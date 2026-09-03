/**
 * Per-engine connection defaults, and the rule that turns them from *prefilled
 * text you have to delete* into *placeholders you can ignore*.
 *
 * The form used to write the defaults into the fields themselves, so picking
 * an engine dropped `default` / `root` / `postgres` into the user box and
 * `8123` / `3306` into the port box as real values. Every connection then
 * started with the chore of selecting and deleting them.
 *
 * Now the fields start empty, the default is shown as greyed placeholder text,
 * and `resolveDefaults` fills the blanks at save time — so leaving a field
 * untouched means exactly what it looks like it means.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */
import type { Engine } from '../types';

export interface EngineDefaults {
  port: number;
  user: string;
  /** '' = no meaningful default; the field is genuinely optional. */
  db: string;
}

export const ENGINE_DEFAULTS: Record<Engine, EngineDefaults> = {
  mysql:    { port: 3306,  user: 'root',     db: '' },
  postgres: { port: 5432,  user: 'postgres', db: 'postgres' },
  redis:    { port: 6379,  user: '',         db: '' },
  // 8123 is the HTTP interface. The native protocol lives on 9000 but is
  // frequently load-balancer-only or closed; HTTP is what ingresses expose.
  clickhouse: { port: 8123, user: 'default',  db: 'default' },
  // File-backed: no port, no user, and `main` is the database SQLite always
  // has. Parquet has no database layer at all — the file is everything.
  // DuckDB: same file story; the attached databases are read from the catalog.
  sqlite:   { port: 0, user: '', db: 'main' },
  parquet:  { port: 0, user: '', db: '' },
  duckdb:   { port: 0, user: '', db: '' },
  // No default user: MongoDB ships unauthenticated by default, and guessing
  // "root" would be wrong for exactly the deployments that set one. The db is
  // both the default database AND the default authSource — left blank.
  mongodb:  { port: 27017, user: '', db: '' },
  // `sa` is the well-known SQL Server admin login and the placeholder is a
  // hint, not a default anyone should ship. Blank db = the login's default
  // database (usually master).
  sqlserver: { port: 1433, user: 'sa', db: '' },
};

/** Host is engine-independent, but follows the same blank-means-default rule. */
export const DEFAULT_HOST = 'localhost';

export interface ConnFields {
  host: string;
  /** null while the box is empty — `Number('')` is 0, which is not a port. */
  port: number | null;
  user: string;
  database: string;
}

export interface ResolvedConn {
  host: string;
  port: number;
  user: string | null;
  database: string | null;
}

/**
 * Blank field → the engine default. This is the whole contract behind the
 * placeholders: what you see greyed out is what you get.
 */
export function resolveDefaults(f: ConnFields, engine: Engine): ResolvedConn {
  const d = ENGINE_DEFAULTS[engine];
  return {
    host:     f.host.trim() || DEFAULT_HOST,
    port:     f.port ?? d.port,
    user:     f.user.trim() || d.user || null,
    database: f.database.trim() || d.db || null,
  };
}

/**
 * Switching engine must not silently keep the previous engine's defaults —
 * port 3306 left over on a ClickHouse connection would be a real mistake. But
 * it must not throw away something typed by hand either.
 *
 * So: a field is cleared only when it still holds the *outgoing* engine's
 * default (or is already empty). Anything else is the user's own input and
 * survives the switch.
 */
export function clearStaleDefaults(f: ConnFields, from: Engine, to: Engine): ConnFields {
  const prev = ENGINE_DEFAULTS[from];
  if (from === to) return f;
  return {
    host:     f.host,
    port:     f.port === null || f.port === prev.port ? null : f.port,
    user:     f.user.trim() === '' || f.user.trim() === prev.user ? '' : f.user,
    database: f.database.trim() === '' || f.database.trim() === prev.db ? '' : f.database,
  };
}

/** Placeholder for the database box — engines differ in what blank means. */
export function databasePlaceholder(engine: Engine): string {
  if (engine === 'redis') return '0 (0–15)';
  const d = ENGINE_DEFAULTS[engine].db;
  return d || '(optional)';
}
