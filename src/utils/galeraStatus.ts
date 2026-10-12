/**
 * Galera cluster (wsrep) status — parsing and health rules.
 *
 * The Replication panel's Galera view runs two read-only queries through
 * `monitor_query` — `SHOW GLOBAL STATUS LIKE 'wsrep%'` and
 * `SHOW GLOBAL VARIABLES LIKE 'wsrep%'` — on MariaDB Galera Cluster and
 * Percona XtraDB Cluster nodes. On a non-Galera server both return empty
 * sets, which is the detection signal, not an error: `detectGalera` reads
 * `wsrep_on` and everything downstream keys off it.
 *
 * Status holds the volatile counters (cluster status, queues, flow control);
 * variables hold the identity (cluster name, node name, incoming addresses).
 * `wsrep_on` does NOT exist as a STATUS variable on MariaDB 11.8 (verified
 * live, 2026-10-02: `SHOW GLOBAL STATUS LIKE 'wsrep_on'` is empty on both a
 * Galera node and a standalone build) — only the VARIABLE carries it, ON when
 * the provider is loaded and active, OFF when `wsrep_provider = none`. PXC
 * carries it in both. `detectGalera` therefore works on either row set, and
 * `parseGaleraStatus` reads the status copy first, the variable as fallback.
 * The same split applies to `wsrep_incoming_addresses`: STATUS on MariaDB,
 * VARIABLES on PXC.
 *
 * The key set differs between MariaDB's Galera and PXC (and between Galera
 * library versions), so every field is nullable and every rule skips what it
 * cannot read — a missing key degrades a rule, it never crashes one.
 *
 * On top of the snapshot sit three derivations for the transfer watch:
 * `transferState` (SST/catch-up/donor card data), `istProgress` (the
 * determinate PXC IST bar from the wsrep_ist_* keys) and `gcacheWindow`
 * (the IST-window estimator from wsrep_local_cached_downto plus the view's
 * own poll samples). Note on joiner visibility, verified live on MariaDB
 * 11.8 + rsync SST (2026-10-02): the joiner refuses TCP connections
 * ENTIRELY (ERROR 2002) for the whole transfer — mariadbd opens the client
 * port only once the node is Synced, for IST catch-up too — so the only
 * SQL-visible transfer signal on this setup is the DONOR's Donor/Desynced
 * state. The 1047 "answers SHOW, rejects queries" middle ground exists in
 * the code for setups where the port opens early, but was never observed
 * here.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */

export type GaleraLevel = 'crit' | 'warn' | 'info' | 'ok';

export interface GaleraFinding {
  level: GaleraLevel;
  title: string;
  detail: string;
}

export interface GaleraStatus {
  /** `wsrep_on` said ON — everything below is meaningless when false. */
  detected: boolean;
  /** wsrep_provider (variable) — the library path, e.g. libgalera_smm.so. */
  provider: string | null;
  /** wsrep_provider_version (status), when the library reports one. */
  providerVersion: string | null;
  clusterName: string | null;
  clusterStateUuid: string | null;
  clusterConfId: number | null;
  /** 'Primary' is the healthy component; 'Non-Primary'/'Disconnected' are not. */
  clusterStatus: string | null;
  clusterSize: number | null;
  incomingAddresses: string | null;
  nodeName: string | null;
  nodeAddress: string | null;
  /** Synced / Donor/Desynced / Joined / Joining — Synced is healthy. */
  localStateComment: string | null;
  /** 'ON'/'OFF' — OFF means the node refuses client queries. */
  ready: string | null;
  /** 'ON'/'OFF' — OFF means no replication traffic flows. */
  connected: string | null;
  lastCommitted: number | null;
  localCertFailures: number | null;
  /** Apply backlog — events received but not yet applied. */
  localRecvQueue: number | null;
  /** Send backlog — events generated but not yet replicated out. */
  localSendQueue: number | null;
  /** Cumulative bytes replicated out / received in, when the library counts them. */
  replicatedBytes: number | null;
  receivedBytes: number | null;
  /**
   * wsrep_replicated / wsrep_received — cumulative write-set COUNTS:
   * originated by this node vs received from peers. The write-source
   * distribution (utils/galeraWriteSources.ts) diffs these across polls;
   * bytes alone cannot say how many transactions a share represents.
   */
  replicated: number | null;
  received: number | null;
  /** 0..1 — the fraction of time the cluster throttled THIS node. */
  flowControlPaused: number | null;
  flowControlSent: number | null;
  flowControlRecv: number | null;
  /**
   * wsrep_flow_control_paused_ns — cumulative nanoseconds paused. Rate-based
   * (compare between samples), immune to the FLUSH STATUS resets that make
   * the paused ratio lie.
   */
  flowControlPausedNs: number | null;
  /** wsrep_local_recv_queue_avg — EWMA of the apply backlog. */
  localRecvQueueAvg: number | null;
  /** wsrep_desync variable — ON means manually desynced (backup mode). */
  desync: string | null;
  /** wsrep_reject_queries variable — NONE / ALL / ALL_KILL (maintenance mode). */
  rejectQueries: string | null;
  /** wsrep_slave_threads variable — parallel applier threads (1..512). */
  slaveThreads: number | null;
  /** wsrep_desync_count (MariaDB) — >0 while a manual desync is in effect. */
  desyncCount: number | null;
  /** wsrep_evs_evict_list — evicted nodes pending a mysqld restart. */
  evsEvictList: string | null;
  /** wsrep_evs_repl_latency — "min/avg/max" seconds between nodes. */
  evsReplLatency: string | null;
  /** wsrep_local_bf_aborts — certification conflicts killing local transactions. */
  localBfAborts: number | null;
  /** wsrep_local_cached_downto — lowest seqno still in the gcache. */
  localCachedDownto: number | null;
  /** wsrep_provider_options — "k=v; k=v; …" (gcache.size lives here). */
  providerOptions: string | null;
  /** wsrep_ist_receive_status (PXC) — transfer percentage text, blank when idle. */
  istReceiveStatus: string | null;
  /** wsrep_ist_receive_seqno_start/current/end (PXC) — exact IST progress. */
  istReceiveSeqnoStart: number | null;
  istReceiveSeqnoCurrent: number | null;
  istReceiveSeqnoEnd: number | null;
}

