/**
 * Redis logical databases behind the browser's db strip
 * (src/components/RedisBrowser.tsx).
 *
 * The backend's `list_schema` (db/redis.rs) renders `INFO keyspace` as labels
 * — "db3 (12 keys)", or "db0 (empty)" for a keyspace-less server — and the
 * connection config's `database` field picks the db index at connect time
 * (`build_url`). There is no runtime switch: `set_session_db` has no Redis
 * arm, and SELECT on the shared connection races every concurrent command
 * onto the wrong database (why `list_prefixes` opens a dedicated one). Both
 * parsings the strip needs live here so the component stays declarative.
 *
 * Pure and dependency-free — driven by `node --test` (tests/redisDbs.test.ts).
 */

/** What one backend db label carries: the index, and the key count when the label reports one. */
export interface RedisDbLabel { index: number; keys: number | null }

/**
 * Parse a `list_schema` db label — "db3 (12 keys)" or "db0 (empty)".
 * Returns null for anything that is not one (a defensive guard, not an
 * expected case: the Redis arm only ever emits these two shapes).
 */
export function parseRedisDbLabel(label: string): RedisDbLabel | null {
  const m = /^db(\d+)(?:\s+\((?:(\d+) keys|empty)\))?$/.exec(label.trim());
  if (!m) return null;
  return { index: Number(m[1]), keys: m[2] !== undefined ? Number(m[2]) : null };
}

/**
 * The db index a session opened with, from the connection's `database` field.
 * Mirrors `build_url` (db/redis.rs): a non-numeric value or db0 produces no
 * URL path, and no path means db0.
 */
export function redisConfigDbIndex(database: string | null | undefined): number {
  const n = Number((database ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
}
