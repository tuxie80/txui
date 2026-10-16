/**
 * Value-view helpers for the Redis key browser (src/utils/redisValue.ts).
 *
 * The backend caps collection reads (200 items, 50 for streams) while the
 * header knows the real cardinality — the "showing N of M" note is what keeps
 * a capped page from posing as the whole value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueItemCount, shownOfTotal } from '../src/utils/redisValue.ts';

test('each collection type counts its own array', () => {
  assert.equal(valueItemCount({ type: 'list', items: [1, 2, 3] }), 3);
  assert.equal(valueItemCount({ type: 'hash', fields: [{}, {}] }), 2);
  assert.equal(valueItemCount({ type: 'set', members: ['a'] }), 1);
  assert.equal(valueItemCount({ type: 'zset', entries: [{}, {}, {}, {}] }), 4);
  assert.equal(valueItemCount({ type: 'stream', entries: [{}] }), 1);
});

test('strings and gone keys have no item count', () => {
  assert.equal(valueItemCount({ type: 'string' }), null);
  assert.equal(valueItemCount({ type: 'none' }), null);
});

test('a capped collection says what it is hiding', () => {
  assert.equal(shownOfTotal(200, 41203), 'showing 200 of 41,203');
});

test('a fully shown or empty key earns no banner', () => {
  assert.equal(shownOfTotal(50, 50), null);
  assert.equal(shownOfTotal(0, 0), null);
  // A shrink between size probe and fetch must not print nonsense.
  assert.equal(shownOfTotal(60, 50), null);
});
