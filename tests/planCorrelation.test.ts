import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlatePlanEvidence } from '../src/utils/planCorrelation.ts';

const pgBaseline = JSON.stringify([{ Plan: {
  'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Total Cost': 100,
  'Plan Rows': 10, 'Actual Total Time': 120, 'Actual Rows': 1000, 'Actual Loops': 1,
  'Shared Hit Blocks': 80, 'Shared Read Blocks': 20, 'Sort Method': 'external merge',
} }]);
const pgCandidate = JSON.stringify([{ Plan: {
  'Node Type': 'Index Scan', 'Relation Name': 'orders', 'Index Name': 'idx_customer',
  'Total Cost': 50, 'Plan Rows': 1000, 'Actual Total Time': 60, 'Actual Rows': 1000,
  'Actual Loops': 1, 'Shared Hit Blocks': 100, 'Shared Read Blocks': 0,
} }]);

test('PostgreSQL runtime, plan diff, cardinality, buffers and spills stay correlated', () => {
  const result = correlatePlanEvidence({
    engine: 'postgres', baselinePlan: pgBaseline, candidatePlan: pgCandidate,
    baselineMs: 120, candidateMs: 60,
  });
  assert.equal(result.comparable, true);
  assert.equal(result.runtime?.deltaMs, 60);
  assert.equal(result.runtime?.improvementPct, 50);
  assert.equal(result.baseline.cardinality?.factor, 100);
  assert.equal(result.baseline.cardinality?.direction, 'underestimated');
  assert.deepEqual(result.baseline.buffers, { operation: 'Seq Scan', hit: 80, read: 20 });
  assert.deepEqual(result.candidate.buffers, { operation: 'Index Scan', hit: 100, read: 0 });
  assert.deepEqual(result.baseline.spills, ['Seq Scan: sort:external merge', 'Seq Scan: sort-spilled']);
  assert.match(result.headline, /faster|fewer|changed|time/i);
});

test('MariaDB measured JSON has runtime but unavailable buffers and spills are not zero', () => {
  const plan = JSON.stringify({ query_block: {
    select_id: 1, cost_info: { query_cost: '100' },
    table: { table_name: 'orders', access_type: 'ALL', rows: 10, r_rows: 1000, r_total_time_ms: 120 },
  } });
  const result = correlatePlanEvidence({ engine: 'mysql', baselinePlan: plan, candidatePlan: plan });
  assert.equal(result.comparable, true);
  assert.equal(result.baseline.cardinality?.factor, 100);
  assert.equal(result.baseline.buffers, null);
  assert.deepEqual(result.baseline.spills, []);
  assert.equal(result.runtime, null);
});

test('MySQL TREE measured plans correlate without inventing missing metrics', () => {
  const baseline = '-> Table scan on orders (cost=10 rows=10) (actual time=0..120 rows=1000 loops=1)';
  const candidate = '-> Index lookup on orders using idx_customer (cost=5 rows=1000) (actual time=0..60 rows=1000 loops=1)';
  const result = correlatePlanEvidence({ engine: 'mysql', baselinePlan: baseline, candidatePlan: candidate, baselineMs: 120, candidateMs: 60 });
  assert.equal(result.comparable, true);
  assert.equal(result.runtime?.improvementPct, 50);
  assert.equal(result.baseline.buffers, null);
  assert.equal(result.baseline.cardinality?.factor, 100);
});

test('measured-versus-estimated is refused and absent metrics stay null', () => {
  const estimated = JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan', 'Total Cost': 100, 'Plan Rows': 10 } }]);
  const result = correlatePlanEvidence({ engine: 'postgres', baselinePlan: estimated, candidatePlan: pgCandidate });
  assert.equal(result.comparable, false);
  assert.match(result.reason!, /different quantities/);
  assert.equal(result.baseline.cardinality, null);
  assert.equal(result.baseline.buffers, null);
  assert.equal(result.runtime, null);
});
