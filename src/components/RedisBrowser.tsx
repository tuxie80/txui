/**
 * Redis Key Browser
 * - Left: SCAN-based key list with pattern search + Load more, grouped into a
 *   namespace tree (utils/redisKeyTree.ts) — SCAN cursors only, never KEYS
 * - Right: type-aware key detail (viewer/editor) + TTL editor + OBJECT ENCODING + delete
 * - Audit tab: TTL/type/encoding findings over the scanned keys (utils/redisAudit.ts)
 * - INFO tab: parsed Redis server INFO
 * - Console tab: typed commands (GET x / HGETALL h / INFO) through the mini
 *   QueryEditor → execute_query, with redisguard enforced server-side
 * - The db strip under the tab bar shows the server's logical databases (from
 *   list_schema's INFO-keyspace labels) and which one this session is on; it
 *   is an INDICATOR, not a switcher — the gap is registered in
 *   utils/engineGaps.ts ('redis::databaseSelect')
 * - Sentinel awareness: on a Sentinel port a banner shows the monitored
 *   topology instead of pretending there is a browsable keyspace
 * - DBA panels (Processes / Server / Tuner / DBA views) open as extra tabs via
 *   the Tools menu's `dbgui:toggle-panel` events — a Redis session mounts this
 *   instead of QueryTabs, so the listener has to live here too.
 */
import { errorDisplay } from '../utils/appError';
import { confirmDialog } from '../utils/appDialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Session } from '../types';
import { redisPanel, redisPanelAllowed } from '../utils/redisPanels';
import { buildRedisKeyTree, autoExpandedPrefixes, type RedisKeyNode } from '../utils/redisKeyTree';
import {
  auditRedisKeys, summarizeFindings, auditButtonLabel, AUDIT_MAX_KEYS,
  type AuditFinding, type RedisKeyAuditRow,
} from '../utils/redisAudit';
import { audited } from '../utils/panelAudit';
import { validateTtlInput, ttlToPreserveOnEdit } from '../utils/redisTtl';
import { mergeScannedKeys } from '../utils/redisScan';
import { shownOfTotal, valueItemCount } from '../utils/redisValue';
import { parseRedisDbLabel, redisConfigDbIndex } from '../utils/redisDbs';
import { engineGapReason } from '../utils/engineGaps';
import { QueryEditor } from './QueryEditor';
import { SchemaStore } from '../store/schema';
import { ConnectionsStore } from '../store/connections';
import {
  GEO_DERIVATION_NOTE, geoExtent, geoSummary, graticuleLines, projectPoints,
  type RedisGeoResult,
} from '../utils/redisGeo';
import { PanelIcon } from './panelIcons';
import { ProcessListPanel } from './ProcessListPanel';
import { ServerInfoPanel } from './ServerInfoPanel';
import { TunerPanel } from './TunerPanel';
import { DbaViewsPanel } from './DbaViewsPanel';

interface Props { session: Session; isActive?: boolean }

// ── Types mirroring Rust enums ────────────────────────────────────────────────

interface KeyInfo   { key: string; key_type: string; ttl: number; size: number; encoding: string | null }
interface ScanResult { cursor: number; keys: string[] }
interface HashField  { field: string; value: string }
interface ZsetEntry  { member: string; score: number }
interface StreamEntry { id: string; fields: Record<string, string> }
interface SentinelReplica { ip: string; port: string; status: string }
interface SentinelMaster  { name: string; ip: string; port: string; status: string; replicas: SentinelReplica[] }
interface SentinelOverview { mode: string; masters: SentinelMaster[] }

type RedisValue =
  | { type: 'string'; value: string | null }
  | { type: 'list';   items: string[] }
  | { type: 'hash';   fields: HashField[] }
  | { type: 'set';    members: string[] }
  | { type: 'zset';   entries: ZsetEntry[] }
  | { type: 'stream'; entries: StreamEntry[] }
  | { type: 'none' };

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  string: '#6c8fff', list: '#4caf73', hash: '#e0b050',
  set: '#b06cff',   zset: '#e07050', stream: '#50c0e0', none: '#666',
};

function formatTtl(ttl: number): string {
  if (ttl === -1) return '∞ persistent';
  if (ttl === -2) return '(expired)';
  if (ttl >= 86400) return `${Math.floor(ttl / 86400)}d ${Math.floor((ttl % 86400) / 3600)}h`;
  if (ttl >= 3600) return `${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`;
  if (ttl >= 60) return `${Math.floor(ttl / 60)}m ${ttl % 60}s`;
  return `${ttl}s`;
}

