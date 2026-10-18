/**
 * Connection-form validation (src/utils/connValidate.ts).
 *
 * The bugs these pin: a cleared SSH port box became 0 (`Number('')`) and was
 * saved; a host port of 70000 was accepted; a file engine could be saved with
 * no path; and the Redis database box took any text, which the URL builder
 * then read as db0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portError, sshPortError, redisDbError, filePathError } from '../src/utils/connValidate.ts';

test('a blank port is fine — the engine default applies', () => {
  assert.equal(portError(null), null);
});

test('well-known ports pass', () => {
  for (const p of [1, 22, 3306, 5432, 6379, 65535]) assert.equal(portError(p), null, `${p}`);
});

test('out-of-range and non-integer ports are rejected', () => {
  for (const p of [0, -1, 65536, 70000, 1.5, NaN]) assert.match(portError(p)!, /1 and 65535/, `${p}`);
});

test('the SSH port has no blank state — 0 is an error, not a default', () => {
  assert.equal(sshPortError(22), null);
  assert.equal(sshPortError(2222), null);
  assert.match(sshPortError(0)!, /1 and 65535/);
  assert.match(sshPortError(65536)!, /1 and 65535/);
  assert.match(sshPortError(NaN)!, /1 and 65535/);
});

test('Redis database: blank is db0, 0–15 pass, everything else is rejected', () => {
  assert.equal(redisDbError(''), null);
  assert.equal(redisDbError('  '), null);
  assert.equal(redisDbError('0'), null);
  assert.equal(redisDbError('15'), null);
  assert.match(redisDbError('16')!, /0 and 15/);
  assert.match(redisDbError('-1')!, /0 and 15/);
  assert.match(redisDbError('abc')!, /0 and 15/);
  assert.match(redisDbError('1.5')!, /0 and 15/);
});

test('a file engine needs a path; DuckDB accepts :memory:', () => {
  assert.match(filePathError('', 'sqlite')!, /SQLite file/);
  assert.match(filePathError('  ', 'parquet')!, /Parquet file/);
  assert.match(filePathError('', 'duckdb')!, /:memory:/);
  assert.equal(filePathError('/tmp/a.sqlite', 'sqlite'), null);
  assert.equal(filePathError(':memory:', 'duckdb'), null);
  assert.equal(filePathError('/data/set/', 'parquet'), null);
});
