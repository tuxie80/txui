/**
 * Deciding how a table is divided for reading.
 *
 * Three decisions, each with a measured reason:
 *
 * **Which key.** Keyset paging needs a column set that is unique, NOT NULL and
 * indexed. The primary key is that by definition; a `NOT NULL` unique index is
 * the fallback; anything else and the table **cannot be chunked safely**, which
 * is reported rather than worked around.
 *
 * **How big.** Measured on a 598,689-row table: 1,000-row chunks ran at 36,705
 * rows/s (599 round-trips), 50,000-row chunks at 405,680 rows/s (13
 * round-trips), 200,000 at 566,038. Round-trip latency dominates below ~10 k
 * and the curve flattens after — so **50 k rows is the right default**, and
 * 200 k buys 1.4× for four times the memory.
 *
 * But rows are the wrong unit to *bound* by. Measured `avg_row_length` on two
 * real tables: **46 bytes** for one, **3,276 bytes** for another — 71× apart.
 * The same 50,000 rows is 2.3 MB of one and 164 MB of the other. The chunk is
 * therefore `min(rows, bytes)` with the **byte cap winning**, and the row count
 * derived from `avg_row_length` rather than guessed.
 *
 * **Whether chunks can be read in parallel.** Only inside one snapshot window
 * (see docs/DBSYNC_DEEPDIVE.md §3.3). And a chunk is **never** a transaction:
 * measured, per-chunk transactions lost a row that was inserted below the
 * watermark between two chunks — 5 rows copied from a 6-row table, no error.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export interface IndexMeta {
  name: string;
  /** `information_schema.statistics.NON_UNIQUE` — 0 means unique. */
  unique: boolean;
  /** Columns in `seq_in_index` order. */
  columns: string[];
  /** True when ANY column of the index is nullable. */
  nullable: boolean;
}

export interface TableMeta {
  schema: string;
  name: string;
  /** `information_schema.tables.TABLE_ROWS` — an estimate, and treated as one. */
  estimatedRows: number | null;
  /** `AVG_ROW_LENGTH`, bytes. */
  avgRowLength: number | null;
  indexes: IndexMeta[];
}

/** Defaults, derived from the measurements in the module comment. */
export const DEFAULT_ROWS_PER_CHUNK = 50_000;
export const MIN_ROWS_PER_CHUNK = 1_000;
export const MAX_ROWS_PER_CHUNK = 200_000;
/** Bytes one chunk may occupy in memory. */
export const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024;

export type ChunkStrategy =
  /** Keyset paging on a unique, NOT NULL, indexed key. */
  | 'keyset'
  /** No usable key, but small enough to read in one go. */
  | 'single-pass'
  /** No usable key and too large — refused. */
  | 'refused';

export interface ChunkPlan {
  strategy: ChunkStrategy;
  /** The key keyset paging walks, empty for the other strategies. */
  keyColumns: string[];
  /** Which index it came from, for the report. */
  keySource: string | null;
  rowsPerChunk: number;
  /** Estimated chunks, for the progress bar's denominator. */
  estimatedChunks: number | null;
  /** Estimated bytes one chunk will hold. */
  estimatedChunkBytes: number | null;
  /** Why this plan, in words a report can print. */
  note: string;
}

export interface ChunkOptions {
  /** Memory budget per chunk. */
  chunkBytes?: number;
  /** Override the derived row count. */
  rowsPerChunk?: number;
  /**
   * Raise the soft cap for an unattended run, where progress granularity and
   * cancel latency matter less than raw throughput.
   */
  softCapRows?: number;
  /**
   * A table with no usable key may still be copied in one pass when it is
   * small. Above this many rows it is refused instead.
   */
  singlePassMaxRows?: number;
}

export const DEFAULT_SINGLE_PASS_MAX_ROWS = 100_000;

