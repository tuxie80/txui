import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkPairs, benchmarkSteps, summarizeTimings } from '../src/utils/benchmark.ts';

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
