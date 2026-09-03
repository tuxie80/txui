/**
 * Data browser — fetches pages of table rows with filter/sort.
 * READ-ONLY: viewing, filtering, sorting, copy/export and the cell viewer only.
 * Inline cell-editing and the commit flow were removed by design — data can
 * never be mutated through the grid (there is no write command behind it).
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { QueryResult } from '../types';
import type { FilterClause, SortClause, TableMeta } from '../types/browser';
import { FilterBar } from './FilterBar';
import { FastGrid } from './FastGrid';
import type { FastGridApi, SelRect } from './FastGrid';
import type { RowChange } from '../types/browser';
import { buildEditSql, assembleEditSql, insertTemplate, editCount, type EditSet } from '../utils/gridEdits';
import { CopyExportMenu } from './CopyExportMenu';
import { GridSettingsPopover } from './GridSettingsPopover';
import { GraphicsView } from './GraphicsView';
import { CellViewer } from './CellViewer';
import { ColumnFilterPopover } from './ColumnFilterPopover';
import { cellText } from '../utils/exporters';
import { virtualFksFor } from '../store/virtualFks';
import type { ColumnFilter, TopValue } from '../utils/columnFilter';
import { addLog } from '../store/logStore';
import { isoNow, logAudit, newRunId } from '../utils/audit';
import { fmtDuration } from '../utils/fmtDuration';
import {
  BROWSE_LIMIT_DEFAULT, BROWSE_LIMIT_CHOICES, defaultBrowseSort, browseSqlText,
  duckdbBrowseTarget,
} from '../utils/browseSql';

/** Funnel filter → server-side WHERE clause. */
function toClause(f: ColumnFilter): FilterClause {
  if (f.isNull) return { column: f.column, op: 'is_null', value: null };
  if (f.exact)  return { column: f.column, op: 'eq', value: f.text };
  return { column: f.column, op: 'like', value: `%${f.text}%` };
}

interface Props {
  sessionId:    string;
  table:        string;   // "schema.table" or "table"
  engine:       string;
  /** Audit attribution — a browse row must say WHICH server it read. */
  connectionName: string;
  /** Scopes virtual FKs: a relation declared on staging is not one here. */
  connectionId: string;
  dbUser:         string;
  resultLabel?: string;   // "Result N" — shown small; the table name isn't repeated big
  onClose:      () => void;
  onFkNavigate: (fkTable: string, fkColumn: string, value: unknown) => void;
  /** Session transaction state + controls, so edit mode can arm/commit one
   *  through the SAME state machine the tab's ⛁ TX buttons use. */
  txOpen?: boolean;
  onBeginTx?: () => Promise<void> | void;
  onEndTx?: (cmd: 'commit_transaction' | 'rollback_transaction') => Promise<void> | void;
}

const PAGE = 100;   // rows per fetch; the row cap (default 100) is user-raisable below

/** The schema half of a "schema.table", for the audit row's database column. */
const dbOf = (t: string) => (t.includes('.') ? t.slice(0, t.indexOf('.')) : '');

