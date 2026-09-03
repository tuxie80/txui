/**
 * pg_stat_statements over time — snapshot → diff (PostgreSQL only).
 *
 * The six pgss views are single cumulative snapshots: they answer "what has
 * been expensive since the counters were last reset", never "what got worse
 * since this morning". This module captures a timestamped snapshot of
 * pg_stat_statements and diffs two of them by `queryid`, so a statement whose
 * total time, call count or per-call mean *increased between two moments* rises
 * to the top — which is the question a DBA actually asks during an incident.
 *
 * The counters are cumulative and monotonic within one measurement epoch, so a
 * later snapshot minus an earlier one is the work done in the interval. The one
 * thing that breaks that arithmetic is `pg_stat_statements_reset()` (or a
 * statement being evicted and re-inserted): after a reset the "later" counters
 * are SMALLER, and a naive subtraction reports a spurious negative. We do the
 * raw subtraction and expose {@link detectReset} so the panel can warn rather
 * than pretend a reset was a slowdown.
 *
 * Shape mirrors utils/schemaDiff: a `Runner`, a snapshot model built by a
 * fetch helper, and a pure diff over the two snapshots. Everything below the
 * fetch is pure and unit-tested from node (tests/pgssDiff.test.ts).
 */
import type { QueryResult } from '../types';

export type Runner = (sql: string) => Promise<QueryResult>;

// ── Availability ──────────────────────────────────────────────────────────────

/**
 * One row: `[installed_version | null, available_version | null]`.
 * `installed` non-null ⇒ the extension exists in this database; only
 * `available` non-null ⇒ present on the server but needs `CREATE EXTENSION`;
 * both null ⇒ not installed anywhere. Mirrors utils/hypopg's detect row.
 */
export function pgssDetectSql(): string {
  return `SELECT
  (SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed,
  (SELECT default_version FROM pg_available_extensions WHERE name = 'pg_stat_statements') AS available`;
}

/**
 * Create the views. Note this only *works* — and only *collects* — when the
 * library is in shared_preload_libraries (a server restart, not something a
 * GUI can do). When it is preloaded, `available` is non-null and this succeeds.
 */
export function pgssEnableSql(): string {
  return 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements';
}

/** `server_version_num` (e.g. 130004) — decides the exec-time column names. */
export function pgssServerVersionSql(): string {
  return `SELECT current_setting('server_version_num')`;
}

export interface PgssStatus {
  installed: boolean;
  available: boolean;
  installedVersion: string | null;
  availableVersion: string | null;
}

/** Interpret the single row returned by {@link pgssDetectSql}. */
export function readPgssStatus(row: unknown[] | undefined): PgssStatus {
  const installedVersion = row && row[0] != null && row[0] !== '' ? String(row[0]) : null;
  const availableVersion = row && row[1] != null && row[1] !== '' ? String(row[1]) : null;
  return {
    installed: installedVersion !== null,
    available: availableVersion !== null || installedVersion !== null,
    installedVersion,
    availableVersion,
  };
}

// ── Snapshot fetch ────────────────────────────────────────────────────────────

/**
 * The projection is fixed and index-addressed by {@link rowsToSnapshot}, so the
 * column ORDER here is load-bearing — keep the two in lockstep.
 *
 * `total_exec_time` / `mean_exec_time` are PG 13+. On 12 and earlier the
 * extension named them `total_time` / `mean_time` (it split planning from
 * execution in 13), so the caller passes `hasExecTime` from the server version
 * and we alias the older columns to the same output names.
 *
 * Rows with a null `queryid` are the `<insufficient privilege>` placeholders a
 * non-superuser sees for other users' statements — they carry no counters worth
 * diffing and cannot be keyed, so they are filtered out.
 */
export function pgssSnapshotSql(hasExecTime: boolean): string {
  const total = hasExecTime ? 'total_exec_time' : 'total_time';
  const mean = hasExecTime ? 'mean_exec_time' : 'mean_time';
  return `SELECT queryid::text AS queryid, query, calls,
       ${total} AS total_exec_time, ${mean} AS mean_exec_time,
       rows, shared_blks_hit, shared_blks_read
FROM pg_stat_statements
WHERE queryid IS NOT NULL`;
}

export interface PgssStat {
  queryid: string;
  query: string;
  calls: number;
  totalExecTime: number;   // milliseconds, cumulative
  meanExecTime: number;    // milliseconds per call
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
}

export interface PgssSnapshot {
  /** Date.now() at capture — the interval endpoint. */
  capturedAt: number;
  /** By queryid. */
  stats: Map<string, PgssStat>;
}

/** pgss counters arrive as bigint/double, which the bridge may stringify. */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Turn the {@link pgssSnapshotSql} result into a snapshot. Pure — the fetch
 * wrapper does the I/O, this does the shaping, so it can be tested from a
 * hand-built QueryResult. A duplicate queryid (same normalized statement seen
 * under two search_paths) keeps the last row; pgss itself dedupes by
 * (userid, dbid, queryid) but our key is queryid alone, which is what a
 * human-facing "the same statement" grouping wants.
 */
