/**
 * Audit log — immutable per-statement execution records, across every session
 * since the database was created (it is SQLite on disk, not memory, so it
 * outlives restarts and is the union of every connection ever opened).
 *
 * A row that says only *what* ran cannot answer the questions people bring to
 * an audit log, so each one also carries **where it came from**: which run,
 * which tab, which database, and whether a person typed it or a panel did it.
 * `run` in particular is what turns a ten-statement script from ten unrelated
 * rows into one run you can follow — `3/10` is the statement that failed.
 *
 * Search covers the SQL, the connection, the user, the error, the tab title,
 * the database and the source. Export via the menu.
 */
import { errorDisplay } from '../utils/appError';
import { failureCounts } from '../utils/audit';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ColumnInfo } from '../types';
import { FastGrid } from './FastGrid';
import { CopyExportMenu } from './CopyExportMenu';
import { GridSettingsPopover } from './GridSettingsPopover';
import { CellViewer } from './CellViewer';

interface AuditRow {
  id: number;
  run_id: string;
  stmt_index: number | null;
  stmt_total: number | null;
  session_id: string;
  tab_title: string;
  database: string;
  source: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  connection_name: string;
  db_user: string;
  engine: string;
  ok: boolean;
  rows_out: number;
  rows_affected: number | null;
  error: string | null;
  error_code: string;
  db_code: string;
  sqlstate: string;
  sql: string;
}

const COLUMNS: ColumnInfo[] = [
  { name: 'started_at',   type_name: 'TEXT', nullable: false },
  { name: 'ms',           type_name: 'BIGINT', nullable: false },
  { name: 'source',       type_name: 'TEXT', nullable: false },
  { name: 'connection',   type_name: 'TEXT', nullable: false },
  { name: 'database',     type_name: 'TEXT', nullable: false },
  { name: 'tab',          type_name: 'TEXT', nullable: false },
  // `3/10` — which statement of which run. Blank for a lone statement.
  { name: 'stmt',         type_name: 'TEXT', nullable: true },
  { name: 'user',         type_name: 'TEXT', nullable: false },
  { name: 'engine',       type_name: 'TEXT', nullable: false },
  { name: 'status',       type_name: 'TEXT', nullable: false },
  { name: 'rows',         type_name: 'BIGINT', nullable: false },
  { name: 'sql',          type_name: 'TEXT', nullable: false },
  { name: 'error',        type_name: 'TEXT', nullable: true },
  // The failure's stable class. `error` is the server's prose, which is what
  // you read; this is what you can group by.
  // The server's own number — 1146, 42P01 — which is what anyone searches
  // for. `error_class` next to it is TxUI's coarse bucket.
  { name: 'db_code',      type_name: 'TEXT', nullable: true },
  { name: 'sqlstate',     type_name: 'TEXT', nullable: true },
  { name: 'error_class',  type_name: 'TEXT', nullable: true },
  { name: 'ended_at',     type_name: 'TEXT', nullable: false },
  { name: 'run',          type_name: 'TEXT', nullable: false },
];

interface Props { onClose?: () => void }

export function AuditLogPanel({ onClose }: Props) {
  const [entries, setEntries] = useState<AuditRow[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ column: string; value: unknown } | null>(null);

  const load = useCallback((q?: string) => {
    invoke<AuditRow[]>('audit_list', { search: q ?? null, limit: 1000 })
      .then(setEntries)
      .catch(e => setError(errorDisplay(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  // debounce the search
  useEffect(() => {
    const t = setTimeout(() => load(search || undefined), 300);
    return () => clearTimeout(t);
  }, [search, load]);

  const rows = useMemo<unknown[][]>(() => entries.map(e => [
    e.started_at,
    e.duration_ms,
    e.source,
    e.connection_name,
    e.database,
    e.tab_title,
    // Only meaningful for a multi-statement run; a lone statement leaves it
    // blank rather than showing a misleading 1/1.
    e.stmt_index && e.stmt_total && e.stmt_total > 1 ? `${e.stmt_index}/${e.stmt_total}` : '',
    e.db_user,
    e.engine,
    e.ok ? 'OK' : 'FAILED',
    e.rows_affected ?? e.rows_out,
    e.sql,
    e.error,
    e.db_code || '',
    e.sqlstate || '',
    e.error_code || '',
    e.ended_at,
    e.run_id,
  ]), [entries]);

  // Counted over the rows on screen, so it always describes what is being
  // looked at rather than the whole table.
  const failures = useMemo(() => failureCounts(entries), [entries]);

  return (
    <div className="proc-panel" style={{ position: 'relative', inset: 'auto', height: '100%' }}>
      <div className="proc-toolbar">
        <span className="proc-title">📜 Audit log</span>
        <input
          className="proc-filter"
          placeholder="Search SQL / connection / user / tab / database / source / error / code (1146)…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button className="toolbar-btn" onClick={() => load(search || undefined)}>↻ Refresh</button>
        <CopyExportMenu
          getData={() => ({ columns: COLUMNS.map(c => c.name), rows })}
          tableName="audit_log"
        />
        <GridSettingsPopover />
        <div style={{ flex: 1 }} />
        {failures.length > 0 && (
          // What the log could not answer before it carried a class: which
          // kind of failure is actually happening, and how often.
          <span className="dv-desc" title="Failures in the rows shown, by class">
            {failures.map(f => `${f.code.replace(/_/g, ' ')} ×${f.count}`).join(' · ')}
          </span>
        )}
        <span className="dv-desc">one immutable row per executed statement</span>
        {onClose && <button className="icon-btn" title="Close" onClick={onClose}>×</button>}
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <FastGrid
        columns={COLUMNS}
        rows={rows}
        onOpenCell={(r, c) => setViewer({ column: COLUMNS[c].name, value: rows[r][c] })}
      />

      <div className="proc-status">
        {entries.length.toLocaleString()} entries{entries.length === 1000 ? ' (showing latest 1000)' : ''}
      </div>

      {viewer && (
        <CellViewer column={viewer.column} value={viewer.value} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}
