/**
 * Where a long-running DDL statement reports its progress.
 *
 * "Is it stuck?" is the only question anyone asks about a nine-minute
 * `ALTER TABLE`, and both engines answer it — in completely different places,
 * neither of which is the process list:
 *
 * - **MySQL** publishes stages through `performance_schema.events_stages_current`,
 *   with `WORK_COMPLETED` / `WORK_ESTIMATED`. For online DDL that is a real
 *   percentage of a real phase ("copy to tmp table", "rebuild index"). It is
 *   **off by default**: the `stage/innodb/alter table%` instruments and the
 *   `events_stages_current` consumer both have to be enabled, and when they
 *   are not, the panel shows nothing and looks broken rather than unconfigured.
 * - **PostgreSQL** has dedicated progress views —
 *   `pg_stat_progress_create_index` for index builds (including
 *   `CONCURRENTLY`, which has the most phases and the longest waits) and
 *   `pg_stat_progress_cluster` for the table rewrites that `ALTER TABLE` and
 *   `VACUUM FULL` perform. Nothing needs enabling; they were simply never read.
 *
 * So the statement has to be recognised before the right question can be
 * asked. This module does that and hands back the query — no phases invented,
 * and when there is genuinely nothing to report it says which of the two
 * reasons applies.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type DdlKind = 'create-index' | 'alter-table' | 'vacuum-cluster' | 'other';

/**
 * What kind of long operation this is.
 *
 * Only the distinctions that change *where progress lives* are made — a
 * finer taxonomy would be a taxonomy nobody consumes.
 */
export function ddlKind(sql: string): DdlKind {
  const s = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (/^create\s+(unique\s+)?index\b/.test(s)) return 'create-index';
  if (/^reindex\b/.test(s)) return 'create-index';
  if (/^(vacuum\s+full|cluster)\b/.test(s)) return 'vacuum-cluster';
  if (/^alter\s+table\b/.test(s)) {
    // An ALTER that only adds an index is an index build as far as progress
    // reporting is concerned — PostgreSQL reports it through the same view.
    return /\badd\s+(unique\s+)?(index|key)\b/.test(s) ? 'create-index' : 'alter-table';
  }
  return 'other';
}

export interface ProgressProbe {
  /** The statement to poll, or null when this engine/kind has no source. */
  sql: string | null;
  /**
   * Why there is nothing, when `sql` is null or comes back empty — written
   * for someone deciding whether to go and enable something.
   */
  note?: string;
}

/**
 * The progress query for a watched backend, per engine and statement kind.
 *
 * `pid` is interpolated rather than bound because these run through the
 * monitor path, which takes no parameters — it is a number this module
 * produced from a process list, never user text, and it is coerced anyway.
 */