/**
 * Queue depth (events) at which a backlog is worth a warning. Single-digit
 * queues come and go with normal write bursts; a queue that sits above this
 * across polls is a node falling behind.
 */
export const QUEUE_WARN = 8;

/** Flow-control paused-ratio thresholds: info above 1%, warn above 10%, crit above 50%. */
export const FC_INFO = 0.01;
export const FC_WARN = 0.1;
export const FC_CRIT = 0.5;

/**
 * Recv-queue EWMA above which the backlog counts as persistent — PROVIDED the
 * instantaneous queue is non-empty too. The EWMA's memory is long (observed
 * live on MariaDB 11.8 + galera 26.4.27: still 3.14 twenty-five minutes after
 * an IST rejoin's catch-up burst, on an idle fully-Synced node), so a high
 * average with an EMPTY queue is residue from a past catch-up, not a live
 * backlog. An unreadable instantaneous queue (null) cannot corroborate, so
 * the average alone decides in that case (unknown-means-allowed).
 */
export const QUEUE_AVG_WARN = 1.0;

/** Brute-force aborts per poll interval at which the info becomes a warn. */
export const BF_ABORT_WARN = 5;

type Row = [string, string];

function toMap(rows: Row[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of rows) m.set(k.toLowerCase(), v);
  return m;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Is a wsrep ON/OFF value on? Tolerates case and surrounding whitespace. */
export function statusOn(v: string | null | undefined): boolean {
  return (v ?? '').trim().toUpperCase() === 'ON';
}

/**
 * Detection from a `wsrep_on` row: ON means the Galera provider is loaded AND
 * active. On MariaDB (11.8 verified live) the row only exists in
 * `SHOW GLOBAL VARIABLES`; PXC also carries it in STATUS — either row set
 * works. An empty result set (non-Galera server, or the STATUS probe on
 * MariaDB) is the expected negative, not an error.
 */
export function detectGalera(statusRows: Row[]): boolean {
  return statusRows.some(([k, v]) => k.toLowerCase() === 'wsrep_on' && statusOn(v));
}

/** Parse the two SHOW result sets into the typed snapshot. */
export function parseGaleraStatus(statusRows: Row[], varRows: Row[]): GaleraStatus {
  const st = toMap(statusRows);
  const va = toMap(varRows);
  const str = (m: Map<string, string>, k: string): string | null => {
    const v = m.get(k);
    return v === undefined || v === '' ? null : v;
  };
  const g = (k: string): string | null => str(st, k) ?? str(va, k);
  const n = (k: string): number | null => num(st.get(k));

  return {
    // STATUS wsrep_on is authoritative; the variable catches MariaDB builds
    // where the status row is absent but the provider variable says ON.
    detected: statusOn(st.get('wsrep_on')) || statusOn(va.get('wsrep_on')),
    provider: str(va, 'wsrep_provider'),
    providerVersion: g('wsrep_provider_version'),
    clusterName: g('wsrep_cluster_name'),
    clusterStateUuid: str(st, 'wsrep_cluster_state_uuid'),
    clusterConfId: n('wsrep_cluster_conf_id'),
    clusterStatus: str(st, 'wsrep_cluster_status'),
    clusterSize: n('wsrep_cluster_size'),
    // STATUS on MariaDB, VARIABLES on PXC — read both.
    incomingAddresses: g('wsrep_incoming_addresses'),
    nodeName: str(va, 'wsrep_node_name'),
    nodeAddress: str(va, 'wsrep_node_address') ?? str(st, 'wsrep_node_address'),
    localStateComment: str(st, 'wsrep_local_state_comment'),
    ready: str(st, 'wsrep_ready') ?? str(va, 'wsrep_ready'),
    connected: str(st, 'wsrep_connected'),
    lastCommitted: n('wsrep_last_committed'),
    localCertFailures: n('wsrep_local_cert_failures'),
    localRecvQueue: n('wsrep_local_recv_queue'),
    localSendQueue: n('wsrep_local_send_queue'),
    replicatedBytes: n('wsrep_replicated_bytes'),
    receivedBytes: n('wsrep_received_bytes'),
    replicated: n('wsrep_replicated'),
    received: n('wsrep_received'),
    flowControlPaused: n('wsrep_flow_control_paused'),
    flowControlSent: n('wsrep_flow_control_sent'),
    flowControlRecv: n('wsrep_flow_control_recv'),
    flowControlPausedNs: n('wsrep_flow_control_paused_ns'),
    localRecvQueueAvg: n('wsrep_local_recv_queue_avg'),
    desync: g('wsrep_desync'),
    rejectQueries: str(va, 'wsrep_reject_queries'),
    slaveThreads: num(va.get('wsrep_slave_threads')),
    desyncCount: n('wsrep_desync_count'),
    evsEvictList: str(st, 'wsrep_evs_evict_list'),
    evsReplLatency: str(st, 'wsrep_evs_repl_latency'),
    localBfAborts: n('wsrep_local_bf_aborts'),
    localCachedDownto: n('wsrep_local_cached_downto'),
    providerOptions: g('wsrep_provider_options'),
    istReceiveStatus: str(st, 'wsrep_ist_receive_status'),
    istReceiveSeqnoStart: n('wsrep_ist_receive_seqno_start'),
    istReceiveSeqnoCurrent: n('wsrep_ist_receive_seqno_current'),
    istReceiveSeqnoEnd: n('wsrep_ist_receive_seqno_end'),
  };
}

/**
 * The donor state. The documented value is 'Donor/Desynced' (slash) on both
 * MariaDB and Percona; some builds and UIs render the hyphen, so both spell
 * the same state.
 */
export function isDonorState(state: string | null): boolean {
  return state === 'Donor/Desynced' || state === 'Donor-Desynced';
}

/**
 * Health rules over the parsed snapshot. Each rule fires only on keys it can
 * actually read; a healthy cluster yields exactly one 'ok' finding. Returned
 * most-severe first, which is also the render order.
 *
 * `prev` is the previous poll's snapshot; the rate-based rules (flow-control
 * paused_ns, brute-force aborts) need it and stay silent on the first sample.
 */
export function galeraFindings(s: GaleraStatus, prev?: GaleraStatus): GaleraFinding[] {
  if (!s.detected) return [];
  const out: GaleraFinding[] = [];
  const pct = fmtPct(s.flowControlPaused);

  if (s.clusterStatus !== null && s.clusterStatus !== 'Primary') {
    out.push({
      level: 'crit',
      title: 'Split-brain risk: this node is in a non-Primary component',
      detail: `wsrep_cluster_status is "${s.clusterStatus}". A non-Primary component ` +
        'cannot certify writes — the node is either partitioned away from the cluster ' +
        'quorum or the cluster never formed. Writes here will fail or, worse, diverge.',
    });
  }
  if (s.connected !== null && !statusOn(s.connected)) {
    out.push({
      level: 'crit',
      title: 'Node not connected to the cluster',
      detail: 'wsrep_connected is OFF — no replication traffic is flowing in either ' +
        'direction. This node is alone until it re-establishes the cluster link.',
    });
  }
  if (s.ready !== null && !statusOn(s.ready)) {
    out.push({
      level: 'crit',
      title: 'Node not ready — refusing client queries',
      detail: 'wsrep_ready is OFF. The server rejects reads and writes (ER_UNKNOWN_ERROR ' +
        '1047); it is typically mid-SST/IST or was taken out of rotation on purpose.',
    });
  }

  const state = s.localStateComment;
  if (state !== null && state !== 'Synced') {
    if (isDonorState(state)) {
      out.push({
        level: 'info',
        title: 'Node is a donor (Desynced)',
        detail: 'Serving a state transfer (SST) to a joining node, or manually desynced ' +
          'via wsrep_desync. Expect degraded writes while it streams; verify it returns ' +
          'to Synced once the transfer completes.',
      });
    } else if (state === 'Joined') {
      out.push({
        level: 'warn',
        title: 'Node Joined but not yet Synced',
        detail: 'The state transfer finished and the node is catching up on the ' +
          'replication backlog. It should reach Synced on its own; if it sits here, ' +
          'watch wsrep_local_recv_queue.',
      });
    } else if (state === 'Joining') {
      out.push({
        level: 'info',
        title: 'Node is joining the cluster',
        detail: 'SST/IST in progress. The node cannot serve traffic until it reaches ' +
          'Joined, then Synced.',
      });
    } else {
      out.push({
        level: 'info',
        title: `Unrecognized local state "${state}"`,
        detail: 'Not one of Synced / Donor/Desynced / Joined / Joining — check the ' +
          'server log for what the node is doing.',
      });
    }
  }

  // Flow control: the paused_ns RATE is the primary signal where both samples
  // carry it — it is cumulative and immune to the FLUSH STATUS resets that
  // leave the paused ratio stale-high. A counter reset (current < previous)
  // makes the rate unreadable, so that case falls back to the ratio.
  const curNs = s.flowControlPausedNs;
  const prevNs = prev?.flowControlPausedNs ?? null;
  if (curNs !== null && prevNs !== null && curNs >= prevNs) {
    const deltaNs = curNs - prevNs;
    if (deltaNs > 0) {
      const level: GaleraLevel = s.flowControlPaused !== null
        ? (s.flowControlPaused > FC_CRIT ? 'crit' : s.flowControlPaused > FC_WARN ? 'warn' : 'info')
        : 'warn';
      out.push({
        level,
        title: 'Flow control throttled this node since the last poll',
        detail: `wsrep_flow_control_paused_ns grew by ${(deltaNs / 1e9).toFixed(2)} s of paused ` +
          'time between polls — the cluster told THIS node to stop accepting writes because ' +
          'a member could not keep up. Sustained pausing points at the slowest node or ' +
          'undersized apply threads (wsrep_slave_threads).',
      });
    }
    // delta === 0: no throttling in the interval — silent even when the ratio
    // is stale-high from before a FLUSH STATUS.
  } else if (s.flowControlPaused !== null && s.flowControlPaused > FC_INFO) {
    const level: GaleraLevel = s.flowControlPaused > FC_CRIT ? 'crit'
      : s.flowControlPaused > FC_WARN ? 'warn' : 'info';
    out.push({
      level,
      title: `Flow control throttled this node ~${pct} of the time`,
      detail: 'wsrep_flow_control_paused measures how often the cluster told THIS node ' +
        'to stop accepting writes because a member could not keep up. Sustained values ' +
        'point at the slowest node in the cluster or undersized apply threads ' +
        '(wsrep_slave_threads) — this is the single most actionable Galera signal.',
    });
  }
  if (s.localRecvQueue !== null && s.localRecvQueue > QUEUE_WARN) {
    out.push({
      level: 'warn',
      title: `${s.localRecvQueue.toLocaleString()} events queued for apply`,
      detail: 'wsrep_local_recv_queue is the apply backlog: the node received writes it ' +
        'has not applied yet, so its reads are stale relative to the cluster. Growing ' +
        'queues mean this is the slowest node — raise wsrep_slave_threads or find the ' +
        'I/O bottleneck.',
    });
  }
  if (s.localSendQueue !== null && s.localSendQueue > QUEUE_WARN) {
    out.push({
      level: 'warn',
      title: `${s.localSendQueue.toLocaleString()} events queued for send`,
      detail: 'wsrep_local_send_queue is the outbound backlog: this node is generating ' +
        'writes faster than the cluster link carries them — network between nodes is ' +
        'the usual suspect.',
    });
  }
  if (s.localCertFailures !== null && s.localCertFailures > 0) {
    out.push({
      level: 'info',
      title: `${s.localCertFailures.toLocaleString()} certification failures since start`,
      detail: 'Transactions rolled back because a conflicting write won certification ' +
        'on another node. Occasional failures are normal under Galera; a climbing ' +
        'counter means hot rows written from several nodes at once — the application ' +
        'needs retry logic or a write-affinity fix.',
    });
  }
  if (s.localRecvQueueAvg !== null && s.localRecvQueueAvg > QUEUE_AVG_WARN
      && (s.localRecvQueue === null || s.localRecvQueue > 0)) {
    out.push({
      level: 'warn',
      title: `Apply backlog persists — recv queue average ${s.localRecvQueueAvg.toFixed(2)}`,
      detail: 'wsrep_local_recv_queue_avg is a moving average, so single write bursts ' +
        'do not move it: an average above 1.0 means this node applies write-sets ' +
        'slower than the cluster produces them. Raise wsrep_slave_threads or find ' +
        'the I/O bottleneck before flow control starts throttling everyone.',
    });
  }
  // Manual desync: the wsrep_desync VARIABLE is the trustworthy signal.
  // desync_count>0 alone just mirrors a live Donor/Desynced state — an SST
  // donor shows count=1 with desync=OFF (verified live on MariaDB 11.8), so
  // the count never fires this finding on its own when the variable reads OFF.
  if (statusOn(s.desync) || (s.desync === null && s.desyncCount !== null && s.desyncCount > 0)) {
    out.push({
      level: 'info',
      title: 'Node is manually desynced (backup mode?)',
      detail: 'wsrep_desync is ON (desync_count above 0) — this node was taken out of ' +
        'the flow-control loop on purpose (typically for a backup). Writes on the ' +
        'other nodes do not wait for it, and it catches up on its own once desync ' +
        'is switched off.',
    });
  }
  if (s.evsEvictList !== null) {
    out.push({
      level: 'warn',
      title: `Evicted nodes pending: ${s.evsEvictList}`,
      detail: 'wsrep_evs_evict_list names members the group evicted (network timeouts, ' +
        'unresponsive). They cannot rejoin the cluster without a mysqld restart — ' +
        'check why they were evicted before simply restarting them.',
    });
  }
  const lat = parseEvsLatency(s.evsReplLatency);
  if (lat !== null && lat.avg > 0.1 && lat.max > 10 * lat.avg) {
    out.push({
      level: 'warn',
      title: 'Inter-node latency spiking — check the network / slowest node',
      detail: `wsrep_evs_repl_latency is ${fmtSecs(lat.min)} / ${fmtSecs(lat.avg)} / ` +
        `${fmtSecs(lat.max)} (min/avg/max). The max is more than 10× the average while ` +
        'the average itself is high, so at least one node pair has a sick link — ' +
        'replication delay and flow control usually follow.',
    });
  }
  if (s.localBfAborts !== null && prev?.localBfAborts != null && s.localBfAborts > prev.localBfAborts) {
    const delta = s.localBfAborts - prev.localBfAborts;
    out.push({
      level: delta >= BF_ABORT_WARN ? 'warn' : 'info',
      title: `${delta.toLocaleString()} brute-force abort${delta === 1 ? '' : 's'} since the last poll`,
      detail: 'Certification conflicts killed local transactions in flight on this node ' +
        '(wsrep_local_bf_aborts). A rising rate means hot rows written from several ' +
        'nodes at once — the application needs retry logic or a write-affinity fix.',
    });
  }
  if (s.clusterSize === 1 && s.clusterStatus === 'Primary') {
    out.push({
      level: 'info',
      title: 'Single-node Primary component',
      detail: 'wsrep_cluster_size is 1 — this node is the whole cluster right now. ' +
        'There is no redundancy until the other members rejoin.',
    });
  }

  if (!out.length) {
    out.push({
      level: 'ok',
      title: 'Cluster Primary, node Synced, no flow control',
      detail: 'All monitored signals are in their healthy state.',
    });
  }

  const order: Record<GaleraLevel, number> = { crit: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/** Parse wsrep_evs_repl_latency "min/avg/max" (seconds) into numbers. */
export function parseEvsLatency(v: string | null): { min: number; avg: number; max: number } | null {
  if (!v) return null;
  const parts = v.split('/').map(p => Number(p.trim()));
  if (parts.length !== 3 || parts.some(p => !Number.isFinite(p))) return null;
  return { min: parts[0], avg: parts[1], max: parts[2] };
}

/** Seconds with adaptive precision: `0.042 s` / `1.50 s`. */
function fmtSecs(v: number): string {
  return `${v < 1 ? v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0') : v.toFixed(2)} s`;
}

export type TransferPhase = 'sst' | 'catchup' | 'donor';
/**
 * Why a node sits in Donor/Desynced: 'manual' (wsrep_desync=ON), 'sst'
 * (donating a transfer — wsrep_desync is readable and OFF), or 'unknown'
 * (the desync variable is unreadable, so the two cannot be told apart).
 * Verified live on MariaDB 11.8 (2026-10-02): an rsync-SST donor reports
 * wsrep_desync=OFF with wsrep_desync_count=1 — the count confirms a LIVE
 * desync, it does NOT point at backup mode.
 */
export type DonorCause = 'manual' | 'sst' | 'unknown';

export interface GaleraTransfer {
  phase: TransferPhase;
  title: string;
  detail: string;
  /** Wall time since the state was first observed by the polling view. */
  elapsedMs: number;
  /** Catch-up countdown — write-sets still queued for apply. */
  queueLeft: number | null;
  donorCause: DonorCause | null;
}

/**
 * Transfer-in-progress card data, derived from the local state comment.
 * Returns null on Synced, on unrecognized states, and when the key is
 * missing. `observedSinceMs` is the view's first-observed-in-state stamp
 * (0 = unknown → elapsed 0); elapsed is clamped non-negative.
 *
 * There is NO SQL-visible SST percentage on any variant — the SST copy says
 * so and shows elapsed time instead. PXC IST progress is istProgress()'s job.
 */
export function transferState(s: GaleraStatus, nowMs: number, observedSinceMs: number): GaleraTransfer | null {
  const elapsedMs = observedSinceMs > 0 ? Math.max(0, nowMs - observedSinceMs) : 0;
  const state = s.localStateComment;
  if (state === 'Joining') {
    return {
      phase: 'sst',
      title: 'Receiving full state transfer (SST)',
      detail: 'Galera does not expose SST progress over SQL — elapsed time shown. ' +
        'The node cannot serve client traffic until the transfer completes and it ' +
        'reaches Joined; on MariaDB + rsync SST it typically refuses connections ' +
        'altogether until then, so seeing this state at all means the port opened early.',
      elapsedMs,
      queueLeft: null,
      donorCause: null,
    };
  }
  if (state === 'Joined') {
    return {
      phase: 'catchup',
      title: 'Transfer received — catching up on queued write-sets',
      detail: s.localRecvQueue !== null
        ? `${s.localRecvQueue.toLocaleString()} write-sets left to apply; the node ` +
          'flips to Synced when the queue drains.'
        : 'The transfer finished and the node is applying the replication backlog ' +
          '(wsrep_local_recv_queue not reported here); it flips to Synced when caught up.',
      elapsedMs,
      queueLeft: s.localRecvQueue,
      donorCause: null,
    };
  }
  if (isDonorState(state)) {
    if (statusOn(s.desync)) {
      return {
        phase: 'donor',
        title: 'Manually desynced — this node is out of the flow-control loop',
        detail: 'wsrep_desync is ON: the node was desynced by hand, typically so a ' +
          'backup can run without flow control waiting on it. It is NOT necessarily ' +
          'serving a state transfer.',
        elapsedMs,
        queueLeft: null,
        donorCause: 'manual',
      };
    }
    // wsrep_desync readable and OFF: a donated transfer. wsrep_desync_count>0
    // confirms the desync is live — on MariaDB 11.8 an rsync-SST donor shows
    // exactly desync=OFF + count=1 (verified live), so the count is evidence
    // FOR a donation here, not for backup mode.
    if (s.desync !== null) {
      return {
        phase: 'donor',
        title: 'Donating state transfer — this node is the donor',
        detail: 'Streaming a state transfer (SST) to a joining node — wsrep_desync is ' +
          'OFF, so this is not a manual desync. Expect degraded writes while it ' +
          'streams; the node returns to Synced when the transfer completes.',
        elapsedMs,
        queueLeft: null,
        donorCause: 'sst',
      };
    }
    return {
      phase: 'donor',
      title: 'Donor/Desynced — donating a transfer or manually desynced',
      detail: 'Serving a state transfer to a joining node, or manually desynced ' +
        'via wsrep_desync; the SHOW output here cannot tell which (the wsrep_desync ' +
        'variable did not parse). Expect degraded writes while it streams.',
      elapsedMs,
      queueLeft: null,
      donorCause: 'unknown',
    };
  }
  return null;
}

export interface IstProgress {
  /** 0..1 — clamped; a current past end still renders 100%. */
  pct: number;
  current: number | null;
  start: number | null;
  end: number | null;
  /** Raw wsrep_ist_receive_status text, when the server reports one. */
  statusText: string | null;
}

/**
 * Determinate IST progress — PXC only (MariaDB does not document the
 * wsrep_ist_* keys; they parse to null and this returns null, so nothing
 * renders). The seqno triple gives exact progress; otherwise the percentage
 * is parsed out of the free-text wsrep_ist_receive_status. Blank (idle),
 * partial keys and unparseable text all yield null.
 */
export function istProgress(s: GaleraStatus): IstProgress | null {
  const start = s.istReceiveSeqnoStart;
  const current = s.istReceiveSeqnoCurrent;
  const end = s.istReceiveSeqnoEnd;
  if (start !== null && current !== null && end !== null && end > start) {
    const pct = Math.min(1, Math.max(0, (current - start) / (end - start)));
    return { pct, current, start, end, statusText: s.istReceiveStatus };
  }
  if (s.istReceiveStatus !== null) {
    const m = s.istReceiveStatus.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) {
      const pct = Math.min(1, Math.max(0, Number(m[1]) / 100));
      return { pct, current: null, start: null, end: null, statusText: s.istReceiveStatus };
    }
  }
  return null;
}

/** One poll's seqno reading for the burn-rate estimator. */
export interface SeqnoSample {
  tsMs: number;
  lastCommitted: number;
}

export interface GcacheWindow {
  /** Seqnos still covered by the gcache: last_committed − cached_downto. */
  windowSeqnos: number | null;
  /** Cluster write rate in seqnos/s, from the view's own poll samples. */
  burnPerSec: number | null;
  /**
   * windowSeqnos / burnPerSec — how long a stopped node can stay down before
   * its rejoin needs a full SST instead of IST. null when the cluster is
   * idle (burn 0 → effectively unbounded) or the rate is unknown.
   */
  timeToSstMs: number | null;
  /** gcache.size out of wsrep_provider_options, humanized (display only). */
  gcacheSizeText: string | null;
}

/**
 * IST-window estimator. The window comes from the snapshot; the burn rate
 * comes from the view's last minutes of poll samples (needs ≥2). A
 * decreasing counter (server restart) discards the earlier samples rather
 * than producing a negative rate.
 */
export function gcacheWindow(s: GaleraStatus, samples: SeqnoSample[]): GcacheWindow {
  const windowSeqnos = s.lastCommitted !== null && s.localCachedDownto !== null
    ? Math.max(0, s.lastCommitted - s.localCachedDownto)
    : null;
  const burnPerSec = seqnoBurnRate(samples);
  const timeToSstMs = burnPerSec !== null && burnPerSec > 0 && windowSeqnos !== null
    ? (windowSeqnos / burnPerSec) * 1000
    : null;
  return { windowSeqnos, burnPerSec, timeToSstMs, gcacheSizeText: gcacheSizeText(s.providerOptions) };
}

/** Mean seqno rate over the samples; null below two usable samples. */
function seqnoBurnRate(samples: SeqnoSample[]): number | null {
  if (samples.length < 2) return null;
  let dseq = 0;
  let dms = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].tsMs - samples[i - 1].tsMs;
    const ds = samples[i].lastCommitted - samples[i - 1].lastCommitted;
    if (dt <= 0) continue;
    if (ds < 0) { dseq = 0; dms = 0; continue; } // counter reset — start over
    dseq += ds;
    dms += dt;
  }
  if (dms <= 0) return null;
  return dseq / (dms / 1000);
}

