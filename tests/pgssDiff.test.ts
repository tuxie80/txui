/**
 * pg_stat_statements snapshot → diff (src/utils/pgssDiff.ts).
 *
 * The counters are cumulative, so the whole value of the module is the
 * subtraction: a later snapshot minus an earlier one is the work done in
 * between. The tests pin the three outcomes of that subtraction — a statement
 * present in both (delta), one only in the later snapshot (new), one only in
 * the earlier (gone) — plus the "biggest total-time increase" ordering the
 * panel leads with, and the reset case where the subtraction lies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QueryResult } from '../src/types';
import {
  rowsToSnapshot, diffPgss, sortByTotalTimeDelta, isActive, detectReset,
  readPgssStatus, pgssSnapshotSql, type PgssSnapshot, type PgssStat,
} from '../src/utils/pgssDiff.ts';

// ── helpers ─────────────────────────────────────────────────────────────────

function qr(rows: unknown[][]): QueryResult {
  return { columns: [], rows, rows_affected: null, execution_ms: 0, fetch_ms: 0, warnings: [] };
}

/** A pgss row in the fixed pgssSnapshotSql column order. */
function row(
  queryid: string, query: string, calls: number,
  total: number, mean: number, rows: number, hit = 0, read = 0,
): unknown[] {
  return [queryid, query, calls, total, mean, rows, hit, read];
}

function snap(capturedAt: number, stats: PgssStat[]): PgssSnapshot {
  return { capturedAt, stats: new Map(stats.map(s => [s.queryid, s])) };
}

function stat(p: Partial<PgssStat> & { queryid: string }): PgssStat {
  return {
    query: `q-${p.queryid}`, calls: 0, totalExecTime: 0, meanExecTime: 0,
    rows: 0, sharedBlksHit: 0, sharedBlksRead: 0, ...p,
  };
}

// ── rowsToSnapshot ───────────────────────────────────────────────────────────

test('rowsToSnapshot keys by queryid, coerces stringy numerics, drops null ids', () => {
  const s = rowsToSnapshot(qr([
    row('100', 'SELECT 1', '5', '250.5', '50.1', '5'),   // bridge stringified
    row('200', 'SELECT 2', 3, 30, 10, 9),
    [null, '<insufficient privilege>', 1, 1, 1, 0, 0, 0], // filtered
  ]), 1000);
  assert.equal(s.capturedAt, 1000);
  assert.equal(s.stats.size, 2);
  const a = s.stats.get('100')!;
  assert.equal(a.calls, 5);
  assert.equal(a.totalExecTime, 250.5);
  assert.equal(a.meanExecTime, 50.1);
  assert.ok(!s.stats.has(''));
});

test('rowsToSnapshot collapses a duplicate queryid, summing counters and recomputing mean', () => {
  const s = rowsToSnapshot(qr([
    row('1', 'SELECT', 4, 40, 10, 4),
    row('1', 'SELECT', 6, 60, 10, 6),
  ]), 0);
  const st = s.stats.get('1')!;
  assert.equal(st.calls, 10);
  assert.equal(st.totalExecTime, 100);
  assert.equal(st.meanExecTime, 10);   // 100 / 10, not the raw last row
  assert.equal(st.rows, 10);
});

// ── diff: changed / new / gone ───────────────────────────────────────────────

test('a statement in both snapshots is "changed" with interval deltas', () => {
  const before = snap(0, [stat({ queryid: '1', calls: 100, totalExecTime: 1000, meanExecTime: 10, rows: 100 })]);
  const after = snap(1, [stat({ queryid: '1', calls: 150, totalExecTime: 3000, meanExecTime: 20, rows: 150 })]);
  const [e] = diffPgss(before, after);
  assert.equal(e.status, 'changed');
  assert.equal(e.deltaCalls, 50);
  assert.equal(e.deltaTotalTime, 2000);
  assert.equal(e.deltaRows, 50);
  assert.equal(e.deltaMeanTime, 10);   // got slower per call
  assert.equal(e.beforeTotalTime, 1000);
  assert.equal(e.afterTotalTime, 3000);
});

test('a statement only in the later snapshot is "new" with a zero baseline', () => {
  const before = snap(0, []);
  const after = snap(1, [stat({ queryid: '9', calls: 7, totalExecTime: 700, meanExecTime: 100, rows: 7 })]);
  const [e] = diffPgss(before, after);
  assert.equal(e.status, 'new');
  assert.equal(e.deltaCalls, 7);
  assert.equal(e.deltaTotalTime, 700);
  assert.equal(e.beforeCalls, 0);
  assert.equal(e.afterCalls, 7);
});

test('a statement only in the earlier snapshot is "gone" with negative deltas', () => {
  const before = snap(0, [stat({ queryid: '5', calls: 20, totalExecTime: 500, meanExecTime: 25, rows: 20 })]);
  const after = snap(1, []);
  const [e] = diffPgss(before, after);
  assert.equal(e.status, 'gone');
  assert.equal(e.deltaCalls, -20);
  assert.equal(e.deltaTotalTime, -500);
  assert.equal(e.afterTotalTime, 0);
});

