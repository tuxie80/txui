/**
 * Keeping plan runs so they can be compared.
 *
 * The plan view answers "what is this query doing". It does not answer the
 * question that follows it and is the reason anyone opened a plan in the first
 * place: **did my change actually help?** Answering that needs two runs and a
 * diff, which is dbForge's best feature and the one thing its profiler has
 * that nothing else here does.
 *
 * A run is keyed by the *shape* of the statement rather than its exact text, so
 * changing a literal (`WHERE id = 7` → `WHERE id = 9`) still compares against
 * the earlier run, while changing the query itself starts a new series. That is
 * the distinction between re-running the same query and writing a different
 * one, and getting it wrong in either direction makes the history useless.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { ParsedPlan, PlanNode } from './planParse.ts';
import type { PlanCostModel } from './planCost.ts';

export interface PlanRun {
  /** Shape key — runs with the same key are comparable. */
  key: string;
  /** ms epoch, supplied by the caller (this module stays pure). */
  at: number;
  /** The statement as typed, for display. */
  sql: string;
  measured: boolean;
  /** Total execution time, when measured. */
  totalMs?: number;
  /** Sum of node weights — comparable within a basis. */
  totalWeight: number;
  basis: 'time' | 'cost';
  /** Rows the plan actually produced at its root, when known. */
  rows?: number;
  /** Flattened node summary, enough to diff shapes without keeping the tree. */
  nodes: RunNode[];
  /**
   * The parsed tree, kept as well as the flat summary.
   *
   * The summary answers "which step got slower". It cannot answer "the index
   * changed", because it matches nodes on `kind|op|relation` and carries no
   * access path — a Seq Scan becoming an Index Scan reads as one removal plus
   * one addition, which is the one comparison people actually come here for.
   * `planDiff` answers it, and needs the tree. At {@link RUNS_PER_KEY} runs a
   * plan tree is a rounding error against the rows it describes.
   */
  plan: ParsedPlan;
}

export interface RunNode {
  path: string;
  op: string;
  kind: string;
  relation?: string;
  weight: number;
  rowsEst?: number;
  rowsActual?: number;
}

/** Cap per series — enough to see a trend, bounded for storage. */
export const RUNS_PER_KEY = 20;

/**
 * A statement's shape, ignoring the values in it.
 *
 * Literals, whitespace and case are normalised away. Two runs of the same
 * query with different parameters belong in one series; a genuinely different
 * query does not.
 */
export function shapeKey(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, '?')     // string literals
    .replace(/\b\d+(\.\d+)?\b/g, '?')          // numbers
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A plan's *shape*, ignoring every number in it.
 *
 * Two runs of one statement can produce genuinely different plans — the
 * optimiser re-chooses each time, and a change in statistics, in the parameter
 * values, or in nothing visible at all can flip it. That is the failure people
 * describe as "it was fast yesterday": the query did not change, the plan did.
 *
 * Timings and row counts are deliberately excluded. They differ on every run
 * whether or not the plan changed, so a fingerprint including them would report
 * instability constantly and mean nothing. What is left — the operations, the
 * relations, the indexes, and the tree they form — changes only when the
 * optimiser actually decided differently.
 */
export function planFingerprint(plan: ParsedPlan): string {
  const walk = (n: PlanNode): string => {
    const self = [n.op, n.stats.relation ?? '', n.stats.index ?? ''].join('');
    // Children are ordered: a join with its inputs swapped is a different plan,
    // not the same one written differently.
    return n.children.length ? `${self}(${n.children.map(walk).join(',')})` : self;
  };
  return walk(plan.root);
}

/** One distinct plan the optimiser has produced for a statement. */
export interface PlanVariant {
  fingerprint: string;
  /** Indexes into the series, oldest first. */
  runs: number[];
  /** Median weight across those runs — variants differ in speed, often a lot. */
  medianWeight: number;
  basis: 'time' | 'cost';
}

export interface Instability {
  /** One entry per distinct plan, most-run first. */
  variants: PlanVariant[];
  /** True once the optimiser has been seen to choose differently. */
  unstable: boolean;
  /**
   * Ratio of the slowest variant's median to the fastest's, when comparable.
   *
   * This is the number that matters: two plans for one query is a curiosity
   * until one of them is twenty times slower, at which point it is the reason
   * for the pager.
   */
  spread?: number;
}

