import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { fmtDuration } from '../utils/fmtDuration';
import {
  fetchPgssSnapshot, pgssDetectSql, pgssEnableSql, readPgssStatus,
  type PgssSnapshot, type PgssStatus,
} from '../utils/pgssDiff';
import { correlatePgWorkload } from '../utils/pgWorkload';
import { pushSnapshot, type Snapshot, type WaitBackend } from '../utils/waitAgg';
import {
  KIND_LABEL, localText, summarizeTitle, timeOfDay,
  type TimelineEvent, type TimelineKind,
} from '../utils/incidentTimeline';
import { StatusIcon } from './StatusIcon';

interface Props {
  session: Session;
  onClose: () => void;
}

type WaitSample =
  | { type: 'Sampling'; intervalMs: number }
  | { type: 'Snapshot'; atMs: number; backends: WaitBackend[] }
  | { type: 'Closed'; reason: string };

type SamplerState = 'idle' | 'starting' | 'live' | 'closed';

const MAX_WAIT_SAMPLES = 2000;
const INTERVALS = [100, 150, 200, 500];
const STATEMENT_LIMIT = 50;
const INCIDENT_LIMIT = 100;
const SQL_KINDS: ReadonlySet<TimelineKind> = new Set(['audit', 'long_query', 'multi_run']);

