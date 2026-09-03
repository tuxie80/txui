/**
 * Choosing a chunk size by looking at the data, then correcting from what
 * actually comes back.
 *
 * `information_schema.AVG_ROW_LENGTH` is the obvious input and it is not good
 * enough. It is InnoDB's on-disk accounting — `data_length / rows`, including
 * page overhead and fill factor — not the size of a row on the wire. Measured
 * against real tables:
 *
 *   hr_demo.salaries        est   46 B   sampled  31 B     1.5× over
 *   txui_sync_src.invoice   est  134 B   sampled  40 B     3.4× over
 *   txui_types.torture      est 3276 B   sampled  16 B   204.8× over
 *   txui_nopk.uniq_only     est 8192 B   sampled   3 B  2730.7× over
 *
 * It over-estimates always, and catastrophically on small tables, where the
 * 16 KB page dominates. Over-estimating is *safe* — it makes chunks smaller —
 * but it means a table that could stream in 50,000-row chunks crawls in 8,000.
 *
 * So the mechanism has three stages:
 *
 *   1. **Analyse** — sample real rows and measure their true size, keeping the
 *      *maximum* as well as the average. A table of mostly-small rows with a
 *      few large BLOBs has an average that will not protect memory.
 *   2. **Plan** — size the first chunk from that, bounded by a memory budget.
 *   3. **Adapt** — after each chunk, compare the bytes and time that actually
 *      arrived against the target and correct. Statistics can be stale; what
 *      just came back over the wire cannot be.
 *
 * **This does not weaken consistency.** Every chunk is read inside the one
 * snapshot transaction (docs/DBSYNC_DEEPDIVE.md §8.1), and changing how many
 * rows the next `LIMIT` asks for does not change *which* rows exist — the read
 * view is fixed the moment the transaction opens. Adaptation is a performance
 * decision taken entirely inside a consistency boundary that is already closed.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

import {
  MIN_ROWS_PER_CHUNK, MAX_ROWS_PER_CHUNK, DEFAULT_ROWS_PER_CHUNK,
  DEFAULT_CHUNK_BYTES,
} from './syncChunk.ts';

/** What a sample of real rows revealed. */
export interface RowSizeSample {
  /** Rows actually measured. */
  sampled: number;
  /** Mean wire bytes per row. */
  avgBytes: number;
  /** Largest row seen — what the memory bound must respect. */
  maxBytes: number;
  /** 95th percentile, when the sampler could produce one. */
  p95Bytes?: number;
}

/** Primary-key spread, which decides whether ranges can be precomputed. */
export interface KeyDensity {
  minKey: number | null;
  maxKey: number | null;
  rows: number | null;
}

export interface TableProfile {
  /** InnoDB's estimate, kept only to report how far off it was. */
  estimatedAvgRowLength: number | null;
  sample: RowSizeSample | null;
  density: KeyDensity | null;
  /** Columns whose type can hold megabytes — the memory hazard. */
  lobColumns: string[];
}

/**
 * The statement that samples row sizes.
 *
 * Deliberately reads from **three positions** rather than the head of the
 * table: rows often grow over time, so `LIMIT 1000` from the start of a
 * ten-year-old table measures the oldest and smallest rows and under-estimates
 * everything that follows.
 *
 * `LENGTH(CONCAT_WS(…))` approximates the wire size closely enough to size a
 * buffer, and costs one index-ordered read of a few thousand rows.
 */
