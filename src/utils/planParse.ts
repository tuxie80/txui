/**
 * Execution-plan parsers: PostgreSQL `EXPLAIN (FORMAT JSON)` and MySQL
 * `EXPLAIN FORMAT=JSON` → one unified tree-table model (Aqua-Data-Studio
 * style: Operation tree + metric columns + per-row cost severity).
 */

import { looksLikeTree, parseMysqlTree } from './planTree.ts';
import { parseClickhousePlan } from './planClickhouse.ts';
import { parseMssqlPlan } from './mssqlPlan.ts';

/**
 * Normalised operation class, independent of engine vocabulary.
 *
 * PostgreSQL says "Seq Scan", MySQL says access_type `ALL`; they are the same
 * thing to a reader and should carry the same icon, the same explanation and
 * the same warning. Everything visual keys off this rather than off the raw
 * label, so a plan reads identically across engines.
 */
export type PlanNodeKind =
  | 'scan-seq' | 'scan-index' | 'scan-index-only' | 'scan-bitmap' | 'scan-const'
  | 'join-nested' | 'join-hash' | 'join-merge'
  | 'sort' | 'aggregate' | 'group' | 'window' | 'distinct' | 'limit'
  | 'union' | 'subquery' | 'materialize' | 'cte' | 'result' | 'other';

/**
 * The numbers behind a node, unformatted.
 *
 * `metrics` below holds display strings, which is all the tree-table ever
 * needed. A graph has to compare nodes — box size, edge weight, colour ramp —
 * so it needs the actual values. Every field is optional because plain EXPLAIN
 * has no timings and MySQL has no per-node time at all.
 */
export interface PlanStats {
  /** Cumulative cost of this node including its children. */
  costTotal?: number;
  /** Cost attributable to this node alone (total minus children). */
  costSelf?: number;
  rowsEst?: number;
  /** Rows the node is expected to EMIT (MySQL rows_produced_per_join). */
  rowsOut?: number;
  rowsActual?: number;
  loops?: number;
  /** Inclusive wall time, already multiplied by loops (ms). */
  msTotal?: number;
  /** Exclusive wall time — this node's own work (ms). */
  msSelf?: number;
  relation?: string;
  index?: string;
  /** Set when the node reports something notable: filesort, temp table, … */
  flags?: string[];
}

export interface PlanNode {
  op: string;                              // operation label
  detail: string;                          // relation / index / condition
  metrics: Record<string, string>;         // column → display value
  /** 0..1 — this node's share of total cost; drives the row tint */
  severity: number;
  /** Normalised class — drives icon, explanation and warnings. */
  kind: PlanNodeKind;
  /** Unformatted values, for the graph and the cost model. */
  stats: PlanStats;
  children: PlanNode[];
}

export interface ParsedPlan {
  root: PlanNode;
  metricColumns: string[];                 // column order for the table
  summary: string;                         // e.g. "Planning 0.2 ms · Execution 34.1 ms"
  /**
   * True when the plan carries measured timings (EXPLAIN ANALYZE), false when
   * every number is a planner estimate. The two must never be presented as if
   * they were the same thing — an estimate that looks like a measurement is
   * how people end up optimising a cost model instead of a query.
   */
  measured: boolean;
  /** Total execution time in ms, when measured. */
  totalMs?: number;
  engine: string;
}

/** Map a PostgreSQL `Node Type` onto the normalised classifier. */
export function pgKind(nodeType: string): PlanNodeKind {
  const t = nodeType.toLowerCase();
  if (t === 'seq scan') return 'scan-seq';
  if (t === 'index only scan') return 'scan-index-only';
  if (t.includes('bitmap')) return 'scan-bitmap';
  if (t.includes('index scan')) return 'scan-index';
  if (t === 'result' ) return 'result';
  if (t.includes('nested loop')) return 'join-nested';
  if (t.includes('hash join')) return 'join-hash';
  if (t === 'hash') return 'join-hash';
  if (t.includes('merge join')) return 'join-merge';
  if (t.includes('sort')) return 'sort';
  if (t.includes('aggregate')) return 'aggregate';
  if (t.includes('group')) return 'group';
  if (t.includes('window')) return 'window';
  if (t === 'unique') return 'distinct';
  if (t === 'limit') return 'limit';
  if (t.includes('append') || t.includes('union')) return 'union';
  if (t.includes('materialize')) return 'materialize';
  if (t.includes('cte') || t.includes('recursive')) return 'cte';
  if (t.includes('subquery') || t.includes('subplan')) return 'subquery';
  if (t.includes('scan')) return 'scan-seq';
  return 'other';
}

