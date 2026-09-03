/**
 * Long-running-query helpers (src/utils/longQuery.ts): threshold classes and
 * the watchdog detected-list fold used by the ⏱ panel's "Watch server" mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  longClass, truncateSql, updateWatchList, WATCH_LIST_CAP,
} from '../src/utils/longQuery.ts';
import type { WatchEntry, WatchRow } from '../src/utils/longQuery.ts';

const row = (over: Partial<WatchRow> = {}): WatchRow => ({
  id: 11, time: 0, user: 'app', host: '10.0.0.1:5001', db: 'shop',
  state: 'executing', sql: 'SELECT * FROM orders', ...over,
});

// ── longClass ─────────────────────────────────────────────────────────────────

test('longClass: below threshold → none, >= threshold → warn, >= 2× → danger', () => {
  assert.equal(longClass(29, 30), '');
  assert.equal(longClass(30, 30), 'warn');
  assert.equal(longClass(59, 30), 'warn');
  assert.equal(longClass(60, 30), 'danger');
  assert.equal(longClass(600, 30), 'danger');
  assert.equal(longClass(10, 0), '', 'a zero threshold disables highlighting');
  assert.equal(longClass(NaN, 30), '', 'a missing/unparseable Time never tints');
});

// ── truncateSql ───────────────────────────────────────────────────────────────

test('truncateSql collapses whitespace and caps length with an ellipsis', () => {
  assert.equal(truncateSql('SELECT  *\nFROM   t', 160), 'SELECT * FROM t');
  const long = 'x'.repeat(500);
  const out = truncateSql(long, 160);
  assert.equal(out.length, 160);
  assert.ok(out.endsWith('…'));
  assert.equal(truncateSql('short', 160), 'short');
});

// ── updateWatchList ───────────────────────────────────────────────────────────

test('a query enters the list only once its age crosses the threshold', () => {
  const r1 = updateWatchList([], [row({ time: 10 })], 60, 1000);
  assert.equal(r1.entries.length, 0, 'sub-threshold polls detect nothing');
  const r2 = updateWatchList([], [row({ time: 61 })], 60, 1000);
  assert.equal(r2.entries.length, 1);
  assert.equal(r2.newOnes.length, 1);
  assert.equal(r2.newOnes[0].firstSeen, 1000);
  assert.equal(r2.newOnes[0].gone, false);
});

test('a live entry updates in place and is reported as new only once', () => {
  const r1 = updateWatchList([], [row({ time: 61 })], 60, 1000);
  const r2 = updateWatchList(r1.entries, [row({ time: 65, state: 'Sending data' })], 60, 2000);
  assert.equal(r2.entries.length, 1);
  assert.equal(r2.newOnes.length, 0, 'no duplicate detection');
  const e = r2.entries[0];
  assert.equal(e.age, 65);
  assert.equal(e.state, 'Sending data');
  assert.equal(e.firstSeen, 1000, 'firstSeen is sticky');
  assert.equal(e.lastSeen, 2000);
  assert.notEqual(e, r1.entries[0], 'entries are copied, never mutated');
});

test('a vanished entry is marked gone and kept (until Clear)', () => {
  const r1 = updateWatchList([], [row({ time: 61 })], 60, 1000);
  const r2 = updateWatchList(r1.entries, [], 60, 2000);
  assert.equal(r2.entries.length, 1);
  assert.equal(r2.entries[0].gone, true);
  assert.equal(r2.newOnes.length, 0);
});

test('a thread that dropped below threshold counts as finished (TIME reset)', () => {
  const r1 = updateWatchList([], [row({ time: 61 })], 60, 1000);
  const r2 = updateWatchList(r1.entries, [row({ time: 3 })], 60, 2000);
  assert.equal(r2.entries[0].gone, true);
});

test('id reuse: a qualifying row on a gone id is a NEW detection', () => {
  const r1 = updateWatchList([], [row({ time: 61 })], 60, 1000);
  const r2 = updateWatchList(r1.entries, [], 60, 2000);           // gone
  const r3 = updateWatchList(r2.entries, [row({ time: 70, user: 'etl' })], 60, 3000);
  assert.equal(r3.entries.length, 1, 'the stale record is replaced');
  assert.equal(r3.newOnes.length, 1);
  assert.equal(r3.newOnes[0].user, 'etl');
  assert.equal(r3.newOnes[0].firstSeen, 3000);
});

test('live entries sort by age desc, gone after live', () => {
  const r1 = updateWatchList([], [row({ id: 1, time: 61 }), row({ id: 2, time: 90 })], 60, 1000);
  const r2 = updateWatchList(r1.entries, [row({ id: 2, time: 95 })], 60, 2000);
  assert.deepEqual(r2.entries.map(e => e.id), [2, 1]);
  assert.equal(r2.entries[1].gone, true);
});

test('the list is capped, shedding the oldest gone entries first', () => {
  let entries: WatchEntry[] = [];
  // one live query
  entries = updateWatchList(entries, [row({ id: 1, time: 100 })], 60, 1000).entries;
  // WATCH_LIST_CAP finished ones
  for (let i = 0; i < WATCH_LIST_CAP + 10; i++) {
    entries = updateWatchList(
      entries,
      [row({ id: 1, time: 100 + i }), row({ id: 100 + i, time: 80 })],
      60, 2000 + i,
    ).entries;
    entries = updateWatchList(entries, [row({ id: 1, time: 101 + i })], 60, 3000 + i).entries;
  }
  assert.ok(entries.length <= WATCH_LIST_CAP);
  assert.ok(entries.some(e => e.id === 1 && !e.gone), 'live entries are never shed');
});
