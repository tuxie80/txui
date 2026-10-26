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
  /** Why there is nothing, when `sql` is null or comes back empty. */
  note?: string;
}

export interface MysqlStage {
  eventId: number;
  phase: string;
  status: 'pending' | 'running' | 'done' | 'skipped';
  workCompleted: number | null;
  workEstimated: number | null;
  pct: number | null;
  phaseSecs: number | null;
  stalledForSecs: number;
  connId: number | null;
  phaseThreadId: number | null;
  sourceQuery: string;
}

export const MYSQL_ALTER_PHASES = [
  'stage/innodb/alter table (read PK and internal sort)',
  'stage/innodb/alter table (merge sort)',
  'stage/innodb/alter table (insert)',
  'stage/innodb/alter table (log apply index)',
  'stage/innodb/alter table (flush)',
  'stage/innodb/alter table (log apply table)',
  'stage/innodb/alter table (end)',
] as const;

export interface MysqlStatementStats {
  lockSecs: number | null;
  rowsAffected: number | null;
  rowsExamined: number | null;
  rowsSent: number | null;
  warnings: number | null;
  errors: number | null;
}

export interface MysqlThreadSnapshot {
  threadId: number;
  statementThreadId: number | null;
  statementEventId: number | null;
  query: string;
  querySecs: number;
  state: string;
  user: string;
  host: string;
  database: string;
  command: string;
  stats: MysqlStatementStats;
  stages: MysqlStage[];
}

export interface MysqlProgressStats {
  active: number;
  done: number;
  remainingSecs: number | null;
  totalSecs: number | null;
  longestPhase: string | null;
  longestPhaseSecs: number | null;
}

export interface MysqlStageSetup {
  instrumentsReady: number;
  instrumentsTotal: number;
  consumersReady: number;
  consumersTotal: number;
  ready: boolean;
}

