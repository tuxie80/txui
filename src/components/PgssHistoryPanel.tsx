/**
 * ⏱ pg_stat_statements over time — snapshot → diff (PostgreSQL only).
 *
 * The pgss views are cumulative single snapshots: they rank what has been
 * expensive since the counters were last reset, but never answer "which queries
 * got slower since this morning". This panel captures timestamped snapshots of
 * pg_stat_statements into memory and diffs any two of them by `queryid`, so the
 * statement whose *total time increased the most between two moments* leads the
 * list — the question asked during an incident, not since the last reset.
 *
 * All SQL goes through the same read-only `monitor_query` path every other PG
 * panel uses; the capture is a plain SELECT and nothing is written. The diff
 * arithmetic and the reset guard live in utils/pgssDiff (pure, unit-tested);
 * this file is capture UI, snapshot bookkeeping and the results table.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { StatusIcon } from './StatusIcon';
import {
  pgssDetectSql, pgssEnableSql, readPgssStatus, fetchPgssSnapshot,
  diffPgss, sortByTotalTimeDelta, isActive, detectReset,
} from '../utils/pgssDiff';
import type { PgssStatus, PgssSnapshot, PgssDiffEntry } from '../utils/pgssDiff';
import { DigestStoreSection, type DigestRowWire } from './DigestStoreSection';

interface Props {
  session: Session;
  onClose: () => void;
}

interface Capture {
  id: number;
  snapshot: PgssSnapshot;
}

/** Keep memory bounded — older captures roll off the front. */
const MAX_CAPTURES = 12;

