/**
 * What each plan operation actually means, and when it is a problem.
 *
 * A plan viewer that only draws boxes assumes you already know what a Bitmap
 * Heap Scan is. Most people reading a plan are reading it precisely because
 * they do not, and the ones who do still benefit from being told *why this
 * node, in this plan* is worth looking at.
 *
 * Two kinds of text live here:
 *   - **Explanations** — what the operation does, always shown, never alarming.
 *   - **Findings** — conditional, derived from the node's own numbers, each
 *     with what was seen, why it matters, and what to do next.
 *
 * A finding must be actionable. "Sequential scan detected" is not a finding,
 * it is a fact; a sequential scan is the *right* plan for a small table or a
 * query reading most of the rows. The rules below therefore look at magnitude
 * and context, not at the operation name alone — a viewer that cries wolf on
 * every Seq Scan gets ignored, which is worse than saying nothing.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { PlanNodeKind } from './planParse.ts';
import type { NodeCost, PlanCostModel } from './planCost.ts';
import { MISESTIMATE_ALERT, formatRows } from './planCost.ts';

export interface OpExplanation {
  /** Short title for the node header. */
  title: string;
  /** One or two sentences: what this operation does. */
  what: string;
  /** When this operation is the right choice — context, not alarm. */
  when: string;
}

/**
 * Per-kind explanations, engine-neutral.
 *
 * Written for someone who knows SQL but not the planner's vocabulary, which is
 * the person who opens a plan view. No sentence assumes a previous one.
 */
export const OP_GLOSSARY: Record<PlanNodeKind, OpExplanation> = {
  'scan-seq': {
    title: 'Full scan',
    what: 'Reads every row in the table, top to bottom, and discards the ones that do not match.',
    when: 'The right choice for a small table, or when the query genuinely needs most of the rows — below roughly 5–10% selectivity an index usually wins, above it a full scan usually does.',
  },
  'scan-index': {
    title: 'Index scan',
    what: 'Walks an index to find matching rows, then fetches each one from the table.',
    when: 'The usual win for selective lookups. The table fetch costs one random read per row, so it stops paying off once a large fraction of the table matches.',
  },
  'scan-index-only': {
    title: 'Index-only scan',
    what: 'Answers entirely from the index without touching the table at all, because the index already holds every column the query asked for.',
    when: 'The best case for a lookup. Requires a covering index and a well-vacuumed visibility map; falling back to heap fetches means the map is stale.',
  },
  'scan-bitmap': {
    title: 'Bitmap scan',
    what: 'Collects matching row locations from an index into a bitmap, sorts them, then reads the table in physical order.',
    when: 'The middle ground between an index scan and a full scan — chosen when many rows match, because reading in physical order turns random I/O into sequential I/O.',
  },
  'scan-const': {
    title: 'Constant row',
    what: 'Reads at most one row, identified directly by a primary or unique key.',
    when: 'The cheapest access there is. Nothing to improve.',
  },
  'join-nested': {
    title: 'Nested loop join',
    what: 'For each row from the outer input, looks up matching rows in the inner input.',
    when: 'Excellent when the outer side is small and the inner side is indexed. Cost grows with the product of both sides, so it degrades badly when the outer row count is large or mis-estimated.',
  },
  'join-hash': {
    title: 'Hash join',
    what: 'Builds a hash table from one input, then streams the other input through it.',
    when: 'The workhorse for joining two large unsorted inputs on equality. Needs memory for the hash table — if it does not fit, it spills to disk and slows sharply.',
  },
  'join-merge': {
    title: 'Merge join',
    what: 'Walks two inputs that are already sorted on the join key, matching as it goes.',
    when: 'Very efficient when both sides arrive sorted — from an index or an earlier sort. If a sort had to be added to make it possible, a hash join is often cheaper.',
  },
  'sort': {
    title: 'Sort',
    what: 'Orders rows by the sort key, in memory when it fits and on disk when it does not.',
    when: 'Unavoidable for ORDER BY without a matching index. An index in the right order removes it entirely.',
  },
  'aggregate': {
    title: 'Aggregate',
    what: 'Reduces many rows to summary values — COUNT, SUM, AVG and friends.',
    when: 'Inherent to the query. Cost is driven by how many rows reach it, so filtering earlier is what helps.',
  },
  'group': {
    title: 'Group',
    what: 'Collects rows into groups by the grouping key before aggregating them.',
    when: 'Cheap over sorted input, more expensive when it needs a hash table or a temporary table to do it.',
  },
  'window': {
    title: 'Window function',
    what: 'Computes a value across a frame of related rows without collapsing them.',
    when: 'Requires its input ordered by the window definition, which often implies a sort.',
  },
  'distinct': {
    title: 'Distinct',
    what: 'Removes duplicate rows, either by sorting them together first or by hashing them.',
    when: 'Often a sign that a join is multiplying rows — worth checking whether the duplicates should exist at all.',
  },
  'limit': {
    title: 'Limit',
    what: 'Stops pulling rows once enough have been produced.',
    when: 'Can make a plan dramatically cheaper by short-circuiting the work beneath it — but only if that work can be stopped early. A sort underneath must complete in full first.',
  },
  'union': {
    title: 'Union / append',
    what: 'Concatenates the results of several sub-plans.',
    when: 'Normal for UNION and for partitioned tables. Each branch is planned separately, so look at the branches, not the append.',
  },
  'subquery': {
    title: 'Subquery',
    what: 'Runs a nested query and feeds its result to the parent.',
    when: 'Fine when it runs once. A correlated subquery runs per outer row, which is where they become expensive.',
  },
  'materialize': {
    title: 'Materialize',
    what: 'Runs a sub-plan once and caches its rows so the parent can re-read them without re-running it.',
    when: 'A deliberate optimisation, usually under a nested loop. Costs memory to save repeated work.',
  },
  'cte': {
    title: 'CTE',
    what: 'A named sub-query, evaluated as its own step.',
    when: 'In PostgreSQL before 12, always an optimisation fence; from 12 on it can be inlined unless declared MATERIALIZED.',
  },
  'result': {
    title: 'Result',
    what: 'Produces the final rows of the statement.',
    when: 'Structural — the top of the plan, not a cost of its own.',
  },
  'other': {
    title: 'Operation',
    what: 'A plan step this viewer does not have a specific description for.',
    when: 'Read the raw plan for the detail.',
  },
};

