import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryLabOperationReport, renderQueryLabReport } from '../src/utils/queryLabReport.ts';
import type { QueryLabReportInput } from '../src/utils/queryLabReport.ts';
import { benchmarkVerdict, summarizeTimings } from '../src/utils/benchmark.ts';
import { correlatePlanEvidence } from '../src/utils/planCorrelation.ts';

function fixture(): QueryLabReportInput {
  const baselineMs = [100, 101, 99];
  const candidateMs = [70, 71, 69];
  const baselinePlan = JSON.stringify([{ Plan: {
    'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Total Cost': 100,
    'Plan Rows': 10, 'Actual Total Time': 100, 'Actual Rows': 1000, 'Actual Loops': 1,
    'Shared Hit Blocks': 80, 'Shared Read Blocks': 20, 'Sort Method': 'external merge',
  } }]);
  const candidatePlan = JSON.stringify([{ Plan: {
    'Node Type': 'Index Scan', 'Relation Name': 'orders', 'Index Name': 'idx_customer',
    'Total Cost': 50, 'Plan Rows': 1000, 'Actual Total Time': 70, 'Actual Rows': 1000,
    'Actual Loops': 1, 'Shared Hit Blocks': 100, 'Shared Read Blocks': 0,
  } }]);
  return {
    engine: 'postgres', database: 'shop', mode: 'measured', specSha256: 'a'.repeat(64),
    originalSql: 'SELECT id FROM orders WHERE customer_id = 1 ORDER BY id',
    candidate: { id: 'rewrite-1', kind: 'rewrite', name: 'Equivalent predicate', sql: 'SELECT id FROM orders WHERE customer_id = 1 AND id > 0 ORDER BY id' },
    scratch: { database: 'txui_mig_0123456789abcdef', runKey: '01234567-89ab-cdef-8123-456789abcdef', environment: 'dev', readOnly: false },
    correctness: {
      status: 'equal', reason: null, rowOrder: 'ordered', maxRows: 100000, maxBytes: 67108864,
      baseline: { rows: 2, bytes: 24, sha256: 'b'.repeat(64), complete: true, reason: null },
      candidate: { rows: 2, bytes: 24, sha256: 'b'.repeat(64), complete: true, reason: null },
    },
    verdict: benchmarkVerdict({
      baselineMs, candidateMs, baselineSha256: 'b'.repeat(64), candidateSha256: 'b'.repeat(64),
      improvementThresholdPct: 5, candidateKind: 'rewrite',
    }),
    benchmark: {
      warmupRuns: 1, repetitions: 3,
      pairs: [
        { repetition: 1, order: 'baseline_first', baseline_ms: 100, candidate_ms: 70 },
        { repetition: 2, order: 'candidate_first', baseline_ms: 101, candidate_ms: 71 },
        { repetition: 3, order: 'baseline_first', baseline_ms: 99, candidate_ms: 69 },
      ],
      baselineMs, candidateMs,
      baseline: summarizeTimings(baselineMs), candidate: summarizeTimings(candidateMs),
      baselineSha256: 'b'.repeat(64), candidateSha256: 'b'.repeat(64),
    },
    correlation: correlatePlanEvidence({ engine: 'postgres', baselinePlan, candidatePlan, baselineMs: 100, candidateMs: 70 }),
    realIndex: {
      indexName: 'txui_lab_0123456789abcdef', buildMs: 17, used: true,
      scratchDropped: true, indexDropped: true, timeoutRestored: true, connectionClosed: true,
    },
    cacheObservations: ['No complete cache control or cold/warm-cache claim is made'],
    timeoutRestored: true, connectionClosed: true,
  };
}

test('minimal HypoPG report is exact deterministic Markdown', () => {
  const report = renderQueryLabReport({
    engine: 'postgres', database: 'shop', mode: 'estimate', specSha256: 'a'.repeat(64),
    originalSql: 'SELECT 1', candidate: { id: 'idx-1', kind: 'index', name: 'Candidate', sql: null },
    scratch: null,
    hypopg: {
      verdict: 'lower_estimated_cost', baselineCost: 100, candidateCost: 75,
      absoluteDelta: -25, percentDelta: -25,
      created: ['<1>btree_orders_customer_id'], used: ['<1>btree_orders_customer_id'], reset: true,
    },
    timeoutRestored: true, connectionClosed: true,
  });
  assert.equal(report, `# Query Optimization Lab report

**Subject:** shop · idx-1 · estimate
**Outcome:** completed

## Experiment identity and environment

| Fact | Value |
|---|---|
| Engine | postgres |
| Database/schema | shop |
| Exact experiment mode | estimate |
| Specification SHA-256 | ${'a'.repeat(64)} |
| Candidate | idx-1 · index · Candidate |
| Scratch database/schema | not available |
| Migration scratch run ID | not available |
| Environment | not available |
| Read-only target | not available |
| Timeout restored | yes |
| Dedicated connection closed | yes |

- No query-result rows, credentials or report timestamp are included
- No complete cache control or cold/warm-cache claim is made

## HypoPG estimate — no query execution

| Fact | Value |
|---|---|
| Verdict | lower_estimated_cost |
| Baseline cost | 100 |
| Candidate cost | 75 |
| Absolute delta | -25 |
| Percent delta | -25 |
| Created indexes | <1>btree_orders_customer_id |
| Used indexes | <1>btree_orders_customer_id |
| HypoPG reset complete | yes |

- Hypothetical plan/cost evidence only; measured runtime comparison is forbidden

## SQL artifacts — not query-result rows

- Original SQL: SELECT 1
`);
});

test('full report preserves raw timings, plan metrics, long SQL and no row values', () => {
  const input = fixture();
  input.originalSql = `SELECT id FROM orders WHERE note = 'private SQL literal' ${'AND id > 0 '.repeat(1000)}ORDER BY id`;
  input.benchmark!.repetitions = 30;
  input.benchmark!.pairs = Array.from({ length: 30 }, (_, index) => ({ repetition: index + 1, order: index % 2 ? 'candidate_first' : 'baseline_first', baseline_ms: 100 + index, candidate_ms: 70 + index }));
  input.benchmark!.baselineMs = input.benchmark!.pairs.map(pair => pair.baseline_ms);
  input.benchmark!.candidateMs = input.benchmark!.pairs.map(pair => pair.candidate_ms);
  const first = renderQueryLabReport(input);
  assert.equal(first, renderQueryLabReport(input));
  assert.equal(buildQueryLabOperationReport(input).outcome, 'completed');
  assert.ok(first.includes('Repetition 30 · candidate_first · baseline 129 ms · candidate 99 ms'));
  assert.ok(first.includes('100× underestimated'));
  assert.ok(first.includes('80 hit / 20 read'));
  assert.ok(first.includes('sort-spilled'));
  assert.ok(first.includes('private SQL literal'));
  assert.ok(!first.includes('query-result row value'));
  assert.ok(!first.includes('2026-11-08T'));
});

test('different results fail and one-shot or timing-only evidence is explicitly incomplete', () => {
  const input = fixture();
  input.correctness!.status = 'different';
  input.correctness!.reason = 'Rows differ';
  assert.equal(buildQueryLabOperationReport(input).outcome, 'failed');
  const timingOnly = fixture();
  timingOnly.correctness = null;
  timingOnly.verdict = null;
  timingOnly.correlation = null;
  timingOnly.realIndex = null;
  const report = buildQueryLabOperationReport(timingOnly);
  assert.equal(report.outcome, 'incomplete');
  assert.ok(report.incompleteEvidence.some(reason => reason.includes('Plan correlation is not available')));
});