/** Map a MySQL `access_type` onto the normalised classifier. */
export function mysqlKind(access: string): PlanNodeKind {
  switch (access) {
    case 'ALL':             return 'scan-seq';
    case 'index':           return 'scan-index';
    case 'range':
    case 'ref':
    case 'index_merge':
    case 'fulltext':        return 'scan-index';
    case 'eq_ref':          return 'scan-index';
    case 'const':
    case 'system':          return 'scan-const';
    case 'unique_subquery':
    case 'index_subquery':  return 'subquery';
    default:                return 'other';
  }
}

const fmt = (n: unknown): string => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (Number.isInteger(v)) return v.toLocaleString();
  return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
};

// ── PostgreSQL ────────────────────────────────────────────────────────────────

interface PgPlan {
  'Node Type': string;
  'Join Type'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Index Cond'?: string;
  'Hash Cond'?: string;
  'Merge Cond'?: string;
  'Filter'?: string;
  'Sort Key'?: string[];
  'Sort Method'?: string;
  Plans?: PgPlan[];
}

export function parsePgPlan(content: string): ParsedPlan {
  const parsed = JSON.parse(content);
  const top = Array.isArray(parsed) ? parsed[0] : parsed;
  const plan: PgPlan = top.Plan;
  const analyzed = plan['Actual Total Time'] !== undefined;

  // Severity basis: node's SELF cost (total minus children) over the root total
  const rootTotal = Math.max(plan['Total Cost'] ?? 0, 1e-9);
  const rootTime = Math.max(selfTimePg(plan), collectMaxTimePg(plan));

  const build = (p: PgPlan): PlanNode => {
    const kids = (p.Plans ?? []).map(build);
    const childCost = (p.Plans ?? []).reduce((s, c) => s + (c['Total Cost'] ?? 0), 0);
    const selfCost = Math.max(0, (p['Total Cost'] ?? 0) - childCost);
    const severity = analyzed && rootTime > 0
      ? Math.min(1, selfTimePg(p) / rootTime)
      : Math.min(1, selfCost / rootTotal);

    const cond = p['Hash Cond'] ?? p['Merge Cond'] ?? p['Index Cond'] ?? p['Filter']
      ?? (p['Sort Key'] ? p['Sort Key'].join(', ') : '');
    const rel = p['Relation Name']
      ? `${p['Relation Name']}${p['Index Name'] ? ` (${p['Index Name']})` : ''}`
      : p['Index Name'] ?? '';

    const metrics: Record<string, string> = {
      'Cost': fmt(p['Total Cost']),
      'Rows (est)': fmt(p['Plan Rows']),
    };
    if (analyzed) {
      metrics['Actual ms'] = fmt(p['Actual Total Time']);
      metrics['Rows (actual)'] = fmt(p['Actual Rows']);
      metrics['Loops'] = fmt(p['Actual Loops']);
    }

    const loops = p['Actual Loops'] ?? 1;
    const flags: string[] = [];
    if (p['Node Type'] === 'Seq Scan') flags.push('full-scan');
    if (p['Sort Method']) flags.push(`sort:${p['Sort Method']}`);
    if ((p['Sort Method'] ?? '').includes('external')) flags.push('sort-spilled');

    return {
      op: p['Join Type'] && p['Node Type'].includes('Join')
        ? `${p['Node Type']} (${p['Join Type']})`
        : p['Node Type'],
      detail: [rel, cond].filter(Boolean).join(' — '),
      metrics,
      severity,
      kind: pgKind(p['Node Type']),
      stats: {
        costTotal: p['Total Cost'],
        costSelf: selfCost,
        rowsEst: p['Plan Rows'],
        // PG reports per-loop actual rows; the real row count is × loops.
        rowsActual: p['Actual Rows'] !== undefined ? p['Actual Rows'] * loops : undefined,
        loops: p['Actual Loops'],
        msTotal: analyzed ? (p['Actual Total Time'] ?? 0) * loops : undefined,
        msSelf: analyzed ? selfTimePg(p) : undefined,
        relation: p['Relation Name'],
        index: p['Index Name'],
        flags: flags.length ? flags : undefined,
      },
      children: kids,
    };
  };

  const metricColumns = analyzed
    ? ['Cost', 'Rows (est)', 'Actual ms', 'Rows (actual)', 'Loops']
    : ['Cost', 'Rows (est)'];

  const parts: string[] = [];
  if (top['Planning Time'] !== undefined) parts.push(`Planning ${fmt(top['Planning Time'])} ms`);
  if (top['Execution Time'] !== undefined) parts.push(`Execution ${fmt(top['Execution Time'])} ms`);

  return {
    root: build(plan), metricColumns, summary: parts.join(' · '),
    measured: analyzed, totalMs: top['Execution Time'], engine: 'postgres',
  };
}

