/**
 * utils/selectionLines.ts — which gutter line numbers light up for a
 * selection. The owner's rule: selecting lines 5–10 lights ALL of 5–10, all
 * the same way; a range ending exactly at a line's start holds nothing of
 * that line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedLineNumbers } from '../src/utils/selectionLines.ts';

const DOC = 'one\ntwo\nthree\nfour\nfive\nsix\n'; // lines 1–6, each 3–4 chars

test('a bare caret lights nothing (the active-line style is separate)', () => {
  assert.equal(selectedLineNumbers(DOC, [{ from: 5, to: 5 }]).size, 0);
  assert.equal(selectedLineNumbers(DOC, []).size, 0);
});

test('a multi-line selection lights every covered line', () => {
  // lines 2–4: from line 2's start into line 4
  const from = DOC.indexOf('two');
  const to = DOC.indexOf('four') + 2;
  assert.deepEqual([...selectedLineNumbers(DOC, [{ from, to }])], [2, 3, 4]);
});

test('selecting whole lines does NOT light the line after the last newline', () => {
  // shift-select lines 2–3: the range covers both newlines and ends exactly
  // at line 4's start — line 4 holds no selected character.
  const from = DOC.indexOf('two');
  const to = DOC.indexOf('four');
  assert.deepEqual([...selectedLineNumbers(DOC, [{ from, to }])], [2, 3]);
});

test('a selection inside one line lights just that line', () => {
  const from = DOC.indexOf('three') + 1;
  assert.deepEqual([...selectedLineNumbers(DOC, [{ from, to: from + 2 }])], [3]);
});

test('reversed ranges (upward drag) normalize', () => {
  const from = DOC.indexOf('two');
  const to = DOC.indexOf('three') + 2;
  assert.deepEqual([...selectedLineNumbers(DOC, [{ from: to, to: from }])], [2, 3]);
});

test('multi-cursor unions all non-empty ranges', () => {
  const r1 = { from: DOC.indexOf('two'), to: DOC.indexOf('two') + 2 };
  const r2 = { from: DOC.indexOf('five'), to: DOC.indexOf('six') + 2 };
  const caret = { from: 0, to: 0 }; // a bare caret alongside — contributes nothing
  assert.deepEqual([...selectedLineNumbers(DOC, [r1, r2, caret])].sort((a, b) => a - b), [2, 5, 6]);
});

test('a selection on the last line without trailing newline works', () => {
  const doc = 'a\nb'; // no trailing newline
  assert.deepEqual([...selectedLineNumbers(doc, [{ from: 0, to: 3 }])], [1, 2]);
  assert.deepEqual([...selectedLineNumbers(doc, [{ from: 2, to: 3 }])], [2]);
});

test('an empty document lights nothing', () => {
  assert.equal(selectedLineNumbers('', [{ from: 0, to: 0 }]).size, 0);
});
