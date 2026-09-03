/**
 * Stored digest snapshots — the persistent half of the digest-history panels.
 *
 * The live panels (MysqlDigestPanel, PgssHistoryPanel) capture snapshots into
 * memory and lose them on restart. This section is the QAN-style local store:
 * "Save snapshot" persists the panel's latest capture (cumulative counters,
 * one row per digest) into history.db via save_digest_snapshot, and any two
 * stored snapshots can be diffed — the before/after-deploy question. The diff
 * itself runs in Rust (diff_digest_snapshots, same changed/new/gone semantics
 * as the live pgss diff), so this file is list/save/pick/render only.
 *
 * Shared by both digest panels; each passes its latest capture already
 * converted to the wire row shape. Retention (100 snapshots per connection)
 * and text dedupe/capping live in src-tauri/src/history.rs.
 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Session } from '../types';
import { errorDisplay } from '../utils/appError';

/** Wire shape of one digest row (cumulative counters), snake_case payload. */
export interface DigestRowWire {
  digest_id: string;
  query_text: string;
  calls: number;
  total_ms: number;
  mean_ms: number;
  rows_total: number;
  shared_blks_hit: number;
  shared_blks_read: number;
}

interface DigestSnapshotMeta {
  id: number;
  connection_id: string;
  engine: string;
  label: string;
  rows_count: number;
  created_at: string;
}

interface StoredDigestDelta {
  digest_id: string;
  query_text: string;
  status: 'changed' | 'new' | 'gone';
  d_calls: number;
  d_total_ms: number;
  d_rows: number;
  after_calls: number;
  after_total_ms: number;
  after_mean_ms: number;
}

interface Props {
  session: Session;
  /** The panel's latest capture as wire rows; null before the first capture. */
  latestRows: DigestRowWire[] | null;
}

const fmtMs = (ms: number) =>
  Math.abs(ms) >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
const fmtDelta = (n: number, f: (n: number) => string) =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${f(Math.abs(n))}`;
const fmtInt = (n: number) => Math.abs(n).toLocaleString();

export function DigestStoreSection({ session, latestRows }: Props) {
  const { connectionId, engine } = session;
  const [stored, setStored] = useState<DigestSnapshotMeta[]>([]);
  const [label, setLabel] = useState('');
  const [beforeId, setBeforeId] = useState<number | null>(null);
  const [afterId, setAfterId] = useState<number | null>(null);
  const [deltas, setDeltas] = useState<StoredDigestDelta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<DigestSnapshotMeta[]>('list_digest_snapshots', { connectionId });
      setStored(list);
      // Newest becomes "after"; the one before it fills "before" if unset.
      setAfterId(a => (a != null && list.some(m => m.id === a) ? a : list[0]?.id ?? null));
      setBeforeId(b => (b != null && list.some(m => m.id === b) ? b : list[1]?.id ?? null));
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async () => {
    if (!latestRows) return;
    setBusy(true); setError(null);
    try {
      await invoke('save_digest_snapshot', {
        connectionId,
        engine,
        label: label.trim() || new Date().toLocaleString(),
        rows: latestRows,
      });
      setLabel('');
      await refresh();
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(false);
    }
  }, [connectionId, engine, label, latestRows, refresh]);

  const remove = useCallback(async (id: number) => {
    setError(null);
    try {
      await invoke('delete_digest_snapshot', { id });
      setDeltas(null);
      await refresh();
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [refresh]);

  const diff = useCallback(async () => {
    if (beforeId == null || afterId == null) return;
    setBusy(true); setError(null);
    try {
      setDeltas(await invoke<StoredDigestDelta[]>('diff_digest_snapshots', { beforeId, afterId }));
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(false);
    }
  }, [beforeId, afterId]);

  const resetSuspected = deltas?.some(d => d.status === 'changed' && d.d_calls < 0) ?? false;
  const optLabel = (m: DigestSnapshotMeta) =>
    `#${m.id} · ${m.label || m.created_at} · ${m.rows_count} digests`;

  return (
    <div className="dg-target" style={{ maxWidth: 1100, marginTop: 12 }}>
      <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0 }}>
        <button className="toolbar-btn" disabled={busy || !latestRows} onClick={() => void save()}
          title={latestRows ? 'Persist the latest capture into history.db' : 'Capture a snapshot first'}>
          💾 Save snapshot
        </button>
        <input type="text" value={label} onChange={e => setLabel(e.target.value)}
          placeholder="label (default: now)" style={{ width: 220 }} />
        <span className="dv-desc" style={{ alignSelf: 'center' }}>
          {stored.length === 0
            ? 'Nothing stored yet — saved snapshots survive restarts (100 per connection kept).'
            : `${stored.length} stored for this connection.`}
        </span>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {stored.length >= 2 && (
        <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0, gap: 16, flexWrap: 'wrap' }}>
          <label className="dg-field-inline"><span>Before</span>
            <select value={beforeId ?? ''} onChange={e => setBeforeId(Number(e.target.value))}>
              {stored.map(m => <option key={m.id} value={m.id}>{optLabel(m)}</option>)}
            </select>
          </label>
          <label className="dg-field-inline"><span>After</span>
            <select value={afterId ?? ''} onChange={e => setAfterId(Number(e.target.value))}>
              {stored.map(m => <option key={m.id} value={m.id}>{optLabel(m)}</option>)}
            </select>
          </label>
          <button className="toolbar-btn" disabled={busy || beforeId == null || afterId == null || beforeId === afterId}
            onClick={() => void diff()}>
            Diff stored
          </button>
        </div>
      )}

      {stored.length > 0 && (
        <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0, gap: 8, flexWrap: 'wrap' }}>
          {stored.map(m => (
            <span key={m.id} className="dv-desc" style={{ alignSelf: 'center' }}>
              {optLabel(m)}{' '}
              <button className="icon-btn" title="Delete stored snapshot" onClick={() => void remove(m.id)}>×</button>
            </span>
          ))}
        </div>
      )}

      {resetSuspected && (
        <div className="mnt-warn">
          A digest lost calls between these snapshots — a counter reset (or eviction)
          happened in the interval, so the deltas below are not a true before/after.
        </div>
      )}

      {deltas && (
        <div className="digest-result">
          <table className="td-table">
            <thead>
              <tr><th></th><th>Statement (digest)</th><th>Δ calls</th><th>Δ total time</th><th>Δ rows</th><th>avg now</th></tr>
            </thead>
            <tbody>
              {deltas.slice(0, 200).map(d => (
                <tr key={d.digest_id}>
                  <td className="dv-desc">{d.status}</td>
                  <td className="digest-text" title={d.query_text}>{d.query_text}</td>
                  <td style={{ textAlign: 'right' }}>{fmtDelta(d.d_calls, fmtInt)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtDelta(d.d_total_ms, fmtMs)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtDelta(d.d_rows, fmtInt)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtMs(d.after_mean_ms)}</td>
                </tr>
              ))}
              {deltas.length === 0 && (
                <tr><td colSpan={6} className="mnt-empty">No digests in these snapshots.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