function selfTimePg(p: PgPlan): number {
  const total = (p['Actual Total Time'] ?? 0) * (p['Actual Loops'] ?? 1);
  const kids = (p.Plans ?? []).reduce(
    (s, c) => s + (c['Actual Total Time'] ?? 0) * (c['Actual Loops'] ?? 1), 0);
  return Math.max(0, total - kids);
}
function collectMaxTimePg(p: PgPlan): number {
  return Math.max(selfTimePg(p), ...(p.Plans ?? []).map(collectMaxTimePg), 0);
}

// ── MySQL ─────────────────────────────────────────────────────────────────────

const ACCESS_LABEL: Record<string, string> = {
  ALL:             'Full Table Scan',
  index:           'Full Index Scan',
  range:           'Index Range Scan',
  ref:             'Index Lookup (ref)',
  eq_ref:          'Unique Lookup (eq_ref)',
  const:           'Constant Row',
  system:          'System Row',
  fulltext:        'Fulltext Search',
  index_merge:     'Index Merge',
  unique_subquery: 'Unique Subquery',
  index_subquery:  'Index Subquery',
};

type MyObj = Record<string, unknown>;

/**
 * Does this JSON carry MariaDB's measured fields?
 *
 * MariaDB's `ANALYZE FORMAT=JSON` is the same document as its
 * `EXPLAIN FORMAT=JSON` with `r_`-prefixed measurements added — `r_rows`
 * beside `rows`, `r_total_time_ms`, `r_loops`, `r_filtered`. So the two are
 * told apart by content rather than by which statement was sent, which also
 * means a plan pasted in from elsewhere is read correctly.
 *
 * Scanning the raw text rather than walking the tree: the fields appear at
 * several depths and the only question is whether *any* of them is present.
 */
function hasMariaMeasurements(content: string): boolean {
  return /"r_(rows|total_time_ms|loops)"\s*:/.test(content);
}