/**
 * gcache.size out of wsrep_provider_options ("k=v; k=v; …"), humanized
 * (`1.0 GB`). An unparseable value comes back verbatim; a missing key (or
 * missing options string) is null. gcache.size is NOT dynamic — display only.
 */
export function gcacheSizeText(opts: string | null): string | null {
  if (!opts) return null;
  for (const part of opts.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() === 'gcache.size') {
      const raw = part.slice(eq + 1).trim();
      if (!raw) return null;
      const bytes = parseSizeBytes(raw);
      return bytes !== null ? fmtBytes(bytes) : raw;
    }
  }
  return null;
}

/** `128M` / `1G` / plain bytes → bytes; null when not a size literal. */
function parseSizeBytes(v: string): number | null {
  const m = v.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i);
  if (!m) return null;
  const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Number(m[1]) * mult[m[2].toUpperCase()];
}

/** `42 s` / `12 min 5 s` / `3 h 40 min` — elapsed and window durations. */
export function fmtElapsed(ms: number): string {
  const v = Math.max(0, Math.round(ms / 1000));
  if (v < 60) return `${v} s`;
  const m = Math.floor(v / 60);
  if (m < 60) {
    const s = v % 60;
    return s === 0 ? `${m} min` : `${m} min ${s} s`;
  }
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h} h` : `${h} h ${mm} min`;
}

/** `1.5 GB` / `312 KB` / `640 B`; null (key absent) renders as an em dash. */
export function fmtBytes(n: number | null): string {
  if (n === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const text = u === 0 ? String(Math.round(v)) : v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return `${text} ${units[u]}`;
}

/** `12.3%` from a 0..1 ratio; null renders as an em dash. */
export function fmtPct(ratio: number | null): string {
  if (ratio === null) return '—';
  const p = ratio * 100;
  return `${p >= 10 ? Math.round(p * 10) / 10 : Math.round(p * 100) / 100}%`;
}

// ── Transition events (incident-timeline feed) ──────────────────────────────

/**
 * One Galera transition worth persisting, as the dashboard's poll diff
 * produces it. `record_galera_event` stores these verbatim (snake_case on the
 * wire); the incident timeline renders `summary` as the row title.
 */
export interface NewGaleraEvent {
  /** 'local_state' | 'cluster_size' | 'flow_control' | 'cluster_view'. */
  eventType: string;
  /** One-line human summary — the timeline row title. */
  summary: string;
  /** Optional context (cluster/node names); '' when nothing adds value. */
  detail: string;
  /** false = incident (left Synced, member lost, FC rising) — the timeline
   *  paints it red; true = recovery or neutral observation. */
  ok: boolean;
}

/** Where a node sits, for the "where it went" half of a state summary. */
function whereabouts(s: GaleraStatus): string {
  return [s.clusterName ? `cluster ${s.clusterName}` : '', s.nodeName ? `node ${s.nodeName}` : '']
    .filter(Boolean).join(' · ');
}

/** The Donor/Desynced half of a state-change summary, cause-disambiguated. */
function donorSummary(from: string, s: GaleraStatus): string {
  const cause = statusOn(s.desync) ? 'manual desync'
    : s.desync !== null ? 'donating SST'
    : 'donating SST or manually desynced';
  return from === 'Synced'
    ? `Node left Synced → Donor/Desynced (${cause})`
    : `Local state ${from} → Donor/Desynced (${cause})`;
}

/**
 * Diff two consecutive poll snapshots into timeline events. TRANSITIONS ONLY:
 * a steady state emits nothing, and the first poll (`prev` null) only
 * establishes the baseline — otherwise opening the tab on a mid-SST donor
 * would file an event for a transfer nobody saw start.
 *
 * Rules:
 * - local state changed → one event; leaving Synced (or landing anywhere
 *   non-Synced) is an incident, arriving at Synced is the recovery. A donor
 *   state is cause-disambiguated (manual desync vs donated SST) the same way
 *   transferState() does.
 * - cluster size changed → one event; shrinking is the incident (a member
 *   left), growing is the rejoin.
 * - flow-control paused ratio crossed FC_WARN / FC_CRIT → one event for the
 *   HIGHEST threshold crossed, in either direction (rising = incident,
 *   falling back = recovery). Both-null ratios skip the rule entirely.
 * - cluster_state_uuid changed → one CRIT-adjacent event: on a same-named
 *   cluster a new state UUID means a partition/re-bootstrap — the
 *   split-brain signal this node can see. A conf_id bump WITHOUT a size or
 *   uuid change is reported too (informational); a routine join/leave bumps
 *   conf_id together with the size, and that change is already the
 *   cluster_size event — reporting both would double-count one incident.
 */
export function galeraEventsFromTransition(
  prev: GaleraStatus | null, cur: GaleraStatus,
): NewGaleraEvent[] {
  if (!prev || !cur.detected) return [];
  const out: NewGaleraEvent[] = [];
  const where = whereabouts(cur);

  if (prev.localStateComment !== null && cur.localStateComment !== null
      && prev.localStateComment !== cur.localStateComment) {
    const from = prev.localStateComment;
    const to = cur.localStateComment;
    const ok = to === 'Synced';
    let summary: string;
    if (isDonorState(to)) {
      summary = donorSummary(from, cur);
    } else if (to === 'Synced' && isDonorState(from)) {
      summary = 'Donation/desync finished — node back to Synced';
    } else if (to === 'Synced' && from === 'Joined') {
      summary = 'Node caught up — Joined → Synced';
    } else {
      summary = `Local state ${from} → ${to}`;
    }
    out.push({ eventType: 'local_state', summary, detail: where, ok });
  }

  if (prev.clusterSize !== null && cur.clusterSize !== null
      && prev.clusterSize !== cur.clusterSize) {
    const grew = cur.clusterSize > prev.clusterSize;
    out.push({
      eventType: 'cluster_size',
      summary: `Cluster size ${prev.clusterSize} → ${cur.clusterSize} — ` +
        (grew ? 'a member (re)joined' : 'a member left'),
      detail: where,
      ok: grew,
    });
  }

  const pfc = prev.flowControlPaused;
  const cfc = cur.flowControlPaused;
  if (pfc !== null && cfc !== null && pfc !== cfc) {
    // One event for the highest threshold crossed, whichever direction.
    for (const [th, name] of [[FC_CRIT, 'critical'], [FC_WARN, 'warning']] as const) {
      if (pfc <= th && cfc > th) {
        out.push({
          eventType: 'flow_control',
          summary: `Flow control rose above the ${name} threshold (${fmtPct(pfc)} → ${fmtPct(cfc)} paused)`,
          detail: where, ok: false,
        });
        break;
      }
      if (pfc > th && cfc <= th) {
        out.push({
          eventType: 'flow_control',
          summary: `Flow control fell back below the ${name} threshold (${fmtPct(pfc)} → ${fmtPct(cfc)} paused)`,
          detail: where, ok: true,
        });
        break;
      }
    }
  }

  if (prev.clusterStateUuid !== null && cur.clusterStateUuid !== null
      && prev.clusterStateUuid !== cur.clusterStateUuid) {
    out.push({
      eventType: 'cluster_view',
      summary: 'Cluster state UUID changed — partition or re-bootstrap (check for split-brain)',
      detail: where, ok: false,
    });
  } else if (prev.clusterConfId !== null && cur.clusterConfId !== null
      && prev.clusterConfId !== cur.clusterConfId
      && prev.clusterSize === cur.clusterSize) {
    out.push({
      eventType: 'cluster_view',
      summary: `Cluster view changed without a membership change (conf_id ${prev.clusterConfId} → ${cur.clusterConfId})`,
      detail: where, ok: true,
    });
  }

  return out;
}

// ── WSREP_INFO membership (optional plugin) ─────────────────────────────────

/**
 * Column order for the WSREP_INFO membership table: identity first
 * (name/uuid), then segment and address, the rest in the order the server
 * returned. Matching is case-insensitive and prefix-tolerant
 * ('node_incoming_addr' counts as an address). Unknown column sets come back
 * untouched — the plugin's schema is the truth, not this list.
 */
export function orderMembershipColumns(cols: string[]): string[] {
  const rank = (c: string): number => {
    const k = c.toLowerCase();
    if (k === 'node_name' || k === 'name') return 0;
    if (k === 'node_uuid' || k === 'uuid') return 1;
    if (k === 'segment') return 2;
    if (k.includes('addr') || k.includes('address')) return 3;
    return 4;
  };
  return [...cols].sort((a, b) => rank(a) - rank(b));
}
