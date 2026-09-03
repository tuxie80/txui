import { errorDisplay } from './utils/appError';
import { lazy, Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { parseRecent, recentLabels, RECENT_KEY } from './utils/sqlFile';
import { listen } from '@tauri-apps/api/event';
import { CommandPalette } from './components/CommandPalette';
import type { PaletteItem } from './components/CommandPalette';
import type { OpenSection } from './utils/openAnything';
import { PanelIcon } from './components/panelIcons';
import { ObjectKindIcon } from './components/treeIcons';
import { ContextMenu, ContextMenuItem } from './components/ContextMenu';
import { AboutModal } from './components/AboutModal';
import { ShortcutsModal } from './components/ShortcutsModal';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { ConnectionForm } from './components/ConnectionForm';
import { QueryTabs } from './components/QueryTabs';
import { SchemaTree } from './components/SchemaTree';
import { EngineLogo } from './components/engineLogos';
import { tabStyle } from './utils/tabStyle';
import { nextScratchName } from './utils/scratch';
import { UnlockGate } from './components/UnlockGate';
import { AppDialogHost } from './components/AppDialogHost';
import { alertDialog, promptDialog } from './utils/appDialog';
import { StatusBar } from './components/StatusBar';
import { CloseTabConfirm } from './components/CloseTabConfirm';
import { ProdAck } from './components/ProdAck';
import type { ProdAckRequest } from './components/ProdAck';
import { isProdAcked, ackProd } from './store/prodAck';
import { getSessionActivities, clearSessionActivities } from './store/tabActivity';
import type { TabActivity } from './store/tabActivity';
import { stopSessionRuns } from './store/playgroundRuns';
import { forgetKillPickerState } from './store/killPickerState';
import { withDeadline } from './utils/withDeadline';

// Engine-specific panels split out of the initial bundle — cold start stays lean
const RedisBrowser = lazy(() =>
  import('./components/RedisBrowser').then(m => ({ default: m.RedisBrowser })));
const MongoBrowser = lazy(() =>
  import('./components/MongoBrowser').then(m => ({ default: m.MongoBrowser })));
const ReplayWorkspace = lazy(() =>
  import('./components/ReplayWorkspace').then(m => ({ default: m.ReplayWorkspace })));
const ReplayChooser = lazy(() =>
  import('./components/replay/ReplayChooser').then(m => ({ default: m.ReplayChooser })));
const MultiExec = lazy(() =>
  import('./components/MultiExec').then(m => ({ default: m.MultiExec })));
const AuditLogPanel = lazy(() =>
  import('./components/AuditLogPanel').then(m => ({ default: m.AuditLogPanel })));
const SchemaComparePanel = lazy(() =>
  import('./components/SchemaComparePanel').then(m => ({ default: m.SchemaComparePanel })));
const DumpRestorePanel = lazy(() =>
  import('./components/DumpRestorePanel').then(m => ({ default: m.DumpRestorePanel })));
const ReplicaSetPanel = lazy(() =>
  import('./components/ReplicaSetPanel').then(m => ({ default: m.ReplicaSetPanel })));
const HypoIndexPanel = lazy(() =>
  import('./components/HypoIndexPanel').then(m => ({ default: m.HypoIndexPanel })));
// What's New embeds CHANGELOG.md as a raw string (~285 kB) — far too dear for
// the entry chunk when the window is opened at most once per release.
const WhatsNewModal = lazy(() =>
  import('./components/WhatsNewModal').then(m => ({ default: m.WhatsNewModal })));
import type { ConnectionConfig, Engine, Session, QueryResult } from './types';
import { ConnectionsStore } from './store/connections';
import { replayApi, type ReplayProbe } from './lib/replay';
import { forgetPrivileges } from './store/sessionPrivileges';
import { forgetFlavor } from './store/serverFlavors';
import { clearSchemaScan } from './store/schemaScan';
import { restoreRunLog } from './store/logStore';
import { logAudit, isoNow } from './utils/audit';
import { PALETTE } from './utils/palette';
import { GridSettingsProvider } from './store/GridSettingsProvider';
import { WelcomeAudit } from './components/WelcomeAudit';
import { useResizable } from './hooks/useResizable';
import { installTooltips } from './utils/tooltip';
import { initTheme, applyTheme } from './utils/themes';
import { initFontScale } from './utils/fontScale';
import { getPref, setPref, PREFS } from './store/preferences';
import './App.css';
import { shortcuts } from './utils/platform';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

type View =
  | { kind: 'welcome' }
  | { kind: 'new-conn'; edit?: ConnectionConfig; group?: string }
  | { kind: 'multi-exec' }
  | { kind: 'audit' }
  | { kind: 'compare' }
  | { kind: 'dump' }
  | { kind: 'replicaset'; folder: string }
  | { kind: 'hypopg'; session: Session }
  | { kind: 'query'; session: Session };

// Per-session workspace pane state

// Command-palette icons, which are plain strings. Every engine needs an entry:
// the three that were missing rendered as nothing at all, so a ClickHouse,
// SQLite or Parquet session was visually unlabelled. The session TAB uses the
// real EngineLogo mark instead — see below.
const ENGINE_ICON: Record<Engine, string> = {
  mysql: '🐬', postgres: '🐘', redis: '⚡',
  clickhouse: '🟡', sqlite: '🗃️', parquet: '🧱', duckdb: '🦆',
  mongodb: '🍃', sqlserver: '🪟',
};

export default function App() {
  const [view, setView] = useState<View>({ kind: 'welcome' });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Dolphie replay detection. A SQLite session whose file fingerprints as a
  // recording does NOT auto-open the dashboard — it presents a chooser and the
  // user decides. Modes: 'probing' → deciding; 'ask' → chooser shown;
  // 'replay' → dashboard; 'raw' → user chose plain SQLite; 'no' → ordinary file.
  const [replayInfo, setReplayInfo] =
    useState<Record<string, { mode: 'probing' | 'ask' | 'replay' | 'raw' | 'no'; path: string; probe?: ReplayProbe }>>({});
  const probedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const s of sessions) {
      if (s.engine !== 'sqlite' || !s.filePath || probedRef.current.has(s.sessionId)) continue;
      probedRef.current.add(s.sessionId);
      const path = s.filePath;
      setReplayInfo(prev => ({ ...prev, [s.sessionId]: { mode: 'probing', path } }));
      replayApi.probe(path)
        .then(p => setReplayInfo(prev => ({ ...prev, [s.sessionId]: { mode: p.is_recording ? 'ask' : 'no', path, probe: p } })))
        .catch(() => setReplayInfo(prev => ({ ...prev, [s.sessionId]: { mode: 'no', path } })));
    }
  }, [sessions]);
  const setReplayMode = useCallback((sessionId: string, mode: 'ask' | 'replay' | 'raw') => {
    setReplayInfo(prev => ({ ...prev, [sessionId]: { ...prev[sessionId], mode } }));
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // ⌘P is the SAME palette pre-filtered to the schema sections — one surface,
  // one ranking, the go-to-table muscle memory intact. Undefined = everything.
  const [paletteSections, setPaletteSections] = useState<readonly OpenSection[] | undefined>(undefined);
  // Kept in sync with the list QueryTabs writes, so a file opened a moment ago
  // is in the palette without a restart.
  const [recentFiles, setRecentFiles] = useState<string[]>(
    () => parseRecent(localStorage.getItem(RECENT_KEY)));
  useEffect(() => {
    const sync = () => setRecentFiles(parseRecent(localStorage.getItem(RECENT_KEY)));
    window.addEventListener('dbgui:recent-files-changed', sync);
    return () => window.removeEventListener('dbgui:recent-files-changed', sync);
  }, []);
  const [objectItems, setObjectItems] = useState<PaletteItem[]>([]);
  const [columnItems, setColumnItems] = useState<PaletteItem[]>([]);
  // Connection activity log shown in the start-screen output pane.
  const [savedConns, setSavedConns] = useState<ConnectionConfig[]>([]);
  // null = not yet loaded. Drives the welcome screen: no saved connections →
  // the first-run how-to; any → the cross-server activity feed.
  const [connCount, setConnCount] = useState<number | null>(null);
  useEffect(() => {
    const load = () => ConnectionsStore.list().then(l => setConnCount(l.length)).catch(() => {});
    load();
    window.addEventListener('dbgui:connections-changed', load);
    return () => window.removeEventListener('dbgui:connections-changed', load);
  }, []);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; session: Session } | null>(null);
  /** Inline rename of a connection, started from its session tab's menu. */
  const [renameSession, setRenameSession] = useState<{ id: string; value: string } | null>(null);

  /**
   * Set a connection's colour from its session tab, and reflect it on every
   * open session of that connection without waiting for a reload.
   */
  const setTabColor = useCallback(async (session: Session, color: string | null) => {
    const cfg = (await ConnectionsStore.list()).find(c => c.id === session.connectionId);
    if (!cfg) return;
    await ConnectionsStore.save({ ...cfg, color });
    setSessions(prev => prev.map(s =>
      s.connectionId === session.connectionId ? { ...s, color } : s));
    window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
  }, []);

  const applyRename = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    setRenameSession(null);
    if (!trimmed) return;
    const cfg = (await ConnectionsStore.list()).find(c => c.id === id);
    if (!cfg || cfg.name === trimmed) return;
    await ConnectionsStore.save({ ...cfg, name: trimmed });
    setSessions(prev => prev.map(s =>
      s.connectionId === id ? { ...s, connectionName: trimmed } : s));
    window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
  }, []);
  // Generic right-click menu — shown wherever no component menu claimed the event
  const [genMenu, setGenMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  const [savedQueries, setSavedQueries] = useState<{ id: number; name: string; folder: string; sql: string }[]>([]);
  // Per-session SchemaTree refresh trigger (incremented to force re-mount of tree's useEffect)
  const [schemaRefreshKeys, setSchemaRefreshKeys] = useState<Record<string, number>>({});
  // Per-session object-explorer collapse
  // ONE setting for every session, not one per session. Collapsing the object
  // explorer is a statement about how you want the window laid out, not about
  // a particular server — having to re-collapse it on each tab was pure
  // clicking. Persisted, like the connections sidebar next to it.
  const [treeCollapsed, setTreeCollapsed] = useState<boolean>(
    () => localStorage.getItem('dbgui.treeCollapsed') === '1');
  const toggleTree = useCallback((collapsed: boolean) => {
    setTreeCollapsed(collapsed);
    try { localStorage.setItem('dbgui.treeCollapsed', collapsed ? '1' : '0'); } catch { /* quota */ }
  }, []);
  // Resizable + collapsible chrome
  const [sidebarW, dragSidebar] = useResizable('dbgui.sidebarW', 300, 200, 640, 'x');
  const [treeW, dragTree] = useResizable('dbgui.treeW', 240, 150, 520, 'x');
  const [sidebarHidden, setSidebarHidden] = useState<boolean>(
    () => localStorage.getItem('dbgui.sidebarHidden') === '1');
  const toggleSidebar = () => setSidebarHidden(h => {
    try { localStorage.setItem('dbgui.sidebarHidden', h ? '0' : '1'); } catch { /* quota */ }
    return !h;
  });
  /**
   * Zen mode: hide the connections sidebar and the status bar, keep the tab
   * strip and the work. Session-only by design (no pref) — it is a posture
   * you drop into for an hour, not a layout you commit to, and a fresh start
   * should always come back fully chrome. The CSS hangs off `body.zen` so
   * enter/exit is a class flip and the flex layout reflows on its own.
   */
  const [zen, setZen] = useState(false);
  const toggleZen = useCallback(() => setZen(z => !z), []);
  useEffect(() => {
    document.body.classList.toggle('zen', zen);
    return () => document.body.classList.remove('zen');
  }, [zen]);
  // All three entry points converge on the one toggle: the Mod-Alt-0 chord,
  // the View → Zen Mode menu item (dbgui:menu-zen), and anything dispatching
  // dbgui:toggle-zen (the command palette, the editor's command table).
  useEffect(() => {
    const onToggle = () => toggleZen();
    window.addEventListener('dbgui:toggle-zen', onToggle);
    return () => window.removeEventListener('dbgui:toggle-zen', onToggle);
  }, [toggleZen]);
  useEffect(() => {
    const un = listen('dbgui:menu-zen', () => toggleZen());
    return () => { un.then(f => f()); };
  }, [toggleZen]);
  // Revealing an object in the tree implies showing the explorer it lives in —
  // a reveal against a collapsed rail would flash nothing.
  useEffect(() => {
    const onReveal = () => toggleTree(false);
    window.addEventListener('dbgui:reveal-object', onReveal);
    return () => window.removeEventListener('dbgui:reveal-object', onReveal);
  }, [toggleTree]);
  const insertTextRef = useRef<((text: string) => void) | null>(null);
  // Where the user was before opening a utility view — × restores it
  const [prevView, setPrevView] = useState<{ view: View; activeSessionId: string | null } | null>(null);
  // Disconnect guard: what is still running on the session(s) being closed.
  // `fromSidebar` distinguishes the sidebar's drop-the-connection close (which
  // logs the drop) from a single tab-X close.
  const [disconnectAsk, setDisconnectAsk] =
    useState<{ victims: Session[]; activities: TabActivity[]; fromSidebar: boolean } | null>(null);

  function openUtility(kind: 'multi-exec' | 'audit' | 'compare' | 'dump') {
    setPrevView({ view, activeSessionId });
    setActiveSessionId(null);
    setView({ kind });
  }

  function openReplicaSet(folder: string) {
    setPrevView({ view, activeSessionId });
    setActiveSessionId(null);
    setView({ kind: 'replicaset', folder });
  }

  // HypoPG what-if advisor — a PostgreSQL-only full-screen utility carrying its
  // own session, closed back to wherever the user was via closeUtility().
  function openHypoPG(session: Session) {
    setPrevView({ view, activeSessionId });
    setActiveSessionId(null);
    setView({ kind: 'hypopg', session });
  }

  function closeUtility() {
    const prev = prevView;
    setPrevView(null);
    if (prev?.view.kind === 'query'
        && sessions.some(s => s.sessionId === prev.activeSessionId)) {
      setActiveSessionId(prev.activeSessionId);
      setView(prev.view);
      return;
    }
    const last = sessions[sessions.length - 1];
    if (last) {
      setActiveSessionId(last.sessionId);
      setView({ kind: 'query', session: last });
    } else {
      setView({ kind: 'welcome' });
    }
  }

  function bumpSchemaRefresh(sessionId: string) {
    setSchemaRefreshKeys(p => ({ ...p, [sessionId]: (p[sessionId] ?? 0) + 1 }));
  }

  async function handleSaveConnection(config: ConnectionConfig, password: string, sshPassword: string) {
    await ConnectionsStore.save(config, password || undefined, sshPassword || undefined);
    window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
    setView({ kind: 'welcome' });
  }

  function openSessionNow(session: Session) {
    setSessions(prev => {
      const exists = prev.find(s => s.sessionId === session.sessionId);
      return exists ? prev : [...prev, session];
    });
    setActiveSessionId(session.sessionId);
    setView({ kind: 'query', session });
    // Hand the screen to the workspace, unconditionally: the connections
    // sidebar hides and the database-objects tree shows — you connected to
    // work on the server, not to keep staring at the connection list.
    setSidebarHidden(true);
    try { localStorage.setItem('dbgui.sidebarHidden', '1'); } catch { /* quota */ }
    toggleTree(false);
  }

  // Prod acknowledgment pending for a session that was opened server-side but
  // not yet let into the workspace.
  const [prodAckAsk, setProdAckAsk] = useState<{ session: Session; request: ProdAckRequest } | null>(null);

  function handleOpenSession(session: Session) {
    // Once per app run per connection: a prod session opens only after the
    // user has seen the active hard limits and clicked through.
    if (session.environment === 'prod' && !isProdAcked(session.connectionId)) {
      ConnectionsStore.list()
        .then(list => list.find(c => c.id === session.connectionId) ?? null)
        .catch(() => null)
        .then(cfg => setProdAckAsk({
          session,
          request: {
            connectionName: session.connectionName,
            allowDdl: cfg?.prod_allow_ddl ?? false,
            allowUnfiltered: cfg?.prod_allow_unfiltered_write ?? false,
            rowCap: getPref(PREFS.prodRowCap),
          },
        }));
      return;
    }
    openSessionNow(session);
  }

  function cancelProdAck() {
    const ask = prodAckAsk;
    setProdAckAsk(null);
    if (!ask) return;
    // Abort the open: close the backend session that was already established.
    ConnectionsStore.close(ask.session.sessionId).catch(() => {});
    window.dispatchEvent(new CustomEvent('dbgui:conn-log', {
      detail: { level: 'info', msg: `${ask.session.connectionName} — connection aborted (production acknowledgment declined)` },
    }));
  }

  function handleTabClick(session: Session) {
    setActiveSessionId(session.sessionId);
    setView({ kind: 'query', session });
  }

  useEffect(() => installTooltips(), []);
  // The joined 📓 Log's tail from the previous run, restored once at startup
  // and marked as such (store/logStore). Closing the app the evening of an
  // incident and finding an empty list the next morning is the wrong end of
  // the day to lose it.
  useEffect(() => { restoreRunLog(); }, []);

  // Auto-connect connections flagged auto_connect, once at launch.
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current) return;
    autoConnectedRef.current = true;
    ConnectionsStore.list().then(list => {
      for (const c of list.filter(x => x.auto_connect)) {
        ConnectionsStore.open(c.id).then(sessionId => {
          handleOpenSession({
            connectionId: c.id, sessionId, connectionName: c.name, engine: c.engine,
              environment: c.environment, readOnly: c.read_only, color: c.color, filePath: c.file_path,
          });
        }).catch(() => {
          window.dispatchEvent(new CustomEvent('dbgui:conn-log', {
            detail: { level: 'err', msg: `Auto-connect ${c.name} failed` } }));
        });
      }
    }).catch(() => {});
    // Mount-only: auto-connect runs once at startup; handleOpenSession is safe
    // to call later because it reads state via setState updaters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Right-click ALWAYS yields a menu: components with their own menus call
  // preventDefault first (checked via defaultPrevented), editable elements keep
  // the native menu (copy/paste), and everywhere else a generic app menu opens
  // — never the WebView's "Inspect Element", never a dead click.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, [contenteditable="true"], .cm-content')) return;
      if (e.defaultPrevented) return; // a component menu (sidebar, tabs, editor) took it
      // Belt-and-suspenders: never overdraw zones that own their own menu.
      if (t?.closest?.('.conn-item-header, .group-folder, .sidebar, .tab, .cm-editor-wrap, .context-menu')) return;
      e.preventDefault();
      const selection = window.getSelection()?.toString() ?? '';
      setGenMenu({ x: e.clientX, y: e.clientY, selection });
    };
    window.addEventListener('contextmenu', onCtx);
    return () => window.removeEventListener('contextmenu', onCtx);
  }, []);
  /**
   * Tools menu → open that plugin in the active session.
   *
   * Re-dispatched as the same window event the plugin menu uses, so the menu is
   * not a second way of opening a panel with its own rules: one already open is
   * focused rather than duplicated, and the engine and privilege gates are the
   * ones QueryTabs already applies.
   */
  useEffect(() => {
    const un = listen<string>('dbgui:open-tool', e => {
      window.dispatchEvent(new CustomEvent('dbgui:toggle-panel', { detail: { panel: e.payload } }));
    });
    return () => { un.then(f => f()); };
  }, []);

  /**
   * File and Help menu items.
   *
   * The native menu sends one `dbgui:menu-action` carrying `file:<what>` or
   * `help:<what>`, rather than an event per item — adding an item is then a
   * change in two places (the menu, this switch) instead of four.
   *
   * Most actions re-dispatch the window event the in-app control already
   * uses, so the menu is never a second implementation with its own rules:
   * File → New Query Tab is the same code path as the "+" button, and a
   * change to one cannot leave the other behind.
   */
  useEffect(() => {
    const un = listen<string>('dbgui:menu-action', async e => {
      const fire = (name: string, detail?: unknown) =>
        window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
      switch (e.payload) {
        case 'file:new-connection': setView({ kind: 'new-conn' }); break;
        case 'file:new-tab':        fire('dbgui:new-tab'); break;
        case 'file:close-tab':      fire('dbgui:close-tab'); break;
        case 'file:close-session':  fire('dbgui:close-session'); break;
        case 'file:export':         fire('dbgui:export-results'); break;
        case 'file:save-sql':       fire('dbgui:save-sql'); break;
        case 'file:save-sql-as':    fire('dbgui:save-sql-as'); break;
        case 'file:open-sql': {
          // Read here rather than in the editor: the dialog and the file read
          // are the same two steps whichever tab ends up holding the text, and
          // the tab does not exist yet when the user picks the file.
          const path = await openDialog({
            multiple: false,
            filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }],
          });
          if (typeof path !== 'string') return;          // cancelled
          try {
            // `sqlfile_open`, not `read_text_file`: it detects the encoding
            // (a CP1250 dump is not an error) and the line endings, and
            // reports the mtime so a later save can spot an outside change.
            const f = await invoke<{
              text: string; encoding: string; detected: boolean;
              eol: string; mtimeMs: number; lossy: boolean;
            }>('sqlfile_open', { path });
            fire('dbgui:open-sql-file', {
              path, sql: f.text, encoding: f.encoding, eol: f.eol, mtimeMs: f.mtimeMs,
            });
          } catch (err) {
            // A file that cannot be read is worth saying out loud — silently
            // opening an empty tab looks like an empty file.
            await alertDialog(`Could not open ${path}: ${errorDisplay(err)}`);
          }
          break;
        }
        case 'help:shortcuts': setShortcutsOpen(true); break;
        case 'help:changelog': setWhatsNewOpen(true); break;
      }
    });
    return () => { un.then(f => f()); };
  }, []);

  useEffect(() => {
    const un = listen('dbgui:about', () => setAboutOpen(true));
    return () => { un.then(f => f()); };
  }, []);
  useEffect(() => {
    const un = listen('dbgui:settings', () => setSettingsOpen(true));
    return () => { un.then(f => f()); };
  }, []);
  useEffect(() => {
    const un = listen('dbgui:menu-wrap', () => window.dispatchEvent(new CustomEvent('dbgui:toggle-wrap')));
    return () => { un.then(f => f()); };
  }, []);
  useEffect(() => {
    const un = listen('dbgui:menu-copyheaders', () => setPref(PREFS.copyHeaders, !getPref(PREFS.copyHeaders)));
    return () => { un.then(f => f()); };
  }, []);

  // Themes — applied at startup and whenever the native menu (View → Theme)
  // fires `dbgui:set-theme` with a theme id.
  useEffect(() => { initTheme(); }, []);
  // App-wide font scale — publishes --font-scale on <html> from the pref and
  // keeps it in sync when Settings changes it.
  useEffect(() => initFontScale(), []);
  useEffect(() => {
    const un = listen<string>('dbgui:set-theme', e => applyTheme(e.payload));
    return () => { un.then(f => f()); };
  }, []);

  // Quick-open (⌘P): the unified palette pre-filtered to tables & columns of
  // the active session — go-to-table, now with the full ranking behind it.
  function openQuickOpen() {
    setPaletteSections(['table', 'column']);
    setPaletteOpen(true);
  }
  const openQuickOpenRef = useRef(openQuickOpen);
  useEffect(() => { openQuickOpenRef.current = openQuickOpen; });

  // ── Global keyboard shortcuts ────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === ',') {
        e.preventDefault();
        setSettingsOpen(o => !o);
      } else if (e.key === 'k') {
        e.preventDefault();
        setPaletteSections(undefined);
        setPaletteOpen(o => !o);
      } else if (e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (e.altKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('dbgui:toggle-wrap'));
      } else if (e.altKey && e.key === '0') {
        // Zen mode. The native View menu carries the same accelerator; this is
        // the fallback for webviews that swallow the chord before the menu.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('dbgui:toggle-zen'));
      } else if (e.shiftKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault();
        setPref(PREFS.copyHeaders, !getPref(PREFS.copyHeaders));
      } else if (e.key === 't') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('dbgui:new-tab'));
      } else if (e.key === 'w') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('dbgui:close-tab'));
      } else if (e.key === 'p') {
        e.preventDefault();
        openQuickOpenRef.current();
      } else if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
        const target = sessions[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          setActiveSessionId(target.sessionId);
          setView({ kind: 'query', session: target });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions]);

  // Refresh the active session's schema tree when a panel creates objects
  useEffect(() => {
    // treeFresh: the dispatcher (the tree's own ↻) already re-listed the
    // tree — the event then only re-sweeps the completion cache.
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ treeFresh?: boolean }>).detail?.treeFresh) return;
      if (activeSessionId) bumpSchemaRefresh(activeSessionId);
    };
    window.addEventListener('dbgui:schema-changed', onChanged);
    return () => window.removeEventListener('dbgui:schema-changed', onChanged);
  }, [activeSessionId]);

  // File → Close Connection (native menu) fires this; all sessions of the
  // connection close server-side. Closing the last query TAB never gets here —
  // a connected session may have zero tabs.
  useEffect(() => {
    const onCloseSession = (e: Event) => {
      const d = (e as CustomEvent<{ connectionId: string }>).detail;
      if (d?.connectionId) disconnectConnection(d.connectionId);
    };
    window.addEventListener('dbgui:close-session', onCloseSession);
    return () => window.removeEventListener('dbgui:close-session', onCloseSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, activeSessionId]);

  // Load saved connections + saved queries whenever the palette opens
  useEffect(() => {
    if (!paletteOpen) return;
    ConnectionsStore.list().then(setSavedConns).catch(() => {});
    invoke<{ id: number; name: string; folder: string; sql: string }[]>('list_saved_queries')
      .then(setSavedQueries)
      .catch(() => {});
    // "Open Anything": every table/view/routine — and every column — of the
    // active session joins the same list, sectioned. Fetched ONCE per palette
    // open into state; the per-keystroke ranking is pure and in-memory
    // (utils/openAnything). Both sweeps are row-capped so a huge server can
    // never freeze the UI.
    const s = sessions.find(x => x.sessionId === activeSessionId);
    // Non-SQL engines have no catalog sweep to run (MongoDB's tree is the
    // SchemaTree's own; Redis has no schema at all).
    if (!s || s.engine === 'redis' || s.engine === 'mongodb') { setObjectItems([]); setColumnItems([]); return; }
    const q = (sql: string) => invoke<QueryResult>('monitor_query', { sessionId: s.sessionId, sql });
    // sqlite_master is per-database — one UNION over every attached db.
    const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
    const ident = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const sqliteDbs = async (): Promise<string[]> =>
      (await q('SELECT name FROM pragma_database_list ORDER BY seq')).rows.map(r => String(r[0]));

    const loadObjects = async (): Promise<QueryResult | null> => {
      try {
        if (s.engine === 'sqlite') {
          const dbs = await sqliteDbs();
          const union = (dbs.length > 0 ? dbs : ['main']).map(d =>
            `SELECT ${lit(d)} AS db, name, type FROM ${ident(d)}.sqlite_master ` +
            `WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`).join(' UNION ALL ');
          return await q(`${union} LIMIT 5000`);
        }
        if (s.engine === 'duckdb') {
          // The catalog functions span every attached database, so the catalog
          // name rides in the "schema" half — the qualified form is the tree's
          // three-level "db.schema.name", which browse and insert both accept.
          return await q(
            "SELECT database_name || '.' || schema_name, table_name, 'table' FROM duckdb_tables() WHERE NOT internal " +
            "UNION ALL SELECT database_name || '.' || schema_name, view_name, 'view' FROM duckdb_views() WHERE NOT internal " +
            "UNION ALL SELECT database_name || '.' || schema_name, function_name, 'function' FROM duckdb_functions() " +
            "WHERE NOT internal AND function_type IN ('macro','table_macro') LIMIT 5000");
        }
        if (s.engine === 'clickhouse') {
          return await q("SELECT database, name, if(engine LIKE '%View','view','table') FROM system.tables " +
            "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') AND NOT is_temporary LIMIT 5000");
        }
        if (s.engine === 'sqlserver') {
          // information_schema is per-database — this is the session's current
          // database, same scope as the editor's schema sweep. TOP, not LIMIT.
          return await q(
            "SELECT TOP 5000 table_schema, table_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables " +
            "UNION ALL SELECT TOP 5000 routine_schema, routine_name, LOWER(routine_type) FROM information_schema.routines");
        }
        const sql = s.engine === 'postgres'
          ? "SELECT table_schema, table_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') " +
            "UNION ALL SELECT routine_schema, routine_name, lower(routine_type) FROM information_schema.routines WHERE routine_schema NOT IN ('pg_catalog','information_schema') LIMIT 5000"
          : "SELECT table_schema, table_name, IF(table_type='VIEW','view','table') FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','performance_schema','mysql','sys') " +
            "UNION ALL SELECT routine_schema, routine_name, LOWER(routine_type) FROM information_schema.routines WHERE routine_schema NOT IN ('information_schema','performance_schema','mysql','sys') LIMIT 5000";
        return await q(sql);
      } catch { return null; }
    };

    const loadColumns = async (): Promise<QueryResult | null> => {
      try {
        if (s.engine === 'sqlite') {
          const dbs = await sqliteDbs();
          const union = (dbs.length > 0 ? dbs : ['main']).map(d =>
            `SELECT ${lit(d)} AS db, m.name, p.name FROM ${ident(d)}.sqlite_master m ` +
            `JOIN pragma_table_info(m.name) p ` +
            `WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'`).join(' UNION ALL ');
          return await q(`${union} LIMIT 8000`);
        }
        if (s.engine === 'duckdb') {
          return await q("SELECT database_name || '.' || schema_name, table_name, column_name " +
            "FROM duckdb_columns() WHERE NOT internal LIMIT 8000");
        }
        if (s.engine === 'clickhouse') {
          return await q("SELECT database, table, name FROM system.columns " +
            "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') LIMIT 8000");
        }
        if (s.engine === 'sqlserver') {
          return await q("SELECT TOP 8000 table_schema, table_name, column_name FROM information_schema.columns " +
            "ORDER BY table_schema, table_name, ordinal_position");
        }
        return await q(s.engine === 'postgres'
          ? "SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position LIMIT 8000"
          : "SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema NOT IN ('information_schema','performance_schema','mysql','sys') ORDER BY table_schema, table_name, ordinal_position LIMIT 8000");
      } catch { return null; }
    };

    loadObjects().then(r => setObjectItems(!r ? [] : r.rows.map(row => {
      const schema = String(row[0]), name = String(row[1]), kind = String(row[2]);
      const qualified = `${schema}.${name}`;
      if (kind === 'table' || kind === 'view') {
        return {
          id: `obj-${qualified}`, label: name, section: 'table' as const, qualified,
          hint: `${kind} · ${schema}`, icon: <ObjectKindIcon kind={kind} />,
          action: () => window.dispatchEvent(new CustomEvent('dbgui:browse-table', { detail: { table: qualified } })),
        };
      }
      return {
        id: `obj-${qualified}-${kind}`, label: name, section: 'table' as const, qualified,
        hint: `${kind} · ${schema}`, icon: <ObjectKindIcon kind="routine" routineType={kind} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:insert-sql', {
          detail: { sql: kind === 'procedure' ? `CALL ${qualified}();` : `${qualified}()` },
        })),
      };
    })));

    loadColumns().then(r => setColumnItems(!r ? [] : r.rows.map(row => {
      const schema = String(row[0]), table = String(row[1]), col = String(row[2]);
      const qualified = `${schema}.${table}.${col}`;
      return {
        id: `col-${qualified}`, label: col, section: 'column' as const, qualified,
        hint: `${schema}.${table}`, icon: <ObjectKindIcon kind="column" />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: qualified } })),
      };
    })));
  }, [paletteOpen, sessions, activeSessionId]);

  // Built only while the palette is open: once the object/column lists have
  // loaded, this spreads up to ~13k items, and nothing consumes the list when
  // the palette is closed — rebuilding it on every unrelated App render was
  // pure waste.
  const paletteItems: PaletteItem[] = !paletteOpen ? [] : (() => {
    const items: PaletteItem[] = [];
    // Recently opened .sql files. The palette is where this belongs rather
    // than the native menu: that menu is built once at startup and cannot
    // grow a list that changes as you work.
    for (const r of recentLabels(recentFiles)) {
      items.push({
        id: `recent-${r.path}`,
        label: `Open: ${r.label}`,
        hint: 'recent file',
        icon: '📄',
        section: 'recent',
        action: async () => {
          try {
            const f = await invoke<{ text: string; encoding: string; eol: string; mtimeMs: number }>(
              'sqlfile_open', { path: r.path });
            window.dispatchEvent(new CustomEvent('dbgui:open-sql-file', {
              detail: { path: r.path, sql: f.text, encoding: f.encoding, eol: f.eol, mtimeMs: f.mtimeMs },
            }));
          } catch (err) {
            await alertDialog(`Could not open ${r.path}: ${errorDisplay(err)}`);
          }
        },
      });
    }
    for (const s of sessions) {
      items.push({
        id: `session-${s.sessionId}`,
        label: `Switch to ${s.connectionName}`,
        hint: 'open session',
        icon: ENGINE_ICON[s.engine],
        section: 'session',
        action: () => { setActiveSessionId(s.sessionId); setView({ kind: 'query', session: s }); },
      });
    }
    for (const c of savedConns) {
      items.push({
        id: `conn-${c.id}`,
        label: `Connect: ${c.name}`,
        hint: c.group ? `${c.engine} · ${c.group}` : c.engine,
        icon: ENGINE_ICON[c.engine],
        section: 'connection',
        action: async () => {
          try {
            const sessionId = await ConnectionsStore.open(c.id);
            handleOpenSession({
              connectionId: c.id, sessionId, connectionName: c.name, engine: c.engine,
              environment: c.environment, readOnly: c.read_only, color: c.color, filePath: c.file_path,
            });
          } catch { /* Sidebar's Connect surfaces errors; palette is best-effort */ }
        },
      });
    }
    items.push(...([
      { id: 'act-new-conn', label: 'New connection…', hint: 'action', icon: '＋',
        action: () => setView({ kind: 'new-conn' }) },
      // Scratch opens through the same window event the sidebar button and the
      // Tools menu item use — the palette is never a second implementation.
      { id: 'act-scratch', label: 'New scratch buffer — in-memory DuckDB, no connection needed',
        hint: 'action', icon: '🦆',
        action: () => window.dispatchEvent(new CustomEvent('dbgui:new-scratch')) },
      { id: 'act-quick-open', label: 'Go to table…', hint: SC.goToTable, icon: <ObjectKindIcon kind="table" />,
        action: () => openQuickOpen() },
      { id: 'act-reveal', label: 'Reveal in database tree…', hint: 'object explorer', icon: <ObjectKindIcon kind="table" />,
        action: async () => {
          // The editor's F12 companion resolves the caret identifier itself and
          // dispatches the same event; from the palette there is no caret, so ask.
          const name = await promptDialog('Reveal object in the database tree — name (bare or schema-qualified):');
          if (name?.trim()) {
            window.dispatchEvent(new CustomEvent('dbgui:reveal-object', { detail: { name: name.trim() } }));
          }
        } },
      { id: 'act-zen', label: 'Toggle zen mode', hint: SC.zen, icon: '▣',
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-zen')) },
      { id: 'act-multi-exec', label: 'Multi-server execution…', hint: 'fleet', icon: '⚟',
        action: () => openUtility('multi-exec') },
      { id: 'act-new-tab', label: 'New query tab', hint: SC.newTab, icon: '▸',
        action: () => window.dispatchEvent(new CustomEvent('dbgui:new-tab')) },
      { id: 'act-close-tab', label: 'Close query tab', hint: SC.closeTab, icon: '▸',
        action: () => window.dispatchEvent(new CustomEvent('dbgui:close-tab')) },
      { id: 'act-history', label: 'Toggle query history', hint: 'action', icon: <PanelIcon panel="history" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-history')) },
      { id: 'act-processes', label: 'Show processes (processlist / kill)', hint: 'action', icon: <PanelIcon panel="processes" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-processes')) },
      { id: 'act-playground', label: 'Playground — spawn a mess (threads / locks / rogue queries)', hint: 'action', icon: <PanelIcon panel="playground" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-playground')) },
      { id: 'act-locks', label: 'Locks & Deadlocks', hint: 'action', icon: <PanelIcon panel="locks" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-locks')) },
      { id: 'act-users', label: 'Users & grants', hint: 'action', icon: <PanelIcon panel="users" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-users')) },
      { id: 'act-serverinfo', label: 'Server variables & status', hint: 'action', icon: <PanelIcon panel="serverinfo" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-serverinfo')) },
      { id: 'act-watch', label: 'Watch — metrics, statement progress, wait profile', hint: 'action', icon: <PanelIcon panel="watch" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-watch')) },
      { id: 'act-replication', label: 'Replication status', hint: 'action', icon: <PanelIcon panel="replication" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-replication')) },
      { id: 'act-dbaviews', label: 'DBA views (sys / performance_schema)', hint: 'action', icon: <PanelIcon panel="dbaviews" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-dbaviews')) },
      { id: 'act-tuner', label: 'Server tuner — health score & guided fixes', hint: 'action', icon: <PanelIcon panel="tuner" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-tuner')) },
      { id: 'act-erdiagram', label: 'ER diagram (visual schema)', hint: 'action', icon: <PanelIcon panel="erdiagram" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-erdiagram')) },
      { id: 'act-datagen', label: 'Data generator (objects + rows)', hint: 'action', icon: <PanelIcon panel="datagen" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-datagen')) },
      { id: 'act-saved', label: 'Saved queries', hint: 'action', icon: <PanelIcon panel="saved" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-saved')) },
      { id: 'act-csvimport', label: 'CSV import', hint: 'action', icon: <PanelIcon panel="csvimport" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-csvimport')) },
      { id: 'act-quality', label: 'SQL Quality — deep query analysis', hint: 'action', icon: <PanelIcon panel="quality" size={13} />,
        action: () => window.dispatchEvent(new CustomEvent('dbgui:toggle-quality')) },
      { id: 'act-audit', label: 'Audit log (who ran what, when)', hint: 'proofs', icon: '📜',
        action: () => openUtility('audit') },
      { id: 'act-compare', label: 'Compare schemas / instances', hint: 'diff', icon: '⇆',
        action: () => openUtility('compare') },
      { id: 'act-dump', label: 'Dump / restore (mysqldump, mydumper, pg_dump…)', hint: 'backup', icon: '🗄',
        action: () => openUtility('dump') },
      { id: 'act-settings', label: 'Settings…', hint: SC.settings, icon: '⚙',
        action: () => setSettingsOpen(true) },
      { id: 'act-about', label: 'About TxUI', hint: 'info', icon: '🐧',
        action: () => setAboutOpen(true) },
    ] as PaletteItem[]).map(a => ({ ...a, section: 'command' as const })));
    // HypoPG is a PostgreSQL-only feature — offer it only when the active
    // session is Postgres, so it never appears against MySQL/Redis/etc.
    const activePg = sessions.find(s => s.sessionId === activeSessionId && s.engine === 'postgres');
    if (activePg) {
      items.push({
        id: 'act-hypopg', label: 'HypoPG — hypothetical index what-if advisor',
        hint: 'postgres · what-if', icon: '🧪', section: 'command',
        action: () => openHypoPG(activePg),
      });
    }
    for (const q of savedQueries) {
      items.push({
        id: `saved-${q.id}`,
        label: `Saved: ${q.folder ? `${q.folder} / ` : ''}${q.name}`,
        hint: 'insert into editor',
        icon: <PanelIcon panel="saved" size={13} />,
        section: 'saved',
        action: () => window.dispatchEvent(
          new CustomEvent('dbgui:insert-sql', { detail: { sql: q.sql } })),
      });
    }
    items.push(...objectItems, ...columnItems);
    return items;
  })();

  /**
   * Open a scratch buffer: an ephemeral in-memory DuckDB session with no
   * saved connection behind it. Three entry points converge here — the
   * sidebar 🦆 button and the palette entry dispatch the window event, the
   * native Tools menu emits the Tauri event of the same name.
   *
   * The connectionId is a one-off UUID minted here: buffers, undo history and
   * bookmarks key off it, and because it never recurs, nothing about a scratch
   * session can resurface after a restart — the honest version of "nothing
   * persists" (QueryTabs also skips persisting scratch buffers outright).
   */
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  async function openScratch() {
    try {
      const sessionId = await ConnectionsStore.openScratch();
      handleOpenSession({
        connectionId: crypto.randomUUID(),
        sessionId,
        connectionName: nextScratchName(sessionsRef.current.map(s => s.connectionName)),
        engine: 'duckdb',
        environment: null,
        readOnly: false,
        color: null,
        filePath: ':memory:',
        scratch: true,
      });
      window.dispatchEvent(new CustomEvent('dbgui:conn-log', {
        detail: { level: 'ok', msg: 'Scratch buffer opened — in-memory DuckDB; nothing is saved' },
      }));
    } catch (err) {
      await alertDialog(`Could not open scratch buffer: ${errorDisplay(err)}`);
    }
  }
  const openScratchRef = useRef(openScratch);
  useEffect(() => { openScratchRef.current = openScratch; });
  useEffect(() => {
    const on = () => { void openScratchRef.current(); };
    window.addEventListener('dbgui:new-scratch', on);
    return () => window.removeEventListener('dbgui:new-scratch', on);
  }, []);
  useEffect(() => {
    const un = listen('dbgui:new-scratch', () => { void openScratchRef.current(); });
    return () => { un.then(f => f()); };
  }, []);

  /** Open a brand-new session on the same connection (tab right-click → Duplicate) */
  async function duplicateSession(session: Session) {
    // A scratch session has no saved connection to re-open — duplicating it
    // means a fresh in-memory database, which is exactly what openScratch does.
    if (session.scratch) { await openScratch(); return; }
    try {
      const sessionId = await ConnectionsStore.open(session.connectionId);
      handleOpenSession({
        connectionId: session.connectionId,
        sessionId,
        connectionName: session.connectionName,
        engine: session.engine,
        environment: session.environment,
        readOnly: session.readOnly,
        color: session.color,
      });
    } catch (err) {
      await alertDialog(`Could not duplicate session: ${errorDisplay(err)}`);
    }
  }

  /** Close every open session for a given saved connection (sidebar Disconnect). */
  async function disconnectConnection(connectionId: string) {
    const victims = sessions.filter(s => s.connectionId === connectionId);
    if (victims.length === 0) return;
    // The same guard as the tab-X: anything still running on the connection
    // (a query, a generation job, a Playground full of live threads) is named
    // first — and stopped deliberately, never silently.
    const running = victims.flatMap(v => getSessionActivities(v.sessionId));
    if (running.length > 0) {
      setDisconnectAsk({ victims, activities: running, fromSidebar: true });
      return;
    }
    await disconnectNow(victims);
  }

  /** The actual drop: all sessions in parallel, each close deadline-bounded. */
  async function disconnectNow(victims: Session[]) {
    const perSession = await Promise.all(victims.map(v => closeSession(v)));
    const allThreads = perSession.flat();
    const tids = allThreads.length > 0
      ? `DB thread ids closed: ${allThreads.join(', ')}`
      : 'thread ids unavailable (connections busy at close)';
    window.dispatchEvent(new CustomEvent('dbgui:conn-log', {
      detail: {
        level: 'err',
        msg: `✂ ${victims[0].connectionName}: ALL connections dropped — ${victims.length} session${victims.length === 1 ? '' : 's'}, pools + tunnels killed. ${tids}`,
      },
    }));
  }

  async function closeSession(session: Session): Promise<number[]> {
    // Stop and forget the session's tracked work NOW, not at QueryTabs unmount:
    // that unmount only runs after the setSessions below, which used to wait
    // on the backend close — a circular hang when the pool close blocked.
    stopSessionRuns(session.sessionId);
    clearSessionActivities(session.sessionId);
    forgetKillPickerState(session.sessionId);
    let threadIds: number[] = [];
    try {
      // The backend bounds its own graceful close (5 s), but the UI never
      // waits on it longer than this: the tab goes away no matter what.
      threadIds = await withDeadline(ConnectionsStore.close(session.sessionId), 8000)
        .catch(() => [] as number[]);
      // A Dolphie recording keeps a columnar cache + a read-only pool warm across
      // Raw↔Replay toggles; a real session close is where we free it. Log the
      // release to the audit log so the memory lifecycle is visible.
      const rp = replayInfo[session.sessionId];
      if (rp?.probe?.is_recording && rp.path) {
        probedRef.current.delete(session.sessionId);
        const rpath = rp.path;
        const sid = session.sessionId;
        const connName = session.connectionName;
        const engine = session.engine;
        void (async () => {
          const startedAt = isoNow();
          const info = await replayApi.evict(rpath).catch(() => null);
          if (info?.freed) {
            let rss = '';
            try {
              const m = await invoke<{ rss_bytes: number }>('app_metrics');
              rss = ` · process RSS now ${Math.round(m.rss_bytes / 1048576)} MB`;
            } catch { /* metrics are best-effort */ }
            // Persistent audit row (+ session Log mirror) so the release shows in
            // the Audit panel alongside the open/index rows.
            logAudit({
              source: 'replay', session_id: sid, tab_title: connName,
              connection_name: connName, db_user: '', engine,
              started_at: startedAt, ended_at: isoNow(), duration_ms: 0,
              ok: true, rows_out: info.snapshots, rows_affected: null, error: null,
              sql: `Released replay cache — freed ${info.snapshots.toLocaleString()} snapshots`
                + `${info.had_series ? ` and ${info.metrics} metric columns` : ' (graphs were not built)'}${rss}`,
            });
          }
        })();
        setReplayInfo(prev => { const n = { ...prev }; delete n[sid]; return n; });
      }
      // The probed role capabilities belong to this session id. Dropping them
      // means a reconnect (possibly as a different user, or after a GRANT) is
      // re-probed rather than inheriting a stale verdict that greys panels the
      // new session can use.
      forgetPrivileges(session.sessionId);
      // Same for the MySQL-vs-MariaDB flavour probe (also cached per session
      // id): a reconnect re-probes, and dead session ids stop accumulating in
      // the module-level cache.
      forgetFlavor(session.sessionId);
      // If the tree was mid-scan, its status-bar line belongs to this session
      // — no SchemaTree path will clear it once the session is gone.
      clearSchemaScan(session.sessionId);
    } finally {
      // State removal is unconditional — a hung or failed backend close must
      // never leave the tab behind. Read through sessionsRef (and update it
      // synchronously) so parallel closes — sidebar Disconnect closes every
      // session of a connection at once — each remove their own session instead
      // of all filtering the same stale render snapshot. No nested setState
      // inside an updater (which React may run twice / discard).
      const next = sessionsRef.current.filter(s => s.sessionId !== session.sessionId);
      sessionsRef.current = next;
      setSessions(next);
      if (activeSessionId === session.sessionId) {
        const remaining = next[next.length - 1];
        if (remaining) {
          setActiveSessionId(remaining.sessionId);
          setView({ kind: 'query', session: remaining });
        } else {
          setActiveSessionId(null);
          setView({ kind: 'welcome' });
        }
      }
    }
    return threadIds;
  }

  /**
   * Disconnecting is the one close that takes the connection itself away, so
   * anything still running on it (a query, a generation job, a Playground full
   * of live threads) has to be named first — and stopped deliberately, never
   * silently.
   */
  async function handleCloseSession(session: Session, e: React.MouseEvent) {
    e.stopPropagation();
    const running = getSessionActivities(session.sessionId);
    if (running.length > 0) {
      setDisconnectAsk({ victims: [session], activities: running, fromSidebar: false });
      return;
    }
    await closeSession(session);
  }


  /**
   * Drop a `.sql` file onto the window to open it.
   *
   * Tauri's own file-drop event rather than the DOM's: the webview does not
   * receive a real path from a native drag, only an opaque handle, and a path
   * is exactly what the tab binding needs.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(async event => {
      if (event.payload.type !== 'drop') return;
      const paths = (event.payload.paths ?? []).filter(p => /\.(sql|txt)$/i.test(p));
      if (!paths.length) return;
      // Several at once is normal when dragging a folder selection.
      for (const path of paths) {
        try {
          const f = await invoke<{ text: string; encoding: string; eol: string; mtimeMs: number }>(
            'sqlfile_open', { path });
          window.dispatchEvent(new CustomEvent('dbgui:open-sql-file', {
            detail: { path, sql: f.text, encoding: f.encoding, eol: f.eol, mtimeMs: f.mtimeMs },
          }));
        } catch (err) {
          await alertDialog(`Could not open ${path}: ${errorDisplay(err)}`);
        }
      }
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);
  return (
    <GridSettingsProvider>
    {/* Nothing behind this is usable until the vault is open — the connection
        list is inside it. */}
    <UnlockGate onOpened={() => window.dispatchEvent(new CustomEvent('dbgui:connections-changed'))} />
    {/* In-DOM confirm/prompt/alert host — native script dialogs auto-accept
        on WebKitGTK and do not exist on WKWebView (utils/appDialog.ts). */}
    <AppDialogHost />
    <div className="app">
      <div className="app-body">
      {!sidebarHidden ? (
        <>
          <div className="sidebar-wrap" style={{ width: sidebarW, minWidth: sidebarW, display: 'flex' }}>
            <Sidebar
              sessions={sessions}
              onNewConnection={(group?: string) => setView({ kind: 'new-conn', group })}
              onEditConnection={cfg => setView({ kind: 'new-conn', edit: cfg })}
              onOpenSession={handleOpenSession}
              activeUtility={['multi-exec', 'audit', 'compare', 'dump', 'replicaset'].includes(view.kind) ? view.kind : null}
              onOpenMultiExec={() => view.kind === 'multi-exec' ? closeUtility() : openUtility('multi-exec')}
              onOpenAudit={() => view.kind === 'audit' ? closeUtility() : openUtility('audit')}
              onOpenCompare={() => view.kind === 'compare' ? closeUtility() : openUtility('compare')}
              onOpenDump={() => view.kind === 'dump' ? closeUtility() : openUtility('dump')}
              onOpenReplicaSet={openReplicaSet}
              onHide={toggleSidebar}
              onDisconnect={disconnectConnection}
              activeSessionId={activeSessionId}
            />
          </div>
          <div className="h-resizer" onMouseDown={dragSidebar} title="Drag to resize" />
        </>
      ) : (
        <button className="tree-rail" title={`Show connections (${SC.sidebar})`} onClick={toggleSidebar}>▸</button>
      )}

      <div className="main">
        {sessions.length > 0 && (
          <div className="tab-bar">
            {sessions.map(s => (
              <div
                key={s.sessionId}
                className={`tab ${s.sessionId === activeSessionId ? 'active' : ''}`}
                style={tabStyle({ color: s.color }, s.sessionId === activeSessionId)}
                onClick={() => handleTabClick(s)}
                onContextMenu={e => {
                  e.preventDefault();
                  setTabMenu({ x: e.clientX, y: e.clientY, session: s });
                }}
              >
                <span className="stab-label">
                  <EngineLogo engine={s.engine} size={13} title={false} />
                  {s.connectionName}
                  {/* A file engine is worth naming: SQLite, Parquet and DuckDB
                      behave unlike anything else here, and the mark alone is easy
                      to miss. For a server the connection name already says it. */}
                  {(s.engine === 'sqlite' || s.engine === 'parquet' || s.engine === 'duckdb') && (
                    <span className="stab-engine">{s.engine}</span>
                  )}
                </span>
                {s.readOnly && <span className="conn-ro" title="Read-only">🔒</span>}
                {s.environment && (
                  <span className={`env-chip env-${s.environment}`}>{s.environment.toUpperCase()}</span>
                )}
                <button
                  className="close-tab"
                  onClick={e => handleCloseSession(s, e)}
                  title="Disconnect"
                >×</button>
              </div>
            ))}
          </div>
        )}

        <div className="content">
          {view.kind === 'welcome' && (
            <div className="ws-start ws-start-solo">
              <div className="ws-start-hint">
                <h1>TxUI</h1>
                {connCount === 0 && (
                  <ul className="ws-start-steps">
                    <li>Right-click empty space in the sidebar → <b>New connection…</b> ({SC.newConnection})</li>
                    <li>…or click <b>+ Add connection</b> at the top of the sidebar</li>
                    <li>Choose the engine and fill in host, port, user and password</li>
                    <li>Click <b>Test</b>, then <b>Save</b></li>
                    <li>Double-click the connection to open it</li>
                  </ul>
                )}
                {(connCount ?? 0) > 0 && (
                  <WelcomeAudit onOpenAudit={() => openUtility('audit')} />
                )}
              </div>
            </div>
          )}

          {view.kind === 'new-conn' && (
            <ConnectionForm
              key={view.edit?.id ?? `new-${view.group ?? ''}`}
              initial={view.edit}
              initialGroup={view.group}
              onSave={handleSaveConnection}
              onCancel={() => setView({ kind: 'welcome' })}
            />
          )}

          {view.kind === 'multi-exec' && (
            <Suspense fallback={null}>
              <MultiExec onClose={closeUtility} />
            </Suspense>
          )}

          {view.kind === 'audit' && (
            <Suspense fallback={null}>
              <AuditLogPanel onClose={closeUtility} />
            </Suspense>
          )}

          {view.kind === 'compare' && (
            <Suspense fallback={null}>
              <SchemaComparePanel onClose={closeUtility} />
            </Suspense>
          )}

          {view.kind === 'dump' && (
            <Suspense fallback={null}>
              <DumpRestorePanel onClose={closeUtility} />
            </Suspense>
          )}

          {view.kind === 'replicaset' && (
            <Suspense fallback={null}>
              <ReplicaSetPanel folder={view.folder} onClose={closeUtility} />
            </Suspense>
          )}

          {view.kind === 'hypopg' && (
            <Suspense fallback={null}>
              <HypoIndexPanel session={view.session} onClose={closeUtility} />
            </Suspense>
          )}

          {/* Keep all session workspaces mounted; hide inactive ones */}
          {sessions.map(s => {
            const isVisible  = view.kind === 'query' && view.session.sessionId === s.sessionId;
            const isRedis    = s.engine === 'redis';
            // MongoDB is not SQL: it gets its own find-editor workspace (the
            // RedisBrowser routing precedent) but KEEPS the object explorer —
            // databases, collections and sampled keys are a real tree.
            const isMongo    = s.engine === 'mongodb';
            const rp         = replayInfo[s.sessionId];
            const refreshKey = schemaRefreshKeys[s.sessionId] ?? 0;
            // Detected recording: ask first, then show whichever the user picks.
            if (rp && (rp.mode === 'ask' || rp.mode === 'replay') && rp.probe) {
              return (
                <div
                  key={s.sessionId}
                  className={`workspace ${s.environment === 'prod' ? 'workspace-prod' : ''}`}
                  style={{ display: isVisible ? 'flex' : 'none' }}
                >
                  <Suspense fallback={null}>
                    {rp.mode === 'ask' ? (
                      <ReplayChooser
                        probe={rp.probe}
                        onReplay={() => setReplayMode(s.sessionId, 'replay')}
                        onRaw={() => setReplayMode(s.sessionId, 'raw')}
                      />
                    ) : (
                      <ReplayWorkspace
                        session={s}
                        path={rp.path}
                        onOpenRaw={() => setReplayMode(s.sessionId, 'raw')}
                      />
                    )}
                  </Suspense>
                </div>
              );
            }
            const rawRecording = rp?.mode === 'raw' && rp.probe?.is_recording;
            return (
              <div
                key={s.sessionId}
                className={`workspace ${s.environment === 'prod' ? 'workspace-prod' : ''}`}
                style={{ display: isVisible ? 'flex' : 'none', position: rawRecording ? 'relative' : undefined }}
              >
                {/* Detected recording opened as raw SQLite — offer the dashboard. */}
                {rawRecording && (
                  <button
                    className="rp-reopen-btn"
                    title="This file is a Dolphie recording — open the Replay dashboard"
                    onClick={() => setReplayMode(s.sessionId, 'replay')}
                  >⏱ Open Replay dashboard</button>
                )}
                {/* Object explorer — hidden for Redis (no schema); collapsible */}
                {!isRedis && !treeCollapsed && (
                  <>
                    <div style={{ width: treeW, minWidth: treeW, display: 'flex' }}>
                      <SchemaTree
                        session={s}
                        refreshKey={refreshKey}
                        onInsertText={text => insertTextRef.current?.(text)}
                        onBrowseTable={(table, kind) =>
                          window.dispatchEvent(new CustomEvent('dbgui:browse-table', { detail: { table, kind } }))}
                        onCollapse={() => toggleTree(true)}
                      />
                    </div>
                    <div className="h-resizer" onMouseDown={dragTree} title="Drag to resize" />
                  </>
                )}
                {!isRedis && treeCollapsed && (
                  <button
                    className="tree-rail"
                    title="Show object explorer"
                    onClick={() => toggleTree(false)}
                  >▸</button>
                )}

                <div className="editor-pane">
                  {isRedis ? (
                    /* Redis gets its own full-pane browser */
                    <Suspense fallback={null}>
                      <RedisBrowser session={s} isActive={s.sessionId === activeSessionId} />
                    </Suspense>
                  ) : isMongo ? (
                    /* MongoDB gets the find editor + JSON grid (no SQL editor) */
                    <Suspense fallback={null}>
                      <MongoBrowser session={s} isActive={s.sessionId === activeSessionId} />
                    </Suspense>
                  ) : (
                    /* Editor is ALWAYS visible — table browsing lives in its result tabs */
                    <div style={{ display: 'flex', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
                      <QueryTabs
                        session={s}
                        openSessions={sessions}
                        isActive={s.sessionId === activeSessionId}
                        insertTextRef={s.sessionId === activeSessionId ? insertTextRef : undefined}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}

        </div>
      </div>
      </div>

      <StatusBar sessions={sessions} />

      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          onClose={() => { setPaletteOpen(false); setPaletteSections(undefined); }}
          onlySections={paletteSections}
          perSection={paletteSections ? 25 : undefined}
          placeholder={paletteSections ? 'Go to table or column…' : undefined}
        />
      )}

      {disconnectAsk && (
        <CloseTabConfirm
          tabLabel={disconnectAsk.victims.length === 1
            ? `${disconnectAsk.victims[0].connectionName} (disconnect)`
            : `${disconnectAsk.victims[0].connectionName} (${disconnectAsk.victims.length} sessions)`}
          isDisconnect
          activities={disconnectAsk.activities}
          onCancel={() => setDisconnectAsk(null)}
          onCloseKeepRunning={() => setDisconnectAsk(null)}
          onKillAndClose={() => {
            const { victims, activities, fromSidebar } = disconnectAsk;
            setDisconnectAsk(null);
            // Fire every cancel, await NONE of them: each kill closure only
            // resolves when its cancel command returns, not when the work is
            // dead — and the backend close sweeps and cancels the session's
            // work itself now. Serially awaiting them would only delay the close.
            for (const a of activities) {
              try { void a.kill?.(); } catch { /* best-effort: disconnecting anyway */ }
            }
            if (fromSidebar) void disconnectNow(victims);
            else void closeSession(victims[0]);
          }}
        />
      )}

      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {whatsNewOpen && <Suspense fallback={null}><WhatsNewModal onClose={() => setWhatsNewOpen(false)} /></Suspense>}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {prodAckAsk && (
        <ProdAck
          request={prodAckAsk.request}
          onCancel={cancelProdAck}
          onConfirm={() => {
            const { session } = prodAckAsk;
            ackProd(session.connectionId);
            setProdAckAsk(null);
            openSessionNow(session);
          }}
        />
      )}

      {genMenu && (
        <ContextMenu x={genMenu.x} y={genMenu.y} onClose={() => setGenMenu(null)}>
          {genMenu.selection && (
            <ContextMenuItem
              label="Copy selection"
              onClick={() => {
                navigator.clipboard.writeText(genMenu.selection).catch(() => {});
                setGenMenu(null);
              }}
            />
          )}
          <ContextMenuItem label={`Command palette…   ${SC.palette}`}
            onClick={() => { setGenMenu(null); setPaletteSections(undefined); setPaletteOpen(true); }} />
          <ContextMenuItem label={`Go to table…   ${SC.goToTable}`}
            onClick={() => { setGenMenu(null); openQuickOpen(); }} />
          <ContextMenuItem label={`${sidebarHidden ? 'Show' : 'Hide'} connections   ${SC.sidebar}`}
            onClick={() => { toggleSidebar(); setGenMenu(null); }} />
        </ContextMenu>
      )}

      {renameSession && (
        <div className="modal-overlay" onClick={() => setRenameSession(null)}>
          <div className="modal rename-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header"><span className="modal-title">Rename connection</span></div>
            <div className="rename-body">
              <input
                autoFocus
                value={renameSession.value}
                onChange={e => setRenameSession({ ...renameSession, value: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter') void applyRename(renameSession.id, renameSession.value);
                  if (e.key === 'Escape') setRenameSession(null);
                }}
              />
              <div className="rename-actions">
                <button className="toolbar-btn" onClick={() => setRenameSession(null)}>Cancel</button>
                <button className="toolbar-btn"
                        onClick={() => void applyRename(renameSession.id, renameSession.value)}>
                  Rename
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)}>
          {/* Rename and colour act on the CONNECTION, so they persist and show
              up in the sidebar too — which is what renaming a server tab is
              understood to mean. A scratch session has no saved connection
              behind it, so it does not get them: a button that silently does
              nothing is worse than no button. Duplicate and Disconnect stay:
              a fresh scratch and dropping the in-memory database are both
              meaningful. */}
          {!tabMenu.session.scratch && (
            <>
          <ContextMenuItem
            label="Rename connection…"
            onClick={() => {
              const s = tabMenu.session;
              setTabMenu(null);
              setRenameSession({ id: s.connectionId, value: s.connectionName });
            }}
          />
          <div className="qtab-menu-colors">
            <button
              className="qtab-swatch"
              title="no colour"
              style={{ background: 'transparent', borderColor: 'var(--border)' }}
              onClick={() => { setTabColor(tabMenu.session, null); setTabMenu(null); }}
            >✕</button>
            {PALETTE.map(c => (
              <button
                key={c}
                className="qtab-swatch"
                title={c}
                style={{ background: c, borderColor: c }}
                onClick={() => { setTabColor(tabMenu.session, c); setTabMenu(null); }}
              />
            ))}
          </div>
            </>
          )}
          <ContextMenuItem
            label="Duplicate session"
            onClick={() => { setTabMenu(null); duplicateSession(tabMenu.session); }}
          />
          <ContextMenuItem
            label="Disconnect"
            danger
            onClick={() => { setTabMenu(null); closeSession(tabMenu.session); }}
          />
        </ContextMenu>
      )}
    </div>
    </GridSettingsProvider>
  );
}
