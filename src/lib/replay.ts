// Frontend API for the Dolphie **Replay** feature — thin typed wrappers over
// the path-based Tauri commands in `src-tauri/src/commands/replay.rs`.
//
// A recording is opened by file path, never by a live connection. The backend
// ingests it once into an in-memory columnar cache; these calls read from it.

import { invoke } from '@tauri-apps/api/core';

export interface ReplayMetadata {
  schema_version: number;
  host: string;
  port: number;
  host_distro: string;
  connection_source: string;
  dolphie_version: string;
  dict_bytes: number;
  /** Server identity, read from a sample snapshot's global_variables. */
  server_version?: string | null;
  server_id?: number | null;
  server_uuid?: string | null;
  server_hostname?: string | null;
  read_only?: boolean | null;
}

export interface ReplayProbe {
  is_recording: boolean;
  metadata: ReplayMetadata | null;
  snapshot_count: number;
  first_timestamp: string | null;
  last_timestamp: string | null;
}

/** Which top-level panels a recording actually carries (the "subset" problem). */
export interface PanelPresence {
  global_status: boolean;
  global_variables: boolean;
  processlist: boolean;
  metric_manager: boolean;
  binlog_status: boolean;
  innodb_metrics: boolean;
  metadata_locks: boolean;
  replica_manager: boolean;
  table_io_waits_data: boolean;
  file_io_data: boolean;
}

export interface ReplayManifest {
  metadata: ReplayMetadata;
  snapshot_count: number;
  /** Full timestamp axis, one per recorded second. */
  timestamps: string[];
  first_timestamp: string | null;
  last_timestamp: string | null;
  /** Available `group.metric` series names, sorted. */
  metrics: string[];
  presence: PanelPresence;
}

export interface SeriesSlice {
  timestamps: string[];
  series: Record<string, number[]>;
  raw_points: number;
  bucket_seconds: number;
  /** Seconds the one-time columnar build took — present only on the response
   *  that triggered it (so the UI can log conversion time). */
  build_secs?: number;
}

export interface VarChange {
  timestamp: string;
  variable_name: string;
  old_value: string | null;
  new_value: string | null;
}

/** A decoded per-second snapshot. Shape mirrors Dolphie's replay JSON; every
 *  field is optional because recordings differ in which panels they capture. */
export interface Snapshot {
  global_status?: Record<string, number | string>;
  global_variables?: Record<string, string>;
  processlist?: ProcessRow[];
  metric_manager?: Record<string, unknown>;
  binlog_status?: Record<string, unknown>;
  innodb_metrics?: Record<string, unknown>;
  metadata_locks?: LockRow[];
  replica_manager?: Record<string, unknown>[];
  table_io_waits_data?: Record<string, unknown>[];
  file_io_data?: Record<string, unknown>[];
}

export interface ProcessRow {
  id?: number;
  mysql_thread_id?: number;
  user?: string;
  host?: string;
  db?: string;
  command?: string;
  time?: number;
  query?: string;
  state?: string;
  trx_state?: string;
  trx_time?: number | string;
  trx_rows_locked?: number;
  trx_rows_modified?: number;
  connection_type?: string;
}

export interface LockRow {
  OBJECT_TYPE?: string;
  OBJECT_SCHEMA?: string;
  OBJECT_NAME?: string;
  LOCK_TYPE?: string;
  LOCK_STATUS?: string;
  PROCESSLIST_ID?: number;
  PROCESSLIST_USER?: string;
  PROCESSLIST_TIME?: number;
  PROCESSLIST_INFO?: string;
}

export const replayApi = {
  probe: (path: string) => invoke<ReplayProbe>('replay_probe', { path }),
  open: (path: string) => invoke<ReplayManifest>('replay_open', { path }),
  series: (path: string, metrics: string[], fromTs: string, toTs: string, maxPoints: number) =>
    invoke<SeriesSlice>('replay_series', { path, metrics, fromTs, toTs, maxPoints }),
  snapshot: (path: string, ts: string) => invoke<Snapshot>('replay_snapshot', { path, ts }),
  variableChanges: (path: string, fromTs: string, toTs: string) =>
    invoke<VarChange[]>('replay_variable_changes', { path, fromTs, toTs }),
  close: (path: string) => invoke<void>('replay_close', { path }),
  /** Free the cached recording (columns + pool) — call on real session close. */
  evict: (path: string) => invoke<EvictInfo>('replay_evict', { path }),
};

/** What `replay_evict` released — for the audit log. */
export interface EvictInfo {
  freed: boolean;
  snapshots: number;
  metrics: number;
  had_series: boolean;
}

/** Ingest progress event payload (`replay-ingest-progress`). */
export interface IngestProgress {
  path: string;
  done: number;
  total: number;
}

/** Group `group.metric` series names by their `group` prefix, preserving a
 *  friendly display order for the well-known Dolphie graph groups. */
const GROUP_ORDER = [
  'threads', 'dml', 'buffer_pool_requests', 'checkpoint', 'redo_log',
  'history_list_length', 'temporary_objects', 'table_cache', 'locks',
  'adaptive_hash_index', 'adaptive_hash_index_hit_ratio', 'disk_io',
  'system_cpu', 'system_memory', 'system_disk_io', 'system_network',
  'aborted_connections', 'replication_lag', 'redo_log_active_count',
];

export function groupMetrics(metrics: string[]): { group: string; metrics: string[] }[] {
  const byGroup = new Map<string, string[]>();
  for (const m of metrics) {
    const dot = m.indexOf('.');
    const g = dot > 0 ? m.slice(0, dot) : m;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(m);
  }
  const known = GROUP_ORDER.filter(g => byGroup.has(g));
  const rest = [...byGroup.keys()].filter(g => !GROUP_ORDER.includes(g)).sort();
  return [...known, ...rest].map(g => ({ group: g, metrics: byGroup.get(g)!.sort() }));
}

/** Nice short label for a `group.metric` series in a legend. */
export function metricLabel(name: string): string {
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(dot + 1) : name;
}

/** Flatten a snapshot's `metric_manager` to exact `group.metric → value` for
 *  the current second — used to keep chart value readouts precise per-step,
 *  since the plotted lines are downsampled. */
export function snapshotMetricValues(snap: Snapshot): Record<string, number> {
  const out: Record<string, number> = {};
  const mm = snap.metric_manager as Record<string, unknown> | undefined;
  if (!mm) return out;
  for (const [group, gv] of Object.entries(mm)) {
    if (group === 'datetimes' || group === '_delta' || !gv || typeof gv !== 'object') continue;
    for (const [metric, mv] of Object.entries(gv as Record<string, unknown>)) {
      const v = Array.isArray(mv) ? mv[0] : mv;
      if (typeof v === 'number') out[`${group}.${metric}`] = v;
    }
  }
  return out;
}
