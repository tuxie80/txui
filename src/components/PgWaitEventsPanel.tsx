/**
 * Wait-event sampling profiler — where PostgreSQL backends spend their wait
 * time.
 *
 * Postgres reports what each backend is waiting on only as an instant snapshot
 * (`wait_event_type` / `wait_event` in `pg_stat_activity`); there is no
 * cumulative counter to query. So, like pganalyze and pg_activity, this polls
 * fast and counts occurrences — a sampling profiler. The backend streams one
 * snapshot per tick over a Tauri channel; this panel folds them into a bounded
 * ring and shows the distribution as a live histogram.
 *
 * The sampler holds no dedicated connection, but it is still a poll loop on a
 * possibly-production server, so stopping matters: the panel stops its sampler
 * when it unmounts as well as when the button is pressed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import type { Session } from '../types';
import { errorDisplay } from '../utils/appError';
import {
  aggregate, pushSnapshot, CPU_BUCKET,
  type Snapshot, type WaitBackend,
} from '../utils/waitAgg';

type WaitSample =
  | { type: 'Sampling'; intervalMs: number }
  | { type: 'Snapshot'; atMs: number; backends: WaitBackend[] }
  | { type: 'Closed'; reason: string };

interface Props {
  session: Session;
  onClose: () => void;
}

/**
 * How many snapshots the ring holds — the width of the profiling window. At
 * 150 ms this is ~5 minutes, which is plenty to see a shape without letting the
 * fold cost grow without bound.
 */
const MAX_SNAPSHOTS = 2000;

/** Poll cadence options, in ms. The backend clamps to [50, 2000] regardless. */
const INTERVALS = [100, 150, 200, 500];

/** A stable-ish colour per wait-event type, so the same class keeps its hue. */
function hueFor(type: string): string {
  if (type === CPU_BUCKET) return 'var(--green, #6fb37e)';
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 55%)`;
}

export function PgWaitEventsPanel({ session, onClose }: Props) {
  const [intervalMs, setIntervalMs] = useState(150);
  const [state, setState] = useState<'idle' | 'starting' | 'live' | 'closed'>('idle');
  const [ring, setRing] = useState<Snapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const supported = session.engine === 'postgres';

  const stop = useCallback(async () => {
    const t = tokenRef.current;
    tokenRef.current = null;
    if (t) await invoke('pg_wait_sample_stop', { token: t }).catch(() => {});
    setState(s => (s === 'live' || s === 'starting' ? 'idle' : s));
  }, []);

  // Stop on unmount as well as on the button — a sampler nobody reads is
  // pointless load on the server.
  useEffect(() => () => {
    const t = tokenRef.current;
    if (t) void invoke('pg_wait_sample_stop', { token: t }).catch(() => {});
  }, []);

  const start = useCallback(async () => {
    await stop();
    setError(null);
    setRing([]);
    setState('starting');
    const token = crypto.randomUUID();
    const onEvent = new Channel<WaitSample>();
    onEvent.onmessage = ev => {
      if (ev.type === 'Sampling') { setState('live'); return; }
      if (ev.type === 'Closed') {
        setState('closed');
        setError(`Sampling stopped: ${ev.reason}`);
        tokenRef.current = null;
        return;
      }
      const snap: Snapshot = { atMs: ev.atMs, backends: ev.backends };
      setRing(prev => pushSnapshot(prev, snap, MAX_SNAPSHOTS));
    };
    try {
      tokenRef.current = token;
      await invoke('pg_wait_sample_start', {
        sessionId: session.sessionId, token, intervalMs, onEvent,
      });
    } catch (e) {
      tokenRef.current = null;
      setState('idle');
      setError(errorDisplay(e));
    }
  }, [session.sessionId, intervalMs, stop]);

  const agg = useMemo(() => aggregate(ring), [ring]);
  const maxCount = agg.byType.length ? agg.byType[0].count : 0;

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">⏱ Wait Events</span>
        <select
          value={intervalMs}
          disabled={state === 'live' || state === 'starting'}
          onChange={e => setIntervalMs(Number(e.target.value))}
          title="Sampling interval"
        >
          {INTERVALS.map(ms => <option key={ms} value={ms}>{ms} ms</option>)}
        </select>
        {state === 'live' || state === 'starting' ? (
          <button className="toolbar-btn td-danger" onClick={() => void stop()}>Stop</button>
        ) : (
          <button className="toolbar-btn" onClick={() => void start()} disabled={!supported}>Sample</button>
        )}
        <span className={`pgl-state pgl-${state}`}>
          {state === 'live' ? '● sampling' : state === 'starting' ? '… starting' : state === 'closed' ? '● stopped' : 'idle'}
        </span>
        <div style={{ flex: 1 }} />
        <span className="dv-desc">{agg.samples} samples · {agg.observations} obs</span>
        <button className="toolbar-btn" onClick={() => setRing([])} disabled={!ring.length}>Clear</button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {!supported && (
        <div className="db-error">Wait-event sampling reads pg_stat_activity, a PostgreSQL view.</div>
      )}
      {error && <div className="proc-error-bar">{error}</div>}

      {supported && state === 'idle' && !ring.length && (
        <div className="db-error">
          Press Sample. Every ~{intervalMs} ms the profiler snapshots which backends are waiting and
          on what, then shows where the wait time concentrates over the window. A running backend with
          no wait event counts as {CPU_BUCKET}.
        </div>
      )}

      <div className="fif-results">
        {agg.byType.length > 0 && (
          <table className="pgl-note" style={{ display: 'table', width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {agg.byType.map(row => (
                <tr key={row.type}>
                  <td style={{ padding: '2px 8px', whiteSpace: 'nowrap', color: 'var(--accent)' }}>{row.type}</td>
                  <td style={{ padding: '2px 8px', width: '55%' }}>
                    <div style={{ background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        width: `${maxCount > 0 ? (row.count / maxCount) * 100 : 0}%`,
                        minWidth: 2,
                        height: 14,
                        background: hueFor(row.type),
                      }} />
                    </div>
                  </td>
                  <td style={{ padding: '2px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {row.pct.toFixed(1)}%
                  </td>
                  <td style={{ padding: '2px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                    {row.count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {agg.byEvent.length > 0 && (
          <div style={{ padding: '8px' }}>
            <div className="dv-desc" style={{ marginBottom: 4 }}>By wait event</div>
            {agg.byEvent.slice(0, 25).map(row => (
              <div key={`${row.type} ${row.event}`} className="pgl-note">
                <span className="pgl-chan" style={{ color: hueFor(row.type) }}>{row.type}</span>
                <span className="pgl-payload">{row.event === row.type ? <em>(running)</em> : row.event}</span>
                <span className="pgl-time" style={{ marginLeft: 'auto' }}>
                  {row.pct.toFixed(1)}% · {row.count}
                </span>
              </div>
            ))}
          </div>
        )}

        {state !== 'idle' && agg.observations === 0 && (
          <div className="dv-desc" style={{ padding: 8 }}>
            No backends were caught waiting or running yet. On a quiet server this is expected — the
            counts appear as soon as another session does work.
          </div>
        )}
      </div>
    </div>
  );
}
