/**
 * tests for src/utils/galeraQuorum.ts — the majority math, the header-line
 * phrasing, the even-size / two-node / single-node findings, and the
 * arbitrator payoff: 2 nodes + garbd reports size 3 and must NOT warn.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  quorumAfterLoss, lossTolerance, quorumSummary, quorumFinding,
} from '../src/utils/galeraQuorum.ts';

describe('quorumAfterLoss', () => {
  test('strict majority of the current component', () => {
    assert.equal(quorumAfterLoss(3, 1), true);
    assert.equal(quorumAfterLoss(3, 2), false);
    assert.equal(quorumAfterLoss(4, 1), true);
    assert.equal(quorumAfterLoss(4, 2), false, 'a tie is not a majority');
    assert.equal(quorumAfterLoss(5, 2), true);
    assert.equal(quorumAfterLoss(5, 3), false);
    assert.equal(quorumAfterLoss(2, 1), false);
    assert.equal(quorumAfterLoss(1, 0), true);
    assert.equal(quorumAfterLoss(1, 1), false);
  });
});

describe('lossTolerance', () => {
  test('the table the advisor renders', () => {
    assert.equal(lossTolerance(1), 0);
    assert.equal(lossTolerance(2), 0);
    assert.equal(lossTolerance(3), 1);
    assert.equal(lossTolerance(4), 1);
    assert.equal(lossTolerance(5), 2);
    assert.equal(lossTolerance(6), 2);
    assert.equal(lossTolerance(7), 3);
  });
});

describe('quorumSummary', () => {
  test('the header lines', () => {
    assert.equal(quorumSummary(3), '3 nodes — survives losing 1');
    assert.equal(quorumSummary(2), '2 nodes — losing ANY node loses quorum');
    assert.equal(quorumSummary(1), '1 node — no redundancy');
    assert.equal(quorumSummary(5), '5 nodes — survives losing 2');
    assert.equal(quorumSummary(3, 1), '2 nodes + 1 arbitrator — survives losing 1');
    assert.equal(quorumSummary(0), 'quorum unknown — no live member answered');
  });
});

describe('quorumFinding', () => {
  test('odd healthy sizes and unreadable size → nothing', () => {
    assert.equal(quorumFinding(3), null);
    assert.equal(quorumFinding(5), null);
    assert.equal(quorumFinding(0), null);
  });

  test('single node → info, not a warning', () => {
    const f = quorumFinding(1)!;
    assert.equal(f.level, 'info');
    assert.ok(f.title.includes('Single-node'));
  });

  test('two nodes → the elevated split-brain wording', () => {
    const f = quorumFinding(2)!;
    assert.equal(f.level, 'warn');
    assert.ok(f.title.includes('split-brain'));
    assert.ok(f.detail.includes('garbd'));
  });

  test('even size ≥ 4 → the tie-has-no-majority warning', () => {
    const f = quorumFinding(4)!;
    assert.equal(f.level, 'warn');
    assert.ok(f.title.includes('Even-sized component (4)'));
    assert.ok(!f.title.includes('split-brain'), 'the 2-node wording is reserved for 2');
  });

  test('the arbitrator payoff: 2 nodes + garbd is size 3 → NO warning', () => {
    // garbd votes, so wsrep_cluster_size already reports 3.
    assert.equal(quorumFinding(3, 1), null);
    // …but an even size WITH an arbitrator is still even — warn, noting it.
    const f = quorumFinding(4, 1)!;
    assert.equal(f.level, 'warn');
    assert.ok(f.detail.includes('arbitrator already votes'));
  });
});