export function progressProbe(engine: string, kind: DdlKind, pid: number): ProgressProbe {
  const id = Math.trunc(Number(pid));
  if (!Number.isFinite(id)) return { sql: null, note: 'no backend to watch yet' };

  if (engine === 'postgres') {
    switch (kind) {
      case 'create-index':
        return {
          sql: `SELECT phase,
       CASE WHEN blocks_total > 0
            THEN round(100.0 * blocks_done / blocks_total)
            WHEN tuples_total > 0
            THEN round(100.0 * tuples_done / tuples_total) END AS pct,
       current_locker_pid
FROM pg_stat_progress_create_index WHERE pid = ${id}`,
          note: 'Index builds report their phase in pg_stat_progress_create_index (PG 12+). '
            + 'A CONCURRENTLY build spends most of its time waiting for older transactions '
            + 'to finish — current_locker_pid names the one it is waiting on.',
        };
      case 'alter-table':
      case 'vacuum-cluster':
        return {
          sql: `SELECT phase,
       CASE WHEN heap_blks_total > 0
            THEN round(100.0 * heap_blks_scanned / heap_blks_total) END AS pct,
       NULL::int AS current_locker_pid
FROM pg_stat_progress_cluster WHERE pid = ${id}`,
          note: 'A table rewrite reports through pg_stat_progress_cluster (PG 12+). '
            + 'An ALTER that only changes the catalog finishes without ever appearing there.',
        };
      default:
        return {
          sql: null,
          note: 'PostgreSQL publishes progress for index builds and table rewrites only. '
            + 'An ordinary statement reports its wait event instead, which the process list shows.',
        };
    }
  }

  if (engine === 'sqlserver') {
    // `sys.dm_exec_requests.percent_complete` is the direct analogue, and its
    // coverage is narrow in a way worth stating rather than discovering: SQL
    // Server populates it for BACKUP, RESTORE, DBCC CHECK*, DBCC SHRINK*,
    // ALTER INDEX REORGANIZE, ROLLBACK and recovery — and **not** for
    // CREATE INDEX or ALTER INDEX REBUILD, which are the two operations
    // someone watching a DDL is most likely to be running. A zero there means
    // "not reported for this command", not "no progress".
    //
    // The join to `sys.dm_exec_sessions` on `is_user_process` is what keeps
    // the ~40 background tasks out. The old `session_id > 50` heuristic is not
    // reliable on a modern instance — session 57 here is a background TASK
    // MANAGER, measured — and a background row answering for a user's pid
    // would report the wrong statement's progress.
    return {
      sql: `SELECT r.status, r.command,
       CASE WHEN r.percent_complete > 0 THEN r.percent_complete END AS pct,
       NULLIF(r.estimated_completion_time, 0) AS eta_ms
FROM sys.dm_exec_requests r
JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
WHERE r.session_id = ${id} AND s.is_user_process = 1`,
      note: 'SQL Server reports percent_complete for BACKUP, RESTORE, DBCC CHECK*/SHRINK*, '
        + 'ALTER INDEX REORGANIZE, ROLLBACK and recovery only — NOT for CREATE INDEX or '
        + 'ALTER INDEX REBUILD. An empty percentage on those two is the documented '
        + 'behaviour, not a stalled statement; watch its wait type instead.',
    };
  }

  // MySQL: one source for every kind, and it is off by default.
  return {
    sql: `SELECT IFNULL(p.STATE,''), IFNULL(s.EVENT_NAME,''),
       IFNULL(s.WORK_COMPLETED,-1), IFNULL(s.WORK_ESTIMATED,-1)
FROM information_schema.PROCESSLIST p
LEFT JOIN performance_schema.threads t ON t.PROCESSLIST_ID = p.ID
LEFT JOIN performance_schema.events_stages_current s ON s.THREAD_ID = t.THREAD_ID
WHERE p.ID = ${id}`,
    note: 'MySQL reports DDL stages through performance_schema, and the instruments are '
      + 'OFF by default — so an empty phase here usually means unconfigured, not stalled.',
  };
}

/**
 * The fix for the commonest reason a MySQL DDL shows no phase.
 *
 * Both halves are required and people reliably enable only the first: the
 * instrument produces the events, the consumer decides whether anything keeps
 * them. Enabling one and not the other looks exactly like enabling neither.
 *
 * Runtime-only — nothing here needs a restart, which is why it is worth
 * offering rather than merely documenting.
 */
export const MYSQL_STAGE_SETUP = [
  "UPDATE performance_schema.setup_instruments SET ENABLED = 'YES', TIMED = 'YES'\n"
  + "WHERE NAME LIKE 'stage/innodb/alter%';",
  "UPDATE performance_schema.setup_consumers SET ENABLED = 'YES'\n"
  + "WHERE NAME IN ('events_stages_current', 'events_stages_history_long');",
];

/** Does this statement do enough work to be worth watching for phases? */
export function reportsPhases(engine: string, sql: string): boolean {
  const kind = ddlKind(sql);
  // MySQL's performance_schema stages cover any statement; PostgreSQL and SQL
  // Server both publish progress for a NAMED set of operations only, so an
  // ordinary statement has nothing to watch on either.
  if (kind === 'other') return engine !== 'postgres' && engine !== 'sqlserver';
  return true;
}