export function parseThreadId(input: string): number | null {
  if (!/^[1-9]\d*$/.test(input.trim())) return null;
  const id = Number(input.trim());
  return Number.isSafeInteger(id) ? id : null;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function mysqlWorkerStages(rows: readonly (readonly unknown[])[]): MysqlStage[] {
  const stages: MysqlStage[] = [];
  for (const row of rows) {
    if (row[4] === null || row[4] === undefined || row[4] === '') continue;
    stages.push({
      eventId: Number(row[10]),
      phase: String(row[4]),
      status: row[9] === 'done' ? 'done' : 'running',
      workCompleted: optionalNumber(row[5]),
      workEstimated: optionalNumber(row[6]),
      pct: optionalNumber(row[7]),
      phaseSecs: optionalNumber(row[8]),
      stalledForSecs: 0,
      connId: optionalNumber(row[0]),
      phaseThreadId: optionalNumber(row[22]),
      sourceQuery: String(row[1] ?? ''),
    });
  }
  return stages;
}

export function appendMysqlWorkerStages(
  snapshot: MysqlThreadSnapshot,
  rows: readonly (readonly unknown[])[],
): MysqlThreadSnapshot {
  const stages = new Map(snapshot.stages.map(stage => [stage.eventId, stage]));
  for (const stage of mysqlWorkerStages(rows)) stages.set(stage.eventId, stage);
  return { ...snapshot, stages: [...stages.values()].sort((a, b) => a.eventId - b.eventId) };
}

export function mysqlThreadSnapshot(rows: readonly (readonly unknown[])[]): MysqlThreadSnapshot | null {
  const first = rows[0];
  if (!first) return null;
  const stages = mysqlWorkerStages(rows);
  const source = stages.length > 0
    ? rows.find(row => row[4] !== null && row[4] !== undefined && row[4] !== '') ?? first
    : first;
  return {
    threadId: Number(first[0]),
    statementThreadId: optionalNumber(source[22]),
    statementEventId: optionalNumber(source[11]),
    query: String(source[1] ?? ''),
    querySecs: optionalNumber(source[2]) ?? 0,
    state: String(source[3] ?? ''),
    user: String(source[12] ?? ''),
    host: String(source[13] ?? ''),
    database: String(source[14] ?? ''),
    command: String(source[15] ?? ''),
    stats: {
      lockSecs: optionalNumber(source[16]),
      rowsAffected: optionalNumber(source[17]),
      rowsExamined: optionalNumber(source[18]),
      rowsSent: optionalNumber(source[19]),
      warnings: optionalNumber(source[20]),
      errors: optionalNumber(source[21]),
    },
    stages,
  };
}

export function mergeMysqlThreadSnapshots(
  previous: MysqlThreadSnapshot | null,
  next: MysqlThreadSnapshot,
): MysqlThreadSnapshot {
  if (!previous || previous.statementEventId !== next.statementEventId || previous.query !== next.query) {
    return next;
  }
  const stages = new Map(previous.stages.map(stage => [stage.eventId, stage]));
  for (const stage of next.stages) {
    const before = stages.get(stage.eventId);
    const elapsed = before?.phaseSecs != null && stage.phaseSecs != null
      ? Math.max(0, stage.phaseSecs - before.phaseSecs) : 0;
    const noWork = before != null && before.workCompleted != null
      && stage.workCompleted === before.workCompleted;
    const stalledForSecs = stage.status === 'running' && noWork
      ? before.stalledForSecs + elapsed : 0;
    stages.set(stage.eventId, { ...stage, stalledForSecs });
  }
  for (const stage of previous.stages) {
    if (!next.stages.some(current => current.eventId === stage.eventId)) {
      stages.set(stage.eventId, { ...stage, status: 'done' });
    }
  }
  return {
    ...next,
    stages: [...stages.values()].sort((a, b) => a.eventId - b.eventId),
  };
}

export function withMysqlAlterLifecycle(snapshot: MysqlThreadSnapshot): MysqlThreadSnapshot {
  const kind = ddlKind(snapshot.query);
  if (kind !== 'alter-table' && kind !== 'create-index') return snapshot;
  const stages = [...snapshot.stages];
  MYSQL_ALTER_PHASES.forEach((phase, index) => {
    if (!stages.some(stage => stage.phase === phase)) {
      stages.push({
        eventId: -(index + 1), phase, status: 'pending',
        workCompleted: null, workEstimated: null, pct: null, phaseSecs: null, stalledForSecs: 0,
        connId: null, phaseThreadId: null, sourceQuery: '',
      });
    }
  });
  const order = (stage: MysqlStage) => {
    const index = MYSQL_ALTER_PHASES.indexOf(stage.phase as typeof MYSQL_ALTER_PHASES[number]);
    return index < 0 ? MYSQL_ALTER_PHASES.length : index;
  };
  return {
    ...snapshot,
    stages: stages.sort((a, b) => order(a) - order(b) || a.eventId - b.eventId),
  };
}

export function finishMysqlThreadSnapshot(snapshot: MysqlThreadSnapshot): MysqlThreadSnapshot {
  return {
    ...snapshot,
    stages: snapshot.stages.map(stage => ({
      ...stage,
      status: stage.status === 'running' ? 'done' as const
        : stage.status === 'pending' ? 'skipped' as const : stage.status,
    })),
  };
}

export function mysqlPhaseTiming(stage: MysqlStage): { remainingSecs: number | null; totalSecs: number | null } {
  const elapsed = stage.phaseSecs;
  if (stage.status === 'done') return { remainingSecs: 0, totalSecs: elapsed };
  if (stage.stalledForSecs >= 30 || elapsed === null || stage.pct === null || stage.pct <= 0) {
    return { remainingSecs: null, totalSecs: null };
  }
  if (stage.pct >= 100) return { remainingSecs: 0, totalSecs: elapsed };
  const remainingSecs = elapsed * (100 - stage.pct) / stage.pct;
  return { remainingSecs, totalSecs: elapsed + remainingSecs };
}

export function mysqlProgressStats(snapshot: MysqlThreadSnapshot): MysqlProgressStats {
  const observed = snapshot.stages.filter(stage => stage.eventId > 0);
  const activeStages = observed.filter(stage => stage.status === 'running');
  const timings = activeStages.map(mysqlPhaseTiming);
  const remainingSecs = observed.length === 0
    ? null
    : activeStages.length === 0
      ? 0
      : timings.every(timing => timing.remainingSecs !== null)
        ? Math.max(...timings.map(timing => timing.remainingSecs!))
        : null;
  const longest = observed.reduce<MysqlStage | null>((best, stage) =>
    (stage.phaseSecs ?? -1) > (best?.phaseSecs ?? -1) ? stage : best, null);
  return {
    active: activeStages.length,
    done: observed.filter(stage => stage.status === 'done').length,
    remainingSecs,
    totalSecs: remainingSecs === null ? null : snapshot.querySecs + remainingSecs,
    longestPhase: longest?.phase ?? null,
    longestPhaseSecs: longest?.phaseSecs ?? null,
  };
}

export function mysqlCompletionLine(snapshot: MysqlThreadSnapshot): string {
  const stats = mysqlProgressStats(snapshot);
  const longest = stats.longestPhase
    ? ` · longest ${stats.longestPhase} ${stats.longestPhaseSecs?.toFixed(1) ?? '?'} s`
    : '';
  return `thread ${snapshot.threadId} finished after ${snapshot.querySecs.toFixed(1)} s · `
    + `${snapshot.stages.filter(stage => stage.eventId > 0).length} phases observed (${stats.done} done)${longest} · `
    + `rows affected/examined/sent ${snapshot.stats.rowsAffected ?? '—'}/`
    + `${snapshot.stats.rowsExamined ?? '—'}/${snapshot.stats.rowsSent ?? '—'} · `
    + `warnings ${snapshot.stats.warnings ?? '—'} · errors ${snapshot.stats.errors ?? '—'}`;
}

export function mysqlStageSetup(row: readonly unknown[] | undefined): MysqlStageSetup | null {
  if (!row) return null;
  const instrumentsReady = optionalNumber(row[0]) ?? 0;
  const instrumentsTotal = optionalNumber(row[1]) ?? 0;
  const consumersReady = optionalNumber(row[2]) ?? 0;
  const consumersTotal = optionalNumber(row[3]) ?? 0;
  return {
    instrumentsReady, instrumentsTotal, consumersReady, consumersTotal,
    ready: instrumentsTotal > 0 && consumersTotal > 0
      && instrumentsReady === instrumentsTotal && consumersReady === consumersTotal,
  };
}

export function threadActivityProbe(engine: string, pid: number): string | null {
  const id = Math.trunc(Number(pid));
  if (!Number.isFinite(id) || id <= 0) return null;
  if (engine === 'postgres') {
    return `SELECT pid, COALESCE(query, ''),
       COALESCE(EXTRACT(EPOCH FROM (now() - query_start))::int, 0),
       COALESCE(state, '')
FROM pg_stat_activity WHERE pid = ${id}`;
  }
  if (engine === 'sqlserver') {
    return `SELECT r.session_id, COALESCE(t.text, ''),
       r.total_elapsed_time / 1000.0, COALESCE(r.status, ''), COALESCE(r.command, ''),
       CASE WHEN r.percent_complete > 0 THEN r.percent_complete END,
       NULLIF(r.estimated_completion_time, 0)
FROM sys.dm_exec_requests r
JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.session_id = ${id} AND s.is_user_process = 1`;
  }
  return null;
}

/**
 * The progress query for a watched backend, per engine and statement kind.
 * Numeric IDs are validated/coerced here because monitor_query has no binds.
 */
export function progressProbe(engine: string, kind: DdlKind, pid: number): ProgressProbe {
  const id = Math.trunc(Number(pid));
  if (!Number.isFinite(id) || id <= 0) return { sql: null, note: 'no backend to watch yet' };

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
          note: 'PostgreSQL publishes progress for index builds and table rewrites only.',
        };
    }
  }

  if (engine === 'sqlserver') {
    return {
      sql: threadActivityProbe(engine, id),
      note: 'SQL Server reports percent_complete for BACKUP, RESTORE, DBCC CHECK*/SHRINK*, '
        + 'ALTER INDEX REORGANIZE, ROLLBACK and recovery only — NOT for CREATE INDEX or '
        + 'ALTER INDEX REBUILD.',
    };
  }

  return {
    sql: `SELECT p.ID AS conn_id, IFNULL(p.INFO, '') AS query,
       COALESCE(ROUND(stmt.TIMER_WAIT / 1e12, 1), p.TIME) AS query_secs,
       IFNULL(p.STATE, '') AS state,
       s.EVENT_NAME AS phase, s.WORK_COMPLETED, s.WORK_ESTIMATED,
       ROUND(100 * s.WORK_COMPLETED / NULLIF(s.WORK_ESTIMATED, 0), 1) AS pct,
       ROUND(s.TIMER_WAIT / 1e12, 1) AS phase_secs,
       IF(s.END_EVENT_ID IS NULL, 'running', 'done') AS phase_status,
       s.EVENT_ID, stmt.EVENT_ID AS statement_event_id,
       IFNULL(p.USER, ''), IFNULL(p.HOST, ''), IFNULL(p.DB, ''), IFNULL(p.COMMAND, ''),
       ROUND(stmt.LOCK_TIME / 1e12, 1) AS lock_secs,
       stmt.ROWS_AFFECTED, stmt.ROWS_EXAMINED, stmt.ROWS_SENT, stmt.WARNINGS, stmt.ERRORS,
       t.THREAD_ID AS statement_thread_id
FROM information_schema.PROCESSLIST p
LEFT JOIN performance_schema.threads t ON t.PROCESSLIST_ID = p.ID
LEFT JOIN performance_schema.events_statements_current stmt ON stmt.THREAD_ID = t.THREAD_ID
LEFT JOIN (
  SELECT THREAD_ID, EVENT_ID, END_EVENT_ID, NESTING_EVENT_ID, EVENT_NAME,
         WORK_COMPLETED, WORK_ESTIMATED, TIMER_WAIT
  FROM performance_schema.events_stages_current
  UNION ALL
  SELECT THREAD_ID, EVENT_ID, END_EVENT_ID, NESTING_EVENT_ID, EVENT_NAME,
         WORK_COMPLETED, WORK_ESTIMATED, TIMER_WAIT
  FROM performance_schema.events_stages_history
) s ON s.THREAD_ID = t.THREAD_ID
 AND s.NESTING_EVENT_ID = stmt.EVENT_ID
 AND (s.EVENT_NAME LIKE 'stage/innodb/alter%' OR s.EVENT_NAME LIKE 'stage/sql/copy%')
WHERE p.ID = ${id}
ORDER BY s.EVENT_ID`,
    note: 'MySQL ALTER stages require performance_schema instruments and consumers.',
  };
}

