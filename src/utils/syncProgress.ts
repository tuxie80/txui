/**
 * What the progress bar knows, and what it refuses to pretend it knows.
 *
 * Three things make a copy's progress bar honest, and each of them was a
 * measurement rather than a preference.
 *
 * **1. Rows are not the whole job.** On the measured 598,689-row table the load
 * took 1,290 ms and rebuilding the four secondary indexes took a further
 * 778 ms — **37.6% of the work**. A bar that counts only rows sits at 100% for
 * more than a third of the run, which is the exact moment a person decides the
 * tool has hung. Phases are therefore weighted, and the weights come from that
 * measurement.
 *
 * **2. The denominator is an estimate.** `TABLE_ROWS` is InnoDB's guess and can
 * be out by a wide margin, so a copy can legitimately deliver more rows than
 * the total it was given. Progress is clamped and the overshoot is *reported*
 * rather than hidden — a bar that sticks at 99% while rows keep arriving is a
 * bar nobody trusts again.
 *
 * **3. A rate needs a window.** Averaging over the whole run makes a copy that
 * has slowed to a crawl still show its opening throughput, so the estimate
 * keeps promising a finish that recedes. The rate here is windowed over the
 * recent past, which means it reacts — and can be noisy, so the ETA is
 * suppressed until enough samples exist to be worth printing.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type Phase =
  | 'analyse'      // sampling row sizes, reading the catalog
  | 'schema'       // creating PK-only tables
  | 'data'         // streaming rows
  | 'indexes'      // rebuilding secondary indexes, FKs, checks
  | 'verify'       // counts and checksums
  | 'done'
  | 'cancelled'
  | 'failed';

/**
 * How much of a table's wall time each phase is worth.
 *
 * `data` and `indexes` come straight from the measurement above (62.4 / 37.6
 * of the two together). The rest are small and roughly observed: analysis is a
 * few sampled reads, schema is one statement per table, and verification is a
 * single pass costing about a quarter of a load (measured: 344 ms of checksum
 * against 1,290 ms of load).
 */
export const PHASE_WEIGHTS: Record<Exclude<Phase, 'done' | 'cancelled' | 'failed'>, number> = {
  analyse: 0.03,
  schema: 0.02,
  data: 0.58,
  indexes: 0.25,
  verify: 0.12,
};

export interface TableProgress {
  schema: string;
  table: string;
  phase: Phase;
  /** Rows delivered so far. */
  rowsDone: number;
  /** Estimated total — `null` when unknown, never a guess dressed as a fact. */
  rowsTotal: number | null;
  chunksDone: number;
  chunksTotal: number | null;
  /** Set when the table finished, so it stops contributing to the rate. */
  finishedAt?: number;
}

/** One observation, for the windowed rate. */
export interface RateSample {
  at: number;
  rows: number;
  bytes: number;
}

export const RATE_WINDOW_MS = 15_000;
/** Below this many samples an ETA is noise, so none is shown. */
export const MIN_SAMPLES_FOR_ETA = 3;

/**
 * How far through one table we are, weighting phases by their real cost.
 *
 * A table in `indexes` is at least 63% done however many rows it has left,
 * because the rows are already in. Without that the bar goes backwards when a
 * table moves from streaming to rebuilding, which reads as a failure.
 */
export function tableFraction(t: TableProgress): number {
  const order: Phase[] = ['analyse', 'schema', 'data', 'indexes', 'verify'];
  if (t.phase === 'done') return 1;
  // A table that was cancelled or failed contributes nothing to *completion*:
  // its rows may be on the target, but the job it represents did not finish and
  // a bar that counted it would say the run went further than it did.
  if (t.phase === 'cancelled' || t.phase === 'failed') return 0;

  const idx = order.indexOf(t.phase);
  if (idx < 0) return 0;
  let done = 0;
  for (let i = 0; i < idx; i++) {
    done += PHASE_WEIGHTS[order[i] as keyof typeof PHASE_WEIGHTS];
  }
  const weight = PHASE_WEIGHTS[t.phase as keyof typeof PHASE_WEIGHTS];
  // Only the data phase has meaningful sub-progress; the others are short
  // enough that pretending to interpolate them would be invented precision.
  if (t.phase === 'data' && t.rowsTotal && t.rowsTotal > 0) {
    done += weight * Math.min(1, t.rowsDone / t.rowsTotal);
  } else if (t.phase === 'data' && t.chunksTotal && t.chunksTotal > 0) {
    done += weight * Math.min(1, t.chunksDone / t.chunksTotal);
  }
  return Math.min(1, done);
}

export interface OverallProgress {
  /** 0..1, or `null` when no table has a usable total. */
  fraction: number | null;
  tablesDone: number;
  tablesTotal: number;
  rowsDone: number;
  /** Sum of estimates; `null` if any table's is unknown. */
  rowsTotal: number | null;
  /** True when more rows arrived than the estimate promised. */
  overshot: boolean;
}

/**
 * The overall bar.
 *
 * Each table contributes equally rather than by size. Weighting by estimated
 * rows sounds better and behaves worse: the estimates are unreliable (see
 * `syncChunkAnalysis`), so a bar weighted by them lurches when a table turns
 * out to be twice its estimate. Equal weighting is wrong in a predictable way,
 * which is the kind of wrong a person can read past.
 */
