/**
 * Long-query OS notification decision layer (src/utils/notify.ts).
 *
 * The notification is the beep's sibling for a window that is not just
 * unfocused-but-audible: same pref-shaped gate, same shared threshold
 * (longQueryBeepSecs), plus the focus check the beep does not need. All of it
 * decided in pure functions here; store/notify.ts only feeds live values in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldNotifyLongQuery, longQueryNotification,
} from '../src/utils/notify.ts';

const ENV = { enabled: true, focused: false, thresholdSecs: 60 };

test('pref off → never notify, however long the run', () => {
  assert.equal(shouldNotifyLongQuery(
    { durationMs: 10 * 60_000, ok: true },
    { ...ENV, enabled: false },
  ), false);
});

test('focused window → never notify (you watched it finish)', () => {
  assert.equal(shouldNotifyLongQuery(
    { durationMs: 10 * 60_000, ok: true },
    { ...ENV, focused: true },
  ), false);
});

test('under the threshold → no notification', () => {
  assert.equal(shouldNotifyLongQuery(
    { durationMs: 59_999, ok: true }, ENV,
  ), false);
  assert.equal(shouldNotifyLongQuery(
    { durationMs: 500, ok: true }, { ...ENV, thresholdSecs: 1 },
  ), false);
});

test('a disabled threshold (0 / negative) never notifies', () => {
  assert.equal(shouldNotifyLongQuery(
    { durationMs: 999_999, ok: true }, { ...ENV, thresholdSecs: 0 },
  ), false);
  assert.equal(shouldNotifyLongQuery(
    { durationMs: 999_999, ok: true }, { ...ENV, thresholdSecs: -5 },
  ), false);
});

test('at/over the threshold, unfocused, enabled → notify', () => {
  assert.equal(shouldNotifyLongQuery({ durationMs: 60_000, ok: true }, ENV), true);
  assert.equal(shouldNotifyLongQuery({ durationMs: 61_000, ok: true }, ENV), true);
  // failures notify too — an error is exactly what you alt-tab back for
  assert.equal(shouldNotifyLongQuery(
    { durationMs: 90_000, ok: false, error: 'boom' }, ENV,
  ), true);
});

test('success payload: statement count + humanized duration', () => {
  assert.deepEqual(
    longQueryNotification({ durationMs: 12_034, ok: true, statements: 2 }),
    { title: 'TxUI — query finished', body: '✓ 2 statements · 12 s 34 ms' },
  );
  // single-statement run: singular, and an omitted count defaults to 1
  assert.deepEqual(
    longQueryNotification({ durationMs: 60_000, ok: true }),
    { title: 'TxUI — query finished', body: '✓ 1 statement · 1 min' },
  );
});

test('failure payload: first line of the error only', () => {
  assert.deepEqual(
    longQueryNotification({ durationMs: 5_000, ok: false, error: '\n  syntax error near "FROM"\n  at line 3' }),
    { title: 'TxUI — query failed', body: '✗ syntax error near "FROM"' },
  );
  // no error text at all still produces a body
  assert.deepEqual(
    longQueryNotification({ durationMs: 5_000, ok: false }),
    { title: 'TxUI — query failed', body: '✗ unknown error' },
  );
});

test('a very long error line is capped for the banner', () => {
  const { body } = longQueryNotification({ durationMs: 5_000, ok: false, error: 'x'.repeat(500) });
  assert.ok(body.length <= 142 + 3, `body too long: ${body.length}`);
  assert.ok(body.endsWith('…'));
});
