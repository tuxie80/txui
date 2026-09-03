/**
 * Building the expression that proves two tables hold the same rows.
 *
 * This is the part of the verifier that earns the word "certainty", and every
 * rule in it exists because a measurement showed the obvious version failing.
 * Copying a 5-row table of awkward types from MySQL 8.0.46 to 8.4.10 produced:
 *
 *   row counts   5 = 5                       ← a count check PASSES
 *   checksums    2401757858 ≠ 3591772800     ← this catches it
 *
 * …because every `NULL` in the table had silently become a zero value. Row
 * counts are not verification. This is.
 *
 * Four measured rules shape the expression:
 *
 * **1. `CONCAT_WS` elides NULLs.** Measured:
 * `CRC32(CONCAT_WS('#','a',NULL,'b'))` **equals** `CRC32(CONCAT_WS('#','a','b'))`.
 * So a copy that turned a NULL into an empty string checksums identically. Every
 * row therefore carries an explicit `ISNULL` bitmap appended to it.
 *
 * **2. `BIT_XOR` is blind to duplicates.** Measured: two identical rows XOR to
 * `0`, which is also the value of the empty set. Any even number of duplicate
 * rows cancels. So the checksum is **always** returned paired with `COUNT(*)`;
 * neither is meaningful alone.
 *
 * **3. Binary must be hexed.** Measured: a `BLOB` holding `0x00010203FF` cannot
 * survive a character-set-tagged comparison — and comparing it as text depends
 * on the connection charset at both ends. `HEX()` makes it byte-exact and
 * charset-independent.
 *
 * **4. Floats are not byte-stable** and are excluded, with the exclusion
 * reported rather than hidden — a report that quietly skips columns is how
 * "verified" comes to mean less than it says.
 *
 * `BIT_XOR` is the right aggregate because it is **order-independent**
 * (measured: forward and reverse agree), so chunk results combine in any order
 * and can be computed in parallel.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export interface ColumnMeta {
  name: string;
  /** `information_schema.columns.DATA_TYPE`, lower case. */
  dataType: string;
  /** `EXTRA` — carries `STORED GENERATED` / `VIRTUAL GENERATED`. */
  extra?: string;
}

export type SkipReason = 'generated' | 'float';

export interface ChecksumSpec {
  /** The `SELECT` that returns `(n, ck)` for a chunk. */
  sql: string;
  /** Columns actually covered. */
  columns: string[];
  /** Columns left out, and why — always reported, never silent. */
  skipped: { column: string; reason: SkipReason; note: string }[];
}

