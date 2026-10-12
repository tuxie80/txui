/**
 * tests for src/utils/galeraWriteRouting.ts — the ranked write-suitability
 * list (eligibility, scoring, tie-breaks), the recommendation, and the
 * warn/info finding.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankWriteTargets, recommendedWriter, writeRoutingFinding,
} from '../src/utils/galeraWriteRouting.ts';
import type { NodeSummary } from '../src/utils/galeraCluster.ts';
import type { WriteShare } from '../src/utils/galeraWriteSources.ts';

function summary(id: string, over: Partial<NodeSummary> = {}): NodeSummary {
  return {
    connectionId: id,
    name: id,
    nodeName: `n-${id}`,
    reachable: true,
    error: null,
    detected: true,
    localState: 'Synced',
    synced: true,
    clusterName: 'db',
    clusterStateUuid: 'uuid-1',
    clusterStatus: 'Primary',
    clusterSize: 3,
    incomingAddresses: [],
    flowControlPaused: 0,
    recvQueue: 0,
    recvQueueAvg: 0,
    sendQueue: 0,
    lastCommitted: 100,
    rates: { commitsPerSec: null, replicatedBytesPerSec: null, receivedBytesPerSec: null },
    transfer: null,
    ist: null,
    polledAtMs: 5000,
    ...over,
  };
}

function node(id: string, over: Partial<NodeSummary> = {}) {
  return { connectionId: id, display: id, summary: summary(id, over) };
}

/** WriteShare map from bare shares (ratePerSec is irrelevant to routing). */
function sharesOf(m: Record<string, number | null>): Map<string, WriteShare> {
  return new Map(Object.entries(m).map(([k, v]) =>
    [k, { ratePerSec: v !== null && v > 0 ? v : 0, share: v }]));
}

describe('rankWriteTargets — eligibility', () => {
  test('unreachable, non-Galera, unsynced and mid-transfer nodes are ineligible with the reason', () => {
    const t = rankWriteTargets([
      node('ok'),
      node('down', { reachable: false, error: 'connect refused' }),
      node('plain', { detected: false }),
      node('donor', { localState: 'Donor/Desynced', synced: false }),
      node('joiner', { localState: 'Joining', synced: false }),
      node('joined', { localState: 'Joined', synced: false }),
      node('nonprimary', { synced: false, clusterStatus: 'Non-Primary' }),
      node('ist', { ist: { pct: 0.4, current: 40, start: 0, end: 100, statusText: null } }),
      node('sst', { transfer: { phase: 'sst', title: 'SST', detail: '', elapsedMs: 1000, queueLeft: null, donorCause: null } }),
    ], new Map());
    const byId = new Map(t.map(x => [x.connectionId, x]));
    assert.equal(byId.get('ok')!.eligible, true);
    assert.equal(byId.get('down')!.eligible, false);
    assert.match(byId.get('down')!.ineligibleReason!, /unreachable/);
    assert.equal(byId.get('plain')!.eligible, false);
    assert.match(byId.get('plain')!.ineligibleReason!, /not a Galera node/);
    assert.match(byId.get('donor')!.ineligibleReason!, /not Synced \(Donor\/Desynced\)/);
    assert.match(byId.get('joiner')!.ineligibleReason!, /not Synced \(Joining\)/);
    assert.match(byId.get('joined')!.ineligibleReason!, /not Synced \(Joined\)/);
    assert.match(byId.get('nonprimary')!.ineligibleReason!, /not Synced/);
    assert.match(byId.get('ist')!.ineligibleReason!, /mid SST\/IST/);
    assert.match(byId.get('sst')!.ineligibleReason!, /mid SST\/IST/);
    for (const x of t.filter(x => !x.eligible)) assert.equal(x.score, -Infinity);
  });

  test('synced null (unreadable key) is ineligible — never guessed', () => {
    const [t] = rankWriteTargets([node('a', { synced: null, localState: null })], new Map());
    assert.equal(t.eligible, false);
    assert.match(t.ineligibleReason!, /unreadable/);
  });
});