/**
 * The best key for keyset paging.
 *
 * `PRIMARY` first — it is unique and NOT NULL by definition, and InnoDB
 * clusters on it, so walking it is a sequential scan rather than a series of
 * index lookups.
 *
 * A unique index is only a candidate when **no column of it is nullable**.
 * That is not fussiness: `(a) > (NULL)` is `NULL`, not true or false, so a
 * nullable key silently stops the walk — the chunk after the first NULL returns
 * nothing and the copy ends early believing it is done.
 */
export function chooseChunkKey(indexes: IndexMeta[]): IndexMeta | null {
  const pk = indexes.find(i => i.name === 'PRIMARY');
  if (pk) return pk;
  return indexes.find(i => i.unique && !i.nullable && i.columns.length > 0) ?? null;
}

/**
 * Rows per chunk, from the byte budget and the table's own average row.
 *
 * Three bounds, and the middle one is the interesting one:
 *
 * **Floor (1,000).** Below this the round trip costs more than the rows —
 * measured 36,705 rows/s at 1,000 against 405,680 at 50,000.
 *
 * **Soft cap (50,000).** Raw throughput keeps improving past this — measured
 * 566,038 rows/s at 200,000 against 405,680 at 50,000 — but chunk size is also
 * the **granularity of progress and the latency of cancel**. On a 598 k-row
 * table, 200 k chunks means the progress bar moves in thirds and a cancel waits
 * for up to 200,000 rows; 50 k means twelve visible steps and a quarter of the
 * wait. The throughput that buys is 1.06 s against 1.48 s. Four times the
 * feedback for four tenths of a second is the right trade for a tool somebody
 * is watching.
 *
 * **Hard cap (200,000).** Reachable only by raising `chunkBytes` deliberately,
 * for an unattended run where nobody is watching a bar.
 */
export function rowsForBudget(
  avgRowLength: number | null,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  softCap = DEFAULT_ROWS_PER_CHUNK,
): number {
  if (!avgRowLength || avgRowLength <= 0) return Math.min(DEFAULT_ROWS_PER_CHUNK, softCap);
  const byBudget = Math.floor(chunkBytes / avgRowLength);
  const capped = Math.min(byBudget, softCap, MAX_ROWS_PER_CHUNK);
  return Math.max(MIN_ROWS_PER_CHUNK, capped);
}

/**
 * Plan how one table is read.
 *
 * A refusal is a first-class outcome. A table with no unique NOT NULL key
 * cannot be chunked without either overlapping (which `INSERT IGNORE` would
 * then silently de-duplicate, dropping legitimate duplicate rows) or skipping.
 * Saying so beats producing a copy that is quietly wrong — and a 200 M-row
 * table with no primary key is a data-modelling problem worth surfacing.
 */
