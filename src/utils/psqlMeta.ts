/**
 * psql meta-command compatibility for TxShell.
 *
 * A PostgreSQL DBA arrives with `\d`, `\dt`, `\l` already in their fingers, but
 * TxShell has its own grammar, so those keystrokes would otherwise do nothing.
 * This module is the translation table: a backslash meta-command becomes the
 * catalog query it stands for, and TxShell runs that query through the very same
 * path a typed `SELECT` takes — no new runner, no backend change.
 *
 * It is deliberately pure and engine-tagged: it emits SQL, or a client-side
 * toggle marker for `\timing` / `\x`, and nothing else. The two commands that
 * are client state in psql stay client state here; everything else is a
 * `pg_catalog` / `information_schema` query the app can already execute.
 *
 * Gated to PostgreSQL. On another engine the catalog shapes differ enough that a
 * guessed translation would be worse than none, so those return `null` and let
 * the shell's own `\`-handling (which knows the MySQL equivalents) take over.
 * The `\timing` / `\x` toggles are client features and work on any engine.
 *
 * Pure and dependency-free apart from the shared literal-escaper — driven by
 * `node --test`.
 */
import { sqlLiteral } from './sqlIdent.ts';

export interface PsqlMetaResult {
  /** A query to run through the normal SQL path. */
  sql?: string;
  /** A user-facing note when there is nothing to run (e.g. wrong engine). */
  note?: string;
  /** A client-side display toggle, applied by the panel rather than the server. */
  toggle?: 'timing' | 'expanded';
}

/** Engines whose catalog these queries target. */
function isPostgres(engine: string): boolean {
  const e = engine.toLowerCase();
  return e === 'postgres' || e === 'postgresql' || e === 'pg';
}

/** The commands this module claims; anything else is left for the shell. */
const CATALOG = new Set([
  'l', 'list', 'dt', 'dv', 'di', 'dn', 'df', 'dp', 'z', 'd', 'du', 'dg',
]);

/**
 * A psql name-pattern as a LIKE clause, or '' when there is no argument.
 *
 * psql patterns are globs (`user*`, `?_tmp`), so `*`/`?` map to SQL `%`/`_`. Any
 * literal `%`/`_` the user typed is escaped first with a backslash so it matches
 * itself rather than acting as a wildcard — PostgreSQL's default LIKE escape is
 * the backslash, and `standard_conforming_strings` keeps it literal in the
 * string. The value is quoted through the shared escaper, so a `'` in the
 * pattern cannot break out of the literal.
 */
function likeClause(column: string, arg: string, engine: string): string {
  if (!arg) return '';
  const pat = arg
    .replace(/[%_\\]/g, '\\$&')
    .replace(/\*/g, '%')
    .replace(/\?/g, '_');
  return ` AND ${column} LIKE ${sqlLiteral(pat, engine)}`;
}

/** `\d name` → the columns of one relation (optionally schema-qualified). */
function describe(arg: string, engine: string): string {
  const dot = arg.lastIndexOf('.');
  const schema = dot >= 0 ? arg.slice(0, dot) : null;
  const name = dot >= 0 ? arg.slice(dot + 1) : arg;
  return 'SELECT column_name, data_type, is_nullable, column_default\n'
    + '  FROM information_schema.columns\n'
    + ` WHERE table_name = ${sqlLiteral(name, engine)}`
    + (schema ? ` AND table_schema = ${sqlLiteral(schema, engine)}` : '')
    + '\n ORDER BY ordinal_position';
}

/** `\d` with no name → tables, views, sequences and matviews, like psql. */
const LIST_RELATIONS =
  "SELECT n.nspname AS schema, c.relname AS name,\n"
  + "       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'\n"
  + "         WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence'\n"
  + "         WHEN 'p' THEN 'partitioned table' END AS type\n"
  + '  FROM pg_catalog.pg_class c\n'
  + '  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n'
  + " WHERE c.relkind IN ('r','v','m','S','p')\n"
  + "   AND n.nspname NOT IN ('pg_catalog','information_schema')\n"
  + " ORDER BY 1, 2";

