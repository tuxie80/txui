/**
 * Chart math (src/utils/chartData.ts).
 *
 * These are the decisions a chart makes before anything is drawn, and each is
 * a way a chart can lie: a text-heavy column treated as numeric, a truncated
 * sample passed off as the whole result, a blank cell plotted at zero, a flat
 * series with no range to draw in. The tests pin the honest behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNT, MAX_CATS, aggregateCategories, lineSeries, niceRange, numericCols,
  sampleRows, scatterPoints, toNum,
} from '../src/utils/chartData.ts';

// ── toNum ───────────────────────────────────────────────────────────────────

test('toNum parses numbers and numeric strings, rejects the rest', () => {
  assert.equal(toNum(42), 42);
  assert.equal(toNum('3.5'), 3.5);
  assert.equal(toNum(' 12 '), 12);
  assert.equal(toNum(null), null);
  assert.equal(toNum(undefined), null);
  assert.equal(toNum(''), null);          // a blank string is not 0
  assert.equal(toNum('   '), null);
  assert.equal(toNum('abc'), null);
  assert.equal(toNum(NaN), null);
  assert.equal(toNum(Infinity), null);
});

// ── numericCols ─────────────────────────────────────────────────────────────

test('numericCols: a column is numeric when most sampled values parse', () => {
  const rows = [
    [1, 'a', '10'],
    [2, 'b', '20'],
    [3, 'c', 'oops'],
    [null, 'd', '30'],
  ];
  assert.deepEqual(numericCols(3, rows), [true, false, true]);
});

test('numericCols: an all-null column is not numeric', () => {
  assert.deepEqual(numericCols(1, [[null], [null]]), [false]);
});

// ── aggregateCategories ─────────────────────────────────────────────────────

test('aggregateCategories sums the value column per category, descending', () => {
  const rows = [['b', 1], ['a', 5], ['b', 2], ['a', 1]];
  assert.deepEqual(aggregateCategories(rows, 0, 1), [['a', 6], ['b', 3]]);
});

test('aggregateCategories with COUNT counts rows', () => {
  const rows = [['x'], ['y'], ['x'], ['x']];
  assert.deepEqual(aggregateCategories(rows, 0, COUNT), [['x', 3], ['y', 1]]);
});

test('aggregateCategories folds the tail past maxCats into "(other)"', () => {
  const rows = Array.from({ length: MAX_CATS + 5 }, (_, i) => [`c${i}`, i + 1]);
  const cats = aggregateCategories(rows, 0, 1);
  assert.equal(cats.length, MAX_CATS);
  const other = cats[cats.length - 1];
  assert.equal(other[0], '(other)');
  // The six smallest values (1..6) are folded: top bucket is c34..c6.
  assert.equal(other[1], 1 + 2 + 3 + 4 + 5 + 6);
  const total = rows.reduce((s, [, v]) => s + (v as number), 0);
  assert.equal(cats.reduce((s, [, v]) => s + v, 0), total);   // nothing lost
});

test('aggregateCategories treats a non-numeric value as 0, not as absent', () => {
  const rows = [['a', 5], ['a', 'n/a']];
  assert.deepEqual(aggregateCategories(rows, 0, 1), [['a', 5]]);
});

// ── sampleRows ──────────────────────────────────────────────────────────────

test('sampleRows keeps small results untouched (stride 1, same array)', () => {
  const rows = [[1], [2], [3]];
  const s = sampleRows(rows, 10);
  assert.equal(s.stride, 1);
  assert.equal(s.rows, rows);
});

test('sampleRows samples evenly and reports the stride', () => {
  const rows = Array.from({ length: 100 }, (_, i) => [i]);
  const s = sampleRows(rows, 10);
  assert.equal(s.stride, 10);
  assert.equal(s.rows.length, 10);
  assert.deepEqual(s.rows.map(r => r[0]), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
});

// ── lineSeries ──────────────────────────────────────────────────────────────

test('lineSeries builds one point list per Y column, dropping non-numerics', () => {
  const rows = [
    ['jan', 10, 1],
    ['feb', null, 2],
    ['mar', 30, 'x'],
    ['apr', 40, 4],
  ];
  const d = lineSeries(rows, 0, [1, 2]);
  assert.deepEqual(d.series, [[10, 30, 40], [1, 2, 4]]);
  assert.deepEqual(d.labels, ['jan', 'feb', 'mar', 'apr']);
  assert.equal(d.stride, 1);
});

// ── scatterPoints ───────────────────────────────────────────────────────────

test('scatterPoints drops rows where either side is not a number', () => {
  const rows = [
    [1, 10],
    [2, null],
    ['n/a', 30],
    [4, 40],
  ];
  const d = scatterPoints(rows, 0, 1);
  assert.deepEqual(d.points, [{ x: 1, y: 10 }, { x: 4, y: 40 }]);
});

test('scatterPoints samples like the line charts do', () => {
  const rows = Array.from({ length: 100 }, (_, i) => [i, i * 2]);
  const d = scatterPoints(rows, 0, 1, 10);
  assert.equal(d.stride, 10);
  assert.equal(d.points.length, 10);
  assert.deepEqual(d.points[0], { x: 0, y: 0 });
});

// ── niceRange ───────────────────────────────────────────────────────────────

test('niceRange pads a flat series so it can still draw', () => {
  assert.deepEqual(niceRange(5, 5), [4, 6]);
});

test('niceRange anchors a near-zero range at zero', () => {
  assert.deepEqual(niceRange(2, 100), [0, 100]);
});

test('niceRange leaves a genuinely offset range alone', () => {
  assert.deepEqual(niceRange(80, 100), [80, 100]);
});

test('niceRange without anchoring keeps a near-zero minimum', () => {
  assert.deepEqual(niceRange(2, 100, false), [2, 100]);
});

test('niceRange handles negative spans', () => {
  assert.deepEqual(niceRange(-50, -10), [-50, -10]);
});
