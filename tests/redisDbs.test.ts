/**
 * Redis db-strip parsing (src/utils/redisDbs.ts).
 *
 * The strip in RedisBrowser shows the server's logical databases from
 * `list_schema`'s labels ("db3 (12 keys)", "db0 (empty)") and highlights the
 * one the session connected to, which comes from the connection's `database`
 * field — the same rule the backend's build_url applies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRedisDbLabel, redisConfigDbIndex } from '../src/utils/redisDbs.ts';

test('a keyspace label carries index and key count', () => {
  assert.deepEqual(parseRedisDbLabel('db3 (12 keys)'), { index: 3, keys: 12 });
  assert.deepEqual(parseRedisDbLabel('db0 (1014 keys)'), { index: 0, keys: 1014 });
  assert.deepEqual(parseRedisDbLabel('db15 (1 keys)'), { index: 15, keys: 1 });
});

test('the empty-server fallback label parses with no count', () => {
  assert.deepEqual(parseRedisDbLabel('db0 (empty)'), { index: 0, keys: null });
});

test('a bare "dbN" still parses — the parenthetical is decoration', () => {
  assert.deepEqual(parseRedisDbLabel('db7'), { index: 7, keys: null });
});

test('anything that is not a db label is refused, not guessed', () => {
  for (const bad of ['', 'keys', 'db', 'dbx (3 keys)', 'db-1 (3 keys)', 'db3 (many keys)', 'db3 (3 keyz)']) {
    assert.equal(parseRedisDbLabel(bad), null, bad);
  }
});

test('the configured db index mirrors build_url: numeric > 0 wins, else db0', () => {
  assert.equal(redisConfigDbIndex('3'), 3);
  assert.equal(redisConfigDbIndex('15'), 15);
  // db0 is the default and gets no URL path — same result either way.
  assert.equal(redisConfigDbIndex('0'), 0);
  assert.equal(redisConfigDbIndex(null), 0);
  assert.equal(redisConfigDbIndex(undefined), 0);
  assert.equal(redisConfigDbIndex(''), 0);
  // A non-numeric value is ignored rather than producing an invalid target.
  assert.equal(redisConfigDbIndex('mydb'), 0);
  assert.equal(redisConfigDbIndex('-1'), 0);
  assert.equal(redisConfigDbIndex('3.5'), 0);
});
