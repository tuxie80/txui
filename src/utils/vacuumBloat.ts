/**
 * PostgreSQL 🧹 Vacuum & Bloat — the pure half of VacuumBloatPanel.
 *
 * Five questions, in the order a DBA asks them (docs/POSTGRES_PLAN.md W3):
 *
 *   1. Now        — is anything vacuuming, and is something blocking it?
 *   2. Backlog    — which tables are past their OWN autovacuum threshold?
 *   3. Bloat      — how much space is wasted, per table and per index?
 *   4. Wraparound — how close is the transaction-id emergency, and why?
 *   5. Act        — the statement that fixes it, with its lock level and cost
 *                   stated before it runs.
 *
 * The reading SQL is NOT re-derived here: sections 1, 2 and 4 are the curated
 * dbaViews entries verbatim (`dbaViewSql` looks them up by id, so this panel
 * and 🩺 DBA Views can never drift apart). What this module adds on top:
 *
 *   - an index-bloat ESTIMATE query (dbaViews has the table-level one only),
 *   - the pgstattuple flow — detect / offer / measure exactly, mirroring the
 *     tuner's capped approach (pg_collectors.rs): exact numbers only where the
 *     extension exists and the relation is small enough to scan,
 *   - row parsers + rankings for each section, and
 *   - the section-5 actions: every verb carries its lock level and a cost
 *   estimate; the exclusive-lock rewrites carry a typed-confirmation word.
 *
 * Pure and dependency-free apart from dbaViews + identifier quoting, so it is
 * driven straight from `node --test`. It never executes anything — the panel
 * does, through the audited `monitor_query` path.
 */

import { DBA_VIEWS } from './dbaViews.ts';
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';
import type { TableRef } from './tableMaintenance.ts';

export type { TableRef };

/** This panel is meaningless anywhere else — every view here is pg_*. */
export function vacuumBloatSupported(engine: string): boolean {
  return engine === 'postgres';
}

/**
 * The SQL of a curated PostgreSQL dbaViews entry, by id.
 *
 * Throws on an unknown id — a typo here must fail loudly in tests, not render
 * as an empty section in the panel.
 */
export function dbaViewSql(id: string): string {
  const v = (DBA_VIEWS.postgres ?? []).find(x => x.id === id);
  if (!v) throw new Error(`no such postgres dbaView: ${id}`);
  return v.sql;
}

// ── the section queries ──────────────────────────────────────────────────────

/** 1. Now — running vacuums (empty is a real answer: nothing is vacuuming). */
export const NOW_SQL = dbaViewSql('pg-progress-vacuum');
/** 1. Now — who is blocking whom, for the vacuum that is not making progress. */
export const BLOCKERS_SQL = dbaViewSql('pg-block-tree');
/** 2. Backlog — dead tuples against each table's OWN threshold (reloptions). */
export const BACKLOG_SQL = dbaViewSql('pg-autovac-due');
/** 2. Backlog, second signal — least-recently vacuumed/analyzed tables. */
export const HISTORY_SQL = dbaViewSql('pg-vacuum');
/** 3. Bloat — the table-level estimate (pg_statistic widths vs pages on disk). */
export const TABLE_BLOAT_SQL = dbaViewSql('pg-bloat-tables');
/** 4. Wraparound — per-database countdown to the forced shutdown. */
export const WRAPAROUND_SQL = dbaViewSql('pg-wraparound');
/** 4. Wraparound — the tables closest to their forced anti-wraparound vacuum. */
export const FREEZE_AGE_SQL = dbaViewSql('pg-freeze-age');
/** 4. Wraparound — what is holding freezing back (old xact, prepared, slot). */
export const FREEZE_BLOCKERS_SQL = dbaViewSql('pg-freeze-blockers');

/**
 * 3. Bloat — the per-index estimate, which dbaViews does not have.
 *
 * There is no honest catalog-only index bloat percentage: an index's dead
 * space is not in pg_statistic the way a table's row width is. What the
 * catalog CAN say, and what the tuner's heuristic uses, is size and shape —
 * a secondary index that has grown past the heap it serves is the finding.
 * The exact number needs pgstattuple (`pgstatindex`'s avg_leaf_density),
 * offered per index below. Small indexes are excluded: an 8 MB floor keeps
 * the noise of a fresh schema off the list.
 */
