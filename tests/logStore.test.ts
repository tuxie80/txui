/**
 * The session log and the joined run log (src/store/logStore.ts).
 *
 * The property under test is the one the per-session design could not give:
 * **the record of a connection survives the connection**. When something went
 * wrong twenty minutes ago, the session you want to read is usually the one
 * you have since closed — and `dropLog` frees that bucket at disconnect. So
 * every entry is also appended to a run-wide list that `dropLog` does not
 * touch, tagged with the session that wrote it and the connection's name at
 * the time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addLog, clearLog, clearRunLog, dropLog, formatLog, formatRunLog,
  runLine, runLogEntries, runSessionCount, setSessionLabel, canonicalLine, restoreRunLog } from '../src/store/logStore.ts';

function reset() {
  clearRunLog();
  clearLog('a');
  clearLog('b');
}

test('an entry lands in its session bucket and in the run log', () => {
  reset();
  setSessionLabel('a', 'prod-mysql');
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'select 1', line: 'select 1' });
  assert.match(formatLog('a'), /select 1/);
  assert.equal(runLogEntries().length, 1);
  assert.equal(runLogEntries()[0].label, 'prod-mysql');
  assert.equal(runLogEntries()[0].sessionId, 'a');
});

test('disconnecting frees the session bucket and keeps the run log', () => {
  // The whole point: the closed connection is the one you want to read.
  reset();
  setSessionLabel('a', 'prod-mysql');
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'select 1', line: 'select 1' });
  addLog('a', { level: 'info', action: 'DISCONNECT', detail: 'bye', line: 'Disconnected from prod-mysql' });
  dropLog('a');
  assert.equal(formatLog('a').trim(), '');            // bucket gone
  assert.equal(runLogEntries().length, 2);             // record kept
  assert.match(formatRunLog(), /Disconnected from prod-mysql/);
});

test('two connections interleave in one chronological list', () => {
  reset();
  setSessionLabel('a', 'prod');
  setSessionLabel('b', 'staging');
  addLog('a', { level: 'ok', action: 'QUERY', detail: '1', line: 'first on prod' });
  addLog('b', { level: 'ok', action: 'QUERY', detail: '2', line: 'first on staging' });
  addLog('a', { level: 'ok', action: 'QUERY', detail: '3', line: 'second on prod' });

  const text = formatRunLog();
  assert.ok(text.indexOf('first on prod') < text.indexOf('first on staging'));
  assert.ok(text.indexOf('first on staging') < text.indexOf('second on prod'));
  assert.equal(runSessionCount(), 2);
});

test('every joined line names its connection', () => {
  // Without it, "3 rows affected in 12 ms" from two servers is the same line
  // twice — which is exactly the confusion the joined view exists to remove.
  reset();
  setSessionLabel('a', 'prod');
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'x', line: '3 rows affected in 12 ms' });
  assert.match(runLine(runLogEntries()[0]), /\[prod\] 3 rows affected in 12 ms$/);
  assert.match(formatRunLog(), /\[prod\]/);
});

test('an unlabelled session still traces back to its id', () => {
  reset();
  addLog('deadbeef-1234', { level: 'info', action: 'CONNECT', detail: 'x', line: 'connecting' });
  assert.match(runLine(runLogEntries()[0]), /\[deadbeef\]/);
});

test('the label is stamped at write time, not read time', () => {
  // A session id can be reused and a connection renamed; rewriting history to
  // match the current name would make an old line say something that was not
  // true when it happened.
  reset();
  setSessionLabel('a', 'old-name');
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'x', line: 'early' });
  setSessionLabel('a', 'new-name');
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'y', line: 'late' });
  assert.match(runLine(runLogEntries()[0]), /\[old-name\]/);
  assert.match(runLine(runLogEntries()[1]), /\[new-name\]/);
});

test('clearing one scope leaves the other alone', () => {
  reset();
  setSessionLabel('a', 'prod');
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'x', line: 'kept' });
  clearLog('a');
  assert.equal(formatLog('a').trim(), '');
  assert.equal(runLogEntries().length, 1, 'clearing a connection must not erase the joined record');

  addLog('a', { level: 'ok', action: 'QUERY', detail: 'y', line: 'also kept' });
  clearRunLog();
  assert.equal(runLogEntries().length, 0);
  assert.match(formatLog('a'), /also kept/, 'clearing the joined log must not erase a live connection\'s own');
});

test('both renderings carry the same canonical message and stamp', () => {
  reset();
  setSessionLabel('a', 'prod');
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'x', line: '1 row retrieved in 3 ms' });
  const e = runLogEntries()[0];
  assert.equal(canonicalLine(e), `${e.stamp} 1 row retrieved in 3 ms`);
  assert.equal(runLine(e), `${e.stamp} [prod] 1 row retrieved in 3 ms`);
});

test('an export carries a header and one line per entry', () => {
  reset();
  setSessionLabel('a', 'prod');
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'x', line: 'one' });
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'y', line: 'two' });
  const out = formatRunLog('TxUI log — all connections');
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'TxUI log — all connections');
  assert.match(lines[1], /^─+$/);
  assert.equal(lines.length, 4);
});

// ── surviving a restart ─────────────────────────────────────────────────────

test('the joined log tail is restored, and marked as a previous run', () => {
  // Closing the app the evening of an incident and finding an empty list the
  // next morning is the wrong end of the day to lose it. But a restored line
  // that looks like a live one is worse than no restore at all.
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  try {
    // Cleared FIRST: clearing also drops the mirror, deliberately — leaving it
    // behind would resurrect everything on the next start.
    clearRunLog();
    store.set('dbgui.runlog.v1', JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      entries: [{
        ts: '09:00:00.000', stamp: '[2026-08-09 09:00:00]', level: 'ok',
        action: 'QUERY', detail: 'x', line: 'yesterday', sessionId: 'a', label: 'prod',
      }],
    }));
    assert.equal(restoreRunLog(), 1);
    const e = runLogEntries()[0];
    assert.equal(e.previousRun, true);
    assert.match(runLine(e), /\(previous run\) \[prod\] yesterday$/);
  } finally {
    clearRunLog();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('a payload of the wrong shape is ignored rather than half-read', () => {
  const store = new Map<string, string>([['dbgui.runlog.v1', '{"v":99,"entries":[]}']]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: () => {}, removeItem: () => {},
  };
  try {
    clearRunLog();
    assert.equal(restoreRunLog(), 0);
    assert.equal(runLogEntries().length, 0);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('restoring is a no-op once the run has written anything of its own', () => {
  // Otherwise a late restore would interleave yesterday into the middle of
  // today, in a list whose whole value is that it is chronological.
  clearRunLog();
  setSessionLabel('a', 'prod');
  addLog('a', { level: 'ok', action: 'QUERY', detail: 'x', line: 'today' });
  assert.equal(restoreRunLog(), 0);
  assert.equal(runLogEntries().length, 1);
  clearRunLog();
});

// ── WP-06 6.1: version-counter store — no clone per emit ───────────────────

test('appends notify subscribers without cloning the buffer', async () => {
  const { subscribeRunLog, runLogVersion } = await import('../src/store/logStore.ts');
  reset();
  let notified = 0;
  const unsub = subscribeRunLog(() => { notified++; });
  const before = runLogEntries();          // the live internal buffer
  const v0 = runLogVersion();
  for (let i = 0; i < 100; i++) {
    addLog('a', { level: 'ok', action: 'QUERY', detail: String(i), line: `q${i}` });
  }
  unsub();
  assert.equal(notified, 100, 'one notification per append');
  assert.equal(runLogVersion(), v0 + 100, 'version bumps once per append');
  // Identity is stable: change is signalled by the version, not by cloning
  // 20 000 entries into a fresh array on every log line.
  assert.equal(runLogEntries(), before);
  assert.equal(runLogEntries().length, 100);
});