export function parseMysqlPlan(content: string): ParsedPlan {
  const parsed = JSON.parse(content) as MyObj;
  const qb = parsed.query_block as MyObj;
  // MySQL nests cost under cost_info.query_cost; MariaDB puts a plain `cost`
  // on the block. Same quantity, different place.
  const queryCost = Number((qb?.cost_info as MyObj)?.query_cost ?? qb?.cost ?? 0) || 1e-9;
  const measured = hasMariaMeasurements(content);

  const buildTable = (t: MyObj): PlanNode => {
    const access = String(t.access_type ?? '');
    const cost = t.cost_info as MyObj | undefined;
    // `cost` is MariaDB's single per-table figure; MySQL splits it into a
    // prefix cost and read+eval components.
    const nodeCost = Number(cost?.prefix_cost ?? t.cost ?? 0);
    const readEval = cost
      ? Number(cost.read_cost ?? 0) + Number(cost.eval_cost ?? 0)
      : Number(t.cost ?? 0);
    // MariaDB's measured numbers. `r_rows` is rows actually produced per loop,
    // so the total is r_rows × r_loops — reporting the per-loop figure as the
    // total is how a nested loop over 10k rows reads as 1.
    const rLoops = Number(t.r_loops ?? 1);
    const rRows = Number(t.r_rows);
    const rowsActual = Number.isFinite(rRows)
      ? rRows * (Number.isFinite(rLoops) ? rLoops : 1) : undefined;
    const msTotal = Number(t.r_total_time_ms ?? t.r_table_time_ms);
    const children: PlanNode[] = [];
    const mat = t.materialized_from_subquery as MyObj | undefined;
    if (mat?.query_block) children.push(buildBlock(mat.query_block as MyObj, 'Materialized Subquery'));
    for (const key of ['attached_subqueries', 'optimized_away_subqueries'] as const) {
      const subs = t[key] as MyObj[] | undefined;
      if (Array.isArray(subs)) {
        for (const s of subs) {
          if (s.query_block) children.push(buildBlock(s.query_block as MyObj, 'Subquery'));
        }
      }
    }
    const flags: string[] = [];
    if (access === 'ALL') flags.push('full-scan');
    if (t.using_filesort) flags.push('filesort');
    if (t.using_temporary_table) flags.push('temp-table');
    if (!t.key && access !== 'const' && access !== 'system') flags.push('no-index');

    const examined = Number(t.rows_examined_per_scan ?? t.rows);
    const produced = Number(t.rows_produced_per_join);

    return {
      op: ACCESS_LABEL[access] ?? (access ? access.toUpperCase() : 'Table'),
      detail: [
        String(t.table_name ?? ''),
        t.key ? `key: ${t.key}` : (access === 'ALL' ? 'no index' : ''),
      ].filter(Boolean).join(' — '),
      metrics: {
        'Cost': fmt(nodeCost),
        'Read+Eval': fmt(readEval),
        'Rows': fmt(t.rows_examined_per_scan ?? t.rows),
        'Filtered %': fmt(t.r_filtered ?? t.filtered),
        ...(rowsActual !== undefined ? { 'Actual rows': fmt(rowsActual) } : {}),
        ...(Number.isFinite(msTotal) ? { 'Time (ms)': fmt(msTotal) } : {}),
      },
      severity: Math.min(1, readEval / queryCost),
      kind: mysqlKind(access),
      stats: {
        costTotal: nodeCost || undefined,
        costSelf: readEval || undefined,
        // MySQL's JSON plan is entirely estimates: rows_examined_per_scan is
        // what the optimiser expects to read, rows_produced_per_join what it
        // expects to emit. Neither is measured, so both live in rowsEst-land.
        rowsEst: Number.isFinite(examined) ? examined : undefined,
        rowsOut: Number.isFinite(produced) ? produced : undefined,
        // Measured, when MariaDB supplied it. Kept apart from rowsEst on
        // purpose: the whole plan view turns on not confusing the optimiser's
        // expectation with what happened.
        rowsActual,
        msTotal: Number.isFinite(msTotal) ? msTotal : undefined,
        loops: Number.isFinite(rLoops) && rLoops !== 1 ? rLoops : undefined,
        relation: t.table_name ? String(t.table_name) : undefined,
        index: t.key ? String(t.key) : undefined,
        flags: flags.length ? flags : undefined,
      },
      children,
    };
  };

  const buildBlock = (block: MyObj, label: string): PlanNode => {
    const children: PlanNode[] = [];
    const walkOp = (obj: MyObj, opLabel: string, kind: PlanNodeKind): PlanNode => {
      const inner = collectChildren(obj);
      const flags: string[] = [];
      if (obj.using_filesort) flags.push('filesort');
      if (obj.using_temporary_table) flags.push('temp-table');
      return {
        op: opLabel, detail: '', metrics: {}, severity: 0, kind,
        stats: flags.length ? { flags } : {},
        children: inner,
      };
    };
    const collectChildren = (obj: MyObj): PlanNode[] => {
      const out: PlanNode[] = [];
      if (obj.table) out.push(buildTable(obj.table as MyObj));
      const nl = obj.nested_loop as MyObj[] | undefined;
      if (Array.isArray(nl)) {
        const nlNode: PlanNode = {
          op: 'Nested Loop Join', detail: '', metrics: {}, severity: 0,
          kind: 'join-nested', stats: {},
          // A nested_loop entry may hold a materialized subquery / nested
          // block instead of a bare `table` — recurse there, don't deref
          // undefined.
          children: nl.flatMap(e => {
            const entry = e as MyObj;
            if (entry.table) return [buildTable(entry.table as MyObj)];
            return collectChildren(entry);
          }),
        };
        out.push(nlNode);
      }
      if (obj.ordering_operation) {
        const oo = obj.ordering_operation as MyObj;
        out.push(walkOp(oo, oo.using_filesort ? 'Sort (filesort)' : 'Sort', 'sort'));
      }
      if (obj.grouping_operation) {
        const go = obj.grouping_operation as MyObj;
        out.push(walkOp(go, go.using_temporary_table ? 'Group (temp table)' : 'Group', 'group'));
      }
      if (obj.duplicates_removal) out.push(walkOp(obj.duplicates_removal as MyObj, 'Distinct', 'distinct'));
      if (obj.windowing) out.push(walkOp(obj.windowing as MyObj, 'Window', 'window'));
      const union = obj.union_result as MyObj | undefined;
      if (union?.query_specifications) {
        const specs = union.query_specifications as MyObj[];
        out.push({
          op: 'Union', detail: '', metrics: {}, severity: 0,
          kind: 'union', stats: {},
          children: specs.map(s => buildBlock(s.query_block as MyObj, 'Query Block')),
        });
      }
      return out;
    };
    children.push(...collectChildren(block));
    const blockCost = Number((block.cost_info as MyObj)?.query_cost ?? 0);
    return {
      op: label,
      detail: block.select_id !== undefined ? `select #${block.select_id}` : '',
      metrics: blockCost ? { 'Cost': fmt(blockCost) } : {},
      severity: 0,
      kind: label === 'Materialized Subquery' ? 'materialize'
        : label === 'Subquery' ? 'subquery'
        : 'result',
      stats: { costTotal: blockCost || undefined },
      children,
    };
  };

  // Sum only the finite terms: MariaDB ANALYZE routinely reports just one of
  // the two, and `x + NaN` dropped the total entirely (WP-09 9.8).
  const timeTerms = [
    Number((parsed.query_optimization as MyObj)?.r_total_time_ms ?? NaN),
    Number(qb?.r_total_time_ms ?? NaN),
  ].filter(Number.isFinite);
  const totalMs = timeTerms.length ? timeTerms.reduce((a, b) => a + b, 0) : NaN;

  return {
    root: buildBlock(qb, 'SELECT Statement'),
    metricColumns: measured
      ? ['Cost', 'Read+Eval', 'Rows', 'Actual rows', 'Time (ms)', 'Filtered %']
      : ['Cost', 'Read+Eval', 'Rows', 'Filtered %'],
    summary: measured
      ? `Query cost ${fmt(queryCost)} — measured`
      : `Query cost ${fmt(queryCost)}`,
    // MySQL's JSON plan is pure optimiser estimate: its measured plan
    // (`EXPLAIN ANALYZE`, 8.0.18+) is TREE text and goes through
    // utils/planAnalyze.ts instead. MariaDB is the exception — its measured
    // plan (`ANALYZE FORMAT=JSON`) is this same JSON with `r_`-prefixed
    // measurements added, so a plan arriving here CAN be measured, and saying
    // otherwise would label real timings as estimates.
    measured,
    totalMs: Number.isFinite(totalMs) ? totalMs : undefined,
    engine: 'mysql',
  };
}

