/**
 * What "hot" means in an execution plan.
 *
 * Everything visual — the colour ramp, the icicle widths, the "worst node"
 * callout — is driven from here rather than from each renderer's own
 * arithmetic, so the graph and the tree can never disagree about which node is
 * the expensive one.
 *
 * Two rules shape the whole module:
 *
 * 1. **Measured and estimated are different things.** With `EXPLAIN ANALYZE`
 *    the weight is real elapsed time. With plain `EXPLAIN` it is the planner's
 *    cost — a unitless guess that is frequently wrong. Presenting them
 *    identically is how people end up tuning the cost model instead of the
 *    query, so the mode travels with the numbers and the UI states it.
 *
 * 2. **Self, not total.** A node's *total* time includes its children, so the
 *    root always looks like the problem. Self time (total minus children) is
 *    what points at the node actually doing the work.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { PlanNode, ParsedPlan } from './planParse.ts';

/** Which number the colours and widths are showing. */
export type CostBasis = 'time' | 'cost';

/** Severity bands. Thresholds are shares of the plan's hottest node. */
export type Severity = 'none' | 'mild' | 'warm' | 'hot' | 'critical';

export interface NodeCost {
  /** The node this describes — identity comparison against the parsed tree. */
  node: PlanNode;
  /** Stable address in the tree ("0.1.0"), used as a React key and for collapse state. */
  path: string;
  depth: number;
  /** The weight driving colour and size, in ms (time basis) or cost units. */
  weight: number;
  /** Cumulative weight including children — drives icicle width. */
  weightTotal: number;
  /** 0..1 — this node's share of the whole plan. */
  share: number;
  /** 0..1 — this node's weight relative to the single hottest node. */
  relative: number;
  severity: Severity;
  /** actual ÷ estimated rows, when both are known and comparable. */
  misestimate?: number;
}

export interface PlanCostModel {
  basis: CostBasis;
  measured: boolean;
  /** Sum of every node's self weight. */
  total: number;
  /** The single largest self weight in the plan. */
  peak: number;
  nodes: NodeCost[];
  byPath: Map<string, NodeCost>;
  /** Hottest first; empty when every node weighs zero. */
  ranked: NodeCost[];
}

/**
 * Bands are relative to the plan's hottest node, not to absolute time.
 *
 * An absolute scale cannot work across both a 2 ms plan and a 40-second one:
 * with fixed millisecond cut-offs the fast plan is uniformly green (nothing to
 * look at, even though one node owns 90% of it) and the slow plan is uniformly
 * red (everything is the problem, so nothing is). Relative banding always
 * answers the question actually being asked — *within this plan*, where does
 * the work sit?
 */
export function severityOf(relative: number): Severity {
  if (!Number.isFinite(relative) || relative <= 0) return 'none';
  if (relative >= 0.75) return 'critical';
  if (relative >= 0.40) return 'hot';
  if (relative >= 0.15) return 'warm';
  if (relative >= 0.03) return 'mild';
  return 'none';
}

/**
 * A node's self weight on the chosen basis.
 *
 * Falls back through the options rather than assuming: a MySQL node has cost
 * but never time, a PG node under plain EXPLAIN has cost but no time, and a
 * structural wrapper node (a MySQL query block) may have neither.
 */
function selfWeight(n: PlanNode, basis: CostBasis): number {
  const s = n.stats;
  if (basis === 'time') {
    if (typeof s.msSelf === 'number') return Math.max(0, s.msSelf);
    if (typeof s.msTotal === 'number') return Math.max(0, s.msTotal);
    return 0;
  }
  if (typeof s.costSelf === 'number') return Math.max(0, s.costSelf);
  if (typeof s.costTotal === 'number') return Math.max(0, s.costTotal);
  return 0;
}

/**
 * How badly the planner mis-guessed this node's cardinality.
 *
 * Returned as a symmetric factor ≥ 1 — 40 means "off by 40×" whether the
 * planner over- or under-estimated, because both are equally diagnostic. Only
 * meaningful when actual rows were measured.
 *
 * Rows below `FLOOR` are ignored: 1 estimated vs 12 actual is a 12× "error"
 * that means nothing, and without a floor every trivial node screams.
 */
const MISESTIMATE_FLOOR = 10;

export function misestimateOf(n: PlanNode): number | undefined {
  const { rowsEst, rowsActual } = n.stats;
  if (typeof rowsEst !== 'number' || typeof rowsActual !== 'number') return undefined;
  if (rowsEst < MISESTIMATE_FLOOR && rowsActual < MISESTIMATE_FLOOR) return undefined;
  // Guard the divide: an estimate of 0 rows happens and is not a divide-by-zero
  // story, it is simply a large miss.
  const est = Math.max(rowsEst, 1);
  const act = Math.max(rowsActual, 1);
  return act >= est ? act / est : est / act;
}

/** Mis-estimates below this are ordinary planner noise, not a finding. */
export const MISESTIMATE_ALERT = 10;

/**
 * Build the cost model for a parsed plan.
 *
 * `basis` is chosen automatically — measured time when the plan has it,
 * estimated cost otherwise — but can be forced, which is what a future
 * metric selector would use.
 */
export function buildCostModel(plan: ParsedPlan, force?: CostBasis): PlanCostModel {
  const basis: CostBasis = force ?? (plan.measured ? 'time' : 'cost');
  const nodes: NodeCost[] = [];

  // Two passes: collect self weights, then derive shares. Totals cannot be
  // known until the whole tree is walked, and a node's share is meaningless
  // without them.
  const totals = new Map<PlanNode, number>();
  const walkTotals = (n: PlanNode): number => {
    const kids = n.children.reduce((sum, c) => sum + walkTotals(c), 0);
    const t = selfWeight(n, basis) + kids;
    totals.set(n, t);
    return t;
  };
  walkTotals(plan.root);

  const walk = (n: PlanNode, depth: number, path: string): void => {
    nodes.push({
      node: n, path, depth,
      weight: selfWeight(n, basis),
      weightTotal: totals.get(n) ?? 0,
      share: 0, relative: 0, severity: 'none',
      misestimate: misestimateOf(n),
    });
    n.children.forEach((c, i) => walk(c, depth + 1, `${path}.${i}`));
  };
  walk(plan.root, 0, '0');

  const total = nodes.reduce((s, e) => s + e.weight, 0);
  const peak = nodes.reduce((m, e) => Math.max(m, e.weight), 0);

  for (const e of nodes) {
    e.share = total > 0 ? e.weight / total : 0;
    e.relative = peak > 0 ? e.weight / peak : 0;
    e.severity = severityOf(e.relative);
  }

  return {
    basis,
    measured: plan.measured,
    total, peak, nodes,
    byPath: new Map(nodes.map(e => [e.path, e])),
    ranked: [...nodes].filter(e => e.weight > 0).sort((a, b) => b.weight - a.weight),
  };
}

/** Human weight for a tooltip or label, unit-aware. */
export function formatWeight(weight: number, basis: CostBasis): string {
  if (basis === 'cost') {
    return weight >= 1000 ? `cost ${Math.round(weight).toLocaleString()}`
      : `cost ${weight.toFixed(weight >= 10 ? 0 : 2)}`;
  }
  if (weight >= 1000) return `${(weight / 1000).toFixed(weight >= 10000 ? 1 : 2)} s`;
  if (weight >= 1) return `${weight.toFixed(1)} ms`;
  return `${weight.toFixed(2)} ms`;
}

/** Compact row count: 1.2M, 4.8k, 812. */
export function formatRows(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}
