/**
 * Galera CLUSTER view — the multi-node correlation layer on top of the
 * single-node wsrep snapshot (`utils/galeraStatus.ts`).
 *
 * Input is N per-node snapshots, one per polled saved connection, each either
 * a parsed `GaleraStatus` or a poll failure. Output is a `ClusterView`:
 * one `NodeSummary` per node (state, queues, flow control, write RATES
 * against the previous poll — the "what are the nodes doing" statistics) and
 * the cluster-wide `ClusterFinding`s no single node can see: split-brain,
 * size/membership disagreement, donor↔joiner SST pairing, unreachable nodes,
 * the slowest node, mixed-up clusters.
 *
 * Every rule tolerates null keys and unreachable nodes — a missing reading
 * degrades a rule, it never crashes one (the same doctrine as galeraStatus,
 * whose thresholds and helpers this reuses rather than duplicates).
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import {
  parseGaleraStatus, transferState, istProgress, fmtElapsed,
  QUEUE_WARN, QUEUE_AVG_WARN, FC_WARN,
  type GaleraStatus, type GaleraTransfer, type IstProgress, type GaleraLevel,
} from './galeraStatus.ts';

type Row = [string, string];

/** One node's poll outcome, as the panel assembles it from the backend events. */
export interface NodeSnapshot {
  connectionId: string;
  connectionName: string;
  ok: boolean;
  /** Poll error text when ok=false (connect refused, timeout, mid-SST 1047…). */
  error: string | null;
  /** Raw SHOW rows; parsed here so the caller ships what the backend shipped. */
  statusRows: Row[];
  variableRows: Row[];
  /** Backend-measured connect+probe time. */
  elapsedMs: number;
  /** Wall-clock time the poll finished (epoch ms) — the rate denominator. */
  polledAtMs: number;
}

/** Per-second write activity, diffed against the previous poll. */
export interface NodeRates {
  /** wsrep_last_committed delta / interval — committed write-sets per second. */
  commitsPerSec: number | null;
  /** wsrep_replicated_bytes delta / interval — bytes/s sent to the cluster. */
  replicatedBytesPerSec: number | null;
  /** wsrep_received_bytes delta / interval — bytes/s received from the cluster. */
  receivedBytesPerSec: number | null;
}

export interface NodeSummary {
  connectionId: string;
  /** The saved connection's name — always present, even for a dead node. */
  name: string;
  /** wsrep_node_name, when the node answered. */
  nodeName: string | null;
  reachable: boolean;
  error: string | null;
  /** wsrep provider ON. A reachable non-Galera server is false, not an error. */
  detected: boolean;
  localState: string | null;
  /** null = unreadable key; never guessed. */
  synced: boolean | null;
  clusterName: string | null;
  clusterStateUuid: string | null;
  clusterStatus: string | null;
  /** wsrep_cluster_size as THIS node sees it — disagreement is a finding. */
  clusterSize: number | null;
  incomingAddresses: string[];
  flowControlPaused: number | null;
  recvQueue: number | null;
  recvQueueAvg: number | null;
  sendQueue: number | null;
  lastCommitted: number | null;
  rates: NodeRates;
  transfer: GaleraTransfer | null;
  ist: IstProgress | null;
  polledAtMs: number;
}

export interface ClusterFinding {
  level: GaleraLevel;
  title: string;
  detail: string;
}

export interface ClusterView {
  nodes: NodeSummary[];
  findings: ClusterFinding[];
}

/**
 * First-observed-in-state stamp per node, kept by the caller across polls
 * (the same pattern the single-node view uses for its transfer card). Keyed
 * by connectionId so a rename never loses a running SST clock.
 */
export interface StateSince {
  state: string | null;
  sinceMs: number;
}

export interface MergeContext {
  nowMs: number;
  /** Previous poll's snapshots — the rate math's baseline. */
  prev?: NodeSnapshot[];
  /** Per-node state clocks, from `trackStateSince`. */
  stateSince?: Record<string, StateSince>;
  /**
   * Donor↔joiner pair clocks, from `trackPairSince` — key
   * `${donorConnectionId}→${joinerConnectionId}` → first-observed stamp.
   */
  pairSince?: Record<string, number>;
}

/**
 * The classic mid-SST refusal where the port IS open: ERROR 1047 (08S01)
 * "WSREP has not yet prepared node for application use". Not the only shape —
 * on MariaDB 11.8 + rsync SST the joiner refuses TCP connections entirely
 * (ERROR 2002) until it is Synced (verified live), so a bare
 * connection-refused only reads as mid-SST when a peer is donating; that
 * correlation lives in mergeCluster, not here.
 */