export function overallProgress(tables: TableProgress[]): OverallProgress {
  const total = tables.length;
  const done = tables.filter(t => t.phase === 'done').length;
  const rowsDone = tables.reduce((n, t) => n + t.rowsDone, 0);

  let rowsTotal: number | null = 0;
  for (const t of tables) {
    if (t.rowsTotal === null) { rowsTotal = null; break; }
    rowsTotal += t.rowsTotal;
  }

  const fraction = total === 0
    ? null
    : tables.reduce((sum, t) => sum + tableFraction(t), 0) / total;

  return {
    fraction,
    tablesDone: done,
    tablesTotal: total,
    rowsDone,
    rowsTotal,
    overshot: rowsTotal !== null && rowsDone > rowsTotal,
  };
}

/**
 * Rows per second over the recent past.
 *
 * Windowed, not cumulative: a copy that has slowed to a crawl must show the
 * crawl, or the finish time it promises recedes for the rest of the run.
 */
export function currentRate(samples: RateSample[], now: number, windowMs = RATE_WINDOW_MS): {
  rowsPerSec: number | null;
  bytesPerSec: number | null;
  samples: number;
} {
  const recent = samples.filter(s => now - s.at <= windowMs);
  if (recent.length < 2) return { rowsPerSec: null, bytesPerSec: null, samples: recent.length };
  const first = recent[0];
  const span = (now - first.at) / 1000;
  if (span <= 0) return { rowsPerSec: null, bytesPerSec: null, samples: recent.length };
  const rows = recent.reduce((n, s) => n + s.rows, 0) - first.rows;
  const bytes = recent.reduce((n, s) => n + s.bytes, 0) - first.bytes;
  return {
    rowsPerSec: Math.max(0, rows / span),
    bytesPerSec: Math.max(0, bytes / span),
    samples: recent.length,
  };
}

/**
 * Seconds remaining, or `null`.
 *
 * Returns `null` far more readily than a typical bar does. An ETA is only shown
 * when the total is known, the rate has enough samples to mean something, and
 * there is work left — because a wrong ETA is worse than none: it is the thing
 * people plan around.
 */
export function estimateRemaining(
  overall: OverallProgress,
  rate: { rowsPerSec: number | null; samples: number },
): number | null {
  if (overall.rowsTotal === null) return null;
  if (rate.rowsPerSec === null || rate.rowsPerSec <= 0) return null;
  if (rate.samples < MIN_SAMPLES_FOR_ETA) return null;
  const left = overall.rowsTotal - overall.rowsDone;
  if (left <= 0) return null;
  // Rows are 58% of the work; the remaining phases scale with what is left.
  const dataSeconds = left / rate.rowsPerSec;
  return dataSeconds / PHASE_WEIGHTS.data;
}

/** `2 min 3 s` / `45 s` / `~1 h 12 min` — the same shape as the run log. */
export function formatEta(seconds: number | null): string {
  if (seconds === null) return 'estimating…';
  const s = Math.max(0, Math.round(seconds));
  // "0 s left" beside a bar at 34% reads as broken. Under a second there is
  // nothing useful to promise, so say that instead of a number.
  if (seconds > 0 && s === 0) return '<1 s';
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${m} min` : `${m} min ${r} s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The single line above the bar.
 *
 * Says what is happening now, not only how far along it is — "copying
 * orders (3 of 12)" tells someone whether the pause they are looking at is
 * normal, and a bare percentage does not.
 */
export function statusLine(
  tables: TableProgress[],
  overall: OverallProgress,
  rate: { rowsPerSec: number | null },
  etaSeconds: number | null,
): string {
  const active = tables.find(t =>
    t.phase !== 'done' && t.phase !== 'cancelled' && t.phase !== 'failed');
  const verb: Record<string, string> = {
    analyse: 'analysing', schema: 'creating', data: 'copying',
    indexes: 'rebuilding indexes on', verify: 'verifying',
  };

  if (!active) {
    return overall.tablesDone === overall.tablesTotal && overall.tablesTotal > 0
      ? `Done — ${overall.rowsDone.toLocaleString()} rows across `
        + `${overall.tablesTotal} table${overall.tablesTotal === 1 ? '' : 's'}.`
      : 'Idle.';
  }

  const where = `${verb[active.phase] ?? active.phase} ${active.schema}.${active.table}`;
  const pos = `${overall.tablesDone + 1} of ${overall.tablesTotal}`;
  const speed = rate.rowsPerSec !== null
    ? ` · ${Math.round(rate.rowsPerSec).toLocaleString()} rows/s`
    : '';
  const eta = etaSeconds !== null ? ` · ${formatEta(etaSeconds)} left` : '';
  const over = overall.overshot ? ' · more rows than estimated' : '';
  return `${where} (${pos})${speed}${eta}${over}`;
}

/** Percentage for the bar itself, or `null` to render it indeterminate. */
export function barPercent(overall: OverallProgress): number | null {
  return overall.fraction === null ? null : Math.round(overall.fraction * 100);
}
