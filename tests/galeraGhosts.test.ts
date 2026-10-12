/**
 * tests for src/utils/galeraGhosts.ts — ghost-member detection (an incoming
 * address no polled config covers), the consecutive-poll tracking, the
 * arbitrator size identity, and the quiet-by-design findings. The fleet has
 * no garbd, so all of this is constructed snapshots — including the proof
 * that a normal 3-node all-ok poll produces NOTHING.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanGhosts, ghostFindings, ghostCardTip, GHOST_MIN_POLLS,
} from '../src/utils/galeraGhosts.ts';
import { normalizeHostPort } from '../src/utils/galeraDiscover.ts';
import type { NodeSummary } from '../src/utils/galeraCluster.ts';

/** Minimal reachable+detected NodeSummary — only the fields scanGhosts reads. */
function node(id: string, size: number | null, incoming: string[]): NodeSummary {
  return {
    connectionId: id, name: id, nodeName: null,
    reachable: true, error: null, detected: true,
    localState: 'Synced', synced: true,
    clusterName: 'db', clusterStateUuid: 'u', clusterStatus: 'Primary',
    clusterSize: size, incomingAddresses: incoming,
    flowControlPaused: null, recvQueue: null, recvQueueAvg: null, sendQueue: null,
    lastCommitted: null,
    rates: { commitsPerSec: null, replicatedBytesPerSec: null, receivedBytesPerSec: null },
    transfer: null, ist: null, polledAtMs: 0,
  };
}

const N3 = ['127.0.0.1:3341', '127.0.0.1:3342', '127.0.0.1:3343'];
const COVERED3 = N3.map(a => normalizeHostPort(a.split(':')[0], Number(a.split(':')[1])));

describe('scanGhosts', () => {
  test('normal 3-node cluster, every member covered: no ghosts, ever', () => {
    const nodes = N3.map((a, i) => node(`n${i}`, 3, N3));
    let polls: Record<string, number> = {};
    for (let i = 0; i < 3; i++) {
      const scan = scanGhosts(nodes, COVERED3, polls);
      polls = scan.nextPolls;
      assert.deepEqual(scan.ghosts, []);
    }
    assert.deepEqual(ghostFindings([]), []);
  });

  test('a covered but DOWN node is not a ghost (it is the unreachable finding)', () => {
    const nodes = [node('n0', 3, N3), node('n1', 3, N3)];
    const scan = scanGhosts(nodes, COVERED3, {});
    assert.deepEqual(scan.ghosts, [], 'the down node is covered by its config');
  });

  test('an unmatched extra member is a ghost; polls accumulate; gone resets', () => {
    const withGarbd = [...N3, '127.0.0.1:3344'];
    const nodes = N3.map((a, i) => node(`n${i}`, 4, withGarbd));
    const s1 = scanGhosts(nodes, COVERED3, {});
    assert.equal(s1.ghosts.length, 1);
    assert.equal(s1.ghosts[0].address, '127.0.0.1:3344');
    assert.equal(s1.ghosts[0].polls, 1);
    assert.equal(s1.ghosts[0].classification, 'unknown_member', 'not persistent yet');
    const s2 = scanGhosts(nodes, COVERED3, s1.nextPolls);
    assert.equal(s2.ghosts[0].polls, 2);
    // Ghost vanishes (garbd left) → the count does not survive.
    const s3 = scanGhosts(N3.map((a, i) => node(`n${i}`, 3, N3)), COVERED3, s2.nextPolls);
    assert.deepEqual(s3.ghosts, []);
    assert.deepEqual(s3.nextPolls, {});
  });

  test('persistent ghost + matching size identity → likely_arbitrator', () => {
    const withGarbd = [...N3, '127.0.0.1:3344'];
    const nodes = N3.map((a, i) => node(`n${i}`, 4, withGarbd)); // size 4 = 3 ok + 1 ghost
    const s1 = scanGhosts(nodes, COVERED3, {});
    const s2 = scanGhosts(nodes, COVERED3, s1.nextPolls);
    assert.equal(s2.ghosts[0].polls, GHOST_MIN_POLLS);
    assert.equal(s2.ghosts[0].classification, 'likely_arbitrator');
    assert.deepEqual(ghostFindings(s2.ghosts), [], 'an arbitrator is a healthy topology — quiet');
  });

  test('size identity broken → stays unknown_member and earns an info finding', () => {
    const withExtra = [...N3, '10.0.0.9:3306'];
    // size 3 but 3 ok + 1 ghost = 4 expected → the pattern does not hold.
    const nodes = N3.map((a, i) => node(`n${i}`, 3, withExtra));
    const s1 = scanGhosts(nodes, COVERED3, {});
    const s2 = scanGhosts(nodes, COVERED3, s1.nextPolls);
    assert.equal(s2.ghosts[0].classification, 'unknown_member');
    const f = ghostFindings(s2.ghosts);
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'info');
    assert.ok(f[0].title.includes('10.0.0.9:3306'));
    assert.ok(f[0].title.includes('not an arbitrator pattern'));
  });

  test('single-poll unknown member earns no finding yet', () => {
    const withExtra = [...N3, '10.0.0.9:3306'];
    const nodes = N3.map((a, i) => node(`n${i}`, 3, withExtra));
    const s1 = scanGhosts(nodes, COVERED3, {});
    assert.equal(s1.ghosts[0].classification, 'unknown_member');
    assert.deepEqual(ghostFindings(s1.ghosts), []);
  });

  test('normalization: LOCALHOST:3344 is the covered 127.0.0.1:3344', () => {
    const nodes = [node('n0', 2, ['LOCALHOST:3341', 'localhost:3344'])];
    const covered = ['127.0.0.1:3341', normalizeHostPort('127.0.0.1', 3344)];
    const scan = scanGhosts(nodes, covered, {});
    assert.deepEqual(scan.ghosts, []);
  });

  test('stray AUTO/blank tokens never fabricate a ghost', () => {
    const nodes = [node('n0', 1, ['AUTO', '127.0.0.1:3341', ''])];
    const scan = scanGhosts(nodes, ['127.0.0.1:3341'], {});
    assert.deepEqual(scan.ghosts, []);
  });
});

describe('ghostCardTip', () => {
  test('arbitrator tip names garbd and the quorum vote', () => {
    const tip = ghostCardTip({ address: 'a:1', polls: 3, classification: 'likely_arbitrator' });
    assert.ok(tip.includes('3 polls'));
    assert.ok(tip.includes('garbd'));
    assert.ok(tip.includes('quorum'));
  });

  test('unknown-member tip says the pattern does not hold', () => {
    const tip = ghostCardTip({ address: 'a:1', polls: 1, classification: 'unknown_member' });
    assert.ok(tip.includes('1 poll'));
    assert.ok(tip.includes('Investigate'));
  });
});
