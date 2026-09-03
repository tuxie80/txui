/**
 * Query-result surface: FastGrid + toolbar.
 * - Client-side sort (header click: asc → desc → off) — results are already
 *   in memory, sorting never re-runs the query.
 * - Selection-aware copy/export in 6 formats, header always included.
 * - Live aggregates (count/sum/avg/min/max) for the selection.
 * - Cell viewer on double-click / Shift+Enter.
 * - Per-column stacking filters (header funnel): free text (contains) or
 *   a top-5 value pick (exact) — all client-side, query never re-runs.
 */
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import type { QueryResult } from '../types';
import type { SortClause } from '../types/browser';
import { FastGrid } from './FastGrid';
import { cellSortKey, compareCellKeys } from '../utils/sortValue';
import type { FastGridApi, SelRect } from './FastGrid';
import { CopyExportMenu } from './CopyExportMenu';
import { GridSettingsPopover } from './GridSettingsPopover';
import { CellViewer } from './CellViewer';
import { RecordView } from './RecordView';
import { ColumnFilterPopover } from './ColumnFilterPopover';
import { ResultChart } from './ResultChart';
import { ResultPivot } from './ResultPivot';
import { matchesFilter, topValueCounts } from '../utils/columnFilter';
import type { ColumnFilter } from '../utils/columnFilter';

interface Props {
  /**
   * Receives the grid's API, for callers that drive the grid from outside it
   * (the 🗺 Map selecting the row a point came from). Mirrored out in an
   * effect: FastGrid assigns its own ref in a child effect, which React runs
   * before this parent one, so the value is there by the time it is copied.
   */
  apiOutRef?: React.MutableRefObject<FastGridApi | null>;
  result: QueryResult;
  /** Dialect for the INSERT export — the active connection's engine. */
  engine?: string;
}

interface Aggregates { count: number; sum: number | null; avg: number | null; min: number | null; max: number | null }

const MAX_AGG_CELLS = 2_000_000; // beyond this only count is shown — keeps selection instant

