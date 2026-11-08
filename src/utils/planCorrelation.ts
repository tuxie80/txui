import { parsePlan } from './planParse.ts';
import type { ParsedPlan, PlanNode } from './planParse.ts';
import { diffPlans } from './planDiff.ts';
import type { PlanDiff } from './planDiff.ts';
import { misestimateOf } from './planCost.ts';

export interface CardinalityEvidence {
  operation: string;
  factor: number;
  estimatedRowsPerLoop: number;
  actualRowsPerLoop: number;
  direction: 'underestimated' | 'overestimated';
}

export interface BufferEvidence {
  operation: string;
  hit: number;
  read: number;
}

export interface PlanMetricEvidence {
  cardinality: CardinalityEvidence | null;
  buffers: BufferEvidence | null;
  spills: string[];
}

export interface RuntimeEvidence {
  baselineMs: number;
  candidateMs: number;
  deltaMs: number;
  improvementPct: number | null;
}

export interface PlanCorrelation {
  comparable: boolean;
  reason: string | null;
  headline: string;
  diff: PlanDiff;
  runtime: RuntimeEvidence | null;
  baseline: PlanMetricEvidence;
  candidate: PlanMetricEvidence;
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function metricEvidence(plan: ParsedPlan): PlanMetricEvidence {
  let cardinality: CardinalityEvidence | null = null;
  let buffers: BufferEvidence | null = null;
  const spills: string[] = [];
  walk(plan.root, node => {
    const factor = misestimateOf(node);
    if (factor !== undefined && Number.isFinite(factor) && (!cardinality || factor > cardinality.factor)) {
      const loops = node.stats.loops && node.stats.loops > 1 ? node.stats.loops : 1;
      const estimatedRowsPerLoop = node.stats.rowsEst ?? 0;
      const actualRowsPerLoop = (node.stats.rowsActual ?? 0) / loops;
      cardinality = {
        operation: node.op,
        factor,
        estimatedRowsPerLoop,
        actualRowsPerLoop,
        direction: actualRowsPerLoop >= estimatedRowsPerLoop ? 'underestimated' : 'overestimated',
      };
    }
    if (node.stats.buffers && (!buffers || node.stats.buffers.read > buffers.read)) {
      buffers = { operation: node.op, ...node.stats.buffers };
    }
    for (const flag of node.stats.flags ?? []) {
      if (/spill|external|temporary|filesort/i.test(flag)) spills.push(`${node.op}: ${flag}`);
    }
  });
  return { cardinality, buffers, spills };
}

export function correlatePlanEvidence(input: {
  engine: 'mysql' | 'postgres';
  baselinePlan: string;
  candidatePlan: string;
  baselineMs?: number | null;
  candidateMs?: number | null;
}): PlanCorrelation {
  const baseline = parsePlan(input.engine, input.baselinePlan);
  const candidate = parsePlan(input.engine, input.candidatePlan);
  const diff = diffPlans(baseline, candidate);
  let runtime: RuntimeEvidence | null = null;
  if (input.baselineMs !== undefined && input.baselineMs !== null
    && input.candidateMs !== undefined && input.candidateMs !== null) {
    if (!Number.isFinite(input.baselineMs) || !Number.isFinite(input.candidateMs)
      || input.baselineMs < 0 || input.candidateMs < 0) throw new Error('runtime evidence must be finite non-negative milliseconds');
    const deltaMs = input.baselineMs - input.candidateMs;
    runtime = {
      baselineMs: input.baselineMs,
      candidateMs: input.candidateMs,
      deltaMs,
      improvementPct: input.baselineMs > 0 ? deltaMs / input.baselineMs * 100 : null,
    };
  }
  return {
    comparable: diff.comparable,
    reason: diff.incomparableReason ?? null,
    headline: diff.headline,
    diff,
    runtime,
    baseline: metricEvidence(baseline),
    candidate: metricEvidence(candidate),
  };
}
