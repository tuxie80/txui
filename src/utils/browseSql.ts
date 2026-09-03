/**
 * Data-browser SQL helpers — pure, no React/Tauri imports (node --test).
 *
 * `browseSqlText` renders a DISPLAY copy of the SELECT the data browser runs,
 * for the session log (`> select … limit 100`). It mirrors the backend
 * builder in src-tauri/src/db/browser.rs (`build_select`) — keep the two in
 * sync. The executed query binds values as parameters; the display copy
 * inlines them as quoted literals so the log line reads like a runnable
 * statement. Nothing here is executed.
 */
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';
import type { FilterClause, FilterOp, SortClause } from '../types/browser';

/** Default page size / hard default limit for the data browser. */
export const BROWSE_LIMIT_DEFAULT = 100;
export const BROWSE_LIMIT_CHOICES = [100, 500, 1000, 5000, 10000];

/**
 * Default browse sort: first PK column DESC — double-clicking a table opens
 * the LATEST rows. No PK → no ORDER BY (no recency promise).
 */
export function defaultBrowseSort(pkColumns: string[]): SortClause[] {
  return pkColumns.length > 0 ? [{ column: pkColumns[0], direction: 'desc' }] : [];
}

/**
 * The DuckDB tree names objects three-level (`db.schema.table`), which
 * `get_table_meta` parses itself — but the browse SELECT builder (PG-style,
 * `$N` params) splits a dotted name ONCE, so it would quote `"db"."schema.table"`
 * as catalog + a literally-dotted table. The fix lives here because the builder
 * is shared: strip the catalog segment, which the current catalog resolves.
 */
export function duckdbBrowseTarget(table: string): string {
  return table.split('.').length > 2 ? table.slice(table.indexOf('.') + 1) : table;
}

/** Next limit when the user raises the row cap (stays within the choices). */
export function clampBrowseLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return BROWSE_LIMIT_DEFAULT;
  return Math.min(n, BROWSE_LIMIT_CHOICES[BROWSE_LIMIT_CHOICES.length - 1]);
}

const OP_SQL: Record<FilterOp, string> = {
  eq: '=', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=',
  like: 'LIKE', not_like: 'NOT LIKE', is_null: 'IS NULL', is_not_null: 'IS NOT NULL',
};
const OP_HAS_VALUE: Record<FilterOp, boolean> = {
  eq: true, neq: true, lt: true, lte: true, gt: true, gte: true,
  like: true, not_like: true, is_null: false, is_not_null: false,
};

/**
 * The quoting family this engine belongs to.
 *
 * Three, not two: SQL Server brackets identifiers and takes neither backticks
 * nor double quotes by default (`QUOTED_IDENTIFIER` makes `"x"` an identifier,
 * but the driver's own SQL should not depend on a session setting).
 */
type Quoting = 'mysql' | 'postgres' | 'sqlserver';

function quotingFor(engine: string): Quoting {
  if (engine === 'postgres' || engine === 'duckdb') return 'postgres';
  if (engine === 'sqlserver') return 'sqlserver';
  return 'mysql';
}

const ident = (name: string, q: Quoting) => quoteIdent(name, q);

function quoteTable(table: string, q: Quoting): string {
  const i = table.indexOf('.');
  return i < 0
    ? ident(table, q)
    : `${ident(table.slice(0, i), q)}.${ident(table.slice(i + 1), q)}`;
}

function literal(v: string, engine: string): string {
  return sqlLiteral(v, engine);
}

export interface BrowseSqlOpts {
  table:   string;             // "schema.table" or "table"
  filters: FilterClause[];
  sort:    SortClause[];
  limit:   number;
  offset:  number;
  engine:  string;             // 'postgres'/'duckdb' → PG quoting; anything else → MySQL
}

/** Display rendering of the browser SELECT (mirrors db/browser.rs build_select). */
export function browseSqlText(o: BrowseSqlOpts): string {
  // DuckDB takes the PG form: double-quoted identifiers — it rejects backticks
  // (measured backend-side: Parser Error at "`").
  const q = quotingFor(o.engine);

  const where = o.filters.length === 0 ? '' : ' WHERE ' + o.filters.map(f => {
    const col = ident(f.column, q);
    return OP_HAS_VALUE[f.op]
      ? `${col} ${OP_SQL[f.op]} ${literal(f.value ?? '', o.engine)}`
      : `${col} ${OP_SQL[f.op]}`;
  }).join(' AND ');

  const order = o.sort.length === 0 ? '' : ' ORDER BY ' + o.sort
    .map(s => `${ident(s.column, q)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`)
    .join(', ');

  const from = quoteTable(o.table, q);

  if (q === 'sqlserver') {
    // Mirrors `build_browse_select` in db/sqlserver.rs, which is the statement
    // that actually runs. T-SQL pages two different ways and the choice is not
    // stylistic: `TOP (n)` for the first page, `OFFSET … FETCH` beyond it —
    // and FETCH is a **syntax error without an ORDER BY**, so an unsorted
    // browse gets a stabilising one rather than a rejected statement.
    if (o.offset > 0) {
      const stabilise = o.sort.length === 0 ? ' ORDER BY 1' : '';
      return `SELECT * FROM ${from}${where}${order}${stabilise}`
        + ` OFFSET ${o.offset} ROWS FETCH NEXT ${o.limit} ROWS ONLY`;
    }
    return `SELECT TOP (${o.limit}) * FROM ${from}${where}${order}`;
  }

  return `SELECT * FROM ${from}${where}${order} LIMIT ${o.limit} OFFSET ${o.offset}`;
}