function computeAggregates(rows: unknown[][], sel: SelRect): Aggregates {
  const cells = (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1);
  let count = 0, sum = 0, numeric = 0;
  let min: number | null = null, max: number | null = null;
  if (cells > MAX_AGG_CELLS) {
    return { count: cells, sum: null, avg: null, min: null, max: null };
  }
  for (let r = sel.r1; r <= Math.min(sel.r2, rows.length - 1); r++) {
    for (let c = sel.c1; c <= sel.c2; c++) {
      const v = rows[r][c];
      if (v === null || v === undefined) continue;
      count++;
      const n = typeof v === 'number' ? v : NaN;
      if (!Number.isNaN(n)) {
        numeric++;
        sum += n;
        if (min === null || n < min) min = n;
        if (max === null || n > max) max = n;
      }
    }
  }
  return numeric > 0
    ? { count, sum, avg: sum / numeric, min, max }
    : { count, sum: null, avg: null, min: null, max: null };
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function ResultGrid({ result, engine, apiOutRef }: Props) {
  const [sort, setSort] = useState<SortClause[]>([]);
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [filterPop, setFilterPop] = useState<{ column: string; anchor: { x: number; y: number } } | null>(null);
  const [agg, setAgg] = useState<Aggregates | null>(null);
  const [hasSel, setHasSel] = useState(false);
  const [viewer, setViewer] = useState<{ column: string; value: unknown } | null>(null);
  const [recordRow, setRecordRow] = useState<number | null>(null);
  const [showRecord, setShowRecord] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [showPivot, setShowPivot] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const apiRef = useRef<FastGridApi | null>(null);
  useEffect(() => {
    if (apiOutRef) apiOutRef.current = apiRef.current;
  });
  const flashTimer = useRef(0);

  const note = useCallback((msg: string) => {
    setFlash(msg);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2500);
  }, []);

  // Stacked column filters — each narrows the rows the others already left
  const filteredRows = useMemo(() => {
    if (filters.length === 0) return result.rows;
    const idx = filters
      .map(f => ({ f, ci: result.columns.findIndex(c => c.name === f.column) }))
      .filter(x => x.ci >= 0);
    return result.rows.filter(row => idx.every(({ f, ci }) => matchesFilter(row[ci], f)));
  }, [result, filters]);

  // Client-side sort — comparator over row references, original array untouched
  const sortedRows = useMemo(() => {
    if (sort.length === 0) return filteredRows;
    const s = sort[0];
    const ci = result.columns.findIndex(c => c.name === s.column);
    if (ci < 0) return filteredRows;
    const dir = s.direction === 'asc' ? 1 : -1;
    // Schwartzian transform: compute each cell's sort key once instead of
    // re-parsing it O(log n) times inside the comparator.
    const keyed = filteredRows.map(row => ({ row, key: cellSortKey(row[ci]) }));
    keyed.sort((a, b) => {
      if (a.key === null) return b.key === null ? 0 : 1;
      if (b.key === null) return -1;
      return compareCellKeys(a.key, b.key) * dir;
    });
    return keyed.map(k => k.row);
  }, [result, filteredRows, sort]);

  // Popover top-5: this column's value counts from rows narrowed by every OTHER
  // column's filter — faceted, so an existing pick on this column can be changed
  const popTop = useMemo(() => {
    if (!filterPop) return [];
    const ci = result.columns.findIndex(c => c.name === filterPop.column);
    if (ci < 0) return [];
    const others = filters
      .filter(f => f.column !== filterPop.column)
      .map(f => ({ f, ci: result.columns.findIndex(c => c.name === f.column) }))
      .filter(x => x.ci >= 0);
    const values: unknown[] = [];
    for (const row of result.rows) {
      if (others.every(({ f, ci: fi }) => matchesFilter(row[fi], f))) values.push(row[ci]);
    }
    return topValueCounts(values, 5);
  }, [filterPop, filters, result]);

  const filteredCols = useMemo(() => new Set(filters.map(f => f.column)), [filters]);

  const handleFilterCol = useCallback((column: string, anchor: { x: number; y: number }) => {
    setFilterPop(prev => prev?.column === column ? null : { column, anchor });
  }, []);

  const applyFilter = useCallback((column: string, f: ColumnFilter | null) => {
    setFilters(prev => {
      const rest = prev.filter(x => x.column !== column);
      return f ? [...rest, f] : rest;
    });
    setFilterPop(null);
  }, []);

  const handleSortCol = useCallback((col: string) => {
    setSort(prev => {
      const existing = prev.find(s => s.column === col);
      if (!existing) return [{ column: col, direction: 'asc' }];
      if (existing.direction === 'asc') return [{ column: col, direction: 'desc' }];
      return [];
    });
  }, []);

  const handleSelection = useCallback((sel: SelRect | null, dragging?: boolean) => {
    setHasSel(sel !== null);
    // The aggregate scan touches up to 2M cells — run it once on the final
    // selection, not on every intermediate drag update.
    if (!dragging) setAgg(sel ? computeAggregates(sortedRows, sel) : null);
    if (sel) setRecordRow(Math.min(sel.r1, sel.r2));
  }, [sortedRows]);

  const handleOpenCell = useCallback((r: number, c: number) => {
    setViewer({ column: result.columns[c].name, value: sortedRows[r][c] });
  }, [result.columns, sortedRows]);

  const getData = useCallback(() => {
    return apiRef.current?.getSelectionData()
      ?? { columns: result.columns.map(c => c.name), rows: sortedRows };
  }, [result.columns, sortedRows]);

  if (result.rows.length === 0) {
    return <div className="empty-result">Query returned 0 rows.</div>;
  }

  return (
    <div className="result-grid-wrap">
      <div className="result-toolbar">
        <span className="result-count">
          {filters.length > 0
            ? `${filteredRows.length.toLocaleString()} of ${result.rows.length.toLocaleString()} rows`
            : `${result.rows.length.toLocaleString()} rows`}
        </span>
        {filters.length > 0 && (
          <button className="toolbar-btn" title="Remove all column filters"
            onClick={() => { setFilters([]); setFilterPop(null); }}>
            ✕ {filters.length} filter{filters.length > 1 ? 's' : ''}
          </button>
        )}
        <CopyExportMenu getData={getData} engine={engine} hasSelection={hasSel} onNote={note} />
        <GridSettingsPopover />
        {flash && <span className="result-flash">{flash}</span>}
        <button className={`toolbar-btn ${showRecord ? 'active' : ''}`}
          title="Record view — selected row transposed"
          onClick={() => setShowRecord(v => !v)}>⊞ Record</button>
        <button className={`toolbar-btn ${showChart ? 'active' : ''}`}
          title="Chart the result (respects active column filters)"
          onClick={() => { setShowChart(v => !v); setShowPivot(false); }}>📊 Chart</button>
        <button className={`toolbar-btn ${showPivot ? 'active' : ''}`}
          title="Group and pivot the result (respects active column filters)"
          onClick={() => { setShowPivot(v => !v); setShowChart(false); }}>▦ Pivot</button>
        <div style={{ flex: 1 }} />
        {agg && agg.count > 0 && (
          <span className="result-agg">
            n={agg.count.toLocaleString()}
            {agg.sum !== null && <> · Σ {fmtNum(agg.sum)}</>}
            {agg.avg !== null && <> · avg {fmtNum(agg.avg)}</>}
            {agg.min !== null && <> · min {fmtNum(agg.min)}</>}
            {agg.max !== null && <> · max {fmtNum(agg.max)}</>}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {showChart && (
          <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
            <ResultChart columns={result.columns} rows={sortedRows} />
          </div>
        )}
        {showPivot && (
          <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
            <ResultPivot columns={result.columns} rows={sortedRows} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, display: showChart || showPivot ? 'none' : 'flex' }}>
          <FastGrid
            columns={result.columns}
            rows={sortedRows}
            sort={sort}
            onSortCol={handleSortCol}
            onFilterCol={handleFilterCol}
            filteredCols={filteredCols}
            onOpenCell={handleOpenCell}
            onSelectionChange={handleSelection}
            apiRef={apiRef}
          />
        </div>
        {showRecord && recordRow !== null && sortedRows[recordRow] && (
          <RecordView
            columns={result.columns}
            row={sortedRows[recordRow]}
            rowIndex={recordRow}
            onClose={() => setShowRecord(false)}
          />
        )}
      </div>

      {filterPop && (
        <ColumnFilterPopover
          column={filterPop.column}
          top={popTop}
          current={filters.find(f => f.column === filterPop.column) ?? null}
          anchor={filterPop.anchor}
          onApply={f => applyFilter(filterPop.column, f)}
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
    </div>
  );
}
