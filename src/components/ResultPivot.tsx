/**
 * Pivot view — group the result by one or more columns and, optionally, spread
 * a second column across the top, aggregating a third.
 *
 * It is a pure in-memory transform of the rows already on screen (see
 * `utils/pivot.ts`); the query never re-runs, so it is as cheap as sorting.
 * Deliberately read-only and self-contained — pickers on the left, the
 * cross-tab on the right, and the cross-tab itself exports through the same
 * Copy ▾ / Export ▾ menu the grid uses.
 */
import { useMemo, useRef, useState } from 'react';
import type { ColumnInfo } from '../types';
import { pivot, aggLabel, OTHER_COL, type AggFn } from '../utils/pivot';
import { CopyExportMenu } from './CopyExportMenu';

interface Props {
  columns: ColumnInfo[];
  rows: unknown[][];
  /** Dialect for the INSERT export — the active connection's engine. */
  engine?: string;
}

const AGGS: AggFn[] = ['count', 'sum', 'avg', 'min', 'max'];
const MAX_PIVOT_ROWS = 5_000; // beyond this the table stops being a summary

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toLocaleString()
      : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(v);
}

export function ResultPivot({ columns, rows, engine }: Props) {
  const names = useMemo(() => columns.map(c => c.name), [columns]);
  const [rowDims, setRowDims] = useState<string[]>(names.length ? [names[0]] : []);
  const [colDim, setColDim] = useState<string>('');   // '' = no pivot column
  const [valueCol, setValueCol] = useState<string>(''); // '' = count rows
  const [agg, setAgg] = useState<AggFn>('count');
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef(0);

  const note = (msg: string) => {
    setFlash(msg);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2500);
  };

  // Without a value column only count is meaningful; fall back rather than
  // silently aggregating nothing.
  const effectiveAgg: AggFn = valueCol ? agg : 'count';

  const out = useMemo(() => {
    if (!rowDims.length) return null;
    return pivot({
      columns: names, rows, rowDims,
      colDim: colDim || null,
      valueCol: valueCol || null,
      agg: effectiveAgg,
    });
  }, [names, rows, rowDims, colDim, valueCol, effectiveAgg]);

  const toggleRowDim = (c: string) =>
    setRowDims(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);

  return (
    <div className="pivot-view" style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
      <div className="pivot-config" style={{
        width: 220, flexShrink: 0, overflowY: 'auto', padding: 8,
        borderRight: '1px solid var(--border)',
      }}>
        <div className="dc-keys-label" style={{ marginBottom: 4 }}>Group rows by</div>
        {names.map(c => (
          <label key={c} className="form-check" style={{ display: 'block' }}>
            <input type="checkbox" checked={rowDims.includes(c)} onChange={() => toggleRowDim(c)} />
            {c}
          </label>
        ))}

        <label className="dg-field-inline" style={{ marginTop: 10 }}>
          <span>Pivot column</span>
          <select value={colDim} onChange={e => setColDim(e.target.value)}>
            <option value="">(none)</option>
            {names.filter(c => !rowDims.includes(c)).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        <label className="dg-field-inline">
          <span>Value</span>
          <select value={valueCol} onChange={e => setValueCol(e.target.value)}>
            <option value="">(row count)</option>
            {names.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        <label className="dg-field-inline">
          <span>Aggregate</span>
          <select value={effectiveAgg} disabled={!valueCol}
            onChange={e => setAgg(e.target.value as AggFn)}>
            {AGGS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        {!valueCol && (
          <div className="dv-desc" style={{ marginTop: 6 }}>
            Pick a value column to sum, average, or take the min/max of it.
          </div>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {out && (
          <div className="pivot-head" style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px',
            borderBottom: '1px solid var(--border)', flexShrink: 0,
          }}>
            <span className="result-count">
              {out.rows.length.toLocaleString()} group{out.rows.length === 1 ? '' : 's'}
            </span>
            {out.foldedCols > 0 && (
              <span className="dv-desc">
                {out.foldedCols.toLocaleString()} less-frequent {colDim} values under {OTHER_COL}
              </span>
            )}
            {flash && <span className="result-flash">{flash}</span>}
            <div style={{ flex: 1 }} />
            {/* Exports every group, not just the ones on screen. */}
            <CopyExportMenu
              getData={() => ({ columns: out.columns, rows: out.rows })}
              tableName="pivot"
              engine={engine}
              onNote={note}
            />
          </div>
        )}
        <div className="pivot-table-wrap" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {!rowDims.length ? (
            <div className="empty-result">Pick at least one column to group by.</div>
          ) : out ? (
            <table className="pivot-table">
              <thead>
                <tr>
                  {out.columns.map((c, i) => (
                    <th key={i} style={{
                      position: 'sticky', top: 0, textAlign: i < rowDims.length ? 'left' : 'right',
                      background: 'var(--bg2)', padding: '3px 8px', borderBottom: '1px solid var(--border)',
                      whiteSpace: 'nowrap',
                    }}>
                      {c}
                    </th>
                  ))}
                </tr>
                {colDim && (
                  <tr>
                    <th colSpan={rowDims.length} />
                    <th colSpan={out.columns.length - rowDims.length}
                      style={{ textAlign: 'center', color: 'var(--text2)', fontWeight: 400, padding: '2px 8px' }}>
                      {aggLabel(effectiveAgg, valueCol || null)} by {colDim}
                    </th>
                  </tr>
                )}
              </thead>
              <tbody>
                {out.rows.slice(0, MAX_PIVOT_ROWS).map((row, ri) => (
                  <tr key={ri}>
                    {row.map((v, ci) => (
                      <td key={ci} style={{
                        textAlign: ci < rowDims.length ? 'left' : 'right',
                        padding: '2px 8px', whiteSpace: 'nowrap',
                        fontVariantNumeric: ci < rowDims.length ? undefined : 'tabular-nums',
                      }}>
                        {fmt(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {out && out.rows.length > MAX_PIVOT_ROWS && (
            <div className="dv-desc" style={{ padding: 8 }}>
              Showing the first {MAX_PIVOT_ROWS.toLocaleString()} of {out.rows.length.toLocaleString()} groups —
              add a column to group by, or filter the result first, to narrow it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
