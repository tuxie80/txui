/**
 * Pure replication-status logic shared by ReplicationPanel and its tests.
 *
 * The backend (`replication_status` in src-tauri/src/commands/ops.rs) emits one
 * section per MySQL channel (one `SHOW REPLICA STATUS` row) plus non-channel
 * sections (connected replicas, PostgreSQL standby/slots). This module
 * normalizes the modern/legacy field names into a Channel, classifies health,
 * and describes the summary-table cells and the expanded-detail rows.
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import type { QueryResult } from '../types';

export interface ReplSection {
  title: string;
  kv: [string, string][] | null;
  table: QueryResult | null;
}

export type Health = 'good' | 'warn' | 'bad' | null;

// ── Channel model (normalized across modern/legacy field names) ──────────────
export interface Channel {
  name: string;
  io: string;
  sql: string;
  behind: string;
  sqlState: string;
  sourceHost: string;
  sourcePort: string;
  sourceUser: string;
  sourceUuid: string;
  sslAllowed: string;
  autoPos: string;
  readFile: string;
  readPos: string;
  relayFile: string;
  execPos: string;
  relaySpace: string;
  retrievedGtid: string;
  executedGtid: string;
  sqlDelay: string;
  remaining: string;
  retryCount: string;
  heartbeat: string;
  filters: string;
  ioErrno: string; ioError: string;
  sqlErrno: string; sqlError: string;
  errno: string; error: string;
  kv: [string, string][];
}

export function isChannelSection(s: ReplSection): boolean {
  return !!s.kv?.some(([k]) => /_(IO|SQL)_Running$/.test(k));
}

/** Replication-filter columns; combined into one row so empty filters waste none. */
export const FILTER_FIELDS = [
  'Replicate_Do_DB', 'Replicate_Ignore_DB',
  'Replicate_Do_Table', 'Replicate_Ignore_Table',
  'Replicate_Wild_Do_Table', 'Replicate_Wild_Ignore_Table',
  'Replicate_Rewrite_DB', 'Replicate_Rewrite_Db',
];

export function toChannel(s: ReplSection): Channel {
  const m = new Map(s.kv ?? []);
  const g = (...keys: string[]) => { for (const k of keys) { const v = m.get(k); if (v !== undefined) return v; } return ''; };
  const chanField = g('Channel_Name');
  const name = chanField || (/channel '([^']*)'/.exec(s.title)?.[1] ?? '') || '(default)';
  const filters = FILTER_FIELDS
    .map(k => [k.replace(/^Replicate_/, ''), g(k)] as [string, string])
    .filter(([, v]) => nonEmpty(v))
    .map(([k, v]) => `${k}: ${v}`)
    .join('  ·  ');
  return {
    name,
    io:  g('Replica_IO_Running', 'Slave_IO_Running'),
    sql: g('Replica_SQL_Running', 'Slave_SQL_Running'),
    behind: g('Seconds_Behind_Source', 'Seconds_Behind_Master'),
    sqlState: g('Replica_SQL_Running_State', 'Slave_SQL_Running_State'),
    sourceHost: g('Source_Host', 'Master_Host'),
    sourcePort: g('Source_Port', 'Master_Port'),
    sourceUser: g('Source_User', 'Master_User'),
    sourceUuid: g('Source_UUID', 'Master_UUID'),
    sslAllowed: g('Source_SSL_Allowed', 'Master_SSL_Allowed'),
    autoPos: g('Auto_Position'),
    readFile: g('Source_Log_File', 'Master_Log_File'),
    readPos: g('Read_Source_Log_Pos', 'Read_Master_Log_Pos'),
    relayFile: g('Relay_Source_Log_File', 'Relay_Master_Log_File'),
    execPos: g('Exec_Source_Log_Pos', 'Exec_Master_Log_Pos'),
    relaySpace: g('Relay_Log_Space'),
    retrievedGtid: g('Retrieved_Gtid_Set'),
    executedGtid: g('Executed_Gtid_Set'),
    sqlDelay: g('SQL_Delay'),
    remaining: g('SQL_Remaining_Delay'),
    retryCount: g('Source_Retry_Count', 'Master_Retry_Count'),
    heartbeat: g('Replica_heartbeat_period', 'Source_Heartbeat_Period', 'Slave_heartbeat_period'),
    filters,
    ioErrno: g('Last_IO_Errno'),  ioError:  g('Last_IO_Error'),
    sqlErrno: g('Last_SQL_Errno'), sqlError: g('Last_SQL_Error'),
    errno: g('Last_Errno'),        error:    g('Last_Error'),
    kv: s.kv ?? [],
  };
}

export const yn = (v: string): Health => v === 'Yes' ? 'good' : v === 'No' ? 'bad' : v === '' ? null : 'warn';
export function lagHealth(v: string): Health {
  if (v === '' || v === 'NULL') return 'bad';
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 'good' : n < 60 ? 'warn' : 'bad';
}
export const isRunning = (c: Channel) => c.io === 'Yes' && c.sql === 'Yes';
export const nonEmpty = (v: string) => v !== '' && v !== 'NULL';
/** Most relevant error text for a channel. */
export function channelError(c: Channel): string {
  const parts: string[] = [];
  if (nonEmpty(c.sqlError)) parts.push(`SQL${c.sqlErrno && c.sqlErrno !== '0' ? ` [${c.sqlErrno}]` : ''}: ${c.sqlError}`);
  if (nonEmpty(c.ioError))  parts.push(`IO${c.ioErrno && c.ioErrno !== '0' ? ` [${c.ioErrno}]` : ''}: ${c.ioError}`);
  if (!parts.length && nonEmpty(c.error)) parts.push(`${c.errno && c.errno !== '0' ? `[${c.errno}] ` : ''}${c.error}`);
  return parts.join('   ·   ');
}

