/**
 * Wait-event sampling aggregation (src/utils/waitAgg.ts).
 *
 * The arithmetic a sampling profiler lives or dies by: what counts as an
 * observation, that an idle backend does not inflate CPU, that percentages are
 * of the grand total, and that the ring stays bounded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate, pushSnapshot, bucketOf, CPU_BUCKET,
  type Snapshot, type WaitBackend,
} from '../src/utils/waitAgg.ts';

const be = (p: Partial<WaitBackend>): WaitBackend => ({
  pid: 1, waitEventType: null, waitEvent: null, state: 'active', query: null, ...p,
});

const snap = (backends: WaitBackend[], atMs = 0): Snapshot => ({ atMs, backends });

// ── bucketOf ────────────────────────────────────────────────────────────────

test('a backend with a wait event is bucketed by type and event', () => {
  assert.deepEqual(
    bucketOf(be({ waitEventType: 'LWLock', waitEvent: 'WALWrite' })),
    { type: 'LWLock', event: 'WALWrite' },
  );
});

test('a running backend with no wait event is on CPU', () => {
  assert.deepEqual(bucketOf(be({ state: 'active' })), { type: CPU_BUCKET, event: CPU_BUCKET });
});

test('an idle backend with no wait event contributes nothing', () => {
  assert.equal(bucketOf(be({ state: 'idle' })), null);
});

test('a wait event without an event name falls back to the type', () => {
  assert.deepEqual(
    bucketOf(be({ waitEventType: 'Timeout', waitEvent: null })),
    { type: 'Timeout', event: 'Timeout' },
  );
});

// ── aggregate ─────────────────────────────────────────────────────────────

test('percentages are of the total observations and sum to ~100', () => {
  // Two snapshots, three counted observations per snapshot = 6 total.
  const ring: Snapshot[] = [
    snap([
      be({ pid: 1, waitEventType: 'LWLock', waitEvent: 'WALWrite' }),
      be({ pid: 2, waitEventType: 'IO', waitEvent: 'DataFileRead' }),
      be({ pid: 3, state: 'active' }), // CPU
    ]),
    snap([
      be({ pid: 1, waitEventType: 'LWLock', waitEvent: 'WALWrite' }),
      be({ pid: 2, waitEventType: 'LWLock', waitEvent: 'BufferMapping' }),
      be({ pid: 3, state: 'idle' }), // dropped
      be({ pid: 4, state: 'active' }), // CPU
    ]),
  ];
  const agg = aggregate(ring);
  assert.equal(agg.samples, 2);
  assert.equal(agg.observations, 6);

  // Top-level: LWLock seen 3×, CPU 2×, IO 1×.
  assert.deepEqual(agg.byType.map(b => [b.type, b.count]), [
    ['LWLock', 3], [CPU_BUCKET, 2], ['IO', 1],
  ]);
  const sum = agg.byType.reduce((s, b) => s + b.pct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, `byType pct summed to ${sum}`);
  assert.ok(Math.abs(agg.byType[0].pct - 50) < 1e-9, 'LWLock is 3/6 = 50%');
});

test('byEvent splits a type into its distinct events', () => {
  const agg = aggregate([snap([
    be({ pid: 1, waitEventType: 'LWLock', waitEvent: 'WALWrite' }),
    be({ pid: 2, waitEventType: 'LWLock', waitEvent: 'WALWrite' }),
    be({ pid: 3, waitEventType: 'LWLock', waitEvent: 'BufferMapping' }),
  ])]);
  assert.deepEqual(agg.byType.map(b => [b.type, b.count]), [['LWLock', 3]]);
  assert.deepEqual(agg.byEvent.map(b => [b.event, b.count]), [
    ['WALWrite', 2], ['BufferMapping', 1],
  ]);
});

test('an empty ring aggregates to zeroes, not a divide-by-zero', () => {
  const agg = aggregate([]);
  assert.equal(agg.samples, 0);
  assert.equal(agg.observations, 0);
  assert.deepEqual(agg.byType, []);
  assert.deepEqual(agg.byEvent, []);
});

test('a snapshot of only idle backends counts as a sample with no observations', () => {
  const agg = aggregate([snap([be({ state: 'idle' }), be({ state: 'idle' })])]);
  assert.equal(agg.samples, 1);
  assert.equal(agg.observations, 0);
});

// ── pushSnapshot ──────────────────────────────────────────────────────────

test('pushSnapshot keeps the newest and drops the oldest past the cap', () => {
  let ring: Snapshot[] = [];
  for (let i = 0; i < 5; i++) ring = pushSnapshot(ring, snap([], i), 3);
  assert.equal(ring.length, 3);
  assert.deepEqual(ring.map(s => s.atMs), [2, 3, 4], 'oldest fell off the front');
});

test('pushSnapshot does not mutate the input array', () => {
  const ring: Snapshot[] = [snap([], 1)];
  const next = pushSnapshot(ring, snap([], 2), 10);
  assert.equal(ring.length, 1, 'input untouched');
  assert.equal(next.length, 2);
});
