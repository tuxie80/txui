/**
 * Galera node OPERATIONS — the write side of the Galera dashboard
 * (`GaleraClusterView`), kept pure so every SQL string, state reflection and
 * eligibility rule is unit-tested without a server.
 *
 * The operations and their exact semantics, verified LIVE against a 3-node
 * MariaDB 11.8 + galera 26.4.27 cluster (2026-10-02):
 *
 * - `wsrep_desync` (backup mode) — SET GLOBAL ON moves the node to
 *   Donor/Desynced with `wsrep_desync_count=1`; OFF returns it to Synced
 *   within a poll or two. The node keeps applying but leaves the
 *   flow-control loop. With ALL three nodes desynced on an idle cluster a
 *   write still went through (verified) — the documented "writes stop
 *   cluster-wide" bites once queues exceed `gcs.fc_limit`, because flow
 *   control then has nobody left to throttle.
 * - `wsrep_reject_queries` (maintenance mode) — `ALL` rejects every
 *   statement that touches a table or a transaction (SELECT from a table,
 *   BEGIN, DDL) with ERROR 1047 (08S01) "WSREP has not yet prepared node for
 *   application use" — for EVERY account including SUPER (verified); `SET`,
 *   `SHOW`, `USE` and no-table SELECTs (`SELECT 1`, `SELECT USER()`) still
 *   answer, which is what makes the mode reversible from the same panel.
 *   `ALL_KILL` is deliberately NOT offered: it also kills existing client
 *   connections, including the session this app is running on — the operator
 *   would lose the very session meant to undo it. Run it from the editor if
 *   you really mean it.
 * - `wsrep_slave_threads` — dynamic, 1..512, reflected immediately (verified
 *   1→4→1). The documented fix for a persistent apply backlog
 *   (wsrep_local_recv_queue/_avg).
 * - `wsrep_provider_options` — **read-only over SQL on MariaDB 11.8**
 *   (verified live: SET GLOBAL fails with ERROR 1238 (HY000) "Variable
 *   'wsrep_provider_options' is a read only variable", and
 *   information_schema.SYSTEM_VARIABLES agrees: READ_ONLY=YES; the MariaDB
 *   docs list it Dynamic: No). On PXC / codership mysql-wsrep it IS dynamic,
 *   which is where `gcache.freeze_purge_at_seqno=now` (prepare for a planned
 *   restart so the rejoin is IST, not SST) and `evs.evict=<uuid>` work. The
 *   gate is therefore a tolerant READ_ONLY probe, not a vendor string.
 * - Session toggles `wsrep_sync_wait` (causal reads) and
 *   `wsrep_dirty_reads` — SESSION scope, no SUPER needed, verified via
 *   `@@session.*`. The MySQL session is a POOL (up to 4 connections): a SET
 *   SESSION lands on the pooled connection that ran it, and idle-timeout can
 *   drop that connection later. The panel says so; correctness-sensitive
 *   reads should pin a transaction (which pins the connection).
 *
 * Permanently NOT offered as buttons: `wsrep_on` (unloading the provider
 * under a running node is a crash-shaped operation) and `pc.bootstrap` —
 * bootstrap-after-quorum-loss is a decision, not a click; the dashboard
 * renders the bootstrap ADVISOR (below) with copyable SQL instead.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */

import { statusOn, type GaleraStatus } from './galeraStatus.ts';

export type GaleraOpId =
  | 'desync-on' | 'desync-off'
  | 'reject-all' | 'reject-none'
  | 'slave-threads'
  | 'gcache-freeze'
  | 'evict';

export interface GaleraOp {
  id: GaleraOpId;
  /** Button label. */
  label: string;
  /** The exact SQL the confirm button runs. */
  sql: string;
  /** Risk text shown in the inline confirmation before anything runs. */
  risk: string;
  /** Typed-confirmation word when a click is not enough (the evict op). */
  confirmWord?: string;
  /**
   * True when the SQL is `SET GLOBAL wsrep_provider_options=…` — dead on
   * MariaDB (read-only variable), dynamic on PXC. Gated by the
   * READ_ONLY probe, not a vendor string.
   */
  providerOption?: boolean;
}