export const INDEX_BLOAT_SQL = `SELECT n.nspname AS schema, t.relname AS "table", i.indexrelname AS "index",
       pg_relation_size(i.indexrelid)::bigint AS index_bytes,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
       pg_relation_size(t.oid)::bigint AS table_bytes,
       pg_size_pretty(pg_relation_size(t.oid)) AS table_size,
       i.idx_scan
FROM pg_stat_user_indexes i
JOIN pg_class t ON t.oid = i.relid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE pg_relation_size(i.indexrelid) >= 8388608
ORDER BY pg_relation_size(i.indexrelid) DESC
LIMIT 50`;

/** Is pgstattuple there, and if not, COULD it be? Two booleans, one row. */
export const PGSTATTUPLE_STATE_SQL = `SELECT
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple') AS installed,
  EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgstattuple') AS available`;

/** Emit-to-editor SQL that installs the extension — generated, never run. */
export const PGSTATTUPLE_INSTALL_SQL = 'CREATE EXTENSION IF NOT EXISTS pgstattuple;';

/**
 * A `'schema.table'` regclass literal, safe for pgstattuple/pgstatindex and
 * pg_relation_size: identifiers are double-quoted first, then the whole path
 * is single-quoted — a name with a quote in it cannot break out.
 */
function regclassLiteral(schema: string, name: string): string {
  return sqlLiteral(`${quoteIdent(schema, 'postgres')}.${quoteIdent(name, 'postgres')}`, 'postgres');
}

/** Relation size in bytes — the cheap probe before an exact scan is offered. */
export function relationSizeSql(schema: string, name: string): string {
  return `SELECT pg_relation_size(${regclassLiteral(schema, name)})::bigint`;
}

/**
 * Exact table bloat via pgstattuple. This SCANS the whole table — the panel
 * offers it per table, capped by size, never as a bulk operation. The waste
 * figure is dead tuples plus free space, the two things VACUUM / a rewrite
 * can actually return.
 */
export function pgStatTableSql(schema: string, name: string): string {
  return `SELECT table_len::bigint, tuple_count::bigint, dead_tuple_count::bigint,
       dead_tuple_len::bigint, free_space::bigint,
       ROUND(100.0 * (dead_tuple_len + free_space) / NULLIF(table_len, 0), 1) AS waste_pct
FROM pgstattuple(${regclassLiteral(schema, name)})`;
}

/**
 * Exact index bloat via pgstatindex — avg_leaf_density is the percentage of
 * each leaf page actually holding tuples, so 100 − density is the waste. Same
 * float8 cast the tuner uses (the column is float4 and decodes badly as-is).
 */
export function pgStatIndexSql(schema: string, index: string): string {
  return `SELECT avg_leaf_density::float8 FROM pgstatindex(${regclassLiteral(schema, index)})`;
}

/**
 * Do not offer an exact scan above this size — pgstattuple reads every page,
 * and the tuner uses the same 4 GiB ceiling. Past it the estimate is the
 * answer, or pg_repack's --dry-run offline.
 */
export const EXACT_SCAN_MAX_BYTES = 4 * 1024 * 1024 * 1024;

// ── row parsers ──────────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function strOrNull(v: unknown): string | null {
  const s = str(v).trim();
  return s === '' || s.toUpperCase() === 'NULL' ? null : s;
}

/** 1. Now — one running vacuum, from pg-progress-vacuum. */
export interface ProgressRow {
  pid: number;
  database: string;
  table: string;
  phase: string;
  heapTotal: string;
  scannedPct: number | null;
  vacuumedPct: number | null;
  indexPasses: number;
}

export function parseProgressRow(row: readonly unknown[]): ProgressRow {
  const pct = (v: unknown) => (v == null || str(v) === '' ? null : num(v));
  return {
    pid: num(row[0]),
    database: str(row[1]),
    table: str(row[2]),
    phase: str(row[3]),
    heapTotal: str(row[4]),
    scannedPct: pct(row[5]),
    vacuumedPct: pct(row[6]),
    indexPasses: num(row[7]),
  };
}

