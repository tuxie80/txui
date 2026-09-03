import { errorDisplay } from '../utils/appError';
import { confirmDialog } from '../utils/appDialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { ConnectionConfig, PingResult, Session } from '../types';
import { ConnectionsStore } from '../store/connections';
import { notifyConnectFailed } from '../store/notify';
import { getFolderMeta, setFolderMeta, renameFolderMeta, useFolderMetaStore } from '../store/folderMeta';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { isFavorite, toggleFavorite, favoriteIds, pruneFavorites, useConnFavorites } from '../store/connFavorites';
import { EngineLogo } from './engineLogos';
import { withDeadline } from '../utils/withDeadline';
import { getPref, PREFS } from '../store/preferences';
import { shortcuts } from '../utils/platform';
import { labelsOf, visibleLabels, matchesLabelSearch } from '../utils/labels';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

interface Props {
  sessions: Session[];
  onNewConnection: (group?: string) => void;
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

const TAG_PALETTE = ['#6c8fff', '#4caf73', '#e0b050', '#50c8c8', '#b06ce0', '#e07a9e', '#e0894a', '#7a8aa0'];
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
  /** connectionId → epoch ms the in-flight connect/test started. */
  const [attempts, setAttempts] = useState<Record<string, number>>({});
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
    }
  }, [sessions]);

  useEffect(() => {
    const load = () => ConnectionsStore.list().then(cfgs => {
      pruneFavorites(new Set(cfgs.map(c => c.id)));
      setConns(cfgs.map(c => ({ config: c, status: 'idle' })));
    });
    load();
    // Re-load after save/delete from the connection form
    window.addEventListener('dbgui:connections-changed', load);
    return () => window.removeEventListener('dbgui:connections-changed', load);
  }, []);

  async function handleDelete(state: ConnState) {
    if (!await confirmDialog(`Delete connection "${state.config.name}"? The stored password is removed too.`, { danger: true, okLabel: 'Delete' })) return;
    await ConnectionsStore.delete(state.config.id);
    setConns(prev => prev.filter(c => c.config.id !== state.config.id));
  }

  function logConn(level: 'info' | 'ok' | 'err', msg: string) {
    window.dispatchEvent(new CustomEvent('dbgui:conn-log', { detail: { level, msg } }));
  }

  /**
   * A connect that never answers used to leave the row amber forever: the
   * backend had no default timeout, so an unreachable host sat on the OS's
   * SYN retries. The backend now bounds it, and the UI bounds it again —
   * because "connecting" with no elapsed time and no end is indistinguishable
   * from the app being broken.
   */
  function connectDeadlineMs(cfg: ConnectionConfig): number {
    // The connection's own timeout plus grace for TLS/handshake/SSH, or the
    // backend default (15s) plus the same grace.
    return ((cfg.connect_timeout_secs ?? 15) + 8) * 1000;
  }

  function beginAttempt(id: string) {
    setAttempts(prev => ({ ...prev, [id]: Date.now() }));
  }
  function endAttempt(id: string) {
    setAttempts(prev => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function handleConnect(state: ConnState) {
    const idx = conns.findIndex(c => c.config.id === state.config.id);
    setConns(prev => prev.map((c, i) => i === idx ? { ...c, status: 'connecting' } : c));
    beginAttempt(state.config.id);
    logConn('info', `Connecting to ${state.config.name}…`);
    const started = Date.now();
    try {
      const sessionId = await withDeadline(
        ConnectionsStore.open(state.config.id), connectDeadlineMs(state.config));
      const session: Session = {
        connectionId: state.config.id,
        sessionId,
        connectionName: state.config.name,
        engine: state.config.engine,
        environment: state.config.environment,
        readOnly: state.config.read_only,
        color: state.config.color,
        filePath: state.config.file_path,
      };
      setConns(prev => prev.map((c, i) => i === idx ? { ...c, status: 'connected' } : c));
      logConn('ok', `Connected to ${state.config.name}`);
      onOpenSession(session);
    } catch (err) {
      const secs = Math.round((Date.now() - started) / 1000);
      const msg = `${errorDisplay(err)} (after ${secs}s)`;
      // Back to a resting state that says what happened — never left amber.
      setConns(prev => prev.map((c, i) =>
        i === idx ? { ...c, status: 'error', ping: { ok: false, latency_ms: secs * 1000, server_version: null, error: msg } } : c
      ));
      logConn('err', `${state.config.name} — ${msg}`);
      // And say it out loud — the red dot alone was the whole feedback before.
      void notifyConnectFailed(state.config.name, errorDisplay(err));
    } finally {
      endAttempt(state.config.id);
    }
  }

  async function handleTest(state: ConnState) {
    const idx = conns.findIndex(c => c.config.id === state.config.id);
    setConns(prev => prev.map((c, i) => i === idx ? { ...c, status: 'connecting' } : c));
    beginAttempt(state.config.id);
    logConn('info', `Testing ${state.config.name}…`);
    const started = Date.now();
    let ping: PingResult;
    try {
      ping = await withDeadline(ConnectionsStore.test(state.config.id), connectDeadlineMs(state.config));
    } catch (err) {
      const secs = Math.round((Date.now() - started) / 1000);
      ping = { ok: false, latency_ms: secs * 1000, server_version: null,
               error: `${errorDisplay(err)} (after ${secs}s)` };
    } finally {
      endAttempt(state.config.id);
    }
    setConns(prev => prev.map((c, i) =>
      i === idx ? { ...c, status: ping.ok ? 'idle' : 'error', ping } : c
    ));
    if (ping.ok) logConn('ok', `${state.config.name} OK${ping.server_version ? ` — ${ping.server_version}` : ''} (${ping.latency_ms}ms)`);
    else logConn('err', `${state.config.name} — ${ping.error ?? 'failed'}`);
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

  /** Export all connections (configs only, never secrets) to a JSON file. */
  async function handleExport() {
    try {
      const path = await save({
        defaultPath: 'txui-connections.json',
        filters: [{ name: 'TxUI connections', extensions: ['json'] }],
      });
      if (!path) return;
      const json = await ConnectionsStore.exportAll();
      await invoke('write_text_file', { path, contents: json });
      logConn('ok', `Exported connections to ${path}`);
    } catch (err) {
      logConn('err', `Export failed — ${errorDisplay(err)}`);
    }
  }

  /** Import an export envelope; fresh ids are assigned, no secrets come along. */
  async function handleImport() {
    try {
      const path = await open({ multiple: false, filters: [{ name: 'TxUI connections', extensions: ['json'] }] });
      if (!path || typeof path !== 'string') return;
      const json = await invoke<string>('read_text_file', { path });
      const n = await ConnectionsStore.importJson(json);
      window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
      logConn('ok', `Imported ${n} connection${n === 1 ? '' : 's'} — passwords are not imported, set them per connection`);
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
  useEffect(() => {
    if (sessions.length === 0) { setLatencies({}); return; }
    const tick = async () => {
      if (document.visibilityState === 'hidden') return;
      const next: Record<string, number> = {};
      await Promise.all(sessions.map(async s => {
        try { next[s.connectionId] = await ConnectionsStore.sessionPing(s.sessionId); }
        catch {
          // Keepalive: a failed ping usually means the pooled socket died while
          // asleep. Retry once — sqlx re-establishes it — so the connection is
          // warm again before the next real query, and the blip self-heals.
          if (!getPref(PREFS.keepAlive)) return;
          try { next[s.connectionId] = await ConnectionsStore.sessionPing(s.sessionId); }
          catch { /* still down — the badge just disappears */ }
        }
      }));
      setLatencies(next);
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

  function renderConn(cs: ConnState, depth: number) {
    const connected = sessions.some(s => s.connectionId === cs.config.id);
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
          {connected && latencies[cs.config.id] != null && (
            <span className="conn-latency" title="Round-trip latency (session ping, refreshed every 30 s)">
              {latencies[cs.config.id]} ms
            </span>
          )}
          {cs.status === 'connecting' && attempts[cs.config.id] != null && (
            <span className="conn-elapsed" title="Waiting for the server to answer">
              {Math.max(0, Math.round((Date.now() - attempts[cs.config.id]) / 1000))}s
            </span>
          )}
          {cs.status === 'error' && (
            <span className="conn-failed" title={cs.ping?.error ?? 'failed'}>failed</span>
          )}
          <span
            className={`status-dot status-${connected ? 'connected' : cs.status}`}
            title={connected ? 'connected'
              : cs.status === 'disconnected' ? 'disconnected — last session closed'
              : cs.ping?.error ?? cs.status}
          />
        </div>
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
        className="conn-filter"
        placeholder="Filter connections…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />

      {/* No hover tooltips anywhere in the connections list — the row's own
          text is enough, and a black box popping up on every mouse move over
          the list is noise, not help. `data-notip` suppresses both our tooltip
          and the browser's native `title` one (see utils/tooltip.ts). */}
      <div className="conn-list" data-notip
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
        <button className="icon-btn" title="Export all connections to JSON (no passwords)" onClick={handleExport}>⤒</button>
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
          <ContextMenuItem label="Connect" onClick={() => { handleConnect(ctxMenu.cs); setCtxMenu(null); }} />
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
            {[null, '#e05555', '#e0b050', '#4caf73', '#50c8c8', '#6c8fff', '#b06ce0', '#e07a9e', '#808a9a'].map(c => (
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
