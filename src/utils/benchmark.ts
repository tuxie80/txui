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
