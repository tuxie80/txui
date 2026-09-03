/**
 * Server variables & status browser.
 * MySQL: SHOW GLOBAL VARIABLES / STATUS · PG: pg_settings / pg_stat_database.
 * Search across all cells; PG variables can be
 * narrowed to changed-from-default only.
 *
 * MySQL/MariaDB variables are also editable: picking a row and setting a new
 * value GENERATES a review-only `SET GLOBAL` statement (plus a `[mysqld]`
 * persistence hint) and hands it to the editor via `dbgui:insert-sql` — it is
 * never executed here. See utils/serverVarEdit.ts.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import { FastGrid } from './FastGrid';
import type { SelRect } from './FastGrid';
import { CopyExportMenu } from './CopyExportMenu';
import { buildServerVarSql } from '../utils/serverVarEdit';
import { buildPgVarSql, buildPgVarResetSql } from '../utils/pgVarEdit';

interface Props {
  sessionId: string;
  engine: string;
  onClose: () => void;
}

type Kind = 'variables' | 'status';

export function ServerInfoPanel({ sessionId, engine, onClose }: Props) {
  const [kind, setKind] = useState<Kind>('variables');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  // Currently selected single row (index into the filtered `rows`), and the
  // variable being edited into a review-only SET GLOBAL statement.
  const [selRow, setSelRow] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null);

  const hasStatus = true;
  const isPg = engine === 'postgres';
  const isRedis = engine === 'redis';
  // MySQL/MariaDB both connect as the 'mysql' engine. Only their global
  // variables can be turned into a SET GLOBAL statement.
  const canEdit = (engine === 'mysql' || engine === 'postgres') && kind === 'variables';

  const load = useCallback(async (k: Kind) => {
    setLoading(true);
    try {
      const r = await invoke<QueryResult>('server_info', { sessionId, kind: k });
      setResult(r);
      setError(null);
    } catch (e) {
      setError(errorDisplay(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { load(kind); }, [load, kind]);

  const sourceCol = useMemo(
    () => result?.columns.findIndex(c => c.name === 'source') ?? -1,
    [result]
  );

  const rows = useMemo(() => {
    if (!result) return [];
    let out = result.rows;
    if (changedOnly && sourceCol >= 0) {
      out = out.filter(r => {
        const src = String(r[sourceCol] ?? '');
        return src !== 'default' && src !== 'client';
      });
    }
    const q = filter.trim().toLowerCase();
    if (q) {
      out = out.filter(r =>
        r.some(cell => cell !== null && String(cell).toLowerCase().includes(q))
      );
    }
    return out;
  }, [result, filter, changedOnly, sourceCol]);

  // SHOW GLOBAL VARIABLES yields `Variable_name` / `Value`; fall back to the
  // first two columns if a build ever renames them.
  const nameCol = useMemo(() => {
    const i = result?.columns.findIndex(c => c.name.toLowerCase() === 'variable_name') ?? -1;
    return i >= 0 ? i : 0;
  }, [result]);
  const valueCol = useMemo(() => {
    const i = result?.columns.findIndex(c => c.name.toLowerCase() === 'value') ?? -1;
    return i >= 0 ? i : 1;
  }, [result]);

  // MySQL 8.0+ (but not MariaDB) supports `SET PERSIST`, which survives a
  // restart with no my.cnf edit. The `version` variable is already in the grid,
  // so detecting this is free.
  const persistSupported = useMemo(() => {
    if (!canEdit || !result) return false;
    const row = result.rows.find(r => String(r[nameCol]).toLowerCase() === 'version');
    const v = row ? String(row[valueCol] ?? '').toLowerCase() : '';
    if (!v || v.includes('mariadb')) return false;
    return parseInt(v, 10) >= 8;
  }, [canEdit, result, nameCol, valueCol]);

  // Selecting a different view or reloading drops any half-finished edit.
  useEffect(() => { setEditing(null); setSelRow(null); }, [kind, result]);

  const openEditor = useCallback((rowIdx: number) => {
    const row = rows[rowIdx];
    if (!row) return;
    setEditing({ name: String(row[nameCol]), value: String(row[valueCol] ?? '') });
  }, [rows, nameCol, valueCol]);

  // Build the review-only statement and hand it to the active editor. Never run.
  const emitSet = useCallback(() => {
    if (!editing) return;
    const sql = isPg
      ? buildPgVarSql(editing.name, editing.value)
      : buildServerVarSql(editing.name, editing.value, { persist: persistSupported });
    window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));
    setEditing(null);
  }, [editing, persistSupported, isPg]);

  // PostgreSQL: reset a GUC back to its default (ALTER SYSTEM RESET).
  const emitReset = useCallback(() => {
    if (!editing) return;
    const sql = buildPgVarResetSql(editing.name);
    window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));
    setEditing(null);
  }, [editing]);

  const onSelectionChange = useCallback((sel: SelRect | null) => {
    setSelRow(sel && sel.r1 === sel.r2 ? sel.r1 : null);
  }, []);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">ⓘ Server</span>
        <div className="gsp-seg" style={{ width: 190 }}>
          <button
            className={kind === 'variables' ? 'active' : ''}
            onClick={() => setKind('variables')}
          >{isRedis ? 'Config' : 'Variables'}</button>
          {hasStatus && (
            <button
              className={kind === 'status' ? 'active' : ''}
              onClick={() => setKind('status')}
            >{isRedis ? 'INFO' : 'Status'}</button>
          )}
        </div>
        <input
          className="proc-filter"
          placeholder="Search…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        {isPg && kind === 'variables' && (
          <label className="gsp-check">
            <input
              type="checkbox"
              checked={changedOnly}
              onChange={e => setChangedOnly(e.target.checked)}
            /> changed only
          </label>
        )}
        {canEdit && (
          <button
            className="toolbar-btn"
            onClick={() => selRow != null && openEditor(selRow)}
            disabled={selRow == null}
            title={selRow == null ? 'Select a variable row to edit' : 'Generate a SET GLOBAL statement for the selected variable'}
          >✎ Set…</button>
        )}
        <button className="toolbar-btn" onClick={() => load(kind)} disabled={loading}>↻ Refresh</button>
        {result && (
          <CopyExportMenu
            getData={() => ({ columns: result.columns.map(c => c.name), rows })}
            tableName={`server_${kind}`}
            engine={engine}
          />
        )}
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {editing && (
        <div
          className="proc-toolbar"
          style={{ gap: 8, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}
        >
          <span className="proc-title" style={{ fontFamily: 'var(--font-mono)' }}>{isPg ? 'ALTER SYSTEM SET' : 'SET GLOBAL'} {editing.name} =</span>
          <input
            className="proc-filter"
            autoFocus
            style={{ flex: 1, minWidth: 160 }}
            value={editing.value}
            onChange={e => setEditing({ name: editing.name, value: e.target.value })}
            onKeyDown={e => {
              if (e.key === 'Enter') emitSet();
              else if (e.key === 'Escape') setEditing(null);
            }}
          />
          <button className="toolbar-btn" onClick={emitSet}>→ Insert into editor</button>
          {isPg && <button className="toolbar-btn" onClick={emitReset} title="Reset this setting to its default">Reset to default</button>}
          <button className="toolbar-btn" onClick={() => setEditing(null)}>Cancel</button>
          <span className="proc-status" style={{ padding: 0 }}>
            Generates a review-only statement (not executed){isPg ? ' · writes postgresql.auto.conf + pg_reload_conf(); restart-only GUCs still need a restart' : (persistSupported ? ' · SET PERSIST offered · persist under [mysqld]' : ' · persist under [mysqld]')}
          </span>
        </div>
      )}

      {result ? (
        <FastGrid
          columns={result.columns}
          rows={rows}
          onSelectionChange={canEdit ? onSelectionChange : undefined}
          onOpenCell={canEdit ? (r) => openEditor(r) : undefined}
        />
      ) : (
        !error && <div className="proc-loading">Loading…</div>
      )}

      <div className="proc-status">
        {result && `${rows.length.toLocaleString()}${filter || changedOnly ? ` / ${result.rows.length.toLocaleString()}` : ''} entries`}
      </div>
    </div>
  );
}
