/**
 * Comparing two query plans.
 *
 * `ExplainView` renders one plan well. The question it cannot answer is the one
 * people actually have: *did the index help?* Reading two plans side by side and
 * spotting that a `ref` became a `range`, or that rows examined fell by two
 * orders of magnitude, is work a machine should do.
 *
 * The hard part is **matching nodes between two trees**, because the trees are
 * not identical — that is the point of the comparison. Matching by position
 * breaks the moment a node is added or removed and then reports every
 * subsequent node as changed, which is a diff that says everything and means
 * nothing. So nodes are matched by identity (operation plus relation plus
 * index) and only then by position among the remaining candidates.
 *
 * Pure — takes two already-parsed plans, so `node --test` covers it.
 */
import type { ParsedPlan, PlanNode } from './planParse.ts';

export type NodeStatus = 'same' | 'changed' | 'added' | 'removed';

export interface MetricDelta {
  name: string;
  before?: number;
  after?: number;
  /** after − before. Undefined when one side is missing. */
  delta?: number;
  /** Ratio after/before, for the "×12 more rows" reading. */
  ratio?: number;
  /** True when the change is an improvement — smaller, for every metric here. */
  better?: boolean;
}

export interface PlanNodeDiff {
  status: NodeStatus;
  /** Depth in the tree, for indentation. */
  depth: number;
  op: string;
  detail: string;
  before?: PlanNode;
  after?: PlanNode;
  /** Metrics that moved by more than the noise floor. */
  metrics: MetricDelta[];
  /** Access path change, the single most informative line. */
  accessChange?: string;
  children: PlanNodeDiff[];
}

export interface PlanDiff {
  root: PlanNodeDiff | null;
  added: number;
  removed: number;
  changed: number;
  /** One sentence: what actually happened. */
  headline: string;
  /** True when both sides are measured; a measured-vs-estimated pair is a trap. */
  comparable: boolean;
  /** Why the pair cannot be compared, when it cannot. */
  incomparableReason?: string;
}

/**
 * The metrics worth diffing, and their noise floor.
 *
 * Everything here is *smaller is better*. Wall time has a wide floor because
 * two runs of the same plan differ by cache state alone; reporting a 5 %
 * timing wobble as a regression trains people to ignore the diff.
 */
const METRICS: Array<{ key: keyof PlanNode['stats']; name: string; floor: number }> = [
  { key: 'rowsActual', name: 'rows', floor: 0.05 },
  { key: 'rowsEst', name: 'rows est.', floor: 0.05 },
  { key: 'costTotal', name: 'cost', floor: 0.05 },
  { key: 'msTotal', name: 'time', floor: 0.25 },
  { key: 'loops', name: 'loops', floor: 0.001 },
];

/** How a node is recognised across two plans. */
function identity(n: PlanNode): string {
  return [n.op, n.stats.relation ?? '', n.stats.index ?? ''].join('\u001F');
}

/**
 * Pair up children of two nodes.
 *
 * Identity first, then leftovers by position. Matching purely by position
 * reports every node after an insertion as changed; matching purely by
 * identity loses nodes that legitimately changed their index, which is exactly
 * the change being looked for. Doing identity first and position second finds
 * both.
 */
function pair(before: PlanNode[], after: PlanNode[]): Array<[PlanNode | undefined, PlanNode | undefined]> {
  const out: Array<[PlanNode | undefined, PlanNode | undefined]> = [];
  const remainingAfter = [...after];
  const unmatchedBefore: PlanNode[] = [];

  for (const b of before) {
    const i = remainingAfter.findIndex(a => identity(a) === identity(b));
    if (i >= 0) out.push([b, remainingAfter.splice(i, 1)[0]]);
    else unmatchedBefore.push(b);
  }
  // Leftovers by position — a node whose index changed is still "the same
  // node in the plan", and that is the comparison worth showing.
  while (unmatchedBefore.length && remainingAfter.length) {
    out.push([unmatchedBefore.shift(), remainingAfter.shift()]);
  }
  for (const b of unmatchedBefore) out.push([b, undefined]);
  for (const a of remainingAfter) out.push([undefined, a]);
  return out;
}

function metricDeltas(b: PlanNode, a: PlanNode): MetricDelta[] {
  const out: MetricDelta[] = [];
  for (const m of METRICS) {
    const before = b.stats[m.key] as number | undefined;
    const after = a.stats[m.key] as number | undefined;
    if (before === undefined && after === undefined) continue;
    if (before === undefined || after === undefined) {
      out.push({ name: m.name, before, after });
      continue;
    }
    const delta = after - before;
    // A relative floor, plus an absolute guard so 0 → 1 is not an infinite
    // ratio and 1 → 2 rows is not reported as a doubling worth reading.
    const base = Math.max(Math.abs(before), 1);
    if (Math.abs(delta) / base < m.floor) continue;
    out.push({
      name: m.name, before, after, delta,
      ratio: before === 0 ? undefined : after / before,
      better: delta < 0,
    });
  }
  return out;
}

/** `ALL → range`, or an index appearing or changing — the informative line. */
function accessChange(b: PlanNode, a: PlanNode): string | undefined {
  const bits: string[] = [];
  if (b.op !== a.op) bits.push(`${b.op} → ${a.op}`);
  const bi = b.stats.index ?? '', ai = a.stats.index ?? '';
  if (bi !== ai) {
    if (!bi) bits.push(`now uses index ${ai}`);
    else if (!ai) bits.push(`no longer uses index ${bi}`);
    else bits.push(`index ${bi} → ${ai}`);
  }
  return bits.length ? bits.join(' · ') : undefined;
}

