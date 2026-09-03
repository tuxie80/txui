/**
 * Progress reporting (src/utils/syncProgress.ts).
 *
 * The phase weights are not chosen — they come from the measured run: 1,290 ms
 * loading 598,689 rows and 778 ms rebuilding four secondary indexes, so index
 * rebuild is 37.6% of a table's work. A bar counting only rows sits at 100%
 * for that entire stretch, which is exactly when a person decides it has hung.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_WEIGHTS, tableFraction, overallProgress, currentRate, estimateRemaining,
  formatEta, statusLine, barPercent, MIN_SAMPLES_FOR_ETA, RATE_WINDOW_MS,
} from '../src/utils/syncProgress.ts';
import type { TableProgress, RateSample } from '../src/utils/syncProgress.ts';

const t = (over: Partial<TableProgress> = {}): TableProgress => ({
  schema: 'db', table: 't', phase: 'data',
  rowsDone: 0, rowsTotal: 1000, chunksDone: 0, chunksTotal: 10, ...over,
});

// ── phase weighting ─────────────────────────────────────────────────────────

test('the weights sum to one', () => {
  const total = Object.values(PHASE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, String(total));
});

test('index rebuild is weighted as real work, not a rounding error', () => {
  // Measured at 37.6% of load+rebuild. If this drops toward zero the bar will
  // stall at 100% again.
  assert.ok(PHASE_WEIGHTS.indexes > 0.2, String(PHASE_WEIGHTS.indexes));
});

test('progress never goes BACKWARDS when a table leaves the data phase', () => {
  // The failure this prevents: rows finish, the bar is high, then the table
  // moves to index rebuild and the bar drops — which reads as a fault.
  const streaming = tableFraction(t({ phase: 'data', rowsDone: 1000, rowsTotal: 1000 }));
  const rebuilding = tableFraction(t({ phase: 'indexes', rowsDone: 1000, rowsTotal: 1000 }));
  const verifying = tableFraction(t({ phase: 'verify', rowsDone: 1000, rowsTotal: 1000 }));
  assert.ok(rebuilding >= streaming, `${rebuilding} < ${streaming}`);
  assert.ok(verifying >= rebuilding, `${verifying} < ${rebuilding}`);
});

test('a table in index rebuild is already most of the way through', () => {
  // All the rows are in; only the rebuild remains.
  assert.ok(tableFraction(t({ phase: 'indexes' })) >= 0.6);
});

test('the data phase interpolates on rows', () => {
  const half = tableFraction(t({ phase: 'data', rowsDone: 500, rowsTotal: 1000 }));
  const none = tableFraction(t({ phase: 'data', rowsDone: 0, rowsTotal: 1000 }));
  assert.ok(half > none);
  assert.ok(half < tableFraction(t({ phase: 'data', rowsDone: 1000, rowsTotal: 1000 })));
});

test('it falls back to chunks when the row total is unknown', () => {
  const f = tableFraction(t({ phase: 'data', rowsTotal: null, chunksDone: 5, chunksTotal: 10 }));
  assert.ok(f > tableFraction(t({ phase: 'data', rowsTotal: null, chunksDone: 0, chunksTotal: 10 })));
});

test('a done table is complete, whatever its counters say', () => {
  assert.equal(tableFraction(t({ phase: 'done', rowsDone: 0, rowsTotal: 999 })), 1);
});

test('overshooting the estimate cannot push a table past 100%', () => {
  // TABLE_ROWS is a guess and can be well under the truth.
  assert.ok(tableFraction(t({ phase: 'data', rowsDone: 5000, rowsTotal: 1000 })) <= 1);
});

// ── overall ─────────────────────────────────────────────────────────────────

test('overall is the mean of the tables', () => {
  const o = overallProgress([t({ phase: 'done' }), t({ phase: 'analyse' })]);
  assert.ok(o.fraction !== null && o.fraction > 0.4 && o.fraction < 0.6, String(o.fraction));
  assert.equal(o.tablesDone, 1);
  assert.equal(o.tablesTotal, 2);
});

test('one unknown row total makes the SUM unknown, not zero', () => {
  const o = overallProgress([t({ rowsTotal: 100 }), t({ rowsTotal: null })]);
  assert.equal(o.rowsTotal, null);
});

test('overshoot is reported rather than hidden', () => {
  // A bar stuck at 99% while rows keep arriving is one nobody trusts again.
  const o = overallProgress([t({ rowsDone: 2000, rowsTotal: 1000 })]);
  assert.equal(o.overshot, true);
});

test('an empty run has no fraction rather than 0% or 100%', () => {
  assert.equal(overallProgress([]).fraction, null);
  assert.equal(barPercent(overallProgress([])), null);
});

test('the bar renders a whole percentage', () => {
  assert.equal(barPercent(overallProgress([t({ phase: 'done' })])), 100);
});

// ── rate ────────────────────────────────────────────────────────────────────

const samples = (spec: [number, number][]): RateSample[] =>
  spec.map(([at, rows]) => ({ at, rows, bytes: rows * 100 }));

test('a rate needs at least two samples', () => {
  assert.equal(currentRate(samples([[0, 0]]), 1000).rowsPerSec, null);
});

test('the rate is windowed, not cumulative', () => {
  // A copy that has slowed must SHOW the slowdown, or the finish time it
  // promises recedes for the rest of the run.
  const now = 100_000;
  const old = samples([[0, 100_000], [1_000, 100_000]]);      // long ago, fast
  const recent = samples([[now - 4_000, 10], [now - 2_000, 10], [now, 10]]);
  const r = currentRate([...old, ...recent], now, RATE_WINDOW_MS);
  assert.ok(r.rowsPerSec !== null && r.rowsPerSec < 1000,
    `stale fast samples leaked in: ${r.rowsPerSec}`);
});

test('samples outside the window are ignored entirely', () => {
  const now = 100_000;
  const r = currentRate(samples([[0, 5], [1, 5]]), now, RATE_WINDOW_MS);
  assert.equal(r.rowsPerSec, null);
  assert.equal(r.samples, 0);
});

test('a zero time span does not divide by zero', () => {
  const r = currentRate(samples([[500, 1], [500, 1]]), 500);
  assert.equal(r.rowsPerSec, null);
});

// ── ETA ─────────────────────────────────────────────────────────────────────

const rate = (rowsPerSec: number | null, n = 10) => ({ rowsPerSec, samples: n });

test('no ETA without a known total', () => {
  const o = overallProgress([t({ rowsTotal: null })]);
  assert.equal(estimateRemaining(o, rate(100)), null);
});

test('no ETA until the rate has enough samples', () => {
  // A wrong ETA is worse than none — it is the thing people plan around.
  const o = overallProgress([t({ rowsDone: 0, rowsTotal: 10_000 })]);
  assert.equal(estimateRemaining(o, rate(100, MIN_SAMPLES_FOR_ETA - 1)), null);
  assert.ok(estimateRemaining(o, rate(100, MIN_SAMPLES_FOR_ETA)) !== null);
});

test('no ETA when there is nothing left', () => {
  const o = overallProgress([t({ rowsDone: 1000, rowsTotal: 1000, phase: 'done' })]);
  assert.equal(estimateRemaining(o, rate(100)), null);
});

test('a zero or negative rate yields no ETA', () => {
  const o = overallProgress([t({ rowsDone: 0, rowsTotal: 1000 })]);
  assert.equal(estimateRemaining(o, rate(0)), null);
  assert.equal(estimateRemaining(o, rate(null)), null);
});

test('the ETA accounts for the phases after the data', () => {
  // Rows are 58% of the work; an ETA covering only rows under-promises by
  // nearly half and then overruns.
  const o = overallProgress([t({ rowsDone: 0, rowsTotal: 5_800 })]);
  const eta = estimateRemaining(o, rate(100))!;
  assert.ok(eta > 58, `${eta} looks like rows-only`);
  assert.ok(Math.abs(eta - 100) < 1, String(eta));
});

test('durations read the way a person says them', () => {
  assert.equal(formatEta(null), 'estimating…');
  assert.equal(formatEta(45), '45 s');
  // "0 s left" beside a bar at 34% reads as broken.
  assert.equal(formatEta(0.4), '<1 s');
  assert.equal(formatEta(0), '0 s');
  assert.equal(formatEta(120), '2 min');
  assert.equal(formatEta(123), '2 min 3 s');
  assert.equal(formatEta(3600), '1 h');
  assert.equal(formatEta(4320), '1 h 12 min');
  assert.equal(formatEta(-5), '0 s');
});

// ── the status line ─────────────────────────────────────────────────────────

test('the line names what is happening, not just a percentage', () => {
  // "copying orders (3 of 12)" tells someone whether the pause they are looking
  // at is normal. A bare percentage does not.
  const tables = [t({ phase: 'done' }), t({ table: 'orders', phase: 'data' })];
  const line = statusLine(tables, overallProgress(tables), { rowsPerSec: 12_345 }, 90);
  assert.match(line, /copying db\.orders/);
  assert.match(line, /2 of 2/);
  assert.match(line, /12,345 rows\/s/);
  assert.match(line, /1 min 30 s left/);
});

test('the index phase is named, so a long pause is explained', () => {
  const tables = [t({ table: 'big', phase: 'indexes' })];
  assert.match(statusLine(tables, overallProgress(tables), { rowsPerSec: null }, null),
    /rebuilding indexes on db\.big/);
});

test('an unknown rate simply omits the speed rather than showing zero', () => {
  const tables = [t()];
  const line = statusLine(tables, overallProgress(tables), { rowsPerSec: null }, null);
  assert.ok(!line.includes('rows/s'), line);
  assert.ok(!line.includes('left'), line);
});

test('overshoot is surfaced in the line', () => {
  const tables = [t({ rowsDone: 5000, rowsTotal: 1000 })];
  assert.match(statusLine(tables, overallProgress(tables), { rowsPerSec: 1 }, null),
    /more rows than estimated/);
});

test('a finished run says so with its totals', () => {
  const tables = [t({ phase: 'done', rowsDone: 1000 })];
  const line = statusLine(tables, overallProgress(tables), { rowsPerSec: null }, null);
  assert.match(line, /^Done — 1,000 rows across 1 table\./);
});

test('a cancelled or failed table contributes nothing to completion', () => {
  // Its rows may be on the target, but the job did not finish — a bar that
  // counted it would say the run went further than it did.
  assert.equal(tableFraction(t({ phase: 'cancelled', rowsDone: 999, rowsTotal: 1000 })), 0);
  assert.equal(tableFraction(t({ phase: 'failed', rowsDone: 999, rowsTotal: 1000 })), 0);
});