export function looksLikeMidSst(error: string | null): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return e.includes('1047') || e.includes('not yet prepared');
}

/** wsrep_incoming_addresses → host:port tokens ('AUTO'/blank tolerated). */
export function parseIncoming(v: string | null): string[] {
  if (!v) return [];
  return v.split(',').map(s => s.trim()).filter(s => s && s.toUpperCase() !== 'AUTO');
}

function rates(cur: GaleraStatus, curAtMs: number, prev: GaleraStatus | null, prevAtMs: number): NodeRates {
  const none: NodeRates = { commitsPerSec: null, replicatedBytesPerSec: null, receivedBytesPerSec: null };
  if (!prev) return none;
  const dtSec = (curAtMs - prevAtMs) / 1000;
  if (dtSec <= 0) return none;
  // A decreasing counter is a server restart or FLUSH STATUS: the rate is
  // unreadable this interval, not negative.
  const rate = (c: number | null, p: number | null): number | null =>
    c !== null && p !== null && c >= p ? (c - p) / dtSec : null;
  return {
    commitsPerSec: rate(cur.lastCommitted, prev.lastCommitted),
    replicatedBytesPerSec: rate(cur.replicatedBytes, prev.replicatedBytes),
    receivedBytesPerSec: rate(cur.receivedBytes, prev.receivedBytes),
  };
}

function summarize(
  snap: NodeSnapshot,
  prev: NodeSnapshot | undefined,
  ctx: MergeContext,
): NodeSummary {
  const base = {
    connectionId: snap.connectionId,
    name: snap.connectionName,
    polledAtMs: snap.polledAtMs,
    rates: { commitsPerSec: null, replicatedBytesPerSec: null, receivedBytesPerSec: null } as NodeRates,
    transfer: null, ist: null,
  };
  if (!snap.ok) {
    return {
      ...base,
      nodeName: null, reachable: false, error: snap.error, detected: false,
      localState: null, synced: null,
      clusterName: null, clusterStateUuid: null, clusterStatus: null,
      clusterSize: null, incomingAddresses: [],
      flowControlPaused: null, recvQueue: null, recvQueueAvg: null, sendQueue: null,
      lastCommitted: null,
    };
  }
  const s: GaleraStatus = parseGaleraStatus(snap.statusRows, snap.variableRows);
  const prevParsed = prev && prev.ok ? parseGaleraStatus(prev.statusRows, prev.variableRows) : null;
  const since = ctx.stateSince?.[snap.connectionId];
  const clock = since && since.state === s.localStateComment ? since.sinceMs : 0;
  return {
    ...base,
    nodeName: s.nodeName,
    reachable: true,
    error: null,
    detected: s.detected,
    localState: s.localStateComment,
    synced: s.localStateComment === null ? null : s.localStateComment === 'Synced',
    clusterName: s.clusterName,
    clusterStateUuid: s.clusterStateUuid,
    clusterStatus: s.clusterStatus,
    clusterSize: s.clusterSize,
    incomingAddresses: parseIncoming(s.incomingAddresses),
    flowControlPaused: s.flowControlPaused,
    recvQueue: s.localRecvQueue,
    recvQueueAvg: s.localRecvQueueAvg,
    sendQueue: s.localSendQueue,
    lastCommitted: s.lastCommitted,
    rates: rates(s, snap.polledAtMs, prevParsed, prev?.polledAtMs ?? 0),
    transfer: transferState(s, ctx.nowMs, clock),
    ist: istProgress(s),
  };
}

/** Nodes that answered AND carry a live wsrep provider — the comparable set. */
function galeraNodes(view: NodeSummary[]): NodeSummary[] {
  return view.filter(n => n.reachable && n.detected);
}

function isDonor(n: NodeSummary): boolean {
  return n.transfer?.phase === 'donor'
    // Only a MANUAL desync (wsrep_desync=ON) is excluded — it is not serving a
    // transfer. 'sst' (desync readable and OFF) and 'unknown' (unreadable) both
    // count: on MariaDB a live SST donor shows desync=OFF + desync_count=1,
    // verified live on 11.8 — excluding those would make pairing PXC-only.
    && n.transfer.donorCause !== 'manual';
}

/**
 * Merge one poll round into the cluster view. Findings are emitted
 * most-severe first, in the rule order they are documented in.
 */