// ── SQL builders ─────────────────────────────────────────────────────────────

/** Backup mode: leave the flow-control loop (ON) / rejoin it (OFF). */
export function desyncSql(on: boolean): string {
  return `SET GLOBAL wsrep_desync = ${on ? 'ON' : 'OFF'}`;
}

/** Maintenance mode: reject (ALL) / accept (NONE) client queries. */
export function rejectQueriesSql(mode: 'NONE' | 'ALL'): string {
  return `SET GLOBAL wsrep_reject_queries = '${mode}'`;
}

/** wsrep_slave_threads documented range is 1..512 (both variants). */
export const SLAVE_THREADS_MIN = 1;
export const SLAVE_THREADS_MAX = 512;

/** Clamp a stepper value into the documented range; NaN → the minimum. */
export function clampSlaveThreads(n: number): number {
  if (!Number.isFinite(n)) return SLAVE_THREADS_MIN;
  return Math.min(SLAVE_THREADS_MAX, Math.max(SLAVE_THREADS_MIN, Math.round(n)));
}

export function slaveThreadsSql(n: number): string {
  return `SET GLOBAL wsrep_slave_threads = ${clampSlaveThreads(n)}`;
}

/** PXC-only: pin the gcache purge frontier so a planned restart rejoins by IST. */
export function gcacheFreezeSql(): string {
  return `SET GLOBAL wsrep_provider_options = 'gcache.freeze_purge_at_seqno=now'`;
}

/**
 * A Galera node UUID as `evs.evict` expects it — 8-4-4-4-12 hex. Tolerant of
 * surrounding whitespace and case; anything else would make the provider
 * reject the SET with an opaque error, so the form refuses it up front.
 */
export function validEvictUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

export function evictSql(uuid: string): string {
  return `SET GLOBAL wsrep_provider_options = 'evs.evict=${uuid.trim().toLowerCase()}'`;
}

// ── Session toggles (SESSION scope — no SUPER, no prod-ack) ──────────────────

/** Causal reads: wait for the queue to drain before reads (1) / don't (0). */
export function syncWaitSql(on: boolean): string {
  return `SET SESSION wsrep_sync_wait = ${on ? 1 : 0}`;
}

/** Allow reads on a node that is not ready (a mid-transfer joiner whose port answers). */
export function dirtyReadsSql(on: boolean): string {
  return `SET SESSION wsrep_dirty_reads = ${on ? 'ON' : 'OFF'}`;
}

/** One probe row for both toggles: `SELECT @@session.wsrep_sync_wait, @@session.wsrep_dirty_reads`. */
export const SESSION_TOGGLES_SQL =
  'SELECT @@session.wsrep_sync_wait, @@session.wsrep_dirty_reads';

export interface SessionToggles {
  /** wsrep_sync_wait bitmask; the checkbox tracks bit 1 (READ). */
  syncWait: number | null;
  dirtyReads: boolean | null;
}

/** Parse the SESSION_TOGGLES_SQL row; missing/blank values stay null. */
export function parseSessionToggles(row: readonly unknown[] | undefined): SessionToggles {
  const syncRaw = row?.[0];
  const dirtyRaw = row?.[1];
  const syncN = syncRaw == null || syncRaw === '' ? null : Number(syncRaw);
  const dirty = dirtyRaw == null ? null : statusOn(String(dirtyRaw)) || String(dirtyRaw) === '1';
  return {
    syncWait: syncN !== null && Number.isFinite(syncN) ? syncN : null,
    dirtyReads: dirtyRaw == null || dirtyRaw === '' ? null : dirty,
  };
}

// ── wsrep_provider_options writability probe ─────────────────────────────────

/**
 * Tolerant probe for whether `SET GLOBAL wsrep_provider_options=…` can work
 * at all. MariaDB carries information_schema.SYSTEM_VARIABLES and reports
 * READ_ONLY=YES there (verified live on 11.8 — the SET fails with ERROR
 * 1238). PXC is MySQL-based and has no such table: the probe ERRORS, which
 * the caller maps to `null` — unknown — and unknown means allowed (the
 * server's own error, if any, is surfaced readably instead).
 */
