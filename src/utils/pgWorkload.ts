import {
  detectReset, diffPgss, isActive, sortByTotalTimeDelta,
  type PgssDiffEntry, type PgssSnapshot,
} from './pgssDiff.ts';
import { aggregate, type Snapshot, type WaitAgg } from './waitAgg.ts';
import { mergeTimeline, type TimelineEvent } from './incidentTimeline.ts';

/** Inclusive epoch-millisecond endpoints shared by all three report sections. */
export interface WorkloadWindow {
  startMs: number;
  endMs: number;
}

export interface WaitCoverage {
  samples: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface PgWorkloadReport {
  window: WorkloadWindow;
  statements: PgssDiffEntry[];
  resetDetected: boolean;
  waits: WaitAgg;
  waitCoverage: WaitCoverage;
  incidents: TimelineEvent[];
}

export function inWorkloadWindow(atMs: number, window: WorkloadWindow): boolean {
  return Number.isFinite(atMs) && atMs >= window.startMs && atMs <= window.endMs;
}

/**
 * Build one coherent view of a manual measurement. Statement counters are
 * diffed by queryid, waits are sampled observations rather than elapsed-time
 * counters, and incidents are local retained events. All three use the same
 * inclusive capture timestamps; a reversed or non-finite interval has no report.
 */
export function correlatePgWorkload(
  before: PgssSnapshot,
  after: PgssSnapshot,
  waitSamples: Snapshot[],
  incidents: TimelineEvent[],
): PgWorkloadReport | null {
  const startMs = before.capturedAt;
  const endMs = after.capturedAt;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;

  const window = { startMs, endMs };
  const sampled = waitSamples.filter(s => inWorkloadWindow(s.atMs, window));
  return {
    window,
    statements: sortByTotalTimeDelta(diffPgss(before, after).filter(isActive)),
    resetDetected: detectReset(before, after),
    waits: aggregate(sampled),
    waitCoverage: {
      samples: sampled.length,
      firstMs: sampled.length ? Math.min(...sampled.map(s => s.atMs)) : null,
      lastMs: sampled.length ? Math.max(...sampled.map(s => s.atMs)) : null,
    },
    incidents: mergeTimeline(incidents.filter(e => inWorkloadWindow(e.at_ms, window))),
  };
}
