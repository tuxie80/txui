/**
 * ❖ Galera cluster — ALL nodes of a cluster monitored at once.
 *
 * Cross-connection by nature, so it is modelled on the Fleet panel rather
 * than a session panel: it picks SAVED connections (the current session's
 * folder-mates pre-selected — "the 3 nodes are already a folder" is the
 * common case), not the session it happens to be open in. Registration is
 * the standard PANEL_META path with the session ctx ignored for polling and
 * used only for the pre-selection (see QueryTabs PANEL_META `cluster`).
 *
 * Each poll is one `galera_cluster_poll` invoke: the backend opens an
 * ephemeral session per node (multi_exec machinery, concurrency-capped,
 * per-node timeout), runs the two read-only wsrep SHOWs and streams back raw
 * rows. EVERYTHING interpretive is pure and tested: utils/galeraCluster.ts
 * (merge → node summaries + cluster findings) on top of
 * utils/galeraStatus.ts (per-node parsing, transfer/IST/gcache derivations).
 *
 * Poll cadence is 5 s via usePoll (hidden tab = no traffic, pause-able);
 * previous snapshots, state clocks and burn-rate samples live in memory only
 * — nothing persists. Read-only by construction: the only writes anywhere
 * are the drill-in opening a session.
 *
 * The "⇄ Spot-check table…" action is the write-free exception to monitoring:
 * `galera_consistency_check` checksums ONE table on every selected node
 * (builder-generated read-only SQL, PK-ordered sample or confirmed full
 * table); the verdict math is the pure utils/galeraConsistency.ts.
 *
 * AD-HOC ("Monitor once") nodes: the Galera tab's discovery banner parks
 * id-preserving config clones in store/galeraAdhoc; this panel reads that
 * store on EVERY poll (cheap, and it makes a banner click land even when the
 * panel was already mounted) and ships the configs as `adhocConfigs` — the
 * backend polls them through the same per-node path but never saves them.
 * They merge as ordinary Node events (findings, split-brain, rates all apply)
 * under a synthetic-but-stable per-member connection_id, so they never
 * collide with the seed's own node. A slim notice bar says how many unsaved
 * nodes ride along and offers "Save all as connections" (the same adopt
 * command the banner uses) or × to drop them — greyed-and-explained, never
 * hidden.
 *
 * ANALYTICS BUNDLE — four readings of the same poll data, all math pure:
 *  - #8 ghosts (utils/galeraGhosts.ts): an incoming address no polled config
 *    covers, persistent across polls + the cluster-size identity → a greyed
 *    "likely garbd" ghost card (arbitrators are quiet by design; only an
 *    unknown member earns an info finding);
 *  - #3 conflicts (utils/galeraConflicts.ts): cert-failure and bf-abort
 *    RATES vs the previous poll + consecutive-poll streaks → per-node card
 *    stat, multi-writer hotspot and conflict-victim warnings;
 *  - #4 write sources (utils/galeraWriteSources.ts): wsrep_replicated deltas
 *    → each node's share of originated writes on its card, single-writer
 *    info and the multi-writer-with-conflicts warning;
 *  - #6 quorum (utils/galeraQuorum.ts): loss tolerance as a header line
 *    ("3 nodes — survives losing 1"), even-size and two-node warnings — a
 *    garbd's vote counts, so 2 nodes + garbd (size 3) correctly does NOT
 *    warn.
 *
 * #2 CLUSTER-WIDE PROCESSLIST: the "▦ Processes" toolbar toggle swaps the
 * main area to a merged "what is every node executing right now" table
 * (`galera_cluster_processlist` — the same fan-out, `SHOW FULL PROCESSLIST`
 * per node). While it is active the cluster poll pauses (one poll at a
 * time; clocks/baselines keep their last values). All interpretation is
 * utils/galeraProcesslist.ts: column-BY-NAME parsing (version-dependent
 * order), wsrep applier/rollbacker classification, cross-node query
 * grouping (the probe's own statement excluded — it would always group),
 * and the PROCESS-privilege heuristic (0 appliers on every answering node
 * → the GRANT hint bar, never a silently empty table). USER rows carry a
 * per-row Kill: `galera_cluster_kill` routes KILL/KILL QUERY to the row's
 * OWN node (thread ids are node-local) over a short-lived session opened
 * from the node's whole config (saved or ad-hoc — the step-② address join),
 * through the factored `kill_processes` body, and is logged + audited like
 * the Processes panel (utils/killExec.ts's pieces). Applier/rollbacker/
 * system rows never get the button (`killableRow`) — killing one breaks
 * replication; a prod-environment node demands the thread id typed first.
 *
 * PER-NODE SERVER-LOG TAIL: a node mid SST/IST offers "⌁ Watch log" on its
 * transfer card (SSH-configured configs only, greyed with the reason
 * otherwise — the tail rides SSH). `galera_cluster_sst_tail` opens an
 * ephemeral session for the node's config WHOLE (saved or ad-hoc — the
 * ad-hoc clone carries the seed's SSH fields and id, so secrets resolve),
 * discovers the error-log path over SQL and streams `tail -n 200 -F` over
 * the connection's own SSH settings — the per-session Galera tab's v5 tail
 * with a config-driven entry point instead of a live session_id. The card
 * turns DETERMINATE the moment the log carries a percentage
 * (utils/galeraSstLog.ts parsing, same as the per-session tab). Tails
 * auto-stop when the transfer resolves, the node leaves the poll/selection,
 * the process view takes over, or the panel unmounts; ■ Stop rides the
 * generic `cancel_watched` oneshot. A mid-SST joiner that refuses TCP gets
 * the connect error inline as the terminal event — never a hang.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import type { ConnectionConfig } from '../types';
import { ConnectionsStore } from '../store/connections';
import { clearGaleraAdhoc, getGaleraAdhoc } from '../store/galeraAdhoc';
import { usePoll } from '../hooks/usePoll';
import { errorDisplay } from '../utils/appError';
import {
  mergeCluster, trackStateSince, trackPairSince, sortFindings,
  type NodeSnapshot, type NodeSummary, type ClusterView, type StateSince,
} from '../utils/galeraCluster';
import {
  gcacheWindow, isDonorState, parseGaleraStatus, fmtBytes, fmtPct, fmtElapsed,
  type SeqnoSample,
} from '../utils/galeraStatus';
import { scanGhosts, ghostFindings, ghostCardTip, type GhostMember } from '../utils/galeraGhosts';
import {
  conflictRates, trackConflictStreaks, conflictFindings, formatConflictStat,
  CONFLICT_MIN_STREAK, type ConflictRates, type ConflictStreak,
} from '../utils/galeraConflicts';
import {
  writeSources, writeSourceFindings, formatWriteShare, type WriteShare,
} from '../utils/galeraWriteSources';
import {
  rankWriteTargets, recommendedWriter, writeRoutingFinding, type WriteTarget,
} from '../utils/galeraWriteRouting';
import { quorumSummary, quorumFinding } from '../utils/galeraQuorum';
import { normalizeHostPort, splitHostPort } from '../utils/galeraDiscover';
import {
  parseSstLogLine, summarizeSstLog,
  type SstLogSignal, type SstLogSummary,
} from '../utils/galeraSstLog';
import {
  buildProcessTable, groupHeader, timeLevel, normalizeInfo, killableRow,
  type ProcessTableModel, type NodeProcessResult, type ProcessRow,
} from '../utils/galeraProcesslist';
import { PREFS, usePreference } from '../store/preferences';
import { addLog } from '../store/logStore';
import { isoNow, logAudit } from '../utils/audit';
import { killLogLine, type KillMode } from '../utils/killAnalyze';
import { partialProc, type KillOutcome } from '../utils/killExec';
import {
  watchIdFor, watchNameFor, WATCH_INTERVAL_CHOICES, WATCH_INTERVAL_DEFAULT_SECS,
} from '../utils/galeraWatch';
import {
  parseTableRef, compareConsistency, formatConsistencyReport,
  SAMPLE_SIZE_OPTIONS, SAMPLE_SIZE_DEFAULT, MISMATCH_ADVICE,
  type CheckMode, type ConsistencyNodeResult, type ConsistencyVerdict,
} from '../utils/galeraConsistency';
import {
  disableWatch, enableWatch, isWatchActive, setWatchInterval, useGaleraWatches,
} from '../store/galeraWatch';

interface Props {
  /** The session the panel tab is open in — used only to pre-select nodes. */
  currentConnectionId?: string;
  /** The same session's id — the cluster kill's log/audit lines land in its
   *  📓 Log, attributed to the row's node by name. */
  sessionId?: string;
  onClose: () => void;
}

type GaleraNodeEvent =
  | { type: 'node'; connection_id: string; connection_name: string; ok: boolean;
      error: string | null; status_rows: [string, string][]; variable_rows: [string, string][];
      elapsed_ms: number }
  | { type: 'done'; nodes: number; ok_count: number; total_ms: number };

type ConsistencyEvent =
  | { type: 'node'; connection_id: string; connection_name: string; ok: boolean;
      error: string | null; row_estimate: number | null; sampled_rows: number;
      checksum_text: string | null; pk_columns: string[]; elapsed_ms: number }
  | { type: 'done'; nodes: number; ok_count: number; total_ms: number };