export const PROVIDER_OPTIONS_READONLY_SQL =
  "SELECT READ_ONLY FROM information_schema.SYSTEM_VARIABLES WHERE VARIABLE_NAME = 'WSREP_PROVIDER_OPTIONS'";

/** 'YES'/'NO' (any case) → boolean; anything else (empty set, error) → null. */
export function parseReadOnlyFlag(value: string | null | undefined): boolean | null {
  const v = (value ?? '').trim().toUpperCase();
  if (v === 'YES') return true;
  if (v === 'NO') return false;
  return null;
}

// ── Op assembly + eligibility ────────────────────────────────────────────────

/**
 * What the gates know. `readOnly` is the session flag; `superDenied` is the
 * `server-admin` capability positively denied (unknown counts as allowed);
 * `providerOptionsReadOnly` is the READ_ONLY probe (null = unknown).
 */
export interface OpGate {
  readOnly: boolean;
  superDenied: boolean;
  /** The grant to name in the tooltip when superDenied (privilegeTip wording). */
  superNeeds?: string;
  providerOptionsReadOnly: boolean | null;
}

/**
 * The reason an op is unavailable, or null when it is offered. Order matters:
 * the session flag is the operator's own choice and is named first; the grant
 * is the server's answer; the variant check is last. An UNKNOWN probe never
 * blocks — the server's error does that job when it comes to it.
 */
export function opUnavailable(op: GaleraOp, gate: OpGate): string | null {
  if (gate.readOnly) {
    return 'This connection is read-only — the server rejects SET GLOBAL here.';
  }
  if (gate.superDenied) {
    return `SET GLOBAL needs ${gate.superNeeds ?? 'SUPER'} — ask for the grant, ` +
      'or connect as a role that has it.';
  }
  if (op.providerOption && gate.providerOptionsReadOnly === true) {
    return 'wsrep_provider_options is read-only over SQL on this server (MariaDB — ' +
      'ERROR 1238). This is a Percona XtraDB Cluster operation; on MariaDB set ' +
      'provider options in the config file and restart.';
  }
  return null;
}

/**
 * The operations offered for the current snapshot: desync and maintenance
 * mode flip with the polled state, the stepper and freeze are stateless, and
 * evict is built from the operator's UUID input (empty = not offered yet).
 */
export function opsFor(s: GaleraStatus, opts: { slaveThreads: number; evictUuid: string }): GaleraOp[] {
  const desynced = statusOn(s.desync);
  const rejecting = (s.rejectQueries ?? '').toUpperCase() === 'ALL';
  const ops: GaleraOp[] = [];

  ops.push(desynced
    ? {
      id: 'desync-off',
      label: 'Leave backup mode (resync)',
      sql: desyncSql(false),
      risk: 'The node rejoins the flow-control loop: the cluster may throttle writes ' +
        'while it works down its apply queue. This is the normal way back from a backup.',
    }
    : {
      id: 'desync-on',
      label: 'Enter backup mode (desync)',
      sql: desyncSql(true),
      risk: 'The node keeps applying write-sets but stops throttling the cluster — ' +
        'flow control no longer waits for it, so it can fall behind without anyone ' +
        'slowing down. If ALL nodes desync, flow control has nobody to throttle and ' +
        'under load writes stall cluster-wide. Desync one node at a time.',
    });

  ops.push(rejecting
    ? {
      id: 'reject-none',
      label: 'Leave maintenance mode (accept queries)',
      sql: rejectQueriesSql('NONE'),
      risk: 'Client queries are accepted again. In-flight rejections do not retry — ' +
        'applications see their own errors from the maintenance window.',
    }
    : {
      id: 'reject-all',
      label: 'Enter maintenance mode (reject queries)',
      sql: rejectQueriesSql('ALL'),
      risk: 'New statements that touch data or a transaction are rejected with ' +
        'ERROR 1047 "WSREP has not yet prepared node for application use" — for ' +
        'every account, SUPER included. SET, SHOW and no-table SELECTs still ' +
        'answer, so this panel can switch back. The node keeps applying ' +
        'write-sets throughout. (ALL_KILL, which would also kill existing ' +
        'connections — including this one — is deliberately not a button.)',
    });

  ops.push({
    id: 'slave-threads',
    label: 'Set apply threads',
    sql: slaveThreadsSql(opts.slaveThreads),
    risk: 'More applier threads drain a recv-queue backlog faster (the documented ' +
      'fix); on a node with certification-conflict history, higher parallelism ' +
      'raises the odds of brute-force aborts. 1 is the conservative default.',
  });

  ops.push({
    id: 'gcache-freeze',
    label: 'Freeze gcache (prepare planned restart)',
    sql: gcacheFreezeSql(),
    providerOption: true,
    risk: 'Pins the gcache purge frontier at the current seqno so the node, ' +
      'restarted soon, rejoins by IST instead of a full SST. The gcache stops ' +
      'reclaiming space until the restart — do it shortly before the restart, ' +
      'not hours ahead. Percona XtraDB Cluster only.',
  });

  if (validEvictUuid(opts.evictUuid)) {
    ops.push({
      id: 'evict',
      label: 'Evict node',
      sql: evictSql(opts.evictUuid),
      providerOption: true,
      confirmWord: 'EVICT',
      risk: `The group evicts ${opts.evictUuid.trim().toLowerCase()} — the node is ` +
        'thrown out of the cluster and CANNOT rejoin without a mysqld restart ' +
        '(it will then need an IST/SST catch-up). Evict only a node that is ' +
        'already unreachable or misbehaving.',
    });
  }

  return ops;
}

