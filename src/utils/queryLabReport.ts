import { renderOperationReport } from './operationReport.ts';
import type { OperationReport, OperationReportSection } from './operationReport.ts';
import type { BenchmarkVerdict, TimingSummary } from './benchmark.ts';
import type { PlanCorrelation } from './planCorrelation.ts';

export interface QueryLabReportBenchmark {
  warmupRuns: number;
  repetitions: number;
  pairs: { repetition: number; order: string; baseline_ms: number; candidate_ms: number }[];
  baselineMs: number[];
  candidateMs: number[];
  baseline: TimingSummary;
  candidate: TimingSummary;
  baselineSha256: string | null;
  candidateSha256: string | null;
}

export interface QueryLabReportCorrectness {
  status: 'equal' | 'different' | 'unverified';
  reason: string | null;
  rowOrder: string;
  maxRows: number;
  maxBytes: number;
  baseline: { rows: number; bytes: number; sha256: string | null; complete: boolean; reason: string | null };
  candidate: { rows: number; bytes: number; sha256: string | null; complete: boolean; reason: string | null };
}

export interface QueryLabReportInput {
  engine: string;
  database: string;
  mode: 'estimate' | 'measured';
  specSha256: string;
  originalSql: string;
  candidate: { id: string; kind: string; name: string; sql: string | null };
  scratch: { database: string; runKey: string | null; environment: string | null; readOnly: boolean } | null;
  correctness?: QueryLabReportCorrectness | null;
  verdict?: BenchmarkVerdict | null;
  benchmark?: QueryLabReportBenchmark | null;
  correlation?: PlanCorrelation | null;
  hypopg?: {
    verdict: string;
    baselineCost: number | null;
    candidateCost: number | null;
    absoluteDelta: number | null;
    percentDelta: number | null;
    created: string[];
    used: string[];
    reset: boolean;
  } | null;
  realIndex?: {
    indexName: string;
    buildMs: number;
    used: boolean;
    scratchDropped: boolean;
    indexDropped: boolean;
    timeoutRestored: boolean;
    connectionClosed: boolean;
  } | null;
  cacheObservations?: string[];
  timeoutRestored?: boolean;
  connectionClosed?: boolean;
}

