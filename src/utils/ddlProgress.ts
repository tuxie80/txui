/**
 * Where a long-running DDL statement reports its progress.
 *
 * "Is it stuck?" is the only question anyone asks about a nine-minute
 * `ALTER TABLE`, and each engine family answers it in a different catalog:
 *
 * - **MariaDB** publishes stage number, stage count and current-stage percentage
 *   directly through `information_schema.PROCESSLIST`, without Performance Schema.
 * - **MySQL and Percona** publish stages through `performance_schema.events_stages_current`,
 *   with `WORK_COMPLETED` / `WORK_ESTIMATED`. For online DDL that is a real
 *   percentage of a real phase ("copy to tmp table", "rebuild index"). It is
 *   **off by default**: the `stage/innodb/alter table%` instruments and the
 *   `events_stages_current` consumer both have to be enabled, and when they
 *   are not, the panel shows nothing and looks broken rather than unconfigured.
 * - **Cloud SQL for MySQL** queues replica-only secondary indexes through
 *   `mysql.addSecondaryIdxOnReplica`; `mysql.cloudsql_replica_idx_status`
 *   exposes queue state, retries, errors, timing and the worker thread when one
 *   exists. It complements, rather than replaces, ordinary InnoDB stages.
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

export type DdlKind = 'create-index' | 'alter-table' | 'vacuum-cluster' | 'maintenance' | 'other';

/**
 * What kind of long operation this is.
 *
 * Only the distinctions that change *where progress lives* are made — a
 * finer taxonomy would be a taxonomy nobody consumes.
 */
