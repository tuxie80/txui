/**
 * Connection-form validation: the checks that run before a config is saved
 * or tested, each returning a user-facing message or null.
 *
 * Until now the only required field was the name: a port of 0 (`Number('')`)
 * or 70000 sailed through to the backend, a file engine could be saved
 * pointing at nothing, and the Redis database box accepted "abc" (which the
 * URL builder then read as db0 — silently a different database than typed).
 * Every check is a pure function so the form stays declarative and the rules
 * stay under `node --test`.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */

/** Ports live in 1–65535. null means "blank" — the engine default applies. */
export function portError(port: number | null): string | null {
  if (port === null) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'Port must be a whole number between 1 and 65535 (blank uses the engine default)';
  }
  return null;
}

/**
 * The SSH port has no blank state in the form (it defaults to 22), so 0 —
 * what `Number('')` produced when the box was cleared — is an error here,
 * not a default.
 */
export function sshPortError(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'SSH port must be a whole number between 1 and 65535';
  }
  return null;
}

/**
 * Stock Redis has 16 logical databases, 0–15. Blank means db0. Anything else
 * (text, a negative, db16) would be silently coerced to db0 by the URL
 * builder — a wrong-database mistake, so it is rejected instead.
 */
export function redisDbError(database: string): string | null {
  const t = database.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0 || n > 15) {
    return 'Redis database must be a number between 0 and 15';
  }
  return null;
}

/** A file engine with no path opens nothing — there is no default file. */
export function filePathError(filePath: string, engine: 'sqlite' | 'parquet' | 'duckdb'): string | null {
  if (filePath.trim()) return null;
  return engine === 'parquet'
    ? 'Choose the Parquet file or dataset folder this connection opens'
    : engine === 'duckdb'
      ? 'Choose the DuckDB file this connection opens (or use :memory:)'
      : 'Choose the SQLite file this connection opens';
}