/** 2. Backlog — one table against its own computed autovacuum threshold. */
export interface BacklogRow {
  schema: string;
  table: string;
  deadTup: number;
  /** threshold + scale_factor × reltuples, reloptions honoured (SQL-side). */
  threshold: number;
  deadPct: number | null;
  lastAutovacuum: string | null;
  autovacuumCount: number;
  /** deadTup / threshold — ≥ 1 means autovacuum is already due. */
  dueRatio: number;
  state: 'due' | 'rising' | 'ok';
}

export function parseBacklogRow(row: readonly unknown[]): BacklogRow {
  const deadTup = num(row[2]);
  const threshold = num(row[3]);
  const dueRatio = threshold > 0 ? deadTup / threshold : (deadTup > 0 ? Infinity : 0);
  return {
    schema: str(row[0]),
    table: str(row[1]),
    deadTup,
    threshold,
    deadPct: row[4] == null ? null : num(row[4]),
    lastAutovacuum: strOrNull(row[5]),
    autovacuumCount: num(row[6]),
    dueRatio,
    state: dueRatio >= 1 ? 'due' : dueRatio >= 0.5 ? 'rising' : 'ok',
  };
}

/** Worst-over-threshold first; a bigger absolute mess wins a tie. */
export function rankBacklog(rows: readonly BacklogRow[]): BacklogRow[] {
  return [...rows].sort((a, b) =>
    b.dueRatio - a.dueRatio
    || b.deadTup - a.deadTup
    || a.table.localeCompare(b.table));
}

/** One plain-language line for why a backlog row is where it is. */
export function backlogReason(r: BacklogRow): string {
  const dead = r.deadTup.toLocaleString();
  if (r.state === 'due') {
    return `${dead} dead tuples — ${r.dueRatio === Infinity ? 'no threshold'
      : `${r.dueRatio.toFixed(1)}× its own threshold of ${r.threshold.toLocaleString()}`}; autovacuum is due`;
  }
  if (r.state === 'rising') {
    return `${dead} dead tuples, ${(r.dueRatio * 100).toFixed(0)}% of the way to its threshold`;
  }
  return `${dead} dead tuples, within its threshold`;
}

/** 3. Bloat — one table, from the pg-bloat-tables ESTIMATE. */
export interface TableBloatRow {
  schema: string;
  table: string;
  size: string;
  relpages: number;
  estPages: number;
  estBloatPct: number | null;
  estWasted: string;
}

export function parseTableBloatRow(row: readonly unknown[]): TableBloatRow {
  return {
    schema: str(row[0]),
    table: str(row[1]),
    size: str(row[2]),
    relpages: num(row[3]),
    estPages: num(row[4]),
    estBloatPct: row[5] == null ? null : num(row[5]),
    estWasted: str(row[6]),
  };
}

/** 3. Bloat — one index, from {@link INDEX_BLOAT_SQL}. */
export interface IndexBloatRow {
  schema: string;
  table: string;
  index: string;
  indexBytes: number;
  indexSize: string;
  tableBytes: number;
  tableSize: string;
  idxScan: number;
  /** The tuner's heuristic: a secondary index larger than its heap is suspect. */
  suspect: boolean;
}

export function parseIndexBloatRow(row: readonly unknown[]): IndexBloatRow {
  const indexBytes = num(row[3]);
  const tableBytes = num(row[5]);
  return {
    schema: str(row[0]),
    table: str(row[1]),
    index: str(row[2]),
    indexBytes,
    indexSize: str(row[4]),
    tableBytes,
    tableSize: str(row[6]),
    idxScan: num(row[7]),
    suspect: tableBytes > 0 && indexBytes > tableBytes,
  };
}

/** 4. Wraparound — one database's countdown, from pg-wraparound. */
export interface WraparoundRow {
  database: string;
  xidAge: number;
  forcedVacuumAt: number;
  xidsUntilShutdown: number;
  pctToShutdown: number;
  state: 'ok' | 'watch' | 'urgent';
}

