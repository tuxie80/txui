/**
 * Diffing one result grid against another.
 *
 * "Did my rewrite change the output?" is the question a rewrite always raises,
 * and it is the one thing the plan diff cannot answer — a faster plan can still
 * return different rows. Data compare answers the same shape of question for
 * two *tables*; this points its engine at two *results* instead.
 *
 * The only new work over `dataCompare.compareRows` is alignment: two results
 * for the same question can carry their columns in a different order, or one
 * can select a column the other omits, so the rows must be reprojected onto a
 * shared column list before a positional comparison means anything. Everything
 * after that is `compareRows`, unchanged and already tested.
 *
 * Pure and dependency-light on purpose — `node --test` covers it without a grid.
 */
import { compareRows, type CompareResult } from './dataCompare.ts';

/** The shape a result grid delivers — a subset of `QueryResult`. */
export interface ResultLike {
  columns: { name: string }[];
  rows: unknown[][];
}

/**
 * Columns present in **both** results, kept in the first result's order.
 *
 * A column only one side selected cannot be compared — there is nothing to
 * compare it against — so it is dropped rather than diffed against nulls, which
 * would report every row as different.
 */
export function sharedColumns(a: ResultLike, b: ResultLike): string[] {
  const inB = new Set(b.columns.map(c => c.name));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of a.columns) {
    // A duplicate column name in one result cannot be addressed positionally by
    // name, so only its first occurrence participates.
    if (inB.has(c.name) && !seen.has(c.name)) { seen.add(c.name); out.push(c.name); }
  }
  return out;
}

/** Reproject a result's rows onto `cols`, matching by column name. */
export function project(result: ResultLike, cols: string[]): unknown[][] {
  const idx = cols.map(name => result.columns.findIndex(c => c.name === name));
  return result.rows.map(row => idx.map(i => (i >= 0 ? row[i] : null)));
}

/**
 * Compare two result grids.
 *
 * `keyColumns` decides what "the same row" means. Choosing every shared column
 * turns it into a set/multiset difference — a changed row shows as one removal
 * plus one addition — which is the right default for "did the output change?".
 * Narrowing to a real key surfaces per-column changes as `different` instead.
 */
export function diffResults(
  a: ResultLike, b: ResultLike, keyColumns: string[], columns?: string[],
): CompareResult {
  const cols = columns ?? sharedColumns(a, b);
  return compareRows({
    columns: cols,
    keyColumns,
    sourceRows: project(a, cols),
    targetRows: project(b, cols),
  });
}