test('changed picks the later query text when it differs', () => {
  const before = snap(0, [stat({ queryid: '1', query: 'old text' })]);
  const after = snap(1, [stat({ queryid: '1', query: 'new text' })]);
  assert.equal(diffPgss(before, after)[0].query, 'new text');
});

// ── sorting ──────────────────────────────────────────────────────────────────

test('sortByTotalTimeDelta ranks the biggest total-time increase first', () => {
  const before = snap(0, [
    stat({ queryid: 'a', calls: 10, totalExecTime: 100 }),
    stat({ queryid: 'b', calls: 10, totalExecTime: 100 }),
    stat({ queryid: 'c', calls: 10, totalExecTime: 100 }),
  ]);
  const after = snap(1, [
    stat({ queryid: 'a', calls: 11, totalExecTime: 150 }),   // +50
    stat({ queryid: 'b', calls: 20, totalExecTime: 5000 }),  // +4900  ← worst
    stat({ queryid: 'c', calls: 10, totalExecTime: 90 }),    // -10 (improved)
  ]);
  const sorted = sortByTotalTimeDelta(diffPgss(before, after));
  assert.deepEqual(sorted.map(e => e.queryid), ['b', 'a', 'c']);
  assert.equal(sorted[0].deltaTotalTime, 4900);
});

test('sortByTotalTimeDelta breaks ties deterministically and does not mutate input', () => {
  const entries = diffPgss(
    snap(0, [stat({ queryid: 'z' }), stat({ queryid: 'a' })]),
    snap(1, [
      stat({ queryid: 'z', calls: 5, totalExecTime: 100 }),
      stat({ queryid: 'a', calls: 5, totalExecTime: 100 }),
    ]),
  );
  const before = entries.map(e => e.queryid);
  const sorted = sortByTotalTimeDelta(entries);
  // equal deltaTotalTime + equal deltaCalls → queryid ascending
  assert.deepEqual(sorted.map(e => e.queryid), ['a', 'z']);
  assert.deepEqual(entries.map(e => e.queryid), before); // original untouched
});

// ── isActive filter ──────────────────────────────────────────────────────────

test('isActive drops a changed row that never ran but keeps new/gone', () => {
  const idle = diffPgss(
    snap(0, [stat({ queryid: '1', calls: 10, totalExecTime: 100 })]),
    snap(1, [stat({ queryid: '1', calls: 10, totalExecTime: 100 })]),
  )[0];
  assert.equal(isActive(idle), false);

  const fresh = diffPgss(snap(0, []), snap(1, [stat({ queryid: '2', calls: 1 })]))[0];
  const gone = diffPgss(snap(0, [stat({ queryid: '3', calls: 1 })]), snap(1, []))[0];
  assert.equal(isActive(fresh), true);
  assert.equal(isActive(gone), true);
});

// ── reset detection ──────────────────────────────────────────────────────────

test('detectReset fires when a matched statement lost calls, else stays quiet', () => {
  const before = snap(0, [stat({ queryid: '1', calls: 100 })]);
  const grew = snap(1, [stat({ queryid: '1', calls: 120 })]);
  const shrank = snap(1, [stat({ queryid: '1', calls: 3 })]);   // reset under it
  assert.equal(detectReset(before, grew), false);
  assert.equal(detectReset(before, shrank), true);
  // a "gone" statement is not evidence of a reset on its own
  assert.equal(detectReset(before, snap(1, [])), false);
});

// ── edge cases ───────────────────────────────────────────────────────────────

test('diffing two empty snapshots yields nothing', () => {
  assert.deepEqual(diffPgss(snap(0, []), snap(1, [])), []);
});

test('reversing before/after negates every delta', () => {
  const x = snap(0, [stat({ queryid: '1', calls: 10, totalExecTime: 100 })]);
  const y = snap(1, [stat({ queryid: '1', calls: 40, totalExecTime: 900 })]);
  const fwd = diffPgss(x, y)[0];
  const rev = diffPgss(y, x)[0];
  assert.equal(fwd.deltaTotalTime, 800);
  assert.equal(rev.deltaTotalTime, -800);
});

// ── availability + SQL builder ───────────────────────────────────────────────

test('readPgssStatus classifies installed / available / absent', () => {
  assert.deepEqual(readPgssStatus(['1.10', '1.10']),
    { installed: true, available: true, installedVersion: '1.10', availableVersion: '1.10' });
  assert.deepEqual(readPgssStatus([null, '1.11']),
    { installed: false, available: true, installedVersion: null, availableVersion: '1.11' });
  assert.deepEqual(readPgssStatus([null, null]),
    { installed: false, available: false, installedVersion: null, availableVersion: null });
  assert.deepEqual(readPgssStatus(undefined),
    { installed: false, available: false, installedVersion: null, availableVersion: null });
});

test('pgssSnapshotSql uses exec-time columns on PG13+ and legacy names before', () => {
  const modern = pgssSnapshotSql(true);
  assert.match(modern, /total_exec_time AS total_exec_time/);
  assert.match(modern, /mean_exec_time AS mean_exec_time/);
  const legacy = pgssSnapshotSql(false);
  assert.match(legacy, /total_time AS total_exec_time/);
  assert.match(legacy, /mean_time AS mean_exec_time/);
  assert.match(legacy, /queryid IS NOT NULL/);
});
