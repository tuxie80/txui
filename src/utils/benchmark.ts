export type BenchmarkSide = 'baseline' | 'candidate';

export interface BenchmarkStep {
  phase: 'warmup' | 'measured';
  repetition: number;
  side: BenchmarkSide;
}

export interface BenchmarkPair {
  repetition: number;
  order: 'baseline_first' | 'candidate_first';
}

export function benchmarkSteps(warmupRuns: number, repetitions: number): BenchmarkStep[] {
  if (!Number.isSafeInteger(warmupRuns) || warmupRuns < 0 || warmupRuns > 10) throw new Error('warmupRuns must be an integer between 0 and 10');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 30) throw new Error('repetitions must be an integer between 1 and 30');
  const steps: BenchmarkStep[] = [];
  const append = (phase: BenchmarkStep['phase'], repetition: number, side: BenchmarkSide) => {
    steps.push({ phase, repetition, side });
  };
  for (let repetition = 1; repetition <= warmupRuns; repetition++) {
    const baselineFirst = repetition % 2 === 1;
    append('warmup', repetition, baselineFirst ? 'baseline' : 'candidate');
    append('warmup', repetition, baselineFirst ? 'candidate' : 'baseline');
  }
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const baselineFirst = repetition % 2 === 1;
    append('measured', repetition, baselineFirst ? 'baseline' : 'candidate');
    append('measured', repetition, baselineFirst ? 'candidate' : 'baseline');
  }
  return steps;
}

export function benchmarkPairs(repetitions: number): BenchmarkPair[] {
  return benchmarkSteps(0, repetitions)
    .filter(step => step.side === 'baseline')
    .map(step => ({ repetition: step.repetition, order: step.repetition % 2 === 1 ? 'baseline_first' : 'candidate_first' }));
}

export interface TimingSummary {
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

export function summarizeTimings(values: readonly number[]): TimingSummary {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('timings must be non-empty finite non-negative numbers');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    maxMs: sorted[sorted.length - 1],
  };
}

export function baselineNoiseMs(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const differences = values.slice(1).map((value, index) => Math.abs(value - values[index]));
  return summarizeTimings(differences).medianMs;
}

export interface BenchmarkVerdictInput {
  baselineMs: readonly number[];
  candidateMs: readonly number[];
  baselineSha256: string | null;
  candidateSha256: string | null;
  improvementThresholdPct: number;
  candidateKind: 'rewrite' | 'index';
  indexUsed?: boolean | null;
}

export interface BenchmarkVerdict {
  verdict: 'improved' | 'regressed' | 'inconclusive' | 'invalid_results';
  reason: string;
  baselineMedianMs: number | null;
  candidateMedianMs: number | null;
  deltaMs: number | null;
  improvementPct: number | null;
  noiseFloorMs: number | null;
  thresholdMs: number | null;
}

export function benchmarkVerdict(input: BenchmarkVerdictInput): BenchmarkVerdict {
  const empty = {
    baselineMedianMs: null, candidateMedianMs: null, deltaMs: null,
    improvementPct: null, noiseFloorMs: null, thresholdMs: null,
  };
  if (!input.baselineSha256 || input.baselineSha256 !== input.candidateSha256) {
    return { verdict: 'invalid_results', reason: 'Complete canonical result hashes are missing or different; timing cannot produce a winner.', ...empty };
  }
  if (input.baselineMs.length < 3 || input.candidateMs.length < 3
    || input.baselineMs.length !== input.candidateMs.length) {
    return { verdict: 'inconclusive', reason: 'At least three matched baseline/candidate pairs are required for a noise-aware verdict.', ...empty };
  }
  if (input.candidateKind === 'index' && input.indexUsed !== true) {
    return { verdict: 'inconclusive', reason: 'The candidate index was not proven to be used; timing cannot produce an index improvement.', ...empty };
  }
  if (!Number.isFinite(input.improvementThresholdPct)
    || input.improvementThresholdPct < 0 || input.improvementThresholdPct > 100) {
    throw new Error('improvementThresholdPct must be between 0 and 100');
  }
  const baseline = summarizeTimings(input.baselineMs);
  const candidate = summarizeTimings(input.candidateMs);
  const noiseFloorMs = baselineNoiseMs(input.baselineMs);
  const thresholdMs = baseline.medianMs * input.improvementThresholdPct / 100;
  const deltaMs = baseline.medianMs - candidate.medianMs;
  const improvementPct = baseline.medianMs > 0 ? deltaMs / baseline.medianMs * 100 : null;
  const shared = {
    baselineMedianMs: baseline.medianMs,
    candidateMedianMs: candidate.medianMs,
    deltaMs,
    improvementPct,
    noiseFloorMs,
    thresholdMs,
  };
  const requiredMs = Math.max(noiseFloorMs ?? 0, thresholdMs);
  if (baseline.medianMs <= 0) {
    return { verdict: 'inconclusive', reason: 'A zero baseline median cannot establish a relative improvement or noise floor.', ...shared };
  }
  if (deltaMs > requiredMs) {
    return { verdict: 'improved', reason: `Candidate median is ${deltaMs} ms faster, exceeding the ${requiredMs} ms noise/threshold floor.`, ...shared };
  }
  if (-deltaMs > requiredMs) {
    return { verdict: 'regressed', reason: `Candidate median is ${-deltaMs} ms slower, exceeding the ${requiredMs} ms noise/threshold floor.`, ...shared };
  }
  return { verdict: 'inconclusive', reason: `The ${deltaMs} ms median delta does not exceed the ${requiredMs} ms noise/threshold floor.`, ...shared };
}
