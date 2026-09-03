/**
 * Build review-only `ALTER SYSTEM` statements for a PostgreSQL GUC — the PG
 * counterpart to serverVarEdit.ts (which is SET GLOBAL for MySQL).
 *
 *   - `ALTER SYSTEM SET name = value` writes to postgresql.auto.conf.
 *   - `SELECT pg_reload_conf()` applies reload-context settings immediately;
 *     `postmaster`-context ones (shared_buffers, max_connections, …) still need
 *     a restart, so the reload is best-effort and the value takes hold either
 *     way once the server next reads its config.
 *
 * Never executed here — handed to the editor for review. Pure / node --test.
 */

/** Bare when a plain number or boolean; otherwise a single-quoted string. */
function pgValue(value: string): string {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(on|off|true|false|yes|no)$/i.test(v)) return v.toLowerCase();
  return `'${v.replace(/'/g, "''")}'`;
}

const qIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function buildPgVarSql(name: string, value: string): string {
  return `ALTER SYSTEM SET ${qIdent(name)} = ${pgValue(value)};\nSELECT pg_reload_conf();`;
}

export function buildPgVarResetSql(name: string): string {
  return `ALTER SYSTEM RESET ${qIdent(name)};\nSELECT pg_reload_conf();`;
}