const q = (name: string) => '`' + name.replace(/`/g, '``') + '`';

/**
 * Types whose text rendering is not a faithful, stable image of the bytes.
 *
 * Hexing them makes the comparison byte-exact and independent of the
 * connection character set at either end — which matters because the two ends
 * are, by definition, different servers.
 */
const BINARY_TYPES = new Set([
  'blob', 'tinyblob', 'mediumblob', 'longblob',
  'binary', 'varbinary', 'bit', 'geometry',
  'point', 'linestring', 'polygon',
  'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection',
]);

/**
 * Text types are hexed too.
 *
 * Not for the bytes' sake but for the **trailing whitespace**: MySQL's
 * comparison and rendering of `CHAR` pads and trims in ways that differ by
 * type, so `'a'` and `'a '` can render alike. Hex makes the difference visible.
 */
const TEXT_TYPES = new Set([
  'char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'json',
  'enum', 'set',
]);

/** Never byte-stable — the same value can print differently on two servers. */
const FLOAT_TYPES = new Set(['float', 'double', 'real']);

/**
 * A *generated* column — not merely one with a generated default.
 *
 * `EXTRA` distinguishes three things that all contain the word GENERATED:
 *
 *   `STORED GENERATED`    real generated column — the target recomputes it
 *   `VIRTUAL GENERATED`   likewise
 *   `DEFAULT_GENERATED`   an ordinary column with a DEFAULT expression, such as
 *                         `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` — ordinary data
 *
 * Matching on `GENERATED` alone excludes the third from verification, which is
 * precisely the silent gap this module exists to prevent. Caught by comparing
 * two live servers: a `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` column was reported
 * as "excluded — generated" and went unchecked.
 */
export function isGenerated(c: ColumnMeta): boolean {
  return /\b(STORED|VIRTUAL)\s+GENERATED\b/i.test(c.extra ?? '');
}

/** How one column is rendered inside the row hash. */
export function columnExpression(c: ColumnMeta): string {
  const t = c.dataType.trim().toLowerCase();
  const col = q(c.name);
  if (BINARY_TYPES.has(t) || TEXT_TYPES.has(t)) return `HEX(${col})`;
  return col;
}

/**
 * Why a column is excluded, in words a report can print.
 *
 * A generated column *should* be compared — but by its expression, not its
 * value: the target recomputes it, so a matching value proves nothing and a
 * differing one means the expression differs, which is a schema finding rather
 * than a data one.
 */
export function skipReason(c: ColumnMeta): { reason: SkipReason; note: string } | null {
  if (isGenerated(c)) {
    return {
      reason: 'generated',
      note: 'Recomputed by the target from its own expression — compared as schema, '
        + 'not as data.',
    };
  }
  if (FLOAT_TYPES.has(c.dataType.trim().toLowerCase())) {
    return {
      reason: 'float',
      note: 'FLOAT/DOUBLE are not byte-stable; the same value can render differently '
        + 'on two servers, so including it would report false differences.',
    };
  }
  return null;
}

export interface ChunkRange {
  /** Primary-key columns, in order. */
  keyColumns: string[];
  /** Exclusive lower bound — the previous chunk's last key. Null = from the start. */
  after: (string | number)[] | null;
  /** Inclusive upper bound. Null = to the end. */
  upTo: (string | number)[] | null;
}

/** A literal safe to paste into a generated statement. */
function literal(v: string | number): string {
  return typeof v === 'number' && Number.isFinite(v)
    ? String(v)
    : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * Row-value comparison for a composite key: `(a,b) > (1,2)`.
 *
 * MySQL supports this natively and uses the primary-key index for it, which is
 * what keeps chunk boundaries cheap on a composite key. Writing it out as
 * `a > 1 OR (a = 1 AND b > 2)` would be equivalent and would not use the index
 * as reliably.
 */
export function rangePredicate(range: ChunkRange): string {
  const cols = `(${range.keyColumns.map(q).join(', ')})`;
  const parts: string[] = [];
  if (range.after) parts.push(`${cols} > (${range.after.map(literal).join(', ')})`);
  if (range.upTo) parts.push(`${cols} <= (${range.upTo.map(literal).join(', ')})`);
  return parts.length > 0 ? parts.join(' AND ') : '1 = 1';
}

/**
 * The `(count, checksum)` statement for a table or one chunk of it.
 *
 * Both values come back from **one** pass over the rows: computing them
 * separately would read the table twice and, worse, could read it at two
 * different instants on a live source.
 */
export function checksumSql(
  schema: string,
  table: string,
  columns: ColumnMeta[],
  range?: ChunkRange,
): ChecksumSpec {
  const skipped: ChecksumSpec['skipped'] = [];
  const used: ColumnMeta[] = [];
  for (const c of columns) {
    const s = skipReason(c);
    if (s) { skipped.push({ column: c.name, ...s }); continue; }
    used.push(c);
  }

  if (used.length === 0) {
    // Nothing comparable. Still return the count — it is the only fact left,
    // and silently returning a checksum of nothing would look like agreement.
    return {
      sql: `SELECT COUNT(*) AS n, NULL AS ck FROM ${q(schema)}.${q(table)}`
        + (range ? ` WHERE ${rangePredicate(range)}` : ''),
      columns: [],
      skipped,
    };
  }

  const values = used.map(columnExpression).join(', ');
  // The bitmap that stops NULL from being elided by CONCAT_WS — rule 1.
  const nullMap = `CONCAT(${used.map(c => `ISNULL(${q(c.name)})`).join(', ')})`;
  const where = range ? ` WHERE ${rangePredicate(range)}` : '';

  return {
    sql:
      `SELECT COUNT(*) AS n,\n`
      + `       BIT_XOR(CAST(CRC32(CONCAT_WS('#', ${values}, ${nullMap})) AS UNSIGNED)) AS ck\n`
      + `FROM ${q(schema)}.${q(table)}${where}`,
    columns: used.map(c => c.name),
    skipped,
  };
}

// ── comparing the results ────────────────────────────────────────────────────

export interface ChecksumResult {
  n: number;
  /** Null when no column was comparable. */
  ck: number | null;
}

export type Verdict = 'match' | 'row-count' | 'content' | 'not-comparable';

export interface Comparison {
  verdict: Verdict;
  /** What to show a person, without them re-deriving it. */
  summary: string;
  source: ChecksumResult;
  target: ChecksumResult;
}

/**
 * Compare one chunk's results.
 *
 * The row-count difference is reported **before** the content difference when
 * both are present: rows missing is a bigger fact than rows differing, and a
 * reader who sees "content differs" first will go looking for the wrong thing.
 */
export function compareChecksums(
  source: ChecksumResult,
  target: ChecksumResult,
  label = 'chunk',
): Comparison {
  if (source.n !== target.n) {
    const d = target.n - source.n;
    return {
      verdict: 'row-count',
      summary: `${label}: row count differs — source ${source.n.toLocaleString()}, `
        + `target ${target.n.toLocaleString()} (${d > 0 ? '+' : ''}${d.toLocaleString()}).`,
      source, target,
    };
  }
  if (source.ck === null || target.ck === null) {
    return {
      verdict: 'not-comparable',
      summary: `${label}: ${source.n.toLocaleString()} rows on both sides, but no column `
        + 'could be checksummed — row count is the only assurance here.',
      source, target,
    };
  }
  if (source.ck !== target.ck) {
    return {
      verdict: 'content',
      summary: `${label}: ${source.n.toLocaleString()} rows on both sides but the content `
        + 'differs. Equal counts with unequal checksums usually means values were '
        + 'transformed in transit — NULLs turned into zeros or empty strings is the '
        + 'commonest cause.',
      source, target,
    };
  }
  return {
    verdict: 'match',
    summary: `${label}: ${source.n.toLocaleString()} rows, content identical.`,
    source, target,
  };
}

/**
 * The sentence for a whole table, given its chunk comparisons.
 *
 * Names the **first failing chunk** rather than only counting failures: the
 * next action after a mismatch is a query against a key range, and a report
 * that says "3 chunks differ" without saying which has not helped.
 */
export function summariseTable(
  table: string,
  chunks: Comparison[],
  skipped: ChecksumSpec['skipped'] = [],
): { ok: boolean; summary: string } {
  const bad = chunks.filter(c => c.verdict !== 'match');
  const caveat = skipped.length > 0
    ? ` (${skipped.length} column${skipped.length === 1 ? '' : 's'} excluded: `
      + `${skipped.map(s => s.column).join(', ')})`
    : '';

  if (bad.length === 0) {
    const rows = chunks.reduce((n, c) => n + c.source.n, 0);
    return {
      ok: true,
      summary: `${table}: ${rows.toLocaleString()} rows verified identical across `
        + `${chunks.length} chunk${chunks.length === 1 ? '' : 's'}${caveat}.`,
    };
  }
  return {
    ok: false,
    summary: `${table}: ${bad.length} of ${chunks.length} chunks differ. `
      + `First: ${bad[0].summary}${caveat}`,
  };
}