export function rowSampleSql(
  schema: string,
  table: string,
  columns: string[],
  keyColumns: string[],
  perPosition = 500,
): string {
  const q = (n: string) => '`' + n.replace(/`/g, '``') + '`';
  const from = `${q(schema)}.${q(table)}`;
  const expr = `LENGTH(CONCAT_WS('|', ${columns.map(q).join(', ')}))`;
  const key = keyColumns.length > 0 ? keyColumns.map(q).join(', ') : null;

  if (!key) {
    return `SELECT COUNT(*) AS n, AVG(${expr}) AS avg_b, MAX(${expr}) AS max_b\n`
      + `FROM (SELECT * FROM ${from} LIMIT ${perPosition * 3}) s`;
  }
  // Head, middle and tail, so growth over time is visible.
  const head = `(SELECT * FROM ${from} ORDER BY ${key} LIMIT ${perPosition})`;
  const tail = `(SELECT * FROM ${from} ORDER BY ${key} DESC LIMIT ${perPosition})`;
  return `SELECT COUNT(*) AS n, AVG(${expr}) AS avg_b, MAX(${expr}) AS max_b\n`
    + `FROM (${head} UNION ALL ${tail}) s`;
}

/** `MIN`/`MAX` of a single-column integer key, for range precomputation. */
export function keyDensitySql(schema: string, table: string, keyColumn: string): string {
  const q = (n: string) => '`' + n.replace(/`/g, '``') + '`';
  return `SELECT MIN(${q(keyColumn)}) AS lo, MAX(${q(keyColumn)}) AS hi, COUNT(*) AS n\n`
    + `FROM ${q(schema)}.${q(table)}`;
}

/**
 * How sparse the key is.
 *
 * `1.0` means every value between min and max is used. `100.0` means only one
 * in a hundred is — a table that has been heavily deleted from, or one using a
 * distributed id scheme.
 *
 * It matters because precomputed ranges assume even spread: splitting
 * `1..1_000_000` into twenty ranges gives twenty equal chunks only if the ids
 * are dense. On a sparse key the same split produces wildly uneven chunks, some
 * empty and some enormous — which is worse than not parallelising at all.
 */
export function keySparsity(d: KeyDensity): number | null {
  if (d.minKey === null || d.maxKey === null || !d.rows || d.rows <= 0) return null;
  const span = d.maxKey - d.minKey + 1;
  return span <= 0 ? null : span / d.rows;
}

/** Above this, precomputed ranges are too uneven to be worth it. */
export const MAX_SPARSITY_FOR_RANGES = 4;

export function canPrecomputeRanges(d: KeyDensity | null): boolean {
  const s = d ? keySparsity(d) : null;
  return s !== null && s <= MAX_SPARSITY_FOR_RANGES;
}

/** LOB types — a single row can be megabytes, so the average lies. */
const LOB_TYPES = new Set([
  'mediumblob', 'longblob', 'mediumtext', 'longtext', 'json', 'geometry',
]);

export function lobColumns(cols: { name: string; dataType: string }[]): string[] {
  return cols.filter(c => LOB_TYPES.has(c.dataType.trim().toLowerCase())).map(c => c.name);
}

export interface SizingResult {
  rowsPerChunk: number;
  /** Bytes one chunk is expected to hold, at the size chosen. */
  expectedBytes: number;
  /** Worst case, using the largest row seen — what memory must survive. */
  worstCaseBytes: number;
  /** What decided it, for the report and the log. */
  basis: 'sample' | 'estimate' | 'default';
  note: string;
}

/**
 * The initial chunk size, from the best evidence available.
 *
 * The **maximum** row governs the memory bound, not the average. A table of
 * 1 KB rows with a handful of 8 MB BLOBs has an average that says 50,000 rows
 * is 50 MB and a reality where one chunk can be 400 GB. Sizing on the average
 * and hoping is how a copy tool runs a machine out of memory on the one table
 * that mattered.
 */
export function sizeFromProfile(
  profile: TableProfile,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  softCap = DEFAULT_ROWS_PER_CHUNK,
): SizingResult {
  const clamp = (n: number) =>
    Math.max(MIN_ROWS_PER_CHUNK, Math.min(MAX_ROWS_PER_CHUNK, softCap, Math.floor(n)));

  if (profile.sample && profile.sample.sampled > 0 && profile.sample.avgBytes > 0) {
    const { avgBytes, maxBytes } = profile.sample;
    // Memory is bounded by the worst row, throughput estimated from the mean.
    const byWorst = maxBytes > 0 ? chunkBytes / maxBytes : Infinity;
    const byAvg = chunkBytes / avgBytes;
    // Halfway in log space: neither the optimistic mean nor the pessimistic max
    // alone. A table whose max is 10× its mean gets roughly a third of the
    // rows the mean would allow — enough headroom to survive a run of large
    // rows without collapsing to a crawl.
    const rows = clamp(Math.sqrt(byWorst * byAvg));
    const est = profile.estimatedAvgRowLength;
    const drift = est && avgBytes > 0 ? est / avgBytes : null;
    return {
      rowsPerChunk: rows,
      expectedBytes: Math.round(rows * avgBytes),
      worstCaseBytes: Math.round(rows * maxBytes),
      basis: 'sample',
      note: `Sampled ${profile.sample.sampled.toLocaleString()} rows: mean `
        + `${Math.round(avgBytes)} B, largest ${Math.round(maxBytes)} B`
        + (drift && drift > 1.5
          ? ` — InnoDB's AVG_ROW_LENGTH said ${est} B, ${drift.toFixed(1)}× the measured mean`
          : '')
        + `. Sized so a chunk of the largest rows still fits `
        + `${Math.round(chunkBytes / 1048576)} MB.`
        + (profile.lobColumns.length > 0
          ? ` Contains LOB columns (${profile.lobColumns.join(', ')}), so the maximum governs.`
          : ''),
    };
  }

  if (profile.estimatedAvgRowLength && profile.estimatedAvgRowLength > 0) {
    const rows = clamp(chunkBytes / profile.estimatedAvgRowLength);
    return {
      rowsPerChunk: rows,
      expectedBytes: rows * profile.estimatedAvgRowLength,
      worstCaseBytes: rows * profile.estimatedAvgRowLength,
      basis: 'estimate',
      note: `No sample taken — using InnoDB's AVG_ROW_LENGTH of `
        + `${profile.estimatedAvgRowLength} B, which over-estimates (measured up to `
        + '2,730× on a small table), so chunks will be conservative.',
    };
  }

  return {
    rowsPerChunk: Math.min(DEFAULT_ROWS_PER_CHUNK, softCap),
    expectedBytes: 0,
    worstCaseBytes: 0,
    basis: 'default',
    note: 'Neither a sample nor a row-length estimate was available — starting at the '
      + 'measured default and adapting from the first chunk.',
  };
}

// ── the feedback loop ────────────────────────────────────────────────────────

export interface ChunkFeedback {
  /** Rows the last chunk actually returned. */
  rows: number;
  /** Bytes it actually occupied. */
  bytes: number;
  /** Wall time it took, ms. */
  ms: number;
}

export interface AdaptResult {
  rowsPerChunk: number;
  changed: boolean;
  reason: string;
}

/** Never move more than this proportion in one step. */
export const MAX_ADAPT_FACTOR = 2;
/** Ignore differences smaller than this — otherwise the size oscillates. */
export const ADAPT_DEADBAND = 0.25;

/**
 * Correct the chunk size from what the last chunk actually did.
 *
 * Two bounds keep it stable:
 *
 * **A deadband.** Chunk sizes that chase every 5% wobble oscillate, and an
 * oscillating chunk size makes the progress bar's remaining-time estimate
 * useless — which is worse than being slightly off.
 *
 * **A step limit.** Doubling or halving at most, so one unusual chunk (a run of
 * large BLOBs) cannot send the next one to either extreme.
 *
 * Reads only from bytes, not from time: a slow chunk may mean large rows, or it
 * may mean the server was briefly busy, and sizing on the latter makes the copy
 * shrink itself for a reason that has already passed.
 */
export function adaptChunkSize(
  current: number,
  feedback: ChunkFeedback,
  targetBytes = DEFAULT_CHUNK_BYTES,
  softCap = DEFAULT_ROWS_PER_CHUNK,
): AdaptResult {
  if (feedback.rows <= 0 || feedback.bytes <= 0) {
    return { rowsPerChunk: current, changed: false, reason: 'no usable feedback' };
  }
  const actualPerRow = feedback.bytes / feedback.rows;
  const ideal = targetBytes / actualPerRow;
  const ratio = ideal / current;

  if (Math.abs(ratio - 1) <= ADAPT_DEADBAND) {
    return {
      rowsPerChunk: current,
      changed: false,
      reason: `within ${Math.round(ADAPT_DEADBAND * 100)}% of target — left alone`,
    };
  }

  const limited = Math.min(
    Math.max(ratio, 1 / MAX_ADAPT_FACTOR),
    MAX_ADAPT_FACTOR);
  const next = Math.max(
    MIN_ROWS_PER_CHUNK,
    Math.min(MAX_ROWS_PER_CHUNK, softCap, Math.floor(current * limited)));

  if (next === current) {
    return { rowsPerChunk: current, changed: false, reason: 'already at a bound' };
  }
  return {
    rowsPerChunk: next,
    changed: true,
    reason: next > current
      ? `rows averaged ${Math.round(actualPerRow)} B, under budget — raising `
        + `${current.toLocaleString()} → ${next.toLocaleString()}`
      : `rows averaged ${Math.round(actualPerRow)} B, over budget — lowering `
        + `${current.toLocaleString()} → ${next.toLocaleString()}`,
  };
}