export function mergeCluster(nodes: NodeSnapshot[], ctx: MergeContext): ClusterView {
  const prevById = new Map((ctx.prev ?? []).map(p => [p.connectionId, p]));
  const view = nodes.map(n => summarize(n, prevById.get(n.connectionId), ctx));
  const findings: ClusterFinding[] = [];
  const live = galeraNodes(view);
  const display = (n: NodeSummary) => n.nodeName ? `${n.name} (${n.nodeName})` : n.name;

  // Group by cluster name: cross-cluster comparisons are the mixed-cluster
  // finding, not split-brain evidence.
  const byCluster = new Map<string, NodeSummary[]>();
  for (const n of live) {
    const key = n.clusterName ?? '(unknown cluster)';
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key)!.push(n);
  }

  // ── CRIT: split-brain ─────────────────────────────────────────────────────
  for (const [cluster, members] of byCluster) {
    const uuids = new Set(members.map(m => m.clusterStateUuid).filter((u): u is string => u !== null));
    if (uuids.size > 1) {
      findings.push({
        level: 'crit',
        title: `Split-brain: nodes of "${cluster}" report ${uuids.size} different cluster state UUIDs`,
        detail: 'wsrep_cluster_state_uuid is the cluster\'s shared history. Two values ' +
          'under one cluster name means the nodes diverged — writes certified on one ' +
          'side are unknown to the other. Stop traffic to the minority side and ' +
          're-join it (it will need SST).',
      });
    }
    const primary = members.filter(m => m.clusterStatus === 'Primary' && m.incomingAddresses.length > 0);
    for (let i = 0; i < primary.length; i++) {
      for (let j = i + 1; j < primary.length; j++) {
        const a = new Set(primary[i].incomingAddresses);
        const disjoint = primary[j].incomingAddresses.every(addr => !a.has(addr));
        if (disjoint) {
          findings.push({
            level: 'crit',
            title: `Split-brain: ${display(primary[i])} and ${display(primary[j])} are both Primary over disjoint memberships`,
            detail: `Each claims the Primary component but their wsrep_incoming_addresses ` +
              `share no member (${primary[i].incomingAddresses.join(', ')} vs ` +
              `${primary[j].incomingAddresses.join(', ')}) — the cluster is partitioned ` +
              'into two quorate-looking halves. This is the failure Galera exists to ' +
              'prevent; verify which side truly holds quorum before writing anywhere.',
          });
        }
      }
    }
  }

  // ── WARN: mixed cluster names (operator picked nodes of two clusters) ─────
  const names = [...new Set(live.map(n => n.clusterName).filter((c): c is string => c !== null))];
  if (names.length > 1) {
    findings.push({
      level: 'warn',
      title: `Polled nodes belong to ${names.length} different clusters: ${names.join(', ')}`,
      detail: 'wsrep_cluster_name differs across the selection — these nodes are not one ' +
        'cluster being monitored, they are several. Size/membership findings below are ' +
        'computed per cluster; deselect the nodes that do not belong here.',
    });
  }

  // ── WARN: size disagreement within a cluster ──────────────────────────────
  for (const [cluster, members] of byCluster) {
    if (members.length < 2) continue;
    const sizes = new Set(members.map(m => m.clusterSize).filter((s): s is number => s !== null));
    if (sizes.size > 1) {
      const per = members.map(m => `${display(m)} sees ${m.clusterSize ?? '?'}`).join(', ');
      findings.push({
        level: 'warn',
        title: `"${cluster}": nodes disagree on the cluster size (${[...sizes].sort((x, y) => x - y).join(' vs ')})`,
        detail: `${per}. Every member of a healthy component sees the same ` +
          'wsrep_cluster_size. Disagreement means a node is mid-join, mid-partition ' +
          'or stuck in an old view — correlate with the membership finding below.',
      });
    }
  }

  // ── WARN: membership disagreement within a cluster ────────────────────────
  for (const [cluster, members] of byCluster) {
    if (members.length < 2) continue;
    const union = new Set(members.flatMap(m => m.incomingAddresses));
    if (union.size === 0) continue;
    for (const m of members) {
      if (m.incomingAddresses.length === 0) continue;
      const missing = [...union].filter(a => !m.incomingAddresses.includes(a));
      if (missing.length > 0) {
        findings.push({
          level: 'warn',
          title: `"${cluster}": ${display(m)} does not see ${missing.join(', ')} in its membership`,
          detail: 'wsrep_incoming_addresses is this node\'s view of the component. ' +
            'Another polled node lists members this one lacks — the usual cause is a ' +
            'node that has not finished joining, or a partial network partition ' +
            'forming right now.',
        });
      }
    }
  }

  // ── WARN/INFO: unreachable nodes ─────────────────────────────────────────
  // Two mid-SST shapes: the 1047 signature (port open, queries refused) and,
  // verified live on MariaDB 11.8 + rsync SST, plain connection-refused while
  // a peer is Donor/Desynced — the joiner's mariadbd does not open the client
  // port until the transfer completes. Refused WITHOUT a live donor stays a
  // plain "unreachable" warning (a crashed node is not an SST).
  const donorsNow = live.filter(isDonor);
  for (const n of view.filter(n => !n.reachable)) {
    if (looksLikeMidSst(n.error)) {
      findings.push({
        level: 'info',
        title: `${n.name} refuses queries — likely mid-SST`,
        detail: `The node answered with the 1047 "WSREP has not yet prepared node for ` +
          `application use" signature, which is what a joiner says while a state ` +
          `transfer streams in. Expected to clear on its own; the node's card turns ` +
          'green when it reaches Synced. Raw error: ' + (n.error ?? ''),
      });
    } else if (donorsNow.length > 0) {
      findings.push({
        level: 'info',
        title: `${n.name} is unreachable while ${display(donorsNow[0])} donates — likely the SST joiner`,
        detail: `The node does not answer at all (connection refused) exactly while ` +
          `${display(donorsNow[0])} is Donor/Desynced — the shape of a state transfer ` +
          `whose joiner keeps its port closed until it syncs (the observed rsync-SST ` +
          `behavior on MariaDB 11.8). Expected to clear on its own. Raw error: ` +
          (n.error ?? ''),
      });
    } else {
      findings.push({
        level: 'warn',
        title: `${n.name} is unreachable`,
        detail: (n.error ?? 'poll failed') + ' — one polled node did not answer. The ' +
          'cluster findings below are computed from the nodes that did.',
      });
    }
  }

  // ── INFO: donor ↔ joiner pairing (SST in progress, with elapsed) ──────────
  const donors = donorsNow;
  const joiners = live.filter(n => n.localState === 'Joining');
  for (const d of donors) {
    for (const j of joiners) {
      const key = `${d.connectionId}→${j.connectionId}`;
      const since = ctx.pairSince?.[key] ?? ctx.nowMs;
      findings.push({
        level: 'info',
        title: `SST in progress: ${display(d)} → ${display(j)}, elapsed ${fmtElapsed(Math.max(0, ctx.nowMs - since))}`,
        detail: `${display(d)} is Desynced donating a state transfer while ` +
          `${display(j)} is Joining. Expect degraded writes on the donor and no ` +
          'client service on the joiner until it flips Joined → Synced.',
      });
    }
  }

  // ── INFO: the slowest node ────────────────────────────────────────────────
  // Persistent = the EWMA moved, not a single write burst; unique max only,
  // so two equally-behind nodes name neither (that is a cluster problem, and
  // the per-node rules already say so). The EWMA needs a non-empty CURRENT
  // queue as corroboration: its memory is long enough (verified live: ~30
  // min) that a past IST/SST catch-up leaves it high on an idle, caught-up
  // node — residue, not a live bottleneck.
  const withAvg = live.filter(n => n.recvQueueAvg !== null && n.recvQueueAvg > QUEUE_AVG_WARN
    && (n.recvQueue === null || n.recvQueue > 0));
  if (withAvg.length > 0) {
    const worst = withAvg.reduce((a, b) => (b.recvQueueAvg! > a.recvQueueAvg! ? b : a));
    if (withAvg.every(n => n === worst || n.recvQueueAvg! < worst.recvQueueAvg!)) {
      findings.push({
        level: 'info',
        title: `Slowest node: ${display(worst)} — persistent apply backlog (avg ${worst.recvQueueAvg!.toFixed(2)})`,
        detail: 'wsrep_local_recv_queue_avg is a moving average, so it only moves when ' +
          'the node applies slower than the cluster writes for a while. Everything ' +
          'else waits for this node through flow control — raise wsrep_slave_threads ' +
          'or find its I/O bottleneck.',
      });
    }
  } else {
    const queued = live.filter(n => n.recvQueue !== null && n.recvQueue > QUEUE_WARN);
    if (queued.length > 0) {
      const worst = queued.reduce((a, b) => (b.recvQueue! > a.recvQueue! ? b : a));
      if (queued.every(n => n === worst || n.recvQueue! < worst.recvQueue!)) {
        findings.push({
          level: 'info',
          title: `Largest apply queue: ${display(worst)} (${worst.recvQueue!.toLocaleString()} events)`,
          detail: 'wsrep_local_recv_queue is the apply backlog — reads on this node are ' +
            'stale relative to the cluster right now. A queue that does not drain ' +
            'becomes flow control for everyone.',
        });
      }
    }
  }
  const throttled = live.filter(n => n.flowControlPaused !== null && n.flowControlPaused > FC_WARN);
  if (throttled.length > 0) {
    const worst = throttled.reduce((a, b) => (b.flowControlPaused! > a.flowControlPaused! ? b : a));
    if (throttled.every(n => n === worst || n.flowControlPaused! < worst.flowControlPaused!)) {
      findings.push({
        level: 'info',
        title: `Most flow-control throttled: ${display(worst)} (~${Math.round(worst.flowControlPaused! * 100)}% of the time)`,
        detail: 'The cluster told THIS node to stop accepting writes more often than ' +
          'any other polled node — it is where the apply bottleneck currently sits.',
      });
    }
  }

  // ── WARN: reachable but no wsrep provider ─────────────────────────────────
  for (const n of view.filter(n => n.reachable && !n.detected)) {
    findings.push({
      level: 'warn',
      title: `${n.name} is not a Galera node`,
      detail: 'It answered, but wsrep_on is OFF/absent — a standalone MySQL/MariaDB ' +
        'server in the node list. It is excluded from every cluster finding; ' +
        'deselect it or point the picker at the cluster\'s actual members.',
    });
  }

  // ── OK: everything reachable, one cluster, all Synced, one size ───────────
  if (!findings.length && live.length > 0 && live.length === view.length) {
    const cluster = names[0] ?? '(unnamed)';
    const size = live[0].clusterSize;
    const allSynced = live.every(n => n.localState === 'Synced');
    const sameSize = live.every(n => n.clusterSize === size);
    if (allSynced && names.length === 1 && sameSize) {
      findings.push({
        level: 'ok',
        title: `${live.length} node${live.length === 1 ? '' : 's'}, all Synced` +
          `${size !== null ? `, size ${size}` : ''}, cluster ${cluster}`,
        detail: 'Every polled node answers, agrees on the membership and reports ' +
          'Synced in the Primary component.',
      });
    }
  }

  return { nodes: view, findings: sortFindings(findings) };
}