/**
 * Detect a statement producing more than one plan — Datadog DBM's mechanism.
 *
 * Honest about its reach: this sees only what has run in this session, capped
 * at {@link RUNS_PER_KEY}. It can prove a statement *is* unstable by catching it
 * in the act; it can never prove one is stable, because the flip may simply not
 * have happened yet. The wording in the UI has to say so, or a quiet panel
 * reads as a clean bill of health it did not earn.
 */
export function detectInstability(series: PlanRun[]): Instability {
  const byPrint = new Map<string, number[]>();
  series.forEach((r, i) => {
    const f = planFingerprint(r.plan);
    const at = byPrint.get(f);
    if (at) at.push(i); else byPrint.set(f, [i]);
  });

  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const variants: PlanVariant[] = [...byPrint].map(([fingerprint, runs]) => ({
    fingerprint,
    runs,
    medianWeight: median(runs.map(i => series[i].totalWeight)),
    basis: series[runs[0]].basis,
  }));
  variants.sort((a, b) => b.runs.length - a.runs.length || a.runs[0] - b.runs[0]);

  // A spread across mixed bases would compare milliseconds with cost units.
  const oneBasis = variants.every(v => v.basis === variants[0]?.basis)
    && series.every(r => r.measured === series[0].measured);
  const weights = variants.map(v => v.medianWeight).filter(w => w > 0);
  const spread = variants.length > 1 && oneBasis && weights.length === variants.length
    ? Math.max(...weights) / Math.min(...weights)
    : undefined;

  return { variants, unstable: variants.length > 1, spread };
}

/** Flatten a plan into the summary a diff needs. */
export function summarise(plan: ParsedPlan, model: PlanCostModel): RunNode[] {
  const out: RunNode[] = [];
  const walk = (n: PlanNode, path: string) => {
    const entry = model.byPath.get(path);
    out.push({
      path,
      op: n.op,
      kind: n.kind,
      relation: n.stats.relation,
      weight: entry?.weight ?? 0,
      rowsEst: n.stats.rowsEst,
      rowsActual: n.stats.rowsActual,
    });
    n.children.forEach((c, i) => walk(c, `${path}.${i}`));
  };
  walk(plan.root, '0');
  return out;
}

/** Build a run record from a parsed plan. */
export function makeRun(
  sql: string, plan: ParsedPlan, model: PlanCostModel, at: number,
): PlanRun {
  return {
    key: shapeKey(sql),
    at,
    sql,
    measured: plan.measured,
    totalMs: plan.totalMs,
    totalWeight: model.total,
    basis: model.basis,
    rows: plan.root.stats.rowsActual ?? plan.root.stats.rowsEst,
    nodes: summarise(plan, model),
    plan,
  };
}

/**
 * Append a run, newest last, capping **per shape key**.
 *
 * The cap is per series, not per array: this store holds runs of every
 * statement explained in a session, so capping the whole array would let a
 * burst of one query evict the history of another — and plan-instability
 * detection, which is built on that history, would silently see a series of
 * one and never report a flip. Only the oldest runs *of this run's key* are
 * evicted, and only once that key exceeds {@link RUNS_PER_KEY}.
 */
export function pushRun(runs: PlanRun[], run: PlanRun): PlanRun[] {
  const next = [...runs, run];
  const evict = next.filter(r => r.key === run.key).length - RUNS_PER_KEY;
  if (evict <= 0) return next;
  // `next` is oldest-first, so dropping the first `evict` runs of this key
  // removes the oldest of that series while leaving every other series intact.
  let dropped = 0;
  return next.filter(r => {
    if (r.key === run.key && dropped < evict) { dropped++; return false; }
    return true;
  });
}

/** The runs comparable with this one, oldest first. */
export function seriesFor(runs: PlanRun[], key: string): PlanRun[] {
  return runs.filter(r => r.key === key);
}

// ── the diff ─────────────────────────────────────────────────────────────────

export type NodeChange = 'added' | 'removed' | 'changed' | 'same';

export interface NodeDelta {
  op: string;
  relation?: string;
  change: NodeChange;
  beforeWeight?: number;
  afterWeight?: number;
  /** after − before, on the shared basis. */
  deltaWeight?: number;
  beforeRows?: number;
  afterRows?: number;
}

export interface PlanDiff {
  before: PlanRun;
  after: PlanRun;
  /** Whether the two are measured on the same basis; a mixed pair is not comparable. */
  comparable: boolean;
  /** Reason, when they are not. */
  incomparable?: string;
  totalDelta: number;
  /** after ÷ before − 1, as a fraction. Negative is an improvement. */
  totalRatio: number;
  /** True when the plan's SHAPE changed, not just its numbers. */
  shapeChanged: boolean;
  nodes: NodeDelta[];
}