export function rowsToSnapshot(result: QueryResult, capturedAt: number): PgssSnapshot {
  const stats = new Map<string, PgssStat>();
  for (const r of result.rows) {
    const queryid = r[0] == null ? '' : String(r[0]);
    if (queryid === '') continue;
    const existing = stats.get(queryid);
    const stat: PgssStat = {
      queryid,
      query: String(r[1] ?? ''),
      calls: num(r[2]),
      totalExecTime: num(r[3]),
      meanExecTime: num(r[4]),
      rows: num(r[5]),
      sharedBlksHit: num(r[6]),
      sharedBlksRead: num(r[7]),
    };
    // Collapse a duplicate queryid by summing the additive counters; mean is
    // recomputed from the summed totals so it stays a real per-call figure.
    if (existing) {
      stat.calls += existing.calls;
      stat.totalExecTime += existing.totalExecTime;
      stat.rows += existing.rows;
      stat.sharedBlksHit += existing.sharedBlksHit;
      stat.sharedBlksRead += existing.sharedBlksRead;
      stat.meanExecTime = stat.calls > 0 ? stat.totalExecTime / stat.calls : 0;
    }
    stats.set(queryid, stat);
  }
  return { capturedAt, stats };
}

/**
 * Capture a snapshot now: detect the server version, run the version-correct
 * projection, and shape the result. The only impure entry point.
 */
export async function fetchPgssSnapshot(run: Runner): Promise<PgssSnapshot> {
  const verRow = await run(pgssServerVersionSql());
  const verNum = num(verRow.rows[0]?.[0]);
  const result = await run(pgssSnapshotSql(verNum >= 130000));
  return rowsToSnapshot(result, Date.now());
}

// ── Diff ──────────────────────────────────────────────────────────────────────

export type PgssDiffStatus =
  /** Present in both snapshots — deltas are the work done in the interval. */
  | 'changed'
  /** Only in the later snapshot — first seen (or re-inserted) in the interval. */
  | 'new'
  /** Only in the earlier snapshot — evicted, or wiped by a counter reset. */
  | 'gone';

export interface PgssDiffEntry {
  queryid: string;
  query: string;
  status: PgssDiffStatus;
  deltaCalls: number;
  deltaTotalTime: number;   // ms — the headline "how much more time this burned"
  deltaRows: number;
  /** Shift in per-call mean (after − before) — "did each run get slower". */
  deltaMeanTime: number;
  beforeCalls: number;
  afterCalls: number;
  beforeTotalTime: number;
  afterTotalTime: number;
  beforeMeanTime: number;
  afterMeanTime: number;
}

const ZERO = { calls: 0, totalExecTime: 0, meanExecTime: 0, rows: 0 };

function entryOf(
  queryid: string,
  query: string,
  status: PgssDiffStatus,
  b: Pick<PgssStat, 'calls' | 'totalExecTime' | 'meanExecTime' | 'rows'>,
  a: Pick<PgssStat, 'calls' | 'totalExecTime' | 'meanExecTime' | 'rows'>,
): PgssDiffEntry {
  return {
    queryid,
    query,
    status,
    deltaCalls: a.calls - b.calls,
    deltaTotalTime: a.totalExecTime - b.totalExecTime,
    deltaRows: a.rows - b.rows,
    deltaMeanTime: a.meanExecTime - b.meanExecTime,
    beforeCalls: b.calls,
    afterCalls: a.calls,
    beforeTotalTime: b.totalExecTime,
    afterTotalTime: a.totalExecTime,
    beforeMeanTime: b.meanExecTime,
    afterMeanTime: a.meanExecTime,
  };
}

/**
 * Diff two snapshots by queryid. A statement in both is `changed` with true
 * interval deltas; one only in `after` is `new` (baseline zero); one only in
 * `before` is `gone` (its counters subtracted to negatives). The result is
 * unsorted and unfiltered — {@link sortByTotalTimeDelta} orders it and
 * {@link isActive} drops the no-op rows, so callers compose the view they want.
 *
 * `before` and `after` are named for intent, not enforced by timestamp; passing
 * them reversed simply negates every delta.
 */
export function diffPgss(before: PgssSnapshot, after: PgssSnapshot): PgssDiffEntry[] {
  const ids = new Set([...before.stats.keys(), ...after.stats.keys()]);
  const out: PgssDiffEntry[] = [];
  for (const id of ids) {
    const b = before.stats.get(id);
    const a = after.stats.get(id);
    if (b && a) {
      out.push(entryOf(id, a.query || b.query, 'changed', b, a));
    } else if (a) {
      out.push(entryOf(id, a.query, 'new', ZERO, a));
    } else if (b) {
      out.push(entryOf(id, b.query, 'gone', b, ZERO));
    }
  }
  return out;
}

/**
 * Descending by total-time increase — the default "what got slower" ordering.
 * Ties break by call-count delta, then queryid, so the sort is stable and
 * deterministic across runs.
 */
export function sortByTotalTimeDelta(entries: PgssDiffEntry[]): PgssDiffEntry[] {
  return [...entries].sort((a, b) =>
    b.deltaTotalTime - a.deltaTotalTime
    || b.deltaCalls - a.deltaCalls
    || a.queryid.localeCompare(b.queryid));
}

/**
 * True when the statement actually did something in the interval. A `changed`
 * row with zero new calls never ran between the snapshots and is noise; `new`
 * and `gone` rows are always kept.
 */
export function isActive(e: PgssDiffEntry): boolean {
  return e.status !== 'changed' || e.deltaCalls !== 0 || e.deltaTotalTime !== 0;
}

/**
 * Did a counter reset (or eviction+reinsert) happen between the snapshots? A
 * matched statement whose call count went DOWN cannot have run negatively —
 * the only explanation is that pg_stat_statements was reset under it, which
 * makes every `changed` delta meaningless. The panel warns on this rather than
 * charting a phantom improvement.
 */
export function detectReset(before: PgssSnapshot, after: PgssSnapshot): boolean {
  for (const [id, b] of before.stats) {
    const a = after.stats.get(id);
    if (a && a.calls < b.calls) return true;
  }
  return false;
}
