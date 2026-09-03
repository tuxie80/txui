/**
 * Interval query monitor — re-runs a query every N seconds and tracks numeric
 * values over time: current value, Δ/s rate, sparkline. A poor-man's live
 * dashboard for threads_running, QPS, lag, locks… (DbVisualizer's Monitor,
 * generalized). Uses `monitor_query` (no history pollution).
 *
 * Metric extraction:
 * - name/value result (SHOW STATUS LIKE …)  → one metric per row
 * - single-row result                        → one metric per numeric column
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import { usePoll } from '../hooks/usePoll';
import { SeriesChart } from './ResultChart';

interface Props {
  sessionId: string;
  engine: string;
  onClose: () => void;
}

const INTERVALS = [1, 2, 3, 5, 10, 30, 60];
const MAX_SAMPLES = 120;

const PRESETS: Record<string, { label: string; sql: string }[]> = {
  mysql: [
    { label: 'Threads', sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_running','Threads_connected')" },
    { label: 'Query rates', sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Questions','Com_select','Com_insert','Com_update','Com_delete')" },
    { label: 'InnoDB rows', sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_rows_read','Innodb_rows_inserted','Innodb_rows_updated','Innodb_rows_deleted')" },
    { label: 'Tmp & sorts', sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Created_tmp_tables','Created_tmp_disk_tables','Sort_merge_passes','Select_full_join')" },
  ],
  postgres: [
    { label: 'Activity', sql: "SELECT count(*) FILTER (WHERE state = 'active') AS active, count(*) FILTER (WHERE wait_event IS NOT NULL) AS waiting, count(*) AS total FROM pg_stat_activity WHERE backend_type = 'client backend'" },
    { label: 'Transactions', sql: 'SELECT xact_commit, xact_rollback, deadlocks FROM pg_stat_database WHERE datname = current_database()' },
    { label: 'Tuples', sql: 'SELECT tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted FROM pg_stat_database WHERE datname = current_database()' },
  ],
  redis: [
    { label: 'Keyspace size', sql: 'DBSIZE' },
  ],
};

interface Metric {
  name: string;
  value: number;
  /** per-second rate vs previous sample; null on first sample */
  rate: number | null;
  samples: number[];
}

function extractValues(r: QueryResult): { name: string; value: number }[] {
  // name/value pairs (SHOW STATUS shape): ≥1 rows, exactly 2 columns
  if (r.columns.length === 2 && r.rows.length >= 1) {
    const pairs: { name: string; value: number }[] = [];
    for (const row of r.rows) {
      const v = Number(row[1]);
      if (Number.isFinite(v)) pairs.push({ name: String(row[0]), value: v });
    }
    if (pairs.length > 0) return pairs;
  }
  // single row: numeric columns
  if (r.rows.length === 1) {
    const out: { name: string; value: number }[] = [];
    r.columns.forEach((c, i) => {
      const v = Number(r.rows[0][i]);
      if (Number.isFinite(v)) out.push({ name: c.name, value: v });
    });
    return out;
  }
  return [];
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <svg className="mon-spark" viewBox="0 0 100 24" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = 100 / (points.length - 1);
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(22 - ((v - min) / span) * 20).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="mon-spark" viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

const fmtVal = (n: number): string =>
  Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(1)}G`
  : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(1)}k`
  : Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);

