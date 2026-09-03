/**
 * MySQL statement-digest history — the MySQL twin of PgssHistoryPanel.
 *
 * Captures timestamped snapshots of
 * `performance_schema.events_statements_summary_by_digest` and diffs any two by
 * DIGEST, so you can ask "which statements got slower / ran more between these
 * two moments" instead of only "what's expensive since the last reset". Read
 * only: every capture is a plain SELECT through `monitor_query`. Arithmetic is
 * in utils/mysqlDigestDiff (pure, unit-tested).
 */
import { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import {
  DIGEST_SNAPSHOT_SQL, diffDigests, parseDigestRows, type DigestSnapshot,
} from '../utils/mysqlDigestDiff';
import { DigestStoreSection, type DigestRowWire } from './DigestStoreSection';

interface Props { session: Session; onClose: () => void; }
interface Capture { id: number; at: number; snapshot: DigestSnapshot; }

const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
const fmtTime = (t: number) => new Date(t).toLocaleTimeString();

export function MysqlDigestPanel({ session, onClose }: Props) {
  const sessionId = session.sessionId;
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [beforeId, setBeforeId] = useState<number | null>(null);
  const [afterId, setAfterId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capture = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await invoke<QueryResult>('monitor_query', { sessionId, sql: DIGEST_SNAPSHOT_SQL });
      const at = Date.now();
      const snap: DigestSnapshot = { at, rows: parseDigestRows(r.rows as unknown[][]) };
      setCaptures(prev => {
        const id = (prev.at(-1)?.id ?? 0) + 1;
        const next = [...prev, { id, at, snapshot: snap }];
        // Newest becomes "after"; the prior newest fills "before" if unset.
        setAfterId(id);
        setBeforeId(b => b ?? prev.at(-1)?.id ?? null);
        return next;
      });
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const before = captures.find(c => c.id === beforeId) ?? null;
  const after = captures.find(c => c.id === afterId) ?? null;
  const deltas = useMemo(
    () => (before && after && before.id !== after.id ? diffDigests(before.snapshot, after.snapshot) : null),
    [before, after]);

  /** Latest capture as wire rows for the persistent store section. */
  const latestWire: DigestRowWire[] | null = useMemo(() => {
    const last = captures.at(-1);
    if (!last) return null;
    return last.snapshot.rows.map(r => ({
      digest_id: r.digest,
      query_text: r.text,
      calls: r.count,
      total_ms: r.totalMs,
      mean_ms: r.count > 0 ? r.totalMs / r.count : 0,
      rows_total: r.rowsExamined,
      shared_blks_hit: 0,
      shared_blks_read: 0,
    }));
  }, [captures]);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🧾 Statement digest history</span>
        <button className="primary" disabled={busy} onClick={() => void capture()}>
          {busy ? 'Capturing…' : 'Capture snapshot'}
        </button>
        {captures.length >= 2 && (
          <>
            <label className="dg-field-inline"><span>Before</span>
              <select value={beforeId ?? ''} onChange={e => setBeforeId(Number(e.target.value))}>
                {captures.map(c => <option key={c.id} value={c.id}>#{c.id} · {fmtTime(c.at)}</option>)}
              </select>
            </label>
            <label className="dg-field-inline"><span>After</span>
              <select value={afterId ?? ''} onChange={e => setAfterId(Number(e.target.value))}>
                {captures.map(c => <option key={c.id} value={c.id}>#{c.id} · {fmtTime(c.at)}</option>)}
              </select>
            </label>
          </>
        )}
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {!captures.length && (
        <div className="mnt-note">
          Capture a snapshot, run some workload, capture again — then this diffs the two by digest so
          you can see exactly which statements ran more or got slower in between.
        </div>
      )}

      {deltas && (
        <div className="digest-result">
          <table className="td-table">
            <thead>
              <tr><th>Statement (digest)</th><th>+ execs</th><th>+ total time</th><th>avg</th><th>+ rows examined</th></tr>
            </thead>
            <tbody>
              {deltas.slice(0, 200).map(d => (
                <tr key={d.digest}>
                  <td className="digest-text" title={d.text}>{d.text}</td>
                  <td style={{ textAlign: 'right' }}>{d.dCount.toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{fmtMs(d.dTotalMs)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtMs(d.avgMs)}</td>
                  <td style={{ textAlign: 'right' }}>{d.dRows.toLocaleString()}</td>
                </tr>
              ))}
              {deltas.length === 0 && (
                <tr><td colSpan={5} className="mnt-empty">No digest advanced between these two snapshots.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <DigestStoreSection session={session} latestRows={latestWire} />
    </div>
  );
}
