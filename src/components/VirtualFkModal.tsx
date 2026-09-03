/**
 * Manage virtual foreign keys for one table (child side). Virtual FKs are
 * local, user-declared relations for FK-less schemas — they power JOIN
 * completion, data-browser click-through and dashed ER-diagram edges.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import { errorDisplay } from '../utils/appError';
import {
  addVirtualFk, removeVirtualFk, useVirtualFks,
  useLegacyVirtualFks, adoptLegacyVirtualFk, discardLegacyVirtualFk,
} from '../store/virtualFks';
import { commentedColumnsSql, findSoftRefs, resolveSoftRefs } from '../utils/softRefs';
import type { SoftRef } from '../utils/softRefs';

interface Props {
  /** qualified `schema.table` — the child side of new relations */
  table: string;
  /** Virtual FKs belong to one connection — see the note in the store. */
  connectionId: string;
  /** Session + engine enable discovery from column comments; without them the
   *  modal is exactly what it was, a manual editor. */
  sessionId?: string;
  engine?: string;
  onClose: () => void;
}

export function VirtualFkModal({ table, connectionId, sessionId, engine, onClose }: Props) {
  const all = useVirtualFks(connectionId);
  const legacy = useLegacyVirtualFks();
  const mine = all.filter(f =>
    f.fromTable.toLowerCase() === table.toLowerCase()
    || f.toTable.toLowerCase() === table.toLowerCase());
  const [fromColumn, setFromColumn] = useState('');
  const [toTable, setToTable] = useState('');
  const [toColumn, setToColumn] = useState('id');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Relationships the schema already wrote down, in the place nobody reads.
   *
   * Most production MySQL has no foreign keys and every relation lives in a
   * column comment. Typing them in one at a time — for a schema that has
   * already documented them — is the work this removes. Nothing is applied:
   * each pair is proposed, with the comment that produced it, and added only
   * when the user says so.
   */
  const [found, setFound] = useState<SoftRef[] | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const schema = table.includes('.') ? table.slice(0, table.indexOf('.')) : '';

  const scan = async () => {
    if (!sessionId || !engine || !schema) return;
    setScanning(true);
    setScanNote(null);
    try {
      const q = (sql: string) => invoke<QueryResult>('monitor_query', { sessionId, sql });
      const comments = await q(commentedColumnsSql(engine, schema));
      const refs = findSoftRefs(comments.rows.map(r => ({
        table: String(r[0]), column: String(r[1]), comment: r[2] == null ? null : String(r[2]),
      })));
      // Resolve against the real catalog: a comment naming a table that is not
      // there must not become a link to nowhere.
      const cols = await q(engine === 'postgres'
        ? `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = '${schema.replace(/'/g, "''")}'`
        : `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = '${schema.replace(/'/g, "''")}'`);
      const byTable = new Map<string, Set<string>>();
      for (const r of cols.rows) {
        const t = String(r[0]);
        if (!byTable.has(t)) byTable.set(t, new Set());
        byTable.get(t)!.add(String(r[1]));
      }
      const { resolved, unresolved } = resolveSoftRefs(
        refs, new Set(byTable.keys()), t => byTable.get(t) ?? new Set());

      const existing = new Set(all.map(f =>
        `${f.fromTable.toLowerCase()}.${f.fromColumn.toLowerCase()}`));
      const fresh = resolved.filter(r =>
        !existing.has(`${schema.toLowerCase()}.${r.fromTable.toLowerCase()}.${r.fromColumn.toLowerCase()}`));

      setFound(fresh);
      setScanNote(
        `${refs.length} reference${refs.length === 1 ? '' : 's'} found in comments · `
        + `${fresh.length} new · ${resolved.length - fresh.length} already declared`
        + (unresolved.length
          ? ` · ${unresolved.length} point at something that is not here`
            + (unresolved[0].didYouMean ? ` (e.g. ${unresolved[0].toTable} — did you mean ${unresolved[0].didYouMean}?)` : '')
          : ''));
    } catch (e) {
      setScanNote(`Could not read the comments: ${errorDisplay(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const accept = (r: SoftRef) => {
    addVirtualFk(connectionId, {
      fromTable: `${schema}.${r.fromTable}`,
      fromColumn: r.fromColumn,
      toTable: `${schema}.${r.toTable}`,
      toColumn: r.toColumn ?? 'id',
    });
    setFound(prev => (prev ?? []).filter(x => x !== r));
  };

  const canAdd = fromColumn.trim() && toTable.trim() && toColumn.trim();
  const add = () => {
    if (!canAdd) return;
    addVirtualFk(connectionId, {
      fromTable: table,
      fromColumn: fromColumn.trim(),
      toTable: toTable.trim(),
      toColumn: toColumn.trim(),
    });
    setFromColumn('');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal vfk-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Virtual foreign keys — {table}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="vfk-body">
          {sessionId && engine && schema && (
            <div className="vfk-scan">
              <div className="vfk-scan-head">
                <button className="toolbar-btn" disabled={scanning} onClick={scan}>
                  {scanning ? 'Reading comments…' : '🔎 Find in column comments'}
                </button>
                <span className="vfk-scan-hint">
                  Most schemas declare their relations in a COMMENT
                  (<code>References orders.id</code>, <code>FK to orders(id)</code>, <code>-&gt; orders.id</code>)
                </span>
              </div>
              {scanNote && <div className="vfk-scan-note">{scanNote}</div>}
              {found && found.length > 0 && (
                <ul className="vfk-found">
                  {found.map((r, i) => (
                    <li key={i}>
                      <code>{r.fromTable}.{r.fromColumn} → {r.toTable}.{r.toColumn}</code>
                      <span className="vfk-evidence" title={r.evidence}>{r.evidence}</span>
                      <button className="toolbar-btn" onClick={() => accept(r)}>Add</button>
                    </li>
                  ))}
                </ul>
              )}
              {found && found.length === 0 && !scanning && (
                <div className="vfk-scan-note">Nothing new to add.</div>
              )}
            </div>
          )}
          <p className="vfk-hint">
            Local only — never written to the server. Declared relations feed JOIN
            completion, FK click-through in Result browsers, and the ER diagram (dashed).
          </p>

          {mine.length > 0 && (
            <div className="vfk-list">
              {mine.map(f => (
                <div key={f.id} className="vfk-row">
                  <code>{f.fromTable}.{f.fromColumn}</code>
                  <span className="vfk-arrow">→</span>
                  <code>{f.toTable}.{f.toColumn}</code>
                  <button className="filter-remove" title="Remove" onClick={() => removeVirtualFk(connectionId, f.id)}>×</button>
                </div>
              ))}
            </div>
          )}
          {mine.length === 0 && <div className="vfk-empty">No virtual FKs touch this table yet.</div>}

          {/* Relations declared before virtual FKs were scoped to a connection.
              Nothing recorded which server they were drawn against, so they
              cannot be attributed automatically — and applying them everywhere
              is exactly the problem scoping fixed. They affect nothing until
              adopted here. */}
          {legacy.length > 0 && (
            <div className="vfk-legacy">
              <div className="vfk-legacy-h">
                {legacy.length} relation{legacy.length === 1 ? '' : 's'} from before virtual FKs
                were tied to a connection
              </div>
              <p className="vfk-legacy-note">
                These used to apply to every server at once. There is no record of which one
                they were drawn against, so they are inactive until you attach them. Add the
                ones that belong to <b>this</b> connection.
              </p>
              {legacy.map(f => (
                <div key={f.id} className="vfk-row">
                  <code>{f.fromTable}.{f.fromColumn}</code>
                  <span className="vfk-arrow">→</span>
                  <code>{f.toTable}.{f.toColumn}</code>
                  <button
                    className="toolbar-btn"
                    onClick={() => adoptLegacyVirtualFk(connectionId, f.id)}
                  >Add here</button>
                  <button
                    className="filter-remove"
                    title="Discard"
                    onClick={() => discardLegacyVirtualFk(f.id)}
                  >×</button>
                </div>
              ))}
            </div>
          )}

          <div className="vfk-add">
            <input
              value={fromColumn} placeholder="column of this table (e.g. customer_id)"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              onChange={e => setFromColumn(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add(); }}
              autoFocus
            />
            <span className="vfk-arrow">→</span>
            <input
              value={toTable} placeholder="parent table (schema.table)"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              onChange={e => setToTable(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add(); }}
            />
            <input
              value={toColumn} placeholder="parent column" style={{ maxWidth: 120 }}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              onChange={e => setToColumn(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add(); }}
            />
            <button className="primary" disabled={!canAdd} onClick={add}>Add</button>
          </div>
        </div>

        <div className="modal-footer">
          <button className="toolbar-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
