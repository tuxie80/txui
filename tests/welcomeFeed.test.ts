/**
 * Welcome-screen activity feed shaping (src/utils/welcomeFeed.ts).
 *
 * The feed is the landing screen once the user has connections: the newest
 * audit rows across every server, with session connect/disconnect reading as
 * "Connected" / "Disconnected — lasted …".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedRows } from '../src/utils/welcomeFeed.ts';

const base = {
  id: 1, started_at: '2026-09-01 16:10:49.508', ended_at: '2026-09-01 16:10:49.508',
  duration_ms: 0,
  connection_name: 'prod', engine: 'mysql', ok: true, error: null, sql: '',
};

test('a connect reads as a point event', () => {
  const [r] = feedRows([{ ...base, source: 'lifecycle', sql: 'connect' }]);
  assert.equal(r.text, 'Connected');
  assert.equal(r.connection, 'prod');
  assert.equal(r.ok, true);
});

test('a disconnect says how long the session lasted', () => {
  const [r] = feedRows([{ ...base, source: 'lifecycle', sql: 'disconnect', duration_ms: 123_000 }]);
  assert.equal(r.text, 'Disconnected — lasted 2 min 3 s');
});

test('a disconnect under a minute still humanizes', () => {
  const [r] = feedRows([{ ...base, source: 'lifecycle', sql: 'disconnect', duration_ms: 1524 }]);
  assert.equal(r.text, 'Disconnected — lasted 1 s 524 ms');
});

test('a failed connect reads as a failure and stays red (ok=false)', () => {
  const [r] = feedRows([{ ...base, source: 'lifecycle', sql: 'connect failed', ok: false, error: 'Connect to prod failed:\ndead' }]);
  assert.equal(r.text, 'Connection failed');
  assert.equal(r.ok, false);
});

test('an executed statement reads as the statement plus its duration', () => {
  const [r] = feedRows([{ ...base, source: 'editor', sql: 'SELECT  *   FROM orders', duration_ms: 12 }]);
  assert.equal(r.text, 'SELECT * FROM orders — 12 ms');
});

test('a failed statement leads with the error, marked as not ok', () => {
  const [r] = feedRows([{ ...base, source: 'editor', ok: false, error: 'Table doesn\'t exist', sql: 'SELECT 1' }]);
  assert.equal(r.text, '! Table doesn\'t exist — SELECT 1');
  assert.equal(r.ok, false);
});

test('a very long statement is truncated rather than pasted whole', () => {
  const [r] = feedRows([{ ...base, source: 'editor', sql: `SELECT ${'x'.repeat(200)}` }]);
  assert.ok(r.text.includes('…'));
  assert.ok(r.text.length < 100);
});

test('the timestamp keeps the log format but drops milliseconds', () => {
  const [r] = feedRows([{ ...base }]);
  assert.equal(r.when, '2026-09-01 16:10:49');
});

test('a disconnect is stamped at the moment it happened, not at session start', () => {
  // The row brackets the whole session: started_at = connect time, ended_at =
  // disconnect time. Showing started_at read as "disconnected at connect
  // time" — the bug this pins.
  const [r] = feedRows([{
    ...base, source: 'lifecycle', sql: 'disconnect', duration_ms: 305_000,
    started_at: '2026-09-03 14:31:43.112', ended_at: '2026-09-03 14:36:48.417',
  }]);
  assert.equal(r.when, '2026-09-03 14:36:48');
  assert.equal(r.text, 'Disconnected — lasted 5 min 5 s');
});

test('a connect is still stamped at its own moment (started_at)', () => {
  const [r] = feedRows([{ ...base, source: 'lifecycle', sql: 'connect' }]);
  assert.equal(r.when, '2026-09-01 16:10:49');
});

test('order is the query\'s order (newest first), and an empty log is empty', () => {
  assert.deepEqual(feedRows([]), []);
  const rows = feedRows([
    { ...base, id: 2, source: 'lifecycle', sql: 'disconnect' },
    { ...base, id: 1, source: 'lifecycle', sql: 'connect' },
  ]);
  assert.deepEqual(rows.map(r => r.id), [2, 1]);
});
