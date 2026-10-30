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
import {
  sharedColumns, project, diffResults, diffToQueryResult, type ResultLike,
} from '../src/utils/resultDiff.ts';
import type { QueryResult } from '../src/types/index.ts';

const R = (columns: string[], rows: unknown[][]): ResultLike =>
  ({ columns: columns.map(name => ({ name })), rows });

const QR = (
  columns: Array<[string, string]>, rows: unknown[][],
): QueryResult => ({
  columns: columns.map(([name, type_name]) => ({ name, type_name, nullable: true })),
  rows, rows_affected: null, execution_ms: 0, fetch_ms: 0, warnings: [],
});

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

// ── TxShell's typed result representation ────────────────────────────────────

test('query-result diff aligns columns and exposes changed typed values', () => {
  const a = QR([['id', 'int'], ['value', 'numeric'], ['note', 'text']],
    [[1, 10.5, null], [2, 20, 'same']]);
  const b = QR([['note', 'text'], ['value', 'text'], ['id', 'int']],
    [[null, '10.50', 1], ['changed', '20', 2]]);
  const out = diffToQueryResult(a, b, ['id']);
  assert.deepEqual(out.result.rows, [
    ['changed', '["2"]', 'note', 'same', 'changed'],
  ]);
  assert.match(out.notices[0], /1 same · 1 changed/);
  assert.match(out.notices[1], /Declared types differ for value/);
});

test('default all-column keys report removals and additions as whole rows', () => {
  const a = QR([['id', 'int'], ['v', 'text']], [[1, 'old']]);
  const b = QR([['v', 'text'], ['id', 'int']], [['new', 1]]);
  const out = diffToQueryResult(a, b);
  assert.equal(out.result.rows.length, 2);
  assert.deepEqual(out.result.rows.map(r => r[0]), ['only_left', 'only_right']);
  assert.deepEqual(JSON.parse(String(out.result.rows[0][3])), { id: 1, v: 'old' });
  assert.deepEqual(JSON.parse(String(out.result.rows[1][4])), { id: 1, v: 'new' });
});

test('NULL stays distinct from empty text and false in the typed output', () => {
  const a = QR([['id', 'int'], ['v', 'text']], [[1, null], [2, ''], [3, false]]);
  const b = QR([['id', 'int'], ['v', 'text']], [[1, ''], [2, null], [3, false]]);
  const out = diffToQueryResult(a, b, ['id']);
  assert.deepEqual(out.result.rows, [
    ['changed', '["1"]', 'v', null, ''],
    ['changed', '["2"]', 'v', '', null],
  ]);
});

test('shape-only columns and duplicate keys are explicit notices', () => {
  const a = QR([['id', 'int'], ['left_only', 'text']], [[1, 'a'], [1, 'b']]);
  const b = QR([['id', 'int'], ['right_only', 'text']], [[1, 'x']]);
  const out = diffToQueryResult(a, b, ['id']);
  assert.ok(out.notices.some(n => /only in current result: left_only/.test(n)));
  assert.ok(out.notices.some(n => /only in #7: right_only/.test(n)) === false,
    'the default label is other result');
  const labelled = diffToQueryResult(a, b, ['id'], 'current result', '#7');
  assert.ok(labelled.notices.some(n => /only in #7: right_only/.test(n)));
  assert.ok(out.notices.some(n => /duplicate key.*only the first/.test(n)));
});

test('no shared columns, duplicate shared names and unknown keys are errors', () => {
  const a = QR([['id', 'int'], ['id', 'int']], [[1, 1]]);
  const b = QR([['id', 'int']], [[1]]);
  assert.throws(() => diffToQueryResult(a, b), /duplicated/);
  assert.throws(() => diffToQueryResult(b, QR([['other', 'int']], [[1]])), /share no column/);
  assert.throws(() => diffToQueryResult(b, b, ['missing']), /not shared.*missing/);
});
