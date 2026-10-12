/**
 * Galera cluster status — the "Galera" tab of the Replication panel (mysql
 * engine only; the tab is not offered on other engines).
 *
 * Detection is one read-only probe, `SHOW GLOBAL VARIABLES LIKE 'wsrep_on'`,
 * through `monitor_query` (SHOW is read-family for the write guard, and SHOW
 * needs no special grant — unknown-means-allowed, so no privilege
 * gate). ON means the wsrep provider is loaded and active: this node is part
 * of a MariaDB Galera Cluster or Percona XtraDB Cluster. The probe reads
 * VARIABLES, not STATUS, because MariaDB has no `wsrep_on` STATUS row at all
 * (verified on 11.8 — the STATUS probe comes back empty on a live Galera
 * node, which would false-negative the whole tab); the variable is ON on a
 * Galera node and OFF on a standalone MariaDB (`wsrep_provider = none`), so
 * it discriminates correctly on both. An OFF/empty result renders an honest
 * empty state and polls nothing further; async-replication detection on the
 * other tab is untouched (a Galera node can also be an async primary or
 * replica).
 *
 * Once detected, the view polls `SHOW GLOBAL STATUS/VARIABLES LIKE 'wsrep%'`
 * every 5 s and hands both row sets to utils/galeraStatus.ts — parsing and
 * the health rules are pure and unit-tested there; this file only renders.
 * A prominent card shows while a state transfer runs (SST elapsed — Galera
 * exposes no SST percentage over SQL — catch-up queue countdown, donor/desync
 * disambiguation), plus a determinate IST bar when PXC reports the
 * wsrep_ist_* seqnos, and a gcache IST-window estimator from the poll's own
 * burn-rate samples. The same poll samples feed a compact sparkline strip
 * (flow-control paused, apply queue, commits/s) and the TRANSITION diff
 * (utils/galeraStatus.ts galeraEventsFromTransition) whose events are
 * persisted fire-and-forget via `record_galera_event` — the incident
 * timeline's `galera_event` kind. When the optional WSREP_INFO plugin is
 * installed (SUPER-gated, off by default), a one-time probe of
 * information_schema.WSREP_MEMBERSHIP adds a membership table; a failure is
 * tolerated silently and nothing renders.
 *
 * When the connection has SSH configured, the transfer card additionally
 * offers "Watch server log": `galera_sst_log_tail` runs
 * `tail -n 200 -F <log_error>` on the DB host over the connection's own SSH
 * settings (same askpass machinery as the tunnel) and streams lines on a
 * Channel; `utils/galeraSstLog.ts` parses them into phase/percentage
 * signals, so the card turns DETERMINATE on "Receiving IST... 64.0%" lines
 * and shows live SST phases otherwise. No SSH → greyed with the reason,
 * never hidden. The tail stops when the card resolves, when the tab hides
 * (panels stay mounted; a hidden tail streams for nobody), and on unmount —
 * all three via the generic ext-job cancel (`cancel_watched`).
 * Caveat verified live on MariaDB 11.8 (2026-10-02): a
 * joiner mid-SST/IST refuses TCP connections outright, so THIS view (which
 * follows one session) just shows its poll error during the transfer — the
 * transfer card for a joining node is primarily visible in the multi-node
 * cluster panel via the donor.
 *
 * AUTO-DISCOVERY: the poll's own wsrep_incoming_addresses is the cluster's
 * member list, so when some members have no saved connection a banner OFFERS
 * (never forces) the two ways to close the gap: "Add as connections"
 * (`galera_adopt_members` — a seed clone per member, secrets copied
 * server-side, folder named after the cluster) and "Monitor once"
 * (id-preserving ad-hoc configs parked in store/galeraAdhoc, polled unsaved
 * by the cluster panel via galera_cluster_poll's adhocConfigs). The matching
 * (localhost ≡ 127.0.0.1, default port, duplicates) is pure
 * utils/galeraDiscover.ts; dismissal persists per connection in localStorage
 * and lifts when the unsaved count grows past the dismissed one.
 *
 * The view also carries the write side (utils/galeraOps.ts holds every SQL
 * string, the risk copy and the eligibility rules): NODE OPERATIONS — backup
 * mode (wsrep_desync), maintenance mode (wsrep_reject_queries NONE/ALL;
 * ALL_KILL deliberately not a button), the apply-threads stepper
 * (wsrep_slave_threads), and the two PXC-only provider-option ops (gcache
 * freeze, node eviction) which are greyed with the reason when the tolerant
 * READ_ONLY probe says wsrep_provider_options is not writable over SQL (on
 * MariaDB 11.8 it is not — ERROR 1238, verified live). All SET GLOBAL ops
 * run through `monitor_query`, whose server-side guard (sqlguard classifies
 * SET GLOBAL as a write) refuses them on read-only sessions — the UI greys
 * them with the same predicate, and a positively-denied SUPER grant
 * (`server-admin` capability) greys them with the grant to ask for
 * (unknown-means-allowed). Every op confirms its own risk inline; eviction
 * needs the word EVICT typed (the VacuumBloatPanel typed-confirmation
 * pattern). On prod sessions the once-per-run ProdAck has already gated the
 * workspace; the ops section additionally badges prod. Session-scope toggles
 * (wsrep_sync_wait causal reads, wsrep_dirty_reads) need no grant and no
 * confirmation. When the poll says non-Primary, a BOOTSTRAP ADVISOR card
 * explains quorum-loss recovery with copyable pc.bootstrap SQL — deliberately
 * NOT a button (utils/galeraOps.ts bootstrapAdvice).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import type { ConnectionConfig, QueryResult } from '../types';
import { usePoll } from '../hooks/usePoll';
import { errorDisplay } from '../utils/appError';
import {
  detectGalera, parseGaleraStatus, galeraFindings, transferState, istProgress,
  gcacheWindow, fmtBytes, fmtPct, fmtElapsed, QUEUE_WARN,
  galeraEventsFromTransition, orderMembershipColumns, statusOn,
  type GaleraStatus, type SeqnoSample,
} from '../utils/galeraStatus';
import { parseIncoming } from '../utils/galeraCluster';
import {
  findUnsavedMembers, memberDisplayName, buildAdhocConfig, shouldShowDiscoverBanner,
} from '../utils/galeraDiscover';
import { setGaleraAdhoc } from '../store/galeraAdhoc';
import {
  parseSstLogLine, summarizeSstLog,
  type SstLogSignal, type SstLogSummary,
} from '../utils/galeraSstLog';
import { ConnectionsStore } from '../store/connections';
import { useTabVisible } from '../store/tabVisibility';
import {
  opsFor, opUnavailable, clampSlaveThreads, parseReadOnlyFlag,
  SESSION_TOGGLES_SQL, parseSessionToggles, syncWaitSql, dirtyReadsSql,
  PROVIDER_OPTIONS_READONLY_SQL, bootstrapAdvice,
  type GaleraOp, type SessionToggles,
} from '../utils/galeraOps';
import { useSessionPrivileges } from '../store/sessionPrivileges';
import { denied } from '../utils/privileges';
import { isoNow, logAudit, newRunId } from '../utils/audit';
import { addLog } from '../store/logStore';
import { fmtDuration } from '../utils/fmtDuration';
import type { Health } from '../utils/replication';

interface Props {
  sessionId: string;
  /** Saved-connection id — scopes the persisted galera_event rows. */
  connectionId: string;
  /** For the audit rows the node operations write. */
  connectionName: string;
  /** 'prod' badges the operations section (the ProdAck modal gated the open). */
  environment?: string | null;
  /** Read-only sessions grey the SET GLOBAL ops; the backend guard agrees. */
  readOnly?: boolean;
}