describe('rankWriteTargets — scoring and order', () => {
  test('single writer with clean queues is top-ranked and the reason names the share', () => {
    const t = rankWriteTargets(
      [node('b'), node('a'), node('c')],
      sharesOf({ a: 0.62, b: 0, c: 0.38 }));
    assert.equal(t[0].connectionId, 'a');
    assert.ok(t[0].reasons.some(r => r.includes('62% of writes')));
    assert.ok(t[0].score > t[1].score);
  });

  test('flow-control throttled writer loses to an idle peer despite the share bonus', () => {
    const t = rankWriteTargets(
      [node('a', { flowControlPaused: 0.12 }), node('b')],
      sharesOf({ a: 0.9, b: 0.1 }));
    assert.equal(t[0].connectionId, 'b', 'share +1.8 < flow control -3');
    assert.ok(t.find(x => x.connectionId === 'a')!.reasons.some(r => r.includes('flow control paused 12%')));
  });

  test('mild flow control, apply-queue average and instantaneous queues each cost', () => {
    const t = rankWriteTargets([
      node('mild', { flowControlPaused: 0.05 }),
      node('avg', { recvQueueAvg: 2.3 }),
      node('queues', { recvQueue: 12, sendQueue: 9 }),
      node('clean'),
    ], new Map());
    const score = (id: string) => t.find(x => x.connectionId === id)!.score;
    assert.equal(score('mild'), -1);
    assert.equal(score('avg'), -2);
    assert.equal(score('queues'), -2);
    assert.equal(score('clean'), 0);
    assert.ok(t.find(x => x.connectionId === 'avg')!.reasons.some(r => r.includes('averaging 2.3')));
    assert.equal(t[0].connectionId, 'clean');
  });

  test('idle cluster (all shares null) — winner by name tie-break', () => {
    const t = rankWriteTargets(
      [node('c'), node('a'), node('b')],
      sharesOf({ a: null, b: null, c: null }));
    assert.deepEqual(t.map(x => x.connectionId), ['a', 'b', 'c']);
  });

  test('deterministic: same inputs rank identically twice', () => {
    const nodes = [node('c', { flowControlPaused: 0.02 }), node('a'), node('b')];
    const shares = sharesOf({ a: 0.5, b: 0.5, c: 0 });
    const first = rankWriteTargets(nodes, shares).map(x => x.connectionId);
    const second = rankWriteTargets(nodes, shares).map(x => x.connectionId);
    assert.deepEqual(first, second);
  });
});

describe('recommendedWriter', () => {
  test('top eligible target, or null when nothing is eligible', () => {
    const t = rankWriteTargets(
      [node('donor', { synced: false, localState: 'Donor/Desynced' }), node('a')],
      new Map());
    assert.equal(recommendedWriter(t)?.connectionId, 'a');
    const none = rankWriteTargets([node('donor', { synced: false, localState: 'Donor/Desynced' })], new Map());
    assert.equal(recommendedWriter(none), null);
  });
});

describe('writeRoutingFinding', () => {
  const nodeList = [
    { connectionId: 'a', display: 'A' },
    { connectionId: 'b', display: 'B' },
  ];

  test('warn when the dominant writer is not the recommendation — names both', () => {
    const targets = rankWriteTargets(
      [{ connectionId: 'a', display: 'A', summary: summary('a', { flowControlPaused: 0.12 }) },
       { connectionId: 'b', display: 'B', summary: summary('b') }],
      sharesOf({ a: 0.8, b: 0.2 }));
    const f = writeRoutingFinding(nodeList, sharesOf({ a: 0.8, b: 0.2 }), targets);
    assert.equal(f?.level, 'warn');
    assert.ok(f!.title.includes('A'));
    assert.ok(f!.title.includes('B'));
    assert.ok(f!.detail.includes('flow control paused 12%'));
  });

  test('warn also when the dominant writer dropped out of eligibility entirely', () => {
    const targets = rankWriteTargets(
      [{ connectionId: 'a', display: 'A', summary: summary('a', { synced: false, localState: 'Donor/Desynced' }) },
       { connectionId: 'b', display: 'B', summary: summary('b') }],
      sharesOf({ a: 0.9, b: 0.1 }));
    const f = writeRoutingFinding(nodeList, sharesOf({ a: 0.9, b: 0.1 }), targets);
    assert.equal(f?.level, 'warn');
    assert.ok(f!.detail.includes('not Synced'));
  });

  test('idle cluster → info naming the recommendation, no warn', () => {
    const targets = rankWriteTargets(
      [{ connectionId: 'a', display: 'A', summary: summary('a') },
       { connectionId: 'b', display: 'B', summary: summary('b') }],
      sharesOf({ a: null, b: null }));
    const f = writeRoutingFinding(nodeList, sharesOf({ a: null, b: null }), targets);
    assert.equal(f?.level, 'info');
    assert.ok(f!.title.includes('Recommended write target: A'));
  });

  test('writes already on the recommendation → info, no warn', () => {
    const targets = rankWriteTargets(
      [{ connectionId: 'a', display: 'A', summary: summary('a') },
       { connectionId: 'b', display: 'B', summary: summary('b') }],
      sharesOf({ a: 0.7, b: 0.3 }));
    const f = writeRoutingFinding(nodeList, sharesOf({ a: 0.7, b: 0.3 }), targets);
    assert.equal(f?.level, 'info');
    assert.ok(f!.title.includes('A'));
    assert.ok(f!.detail.includes('writes already land here'));
  });

  test('nothing eligible → null (other findings already scream)', () => {
    const targets = rankWriteTargets(
      [{ connectionId: 'a', display: 'A', summary: summary('a', { reachable: false }) },
       { connectionId: 'b', display: 'B', summary: summary('b', { synced: false, localState: 'Joining' }) }],
      new Map());
    assert.equal(writeRoutingFinding(nodeList, new Map(), targets), null);
  });

  test('fewer than 2 live Galera nodes → null (routing is meaningless on one node)', () => {
    const targets = rankWriteTargets(
      [{ connectionId: 'a', display: 'A', summary: summary('a') }], new Map());
    assert.equal(writeRoutingFinding([{ connectionId: 'a', display: 'A' }], new Map(), targets), null);
  });
});
