/**
 * UI deadline (src/utils/withDeadline.ts).
 *
 * The bug this prevents: a connection row stuck on "connecting" forever
 * because the call it was waiting on never settled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline, DeadlineError, connectDeadlineMs } from '../src/utils/withDeadline.ts';

const later = <T>(v: T, ms: number) => new Promise<T>(r => setTimeout(() => r(v), ms));

test('a promise that settles in time passes straight through', async () => {
  assert.equal(await withDeadline(later('ok', 5), 200), 'ok');
});

test('a promise that never settles rejects with the elapsed deadline', async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    () => withDeadline(never, 30),
    (e: unknown) => e instanceof DeadlineError && /timed out after/.test((e as Error).message),
  );
});

test('the original rejection is preserved, not replaced by the deadline', async () => {
  // A real connection error must reach the user as itself — being wrapped in
  // "timed out" would hide "password authentication failed".
  await assert.rejects(
    () => withDeadline(Promise.reject(new Error('auth failed')), 500),
    /auth failed/,
  );
});

test('a non-positive deadline means no deadline, not instant failure', async () => {
  // A mis-configured timeout must not make every connection fail immediately.
  assert.equal(await withDeadline(later('ok', 5), 0), 'ok');
  assert.equal(await withDeadline(later('ok', 5), -1), 'ok');
});

test('the timer is cleared once settled', async () => {
  // Left running, every attempt would keep the process alive for the full
  // deadline — visible in tests as a hang, and in the app as a leak.
  const before = process.getActiveResourcesInfo?.().filter(r => r === 'Timeout').length ?? 0;
  await withDeadline(later('ok', 1), 60_000);
  const after = process.getActiveResourcesInfo?.().filter(r => r === 'Timeout').length ?? 0;
  assert.equal(after, before);
});

test('connectDeadlineMs: connection timeout plus grace, 15 s default', () => {
  // The sidebar and the form's Test share this schedule — a connect the UI
  // watches must never outlive the backend's own bound by less than the
  // handshake grace.
  assert.equal(connectDeadlineMs({}), 23_000);
  assert.equal(connectDeadlineMs({ connect_timeout_secs: null }), 23_000);
  assert.equal(connectDeadlineMs({ connect_timeout_secs: 5 }), 13_000);
  // An explicit 0 is honoured (backend: no timeout) rather than read as unset.
  assert.equal(connectDeadlineMs({ connect_timeout_secs: 0 }), 8_000);
});
