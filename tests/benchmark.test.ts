import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineNoiseMs, benchmarkPairs, benchmarkSteps, benchmarkVerdict, summarizeTimings } from '../src/utils/benchmark.ts';

test('benchmark scheduler alternates warmup and measured pairs with bounded counts', () => {
  const steps = benchmarkSteps(2, 4);
  assert.equal(steps.length, 12);
  assert.deepEqual(steps.slice(0, 4).map(step => step.side), ['baseline', 'candidate', 'candidate', 'baseline']);
  assert.deepEqual(steps.slice(4).map(step => step.side), [
    'baseline', 'candidate', 'candidate', 'baseline',
    'baseline', 'candidate', 'candidate', 'baseline',
  ]);
  assert.deepEqual(benchmarkPairs(3), [
    { repetition: 1, order: 'baseline_first' },
    { repetition: 2, order: 'candidate_first' },
    { repetition: 3, order: 'baseline_first' },
  ]);
  assert.equal(benchmarkSteps(10, 30).length, 80);
  assert.throws(() => benchmarkSteps(-1, 1));
  assert.throws(() => benchmarkSteps(11, 1));
  assert.throws(() => benchmarkSteps(0, 0));
  assert.throws(() => benchmarkSteps(0, 31));
});

test('timing summaries preserve raw counts and calculate median, nearest-rank p95, min and max', () => {
  assert.deepEqual(summarizeTimings([9, 1, 5, 3, 7, 2, 8]), {
    count: 7, minMs: 1, medianMs: 5, p95Ms: 9, maxMs: 9,
  });
  assert.deepEqual(summarizeTimings([10, 1, 7, 3]), {
    count: 4, minMs: 1, medianMs: 5, p95Ms: 10, maxMs: 10,
  });
  assert.deepEqual(summarizeTimings([0]), {
    count: 1, minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0,
  });
  assert.throws(() => summarizeTimings([]));
  assert.throws(() => summarizeTimings([Number.NaN]));
  assert.throws(() => summarizeTimings([-1]));
});

function verdictFixture(overrides = {}) {
  return {
    baselineMs: [100, 101, 99, 100], candidateMs: [70, 71, 69, 70],
    baselineSha256: 'same', candidateSha256: 'same', improvementThresholdPct: 5,
    candidateKind: 'rewrite' as const, ...overrides,
  };
}

test('stable improvements and regressions must exceed both threshold and baseline noise', () => {
  const improved = benchmarkVerdict(verdictFixture());
  assert.equal(improved.verdict, 'improved');
  assert.equal(improved.noiseFloorMs, 1);
  assert.equal(improved.thresholdMs, 5);
  assert.equal(improved.deltaMs, 30);
  assert.equal(baselineNoiseMs([100, 200, 100]), 100);
  assert.equal(benchmarkVerdict(verdictFixture({ candidateMs: [130, 131, 129, 130] })).verdict, 'regressed');
});

test('tiny or noisy deltas and insufficient repetitions stay inconclusive', () => {
  assert.equal(benchmarkVerdict(verdictFixture({ candidateMs: [99, 100, 98, 99] })).verdict, 'inconclusive');
  assert.equal(benchmarkVerdict(verdictFixture({ baselineMs: [100, 200, 100], candidateMs: [80, 90, 80] })).verdict, 'inconclusive');
  assert.equal(benchmarkVerdict(verdictFixture({ baselineMs: [100, 90], candidateMs: [10, 10] })).verdict, 'inconclusive');
  assert.equal(benchmarkVerdict(verdictFixture({ baselineMs: [0, 0, 0], candidateMs: [0, 0, 0] })).verdict, 'inconclusive');
});

test('different results are invalid and an unused index cannot improve', () => {
  assert.equal(benchmarkVerdict(verdictFixture({ candidateSha256: 'different' })).verdict, 'invalid_results');
  assert.equal(benchmarkVerdict(verdictFixture({ baselineSha256: null })).verdict, 'invalid_results');
  assert.equal(benchmarkVerdict(verdictFixture({ candidateKind: 'index', indexUsed: false })).verdict, 'inconclusive');
  assert.equal(benchmarkVerdict(verdictFixture({ candidateKind: 'index', indexUsed: true })).verdict, 'improved');
});