type Probe = 'pending' | 'no' | 'yes';

/** Wire shape of `galera_sst_log_tail`'s Channel — mirrors SstLogEvent in
 *  src-tauri/src/commands/galera.rs. */
type SstLogEvent =
  | { type: 'started'; path: string }
  | { type: 'line'; line: string }
  | { type: 'note'; message: string }
  | { type: 'ended'; reason: string };

/** The running log tail: raw recent lines for the mini view, the parsed
 *  signal window (capped — summarizeSstLog re-folds it per line) and the
 *  folded summary the card renders from. */
interface LogWatchState {
  path: string | null;
  signals: SstLogSignal[];
  summary: SstLogSummary | null;
  recent: string[];
  notes: string[];
  /** Set by the terminal `ended` event or a rejected invoke. */
  ended: string | null;
}

/** Cap on retained signals/lines — an SST can print for minutes at 5 lines/s. */
const LOGWATCH_KEEP = 500;

/** SHOW rows → [name, value] pairs for the parser. NULLs become ''. */
const rows2 = (r: QueryResult): [string, string][] =>
  r.rows.map(row => [String(row[0] ?? ''), row[1] == null ? '' : String(row[1])]);

const onOffHealth = (v: string | null): Health => v === null ? null : v === 'ON' ? 'good' : 'bad';
const stateHealth = (v: string | null): Health =>
  v === null ? null : v === 'Synced' ? 'good' : v === 'Joining' ? null : 'warn';

// ── Cluster auto-discovery (the banner) ─────────────────────────────────────
// The dismissal is persisted per connection: hidden while the unsaved-member
// count stays at or below the dismissed count, back when the cluster grows
// past it (utils/galeraDiscover.shouldShowDiscoverBanner).
const DISCOVER_DISMISS_PREFIX = 'dbgui.galeraDiscover.dismissed.';

function readDiscoverDismissed(connectionId: string): number | null {
  try {
    const v = localStorage.getItem(DISCOVER_DISMISS_PREFIX + connectionId);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;   // storage blocked — treat as never dismissed
  }
}

/** One poll's readings for the sparkline strip (nulls allowed per metric). */
interface MetricSample {
  tsMs: number;
  fcPaused: number | null;
  recvQueue: number | null;
  lastCommitted: number | null;
}

/** Sparkline window: the same ≈5 min the seqno ring buffer keeps. */
const METRIC_SAMPLE_MS = 5 * 60_000;

