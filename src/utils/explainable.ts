/**
 * Which statements `EXPLAIN` actually applies to.
 *
 * Pressing ⌘E on a `CREATE TABLE` used to send it straight to the server as
 * `EXPLAIN CREATE TABLE …`, and the user got:
 *
 *     ERROR 1064 (42000): You have an error in your SQL syntax; check the
 *     manual that corresponds to your MySQL server version for the right
 *     syntax to use near 'CREATE TABLE `assignments` (…' at line 1
 *
 * Three things are wrong with that. It blames *their* syntax, which is fine.
 * It quotes a statement they did not write — the app added the `EXPLAIN`. And
 * it tells them nothing about what to do, because the answer is "that
 * statement has no plan", which no part of the message says.
 *
 * The engines genuinely differ, and the difference is not academic:
 * PostgreSQL will happily explain `CREATE TABLE … AS SELECT` (it has a plan —
 * the SELECT) and MySQL will not explain any DDL at all. So this is a table,
 * not a regex.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export interface ExplainVerdict {
  ok: boolean;
  /** Shown instead of the server error. Present only when `ok` is false. */
  reason?: string;
}

/** The leading keyword, with comments and leading noise removed. */
export function leadingKeyword(sql: string): string {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/^[\s(;]+/, '')
    .trim();
  // `WITH … SELECT` is a SELECT as far as EXPLAIN is concerned, and both
  // engines accept it.
  const first = /^[a-z_]+/i.exec(cleaned)?.[0]?.toUpperCase() ?? '';
  return first;
}

/**
 * MySQL 8 explains exactly the four data statements plus `TABLE`. Everything
 * else — DDL, DCL, SHOW, SET, transaction control — is a syntax error, and the
 * error names the user's statement rather than the app's prefix.
 */
const MYSQL_OK = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'TABLE', 'VALUES']);

/**
 * PostgreSQL explains the data statements *and* the two DDL forms that carry a
 * query inside them, because those have a plan to show.
 */
const PG_OK = new Set([
  'SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES',
  'TABLE', 'EXECUTE', 'DECLARE', 'CREATE', 'REFRESH',
]);

/** `CREATE` is only explainable when it wraps a query. */
const PG_CREATE_OK = /^\s*create\s+(or\s+replace\s+)?(temp(orary)?\s+|unlogged\s+)?(table|materialized\s+view)\b[\s\S]*\bas\b[\s\S]*\bselect\b/i;

const NAMES: Record<string, string> = {
  mysql: 'MySQL', postgres: 'PostgreSQL', clickhouse: 'ClickHouse',
  sqlite: 'SQLite', parquet: 'Parquet', redis: 'Redis', duckdb: 'DuckDB',
  sqlserver: 'SQL Server',
};

/**
 * SQL Server plans the data statements, and `EXEC` as well.
 *
 * `EXEC` is the interesting one: under `SET SHOWPLAN_XML ON` the server plans
 * every statement *inside* the procedure and returns them all, which is the
 * only way to see what a procedure is actually doing without unpicking its
 * body. MySQL and PostgreSQL offer nothing equivalent, so it is included
 * rather than kept out for symmetry.
 */
const MSSQL_OK = new Set([
  'SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES',
  'EXEC', 'EXECUTE',
]);

/**
 * Can this statement be explained on this engine?
 *
 * The `reason` is written to be the whole answer: what kind of statement it
 * is, why there is no plan, and — where there is one — the thing to do
 * instead. It replaces the server error rather than decorating it.
 */
export function explainVerdict(sql: string, engine: string): ExplainVerdict {
  const kw = leadingKeyword(sql);
  if (!kw) return { ok: false, reason: 'Nothing to explain — the statement is empty.' };

  const name = NAMES[engine] ?? engine;

  if (engine === 'redis' || engine === 'parquet') {
    return { ok: false, reason: `${name} has no query planner, so there is no plan to show.` };
  }

  if (engine === 'postgres') {
    if (kw === 'CREATE') {
      return PG_CREATE_OK.test(sql)
        ? { ok: true }
        : {
          ok: false,
          reason: 'PostgreSQL can only explain a CREATE that wraps a query — '
            + '`CREATE TABLE … AS SELECT` or `CREATE MATERIALIZED VIEW … AS SELECT`. '
            + 'Plain DDL has no plan: it does one thing, and the planner is not involved.',
        };
    }
    if (kw === 'REFRESH') return { ok: true };
    return PG_OK.has(kw)
      ? { ok: true }
      : { ok: false, reason: ddlReason(kw, name) };
  }

  if (engine === 'clickhouse' || engine === 'sqlite') {
    // Both explain the read path and nothing else worth offering here.
    return kw === 'SELECT' || kw === 'WITH' || kw === 'VALUES'
      ? { ok: true }
      : { ok: false, reason: ddlReason(kw, name) };
  }

  if (engine === 'sqlserver') {
    // SHOWPLAN mode technically ACCEPTS DDL and returns a document — but one
    // with no operator tree in it, because a CREATE TABLE has nothing to plan.
    // Refusing here means the user reads why instead of watching an empty
    // diagram render.
    return MSSQL_OK.has(kw)
      ? { ok: true }
      : { ok: false, reason: ddlReason(kw, name) };
  }

  if (engine === 'duckdb') {
    // DuckDB plans the data statements (EXPLAIN / EXPLAIN ANALYZE both render
    // as text). DDL has no plan there either.
    return MYSQL_OK.has(kw)
      ? { ok: true }
      : { ok: false, reason: ddlReason(kw, name) };
  }

  return MYSQL_OK.has(kw) ? { ok: true } : { ok: false, reason: ddlReason(kw, name) };
}

function ddlReason(kw: string, engine: string): string {
  const ddl = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT']);
  if (ddl.has(kw)) {
    return `${engine} cannot explain a ${kw} statement — DDL has no query plan. `
      + 'It does one thing, and the optimizer is not involved.'
      + (kw === 'ALTER' || kw === 'CREATE'
        ? ' To see what it will cost instead, run it: the confirmation window states the '
          + 'algorithm, the lock it takes and how long it is likely to hold.'
        : '');
  }
  if (kw === 'SHOW' || kw === 'DESCRIBE' || kw === 'EXPLAIN' || kw === 'SET' || kw === 'USE') {
    return `${engine} cannot explain a ${kw} statement — it reads or sets server state rather than `
      + 'querying data, so there is no plan.';
  }
  if (kw === 'GRANT' || kw === 'REVOKE' || kw === 'CREATE_USER') {
    return `${engine} cannot explain a ${kw} statement — privilege changes have no plan.`;
  }
  if (kw === 'BEGIN' || kw === 'START' || kw === 'COMMIT' || kw === 'ROLLBACK' || kw === 'SAVEPOINT') {
    return `${engine} cannot explain transaction control — there is no query to plan.`;
  }
  return `${engine} cannot explain a ${kw} statement. EXPLAIN applies to statements that read or `
    + 'change rows — SELECT, INSERT, UPDATE and DELETE.';
}
