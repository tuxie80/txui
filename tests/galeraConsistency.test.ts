/**
 * tests for src/utils/galeraConsistency.ts — table-ref parsing, the match /
 * mismatch / inconclusive comparison, majority vs tie divergence naming, and
 * report shaping.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTableRef, compareConsistency, formatConsistencyReport,
  SAMPLE_SIZE_OPTIONS, SAMPLE_SIZE_DEFAULT, MISMATCH_ADVICE,
  type ConsistencyNodeResult,
} from '../src/utils/galeraConsistency.ts';

function node(
  name: string,
  checksum: string | null,
  rows = 5000,
  over: Partial<ConsistencyNodeResult> = {},
): ConsistencyNodeResult {
  return {
    connectionId: `id-${name}`,
    connectionName: name,
    ok: checksum !== null,
    error: checksum === null ? (over.error ?? 'boom') : null,
    rowEstimate: 5000,
    sampledRows: rows,
    checksumText: checksum,
    pkColumns: ['id'],
    elapsedMs: 80,
    ...over,
  };
}

describe('parseTableRef', () => {
  test('schema.table splits on the last dot', () => {
    assert.deepEqual(parseTableRef('galera_smoke.cc_test', null),
      { schema: 'galera_smoke', table: 'cc_test' });
    assert.deepEqual(parseTableRef('  shop.orders  ', null),
      { schema: 'shop', table: 'orders' });
  });

  test('bare table uses the default schema when there is one', () => {
    assert.deepEqual(parseTableRef('cc_test', 'galera_smoke'),
      { schema: 'galera_smoke', table: 'cc_test' });
  });

  test('bare table without a default schema is an honest error', () => {
    const r = parseTableRef('cc_test', null);
    assert.ok('error' in r && r.error.includes('schema.table'));
  });

  test('empty and malformed inputs are errors, never guesses', () => {
    assert.ok('error' in parseTableRef('', 'x'));
    assert.ok('error' in parseTableRef('.t', null));
    assert.ok('error' in parseTableRef('s.', null));
  });
});

describe('compareConsistency', () => {
  test('all-equal checksums are a match', () => {
    const v = compareConsistency([
      node('galera1', '12345'), node('galera2', '12345'), node('galera3', '12345'),
    ]);
    assert.equal(v.status, 'match');
    assert.equal(v.divergent.length, 0);
    assert.equal(v.groups.length, 1);
    assert.match(v.summary, /Match — all 3 nodes identical/);
    assert.match(v.summary, /checksum 12345/);
    assert.match(v.summary, /5,000 rows/);
  });

  test('one node off the majority is named divergent', () => {
    const v = compareConsistency([
      node('galera1', '111'), node('galera2', '222'), node('galera3', '111'),
    ]);
    assert.equal(v.status, 'mismatch');
    assert.deepEqual(v.divergent.map(n => n.connectionName), ['galera2']);
    assert.match(v.summary, /galera2/);
    assert.equal(v.groups.length, 2);
  });

  test('a different row COUNT with an equal sum is still a mismatch', () => {
    // The comparison key is (checksum, sampled_rows) together.
    const v = compareConsistency([
      node('galera1', '111', 5000), node('galera2', '111', 4999),
    ]);
    assert.equal(v.status, 'mismatch');
  });

  test('a two-node tie has no majority and names no villain', () => {
    const v = compareConsistency([
      node('galera1', '111'), node('galera2', '222'),
    ]);
    assert.equal(v.status, 'mismatch');
    assert.equal(v.divergent.length, 0);
    assert.match(v.summary, /no majority/);
  });

  test('failed nodes are inconclusive and named, never silently dropped', () => {
    const v = compareConsistency([
      node('galera1', '111'),
      node('galera2', '111'),
      node('galera3', null, 0, { error: 'timeout after 30s' }),
    ]);
    assert.equal(v.status, 'match');
    assert.equal(v.inconclusive.length, 1);
    assert.equal(v.inconclusive[0].connectionName, 'galera3');
    assert.match(v.summary, /1 node inconclusive \(galera3\)/);
  });

  test('fewer than two answers is inconclusive, not a match', () => {
    const one = compareConsistency([node('galera1', '111')]);
    assert.equal(one.status, 'inconclusive');
    const none = compareConsistency([node('galera1', null, 0)]);
    assert.equal(none.status, 'inconclusive');
  });

  test('an ok node without a checksum text counts as inconclusive', () => {
    const v = compareConsistency([
      node('galera1', '111'),
      node('galera2', '111'),
      node('galera3', '111', 5000, { checksumText: null }),
    ]);
    assert.equal(v.status, 'match');
    assert.equal(v.inconclusive.length, 1);
  });
});

describe('formatConsistencyReport', () => {
  test('report carries mode, verdict and one line per node', () => {
    const v = compareConsistency([
      node('galera1', '111'), node('galera2', '222'), node('galera3', null, 0, { error: 'no PK' }),
    ]);
    const text = formatConsistencyReport('galera_smoke.cc_test', 'sample', SAMPLE_SIZE_DEFAULT, v);
    assert.match(text, /galera_smoke\.cc_test/);
    assert.match(text, /sample \(first 10,000 rows by PK\)/);
    assert.match(text, /MISMATCH/);
    assert.match(text, /galera1/);
    assert.match(text, /galera2/);
    assert.match(text, /no PK/);
    assert.match(text, /wsrep_on=OFF drift/); // the advice block
  });

  test('full mode says so; a match adds no advice', () => {
    const v = compareConsistency([node('a', '9'), node('b', '9')]);
    const text = formatConsistencyReport('s.t', 'full', 0, v);
    assert.match(text, /mode: full table/);
    assert.ok(!text.includes(MISMATCH_ADVICE));
  });

  test('sample-size options are the dialog contract', () => {
    assert.deepEqual(SAMPLE_SIZE_OPTIONS.map(o => o.value), [1_000, 10_000, 100_000]);
    assert.equal(SAMPLE_SIZE_DEFAULT, 10_000);
  });
});
