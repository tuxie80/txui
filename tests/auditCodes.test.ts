/**
 * Failure classification in the audit log (src/utils/audit.ts).
 *
 * The gap it closes: the log carried the server's prose in `error` and nothing
 * else, so "how often are we losing connections?" and "did raising the timeout
 * help?" could not be answered — every wording variant was a distinct string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureCounts, auditLine } from '../src/utils/audit.ts';

const row = (ok: boolean, error_code = '') => ({ ok, error_code });

test('failures are grouped by class, commonest first', () => {
  const out = failureCounts([
    row(false, 'connection_lost'), row(false, 'timeout'),
    row(false, 'connection_lost'), row(true), row(false, 'connection_lost'),
  ]);
  assert.deepEqual(out, [
    { code: 'connection_lost', count: 3 },
    { code: 'timeout', count: 1 },
  ]);
});

test('successes are not counted, whatever they carry', () => {
  // A row can be ok and still have a code if a call site set one by hand.
  assert.deepEqual(failureCounts([row(true, 'timeout'), row(true)]), []);
});

test('rows written before the column existed are left out, not bucketed', () => {
  // Counting them as `unknown` would invent a failure class whose trend is
  // really just the migration date.
  assert.deepEqual(failureCounts([row(false, ''), row(false, 'timeout')]),
    [{ code: 'timeout', count: 1 }]);
});

test('ties are broken by name so the order does not flicker', () => {
  const out = failureCounts([row(false, 'timeout'), row(false, 'constraint')]);
  assert.deepEqual(out.map(c => c.code), ['constraint', 'timeout']);
});

test('an empty log is empty, not an error', () => {
  assert.deepEqual(failureCounts([]), []);
});

// ── the line the session log shows for an audited action ────────────────────

test('an audited panel action reads as a result line, not as a database row', () => {
  // Panels used to be audited and invisible in the 📓 Log — the most
  // consequential things the app can do (OPTIMIZE, data generation, import)
  // left no trace on the log the user actually watches.
  const base = {
    started_at: '', ended_at: '', connection_name: 'prod', db_user: 'root',
    engine: 'mysql', session_id: 's1', rows_out: 0, rows_affected: null,
    error: null, sql: 'ANALYZE TABLE   orders',
  };
  assert.equal(
    auditLine({ ...base, ok: true, duration_ms: 1524, rows_out: 3 }),
    'ANALYZE TABLE orders — 3 rows retrieved in 1 s 524 ms');
  assert.equal(
    auditLine({ ...base, ok: true, duration_ms: 12, rows_affected: 1 }),
    'ANALYZE TABLE orders — 1 row affected in 12 ms');
  assert.match(
    auditLine({ ...base, ok: false, duration_ms: 42, error: 'Table doesn\'t exist' }),
    /^! Table doesn't exist — ANALYZE TABLE orders \(after 42 ms\)$/);
});

test('a long statement is truncated rather than pasted whole into the log', () => {
  const line = auditLine({
    started_at: '', ended_at: '', connection_name: 'p', db_user: 'r', engine: 'mysql',
    session_id: 's1', ok: true, duration_ms: 1, rows_out: 0, rows_affected: null,
    error: null, sql: 'SELECT ' + 'x'.repeat(500),
  });
  assert.ok(line.includes('…'));
  assert.ok(line.length < 260);
});