/**
 * Translate one `\`-line into SQL, a client toggle, or a note.
 *
 * Returns `null` for anything this module does not own — an unknown command, or
 * a catalog command on a non-PostgreSQL engine — so the caller can fall back to
 * its own handling and report a genuinely unknown command itself.
 */
export function psqlMeta(line: string, engine: string): PsqlMetaResult | null {
  const s = line.trim();
  if (!s.startsWith('\\')) return null;

  // A command is letters, optionally suffixed with psql's `+` verbosity flag;
  // the remainder is a name or glob pattern. `\?` and friends fail the match and
  // fall through to the shell.
  const m = /^([a-zA-Z]+)(\+)?\s*([\s\S]*)$/.exec(s.slice(1));
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = m[3].trim();

  // Client-side display toggles — engine-independent, like psql's own.
  if (cmd === 'timing') return { toggle: 'timing' };
  if (cmd === 'x') return { toggle: 'expanded' };

  if (!CATALOG.has(cmd)) return null;
  if (!isPostgres(engine)) return null;

  switch (cmd) {
    case 'l':
    case 'list':
      return {
        sql: 'SELECT datname AS database\n'
          + '  FROM pg_catalog.pg_database\n'
          + ' WHERE NOT datistemplate'
          + likeClause('datname', arg, engine)
          + '\n ORDER BY 1',
      };

    case 'dt':
      return {
        sql: 'SELECT schemaname AS schema, tablename AS table\n'
          + '  FROM pg_catalog.pg_tables\n'
          + " WHERE schemaname NOT IN ('pg_catalog','information_schema')"
          + likeClause('tablename', arg, engine)
          + '\n ORDER BY 1, 2',
      };

    case 'dv':
      return {
        sql: 'SELECT schemaname AS schema, viewname AS view\n'
          + '  FROM pg_catalog.pg_views\n'
          + " WHERE schemaname NOT IN ('pg_catalog','information_schema')"
          + likeClause('viewname', arg, engine)
          + '\n ORDER BY 1, 2',
      };

    case 'di':
      return {
        sql: 'SELECT schemaname AS schema, indexname AS index, tablename AS table\n'
          + '  FROM pg_catalog.pg_indexes\n'
          + " WHERE schemaname NOT IN ('pg_catalog','information_schema')"
          + likeClause('indexname', arg, engine)
          + '\n ORDER BY 1, 2',
      };

    case 'dn':
      return {
        sql: 'SELECT nspname AS schema, pg_catalog.pg_get_userbyid(nspowner) AS owner\n'
          + '  FROM pg_catalog.pg_namespace\n'
          + " WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'"
          + likeClause('nspname', arg, engine)
          + '\n ORDER BY 1',
      };

    case 'df':
      return {
        sql: 'SELECT n.nspname AS schema, p.proname AS name,\n'
          + '       pg_catalog.pg_get_function_result(p.oid) AS returns\n'
          + '  FROM pg_catalog.pg_proc p\n'
          + '  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace\n'
          + " WHERE n.nspname NOT IN ('pg_catalog','information_schema')"
          + likeClause('p.proname', arg, engine)
          + '\n ORDER BY 1, 2',
      };

    case 'dp':
    case 'z':
      return {
        sql: 'SELECT table_schema AS schema, table_name AS name,\n'
          + '       grantee, privilege_type\n'
          + '  FROM information_schema.role_table_grants\n'
          + " WHERE table_schema NOT IN ('pg_catalog','information_schema')"
          + likeClause('table_name', arg, engine)
          + '\n ORDER BY 1, 2, 3',
      };

    case 'du':
    case 'dg':
      return {
        sql: 'SELECT rolname AS role, rolsuper AS superuser, rolcreatedb AS createdb,\n'
          + '       rolcreaterole AS createrole, rolcanlogin AS login,\n'
          + '       rolreplication AS replication\n'
          + '  FROM pg_catalog.pg_roles\n'
          + " WHERE rolname NOT LIKE 'pg\\_%'"
          + likeClause('rolname', arg, engine)
          + '\n ORDER BY 1',
      };

    case 'd':
      // `\d` and `\d+` describe a relation; with no name they list relations.
      return { sql: arg ? describe(arg, engine) : LIST_RELATIONS };

    default:
      return null;
  }
}