export function parseWraparoundRow(row: readonly unknown[]): WraparoundRow {
  const pct = num(row[4]);
  return {
    database: str(row[0]),
    xidAge: num(row[1]),
    forcedVacuumAt: num(row[2]),
    xidsUntilShutdown: num(row[3]),
    pctToShutdown: pct,
    // The view's own words: anything past 50% needs attention today; past 75%
    // the remaining headroom is months, not years, on any busy system.
    state: pct >= 75 ? 'urgent' : pct >= 50 ? 'watch' : 'ok',
  };
}

/** The worst wraparound row → the banner line for the section. */
export function wraparoundSummary(rows: readonly WraparoundRow[]): string {
  if (rows.length === 0) return 'No databases report a freeze age.';
  const worst = [...rows].sort((a, b) => b.pctToShutdown - a.pctToShutdown)[0];
  const headroom = `${worst.xidsUntilShutdown.toLocaleString()} transactions of headroom`;
  if (worst.state === 'urgent') {
    return `${worst.database} is at ${worst.pctToShutdown}% of the wraparound limit — ${headroom}. Act this week: freeze the oldest tables and clear the blockers below.`;
  }
  if (worst.state === 'watch') {
    return `${worst.database} is at ${worst.pctToShutdown}% of the wraparound limit — ${headroom}. Schedule the freeze before autovacuum is forced into it.`;
  }
  return `Oldest database (${worst.database}) is at ${worst.pctToShutdown}% of the wraparound limit — ${headroom}.`;
}

/** 4. Wraparound — one table's freeze age, from pg-freeze-age. */
export interface FreezeAgeRow {
  schema: string;
  table: string;
  xidAge: number;
  pctToForced: number | null;
  totalSize: string;
}

export function parseFreezeAgeRow(row: readonly unknown[]): FreezeAgeRow {
  return {
    schema: str(row[0]),
    table: str(row[1]),
    xidAge: num(row[2]),
    pctToForced: row[3] == null ? null : num(row[3]),
    totalSize: str(row[4]),
  };
}

/** 4. Wraparound — one thing holding freezing back, from pg-freeze-blockers. */
export interface FreezeBlockerRow {
  kind: string;
  ident: string;
  who: string;
  ageS: number | null;
  detail: string;
}

export function parseFreezeBlockerRow(row: readonly unknown[]): FreezeBlockerRow {
  return {
    kind: str(row[0]),
    ident: str(row[1]),
    who: str(row[2]),
    ageS: row[3] == null ? null : num(row[3]),
    detail: str(row[4]),
  };
}

/** 2. Backlog history — one table's vacuum/analyze timestamps, from pg-vacuum. */
export interface HistoryRow {
  schema: string;
  table: string;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
  vacuumCount: number;
  autovacuumCount: number;
  neverVacuumed: boolean;
  neverAnalyzed: boolean;
}

export function parseHistoryRow(row: readonly unknown[]): HistoryRow {
  const r: HistoryRow = {
    schema: str(row[0]),
    table: str(row[1]),
    lastVacuum: strOrNull(row[2]),
    lastAutovacuum: strOrNull(row[3]),
    lastAnalyze: strOrNull(row[4]),
    lastAutoanalyze: strOrNull(row[5]),
    vacuumCount: num(row[6]),
    autovacuumCount: num(row[7]),
    neverVacuumed: false,
    neverAnalyzed: false,
  };
  r.neverVacuumed = !r.lastVacuum && !r.lastAutovacuum;
  r.neverAnalyzed = !r.lastAnalyze && !r.lastAutoanalyze;
  return r;
}

// ── 5. the actions ───────────────────────────────────────────────────────────

export type VbActionId =
  | 'vacuum-verbose-analyze' | 'analyze'
  | 'reindex-index' | 'reindex-table'
  | 'vacuum-full' | 'cluster'
  | 'pg-repack';

export type VbLockLevel = 'low' | 'nonblocking' | 'exclusive' | 'external';

