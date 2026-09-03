/**
 * MySQL `EXPLAIN ANALYZE` → the same plan model the graph draws.
 *
 * MySQL is the awkward one. `EXPLAIN FORMAT=JSON` gives a structured plan made
 * entirely of *estimates*; `EXPLAIN ANALYZE` gives real measured timings but
 * emits them as an indented **TREE text** blob, with no JSON option at all
 * (8.0.18+). So the one MySQL plan worth drawing — the measured one — is the
 * one that arrives in the format the JSON parser cannot read, and without this
 * adapter it falls through to a raw text dump.
 *
 * `utils/planAnalyze.ts` already scans that text into a line tree. This module
 * translates that tree into `ParsedPlan`, so a measured MySQL plan gets the
 * same graph, the same cost model and the same findings as PostgreSQL.
 *
 * A worked line:
 *
 *   -> Nested loop inner join  (cost=1.2 rows=8)
 *        (actual time=0.03..12.4 rows=1204 loops=1)
 *
 * `actual time=..12.4` is per loop and inclusive of children, so total wall
 * time is `12.4 × loops` and self time subtracts the children's totals —
 * exactly the convention utils/planCost expects.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { parseAnalyzeTree } from './planAnalyze.ts';
import type { PlanNode as TreeNode } from './planAnalyze.ts';
import type { PlanNode, ParsedPlan, PlanNodeKind, PlanStats } from './planParse.ts';

/**
 * Classify a MySQL TREE operation label.
 *
 * The labels are prose rather than an enum, so this matches on the distinctive
 * phrase. Order matters: "Single-row index lookup" must be tested before the
 * looser "index lookup", and "Table scan on <temporary>" is a materialised
 * intermediate rather than a real table scan.
 */
export function treeKind(label: string): PlanNodeKind {
  const t = label.toLowerCase();
  if (/^table scan on <(temporary|union)/.test(t)) return 'materialize';
  if (t.startsWith('table scan')) return 'scan-seq';
  if (t.startsWith('single-row index lookup') || t.startsWith('single-row covering')) return 'scan-const';
  if (t.startsWith('constant row') || t.includes('rows fetched before execution')) return 'scan-const';
  if (t.includes('covering index') || t.includes('index lookup')
      || t.includes('index scan') || t.includes('index range scan')) return 'scan-index';
  if (t.includes('nested loop')) return 'join-nested';
  if (t.includes('hash join') || t.startsWith('hash')) return 'join-hash';
  if (t.includes('merge join')) return 'join-merge';
  if (t.startsWith('sort')) return 'sort';
  if (t.includes('group aggregate') || t.startsWith('group')) return 'group';
  if (t.includes('aggregate')) return 'aggregate';
  if (t.startsWith('window')) return 'window';
  if (t.startsWith('remove duplicates') || t.startsWith('distinct')) return 'distinct';
  if (t.startsWith('limit')) return 'limit';
  if (t.startsWith('union') || t.startsWith('append')) return 'union';
  if (t.startsWith('materialize') || t.includes('temporary table')) return 'materialize';
  if (t.includes('subquery')) return 'subquery';
  if (t.startsWith('filter')) return 'other';
  return 'other';
}

