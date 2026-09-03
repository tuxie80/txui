/**
 * Build a review-only `SET GLOBAL` statement for a MySQL/MariaDB server variable.
 *
 * The Server info panel browses `SHOW GLOBAL VARIABLES` read-only. Editing a row
 * does NOT write to the server — it *generates* the statement and hands it to the
 * SQL editor (via the `dbgui:insert-sql` event) for the DBA to review and run.
 *
 * Two things make the generated text trustworthy:
 *
 *   - **Values are quoted by type.** A plain number goes in bare
 *     (`SET GLOBAL max_connections = 500`); anything else is a SQL string literal
 *     (`SET GLOBAL sql_mode = 'STRICT_TRANS_TABLES'`), escaped by `sqlLiteral` so
 *     a value containing a quote or backslash cannot break out of the literal.
 *   - **`SET GLOBAL` is not persistent.** It reverts on restart, so every block
 *     carries a `[mysqld]` hint. On MySQL 8.0+ the caller can also surface the
 *     `SET PERSIST` form, which survives a restart without editing my.cnf.
 *
 * Kept dependency-light (only sqlIdent) so it unit-tests straight from node —
 * see tests/serverVarEdit.test.ts.
 */
import { safeIdent, sqlLiteral } from './sqlIdent.ts';

/** A plain integer or decimal literal — bare in SQL; everything else is quoted. */
export function isNumericValue(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * A variable value as it should appear on the right of `=`: numbers bare,
 * everything else (including the empty string and `ON`/`OFF` symbolics) as a
 * safely-escaped SQL string literal.
 */
export function formatVarValue(value: string, engine = 'mysql'): string {
  const v = value.trim();
  return isNumericValue(v) ? v : sqlLiteral(v, engine);
}

export interface BuildOptions {
  /** MySQL 8.0+ (not MariaDB): also surface the `SET PERSIST` form. */
  persist?: boolean;
  /** Engine tag for value/identifier quoting — `'mysql'` covers MariaDB too. */
  engine?: string;
}

/**
 * The review-only block for one variable: the `SET GLOBAL` statement followed by
 * commented persistence guidance. Never executed — inserted into the editor.
 */
export function buildServerVarSql(name: string, value: string, opts: BuildOptions = {}): string {
  const engine = opts.engine ?? 'mysql';
  const ident = safeIdent(name, engine);
  const val = formatVarValue(value, engine);
  const raw = value.trim();

  const lines = [`SET GLOBAL ${ident} = ${val};`];
  if (opts.persist) {
    // MySQL 8.0+: persists across restarts with no config-file edit.
    lines.push(`-- MySQL 8.0+: persist across restarts without editing my.cnf:`);
    lines.push(`-- SET PERSIST ${ident} = ${val};`);
  }
  lines.push(`-- SET GLOBAL is runtime-only (reverts on restart). To persist, add to the [mysqld] section of my.cnf:`);
  lines.push(`-- [mysqld]`);
  lines.push(`-- ${name} = ${raw}`);
  return lines.join('\n');
}
