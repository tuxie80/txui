/**
 * MySQL Group Replication (MGR) — parsing and health rules.
 *
 * The Replication panel's "⟡ Group replication" view runs read-only queries
 * through `monitor_query`, exactly the way the Galera view does:
 *
 *   1. Detection: SELECT PLUGIN_NAME, PLUGIN_STATUS FROM
 *      information_schema.PLUGINS WHERE PLUGIN_NAME = 'group_replication'.
 *      Three honest outcomes (grPluginState): 'absent' (no row — plain
 *      MySQL, and every MariaDB: GR is MySQL-only), 'inactive' (installed
 *      but not ACTIVE), 'active'. ACTIVE with an EMPTY members table means
 *      the plugin is loaded but the group was never started — the empty
 *      state says so and hints START GROUP_REPLICATION.
 *   2. Members:  SELECT * FROM performance_schema.replication_group_members
 *   3. Stats:    SELECT * FROM performance_schema.replication_group_member_stats
 *   4. Identity: SELECT @@group_replication_group_name,
 *      @@group_replication_single_primary_mode, @@group_replication_local_address,
 *      @@group_replication_group_seeds, @@server_uuid
 *
 * All column access is BY NAME and every field is nullable: the column set
 * changes across versions (8.4 prefixes both tables with CHANNEL_NAME and
 * adds MEMBER_COMMUNICATION_STACK; early 8.0 has no MEMBER_ROLE /
 * MEMBER_VERSION; the stats counters date from 5.7) and a SELECT * on a
 * version the probe never met must degrade, never throw — the galeraStatus.ts
 * convention.
 *
 * Provisioning (MGR's SST equivalent) is a distributed CLONE: when the
 * clone plugin is active, performance_schema.clone_status / clone_progress
 * answer and parseCloneProgress folds them into a determinate bar shown
 * while a member is RECOVERING. The probe is opportunistic like the Galera
 * view's WSREP_INFO one — clone plugin absent or tables empty → null →
 * nothing renders.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */

export type GrLevel = 'crit' | 'warn' | 'info' | 'ok';

export interface GrFinding {
  level: GrLevel;
  title: string;
  detail: string;
}

/** Outcome of the information_schema.PLUGINS probe. */
export type GrPluginState = 'active' | 'inactive' | 'absent';

export interface GrMember {
  /** MEMBER_ID — the member's server_uuid. */
  id: string | null;
  host: string | null;
  port: number | null;
  /** ONLINE / RECOVERING / OFFLINE / ERROR / UNREACHABLE. */
  state: string | null;
  /** PRIMARY / SECONDARY (8.0+; null on 5.7-shaped rows). */
  role: string | null;
  /** MEMBER_VERSION (8.0+; null on 5.7-shaped rows). */
  version: string | null;
}

export interface GrMemberStats {
  memberId: string | null;
  viewId: string | null;
  /** COUNT_TRANSACTIONS_IN_QUEUE — certified, waiting to be applied (cert queue). */
  certQueue: number | null;
  /** COUNT_TRANSACTIONS_CHECKED — certification decisions this member took part in. */
  txChecked: number | null;
  /** COUNT_CONFLICTS_DETECTED — cumulative certification conflicts. */
  conflicts: number | null;
  /** COUNT_TRANSACTIONS_ROWS_VALIDATING — in the certification pipeline now. */
  rowsValidating: number | null;
  /** TRANSACTIONS_COMMITTED_ALL_MEMBERS — GTID-set text, '' when idle. */
  committedAllMembers: string | null;
  /** LAST_CONFLICT_FREE_TRANSACTION — GTID text, '' on a group that never conflicted. */
  lastConflictFree: string | null;
  /** COUNT_TRANSACTIONS_REMOTE_IN_APPLIER_QUEUE — the apply backlog. */
  applierQueue: number | null;
  /** COUNT_TRANSACTIONS_REMOTE_APPLIED — cumulative remote applies. */
  remoteApplied: number | null;
  /** COUNT_TRANSACTIONS_LOCAL_PROPOSED — transactions this member sent to certification. */
  localProposed: number | null;
  /** COUNT_TRANSACTIONS_LOCAL_ROLLBACK — local rollbacks after certification. */
  localRollback: number | null;
}

