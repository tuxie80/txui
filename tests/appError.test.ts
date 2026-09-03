/**
 * Typed errors on the frontend (src/utils/appError.ts).
 *
 * The bug being replaced: `utils/scriptRun.ts` decided whether to stop a
 * multi-statement run by checking whether the error text contained
 * "Query cancelled", and needed a test proving PostgreSQL's
 * `canceling statement due to statement timeout` was not mistaken for it.
 * The string was load-bearing. These assert the typed path removes that, and
 * that the string fallback still behaves while the conversion is incomplete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAppError, errorMessage, isCancelled, isTimeout, isRetryable,
  isGuardRefusal, errorSeverity, errorLabel, errorDisplay,
} from '../src/utils/appError.ts';

const typed = (code: string, message = 'm', detail: string | null = null) =>
  ({ code, message, detail });

// ── normalising ─────────────────────────────────────────────────────────────

test('a typed error passes through with its code', () => {
  const e = toAppError(typed('constraint', 'Duplicate entry'));
  assert.equal(e.code, 'constraint');
  assert.equal(e.message, 'Duplicate entry');
});

test('an unconverted command still returns a string, and its text survives', () => {
  // Conversion is incremental; both shapes must work until it finishes.
  const e = toAppError('Table does not exist');
  assert.equal(e.code, 'unknown');
  assert.equal(e.message, 'Table does not exist');
});

test('a string is NOT re-classified in the frontend', () => {
  // The backend owns classification. Guessing again here would give two
  // sources of truth that disagree at the margins — the thing typing the error
  // was meant to end.
  assert.equal(toAppError('Access denied for user').code, 'unknown');
});

test('an unrecognised code is treated as a string, not trusted', () => {
  const e = toAppError({ code: 'not_a_real_code', message: 'x', detail: null });
  assert.equal(e.code, 'unknown');
});

test('an Error instance yields its message', () => {
  assert.equal(toAppError(new Error('boom')).message, 'boom');
});

test('null and undefined do not throw', () => {
  assert.equal(toAppError(null).code, 'unknown');
  assert.equal(toAppError(undefined).code, 'unknown');
  assert.equal(errorMessage(undefined), 'undefined');
});

// ── the distinction that caused the original bug ────────────────────────────

test('a typed cancellation is one; a typed timeout is NOT', () => {
  assert.ok(isCancelled(typed('cancelled')));
  assert.ok(!isCancelled(typed('timeout')));
  assert.ok(isTimeout(typed('timeout')));
});

test('the string fallback matches the backend wording exactly, not loosely', () => {
  // A /cancel/i match would swallow PostgreSQL's timeout, which is the
  // regression this guards.
  assert.ok(isCancelled('Query cancelled'));
  assert.ok(!isCancelled('ERROR: canceling statement due to statement timeout'));
  assert.ok(!isCancelled('canceling statement due to user request'));
});

test('the string fallback still spots a timeout', () => {
  assert.ok(isTimeout('ERROR: canceling statement due to statement timeout'));
  assert.ok(isTimeout('Lock wait timeout exceeded'));
  assert.ok(!isTimeout('syntax error at or near "slect"'));
});

test('a typed code always wins over the text', () => {
  // If the backend says cancelled, the message is irrelevant.
  assert.ok(isCancelled(typed('cancelled', 'anything at all')));
  assert.ok(!isCancelled(typed('timeout', 'Query cancelled')));
});

// ── policy derived from the code ────────────────────────────────────────────

test('only transient failures are retryable', () => {
  for (const c of ['connection_lost', 'connect_failed', 'timeout']) {
    assert.ok(isRetryable(typed(c)), c);
  }
  for (const c of ['sql_syntax', 'permission_denied', 'constraint', 'cancelled']) {
    assert.ok(!isRetryable(typed(c)), c);
  }
});

test('a guard refusal is distinguishable from a server rejection', () => {
  // "TxUI refused this" and "the server refused this" call for different
  // wording and different next steps.
  assert.ok(isGuardRefusal(typed('guard_refused')));
  assert.ok(!isGuardRefusal(typed('permission_denied')));
});

test('a cancellation is not shown as an error', () => {
  // A red banner for something the user just clicked Cancel on trains people
  // to ignore red banners.
  assert.equal(errorSeverity(typed('cancelled')), 'info');
  assert.equal(errorSeverity(typed('timeout')), 'warn');
  assert.equal(errorSeverity(typed('guard_refused')), 'warn');
  assert.equal(errorSeverity(typed('sql_syntax')), 'error');
  assert.equal(errorSeverity('some raw string'), 'error');
});

test('the label is groupable for telemetry', () => {
  // Counting failures by class is what prose errors made impossible.
  assert.equal(errorLabel(typed('connection_lost')), 'connection lost');
  assert.equal(errorLabel('raw'), 'unknown');
});

// ── an unrecognised code must not cost the message ──────────────────────────

test('an object with an unknown code keeps its message', () => {
  // The failure this prevents: the backend serialized its enum as `Cancelled`
  // rather than `cancelled`, so the code was unrecognised, `String(err)` gave
  // "[object Object]", and the string fallback matched against that — making
  // isCancelled() return FALSE for a real cancellation. A cancel mid-script
  // was then reported as a failed statement, which is the bug the typed path
  // exists to prevent.
  const e = toAppError({ code: 'Cancelled', message: 'Query cancelled', detail: null });
  assert.equal(e.code, 'unknown');
  assert.equal(e.message, 'Query cancelled');
  assert.ok(isCancelled(e), 'the string fallback must still recognise it');
});

test('the detail survives an unrecognised code too', () => {
  const e = toAppError({ code: 'nope', message: 'm', detail: 'server said this' });
  assert.equal(e.detail, 'server said this');
});

test('an object with no message at all is still safe', () => {
  assert.equal(toAppError({ code: 'nope' }).code, 'unknown');
  assert.doesNotThrow(() => toAppError({}));
});

// ── the server's own error number ───────────────────────────────────────────

const withCode = (db_code: string | null, sqlstate: string | null, message = 'm') =>
  ({ code: 'not_found', message, detail: null, db_code, sqlstate });

test('the number leads, because that is what people look up', () => {
  // Verified against MySQL 8.0.46: SELECT * FROM no_such_table.
  assert.equal(
    errorDisplay(withCode('1146', '42S02', "Table 'shop.orders' doesn't exist")),
    "ERROR 1146 (42S02): Table 'shop.orders' doesn't exist");
});

test('PostgreSQL is not made to look like it has two codes', () => {
  // SQLSTATE *is* its code — printing "ERROR 42P01 (42P01)" would be noise.
  assert.equal(
    errorDisplay(withCode('42P01', '42P01', 'relation "orders" does not exist')),
    'ERROR 42P01: relation "orders" does not exist');
});

test('an error with no server number is shown as its message alone', () => {
  // A pool timeout or a TLS failure never reached the server, so inventing a
  // number would be worse than having none.
  assert.equal(errorDisplay(withCode(null, null, 'pool timed out')), 'pool timed out');
});

test('an untyped string error still renders as itself', () => {
  // 94 commands still return strings; they must not become "[object Object]".
  assert.equal(errorDisplay('Lost connection'), 'Lost connection');
});

test('a typed object is never rendered as [object Object]', () => {
  // The regression this guards: `String(err)` on a typed error gives
  // "[object Object]", losing the number AND the sentence at once.
  for (const e of [withCode('1146', '42S02'), withCode(null, null), { code: 'timeout', message: 'x', detail: null }]) {
    assert.ok(!errorDisplay(e).includes('[object Object]'), JSON.stringify(e));
  }
});

test('the number and sqlstate survive normalisation', () => {
  const e = toAppError(withCode('1213', '40001', 'Deadlock found'));
  assert.equal(e.db_code, '1213');
  assert.equal(e.sqlstate, '40001');
});