/**
 * Parse whatever the server gave us into the shared plan model.
 *
 * The format is detected rather than declared, because MySQL alone returns two
 * of them: `EXPLAIN FORMAT=JSON` is structured estimates, while the measured
 * `EXPLAIN ANALYZE` is indented TREE text with no JSON option. Keying off the
 * content means the caller does not have to know which button produced it.
 *
 * Throws when there is nothing parseable, so the caller can fall back to the
 * raw output instead of rendering an empty diagram.
 */
export function parsePlan(engine: string, content: string): ParsedPlan {
  const trimmed = content.trim();
  const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (engine === 'postgres') {
    if (!isJson) throw new Error('PostgreSQL plan is not JSON');
    return parsePgPlan(content);
  }
  if (engine === 'mysql') {
    if (isJson) return parseMysqlPlan(content);
    // EXPLAIN ANALYZE — measured, and the only MySQL plan with real timings.
    if (looksLikeTree(content)) return parseMysqlTree(content);
    throw new Error('unrecognised MySQL plan format');
  }
  if (engine === 'clickhouse') {
    // Tabular / indented text — there is no JSON plan to detect.
    return parseClickhousePlan(content);
  }
  if (engine === 'sqlserver') {
    // SHOWPLAN_XML (estimated) and STATISTICS XML (measured) are the same
    // document shape; the parser tells them apart by the presence of
    // RunTimeInformation, so the caller does not have to say which it asked for.
    return parseMssqlPlan(content);
  }
  throw new Error(`no plan parser for ${engine}`);
}