/** Severity order shared by every finding producer — mergeCluster sorts its
 *  own, and the panel's add-on modules (ghosts, conflicts, write sources,
 *  quorum) reuse this to merge theirs into the same strip. */
export function sortFindings(findings: ClusterFinding[]): ClusterFinding[] {
  const order: Record<GaleraLevel, number> = { crit: 0, warn: 1, info: 2, ok: 3 };
  return [...findings].sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * Advance the per-node state clocks by one poll: a node still in the same
 * local state keeps its stamp, a changed (or newly seen) state restarts it.
 * Unreachable nodes keep their old clock — a failed poll says nothing about
 * the state, and the SST clock should not reset because a probe timed out.
 */
export function trackStateSince(
  nodes: NodeSnapshot[],
  prev: Record<string, StateSince>,
  nowMs: number,
): Record<string, StateSince> {
  const next: Record<string, StateSince> = { ...prev };
  for (const n of nodes) {
    if (!n.ok) continue;
    const state = parseGaleraStatus(n.statusRows, n.variableRows).localStateComment;
    const cur = prev[n.connectionId];
    next[n.connectionId] = cur && cur.state === state ? cur : { state, sinceMs: nowMs };
  }
  return next;
}

/**
 * Advance the donor↔joiner pair clocks by one poll: pairs still observed keep
 * their stamp (that is the SST elapsed time), vanished pairs are dropped so a
 * LATER transfer between the same two nodes starts a fresh clock.
 */
export function trackPairSince(
  view: ClusterView,
  prev: Record<string, number>,
  nowMs: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  const donors = view.nodes.filter(isDonor);
  const joiners = view.nodes.filter(n => n.reachable && n.detected && n.localState === 'Joining');
  for (const d of donors) {
    for (const j of joiners) {
      const key = `${d.connectionId}→${j.connectionId}`;
      next[key] = prev[key] ?? nowMs;
    }
  }
  return next;
}