export const MYSQL_CURRENT_ALTER_STAGES_SQL = `SELECT
  t.PROCESSLIST_ID AS conn_id, IFNULL(t.PROCESSLIST_INFO, '') AS query,
  ROUND(s.TIMER_WAIT / 1e12, 1) AS query_secs, '' AS state,
  s.EVENT_NAME AS phase, s.WORK_COMPLETED, s.WORK_ESTIMATED,
  ROUND(100 * s.WORK_COMPLETED / NULLIF(s.WORK_ESTIMATED, 0), 1) AS pct,
  ROUND(s.TIMER_WAIT / 1e12, 1) AS phase_secs,
  IF(s.END_EVENT_ID IS NULL, 'running', 'done') AS phase_status,
  s.EVENT_ID, s.NESTING_EVENT_ID AS statement_event_id,
  IFNULL(t.PROCESSLIST_USER, ''), IFNULL(t.PROCESSLIST_HOST, ''),
  IFNULL(t.PROCESSLIST_DB, ''), IFNULL(t.PROCESSLIST_COMMAND, ''),
  0 AS lock_secs, 0 AS rows_affected, 0 AS rows_examined, 0 AS rows_sent,
  0 AS warnings, 0 AS errors, s.THREAD_ID AS statement_thread_id
FROM performance_schema.events_stages_current s
JOIN performance_schema.threads t USING (THREAD_ID)
WHERE s.EVENT_NAME LIKE 'stage/innodb/alter%' OR s.EVENT_NAME LIKE 'stage/sql/copy%'
ORDER BY s.EVENT_ID`;

