// Dolphie Replay workspace — the "other main window."
//
// Opens a recording by path, ingests it once (backend builds a columnar cache
// with a progress event), then presents a time-scrubbed, panel-based
// observability dashboard: KPI tiles, per-group graphs, and per-second detail
// panels (processlist, locks, replication, variables, binlog, innodb, I/O).
//
// Two cursors: a *live* one that moves while dragging (chart cursor only) and a
// *committed* one that fires the single per-second snapshot fetch on release —
// so 10× scrubbing never floods the backend.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { Session } from '../types';
import {
  type IngestProgress, type ReplayManifest, type SeriesSlice, type Snapshot,
  type VarChange, groupMetrics, replayApi, snapshotMetricValues,
} from '../lib/replay';
import { LineChart } from './replay/LineChart';
import { ReplayScrubber } from './replay/ReplayScrubber';
import {
  ActivityPanel, DashboardTiles, InnodbPanel, KeyValuePanel, RowsPanel, VariablesPanel,
} from './replay/panels';
import { logAudit, isoNow } from '../utils/audit';
import './replay/replay.css';

type PanelId =
  | 'graphs' | 'processlist' | 'replication'
  | 'variables' | 'binlog' | 'innodb' | 'tableio' | 'fileio';

interface PanelDef { id: PanelId; label: string; present: (m: ReplayManifest) => boolean }

// Dashboard is no longer a tab — its tiles are a persistent header strip shown
// under the graph on every panel. Processlist and metadata-locks share one tab.
const PANELS: PanelDef[] = [
  { id: 'graphs', label: 'Graphs', present: m => m.presence.metric_manager },
  { id: 'processlist', label: 'Processlist & locks', present: m => m.presence.processlist || m.presence.metadata_locks },
  { id: 'replication', label: 'Replication', present: m => m.presence.replica_manager },
  { id: 'variables', label: 'Variables', present: m => m.presence.global_variables },
  { id: 'binlog', label: 'Binary log', present: m => m.presence.binlog_status },
  { id: 'innodb', label: 'InnoDB', present: m => m.presence.innodb_metrics || m.presence.global_status },
  { id: 'tableio', label: 'Table I/O', present: m => m.presence.table_io_waits_data },
  { id: 'fileio', label: 'File I/O', present: m => m.presence.file_io_data },
];

interface Props {
  session: Session;
  path: string;
  onOpenRaw: () => void;
}

// Last committed cursor per recording path, kept at module scope so toggling
// Replay ↔ Raw SQLite (which unmounts/remounts this component) returns you to
// the second you were on, not to the tail.
const lastCursor = new Map<string, number>();

