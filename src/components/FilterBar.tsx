import { useState } from 'react';
import type { FilterClause, FilterOp, SortClause, SortDir, TableColumn } from '../types/browser';
import { OP_LABELS, OPS_WITH_VALUE } from '../types/browser';

interface Props {
  columns:  TableColumn[];
  filters:  FilterClause[];
  sort:     SortClause[];
  onChange: (filters: FilterClause[], sort: SortClause[]) => void;
  inline?:  boolean;   // render as an inline toolbar control (panel overlays)
}

export function FilterBar({ columns, filters, sort, onChange, inline }: Props) {
  const [open, setOpen] = useState(false);
  const activeCount = filters.length + sort.length;

  function addFilter() {
    const col = columns[0]?.name ?? '';
    onChange([...filters, { column: col, op: 'eq', value: '' }], sort);
  }

  function updateFilter(i: number, patch: Partial<FilterClause>) {
    const next = filters.map((f, idx) => idx === i ? { ...f, ...patch } : f);
    onChange(next, sort);
  }

  function removeFilter(i: number) {
    onChange(filters.filter((_, idx) => idx !== i), sort);
  }

  function addSort() {
    const col = columns[0]?.name ?? '';
    // Don't duplicate columns
    if (sort.find(s => s.column === col)) return;
    onChange(filters, [...sort, { column: col, direction: 'asc' }]);
  }

  function updateSort(i: number, patch: Partial<SortClause>) {
    onChange(filters, sort.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  }

  function removeSort(i: number) {
    onChange(filters, sort.filter((_, idx) => idx !== i));
  }

  function clearAll() {
    onChange([], []);
  }

  return (
    <div className={`filter-bar ${inline ? "filter-bar-inline" : ""}`}>
      <div className="filter-bar-toggle">
        <button
          className={`filter-toggle-btn ${open ? 'active' : ''}`}
          onClick={() => setOpen(o => !o)}
        >
          ⚙ Filter &amp; Sort
          {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
        </button>
        {activeCount > 0 && (
          <button className="filter-clear" onClick={clearAll} title="Clear all">✕</button>
        )}
      </div>

      {open && (
        <div className="filter-panel">
          {/* Filters */}
          <div className="filter-section">
            <div className="filter-section-head">
              <span>WHERE</span>
              <button className="icon-btn" onClick={addFilter}>+</button>
            </div>
            {filters.map((f, i) => (
              <div key={i} className="filter-row">
                <select
                  value={f.column}
                  onChange={e => updateFilter(i, { column: e.target.value })}
                >
                  {columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>

                <select
                  value={f.op}
                  onChange={e => updateFilter(i, { op: e.target.value as FilterOp, value: null })}
                >
                  {(Object.keys(OP_LABELS) as FilterOp[]).map(op => (
                    <option key={op} value={op}>{OP_LABELS[op]}</option>
                  ))}
                </select>

                {OPS_WITH_VALUE.includes(f.op) && (
                  <input
                    value={f.value ?? ''}
                    onChange={e => updateFilter(i, { value: e.target.value })}
                    placeholder="value"
                  />
                )}

                <button className="filter-remove" onClick={() => removeFilter(i)}>×</button>
              </div>
            ))}
            {filters.length === 0 && (
              <span className="filter-empty">No filters</span>
            )}
          </div>

          {/* Sort */}
          <div className="filter-section">
            <div className="filter-section-head">
              <span>ORDER BY</span>
              <button className="icon-btn" onClick={addSort}>+</button>
            </div>
            {sort.map((s, i) => (
              <div key={i} className="filter-row">
                <select
                  value={s.column}
                  onChange={e => updateSort(i, { column: e.target.value })}
                >
                  {columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                <select
                  value={s.direction}
                  onChange={e => updateSort(i, { direction: e.target.value as SortDir })}
                >
                  <option value="asc">ASC</option>
                  <option value="desc">DESC</option>
                </select>
                <button className="filter-remove" onClick={() => removeSort(i)}>×</button>
              </div>
            ))}
            {sort.length === 0 && <span className="filter-empty">No sort</span>}
          </div>
        </div>
      )}
    </div>
  );
}
