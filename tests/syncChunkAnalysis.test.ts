/**
 * Data-driven chunk sizing (src/utils/syncChunkAnalysis.ts).
 *
 * The premise is measured: `AVG_ROW_LENGTH` over-estimated real row size by
 * 1.5× on one table, 3.4× on another and 2,730× on a small one, because it is
 * InnoDB's page accounting rather than the wire size. Sizing from it alone
 * makes every chunk needlessly small; sizing from a sampled *average* alone
 * makes a table with a few large BLOBs blow the memory budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowSampleSql, keyDensitySql, keySparsity, canPrecomputeRanges, lobColumns,
  sizeFromProfile, adaptChunkSize,
  MAX_ADAPT_FACTOR, ADAPT_DEADBAND, MAX_SPARSITY_FOR_RANGES,
} from '../src/utils/syncChunkAnalysis.ts';
import type { TableProfile } from '../src/utils/syncChunkAnalysis.ts';
import { MIN_ROWS_PER_CHUNK, DEFAULT_ROWS_PER_CHUNK } from '../src/utils/syncChunk.ts';

const MB = 1024 * 1024;
const profile = (over: Partial<TableProfile> = {}): TableProfile => ({
  estimatedAvgRowLength: null, sample: null, density: null, lobColumns: [], ...over,
});

// ── sampling ────────────────────────────────────────────────────────────────

test('the sample reads from both ends, not just the head', () => {
  // Rows grow over time; LIMIT 1000 from the start of a ten-year-old table
  // measures the oldest and smallest and under-estimates everything after.
  const sql = rowSampleSql('db', 't', ['a', 'b'], ['id'], 500);
  assert.match(sql, /ORDER BY `id` LIMIT 500/);
  assert.match(sql, /ORDER BY `id` DESC LIMIT 500/);
  assert.match(sql, /UNION ALL/);
});

test('the sample measures both mean and maximum', () => {
  const sql = rowSampleSql('db', 't', ['a'], ['id']);
  assert.match(sql, /AVG\(/);
  assert.match(sql, /MAX\(/);
});

test('a keyless table still samples, without ordering', () => {
  const sql = rowSampleSql('db', 't', ['a'], []);
  assert.ok(!sql.includes('ORDER BY'), sql);
  assert.match(sql, /LIMIT 1500/);
});

test('identifiers are escaped in the sample and density statements', () => {
  assert.match(rowSampleSql('we`ird', 'ta`ble', ['c`ol'], ['i`d']), /`we``ird`\.`ta``ble`/);
  assert.match(keyDensitySql('we`ird', 't', 'i`d'), /MIN\(`i``d`\)/);
});

// ── key density ─────────────────────────────────────────────────────────────

test('a dense key has sparsity near 1', () => {
  assert.equal(keySparsity({ minKey: 1, maxKey: 1000, rows: 1000 }), 1);
});

test('a heavily deleted table is sparse', () => {
  // 1..1,000,000 holding 10,000 rows — one id in a hundred is used.
  assert.equal(keySparsity({ minKey: 1, maxKey: 1_000_000, rows: 10_000 }), 100);
});

test('precomputed ranges are refused on a sparse key', () => {
  // Splitting 1..1,000,000 into twenty ranges gives twenty equal chunks only
  // if the ids are dense; on a sparse key some come back empty and some
  // enormous, which is worse than not parallelising.
  assert.ok(canPrecomputeRanges({ minKey: 1, maxKey: 1000, rows: 1000 }));
  assert.ok(!canPrecomputeRanges({ minKey: 1, maxKey: 1_000_000, rows: 10_000 }));
});

test('the sparsity threshold is the documented one', () => {
  const atLimit = { minKey: 1, maxKey: MAX_SPARSITY_FOR_RANGES * 1000, rows: 1000 };
  assert.ok(canPrecomputeRanges(atLimit));
});

test('unknown density cannot be used for ranges', () => {
  assert.equal(keySparsity({ minKey: null, maxKey: null, rows: null }), null);
  assert.ok(!canPrecomputeRanges(null));
  assert.ok(!canPrecomputeRanges({ minKey: 1, maxKey: 10, rows: 0 }));
});

// ── LOB detection ───────────────────────────────────────────────────────────

test('types that can hold megabytes are flagged', () => {
  const cols = [
    { name: 'id', dataType: 'int' }, { name: 'body', dataType: 'longtext' },
    { name: 'doc', dataType: 'mediumblob' }, { name: 'meta', dataType: 'json' },
    { name: 'name', dataType: 'varchar' },
  ];
  assert.deepEqual(lobColumns(cols), ['body', 'doc', 'meta']);
});

// ── sizing ──────────────────────────────────────────────────────────────────

test('a sample beats the estimate, and says by how much', () => {
  // Measured: invoice's AVG_ROW_LENGTH was 134 B against a sampled 40 B.
  const r = sizeFromProfile(profile({
    estimatedAvgRowLength: 134,
    sample: { sampled: 1000, avgBytes: 40, maxBytes: 45 },
  }), 64 * MB);
  assert.equal(r.basis, 'sample');
  assert.match(r.note, /3\.4× the measured mean/);
});

test('the MAXIMUM row governs the memory bound, not the mean', () => {
  // 1 KB mean with 8 MB outliers: sizing on the mean says 50,000 rows is
  // 50 MB, and reality is that one chunk can be 400 GB.
  const meanOnly = sizeFromProfile(profile({
    sample: { sampled: 1000, avgBytes: 1024, maxBytes: 1024 },
  }), 64 * MB);
  const withOutliers = sizeFromProfile(profile({
    sample: { sampled: 1000, avgBytes: 1024, maxBytes: 8 * MB },
  }), 64 * MB);
  assert.ok(withOutliers.rowsPerChunk < meanOnly.rowsPerChunk,
    `${withOutliers.rowsPerChunk} should be well under ${meanOnly.rowsPerChunk}`);
});

test('a uniform table is not punished for having a maximum', () => {
  // max == avg means no outliers, so the size should approach what the mean
  // alone would allow rather than being halved for nothing.
  const r = sizeFromProfile(profile({
    sample: { sampled: 1000, avgBytes: 100, maxBytes: 100 },
  }), 64 * MB);
  assert.equal(r.rowsPerChunk, DEFAULT_ROWS_PER_CHUNK);
});

test('LOB columns are named in the note', () => {
  const r = sizeFromProfile(profile({
    sample: { sampled: 100, avgBytes: 500, maxBytes: 2 * MB },
    lobColumns: ['body', 'doc'],
  }), 64 * MB);
  assert.match(r.note, /LOB columns \(body, doc\)/);
});

test('the estimate is used when no sample exists, and admits it is conservative', () => {
  const r = sizeFromProfile(profile({ estimatedAvgRowLength: 8192 }), 64 * MB);
  assert.equal(r.basis, 'estimate');
  assert.match(r.note, /over-estimates/);
});

test('with neither, it starts at the default and says it will adapt', () => {
  const r = sizeFromProfile(profile());
  assert.equal(r.basis, 'default');
  assert.equal(r.rowsPerChunk, DEFAULT_ROWS_PER_CHUNK);
  assert.match(r.note, /adapting from the first chunk/);
});

test('sizing never returns fewer rows than the floor', () => {
  // Even a 64 MB row must not produce a zero-row chunk.
  const r = sizeFromProfile(profile({
    sample: { sampled: 10, avgBytes: 64 * MB, maxBytes: 64 * MB },
  }), 1024);
  assert.equal(r.rowsPerChunk, MIN_ROWS_PER_CHUNK);
});

test('the worst case is reported alongside the expected', () => {
  const r = sizeFromProfile(profile({
    sample: { sampled: 100, avgBytes: 100, maxBytes: 1000 },
  }), 64 * MB);
  assert.ok(r.worstCaseBytes > r.expectedBytes);
});

// ── adapting ────────────────────────────────────────────────────────────────

test('a chunk on target is left alone', () => {
  // 50,000 rows × 1,342 B ≈ 64 MB.
  const r = adaptChunkSize(50_000, { rows: 50_000, bytes: 64 * MB, ms: 100 });
  assert.equal(r.changed, false);
  assert.match(r.reason, /within \d+% of target/);
});

test('small differences are ignored — chasing them oscillates', () => {
  // A size that chases every wobble makes the remaining-time estimate useless,
  // which is worse than being slightly off.
  const nudge = 64 * MB * (1 + ADAPT_DEADBAND / 2);
  assert.equal(adaptChunkSize(50_000, { rows: 50_000, bytes: nudge, ms: 100 }).changed, false);
});

test('rows smaller than expected raise the chunk size', () => {
  const r = adaptChunkSize(10_000, { rows: 10_000, bytes: 8 * MB, ms: 50 }, 64 * MB, 200_000);
  assert.ok(r.changed);
  assert.ok(r.rowsPerChunk > 10_000);
  assert.match(r.reason, /under budget — raising/);
});

test('rows larger than expected lower it', () => {
  const r = adaptChunkSize(50_000, { rows: 50_000, bytes: 256 * MB, ms: 900 });
  assert.ok(r.changed);
  assert.ok(r.rowsPerChunk < 50_000);
  assert.match(r.reason, /over budget — lowering/);
});

test('one unusual chunk cannot send the next to an extreme', () => {
  // A run of large BLOBs must not collapse the following chunk to nothing.
  const r = adaptChunkSize(50_000, { rows: 50_000, bytes: 4096 * MB, ms: 9000 });
  assert.ok(r.rowsPerChunk >= 50_000 / MAX_ADAPT_FACTOR,
    `${r.rowsPerChunk} fell further than one step`);
});

test('growth is limited to one step too', () => {
  const r = adaptChunkSize(10_000, { rows: 10_000, bytes: 1024, ms: 5 }, 64 * MB, 200_000);
  assert.ok(r.rowsPerChunk <= 10_000 * MAX_ADAPT_FACTOR);
});

test('adaptation respects the soft cap', () => {
  const r = adaptChunkSize(40_000, { rows: 40_000, bytes: 1024, ms: 5 }, 64 * MB, DEFAULT_ROWS_PER_CHUNK);
  assert.ok(r.rowsPerChunk <= DEFAULT_ROWS_PER_CHUNK);
});

test('an empty chunk yields no adaptation rather than a divide by zero', () => {
  const r = adaptChunkSize(50_000, { rows: 0, bytes: 0, ms: 10 });
  assert.equal(r.changed, false);
  assert.equal(r.rowsPerChunk, 50_000);
  assert.match(r.reason, /no usable feedback/);
});

test('a slow chunk alone does not shrink the size', () => {
  // Slow may mean large rows, or may mean the server was briefly busy. Sizing
  // on the latter shrinks the copy for a reason that has already passed.
  const onTargetBytesButSlow = adaptChunkSize(50_000, { rows: 50_000, bytes: 64 * MB, ms: 30_000 });
  assert.equal(onTargetBytesButSlow.changed, false);
});

test('adaptation converges rather than ringing', () => {
  // Feed a constant 200 B/row and check the size settles.
  let rows = 1_000;
  const sizes: number[] = [];
  for (let i = 0; i < 12; i++) {
    const r = adaptChunkSize(rows, { rows, bytes: rows * 200, ms: 10 }, 64 * MB, 200_000);
    rows = r.rowsPerChunk;
    sizes.push(rows);
  }
  const last3 = sizes.slice(-3);
  assert.ok(new Set(last3).size === 1, `did not settle: ${sizes.join(', ')}`);
  // …and it settled near the true answer (64 MB / 200 B ≈ 335,544, capped).
  assert.ok(rows >= 200_000 * 0.9, String(rows));
});