export function buildQueryLabOperationReport(input: QueryLabReportInput): OperationReport {
  const incomplete: string[] = [];
  if (input.correctness?.status === 'unverified') incomplete.push('Rewrite correctness is unverified; no equality claim is available');
  if (input.correctness?.status === 'different') incomplete.push('Rewrite results differ and are invalid for comparison');
  if (input.verdict?.verdict === 'inconclusive') incomplete.push(`Benchmark verdict is inconclusive: ${input.verdict.reason}`);
  if (input.verdict?.verdict === 'invalid_results') incomplete.push('Result hashes are missing or different');
  if (input.correlation && !input.correlation.comparable) incomplete.push(input.correlation.reason ?? 'Plan correlation is not comparable');
  if (!input.correlation && input.mode === 'measured' && !input.realIndex) incomplete.push('Plan correlation is not available for this timing-only run');
  if (!input.benchmark && !input.realIndex && !input.hypopg && !input.correctness) incomplete.push('No candidate evidence has been captured');

  const sections: OperationReportSection[] = [{
    heading: 'Experiment identity and environment',
    facts: [
      { label: 'Engine', value: input.engine },
      { label: 'Database/schema', value: input.database },
      { label: 'Exact experiment mode', value: input.mode },
      { label: 'Specification SHA-256', value: input.specSha256 },
      { label: 'Candidate', value: `${input.candidate.id} · ${input.candidate.kind} · ${input.candidate.name}` },
      { label: 'Scratch database/schema', value: input.scratch?.database ?? null },
      { label: 'Migration scratch run ID', value: input.scratch?.runKey ?? null },
      { label: 'Environment', value: input.scratch?.environment ?? null },
      { label: 'Read-only target', value: input.scratch?.readOnly ?? null },
      { label: 'Timeout restored', value: input.timeoutRestored ?? null },
      { label: 'Dedicated connection closed', value: input.connectionClosed ?? null },
    ],
    lines: [
      'No query-result rows, credentials or report timestamp are included',
      ...(input.cacheObservations?.length ? input.cacheObservations : ['No complete cache control or cold/warm-cache claim is made']),
    ],
  }];

  if (input.correctness) {
    const value = input.correctness;
    sections.push({
      heading: 'Canonical result correctness',
      facts: [
        { label: 'Correctness', value: value.status },
        { label: 'Reason', value: value.reason },
        { label: 'Row policy', value: value.rowOrder },
        { label: 'Maximum rows', value: value.maxRows },
        { label: 'Maximum decoded bytes', value: value.maxBytes },
        { label: 'Baseline observed rows / bytes', value: `${value.baseline.rows} / ${value.baseline.bytes}` },
        { label: 'Candidate observed rows / bytes', value: `${value.candidate.rows} / ${value.candidate.bytes}` },
        { label: 'Baseline complete', value: value.baseline.complete },
        { label: 'Candidate complete', value: value.candidate.complete },
        { label: 'Baseline SHA-256', value: value.baseline.sha256 },
        { label: 'Candidate SHA-256', value: value.candidate.sha256 },
        { label: 'Baseline unverified reason', value: value.baseline.reason },
        { label: 'Candidate unverified reason', value: value.candidate.reason },
      ],
    });
  }

  if (input.verdict) {
    const verdict = input.verdict;
    sections.push({
      heading: 'Noise-aware verdict',
      facts: [
        { label: 'Verdict', value: verdict.verdict },
        { label: 'Reason', value: verdict.reason },
        { label: 'Baseline median ms', value: verdict.baselineMedianMs },
        { label: 'Candidate median ms', value: verdict.candidateMedianMs },
        { label: 'Median delta ms', value: verdict.deltaMs },
        { label: 'Improvement percent', value: verdict.improvementPct },
        { label: 'Baseline-on-baseline noise ms', value: verdict.noiseFloorMs },
        { label: 'Configured threshold ms', value: verdict.thresholdMs },
      ],
    });
  }

  if (input.benchmark) {
    const benchmark = input.benchmark;
    const stats = (side: 'baseline' | 'candidate') => {
      const summary = benchmark[side];
      return `${summary.count} runs · min ${summary.minMs} ms · median ${summary.medianMs} ms · p95 ${summary.p95Ms} ms · max ${summary.maxMs} ms`;
    };
    sections.push({
      heading: 'Timing distribution and raw observations',
      facts: [
        { label: 'Warmup runs per side', value: benchmark.warmupRuns },
        { label: 'Measured repetitions per side', value: benchmark.repetitions },
        { label: 'Baseline distribution', value: stats('baseline') },
        { label: 'Candidate distribution', value: stats('candidate') },
        { label: 'Baseline raw timings ms', value: `[${benchmark.baselineMs.join(', ')}]` },
        { label: 'Candidate raw timings ms', value: `[${benchmark.candidateMs.join(', ')}]` },
        { label: 'Baseline SHA-256', value: benchmark.baselineSha256 },
        { label: 'Candidate SHA-256', value: benchmark.candidateSha256 },
      ],
      lines: benchmark.pairs.map(pair => `Repetition ${pair.repetition} · ${pair.order} · baseline ${pair.baseline_ms} ms · candidate ${pair.candidate_ms} ms`),
    });
  }

  if (input.hypopg) {
    const value = input.hypopg;
    sections.push({
      heading: 'HypoPG estimate — no query execution',
      facts: [
        { label: 'Verdict', value: value.verdict },
        { label: 'Baseline cost', value: value.baselineCost },
        { label: 'Candidate cost', value: value.candidateCost },
        { label: 'Absolute delta', value: value.absoluteDelta },
        { label: 'Percent delta', value: value.percentDelta },
        { label: 'Created indexes', value: value.created.join(', ') || 'none' },
        { label: 'Used indexes', value: value.used.join(', ') || 'none' },
        { label: 'HypoPG reset complete', value: value.reset },
      ],
      lines: ['Hypothetical plan/cost evidence only; measured runtime comparison is forbidden'],
    });
  }

  if (input.realIndex) {
    const value = input.realIndex;
    sections.push({
      heading: 'Real-index lifecycle',
      facts: [
        { label: 'Generated index', value: value.indexName },
        { label: 'Create wall time ms (lock wait + rebuild)', value: value.buildMs },
        { label: 'Candidate index used', value: value.used },
        { label: 'Candidate index dropped', value: value.indexDropped },
        { label: 'Migration scratch dropped', value: value.scratchDropped },
        { label: 'Timeout restored', value: value.timeoutRestored },
        { label: 'Dedicated connection closed', value: value.connectionClosed },
      ],
    });
  }

  if (input.correlation) {
    const correlation = input.correlation;
    const metric = (side: 'baseline' | 'candidate') => {
      const evidence = correlation[side];
      return [
        `cardinality ${evidence.cardinality ? `${evidence.cardinality.factor}× ${evidence.cardinality.direction} at ${evidence.cardinality.operation} (${evidence.cardinality.estimatedRowsPerLoop} → ${evidence.cardinality.actualRowsPerLoop} rows/loop)` : 'not available'}`,
        `buffers ${evidence.buffers ? `${evidence.buffers.hit} hit / ${evidence.buffers.read} read at ${evidence.buffers.operation}` : 'not available'}`,
        `spills ${evidence.spills.length ? evidence.spills.join(', ') : 'none reported'}`,
      ].join(' · ');
    };
    sections.push({
      heading: 'Plan correlation',
      facts: [
        { label: 'Comparable', value: correlation.comparable },
        { label: 'Reason', value: correlation.reason },
        { label: 'Headline', value: correlation.headline },
        { label: 'Changed / added / removed nodes', value: `${correlation.diff.changed} / ${correlation.diff.added} / ${correlation.diff.removed}` },
        { label: 'Runtime baseline ms', value: correlation.runtime?.baselineMs ?? null },
        { label: 'Runtime candidate ms', value: correlation.runtime?.candidateMs ?? null },
        { label: 'Runtime delta ms', value: correlation.runtime?.deltaMs ?? null },
        { label: 'Runtime improvement percent', value: correlation.runtime?.improvementPct ?? null },
        { label: 'Baseline metrics', value: metric('baseline') },
        { label: 'Candidate metrics', value: metric('candidate') },
      ],
    });
  }

  sections.push({
    heading: 'SQL artifacts — not query-result rows',
    lines: [
      `Original SQL: ${input.originalSql}`,
      ...(input.candidate.sql ? [`Candidate SQL: ${input.candidate.sql}`] : []),
    ],
  });

  return {
    title: 'Query Optimization Lab report',
    subject: `${input.database} · ${input.candidate.id} · ${input.mode}`,
    outcome: input.correctness?.status === 'different' || input.verdict?.verdict === 'invalid_results'
      ? 'failed'
      : incomplete.length ? 'incomplete' : 'completed',
    sections,
    incompleteEvidence: [...new Set(incomplete)],
  };
}

export function renderQueryLabReport(input: QueryLabReportInput): string {
  return renderOperationReport(buildQueryLabOperationReport(input));
}
