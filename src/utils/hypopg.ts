/**
 * HypoPG "what-if" index advisor — pure SQL builders and cost-delta logic.
 *
 * HypoPG registers *hypothetical* indexes that live only in the current
 * session: they cost nothing to create, occupy no disk, and vanish on
 * `hypopg_reset()` or disconnect. That makes "would this index help?" a
 * question you can answer against production without writing anything real.
 *
 * The flow this module supports: plan a target query WITHOUT the index
 * (baseline), register the candidate hypothetically, plan again, and compare
 * the planner's estimated cost. Crucially every plan is a plain `EXPLAIN`
 * (no `ANALYZE`) — a hypothetical index cannot actually be scanned, so
 * executing the query would defeat the point *and* touch the database. Plain
 * EXPLAIN only asks the planner what it intends, which is exactly what a
 * what-if question wants and is entirely read-only.
 *
 * The cost figures come from the same PostgreSQL plan parser the Explain view
 * uses (utils/planParse), so a hypothetical plan is read identically to a real
 * one — including how we tell whether the planner actually reached for the
 * new index.
 */
import { parsePlan } from './planParse.ts';
import type { ParsedPlan, PlanNode } from './planParse.ts';
import { sqlLiteral } from './sqlIdent.ts';

// ── SQL builders ────────────────────────────────────────────────────────────

/**
 * One row: `[installed_version | null, available_version | null]`.
 * `installed` non-null ⇒ ready to use; only `available` non-null ⇒ present on
 * the server but needs `CREATE EXTENSION`; both null ⇒ not installed anywhere.
 */
export function hypopgDetectSql(): string {
  return `SELECT
  (SELECT extversion FROM pg_extension WHERE extname = 'hypopg') AS installed,
  (SELECT default_version FROM pg_available_extensions WHERE name = 'hypopg') AS available`;
}

/** Load the extension into the database. Idempotent; adds functions only. */
export function hypopgEnableSql(): string {
  return 'CREATE EXTENSION IF NOT EXISTS hypopg';
}

/**
 * Register one hypothetical index. Returns rows `[indexrelid, indexname]` —
 * the generated name looks like `<13342>btree_orders_customer_id` and is what
 * a later EXPLAIN prints when the planner picks it.
 */
export function hypopgCreateSql(indexDdl: string): string {
  return `SELECT indexrelid, indexname FROM hypopg_create_index(${sqlLiteral(stripTrailingSemicolon(indexDdl), 'postgres')})`;
}

/** Drop every hypothetical index registered in this session. */
export function hypopgResetSql(): string {
  return 'SELECT hypopg_reset()';
}

/**
 * Plan a query WITHOUT executing it. Plain EXPLAIN, never ANALYZE: a
 * hypothetical index has no physical pages to scan, and not running the query
 * is what keeps the advisor read-only.
 */
export function explainJsonSql(query: string): string {
  return `EXPLAIN (FORMAT JSON) ${stripTrailingSemicolon(query)}`;
}

/** A candidate must actually be a CREATE INDEX — anything else is a mistake. */
export function looksLikeCreateIndex(ddl: string): boolean {
  return /^\s*create\s+(unique\s+)?index\b/i.test(ddl);
}

/** A hypopg name is angle-bracketed with the backing oid, e.g. `<13342>btree_…`. */
export function isHypotheticalIndexName(name: string): boolean {
  return /^<\d+>/.test(name);
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

// ── detection ─────────────────────────────────────────────────────────────

export interface HypopgStatus {
  installed: boolean;
  available: boolean;
  installedVersion: string | null;
  availableVersion: string | null;
}

/** Interpret the single row returned by {@link hypopgDetectSql}. */
export function readHypopgStatus(row: unknown[] | undefined): HypopgStatus {
  const installedVersion = row && row[0] != null && row[0] !== '' ? String(row[0]) : null;
  const availableVersion = row && row[1] != null && row[1] !== '' ? String(row[1]) : null;
  return {
    installed: installedVersion !== null,
    available: availableVersion !== null || installedVersion !== null,
    installedVersion,
    availableVersion,
  };
}

// ── cost delta ──────────────────────────────────────────────────────────────

export interface CostDelta {
  baselineCost: number;
  hypoCost: number;
  /** hypo − baseline; negative means the candidate index is cheaper. */
  absolute: number;
  /** percent change relative to baseline (negative = improvement). */
  percent: number;
  /** True when the planner's estimated cost dropped with the index present. */
  improved: boolean;
  /** Did the planner actually pick a hypothetical index in the new plan? */
  indexUsed: boolean;
  /** Hypothetical index names that appear in the new plan. */
  usedIndexNames: string[];
}

function totalCost(plan: ParsedPlan): number {
  return plan.root.stats.costTotal ?? 0;
}

function collectIndexNames(node: PlanNode, into: Set<string>): void {
  if (node.stats.index) into.add(node.stats.index);
  for (const c of node.children) collectIndexNames(c, into);
}

/**
 * Compare a baseline plan against one produced with the candidate index
 * registered. `hypoIndexNames` are the names `hypopg_create_index` returned;
 * an index is counted as "used" when its name appears in the new plan (or,
 * defensively, when any angle-bracketed hypopg name does — a plan can pick a
 * different candidate than the one just added when several are live).
 */
export function computeCostDelta(
  baselineJson: string,
  hypoJson: string,
  hypoIndexNames: string[],
): CostDelta {
  const baseline = parsePlan('postgres', baselineJson);
  const hypo = parsePlan('postgres', hypoJson);
  const baselineCost = totalCost(baseline);
  const hypoCost = totalCost(hypo);
  const absolute = hypoCost - baselineCost;
  const percent = baselineCost > 0 ? (absolute / baselineCost) * 100 : 0;

  const names = new Set<string>();
  collectIndexNames(hypo.root, names);
  const created = new Set(hypoIndexNames);
  const usedIndexNames = [...names].filter(
    n => created.has(n) || isHypotheticalIndexName(n),
  );

  return {
    baselineCost,
    hypoCost,
    absolute,
    percent,
    improved: hypoCost < baselineCost,
    indexUsed: usedIndexNames.length > 0,
    usedIndexNames,
  };
}

/** A one-line verdict for the results banner. */
export function verdictOf(delta: CostDelta): string {
  if (!delta.indexUsed) {
    return delta.improved
      ? 'The planner did not use the index, yet the plan changed — investigate before trusting this.'
      : 'The planner ignored the hypothetical index. Building it for real would not help this query.';
  }
  if (delta.improved) {
    return `The planner chose the index and estimated cost fell ${Math.abs(delta.percent).toFixed(1)}%.`;
  }
  return 'The planner used the index but the estimated cost did not improve — not worth building.';
}
