/**
 * Per-line change status (src/utils/lineDiff.ts → lineChangeStatus).
 *
 * The data behind the change-bar gutter: for every CURRENT line a status of
 * added / changed / unchanged, plus the line indices where baseline lines were
 * deleted between kept lines. These pin the LCS coalescing (a del+add run reads
 * as one 'changed' line, not a delete plus an add) and the edge cases the
 * gutter leans on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineChangeStatus } from '../src/utils/lineDiff.ts';

test('identical texts → every line unchanged, no deletions', () => {
  const r = lineChangeStatus('a\nb\nc', 'a\nb\nc');
  assert.deepEqual(r.status, ['unchanged', 'unchanged', 'unchanged']);
  assert.deepEqual(r.deletedBefore, []);
});

test('appended lines are added', () => {
  const r = lineChangeStatus('a\nb', 'a\nb\nc\nd');
  assert.deepEqual(r.status, ['unchanged', 'unchanged', 'added', 'added']);
  assert.deepEqual(r.deletedBefore, []);
});

test('an edited line reads as changed, not add + delete', () => {
  const r = lineChangeStatus('a\nb\nc', 'a\nB\nc');
  assert.deepEqual(r.status, ['unchanged', 'changed', 'unchanged']);
  assert.deepEqual(r.deletedBefore, []);
});

test('a removed line leaves a deletion marker before the next kept line', () => {
  const r = lineChangeStatus('a\nb\nc', 'a\nc');
  assert.deepEqual(r.status, ['unchanged', 'unchanged']);
  // 'b' was deleted; the gap sits before current line index 1 ('c').
  assert.deepEqual(r.deletedBefore, [1]);
});

test('a trailing deletion is reported one past the last line', () => {
  const r = lineChangeStatus('a\nb\nc', 'a\nb');
  assert.deepEqual(r.status, ['unchanged', 'unchanged']);
  assert.deepEqual(r.deletedBefore, [2]);
});

test('empty baseline → every line is added', () => {
  const r = lineChangeStatus('', 'a\nb\nc');
  assert.deepEqual(r.status, ['added', 'added', 'added']);
  assert.deepEqual(r.deletedBefore, []);
});

test('a change hunk pairs changes then spills extra additions', () => {
  // one baseline line replaced by three: first is 'changed', rest 'added'.
  const r = lineChangeStatus('a\nx\nc', 'a\np\nq\nr\nc');
  assert.deepEqual(r.status, ['unchanged', 'changed', 'added', 'added', 'unchanged']);
  assert.deepEqual(r.deletedBefore, []);
});

test('more removed than added: changed line plus a deletion marker', () => {
  // three baseline lines (x,y,z) become one (p): p is 'changed', two extra
  // deletions leave a gap before the following kept line.
  const r = lineChangeStatus('a\nx\ny\nz\nc', 'a\np\nc');
  assert.deepEqual(r.status, ['unchanged', 'changed', 'unchanged']);
  assert.deepEqual(r.deletedBefore, [2]);
});

test('a fully rewritten document has no unchanged lines', () => {
  const r = lineChangeStatus('one\ntwo', 'ONE\nTWO');
  assert.deepEqual(r.status, ['changed', 'changed']);
  assert.deepEqual(r.deletedBefore, []);
});

test('the DP guard falls back to a positional compare on huge inputs', () => {
  const big = Array.from({ length: 1100 }, (_, i) => `line ${i}`);
  const baseline = big.join('\n');
  const current = big.slice();
  current[500] = 'PATCHED';
  const r = lineChangeStatus(baseline, current.join('\n'));
  assert.equal(r.status.length, 1100);
  assert.equal(r.status[500], 'changed');
  assert.equal(r.status[0], 'unchanged');
  assert.equal(r.status[1099], 'unchanged');
});