export type FindingLevel = 'info' | 'warn' | 'critical';

export interface Finding {
  level: FindingLevel;
  /** Short label for the badge on the node. */
  badge: string;
  /** What was observed, in this plan, with its numbers. */
  observed: string;
  /** Why it matters. */
  why: string;
  /** What to do about it. */
  action: string;
}

/** A node is "big" when it is worth caring about the row count at all. */
const BIG_ROWS = 10_000;

/**
 * Findings for one node, given its cost context.
 *
 * Every rule is gated on magnitude as well as shape, so a correct plan over a
 * small table produces nothing.
 */
export function findingsFor(entry: NodeCost, model: PlanCostModel): Finding[] {
  const n = entry.node;
  const s = n.stats;
  const out: Finding[] = [];
  const flags = new Set(s.flags ?? []);
  const rows = s.rowsActual ?? s.rowsEst;

  // ── full scan, but only when it is actually reading a lot ──
  if ((n.kind === 'scan-seq' || flags.has('full-scan'))
      && typeof rows === 'number' && rows >= BIG_ROWS) {
    const hot = entry.severity === 'hot' || entry.severity === 'critical';
    out.push({
      level: hot ? 'critical' : 'warn',
      badge: 'full scan',
      observed: `Reads ${formatRows(rows)} rows from ${s.relation ?? 'the table'} with no index`
        + (hot ? `, and is the most expensive step in this plan.` : '.'),
      why: 'Every row is read and then filtered, so the work grows with the size of the table rather than with the size of the answer.',
      action: `Add an index covering the filter or join predicate on ${s.relation ?? 'this table'}. If the query genuinely needs most of the rows, a full scan is already the correct plan.`,
    });
  }

  // ── no index used on a table that is not tiny ──
  if (flags.has('no-index') && !flags.has('full-scan')
      && typeof rows === 'number' && rows >= BIG_ROWS) {
    out.push({
      level: 'warn',
      badge: 'no index',
      observed: `No index chosen for ${s.relation ?? 'this table'} over ${formatRows(rows)} rows.`,
      why: 'The optimiser had no usable index for the predicate, or judged the available ones not selective enough.',
      action: 'Check that an index exists on the filtered columns and that its leading column matches the predicate.',
    });
  }

  // ── sort spilled to disk ──
  if (flags.has('sort-spilled')) {
    out.push({
      level: 'warn',
      badge: 'sort spilled',
      observed: 'The sort did not fit in memory and was written to disk.',
      why: 'A disk sort is orders of magnitude slower than an in-memory one, and the I/O competes with everything else on the server.',
      action: 'Raise work_mem for this session, reduce the rows reaching the sort, or add an index that returns them already ordered.',
    });
  }

  // ── filesort / temp table (MySQL) ──
  if (flags.has('filesort')) {
    out.push({
      level: 'warn',
      badge: 'filesort',
      observed: 'MySQL must sort the rows itself rather than reading them in order.',
      why: 'The sort happens after the rows are fetched, so it scales with the result size and cannot be short-circuited by a LIMIT.',
      action: 'Add an index whose column order matches the ORDER BY, so the rows arrive already sorted.',
    });
  }
  if (flags.has('temp-table')) {
    out.push({
      level: 'warn',
      badge: 'temp table',
      observed: 'The step needs a temporary table to hold intermediate rows.',
      why: 'Temporary tables start in memory and are converted to disk-backed MyISAM/InnoDB once they exceed tmp_table_size, at which point they get much slower.',
      action: 'Reduce the grouped or distinct row count, or index the grouping columns so the work can be done in order instead.',
    });
  }

  // ── planner mis-estimation, only when measured ──
  if (model.measured && entry.misestimate !== undefined && entry.misestimate >= MISESTIMATE_ALERT) {
    const over = (s.rowsActual ?? 0) < (s.rowsEst ?? 0);
    out.push({
      level: entry.misestimate >= 100 ? 'critical' : 'warn',
      badge: `${Math.round(entry.misestimate)}× off`,
      observed: `Planner expected ${formatRows(s.rowsEst)} rows, got ${formatRows(s.rowsActual)}`
        + ` — ${over ? 'over' : 'under'}-estimated by ${Math.round(entry.misestimate)}×.`,
      why: 'Join order, join method and memory sizing are all chosen from these estimates. A large miss here is frequently the root cause of a bad plan, even when this node is not the slowest one.',
      action: `Refresh statistics on ${s.relation ?? 'the underlying table'} (ANALYZE), and consider extended statistics if the predicate spans correlated columns.`,
    });
  }

  // ── nested loop over a large outer input ──
  if (n.kind === 'join-nested') {
    const outer = n.children[0]?.stats;
    const outerRows = outer?.rowsActual ?? outer?.rowsEst;
    if (typeof outerRows === 'number' && outerRows >= BIG_ROWS) {
      out.push({
        level: entry.severity === 'critical' ? 'critical' : 'warn',
        badge: 'loop × rows',
        observed: `Nested loop driven by ${formatRows(outerRows)} outer rows — the inner side is probed once per row.`,
        why: 'A nested loop costs roughly outer × inner. It is the right join for a small outer input and a poor one as that input grows.',
        action: 'Check whether the outer row count was mis-estimated; if it is genuinely large, a hash join is usually the better plan.',
      });
    }
  }

  return out;
}

/** Every finding in the plan, hottest node first. */
export function allFindings(model: PlanCostModel): Array<{ entry: NodeCost; finding: Finding }> {
  const out: Array<{ entry: NodeCost; finding: Finding }> = [];
  for (const entry of model.ranked.length ? model.ranked : model.nodes) {
    for (const finding of findingsFor(entry, model)) out.push({ entry, finding });
  }
  const rank: Record<FindingLevel, number> = { critical: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.finding.level] - rank[b.finding.level]);
}