function diffNode(
  b: PlanNode | undefined, a: PlanNode | undefined, depth: number,
  counts: { added: number; removed: number; changed: number },
): PlanNodeDiff {
  if (!b && a) {
    counts.added++;
    return {
      status: 'added', depth, op: a.op, detail: a.detail, after: a, metrics: [],
      children: a.children.map(c => diffNode(undefined, c, depth + 1, counts)),
    };
  }
  if (b && !a) {
    counts.removed++;
    return {
      status: 'removed', depth, op: b.op, detail: b.detail, before: b, metrics: [],
      children: b.children.map(c => diffNode(c, undefined, depth + 1, counts)),
    };
  }
  const bb = b!, aa = a!;
  const metrics = metricDeltas(bb, aa);
  const access = accessChange(bb, aa);
  const status: NodeStatus = metrics.length || access ? 'changed' : 'same';
  if (status === 'changed') counts.changed++;
  return {
    status, depth, op: aa.op, detail: aa.detail, before: bb, after: aa,
    metrics, accessChange: access,
    children: pair(bb.children, aa.children).map(([x, y]) => diffNode(x, y, depth + 1, counts)),
  };
}

/**
 * Compare two parsed plans.
 *
 * Refuses a measured-against-estimated pair. `EXPLAIN` costs and `EXPLAIN
 * ANALYZE` timings are different quantities, and a diff that puts them in the
 * same column is not a comparison, it is a category error with a number
 * attached.
 */
export function diffPlans(before: ParsedPlan, after: ParsedPlan): PlanDiff {
  if (before.measured !== after.measured) {
    return {
      root: null, added: 0, removed: 0, changed: 0, comparable: false,
      headline: 'These two plans cannot be compared.',
      incomparableReason:
        'One is EXPLAIN and the other EXPLAIN ANALYZE. Estimated costs and measured timings '
        + 'are different quantities — comparing them would produce a number that means nothing. '
        + 'Capture both the same way.',
    };
  }

  const counts = { added: 0, removed: 0, changed: 0 };
  const root = diffNode(before.root, after.root, 0, counts);

  const rowsBefore = before.root.stats.rowsActual ?? before.root.stats.rowsEst;
  const rowsAfter = after.root.stats.rowsActual ?? after.root.stats.rowsEst;
  const msBefore = before.root.stats.msTotal;
  const msAfter = after.root.stats.msTotal;

  let headline: string;
  if (!counts.added && !counts.removed && !counts.changed) {
    headline = 'The two plans are identical.';
  } else if (msBefore !== undefined && msAfter !== undefined && msBefore > 0) {
    const f = msAfter / msBefore;
    headline = f < 0.95
      ? `${(1 / f).toFixed(1)}× faster — ${msBefore.toFixed(1)} ms → ${msAfter.toFixed(1)} ms.`
      : f > 1.05
        ? `${f.toFixed(1)}× slower — ${msBefore.toFixed(1)} ms → ${msAfter.toFixed(1)} ms.`
        : `About the same time (${msBefore.toFixed(1)} → ${msAfter.toFixed(1)} ms), but the plan changed.`;
  } else if (rowsBefore !== undefined && rowsAfter !== undefined && rowsBefore > 0) {
    const f = rowsAfter / rowsBefore;
    headline = f < 1
      ? `Examines ${(1 / f).toFixed(1)}× fewer rows.`
      : `Examines ${f.toFixed(1)}× more rows.`;
  } else {
    headline = `${counts.changed} node${counts.changed === 1 ? '' : 's'} changed, `
      + `${counts.added} added, ${counts.removed} removed.`;
  }

  return { root, ...counts, headline, comparable: true };
}

/**
 * Which of a node's changed metrics to put in the numeric columns.
 *
 * A node can move on several at once, and showing all of them turns the row
 * into a paragraph. Measured time wins when it exists because it is the only
 * one that is not a model's opinion; cost is the estimate that stands in for it;
 * rows come next because a row count explains a timing rather than restating
 * it. `loops` is last — it is almost always a consequence of the others.
 */
const METRIC_PRIORITY = ['time', 'cost', 'rows', 'rows est.', 'loops'];

export function primaryMetric(node: PlanNodeDiff): MetricDelta | undefined {
  for (const name of METRIC_PRIORITY) {
    const m = node.metrics.find(x => x.name === name);
    if (m) return m;
  }
  return node.metrics[0];
}

/**
 * Flatten for rendering, depth-first.
 *
 * With `changedOnly`, an unchanged node is kept when a descendant changed —
 * dropping it would leave the interesting nodes in a flat list with no
 * indication of where in the plan they sit, which is most of what a plan tells
 * you.
 */
export function flattenDiff(node: PlanNodeDiff | null, changedOnly: boolean): PlanNodeDiff[] {
  if (!node) return [];
  const flat: PlanNodeDiff[] = [];
  const collect = (n: PlanNodeDiff) => { flat.push(n); n.children.forEach(collect); };
  collect(node);
  if (!changedOnly) return flat;

  const keep = new Set<PlanNodeDiff>();
  const mark = (n: PlanNodeDiff, ancestors: PlanNodeDiff[]): boolean => {
    let any = n.status !== 'same';
    for (const c of n.children) {
      if (mark(c, [...ancestors, n])) any = true;
    }
    if (n.status !== 'same') ancestors.forEach(a => keep.add(a));
    if (any) keep.add(n);
    return any;
  };
  mark(node, []);
  return flat.filter(n => keep.has(n));
}
