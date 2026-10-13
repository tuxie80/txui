/**
 * Pivot — grouping and cross-tabbing a result grid.
 *
 * The cases that matter: a plain group-by with each aggregate, a cross-tab that
 * spreads a column across the top, missing cells left null rather than zero,
 * numeric-looking strings folded in, and count staying independent of the value
 * column.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pivot, aggLabel, type PivotSpec } from '../src/utils/pivot.ts';

const DATA: { columns: string[]; rows: unknown[][] } = {
  columns: ['region', 'product', 'amount'],
  rows: [
    ['EU', 'a', 10],
    ['EU', 'b', 20],
    ['EU', 'a', 5],
    ['US', 'a', 100],
    ['US', 'b', '7'],   // numeric-looking string
  ],
};

const spec = (o: Partial<PivotSpec>): PivotSpec => ({
  columns: DATA.columns, rows: DATA.rows,
  rowDims: ['region'], colDim: null, valueCol: 'amount', agg: 'sum', ...o,
});

test('group-by sum totals each group', () => {
  const r = pivot(spec({ agg: 'sum' }));
  assert.deepEqual(r.columns, ['region', 'sum(amount)']);
  assert.deepEqual(r.rows, [['EU', 35], ['US', 107]]);  // 100 + 7 (string coerced)
});

test('count is independent of the value column', () => {
  const r = pivot(spec({ agg: 'count', valueCol: null }));
  assert.deepEqual(r.columns, ['region', 'count']);
  assert.deepEqual(r.rows, [['EU', 3], ['US', 2]]);
});

test('avg / min / max over the group', () => {
  assert.deepEqual(pivot(spec({ agg: 'avg' })).rows, [['EU', 35 / 3], ['US', 53.5]]);
  assert.deepEqual(pivot(spec({ agg: 'min' })).rows, [['EU', 5], ['US', 7]]);
  assert.deepEqual(pivot(spec({ agg: 'max' })).rows, [['EU', 20], ['US', 100]]);
});

test('a pivot column becomes a cross-tab, missing cells null', () => {
  const r = pivot(spec({ rowDims: ['region'], colDim: 'product', agg: 'sum' }));
  assert.deepEqual(r.columns, ['region', 'a', 'b']);
  // EU: a=10+5=15, b=20 ; US: a=100, b=7
  assert.deepEqual(r.rows, [['EU', 15, 20], ['US', 100, 7]]);
});

test('a cell with no matching rows is null, not zero', () => {
  const data = {
    columns: ['r', 'c', 'v'],
    rows: [['x', 'p', 1], ['y', 'q', 2]] as unknown[][],
  };
  const r = pivot({ ...data, rowDims: ['r'], colDim: 'c', valueCol: 'v', agg: 'sum' });
  assert.deepEqual(r.columns, ['r', 'p', 'q']);
  assert.deepEqual(r.rows, [['x', 1, null], ['y', null, 2]]);
});

test('rows keep first-appearance order; pivot columns are sorted', () => {
  const data = {
    columns: ['r', 'c'],
    rows: [['z', 'b'], ['a', 'a'], ['z', 'a']] as unknown[][],
  };
  const r = pivot({ ...data, rowDims: ['r'], colDim: 'c', valueCol: null, agg: 'count' });
  assert.deepEqual(r.columns, ['r', 'a', 'b']);        // columns sorted
  assert.deepEqual(r.rows[0][0], 'z');                  // rows in first-seen order
  assert.deepEqual(r.rows[1][0], 'a');
});

test('sum of a group with no numeric values is null', () => {
  const data = { columns: ['r', 'v'], rows: [['x', 'hello'], ['x', 'world']] as unknown[][] };
  const r = pivot({ ...data, rowDims: ['r'], colDim: null, valueCol: 'v', agg: 'sum' });
  assert.deepEqual(r.rows, [['x', null]]);
});

test('aggLabel names the aggregate', () => {
  assert.equal(aggLabel('count', null), 'count');
  assert.equal(aggLabel('sum', 'amount'), 'sum(amount)');
  assert.equal(aggLabel('avg', null), 'count');  // no value column → count
});

test('decimal-looking strings fold into the arithmetic, not NaN', () => {
  const data = {
    columns: ['r', 'v'],
    rows: [['x', '10.50'], ['x', '0.5'], ['x', null]] as unknown[][],
  };
  // DECIMAL arrives as a string from the drivers; NULL stays out of the maths.
  assert.deepEqual(pivot({ ...data, rowDims: ['r'], colDim: null, valueCol: 'v', agg: 'sum' }).rows, [['x', 11]]);
  assert.deepEqual(pivot({ ...data, rowDims: ['r'], colDim: null, valueCol: 'v', agg: 'avg' }).rows, [['x', 5.5]]);
  // count still counts every row, NULL included.
  assert.deepEqual(pivot({ ...data, rowDims: ['r'], colDim: null, valueCol: 'v', agg: 'count' }).rows, [['x', 3]]);
});

test('non-numeric values are skipped, not folded in as zero', () => {
  const data = {
    columns: ['r', 'v'],
    rows: [['x', 10], ['x', 'n/a'], ['x', null]] as unknown[][],
  };
  const r = pivot({ ...data, rowDims: ['r'], colDim: null, valueCol: 'v', agg: 'avg' });
  assert.deepEqual(r.rows, [['x', 10]]);   // avg over the one numeric value
});

test('past maxCols the rarest values fold into (other), totals intact', () => {
  const data = {
    columns: ['r', 'c'],
    rows: [
      ['x', 'a'], ['x', 'a'], ['x', 'a'],
      ['x', 'b'], ['x', 'b'],
      ['x', 'c'],
      ['x', 'd'],
    ] as unknown[][],
  };
  const r = pivot({ ...data, rowDims: ['r'], colDim: 'c', valueCol: null, agg: 'count', maxCols: 3 });
  assert.equal(r.foldedCols, 2);
  assert.deepEqual(r.columns, ['r', 'a', 'b', '(other)']);   // top 2 kept, c+d folded
  assert.deepEqual(r.rows, [['x', 3, 2, 2]]);                 // 3+2+2 = 7 rows
});

test('(other) sums the folded cells, and a group without them stays null', () => {
  const data = {
    columns: ['r', 'c', 'v'],
    rows: [
      ['x', 'a', 1], ['x', 'b', 10], ['x', 'c', 100],
      ['y', 'a', 2],
    ] as unknown[][],
  };
  const r = pivot({ ...data, rowDims: ['r'], colDim: 'c', valueCol: 'v', agg: 'sum', maxCols: 2 });
  assert.equal(r.foldedCols, 2);
  // 'a' is the most frequent (2 rows) and survives; b+c fold into (other).
  assert.deepEqual(r.columns, ['r', 'a', '(other)']);
  assert.deepEqual(r.rows, [['x', 1, 110], ['y', 2, null]]);
});

test('no fold at or under the cap', () => {
  const r = pivot(spec({ rowDims: ['region'], colDim: 'product', agg: 'sum', maxCols: 2 }));
  assert.equal(r.foldedCols, 0);
  assert.deepEqual(r.columns, ['region', 'a', 'b']);
});