export interface VbAction {
  id: VbActionId;
  label: string;
  lockLevel: VbLockLevel;
  /** The lock this takes, said plainly — shown on the button. */
  lock: string;
  summary: string;
  /** The consequence, stated before it runs. Required for exclusive actions. */
  warning?: string;
  /** Runs through the audited exec path; false = generated advice only. */
  executes: boolean;
  /** Typed-confirmation word for the destructive ones (MaintenancePanel pattern). */
  confirmWord?: string;
  /** Minimum server major — REINDEX … CONCURRENTLY arrived in PG 12. */
  minMajor?: number;
  /** What the action names: a table, or one index of a table. */
  target: 'table' | 'index';
}

export const VB_ACTIONS: VbAction[] = [
  {
    id: 'vacuum-verbose-analyze',
    label: 'VACUUM (VERBOSE, ANALYZE)',
    lockLevel: 'low',
    lock: 'SHARE UPDATE EXCLUSIVE — runs alongside reads and writes',
    summary: 'Reclaim dead tuples and refresh planner statistics, with VERBOSE '
      + 'progress in the server log. The routine choice, and almost always the right one.',
    executes: true,
    target: 'table',
  },
  {
    id: 'analyze',
    label: 'ANALYZE',
    lockLevel: 'low',
    lock: 'SHARE UPDATE EXCLUSIVE — does not block reads or writes',
    summary: 'Recompute planner statistics only. The cheapest action — right when '
      + 'the stats are stale but the table is not bloated.',
    executes: true,
    target: 'table',
  },
  {
    id: 'reindex-index',
    label: 'REINDEX INDEX CONCURRENTLY',
    lockLevel: 'nonblocking',
    lock: 'non-blocking — builds the new index beside the old one',
    summary: 'Rebuild one bloated index without taking the table offline. PG 12+.',
    warning: 'CONCURRENTLY cannot run inside a transaction block, needs disk for '
      + 'a second copy of the index while it builds, and leaves an INVALID index '
      + 'behind if it is interrupted — which you then drop by hand.',
    executes: true,
    minMajor: 12,
    target: 'index',
  },
  {
    id: 'reindex-table',
    label: 'REINDEX TABLE CONCURRENTLY',
    lockLevel: 'nonblocking',
    lock: 'non-blocking — rebuilds every index of the table beside the old ones',
    summary: 'Rebuild all of a table’s indexes without taking it offline. PG 12+.',
    warning: 'CONCURRENTLY cannot run inside a transaction block and needs disk '
      + 'for a second copy of EVERY index while it builds. An interruption leaves '
      + 'INVALID indexes behind to drop by hand.',
    executes: true,
    minMajor: 12,
    target: 'table',
  },
  {
    id: 'vacuum-full',
    label: 'VACUUM FULL',
    lockLevel: 'exclusive',
    lock: 'ACCESS EXCLUSIVE — rewrites the whole table, blocks every read and write',
    summary: 'Fully compact the table and return the freed space to the OS.',
    warning: 'Takes an ACCESS EXCLUSIVE lock for the ENTIRE rewrite and needs '
      + 'free disk equal to the table size. On a large or busy table this is '
      + 'minutes to hours of total downtime — schedule it in a window. Plain '
      + 'VACUUM reclaims dead tuples without the lock, and pg_repack does the '
      + 'same rewrite online. On a prod connection the server-side guard '
      + 'rejects this unless the connection opted into DDL.',
    executes: true,
    confirmWord: 'VACUUM FULL',
    target: 'table',
  },
  {
    id: 'cluster',
    label: 'CLUSTER',
    lockLevel: 'exclusive',
    lock: 'ACCESS EXCLUSIVE — rewrites the table in index order, blocks all access',
    summary: 'Rewrite the table physically ordered by one of its indexes.',
    warning: 'The same ACCESS EXCLUSIVE lock and full rewrite as VACUUM FULL — '
      + 'the same total downtime, and the same prod guard. It also needs a '
      + 'clustered index already chosen on the table — the first time, use '
      + 'CLUSTER tbl USING some_index to set it.',
    executes: true,
    confirmWord: 'CLUSTER',
    target: 'table',
  },
  {
    id: 'pg-repack',
    label: 'pg_repack (advice)',
    lockLevel: 'external',
    lock: 'external tool — brief exclusive locks at start and end only',
    summary: 'The online VACUUM FULL: rebuilds the table (and optionally its '
      + 'indexes) with no lasting lock. Generated as advice to run from a shell '
      + '— TxUI does not execute external tools.',
    executes: false,
    target: 'table',
  },
];