/**
 * Identity for matching a node between two runs.
 *
 * Path is wrong: inserting one node shifts every path below it and the diff
 * reports the whole plan as rewritten. Operation plus relation survives that,
 * and is what a reader means by "the same step".
 */
function identity(n: RunNode): string {
  return `${n.kind}|${n.op}|${n.relation ?? ''}`;
}

/**
 * Compare two runs.
 *
 * Refuses to compare an estimated plan with a measured one. Cost units and
 * milliseconds are different quantities, and a "300% faster" derived from
 * mixing them would be worse than saying nothing.
 */
export function diffRuns(before: PlanRun, after: PlanRun): PlanDiff {
  const comparable = before.basis === after.basis && before.measured === after.measured;
  const incomparable = comparable ? undefined
    : before.measured !== after.measured
      ? 'One run is measured (EXPLAIN ANALYZE) and the other is an estimate — '
        + 'cost units and milliseconds are not the same quantity, so the totals '
        + 'cannot be compared. Re-run both the same way.'
      : `These runs use different bases (${before.basis} vs ${after.basis}).`;

  const beforeByKey = new Map<string, RunNode>();
  for (const n of before.nodes) if (!beforeByKey.has(identity(n))) beforeByKey.set(identity(n), n);
  const afterByKey = new Map<string, RunNode>();
  for (const n of after.nodes) if (!afterByKey.has(identity(n))) afterByKey.set(identity(n), n);

  const nodes: NodeDelta[] = [];
  for (const [k, a] of afterByKey) {
    const b = beforeByKey.get(k);
    if (!b) {
      nodes.push({ op: a.op, relation: a.relation, change: 'added',
        afterWeight: a.weight, afterRows: a.rowsActual ?? a.rowsEst });
      continue;
    }
    const delta = a.weight - b.weight;
    // A hair's difference in timing is noise, not a change worth reporting.
    const noise = Math.max(0.5, Math.abs(b.weight) * 0.02);
    nodes.push({
      op: a.op, relation: a.relation,
      change: Math.abs(delta) > noise ? 'changed' : 'same',
      beforeWeight: b.weight, afterWeight: a.weight, deltaWeight: delta,
      beforeRows: b.rowsActual ?? b.rowsEst,
      afterRows: a.rowsActual ?? a.rowsEst,
    });
  }
  for (const [k, b] of beforeByKey) {
    if (afterByKey.has(k)) continue;
    nodes.push({ op: b.op, relation: b.relation, change: 'removed',
      beforeWeight: b.weight, beforeRows: b.rowsActual ?? b.rowsEst });
  }

  nodes.sort((x, y) => Math.abs(y.deltaWeight ?? y.afterWeight ?? y.beforeWeight ?? 0)
    - Math.abs(x.deltaWeight ?? x.afterWeight ?? x.beforeWeight ?? 0));

  const totalDelta = after.totalWeight - before.totalWeight;
  const totalRatio = before.totalWeight > 0
    ? after.totalWeight / before.totalWeight - 1
    : 0;

  return {
    before, after, comparable, incomparable,
    totalDelta, totalRatio,
    shapeChanged: nodes.some(n => n.change === 'added' || n.change === 'removed'),
    nodes,
  };
}

/**
 * The verdict, in one sentence.
 *
 * States the direction plainly and refuses to when the runs are not
 * comparable — "did it help?" deserves yes, no, or "cannot tell", never a
 * number derived from two different units.
 */
export function verdict(diff: PlanDiff): string {
  if (!diff.comparable) return 'Not comparable.';
  const pct = Math.round(Math.abs(diff.totalRatio) * 100);
  const unit = diff.after.basis === 'time' ? 'time' : 'estimated cost';
  if (pct < 5) {
    return `No meaningful change in ${unit}`
      + (diff.shapeChanged ? ', though the plan shape changed.' : '.');
  }
  const dir = diff.totalRatio < 0 ? 'faster' : 'slower';
  const better = diff.totalRatio < 0 ? 'Improved' : 'Regressed';
  return `${better} — ${pct}% ${diff.after.basis === 'time' ? dir : (diff.totalRatio < 0 ? 'cheaper' : 'more expensive')}`
    + (diff.shapeChanged ? ', and the plan shape changed.' : '.');
}