type GaleraProcessEvent =
  | { type: 'node'; connection_id: string; connection_name: string; ok: boolean;
      error: string | null; columns: string[]; rows: string[][]; elapsed_ms: number }
  | { type: 'done'; nodes: number; ok_count: number; total_ms: number };

/** Wire shape of `galera_cluster_sst_tail`'s Channel — mirrors SstLogEvent in
 *  src-tauri/src/commands/galera.rs. */
type SstLogEvent =
  | { type: 'started'; path: string }
  | { type: 'line'; line: string }
  | { type: 'note'; message: string }
  | { type: 'ended'; reason: string };

/** One node's running log tail: raw recent lines for the mini view, the
 *  parsed signal window (capped — summarizeSstLog re-folds it per line) and
 *  the folded summary the card renders from. The same 6-field shape
 *  GaleraClusterView's LogWatchState uses (extracting it into a shared module
 *  is a deliberately deferred follow-up). */
interface LogWatchState {
  path: string | null;
  signals: SstLogSignal[];
  summary: SstLogSummary | null;
  recent: string[];
  notes: string[];
  /** Set by the terminal `ended` event or a rejected invoke. */
  ended: string | null;
}

/** Cap on retained signals — an SST can print for minutes at 5 lines/s. */
const LOGWATCH_KEEP = 500;

/** Info cell: the table shows one line, the full text rides the title. */
const infoCell = (info: string) => {
  const oneLine = normalizeInfo(info);
  return oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine;
};

/** One process row's cells — shared by the singles list and the system
 *  collapsible (which passes no `kill`: system threads are never killable,
 *  so the action cell stays empty there). */
function ProcessCells({ r, kill }: { r: ProcessRow; kill?: ReactNode }) {
  return (
    <>
      <td>{r.nodeName}</td>
      <td>{r.user}</td>
      <td className="galc-host">{r.host}</td>
      <td>{r.db}</td>
      <td>{r.command}</td>
      <td className={timeLevel(r.timeS) === 'warn' ? 'galc-bad' : ''}>{r.timeS ?? '—'}</td>
      <td>{r.state}</td>
      <td className="galc-proc-info" title={r.info || undefined}>{infoCell(r.info)}</td>
      <td className="galc-proc-act">{kill}</td>
    </>
  );
}

/** Badge text + class for a node's local state (down/non-Galera included). */
function stateBadge(n: NodeSummary): { text: string; cls: string } {
  if (!n.reachable) return { text: 'unreachable', cls: 'down' };
  if (!n.detected) return { text: 'no wsrep', cls: 'down' };
  const s = n.localState;
  if (s === 'Synced') return { text: 'Synced', cls: 'synced' };
  if (s !== null && isDonorState(s)) return { text: 'Donor', cls: 'donor' };
  if (s === 'Joining') return { text: 'Joining', cls: 'joining' };
  if (s === 'Joined') return { text: 'Joined', cls: 'joined' };
  return { text: s ?? '—', cls: 'down' };
}

const rateText = (v: number | null, unit: string) =>
  v === null ? '—' : `${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)}${unit}`;