function normalizedDdl(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function ddlKind(sql: string): DdlKind {
  const s = normalizedDdl(sql);

  if (/^create\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:(?:clustered|nonclustered|columnstore|fulltext|spatial|vector|primary\s+xml|xml|json)\s+)*index\b/.test(s)) {
    return 'create-index';
  }
  if (/^call\s+mysql\.addsecondaryidxonreplica\s*\(/.test(s)) return 'create-index';
  if (/^reindex\b/.test(s)) return 'create-index';
  if (/^alter\s+index\b.*\brebuild(?:\s*\(|\s+with\b|\s*;|$)/.test(s)) return 'create-index';
  if (/^(vacuum\s+full|cluster)\b/.test(s)) return 'vacuum-cluster';
  if (/^(?:(?:optimize|repair|check|analyze)\s+(?:local\s+)?table|load\s+data)\b/.test(s)) {
    return 'maintenance';
  }
  if (/^alter\s+table\b/.test(s)) {
    // PostgreSQL reports indexes created by table constraints through the same
    // progress view as CREATE INDEX. MySQL-family index forms build too.
    const add = '\\badd\\s+(?:constraint\\s+(?:"[^"]*"|`[^`]*`|\\[[^\\]]*\\]|\\S+)\\s+)?';
    const index = new RegExp(add + '(?:(?:unique|fulltext|spatial|vector)\\s+)?(?:index|key)\\b');
    const constraint = new RegExp(add + '(?:primary\\s+key|unique)\\b');
    return index.test(s) || constraint.test(s) ? 'create-index' : 'alter-table';
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

export interface MariaDbNativeProgress {
  stage: number;
  maxStage: number;
  stagePct: number | null;
  totalPct: number | null;
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
  native?: MariaDbNativeProgress;
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

function mysqlStageKey(stage: MysqlStage): string {
  return `${stage.phaseThreadId ?? 'unknown'}:${stage.eventId}`;
}

function compareMysqlStages(a: MysqlStage, b: MysqlStage): number {
  return a.eventId - b.eventId || (a.phaseThreadId ?? 0) - (b.phaseThreadId ?? 0);
}

export function appendMysqlWorkerStages(
  snapshot: MysqlThreadSnapshot,
  rows: readonly (readonly unknown[])[],
): MysqlThreadSnapshot {
  const related = rows.filter(row => {
    const connId = optionalNumber(row[0]);
    return snapshot.statementEventId !== null
      && optionalNumber(row[11]) === snapshot.statementEventId
      && (connId === snapshot.threadId || connId === null);
  });
  const stages = new Map(snapshot.stages.map(stage => [mysqlStageKey(stage), stage]));
  for (const stage of mysqlWorkerStages(related)) stages.set(mysqlStageKey(stage), stage);
  return { ...snapshot, stages: [...stages.values()].sort(compareMysqlStages) };
}

export function mysqlThreadSnapshot(rows: readonly (readonly unknown[])[]): MysqlThreadSnapshot | null {
  const first = rows[0];
  if (!first) return null;
  const stages = mysqlWorkerStages(rows);
  const source = stages.length > 0
    ? rows.find(row => row[4] !== null && row[4] !== undefined && row[4] !== '') ?? first
    : first;
  const nativeStage = optionalNumber(source[23]);
  const nativeMaxStage = optionalNumber(source[24]);
  const hasNativeProgress = nativeStage !== null && nativeMaxStage !== null;
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
    native: hasNativeProgress ? {
      stage: nativeStage,
      maxStage: nativeMaxStage,
      stagePct: nativeMaxStage > 0 ? optionalNumber(source[25]) : null,
      totalPct: nativeMaxStage > 0 ? optionalNumber(source[26]) : null,
    } : undefined,
  };
}

export function mergeMysqlThreadSnapshots(
  previous: MysqlThreadSnapshot | null,
  next: MysqlThreadSnapshot,
): MysqlThreadSnapshot {
  if (!previous || previous.query !== next.query
    || (previous.statementEventId !== null && next.statementEventId !== null
      && previous.statementEventId !== next.statementEventId)) {
    return next;
  }
  const stages = new Map(previous.stages.map(stage => [mysqlStageKey(stage), stage]));
  for (const stage of next.stages) {
    const key = mysqlStageKey(stage);
    const before = stages.get(key);
    const elapsed = before?.phaseSecs != null && stage.phaseSecs != null
      ? Math.max(0, stage.phaseSecs - before.phaseSecs) : 0;
    const noWork = before != null && before.workCompleted != null
      && stage.workCompleted === before.workCompleted;
    const stalledForSecs = stage.status === 'running' && noWork
      ? before.stalledForSecs + elapsed : 0;
    stages.set(key, { ...stage, stalledForSecs });
  }
  for (const stage of previous.stages) {
    if (!next.stages.some(current => mysqlStageKey(current) === mysqlStageKey(stage))) {
      stages.set(mysqlStageKey(stage), { ...stage, status: 'done' });
    }
  }
  return {
    ...next,
    stages: [...stages.values()].sort(compareMysqlStages),
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
  const native = snapshot.native && snapshot.native.maxStage > 0
    ? ` · last MariaDB stage ${snapshot.native.stage}/${snapshot.native.maxStage}`
      + ` ${snapshot.native.stagePct?.toFixed(1) ?? '—'}%`
      + ` (overall ${snapshot.native.totalPct?.toFixed(1) ?? '—'}%)`
    : '';
  return `thread ${snapshot.threadId} finished after ${snapshot.querySecs.toFixed(1)} s · `
    + `${snapshot.stages.filter(stage => stage.eventId > 0).length} phases observed (${stats.done} done)${longest}${native} · `
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
       NULLIF(r.estimated_completion_time, 0),
       NULLIF(r.blocking_session_id, 0), r.wait_type, r.wait_time / 1000.0,
       r.cpu_time / 1000.0, r.reads, r.writes, r.logical_reads, r.dop,
       r.granted_query_memory, r.start_time, r.is_resumable
FROM sys.dm_exec_requests r
JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.session_id = ${id} AND s.is_user_process = 1`;
  }
  return null;
}

export interface SqlServerProgress {
  phase: string;
  pct: number | null;
  detail: string;
}

export const SQLSERVER_RESUMABLE_PROGRESS_SQL = `SELECT object_id, index_id, name, sql_text,
       state_desc, total_execution_time, percent_complete, page_count, partition_number
FROM sys.index_resumable_operations`;

export const SQLSERVER_ONLINE_INDEX_EVENTS_SQL = `SELECT s.name,
       e.event_xml.value('(@timestamp)[1]', 'datetime2'),
       CAST(e.event_xml.query('.') AS nvarchar(max))
FROM sys.dm_xe_sessions s
JOIN sys.dm_xe_session_targets t ON t.event_session_address = s.address
JOIN sys.dm_xe_session_events ev ON ev.event_session_address = s.address
CROSS APPLY (SELECT CAST(t.target_data AS xml) AS target_xml) x
CROSS APPLY x.target_xml.nodes('/RingBufferTarget/event[@name="progress_report_online_index_operation"]') e(event_xml)
WHERE t.target_name = 'ring_buffer'
  AND ev.event_name = 'progress_report_online_index_operation'
ORDER BY 2`;

export function sqlServerOperatorProgressSql(pid: number): string | null {
  const id = Math.trunc(Number(pid));
  if (!Number.isFinite(id) || id <= 0) return null;
  return `SELECT node_id, physical_operator_name,
       SUM(row_count), SUM(estimate_row_count),
       SUM(elapsed_time_ms), SUM(cpu_time_ms)
FROM sys.dm_exec_query_profiles
WHERE session_id = ${id}
GROUP BY node_id, physical_operator_name
ORDER BY node_id`;
}

function normalizedStatement(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();
}

export function sqlServerResumableProgress(
  rows: readonly (readonly unknown[])[], query: string,
): SqlServerProgress | null {
  const wanted = normalizedStatement(query);
  const matches = rows.filter(row => {
    const candidate = normalizedStatement(String(row[3] ?? ''));
    return candidate.length > 0 && (wanted === candidate || wanted.includes(candidate));
  });
  if (matches.length !== 1) return null;
  const row = matches[0];
  const state = String(row[4] ?? 'running').toLowerCase();
  const minutes = optionalNumber(row[5]);
  const pages = optionalNumber(row[7]);
  const partition = optionalNumber(row[8]);
  return {
    phase: `resumable index operation · ${state}`,
    pct: optionalNumber(row[6]),
    detail: `sys.index_resumable_operations · ${minutes ?? '—'} min · ${pages?.toLocaleString() ?? '—'} pages`
      + (partition === null ? '' : ` · partition ${partition}`),
  };
}

function xmlField(xml: string, names: readonly string[]): string | null {
  for (const name of names) {
    const match = xml.match(new RegExp(`<(?:action|data)\\b[^>]*\\bname="${name}"[^>]*>[\\s\\S]*?<value>([\\s\\S]*?)</value>`, 'i'));
    if (match) return match[1].trim();
  }
  return null;
}

const ONLINE_INDEX_STAGES: Record<string, string> = {
  '1': 'start', '2': 'stage 1 · base object build', '3': 'stage 1 complete',
  '4': 'stage 2 · nonclustered indexes', '5': 'stage 2 complete',
  '6': 'inserting rows', '7': 'done',
};

export function sqlServerOnlineIndexProgress(
  rows: readonly (readonly unknown[])[], pid: number, since?: unknown,
): SqlServerProgress | null {
  const started = since === null || since === undefined ? null : Date.parse(String(since));
  const events = rows.map(row => ({ row, xml: String(row[2] ?? '') }))
    .filter(event => Number(xmlField(event.xml, ['session_id', 'spid'])) === pid)
    .filter(event => {
      if (started === null || !Number.isFinite(started)) return true;
      const timestamp = Date.parse(String(event.row[1] ?? ''));
      return Number.isFinite(timestamp) && timestamp >= started;
    });
  if (events.length === 0) return null;
  let phase = 'online index operation';
  let inserted: number | null = null;
  let partition: number | null = null;
  for (const event of events) {
    const stage = xmlField(event.xml, ['event_subclass', 'progress_stage', 'subclass']);
    if (stage !== null && stage !== '6') phase = ONLINE_INDEX_STAGES[stage] ?? stage;
    const rows = optionalNumber(xmlField(event.xml, ['bigint_data1', 'rows_inserted', 'row_count']));
    if (rows !== null) inserted = rows;
    partition = optionalNumber(xmlField(event.xml, ['partition_number'])) ?? partition;
  }
  return {
    phase,
    pct: null,
    detail: `online index Extended Events · ${inserted === null ? 'no row count yet' : `${inserted.toLocaleString()} rows inserted`}`
      + (partition === null ? '' : ` · partition ${partition}`),
  };
}

export function sqlServerOperatorProgress(
  rows: readonly (readonly unknown[])[],
): SqlServerProgress | null {
  const candidates = rows.map(row => ({
    name: String(row[1] ?? 'operator'),
    rows: optionalNumber(row[2]), estimate: optionalNumber(row[3]),
  })).filter(row => row.rows !== null || row.estimate !== null);
  if (candidates.length === 0) return null;
  const scan = candidates.find(row => /scan/i.test(row.name) && (row.estimate ?? 0) > 0);
  const selected = scan ?? candidates.reduce((best, row) =>
    (row.estimate ?? -1) > (best.estimate ?? -1) ? row : best);
  const pct = selected.rows !== null && selected.estimate !== null && selected.estimate > 0
    ? 100 * selected.rows / selected.estimate : null;
  return {
    phase: `${selected.name} · estimated operator progress`,
    pct,
    detail: `${selected.rows?.toLocaleString() ?? '—'} / ${selected.estimate?.toLocaleString() ?? '—'} rows · query profiles; not total DDL completion`,
  };
}

export function sqlServerActivityDiagnostics(row: readonly unknown[]): string[] {
  const diagnostics: string[] = [];
  const blocker = optionalNumber(row[7]);
  if (blocker !== null && blocker > 0) diagnostics.push(`blocked by session ${blocker}`);
  const wait = String(row[8] ?? '');
  if (wait) diagnostics.push(`wait ${wait} ${optionalNumber(row[9])?.toFixed(1) ?? '0.0'} s`);
  const cpu = optionalNumber(row[10]);
  if (cpu !== null) diagnostics.push(`CPU ${cpu.toFixed(1)} s`);
  const reads = optionalNumber(row[11]);
  const writes = optionalNumber(row[12]);
  const logical = optionalNumber(row[13]);
  if (reads !== null || writes !== null || logical !== null) {
    diagnostics.push(`reads ${logical ?? '—'} logical / ${reads ?? '—'} physical · writes ${writes ?? '—'}`);
  }
  const dop = optionalNumber(row[14]);
  if (dop !== null && dop > 0) diagnostics.push(`DOP ${dop}`);
  const memory = optionalNumber(row[15]);
  if (memory !== null) diagnostics.push(`granted memory ${(memory * 8 / 1024).toFixed(1)} MiB`);
  return diagnostics;
}

export interface CloudSqlReplicaIndexJob {
  idxId: number;
  createStmt: string;
  action: string;
  threadId: number | null;
  startTime: string;
  endTime: string | null;
  retryCount: number;
  error: string | null;
  commentTag: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | string;
}

export const CLOUDSQL_REPLICA_IDX_STATUS_SQL = `SELECT idx_id, create_stmt, action, thread_id,
       start_time, end_time, retry_count, err_msg, comment_tag, status
FROM mysql.cloudsql_replica_idx_status
ORDER BY start_time DESC, idx_id DESC
LIMIT 50`;

export function cloudSqlReplicaIndexJobs(rows: readonly (readonly unknown[])[]): CloudSqlReplicaIndexJob[] {
  return rows.map(row => ({
    idxId: Number(row[0]),
    createStmt: String(row[1] ?? ''),
    action: String(row[2] ?? ''),
    threadId: optionalNumber(row[3]),
    startTime: String(row[4] ?? ''),
    endTime: row[5] === null || row[5] === undefined ? null : String(row[5]),
    retryCount: optionalNumber(row[6]) ?? 0,
    error: row[7] === null || row[7] === undefined ? null : String(row[7]),
    commentTag: String(row[8] ?? ''),
    status: String(row[9] ?? ''),
  }));
}

export function cloudSqlReplicaIndexJobLine(job: CloudSqlReplicaIndexJob): string {
  const thread = job.threadId === null ? 'no active thread' : `thread ${job.threadId}`;
  const retries = job.retryCount > 0 ? ` · retries ${job.retryCount}` : '';
  const error = job.error ? ` · ${job.error}` : '';
  return `managed index #${job.idxId} ${job.action} · ${job.status} · ${thread}${retries}${error}`;
}

export interface ActivityCompletionSnapshot {
  querySecs: number;
  phase: string;
  pct: number | null;
  detail: string;
  diagnostics: string[];
}

export function activityCompletionLine(
  engine: string, threadId: number, snapshot: ActivityCompletionSnapshot,
): string {
  const source = engine === 'postgres' ? 'backend' : 'session';
  const phase = snapshot.phase || 'not reported';
  const pct = snapshot.pct === null ? 'no server estimate' : `${snapshot.pct.toFixed(1)}%`;
  const detail = snapshot.detail ? ` · ${snapshot.detail}` : '';
  const diagnostics = snapshot.diagnostics.length > 0 ? ` · ${snapshot.diagnostics.join(' · ')}` : '';
  return `${source} ${threadId} finished after ${snapshot.querySecs.toFixed(1)} s · `
    + `final observed phase ${phase} · last observed progress ${pct}${detail}${diagnostics}`;
}

/**
 * The progress query for a watched backend, per engine and statement kind.
 * Numeric IDs are validated/coerced here because monitor_query has no binds.
 */
export function progressProbe(engine: string, kind: DdlKind, pid: number, flavor?: 'mysql' | 'mariadb' | 'percona'): ProgressProbe {
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
      note: 'sys.dm_exec_requests reports percent_complete for BACKUP, RESTORE, DBCC CHECK*/SHRINK*, '
        + 'ALTER INDEX REORGANIZE, ROLLBACK and recovery only — NOT for CREATE INDEX or '
        + 'ALTER INDEX REBUILD in the ordinary non-resumable case. Resumable, online-event and '
        + 'query-profile metadata are probed separately.',
    };
  }

  if (engine !== 'mysql') {
    return {
      sql: null,
      note: `${engine} does not expose a supported cross-session DDL progress catalog.`,
    };
  }

  if (flavor === 'mariadb') {
    return {
      sql: `SELECT p.ID AS conn_id, IFNULL(p.INFO, '') AS query,
       ROUND(p.TIME_MS / 1000, 1) AS query_secs, IFNULL(p.STATE, '') AS state,
       NULL AS phase, NULL AS work_completed, NULL AS work_estimated,
       NULL AS pct, NULL AS phase_secs, 'running' AS phase_status,
       NULL AS event_id, NULL AS statement_event_id,
       IFNULL(p.USER, ''), IFNULL(p.HOST, ''), IFNULL(p.DB, ''), IFNULL(p.COMMAND, ''),
       NULL AS lock_secs, NULL AS rows_affected, p.EXAMINED_ROWS,
       NULL AS rows_sent, NULL AS warnings, NULL AS errors, NULL AS statement_thread_id,
       p.STAGE, p.MAX_STAGE, p.PROGRESS,
       CASE WHEN p.MAX_STAGE < 2 THEN p.PROGRESS
            ELSE (p.STAGE - 1) / p.MAX_STAGE * 100 + p.PROGRESS / p.MAX_STAGE END AS total_pct
FROM information_schema.PROCESSLIST p
WHERE p.ID = ${id}`,
      note: 'MariaDB native processlist progress does not require performance_schema. '
        + 'PROGRESS is within the current stage; total_pct follows MariaDB’s documented overall formula.',
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

export function mysqlCurrentAlterStagesSql(snapshot: MysqlThreadSnapshot): string | null {
  const statementThreadId = snapshot.statementThreadId;
  const statementEventId = snapshot.statementEventId;
  if (statementThreadId === null || statementEventId === null) return null;
  return `SELECT
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
JOIN performance_schema.events_statements_current stmt
  ON stmt.THREAD_ID = ${statementThreadId} AND stmt.EVENT_ID = ${statementEventId}
WHERE (s.EVENT_NAME LIKE 'stage/innodb/alter%' OR s.EVENT_NAME LIKE 'stage/sql/copy%')
  AND (
    (s.THREAD_ID = stmt.THREAD_ID AND s.NESTING_EVENT_ID = stmt.EVENT_ID)
    OR (
      t.PROCESSLIST_ID IS NULL AND s.NESTING_EVENT_ID = stmt.EVENT_ID
      AND NOT EXISTS (
        SELECT 1 FROM performance_schema.events_statements_current other_stmt
        WHERE other_stmt.EVENT_ID = stmt.EVENT_ID
          AND other_stmt.THREAD_ID <> stmt.THREAD_ID
      )
    )
  )
ORDER BY s.EVENT_ID, s.THREAD_ID`;
}

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

export function mysqlOperationNotes(
  sql: string, flavor: 'mysql' | 'mariadb' | 'percona' = 'mysql',
): string[] {
  const s = normalizedDdl(sql);
  const notes: string[] = [];
  if (/^call\s+mysql\.addsecondaryidxonreplica\s*\(/.test(s)) {
    notes.push('This stored procedure performs the index build on the replica. Watch its real InnoDB stages and the managed-index status table when available.');
  }
  if (/^call\s+mysql\.cloudsql_replica_idx_/.test(s)) {
    notes.push('Cloud SQL control operation only; the replica’s background maintenance queue performs the index build and reports PENDING/RUNNING/DONE/FAILED with retries.');
  }
  if (flavor === 'mariadb' && /^alter\s+table\b.*\b(?:add|drop)\s+system\s+versioning\b/.test(s)) {
    notes.push(/\bdrop\s+system\s+versioning\b/.test(s)
      ? 'Dropping system versioning deletes all retained history and rebuilds the table.'
      : 'Adding system versioning rebuilds the table; existing rows become part of the versioned history.');
  }
  if (/\bconvert\s+to\s+character\s+set\b|\b(?:default\s+)?collate\s*=?/.test(s)) {
    notes.push('Character-set or collation changes can rebuild the table and affected indexes; verify sort order and replica compatibility.');
  }
  if (flavor === 'mariadb' && /uca1400[\w]*/.test(s)) {
    notes.push('UCA 14.0 collations require MariaDB 11.6 or later on every replica; older replicas do not understand them.');
  }
  if (/\brow_format\s*=\s*compressed\b/.test(s)) {
    notes.push(flavor === 'mariadb'
      ? 'ROW_FORMAT=COMPRESSED rebuilds the table using InnoDB’s compressed row format; it is separate from MariaDB PAGE_COMPRESSED.'
      : 'ROW_FORMAT=COMPRESSED rebuilds the table using InnoDB compressed rows; compression savings are workload-dependent.');
  }
  if (flavor === 'mariadb' && /\bpage_compressed\s*=\s*(?:1|on)\b/.test(s)) {
    notes.push('PAGE_COMPRESSED rebuilds the table. Filesystem space savings depend on sparse-file and hole-punching support; DATA_FREE does not measure compression ratio.');
  }
  if (flavor !== 'mariadb' && /\bcompression\s*=\s*['"]?(?:zlib|lz4)/.test(s)) {
    notes.push('Transparent InnoDB page compression rebuilds the table. Actual filesystem savings depend on the filesystem and workload.');
  }
  if (/^optimize\s+(?:local\s+)?table\b/.test(s)
    || /^alter\s+table\b.*\bengine\s*=\s*innodb\b/.test(s)) {
    notes.push('This rebuild can compact data and indexes, but space returns to the filesystem only when the engine and tablespace permit it. DATA_FREE alone is not a general fragmentation measure.');
  }
  if (/^repair\s+(?:local\s+)?table\b/.test(s)) {
    notes.push(flavor === 'mariadb'
      ? 'REPAIR is storage-engine-specific. MariaDB can report native progress for Aria repair; InnoDB does not support REPAIR TABLE.'
      : 'REPAIR is storage-engine-specific and does not repair InnoDB tables.');
  }
  return notes;
}

/** Does this statement do enough work to be worth watching for phases? */
export function reportsPhases(engine: string, sql: string): boolean {
  if (engine !== 'mysql' && engine !== 'postgres' && engine !== 'sqlserver') return false;
  const kind = ddlKind(sql);
  if (kind === 'maintenance') return engine === 'mysql';
  if (kind !== 'other') return true;
  if (engine === 'sqlserver') {
    return /^alter\s+index\b.*\breorganize(?:\s*\(|\s+with\b|\s*;|$)/.test(normalizedDdl(sql));
  }
  return engine !== 'postgres';
}
