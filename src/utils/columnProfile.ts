/**
 * Column profiling — what is actually *in* a column.
 *
 * Distinct from the Maintenance panel's Analyze op, which reports the
 * **optimiser's** statistics. That is what the planner believes; this is what
 * the data says,
 * and the two disagree more often than anyone would like. Profiling is
 * normally the first thing done with an unfamiliar table, and the answer here
 * used to be "write the SQL yourself".
 *
 * The whole module is SQL generation, so it is pure and testable without a
 * database. Two things it is careful about, because both turn a helpful screen
 * into an outage:
 *
 * * **One pass, not one query per column.** Twenty columns must not be twenty
 *   full scans of the same table.
 * * **Sampling is explicit.** A profile of a 400 M-row table has to say it read
 *   a sample, or the numbers are a lie told confidently.
 */
import { quoteIdent } from './sqlIdent.ts';

export type Engine = 'mysql' | 'postgres' | 'sqlserver';

export interface ProfileColumn {
  name: string;
  /** `int`, `varchar`, `timestamptz` — drives which aggregates make sense. */
  dataType: string;
}

/**
 * Which aggregates a type can answer.
 *
 * `MIN`/`MAX` on a `text` column is legal and almost never wanted — it returns
 * the alphabetically first string, which reads like a data point and is
 * noise. Averages on anything non-numeric are an error on PostgreSQL and a
 * silent zero on MySQL, which is worse.
 */
export type TypeClass = 'numeric' | 'temporal' | 'text' | 'boolean' | 'other';