const fmtMs = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 2 });
const fmtInt = (n: number) => n.toLocaleString();
const fmtDelta = (n: number, f: (n: number) => string) =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${f(Math.abs(n))}`;
const fmtClock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const STATUS_LABEL: Record<PgssDiffEntry['status'], string> = {
  changed: 'changed', new: 'new', gone: 'gone',
};

export function PgssHistoryPanel({ session, onClose }: Props) {
  const { sessionId } = session;
  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId, sql }),
    [sessionId]);

  const isPg = session.engine === 'postgres';

  const [status, setStatus] = useState<PgssStatus | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [enabling, setEnabling] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [captures, setCaptures] = useState<Capture[]>([]);
  const [beforeId, setBeforeId] = useState<number | null>(null);
  const [afterId, setAfterId] = useState<number | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const nextId = useMemo(() => ({ n: 0 }), []);

  const detect = useCallback(async () => {
    if (!isPg) { setDetecting(false); return; }
    setDetecting(true);
    try {
      const r = await run(pgssDetectSql());
      setStatus(readPgssStatus(r.rows[0]));
    } catch (e) {
      setError(errorDisplay(e));
      setStatus(null);
    } finally {
      setDetecting(false);
    }
  }, [run, isPg]);

  useEffect(() => { void detect(); }, [detect]);

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
  }, [run, detect]);

  const capture = useCallback(async () => {
    setCapturing(true);
    setError(null);
    try {
      const snapshot = await fetchPgssSnapshot(run);
      const id = nextId.n++;
      // A fresh capture becomes the "after"; the previous newest fills the
      // "before" if none is chosen yet, so "snapshot now, compare to last"
      // needs no extra clicks.
      setCaptures(prev => {
        const prevNewest = prev.length > 0 ? prev[prev.length - 1].id : id;
        setAfterId(id);
        setBeforeId(b => b ?? prevNewest);
        return [...prev, { id, snapshot }].slice(-MAX_CAPTURES);
      });
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setCapturing(false);
    }
  }, [run, nextId]);

  const before = captures.find(c => c.id === beforeId) ?? null;
  const after = captures.find(c => c.id === afterId) ?? null;

  const entries = useMemo(() => {
    if (!before || !after || before.id === after.id) return null;
    const all = diffPgss(before.snapshot, after.snapshot);
    const kept = showUnchanged ? all : all.filter(isActive);
    return sortByTotalTimeDelta(kept);
  }, [before, after, showUnchanged]);

  const reset = useMemo(
    () => (before && after ? detectReset(before.snapshot, after.snapshot) : false),
    [before, after]);

  /** Latest capture as wire rows for the persistent store section. */
  const latestWire: DigestRowWire[] | null = useMemo(() => {
    const last = captures.at(-1);
    if (!last) return null;
    return [...last.snapshot.stats.values()].map(s => ({
      digest_id: s.queryid,
      query_text: s.query,
      calls: s.calls,
      total_ms: s.totalExecTime,
      mean_ms: s.meanExecTime,
      rows_total: s.rows,
      shared_blks_hit: s.sharedBlksHit,
      shared_blks_read: s.sharedBlksRead,
    }));
  }, [captures]);

  const ready = status?.installed === true;

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">⏱ pg_stat_statements over time</span>
        <span className="dv-desc">{session.connectionName}</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="dg-body">
        <div className="dg-target" style={{ maxWidth: 1100 }}>
          {/* ── availability banner ─────────────────────────────────────── */}
          {!isPg ? (
            <div className="mnt-warn">
              <StatusIcon kind="error" /> This panel is PostgreSQL-only.
            </div>
          ) : detecting ? (
            <div className="dv-desc">Checking for pg_stat_statements…</div>
          ) : !status ? (
            <div className="mnt-warn">
              <StatusIcon kind="error" /> Could not determine pg_stat_statements availability.
              <button className="toolbar-btn" onClick={() => void detect()} style={{ marginLeft: 8 }}>
                Retry
              </button>
            </div>
          ) : ready ? (
            <div className="mnt-bulk-cost c-metadata">
              <StatusIcon kind="ok" />
              <span>pg_stat_statements {status.installedVersion} is active. Capture a
                snapshot now, capture another later, and diff them by queryid.</span>
            </div>
          ) : status.available ? (
            <div className="mnt-warn">
              <StatusIcon kind="error" />
              <span>
                pg_stat_statements is available on this server but not enabled in this
                database.
              </span>
              <button className="primary" onClick={enable} disabled={enabling} style={{ marginLeft: 8 }}>
                {enabling ? 'Enabling…' : 'Enable extension'}
              </button>
            </div>
          ) : (
            <div className="mnt-warn">
              <StatusIcon kind="error" />
              <span>
                pg_stat_statements is not installed. Add it to
                <code> shared_preload_libraries</code> in <code>postgresql.conf</code>,
                restart the server, then <code>CREATE EXTENSION pg_stat_statements</code>.
              </span>
            </div>
          )}

          {/* ── capture controls ────────────────────────────────────────── */}
          {ready && (
            <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0 }}>
              <button className="primary" disabled={capturing} onClick={capture}>
                {capturing ? 'Capturing…' : '📸 Capture snapshot'}
              </button>
              <span className="dv-desc" style={{ alignSelf: 'center' }}>
                {captures.length === 0
                  ? 'No snapshots yet — capture one now, then again after some workload has run.'
                  : `${captures.length} snapshot${captures.length === 1 ? '' : 's'} in memory (last ${MAX_CAPTURES} kept).`}
              </span>
            </div>
          )}

          {/* ── snapshot pickers ────────────────────────────────────────── */}
          {ready && captures.length >= 2 && (
            <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0, gap: 16, flexWrap: 'wrap' }}>
              <label className="dg-field-inline">
                <span>Before</span>
                <select value={beforeId ?? ''} onChange={e => setBeforeId(Number(e.target.value))}>
                  {captures.map((c, i) => (
                    <option key={c.id} value={c.id}>
                      #{i + 1} · {fmtClock(c.snapshot.capturedAt)} · {c.snapshot.stats.size} stmts
                    </option>
                  ))}
                </select>
              </label>
              <label className="dg-field-inline">
                <span>After</span>
                <select value={afterId ?? ''} onChange={e => setAfterId(Number(e.target.value))}>
                  {captures.map((c, i) => (
                    <option key={c.id} value={c.id}>
                      #{i + 1} · {fmtClock(c.snapshot.capturedAt)} · {c.snapshot.stats.size} stmts
                    </option>
                  ))}
                </select>
              </label>
              <label className="dg-field-inline" style={{ alignSelf: 'center' }}>
                <input type="checkbox" checked={showUnchanged}
                  onChange={e => setShowUnchanged(e.target.checked)} />
                <span>show statements with no new calls</span>
              </label>
            </div>
          )}

          {/* ── reset warning ───────────────────────────────────────────── */}
          {reset && (
            <div className="mnt-warn">
              <StatusIcon kind="error" />
              <span>
                A statement lost calls between these snapshots —
                <code> pg_stat_statements_reset()</code> (or eviction) happened in the
                interval, so the deltas below are not a true before/after.
              </span>
            </div>
          )}

          {/* ── results ─────────────────────────────────────────────────── */}
          {ready && captures.length < 2 ? (
            <div className="dv-desc" style={{ marginTop: 4 }}>
              Capture at least two snapshots to see a diff.
            </div>
          ) : entries && before && after ? (
            before.id === after.id ? (
              <div className="dv-desc">Pick two different snapshots to compare.</div>
            ) : entries.length === 0 ? (
              <div className="dv-desc">
                No statements changed between {fmtClock(before.snapshot.capturedAt)} and{' '}
                {fmtClock(after.snapshot.capturedAt)}.
              </div>
            ) : (
              <div className="mnt-results">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th className="cp-n">Δ total ms</th>
                      <th className="cp-n">Δ calls</th>
                      <th className="cp-n">Δ mean ms</th>
                      <th className="cp-n">Δ rows</th>
                      <th className="cp-n">total ms now</th>
                      <th>query</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(e => (
                      <tr key={e.queryid}>
                        <td>
                          <span className={`dv-desc ${e.status === 'new' ? 'c-metadata' : ''}`}>
                            {STATUS_LABEL[e.status]}
                          </span>
                        </td>
                        <td className="cp-n" style={{ color: deltaColor(e.deltaTotalTime), fontWeight: 600 }}>
                          {fmtDelta(e.deltaTotalTime, fmtMs)}
                        </td>
                        <td className="cp-n">{fmtDelta(e.deltaCalls, fmtInt)}</td>
                        <td className="cp-n" style={{ color: deltaColor(e.deltaMeanTime) }}>
                          {fmtDelta(e.deltaMeanTime, fmtMs)}
                        </td>
                        <td className="cp-n">{fmtDelta(e.deltaRows, fmtInt)}</td>
                        <td className="cp-n">{fmtMs(e.afterTotalTime)}</td>
                        <td className="cp-type" style={{ whiteSpace: 'nowrap', maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis' }}
                          title={e.query}>
                          {e.query}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}
        </div>

        {ready && <DigestStoreSection session={session} latestRows={latestWire} />}
      </div>
    </div>
  );
}

/** Slower is bad (red), faster is good (green), unchanged inherits. */
function deltaColor(delta: number): string | undefined {
  if (delta > 0) return 'var(--danger, #c33)';
  if (delta < 0) return 'var(--ok, #3a3)';
  return undefined;
}
