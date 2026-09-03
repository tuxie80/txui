// Detail panels for the Replay workspace. Each reads a single decoded
// snapshot (the second under the cursor) and renders it. They are deliberately
// plain HTML tables inside scroll containers: a snapshot's lists are small
// (tens to low-hundreds of rows) and re-render on every committed scrub, so
// simplicity and mount speed beat virtualization here.

import { useMemo, useState } from 'react';
import type { LockRow, ProcessRow, Snapshot, VarChange } from '../../lib/replay';

// ── shared helpers ───────────────────────────────────────────────────────────

/** metric_manager.<group>.<metric>[0] — the current value of a graph metric. */
function mm(snap: Snapshot, path: string): number | undefined {
  const [g, m] = path.split('.');
  const grp = (snap.metric_manager as Record<string, Record<string, unknown>>)?.[g];
  const v = grp?.[m];
  if (Array.isArray(v)) return typeof v[0] === 'number' ? v[0] : undefined;
  return typeof v === 'number' ? v : undefined;
}

function gs(snap: Snapshot, key: string): number | undefined {
  const v = snap.global_status?.[key];
  return typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : undefined;
}

function fmtNum(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'G';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function fmtDuration(s: number | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function fmtBytes(b: number | undefined): string {
  if (b == null || !Number.isFinite(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// ── Dashboard tiles ──────────────────────────────────────────────────────────

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`rp-tile ${tone ? `rp-tile-${tone}` : ''}`}>
      <div className="rp-tile-label">{label}</div>
      <div className="rp-tile-value">{value}</div>
      {sub && <div className="rp-tile-sub">{sub}</div>}
    </div>
  );
}

export function DashboardTiles({ snap, values, compact }: {
  snap: Snapshot;
  /** Focused-second metric values (`group.metric` → value) from the in-memory
   *  series — this is what keeps the always-visible strip LIVE while you hover /
   *  scrub / play, instead of only updating on a committed snapshot fetch. */
  values: Record<string, number>;
  compact?: boolean;
}) {
  // Prefer the focused-second value; fall back to the committed snapshot so a
  // tile is never blank before the series finish loading.
  const v = (p: string) => { const x = values[p]; return Number.isFinite(x) ? x : mm(snap, p); };
  const running = v('threads.Threads_running') ?? gs(snap, 'Threads_running');
  const connected = v('threads.Threads_connected') ?? gs(snap, 'Threads_connected');
  const qps = v('dml.Queries');
  const selects = v('dml.Com_select');
  const writes = (v('dml.Com_insert') ?? 0) + (v('dml.Com_update') ?? 0) + (v('dml.Com_delete') ?? 0);
  const bpReads = v('buffer_pool_requests.Innodb_buffer_pool_reads');
  const bpReq = v('buffer_pool_requests.Innodb_buffer_pool_read_requests');
  const hit = bpReq && bpReq > 0 ? (1 - (bpReads ?? 0) / bpReq) * 100 : undefined;
  const hll = v('history_list_length.trx_rseg_history_len');
  const lag = v('replication_lag.lag');
  const uptime = gs(snap, 'Uptime');
  const tmpDisk = v('temporary_objects.Created_tmp_disk_tables');
  const nproc = snap.processlist?.length ?? 0;
  // Full InnoDB set folded into the one always-visible strip.
  const dataB = gs(snap, 'Innodb_buffer_pool_bytes_data');
  const dirtyB = gs(snap, 'Innodb_buffer_pool_bytes_dirty');
  const dirtyPct = dataB && dataB > 0 && dirtyB != null ? (dirtyB / dataB) * 100 : undefined;
  const checkpoint = v('checkpoint.checkpoint_age');
  const bpWrites = v('buffer_pool_requests.Innodb_buffer_pool_write_requests');
  const lsn = gs(snap, 'Innodb_lsn_current');
  const osLog = gs(snap, 'Innodb_os_log_written');
  const ahiSearch = v('adaptive_hash_index.adaptive_hash_searches');

  const tiles: { label: string; value: string; sub?: string; tone?: string }[] = [
    { label: 'T. running', value: fmtNum(running), tone: running != null && running > 40 ? 'warn' : undefined },
    { label: 'T. conn.', value: fmtNum(connected) },
    { label: 'Queries/s', value: fmtNum(qps), sub: selects != null ? `${fmtNum(selects)} SEL/s` : undefined },
    { label: 'Writes/s', value: fmtNum(writes) },
    { label: 'Processlist', value: fmtNum(nproc) },
    { label: 'Repl lag', value: lag != null ? fmtDuration(lag) : '—', tone: lag != null && lag > 5 ? 'bad' : lag != null && lag > 0 ? 'warn' : 'ok' },
    { label: 'Tmp disk/s', value: fmtNum(tmpDisk), tone: tmpDisk != null && tmpDisk > 0 ? 'warn' : undefined },
    { label: 'BP hit', value: hit != null ? hit.toFixed(3) + '%' : '—', tone: hit != null && hit < 99 ? 'warn' : 'ok' },
    { label: 'BP data', value: fmtBytes(dataB) },
    { label: 'BP dirty', value: dirtyPct != null ? dirtyPct.toFixed(1) + '%' : '—', tone: dirtyPct != null && dirtyPct > 75 ? 'warn' : undefined },
    { label: 'BP reads/s', value: fmtNum(bpReads), tone: bpReads != null && bpReads > 0 ? 'warn' : 'ok' },
    { label: 'BP req/s', value: fmtNum(bpReq) },
    { label: 'BP writes/s', value: fmtNum(bpWrites) },
    { label: 'Hist. list', value: fmtNum(hll), tone: hll != null && hll > 1e6 ? 'bad' : undefined },
    { label: 'Checkpt', value: fmtNum(checkpoint) },
    { label: 'LSN', value: fmtNum(lsn) },
    { label: 'OS log', value: fmtBytes(osLog) },
    { label: 'AHI srch/s', value: fmtNum(ahiSearch) },
    { label: 'Uptime', value: fmtDuration(uptime) },
  ];
  // Force the strip into EXACTLY one row: one equal column per tile, filling
  // the full width with no slack. Values ellipsize if a column gets tight.
  const cols = tiles.length;
  return (
    <div
      className={`rp-tiles ${compact ? 'rp-tiles-compact' : ''}`}
      style={compact ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
    >
      {tiles.map((t, i) => <Tile key={i} label={t.label} value={t.value} sub={t.sub} tone={t.tone} />)}
    </div>
  );
}

// ── Processlist ──────────────────────────────────────────────────────────────

/** Full-query viewer: shows the ENTIRE stored query text (whatever its length)
 *  and copies all of it — never a truncated stub. */
function QueryViewer({ query, onClose }: { query: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(query).then(() => setCopied(true)).catch(() => {}); };
  return (
    <div className="rp-qv-backdrop" onClick={onClose}>
      <div className="rp-qv" onClick={e => e.stopPropagation()}>
        <div className="rp-qv-head">
          <span>Full query — {query.length.toLocaleString()} chars</span>
          <span className="rp-qv-actions">
            <button className="rp-btn2" onClick={copy}>{copied ? '✓ Copied' : '📋 Copy all'}</button>
            <button className="rp-btn2" onClick={onClose}>Close</button>
          </span>
        </div>
        <pre className="rp-qv-body">{query}</pre>
      </div>
    </div>
  );
}

export function ProcesslistPanel({ snap, onQuery, highlight, onHover }: {
  snap: Snapshot;
  onQuery: (q: string) => void;
  /** Thread id currently highlighted (hovered in either table) — matching
   *  rows get the shared accent background so you can see who holds which lock. */
  highlight?: number | null;
  onHover?: (id: number | null) => void;
}) {
  const [hideSleep, setHideSleep] = useState(true);
  const [hideSystem, setHideSystem] = useState(true);
  const [filter, setFilter] = useState('');
  const [viewQuery, setViewQuery] = useState<string | null>(null);

  const rows = useMemo(() => {
    let ps = snap.processlist ?? [];
    if (hideSleep) ps = ps.filter(p => (p.command ?? '').toLowerCase() !== 'sleep');
    if (hideSystem) ps = ps.filter(p => !/^(event_scheduler|system user|rdsadmin)$/i.test(p.user ?? ''));
    if (filter.trim()) {
      const f = filter.toLowerCase();
      ps = ps.filter(p =>
        [p.user, p.host, p.db, p.query, p.state].some(x => (x ?? '').toLowerCase().includes(f)));
    }
    return [...ps].sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
  }, [snap.processlist, hideSleep, hideSystem, filter]);

  return (
    <div className="rp-panel-body">
      <div className="rp-toolbar">
        <input className="rp-input" placeholder="Filter user / db / query / state…"
          value={filter} onChange={e => setFilter(e.target.value)} />
        <label className="rp-check"><input type="checkbox" checked={hideSleep}
          onChange={e => setHideSleep(e.target.checked)} /> Hide Sleep</label>
        <label className="rp-check"><input type="checkbox" checked={hideSystem}
          onChange={e => setHideSystem(e.target.checked)} /> Hide system</label>
        <span className="rp-count">{rows.length} threads</span>
      </div>
      <div className="rp-table-wrap">
        <table className="rp-table">
          <thead>
            <tr>
              <th>ID</th><th>User</th><th>Host</th><th>DB</th><th>Command</th>
              <th className="rp-num">Time</th><th>State</th><th>Trx</th>
              <th className="rp-num">Rows lock</th><th>Query</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p: ProcessRow, i) => {
              const isHl = highlight != null && (p.id === highlight || p.mysql_thread_id === highlight);
              return (
              <tr key={p.id ?? i}
                className={`${Number(p.time) > 10 && p.command !== 'Sleep' ? 'rp-row-long' : ''}${isHl ? ' rp-thread-hl' : ''}`}
                onMouseEnter={() => onHover?.(p.id ?? p.mysql_thread_id ?? null)}
                onMouseLeave={() => onHover?.(null)}>
                <td className="rp-num rp-strong">{p.id ?? p.mysql_thread_id}</td>
                <td>{p.user}</td>
                <td className="rp-dim">{p.host}</td>
                <td>{p.db}</td>
                <td>{p.command}</td>
                <td className="rp-num">{p.time}</td>
                <td className="rp-dim">{p.state}</td>
                <td className="rp-dim">{p.trx_state}{p.trx_time ? ` ${p.trx_time}` : ''}</td>
                <td className="rp-num">{p.trx_rows_locked ?? ''}</td>
                <td className="rp-query" title="Click: copy the whole query + view it in full"
                  onClick={() => { if (p.query) { onQuery(p.query); setViewQuery(p.query); } }}>{p.query}</td>
              </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={10} className="rp-empty">No matching threads at this second.</td></tr>}
          </tbody>
        </table>
      </div>
      {viewQuery != null && <QueryViewer query={viewQuery} onClose={() => setViewQuery(null)} />}
    </div>
  );
}

/** Processlist + Metadata locks on one tab: the live threads on top, the MDL
 *  they hold/wait for below — each lock carries its PROCESSLIST_ID so you can
 *  see which thread blocks which object. */
export function ActivityPanel({ snap, onQuery }: { snap: Snapshot; onQuery: (q: string) => void }) {
  const locks = snap.metadata_locks ?? [];
  // Shared hovered thread id: hovering a processlist row highlights the MDL rows
  // that thread holds/waits on (and vice-versa) with the same accent background,
  // so you can see at a glance which thread is doing what to which object.
  const [hoverThread, setHoverThread] = useState<number | null>(null);
  return (
    <div className="rp-activity">
      <div className="rp-activity-section">
        <div className="rp-section-title">
          Processlist — {snap.processlist?.length ?? 0} threads
          {hoverThread != null && <span className="rp-hint"> · linked to thread {hoverThread}</span>}
        </div>
        <ProcesslistPanel snap={snap} onQuery={onQuery} highlight={hoverThread} onHover={setHoverThread} />
      </div>
      <div className="rp-activity-section rp-activity-locks">
        <div className="rp-section-title">Metadata locks — {locks.length}{locks.some(l => (l.LOCK_STATUS ?? '') !== 'GRANTED') ? ' ⚠ contended' : ''}</div>
        <LocksPanel snap={snap} highlight={hoverThread} onHover={setHoverThread} />
      </div>
    </div>
  );
}

// ── Metadata locks ───────────────────────────────────────────────────────────

export function LocksPanel({ snap, highlight, onHover }: {
  snap: Snapshot;
  highlight?: number | null;
  onHover?: (id: number | null) => void;
}) {
  const rows = snap.metadata_locks ?? [];
  return (
    <div className="rp-panel-body">
      <div className="rp-table-wrap">
        <table className="rp-table">
          <thead>
            <tr><th className="rp-num">Thread&nbsp;id</th><th>Status</th><th>Type</th><th>Schema</th>
              <th>Object</th><th>Lock</th><th>User</th><th className="rp-num">Time</th><th>Blocking query</th></tr>
          </thead>
          <tbody>
            {rows.map((l: LockRow, i) => {
              const isHl = highlight != null && l.PROCESSLIST_ID === highlight;
              return (
              <tr key={i}
                className={`${(l.LOCK_STATUS ?? '') !== 'GRANTED' ? 'rp-row-long' : ''}${isHl ? ' rp-thread-hl' : ''}`}
                onMouseEnter={() => onHover?.(l.PROCESSLIST_ID ?? null)}
                onMouseLeave={() => onHover?.(null)}>
                <td className="rp-num rp-strong">{l.PROCESSLIST_ID ?? '—'}</td>
                <td>{l.LOCK_STATUS}</td>
                <td>{l.OBJECT_TYPE}</td><td>{l.OBJECT_SCHEMA}</td><td>{l.OBJECT_NAME}</td>
                <td>{l.LOCK_TYPE}</td><td>{l.PROCESSLIST_USER}</td>
                <td className="rp-num">{l.PROCESSLIST_TIME}</td>
                <td className="rp-wide" title={l.PROCESSLIST_INFO ?? ''}>{l.PROCESSLIST_INFO}</td>
              </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={9} className="rp-empty">No metadata locks held at this second.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Generic key/value + row-list panels (replication, binlog, innodb, io) ────

export function KeyValuePanel({ obj }: { obj: Record<string, unknown> | undefined }) {
  const entries = obj ? Object.entries(obj) : [];
  return (
    <div className="rp-panel-body">
      <div className="rp-table-wrap">
        <table className="rp-table rp-kv">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}><th>{k}</th><td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>
            ))}
            {entries.length === 0 && <tr><td className="rp-empty">Not recorded at this second.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RowsPanel({ rows }: { rows: Record<string, unknown>[] | undefined }) {
  const list = rows ?? [];
  const cols = useMemo(() => {
    const s = new Set<string>();
    for (const r of (rows ?? []).slice(0, 50)) Object.keys(r).forEach(k => s.add(k));
    return [...s];
  }, [rows]);
  return (
    <div className="rp-panel-body">
      <div className="rp-table-wrap">
        <table className="rp-table">
          <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {list.map((r, i) => (
              <tr key={i}>{cols.map(c => <td key={c}>{r[c] == null ? '' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c])}</td>)}</tr>
            ))}
            {list.length === 0 && <tr><td className="rp-empty" colSpan={Math.max(1, cols.length)}>Not recorded at this second.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Variables (+ change log) ─────────────────────────────────────────────────

export function VariablesPanel({ snap, changes }: { snap: Snapshot; changes: VarChange[] }) {
  const [filter, setFilter] = useState('');
  const vars = useMemo(() => {
    const all = Object.entries(snap.global_variables ?? {});
    const f = filter.trim().toLowerCase();
    return f ? all.filter(([k, v]) => k.toLowerCase().includes(f) || String(v).toLowerCase().includes(f)) : all;
  }, [snap.global_variables, filter]);

  return (
    <div className="rp-panel-body rp-split">
      <div className="rp-split-main">
        <div className="rp-toolbar">
          <input className="rp-input" placeholder="Filter variables…"
            value={filter} onChange={e => setFilter(e.target.value)} />
          <span className="rp-count">{vars.length} variables</span>
        </div>
        <div className="rp-table-wrap">
          <table className="rp-table rp-kv">
            <tbody>
              {vars.map(([k, v]) => <tr key={k}><th>{k}</th><td>{String(v)}</td></tr>)}
              {vars.length === 0 && <tr><td className="rp-empty">No variables recorded.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="rp-split-side">
        <div className="rp-side-title">Variable changes {changes.length ? `(${changes.length})` : ''}</div>
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead><tr><th>Time</th><th>Variable</th><th>Old → New</th></tr></thead>
            <tbody>
              {changes.map((c, i) => (
                <tr key={i}><td className="rp-dim">{c.timestamp.slice(11)}</td><td>{c.variable_name}</td>
                  <td>{c.old_value} → <b>{c.new_value}</b></td></tr>
              ))}
              {changes.length === 0 && <tr><td colSpan={3} className="rp-empty">No changes in this window.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── InnoDB ───────────────────────────────────────────────────────────────────

/** InnoDB engine health at this second. A recording's `innodb_metrics` table is
 *  usually sparse (a few counters), so this panel draws the useful picture from
 *  `global_status` (buffer pool, LSN) and `metric_manager` (redo, checkpoint,
 *  adaptive hash) as well — otherwise the panel looks empty when it shouldn't. */
export function InnodbPanel({ snap }: { snap: Snapshot }) {
  // Headline InnoDB numbers now live in the always-visible dashboard strip, so
  // this tab shows the raw recorded innodb_metrics and the InnoDB-related
  // global_status counters as reference detail.
  const im = Object.entries((snap.innodb_metrics ?? {}) as Record<string, unknown>);
  const gsInnodb = Object.entries(snap.global_status ?? {}).filter(([k]) => k.toLowerCase().startsWith('innodb'));
  const kv = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <div className="rp-panel-body">
      <div className="rp-table-wrap">
        <div className="rp-section-title">innodb_metrics (recorded)</div>
        <table className="rp-table rp-kv"><tbody>
          {im.map(([k, v]) => <tr key={k}><th>{k}</th><td>{kv(v)}</td></tr>)}
          {im.length === 0 && <tr><td className="rp-empty">Not recorded.</td></tr>}
        </tbody></table>
        <div className="rp-section-title" style={{ marginTop: 12 }}>global_status · Innodb_*</div>
        <table className="rp-table rp-kv"><tbody>
          {gsInnodb.map(([k, v]) => <tr key={k}><th>{k}</th><td>{kv(v)}</td></tr>)}
          {gsInnodb.length === 0 && <tr><td className="rp-empty">Not recorded.</td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}
