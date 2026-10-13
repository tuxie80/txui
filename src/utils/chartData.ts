/**
 * The chart math behind `ResultChart` — column inference, aggregation,
 * sampling and axis ranges.
 *
 * Pure and dependency-free (only `cellText` from the pure exporters), driven
 * by `node --test`. The component keeps the drawing; every decision about
 * *which numbers get drawn* lives here so it can be tested without a DOM.
 *
 * Two judgement calls are deliberate:
 *
 *  - **A column is numeric when most sampled values parse.** One `n/a` in a
 *    column of numbers must not disqualify it; one number in a column of text
 *    must not qualify it. 70% of the first 200 non-null rows is the line.
 *  - **Big results are sampled, never truncated.** A line of the first 2000
 *    rows of a million-row table shows the beginning of the data and pretends
 *    it is the whole; an even stride shows the whole shape at lower
 *    resolution, which is what a chart is for. The stride is always returned
 *    so the UI can say "sampled 1:N" — a silent sample is a lie.
 */
import { cellText } from './exporters.ts';

/** Pseudo Y column: count rows per category instead of summing one. */
export const COUNT = -1;
/** Bar/pie fold every category past this into one "(other)" bucket. */
export const MAX_CATS = 30;
/** Line/area/scatter draw at most this many points per series. */
export const MAX_POINTS = 2000;

/** Parse a cell as a finite number, or null. Blank strings are not 0. */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v));
  return Number.isFinite(n) && String(v).trim() !== '' ? n : null;
}

/** Per column: do most non-null sampled values parse as numbers? */
export function numericCols(columnCount: number, rows: unknown[][]): boolean[] {
  const sample = rows.slice(0, 200);
  return Array.from({ length: columnCount }, (_, ci) => {
    let num = 0, seen = 0;
    for (const r of sample) {
      const v = r[ci];
      if (v === null || v === undefined) continue;
      seen++;
      if (toNum(v) !== null) num++;
    }
    return seen > 0 && num / seen > 0.7;
  });
}

/**
 * Bar/pie data: aggregate rows by the X column (sum of Y, or row count when
 * `yCol` is COUNT), sorted descending, with the tail past `maxCats` folded
 * into a single "(other)" bucket — a 500-slice pie is not a pie.
 */
export function aggregateCategories(
  rows: unknown[][], xCol: number, yCol: number, maxCats = MAX_CATS,
): [string, number][] {
  const agg = new Map<string, number>();
  for (const r of rows) {
    const k = cellText(r[xCol]);
    const v = yCol === COUNT ? 1 : (toNum(r[yCol]) ?? 0);
    agg.set(k, (agg.get(k) ?? 0) + v);
  }
  const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > maxCats) {
    const rest = sorted.slice(maxCats - 1).reduce((s, [, v]) => s + v, 0);
    return [...sorted.slice(0, maxCats - 1), ['(other)', rest] as [string, number]];
  }
  return sorted;
}

export interface Sampled { rows: unknown[][]; stride: number }

/** Even-stride sample down to at most `maxPoints` rows (see the header note). */
export function sampleRows(rows: unknown[][], maxPoints = MAX_POINTS): Sampled {
  const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  return { rows: stride === 1 ? rows : rows.filter((_, i) => i % stride === 0), stride };
}

export interface LineData {
  /** One point list per requested Y column, in request order. */
  series: number[][];
  /** X label per sampled row (row order preserved, NaN points dropped per series). */
  labels: string[];
  stride: number;
}

/** Line/area data: each Y column in sampled row order, non-numeric cells dropped. */
export function lineSeries(
  rows: unknown[][], xCol: number, yCols: number[], maxPoints = MAX_POINTS,
): LineData {
  const { rows: sampled, stride } = sampleRows(rows, maxPoints);
  const series = yCols.map(yCol =>
    sampled.map(r => (yCol === COUNT ? 1 : toNum(r[yCol]) ?? NaN)).filter(Number.isFinite));
  const labels = sampled.map(r => cellText(r[xCol]));
  return { series, labels, stride };
}

export interface ScatterPoint { x: number; y: number }
export interface ScatterData { points: ScatterPoint[]; stride: number }

/**
 * Scatter data: the rows where BOTH columns parse as numbers. A row with one
 * blank side has no position on the plane, so it is dropped rather than
 * plotted at 0 — a pile of points on an axis is a data bug masquerading as a
 * cluster.
 */
export function scatterPoints(
  rows: unknown[][], xCol: number, yCol: number, maxPoints = MAX_POINTS,
): ScatterData {
  const { rows: sampled, stride } = sampleRows(rows, maxPoints);
  const points: ScatterPoint[] = [];
  for (const r of sampled) {
    const x = toNum(r[xCol]);
    const y = toNum(r[yCol]);
    if (x !== null && y !== null) points.push({ x, y });
  }
  return { points, stride };
}

/**
 * Axis range over a set of values.
 *
 * A flat series (min === max) still needs a range to draw in, so it is padded
 * by one. With `anchorZero`, a range that starts near zero is extended to
 * zero — a line from 99.2 to 99.8 drawn full-height reads as a crash and a
 * recovery when nothing moved. Scatter passes false: there the interesting
 * thing is the shape of the cloud, and forcing the origin in can squash it
 * into a corner.
 */
export function niceRange(min: number, max: number, anchorZero = true): [number, number] {
  if (min === max) { min -= 1; max += 1; }
  if (anchorZero && min > 0 && min / max < 0.35) min = 0;
  return [min, max];
}
