/**
 * Status-bar running-tasks rows (src/utils/runningTasks.ts).
 *
 * The popover lists everything the tab-activity registry knows is still
 * running on a server; these cover the pure shaping — naming, elapsed time,
 * and the can/cannot-stop flag the Stop button greys on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRunningTasks, type ActivityEntry } from '../src/utils/runningTasks.ts';

const entry = (over: Partial<ActivityEntry> & { activity: Partial<ActivityEntry['activity']> }): ActivityEntry => ({
  key: 's1|sql:1',
  sessionId: 's1',
  ...over,
  activity: { id: 'query', label: 'Running query', detail: 'SELECT 1', hasKill: true, ...over.activity },
});

test('one row per activity, in registration order', () => {
  const rows = collectRunningTasks([
    entry({ key: 's1|sql:1', sessionId: 's1' }),
    entry({ key: 's1|panel:datagen', sessionId: 's1', activity: { id: 'generate', label: 'Generating data' } }),
    entry({ key: 's2|sql:2', sessionId: 's2', activity: { id: 'query', label: 'Running query' } }),
  ], () => undefined, 0);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.label), ['Running query', 'Generating data', 'Running query']);
});

test('the session name resolves, falling back to the session id', () => {
  const names = new Map([['s1', 'prod-mysql']]);
  const [known, gone] = collectRunningTasks([
    entry({ sessionId: 's1' }),
    entry({ key: 's2|sql:4', sessionId: 's2' }),
  ], id => names.get(id), 0);
  assert.equal(known.sessionName, 'prod-mysql');
  // The session may already be closing when the popover reads the registry —
  // a raw id beats a blank or a crash.
  assert.equal(gone.sessionName, 's2');
});

test('row keys stay unique when several tabs of one session run the same kind', () => {
  const rows = collectRunningTasks([
    entry({ key: 's1|sql:1' }),
    entry({ key: 's1|sql:2' }),
  ], () => undefined, 0);
  assert.notEqual(rows[0].key, rows[1].key);
});

test('elapsed is the compact duration since the registration stamp', () => {
  const startedAt = 10_000;
  const [row] = collectRunningTasks(
    [entry({ activity: { startedAt } })],
    () => undefined, startedAt + 12_300);
  assert.equal(row.elapsed, '12.3s');
});

test('a registration without a start time shows no elapsed, never a negative one', () => {
  const [noStamp, skewed] = collectRunningTasks([
    entry({}),
    entry({ key: 's1|sql:2', activity: { startedAt: 5_000 } }),
  ], () => undefined, 2_000);   // clock behind the stamp (clock skew)
  assert.equal(noStamp.elapsed, null);
  assert.equal(skewed.elapsed, '0ms');
});

test('canStop mirrors the presence of a kill closure', () => {
  const [stoppable, notStoppable] = collectRunningTasks([
    entry({ activity: { hasKill: true } }),
    entry({ key: 's1|panel:csvimport', activity: { id: 'import', hasKill: false } }),
  ], () => undefined, 0);
  assert.equal(stoppable.canStop, true);
  assert.equal(notStoppable.canStop, false);
});

test('threads default to an empty list', () => {
  const [row] = collectRunningTasks([entry({})], () => undefined, 0);
  assert.deepEqual(row.threads, []);
});
