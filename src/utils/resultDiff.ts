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
import type { ColumnInfo, QueryResult } from '../types/index.ts';

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

export interface QueryResultDiff {
  result: QueryResult;
  notices: string[];
}

/**
 * Render a result diff as another typed result, so TxShell can filter, sort or
 * export it like any other pipeline stage. Row-changing values stay values;
 * only composite keys and whole added/removed rows need a JSON representation.
 */
export function diffToQueryResult(
  a: QueryResult, b: QueryResult, keyColumns?: string[],
  leftLabel = 'current result', rightLabel = 'other result',
): QueryResultDiff {
  const shared = sharedColumns(a, b);
  if (!shared.length) {
    throw new Error('The results share no column names. Alias matching columns the same way.');
  }
  for (const name of shared) {
    if (a.columns.filter(c => c.name === name).length > 1
      || b.columns.filter(c => c.name === name).length > 1) {
      throw new Error(`Shared column \`${name}\` is duplicated; alias it uniquely before diffing.`);
    }
  }

  const keys = keyColumns ?? shared;
  const missing = keys.filter(k => !shared.includes(k));
  if (missing.length) {
    throw new Error(`Key column${missing.length === 1 ? '' : 's'} not shared by both results: `
      + `${missing.join(', ')}. Shared columns: ${shared.join(', ')}`);
  }
  const diff = diffResults(a, b, keys, shared);
  const notices = [
    `Diff: ${diff.same} same · ${diff.different.length} changed · `
      + `${diff.onlyInSource.length} only left · ${diff.onlyInTarget.length} only right.`,
  ];

  const onlyA = a.columns.map(c => c.name).filter(n => !shared.includes(n));
  const onlyB = b.columns.map(c => c.name).filter(n => !shared.includes(n));
  if (onlyA.length) notices.push(`Shape: only in ${leftLabel}: ${onlyA.join(', ')}.`);
  if (onlyB.length) notices.push(`Shape: only in ${rightLabel}: ${onlyB.join(', ')}.`);
  const types = new Map(b.columns.map(c => [c.name, c.type_name]));
  const typeDiffs = shared.filter(name => {
    const left = a.columns.find(c => c.name === name)?.type_name ?? '';
    return left.toLowerCase() !== (types.get(name) ?? '').toLowerCase();
  });
  if (typeDiffs.length) {
    notices.push(`Declared types differ for ${typeDiffs.join(', ')}; values use result-diff `
      + 'normalization (numeric spellings compare numerically; NULL stays distinct).');
  }
  if (diff.duplicateKeys.length) {
    notices.push(`${diff.duplicateKeys.length} duplicate key value${diff.duplicateKeys.length === 1 ? '' : 's'}; `
      + 'only the first row for each key was compared. Choose a unique key for a complete diff.');
  }

  const columns: ColumnInfo[] = [
    { name: 'change', type_name: 'text', nullable: false },
    { name: 'key', type_name: 'text', nullable: false },
    { name: 'column', type_name: 'text', nullable: true },
    { name: 'left', type_name: 'any', nullable: true },
    { name: 'right', type_name: 'any', nullable: true },
  ];
  const rowText = (row: unknown[]) => JSON.stringify(Object.fromEntries(
    shared.map((name, i) => [name, row[i] === undefined ? null : row[i]]),
  ));
  const rows: unknown[][] = [];
  for (const d of diff.different) {
    for (const name of d.changed) {
      const i = shared.indexOf(name);
      rows.push(['changed', JSON.stringify(d.key), name, d.source?.[i] ?? null, d.target?.[i] ?? null]);
    }
  }
  for (const d of diff.onlyInSource) {
    rows.push(['only_left', JSON.stringify(d.key), null, rowText(d.source!), null]);
  }
  for (const d of diff.onlyInTarget) {
    rows.push(['only_right', JSON.stringify(d.key), null, null, rowText(d.target!)]);
  }
  return {
    result: { columns, rows, rows_affected: null, execution_ms: 0, fetch_ms: 0, warnings: [] },
    notices,
  };
}