export function planChunks(table: TableMeta, opts: ChunkOptions = {}): ChunkPlan {
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const singlePassMax = opts.singlePassMaxRows ?? DEFAULT_SINGLE_PASS_MAX_ROWS;
  const rowsPerChunk = opts.rowsPerChunk
    ?? rowsForBudget(table.avgRowLength, chunkBytes, opts.softCapRows);
  const chunkBytesEst = table.avgRowLength ? rowsPerChunk * table.avgRowLength : null;

  const key = chooseChunkKey(table.indexes);
  if (key) {
    const estimatedChunks = table.estimatedRows !== null
      ? Math.max(1, Math.ceil(table.estimatedRows / rowsPerChunk))
      : null;
    const derived = table.avgRowLength
      ? `${rowsPerChunk.toLocaleString()} rows/chunk, derived from an average row of `
        + `${table.avgRowLength} bytes against a ${Math.round(chunkBytes / 1024 / 1024)} MB budget`
      : `${rowsPerChunk.toLocaleString()} rows/chunk (no average row length available)`;
    return {
      strategy: 'keyset',
      keyColumns: key.columns,
      keySource: key.name,
      rowsPerChunk,
      estimatedChunks,
      estimatedChunkBytes: chunkBytesEst,
      note: `Keyset paging on ${key.name === 'PRIMARY' ? 'the primary key' : `unique index \`${key.name}\``} `
        + `(${key.columns.join(', ')}) — ${derived}.`,
    };
  }

  // No usable key.
  const rows = table.estimatedRows;
  const nullableUnique = table.indexes.find(i => i.unique && i.nullable);
  const whyNoKey = nullableUnique
    ? `The only unique index (\`${nullableUnique.name}\`) has a nullable column, and `
      + '`(x) > (NULL)` is NULL rather than true or false — paging on it would stop '
      + 'silently at the first NULL and the copy would end early believing it was done.'
    : 'The table has no primary key and no NOT NULL unique index.';

  if (rows !== null && rows <= singlePassMax) {
    return {
      strategy: 'single-pass',
      keyColumns: [],
      keySource: null,
      rowsPerChunk: rows,
      estimatedChunks: 1,
      estimatedChunkBytes: chunkBytesEst,
      note: `${whyNoKey} At an estimated ${rows.toLocaleString()} rows it is small enough `
        + 'to read in one pass — which is consistent, but cannot be resumed or parallelised.',
    };
  }

  return {
    strategy: 'refused',
    keyColumns: [],
    keySource: null,
    rowsPerChunk: 0,
    estimatedChunks: null,
    estimatedChunkBytes: null,
    note: `${whyNoKey} At an estimated ${rows === null ? 'unknown' : rows.toLocaleString()} `
      + 'rows it is too large to read in one pass. Chunking it on a non-unique column '
      + 'would produce overlapping ranges, and de-duplicating those on the target would '
      + 'silently drop legitimate duplicate rows. Add a primary key, or copy this table '
      + 'separately with the consequences understood.',
  };
}

// ── the walk ─────────────────────────────────────────────────────────────────

export interface ChunkBounds {
  /** 1-based, for progress reporting. */
  index: number;
  /** Exclusive lower bound — null for the first chunk. */
  after: (string | number)[] | null;
}

/**
 * The `SELECT` for one chunk.
 *
 * `ORDER BY` the key is not decoration: it is what makes the *next* chunk's
 * lower bound well defined, and it delivers rows in primary-key order, which is
 * what a clustered index wants on the way in.
 */
export function chunkSelectSql(
  schema: string,
  table: string,
  columns: string[],
  plan: ChunkPlan,
  after: (string | number)[] | null,
): string {
  const q = (n: string) => '`' + n.replace(/`/g, '``') + '`';
  const cols = columns.map(q).join(', ');
  const from = `${q(schema)}.${q(table)}`;

  if (plan.strategy === 'single-pass') {
    return `SELECT ${cols} FROM ${from}`;
  }

  const keys = plan.keyColumns.map(q).join(', ');
  const lit = (v: string | number) =>
    typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  const where = after
    ? ` WHERE (${keys}) > (${after.map(lit).join(', ')})`
    : '';
  return `SELECT ${cols} FROM ${from}${where} ORDER BY ${keys} LIMIT ${plan.rowsPerChunk}`;
}

/** The key values of the last row, which bound the next chunk. */
export function nextBound(
  lastRow: Record<string, string | number> | null,
  plan: ChunkPlan,
): (string | number)[] | null {
  if (!lastRow || plan.keyColumns.length === 0) return null;
  return plan.keyColumns.map(c => lastRow[c]);
}

/**
 * Total estimated chunks across a set of tables — the progress denominator.
 *
 * Returns `null` if any table's estimate is unknown, because a progress bar
 * whose denominator is a guess with an unmarked hole in it is worse than one
 * that admits it does not know.
 */
export function totalEstimatedChunks(plans: ChunkPlan[]): number | null {
  let total = 0;
  for (const p of plans) {
    if (p.strategy === 'refused') continue;
    if (p.estimatedChunks === null) return null;
    total += p.estimatedChunks;
  }
  return total;
}
