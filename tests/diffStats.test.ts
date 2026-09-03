/**
 * Line tally behind the SQL compare toolbar badge (src/utils/diffStats.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffStats, summarizeDiff } from '../src/utils/diffStats.ts';

test('identical texts → identical, no adds or removes', () => {
  const s = diffStats('a\nb\nc', 'a\nb\nc');
  assert.equal(s.identical, true);
  assert.equal(s.added, 0);
  assert.equal(s.removed, 0);
  assert.equal(s.same, 3);
  assert.equal(summarizeDiff(s), 'Identical');
});

test('two empty texts are identical', () => {
  const s = diffStats('', '');
  assert.equal(s.identical, true);
  assert.equal(summarizeDiff(s), 'Identical');
});

test('appended lines count as added', () => {
  const s = diffStats('a\nb', 'a\nb\nc\nd');
  assert.equal(s.added, 2);
  assert.equal(s.removed, 0);
  assert.equal(s.identical, false);
  assert.equal(summarizeDiff(s), '+2');
});

test('removed lines count as removed', () => {
  const s = diffStats('a\nb\nc', 'a\nc');
  assert.equal(s.added, 0);
  assert.equal(s.removed, 1);
  assert.equal(summarizeDiff(s), '−1');
});

test('an edited line is one removal and one addition', () => {
  const s = diffStats('a\nb\nc', 'a\nB\nc');
  assert.equal(s.added, 1);
  assert.equal(s.removed, 1);
  assert.equal(summarizeDiff(s), '+1  −1');
});
