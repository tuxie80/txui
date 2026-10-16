/**
 * SCAN page merging for the Redis key browser (src/utils/redisScan.ts).
 *
 * Redis SCAN may return the same key on two pages; concatenating pages lists
 * it twice (and React keys collide). The merge dedups, first-seen order kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeScannedKeys } from '../src/utils/redisScan.ts';

test('disjoint pages concatenate in order', () => {
  assert.deepEqual(mergeScannedKeys(['a', 'b'], ['c', 'd']), ['a', 'b', 'c', 'd']);
});

test('a key repeated across pages appears once, at its first position', () => {
  assert.deepEqual(mergeScannedKeys(['a', 'b', 'c'], ['b', 'd', 'a']), ['a', 'b', 'c', 'd']);
});

test('duplicates within one page also collapse', () => {
  assert.deepEqual(mergeScannedKeys([], ['x', 'x', 'y']), ['x', 'y']);
});

test('an empty page changes nothing and copies nothing by reference', () => {
  const prev = ['a'];
  const merged = mergeScannedKeys(prev, []);
  assert.deepEqual(merged, ['a']);
  assert.notEqual(merged, prev, 'state updates need a new array for React');
});