export function MonitorPanel({ sessionId, engine, onClose }: Props) {
  const [sql, setSql] = useState(PRESETS[engine]?.[0]?.sql ?? '');
  const [intervalSec, setIntervalSec] = useState(2);
  const [active, setActive] = useState(false);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ticks, setTicks] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const samplesRef = useRef<Map<string, number[]>>(new Map());
  const lastRef = useRef<{ ts: number; values: Map<string, number> } | null>(null);
  const tick = useCallback(async () => {
    try {
      const r = await invoke<QueryResult>('monitor_query', { sessionId, sql });
      const now = performance.now();
      const values = extractValues(r);
      if (values.length === 0) {
        setError('Result has no numeric values to track (need name/value rows or a single row).');
        setActive(false);
        return;
      }
      const prev = lastRef.current;
      const next: Metric[] = values.map(({ name, value }) => {
        const buf = samplesRef.current.get(name) ?? [];
        buf.push(value);
        if (buf.length > MAX_SAMPLES) buf.shift();
        samplesRef.current.set(name, buf);
        let rate: number | null = null;
        if (prev && prev.values.has(name)) {
          const dt = (now - prev.ts) / 1000;
          if (dt > 0) rate = (value - prev.values.get(name)!) / dt;
        }
        return { name, value, rate, samples: [...buf] };
      });
      lastRef.current = { ts: now, values: new Map(values.map(v => [v.name, v.value])) };
      setMetrics(next);
      setError(null);
      setTicks(t => t + 1);
    } catch (e) {
      setError(errorDisplay(e));
      setActive(false);
    }
  }, [sessionId, sql]);

  // hidden tab: monitor stays "on", but idle — hooks/usePoll owns the loop.
  usePoll(tick, active ? intervalSec : 0, { immediate: active, paused: !active });

  function start() {
    samplesRef.current = new Map();
    lastRef.current = null;
    setMetrics([]);
    setTicks(0);
    setError(null);
    setActive(true);
  }

  const presets = PRESETS[engine] ?? [];
  const canStart = sql.trim().length > 0;

  const maxRate = useMemo(
    () => Math.max(...metrics.map(m => Math.abs(m.rate ?? 0)), 0),
    [metrics]
  );

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">📈 Monitor</span>
        {presets.length > 0 && (
          <select
            value=""
            onChange={e => {
              const p = presets.find(p => p.label === e.target.value);
              if (p) { setSql(p.sql); setActive(false); }
            }}
          >
            <option value="" disabled>Presets…</option>
            {presets.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
          </select>
        )}
        <select value={intervalSec} onChange={e => setIntervalSec(Number(e.target.value))}>
          {INTERVALS.map(s => <option key={s} value={s}>{s}s</option>)}
        </select>
        {active ? (
          <button className="toolbar-btn" onClick={() => setActive(false)}>⏸ Stop</button>
        ) : (
          <button className="toolbar-btn" onClick={start} disabled={!canStart}>▶ Start</button>
        )}
        <div style={{ flex: 1 }} />
        <span className="proc-status" style={{ border: 'none', background: 'none' }}>
          {active ? `every ${intervalSec}s · ${ticks} samples` : 'stopped'}
        </span>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      <textarea
        className="mon-sql"
        value={sql}
        onChange={e => { setSql(e.target.value); setActive(false); }}
        placeholder={"SHOW GLOBAL STATUS LIKE 'Threads_running'   — or any query returning name/value rows or one numeric row"}
        rows={3}
        spellCheck={false}
      />

      {error && <div className="proc-error-bar">{error}</div>}

      {expanded && (() => {
        const m = metrics.find(x => x.name === expanded);
        if (!m) return null;
        return (
          <div className="mon-expanded">
            <div className="mon-expanded-head">
              <b>{m.name}</b>
              <span className="dv-desc">{m.samples.length} samples · every {intervalSec}s</span>
              <div style={{ flex: 1 }} />
              <button className="toolbar-btn" onClick={() => setExpanded(null)}>✕ Close chart</button>
            </div>
            <SeriesChart series={[{ name: m.name, points: m.samples }]} area height={240} />
          </div>
        );
      })()}

      <div className="mon-grid">
        {metrics.map(m => (
          <div key={m.name} className={`mon-card ${expanded === m.name ? 'mon-card-active' : ''}`}
            onClick={() => setExpanded(prev => prev === m.name ? null : m.name)}
            title="Click for a full-size history chart">
            <div className="mon-name" title={m.name}>{m.name}</div>
            <div className="mon-value">{fmtVal(m.value)}</div>
            <div className={`mon-rate ${m.rate && Math.abs(m.rate) === maxRate && maxRate > 0 ? 'mon-rate-hot' : ''}`}>
              {m.rate === null ? '—' : `${m.rate >= 0 ? '+' : ''}${fmtVal(m.rate)}/s`}
            </div>
            <Sparkline points={m.samples} />
          </div>
        ))}
        {metrics.length === 0 && !error && (
          <div className="mx-empty">
            Pick a preset or write a query, then ▶ Start.
            Values are sampled every interval; counters show Δ/s rates.
          </div>
        )}
      </div>
    </div>
  );
}
