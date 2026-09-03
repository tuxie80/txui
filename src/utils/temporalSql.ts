/**
 * Reading the history of a MariaDB system-versioned table.
 *
 * A versioned table keeps every version of every row, and an ordinary `SELECT`
 * shows none of them — it returns the current state and nothing else. The
 * history is reachable only through `FOR SYSTEM_TIME`, and only if you also
 * name `row_start` and `row_end` explicitly, because MariaDB hides them from
 * `SELECT *`. So a table whose whole purpose is to retain history looks, from
 * every ordinary query, exactly like one that does not.
 *
 * ## Telling the current version apart
 *
 * A row's `row_end` is a sentinel far in the future while it is current. The
 * sentinel is **not the same on every version** — measured:
 *
 * ```
 * MariaDB 10.6   2038-01-19 04:14:07.999999   ← the 32-bit timestamp maximum
 * MariaDB 11.8   2106-02-07 07:28:15.999999
 * ```
 *
 * Matching a literal would therefore mark every row historical on one of them.
 * `row_end > NOW(6)` is the portable test and works on both.
 *
 * Pure: builds SQL, runs nothing.
 */
import { quoteIdent } from './sqlIdent.ts';

/** The versioning columns, hidden from `SELECT *` and named explicitly here. */
export const ROW_START = 'row_start';
export const ROW_END = 'row_end';

export type HistoryMode =
  /** Every version of every row. */
  | { kind: 'all' }
  /** The table as it stood at one instant. */
  | { kind: 'asOf'; at: string }
  /** Versions whose lifetime overlaps a window. */
  | { kind: 'between'; from: string; to: string };

export interface HistoryOpts {
  /** `schema.table` or `table`. */
  table: string;
  /** Business columns to show. Empty means `*`, plus the versioning columns. */
  columns?: string[];
  mode: HistoryMode;
  limit?: number;
}

const q = (s: string) => quoteIdent(s, 'mysql');

/** `schema.table` → `` `schema`.`table` ``. */
function quoteTable(t: string): string {
  return t.split('.').map(p => q(p.trim())).join('.');
}

/**
 * A timestamp literal.
 *
 * Only the characters a timestamp can contain survive. This value comes from a
 * date picker or a typed field and is concatenated into SQL — `FOR SYSTEM_TIME`
 * takes a literal, not a placeholder, so there is no bind parameter to hide
 * behind.
 */
function tsLiteral(v: string): string {
  // Matched against a timestamp shape rather than filtered character by
  // character. Filtering leaves residue — `2026-01-01'; DROP TABLE x; --`
  // strips down to `2026-01-01  T  --`, which is harmless but is not the
  // instant anyone asked for. Anything unmatched becomes an empty literal,
  // which the server rejects outright: better a clear error than a query
  // silently run against a different point in time.
  const m = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?/
    .exec(String(v ?? ''));
  return `'${m ? m[0] : ''}'`;
}

/** Does this parse as a timestamp the temporal clauses will accept? */
export function isValidTimestamp(v: string): boolean {
  return /^\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?\s*$/
    .test(String(v ?? ''));
}

function clause(mode: HistoryMode): string {
  switch (mode.kind) {
    case 'asOf':
      return ` FOR SYSTEM_TIME AS OF ${tsLiteral(mode.at)}`;
    case 'between':
      // BETWEEN is inclusive of both ends in MariaDB's temporal syntax, unlike
      // FROM…TO which excludes the upper bound.
      return ` FOR SYSTEM_TIME BETWEEN ${tsLiteral(mode.from)} AND ${tsLiteral(mode.to)}`;
    case 'all':
    default:
      return ' FOR SYSTEM_TIME ALL';
  }
}

/**
 * The query that shows a versioned table's history.
 *
 * `is_current` comes first because it is the column that makes the rest
 * readable: without it, the current version and a superseded one look the same
 * apart from a timestamp nobody can compare at a glance.
 *
 * Ordered newest-first within each version chain. A history read without an
 * order is a pile of rows in storage order, which is not the order anything
 * happened in.
 */
export function historySql(o: HistoryOpts): string {
  // A bare `*` cannot follow other select items — `SELECT a, b, *` is a syntax
  // error — so the star has to be qualified with the table. Caught by running
  // the query rather than by reading it; the unit test had encoded the bug.
  const bare = o.table.split('.').pop() ?? o.table;
  const cols = o.columns?.length ? o.columns.map(q).join(', ') : `${q(bare)}.*`;
  const limit = Number.isFinite(o.limit) && (o.limit as number) > 0
    ? ` LIMIT ${Math.floor(o.limit as number)}` : '';
  return `SELECT ${q(ROW_END)} > NOW(6) AS is_current, `
    + `${q(ROW_START)}, ${q(ROW_END)}, ${cols} `
    + `FROM ${quoteTable(o.table)}${clause(o.mode)} `
    + `ORDER BY ${q(ROW_START)} DESC${limit}`;
}

/**
 * What changed between two adjacent versions of the same row.
 *
 * Given the rows a history query returned, pair each version with the one
 * before it and name the columns that differ. Comparing as text on purpose:
 * these values arrive already rendered, and re-parsing a decimal to compare it
 * numerically would call `10.50` and `10.5` different in one direction and the
 * same in the other depending on the driver.
 */
export function versionDiff(
  older: Record<string, unknown>, newer: Record<string, unknown>,
): string[] {
  const skip = new Set([ROW_START, ROW_END, 'is_current']);
  const out: string[] = [];
  for (const k of Object.keys(newer)) {
    if (skip.has(k)) continue;
    const a = older[k], b = newer[k];
    const same = a === b
      || (a === null || a === undefined ? b === null || b === undefined : String(a) === String(b));
    if (!same) out.push(k);
  }
  return out;
}

/**
 * Why a version ended: superseded by an update, or deleted.
 *
 * A deleted row's last version simply stops — there is no later version of it.
 * That distinction is the one a history view exists to show, and it cannot be
 * read off a single row: it needs to know whether the key appears again.
 */
export function endedBy(
  isCurrent: boolean, hasLaterVersion: boolean,
): 'current' | 'updated' | 'deleted' {
  if (isCurrent) return 'current';
  return hasLaterVersion ? 'updated' : 'deleted';
}