export interface GrSnapshot {
  /** The plugin probe said ACTIVE — everything below is meaningless when false. */
  detected: boolean;
  members: GrMember[];
  stats: GrMemberStats[];
  groupName: string | null;
  singlePrimary: boolean | null;
  localAddress: string | null;
  seeds: string | null;
  /** @@server_uuid — which member row is THIS server (for the "this node" mark). */
  serverUuid: string | null;
}

/** Applier/cert queue depth worth a warning even without a previous sample. */
export const GR_QUEUE_WARN = 8;

type Cell = string | number | null;
type Row = Cell[];
type Cols = string[];

/** Case-insensitive column index; -1 when the column does not exist. */
const col = (cols: Cols, name: string): number =>
  cols.findIndex(c => c.toLowerCase() === name.toLowerCase());

const cellStr = (row: Row, i: number): string | null => {
  if (i < 0) return null;
  const v = row[i];
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
};

const cellNum = (row: Row, i: number): number | null => {
  const s = cellStr(row, i);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Fold the PLUGINS probe rows ([PLUGIN_NAME, PLUGIN_STATUS] pairs) into the
 * three-way detection state. Any non-ACTIVE status counts as 'inactive' —
 * DISABLED and DELETED both mean "installed but not usable as-is".
 */
export function grPluginState(rows: [string, string][]): GrPluginState {
  const hit = rows.find(([name]) => name.toLowerCase() === 'group_replication');
  if (!hit) return 'absent';
  return hit[1].toUpperCase() === 'ACTIVE' ? 'active' : 'inactive';
}

/** Parse replication_group_members rows (SELECT * — column names drive it). */
export function parseGrMembers(cols: Cols, rows: Row[]): GrMember[] {
  const iId = col(cols, 'member_id');
  const iHost = col(cols, 'member_host');
  const iPort = col(cols, 'member_port');
  const iState = col(cols, 'member_state');
  const iRole = col(cols, 'member_role');
  const iVersion = col(cols, 'member_version');
  return rows.map(row => ({
    id: cellStr(row, iId),
    host: cellStr(row, iHost),
    port: cellNum(row, iPort),
    state: cellStr(row, iState),
    role: cellStr(row, iRole),
    version: cellStr(row, iVersion),
  }));
}

/** Parse replication_group_member_stats rows (one per member). */
export function parseGrStats(cols: Cols, rows: Row[]): GrMemberStats[] {
  const iId = col(cols, 'member_id');
  const iView = col(cols, 'view_id');
  const iCertQ = col(cols, 'count_transactions_in_queue');
  const iChecked = col(cols, 'count_transactions_checked');
  const iConflicts = col(cols, 'count_conflicts_detected');
  const iRowsVal = col(cols, 'count_transactions_rows_validating');
  const iCommitted = col(cols, 'transactions_committed_all_members');
  const iLastCft = col(cols, 'last_conflict_free_transaction');
  const iApplierQ = col(cols, 'count_transactions_remote_in_applier_queue');
  const iApplied = col(cols, 'count_transactions_remote_applied');
  const iProposed = col(cols, 'count_transactions_local_proposed');
  const iRollback = col(cols, 'count_transactions_local_rollback');
  return rows.map(row => ({
    memberId: cellStr(row, iId),
    viewId: cellStr(row, iView),
    certQueue: cellNum(row, iCertQ),
    txChecked: cellNum(row, iChecked),
    conflicts: cellNum(row, iConflicts),
    rowsValidating: cellNum(row, iRowsVal),
    committedAllMembers: cellStr(row, iCommitted),
    lastConflictFree: cellStr(row, iLastCft),
    applierQueue: cellNum(row, iApplierQ),
    remoteApplied: cellNum(row, iApplied),
    localProposed: cellNum(row, iProposed),
    localRollback: cellNum(row, iRollback),
  }));
}

/**
 * The identity SELECT returns one row of @@ values in a known order
 * (group_name, single_primary_mode, local_address, group_seeds, server_uuid)
 * — positional by construction, since the view builds the statement.
 */
export const GR_IDENTITY_SQL =
  'SELECT @@group_replication_group_name, @@group_replication_single_primary_mode, ' +
  '@@group_replication_local_address, @@group_replication_group_seeds, @@server_uuid';

export function parseGrIdentity(row: Row | undefined): Pick<GrSnapshot,
  'groupName' | 'singlePrimary' | 'localAddress' | 'seeds' | 'serverUuid'> {
  const at = (i: number) => (row ? cellStr(row, i) : null);
  const sp = at(1);
  return {
    groupName: at(0),
    singlePrimary: sp === null ? null : sp === '1' || sp.toUpperCase() === 'ON',
    localAddress: at(2),
    seeds: at(3),
    serverUuid: at(4),
  };
}

/** Assemble the typed snapshot the findings rules and the view render from. */
export function parseGrSnapshot(
  memberCols: Cols, memberRows: Row[],
  statsCols: Cols, statsRows: Row[],
  identityRow: Row | undefined,
): GrSnapshot {
  return {
    detected: true,
    members: parseGrMembers(memberCols, memberRows),
    stats: parseGrStats(statsCols, statsRows),
    ...parseGrIdentity(identityRow),
  };
}

/** Stats row for one member id (null when the stats probe lacks it). */
export function grStatsFor(snap: GrSnapshot, memberId: string | null): GrMemberStats | null {
  if (memberId === null) return null;
  return snap.stats.find(s => s.memberId === memberId) ?? null;
}

/**
 * The members table answers but the group was never started: plugin ACTIVE,
 * zero member rows. The empty state uses this to hint START GROUP_REPLICATION
 * instead of reporting "not active".
 */
export function grGroupNotStarted(memberCount: number): boolean {
  return memberCount === 0;
}

/**
 * Health rules. Every rule reads what it can and skips what it cannot —
 * a missing column degrades a rule, it never crashes one. `prev` (the
 * previous poll's snapshot) feeds the rate-based rules (queue growth,
 * new conflicts); the first poll runs the absolute rules only.
 */
export function grFindings(snap: GrSnapshot, prev?: GrSnapshot): GrFinding[] {
  if (!snap.detected) return [];
  const out: GrFinding[] = [];

  for (const m of snap.members) {
    const who = `${m.host ?? '?'}${m.port !== null ? `:${m.port}` : ''}`;
    switch (m.state) {
      case 'ERROR':
      case 'UNREACHABLE':
        out.push({
          level: 'crit',
          title: `Member ${who} is ${m.state}`,
          detail: m.state === 'ERROR'
            ? 'The member hit an error in group replication and left the group ' +
              'functionally — check its error log; it usually needs STOP/START ' +
              'GROUP_REPLICATION after the cause (often a conflicting transaction ' +
              'or an unreachable group port) is fixed.'
            : 'This member cannot reach the named member over the group ' +
              'communication port — network partition or a dead peer. Writes in ' +
              'single-primary mode keep working while the PRIMARY is reachable, ' +
              'but the group is one failure closer to losing quorum.',
        });
        break;
      case 'OFFLINE':
        out.push({
          level: 'warn',
          title: `Member ${who} is OFFLINE`,
          detail: 'The group_replication plugin is loaded on that member but the ' +
            'group is not running there (stopped manually, or start-on-boot ' +
            'failed to rejoin). START GROUP_REPLICATION on that member rejoins it.',
        });
        break;
      case 'RECOVERING':
        out.push({
          level: 'info',
          title: `Member ${who} is RECOVERING (provisioning)`,
          detail: 'The member joined and is catching up — usually a distributed ' +
            'clone from a donor (MGR\u2019s SST), then binlog catch-up. When the ' +
            'clone plugin is active the progress bar above tracks the clone ' +
            'stages live; the member turns ONLINE when done.',
        });
        break;
      default:
        break;  // ONLINE, or a state this build does not know — no finding
    }
  }

  // Single-primary without a PRIMARY among ONLINE members: writes are down.
  if (snap.singlePrimary === true) {
    const online = snap.members.filter(m => m.state === 'ONLINE');
    if (online.length > 0 && !online.some(m => m.role === 'PRIMARY')) {
      out.push({
        level: 'crit',
        title: 'Single-primary group has no PRIMARY',
        detail: 'group_replication_single_primary_mode is ON but no ONLINE ' +
          'member carries the PRIMARY role — a primary election is in progress ' +
          'or failed. All writes are rejected until one wins.',
      });
    }
  }

  if (snap.singlePrimary === false) {
    out.push({
      level: 'info',
      title: 'Multi-primary mode',
      detail: 'Every ONLINE member accepts writes and certification conflicts ' +
          'become possible between them — watch COUNT_CONFLICTS_DETECTED. ' +
          'Most deployments run single-primary; switching is ' +
          'SELECT group_replication_switch_to_single_primary_mode().',
    });
  }

  for (const s of snap.stats) {
    const prevStats = prev ? grStatsFor(prev, s.memberId) : null;
    const who = snap.members.find(m => m.id === s.memberId);
    const name = who ? `${who.host ?? '?'}${who.port !== null ? `:${who.port}` : ''}` : (s.memberId ?? '?');

    if (s.conflicts !== null && s.conflicts > 0) {
      const delta = prevStats?.conflicts !== null && prevStats?.conflicts !== undefined
        ? s.conflicts - (prevStats?.conflicts ?? 0)
        : null;
      out.push({
        level: 'warn',
        title: `Certification conflicts on ${name}: ${s.conflicts.toLocaleString()}`,
        detail: 'Transactions were rolled back because a conflicting transaction ' +
          'had already certified elsewhere in the group' +
          (delta !== null && delta > 0
            ? ` — ${delta.toLocaleString()} new since the previous poll.`
            : '. The counter is cumulative; a new conflict fires this warning again.') +
          ' Frequent conflicts point at hot rows written from two members at once.',
      });
    }

    if (s.applierQueue !== null) {
      const grew = prevStats?.applierQueue !== null && prevStats?.applierQueue !== undefined
        && s.applierQueue > (prevStats?.applierQueue ?? 0);
      if (grew || s.applierQueue > GR_QUEUE_WARN) {
        out.push({
          level: 'warn',
          title: `Apply backlog on ${name}: ${s.applierQueue.toLocaleString()} transactions waiting`,
          detail: 'COUNT_TRANSACTIONS_REMOTE_IN_APPLIER_QUEUE is ' +
            (grew ? 'growing — the member is applying slower than the group ' +
              'commits; sustained growth means this member falls behind and ' +
              'reads from it serve stale data.'
              : `already ${s.applierQueue.toLocaleString()} deep.`) +
            ' The usual fixes are more applier parallelism ' +
            '(replica_parallel_workers on the group_replication_applier channel) ' +
            'and relieving disk pressure on this member.',
        });
      }
    }
  }

  return out;
}

// ── Clone (provisioning) progress ─────────────────────────────────────────

/** The documented clone stage order — drives the overall-percentage fold. */
export const CLONE_STAGES = [
  'DROP DATA', 'FILE COPY', 'PAGE COPY', 'REDO COPY', 'FILE SYNC', 'RESTART', 'RECOVERY',
] as const;

export interface GrCloneStage {
  stage: string;
  /** Not Started / In Progress / Completed / Failed. */
  state: string | null;
  beginTime: string | null;
  endTime: string | null;
  /** ESTIMATE — bytes the stage expects to move (0 when the stage is byteless). */
  estimateBytes: number | null;
  /** DATA — bytes moved so far. */
  dataBytes: number | null;
  /** DATA_SPEED — current bytes/s, when the server reports one. */
  dataSpeedBps: number | null;
}

export interface GrCloneProgress {
  /** clone_status STATE: Not Started / In Progress / Completed / Failed. */
  state: string | null;
  source: string | null;
  errorNo: number | null;
  errorMessage: string | null;
  stages: GrCloneStage[];
  currentStage: string | null;
  /** 0..1 — (done stages + current stage's byte ratio) / total stages. */
  overallPct: number | null;
}

/**
 * Fold clone_status + clone_progress into one progress object. Returns null
 * when there is nothing to show — no clone ever ran (the common idle case:
 * both tables exist but are empty), so the view renders no bar.
 */
export function parseCloneProgress(
  statusCols: Cols, statusRows: Row[],
  progressCols: Cols, progressRows: Row[],
): GrCloneProgress | null {
  if (statusRows.length === 0 && progressRows.length === 0) return null;

  const sRow = statusRows[0];
  const status = {
    state: sRow ? cellStr(sRow, col(statusCols, 'state')) : null,
    source: sRow ? cellStr(sRow, col(statusCols, 'source')) : null,
    errorNo: sRow ? cellNum(sRow, col(statusCols, 'error_no')) : null,
    errorMessage: sRow ? cellStr(sRow, col(statusCols, 'error_message')) : null,
  };

  const iStage = col(progressCols, 'stage');
  const iState = col(progressCols, 'state');
  const iBegin = col(progressCols, 'begin_time');
  const iEnd = col(progressCols, 'end_time');
  const iEstimate = col(progressCols, 'estimate');
  const iData = col(progressCols, 'data');
  const iSpeed = col(progressCols, 'data_speed');
  const stages: GrCloneStage[] = progressRows.map(row => ({
    stage: cellStr(row, iStage) ?? '?',
    state: cellStr(row, iState),
    beginTime: cellStr(row, iBegin),
    endTime: cellStr(row, iEnd),
    estimateBytes: cellNum(row, iEstimate),
    dataBytes: cellNum(row, iData),
    dataSpeedBps: cellNum(row, iSpeed),
  }));

  const current = stages.find(s => s.state === 'In Progress') ?? null;

  // Overall = completed stages + the current stage's byte ratio, over the
  // documented stage count. A stage with no byte estimate (REDO COPY on an
  // idle donor, RESTART…) counts by its state: Completed = 1, In Progress = ½
  // — an honest middle when bytes cannot speak. Unknown extra stages just
  // widen the denominator via the max() guard.
  const done = stages.filter(s => s.state === 'Completed').length;
  let frac = 0;
  if (current) {
    frac = current.estimateBytes !== null && current.estimateBytes > 0 && current.dataBytes !== null
      ? Math.min(1, current.dataBytes / current.estimateBytes)
      : 0.5;
  }
  const denom = Math.max(CLONE_STAGES.length, stages.length);
  const overallPct = stages.length === 0
    ? (status.state === 'Completed' ? 1 : null)
    : Math.min(1, (done + frac) / denom);

  return {
    ...status,
    stages,
    currentStage: current?.stage ?? null,
    overallPct,
  };
}

/** Badge health for a member state — ONLINE good, RECOVERING transitional. */
export function grStateHealth(state: string | null): 'good' | 'warn' | 'bad' | null {
  switch (state) {
    case 'ONLINE': return 'good';
    case 'RECOVERING': return 'warn';
    case 'OFFLINE': case 'ERROR': case 'UNREACHABLE': return 'bad';
    default: return null;
  }
}
