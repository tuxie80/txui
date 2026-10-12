/**
 * Cluster-wide processlist — "what is every node executing right now", merged
 * into one model. The backend (`galera_cluster_processlist`) ships raw
 * `SHOW FULL PROCESSLIST` columns + string rows per node; EVERY positional
 * and interpretive decision lives here, because the column order differs
 * across MySQL / MariaDB / Percona versions (MariaDB adds Progress/Time_ms,
 * older Percona reorders) — columns are looked up BY NAME, never by index.
 *
 * Thread taxonomy (grounded on a live MariaDB 11.8 Galera processlist):
 *  - applier:    `system user` threads — the wsrep write-set appliers. They
 *                exist even on an idle node (wsrep_slave_threads keeps them
 *                around), which is what makes their ABSENCE meaningful.
 *  - rollbacker: `system user` whose State says so ("wsrep aborter idle").
 *  - system:     event_scheduler, Daemon commands — server housekeeping.
 *  - user:       everything else, including the probe's own connection.
 *
 * The PROCESS-privilege heuristic: without PROCESS a server returns only the
 * session's own threads, and the poll uses a fresh ephemeral session — so an
 * unprivileged account sees ~1 user row and ZERO appliers per node. An idle
 * cluster legitimately has few USER rows, but a live Galera node always has
 * applier threads: 0 appliers on every answering node is the discriminating
 * signal, and an idle cluster never false-positives.
 *
 * KILL is offered per row — but only where offering it is safe: `user` rows
 * with a numeric thread id (`killableRow`). The panel routes
 * `galera_cluster_kill` to the row's OWN node (thread ids are node-local) over
 * a short-lived session, audited like the per-session Processes panel.
 * Applier, rollbacker and system threads are never killable here — killing
 * one breaks replication.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import type { GaleraLevel } from './galeraStatus.ts';

/** One node's raw processlist, as the panel assembles it from the events. */
export interface NodeProcessResult {
  connectionId: string;
  connectionName: string;
  ok: boolean;
  error: string | null;
  columns: string[];
  rows: string[][];
}

export type ThreadKind = 'user' | 'applier' | 'rollbacker' | 'system';

/** One merged, tagged process row. Missing columns degrade to ''/null. */
export interface ProcessRow {
  connectionId: string;
  nodeName: string;
  id: string;
  user: string;
  host: string;
  db: string;
  command: string;
  timeS: number | null;
  state: string;
  info: string;
  kind: ThreadKind;
}

/** Per-node headline numbers for the system-threads collapsible. */
export interface NodeProcessSummary {
  userQueries: number;
  appliersActive: number;
  appliersIdle: number;
  /** Longest-running USER thread, seconds; null when none is running. */
  longestQueryS: number | null;
}

/** A normalized query seen on MORE THAN ONE node — the "writeset apply on
 *  every node vs a local read on one" answer. */
export interface QueryGroup {
  /** The normalized Info (whitespace-collapsed, truncated). */
  info: string;
  /** nodeName → running count on that node. */
  perNode: [string, number][];
  totalCount: number;
  maxTimeS: number | null;
  /** All participants are appliers → the cluster is applying one write-set. */
  allAppliers: boolean;
}

/** Everything the process table renders, built in one pass. */
export interface ProcessTableModel {
  /** The PROCESS-grant hint bar text, when the own-thread-only shape holds. */
  hint: string | null;
  /** Multi-node query groups, longest-running first. */
  groups: QueryGroup[];
  /** USER rows belonging to no multi-node group, longest-running first. */
  singles: ProcessRow[];
  /** Applier/rollbacker/system rows per node (behind the collapsible). */
  systemByNode: { connectionId: string; nodeName: string; summary: NodeProcessSummary; rows: ProcessRow[] }[];
  /** Nodes whose poll failed — rendered inline, never silently dropped. */
  unreachable: { connectionId: string; nodeName: string; error: string }[];
}

export const PROCESS_GRANT_HINT =
  'Every node shows only the probe\'s own connection — the account likely lacks the PROCESS ' +
  'privilege. GRANT PROCESS ON *.* TO the connection\'s user (or use an account that has it) ' +
  'to see every thread.';

