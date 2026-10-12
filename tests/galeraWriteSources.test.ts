/**
 * tests for src/utils/galeraWriteSources.ts — the originated-writes rate and
 * share math, the single-writer info / multi-writer-with-conflicts warn, and
 * the card-stat format.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeSources, writeSourceFindings, formatWriteShare,
} from '../src/utils/galeraWriteSources.ts';
import type { NodeSnapshot } from '../src/utils/galeraCluster.ts';

function snap(id: string, atMs: number, repl: string, over: { ok?: boolean } = {}): NodeSnapshot {
  return {
    connectionId: id,
    connectionName: id,
    ok: over.ok ?? true,
    error: null,
    statusRows: [
      ['wsrep_replicated', repl],
      ['wsrep_received', '0'],
      ['wsrep_local_state_comment', 'Synced'],
      ['wsrep_cluster_status', 'Primary'],
    ],
    variableRows: [['wsrep_on', 'ON'], ['wsrep_cluster_name', 'db']],
    elapsedMs: 5,
    polledAtMs: atMs,
  };
}

describe('writeSources', () => {
  test('originated rate per node; shares sum to 1 over the writers', () => {
    const prev = [snap('a', 0, '100'), snap('b', 0, '50'), snap('c', 0, '0')];
    const cur = [snap('a', 5000, '160'), snap('b', 5000, '80'), snap('c', 5000, '0')];
    const shares = writeSources(cur, prev);
    assert.equal(shares.get('a')!.ratePerSec, 12);   // 60 / 5 s
    assert.equal(shares.get('b')!.ratePerSec, 6);    // 30 / 5 s
    assert.equal(shares.get('c')!.ratePerSec, 0);
    assert.equal(shares.get('a')!.share, 12 / 18);
    assert.equal(shares.get('b')!.share, 6 / 18);
    assert.equal(shares.get('c')!.share, 0);
  });

  test('no baseline, counter reset and idle cluster all read as null share', () => {
    const first = writeSources([snap('a', 0, '10')], []);
    assert.equal(first.get('a')!.ratePerSec, null);
    assert.equal(first.get('a')!.share, null);

    const idle = writeSources([snap('a', 5000, '10'), snap('b', 5000, '5')],
      [snap('a', 0, '10'), snap('b', 0, '5')]);
    assert.equal(idle.get('a')!.ratePerSec, 0);
    assert.equal(idle.get('a')!.share, null, 'no distribution of nothing');

    const reset = writeSources([snap('a', 5000, '2')], [snap('a', 0, '10')]);
    assert.equal(reset.get('a')!.ratePerSec, null, 'restart/FLUSH STATUS — unreadable');
  });
});

describe('writeSourceFindings', () => {
  const nodes = [
    { connectionId: 'a', display: 'A' },
    { connectionId: 'b', display: 'B' },
    { connectionId: 'c', display: 'C' },
  ];
  const sharesOf = (m: Record<string, number>) => {
    const total = Object.values(m).reduce((x, y) => x + y, 0);
    return new Map(Object.entries(m).map(([k, v]) =>
      [k, { ratePerSec: v, share: total > 0 ? v / total : null }]));
  };

  test('one writer among several nodes → single-writer info naming it', () => {
    const f = writeSourceFindings(nodes, sharesOf({ a: 10, b: 0, c: 0 }));
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'info');
    assert.ok(f[0].title.includes('Single-writer'));
    assert.ok(f[0].title.includes('A'));
  });

  test('several writers WITH sustained cert failures → the multi-writer warn', () => {
    const f = writeSourceFindings(nodes, sharesOf({ a: 10, b: 5, c: 0 }), ['A', 'B']);
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'warn');
    assert.ok(f[0].title.includes('2 nodes'));
    assert.ok(f[0].title.includes('A, B'));
  });

  test('several writers but NO cert failures → no warning (possible ≠ observed)', () => {
    const f = writeSourceFindings(nodes, sharesOf({ a: 10, b: 5, c: 0 }), []);
    assert.deepEqual(f, []);
  });

  test('idle cluster → nothing', () => {
    assert.deepEqual(writeSourceFindings(nodes, sharesOf({ a: 0, b: 0, c: 0 })), []);
  });
});

describe('formatWriteShare', () => {
  test('percent, rounded; dash when null', () => {
    assert.equal(formatWriteShare(null), null);
    assert.equal(formatWriteShare(1), '100%');
    assert.equal(formatWriteShare(0.666), '67%');
    assert.equal(formatWriteShare(0), '0%');
  });
});