function formatSize(type: string, size: number): string {
  if (type === 'string') {
    if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    if (size > 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${size} B`;
  }
  return `${size} items`;
}

// Parse Redis INFO string into sections
function parseInfo(raw: string): Array<{ section: string; rows: Array<[string, string]> }> {
  const sections: Array<{ section: string; rows: Array<[string, string]> }> = [];
  let current: { section: string; rows: Array<[string, string]> } | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (trimmed.startsWith('# ')) {
        current = { section: trimmed.slice(2), rows: [] };
        sections.push(current);
      }
      continue;
    }
    const idx = trimmed.indexOf(':');
    if (idx >= 0 && current) {
      current.rows.push([trimmed.slice(0, idx), trimmed.slice(idx + 1)]);
    }
  }
  return sections;
}

// ── Key List (namespace tree) ─────────────────────────────────────────────────

function KeyRow({ k, depth, selectedKey, onSelect }: {
  k: string; depth: number; selectedKey: string | null; onSelect: (k: string) => void
}) {
  return (
    <div
      className={`rb-key-row ${k === selectedKey ? 'selected' : ''}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={() => onSelect(k)}
      title={k}
    >
      <span className="rb-key-name">{k}</span>
    </div>
  );
}

function NamespaceNode({ node, depth, expanded, onToggle, selectedKey, onSelect }: {
  node: RedisKeyNode; depth: number;
  expanded: Set<string>; onToggle: (prefix: string) => void;
  selectedKey: string | null; onSelect: (k: string) => void;
}) {
  const open = expanded.has(node.prefix);
  return (
    <>
      <div
        className="rb-ns-row"
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => onToggle(node.prefix)}
        title={`${node.prefix}* — ${node.count.toLocaleString()} keys`}
      >
        <span className="rb-ns-caret">{open ? '▾' : '▸'}</span>
        <span className="rb-ns-name">{node.name}</span>
        <span className="rb-ns-count">{node.count.toLocaleString()}</span>
      </div>
      {open && node.keys.map(k => (
        <KeyRow key={k} k={k} depth={depth + 1} selectedKey={selectedKey} onSelect={onSelect} />
      ))}
      {open && node.children.map(c => (
        <NamespaceNode key={c.prefix} node={c} depth={depth + 1}
          expanded={expanded} onToggle={onToggle} selectedKey={selectedKey} onSelect={onSelect} />
      ))}
    </>
  );
}

function KeyTree({ keys, selectedKey, onSelect }: {
  keys: string[]; selectedKey: string | null; onSelect: (k: string) => void
}) {
  const tree = useMemo(() => buildRedisKeyTree(keys), [keys]);
  // Expand state keyed by full prefix. Initialised per tree build by the
  // auto-expand rule; user toggles from earlier builds survive a re-scan.
  const [expanded, setExpanded] = useState<Set<string>>(() => autoExpandedPrefixes(tree));
  // Prefixes the auto rule has already applied — re-scanning or loading more
  // keys must not re-expand a namespace the user deliberately collapsed.
  const autoSeenRef = useRef<Set<string>>(new Set(autoExpandedPrefixes(tree)));
  useEffect(() => {
    const fresh = [...autoExpandedPrefixes(tree)].filter(p => !autoSeenRef.current.has(p));
    if (fresh.length === 0) return;
    fresh.forEach(p => autoSeenRef.current.add(p));
    setExpanded(prev => new Set([...prev, ...fresh]));
  }, [tree]);

  const toggle = useCallback((prefix: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix); else next.add(prefix);
      return next;
    });
  }, []);

  return (
    <div className="rb-key-list">
      {tree.namespaces.map(n => (
        <NamespaceNode key={n.prefix} node={n} depth={0}
          expanded={expanded} onToggle={toggle} selectedKey={selectedKey} onSelect={onSelect} />
      ))}
      {tree.bare.map(k => (
        <KeyRow key={k} k={k} depth={0} selectedKey={selectedKey} onSelect={onSelect} />
      ))}
    </div>
  );
}

// ── Key Detail ────────────────────────────────────────────────────────────────