/** Truncate the Info the table shows; the full text rides the title attr. */
export const INFO_DISPLAY_MAX = 200;

/**
 * The probe's own statement. Every poll runs it on every node at the same
 * moment, so it would ALWAYS form a multi-node group — pure noise atop the
 * cross-node grouping it would otherwise answer. Excluded from groupQueries.
 */
const PROBE_SQL_NORMALIZED = 'SHOW FULL PROCESSLIST';

/** Raw columns → the index map; -1 means "this build does not have it". */
function columnMap(columns: string[]) {
  const lower = columns.map(c => c.toLowerCase());
  const at = (name: string) => lower.indexOf(name);
  return {
    id: at('id'),
    user: at('user'),
    host: at('host'),
    db: at('db'),
    command: at('command'),
    time: at('time'),
    state: at('state'),
    info: at('info'),
  };
}

const cell = (row: string[], idx: number): string => (idx >= 0 ? row[idx] ?? '' : '');

/** wsrep thread taxonomy from (user, command, state). */
export function classifyThread(input: { user: string; command: string; state: string }): ThreadKind {
  const user = input.user.trim().toLowerCase();
  const state = input.state.toLowerCase();
  if (user === 'system user') {
    // Verified live on MariaDB 11.8: the aborter thread reads exactly
    // "wsrep aborter idle"; appliers carry a blank or wsrep-ish state.
    if (state.includes('aborter') || state.includes('rollback')) return 'rollbacker';
    return 'applier';
  }
  if (user === 'event_scheduler' || input.command.trim().toLowerCase() === 'daemon') return 'system';
  return 'user';
}

/**
 * Is this row killable? Only `user` threads with a numeric thread id — the
 * id is node-local, so the panel routes `galera_cluster_kill` to the row's own
 * node. Applier/rollbacker/system threads are never killable (killing one
 * breaks replication), and a missing/unparseable id cannot be addressed at
 * all. The button AND the handler guard with this same predicate.
 */
export function killableRow(r: ProcessRow): boolean {
  return r.kind === 'user' && /^\d+$/.test(r.id);
}

/**
 * Merge every answering node's processlist into one flat, tagged, sorted row
 * list — longest-running first, unreadable times last. Per-node parsing uses
 * that node's OWN columns array.
 */
export function mergeProcesslists(nodeResults: NodeProcessResult[]): ProcessRow[] {
  const out: ProcessRow[] = [];
  for (const n of nodeResults) {
    if (!n.ok) continue;
    const cm = columnMap(n.columns);
    for (const row of n.rows) {
      const timeRaw = cell(row, cm.time);
      const timeN = Number(timeRaw);
      const user = cell(row, cm.user);
      const command = cell(row, cm.command);
      const state = cell(row, cm.state);
      out.push({
        connectionId: n.connectionId,
        nodeName: n.connectionName,
        id: cell(row, cm.id),
        user,
        host: cell(row, cm.host),
        db: cell(row, cm.db),
        command,
        timeS: timeRaw !== '' && Number.isFinite(timeN) ? timeN : null,
        state,
        info: cell(row, cm.info),
        kind: classifyThread({ user, command, state }),
      });
    }
  }
  out.sort((a, b) => (b.timeS ?? -1) - (a.timeS ?? -1));
  return out;
}

/** Per-node headline counts. */
export function summarizeNode(rows: ProcessRow[]): NodeProcessSummary {
  const userRows = rows.filter(r => r.kind === 'user');
  const running = userRows.filter(r => r.command.toLowerCase() === 'query');
  const appliers = rows.filter(r => r.kind === 'applier');
  const activeAppliers = appliers.filter(r => r.command.toLowerCase() !== 'sleep');
  const times = running.map(r => r.timeS).filter((t): t is number => t !== null);
  return {
    userQueries: running.length,
    appliersActive: activeAppliers.length,
    appliersIdle: appliers.length - activeAppliers.length,
    longestQueryS: times.length > 0 ? Math.max(...times) : null,
  };
}