// ── Bootstrap advisor (Feature B — deliberately NOT a button) ────────────────

/**
 * The recovery statement, copyable. This is the PXC / codership mysql-wsrep
 * path; on MariaDB wsrep_provider_options is read-only over SQL (verified
 * live on 11.8 — ERROR 1238), where the equivalent is restarting the most
 * advanced node with `galera_new_cluster` / `mariadbd --wsrep-new-cluster`.
 */
export const BOOTSTRAP_SQL = "SET GLOBAL wsrep_provider_options = 'pc.bootstrap=1';";

export interface BootstrapAdvice {
  headline: string;
  detail: string;
  /** The copyable statement. */
  sql: string;
  wrongNodeWarning: string;
  recoverNote: string;
  /** MariaDB-only addendum, when the probe says provider options are read-only. */
  mariadbNote: string | null;
}

/**
 * Render the advisor only when the poll positively says this node is in a
 * NON-Primary component. A missing wsrep_cluster_status (null) renders
 * nothing — an unreadable key is not a quorum loss.
 */
export function bootstrapAdvice(s: GaleraStatus, providerOptionsReadOnly: boolean | null): BootstrapAdvice | null {
  if (!s.detected || s.clusterStatus === null || s.clusterStatus === 'Primary') return null;
  return {
    headline: 'This node is in a non-Primary component — quorum is lost or the cluster never formed',
    detail: 'A non-Primary component cannot certify writes: the nodes partitioned ' +
      'away from each other (split-brain risk) or the whole cluster went down. ' +
      'Recovery is a decision, not a click, so this is deliberately not a button: ' +
      'identify the most advanced node — compare wsrep_last_committed across all ' +
      'former members; the highest wins — and on THAT node only, run:',
    sql: BOOTSTRAP_SQL,
    wrongNodeWarning: 'Running this on the wrong node bootstraps a stale copy of ' +
      'the data: transactions the real most-advanced node had are LOST.',
    recoverNote: 'For a node that is down, `mariadbd --wsrep-recover` prints the ' +
      'seqno of its last applied write-set to the error log — that is how you ' +
      'compare nodes that cannot answer SQL.',
    mariadbNote: providerOptionsReadOnly === true
      ? 'On this server wsrep_provider_options is read-only over SQL (MariaDB — ' +
        'the statement above fails with ERROR 1238). The MariaDB path: stop all ' +
        'nodes, then start the most advanced one with `galera_new_cluster` ' +
        '(or `mariadbd --wsrep-new-cluster`) and rejoin the rest.'
      : null,
  };
}
