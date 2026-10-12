/**
 * Design the schema of a NEW Parquet file (connection form's New… button).
 * Parquet is immutable, so "create" means "write once, completely" — for an
 * empty file that means the schema IS the file, which is why this dialog
 * exists rather than a bare save picker. Column list state and validation
 * live in the pure utils/parquetSchema.ts (mirrored by the Rust allowlist);
 * this component is rows + a save dialog + the invoke.
 */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { errorDisplay } from '../utils/appError';
import {
  PARQUET_TYPES, newColumnDraft, validateColumns, buildPayload,
  type ParquetColumnDraft, type ParquetTypeId,
} from '../utils/parquetSchema';

interface Props {
  /** Called with the created file's path; the form points itself at it. */
  onCreated: (path: string) => void;
  onCancel: () => void;
}

export function ParquetSchemaDialog({ onCreated, onCancel }: Props) {
  const [cols, setCols] = useState<ParquetColumnDraft[]>([newColumnDraft('id')]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const patch = (i: number, p: Partial<ParquetColumnDraft>) =>
    setCols(prev => prev.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const move = (i: number, dir: -1 | 1) =>
    setCols(prev => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  async function create() {
    const problems = validateColumns(cols);
    setErrors(problems);
    if (problems.length > 0) return;
    const picked = await saveDialog({
      defaultPath: 'new-data.parquet',
      filters: [{ name: 'Parquet', extensions: ['parquet'] }],
    });
    if (!picked) return;
    setBusy(true);
    try {
      // The save dialog already confirmed any overwrite, but the backend
      // refuses an existing path outright — same rule as create_sqlite_file.
      await invoke('create_parquet_file', { path: picked, columns: buildPayload(cols) });
      onCreated(picked);
    } catch (e) {
      setErrors([`Could not create the file — ${errorDisplay(e)}`]);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal wc-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">New Parquet file</span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>

        <div className="wc-body">
          <p className="form-hint" style={{ marginTop: 0 }}>
            Parquet files are immutable — the schema chosen here is fixed at creation.
            The file starts empty; rows come from appending with another tool, or create
            from data instead via Export → Parquet on a result grid.
          </p>
          {cols.map((c, i) => (
            <div key={i} className="cf-pair" style={{ marginBottom: 4 }}>
              <input value={c.name} placeholder="column name" style={{ flex: 2 }}
                onChange={e => patch(i, { name: e.target.value })} />
              <select value={c.type} style={{ flex: 1 }}
                onChange={e => patch(i, { type: e.target.value as ParquetTypeId })}>
                {PARQUET_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              {c.type === 'decimal' && (
                <>
                  <input type="number" min={1} max={38} value={c.precision} title="precision"
                    style={{ width: 56 }}
                    onChange={e => patch(i, { precision: Number(e.target.value) })} />
                  <input type="number" min={0} max={38} value={c.scale} title="scale"
                    style={{ width: 56 }}
                    onChange={e => patch(i, { scale: Number(e.target.value) })} />
                </>
              )}
              <label className="pq-null" title="Nullable (OPTIONAL in Parquet terms)">
                <input type="checkbox" checked={c.nullable}
                  onChange={e => patch(i, { nullable: e.target.checked })} />
                null
              </label>
              <button type="button" title="Move up" style={{ width: 26 }}
                disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" title="Move down" style={{ width: 26 }}
                disabled={i === cols.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" title="Remove column" style={{ width: 26 }}
                disabled={cols.length <= 1}
                onClick={() => setCols(prev => prev.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" style={{ alignSelf: 'flex-start' }}
            onClick={() => setCols(prev => [...prev, newColumnDraft()])}>+ add column</button>
          {errors.length > 0 && (
            <ul className="pq-errors">
              {errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>

        <div className="wc-actions">
          <button ref={cancelRef} className="toolbar-btn wc-cancel" onClick={onCancel}>
            Cancel (Esc)
          </button>
          <div style={{ flex: 1 }} />
          <button className="toolbar-btn wc-run" disabled={busy} onClick={create}>
            {busy ? 'Creating…' : 'Choose location & create…'}
          </button>
        </div>
      </div>
    </div>
  );
}