export const MYSQL_STAGE_SETUP = [
  "UPDATE performance_schema.setup_instruments SET ENABLED = 'YES', TIMED = 'YES'\n"
  + "WHERE NAME LIKE 'stage/innodb/alter%' OR NAME = 'stage/sql/copy to tmp table';",
  "UPDATE performance_schema.setup_consumers SET ENABLED = 'YES'\n"
  + "WHERE NAME LIKE 'events_stages_%';",
];

export const MYSQL_STAGE_STATUS_SQL = `SELECT
  (SELECT COUNT(*) FROM performance_schema.setup_instruments
    WHERE (NAME LIKE 'stage/innodb/alter%' OR NAME = 'stage/sql/copy to tmp table')
      AND ENABLED = 'YES' AND TIMED = 'YES'),
  (SELECT COUNT(*) FROM performance_schema.setup_instruments
    WHERE NAME LIKE 'stage/innodb/alter%' OR NAME = 'stage/sql/copy to tmp table'),
  (SELECT COUNT(*) FROM performance_schema.setup_consumers
    WHERE NAME LIKE 'events_stages_%' AND ENABLED = 'YES'),
  (SELECT COUNT(*) FROM performance_schema.setup_consumers
    WHERE NAME LIKE 'events_stages_%')`;

/** Does this statement do enough work to be worth watching for phases? */
export function reportsPhases(engine: string, sql: string): boolean {
  const kind = ddlKind(sql);
  if (kind === 'other') return engine !== 'postgres' && engine !== 'sqlserver';
  return true;
}
