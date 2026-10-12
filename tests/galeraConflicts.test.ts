/**
 * tests for src/utils/galeraConflicts.ts — the cert-failure / bf-abort rate
 * math against previous snapshots, the consecutive-poll streaks, the two
 * findings (multi-writer hotspot, conflict victim) and the card-stat format.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictRates, trackConflictStreaks, conflictFindings, formatConflictStat,
  CONFLICT_MIN_STREAK, type ConflictRates, type ConflictStreak,
} from '../src/utils/galeraConflicts.ts';
import type { NodeSnapshot } from '../src/utils/galeraCluster.ts';

function snap(id: string, atMs: number, over: {
  ok?: boolean; cert?: string; bf?: string; repl?: string; recv?: string; size?: string;
} = {}): NodeSnapshot {
  const status: [string, string][] = [
    ['wsrep_cluster_size', over.size ?? '3'],
    ['wsrep_local_cert_failures', over.cert ?? '0'],
    ['wsrep_local_bf_aborts', over.bf ?? '0'],
    ['wsrep_replicated', over.repl ?? '0'],
    ['wsrep_received', over.recv ?? '0'],
    ['wsrep_local_state_comment', 'Synced'],
    ['wsrep_cluster_status', 'Primary'],
  ];
  return {
    connectionId: id,
    connectionName: id,
    ok: over.ok ?? true,
    error: null,
    statusRows: status,
    variableRows: [['wsrep_on', 'ON'], ['wsrep_cluster_name', 'db']],
    elapsedMs: 5,
    polledAtMs: atMs,
  };
}

describe('conflictRates', () => {
  test('no baseline or failed polls → nulls (dash, not zero)', () => {
    const cur = snap('a', 5000, { cert: '7' });
    assert.deepEqual(conflictRates(cur, undefined), { certPerSec: null, bfPerSec: null });
    assert.deepEqual(conflictRates(cur, snap('a', 0, { ok: false })), { certPerSec: null, bfPerSec: null });
    assert.deepEqual(conflictRates(snap('a', 5000, { ok: false }), snap('a', 0)), { certPerSec: null, bfPerSec: null });
  });

  test('delta over the interval; counter reset → null', () => {
    const prev = snap('a', 0, { cert: '10', bf: '4' });
    const cur = snap('a', 5000, { cert: '20', bf: '4' });
    const r = conflictRates(cur, prev);
    assert.equal(r.certPerSec, 2);      // 10 failures / 5 s
    assert.equal(r.bfPerSec, 0);
    // Restart / FLUSH STATUS: counter went DOWN — unreadable, not negative.
    const reset = snap('a', 10_000, { cert: '1' });
    assert.equal(conflictRates(reset, cur).certPerSec, null);
  });
});

describe('trackConflictStreaks', () => {
  test('positive increments, zero and null both reset', () => {
    const rates = new Map<string, ConflictRates>();
    rates.set('a', { certPerSec: 0.5, bfPerSec: 0 });
    rates.set('b', { certPerSec: 0, bfPerSec: null });
    let streaks: Record<string, ConflictStreak> = {};
    streaks = trackConflictStreaks(rates, streaks);
    assert.deepEqual(streaks, { a: { cert: 1, bf: 0 }, b: { cert: 0, bf: 0 } });
    streaks = trackConflictStreaks(rates, streaks);
    assert.equal(streaks.a.cert, 2);
    rates.set('a', { certPerSec: null, bfPerSec: 1 });
    streaks = trackConflictStreaks(rates, streaks);
    assert.equal(streaks.a.cert, 0, 'an unreadable interval breaks the run');
    assert.equal(streaks.a.bf, 1);
    // A node that vanished from the poll drops out of the map.
    streaks = trackConflictStreaks(new Map(), streaks);
    assert.deepEqual(streaks, {});
  });
});

describe('conflictFindings', () => {
  const nodes = [
    { connectionId: 'a', display: 'A' },
    { connectionId: 'b', display: 'B' },
    { connectionId: 'c', display: 'C' },
  ];

  test('cert failures sustained on >1 node → multi-writer hotspot', () => {
    const streaks = { a: { cert: CONFLICT_MIN_STREAK, bf: 0 }, b: { cert: 3, bf: 0 } };
    const f = conflictFindings(nodes, streaks);
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'warn');
    assert.ok(f[0].title.includes('A, B'));
    assert.ok(f[0].title.toLowerCase().includes('multi-writer'));
  });

  test('cert failures on ONE node only → no hotspot finding', () => {
    const f = conflictFindings(nodes, { a: { cert: 5, bf: 0 } });
    assert.deepEqual(f, []);
  });

  test('a streak below the sustain threshold is a blip, not a finding', () => {
    const f = conflictFindings(nodes, {
      a: { cert: CONFLICT_MIN_STREAK - 1, bf: 0 }, b: { cert: 1, bf: 0 },
    });
    assert.deepEqual(f, []);
  });

  test('bf aborts concentrated on one node → the conflict-victim finding', () => {
    const f = conflictFindings(nodes, { c: { cert: 0, bf: 2 } }, ['A', 'B']);
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'warn');
    assert.ok(f[0].title.includes('C is the conflict victim'));
    assert.ok(f[0].title.includes('A, B'));
  });

  test('bf aborts on several nodes → no single-victim claim', () => {
    const f = conflictFindings(nodes, { a: { bf: 2, cert: 0 }, b: { bf: 2, cert: 0 } }, ['A', 'B']);
    assert.deepEqual(f, []);
  });
});

describe('formatConflictStat', () => {
  test('dash without a baseline; small rates keep one decimal; big ones round', () => {
    assert.equal(formatConflictStat(undefined), null);
    assert.equal(formatConflictStat({ certPerSec: null, bfPerSec: null }), null);
    assert.equal(formatConflictStat({ certPerSec: 0, bfPerSec: 0 }), 'cert 0.0/s · bf 0.0/s');
    assert.equal(formatConflictStat({ certPerSec: 0.25, bfPerSec: 12.4 }), 'cert 0.3/s · bf 12/s');
    assert.equal(formatConflictStat({ certPerSec: 0.4, bfPerSec: null }), 'cert 0.4/s · bf —');
  });
});