export function classifyType(dataType: string): TypeClass {
  const t = dataType.toLowerCase();
  if (/^(bool|boolean|bit\(1\)|tinyint\(1\))/.test(t)) return 'boolean';
  // Temporal before numeric, and the order is load-bearing: `interval`
  // contains `int`, so the numeric test claims it first and an interval column
  // gets an AVG() it cannot answer.
  if (/(date|time|year|interval)/.test(t)) return 'temporal';
  if (/(int|serial|decimal|numeric|float|double|real|money)/.test(t)) return 'numeric';
  if (/(char|text|string|enum|uuid|json)/.test(t)) return 'text';
  return 'other';
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * One query returning a row per column: nulls, distincts, extremes and — for
 * text — length range.
 *
 * Built as a `UNION ALL` of per-column aggregates over a single scan of a
 * common table expression, so the table is read once regardless of how many
 * columns are profiled. Everything is cast to text in the output because the
 * columns of a union must agree, and the grid renders strings anyway.
 */
export function profileSql(
  engine: Engine,
  schema: string,
  table: string,
  columns: ProfileColumn[],
  sampleRows: number | null,
): string {
  const q = (s: string) => quoteIdent(s, engine);
  const qualified = `${q(schema)}.${q(table)}`;
  // A sample is a plain row cap, not TABLESAMPLE: portable, and for a profile
  // the first N rows of an unordered scan are as representative as anything
  // else without paying for a sort. T-SQL spells the cap TOP, at the front.
  const src = sampleRows && sampleRows > 0
    ? (engine === 'sqlserver'
        ? `(SELECT TOP (${Math.floor(sampleRows)}) * FROM ${qualified}) AS _s`
        : `(SELECT * FROM ${qualified} LIMIT ${Math.floor(sampleRows)}) AS _s`)
    : qualified;

  // Every branch of the UNION must agree on type, so each aggregate is cast to
  // text. `CHAR` is MySQL's spelling; T-SQL needs a length or it silently
  // truncates to 30 characters — nvarchar(4000) is the honest width here.
  const asText = (expr: string) =>
    engine === 'postgres' ? `(${expr})::text`
      : engine === 'sqlserver' ? `CAST(${expr} AS nvarchar(4000))`
      : `CAST(${expr} AS CHAR)`;

  const parts = columns.map(c => {
    const col = q(c.name);
    const kind = classifyType(c.dataType);
    // MIN/MAX only where they mean something; NULL keeps the union's shape.
    const extremes = kind === 'numeric' || kind === 'temporal'
      ? [asText(`MIN(${col})`), asText(`MAX(${col})`)]
      : ['NULL', 'NULL'];
    // AVG over an integer column is INTEGER division in T-SQL as well as in
    // PostgreSQL — `AVG(id)` on 1,2 gives 1, not 1.5 — so both cast first.
    const avg = kind === 'numeric'
      ? asText(engine === 'postgres' ? `ROUND(AVG(${col}::numeric), 4)`
          : engine === 'sqlserver' ? `ROUND(AVG(CAST(${col} AS decimal(38,6))), 4)`
          : `ROUND(AVG(${col}), 4)`)
      : 'NULL';
    // LENGTH / CHAR_LENGTH / LEN — three engines, three spellings. T-SQL's LEN
    // also IGNORES trailing spaces, which DATALENGTH would not; LEN is the
    // right one here because a profile is about the value, not its storage.
    const lenFn = engine === 'postgres' ? 'LENGTH'
      : engine === 'sqlserver' ? 'LEN' : 'CHAR_LENGTH';
    const len = kind === 'text'
      ? [asText(`MIN(${lenFn}(${col}))`), asText(`MAX(${lenFn}(${col}))`)]
      : ['NULL', 'NULL'];

    return `SELECT ${lit(c.name)} AS column_name, ${lit(c.dataType)} AS data_type,`
      + ` COUNT(*) AS rows_scanned,`
      + ` COUNT(${col}) AS non_null,`
      + ` COUNT(*) - COUNT(${col}) AS nulls,`
      + ` COUNT(DISTINCT ${col}) AS distinct_vals,`
      + ` ${extremes[0]} AS min_value, ${extremes[1]} AS max_value,`
      + ` ${avg} AS avg_value,`
      + ` ${len[0]} AS min_len, ${len[1]} AS max_len`
      + ` FROM ${src}`;
  });

  return parts.join('\nUNION ALL\n');
}

/**
 * The most common values in one column, with counts.
 *
 * Separate from the profile because it is per-column by nature and because it
 * is the expensive one — a `GROUP BY` over a wide text column on a large table
 * is not something to run for twenty columns at once without being asked.
 */
export function topValuesSql(
  engine: Engine,
  schema: string,
  table: string,
  column: string,
  limit: number,
  sampleRows: number | null,
): string {
  const q = (s: string) => quoteIdent(s, engine);
  const qualified = `${q(schema)}.${q(table)}`;
  const src = sampleRows && sampleRows > 0
    ? (engine === 'sqlserver'
        ? `(SELECT TOP (${Math.floor(sampleRows)}) ${q(column)} FROM ${qualified}) AS _s`
        : `(SELECT ${q(column)} FROM ${qualified} LIMIT ${Math.floor(sampleRows)}) AS _s`)
    : qualified;
  const col = q(column);
  // NULL is counted as its own bucket rather than dropped: "40 % of this
  // column is NULL" is usually the finding.
  const head = engine === 'sqlserver' ? `SELECT TOP (${Math.floor(limit)}) ` : 'SELECT ';
  const tail = engine === 'sqlserver' ? '' : ` LIMIT ${Math.floor(limit)}`;
  return `${head}${col} AS value, COUNT(*) AS n FROM ${src}`
    + ` GROUP BY ${col} ORDER BY n DESC${tail}`;
}

/** Row-count estimate, to decide whether to offer a sample. Cheap on both. */
export function rowEstimateSql(engine: Engine, schema: string, table: string): string {
  if (engine === 'postgres') {
    // reltuples is the planner's estimate — instant, and -1 on a table that
    // has never been analysed, which the caller must treat as "unknown".
    return `SELECT reltuples::bigint AS est FROM pg_class c`
      + ` JOIN pg_namespace n ON n.oid = c.relnamespace`
      + ` WHERE n.nspname = ${lit(schema)} AND c.relname = ${lit(table)}`;
  }
  if (engine === 'sqlserver') {
    // dm_db_partition_stats.row_count for the heap or clustered index — exact
    // for a base table and free, unlike a COUNT(*) scan. (`rows` is
    // sys.partitions' spelling; this DMV calls it row_count.)
    return `SELECT SUM(p.row_count) AS est FROM sys.dm_db_partition_stats p`
      + ` JOIN sys.objects o ON o.object_id = p.object_id`
      + ` JOIN sys.schemas s ON s.schema_id = o.schema_id`
      + ` WHERE s.name = ${lit(schema)} AND o.name = ${lit(table)}`
      + ` AND p.index_id IN (0, 1)`;
  }
  return `SELECT TABLE_ROWS AS est FROM information_schema.TABLES`
    + ` WHERE TABLE_SCHEMA = ${lit(schema)} AND TABLE_NAME = ${lit(table)}`;
}

/**
 * Above this, profiling offers a sample by default.
 *
 * Two million because a full scan of that is seconds on a warm table and
 * minutes on a cold one — past it the honest default is a sample the user can
 * override, rather than a screen that appears to hang.
 */
export const SAMPLE_THRESHOLD = 2_000_000;
export const DEFAULT_SAMPLE = 500_000;

/** Should a sample be offered, given the row estimate? */
export function suggestSample(estimate: number | null): number | null {
  if (estimate === null || estimate < 0) return null;   // unknown — do not guess
  return estimate > SAMPLE_THRESHOLD ? DEFAULT_SAMPLE : null;
}

/**
 * Selectivity as a share of the rows scanned.
 *
 * The number that tells you what a column *is*: 1.0 is a key, near 0 is a flag,
 * and a column that is 98 % one value is an index nobody should build.
 */
export function selectivity(distinct: number, rowsScanned: number): number | null {
  if (rowsScanned <= 0) return null;
  return distinct / rowsScanned;
}

/** A one-line reading of a column, from its profile row. */
export function describeColumn(p: {
  rowsScanned: number; nulls: number; distinctVals: number;
}): string {
  const { rowsScanned, nulls, distinctVals } = p;
  if (rowsScanned === 0) return 'empty table';
  if (nulls === rowsScanned) return 'entirely NULL';
  const sel = distinctVals / rowsScanned;
  const nullShare = nulls / rowsScanned;
  const bits: string[] = [];
  if (distinctVals === rowsScanned && nulls === 0) bits.push('unique');
  else if (distinctVals === 1) bits.push('single value');
  else if (sel < 0.01) bits.push('very low cardinality');
  else if (sel > 0.95) bits.push('near-unique');
  if (nullShare >= 0.5) bits.push(`${Math.round(nullShare * 100)}% NULL`);
  else if (nulls > 0) bits.push(`${Math.round(nullShare * 100)}% NULL`);
  return bits.length ? bits.join(' · ') : 'ordinary';
}
