/**
 * Duplicate / copy a table (structure + optional data) on the same server —
 * the one-click "clone this table" every desktop client ships (HeidiSQL,
 * phpMyAdmin, Navicat, DataGrip, dbForge).
 *
 * REVIEW-ONLY: this only *builds* the SQL. The caller drops it into the editor;
 * the user decides when (and whether) to run it. Cloning a large table copies
 * every row, so it is never auto-executed.
 *
 * Engine shapes differ:
 *   - MySQL / MariaDB: `CREATE TABLE new LIKE old` copies the full structure
 *     (columns, indexes, defaults). `LIKE ... INCLUDING ALL` is not valid there.
 *   - PostgreSQL: `CREATE TABLE new (LIKE old INCLUDING ALL)` — the plain
 *     `LIKE old` form on PG copies only columns, so INCLUDING ALL is needed to
 *     carry indexes, defaults, constraints across.
 *
 *   - **SQL Server has neither form.** `CREATE TABLE new LIKE old` and
 *     `(LIKE old INCLUDING ALL)` are both syntax errors. Its idiom is
 *     `SELECT … INTO new FROM old`, which creates the table as a side effect of
 *     the select — so structure-only is the same statement with a false
 *     predicate.
 *
 *     **It copies less than the other two, and that is worth saying.** Measured
 *     against SQL Server 2022: every column comes across, and so does IDENTITY —
 *     but indexes, primary keys, defaults, check constraints and foreign keys do
 *     **not** (0 of each on the copy). The other engines' forms carry them. A
 *     clone that silently lost every index would be discovered later, under
 *     load, so the caller is told rather than left to find out.
 *
 * Data, when requested, is the same on all three in spirit; on SQL Server it is
 * the single `SELECT * INTO` rather than a separate INSERT.
 */
import { quoteIdent } from './sqlIdent.ts';

export interface DuplicateTableParams {
  /** Owning schema/database, if the object is qualified. */
  schema?: string;
  /** Source table name. */
  table: string;
  /** Name for the copy (created in the same schema as the source). */
  newName: string;
  /** Also copy the rows, not just the structure. */
  withData?: boolean;
  engine: string;
}

/** Quote `schema.name`, or just `name` when there is no schema. */
function qualified(schema: string | undefined, name: string, engine: string): string {
  const q = quoteIdent(name, engine);
  return schema ? `${quoteIdent(schema, engine)}.${q}` : q;
}

/**
 * Build the statements that clone `table` into `newName` on the same server.
 * Returns bare SQL (no trailing `;`) — the caller joins and terminates, matching
 * the other SQL builders in this app.
 */
export function duplicateTableSql(params: DuplicateTableParams): string[] {
  const { schema, table, newName, withData, engine } = params;
  const src = qualified(schema, table, engine);
  const dst = qualified(schema, newName, engine);

  if (engine === 'sqlserver') {
    // One statement, not two: SELECT INTO creates the table AND fills it, so
    // structure-only is the same statement with a predicate that matches
    // nothing. A separate INSERT afterwards would be inserting into a table
    // this statement had already populated.
    return [
      '-- SELECT INTO copies the columns and IDENTITY, but NOT the indexes,',
      '-- primary key, defaults, check constraints or foreign keys.',
      '-- Recreate those on the copy if it needs them.',
      `SELECT * INTO ${dst} FROM ${src}${withData ? '' : ' WHERE 1 = 0'}`,
    ];
  }

  const create = engine === 'postgres'
    ? `CREATE TABLE ${dst} (LIKE ${src} INCLUDING ALL)`
    : `CREATE TABLE ${dst} LIKE ${src}`;

  const stmts = [create];
  if (withData) stmts.push(`INSERT INTO ${dst} SELECT * FROM ${src}`);
  return stmts;
}
