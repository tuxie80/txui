/**
 * Chunk planning (src/utils/syncChunk.ts).
 *
 * The numbers asserted here come from measurements against MySQL 8.0.46:
 * throughput at four chunk sizes on a 598,689-row table, and `AVG_ROW_LENGTH`
 * read from two real tables that differ by 71×.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseChunkKey, rowsForBudget, planChunks, chunkSelectSql, nextBound,
  totalEstimatedChunks,
  DEFAULT_ROWS_PER_CHUNK, MIN_ROWS_PER_CHUNK, MAX_ROWS_PER_CHUNK, DEFAULT_CHUNK_BYTES,
} from '../src/utils/syncChunk.ts';
import type { IndexMeta, TableMeta } from '../src/utils/syncChunk.ts';

const idx = (name: string, columns: string[], unique = true, nullable = false): IndexMeta =>
  ({ name, columns, unique, nullable });

const tbl = (over: Partial<TableMeta> = {}): TableMeta => ({
  schema: 'db', name: 't', estimatedRows: 1_000_000, avgRowLength: 100, indexes: [], ...over,
});

// ── choosing the key ────────────────────────────────────────────────────────

test('the primary key wins', () => {
  const k = chooseChunkKey([idx('uq_a', ['a']), idx('PRIMARY', ['id'])]);
  assert.equal(k?.name, 'PRIMARY');
});

test('a composite primary key is used whole', () => {
  const k = chooseChunkKey([idx('PRIMARY', ['id', 'customer_id'])]);
  assert.deepEqual(k?.columns, ['id', 'customer_id']);
});

test('a NOT NULL unique index is the fallback', () => {
  const k = chooseChunkKey([idx('ix_x', ['x'], false), idx('uq_a', ['a'])]);
  assert.equal(k?.name, 'uq_a');
});

test('a NULLABLE unique index is REFUSED as a key', () => {
  // `(x) > (NULL)` is NULL — neither true nor false — so paging on it stops
  // silently at the first NULL and the copy ends early believing it is done.
  assert.equal(chooseChunkKey([idx('uq_a', ['a'], true, true)]), null);
});

test('a non-unique index is never a key', () => {
  // Overlapping ranges, and de-duplicating them on the target drops legitimate
  // duplicate rows.
  assert.equal(chooseChunkKey([idx('ix_a', ['a'], false)]), null);
});

test('no indexes at all yields no key', () => {
  assert.equal(chooseChunkKey([]), null);
});

// ── sizing ──────────────────────────────────────────────────────────────────

test('rows per chunk come from the byte budget, not a fixed count', () => {
  // Measured on real tables: avg_row_length 46 vs 3,276 — 71× apart. The same
  // 50,000 rows is 2.3 MB of one and 164 MB of the other.
  const narrow = rowsForBudget(46, 64 * 1024 * 1024);
  const wide = rowsForBudget(3276, 64 * 1024 * 1024);
  assert.ok(narrow > wide, `${narrow} should exceed ${wide}`);
  assert.ok(wide * 3276 <= 64 * 1024 * 1024, 'wide chunk must fit the budget');
});

test('the row count is clamped at both ends', () => {
  // Below ~1,000 the round trip costs more than the rows (36,705 rows/s at
  // 1,000 against 405,680 at 50,000).
  assert.equal(rowsForBudget(100_000_000, 1024), MIN_ROWS_PER_CHUNK);
});

test('a narrow table stops at the soft cap, not the byte budget', () => {
  // 64 MB of 46-byte rows is 1.4 million — but chunk size is also the
  // granularity of the progress bar and the latency of cancel. On the measured
  // 598 k-row table, 200 k chunks move the bar in thirds for 0.4 s of gain.
  assert.equal(rowsForBudget(46, 64 * 1024 * 1024), DEFAULT_ROWS_PER_CHUNK);
});

test('the soft cap can be raised for an unattended run', () => {
  // Nobody watching a bar — take the throughput.
  assert.equal(rowsForBudget(46, 64 * 1024 * 1024, MAX_ROWS_PER_CHUNK), MAX_ROWS_PER_CHUNK);
});

test('the byte budget still wins for a wide table', () => {
  // 64 MB of 3,276-byte rows is ~20 k, well under the soft cap.
  const rows = rowsForBudget(3276, 64 * 1024 * 1024);
  assert.ok(rows < DEFAULT_ROWS_PER_CHUNK, String(rows));
  assert.ok(rows * 3276 <= 64 * 1024 * 1024);
});

test('an unknown average row length falls back to the measured default', () => {
  assert.equal(rowsForBudget(null), DEFAULT_ROWS_PER_CHUNK);
  assert.equal(rowsForBudget(0), DEFAULT_ROWS_PER_CHUNK);
});

test('the default budget produces a sane chunk for a typical row', () => {
  const rows = rowsForBudget(100, DEFAULT_CHUNK_BYTES);
  assert.ok(rows >= MIN_ROWS_PER_CHUNK && rows <= MAX_ROWS_PER_CHUNK, String(rows));
});

// ── planning ────────────────────────────────────────────────────────────────

test('a table with a primary key gets a keyset plan', () => {
  const p = planChunks(tbl({ indexes: [idx('PRIMARY', ['id'])] }));
  assert.equal(p.strategy, 'keyset');
  assert.deepEqual(p.keyColumns, ['id']);
  assert.equal(p.keySource, 'PRIMARY');
  assert.match(p.note, /primary key/);
});

test('the estimated chunk count is the progress denominator', () => {
  const p = planChunks(tbl({ estimatedRows: 250_000, avgRowLength: 100, indexes: [idx('PRIMARY', ['id'])] }),
    { rowsPerChunk: 50_000 });
  assert.equal(p.estimatedChunks, 5);
});

test('an unknown row estimate yields an unknown chunk count, not a guess', () => {
  const p = planChunks(tbl({ estimatedRows: null, indexes: [idx('PRIMARY', ['id'])] }));
  assert.equal(p.estimatedChunks, null);
});

test('a small keyless table is read in ONE pass, and says it cannot resume', () => {
  const p = planChunks(tbl({ estimatedRows: 5_000, indexes: [] }));
  assert.equal(p.strategy, 'single-pass');
  assert.match(p.note, /cannot be resumed or parallelised/);
});

test('a large keyless table is REFUSED, with the consequence spelled out', () => {
  // A copy that is quietly wrong is worse than one that did not run.
  const p = planChunks(tbl({ estimatedRows: 200_000_000, indexes: [] }));
  assert.equal(p.strategy, 'refused');
  assert.match(p.note, /overlapping ranges/);
  assert.match(p.note, /silently drop legitimate duplicate rows/);
  assert.match(p.note, /Add a primary key/);
});

test('a nullable unique index explains ITSELF in the refusal', () => {
  // "no usable key" would send someone looking for an index that is right
  // there. The reason it is unusable is the useful part.
  const p = planChunks(tbl({
    estimatedRows: 200_000_000,
    indexes: [idx('uq_a', ['a'], true, true)],
  }));
  assert.equal(p.strategy, 'refused');
  assert.match(p.note, /`uq_a`/);
  assert.match(p.note, /nullable/);
  assert.match(p.note, /NULL rather than true or false/);
});

test('the note states where the row count came from', () => {
  const p = planChunks(tbl({ avgRowLength: 46, indexes: [idx('PRIMARY', ['id'])] }));
  assert.match(p.note, /average row of 46 bytes/);
});

test('an explicit rows-per-chunk overrides the derivation', () => {
  const p = planChunks(tbl({ indexes: [idx('PRIMARY', ['id'])] }), { rowsPerChunk: 7 });
  assert.equal(p.rowsPerChunk, 7);
});

// ── the walk ────────────────────────────────────────────────────────────────

const KEYSET = planChunks(tbl({ indexes: [idx('PRIMARY', ['id']) ] }), { rowsPerChunk: 1000 });

test('the first chunk has no lower bound', () => {
  const sql = chunkSelectSql('db', 't', ['id', 'v'], KEYSET, null);
  assert.ok(!sql.includes('WHERE'), sql);
  assert.match(sql, /ORDER BY `id` LIMIT 1000/);
});

test('later chunks page on the last key seen', () => {
  const sql = chunkSelectSql('db', 't', ['id', 'v'], KEYSET, [500]);
  assert.match(sql, /WHERE \(`id`\) > \(500\)/);
});

test('a composite key pages as a tuple', () => {
  const p = planChunks(tbl({ indexes: [idx('PRIMARY', ['a', 'b'])] }), { rowsPerChunk: 10 });
  assert.match(chunkSelectSql('db', 't', ['a', 'b'], p, [1, 'x']),
    /WHERE \(`a`, `b`\) > \(1, 'x'\)/);
});

test('ORDER BY is always present — it defines the next bound', () => {
  // Without it the "last row" is whatever the server felt like returning, and
  // the next chunk's lower bound is meaningless.
  assert.match(chunkSelectSql('db', 't', ['id'], KEYSET, [1]), /ORDER BY `id`/);
});

test('a single-pass plan has no WHERE, no ORDER BY and no LIMIT', () => {
  const p = planChunks(tbl({ estimatedRows: 100, indexes: [] }));
  const sql = chunkSelectSql('db', 't', ['a'], p, null);
  assert.equal(sql, 'SELECT `a` FROM `db`.`t`');
});

test('identifiers and key literals are escaped', () => {
  const sql = chunkSelectSql('we`ird', 'ta`ble', ['c`ol'], KEYSET, ["it's"]);
  assert.match(sql, /`we``ird`\.`ta``ble`/);
  assert.match(sql, /`c``ol`/);
  assert.match(sql, /'it''s'/);
});

test('the next bound is taken from the key columns of the last row', () => {
  const p = planChunks(tbl({ indexes: [idx('PRIMARY', ['a', 'b'])] }));
  assert.deepEqual(nextBound({ a: 5, b: 'z', other: 'ignored' }, p), [5, 'z']);
});

test('no last row means the walk is finished', () => {
  assert.equal(nextBound(null, KEYSET), null);
});

// ── progress denominator ────────────────────────────────────────────────────

test('estimated chunks sum across tables', () => {
  const a = planChunks(tbl({ estimatedRows: 100_000, indexes: [idx('PRIMARY', ['id'])] }), { rowsPerChunk: 50_000 });
  const b = planChunks(tbl({ estimatedRows: 50_000, indexes: [idx('PRIMARY', ['id'])] }), { rowsPerChunk: 50_000 });
  assert.equal(totalEstimatedChunks([a, b]), 3);
});

test('refused tables do not inflate the denominator', () => {
  const ok = planChunks(tbl({ estimatedRows: 100_000, indexes: [idx('PRIMARY', ['id'])] }), { rowsPerChunk: 50_000 });
  const no = planChunks(tbl({ estimatedRows: 200_000_000, indexes: [] }));
  assert.equal(totalEstimatedChunks([ok, no]), 2);
});

test('one unknown estimate makes the whole total unknown', () => {
  // A progress bar whose denominator has an unmarked hole in it is worse than
  // one that admits it does not know.
  const known = planChunks(tbl({ estimatedRows: 100_000, indexes: [idx('PRIMARY', ['id'])] }));
  const unknown = planChunks(tbl({ estimatedRows: null, indexes: [idx('PRIMARY', ['id'])] }));
  assert.equal(totalEstimatedChunks([known, unknown]), null);
});
