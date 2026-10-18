/**
 * Per-connection database visibility filter (W5.6 — pgAdmin's DB
 * restriction). On a shared host with hundreds of databases the tree shows
 * only the listed ones; an empty list shows all.
 *
 * The FILTERING itself is backend-side (`list_schema` narrows the top-level
 * listing against the session's captured `db_filter`) — this module is the
 * form's half: which engines the field applies to, and parsing the
 * comma-separated input into the stored shape.
 *
 * Matching is exact, with the engine's own case rules (MySQL database names
 * are case-sensitive where the filesystem is; SQL Server's usually are not).
 * No globs, no folding — a filter that guesses hides databases the user
 * meant to keep, which is worse than no filter.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */
import type { Engine } from '../types';

/**
 * Engines whose tree top level IS the server's database list
 * (`SchemaNode::Database`). Mirrors `Engine::has_database_listing` in Rust —
 * keep the two in sync.
 *
 * Not PostgreSQL (a session pins one database at connect; the Database field
 * is the restriction), not Redis (numbered databases, and the tree's labels
 * are decorated — "db3 (12 keys)"), not the file engines (one local path).
 */
export function dbFilterApplies(engine: Engine): boolean {
  return engine === 'mysql' || engine === 'clickhouse'
    || engine === 'mongodb' || engine === 'sqlserver';
}

/**
 * Parse the form's comma-separated input: trim each name, drop empties,
 * dedupe (first occurrence wins — duplicates would only bloat the stored
 * config). No other validation: whether a name exists is the server's
 * business, and a typo shows an empty tree, not a wrong one.
 */
export function parseDbFilter(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(',')) {
    const name = part.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

/** The stored list back into the input's text form (editing a connection). */
export function formatDbFilter(names: string[] | undefined): string {
  return (names ?? []).join(', ');
}