export function findVbAction(id: VbActionId): VbAction {
  const a = VB_ACTIONS.find(x => x.id === id);
  if (!a) throw new Error(`no such vacuum action: ${id}`);
  return a;
}

/**
 * The SQL (or, for pg_repack, the generated advice block) for one action.
 *
 * Identifiers are quoted so a mixed-case or reserved name resolves to the
 * object it names. `index` is required for `reindex-index` and ignored by the
 * table-targeted actions. Everything here is PostgreSQL-only; the panel never
 * calls this for another engine.
 */
export function vbActionSql(
  action: VbActionId, ref: TableRef, opts: { index?: string; database?: string } = {},
): string {
  const s = quoteIdent(ref.schema, 'postgres');
  const t = `${s}.${quoteIdent(ref.name, 'postgres')}`;
  switch (action) {
    case 'vacuum-verbose-analyze':
      return `VACUUM (VERBOSE, ANALYZE) ${t};`;
    case 'analyze':
      return `ANALYZE ${t};`;
    case 'reindex-index':
      return `REINDEX INDEX CONCURRENTLY ${s}.${quoteIdent(opts.index ?? '', 'postgres')};`;
    case 'reindex-table':
      return `REINDEX TABLE CONCURRENTLY ${t};`;
    case 'vacuum-full':
      return `VACUUM FULL ${t};`;
    case 'cluster':
      return `CLUSTER ${t};`;
    case 'pg-repack': {
      const db = opts.database ?? '<database>';
      return [
        `-- pg_repack: the ONLINE table rebuild — no lasting ACCESS EXCLUSIVE lock.`,
        `-- It is an external tool plus a server extension, run from a shell, not from TxUI.`,
        `-- 1. install the pg_repack package matching this server's PostgreSQL major`,
        `-- 2. CREATE EXTENSION IF NOT EXISTS pg_repack;   -- once per database`,
        `-- 3. from a shell:`,
        `--   pg_repack -d ${db} -t ${t}`,
        `-- Disk: needs free space for a shadow copy of the table plus its rebuilt indexes.`,
        `-- Locks: brief ACCESS EXCLUSIVE at start and end only; reads and writes continue.`,
      ].join('\n');
    }
  }
}

/**
 * The cost of an action, stated before it runs.
 *
 * Sized from what the panel already knows — the bloat section's measured size,
 * the backlog's dead tuples. When nothing is known the text says so rather
 * than guessing a number.
 */
export function actionCost(
  action: VbActionId,
  ctx: { sizePretty?: string; deadTup?: number },
): string {
  const size = ctx.sizePretty;
  switch (action) {
    case 'vacuum-verbose-analyze':
      return size
        ? `reads the ${size} heap${ctx.deadTup ? `, reclaims ~${ctx.deadTup.toLocaleString()} dead tuples` : ''} in place — no extra disk, no blocking`
        : 'reads the whole heap once — no extra disk, no blocking';
    case 'analyze':
      return 'samples a statistical slice of the table — seconds at most';
    case 'reindex-index':
      return size
        ? `builds a second copy of the index — needs ~${size} of free disk for the duration`
        : 'builds a second copy of the index — needs its size again in free disk';
    case 'reindex-table':
      return 'builds a second copy of EVERY index of the table — needs their combined size in free disk';
    case 'vacuum-full':
    case 'cluster':
      return size
        ? `rewrites the whole table — needs ~${size} of free disk and holds its lock for the entire rewrite`
        : 'rewrites the whole table — needs its size in free disk and holds ACCESS EXCLUSIVE throughout';
    case 'pg-repack':
      return size
        ? `needs ~${size} of free disk for the shadow copy; runs online`
        : 'needs the table’s size again in free disk for the shadow copy; runs online';
  }
}