export function GaleraClusterPanel({ currentConnectionId, sessionId, onClose }: Props) {
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [pickerOpen, setPickerOpen] = useState(true);
  const [watchOpen, setWatchOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [view, setView] = useState<ClusterView | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // Unsaved "Monitor once" nodes riding along (store/galeraAdhoc). The state
  // copy drives the notice bar; the poll re-reads the store fresh every tick
  // so a banner click lands even when this panel was already mounted.
  const [adhocConfigs, setAdhocConfigs] = useState<ConnectionConfig[]>(() => getGaleraAdhoc());
  const [adhocBusy, setAdhocBusy] = useState(false);
  const [adhocError, setAdhocError] = useState<string | null>(null);

  // ── Analytics bundle (ghosts #8, conflicts #3, write sources #4, quorum
  // #6) — all derived from the SAME poll data, all math in pure utils; the
  // refs are the consecutive-poll trackers (the stateSinceRef pattern). ──────
  const ghostPollsRef = useRef<Record<string, number>>({});
  const conflictStreaksRef = useRef<Record<string, ConflictStreak>>({});
  const [ghosts, setGhosts] = useState<GhostMember[]>([]);
  const [conflictRatesMap, setConflictRatesMap] = useState<Map<string, ConflictRates>>(new Map());
  const [writeShares, setWriteShares] = useState<Map<string, WriteShare>>(new Map());
  // #5 write routing: the ranked write-suitability list from the same poll
  // data (utils/galeraWriteRouting.ts) — badges the recommended node's card,
  // feeds the findings strip, targets the "✎ Open writer" button.
  const [writeRouting, setWriteRouting] = useState<WriteTarget[]>([]);
  const [quorum, setQuorum] = useState<{ size: number; arbitrators: number } | null>(null);

  // ── #2 cluster-wide processlist ───────────────────────────────────────────
  // A toolbar toggle swaps the main area between the node grid and the merged
  // process view. While the process view is active the CLUSTER poll pauses
  // (one poll at a time per panel): the state clocks, rate baselines and
  // seqno samples simply keep their last values — the SST elapsed math
  // tolerates the gap exactly the way it tolerates a failed poll.
  const [procView, setProcView] = useState(false);
  const [procModel, setProcModel] = useState<ProcessTableModel | null>(null);
  const [procError, setProcError] = useState<string | null>(null);
  const [procUpdatedAt, setProcUpdatedAt] = useState<Date | null>(null);
  /** Nodes whose system-threads collapsible is open, by connectionId. */
  const [systemOpen, setSystemOpen] = useState<Set<string>>(new Set());
  const procResultsRef = useRef<Map<string, NodeProcessResult>>(new Map());

  // ── Per-row kill from the process view ────────────────────────────────────
  // Settings → Safety → Interactive kill off greys every row's button
  // ("monitor only", parity with the per-session Processes panel).
  const [interactiveKill] = usePreference(PREFS.interactiveKill);
  /** The row + resolved config whose inline confirm strip is open. */
  const [killTarget, setKillTarget] = useState<{ row: ProcessRow; config: ConnectionConfig } | null>(null);
  /** The prod typed-confirmation text (type the thread id — the EVICT pattern). */
  const [killConfirm, setKillConfirm] = useState('');
  const [killBusy, setKillBusy] = useState(false);
  /** A failed outcome renders inline in the strip — never hidden. */
  const [killError, setKillError] = useState<string | null>(null);

  // ── SST/IST server-log tails (per node, over the node's own SSH config) ──
  // The transfer card's "⌁ Watch log" runs `galera_cluster_sst_tail`: the
  // config goes over WHOLE (saved node → its entry in `conns`; ad-hoc node →
  // the getGaleraAdhoc() clone, which carries the seed's SSH fields and id —
  // the id is what makes the SSH password resolve), so the backend never
  // touches state.configs and ad-hoc nodes tail like saved ones. One tail per
  // node; several may run in parallel (a transfer involves ≤2 nodes, each an
  // independent ssh child). The run keys live in a ref because the streaming
  // Channel callback must cancel without racing a render.
  const [tails, setTails] = useState<Map<string, LogWatchState>>(new Map());
  const tailKeysRef = useRef<Map<string, string>>(new Map());

  // Poll-round state, kept across ticks: raw snapshots (also the next round's
  // rate baseline), state/pair clocks (the SST elapsed math) and per-node
  // seqno samples feeding each card's gcache window. In-memory only. The
  // state copies exist for render; the refs mirror them so the streaming
  // Channel callback can compute without racing a render.
  const snapsRef = useRef<NodeSnapshot[]>([]);
  const [snaps, setSnaps] = useState<NodeSnapshot[]>([]);
  const stateSinceRef = useRef<Record<string, StateSince>>({});
  const pairSinceRef = useRef<Record<string, number>>({});
  const samplesRef = useRef<Map<string, SeqnoSample[]>>(new Map());
  const [samples, setSamples] = useState<Map<string, SeqnoSample[]>>(new Map());
  const mountedRef = useRef(true);
  // StrictMode (dev) runs setup → cleanup → setup on the SAME instance: the
  // cleanup would leave the flag false forever, silently killing every Channel
  // handler — so the setup must set it back, not just the initial useRef.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    ConnectionsStore.list().then(setConns).catch(() => {});
  }, []);

  const mysqlConns = useMemo(() => conns.filter(c => c.engine === 'mysql'), [conns]);

  // Default selection, derived rather than stored: the current connection's
  // folder-mates, or the current connection alone when it has no folder ("the
  // 3 nodes are already a folder" is the common case). The user's first click
  // replaces it with an explicit set — an effect writing one into the other
  // would just add a render and a chance for them to disagree.
  const defaultSelected = useMemo(() => {
    const cur = conns.find(c => c.id === currentConnectionId);
    const mates = cur?.group
      ? mysqlConns.filter(c => c.group === cur.group)
      : mysqlConns.filter(c => c.id === currentConnectionId);
    return new Set(mates.map(c => c.id));
  }, [conns, mysqlConns, currentConnectionId]);
  const effectiveSelected = selected ?? defaultSelected;

  // #5 write routing derived: the panel-wide recommendation (badges the
  // card, feeds the findings strip) — and the Open-writer button's target,
  // restricted to SAVED connections (an ad-hoc "Monitor once" node ranks and
  // can badge, but has no saved connection to open).
  const writeRec = useMemo(() => recommendedWriter(writeRouting), [writeRouting]);
  const openTarget = useMemo(
    () => recommendedWriter(writeRouting.filter(t => effectiveSelected.has(t.connectionId))),
    [writeRouting, effectiveSelected]);

  // The background watch bound to the CURRENT selection (the watch's identity
  // is its node set — see watchIdFor). Changing the selection points the
  // toggle at a different watch; an enabled watch keeps its own node list.
  const watchIds = useMemo(() => [...effectiveSelected], [effectiveSelected]);
  const watches = useGaleraWatches();   // re-render on any watch change
  const watchId = watchIds.length > 0 ? watchIdFor(watchIds) : null;
  // A config exists iff the watch is on (disable removes it) — and the loop
  // should be running for it (isWatchActive is the truth the UI reflects).
  const watchCfg = watchId !== null ? (watches.find(w => w.id === watchId) ?? null) : null;
  const activeWatch = watchCfg !== null && isWatchActive(watchCfg.id) ? watchCfg : null;
  const [watchSecs, setWatchSecs] = useState(WATCH_INTERVAL_DEFAULT_SECS);
  const effectiveWatchSecs = activeWatch?.intervalSecs ?? watchSecs;

  // ── Consistency spot-check state. The dialog's table input follows the
  // same derived-default pattern as the node selection: null = untouched, so
  // the current connection's default database prefill shows through.
  const [ccOpen, setCcOpen] = useState(false);
  const [ccTable, setCcTable] = useState<string | null>(null);
  const [ccSize, setCcSize] = useState<number>(SAMPLE_SIZE_DEFAULT);
  const [ccMode, setCcMode] = useState<CheckMode>('sample');
  const [ccFullAck, setCcFullAck] = useState(false);
  const [ccRunning, setCcRunning] = useState(false);
  const [ccError, setCcError] = useState<string | null>(null);
  const [ccResults, setCcResults] = useState<Map<string, ConsistencyNodeResult>>(new Map());
  const [ccVerdict, setCcVerdict] = useState<ConsistencyVerdict | null>(null);
  const ccDefaultDb = useMemo(
    () => conns.find(c => c.id === currentConnectionId)?.database ?? null,
    [conns, currentConnectionId]);
  const ccTableValue = ccTable ?? (ccDefaultDb ? `${ccDefaultDb}.` : '');

  const runSpotCheck = useCallback(async () => {
    if (ccRunning) return;
    if (effectiveSelected.size === 0) { setCcError('pick at least one node above'); return; }
    const ref = parseTableRef(ccTableValue, ccDefaultDb);
    if ('error' in ref) { setCcError(ref.error); return; }
    if (ccMode === 'full' && !ccFullAck) {
      setCcError('full-table mode reads every row on every node — tick the confirmation box first');
      return;
    }
    setCcRunning(true);
    setCcError(null);
    setCcVerdict(null);
    const results = new Map<string, ConsistencyNodeResult>();
    setCcResults(new Map(results));
    const chan = new Channel<ConsistencyEvent>();
    chan.onmessage = ev => {
      if (!mountedRef.current) return;
      if (ev.type === 'node') {
        results.set(ev.connection_id, {
          connectionId: ev.connection_id,
          connectionName: ev.connection_name,
          ok: ev.ok,
          error: ev.error,
          rowEstimate: ev.row_estimate,
          sampledRows: ev.sampled_rows,
          checksumText: ev.checksum_text,
          pkColumns: ev.pk_columns,
          elapsedMs: ev.elapsed_ms,
        });
        setCcResults(new Map(results));
      } else {
        setCcVerdict(compareConsistency([...results.values()]));
        setCcRunning(false);
      }
    };
    try {
      await invoke('galera_consistency_check', {
        connectionIds: [...effectiveSelected],
        schema: ref.schema,
        table: ref.table,
        sampleLimit: ccSize,
        mode: ccMode,
        onEvent: chan,
      });
    } catch (e) {
      if (mountedRef.current) {
        setCcError(errorDisplay(e));
        setCcRunning(false);
      }
    }
  }, [ccRunning, effectiveSelected, ccTableValue, ccDefaultDb, ccMode, ccFullAck, ccSize]);

  const toggleWatch = useCallback(() => {
    if (watchId === null) return;
    if (activeWatch) {
      disableWatch(watchId);
    } else {
      enableWatch(watchNameFor(conns, watchIds), watchIds, watchSecs);
    }
  }, [watchId, activeWatch, conns, watchIds, watchSecs]);

  const groups = useMemo(() => {
    const map = new Map<string, ConnectionConfig[]>();
    for (const c of mysqlConns) {
      const g = c.group ?? '';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(c);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [mysqlConns]);

  /** The config a node's log tail would run with: the saved connection, or —
   *  for an ad-hoc "Monitor once" node, whose event id is synthetic — the
   *  ad-hoc clone matched by the node's own `wsrep_node_address` (variable
   *  rows ride every poll snapshot) against the canonical host:port form. */
  const tailConfigFor = useCallback((n: NodeSummary): ConnectionConfig | null => {
    const saved = conns.find(c => c.id === n.connectionId);
    if (saved) return saved;
    const raw = snapsRef.current.find(x => x.connectionId === n.connectionId);
    const addr = raw?.variableRows.find(r => r[0] === 'wsrep_node_address')?.[1];
    const hp = addr ? splitHostPort(addr) : null;
    if (!hp) return null;
    return getGaleraAdhoc().find(c =>
      !!c.host && normalizeHostPort(c.host, c.port ?? null) === normalizeHostPort(hp.host, hp.port)) ?? null;
  }, [conns]);

  /** The config a process row's Kill would run against: the saved connection,
   *  or — for an ad-hoc "Monitor once" node, whose event id is synthetic —
   *  the ad-hoc clone matched by the node's own `wsrep_node_address` against
   *  the canonical host:port form — exactly the join `tailConfigFor` (⌁ Watch
   *  log) uses. The cluster poll pauses while the process view is up, but its
   *  last snapshots are kept, which is where the address comes from.
   *  Unresolvable → no Kill button (the cell stays empty). */
  const procConfigFor = useCallback((r: ProcessRow): ConnectionConfig | null => {
    const saved = conns.find(c => c.id === r.connectionId);
    if (saved) return saved;
    const raw = snapsRef.current.find(x => x.connectionId === r.connectionId);
    const addr = raw?.variableRows.find(v => v[0] === 'wsrep_node_address')?.[1];
    const hp = addr ? splitHostPort(addr) : null;
    if (!hp) return null;
    return getGaleraAdhoc().find(c =>
      !!c.host && normalizeHostPort(c.host, c.port ?? null) === normalizeHostPort(hp.host, hp.port)) ?? null;
  }, [conns]);

  /** Stop one node's tail: fire the ext-job oneshot (the backend kills the
   *  ssh child and sends the terminal event). `remove` also drops the map
   *  entry — the auto-stops use it because the card is gone anyway; a manual
   *  ■ Stop keeps the entry so the card shows the ended note. */
  const stopTail = useCallback((connectionId: string, remove = false) => {
    const k = tailKeysRef.current.get(connectionId);
    tailKeysRef.current.delete(connectionId);
    if (k) void invoke('cancel_watched', { runKey: k }).catch(() => { /* already gone */ });
    if (remove) {
      setTails(m => {
        if (!m.has(connectionId)) return m;
        const next = new Map(m);
        next.delete(connectionId);
        return next;
      });
    }
  }, []);

  const startTail = useCallback(async (n: NodeSummary) => {
    const id = n.connectionId;
    if (tailKeysRef.current.has(id)) return;   // one tail per node
    const cfg = tailConfigFor(n);
    if (!cfg || !cfg.use_ssh || !cfg.ssh_host || !cfg.ssh_user) return;  // the button's predicate
    const runKey = crypto.randomUUID();
    tailKeysRef.current.set(id, runKey);
    setTails(m => new Map(m).set(id,
      { path: null, signals: [], summary: null, recent: [], notes: [], ended: null }));
    const patch = (f: (w: LogWatchState) => LogWatchState) =>
      setTails(m => {
        const w = m.get(id);
        if (!w) return m;
        const next = new Map(m);
        next.set(id, f(w));
        return next;
      });
    const chan = new Channel<SstLogEvent>();
    chan.onmessage = ev => {
      if (ev.type === 'started') {
        patch(w => ({ ...w, path: ev.path }));
      } else if (ev.type === 'line') {
        const sig = parseSstLogLine(ev.line);
        setTails(m => {
          const w = m.get(id);
          if (!w) return m;
          const signals = sig ? [...w.signals, sig].slice(-LOGWATCH_KEEP) : w.signals;
          const next = new Map(m);
          next.set(id, {
            ...w,
            signals,
            summary: sig ? summarizeSstLog(signals) : w.summary,
            recent: [...w.recent, ev.line].slice(-8),
          });
          return next;
        });
      } else if (ev.type === 'note') {
        patch(w => ({ ...w, notes: [...w.notes, ev.message].slice(-4) }));
      } else {
        tailKeysRef.current.delete(id);
        patch(w => ({ ...w, ended: ev.reason }));
      }
    };
    try {
      // Resolves only when the stream ends; the terminal event already set
      // `ended`, so all that is left is an invoke rejected before start.
      await invoke('galera_cluster_sst_tail', { connectionConfig: cfg, runKey, onEvent: chan });
    } catch (e) {
      tailKeysRef.current.delete(id);
      patch(w => ({ ...w, ended: errorDisplay(e) }));
    }
  }, [tailConfigFor]);

  const poll = useCallback(async () => {
    const adhocNow = getGaleraAdhoc();
    setAdhocConfigs(adhocNow);   // same reference → no re-render; a banner click → notice bar
    if (effectiveSelected.size === 0 && adhocNow.length === 0) return;
    const ids = [...effectiveSelected];    const chan = new Channel<GaleraNodeEvent>();
    // The rate/share/conflict math diffs against the previous COMPLETE round.
    // Capture it before any event lands: with per-event `snapsRef` reads, the
    // second event of a round already finds the first node's FRESH snapshot in
    // "prev", so its rate diffs against itself (dt=0 → null) and the settled
    // view only ever shows rates for the last-answering node.
    const prevRound = snapsRef.current;
    chan.onmessage = ev => {
      if (!mountedRef.current || ev.type !== 'node') return;
      const snap: NodeSnapshot = {
        connectionId: ev.connection_id,
        connectionName: ev.connection_name,
        ok: ev.ok,
        error: ev.error,
        statusRows: ev.status_rows,
        variableRows: ev.variable_rows,
        elapsedMs: ev.elapsed_ms,
        polledAtMs: Date.now(),
      };
      const prev = prevRound;
      const round = [...snapsRef.current.filter(s => s.connectionId !== snap.connectionId), snap];
      // Node events stream in as each node finishes — merge incrementally so a
      // slow last node never holds the already-answered ones hostage.
      snapsRef.current = round;
      setSnaps(round);
      const nowMs = Date.now();
      const merged = mergeCluster(round, {
        nowMs,
        prev: prev,
        stateSince: stateSinceRef.current,
        pairSince: pairSinceRef.current,
      });
      stateSinceRef.current = trackStateSince(round, stateSinceRef.current, nowMs);
      pairSinceRef.current = trackPairSince(merged, pairSinceRef.current, nowMs);

      // ── Analytics bundle: conflicts, write sources, ghosts, quorum ──────
      const liveNodes = merged.nodes.filter(n => n.reachable && n.detected);
      const disp = (n: NodeSummary) => (n.nodeName ? `${n.name} (${n.nodeName})` : n.name);
      const prevById = new Map(prev.map(p => [p.connectionId, p]));

      // #3 certification conflicts: rates vs the previous poll + streaks.
      const cRates = new Map<string, ConflictRates>();
      for (const s of round) cRates.set(s.connectionId, conflictRates(s, prevById.get(s.connectionId)));
      conflictStreaksRef.current = trackConflictStreaks(cRates, conflictStreaksRef.current);
      setConflictRatesMap(new Map(cRates));

      // #4 write-source distribution: originated-writes shares.
      const shares = writeSources(round, prev);
      setWriteShares(new Map(shares));

      // #5 write routing: which node writes SHOULD go to — the same summaries
      // + shares ranked, the recommendation named in the findings strip.
      const routing = rankWriteTargets(
        liveNodes.map(n => ({ connectionId: n.connectionId, display: disp(n), summary: n })),
        shares);
      setWriteRouting(routing);

      // #8 ghosts: an incoming address no polled config (saved OR ad-hoc)
      // covers — matched on the discovery module's canonical host:port.
      const covered: string[] = [];
      for (const id of ids) {
        const c = conns.find(x => x.id === id);
        if (c?.host) covered.push(normalizeHostPort(c.host, c.port ?? null));
      }
      for (const c of adhocNow) {
        if (c.host) covered.push(normalizeHostPort(c.host, c.port ?? null));
      }
      const scan = scanGhosts(merged.nodes, covered, ghostPollsRef.current);
      ghostPollsRef.current = scan.nextPolls;
      setGhosts(scan.ghosts);

      // #6 quorum: the reported size already counts a garbd; only when no
      // node reports one is it derived as ok-nodes + ghosts.
      const reportedSizes = liveNodes.map(n => n.clusterSize).filter((s): s is number => s !== null);
      const arbCount = scan.ghosts.filter(g => g.classification === 'likely_arbitrator').length;
      const qSize = reportedSizes.length > 0
        ? Math.max(...reportedSizes)
        : liveNodes.length + scan.ghosts.length;
      setQuorum(liveNodes.length > 0 ? { size: qSize, arbitrators: arbCount } : null);

      const nodeList = liveNodes.map(n => ({ connectionId: n.connectionId, display: disp(n) }));
      const originators = liveNodes
        .filter(n => (shares.get(n.connectionId)?.ratePerSec ?? 0) > 0).map(disp);
      const certOffenders = liveNodes
        .filter(n => (conflictStreaksRef.current[n.connectionId]?.cert ?? 0) >= CONFLICT_MIN_STREAK)
        .map(disp);
      const extraFindings = [
        ...conflictFindings(nodeList, conflictStreaksRef.current, originators),
        ...writeSourceFindings(nodeList, shares, certOffenders),
        ...ghostFindings(scan.ghosts),
      ];
      const qf = liveNodes.length > 0
        ? quorumFinding(qSize, reportedSizes.length > 0 ? arbCount : 0)
        : null;
      if (qf) extraFindings.push(qf);
      const wrf = writeRoutingFinding(nodeList, shares, routing);
      if (wrf) extraFindings.push(wrf);
      merged.findings = sortFindings([...merged.findings, ...extraFindings]);

      for (const s of round) {
        if (!s.ok) continue;
        const lc = merged.nodes.find(n => n.connectionId === s.connectionId)?.lastCommitted;
        if (lc == null) continue;
        const list = samplesRef.current.get(s.connectionId) ?? [];
        samplesRef.current.set(s.connectionId,
          [...list, { tsMs: nowMs, lastCommitted: lc }].filter(x => nowMs - x.tsMs <= 5 * 60_000).slice(-60));
      }
      setSamples(new Map(samplesRef.current));
      setView(merged);
      setUpdatedAt(new Date());

      // Auto-stop log tails whose transfer resolved (this poll shows no
      // transfer/IST for the node), whose node left the poll entirely, or
      // whose SAVED node was deselected mid-tail (an ad-hoc node's synthetic
      // id is never in the selection — its absence from merged.nodes is the
      // signal there).
      for (const tid of [...tailKeysRef.current.keys()]) {
        const tn = merged.nodes.find(x => x.connectionId === tid);
        const deselectedSaved = !effectiveSelected.has(tid) && conns.some(c => c.id === tid);
        if (!tn || !(tn.transfer || tn.ist) || deselectedSaved) stopTail(tid, true);
      }
    };
    try {
      await invoke('galera_cluster_poll', { connectionIds: ids, adhocConfigs: adhocNow, onEvent: chan });
      if (mountedRef.current) setPollError(null);
    } catch (e) {
      if (mountedRef.current) setPollError(errorDisplay(e));
    }
  }, [effectiveSelected, conns, stopTail]);
  const refresh = usePoll(poll, 5, { paused: paused || procView || (effectiveSelected.size === 0 && adhocConfigs.length === 0), inFlightGraceMs: 30_000 });

  // The process poll: same 5 s cadence, same selection + ad-hoc configs, same
  // pause — but ONLY while the process view is active (and the cluster poll
  // above yields to it). Each tick is a fresh point-in-time snapshot: stale
  // rows from the previous tick would be wrong, not merely old, so the
  // results map is rebuilt per round rather than merged across rounds.
  const pollProcesses = useCallback(async () => {
    const adhocNow = getGaleraAdhoc();
    if (effectiveSelected.size === 0 && adhocNow.length === 0) return;
    const ids = [...effectiveSelected];
    procResultsRef.current = new Map();
    const chan = new Channel<GaleraProcessEvent>();
    chan.onmessage = ev => {
      if (!mountedRef.current || ev.type !== 'node') return;
      procResultsRef.current.set(ev.connection_id, {
        connectionId: ev.connection_id,
        connectionName: ev.connection_name,
        ok: ev.ok,
        error: ev.error,
        columns: ev.columns,
        rows: ev.rows,
      });
      setProcModel(buildProcessTable([...procResultsRef.current.values()]));
      setProcUpdatedAt(new Date());
    };
    try {
      await invoke('galera_cluster_processlist', {
        connectionIds: ids, adhocConfigs: adhocNow, onEvent: chan,
      });
      if (mountedRef.current) setProcError(null);
    } catch (e) {
      if (mountedRef.current) setProcError(errorDisplay(e));
    }
  }, [effectiveSelected]);
  usePoll(pollProcesses, 5, {
    paused: paused || !procView || (effectiveSelected.size === 0 && adhocConfigs.length === 0),
    inFlightGraceMs: 30_000,
  });

  /** The trailing action cell for one process row: a Kill button only when
   *  the row is a killable user thread AND its node resolves to a pollable
   *  config; greyed-and-explained (never `disabled`) when interactive kill is
   *  off or the connection is read-only; an empty cell otherwise. */
  const killCellFor = (r: ProcessRow): ReactNode => {
    if (!killableRow(r)) return null;
    const cfg = procConfigFor(r);
    if (!cfg) return null;
    const blocked = !interactiveKill
      ? 'Interactive kill is off (Settings → Safety) — monitor only'
      : cfg.read_only
        ? 'This connection is read-only — killing sessions is blocked'
        : null;
    const openConfirm = () => {
      // The handler guards with exactly the predicate the button used.
      if (blocked || killBusy) return;
      setKillConfirm('');
      setKillError(null);
      setKillTarget({ row: r, config: cfg });
    };
    if (blocked) {
      return (
        <span className="unavail" data-tip={blocked}>
          <button className="toolbar-btn proc-kill" aria-disabled="true" onClick={openConfirm}>Kill</button>
        </span>
      );
    }
    return (
      <button className="toolbar-btn proc-kill"
              title={`Kill thread ${r.id} on ${r.nodeName} — abort the query or drop the connection, audited like the Processes panel`}
              onClick={openConfirm}>
        Kill
      </button>
    );
  };

  /** Execute the armed kill: one `galera_cluster_kill` invoke, then one
   *  session-log line (killLogLine) and one audit row (logAudit) per outcome —
   *  killExec.ts's logging pieces with the row's node as the connection name.
   *  Per-thread failure is data (KillOutcome.error) and renders inline. */
  const executeClusterKill = useCallback(async (mode: KillMode) => {
    const t = killTarget;
    if (!t || killBusy) return;
    const { row, config } = t;
    // The handler guards with exactly the predicates the button used.
    if (!interactiveKill || config.read_only || !killableRow(row)) return;
    if (config.environment === 'prod' && killConfirm.trim() !== row.id) return;
    setKillBusy(true);
    setKillError(null);
    const id = Number(row.id);
    const source = 'Galera cluster processlist';
    const proc = partialProc({
      id, user: row.user, host: row.host, db: row.db,
      command: row.command, time: row.timeS ?? 0, state: row.state, info: row.info,
    });
    const started = isoNow();
    const t0 = Date.now();
    try {
      const outcomes = await invoke<KillOutcome[]>('galera_cluster_kill', {
        connectionConfig: config, id, mode,
      });
      const ended = isoNow();
      const ms = Date.now() - t0;
      for (const o of outcomes) {
        const line = killLogLine({
          id: o.id, mode, statement: o.statement, ok: o.ok, error: o.error,
          proc, agedSecs: null, source,
        });
        if (sessionId) addLog(sessionId, { level: o.ok ? 'ok' : 'err', action: 'KILL', detail: line, ms });
        logAudit({
          started_at: started, ended_at: ended, duration_ms: ms,
          connection_name: row.nodeName, db_user: row.user, engine: 'mysql',
          ok: o.ok, rows_out: 0, rows_affected: null, error: o.error, sql: line,
        }, { alsoLog: false });
      }
      const failed = outcomes.filter(o => !o.ok);
      if (failed.length === 0) {
        setKillTarget(null);
        void pollProcesses();
      } else {
        // e.g. a missing CONNECTION_ADMIN surfaces honestly (unknown-means-
        // allowed stays the privilege rule — the button was offered).
        setKillError(failed.map(o => o.error ?? 'kill failed').join(' · '));
      }
    } catch (e) {
      // The command itself failed (engine gate, read-only, connect refused) —
      // log the attempt like killExec does, then show it inline.
      const detail = `${mode === 'query' ? 'KILL QUERY' : 'KILL'} #${id} · FAILED: ${errorDisplay(e).replace(/\s+/g, ' ')} · via ${source}`;
      if (sessionId) addLog(sessionId, { level: 'err', action: 'KILL', detail });
      logAudit({
        started_at: started, ended_at: isoNow(), duration_ms: Date.now() - t0,
        connection_name: row.nodeName, db_user: row.user, engine: 'mysql',
        ok: false, rows_out: 0, rows_affected: null,
        error: errorDisplay(e), raw_error: e, sql: detail,
      }, { alsoLog: false });
      setKillError(errorDisplay(e));
    }
    setKillBusy(false);
  }, [killTarget, killBusy, killConfirm, interactiveKill, sessionId, pollProcesses]);

  // The process view takes over the poll — stop every tail with it (each is
  // an ssh child streaming for a card the user can no longer see).
  useEffect(() => {
    if (!procView) return;
    for (const id of [...tailKeysRef.current.keys()]) stopTail(id, true);
  }, [procView, stopTail]);

  // Unmount: cancel every ssh child streaming for this panel.
  useEffect(() => () => {
    for (const k of tailKeysRef.current.values()) {
      void invoke('cancel_watched', { runKey: k }).catch(() => { /* closing anyway */ });
    }
    tailKeysRef.current.clear();
  }, []);

  const toggleSystemNode = useCallback((connectionId: string) => {
    setSystemOpen(prev => {
      const next = new Set(prev);
      if (next.has(connectionId)) next.delete(connectionId); else next.add(connectionId);
      return next;
    });
  }, []);

  function toggle(id: string) {
    const next = new Set(effectiveSelected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }
  function toggleGroup(items: ConnectionConfig[]) {
    const next = new Set(effectiveSelected);
    const allIn = items.every(c => next.has(c.id));
    for (const c of items) {
      if (allIn) next.delete(c.id); else next.add(c.id);
    }
    setSelected(next);
  }

  const drillIn = useCallback((connectionId: string) => {
    window.dispatchEvent(new CustomEvent('dbgui:open-connection', { detail: { connectionId, galera: true } }));
  }, []);

  /** "✎ Open writer": a session on the recommended write target with a fresh
   *  query tab — the drill-in choke point's newTab flag (App.tsx). Guarded by
   *  the same predicate the button used (never `disabled`). */
  const openWriter = useCallback(() => {
    if (!openTarget) return;
    window.dispatchEvent(new CustomEvent('dbgui:open-connection', {
      detail: { connectionId: openTarget.connectionId, newTab: true },
    }));
  }, [openTarget]);

  // ── Ad-hoc ("Monitor once") nodes ─────────────────────────────────────────
  /** Drop snapshots whose node is no longer polled (an ad-hoc node's
   *  synthetic id is not recomputable here, so "not in keepIds" is the test)
   *  and re-merge what remains. */
  const dropNonSelectedSnaps = useCallback((keepIds: Set<string>) => {
    const round = snapsRef.current.filter(s => keepIds.has(s.connectionId));
    snapsRef.current = round;
    setSnaps(round);
    if (round.length === 0) { setView(null); return; }
    const nowMs = Date.now();
    setView(mergeCluster(round, {
      nowMs, prev: round,
      stateSince: stateSinceRef.current,
      pairSince: pairSinceRef.current,
    }));
  }, []);

  /** "Save all as connections" — the same adopt command the discovery banner
   *  runs (the ad-hoc configs carry the seed's id, which is what makes both
   *  secret resolution and this call work), then swap the nodes from unsaved
   *  polling to the freshly saved connections so monitoring continues
   *  seamlessly. */
  const saveAllAdhoc = useCallback(async () => {
    const adhoc = getGaleraAdhoc();
    const seedId = adhoc[0]?.id;
    if (!seedId || adhocBusy) return;
    setAdhocBusy(true);
    setAdhocError(null);
    try {
      const members = adhoc.map(c => ({
        host: c.host ?? 'localhost',
        port: c.port ?? 3306,
        name: c.name,
      }));
      const created = await invoke<ConnectionConfig[]>('galera_adopt_members', {
        seedId, members, group: adhoc[0].group ?? null,
      });
      clearGaleraAdhoc();
      setAdhocConfigs([]);
      window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
      const list = await ConnectionsStore.list().catch(() => null);
      if (list) setConns(list);
      const next = new Set([...effectiveSelected, ...created.map(c => c.id)]);
      setSelected(next);
      dropNonSelectedSnaps(next);
    } catch (e) {
      setAdhocError(errorDisplay(e));
    }
    setAdhocBusy(false);
  }, [adhocBusy, effectiveSelected, dropNonSelectedSnaps]);

  /** × on the notice bar: stop monitoring the unsaved nodes, back to the
   *  saved-only selection. */
  const clearAdhoc = useCallback(() => {
    clearGaleraAdhoc();
    setAdhocConfigs([]);
    setAdhocError(null);
    dropNonSelectedSnaps(new Set(effectiveSelected));
  }, [effectiveSelected, dropNonSelectedSnaps]);

  const selectedCount = effectiveSelected.size;

  return (
    <div className="galc-root">
      <div className="gal-toolbar">
        <span className="proc-title">❖ Galera cluster</span>
        <button className="toolbar-btn" onClick={() => setPickerOpen(o => !o)}>
          {pickerOpen ? '▾ Nodes' : '▸ Nodes'} ({selectedCount})
        </button>
        <button
          className={`toolbar-btn${activeWatch ? ' galc-watch-on' : ''}`}
          title={activeWatch
            ? `Background watch is ON — polling every ${activeWatch.intervalSecs}s even with this panel closed`
            : 'Watch this cluster in the background — transitions to the Incident timeline, alerts on split-brain / member loss'}
          onClick={() => setWatchOpen(o => !o)}
        >
          {watchOpen ? '▾' : '▸'} {activeWatch ? '◉ Watching' : '○ Watch'}
        </button>
        <button className="toolbar-btn" onClick={() => setPaused(p => !p)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button
          className={`toolbar-btn${procView ? ' galc-watch-on' : ''}`}
          title="Cluster-wide processlist — what every selected node is executing right now, with a per-row Kill routed to the row's own node (user threads only)"
          onClick={() => setProcView(v => !v)}
        >
          ▦ Processes
        </button>
        <button
          className="toolbar-btn"
          title="Cross-node consistency spot-check — checksum one table on every selected node and compare"
          onClick={() => setCcOpen(o => !o)}
        >
          {ccOpen ? '▾' : '▸'} ⇄ Spot-check table…
        </button>
        {openTarget ? (
          <button
            className="toolbar-btn"
            title={`Open a session on ${openTarget.display} — the recommended write target — with a fresh query tab`}
            onClick={openWriter}
          >
            ✎ Open writer
          </button>
        ) : (
          <span className="unavail"
                data-tip="No synced, healthy node in this poll — write routing needs a reachable, Synced Galera node with no active SST/IST among the selected saved connections">
            <button className="toolbar-btn" aria-disabled="true" onClick={openWriter}>✎ Open writer</button>
          </span>
        )}
        <button className="toolbar-btn" onClick={refresh} disabled={selectedCount === 0 && adhocConfigs.length === 0}>↻ Refresh</button>
        {updatedAt && (
          <span className="repl-updated" title="Last successful refresh">
            updated {updatedAt.toLocaleTimeString()}
          </span>
        )}
        <span className="proc-status" style={{ border: 'none', background: 'none' }}>
          {paused ? 'paused' : 'every 5s'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {pickerOpen && (
        <div className="galc-picker">
          {groups.map(([group, items]) => (
            <div key={group || '(no group)'} className="galc-picker-group">
              <div className="mx-group" onClick={() => toggleGroup(items)}>
                <input type="checkbox" readOnly checked={items.length > 0 && items.every(c => effectiveSelected.has(c.id))} />
                <span>{group || 'Ungrouped'}</span>
                <span className="mx-group-n">{items.length}</span>
              </div>
              {items.map(c => (
                <label key={c.id} className="mx-server">
                  <input type="checkbox" checked={effectiveSelected.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="mx-name">{c.name}</span>
                  <span className="galc-host">{c.host ?? ''}{c.port ? `:${c.port}` : ''}</span>
                </label>
              ))}
            </div>
          ))}
          {mysqlConns.length === 0 && (
            <div className="mx-empty">No MySQL/MariaDB connections saved — Galera is MySQL-family.</div>
          )}
          {mysqlConns.length > 0 && conns.some(c => c.engine !== 'mysql') && (
            <div className="galc-note">Only MySQL-family connections are listed — wsrep does not exist elsewhere.</div>
          )}
        </div>
      )}

      {watchOpen && (
        <div className="galc-picker">
          <div className="galc-watch">
            <label className="mx-server">
              <input
                type="checkbox"
                checked={activeWatch !== null}
                onChange={toggleWatch}
              />
              <span className="mx-name">Watch this cluster in the background</span>
              {activeWatch && (
                <span className="galc-host">running — every {activeWatch.intervalSecs}s</span>
              )}
            </label>
            <label className="galc-watch-interval">
              Poll every{' '}
              <select
                value={effectiveWatchSecs}
                onChange={e => {
                  const secs = Number(e.target.value);
                  setWatchSecs(secs);
                  if (activeWatch) setWatchInterval(activeWatch.id, secs);
                }}
              >
                {WATCH_INTERVAL_CHOICES.map(s => (
                  <option key={s} value={s}>{s}s</option>
                ))}
              </select>
            </label>
            <div className="galc-note">
              Keeps polling the selected nodes while the app runs, even with this panel
              closed. Transitions land on each node's Incident timeline; an OS
              notification fires only on the important ones — split-brain suspicion, a
              member leaving, a node unreachable for 3+ polls, flow control crossing
              the critical threshold, an SST starting/finishing (rate-limited, never
              one per poll). Read-only <code>SHOW</code> probes only; the watch stops
              itself if every watched connection is deleted, and the status bar's
              "⟳ running" popover shows it with a Stop button.
            </div>
            {selectedCount > 0 && !activeWatch && (
              <div className="galc-note">
                The watch binds to the nodes selected right now ({selectedCount});
                changing the selection points this toggle at a different watch.
              </div>
            )}
          </div>
        </div>
      )}

      {pollError && <div className="proc-error-bar">{pollError}</div>}

      {view && !procView && quorum && (
        <div className="galc-quorum"
             data-tip="Quorum tolerance — a strict majority of the current component must survive. A likely arbitrator (garbd) counts as a voting member; the reported cluster size already includes it.">
          ❖ {quorumSummary(quorum.size, quorum.arbitrators)}
        </div>
      )}

      {adhocConfigs.length > 0 && (
        <div className="galc-note galc-adhoc">
          <span>
            Monitoring {adhocConfigs.length} unsaved node{adhocConfigs.length === 1 ? '' : 's'}
            {' '}({adhocConfigs.map(c => c.name).join(', ')}) — cloned from the saved connection
            they were discovered on, polled for this app run only, never persisted.
          </span>
          <button className="toolbar-btn"
                  data-tip="Save every unsaved node as a real connection cloned from the same seed (passwords copied inside the secret store), then keep polling them as saved nodes"
                  disabled={adhocBusy}
                  onClick={() => { if (!adhocBusy) void saveAllAdhoc(); }}>
            {adhocBusy ? 'Saving…' : 'Save all as connections'}
          </button>
          <button className="icon-btn" title="Stop monitoring the unsaved nodes — back to the saved selection"
                  onClick={clearAdhoc}>×</button>
          {adhocError && <span className="galc-error">{adhocError}</span>}
        </div>
      )}

      {ccOpen && (
        <div className="galc-picker galc-cc">
          <div className="galc-cc-form">
            <label>
              Table
              <input
                className="galc-cc-table-in"
                value={ccTableValue}
                onChange={e => setCcTable(e.target.value)}
                placeholder="schema.table"
                spellCheck={false}
              />
            </label>
            <label>
              Sample
              <select
                value={ccMode === 'full' ? 'full' : String(ccSize)}
                onChange={e => {
                  const v = e.target.value;
                  if (v === 'full') { setCcMode('full'); }
                  else { setCcMode('sample'); setCcSize(Number(v)); }
                }}
              >
                {SAMPLE_SIZE_OPTIONS.map(o => (
                  <option key={o.value} value={String(o.value)}>{o.label}</option>
                ))}
                <option value="full">full table</option>
              </select>
            </label>
            {ccMode === 'full' && (
              <label className="galc-cc-ack">
                <input
                  type="checkbox"
                  checked={ccFullAck}
                  onChange={e => setCcFullAck(e.target.checked)}
                />
                I understand this reads the whole table on every node
              </label>
            )}
            <button className="toolbar-btn" onClick={runSpotCheck}>
              {ccRunning ? `Checking… ${ccResults.size}/${selectedCount}` : 'Run spot-check'}
            </button>
          </div>
          <div className="galc-note">
            Read-only proof that every node holds the same rows: each selected node
            computes <code>SUM(CRC32(CONCAT_WS('#', …)))</code> over the same
            PK-ordered sample (first N rows by primary key — deterministic only when the
            data is) and the checksums are compared. <code>CONCAT_WS</code> skips NULLs,
            identically on every node. A table with no primary key cannot be sampled
            deterministically — use <em>full table</em> there. Sample sizes are bounded;
            a node that fails or times out (30 s) is reported inconclusive and never
            blocks the others. The SQL is builder-generated — nothing typed here is
            executed as SQL. Works on any MySQL-family multi-node set, async replicas
            included.
          </div>
          {ccError && <div className="galc-error">{ccError}</div>}
          {ccVerdict && (
            <div className={`gal-finding gal-${ccVerdict.status === 'match' ? 'ok' : ccVerdict.status === 'mismatch' ? 'crit' : 'warn'} galc-cc-verdict`}>
              <div className="gal-finding-title">{ccVerdict.summary}</div>
              <div className="gal-finding-detail">
                {ccVerdict.status === 'mismatch' && (
                  <div className="galc-cc-advice">{MISMATCH_ADVICE}</div>
                )}
                <table className="galc-cc-grid">
                  <thead>
                    <tr><th>node</th><th>rows</th><th>checksum</th><th>elapsed</th></tr>
                  </thead>
                  <tbody>
                    {[...ccVerdict.groups.flatMap(g => g.nodes), ...ccVerdict.inconclusive].map(n => (
                      <tr key={n.connectionId} className={ccVerdict.divergent.some(d => d.connectionId === n.connectionId) ? 'galc-cc-divergent' : ''}>
                        <td>{n.connectionName}</td>
                        {n.ok && n.checksumText !== null ? (
                          <>
                            <td className="galc-cc-num">{n.sampledRows.toLocaleString()}</td>
                            <td className="galc-cc-sum">{n.checksumText}</td>
                            <td className="galc-cc-num">{n.elapsedMs} ms</td>
                          </>
                        ) : (
                          <td colSpan={3} className="galc-cc-inc">{n.error ?? 'inconclusive'}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  className="toolbar-btn galc-cc-copy"
                  onClick={() => {
                    const ref = parseTableRef(ccTableValue, ccDefaultDb);
                    const name = 'error' in ref ? ccTableValue : `${ref.schema}.${ref.table}`;
                    navigator.clipboard.writeText(
                      formatConsistencyReport(name, ccMode, ccSize, ccVerdict)).catch(() => {});
                  }}
                >
                  Copy report
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {view && !procView && view.findings.length > 0 && (
        <div className="gal-findings">
          {view.findings.map((f, i) => (
            <div key={i} className={`gal-finding gal-${f.level}`}>
              <div className="gal-finding-title">{f.title}</div>
              <div className="gal-finding-detail">{f.detail}</div>
            </div>
          ))}
        </div>
      )}

      {!procView && !view && (selectedCount > 0 || adhocConfigs.length > 0) && (
        <div className="proc-loading">Polling {selectedCount + adhocConfigs.length} node{selectedCount + adhocConfigs.length === 1 ? '' : 's'}…</div>
      )}
      {!procView && selectedCount === 0 && adhocConfigs.length === 0 && (
        <div className="gal-empty">
          <div className="gal-empty-title">Pick the cluster's nodes</div>
          <div>
            Select the saved connections that make up the cluster above — the current
            connection's folder is pre-selected, since the nodes of a cluster are
            usually already one folder. Each poll opens a short-lived session per node,
            runs <code>SHOW GLOBAL STATUS/VARIABLES LIKE 'wsrep%'</code> and closes it
            again; nothing is written anywhere.
          </div>
        </div>
      )}

      {procView && (
        <div className="galc-proc">
          {procError && <div className="proc-error-bar">{procError}</div>}
          {procModel?.hint && (
            <div className="gal-finding gal-info">
              <div className="gal-finding-title">Only the probe's own connection is visible</div>
              <div className="gal-finding-detail">{procModel.hint}</div>
            </div>
          )}
          {!procModel && !procError && (
            <div className="proc-loading">Polling processlists…</div>
          )}
          {procUpdatedAt && (
            <span className="repl-updated" title="Last successful refresh">
              updated {procUpdatedAt.toLocaleTimeString()}
            </span>
          )}
          {procModel && (
            <table className="galc-cc-grid galc-proc-grid">
              <thead>
                <tr>
                  <th>node</th><th>user</th><th>host</th><th>db</th><th>command</th>
                  <th>time</th><th>state</th><th>info</th><th></th>
                </tr>
              </thead>
              <tbody>
                {procModel.unreachable.map(u => (
                  <tr key={`un-${u.connectionId}`}>
                    <td>{u.nodeName}</td>
                    <td colSpan={8} className="galc-cc-inc">{u.error}</td>
                  </tr>
                ))}
                {procModel.groups.map(g => (
                  <tr key={`g-${g.info}`} className="galc-proc-group">
                    <td colSpan={9}>
                      <span className="galc-proc-ghead">{groupHeader(g)}</span>
                      {g.maxTimeS !== null && <span className="galc-host"> · {g.maxTimeS}s</span>}
                      <span className="galc-host">
                        {' '}({g.perNode.map(([n, c]) => `${n}${c > 1 ? ` ×${c}` : ''}`).join(', ')})
                      </span>
                      <span className="galc-proc-info" title={g.info}> — {infoCell(g.info)}</span>
                    </td>
                  </tr>
                ))}
                {procModel.singles.map((r, i) => (
                  <Fragment key={`s-${r.connectionId}-${r.id}-${i}`}>
                    <tr>
                      <ProcessCells r={r} kill={killCellFor(r)} />
                    </tr>
                    {killTarget !== null && killTarget.row.connectionId === r.connectionId
                      && killTarget.row.id === r.id && (
                      <tr className="galc-kill-confirm">
                        <td colSpan={9}>
                          {(() => {
                            const kt = killTarget;
                            // Prod: the thread id must be typed before the
                            // buttons arm (the EVICT typed-confirm precedent).
                            const isProd = kt.config.environment === 'prod';
                            const armed = !killBusy && (!isProd || killConfirm.trim() === kt.row.id);
                            return (
                              <div className="gal-op-confirm">
                                <div className="gal-op-risk">
                                  Kill thread <b>{kt.row.id}</b> on <b>{kt.row.nodeName}</b>
                                  {' '}— {kt.row.user || '?'}@{kt.row.host || '?'}
                                  {kt.row.db ? ` · db ${kt.row.db}` : ''}
                                  {kt.row.timeS !== null ? ` · ${kt.row.timeS}s in ${kt.row.command || '?'}` : ''}
                                  {isProd && <span className="galc-bad"> · prod connection</span>}
                                  {kt.row.info && (
                                    <div className="galc-proc-info" title={kt.row.info}>
                                      {infoCell(kt.row.info)}
                                    </div>
                                  )}
                                </div>
                                <div className="mnt-run">
                                  {isProd && (
                                    <label className="mnt-confirm">
                                      <span>Type <b>{kt.row.id}</b> to enable</span>
                                      <input value={killConfirm} spellCheck={false}
                                             onChange={e => setKillConfirm(e.target.value)} />
                                    </label>
                                  )}
                                  <div style={{ flex: 1 }} />
                                  <button className="toolbar-btn proc-kill" disabled={!armed}
                                          onClick={() => { if (armed) void executeClusterKill('query'); }}>
                                    Kill query {kt.row.id}
                                  </button>
                                  <button className="toolbar-btn proc-kill-hard" disabled={!armed}
                                          onClick={() => { if (armed) void executeClusterKill('connection'); }}>
                                    Kill connection {kt.row.id}
                                  </button>
                                  <button className="icon-btn" title="Cancel"
                                          onClick={() => { setKillTarget(null); setKillConfirm(''); setKillError(null); }}>
                                    ✕
                                  </button>
                                </div>
                                {killError && <div className="galc-error">{killError}</div>}
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {procModel.systemByNode.map(s => (
                  <Fragment key={`sys-${s.connectionId}`}>
                    {s.rows.length > 0 && (
                      <tr className="galc-proc-sys" onClick={() => toggleSystemNode(s.connectionId)}>
                        <td colSpan={9}>
                          <span className={`gal-chev${systemOpen.has(s.connectionId) ? ' open' : ''}`}>▸</span>
                          {' '}{s.nodeName} — {s.rows.length} system thread{s.rows.length === 1 ? '' : 's'}
                          {' '}({s.summary.appliersActive} applier active · {s.summary.appliersIdle} idle)
                        </td>
                      </tr>
                    )}
                    {systemOpen.has(s.connectionId) && s.rows.map((r, i) => (
                      <tr key={`sys-${s.connectionId}-${r.id}-${i}`} className="galc-proc-sysrow">
                        <ProcessCells r={r} />
                      </tr>
                    ))}
                  </Fragment>
                ))}
                {procModel.groups.length === 0 && procModel.singles.length === 0
                  && procModel.unreachable.length === 0 && (
                  <tr><td colSpan={9} className="galc-cc-inc">No user threads running on any node.</td></tr>
                )}
              </tbody>
            </table>
          )}
          <div className="galc-note">
            <code>SHOW FULL PROCESSLIST</code> per node on the same ephemeral sessions as the
            cluster poll. Kill acts on the row's own node via a short-lived session; audited like
            the Processes panel. Applier/system threads are never killable here.
          </div>
        </div>
      )}

      {view && !procView && (
        <div className="galc-grid">
          {view.nodes.map(n => {            const badge = stateBadge(n);
            // gcacheWindow wants the parsed snapshot — re-parse this node's raw
            // rows (parseGaleraStatus is pure and the row sets are ~100 rows).
            const raw = snaps.find(x => x.connectionId === n.connectionId);
            const gw = raw?.ok
              ? gcacheWindow(parseGaleraStatus(raw.statusRows, raw.variableRows),
                  samples.get(n.connectionId) ?? [])
              : null;
            return (
              <div key={n.connectionId} className={`galc-card galc-${badge.cls}`}>
                <div className="galc-card-head">
                  <span className={`galc-state galc-state-${badge.cls}`}>{badge.text}</span>
                  <span className="galc-name" title={n.nodeName ? `wsrep node: ${n.nodeName}` : undefined}>
                    {n.name}
                  </span>
                  {n.nodeName && n.nodeName !== n.name && <span className="galc-nodename">{n.nodeName}</span>}
                  {n.connectionId === writeRec?.connectionId && (
                    <span className="galc-writer"
                          title={writeRec.reasons.length > 0
                            ? writeRec.reasons.join(' · ')
                            : 'Recommended write target — synced, no flow control, idle queues'}>
                      ✎ write target
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <button className="toolbar-btn" title="Open this node's session on its Galera tab"
                          onClick={() => drillIn(n.connectionId)}>Open</button>
                </div>

                {!n.reachable && (
                  <div className="galc-error">{n.error ?? 'unreachable'}</div>
                )}
                {n.reachable && !n.detected && (
                  <div className="galc-error">No wsrep provider — not a Galera node.</div>
                )}

                {n.reachable && n.detected && (
                  <>
                    {(n.transfer || n.ist) && (
                      <div className={`gal-transfer gal-transfer-${n.transfer?.phase ?? 'ist'}`}>
                        {n.transfer && (
                          <>
                            <div className="gal-transfer-head">
                              <span className="gal-transfer-title">{n.transfer.title}</span>
                              <span className="gal-transfer-elapsed">elapsed {fmtElapsed(n.transfer.elapsedMs)}</span>
                            </div>
                            {n.transfer.phase === 'sst' && (
                              <div className="gal-progress"><div className="gal-progress-pulse" /></div>
                            )}
                            {n.transfer.phase === 'catchup' && n.transfer.queueLeft !== null && (
                              <div className="gal-transfer-detail">
                                {n.transfer.queueLeft.toLocaleString()} write-sets left to apply.
                              </div>
                            )}
                          </>
                        )}
                        {n.ist && (
                          <div className="gal-ist">
                            <div className="gal-ist-label">IST {Math.round(n.ist.pct * 100)}%</div>
                            <div className="gal-progress">
                              <div className="gal-progress-fill" style={{ width: `${n.ist.pct * 100}%` }} />
                            </div>
                          </div>
                        )}

                        {/* Server-log tail: with a percentage from the log the
                            card turns determinate; with only phase lines it
                            stays honest about it. One tail per node. */}
                        {(() => {
                          const tail = tails.get(n.connectionId);
                          if (tail?.ended) {
                            return (
                              <div className="gal-op-cur gal-op-hint">
                                server-log watch ended ({tail.ended})
                              </div>
                            );
                          }
                          if (tail) {
                            const sum = tail.summary;
                            const label = sum?.pct != null
                              ? `${sum.phase === 'ist-progress' ? 'IST' : 'SST'} ${Math.round(sum.pct * 100)}%` +
                                (sum.eventsDone != null && sum.eventsTotal != null
                                  ? ` — ${sum.eventsDone.toLocaleString()} of ${sum.eventsTotal.toLocaleString()} events`
                                  : sum.detail ? ` — ${sum.detail}` : '')
                              : sum ? `SST in progress — ${sum.detail}` : 'watching the server log…';
                            return (
                              <div className="gal-logwatch">
                                <div className="gal-ist-label">
                                  {label}
                                  <span className="gal-ist-status">
                                    {' '}· server log{tail.path ? '' : ' (locating…)'}
                                  </span>
                                  <button className="toolbar-btn" style={{ marginLeft: 8 }}
                                          onClick={() => stopTail(n.connectionId)}>
                                    ■ Stop
                                  </button>
                                </div>
                                <div className="gal-progress">
                                  {sum?.pct != null
                                    ? <div className="gal-progress-fill" style={{ width: `${sum.pct * 100}%` }} />
                                    : <div className="gal-progress-pulse" />}
                                </div>
                                {sum?.failed && (
                                  <div className="gal-finding-detail">
                                    ⚠ the server log shows a WSREP_SST error line — the SST scripts retry;
                                    watch for a completion line before acting on it.
                                  </div>
                                )}
                                {tail.recent.length > 0 && (
                                  <pre className="gal-logwatch-lines"
                                       title={tail.recent.join('\n')}
                                       data-tip={tail.path ? `tail -F ${tail.path}` : 'server error log'}>
                                    {tail.recent.slice(-4).join('\n')}
                                  </pre>
                                )}
                                {tail.notes.map((m, i) => (
                                  <div key={i} className="gal-op-cur gal-op-hint">{m}</div>
                                ))}
                              </div>
                            );
                          }
                          // The offer, SSH-gated: saved node → its entry in
                          // `conns`; ad-hoc node → the clone matched by
                          // wsrep_node_address (it carries the seed's SSH
                          // fields). No SSH → greyed with the reason, never
                          // disabled; the handler guards the same predicate.
                          const cfg = tailConfigFor(n);
                          const canTail = !!cfg && cfg.use_ssh && !!cfg.ssh_host && !!cfg.ssh_user;
                          return (
                            <div className="gal-logwatch-offer">
                              {canTail ? (
                                <button className="toolbar-btn"
                                        data-tip="tail this node's server error log over SSH — live SST phases and the real IST percentage (the only source of one)"
                                        onClick={() => { if (canTail) void startTail(n); }}>
                                  ⌁ Watch log
                                </button>
                              ) : (
                                <span className="unavail"
                                      data-tip={cfg
                                        ? 'no SSH on this connection — the log tail rides SSH'
                                        : 'no connection config resolves for this node — the log tail needs the connection (with SSH) that polls it'}>
                                  <button className="toolbar-btn" aria-disabled="true"
                                          onClick={() => { if (canTail) void startTail(n); }}>
                                    ⌁ Watch log
                                  </button>
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    <div className="galc-stats">
                      <div className="galc-stat">
                        <span className="galc-stat-k">size seen</span>
                        <span className="galc-stat-v">{n.clusterSize ?? '—'}</span>
                      </div>
                      <div className="galc-stat">
                        <span className="galc-stat-k">FC paused</span>
                        <span className={`galc-stat-v ${n.flowControlPaused !== null && n.flowControlPaused > 0.1 ? 'galc-bad' : n.flowControlPaused !== null && n.flowControlPaused > 0.01 ? 'galc-warn' : ''}`}>
                          {fmtPct(n.flowControlPaused)}
                        </span>
                      </div>
                      <div className="galc-stat">
                        <span className="galc-stat-k">recv queue</span>
                        <span className={`galc-stat-v ${(n.recvQueue ?? 0) > 8 ? 'galc-warn' : ''}`}>
                          {n.recvQueue === null ? '—' : n.recvQueue.toLocaleString()}
                        </span>
                      </div>
                      <div className="galc-stat">
                        <span className="galc-stat-k">send queue</span>
                        <span className={`galc-stat-v ${(n.sendQueue ?? 0) > 8 ? 'galc-warn' : ''}`}>
                          {n.sendQueue === null ? '—' : n.sendQueue.toLocaleString()}
                        </span>
                      </div>
                      <div className="galc-stat">
                        <span className="galc-stat-k">commits/s</span>
                        <span className="galc-stat-v">{rateText(n.rates.commitsPerSec, '/s')}</span>
                      </div>
                      <div className="galc-stat">
                        <span className="galc-stat-k">replicated</span>
                        <span className="galc-stat-v">
                          {n.rates.replicatedBytesPerSec === null ? '—' : `${fmtBytes(Math.round(n.rates.replicatedBytesPerSec))}/s out`}
                        </span>
                      </div>
                      <div className="galc-stat">
                        <span className="galc-stat-k">received</span>
                        <span className="galc-stat-v">
                          {n.rates.receivedBytesPerSec === null ? '—' : `${fmtBytes(Math.round(n.rates.receivedBytesPerSec))}/s in`}
                        </span>
                      </div>
                      {(() => {
                        const cr = conflictRatesMap.get(n.connectionId);
                        const conflictHot = !!cr && ((cr.certPerSec ?? 0) > 0 || (cr.bfPerSec ?? 0) > 0);
                        const share = writeShares.get(n.connectionId)?.share ?? null;
                        return (
                          <>
                            <div className="galc-stat"
                                 title="cert = local transactions failing certification (originating side) · bf = local transactions aborted by a conflicting replicated write-set (victim side) — rates vs the previous poll">
                              <span className="galc-stat-k">conflicts</span>
                              <span className={`galc-stat-v ${conflictHot ? 'galc-warn' : ''}`}>
                                {formatConflictStat(cr) ?? '—'}
                              </span>
                            </div>
                            <div className="galc-stat"
                                 title="This node's share of the write-sets the cluster originated in the last interval (wsrep_replicated delta). Dash: no baseline yet, or an idle cluster.">
                              <span className="galc-stat-k">writes here</span>
                              <span className="galc-stat-v">{formatWriteShare(share) ?? '—'}</span>
                            </div>
                          </>
                        );
                      })()}
                      {gw && gw.timeToSstMs !== null && (
                        <div className="galc-stat galc-stat-wide" title="IST window — a node restarted within it rejoins by IST, not SST">
                          <span className="galc-stat-k">gcache window</span>
                          <span className="galc-stat-v">
                            ≈ {fmtElapsed(gw.timeToSstMs)}{gw.gcacheSizeText ? ` (gcache ${gw.gcacheSizeText})` : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}

          {/* #8 ghost members: in every node's incoming addresses, matched by
              no polled config — greyed and explained, never an error. */}
          {ghosts.map(g => (
            <div key={`ghost-${g.address}`} className="galc-card galc-down galc-ghost">
              <div className="galc-card-head">
                <span className="galc-state galc-state-down">ghost</span>
                <span className="galc-name">{g.address}</span>
                <span className="galc-nodename">
                  {g.classification === 'likely_arbitrator' ? 'likely garbd' : 'unknown member'}
                </span>
              </div>
              <span className="unavail" data-tip={ghostCardTip(g)}>
                <div className="galc-error galc-ghost-note">
                  answers Galera (gcomm), not SQL — {g.polls} poll{g.polls === 1 ? '' : 's'}
                </div>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