const fmtMs = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 2 });
const fmtInt = (n: number) => n.toLocaleString();
const fmtDelta = (n: number, f: (n: number) => string) =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${f(Math.abs(n))}`;
const fmtTime = (ms: number) => new Date(ms).toLocaleString();

function incidentSql(event: TimelineEvent): string | null {
  if (!SQL_KINDS.has(event.kind)) return null;
  const sql = event.kind === 'audit' ? event.title : event.detail;
  return sql.trim() ? sql : null;
}

function insertIntoEditor(sql: string) {
  window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));
}

export function PgWorkloadPanel({ session, onClose }: Props) {
  const { sessionId } = session;
  const isPg = session.engine === 'postgres';
  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId, sql }),
    [sessionId],
  );

  const [status, setStatus] = useState<PgssStatus | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [enabling, setEnabling] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [incidentError, setIncidentError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<PgssSnapshot | null>(null);
  const [after, setAfter] = useState<PgssSnapshot | null>(null);
  const [incidents, setIncidents] = useState<TimelineEvent[]>([]);
  const [waitSamples, setWaitSamples] = useState<Snapshot[]>([]);
  const [samplerState, setSamplerState] = useState<SamplerState>('idle');
  const [intervalMs, setIntervalMs] = useState(150);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const tokenRef = useRef<string | null>(null);

  const detect = useCallback(async () => {
    if (!isPg) { setDetecting(false); return; }
    setDetecting(true);
    setError(null);
    try {
      const result = await run(pgssDetectSql());
      setStatus(readPgssStatus(result.rows[0]));
    } catch (e) {
      setStatus(null);
      setError(errorDisplay(e));
    } finally {
      setDetecting(false);
    }
  }, [isPg, run]);

  useEffect(() => { void detect(); }, [detect]);

  const stopWaits = useCallback(async () => {
    const token = tokenRef.current;
    tokenRef.current = null;
    if (token) await invoke('pg_wait_sample_stop', { token }).catch(() => {});
    setSamplerState('idle');
  }, []);

  useEffect(() => () => {
    const token = tokenRef.current;
    if (token) void invoke('pg_wait_sample_stop', { token }).catch(() => {});
  }, []);

  const startWaits = useCallback(async () => {
    if (!baseline || after || !isPg) return;
    await stopWaits();
    setError(null);
    setSamplerState('starting');
    const token = crypto.randomUUID();
    const onEvent = new Channel<WaitSample>();
    onEvent.onmessage = event => {
      if (tokenRef.current !== token) return;
      if (event.type === 'Sampling') { setSamplerState('live'); return; }
      if (event.type === 'Closed') {
        tokenRef.current = null;
        setSamplerState('closed');
        setError(`Wait sampling stopped: ${event.reason}`);
        return;
      }
      const sample: Snapshot = { atMs: event.atMs, backends: event.backends };
      setWaitSamples(prev => pushSnapshot(prev, sample, MAX_WAIT_SAMPLES));
    };
    try {
      tokenRef.current = token;
      await invoke('pg_wait_sample_start', { sessionId, token, intervalMs, onEvent });
    } catch (e) {
      tokenRef.current = null;
      setSamplerState('idle');
      setError(errorDisplay(e));
    }
  }, [after, baseline, intervalMs, isPg, sessionId, stopWaits]);

  const enable = useCallback(async () => {
    setEnabling(true);
    setError(null);
    try {
      await run(pgssEnableSql());
      await detect();
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setEnabling(false);
    }
  }, [detect, run]);

  const captureBaseline = useCallback(async () => {
    setCapturing(true);
    setError(null);
    setIncidentError(null);
    await stopWaits();
    try {
      const snapshot = await fetchPgssSnapshot(run);
      setBaseline(snapshot);
      setAfter(null);
      setIncidents([]);
      setWaitSamples([]);
      setExpanded(new Set());
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setCapturing(false);
    }
  }, [run, stopWaits]);

  const captureAfter = useCallback(async () => {
    if (!baseline) return;
    setCapturing(true);
    setError(null);
    setIncidentError(null);
    await stopWaits();
    try {
      const snapshot = await fetchPgssSnapshot(run);
      setAfter(snapshot);
      setIncidents([]);
      setExpanded(new Set());
      try {
        const rows = await invoke<TimelineEvent[]>('incident_timeline', {
          connectionId: session.connectionId,
          connectionName: session.connectionName,
          from: localText(new Date(baseline.capturedAt)),
          to: localText(new Date(snapshot.capturedAt)),
          kinds: null,
          limit: 2000,
        });
        setIncidents(rows);
      } catch (e) {
        setIncidentError(errorDisplay(e));
      }
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setCapturing(false);
    }
  }, [baseline, run, session.connectionId, session.connectionName, stopWaits]);

  const report = useMemo(
    () => baseline && after ? correlatePgWorkload(baseline, after, waitSamples, incidents) : null,
    [after, baseline, incidents, waitSamples],
  );
  const ready = status?.installed === true;
  const sampling = samplerState === 'starting' || samplerState === 'live';

  const toggleIncident = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">PostgreSQL Workload</span>
        <span className="dv-desc">{session.connectionName}</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="dg-body">
        <div className="dg-target" style={{ maxWidth: 1400 }}>
          {!isPg ? (
            <div className="mnt-warn"><StatusIcon kind="error" /> This panel is PostgreSQL-only.</div>
          ) : detecting ? (
            <div className="dv-desc">Checking for pg_stat_statements…</div>
          ) : !status ? (
            <div className="mnt-warn">
              <StatusIcon kind="error" /> Could not determine pg_stat_statements availability.
              <button className="toolbar-btn" onClick={() => void detect()} style={{ marginLeft: 8 }}>Retry</button>
            </div>
          ) : !ready ? (
            status.available ? (
              <div className="mnt-warn">
                <StatusIcon kind="error" />
                <span>pg_stat_statements is available but not enabled in this database.</span>
                <button className="primary" onClick={enable} disabled={enabling} style={{ marginLeft: 8 }}>
                  {enabling ? 'Enabling…' : 'Enable extension'}
                </button>
              </div>
            ) : (
              <div className="mnt-warn">
                <StatusIcon kind="error" />
                <span>Add pg_stat_statements to <code>shared_preload_libraries</code>, restart PostgreSQL,
                  then run <code>CREATE EXTENSION pg_stat_statements</code>.</span>
              </div>
            )
          ) : (
            <>
              <div className="mnt-bulk-cost c-metadata">
                <StatusIcon kind="ok" />
                <span>Manual before/after measurement using pg_stat_statements {status.installedVersion}.
                  Nothing is captured in the background.</span>
              </div>

              <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0, flexWrap: 'wrap' }}>
                <button className="primary" disabled={capturing} onClick={() => void captureBaseline()}>
                  {capturing ? 'Capturing…' : baseline ? '1. Capture new baseline' : '1. Capture baseline'}
                </button>
                <button className="primary" disabled={!baseline || capturing} onClick={() => void captureAfter()}>
                  {capturing && baseline ? 'Capturing…' : '2. Capture after'}
                </button>
                <span className="dv-desc" style={{ alignSelf: 'center' }}>
                  {baseline ? `Baseline ${fmtTime(baseline.capturedAt)}` : 'Capture a baseline, run the workload, then capture after.'}
                  {after ? ` → after ${fmtTime(after.capturedAt)}` : ''}
                </span>
              </div>

              <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0, flexWrap: 'wrap' }}>
                <strong>Optional wait sampling</strong>
                <select value={intervalMs} disabled={sampling || !baseline || !!after}
                  onChange={e => setIntervalMs(Number(e.target.value))} title="Wait sampling interval">
                  {INTERVALS.map(ms => <option key={ms} value={ms}>{ms} ms</option>)}
                </select>
                {sampling ? (
                  <button className="toolbar-btn td-danger" onClick={() => void stopWaits()}>Stop wait sampling</button>
                ) : (
                  <button className="toolbar-btn" disabled={!baseline || !!after} onClick={() => void startWaits()}>
                    Start wait sampling
                  </button>
                )}
                <span className={`pgl-state pgl-${samplerState}`}>
                  {samplerState === 'live' ? '● sampling' : samplerState === 'starting' ? '… starting'
                    : samplerState === 'closed' ? '● sampler stopped on error' : 'idle'}
                </span>
                <span className="dv-desc">{waitSamples.length} retained sample{waitSamples.length === 1 ? '' : 's'}</span>
              </div>
              <div className="dv-desc" style={{ marginBottom: 12 }}>
                Waits are in-memory only and represent just the time sampled while this panel was active,
                not the whole measurement window or server history. At most {MAX_WAIT_SAMPLES.toLocaleString()} samples are retained.
              </div>

              {baseline && !after && (
                <div className="dv-desc">Run the workload now. Optionally start wait sampling, then choose “2. Capture after”.</div>
              )}

              {report && (
                <div style={{ display: 'grid', gap: 18 }}>
                  <div className="dv-desc">
                    Measurement window: {fmtTime(report.window.startMs)} → {fmtTime(report.window.endMs)}
                    {' '}({fmtDuration(report.window.endMs - report.window.startMs)})
                  </div>

                  <section>
                    <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0 }}>
                      <strong>1. Ranked statement deltas</strong>
                      <span className="dv-desc">by increased total execution time</span>
                    </div>
                    {report.resetDetected && (
                      <div className="mnt-warn">
                        <StatusIcon kind="error" />
                        <span>A statement lost calls between captures. A pg_stat_statements reset or eviction/reinsertion
                          makes these deltas unreliable; capture a new baseline before drawing conclusions.</span>
                      </div>
                    )}
                    {report.statements.length === 0 ? (
                      <div className="dv-desc">No statement activity was recorded between the captures.</div>
                    ) : (
                      <>
                        <div className="mnt-results">
                          <table className="cp-table">
                            <thead><tr>
                              <th>status</th><th className="cp-n">Δ total ms</th><th className="cp-n">Δ calls</th>
                              <th className="cp-n">Δ mean ms</th><th className="cp-n">Δ rows</th><th>query</th><th></th>
                            </tr></thead>
                            <tbody>
                              {report.statements.slice(0, STATEMENT_LIMIT).map(entry => (
                                <tr key={entry.queryid}>
                                  <td className="dv-desc">{entry.status}</td>
                                  <td className="cp-n" style={{ fontWeight: 600 }}>{fmtDelta(entry.deltaTotalTime, fmtMs)}</td>
                                  <td className="cp-n">{fmtDelta(entry.deltaCalls, fmtInt)}</td>
                                  <td className="cp-n">{fmtDelta(entry.deltaMeanTime, fmtMs)}</td>
                                  <td className="cp-n">{fmtDelta(entry.deltaRows, fmtInt)}</td>
                                  <td className="cp-type" title={entry.query} style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {entry.query}
                                  </td>
                                  <td><button className="toolbar-btn" onClick={() => insertIntoEditor(entry.query)}>Editor</button></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {report.statements.length > STATEMENT_LIMIT && (
                          <div className="dv-desc">Showing top {STATEMENT_LIMIT} of {report.statements.length} active statements.</div>
                        )}
                      </>
                    )}
                  </section>

                  <section>
                    <strong>2. Sampled waits</strong>
                    {report.waitCoverage.samples === 0 ? (
                      <div className="dv-desc" style={{ marginTop: 6 }}>
                        No wait samples were taken in this window. This says nothing about unsampled server waits.
                      </div>
                    ) : (
                      <>
                        <div className="dv-desc" style={{ margin: '4px 0 8px' }}>
                          {report.waitCoverage.samples} samples · {report.waits.observations} backend observations
                          {report.waitCoverage.firstMs !== null && report.waitCoverage.lastMs !== null && (
                            <> · sampled coverage {fmtTime(report.waitCoverage.firstMs)} → {fmtTime(report.waitCoverage.lastMs)}</>
                          )}
                        </div>
                        {report.waits.observations === 0 ? (
                          <div className="dv-desc">No backend was caught running or waiting in the retained samples.</div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 0.7fr) minmax(320px, 1.3fr)', gap: 16 }}>
                            <table className="cp-table">
                              <thead><tr><th>wait type</th><th className="cp-n">share</th><th className="cp-n">observations</th></tr></thead>
                              <tbody>{report.waits.byType.map(row => (
                                <tr key={row.type}><td>{row.type}</td><td className="cp-n">{row.pct.toFixed(1)}%</td><td className="cp-n">{row.count}</td></tr>
                              ))}</tbody>
                            </table>
                            <table className="cp-table">
                              <thead><tr><th>type</th><th>event</th><th className="cp-n">share</th><th className="cp-n">observations</th></tr></thead>
                              <tbody>{report.waits.byEvent.slice(0, 25).map(row => (
                                <tr key={`${row.type} ${row.event}`}><td>{row.type}</td><td>{row.event === row.type && row.type === 'CPU' ? <em>(running)</em> : row.event}</td>
                                  <td className="cp-n">{row.pct.toFixed(1)}%</td><td className="cp-n">{row.count}</td></tr>
                              ))}</tbody>
                            </table>
                          </div>
                        )}
                      </>
                    )}
                  </section>

                  <section>
                    <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0 }}>
                      <strong>3. Local incidents in the same window</strong>
                      <button className="toolbar-btn" onClick={() => window.dispatchEvent(new CustomEvent('dbgui:toggle-panel', { detail: { panel: 'timeline' } }))}>
                        Open incident timeline
                      </button>
                    </div>
                    {incidentError && <div className="proc-error-bar">Could not load local incidents: {incidentError}</div>}
                    {!incidentError && report.incidents.length === 0 && (
                      <div className="dv-desc">No retained local long queries, deadlocks, failures, or other incidents fall inside this window.</div>
                    )}
                    <div className="tl-list">
                      {report.incidents.slice(0, INCIDENT_LIMIT).map(event => {
                        const sql = incidentSql(event);
                        return (
                          <div key={event.id} className={`tl-row${event.ok ? '' : ' tl-bad'}`}>
                            <div className="tl-row-main" onClick={() => toggleIncident(event.id)}>
                              <span className="tl-time">{timeOfDay(event.at_ms)}</span>
                              <span className={`tl-kind tl-kind-${event.kind}`}>{KIND_LABEL[event.kind]}</span>
                              <span className="tl-title">{summarizeTitle(event)}</span>
                              {event.duration_ms > 0 && <span className="tl-dur">{fmtDuration(event.duration_ms)}</span>}
                              {!event.ok && <span className="tl-status">failed</span>}
                            </div>
                            {expanded.has(event.id) && (
                              <div className="tl-detail">
                                {event.detail && <pre className="tl-detail-text">{event.detail}</pre>}
                                {event.kind === 'audit' && event.title !== event.detail && <pre className="tl-detail-text">{event.title}</pre>}
                                {sql && <button className="toolbar-btn" onClick={() => insertIntoEditor(sql)}>Insert into editor</button>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {report.incidents.length > INCIDENT_LIMIT && (
                      <div className="dv-desc">Showing newest {INCIDENT_LIMIT} of {report.incidents.length} incidents. Open the timeline for the full retained view.</div>
                    )}
                  </section>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="proc-status">
        Manual captures and waits stay in this panel's memory; no snapshot database or background collector is added.
        Local incidents remain subject to the existing history stores' retention limits.
      </div>
    </div>
  );
}