/** Compact sparkline — the MonitorPanel shape, minus the empty-state chrome. */
function GalSpark({ points, hot }: { points: number[]; hot?: boolean }) {
  if (points.length < 2) return <svg className="gal-spark" viewBox="0 0 100 24" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = 100 / (points.length - 1);
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(22 - ((v - min) / span) * 20).toFixed(1)}`)
    .join(' ');
  return (
    <svg className={`gal-spark${hot ? ' gal-spark-hot' : ''}`} viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function GaleraClusterView({ sessionId, connectionId, connectionName, environment, readOnly }: Props) {
  const [probe, setProbe] = useState<Probe>('pending');
  // Current + previous snapshot in one state so the rate-based health rules
  // always compare two different polls (functional update, no stale closure).
  const [pair, setPair] = useState<{ cur: GaleraStatus; prev: GaleraStatus | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // Transfer watch state, kept across polls: first-observed-in-state stamp
  // (reset when the local state changes) and the seqno ring buffer feeding
  // the gcache burn rate (≈5 min at the 5 s poll). Poll failures never touch
  // either — a failed poll just leaves the previous reading in place.
  const [stateSince, setStateSince] = useState<{ state: string | null; sinceMs: number }>({ state: null, sinceMs: 0 });
  const [samples, setSamples] = useState<SeqnoSample[]>([]);
  // Sparkline strip samples — same cadence and window as the seqno buffer.
  const [metricSamples, setMetricSamples] = useState<MetricSample[]>([]);
  // The previous poll's snapshot for the transition diff, in a ref because
  // the poll body must diff against the ACTUAL previous poll even when a
  // render has not committed yet (stale closure would double-fire events).
  const prevSnapRef = useRef<GaleraStatus | null>(null);
  // WSREP_INFO membership (optional plugin): null = absent or not probed —
  // either way nothing renders; variant-dependent data is omitted, never
  // greyed. Probed once per session, only after wsrep detection.
  const [membership, setMembership] = useState<QueryResult | null>(null);
  const snap = pair?.cur ?? null;

  // ── Node operations (Feature A) ────────────────────────────────────────────
  // The gates: read-only sessions and a positively-denied SUPER grant grey the
  // SET GLOBAL ops with the reason (unknown-means-allowed); the backend write
  // guard refuses them regardless. wsrep_provider_options writability is
  // probed, not assumed — MariaDB 11.8 reports READ_ONLY=YES (verified live:
  // the SET fails with ERROR 1238), PXC has no such table so the probe errors
  // → null → allowed.
  const [providerOptsReadOnly, setProviderOptsReadOnly] = useState<boolean | null>(null);
  const [toggles, setToggles] = useState<SessionToggles>({ syncWait: null, dirtyReads: null });
  const [threadsInput, setThreadsInput] = useState('');
  const [evictUuid, setEvictUuid] = useState('');
  /** The op whose inline risk confirmation is open; null = none. */
  const [pending, setPending] = useState<GaleraOp | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [opBusy, setOpBusy] = useState(false);
  const [opResults, setOpResults] = useState<{ sql: string; ok: boolean; message: string; ms: number }[]>([]);
  /** Bootstrap advisor copy-button feedback. */
  const [copied, setCopied] = useState(false);
  // Collapse state for the rarely-used surfaces: the WSREP_INFO membership
  // table (inside the Membership card) and the whole Node operations card.
  // Both default collapsed — their one-line summaries carry the live values.
  const [membersOpen, setMembersOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const isProd = environment === 'prod';
  const privs = useSessionPrivileges(sessionId, 'mysql');
  const superDenied = denied(privs, 'server-admin');

  // ── SST/IST server-log watch over SSH (the only true SST percentage) ──────
  // Gate: the CONNECTION has SSH configured (checked once against the saved
  // config, secrets never cross) — the desktop OS is irrelevant: ssh is
  // already a tunnel requirement and tail -F runs remote-side. No SSH → the
  // control is greyed with the reason, never hidden; the handler guards with
  // the same predicate, and the backend refuses independently.
  const [hasSsh, setHasSsh] = useState<boolean | null>(null);
  const [logWatch, setLogWatch] = useState<LogWatchState | null>(null);
  const logWatchKeyRef = useRef<string | null>(null);
  const tabVisible = useTabVisible();

  // ── Cluster auto-discovery ────────────────────────────────────────────────
  // The saved-connection list the unsaved-member matching runs against (null
  // = not loaded yet — the banner simply waits). Loaded once, refreshed after
  // a successful adoption, which is also what makes the banner clear itself.
  const [savedConns, setSavedConns] = useState<ConnectionConfig[] | null>(null);
  const [discoverDismissed, setDiscoverDismissed] = useState<number | null>(
    () => readDiscoverDismissed(connectionId));
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adoptedMsg, setAdoptedMsg] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    ConnectionsStore.list()
      .then(list => {
        if (dead) return;
        setHasSsh(!!list.find(c => c.id === connectionId && c.use_ssh && c.ssh_host));
        setSavedConns(list);
      })
      .catch(() => { if (!dead) setHasSsh(false); });
    return () => { dead = true; };
  }, [connectionId]);

  const stopLogWatch = useCallback(() => {
    const k = logWatchKeyRef.current;
    logWatchKeyRef.current = null;
    if (k) void invoke('cancel_watched', { runKey: k }).catch(() => { /* already gone */ });
  }, []);

  const startLogWatch = useCallback(async () => {
    if (!hasSsh || logWatchKeyRef.current) return;  // the button's predicate
    const runKey = crypto.randomUUID();
    logWatchKeyRef.current = runKey;
    setLogWatch({ path: null, signals: [], summary: null, recent: [], notes: [], ended: null });
    addLog(sessionId, { level: 'info', action: 'GALERA',
      detail: 'galera_sst_log_tail', line: '▶ watching server error log over SSH' });
    const chan = new Channel<SstLogEvent>();
    chan.onmessage = ev => {
      if (ev.type === 'started') {
        setLogWatch(w => w ? { ...w, path: ev.path } : w);
      } else if (ev.type === 'line') {
        const sig = parseSstLogLine(ev.line);
        setLogWatch(w => {
          if (!w) return w;
          const signals = sig ? [...w.signals, sig].slice(-LOGWATCH_KEEP) : w.signals;
          return {
            ...w,
            signals,
            summary: sig ? summarizeSstLog(signals) : w.summary,
            recent: [...w.recent, ev.line].slice(-8),
          };
        });
      } else if (ev.type === 'note') {
        setLogWatch(w => w ? { ...w, notes: [...w.notes, ev.message].slice(-4) } : w);
      } else {
        logWatchKeyRef.current = null;
        setLogWatch(w => w ? { ...w, ended: ev.reason } : w);
      }
    };
    try {
      // Resolves only when the stream ends; the terminal event already set
      // `ended`, so all that is left is an invoke that failed before start.
      await invoke('galera_sst_log_tail', { sessionId, connectionId, runKey, onEvent: chan });
    } catch (e) {
      logWatchKeyRef.current = null;
      setLogWatch(w => w ? { ...w, ended: errorDisplay(e) } : w);
    }
  }, [hasSsh, sessionId, connectionId]);

  // The tail stops with the card (transfer resolved), with a hidden tab
  // (panels stay mounted — a hidden tail is an ssh process streaming for
  // nobody), and with the panel itself (unmount).
  const cardActive = !!(snap && (transferState(snap, 0, 0) || istProgress(snap)));
  useEffect(() => {
    if (logWatch && !logWatch.ended && (!tabVisible || !cardActive)) stopLogWatch();
  }, [tabVisible, cardActive, logWatch, stopLogWatch]);
  useEffect(() => () => {
    const k = logWatchKeyRef.current;
    if (k) void invoke('cancel_watched', { runKey: k }).catch(() => { /* closing anyway */ });
  }, []);

  useEffect(() => {
    if (probe !== 'yes') return;
    let dead = false;
    (async () => {
      try {
        const r = await invoke<QueryResult>('monitor_query', {
          sessionId, sql: PROVIDER_OPTIONS_READONLY_SQL,
        });
        if (!dead) setProviderOptsReadOnly(parseReadOnlyFlag(r.rows[0]?.[0] == null ? null : String(r.rows[0][0])));
      } catch { if (!dead) setProviderOptsReadOnly(null); }
    })();
    return () => { dead = true; };
  }, [sessionId, probe]);

  const refreshToggles = useCallback(async () => {
    try {
      const r = await invoke<QueryResult>('monitor_query', { sessionId, sql: SESSION_TOGGLES_SQL });
      setToggles(parseSessionToggles(r.rows[0]));
    } catch { /* leave the previous reading; the checkboxes stay indeterminate */ }
  }, [sessionId]);
  useEffect(() => {
    if (probe === 'yes') void refreshToggles();
  }, [probe, refreshToggles]);

  // One detection probe per session. Failure to answer reads as "not Galera" —
  // the empty state names what was asked, so nothing is hidden.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await invoke<QueryResult>('monitor_query', {
          sessionId, sql: "SHOW GLOBAL VARIABLES LIKE 'wsrep_on'",
        });
        if (!dead) setProbe(detectGalera(rows2(r)) ? 'yes' : 'no');
      } catch {
        if (!dead) setProbe('no');
      }
    })();
    return () => { dead = true; };
  }, [sessionId]);

  // One WSREP_INFO probe per session, after detection. The plugin is not
  // installed by default and the table is SUPER-gated, so failure is the
  // common case and stays silent — no error surface, no greyed control.
  useEffect(() => {
    if (probe !== 'yes') return;
    let dead = false;
    (async () => {
      try {
        const r = await invoke<QueryResult>('monitor_query', {
          sessionId, sql: 'SELECT * FROM information_schema.WSREP_MEMBERSHIP',
        });
        if (!dead && r.rows.length > 0) setMembership(r);
      } catch { /* plugin absent or not privileged — render nothing */ }
    })();
    return () => { dead = true; };
  }, [sessionId, probe]);

  const body = useCallback(async () => {
    if (probe !== 'yes') return;
    try {
      const [st, va] = await Promise.all([
        invoke<QueryResult>('monitor_query', { sessionId, sql: "SHOW GLOBAL STATUS LIKE 'wsrep%'" }),
        invoke<QueryResult>('monitor_query', { sessionId, sql: "SHOW GLOBAL VARIABLES LIKE 'wsrep%'" }),
      ]);
      const parsed = parseGaleraStatus(rows2(st), rows2(va));
      const nowMs = Date.now();
      setStateSince(prev => prev.state === parsed.localStateComment
        ? prev
        : { state: parsed.localStateComment, sinceMs: nowMs });
      const lc = parsed.lastCommitted;
      if (lc !== null) {
        setSamples(prev => [...prev, { tsMs: nowMs, lastCommitted: lc }]
          .filter(s => nowMs - s.tsMs <= 5 * 60_000)
          .slice(-60));
      }
      setMetricSamples(prev => [...prev, {
        tsMs: nowMs,
        fcPaused: parsed.flowControlPaused,
        recvQueue: parsed.localRecvQueue,
        lastCommitted: lc,
      }].filter(s => nowMs - s.tsMs <= METRIC_SAMPLE_MS).slice(-60));
      // Transition events — fire-and-forget, NEVER blocking the poll: the
      // store dedupes identical repeats, and a failed record just means one
      // missing timeline row.
      const prevSnap = prevSnapRef.current;
      prevSnapRef.current = parsed;
      for (const ev of galeraEventsFromTransition(prevSnap, parsed)) {
        void invoke('record_galera_event', {
          connectionId, engine: 'mysql',
          eventType: ev.eventType, summary: ev.summary, detail: ev.detail, ok: ev.ok,
        }).catch(() => { /* local-store hiccup — the poll is the product */ });
      }
      setPair(p => ({ cur: parsed, prev: p?.cur ?? null }));
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [sessionId, connectionId, probe]);
  const refresh = usePoll(body, 5, { paused: paused || probe !== 'yes', inFlightGraceMs: 30_000 });

  // ── Discovery derived values + the three banner actions ───────────────────
  // Discovery needs NO probe of its own: the poll above already reads
  // wsrep_incoming_addresses. Everything matching-shaped is pure
  // (utils/galeraDiscover.ts) — this is the I/O shell around it.
  const incoming = useMemo(
    () => (snap ? parseIncoming(snap.incomingAddresses) : []),
    [snap]);
  const unsavedMembers = useMemo(
    () => (savedConns ? findUnsavedMembers(incoming, savedConns, connectionId) : []),
    [incoming, savedConns, connectionId]);
  const seedConfig = useMemo(
    () => savedConns?.find(c => c.id === connectionId) ?? null,
    [savedConns, connectionId]);
  const clusterName = snap?.clusterName ?? null;
  const showDiscover = probe === 'yes' && savedConns !== null
    && shouldShowDiscoverBanner(unsavedMembers.length, discoverDismissed);

  /** "Add as connections" — adopt every unsaved member as a real saved
   *  connection (secrets copied server-side), into a folder named after the
   *  cluster. The banner clears itself when the refreshed list covers them. */
  const adoptMembers = useCallback(async () => {
    if (!seedConfig || adoptBusy || unsavedMembers.length === 0) return;
    setAdoptBusy(true);
    setAdoptError(null);
    try {
      const members = unsavedMembers.map(m => ({
        host: m.host, port: m.port, name: memberDisplayName(clusterName, m.host, m.port),
      }));
      const created = await invoke<ConnectionConfig[]>('galera_adopt_members', {
        seedId: connectionId, members, group: clusterName,
      });
      // The sidebar and every other connections listener refresh.
      window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
      const msg = `✓ ${created.length} connection${created.length === 1 ? '' : 's'} added` +
        `${clusterName ? ` to folder '${clusterName}'` : ''} — in the sidebar now`;
      addLog(sessionId, { level: 'ok', action: 'GALERA', detail: 'galera_adopt_members', line: msg });
      setAdoptedMsg(msg);
      setSavedConns(await ConnectionsStore.list());
    } catch (e) {
      setAdoptError(errorDisplay(e));
    }
    setAdoptBusy(false);
  }, [seedConfig, adoptBusy, unsavedMembers, clusterName, connectionId, sessionId]);

  /** "Monitor once" — park the id-preserving ad-hoc configs for the cluster
   *  panel (it polls them unsaved, this app run only) and open that panel. */
  const monitorOnce = useCallback(() => {
    if (!seedConfig || unsavedMembers.length === 0) return;
    setGaleraAdhoc(unsavedMembers.map(m => buildAdhocConfig(seedConfig, m.host, m.port, clusterName)));
    window.dispatchEvent(new CustomEvent('dbgui:toggle-panel', { detail: { panel: 'cluster' } }));
  }, [seedConfig, unsavedMembers, clusterName]);

  const dismissDiscover = useCallback(() => {
    try {
      localStorage.setItem(DISCOVER_DISMISS_PREFIX + connectionId, String(unsavedMembers.length));
    } catch { /* storage blocked — the in-memory copy still dismisses for this run */ }
    setDiscoverDismissed(unsavedMembers.length);
  }, [connectionId, unsavedMembers.length]);

  /**
   * Every statement this view RUNS reaches the audit log and the session log —
   * the MaintenancePanel/VacuumBloatPanel contract. Execution goes through
   * `monitor_query`: sqlguard classifies SET GLOBAL as a write, so the
   * server-side read-only refusal and the UI greying are the same predicate.
   * The handler guards with exactly the predicate the button rendered with.
   */
  const runOp = useCallback(async (op: GaleraOp) => {
    const gate = { readOnly: !!readOnly, superDenied, providerOptionsReadOnly: providerOptsReadOnly };
    if (opUnavailable(op, gate) || opBusy) return;
    if (op.confirmWord && confirmText.trim().toUpperCase() !== op.confirmWord) return;
    setOpBusy(true);
    addLog(sessionId, { level: 'info', action: 'GALERA', detail: op.sql, line: `▶ ${op.sql}` });
    const startedAt = isoNow();
    const t0 = performance.now();
    try {
      await invoke<QueryResult>('monitor_query', { sessionId, sql: op.sql });
      const ms = Math.round(performance.now() - t0);
      logAudit({
        run_id: newRunId(), stmt_index: 1, stmt_total: 1,
        session_id: sessionId, tab_title: '❖ Galera', database: '', source: 'panel',
        started_at: startedAt, ended_at: isoNow(), duration_ms: ms,
        connection_name: connectionName, db_user: '', engine: 'mysql', sql: op.sql,
        ok: true, rows_out: 0, rows_affected: null, error: null,
      }, { alsoLog: false });
      addLog(sessionId, { level: 'ok', action: 'GALERA', detail: op.sql, ms,
        line: `✓ ${op.sql} — done in ${fmtDuration(ms)}` });
      setOpResults(prev => [...prev, { sql: op.sql, ok: true, message: 'done', ms }]);
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      logAudit({
        run_id: newRunId(), stmt_index: 1, stmt_total: 1,
        session_id: sessionId, tab_title: '❖ Galera', database: '', source: 'panel',
        started_at: startedAt, ended_at: isoNow(), duration_ms: ms,
        connection_name: connectionName, db_user: '', engine: 'mysql', sql: op.sql,
        ok: false, rows_out: 0, rows_affected: null, error: errorDisplay(e), raw_error: e,
      }, { alsoLog: false });
      addLog(sessionId, { level: 'err', action: 'GALERA', detail: op.sql, ms,
        line: `✗ ${op.sql} — ${errorDisplay(e)}` });
      setOpResults(prev => [...prev, { sql: op.sql, ok: false, message: errorDisplay(e), ms }]);
    }
    setOpBusy(false);
    setPending(null);
    setConfirmText('');
    void refresh();
  }, [readOnly, superDenied, providerOptsReadOnly, opBusy, confirmText, sessionId, connectionName, refresh]);

  /** Session-scope toggles: SET SESSION — no grant, no confirmation, no gate. */
  const setToggle = useCallback(async (sql: string) => {
    addLog(sessionId, { level: 'info', action: 'GALERA', detail: sql, line: `▶ ${sql}` });
    try {
      await invoke<QueryResult>('monitor_query', { sessionId, sql });
      addLog(sessionId, { level: 'ok', action: 'GALERA', detail: sql, line: `✓ ${sql}` });
    } catch (e) {
      addLog(sessionId, { level: 'err', action: 'GALERA', detail: sql, line: `✗ ${sql} — ${errorDisplay(e)}` });
    }
    await refreshToggles();
  }, [sessionId, refreshToggles]);

  if (probe === 'pending') {
    return <div className="proc-loading">Probing for a wsrep provider…</div>;
  }
  if (probe === 'no') {
    return (
      <div className="gal-empty">
        <div className="gal-empty-title">No wsrep provider on this server</div>
        <div>
          <code>SHOW GLOBAL VARIABLES LIKE 'wsrep_on'</code> came back empty or OFF — this node is
          not part of a Galera cluster (MariaDB Galera Cluster / Percona XtraDB Cluster).
          Plain MySQL and standalone MariaDB (wsrep_provider = none) answer exactly this way;
          the async-replication view on the other tab is unaffected.
        </div>
      </div>
    );
  }

  const findings = snap ? galeraFindings(snap, pair?.prev ?? undefined) : [];
  // Elapsed time advances with the last successful poll (updatedAt), which is
  // also the cadence that re-renders this view — no render-time clock reads.
  const transfer = snap ? transferState(snap, updatedAt?.getTime() ?? 0, stateSince.sinceMs) : null;
  const ist = snap ? istProgress(snap) : null;
  const gw = snap ? gcacheWindow(snap, samples) : null;

  // Sparkline series from the poll's own samples; nulls are dropped per
  // metric (a build that cannot report a key just shows a shorter series).
  // Commits/s is the consecutive-samples rate; counter resets (ds < 0) skip
  // the interval instead of charting a nonsense negative.
  const fcSeries = metricSamples.flatMap(s => s.fcPaused === null ? [] : [s.fcPaused]);
  const queueSeries = metricSamples.flatMap(s => s.recvQueue === null ? [] : [s.recvQueue]);
  const commitSeries: number[] = [];
  for (let i = 1; i < metricSamples.length; i++) {
    const a = metricSamples[i - 1], b = metricSamples[i];
    if (a.lastCommitted === null || b.lastCommitted === null) continue;
    const dt = (b.tsMs - a.tsMs) / 1000;
    const ds = b.lastCommitted - a.lastCommitted;
    if (dt > 0 && ds >= 0) commitSeries.push(ds / dt);
  }
  const commitNow = commitSeries.length ? commitSeries[commitSeries.length - 1] : null;
  const fcHealth: Health = snap?.flowControlPaused == null ? null
    : snap.flowControlPaused > 0.1 ? 'bad'
    : snap.flowControlPaused > 0.01 ? 'warn' : 'good';
  const clusterHealth: Health = snap?.clusterStatus == null ? null
    : snap.clusterStatus === 'Primary' ? 'good' : 'bad';

  const kv = (label: string, value: string | null, opts: { health?: Health; mono?: boolean } = {}) => (
    <tr className={opts.health ? `repl-${opts.health}` : ''}>
      <td className="repl-key">{label}</td>
      <td className={`repl-val ${opts.mono ? 'repl-mono' : ''}`}>
        {value ?? <span className="fg-null">—</span>}
      </td>
    </tr>
  );
  const num = (n: number | null) => n === null ? null : n.toLocaleString();
  const bytes = (n: number | null) => n === null ? null : fmtBytes(n);

  // ── Feature B: bootstrap advisor (non-Primary only; never a button) ──────
  const advice = snap ? bootstrapAdvice(snap, providerOptsReadOnly) : null;

  // ── Feature A: node operations for the current snapshot ──────────────────
  const gate = { readOnly: !!readOnly, superDenied, providerOptionsReadOnly: providerOptsReadOnly };
  const threadsDraft = threadsInput === ''
    ? (snap?.slaveThreads ?? 1)
    : clampSlaveThreads(Number(threadsInput));
  const ops = snap ? opsFor(snap, { slaveThreads: threadsDraft, evictUuid }) : [];
  const opById = (id: GaleraOp['id']) => ops.find(o => o.id === id);
  /** The op currently offered for each control (state-flipped where applicable). */
  const desyncOp = opById('desync-on') ?? opById('desync-off');
  const rejectOp = opById('reject-all') ?? opById('reject-none');
  const threadsOp = opById('slave-threads');
  const freezeOp = opById('gcache-freeze');
  const evictOp = opById('evict');

  /** Known member UUIDs for the evict input, from the WSREP_INFO membership
   *  table when that optional plugin answered (absent → empty, free text). */
  const memberUuids: string[] = (() => {
    if (!membership) return [];
    const idx = membership.columns.findIndex(c => /uuid/i.test(c.name));
    if (idx < 0) return [];
    return membership.rows.map(r => String(r[idx] ?? '')).filter(Boolean);
  })();

  /** Button that opens the op's inline risk confirmation, greyed with the reason. */
  const opButton = (op: GaleraOp | undefined, label?: string) => {
    if (!op) return null;
    const why = opUnavailable(op, gate);
    const btn = (
      <button
        className="toolbar-btn"
        disabled={opBusy}
        onClick={() => { if (!why) { setPending(op); setConfirmText(''); } }}
      >
        {label ?? op.label}
      </button>
    );
    return why
      ? <span className="unavail" data-tip={why}>{btn}</span>
      : btn;
  };

  return (
    <div>
      <div className="gal-toolbar">
        <button className="toolbar-btn" onClick={() => setPaused(p => !p)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button className="toolbar-btn" onClick={refresh}>↻ Refresh</button>
        {updatedAt && (
          <span className="repl-updated" title="Last successful refresh">
            updated {updatedAt.toLocaleTimeString()}
          </span>
        )}
        <span className="proc-status" style={{ border: 'none', background: 'none' }}>
          {paused ? 'paused' : 'every 5s'}
        </span>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {showDiscover && (
        <div className="gal-finding gal-info">
          <div className="gal-finding-title">
            Cluster '{clusterName ?? '(unnamed)'}' has {snap?.clusterSize ?? incoming.length} members
            — {unsavedMembers.length} not in your connections
          </div>
          <div className="gal-finding-detail">
            This node's <code>wsrep_incoming_addresses</code> lists{' '}
            {unsavedMembers.map(m => `${m.host}:${m.port}`).join(', ')} — its cluster mates.
            Adopt them as saved connections (same credentials and SSH settings as this one,
            into a folder named after the cluster) or monitor them once, unsaved.
            <div className="gal-discover-actions">
              {seedConfig ? (
                <>
                  <button className="toolbar-btn"
                          data-tip="Save every listed member as a connection cloned from this one — passwords are copied inside the secret store, never shown"
                          onClick={() => { if (seedConfig) void adoptMembers(); }}>
                    {adoptBusy ? 'Adding…' : 'Add as connections'}
                  </button>
                  <button className="toolbar-btn"
                          data-tip="Poll the listed members in the Galera cluster panel without saving them — this app run only"
                          onClick={() => { if (seedConfig) monitorOnce(); }}>
                    Monitor once
                  </button>
                </>
              ) : (
                <span className="unavail"
                      data-tip="Discovery needs this node's SAVED connection — the adopted members inherit its credentials, so there is nothing to clone from here">
                  <button className="toolbar-btn" aria-disabled="true"
                          onClick={() => { if (seedConfig) void adoptMembers(); }}>
                    Add as connections
                  </button>
                </span>
              )}
              <button className="toolbar-btn"
                      data-tip="Hide this offer for the current members — it returns if more unsaved members appear"
                      onClick={dismissDiscover}>
                Dismiss
              </button>
            </div>
            {adoptError && <div className="galc-error">{adoptError}</div>}
          </div>
        </div>
      )}

      {adoptedMsg && !showDiscover && (
        <div className="gal-finding gal-ok">
          <div className="gal-finding-title">
            {adoptedMsg}
            <button className="icon-btn" style={{ marginLeft: 8 }} title="Close"
                    onClick={() => setAdoptedMsg(null)}>×</button>
          </div>
        </div>
      )}

      {advice && (
        <div className="gal-finding gal-crit gal-advisor">
          <div className="gal-finding-title">{advice.headline}</div>
          <div className="gal-finding-detail">
            {advice.detail}
            <span className="gal-advisor-sql">
              <code>{advice.sql}</code>
              <button className="toolbar-btn" onClick={() => {
                navigator.clipboard.writeText(advice.sql).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }).catch(() => {});
              }}>{copied ? 'Copied ✓' : 'Copy'}</button>
            </span>
            <div className="gal-advisor-warn">⚠ {advice.wrongNodeWarning}</div>
            <div>{advice.recoverNote}</div>
            {advice.mariadbNote && <div>{advice.mariadbNote}</div>}
          </div>
        </div>
      )}

      {(transfer || ist) && (
        <div className={`gal-transfer gal-transfer-${transfer?.phase ?? 'ist'}`}>
          {transfer && (
            <>
              <div className="gal-transfer-head">
                <span className="gal-transfer-title">{transfer.title}</span>
                <span className="gal-transfer-elapsed">elapsed {fmtElapsed(transfer.elapsedMs)}</span>
              </div>
              <div className="gal-transfer-detail">{transfer.detail}</div>
              {transfer.phase === 'sst' && logWatch?.summary?.pct == null && (
                <div className="gal-progress">
                  <div className="gal-progress-pulse" />
                </div>
              )}
            </>
          )}
          {ist && (
            <div className="gal-ist">
              <div className="gal-ist-label">
                IST {Math.round(ist.pct * 100)}%
                {ist.current !== null && ist.start !== null && ist.end !== null &&
                  ` — ${(ist.current - ist.start).toLocaleString()} of ${(ist.end - ist.start).toLocaleString()} events`}
                {ist.statusText && <span className="gal-ist-status"> ({ist.statusText})</span>}
              </div>
              <div className="gal-progress">
                <div className="gal-progress-fill" style={{ width: `${ist.pct * 100}%` }} />
              </div>
            </div>
          )}

          {/* Server-log watch: with a percentage from the log the card turns
              determinate; with only phase lines it stays honest about it. */}
          {logWatch && !logWatch.ended && (() => {
            const sum = logWatch.summary;
            const label = sum?.pct != null
              ? `${sum.phase === 'ist-progress' ? 'IST' : 'SST'} ${Math.round(sum.pct * 100)}%` +
                (sum.eventsDone != null && sum.eventsTotal != null
                  ? ` — ${sum.eventsDone.toLocaleString()}/${sum.eventsTotal.toLocaleString()} events`
                  : sum.detail ? ` — ${sum.detail}` : '')
              : sum ? `SST in progress — ${sum.detail}` : 'watching the server log…';
            return (
              <div className="gal-logwatch">
                <div className="gal-ist-label">
                  {label}
                  <span className="gal-ist-status">
                    {' '}· server log{logWatch.path ? '' : ' (locating…)'}
                  </span>
                  <button className="toolbar-btn" style={{ marginLeft: 8 }} onClick={stopLogWatch}>
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
                {logWatch.recent.length > 0 && (
                  <pre className="gal-logwatch-lines"
                       data-tip={logWatch.path ? `tail -F ${logWatch.path}` : 'server error log'}>
                    {logWatch.recent.join('\n')}
                  </pre>
                )}
                {logWatch.notes.map((n, i) => (
                  <div key={i} className="gal-op-cur gal-op-hint">{n}</div>
                ))}
              </div>
            );
          })()}
          {logWatch?.ended && (
            <div className="gal-op-cur gal-op-hint">server-log watch ended ({logWatch.ended})</div>
          )}
          {!logWatch && hasSsh !== null && (
            <div className="gal-logwatch-offer">
              {hasSsh ? (
                <button className="toolbar-btn"
                        data-tip="tail the server's error log over SSH — live SST phases and the real IST percentage (the only source of one)"
                        onClick={() => { if (hasSsh) void startLogWatch(); }}>
                  ⌁ Watch server log
                </button>
              ) : (
                <span className="unavail"
                      data-tip="Add SSH to this connection to watch the server log — the error log carries the SST phase lines and the real IST percentage that SQL cannot report">
                  <button className="toolbar-btn" aria-disabled="true"
                          onClick={() => { if (hasSsh) void startLogWatch(); }}>
                    ⌁ Watch server log
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {snap && findings.length > 0 && (
        <div className="gal-findings">
          {findings.map((f, i) => (
            <div key={i} className={`gal-finding gal-${f.level}`}>
              <div className="gal-finding-title">{f.title}</div>
              <div className="gal-finding-detail">{f.detail}</div>
            </div>
          ))}
        </div>
      )}

      {snap && metricSamples.length >= 2 && (
        <div className="gal-spark-strip" data-tip="Last ~5 minutes, from this view's own polls">
          <div className="gal-spark-item">
            <span className="gal-spark-label">Flow control paused</span>
            <span className="gal-spark-val">{fmtPct(snap.flowControlPaused)}</span>
            <GalSpark points={fcSeries} hot={fcSeries.length > 0 && fcSeries[fcSeries.length - 1] > 0.01} />
          </div>
          <div className="gal-spark-item">
            <span className="gal-spark-label">Apply queue</span>
            <span className="gal-spark-val">{num(snap.localRecvQueue) ?? '—'}</span>
            <GalSpark points={queueSeries} hot={queueSeries.length > 0 && queueSeries[queueSeries.length - 1] > QUEUE_WARN} />
          </div>
          <div className="gal-spark-item">
            <span className="gal-spark-label">Commits/s</span>
            <span className="gal-spark-val">{commitNow === null ? '—' : commitNow < 10 ? commitNow.toFixed(1) : Math.round(commitNow).toLocaleString()}</span>
            <GalSpark points={commitSeries} />
          </div>
        </div>
      )}

      {snap && (
        <>
          {/* The four kv sections + flow control pack into a dense card grid —
              gal-card scopes the tighter spacing so the async tab's
              .repl-section rhythm is untouched. */}
          <div className="gal-cards">
            <div className="gal-card">
              <div className="repl-title">Cluster</div>
              <table className="repl-kv"><tbody>
                {kv('Status', snap.clusterStatus, { health: clusterHealth })}
                {kv('Size', snap.clusterSize === null ? null : `${snap.clusterSize} node${snap.clusterSize === 1 ? '' : 's'}`)}
                {kv('Cluster name', snap.clusterName)}
              </tbody></table>
              {(snap.provider || snap.clusterStateUuid || snap.clusterConfId !== null) && (
                <div className="gal-trivia">
                  {[
                    snap.provider ? `${snap.provider}${snap.providerVersion ? ` ${snap.providerVersion}` : ''}` : null,
                    snap.clusterStateUuid ? `uuid ${snap.clusterStateUuid}` : null,
                    snap.clusterConfId !== null ? `conf ${snap.clusterConfId}` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>

            <div className="gal-card">
              <div className="repl-title">Membership</div>
              <table className="repl-kv"><tbody>
                {kv('This node', snap.nodeName
                  ? `${snap.nodeName}${snap.nodeAddress ? ` (${snap.nodeAddress})` : ''}` : null)}
                {kv('Incoming addresses', snap.incomingAddresses, { mono: true })}
              </tbody></table>
              {membership && (
                <>
                  <button className="gal-exp" aria-expanded={membersOpen}
                          onClick={() => setMembersOpen(v => !v)}>
                    <span className={`gal-chev${membersOpen ? ' open' : ''}`}>▸</span>
                    {membership.rows.length} member{membership.rows.length === 1 ? '' : 's'} (WSREP_INFO)
                  </button>
                  {membersOpen && (
                    <table className="gal-membership">
                      <thead>
                        <tr>
                          {orderMembershipColumns(membership.columns.map(c => c.name)).map(name => (
                            <th key={name}>{name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {membership.rows.map((row, i) => (
                          <tr key={i}>
                            {orderMembershipColumns(membership.columns.map(c => c.name)).map(name => {
                              const idx = membership.columns.findIndex(c => c.name === name);
                              const v = row[idx];
                              return <td key={name} className="repl-mono">{v == null ? '—' : String(v)}</td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </div>

            <div className="gal-card">
              <div className="repl-title">Node state</div>
              <table className="repl-kv"><tbody>
                {kv('Local state', snap.localStateComment, { health: stateHealth(snap.localStateComment) })}
                {kv('Ready', snap.ready, { health: onOffHealth(snap.ready) })}
                {kv('Connected', snap.connected, { health: onOffHealth(snap.connected) })}
              </tbody></table>
            </div>

            <div className="gal-card">
              <div className="repl-title">Replication progress</div>
              <table className="repl-kv"><tbody>
                {kv('Last committed', num(snap.lastCommitted), { mono: true })}
                {kv('Certification failures', num(snap.localCertFailures), {
                  health: snap.localCertFailures ? 'warn' : null, mono: true,
                })}
                {kv('Apply queue (recv)', num(snap.localRecvQueue), {
                  health: (snap.localRecvQueue ?? 0) > QUEUE_WARN ? 'warn' : null, mono: true,
                })}
                {kv('Send queue', num(snap.localSendQueue), {
                  health: (snap.localSendQueue ?? 0) > QUEUE_WARN ? 'warn' : null, mono: true,
                })}
                {kv('Replicated', bytes(snap.replicatedBytes), { mono: true })}
                {kv('Received', bytes(snap.receivedBytes), { mono: true })}
              </tbody></table>
              {gw && (gw.windowSeqnos !== null || gw.gcacheSizeText !== null) && (
                <div className="gal-gcache">
                  {gw.timeToSstMs !== null && (
                    <>≈ {fmtElapsed(gw.timeToSstMs)} of write-sets cached
                      {gw.gcacheSizeText ? ` (gcache ${gw.gcacheSizeText})` : ''} — a node
                      restarted within that window rejoins by IST, not SST.</>
                  )}
                  {gw.timeToSstMs === null && gw.burnPerSec === 0 && gw.windowSeqnos !== null && (
                    <>Idle cluster: {gw.windowSeqnos.toLocaleString()} seqnos cached
                      {gw.gcacheSizeText ? ` (gcache ${gw.gcacheSizeText})` : ''} — with no
                      writes burning the window, a restarted node rejoins by IST
                      effectively regardless of downtime.</>
                  )}
                  {gw.timeToSstMs === null && gw.burnPerSec === null && (
                    <>Collecting burn rate…
                      {gw.windowSeqnos !== null && ` ${gw.windowSeqnos.toLocaleString()} seqnos in the gcache window`}
                      {gw.gcacheSizeText ? ` (gcache ${gw.gcacheSizeText})` : ''} — the
                      IST-window estimate appears once two polls have measured the write rate.</>
                  )}
                  {gw.windowSeqnos === null && gw.gcacheSizeText !== null && (
                    <>gcache {gw.gcacheSizeText} — wsrep_local_cached_downto is not reported
                      on this build, so the IST window cannot be estimated.</>
                  )}
                </div>
              )}
            </div>

            <div className="gal-card">
              <div className="repl-title">Flow control</div>
              <div className="gal-fc">
                <span className={`gal-fc-big ${fcHealth ? `gal-${fcHealth}` : ''}`}>{fmtPct(snap.flowControlPaused)}</span>
                <span className="gal-fc-label">
                  of the time the cluster throttled THIS node (wsrep_flow_control_paused).
                  Anything materially above 0% points at the slowest node or undersized apply threads.
                </span>
              </div>
              <table className="repl-kv"><tbody>
                {kv('FC messages sent', num(snap.flowControlSent), { mono: true })}
                {kv('FC messages received', num(snap.flowControlRecv), { mono: true })}
              </tbody></table>
            </div>
          </div>

          {/* Node operations: rarely touched, so the card collapses to one
              summary line carrying the live values — expanding reveals the
              controls unchanged. */}
          <div className="gal-card gal-ops">
            <button className="gal-ops-head" aria-expanded={opsOpen}
                    onClick={() => setOpsOpen(v => !v)}>
              <span className={`gal-chev${opsOpen ? ' open' : ''}`}>▸</span>
              <span className="repl-title">Node operations</span>
              {isProd && <span className="mnt-prod">prod</span>}
              <span className="gal-ops-summary">
                {'desync '}
                <span className={statusOn(snap.desync) ? 'gal-warn-text' : ''}>
                  {snap.desync === null ? '—' : statusOn(snap.desync) ? 'ON' : 'OFF'}
                </span>
                {' · maintenance '}
                <span className={(snap.rejectQueries ?? '').toUpperCase() === 'ALL' ? 'gal-warn-text' : ''}>
                  {snap.rejectQueries ?? '—'}
                </span>
                {` · threads ${num(snap.slaveThreads) ?? '—'}`}
                {` · sync_wait ${toggles.syncWait ?? '?'}`}
                {` · dirty_reads ${toggles.dirtyReads === null ? '?' : toggles.dirtyReads ? 'ON' : 'OFF'}`}
              </span>
            </button>
            {opsOpen && (
              <div className="gal-ops-body">
            <div className="gal-ops-note">
              These run SET GLOBAL on THIS node{snap.nodeName ? ` (${snap.nodeName})` : ''} —
              each asks for its own confirmation and every run is audited. Read-only
              sessions and accounts without SUPER are greyed with the reason;
              wsrep_on and pc.bootstrap are deliberately not buttons.
            </div>

            <div className="gal-op-row">
              <span className="gal-op-label">Backup mode (desync)</span>
              <span className={`gal-op-cur ${statusOn(snap.desync) ? 'gal-warn-text' : ''}`}>
                {snap.desync === null ? '—' : statusOn(snap.desync) ? 'ON — out of the flow-control loop' : 'OFF'}
              </span>
              {opButton(desyncOp)}
            </div>

            <div className="gal-op-row">
              <span className="gal-op-label">Maintenance mode</span>
              <span className={`gal-op-cur ${(snap.rejectQueries ?? '').toUpperCase() === 'ALL' ? 'gal-warn-text' : ''}`}>
                {snap.rejectQueries ?? '—'}
              </span>
              {opButton(rejectOp)}
            </div>

            <div className="gal-op-row">
              <span className="gal-op-label">Apply threads</span>
              <span className="gal-op-cur">{num(snap.slaveThreads) ?? '—'}</span>
              <input
                className="td-in gal-threads-in"
                type="number" min={1} max={512}
                value={threadsInput === '' ? String(snap.slaveThreads ?? 1) : threadsInput}
                onChange={e => setThreadsInput(e.target.value)}
                data-tip="1..512 — the documented fix for a persistent apply backlog (see Apply queue above)"
              />
              {opButton(threadsOp, `Set ${threadsDraft}`)}
            </div>

            <div className="gal-op-row">
              <span className="gal-op-label">gcache freeze</span>
              <span className="gal-op-cur gal-op-hint">prepare for planned restart (IST instead of SST)</span>
              {opButton(freezeOp)}
            </div>

            <div className="gal-op-row">
              <span className="gal-op-label">Evict node</span>
              <input
                className="td-in gal-evict-in"
                value={evictUuid}
                placeholder="member node UUID (8-4-4-4-12 hex)"
                spellCheck={false}
                onChange={e => setEvictUuid(e.target.value)}
                data-tip={snap.evsEvictList
                  ? `Already evicted, pending restart: ${snap.evsEvictList}`
                  : 'The UUID of the MEMBER to evict — see the membership table above when the WSREP_INFO plugin is installed'}
                list={`gal-evict-uuids-${sessionId}`}
              />
              {memberUuids.length > 0 && (
                <datalist id={`gal-evict-uuids-${sessionId}`}>
                  {memberUuids.map(u => <option key={u} value={u} />)}
                </datalist>
              )}
              {evictUuid.trim() && !evictOp
                ? <span className="gal-op-cur gal-op-hint">not a UUID</span>
                : opButton(evictOp)}
            </div>

            {pending && (
              <div className="gal-op-confirm">
                <div className="gal-op-risk">{pending.risk}</div>
                <pre className="mnt-bulk-sql">{pending.sql}</pre>
                <div className="mnt-run">
                  {pending.confirmWord && (
                    <label className="mnt-confirm">
                      <span>Type <b>{pending.confirmWord}</b> to enable</span>
                      <input value={confirmText} spellCheck={false}
                             onChange={e => setConfirmText(e.target.value)} />
                    </label>
                  )}
                  <div style={{ flex: 1 }} />
                  <button className="toolbar-btn"
                          onClick={() => { setPending(null); setConfirmText(''); }}>
                    Cancel
                  </button>
                  <button
                    className="toolbar-btn mnt-danger"
                    disabled={opBusy || (!!pending.confirmWord && confirmText.trim().toUpperCase() !== pending.confirmWord)}
                    onClick={() => { if (!opUnavailable(pending, gate)) void runOp(pending); }}
                  >
                    {opBusy ? 'Running…' : `Run: ${pending.label}`}
                  </button>
                </div>
              </div>
            )}

            {opResults.length > 0 && (
              <div className="mnt-results">
                {opResults.map((r, i) => (
                  <div key={i} className={`mnt-result${r.ok ? '' : ' bad'}`}>
                    <span className="mnt-result-table">{r.sql}</span>
                    <span className="mnt-result-msg">{r.message}{r.ms > 0 ? ` · ${fmtDuration(r.ms)}` : ''}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="gal-op-sess">
              <span className="gal-op-label">This session</span>
              <label className="gsp-check"
                     data-tip="Causal reads: wait until this node has applied everything the cluster committed before answering reads. Applies to this session's pooled connections; a freshly opened pooled connection starts at the server default.">
                <input type="checkbox"
                  checked={toggles.syncWait !== null && (toggles.syncWait & 1) !== 0}
                  onChange={e => void setToggle(syncWaitSql(e.target.checked))} />
                causal reads (wsrep_sync_wait=1)
              </label>
              <label className="gsp-check"
                     data-tip="Allow reads while the node is not ready (a mid-transfer joiner whose port answers). Session scope, no grant needed.">
                <input type="checkbox"
                  checked={toggles.dirtyReads === true}
                  onChange={e => void setToggle(dirtyReadsSql(e.target.checked))} />
                dirty reads (wsrep_dirty_reads)
              </label>
              <span className="gal-op-cur gal-op-hint">
                {toggles.syncWait === null && toggles.dirtyReads === null
                  ? 'reading current values…'
                  : `now: sync_wait=${toggles.syncWait ?? '?'}, dirty_reads=${toggles.dirtyReads === null ? '?' : toggles.dirtyReads ? 'ON' : 'OFF'}`}
              </span>
            </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