/** Whitespace-collapsed, truncated Info — the group identity. */
export function normalizeInfo(info: string): string {
  return info.replace(/\s+/g, ' ').trim().slice(0, INFO_DISPLAY_MAX);
}

/**
 * Identical normalized queries across nodes → groups. Only groups spanning
 * MORE THAN ONE node are returned (a query on one node is just a row).
 * Empty Info never groups. Longest-running groups first.
 */
export function groupQueries(rows: ProcessRow[]): QueryGroup[] {
  const byInfo = new Map<string, ProcessRow[]>();
  for (const r of rows) {
    const key = normalizeInfo(r.info);
    if (!key || key.toUpperCase() === PROBE_SQL_NORMALIZED) continue;
    if (!byInfo.has(key)) byInfo.set(key, []);
    byInfo.get(key)!.push(r);
  }
  const groups: QueryGroup[] = [];
  for (const [info, members] of byInfo) {
    const nodes = new Map<string, number>();
    for (const m of members) nodes.set(m.nodeName, (nodes.get(m.nodeName) ?? 0) + 1);
    if (nodes.size < 2) continue;
    const times = members.map(m => m.timeS).filter((t): t is number => t !== null);
    groups.push({
      info,
      perNode: [...nodes.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      totalCount: members.length,
      maxTimeS: times.length > 0 ? Math.max(...times) : null,
      allAppliers: members.every(m => m.kind === 'applier'),
    });
  }
  groups.sort((a, b) => (b.maxTimeS ?? -1) - (a.maxTimeS ?? -1));
  return groups;
}

/**
 * The PROCESS-privilege shape: EVERY answering node returned at most one
 * user thread (its own probe) and ZERO applier threads. An idle cluster
 * false-positives on the first half but never the second — a live Galera
 * node always keeps applier threads. No answering node → not decidable →
 * false (no hint).
 */
export function ownThreadOnly(nodeResults: NodeProcessResult[]): boolean {
  const ok = nodeResults.filter(n => n.ok);
  if (ok.length === 0) return false;
  return ok.every(n => {
    const rows = mergeProcesslists([n]);
    const users = rows.filter(r => r.kind === 'user');
    const appliers = rows.filter(r => r.kind === 'applier' || r.kind === 'rollbacker');
    return users.length <= 1 && appliers.length === 0;
  });
}

/** One pass → everything the table renders. */
export function buildProcessTable(nodeResults: NodeProcessResult[]): ProcessTableModel {
  const all = mergeProcesslists(nodeResults);
  const groups = groupQueries(all);
  const grouped = new Set<ProcessRow>();
  for (const g of groups) {
    for (const r of all) {
      if (normalizeInfo(r.info) === g.info) grouped.add(r);
    }
  }
  const singles = all.filter(r => r.kind === 'user' && !grouped.has(r));
  const byNode = new Map<string, ProcessRow[]>();
  for (const r of all) {
    if (!byNode.has(r.connectionId)) byNode.set(r.connectionId, []);
    byNode.get(r.connectionId)!.push(r);
  }
  const systemByNode = [...byNode.entries()].map(([connectionId, rows]) => ({
    connectionId,
    nodeName: rows[0]?.nodeName ?? connectionId,
    summary: summarizeNode(rows),
    rows: rows.filter(r => r.kind !== 'user'),
  }));
  return {
    hint: ownThreadOnly(nodeResults) ? PROCESS_GRANT_HINT : null,
    groups,
    singles,
    systemByNode,
    unreachable: nodeResults.filter(n => !n.ok).map(n => ({
      connectionId: n.connectionId,
      nodeName: n.connectionName,
      error: n.error ?? 'poll failed',
    })),
  };
}

/** A group header line: "×3 nodes — writeset apply" or "×2 nodes". */
export function groupHeader(g: QueryGroup): string {
  const base = `×${g.perNode.length} node${g.perNode.length === 1 ? '' : 's'}`;
  return g.allAppliers ? `${base} — writeset apply` : base;
}

/** Level for a row's Time cell, matching the panel's warn vocabulary. */
export function timeLevel(timeS: number | null): GaleraLevel | null {
  if (timeS === null) return null;
  if (timeS >= 60) return 'warn';
  return null;
}