/** GTID sets can run to thousands of chars — show the head + set count; full value is in "all fields". */
export function shortenGtid(v: string): string {
  if (!nonEmpty(v) || v.length <= 48) return v;
  const sets = v.split(/[\s,]+/).filter(Boolean).length;
  return `${v.slice(0, 36)}… (${sets} set${sets === 1 ? '' : 's'}, ${v.length} chars)`;
}

// ── Summary table: one row per channel ───────────────────────────────────────
export interface SummaryCells {
  name: string;
  running: boolean;
  io: string;
  ioHealth: Health;
  sql: string;
  sqlHealth: Health;
  behind: string;
  behindHealth: Health;
  source: string;
}

/** Vital first-glance cells for a channel row in the summary table. */
export function channelSummary(c: Channel): SummaryCells {
  return {
    name: c.name,
    running: isRunning(c),
    io: c.io || '—',
    ioHealth: yn(c.io),
    sql: c.sql || '—',
    sqlHealth: yn(c.sql),
    behind: c.behind === '' ? 'NULL' : c.behind,
    behindHealth: lagHealth(c.behind),
    source: c.sourceHost ? `${c.sourceHost}${c.sourcePort ? `:${c.sourcePort}` : ''}` : '',
  };
}

// ── Expanded detail rows (curated fields under an open channel row) ──────────
export interface DetailRow { label: string; get: (c: Channel) => string; health?: (c: Channel) => Health; mono?: boolean; errorRow?: boolean; whenPresent?: boolean }
export const DETAIL_ROWS: DetailRow[] = [
  { label: 'IO thread',     get: c => c.io || '—',  health: c => yn(c.io) },
  { label: 'SQL thread',    get: c => c.sql || '—', health: c => yn(c.sql) },
  { label: 'Seconds behind', get: c => c.behind === '' ? 'NULL' : c.behind, health: c => lagHealth(c.behind) },
  { label: 'SQL state',     get: c => c.sqlState },
  { label: 'Source',        get: c => c.sourceHost ? `${c.sourceHost}${c.sourcePort ? `:${c.sourcePort}` : ''}` : '', mono: true },
  { label: 'Source user',   get: c => c.sourceUser, mono: true },
  { label: 'Source UUID',   get: c => c.sourceUuid, mono: true, whenPresent: true },
  { label: 'SSL allowed',   get: c => c.sslAllowed, health: c => yn(c.sslAllowed) },
  { label: 'Auto position', get: c => c.autoPos },
  { label: 'Read position', get: c => c.readFile ? `${c.readFile}:${c.readPos}` : c.readPos, mono: true, whenPresent: true },
  { label: 'Exec position', get: c => c.relayFile ? `${c.relayFile}:${c.execPos}` : c.execPos, mono: true },
  { label: 'Relay log space', get: c => c.relaySpace, mono: true, whenPresent: true },
  { label: 'GTID retrieved', get: c => shortenGtid(c.retrievedGtid), mono: true, whenPresent: true },
  { label: 'GTID executed',  get: c => shortenGtid(c.executedGtid), mono: true, whenPresent: true },
  { label: 'SQL delay',     get: c => {
    const parts: string[] = [];
    if (c.sqlDelay && c.sqlDelay !== '0') parts.push(`${c.sqlDelay}s`);
    if (nonEmpty(c.remaining) && c.remaining !== '0') parts.push(`rem ${c.remaining}s`);
    return parts.join(', ');
  }, whenPresent: true },
  { label: 'Retry count',   get: c => c.retryCount },
  { label: 'Heartbeat',     get: c => c.heartbeat ? `${c.heartbeat}s` : '', whenPresent: true },
  { label: 'Filters',       get: c => c.filters, whenPresent: true },
  { label: 'Last IO error',  get: c => c.ioError,  errorRow: true },
  { label: 'Last SQL error', get: c => c.sqlError, errorRow: true },
  { label: 'Last error',     get: c => c.error,    errorRow: true },
];

/** Detail rows worth rendering for a channel (drops empty whenPresent rows; error rows only with text). */
export function visibleDetailRows(c: Channel): DetailRow[] {
  return DETAIL_ROWS.filter(r => (!r.errorRow && !r.whenPresent) || nonEmpty(r.get(c)));
}

// ── Non-channel key/value display (PG standby, notices) ──────────────────────
export const KEY_FIELDS = [
  'Role', 'Info', 'Error', 'in_recovery', 'status', 'slot_name',
  'lag_seconds', 'sender_host', 'receive_lsn', 'replay_lsn', 'File', 'Position',
  'replay_paused', 'last_replay_time',
];
export function kvHealth(key: string, value: string): Health {
  if (key === 'status') return value === 'streaming' ? 'good' : 'warn';
  if (key === 'replay_paused') return value === 'true' ? 'warn' : null;
  if (/lag_seconds/i.test(key)) return lagHealth(value);
  if (/error/i.test(key) && nonEmpty(value)) return 'bad';
  return null;
}