export function DataBrowser({
  sessionId, table, engine, connectionName, connectionId, dbUser, resultLabel, onClose, onFkNavigate,
  txOpen, onBeginTx, onEndTx,
}: Props) {
  const [meta, setMeta]     = useState<TableMeta | null>(null);
  const [rows, setRows]     = useState<unknown[][]>([]);
  const [cols, setCols]     = useState<QueryResult['columns']>([]);
  const [loadedAll, setLoadedAll] = useState(false);
  const [filters, setFilters] = useState<FilterClause[]>([]);
  const [colFilters, setColFilters] = useState<ColumnFilter[]>([]);
  const [filterPop, setFilterPop] = useState<{ column: string; anchor: { x: number; y: number } } | null>(null);
  const [popTop, setPopTop] = useState<TopValue[]>([]);
  const [popLoading, setPopLoading] = useState(false);
  // null = untouched → default sort (first PK column DESC = latest rows first)
  const [userSort, setUserSort] = useState<SortClause[] | null>(null);
  // Hard row cap: strict LIMIT 100 by default, raisable from the status bar.
  const [limit, setLimit]     = useState(BROWSE_LIMIT_DEFAULT);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ column: string; value: unknown } | null>(null);
  const [showGraphics, setShowGraphics] = useState(false);
  const fetchSeq = useRef(0);
  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const apiRef = useRef<FastGridApi | null>(null);

  // ── Staged edit mode (review-only) ───────────────────────────────────────
  // The browser stays read-only: edits are collected here and highlighted, but
  // NOTHING is written. "Generate SQL" emits a transaction into the editor for
  // the user to review and run themselves — the only thing that changes data.
  const [editMode, setEditMode] = useState(false);
  // Existing-row updates and deletes, keyed by JSON.stringify(primary key).
  const [updates, setUpdates] = useState<Map<string, { pk: Record<string, unknown>; set: Record<string, unknown> }>>(new Map());
  const [deletes, setDeletes] = useState<Map<string, Record<string, unknown>>>(new Map());
  const [sel, setSel] = useState<SelRect | null>(null);

  // Editing needs three things, and SQL Server has all of them: a primary key
  // to build a keyed WHERE from, a transaction to arm so the edits are
  // reversible, and a DML builder for the dialect. `gridEdits` was already
  // parameterised — it emits bracket-quoted T-SQL correctly — so the engine
  // list was the only thing keeping the grid read-only there.
  const canEdit = !!meta && meta.pk_columns.length > 0
    && (engine === 'mysql' || engine === 'postgres' || engine === 'sqlserver');
  // DuckDB: the tree's three-level "db.schema.table" addresses get_table_meta
  // fine, but the SELECT builder splits a dotted name once — so browse and
  // value-count calls go out with the catalog segment stripped (the current
  // catalog resolves it). See duckdbBrowseTarget.
  const browseTarget = engine === 'duckdb' ? duckdbBrowseTarget(table) : table;
  const colIdx = useCallback((name: string) => cols.findIndex(c => c.name === name), [cols]);
  const pkOfRow = useCallback((row: unknown[]): Record<string, unknown> =>
    Object.fromEntries((meta?.pk_columns ?? []).map(c => [c, row[colIdx(c)]])), [meta, colIdx]);

  const onCellEdit = useCallback((change: RowChange) => {
    const key = JSON.stringify(change.pk_values);
    setUpdates(m => {
      const n = new Map(m);
      const e = n.get(key) ?? { pk: change.pk_values, set: {} };
      n.set(key, { pk: change.pk_values, set: { ...e.set, [change.column]: change.new_value } });
      return n;
    });
  }, []);

  // Rows with staged edits applied, so the grid shows the new values.
  const displayRows = useMemo(() => {
    if (updates.size === 0 || !meta) return rows;
    return rows.map(row => {
      const u = updates.get(JSON.stringify(pkOfRow(row)));
      if (!u) return row;
      const clone = [...row];
      for (const [col, val] of Object.entries(u.set)) { const i = colIdx(col); if (i >= 0) clone[i] = val; }
      return clone;
    });
  }, [rows, updates, meta, pkOfRow, colIdx]);

  const pendingKeys = useMemo(() => {
    const s = new Set<string>();
    for (const [key, u] of updates) for (const col of Object.keys(u.set)) s.add(`${key}|${col}`);
    return s;
  }, [updates]);

  const rowClass = useCallback((r: number) => {
    const row = displayRows[r];
    return row && deletes.has(JSON.stringify(pkOfRow(row))) ? 'db-row-deleted' : '';
  }, [displayRows, deletes, pkOfRow]);

  const markSelectedDeleted = useCallback(() => {
    if (!sel || !meta) return;
    setDeletes(m => {
      const n = new Map(m);
      for (let r = Math.min(sel.r1, sel.r2); r <= Math.max(sel.r1, sel.r2); r++) {
        const row = displayRows[r]; if (!row) continue;
        const pk = pkOfRow(row); n.set(JSON.stringify(pk), pk);
      }
      return n;
    });
  }, [sel, meta, displayRows, pkOfRow]);

  const stagedCount = editCount({ updates: [...updates.values()], inserts: [], deletes: [...deletes.values()] });

  // Staged edits never outlive the data they target: DataBrowser is keyed by
  // session+table at the render site, so it remounts (clean state) on any
  // change — no manual reset needed here.
  const discardEdits = useCallback(() => { setUpdates(new Map()); setDeletes(new Map()); }, []);
  // True when *we* opened the transaction on entering edit mode.
  const [armedByUs, setArmedByUs] = useState(false);

  const emitSql = (sql: string) =>
    window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));

  const generateEditSql = useCallback(async () => {
    if (!meta) return;
    const set: EditSet = {
      table,
      pkColumns: meta.pk_columns,
      types: Object.fromEntries(meta.columns.map(c => [c.name, c.type_name])),
      updates: [...updates.values()],
      inserts: [],
      deletes: [...deletes.values()],
    };
    try {
      // Whether the emitted SQL behaves as a reviewable transaction or as an
      // immediate write depends on the session's mode — so ask, and let the
      // header say the truth. (A pinned connection = autocommit-off or ⛁ TX.)
      const tx = await invoke<{ held: boolean }>('tx_status', { sessionId }).catch(() => ({ held: false }));
      const block = assembleEditSql(buildEditSql(set, engine), tx.held);
      if (block) emitSql(block);
    } catch (e) { setError(errorDisplay(e)); }
  }, [meta, table, updates, deletes, engine, sessionId]);

  const emitInsertTemplate = useCallback(() => {
    if (!meta) return;
    emitSql(insertTemplate(table, meta.columns.map(c => ({ name: c.name, type: c.type_name })), engine));
  }, [meta, table, engine]);

  // Load metadata on mount. The component is keyed by session+table at the
  // render site, so it remounts (fresh state) whenever either changes — no
  // synchronous reset needed here.
  useEffect(() => {
    invoke<TableMeta>('get_table_meta', { sessionId, parent: table })
      .then(m => {
        // Virtual FKs: user-declared relations behave like real ones — the
        // column gets 🔗 + click-through navigation. Real constraints win.
        const virt = virtualFksFor(connectionId, table).filter(v => v.fromTable.toLowerCase() === table.toLowerCase());
        if (virt.length) {
          m = { ...m, columns: m.columns.map(c => {
            const v = virt.find(x => x.fromColumn === c.name);
            return v && !c.fk_table ? { ...c, fk_table: v.toTable, fk_column: v.toColumn } : c;
          }) };
        }
        setMeta(m);
      })
      .catch(e => setError(errorDisplay(e)));
  }, [sessionId, table, connectionId]);

  // Effective server-side filters = FilterBar clauses + per-column funnel filters
  const effFilters = useMemo(
    () => [...filters, ...colFilters.map(toClause)],
    [filters, colFilters]
  );

  // Effective sort: the user's header pick; untouched → first PK column DESC,
  // so a double-clicked table opens with the LATEST rows (no PK → no ORDER BY).
  const effSort = useMemo<SortClause[]>(
    () => userSort ?? (meta ? defaultBrowseSort(meta.pk_columns) : []),
    [userSort, meta]
  );

  /**
   * One page fetch — the only browse_table call site. Logs exactly like the
   * query runner: the executed SELECT (`> …`), then the canonical result
   * line with execution/fetch timing (or the error line).
   */
  const fetchPage = useCallback((fetchLimit: number, offset: number, append: boolean) => {
    const seq = ++fetchSeq.current;
    loadingRef.current = true;
    setLoading(true);
    // Predicted here only so the `> …` line appears BEFORE the round-trip; the
    // reply carries the statement that actually ran and replaces it. The two
    // genuinely differ — PostgreSQL casts the bound parameter
    // (`"id" = $1::bigint`) so the column stays indexable, and the browser
    // binds every value rather than inlining it. A log that only ever showed
    // this prediction was a log that could be wrong about production.
    const predicted = browseSqlText({ table: browseTarget, filters: effFilters, sort: effSort, limit: fetchLimit, offset, engine });
    addLog(sessionId, { level: 'info', action: 'BROWSE', detail: predicted, line: `> ${predicted}` });
    const startedAt = isoNow();
    const runId = newRunId();
    const t0 = performance.now();
    invoke<QueryResult & { executed_sql?: string }>('browse_table', {
      params: { session_id: sessionId, table: browseTarget, filters: effFilters, sort: effSort, limit: fetchLimit, offset },
    })
      .then(r => {
        if (seq !== fetchSeq.current) return;
        const execMs = Math.round(r.execution_ms);
        const fetchMs = Math.round(r.fetch_ms ?? 0);
        const n = r.rows.length;
        const sqlText = r.executed_sql || predicted;
        if (r.executed_sql && r.executed_sql !== predicted) {
          // Show what ran, not what was guessed.
          addLog(sessionId, { level: 'info', action: 'BROWSE', detail: sqlText,
            line: `> ${sqlText}` });
        }
        // Browsing is a real read against a real server — on production it is
        // exactly what an audit is later asked about. It never reached the
        // audit log before, so "who looked at this table" had no answer.
        logAudit({
          run_id: runId, source: 'browser',
          session_id: sessionId, tab_title: `Browse ${table}`, database: dbOf(table),
          started_at: startedAt, ended_at: isoNow(),
          duration_ms: Math.round(performance.now() - t0),
          connection_name: connectionName, db_user: dbUser, engine,
          ok: true, rows_out: n, rows_affected: null, error: null, sql: sqlText,
        }, { alsoLog: false });
        addLog(sessionId, { level: 'ok', action: 'BROWSE', detail: sqlText,
          rows: n, execMs, fetchMs,
          line: `${n} row${n === 1 ? '' : 's'} retrieved in ${fmtDuration(execMs + fetchMs)} (execution: ${fmtDuration(execMs)}, fetching: ${fmtDuration(fetchMs)})` });
        // Column shape is stable across pages of one browse (same SELECT, only
        // LIMIT/OFFSET change), so skip setCols when appending: a fresh array
        // identity would reset FastGrid's selection/width state and re-run the
        // width-measure memo, re-rendering every visible row per page.
        if (!append) setCols(r.columns);
        setRows(prev => append ? [...prev, ...r.rows] : r.rows);
        offsetRef.current = offset + n;
        if (n < fetchLimit || offsetRef.current >= limit) setLoadedAll(true);
        setError(null);
      })
      .catch(e => {
        if (seq !== fetchSeq.current) return;
        const ms = Math.round(performance.now() - t0);
        logAudit({
          run_id: runId, source: 'browser',
          session_id: sessionId, tab_title: `Browse ${table}`, database: dbOf(table),
          started_at: startedAt, ended_at: isoNow(), duration_ms: ms,
          connection_name: connectionName, db_user: dbUser, engine,
          ok: false, rows_out: 0, rows_affected: null, error: errorDisplay(e),
          // The display text has the number folded in for a reader; the raw
          // rejection is what the stored db_code/sqlstate are read from.
          raw_error: e, sql: predicted,
        }, { alsoLog: false });
        addLog(sessionId, { level: 'err', action: 'BROWSE', detail: errorDisplay(e), ms,
          line: `! ${errorDisplay(e).replace(/\s+/g, ' ').trim()} (after ${fmtDuration(ms)})` });
        setError(errorDisplay(e));
      })
      .finally(() => { if (seq === fetchSeq.current) { loadingRef.current = false; setLoading(false); } });
  }, [sessionId, table, browseTarget, engine, effFilters, effSort, limit, connectionName, dbUser]);

  // Load the next page and APPEND — until the row cap (`limit`) is reached.
  const loadMore = useCallback(() => {
    if (!meta || loadingRef.current || loadedAll) return;
    const fetchLimit = Math.min(PAGE, limit - offsetRef.current);
    if (fetchLimit <= 0) { setLoadedAll(true); return; }
    fetchPage(fetchLimit, offsetRef.current, true);
  }, [meta, loadedAll, limit, fetchPage]);

  // Re-read page 1 from the server — used after a commit so the grid shows the
  // now-persisted rows rather than the optimistic display.
  const reloadFirstPage = useCallback(() => {
    if (!meta) return;
    offsetRef.current = 0;
    setRows([]); setLoadedAll(false);
    fetchPage(Math.min(PAGE, limit), 0, false);
  }, [meta, limit, fetchPage]);

  // ── Edit-mode transaction control (defined here so it can use reloadFirstPage) ──
  const enterEditMode = useCallback(async () => {
    setEditMode(true);
    // Arm a transaction so edits are reviewable and reversible — only a BEGIN,
    // no data written. If the session already has one open, ride it.
    if (canEdit && !txOpen && onBeginTx) {
      try { await onBeginTx(); setArmedByUs(true); } catch { /* stay in autocommit */ }
    }
  }, [canEdit, txOpen, onBeginTx]);

  const finishTx = useCallback(async (commit: boolean) => {
    if (onEndTx) await onEndTx(commit ? 'commit_transaction' : 'rollback_transaction');
    setArmedByUs(false);
    discardEdits();
    if (commit) reloadFirstPage();   // show the persisted rows
  }, [onEndTx, discardEdits, reloadFirstPage]);

  const leaveEditMode = useCallback(async () => {
    // Left without committing: undo our own arming so no transaction is pinned.
    if (armedByUs && txOpen && onEndTx) { try { await onEndTx('rollback_transaction'); } catch { /* ignore */ } }
    setArmedByUs(false);
    discardEdits();
    setEditMode(false);
  }, [armedByUs, txOpen, onEndTx, discardEdits]);

  // Reset the accumulation when the query params change, then load page 1.
  useEffect(() => {
    if (!meta) return;
    offsetRef.current = 0;
    /* eslint-disable react-hooks/set-state-in-effect */
    setRows([]); setCols([]); setLoadedAll(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchPage(Math.min(PAGE, limit), 0, false);
  }, [meta, limit, fetchPage]);

  const handleFilterChange = useCallback((f: FilterClause[], s: SortClause[]) => {
    setFilters(f);
    setUserSort(s);
  }, []);

  // Funnel click: open the popover and fetch the column's top-5 value counts
  // from the SERVER (whole table, faceted by the other columns' filters).
  const handleFilterCol = useCallback((column: string, anchor: { x: number; y: number }) => {
    setFilterPop(prev => {
      if (prev?.column === column) return null;
      const others = [
        ...filters.filter(f => f.column !== column),
        ...colFilters.filter(f => f.column !== column).map(toClause),
      ];
      setPopTop([]);
      setPopLoading(true);
      invoke<QueryResult>('column_value_counts', {
        sessionId, table: browseTarget, column, filters: others, limit: 5,
      })
        .then(r => setPopTop(r.rows.map(row => ({
          text: cellText(row[0]),
          count: Number(row[1]),
          isNull: row[0] === null || row[0] === undefined,
        }))))
        .catch(() => setPopTop([]))
        .finally(() => setPopLoading(false));
      return { column, anchor };
    });
  }, [sessionId, browseTarget, filters, colFilters]);

  const applyColFilter = useCallback((column: string, f: ColumnFilter | null) => {
    setColFilters(prev => {
      const rest = prev.filter(x => x.column !== column);
      return f ? [...rest, f] : rest;
    });
    setFilterPop(null);
  }, []);

  const filteredCols = useMemo(() => new Set(colFilters.map(f => f.column)), [colFilters]);

  const handleSortCol = useCallback((col: string) => {
    setUserSort(prev => {
      // First explicit header click starts from the effective (default) sort.
      const cur = prev ?? (meta ? defaultBrowseSort(meta.pk_columns) : []);
      const existing = cur.find(s => s.column === col);
      if (!existing) return [{ column: col, direction: 'asc' }];
      if (existing.direction === 'asc') return [{ column: col, direction: 'desc' }];
      return cur.filter(s => s.column !== col);
    });
  }, [meta]);

  const totalRows  = meta?.total_rows ?? null;
  const tableLabel = table.split('.').pop() ?? table;
  const isRedis    = engine === 'redis';

  // PostgreSQL: export the whole table via native COPY TO STDOUT (streamed on
  // the backend), the fast path for a full-table dump.
  const copyExportPg = useCallback(async () => {
    try {
      const path = await saveDialog({
        defaultPath: `${tableLabel}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'TSV', extensions: ['tsv'] }],
      });
      if (!path) return;
      const fmt = path.endsWith('.tsv') ? 'tsv' : 'csv';
      const bytes = await invoke<number>('pg_copy_export',
        { sessionId, source: table, outPath: path, format: fmt, header: true });
      setError(`COPY exported ${bytes.toLocaleString()} bytes → ${path}`);
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [sessionId, table, tableLabel]);

  // Parquet: stream the whole file to disk on the backend (no in-memory / IPC
  // round-trip), so a file too big to page through can still be exported.
  const exportParquetFile = useCallback(async () => {
    try {
      const path = await saveDialog({
        defaultPath: `${tableLabel}.csv`,
        filters: [
          { name: 'CSV', extensions: ['csv'] },
          { name: 'TSV', extensions: ['tsv'] },
          { name: 'JSON (ndjson)', extensions: ['json', 'ndjson'] },
        ],
      });
      if (!path) return;
      const fmt = path.endsWith('.tsv') ? 'tsv'
        : (path.endsWith('.json') || path.endsWith('.ndjson')) ? 'json' : 'csv';
      const rows = await invoke<number>('export_parquet_file', { sessionId, outPath: path, format: fmt });
      setError(`Exported ${rows.toLocaleString()} rows → ${path}`);
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [sessionId, tableLabel]);
  // The cap cut the result short (vs "all rows loaded") — tell the user how to raise it.
  const capped = loadedAll && totalRows !== null && rows.length < totalRows;

  if (isRedis) {
    return (
      <div className="data-browser">
        <div className="db-toolbar">
          <span className="db-title">{tableLabel}</span>
          <button className="db-close" onClick={onClose}>✕ Close browser</button>
        </div>
        <div className="db-error">Data browser is not available for Redis.</div>
      </div>
    );
  }

  return (
    <div className="data-browser">
      {/* One compact toolbar line: table · read-only · rows · Filter/Sort · actions */}
      <div className="db-toolbar db-toolbar-compact">
        <span className="db-title-sm" title={table}>
          {resultLabel && <span className="db-result-label">{resultLabel}</span>}
          ▦ {tableLabel}
          <span className="db-readonly-badge" title="The data browser is read-only">read-only</span>
          {totalRows !== null && <span className="db-row-count">{totalRows.toLocaleString()} rows</span>}
        </span>
        {meta && (
          <FilterBar inline columns={meta.columns} filters={filters} sort={effSort} onChange={handleFilterChange} />
        )}
        {colFilters.length > 0 && (
          <button className="toolbar-btn" title="Remove all column filters"
            onClick={() => { setColFilters([]); setFilterPop(null); }}>
            ✕ {colFilters.length} filter{colFilters.length > 1 ? 's' : ''}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <div className="db-toolbar-right">
          {engine === 'parquet' && (
            <button className="toolbar-btn"
              data-tip="Stream the entire Parquet file to CSV/TSV/JSON — reads it a row group at a time, so a file too big to page through can still be exported."
              onClick={() => void exportParquetFile()}>⭳ Export file</button>
          )}
          {engine === 'postgres' && (
            <button className="toolbar-btn"
              data-tip="Export the whole table with PostgreSQL's native COPY TO — streamed on the backend, far faster than a row-by-row dump."
              onClick={() => void copyExportPg()}>⭳ COPY export</button>
          )}
          {canEdit && !editMode && (
            <button className="toolbar-btn"
              data-tip="Edit cells / delete rows. Opens a transaction so changes are reviewable — Commit to keep, Rollback to undo."
              onClick={enterEditMode}>✎ Edit</button>
          )}
          {editMode && (
            <>
              <span className={`db-staged ${stagedCount ? 'db-staged-on' : ''}`}
                title={txOpen
                  ? 'A transaction is open — run the generated SQL, then Commit to keep or Rollback to undo.'
                  : 'Autocommit is on — the generated statements commit immediately when run.'}>
                {txOpen ? '⛁ ' : '⚠ '}
                {stagedCount
                  ? `${stagedCount} staged change${stagedCount === 1 ? '' : 's'}`
                  : (txOpen ? 'Editing in a transaction' : 'Edit mode — autocommit')}
              </span>
              <button className="toolbar-btn" data-tip="Mark the selected row(s) for deletion"
                disabled={!sel} onClick={markSelectedDeleted}>🗑 Delete rows</button>
              <button className="toolbar-btn" data-tip="Insert a blank INSERT skeleton into the editor to fill in"
                onClick={emitInsertTemplate}>＋ Insert row</button>
              <button className="toolbar-btn" data-tip="Emit the UPDATE/DELETE for review into the editor — run it to apply"
                disabled={!stagedCount} onClick={generateEditSql}>⟳ Generate SQL</button>
              {txOpen ? (
                <>
                  <button className="toolbar-btn td-danger" data-tip="Commit the open transaction — make the changes permanent"
                    onClick={() => void finishTx(true)}>✔ Commit</button>
                  <button className="toolbar-btn" data-tip="Roll back the open transaction — undo everything since it opened"
                    onClick={() => void finishTx(false)}>✖ Rollback</button>
                </>
              ) : (
                <button className="toolbar-btn" data-tip="Discard all staged edits"
                  disabled={!stagedCount} onClick={discardEdits}>Discard</button>
              )}
              <button className="toolbar-btn" data-tip="Leave edit mode (rolls back an uncommitted transaction it opened)"
                onClick={() => void leaveEditMode()}>Done</button>
            </>
          )}
          {cols.length > 0 && (
            <button className={`toolbar-btn ${showGraphics ? 'active' : ''}`}
              data-tip="Visualise these rows — a map (coordinates) or a chart"
              onClick={() => setShowGraphics(v => !v)}>📈 Graphics</button>
          )}
          {cols.length > 0 && (
            <CopyExportMenu
              getData={() => apiRef.current?.getSelectionData() ?? { columns: cols.map(c => c.name), rows }}
              tableName={tableLabel}
              engine={engine}
            />
          )}
          <GridSettingsPopover />
          <button className="db-close" onClick={onClose} title="Close result">✕</button>
        </div>
      </div>

      {/* Status / error */}
      {error && <div className="db-error">{error}</div>}

      {/* Graphics over the browsed rows — the double-clicked-table equivalent
          of the query result's Graphics tab. */}
      {showGraphics && cols.length > 0 && (
        <div className="db-grid-wrap">
          <GraphicsView
            columns={cols}
            rows={rows}
            onSelectRow={row => apiRef.current?.selectRow(row)}
          />
        </div>
      )}

      {/* Grid area — paged 100 rows at a time, up to the Limit cap below */}
      <div className="db-grid-wrap" style={showGraphics ? { display: 'none' } : undefined}>
        {loading && rows.length === 0 && <div className="db-loading">Loading…</div>}
        {cols.length > 0 && meta && (
          <FastGrid
            columns={cols}
            rows={displayRows}
            meta={meta.columns}
            pkColumns={meta.pk_columns}
            sort={effSort}
            onSortCol={handleSortCol}
            onFilterCol={handleFilterCol}
            filteredCols={filteredCols}
            onFkClick={onFkNavigate}
            onNearBottom={loadMore}
            onOpenCell={(r, c) => setViewer({
              column: cols[c].name,
              value: displayRows[r]?.[c],
            })}
            apiRef={apiRef}
            {...(editMode ? {
              onEdit: onCellEdit,
              pendingKeys,
              rowClass,
              onSelectionChange: setSel,
            } : {})}
          />
        )}
      </div>

      {filterPop && (
        <ColumnFilterPopover
          column={filterPop.column}
          top={popTop}
          loading={popLoading}
          current={colFilters.find(f => f.column === filterPop.column) ?? null}
          anchor={filterPop.anchor}
          onApply={f => applyColFilter(filterPop.column, f)}
          onClose={() => setFilterPop(null)}
        />
      )}

      {viewer && (
        <CellViewer
          column={viewer.column}
          value={viewer.value}
          onClose={() => setViewer(null)}
        />
      )}

      {/* Row-count / load status + row cap (strict LIMIT 100 by default) */}
      <div className="db-pagination">
        <span className="db-page-info">
          {rows.length > 0
            ? `Loaded ${rows.length.toLocaleString()}${totalRows !== null ? ` of ${totalRows.toLocaleString()}` : ''} rows`
              + (capped ? ' · capped — raise the limit for more'
                : loadedAll ? ' · all'
                : loading ? ' · loading more…' : ' · scroll for more')
            : loading ? 'Loading…' : 'No rows'}
        </span>
        <label className="db-limit" title="Hard row cap for this browse — the SELECT's LIMIT">
          Limit
          <select
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
          >
            {BROWSE_LIMIT_CHOICES.map(n => (
              <option key={n} value={n}>{n.toLocaleString()}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
