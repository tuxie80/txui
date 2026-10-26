import { errorDisplay, isCancelled } from '../utils/appError';
import { confirmDialog, promptDialog } from '../utils/appDialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { ConnectionConfig, PingResult, Session } from '../types';
import { ConnectionsStore } from '../store/connections';
import { notifyConnectFailed } from '../store/notify';
import { getFolderMeta, setFolderMeta, renameFolderMeta, useFolderMetaStore } from '../store/folderMeta';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { isFavorite, toggleFavorite, favoriteIds, pruneFavorites, useConnFavorites } from '../store/connFavorites';
import { EngineLogo } from './engineLogos';
import { withDeadline, connectDeadlineMs, DeadlineError } from '../utils/withDeadline';
import { stagedDeadlineMs, stagedToPing } from '../utils/connDiag';
import type { StagedConnectResult } from '../utils/connDiag';
import { ConnDiagChecklist } from './ConnDiagChecklist';
import { configToConnectionUrl } from '../utils/connUrl';
import { isEncryptedExport } from '../utils/connExport';
import { LocalDiscovery } from './LocalDiscovery';
import { getPref, PREFS } from '../store/preferences';
import { shortcuts } from '../utils/platform';
import { labelsOf, visibleLabels, matchesLabelSearch } from '../utils/labels';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

interface Props {
  sessions: Session[];
  onNewConnection: (group?: string, prefill?: Partial<ConnectionConfig>) => void;
  onEditConnection: (config: ConnectionConfig) => void;
  onOpenSession: (session: Session) => void;
  onOpenMultiExec: () => void;
  onOpenAudit: () => void;
  onOpenCompare: () => void;
  onOpenDump: () => void;
  onOpenReplicaSet: (folderPath: string) => void;
  activeUtility: string | null;
  onHide: () => void;
  onDisconnect: (connectionId: string) => void;
  activeSessionId: string | null;
}

interface ConnState {
  config: ConnectionConfig;
  /** disconnected = WAS connected this app run, now closed → red dot */
  status: 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';
  ping?: PingResult;
  /** The last staged diagnostics run (Test / Diagnose) — the checklist. */
  diag?: StagedConnectResult | null;
  /** A Diagnose run is in flight for this row. */
  diagBusy?: boolean;
}

/** Why a connected row is amber: the keepalive ping failed, or the backend
 *  reported the SSH tunnel under the session died (conn:tunnel-lost). */
interface Unreachable {
  kind: 'ping' | 'tunnel';
  detail?: string;
}

/** Nested folder tree built from `/`-separated group paths. */
interface FolderNode {
  path: string;                       // full path ("prod/eu")
  name: string;                       // last segment ("eu")
  children: Map<string, FolderNode>;
  items: ConnState[];
}

function buildTree(conns: ConnState[]): FolderNode {
  const root: FolderNode = { path: '', name: '', children: new Map(), items: [] };
  for (const c of conns) {
    const path = (c.config.group ?? '').split('/').map(s => s.trim()).filter(Boolean);
    let node = root;
    for (const seg of path) {
      const p = node.path ? `${node.path}/${seg}` : seg;
      if (!node.children.has(seg)) {
        node.children.set(seg, { path: p, name: seg, children: new Map(), items: [] });
      }
      node = node.children.get(seg)!;
    }
    node.items.push(c);
  }
  const sortNode = (n: FolderNode) => {
    n.items.sort((a, b) => a.config.name.localeCompare(b.config.name));
    n.children = new Map([...n.children.entries()].sort(([a], [b]) => a.localeCompare(b)));
    for (const child of n.children.values()) sortNode(child);
  };
  sortNode(root);
  return root;
}

function countItems(n: FolderNode): number {
  let total = n.items.length;
  for (const c of n.children.values()) total += countItems(c);
  return total;
}

const COLLAPSE_KEY = 'dbgui.connCollapsed';