function KeyDetail({ sessionId, engine, readOnly, keyInfo, value, onDeleted, onValueSaved, onTtlSaved }: {
  sessionId:   string;
  engine:      Session['engine'];
  /** Read-only connection: write controls grey with the reason, never hide. */
  readOnly:    boolean;
  keyInfo:     KeyInfo;
  value:       RedisValue | null;
  onDeleted:   () => void;
  onValueSaved:() => void;
  onTtlSaved:  (newTtl: number) => void;
}) {
  const [editTtl, setEditTtl]   = useState(false);
  const [ttlInput, setTtlInput] = useState('');
  const [strEdit, setStrEdit]   = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  const roTip = (action: string) =>
    readOnly ? `Connection is read-only — ${action} is blocked.` : undefined;

  async function handleDelete() {
    if (readOnly) return;
    if (!await confirmDialog(`Delete key "${keyInfo.key}"?`, { danger: true, okLabel: 'Delete' })) return;
    try {
      await audited({
        sessionId, engine, tab: 'Redis browser', source: 'panel',
        statement: `DEL ${keyInfo.key}`,
        rowsAffected: (n: number) => n,
        run: () => invoke<number>('redis_delete_keys', { sessionId, keys: [keyInfo.key] }),
      });
      onDeleted();
    } catch (e) { setErr(errorDisplay(e)); }
  }

  async function handleSaveString() {
    if (strEdit === null || readOnly) return;
    setSaving(true); setErr(null);
    // SET without EX wipes the key's TTL — send back the TTL the key has so
    // the edit preserves it (KEEPTTL would need Redis ≥ 6).
    const ttlSecs = ttlToPreserveOnEdit(keyInfo.ttl);
    try {
      await audited({
        sessionId, engine, tab: 'Redis browser', source: 'panel',
        statement: `SET ${keyInfo.key} ${JSON.stringify(strEdit)}${ttlSecs ? ` EX ${ttlSecs}` : ''}`,
        run: () => invoke('redis_set_string', {
          sessionId, key: keyInfo.key, value: strEdit, ttlSecs,
        }),
      });
      onValueSaved();
      setStrEdit(null);
    } catch (e) { setErr(errorDisplay(e)); }
    finally { setSaving(false); }
  }

  async function handleSaveTtl() {
    if (readOnly) return;
    setErr(null);
    // 0 would EXPIRE key 0 — an immediate delete with no confirmation — and
    // negatives other than -1 are not Redis TTLs. Validated here and again
    // server-side (set_ttl_body).
    const parsed = validateTtlInput(ttlInput);
    if (!parsed.ok) { setErr(parsed.error); return; }
    const secs = parsed.secs;
    try {
      await audited({
        sessionId, engine, tab: 'Redis browser', source: 'panel',
        statement: secs < 0 ? `PERSIST ${keyInfo.key}` : `EXPIRE ${keyInfo.key} ${secs}`,
        run: () => invoke('redis_set_ttl', { sessionId, key: keyInfo.key, ttlSecs: secs }),
      });
      setEditTtl(false);
      onTtlSaved(secs < 0 ? -1 : secs);
    } catch (e) { setErr(errorDisplay(e)); }
  }

  // A capped collection page must not pose as the whole value: the backend
  // reads at most 200 items (50 for a stream) while the header knows the real
  // cardinality.
  const shownCount = value ? valueItemCount(value) : null;
  const truncNote = shownCount !== null ? shownOfTotal(shownCount, keyInfo.size) : null;

  return (
    <div className="rb-detail">
      {/* Header */}
      <div className="rb-detail-header">
        <span className="rb-type-badge" style={{ background: TYPE_COLOR[keyInfo.key_type] ?? '#666' }}>
          {keyInfo.key_type.toUpperCase()}
        </span>
        {keyInfo.encoding && (
          <span className="rb-enc-badge" title="OBJECT ENCODING">{keyInfo.encoding}</span>
        )}
        <span className="rb-detail-key" title={keyInfo.key}>{keyInfo.key}</span>
        <span className="rb-detail-size">{formatSize(keyInfo.key_type, keyInfo.size)}</span>
        <button
          className={`rb-delete-btn${readOnly ? ' unavail' : ''}`}
          data-tip={roTip('deleting keys')}
          onClick={handleDelete}
          title={roTip('deleting keys') ?? 'Delete key'}
        >🗑 Delete</button>
      </div>

      {/* TTL row */}
      <div className="rb-ttl-row">
        <span className="rb-ttl-label">TTL:</span>
        {editTtl ? (
          <>
            <input
              className="rb-ttl-input"
              value={ttlInput}
              onChange={e => setTtlInput(e.target.value)}
              placeholder="-1 = persistent, or seconds"
              onKeyDown={e => { if (e.key === 'Enter') handleSaveTtl(); if (e.key === 'Escape') setEditTtl(false); }}
              autoFocus
            />
            <button className="rb-small-btn" onClick={handleSaveTtl}>Set</button>
            <button className="rb-small-btn" onClick={() => setEditTtl(false)}>Cancel</button>
          </>
        ) : (
          <>
            <span className={`rb-ttl-val ${keyInfo.ttl === -2 ? 'expired' : ''}`}>
              {formatTtl(keyInfo.ttl)}
            </span>
            <button
              className={`rb-small-btn${readOnly ? ' unavail' : ''}`}
              data-tip={roTip('changing TTLs')}
              onClick={() => { if (readOnly) return; setTtlInput(String(keyInfo.ttl)); setEditTtl(true); }}
            >
              Edit
            </button>
          </>
        )}
      </div>

      {err && <div className="rb-err">{err}</div>}
      {truncNote && <div className="rb-trunc-note">{truncNote}</div>}

      {/* Value viewer */}
      <div className="rb-value-area">
        {!value && <div className="rb-loading">Loading…</div>}
        {value && <ValueViewer
          value={value}
          sessionId={sessionId}
          keyName={keyInfo.key}
          strEdit={strEdit}
          onStrEdit={setStrEdit}
          onSaveString={handleSaveString}
          saving={saving}
          readOnly={readOnly}
          readOnlyTip={roTip('writing keys')}
        />}
      </div>
    </div>
  );
}

