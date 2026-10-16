/**
 * The DDL side of CSV import's new-table mode.
 *
 * The wizard's type inference emits SQL-standard names (BIGINT, DOUBLE
 * PRECISION, VARCHAR(255), …) that MySQL, PostgreSQL, SQLite and SQL Server
 * all accept as-is. ClickHouse needs two things changed:
 *
 *   - the types are real CH types — the values load as quoted literals, which
 *     CH parses per target column type, so an Int64 column still receives
 *     '42'; storing numbers as String would be the silent-bad outcome;
 *   - a CREATE TABLE without ENGINE is an error (there is no default table
 *     engine), so the statement gets a plain MergeTree with no sorting key —
 *     an import target, not a tuned table.
 *
 * Pure: no server, no React. `node --test` covers it.
 */

/**
 * The inferred column type as the target engine spells it. Identity except
 * for ClickHouse, where the preview's SQL-standard names are mapped to the
 * real types — applied once when the preview loads, so the step-2 type field
 * shows (and edits) genuine CH types.
 */
export function csvColumnType(engine: string, inferred: string): string {
  if (engine !== 'clickhouse') return inferred;
  switch (inferred.toUpperCase()) {
    case 'BIGINT': return 'Int64';
    case 'DOUBLE PRECISION': return 'Float64';
    case 'TIMESTAMP': return 'DateTime';
    case 'DATE': return 'Date';
    case 'BOOLEAN': return 'Bool';
    // VARCHAR(255) and TEXT — CH has no length-bounded string.
    default: return 'String';
  }
}

/**
 * `CREATE TABLE` for the mapped columns. `quotedTable` and `ident` arrive
 * already quoted by the caller (quoteIdent, per engine). ClickHouse appends
 * the ENGINE clause it cannot live without: `ORDER BY tuple()` is the
 * no-sorting-key spelling — right for a staging target the user can ALTER.
 */
export function csvCreateTableSql(
  engine: string,
  quotedTable: string,
  cols: { ident: string; type: string }[],
): string {
  const lines = cols.map(c => `  ${c.ident} ${c.type}`);
  const base = `CREATE TABLE ${quotedTable} (\n${lines.join(',\n')}\n)`;
  return engine === 'clickhouse' ? `${base}\nENGINE = MergeTree\nORDER BY tuple()` : base;
}