export function ReplayWorkspace({ session, path, onOpenRaw }: Props) {
  const [phase, setPhase] = useState<'opening' | 'ready' | 'error'>('opening');
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ReplayManifest | null>(null);

  const [index, setIndex] = useState(0);       // committed cursor
  const [liveIndex, setLiveIndex] = useState(0); // during drag
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [panel, setPanel] = useState<PanelId>('graphs');

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [full, setFull] = useState<SeriesSlice | null>(null);
  const [changes, setChanges] = useState<VarChange[]>([]);
  // Shared hover index across all charts (downsampled-axis space): hovering one
  // chart moves the crosshair + value readouts on all of them.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const snapToken = useRef(0);

  // ── open + ingest ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    // Hold the PROMISE, not the resolved unlisten: cleanup used to call
    // `un?.()` with `un` assigned only after the await resolved, so an
    // unmount during that window left the listener subscribed for the app's
    // lifetime (WP-13 13.3).
    const unlisten = listen<IngestProgress>('replay-ingest-progress', e => {
      if (e.payload.path === path) setProgress(e.payload);
    });
    (async () => {
      try {
        const openStartedAt = isoNow();
        const t0 = performance.now();
        const m = await replayApi.open(path);
        if (cancelled) return;
        const openMs = Math.round(performance.now() - t0);
        setManifest(m);
        // Persistent audit row (also mirrored to the session Log) so the whole
        // recording lifecycle shows up in the Audit panel and survives restarts.
        const auditBase = {
          source: 'replay' as const,
          session_id: session.sessionId,
          tab_title: session.connectionName,
          database: `${m.metadata.host}:${m.metadata.port}`,
          connection_name: session.connectionName,
          db_user: m.metadata.server_uuid ?? '',
          engine: session.engine,
          rows_affected: null,
        };
        logAudit({
          ...auditBase,
          started_at: openStartedAt, ended_at: isoNow(), duration_ms: openMs,
          ok: true, rows_out: m.snapshot_count, error: null,
          sql: `Opened Dolphie recording ${m.metadata.host}:${m.metadata.port}`
            + `${m.metadata.server_version ? ` (${m.metadata.server_version})` : ''} — ${m.snapshot_count.toLocaleString()} snapshots`,
        });
        const tail = Math.max(0, m.timestamps.length - 1);
        // Return to where we were before an in-session Raw↔Replay toggle; only
        // fall back to the tail on a genuinely first open.
        const restored = lastCursor.get(path);
        const start = restored != null && restored >= 0 && restored <= tail ? restored : tail;
        setIndex(start);
        setLiveIndex(start);
        // First present panel.
        const firstPanel = PANELS.find(p => p.present(m));
        if (firstPanel) setPanel(firstPanel.id);
        // App is usable NOW — timestamps, scrubber, dashboard and detail panels
        // all work off the manifest + single-row snapshots. The heavy columnar
        // build for the graphs runs in the BACKGROUND so we never block the
        // window on it.
        setPhase('ready');

        // Background: build the columnar series (graphs show "Loading graphs…"
        // until this lands). The first call triggers the parallel build and
        // returns build_secs; log how long it took.
        if (m.first_timestamp && m.last_timestamp && m.metrics.length) {
          const buildStartedAt = isoNow();
          replayApi.series(path, m.metrics, m.first_timestamp, m.last_timestamp, 800)
            .then(s => {
              if (cancelled) return;
              setFull(s);
              logAudit({
                ...auditBase,
                started_at: buildStartedAt, ended_at: isoNow(),
                duration_ms: s.build_secs != null ? Math.round(s.build_secs * 1000) : 0,
                ok: true, rows_out: m.snapshot_count, error: null,
                sql: s.build_secs != null
                  ? `Indexed recording — built columnar graph cache (${m.snapshot_count.toLocaleString()} snapshots) in ${s.build_secs.toFixed(1)}s`
                  : `Indexed recording — graphs served from warm cache (${m.snapshot_count.toLocaleString()} snapshots)`,
              });
            })
            .catch(() => {});
        }
        // Variable change log over the whole recording.
        if (m.first_timestamp && m.last_timestamp) {
          replayApi.variableChanges(path, m.first_timestamp, m.last_timestamp)
            .then(c => { if (!cancelled) setChanges(c); }).catch(() => {});
        }
      } catch (e) {
        if (!cancelled) { setError(String(e)); setPhase('error'); }
      }
    })();
    return () => {
      cancelled = true;
      unlisten.then(f => f()).catch(() => {});
      replayApi.close(path).catch(() => {});
    };
  }, [path, session.sessionId, session.connectionName, session.engine]);

  // ── committed cursor → fetch the second's snapshot ──────────────────────────
  useEffect(() => {
    if (phase !== 'ready' || !manifest) return;
    const ts = manifest.timestamps[index];
    if (!ts) return;
    const token = ++snapToken.current;
    replayApi.snapshot(path, ts)
      .then(s => { if (token === snapToken.current) setSnap(s); })
      .catch(() => {});
  }, [index, phase, manifest, path]);

  // ── keyboard transport ──────────────────────────────────────────────────────
  const commit = useCallback((i: number) => {
    const last = Math.max(0, (manifest?.timestamps.length ?? 1) - 1);
    const c = Math.max(0, Math.min(last, i));
    setIndex(c); setLiveIndex(c);
    lastCursor.set(path, c);
  }, [manifest, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); commit(index - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); commit(index + 1); }
      else if (e.key === 'Home') { commit(0); }
      else if (e.key === 'End') { commit((manifest?.timestamps.length ?? 1) - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, commit, manifest]);

  const n = manifest?.timestamps.length ?? 0;

  // The "NOW" the user is looking at. Reflects the LIVE cursor while dragging,
  // the committed cursor otherwise. ALWAYS clamped to a valid row so the time
  // is never empty and never out of bounds — time is the thing the user cares
  // about most, so it must always resolve.
  const clampIdx = (i: number) => (n === 0 ? 0 : Math.max(0, Math.min(n - 1, i)));
  const nowIdx = clampIdx(liveIndex);
  const nowTime = manifest?.timestamps[nowIdx] ?? manifest?.timestamps[clampIdx(index)] ?? '—';

  // Map the LIVE index onto the downsampled context/graph axis, so dragging and
  // stepping move the chart cursor + value readouts instantly (the series are
  // already in memory — no fetch needed for graph values). Plain computation:
  // the React Compiler memoizes it, and it avoids the manual-memoization lint.
  const ctxCursor = !full || full.timestamps.length === 0 || n <= 1
    ? 0
    : Math.round((clampIdx(liveIndex) / (n - 1)) * (full.timestamps.length - 1));

  const ctxSeek = useCallback((sliceIdx: number) => {
    if (!full || full.timestamps.length <= 1) return;
    commit(Math.round((sliceIdx / (full.timestamps.length - 1)) * (n - 1)));
  }, [full, n, commit]);

  const groups = useMemo(() => manifest ? groupMetrics(manifest.metrics) : [], [manifest]);

  // Exact current-second metric values from the snapshot, so chart readouts
  // update every second even though the plotted lines are downsampled.
  const curVals = useMemo(() => (snap ? snapshotMetricValues(snap) : {}), [snap]);

  // Values for the always-visible dashboard strip: the hovered second (from the
  // in-memory series) while scanning a chart, otherwise the committed second.
  // This is what keeps the strip LIVE instead of frozen at the last commit.
  const stripVals = useMemo(() => {
    if (hoverIdx != null && full) {
      const out: Record<string, number> = {};
      for (const [k, arr] of Object.entries(full.series)) {
        const x = arr[hoverIdx];
        if (Number.isFinite(x)) out[k] = x;
      }
      return out;
    }
    return curVals;
  }, [hoverIdx, full, curVals]);

  // Anomaly strip: flag slice indices where a headline metric spikes past a
  // 3σ / hard-floor threshold or replication falls behind. Computed off the
  // already-downsampled full-range slice, so it's cheap and matches the
  // context chart's x-axis exactly.
  const anomalies = useMemo(() => {
    if (!full) return [] as number[];
    const flags = new Set<number>();
    const flagSpikes = (key: string, hardMin: number) => {
      const col = full.series[key];
      if (!col) return;
      const finite = col.filter(Number.isFinite);
      if (!finite.length) return;
      const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
      const sd = Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length) || 0;
      const thr = Math.max(hardMin, mean + 3 * sd);
      col.forEach((v, i) => { if (Number.isFinite(v) && v >= thr) flags.add(i); });
    };
    flagSpikes('threads.Threads_running', 20);
    flagSpikes('history_list_length.trx_rseg_history_len', 500_000);
    full.series['replication_lag.lag']?.forEach((v, i) => { if (Number.isFinite(v) && v > 5) flags.add(i); });
    return [...flags].sort((a, b) => a - b);
  }, [full]);

  const jumpAnom = useCallback((dir: 1 | -1) => {
    if (!anomalies.length || !full) return;
    let target: number | undefined;
    if (dir === 1) target = anomalies.find(a => a > ctxCursor) ?? anomalies[0];
    else {
      const before = anomalies.filter(a => a < ctxCursor);
      target = before.length ? before[before.length - 1] : anomalies[anomalies.length - 1];
    }
    if (target != null) ctxSeek(target);
  }, [anomalies, full, ctxCursor, ctxSeek]);

  const copyQuery = useCallback((q: string) => {
    navigator.clipboard?.writeText(q).catch(() => {});
  }, []);

  // ── render ───────────────────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <div className="rp-root rp-center">
        <div className="rp-error">
          <b>Could not open recording.</b>
          <pre>{error}</pre>
          <button className="rp-btn2" onClick={onOpenRaw}>Open as raw SQLite instead</button>
        </div>
      </div>
    );
  }

  if (phase === 'opening' || !manifest) {
    const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="rp-root rp-center">
        <div className="rp-loading">
          <div className="rp-loading-title">Indexing recording…</div>
          <div className="rp-bar"><div className="rp-bar-fill" style={{ width: `${pct}%` }} /></div>
          <div className="rp-loading-sub">
            {progress ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} snapshots (${pct}%)` : 'Reading…'}
          </div>
          <div className="rp-loading-hint">Reading the timestamp axis — the graphs build in the background once the dashboard opens.</div>
        </div>
      </div>
    );
  }

  const meta = manifest.metadata;
  // Context chart: a couple of headline series across the whole recording.
  const ctxSeries: Record<string, number[]> = {};
  if (full) {
    for (const key of ['threads.Threads_running', 'dml.Queries', 'replication_lag.lag']) {
      if (full.series[key]) ctxSeries[key] = full.series[key];
    }
  }

  return (
    <div className="rp-root">
      {/* Header */}
      <div className="rp-header">
        <div className="rp-head-id">
          <span className="rp-badge">⏱ REPLAY</span>
          <span className="rp-host">{meta.host}:{meta.port}</span>
          {meta.server_hostname && <span className="rp-dim">@{meta.server_hostname}</span>}
          <span className="rp-dim">
            {meta.host_distro}{meta.server_version ? ` ${meta.server_version}` : ''}
          </span>
          {meta.read_only != null && (
            <span className={`rp-role ${meta.read_only ? 'rp-role-ro' : 'rp-role-rw'}`}>
              {meta.read_only ? 'READ-ONLY' : 'READ-WRITE'}
            </span>
          )}
          {meta.server_uuid && (
            <span className="rp-dim rp-uuid"
              title={`server_uuid ${meta.server_uuid}${meta.server_id != null ? `  ·  server_id ${meta.server_id}` : ''}`}>
              {meta.server_uuid.slice(0, 8)}…
            </span>
          )}
          <span className="rp-dim">dolphie {meta.dolphie_version}</span>
        </div>
        <div className="rp-head-range">
          <span className="rp-dim">{manifest.first_timestamp} → {manifest.last_timestamp}</span>
          <span className="rp-count">{n.toLocaleString()} snapshots</span>
          {anomalies.length > 0 && (
            <span className="rp-anom">
              <button className="rp-btn2" title="Previous anomaly" onClick={() => jumpAnom(-1)}>⚠◀</button>
              <span className="rp-count">{anomalies.length} anomalies</span>
              <button className="rp-btn2" title="Next anomaly" onClick={() => jumpAnom(1)}>▶⚠</button>
            </span>
          )}
          <button className="rp-btn2" title="Browse the raw SQLite tables instead" onClick={onOpenRaw}>Raw SQLite</button>
        </div>
      </div>

      {/* NOW — the single most important thing: the timestamp under the cursor,
          big and always visible on every panel. Reflects the live cursor while
          dragging, the committed one otherwise, always clamped to a valid row. */}
      <div className="rp-nowbar">
        <span className="rp-now-label">NOW</span>
        <span className="rp-now-time">{nowTime}</span>
        <span className="rp-now-pos">{n === 0 ? '0 / 0' : `${(nowIdx + 1).toLocaleString()} / ${n.toLocaleString()}`}</span>
        {playing && <span className="rp-now-playing">▶ {speed}×</span>}
      </div>

      {/* Context chart across the whole recording with a movable cursor */}
      {full && Object.keys(ctxSeries).length > 0 && (
        <div className="rp-context">
          <LineChart timestamps={full.timestamps} series={ctxSeries} height={72}
            cursorIndex={ctxCursor} onSeek={ctxSeek} hideLegend markers={anomalies}
            currentValues={curVals} currentTs={nowTime}
            hoverIndex={hoverIdx} onHoverIndex={setHoverIdx} />
        </div>
      )}

      {/* Dashboard strip: KPI tiles for the current second, auto-positioned
          under the graph and visible on EVERY tab (not a tab of its own). */}
      {snap && (
        <div className="rp-dashboard-strip">
          <DashboardTiles snap={snap} values={stripVals} compact />
        </div>
      )}

      {/* Panel nav */}
      <div className="rp-nav">
        {PANELS.map(p => {
          const present = p.present(manifest);
          return (
            <button key={p.id}
              className={`rp-tab ${panel === p.id ? 'active' : ''} ${present ? '' : 'rp-tab-off'}`}
              disabled={!present}
              title={present ? '' : 'Not recorded in this file'}
              onClick={() => present && setPanel(p.id)}>
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Panel body */}
      <div className="rp-content">
        {!snap && <div className="rp-empty">Loading snapshot…</div>}
        {snap && panel === 'graphs' && (
          <div className="rp-graphs">
            {full ? groups.map(g => (
              <LineChart key={g.group}
                title={g.group}
                timestamps={full.timestamps}
                series={Object.fromEntries(g.metrics.filter(m => full.series[m]).map(m => [m, full.series[m]]))}
                height={150}
                cursorIndex={ctxCursor}
                onSeek={ctxSeek}
                currentValues={curVals}
                currentTs={nowTime}
                hoverIndex={hoverIdx}
                onHoverIndex={setHoverIdx}
              />
            )) : (
              <div className="rp-empty">
                Building graphs{progress && progress.total > 0
                  ? `… ${Math.round((progress.done / progress.total) * 100)}%` : '…'}
              </div>
            )}
          </div>
        )}
        {snap && panel === 'processlist' && <ActivityPanel snap={snap} onQuery={copyQuery} />}
        {snap && panel === 'replication' && <RowsPanel rows={snap.replica_manager} />}
        {snap && panel === 'variables' && <VariablesPanel snap={snap} changes={changes} />}
        {snap && panel === 'binlog' && <KeyValuePanel obj={snap.binlog_status} />}
        {snap && panel === 'innodb' && <InnodbPanel snap={snap} />}
        {snap && panel === 'tableio' && <RowsPanel rows={snap.table_io_waits_data} />}
        {snap && panel === 'fileio' && <RowsPanel rows={snap.file_io_data} />}
      </div>

      {/* Scrubber */}
      <ReplayScrubber
        timestamps={manifest.timestamps}
        index={index}
        liveIndex={liveIndex}
        playing={playing}
        speed={speed}
        onDrag={setLiveIndex}
        onCommit={commit}
        onTogglePlay={() => setPlaying(p => !p)}
        onSpeed={setSpeed}
      />
    </div>
  );
}