/** The table a TREE label is operating on, when it names one. */
export function treeRelation(label: string): string | undefined {
  // "Table scan on o", "Index lookup on c using PRIMARY (id=o.customer_id)",
  // "Covering index scan on t using idx_a"
  const m = /\bon\s+([`"]?)([\w$<>]+)\1/i.exec(label);
  const name = m?.[2];
  if (!name || name.startsWith('<')) return undefined;   // <temporary>, <union1,2>
  return name;
}

/** The index a TREE label names, if any. */
export function treeIndex(label: string): string | undefined {
  return /\busing\s+([`"]?)([\w$]+)\1/i.exec(label)?.[2];
}

/** Total wall time for a node across every loop, in ms. */
function totalMs(n: TreeNode): number | null {
  if (n.timeTotal === null) return null;
  return n.timeTotal * (n.loops ?? 1);
}

/**
 * The wall time a subtree really cost, which is not always its root's time.
 *
 * MySQL reports a materialised branch oddly: the node that *reads* the
 * temporary table reports only the read, while the operation that *filled* it
 * sits underneath reporting the full build. A real plan:
 *
 *   Sort                        124.600 ms
 *     Table scan on <temporary>   0.030 ms   ← reads the finished temp table
 *       Aggregate                124.100 ms  ← but this is what built it
 *
 * Times are otherwise cumulative, so self-time is normally parent minus
 * children. Across that boundary the naive subtraction breaks twice over: the
 * Sort appears to own 124.57 ms of work it never did, and the plan's self
 * times sum to 248 ms for a query that took 124 ms.
 *
 * Taking the deepest total in the subtree instead of the immediate child's
 * total fixes both — the self times then sum back to the execution time.
 */
function subtreeMs(n: TreeNode): number {
  let max = totalMs(n) ?? 0;
  for (const c of n.children) max = Math.max(max, subtreeMs(c));
  return max;
}

/** Wall time attributable to the node itself — children subtracted. */
function selfMs(n: TreeNode): number | null {
  const own = totalMs(n);
  if (own === null) return null;
  let kids = 0;
  for (const c of n.children) kids += subtreeMs(c);
  return Math.max(0, own - kids);
}

const fmt = (n: number | null | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(3);
};

function convert(n: TreeNode): PlanNode {
  const children = n.children.map(convert);
  const ms = totalMs(n);
  const self = selfMs(n);
  const loops = n.loops ?? 1;
  const label = n.label.replace(/\s+/g, ' ').trim();
  const relation = treeRelation(label);
  const index = treeIndex(label);

  const flags: string[] = [];
  const kind = treeKind(label);
  if (kind === 'scan-seq') flags.push('full-scan');
  if (/using filesort/i.test(label) || (kind === 'sort' && !index)) flags.push('filesort');
  if (/temporary table/i.test(label)) flags.push('temp-table');
  if (n.neverExecuted) flags.push('never-executed');

  const stats: PlanStats = {
    costTotal: n.cost ?? undefined,
    rowsEst: n.estRows ?? undefined,
    // actRows is per loop; the real row count is across all of them.
    rowsActual: n.actRows !== null ? n.actRows * loops : undefined,
    loops: n.loops ?? undefined,
    msTotal: ms ?? undefined,
    msSelf: self ?? undefined,
    relation,
    index,
    flags: flags.length ? flags : undefined,
  };

  const metrics: Record<string, string> = {
    'Cost': fmt(n.cost),
    'Rows (est)': fmt(n.estRows),
    'Actual ms': fmt(ms),
    'Rows (actual)': fmt(stats.rowsActual),
    'Loops': fmt(n.loops),
  };

  return {
    // The label carries its own detail ("Index lookup on c using PRIMARY"),
    // so the op is the leading phrase and the rest becomes detail.
    op: label.split(/\s+(?:on|using)\s+/i)[0] || label,
    detail: [relation, index ? `using ${index}` : ''].filter(Boolean).join(' — '),
    metrics,
    severity: 0,   // recomputed by utils/planCost from the numbers above
    kind,
    stats,
    children,
  };
}

/** Does this look like MySQL's TREE output rather than JSON? */
export function looksLikeTree(content: string): boolean {
  const t = content.trim();
  if (t.startsWith('{') || t.startsWith('[')) return false;
  return t.includes('->');
}

/**
 * Parse MySQL `EXPLAIN ANALYZE` TREE text into the shared plan model.
 *
 * Throws when the text holds no recognisable plan lines, so the caller can
 * fall back to showing the raw output rather than an empty diagram.
 */
export function parseMysqlTree(content: string): ParsedPlan {
  const roots = parseAnalyzeTree(content);
  if (roots.length === 0) throw new Error('no plan lines in EXPLAIN ANALYZE output');

  // Normally one root. A UNION can produce several; wrap them so the graph
  // still has a single entry point rather than silently dropping all but one.
  const converted = roots.map(convert);
  const root: PlanNode = converted.length === 1 ? converted[0] : {
    op: 'Statement',
    detail: `${converted.length} top-level operations`,
    metrics: {},
    severity: 0,
    kind: 'result',
    stats: {},
    children: converted,
  };

  const total = converted.reduce((s, c) => s + (c.stats.msTotal ?? 0), 0);
  return {
    root,
    metricColumns: ['Cost', 'Rows (est)', 'Actual ms', 'Rows (actual)', 'Loops'],
    summary: total > 0 ? `Execution ${fmt(total)} ms` : '',
    measured: true,
    totalMs: total > 0 ? total : undefined,
    engine: 'mysql',
  };
}