const TAG_PALETTE = ['#4da8ff', '#4caf73', '#e0b050', '#50c8c8', '#b06ce0', '#e07a9e', '#e0894a', '#7a8aa0'];
function tagColor(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

// Engine identity comes from the brand marks in engineLogos.tsx rather than
// emoji: emoji render differently per platform/font and carry no brand colour,
// which made MySQL and PostgreSQL rows hard to tell apart at a glance.

export function Sidebar({ sessions, onNewConnection, onEditConnection, onOpenSession, onOpenMultiExec, onOpenAudit, onOpenCompare, onOpenDump, onOpenReplicaSet, activeUtility, onHide, onDisconnect, activeSessionId }: Props) {
  const [conns, setConns] = useState<ConnState[]>([]);
  // Latest rows for event handlers (dbgui:connect) that run outside render.
  const connsRef = useRef<ConnState[]>([]);
  useEffect(() => { connsRef.current = conns; }, [conns]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cs: ConnState } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; node: FolderNode } | null>(null);
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
  const [moveDlg, setMoveDlg] = useState<ConnState | null>(null);
  // WKWebView has no window.prompt — folder name/rename go through this modal
  const [nameDlg, setNameDlg] = useState<{ title: string; initial: string; apply: (v: string) => void } | null>(null);
  const [nameVal, setNameVal] = useState('');
  useEffect(() => {
    if (!moveDlg && !nameDlg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMoveDlg(null); setNameDlg(null); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [moveDlg, nameDlg]);
  const [moveTarget, setMoveTarget] = useState('');
  const [filter, setFilter] = useState('');
  // Drag-and-drop: move a connection into a folder by dragging its row onto a
  // folder header (or the empty area = top level).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropPath, setDropPath] = useState<string | null>(null);
  const dropOnFolder = (path: string) => {
    const cs = conns.find(c => c.config.id === dragId);
    setDragId(null); setDropPath(null);
    if (cs && (cs.config.group ?? '') !== path) void moveToFolder(cs, path);
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Which row's failure detail is expanded (the "failed" chip toggles it). */
  const [errDetailId, setErrDetailId] = useState<string | null>(null);
  /** connectionId → the in-flight connect/test attempt (start time + what it
   *  is — only a connect is cancellable, so only a connect gets the ✕). */
  const [attempts, setAttempts] = useState<Record<string, { at: number; kind: 'connect' | 'test' }>>({});
  /** Re-render once a second while anything is connecting, to move the timer. */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Object.keys(attempts).length === 0) return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [attempts]);
  useFolderMetaStore(); // re-render when folder color/note changes
  useConnFavorites();   // re-render when favorites / recent change
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); }
    catch { return new Set(); }
  });
  const toggleFolder = (path: string) => setCollapsed(prev => {
    const n = new Set(prev);
    if (n.has(path)) n.delete(path); else n.add(path);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...n])); } catch { /* quota */ }
    return n;
  });

  // Red-dot semantics: a connection that HAD live sessions and now has none
  // was disconnected (last tab closed / explicit disconnect) — mark it red.
  const prevConnectedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(sessions.map(s => s.connectionId));
    const dropped = [...prevConnectedRef.current].filter(id => !now.has(id));
    prevConnectedRef.current = now;
    if (dropped.length > 0) {
      setConns(prev => prev.map(c =>
        dropped.includes(c.config.id) ? { ...c, status: 'disconnected' } : c));
      // A closed session is "disconnected", not "unreachable" — the amber
      // state belongs to live sessions only.
      setUnreachable(prev => {
        const out = { ...prev };
        for (const id of dropped) delete out[id];
        return out;
      });
    }
  }, [sessions]);

  useEffect(() => {
    const load = () => ConnectionsStore.list().then(cfgs => {
      pruneFavorites(new Set(cfgs.map(c => c.id)));
      setConns(prev => {
        const byId = new Map(prev.map(c => [c.config.id, c]));
        return cfgs.map(config => {
          const old = byId.get(config.id);
          // A save/delete reload must not lose an in-flight connect or the
          // failure it produced — only the config underneath may have changed.
          return old && old.status !== 'idle'
            ? { ...old, config }
            : { config, status: 'idle' as const };
        });
      });
    });
    load();
    // Re-load after save/delete from the connection form
    window.addEventListener('dbgui:connections-changed', load);
    return () => window.removeEventListener('dbgui:connections-changed', load);
  }, []);

  // Auto-connect (and any other out-of-sidebar connect request) goes through
  // the SAME status machine as a double-click: the red dot, the elapsed
  // counter, the notification. Before this, an auto-connect failure was one
  // log line and nothing else.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ connectionId: string }>).detail;
      if (!d?.connectionId) return;
      const found = connsRef.current.find(c => c.config.id === d.connectionId);
      if (found) { void handleConnect(found); return; }
      // The list may not have loaded yet (auto-connect fires at startup) —
      // fetch the config and connect with a fresh row state.
      void ConnectionsStore.list().then(list => {
        const cfg = list.find(c => c.id === d.connectionId);
        if (cfg) void handleConnect({ config: cfg, status: 'idle' });
      }).catch(() => {});
    };
    window.addEventListener('dbgui:connect', on);
    return () => window.removeEventListener('dbgui:connect', on);
    // Mount-only: reads state through connsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDelete(state: ConnState) {
    // Name what stays behind: deleting the config does not close sessions
    // already open on it, and finding that out later reads as a bug.
    const openNow = sessions.filter(s => s.connectionId === state.config.id);
    const openNote = openNow.length > 0
      ? ` ${openNow.length} session${openNow.length === 1 ? '' : 's'} (${openNow.map(s => s.connectionName).join(', ')}) ${openNow.length === 1 ? 'is' : 'are'} still open on it — deleting does not disconnect them; they keep running until closed.`
      : '';
    if (!await confirmDialog(`Delete connection "${state.config.name}"? The stored password is removed too.${openNote}`, { danger: true, okLabel: 'Delete' })) return;
    await ConnectionsStore.delete(state.config.id);
    setConns(prev => prev.filter(c => c.config.id !== state.config.id));
  }

  /** Connection-lifecycle log line (W5.0): App's listener writes it to the
   *  session log — the explicit sessionId when one is in scope, else the
   *  active session's. */
  function logConn(level: 'info' | 'ok' | 'err', msg: string, sessionId?: string) {
    window.dispatchEvent(new CustomEvent('dbgui:conn-log', { detail: { level, msg, sessionId } }));
  }

  /**
   * A connect that never answers used to leave the row amber forever: the
   * backend had no default timeout, so an unreachable host sat on the OS's
   * SYN retries. The backend now bounds it, and the UI bounds it again —
   * because "connecting" with no elapsed time and no end is indistinguishable
   * from the app being broken. The deadline itself is shared with the form's
   * Test button (utils/withDeadline: connectDeadlineMs).
   */
  /** connectionId → attempt — mirrored in a ref so a second click in the
   *  same render batch still sees the in-flight attempt. */
  const attemptsRef = useRef<Record<string, { at: number; kind: 'connect' | 'test' }>>({});
  function beginAttempt(id: string, kind: 'connect' | 'test') {
    attemptsRef.current = { ...attemptsRef.current, [id]: { at: Date.now(), kind } };
    setAttempts(attemptsRef.current);
  }
  function endAttempt(id: string) {
    if (!(id in attemptsRef.current)) return;
    const next = { ...attemptsRef.current };
    delete next[id];
    attemptsRef.current = next;
    setAttempts(next);
  }

  async function handleConnect(state: ConnState) {
    const id = state.config.id;
    // Double-connect guard: a second click while the first is still in flight
    // used to fire a second open_connection — two pools, two tunnels, and a
    // status machine that no longer knew which answer belonged to which click.
    if (id in attemptsRef.current) return;
    setConns(prev => {
      // An event-driven connect (auto-connect, palette) can name a connection
      // the list has not loaded yet — add the row so the status is visible.
      const rows = prev.some(c => c.config.id === id) ? prev : [...prev, state];
      return rows.map(c => c.config.id === id ? { ...c, status: 'connecting' } : c);
    });
    beginAttempt(id, 'connect');
    logConn('info', `Connecting to ${state.config.name}…`);
    const started = Date.now();
    try {
      const sessionId = await withDeadline(
        ConnectionsStore.open(id), connectDeadlineMs(state.config));
      const session: Session = {
        connectionId: id,
        sessionId,
        connectionName: state.config.name,
        engine: state.config.engine,
        environment: state.config.environment,
        readOnly: state.config.read_only,
        color: state.config.color,
        filePath: state.config.file_path,
      };
      setConns(prev => prev.map(c => c.config.id === id ? { ...c, status: 'connected' } : c));
      logConn('ok', `Connected to ${state.config.name}`, sessionId);
      onOpenSession(session);
    } catch (err) {
      // The ✕ on the connecting badge (W3.2): the user stopped this attempt —
      // an aborted state, not a failure. No red dot, no notification, no
      // orphan sweep (the backend reaper drops a late session itself).
      if (isCancelled(err)) {
        setConns(prev => prev.map(c => c.config.id === id ? { ...c, status: 'idle' } : c));
        logConn('info', `${state.config.name} — connect cancelled`);
        return;
      }
      const secs = Math.round((Date.now() - started) / 1000);
      const msg = `${errorDisplay(err)} (after ${secs}s)`;
      // Back to a resting state that says what happened — never left amber.
      setConns(prev => prev.map(c =>
        c.config.id === id ? { ...c, status: 'error', ping: { ok: false, latency_ms: secs * 1000, server_version: null, error: msg } } : c
      ));
      logConn('err', `${state.config.name} — ${msg}`);
      // And say it out loud — the red dot alone was the whole feedback before.
      void notifyConnectFailed(state.config.name, errorDisplay(err));
      if (err instanceof DeadlineError) {
        // The UI gave up but the backend kept opening — a slow connect can
        // still land a live pool + tunnel that nobody holds. Best-effort
        // cleanup of any session that arrived since this attempt started.
        void invoke('close_orphaned_connection', {
          connectionId: id, attemptAgeMs: Date.now() - started,
        }).catch(() => {});
      }
    } finally {
      endAttempt(id);
    }
  }

  async function handleTest(state: ConnState) {
    const id = state.config.id;
    setConns(prev => prev.map(c => c.config.id === id ? { ...c, status: 'connecting' } : c));
    beginAttempt(id, 'test');
    logConn('info', `Testing ${state.config.name}…`);
    const started = Date.now();
    let ping: PingResult;
    let diag: StagedConnectResult | null = null;
    try {
      // Staged diagnostics (W3.1): a failed run is DATA (verdict 'fail'), not
      // a rejection — the checklist shows which of the six stages broke.
      diag = await withDeadline(
        ConnectionsStore.testStaged(state.config), stagedDeadlineMs(state.config));
      ping = stagedToPing(diag);
    } catch (err) {
      const secs = Math.round((Date.now() - started) / 1000);
      ping = { ok: false, latency_ms: secs * 1000, server_version: null,
               error: `${errorDisplay(err)} (after ${secs}s)` };
    } finally {
      endAttempt(id);
    }
    setConns(prev => prev.map(c =>
      c.config.id === id ? { ...c, status: ping.ok ? 'idle' : 'error', ping, diag } : c
    ));
    // Open the detail row so the stage checklist is what the answer looks
    // like — on failure it names the stage that broke, on success it carries
    // the dial/TLS/auth split (W3.3).
    setErrDetailId(id);
    if (ping.ok) logConn('ok', `${state.config.name} OK${ping.server_version ? ` — ${ping.server_version}` : ''} (${ping.latency_ms}ms)`);
    else logConn('err', `${state.config.name} — ${ping.error ?? 'failed'}`);
  }

  /** "Diagnose" on a failed connect / amber unreachable row: run the staged
   *  test and show the checklist inline (W3.1 failure reporting, W4.1). Does
   *  not touch the status machine — the row keeps saying what it said. */
  async function handleDiagnose(state: ConnState) {
    const id = state.config.id;
    if (state.diagBusy) return;
    setErrDetailId(id);
    setConns(prev => prev.map(c => c.config.id === id ? { ...c, diagBusy: true } : c));
    try {
      const diag = await withDeadline(
        ConnectionsStore.testStaged(state.config), stagedDeadlineMs(state.config));
      setConns(prev => prev.map(c => c.config.id === id ? { ...c, diag, diagBusy: false } : c));
      logConn(diag.verdict === 'ok' ? 'ok' : 'err', `Diagnose ${state.config.name} — ${diag.verdict} (${diag.total_ms}ms)`);
    } catch (err) {
      setConns(prev => prev.map(c => c.config.id === id ? { ...c, diagBusy: false } : c));
      logConn('err', `Diagnose ${state.config.name} — ${errorDisplay(err)}`);
    }
  }

  /** Duplicate config + keychain password under a new id (roadmap D3). */
  async function handleDuplicate(state: ConnState) {
    try {
      await invoke('duplicate_connection', { id: state.config.id });
      window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
      logConn('ok', `Duplicated ${state.config.name}`);
    } catch (err) {
      logConn('err', `Duplicate failed — ${errorDisplay(err)}`);
    }
  }

  /** Export all connections to a JSON file. The default carries configs only,
   *  never secrets (unchanged); opt-in, the secrets come along inside a
   *  passphrase-protected envelope (W5.2, TablePlus/Compass model). */
  async function handleExport() {
    try {
      const path = await save({
        defaultPath: 'txui-connections.json',
        filters: [{ name: 'TxUI connections', extensions: ['json'] }],
      });
      if (!path) return;
      // Enter = OK = the default (configs only, no secrets). "Include
      // passwords…" is the explicit click, gated again by the passphrase
      // prompt (Escape there aborts before anything is written).
      const configsOnly = await confirmDialog(
        'Include stored passwords in the export?\n\n'
        + 'Configs only (default): no secrets travel; recipients set their own passwords.\n'
        + 'Include passwords: everything travels, inside an envelope protected by a passphrase you choose next.',
        { title: 'Export connections', okLabel: 'Configs only (default)', cancelLabel: 'Include passwords…' });
      if (!configsOnly) {
        const passphrase = await promptDialog(
          'Passphrase for this export — asked for again at import:', '',
          { title: 'Encrypt export', okLabel: 'Export' });
        // An empty passphrase is not an export anyone can trust — abort.
        if (!passphrase) { logConn('info', 'Export cancelled — no passphrase given'); return; }
        const payload = await invoke<string>('export_connections_encrypted', { ids: null, passphrase });
        await invoke('write_text_file', { path, contents: payload });
        logConn('ok', `Exported connections to ${path} — encrypted, passwords included`);
      } else {
        const json = await ConnectionsStore.exportAll();
        await invoke('write_text_file', { path, contents: json });
        logConn('ok', `Exported connections to ${path}`);
      }
    } catch (err) {
      logConn('err', `Export failed — ${errorDisplay(err)}`);
    }
  }

  /** Import an export envelope; fresh ids are assigned. The encrypted
   *  envelope (W5.2, detected by shape) asks for its passphrase and brings
   *  the passwords along; the plain one never carries secrets. */
  async function handleImport() {
    try {
      const path = await open({ multiple: false, filters: [{ name: 'TxUI connections', extensions: ['json'] }] });
      if (!path || typeof path !== 'string') return;
      const json = await invoke<string>('read_text_file', { path });
      let n: number;
      if (isEncryptedExport(json)) {
        const passphrase = await promptDialog(
          'This export is passphrase-protected. Passphrase:', '',
          { title: 'Import connections', okLabel: 'Import' });
        if (!passphrase) { logConn('info', 'Import cancelled — no passphrase given'); return; }
        n = await invoke<number>('import_connections_encrypted', { payload: json, passphrase });
        window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
        logConn('ok', `Imported ${n} connection${n === 1 ? '' : 's'} — passwords included`);
      } else {
        n = await ConnectionsStore.importJson(json);
        window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
        logConn('ok', `Imported ${n} connection${n === 1 ? '' : 's'} — passwords are not imported, set them per connection`);
      }
    } catch (err) {
      logConn('err', `Import failed — ${errorDisplay(err)}`);
    }
  }

  // Import connections discovered in the local tool config files
  // (~/.pgpass, ~/.pg_service.conf, ~/.my.cnf). Passwords are never imported;
  // each lands in an "Imported/*" folder for review.
  async function handleImportTools() {
    try {
      const found = await invoke<ConnectionConfig[]>('import_tool_configs');
      if (!found.length) {
        logConn('info', 'No connections found in ~/.pgpass, ~/.pg_service.conf or ~/.my.cnf');
        return;
      }
      for (const cfg of found) await ConnectionsStore.save(cfg);
      window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
      logConn('ok', `Imported ${found.length} connection${found.length === 1 ? '' : 's'} from local tool configs — set passwords per connection`);
    } catch (err) {
      logConn('err', `Import from tools failed — ${errorDisplay(err)}`);
    }
  }

  // Latency badges: ping every OPEN session every 30 s (paused while hidden).
  const [latencies, setLatencies] = useState<Record<string, number>>({});
  // W4.1 health: a connection whose sessions stopped answering goes amber
  // ("unreachable") instead of silently losing the badge while the dot stays
  // green; the next answered ping turns it green again.
  const [unreachable, setUnreachable] = useState<Record<string, Unreachable>>({});
  useEffect(() => {
    if (sessions.length === 0) { setLatencies({}); setUnreachable({}); return; }
    const tick = async () => {
      if (document.visibilityState === 'hidden') return;
      const next: Record<string, number> = {};
      const up = new Set<string>();
      const down = new Set<string>();
      await Promise.all(sessions.map(async s => {
        const ping = async (): Promise<number | null> => {
          try { return await ConnectionsStore.sessionPing(s.sessionId); }
          catch { return null; }
        };
        let ms = await ping();
        // Keepalive: a failed ping usually means the pooled socket died while
        // asleep. Retry once — sqlx re-establishes it — so the connection is
        // warm again before the next real query, and the blip self-heals.
        if (ms == null && getPref(PREFS.keepAlive)) ms = await ping();
        if (ms == null) down.add(s.connectionId);
        else { next[s.connectionId] = ms; up.add(s.connectionId); }
      }));
      setLatencies(next);
      setUnreachable(prev => {
        const out = { ...prev };
        // Any answered session on the connection clears it — recovery to green.
        for (const id of up) delete out[id];
        // Only when NO session answered; a tunnel-lost report (more specific)
        // already there is kept rather than rewritten as a ping failure.
        for (const id of down) if (!up.has(id)) out[id] = out[id] ?? { kind: 'ping' };
        return out;
      });
    };
    tick();
    const t = setInterval(tick, 30_000);
    // Re-warm pools the moment the window comes back (post-sleep / VPN blip).
    const onResume = () => { if (getPref(PREFS.keepAlive) && document.visibilityState === 'visible') void tick(); };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [sessions]);

  // W4.5/W4.1: the backend watches tunnel child processes and reports a death
  // mid-session here — before it, a dead tunnel surfaced only as the next
  // query's error. Mark the row amber; the ping loop restores green (or would
  // fail too, confirming the state).
  useEffect(() => {
    const un = listen<{ session_id: string; connection_id: string; reason: string }>(
      'conn:tunnel-lost', e => {
        const p = e.payload;
        if (!p?.connection_id) return;
        setUnreachable(prev => ({ ...prev, [p.connection_id]: { kind: 'tunnel', detail: p.reason } }));
        logConn('err', `SSH tunnel lost${p.reason ? ` — ${p.reason}` : ''}`);
      });
    return () => { un.then(f => f()); };
  }, []);

  /** All folder paths in use — feeds the move-dialog datalist. */
  const allFolders = useMemo(() => {
    const out = new Set<string>();
    for (const c of conns) {
      const parts = (c.config.group ?? '').split('/').map(x => x.trim()).filter(Boolean);
      for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
    }
    return [...out].sort();
  }, [conns]);

  async function moveToFolder(cs: ConnState, target: string) {
    const group = target.split('/').map(x => x.trim()).filter(Boolean).join('/') || null;
    await ConnectionsStore.save({ ...cs.config, group });
    window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
  }

  /** Rename a folder path — rewrites the group prefix of every contained connection. */
  async function applyRenameFolder(node: FolderNode, next: string) {
    const clean = next.split('/').map(x => x.trim()).filter(Boolean).join('/');
    for (const c of conns) {
      const g = c.config.group ?? '';
      if (g === node.path || g.startsWith(node.path + '/')) {
        const rest = g.slice(node.path.length);
        const group = (clean + rest).split('/').filter(Boolean).join('/') || null;
        await ConnectionsStore.save({ ...c.config, group });
      }
    }
    // The folder's own attributes — colour, note, replica-set flag, designated
    // primary — are keyed by path, so they have to move with it. Without this,
    // renaming a folder silently threw all of that away.
    renameFolderMeta(node.path, clean);
    window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
  }

  const tree = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const visible = q
      ? conns.filter(c =>
          c.config.name.toLowerCase().includes(q)
          || (c.config.group ?? '').toLowerCase().includes(q)
          || (c.config.host ?? '').toLowerCase().includes(q)
          || (c.config.notes ?? '').toLowerCase().includes(q)
          // Hidden labels are searchable on purpose: hidden means "spends no
          // chip", never "cannot be found".
          || matchesLabelSearch(c.config, q))
      : conns;
    return buildTree(visible);
  }, [conns, filter]);
  const filtering = filter.trim().length > 0;

  // W5.8 keyboard navigation: the rows in RENDER order (a collapsed folder's
  // contents are not rendered, so they are not reachable by arrows either).
  const visibleFlat = useMemo(() => {
    const out: ConnState[] = [];
    const walk = (n: FolderNode) => {
      if (n.path !== '' && !filtering && collapsed.has(n.path)) return;
      out.push(...n.items);
      for (const child of n.children.values()) walk(child);
    };
    walk(tree);
    return out;
  }, [tree, filtering, collapsed]);

  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  /** Arrow keys on the list / Enter to connect; printable keys type into the
   *  filter (the focus follows, so the box owns the text from then on). */
  function onListKey(e: React.KeyboardEvent) {
    const ids = visibleFlat.map(c => c.config.id);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (ids.length === 0) return;
      const i = ids.indexOf(selectedId ?? '');
      const next = i === -1
        ? (e.key === 'ArrowDown' ? ids[0] : ids[ids.length - 1])
        : ids[(i + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length];
      setSelectedId(next);
    } else if (e.key === 'Enter') {
      const cs = visibleFlat.find(c => c.config.id === selectedId);
      if (cs) { e.preventDefault(); void handleConnect(cs); }
    } else if (e.key === 'Escape' && filter) {
      e.preventDefault();
      setFilter('');
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setFilter(f => f + e.key);
      filterRef.current?.focus();
    }
  }

  /** Keys while the FILTER box has focus: ArrowDown steps into the list,
   *  Enter connects the selected (or first visible) row. */
  function onFilterKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      const first = visibleFlat[0];
      if (first) { e.preventDefault(); setSelectedId(first.config.id); listRef.current?.focus(); }
    } else if (e.key === 'Enter') {
      const cs = visibleFlat.find(c => c.config.id === selectedId) ?? visibleFlat[0];
      if (cs) { e.preventDefault(); void handleConnect(cs); }
    } else if (e.key === 'Escape' && filter) {
      setFilter('');
    }
  }

  // Keep the keyboard-selected row in view — selection is also set by click,
  // and scrollIntoView({block:'nearest'}) is a no-op when already visible.
  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector('.conn-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // Pool occupancy (W4.4 surface) in the expanded health/diagnostics row of a
  // CONNECTED connection: how busy is this pool right now. null (non-sqlx
  // engines) renders nothing at all — there is no pool to describe.
  const [poolStats, setPoolStats] = useState<Record<string, { size: number; idle: number; in_use: number } | null>>({});
  useEffect(() => {
    if (!errDetailId) return;
    const s = sessions.find(x => x.connectionId === errDetailId);
    if (!s) return;
    let alive = true;
    ConnectionsStore.sessionPoolStats(s.sessionId)
      .then(r => { if (alive) setPoolStats(prev => ({ ...prev, [errDetailId]: r })); })
      .catch(() => {});
    return () => { alive = false; };
  }, [errDetailId, sessions]);

  function renderConn(cs: ConnState, depth: number) {
    const connected = sessions.some(s => s.connectionId === cs.config.id);
    // W4.1: amber while a connected row's keepalive fails (or its tunnel died).
    const un = connected ? unreachable[cs.config.id] : undefined;
    const attempt = attempts[cs.config.id];
    const color = cs.config.color;
    return (
      <div key={cs.config.id}
        className={`conn-item ${selectedId === cs.config.id ? 'selected' : ''}`}
        style={{ marginLeft: depth * 14 }}>
        <div
          className={`conn-item-header${dragId === cs.config.id ? ' dragging' : ''}`}
          draggable
          onDragStart={e => { setDragId(cs.config.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => { setDragId(null); setDropPath(null); }}
          style={color ? { borderLeft: `3px solid ${color}`, background: `${color}1a` } : undefined}
          title={`${cs.config.name} — ${cs.config.host ?? 'localhost'}:${cs.config.port ?? ''}${cs.config.notes ? ' — ' + cs.config.notes : ''} · double-click to connect · right-click for actions · drag to a folder`}
          onClick={() => setSelectedId(cs.config.id)}
          onDoubleClick={() => handleConnect(cs)}
          onContextMenu={e => {
            // Always: select this row, suppress the native menu, open ours.
            e.preventDefault();
            e.stopPropagation();
            setSelectedId(cs.config.id);
            setCtxMenu({ x: e.clientX, y: e.clientY, cs });
          }}
        >
          <span className="engine-icon"><EngineLogo engine={cs.config.engine} size={14} /></span>
          {cs.config.environment && (
            <span className={`env-chip env-${cs.config.environment}`}>
              {cs.config.environment.toUpperCase()}
            </span>
          )}
          <span className="conn-name">{cs.config.name}</span>
          {getFolderMeta(cs.config.group ?? '').primaryId === cs.config.id && (
            <span className="rs-primary" title="Replica-set primary">★</span>
          )}
          {cs.config.read_only && <span className="conn-ro" title="Read-only">🔒</span>}
          {/* Visible labels only. A label marked hidden still groups servers
              for the 🏷 Fleet checks and still matches the filter — it just
              does not compete for width with the ones a person reads. */}
          {visibleLabels(labelsOf(cs.config)).slice(0, 3).map(l => (
            <span key={l.name} className="conn-tag" style={{
              color: tagColor(l.name),
              borderColor: tagColor(l.name),
              background: `${tagColor(l.name)}1f`,
            }}>{l.name}</span>
          ))}
          {connected && !un && latencies[cs.config.id] != null && (
            <span className="conn-latency" title="Round-trip latency (session ping, refreshed every 30 s)">
              {latencies[cs.config.id]} ms
            </span>
          )}
          {/* The conn-list suppresses hover tooltips (data-notip), so the
              reason is a labelled chip, not a title — click runs the staged
              diagnosis inline. */}
          {un && (
            <button type="button" className="conn-unreachable"
              onClick={e => { e.stopPropagation(); void handleDiagnose(cs); }}>
              {un.kind === 'tunnel' ? 'tunnel lost' : 'unreachable'} {errDetailId === cs.config.id ? '▴' : '▾'}
            </button>
          )}
          {cs.status === 'connecting' && attempt != null && (
            <span className="conn-elapsed" title="Waiting for the server to answer">
              {Math.max(0, Math.round((Date.now() - attempt.at) / 1000))}s
              {/* W3.2: a connect can be cancelled; a test is short and cannot
                  (cancel_connect targets open_connection only). */}
              {attempt.kind === 'connect' && (
                <button type="button" className="conn-cancel"
                  title="Cancel this connect attempt"
                  onClick={e => {
                    e.stopPropagation();
                    void ConnectionsStore.cancelConnect(cs.config.id).catch(() => {});
                  }}>
                  ✕
                </button>
              )}
            </span>
          )}
          {cs.status === 'error' && (
            <button type="button" className="conn-failed"
              title={`${cs.ping?.error ?? 'failed'} — click for details`}
              onClick={e => {
                e.stopPropagation();
                setErrDetailId(errDetailId === cs.config.id ? null : cs.config.id);
              }}>
              failed {errDetailId === cs.config.id ? '▴' : '▾'}
            </button>
          )}
          <span
            className={`status-dot status-${un ? 'unreachable' : connected ? 'connected' : cs.status}`}
            title={un
              ? (un.kind === 'tunnel' ? 'SSH tunnel lost' : 'unreachable — last ping failed')
              : connected ? 'connected'
              : cs.status === 'disconnected' ? 'disconnected — last session closed'
              : cs.ping?.error ?? cs.status}
          />
        </div>
        {/* The failure, in full, on demand — the tooltip-only error used to
            truncate the server's actual reason into one hover line. Diagnose
            runs the staged test (W3.1) so a failed connect is one click from
            the exact stage that broke; the same panel carries a Test result. */}
        {errDetailId === cs.config.id && (cs.status === 'error' || cs.diag || un) && (
          <div className="conn-error-detail">
            {cs.status === 'error' && (
              <div className="conn-error-text">{cs.ping?.error ?? 'Connection failed'}</div>
            )}
            {un && (
              <div className="conn-error-text warn">
                {un.kind === 'tunnel'
                  ? `SSH tunnel lost${un.detail ? ` — ${un.detail}` : ''}`
                  : 'unreachable — the last keepalive ping failed'}
              </div>
            )}
            {cs.diag && <ConnDiagChecklist result={cs.diag} />}
            {connected && poolStats[cs.config.id] && (
              <div className="conn-error-text">
                pool: {poolStats[cs.config.id]!.in_use} in use · {poolStats[cs.config.id]!.idle} idle · {poolStats[cs.config.id]!.size} total
              </div>
            )}
            <div className="conn-error-actions">
              {cs.status === 'error' && (<>
                <button type="button"
                  onClick={() => { setErrDetailId(null); void handleConnect(cs); }}>
                  Retry
                </button>
                <button type="button"
                  onClick={() => { setErrDetailId(null); onEditConnection(cs.config); }}>
                  Edit connection
                </button>
              </>)}
              <button type="button" disabled={cs.diagBusy}
                onClick={() => void handleDiagnose(cs)}>
                {cs.diagBusy ? 'Diagnosing…' : cs.diag ? 'Diagnose again' : 'Diagnose'}
              </button>
              <button type="button" onClick={() => setErrDetailId(null)}>Close</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderFolder(node: FolderNode, depth: number): React.ReactNode {
    const folded = !filtering && collapsed.has(node.path);
    return (
      <div key={node.path || 'root'} className="conn-group">
        {node.path && (
          <div
            className={`group-label group-folder${dropPath === node.path ? ' drop-target' : ''}`}
            style={{
              paddingLeft: 8 + (depth - 1) * 14,
              borderLeft: getFolderMeta(node.path).color ? `3px solid ${getFolderMeta(node.path).color}` : undefined,
            }}
            title={getFolderMeta(node.path).note || undefined}
            onDragOver={e => { if (dragId) { e.preventDefault(); e.stopPropagation(); setDropPath(node.path); } }}
            onDragLeave={() => setDropPath(p => (p === node.path ? null : p))}
            onDrop={e => { e.preventDefault(); e.stopPropagation(); dropOnFolder(node.path); }}
            onClick={() => toggleFolder(node.path)}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setFolderMenu({ x: e.clientX, y: e.clientY, node }); }}
          >
            <span className="icon-slot">{folded ? '📁' : '📂'}</span>
            {/* folder-name truncates with an ellipsis; the full path stays in
                the title so a long nested name never loses information */}
            <span className="folder-name" title={node.path}>{node.name}</span>
            {getFolderMeta(node.path).replicaSet && (
              <span className="conn-tag rs-tag" title="Replica set — right-click for the dashboard">🔁 set</span>
            )}
            {getFolderMeta(node.path).note && <span className="conn-tag">{getFolderMeta(node.path).note}</span>}
            <span className="group-count">{countItems(node)}</span>
          </div>
        )}
        {!folded && (
          <>
            {node.items.map(cs => renderConn(cs, depth))}
            {[...node.children.values()].map(child => renderFolder(child, depth + 1))}
          </>
        )}
      </div>
    );
  }

  return (
    <aside
      className="sidebar"
      onContextMenu={e => {
        // rows/folders stopPropagation — reaching here means empty space
        e.preventDefault();
        setBgMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="sidebar-header">
        <div style={{ display: 'flex', gap: 4, width: '100%', justifyContent: 'flex-start' }}>
          <button className="icon-btn"
            title={`New connection… (${SC.newConnection})`}
            onClick={() => onNewConnection()}>+</button>
          <button className={`icon-btn ${activeUtility === 'dump' ? 'active' : ''}`} title="Dump / restore" onClick={onOpenDump}>🗄</button>
          <button className={`icon-btn ${activeUtility === 'compare' ? 'active' : ''}`} title="Compare schemas / instances" onClick={onOpenCompare}>⇆</button>
          <button className={`icon-btn ${activeUtility === 'audit' ? 'active' : ''}`} title="Audit log" onClick={onOpenAudit}>📜</button>
          <button className={`icon-btn ${activeUtility === 'multi-exec' ? 'active' : ''}`} title="Multi-server execution" onClick={onOpenMultiExec}>⚟</button>
        </div>
      </div>

      <input
        ref={filterRef}
        className="conn-filter"
        placeholder="Filter connections… (↑↓ move, Enter connects)"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        onKeyDown={onFilterKey}
      />

      {/* No hover tooltips anywhere in the connections list — the row's own
          text is enough, and a black box popping up on every mouse move over
          the list is noise, not help. `data-notip` suppresses both our tooltip
          and the browser's native `title` one (see utils/tooltip.ts). */}
      <div className="conn-list" data-notip
        ref={listRef}
        tabIndex={0}
        onKeyDown={onListKey}
        onDragOver={e => { if (dragId) { e.preventDefault(); setDropPath(''); } }}
        onDrop={e => { e.preventDefault(); dropOnFolder(''); }}>
        {/* Pinned quick-access: starred connections.
            One-click rows that connect — the 3–4 databases you actually use. */}
        {(() => {
          const byId = new Map(conns.map(c => [c.config.id, c]));
          const favs = favoriteIds().map(id => byId.get(id)).filter((c): c is ConnState => !!c);
          if (!favs.length) return null;
          const quickRow = (cs: ConnState, star: boolean) => (
            <div key={`pin-${cs.config.id}`} className="conn-pin"
              title={`${cs.config.name} — click to connect`}
              onClick={() => handleConnect(cs)}>
              <span className="engine-icon"><EngineLogo engine={cs.config.engine} size={14} /></span>
              <span className="conn-name">{cs.config.name}</span>
              {star && <span className="conn-pin-star">★</span>}
            </div>
          );
          return (
            <div className="conn-pinned">
              {favs.length > 0 && <div className="sidebar-section-label">★ Favorites</div>}
              {favs.map(cs => quickRow(cs, true))}
            </div>
          );
        })()}
        {renderFolder(tree, 0)}

        {conns.length === 0 && (
          <div className="empty-state">
            <p>No connections yet.</p>
            <button className="primary" onClick={() => onNewConnection()}>Add connection</button>
            {/* W5.3: probe this machine's well-known ports and offer what
                answers as one-click, prefilled connection forms. */}
            <LocalDiscovery
              existing={[]}
              onAdd={prefill => onNewConnection(undefined, prefill)}
            />
            {/* Scratch needs no connection at all — the zero-config way to be
                running SQL ten seconds after first launch. */}
            <button className="toolbar-btn" style={{ marginTop: 8 }}
              onClick={() => window.dispatchEvent(new CustomEvent('dbgui:new-scratch'))}>
              🦆 Scratch buffer (no connection needed)
            </button>
          </div>
        )}
      </div>

      {sessions.length > 0 && (
        <div className="open-sessions">
          <div className="sidebar-section-label">Open sessions</div>
          {sessions.map(s => (
            <div
              key={s.sessionId}
              className={`session-item ${s.sessionId === activeSessionId ? 'active' : ''}`}
              onClick={() => onOpenSession(s)}
            >
              <span className="engine-icon"><EngineLogo engine={s.engine} size={14} /></span>
              <span className="session-name">{s.connectionName}</span>
            </div>
          ))}
        </div>
      )}

      {/* Scratch + import/export live in a pinned bottom bar — connection
          upkeep rather than session utilities, so out of the top row. Pinned
          above Hide regardless of list length (conn-list is flex:1). */}
      <div className="sidebar-tools">
        {/* Dispatches the window event — App owns what "open a scratch
            buffer" means (one path for button, palette and Tools menu). */}
        <button className="icon-btn"
          title="New scratch buffer — in-memory DuckDB, no connection needed (paste data, try syntax, query a CSV/Parquet path directly)"
          onClick={() => window.dispatchEvent(new CustomEvent('dbgui:new-scratch'))}>🦆</button>
        <button className="icon-btn" title="Import connections from JSON" onClick={handleImport}>⤓</button>
        <button className="icon-btn" title="Import from ~/.pgpass, ~/.pg_service.conf, ~/.my.cnf" onClick={handleImportTools}>⇲</button>
        <button className="icon-btn" title="Export all connections to JSON (passwords optional, passphrase-protected)" onClick={handleExport}>⤒</button>
      </div>

      {/* Full-width, labelled — the old ◂ icon in the header row read as
          decoration and nobody found it. Sits at the bottom (conn-list is
          flex:1 above it); the collapsed rail's hover accent is the way back. */}
      <button className="sidebar-hide" title={`Hide connections (${SC.sidebar})`} onClick={onHide}>
        ◂ Hide
      </button>
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <ContextMenuItem
            label={isFavorite(ctxMenu.cs.config.id) ? '★ Unfavorite' : '☆ Favorite'}
            onClick={() => { toggleFavorite(ctxMenu.cs.config.id); setCtxMenu(null); }} />
          <ContextMenuItem label="Edit" onClick={() => { onEditConnection(ctxMenu.cs.config); setCtxMenu(null); }} />
          <ContextMenuItem label="Copy name" onClick={() => { navigator.clipboard.writeText(ctxMenu.cs.config.name).catch(() => {}); setCtxMenu(null); }} />
          {/* Shareable shape of the config — secrets are structurally absent
              (configToConnectionUrl has no password field). File engines have
              no URL form, so the item is not offered for them. */}
          {configToConnectionUrl(ctxMenu.cs.config) !== null && (
            <ContextMenuItem label="Copy as URL" onClick={() => {
              const url = configToConnectionUrl(ctxMenu.cs.config);
              if (url) navigator.clipboard.writeText(url).catch(() => {});
              setCtxMenu(null);
            }} />
          )}
          <ContextMenuItem label="Connect" onClick={() => { handleConnect(ctxMenu.cs); setCtxMenu(null); }} />
          {sessions.some(s => s.connectionId === ctxMenu.cs.config.id) && (
            /* W4.2: close every session of this connection and reopen them in
               the same tab slots — App owns the session swap (dbgui:reconnect). */
            <ContextMenuItem label="Reconnect" onClick={() => {
              window.dispatchEvent(new CustomEvent('dbgui:reconnect', { detail: { connectionId: ctxMenu.cs.config.id } }));
              setCtxMenu(null);
            }} />
          )}
          {sessions.some(s => s.connectionId === ctxMenu.cs.config.id) && (
            <ContextMenuItem label="Disconnect" danger onClick={() => { onDisconnect(ctxMenu.cs.config.id); setCtxMenu(null); }} />
          )}
          <ContextMenuItem label="Test" onClick={() => { handleTest(ctxMenu.cs); setCtxMenu(null); }} />
          <ContextMenuItem label="Duplicate" onClick={() => { handleDuplicate(ctxMenu.cs); setCtxMenu(null); }} />
          <ContextMenuItem label="Move to folder…" onClick={() => { setMoveTarget(ctxMenu.cs.config.group ?? ''); setMoveDlg(ctxMenu.cs); setCtxMenu(null); }} />
          {getFolderMeta(ctxMenu.cs.config.group ?? '').replicaSet && (
            getFolderMeta(ctxMenu.cs.config.group ?? '').primaryId === ctxMenu.cs.config.id ? (
              <ContextMenuItem label="★ Unset replica-set primary"
                onClick={() => { setFolderMeta(ctxMenu.cs.config.group ?? '', { primaryId: null }); setCtxMenu(null); }} />
            ) : (
              <ContextMenuItem label="★ Set as replica-set primary"
                onClick={() => { setFolderMeta(ctxMenu.cs.config.group ?? '', { primaryId: ctxMenu.cs.config.id }); setCtxMenu(null); }} />
            )
          )}
          <ContextMenuItem label="Delete" danger onClick={() => { handleDelete(ctxMenu.cs); setCtxMenu(null); }} />
        </ContextMenu>
      )}
      {bgMenu && (
        <ContextMenu x={bgMenu.x} y={bgMenu.y} onClose={() => setBgMenu(null)}>
          <ContextMenuItem label="New connection…" onClick={() => { onNewConnection(); setBgMenu(null); }} />
          <ContextMenuItem label="New folder…" onClick={() => {
            setBgMenu(null);
            setNameVal('');
            setNameDlg({ title: 'New folder — opens the connection form with it prefilled', initial: '',
              apply: v => { if (v.trim()) onNewConnection(v.trim()); } });
          }} />
          <ContextMenuItem label="Collapse all folders" onClick={() => {
            setBgMenu(null);
            const all = new Set(allFolders);
            setCollapsed(all);
            try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...all])); } catch { /* quota */ }
          }} />
          <ContextMenuItem label="Expand all folders" onClick={() => {
            setBgMenu(null);
            setCollapsed(new Set());
            try { localStorage.setItem(COLLAPSE_KEY, '[]'); } catch { /* quota */ }
          }} />
        </ContextMenu>
      )}

      {folderMenu && (
        <ContextMenu x={folderMenu.x} y={folderMenu.y} onClose={() => setFolderMenu(null)}>
          <ContextMenuItem label={`New connection in "${folderMenu.node.name}"`}
            onClick={() => { onNewConnection(folderMenu.node.path); setFolderMenu(null); }} />
          <ContextMenuItem label="New subfolder + connection…"
            onClick={() => { onNewConnection(folderMenu.node.path + '/'); setFolderMenu(null); }} />
          <ContextMenuItem label="Rename folder…"
            onClick={() => {
              const node = folderMenu.node;
              setFolderMenu(null);
              setNameVal(node.path);
              setNameDlg({ title: `Rename folder "${node.name}"`, initial: node.path,
                apply: v => applyRenameFolder(node, v) });
            }} />
          <ContextMenuItem label="Set tag / note…"
            onClick={() => {
              const node = folderMenu.node;
              setFolderMenu(null);
              setNameVal(getFolderMeta(node.path).note ?? '');
              setNameDlg({ title: `Tag / note for "${node.name}"`, initial: getFolderMeta(node.path).note ?? '',
                apply: v => setFolderMeta(node.path, { note: v.trim() || undefined }) });
            }} />
          <div className="cf-colors" style={{ padding: '4px 12px' }}>
            {[null, '#e05555', '#e0b050', '#4caf73', '#50c8c8', '#4da8ff', '#b06ce0', '#e07a9e', '#808a9a'].map(c => (
              <button key={c ?? 'none'} type="button"
                className={`cf-swatch ${getFolderMeta(folderMenu.node.path).color === c ? 'cf-swatch-on' : ''}`}
                style={c ? { background: c } : undefined}
                title={c ?? 'no color'}
                onClick={() => { setFolderMeta(folderMenu.node.path, { color: c }); setFolderMenu(null); }}
              >{c ? '' : '∅'}</button>
            ))}
          </div>
          <ContextMenuItem label={collapsed.has(folderMenu.node.path) ? 'Expand' : 'Collapse'}
            onClick={() => { toggleFolder(folderMenu.node.path); setFolderMenu(null); }} />
          {getFolderMeta(folderMenu.node.path).replicaSet ? (
            <>
              <ContextMenuItem label="🔁 Replica set dashboard…"
                onClick={() => { onOpenReplicaSet(folderMenu.node.path); setFolderMenu(null); }} />
              <ContextMenuItem label="Stop treating as replica set"
                onClick={() => { setFolderMeta(folderMenu.node.path, { replicaSet: false, primaryId: null }); setFolderMenu(null); }} />
            </>
          ) : (
            <ContextMenuItem label="🔁 Treat as replica set"
              onClick={() => { setFolderMeta(folderMenu.node.path, { replicaSet: true }); setFolderMenu(null); }} />
          )}
        </ContextMenu>
      )}

      {nameDlg && (
        <div className="modal-overlay" onClick={() => setNameDlg(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{nameDlg.title}</span>
              <button className="modal-close" onClick={() => setNameDlg(null)}>×</button>
            </div>
            <div style={{ padding: '12px 16px' }}>
              <input autoFocus value={nameVal} onChange={e => setNameVal(e.target.value)}
                placeholder={'folder path — "/" nests'}
                onKeyDown={e => { if (e.key === 'Enter') { nameDlg.apply(nameVal); setNameDlg(null); } }}
                style={{ width: '100%', boxSizing: 'border-box' }} />
            </div>
            <div className="modal-footer">
              <button className="toolbar-btn" onClick={() => setNameDlg(null)}>Cancel</button>
              <button className="primary" onClick={() => { nameDlg.apply(nameVal); setNameDlg(null); }}>OK</button>
            </div>
          </div>
        </div>
      )}

      {moveDlg && (
        <div className="modal-overlay" onClick={() => setMoveDlg(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Move "{moveDlg.config.name}" to folder</span>
              <button className="modal-close" onClick={() => setMoveDlg(null)}>×</button>
            </div>
            <div style={{ padding: '12px 16px' }}>
              <input
                autoFocus
                list="dbgui-move-folders"
                value={moveTarget}
                onChange={e => setMoveTarget(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { moveToFolder(moveDlg, moveTarget); setMoveDlg(null); } }}
                placeholder={'folder path — "/" nests, empty = top level'}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
              <datalist id="dbgui-move-folders">
                {allFolders.map(f => <option key={f} value={f} />)}
              </datalist>
            </div>
            <div className="modal-footer">
              <button className="toolbar-btn" onClick={() => setMoveDlg(null)}>Cancel</button>
              <button className="primary" onClick={() => { moveToFolder(moveDlg, moveTarget); setMoveDlg(null); }}>Move</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