function ValueViewer({ value, sessionId, keyName, strEdit, onStrEdit, onSaveString, saving, readOnly, readOnlyTip }: {
  value: RedisValue;
  sessionId: string;
  keyName: string;
  strEdit: string | null;
  onStrEdit: (v: string) => void;
  onSaveString: () => void;
  saving: boolean;
  readOnly: boolean;
  readOnlyTip: string | undefined;
}) {
  if (value.type === 'none')   return <div className="rb-no-value">Key does not exist.</div>;

  if (value.type === 'string') return (
    <div className="rb-str-wrap">
      <textarea
        className="rb-str-editor"
        value={strEdit !== null ? strEdit : (value.value ?? '')}
        onChange={e => onStrEdit(e.target.value)}
        onFocus={() => { if (strEdit === null) onStrEdit(value.value ?? ''); }}
        spellCheck={false}
      />
      {strEdit !== null && (
        <button
          className={`rb-save-btn${readOnly ? ' unavail' : ''}`}
          data-tip={readOnlyTip}
          onClick={() => { if (!readOnly) onSaveString(); }}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  );

  if (value.type === 'list')   return (
    <div className="rb-list-wrap">
      {value.items.map((item, i) => (
        <div key={i} className="rb-list-item">
          <span className="rb-idx">{i}</span>
          <span className="rb-item-val">{item}</span>
        </div>
      ))}
    </div>
  );

  if (value.type === 'hash')   return (
    <table className="rb-table">
      <thead><tr><th>Field</th><th>Value</th></tr></thead>
      <tbody>
        {value.fields.map(f => (
          <tr key={f.field}>
            <td className="rb-field-name">{f.field}</td>
            <td className="rb-field-val">{f.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  if (value.type === 'set')    return (
    <div className="rb-set-wrap">
      {value.members.map(m => (
        <span key={m} className="rb-member-chip">{m}</span>
      ))}
    </div>
  );

  if (value.type === 'zset')   return (
    <ZsetValue entries={value.entries} sessionId={sessionId} keyName={keyName} />
  );

  if (value.type === 'stream') {
    const allFields = Array.from(new Set(value.entries.flatMap(e => Object.keys(e.fields))));
    return (
      <table className="rb-table rb-stream-table">
        <thead><tr><th>ID</th>{allFields.map(f => <th key={f}>{f}</th>)}</tr></thead>
        <tbody>
          {value.entries.map(e => (
            <tr key={e.id}>
              <td className="rb-stream-id">{e.id}</td>
              {allFields.map(f => <td key={f}>{e.fields[f] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return null;
}

// ── Zset viewer + "view as geo" ───────────────────────────────────────────────

/**
 * The zset table plus the opt-in geo view. Detection is deliberately NOT
 * automatic: any zset's scores decode as geohash52, so a leaderboard would
 * light up too — the user asks ("⬡ View as geo"), GEOPOS answers, and the
 * summary line reports exactly what came back (located / no coordinates /
 * capped).
 */
function ZsetValue({ entries, sessionId, keyName }: {
  entries: ZsetEntry[]; sessionId: string; keyName: string;
}) {
  const [geo, setGeo]         = useState<RedisGeoResult | null>(null);
  const [geoOpen, setGeoOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [geoErr, setGeoErr]   = useState<string | null>(null);

  async function viewAsGeo() {
    if (geoOpen) { setGeoOpen(false); return; }
    if (geo) { setGeoOpen(true); return; }   // re-open the already-resolved view
    setLoading(true); setGeoErr(null);
    try {
      const r = await invoke<RedisGeoResult>('redis_geo_points', { sessionId, key: keyName, limit: null });
      setGeo(r);
      setGeoOpen(true);
    } catch (e) { setGeoErr(errorDisplay(e)); }
    finally { setLoading(false); }
  }

  return (
    <div>
      <table className="rb-table">
        <thead><tr><th>Score</th><th>Member</th></tr></thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i}>
              <td className="rb-score">{e.score}</td>
              <td>{e.member}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rb-geo-toolbar">
        <button
          className="rb-small-btn"
          onClick={viewAsGeo}
          disabled={loading}
          title="Resolve members to coordinates with GEOPOS and draw them (read-only)"
        >
          {loading ? 'Resolving…' : geoOpen ? '⬡ Hide geo view' : '⬡ View as geo'}
        </button>
        {geoErr && <span className="rb-err">{geoErr}</span>}
      </div>
      {geoOpen && geo && <GeoPointsView result={geo} />}
    </div>
  );
}

const GEO_CV_W = 620;
const GEO_CV_H = 260;
const GEO_CV_PAD = 24;

function GeoPointsView({ result }: { result: RedisGeoResult }) {
  const ext = geoExtent(result.points);
  return (
    <div className="rb-geo-panel">
      <div className="rb-geo-summary">{geoSummary(result)}</div>
      <div className="rb-geo-note">{GEO_DERIVATION_NOTE}</div>
      {result.points.length > 0 && ext && (
        <>
          <GeoCanvas points={result.points} />
          <div className="rb-geo-extent">
            lon {ext.minLon.toFixed(5)} … {ext.maxLon.toFixed(5)} ·
            lat {ext.minLat.toFixed(5)} … {ext.maxLat.toFixed(5)}
          </div>
        </>
      )}
    </div>
  );
}

/** Lat/lon scatter with a graticule — self-contained; the app map stays out of it. */
function GeoCanvas({ points }: { points: RedisGeoResult['points'] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = GEO_CV_W * dpr;
    cv.height = GEO_CV_H * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, GEO_CV_W, GEO_CV_H);

    const css = getComputedStyle(cv);
    const grid = css.getPropertyValue('--text2').trim() || '#888';
    const dot  = css.getPropertyValue('--accent').trim() || '#3b82f6';

    const ext = geoExtent(points);
    if (!ext) return;
    const projected = projectPoints(points, GEO_CV_W, GEO_CV_H, GEO_CV_PAD);

    // Graticule: nice-degree lines through the data extent.
    ctx.strokeStyle = grid;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    const lonLines = graticuleLines(ext.minLon, ext.maxLon);
    const latLines = graticuleLines(ext.minLat, ext.maxLat);
    for (const lon of lonLines) {
      const [a, b] = projectPoints(
        [{ member: '', lon, lat: ext.minLat }, { member: '', lon, lat: ext.maxLat }],
        GEO_CV_W, GEO_CV_H, GEO_CV_PAD);
      if (ext.minLat === ext.maxLat) { a.y = GEO_CV_PAD; b.y = GEO_CV_H - GEO_CV_PAD; }
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (const lat of latLines) {
      const [a, b] = projectPoints(
        [{ member: '', lon: ext.minLon, lat }, { member: '', lon: ext.maxLon, lat }],
        GEO_CV_W, GEO_CV_H, GEO_CV_PAD);
      if (ext.minLon === ext.maxLon) { a.x = GEO_CV_PAD; b.x = GEO_CV_W - GEO_CV_PAD; }
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.fillStyle = dot;
    for (const p of projected) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [points]);

  return (
    <canvas
      ref={ref}
      className="rb-geo-canvas"
      style={{ width: '100%', height: GEO_CV_H }}
      title={`${points.length.toLocaleString()} points (equirectangular)`}
    />
  );
}

// ── INFO Tab ──────────────────────────────────────────────────────────────────

function InfoPanel({ sessionId }: { sessionId: string }) {
  const [raw, setRaw]       = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);

  async function refresh() {
    setLoading(true); setErr(null);
    try {
      const s = await invoke<string>('redis_server_info', { sessionId, section: null });
      setRaw(s);
    } catch (e) { setErr(errorDisplay(e)); }
    finally { setLoading(false); }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, [sessionId]);

  const sections = raw ? parseInfo(raw) : [];

  return (
    <div className="rb-info-panel">
      <div className="rb-info-toolbar">
        <button className="rb-small-btn" onClick={refresh} disabled={loading}>
          {loading ? 'Loading…' : '↺ Refresh'}
        </button>
      </div>
      {err && <div className="rb-err">{err}</div>}
      {sections.map(s => (
        <div key={s.section} className="rb-info-section">
          <div className="rb-info-section-title">{s.section}</div>
          <table className="rb-table">
            <tbody>
              {s.rows.map(([k, v]) => (
                <tr key={k}>
                  <td className="rb-info-key">{k}</td>
                  <td className="rb-info-val">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ── Sentinel banner ───────────────────────────────────────────────────────────

function SentinelBanner({ overview }: { overview: SentinelOverview }) {
  const [open, setOpen] = useState(false);
  const n = overview.masters.length;
  return (
    <div className="rb-sentinel">
      <div className="rb-sentinel-head" onClick={() => setOpen(o => !o)}>
        <span className="rb-ns-caret">{open ? '▾' : '▸'}</span>
        <strong>Sentinel mode</strong> — this port monitors{' '}
        {n} master{n === 1 ? '' : 's'}; it holds no data keyspace of its own.
        Connect to a monitored master to browse keys.
      </div>
      {open && (
        <table className="rb-table">
          <thead><tr><th>Master</th><th>Address</th><th>Status</th><th>Replicas</th></tr></thead>
          <tbody>
            {overview.masters.map(m => (
              <tr key={m.name}>
                <td className="rb-field-name">{m.name}</td>
                <td>{m.ip}:{m.port}</td>
                <td>{m.status}</td>
                <td>
                  {m.replicas.length === 0
                    ? '—'
                    : m.replicas.map(r => `${r.ip}:${r.port}${r.status && r.status !== 'ok' ? ` (${r.status})` : ''}`).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Audit tab ─────────────────────────────────────────────────────────────────

const FINDING_LABEL: Record<AuditFinding['kind'], string> = {
  'no-ttl': 'No TTL',
  'expired': 'Expired',
  'big-string': 'Big string',
  'big-collection': 'Big collection',
  'non-compact-encoding': 'Encoding',
};

function AuditPanel({ sessionId, keys }: { sessionId: string; keys: string[] }) {
  const [rows, setRows]         = useState<RedisKeyAuditRow[] | null>(null);
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  async function run() {
    setLoading(true); setErr(null);
    try {
      // The backend caps a batch at AUDIT_MAX_KEYS — the label says so too.
      setRows(await invoke<RedisKeyAuditRow[]>('redis_key_audit', {
        sessionId, keys: keys.slice(0, AUDIT_MAX_KEYS),
      }));
    } catch (e) { setErr(errorDisplay(e)); }
    finally { setLoading(false); }
  }

  const findings = useMemo(() => (rows ? auditRedisKeys(rows) : []), [rows]);
  const summary = useMemo(() => summarizeFindings(findings), [findings]);

  return (
    <div className="rb-audit">
      <div className="rb-info-toolbar">
        <button className="rb-small-btn" onClick={run} disabled={loading || keys.length === 0}
          title={keys.length === 0 ? 'Scan keys on the Keys tab first — the audit covers the scanned sample' : undefined}>
          {loading ? 'Auditing…' : auditButtonLabel(keys.length)}
        </button>
        <span className="rb-audit-note">
          Covers only the keys already loaded by SCAN (never KEYS) — Load more on
          the Keys tab widens the sample.
        </span>
      </div>
      {err && <div className="rb-err">{err}</div>}
      {rows && (
        <>
          <div className="rb-audit-summary">
            {findings.length === 0
              ? `No findings across ${rows.length.toLocaleString()} keys.`
              : `${findings.length.toLocaleString()} findings across ${rows.length.toLocaleString()} keys: ` +
                (Object.entries(summary) as Array<[AuditFinding['kind'], number]>)
                  .map(([kind, n]) => `${n} ${FINDING_LABEL[kind].toLowerCase()}`)
                  .join(' · ')}
          </div>
          <table className="rb-table">
            <thead>
              <tr><th>Key</th><th>Type</th><th>TTL</th><th>Encoding</th><th>Size</th><th>Findings</th></tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const fs = findings.filter(f => f.key === r.key);
                return (
                  <tr key={r.key} className={fs.length > 0 ? 'rb-audit-flagged' : ''}>
                    <td className="rb-field-name" title={r.key}>{r.key}</td>
                    <td>{r.key_type}</td>
                    <td className={r.ttl === -1 ? 'rb-audit-warn' : ''}>{formatTtl(r.ttl)}</td>
                    <td>{r.encoding ?? '—'}</td>
                    <td>{formatSize(r.key_type, r.size)}</td>
                    <td>
                      {fs.map((f, i) => (
                        <div key={i} className={`rb-audit-finding ${f.severity}`} title={f.message}>
                          {f.severity === 'warn' ? '⚠' : 'ⓘ'} {f.message}
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ── db strip ──────────────────────────────────────────────────────────────────

interface DbEntry { label: string; index: number; keys: number | null }

/**
 * The server's logical databases and which one this session is on.
 *
 * An INDICATOR, deliberately not a switcher: the db index is fixed at connect
 * time by the connection's Database field and the runtime-switch plumbing does
 * not exist — registered as 'redis::databaseSelect' in utils/engineGaps.ts,
 * whose reason (with the workaround) is the strip's tooltip. Cluster mode
 * falls out of the data: INFO keyspace reports db0 only, so only db0 lists.
 */
function DbStrip({ sessionId, connectionId }: { sessionId: string; connectionId: string }) {
  const [dbs, setDbs]           = useState<DbEntry[] | null>(null);
  const [currentDb, setCurrentDb] = useState(0);
  const [loading, setLoading]   = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nodes = await SchemaStore.listSchema(sessionId);
      const parsed = nodes.flatMap(n => {
        if (n.kind !== 'database') return [];
        const p = parseRedisDbLabel(n.name);
        return p ? [{ label: n.name, index: p.index, keys: p.keys }] : [];
      });
      parsed.sort((a, b) => a.index - b.index);
      setDbs(parsed);
    } catch { setDbs(null); }
    finally { setLoading(false); }
  }, [sessionId]);

  useEffect(() => { refresh(); }, [refresh]);

  // The session's db index is the connection's `database` field — the value
  // build_url baked into the connection URL when the session opened.
  useEffect(() => {
    ConnectionsStore.list()
      .then(list => setCurrentDb(redisConfigDbIndex(list.find(c => c.id === connectionId)?.database)))
      .catch(() => {});
  }, [connectionId]);

  if (!dbs) return null;
  const switchTip = engineGapReason('redis', 'databaseSelect');
  return (
    <div className="rb-db-strip">
      {dbs.map(d => (
        <span
          key={d.index}
          className={`rb-db-chip${d.index === currentDb ? ' current' : ''}`}
          title={d.index === currentDb
            ? `${d.label} — this session's database`
            : `${d.label}\n${switchTip ?? ''}`}
        >
          db{d.index}
          {d.keys !== null && <span className="rb-db-count">{d.keys.toLocaleString()}</span>}
        </span>
      ))}
      <button
        className="rb-db-refresh"
        onClick={refresh}
        disabled={loading}
        title="Re-read INFO keyspace"
      >↺</button>
    </div>
  );
}

// ── Console tab ───────────────────────────────────────────────────────────────

/**
 * Typed Redis commands (GET x / HGETALL h / INFO) over execute_query, with the
 * reply shaped into a grid by the backend's redis_shape pipeline.
 *
 * This is the mini QueryEditor, NOT SqlEditor: a richer Redis editor surface
 * already exists — SqlEditor's engine==='redis' branch, utils/redisComplete.ts
 * and the generated utils/redisCommands.ts catalog — but it is wired into
 * QueryTabs, which a Redis session never mounts. That machinery stays for a
 * future full editor; the console needs only a run loop, and QueryEditor's is
 * already correct.
 *
 * Read-only is enforced server-side (guard_statement → redisguard classifies
 * the typed command against the server-informed write catalog), so reads run
 * on a read-only connection and writes come back as the refusal error in the
 * editor's error area — the frontend deliberately does not pre-guess the
 * classification.
 */
function ConsolePanel({ session }: { session: Session }) {
  return (
    <div className="rb-console-pane">
      {!!session.readOnly && (
        <div className="rb-console-ro">
          Read-only connection — read commands run; write commands are refused by the server-side guard.
        </div>
      )}
      <QueryEditor session={session} />
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function RedisBrowser({ session, isActive = true }: Props) {
  const { sessionId } = session;
  // 'keys' | 'audit' | 'info' | 'console' | a REDIS_PANELS id — a panel is just another tab here.
  const [tab, setTab]           = useState<string>('keys');
  const [sentinel, setSentinel] = useState<SentinelOverview | null>(null);
  const [pattern, setPattern]   = useState('*');
  const [keys, setKeys]         = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<number>(0);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr]   = useState<string | null>(null);
  const [selKey, setSelKey]     = useState<string | null>(null);
  const [keyInfo, setKeyInfo]   = useState<KeyInfo | null>(null);
  const [keyValue, setKeyValue] = useState<RedisValue | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  // Monotonic detail-request id — two fast key clicks must not let the slower
  // response render its key's data under the other key's header.
  const detailReqRef = useRef(0);

  async function scan(fresh: boolean) {
    setScanning(true); setScanErr(null);
    const cur = fresh ? 0 : nextCursor;
    try {
      const res = await invoke<ScanResult>('redis_scan', {
        sessionId, pattern, cursor: cur, count: 200
      });
      // SCAN may return the same key on two pages — merge through a Set.
      setKeys(prev => mergeScannedKeys(fresh ? [] : prev, res.keys));
      setNextCursor(res.cursor);
    } catch (e) { setScanErr(errorDisplay(e)); }
    finally { setScanning(false); }
  }

  // Initial scan when component mounts
  useEffect(() => {
    scan(true);
    setSelKey(null);
    setKeyInfo(null);
    setKeyValue(null);
    setDetailErr(null);
    // Sentinel awareness: one cheap probe (INFO server) on open. A Sentinel
    // port gets a topology banner instead of a silent empty keyspace.
    invoke<SentinelOverview>('redis_sentinel_overview', { sessionId })
      .then(setSentinel)
      .catch(() => setSentinel(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function loadKeyDetail(key: string) {
    const req = ++detailReqRef.current;
    setSelKey(key);
    setKeyInfo(null);
    setKeyValue(null);
    setDetailErr(null);
    setDetailLoading(true);
    try {
      const [info, val] = await Promise.all([
        invoke<KeyInfo>('redis_key_info', { sessionId, key }),
        invoke<RedisValue>('redis_get_value', { sessionId, key }),
      ]);
      if (req !== detailReqRef.current) return; // a newer key was clicked
      setKeyInfo(info);
      setKeyValue(val);
    } catch (e) {
      // Without the catch the rejection was unhandled and the pane silently
      // reverted to "Select a key to inspect it." — show the failure instead.
      if (req !== detailReqRef.current) return;
      setDetailErr(errorDisplay(e));
    } finally { if (req === detailReqRef.current) setDetailLoading(false); }
  }

  const handleDeleted = useCallback(() => {
    setKeys(prev => prev.filter(k => k !== selKey));
    setSelKey(null);
    setKeyInfo(null);
    setKeyValue(null);
    setDetailErr(null);
  }, [selKey]);

  const handleValueSaved = useCallback(() => {
    if (selKey) loadKeyDetail(selKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, sessionId]);

  const handleTtlSaved = useCallback((newTtl: number) => {
    setKeyInfo(prev => prev ? { ...prev, ttl: newTtl } : null);
  }, []);

  /**
   * Tools menu / plugin-menu panels. Same semantics as QueryTabs.panelToggle:
   * toggling the panel you are looking at closes it (back to the key
   * browser), anything else just focuses it — never a duplicate.
   */
  const togglePanel = useCallback((panel: string) => {
    setTab(cur => (cur === panel ? 'keys' : panel));
  }, []);

  // Only the ACTIVE session answers, like QueryTabs' isActive gate: every
  // session workspace stays mounted, so without this each open Redis session
  // would open the panel at once. The engine gate is redisPanelAllowed —
  // a panel Redis cannot host (a SQL editor panel, the playground, …) is
  // ignored, exactly as QueryTabs' PANEL_ENGINE_CAP gate ignores it.
  useEffect(() => {
    if (!isActive) return;
    const onTogglePanel = (e: Event) => {
      const panel = (e as CustomEvent<{ panel: string }>).detail?.panel;
      if (!panel || !redisPanelAllowed(session.engine, panel)) return;
      togglePanel(panel);
    };
    window.addEventListener('dbgui:toggle-panel', onTogglePanel);
    return () => window.removeEventListener('dbgui:toggle-panel', onTogglePanel);
  }, [isActive, session.engine, togglePanel]);

  const activePanel = redisPanel(tab);
  const closePanel = useCallback(() => setTab('keys'), []);

  const hasMore = nextCursor !== 0;

  return (
    <div className="redis-browser">
      {/* Tab bar */}
      <div className="rb-tab-bar">
        <button
          className={`rb-tab ${tab === 'keys' ? 'active' : ''}`}
          onClick={() => setTab('keys')}
        >Keys {keys.length > 0 && <span className="rb-tab-count">{keys.length}</span>}</button>
        <button
          className={`rb-tab ${tab === 'audit' ? 'active' : ''}`}
          onClick={() => setTab('audit')}
          title="TTL / type / encoding findings over the scanned keys"
        >Audit</button>
        <button
          className={`rb-tab ${tab === 'info' ? 'active' : ''}`}
          onClick={() => setTab('info')}
        >Server INFO</button>
        <button
          className={`rb-tab ${tab === 'console' ? 'active' : ''}`}
          onClick={() => setTab('console')}
          title="Type Redis commands (GET x, HGETALL h, INFO) and run them — write commands follow the connection's read-only setting"
        >Console</button>
        {activePanel && (
          <button
            className="rb-tab active"
            onClick={() => togglePanel(activePanel.id)}
            title="Close panel"
          ><span className="icon-slot"><PanelIcon panel={activePanel.id} size={13} /></span>{activePanel.label} ×</button>
        )}
        {/* A Sentinel port holds no keyspace — no dbs to indicate. */}
        {sentinel?.mode !== 'sentinel' && (
          <DbStrip sessionId={sessionId} connectionId={session.connectionId} />
        )}
      </div>

      {tab === 'console' && <ConsolePanel session={session} />}

      {tab === 'processes' && (
        <ProcessListPanel sessionId={sessionId} connectionName={session.connectionName}
          engine={session.engine} onClose={closePanel} />
      )}
      {tab === 'serverinfo' && (
        <ServerInfoPanel sessionId={sessionId} engine={session.engine} onClose={closePanel} />
      )}
      {tab === 'tuner' && (
        <TunerPanel sessionId={sessionId} engine={session.engine}
          environment={session.environment} onClose={closePanel} />
      )}
      {tab === 'dbaviews' && (
        <DbaViewsPanel sessionId={sessionId} engine={session.engine} onClose={closePanel} />
      )}

      {tab === 'info' && <InfoPanel sessionId={sessionId} />}

      {tab === 'audit' && <AuditPanel sessionId={sessionId} keys={keys} />}

      {tab === 'keys' && (
        <div className="rb-keys-pane">
          {sentinel?.mode === 'sentinel' && <SentinelBanner overview={sentinel} />}
          {/* Search bar */}
          <div className="rb-search-bar">
            <input
              className="rb-pattern-input"
              value={pattern}
              onChange={e => setPattern(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && scan(true)}
              placeholder="Pattern (e.g. user:*)"
              spellCheck={false}
            />
            <button className="rb-scan-btn" onClick={() => scan(true)} disabled={scanning}>
              {scanning ? '…' : 'Scan'}
            </button>
          </div>

          {scanErr && <div className="rb-err">{scanErr}</div>}

          <div className="rb-split">
            {/* Key list */}
            <div className="rb-left-panel">
              <KeyTree keys={keys} selectedKey={selKey} onSelect={loadKeyDetail} />
              {hasMore && (
                <button
                  className="rb-load-more"
                  onClick={() => scan(false)}
                  disabled={scanning}
                >
                  {scanning ? 'Loading…' : `Load more (cursor: ${nextCursor})`}
                </button>
              )}
              {keys.length === 0 && !scanning && (
                <div className="rb-empty">No keys matched.</div>
              )}
            </div>

            {/* Key detail */}
            <div className="rb-right-panel">
              {detailLoading && <div className="rb-loading">Loading…</div>}
              {!detailLoading && detailErr && <div className="rb-err">{detailErr}</div>}
              {!detailLoading && keyInfo && (
                <KeyDetail
                  sessionId={sessionId}
                  engine={session.engine}
                  readOnly={!!session.readOnly}
                  keyInfo={keyInfo}
                  value={keyValue}
                  onDeleted={handleDeleted}
                  onValueSaved={handleValueSaved}
                  onTtlSaved={handleTtlSaved}
                />
              )}
              {!detailLoading && !keyInfo && !detailErr && (
                <div className="rb-no-sel">Select a key to inspect it.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
