/**
 * Grouping and pivoting a result grid in memory.
 *
 * Three rivals (DBeaver, Aqua, dbForge) let you group a result by a column and
 * pivot it without rewriting the query, and the arithmetic for it already
 * exists here — the grid's selection aggregates do count/sum/avg/min/max. What
 * was missing is grouping *by* a column and spreading a second column across
 * the top. This is that, and only that: it never touches the server, so it is
 * as cheap and as safe as sorting the grid.
 *
 * Two shapes come out of the one function:
 *   - no pivot column → one aggregate column, a plain GROUP BY.
 *   - a pivot column → its distinct values become columns, a cross-tab.
 *
 * Pure and dependency-free — `node --test` covers it without a grid.
 */
export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface PivotSpec {
  columns: string[];
  rows: unknown[][];
  /** Columns whose distinct tuples become the output rows. */
  rowDims: string[];
  /** Column whose distinct values become extra output columns, or null. */
  colDim: string | null;
  /** Column to aggregate. Required for sum/avg/min/max; ignored for count. */
  valueCol: string | null;
  agg: AggFn;
}

export interface PivotResult {
  columns: string[];
  rows: unknown[][];
}

const SEP = ''; // unit separator — cannot collide with rendered values

/**
 * Coerce to a number for aggregation.
 *
 * Drivers deliver numerics inconsistently — a `DECIMAL` arrives as `"10.50"`
 * from one and `10.5` from another — so a numeric-looking string counts, and
 * everything else is skipped rather than folded in as a zero.
 */
function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
  return NaN;
}

interface Acc {
  /** Rows in the group — this is `count`, independent of the value column. */
  n: number;
  sum: number;
  numeric: number;
  min: number;
  max: number;
}

function fold(acc: Acc, value: unknown): void {
  acc.n++;
  const num = toNum(value);
  if (!Number.isNaN(num)) {
    acc.numeric++;
    acc.sum += num;
    if (num < acc.min) acc.min = num;
    if (num > acc.max) acc.max = num;
  }
}

function finish(acc: Acc | undefined, agg: AggFn): number | null {
  if (!acc) return null;
  switch (agg) {
    case 'count': return acc.n;
    case 'sum': return acc.numeric ? acc.sum : null;
    case 'avg': return acc.numeric ? acc.sum / acc.numeric : null;
    case 'min': return acc.numeric ? acc.min : null;
    case 'max': return acc.numeric ? acc.max : null;
  }
}

/** The header for the aggregate column when there is no pivot. */
export function aggLabel(agg: AggFn, valueCol: string | null): string {
  return agg === 'count' || !valueCol ? 'count' : `${agg}(${valueCol})`;
}

export function pivot(spec: PivotSpec): PivotResult {
  const { columns, rows, rowDims, colDim, valueCol, agg } = spec;
  const idx = (name: string) => columns.indexOf(name);
  const rowIdx = rowDims.map(idx);
  const colIdx = colDim ? idx(colDim) : -1;
  const valIdx = valueCol ? idx(valueCol) : -1;

  const newAcc = (): Acc => ({ n: 0, sum: 0, numeric: 0, min: Infinity, max: -Infinity });

  // rowKey → { dims: the row-dimension values, cells: colKey → accumulator }
  const groups = new Map<string, { dims: unknown[]; cells: Map<string, Acc> }>();
  const order: string[] = [];             // row order, first appearance
  const colKeys = new Set<string>();       // distinct pivot values

  for (const row of rows) {
    const dims = rowIdx.map(i => (i >= 0 ? row[i] : null));
    const rowKey = dims.map(v => String(v ?? '')).join(SEP);
    let g = groups.get(rowKey);
    if (!g) { g = { dims, cells: new Map() }; groups.set(rowKey, g); order.push(rowKey); }

    const colKey = colIdx >= 0 ? String(row[colIdx] ?? '') : '';
    if (colIdx >= 0) colKeys.add(colKey);
    let acc = g.cells.get(colKey);
    if (!acc) { acc = newAcc(); g.cells.set(colKey, acc); }
    fold(acc, valIdx >= 0 ? row[valIdx] : null);
  }

  if (colIdx < 0) {
    // Plain group-by: one aggregate column.
    return {
      columns: [...rowDims, aggLabel(agg, valueCol)],
      rows: order.map(k => {
        const g = groups.get(k)!;
        return [...g.dims, finish(g.cells.get(''), agg)];
      }),
    };
  }

  // Cross-tab: distinct pivot values become columns, sorted for a stable layout.
  const pivotCols = [...colKeys].sort();
  return {
    columns: [...rowDims, ...pivotCols],
    rows: order.map(k => {
      const g = groups.get(k)!;
      return [...g.dims, ...pivotCols.map(pc => finish(g.cells.get(pc), agg))];
    }),
  };
}
