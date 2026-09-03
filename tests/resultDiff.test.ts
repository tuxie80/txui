/**
 * Result diff — aligning two grids, then leaning on the compare engine.
 *
 * The alignment is the new code; the comparison itself is `compareRows`, tested
 * separately. So these tests concentrate on the alignment edges: different
 * column orders, a column only one side has, duplicate names, and the two ways
 * a key can be chosen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedColumns, project, diffResults, type ResultLike } from '../src/utils/resultDiff.ts';

const R = (columns: string[], rows: unknown[][]): ResultLike =>
  ({ columns: columns.map(name => ({ name })), rows });

test('shared columns are those in both, in the first result order', () => {
  const a = R(['id', 'name', 'city'], []);
  const b = R(['city', 'id', 'age'], []);
  assert.deepEqual(sharedColumns(a, b), ['id', 'city']);
});

test('a duplicate column name participates only once', () => {
  const a = R(['id', 'id', 'name'], []);
  const b = R(['id', 'name'], []);
  assert.deepEqual(sharedColumns(a, b), ['id', 'name']);
});

test('project reorders rows onto the shared column list', () => {
  const b = R(['city', 'id', 'age'], [['Prague', 1, 30], ['Brno', 2, 40]]);
  assert.deepEqual(project(b, ['id', 'city']), [[1, 'Prague'], [2, 'Brno']]);
});

test('column order does not make identical results differ', () => {
  // The classic rewrite: same rows, columns emitted in a different order.
  const a = R(['id', 'name'], [[1, 'a'], [2, 'b']]);
  const b = R(['name', 'id'], [['a', 1], ['b', 2]]);
  const d = diffResults(a, b, ['id']);
  assert.equal(d.same, 2);
  assert.equal(d.different.length, 0);
  assert.equal(d.onlyInSource.length, 0);
  assert.equal(d.onlyInTarget.length, 0);
});

test('all shared columns as key gives a set difference', () => {
  // A row whose value changed shows as one removal plus one addition when every
  // column is part of the key — the answer to "did the output change?".
  const a = R(['id', 'v'], [[1, 'x'], [2, 'y']]);
  const b = R(['id', 'v'], [[1, 'x'], [2, 'CHANGED']]);
  const d = diffResults(a, b, ['id', 'v']);
  assert.equal(d.same, 1);
  assert.equal(d.different.length, 0, 'no per-column diff when every column is a key');
  assert.equal(d.onlyInSource.length, 1);
  assert.equal(d.onlyInTarget.length, 1);
});

test('a real key surfaces the change as a per-column difference', () => {
  const a = R(['id', 'v'], [[1, 'x'], [2, 'y']]);
  const b = R(['id', 'v'], [[1, 'x'], [2, 'CHANGED']]);
  const d = diffResults(a, b, ['id']);
  assert.equal(d.same, 1);
  assert.equal(d.different.length, 1);
  assert.deepEqual(d.different[0].changed, ['v']);
});

test('columns present on only one side are dropped, not diffed against null', () => {
  const a = R(['id', 'name', 'extra'], [[1, 'a', 'zzz']]);
  const b = R(['id', 'name'], [[1, 'a']]);
  const d = diffResults(a, b, ['id']);
  assert.equal(d.same, 1, 'the extra column is ignored, so the row matches');
});
