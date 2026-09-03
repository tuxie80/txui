/**
 * SQL builders for creating and dropping the top-level namespaces a server
 * holds: PostgreSQL **schemas** and, on both PostgreSQL and MySQL/MariaDB,
 * whole **databases**.
 *
 * Everything here is **review-only**: the strings are inserted into the editor
 * for the user to run, never executed by the tree. Identifiers are quoted with
 * the shared `sqlIdent.quoteIdent` (never hand-rolled) — double-quoted on
 * PostgreSQL, back-ticked on MySQL — so a mixed-case or reserved name resolves
 * to exactly the object the user picked.
 *
 * Dialect notes that shape the output:
 *   - **CREATE SCHEMA IF NOT EXISTS** is valid on MySQL and PostgreSQL, so
 *     create is idempotent there. **CREATE DATABASE** has no `IF NOT EXISTS` on
 *     PostgreSQL, so it is emitted plain there and idempotently on MySQL.
 *   - **SQL Server has neither `IF NOT EXISTS` form** — both are Msg 156,
 *     *"Incorrect syntax near the keyword 'IF'"*. Idempotence there is an
 *     existence test around the statement, and for `CREATE SCHEMA` that test
 *     has to wrap the statement in `EXEC(…)`: T-SQL requires `CREATE SCHEMA` to
 *     be **the first statement in its batch** (Msg 111), so it cannot follow an
 *     `IF` on its own.
 *   - **DROP** is emitted plain (RESTRICT): with no `CASCADE` the server
 *     refuses to drop a non-empty schema, which is the safe default. `CASCADE`
 *     is PostgreSQL-only — MySQL `DROP DATABASE` has no such modifier and
 *     always takes everything with it.
 *   - Owner (`AUTHORIZATION` / `OWNER`) is a PostgreSQL identifier and is
 *     quoted. `CHARACTER SET` / `COLLATE` are MySQL charset tokens, not
 *     identifiers — emitted bare, and only when they match a safe token so a
 *     stray value can never break out of the clause.
 *
 * Pure module (no React / Tauri imports) — unit-tested with `node --test`.
 */
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

/** A charset / collation token is a plain word — never an identifier to quote. */
const SAFE_TOKEN = /^[A-Za-z0-9_]+$/;

function trimmed(v: string | null | undefined): string {
  return (v ?? '').trim();
}

export interface CreateSchemaOpts {
  engine: string;
  name: string;
  /** PostgreSQL `AUTHORIZATION <owner>`. Ignored when blank or non-PG. */
  owner?: string | null;
}

/**
 * `CREATE SCHEMA IF NOT EXISTS <name>` — a namespace within the current
 * database. `IF NOT EXISTS` is honoured by both engines. On MySQL `SCHEMA` is
 * a synonym for `DATABASE`; the tree only offers this on PostgreSQL, but the
 * builder stays engine-aware so the quoting is always right.
 */
export function createSchemaSql(o: CreateSchemaOpts): string {
  const owner = trimmed(o.owner);
  if (o.engine === 'sqlserver') {
    // The inner statement is a STRING, so its identifiers are bracket-quoted
    // and then the whole thing is escaped as a T-SQL literal — two quoting
    // rules stacked, which is the shape that goes wrong silently.
    const inner = `CREATE SCHEMA ${quoteIdent(o.name, o.engine)}`
      + (owner ? ` AUTHORIZATION ${quoteIdent(owner, o.engine)}` : '');
    return `IF SCHEMA_ID(${sqlLiteral(o.name, o.engine)}) IS NULL `
      + `EXEC(${sqlLiteral(inner, o.engine)});`;
  }
  let sql = `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(o.name, o.engine)}`;
  if (owner && o.engine === 'postgres') {
    sql += ` AUTHORIZATION ${quoteIdent(owner, o.engine)}`;
  }
  return sql + ';';
}

export interface DropSchemaOpts {
  engine: string;
  name: string;
  /** PostgreSQL `CASCADE`. Ignored on MySQL, which has no such modifier. */
  cascade?: boolean;
}

/**
 * `DROP SCHEMA <name> [CASCADE]`. Plain (RESTRICT) by default so the server
 * refuses when the schema still holds objects; `CASCADE` (PostgreSQL only)
 * takes them all with it.
 */
export function dropSchemaSql(o: DropSchemaOpts): string {
  // SQL Server has `IF EXISTS` on the DROP side (2016+) even though it has none
  // on the CREATE side, and no CASCADE at all — a schema holding objects is
  // refused, which is the safe default the other engines get from RESTRICT.
  if (o.engine === 'sqlserver') {
    return `DROP SCHEMA IF EXISTS ${quoteIdent(o.name, o.engine)};`;
  }
  let sql = `DROP SCHEMA ${quoteIdent(o.name, o.engine)}`;
  if (o.cascade && o.engine === 'postgres') sql += ' CASCADE';
  return sql + ';';
}

export interface CreateDatabaseOpts {
  engine: string;
  name: string;
  /** PostgreSQL `OWNER <owner>`. Ignored when blank or non-PG. */
  owner?: string | null;
  /** MySQL `CHARACTER SET <charset>`. Ignored when blank or non-MySQL. */
  charset?: string | null;
  /** MySQL `COLLATE <collation>`. Ignored when blank or non-MySQL. */
  collate?: string | null;
}

/**
 * `CREATE DATABASE <name>` — a whole database. Idempotent on MySQL
 * (`IF NOT EXISTS`, plus optional `CHARACTER SET` / `COLLATE`); plain on
 * PostgreSQL, which rejects `IF NOT EXISTS` here, with an optional `OWNER`.
 */
export function createDatabaseSql(o: CreateDatabaseOpts): string {
  const q = quoteIdent(o.name, o.engine);
  if (o.engine === 'sqlserver') {
    // No IF NOT EXISTS, and no character set — SQL Server's per-database text
    // setting is the COLLATION, which carries the code page with it.
    const collate = trimmed(o.collate);
    return `IF DB_ID(${sqlLiteral(o.name, o.engine)}) IS NULL CREATE DATABASE ${q}`
      + (collate && SAFE_TOKEN.test(collate) ? ` COLLATE ${collate}` : '')
      + ';';
  }
  if (o.engine === 'postgres') {
    let sql = `CREATE DATABASE ${q}`;
    const owner = trimmed(o.owner);
    if (owner) sql += ` OWNER ${quoteIdent(owner, o.engine)}`;
    return sql + ';';
  }
  let sql = `CREATE DATABASE IF NOT EXISTS ${q}`;
  const charset = trimmed(o.charset);
  const collate = trimmed(o.collate);
  if (charset && SAFE_TOKEN.test(charset)) sql += ` CHARACTER SET ${charset}`;
  if (collate && SAFE_TOKEN.test(collate)) sql += ` COLLATE ${collate}`;
  return sql + ';';
}

export interface DropDatabaseOpts {
  engine: string;
  name: string;
}

/**
 * `DROP DATABASE <name>` — removes the database and everything in it. Neither
 * engine takes `CASCADE` here (it is implied), so this is always the plain
 * form; the danger is in the statement itself, which is why the tree emits it
 * for review rather than running it.
 */
export function dropDatabaseSql(o: DropDatabaseOpts): string {
  if (o.engine === 'sqlserver') {
    return `DROP DATABASE IF EXISTS ${quoteIdent(o.name, o.engine)};`;
  }
  return `DROP DATABASE ${quoteIdent(o.name, o.engine)};`;
}
