/**
 * SQLite maintenance — the guided action list.
 *
 * SQLite maintenance is database-level, not table-level: you VACUUM the whole
 * file, you check the integrity of the whole file. So unlike the MySQL/PG
 * maintenance panel (which operates on selected tables) this is a fixed, small
 * set of verbs, each with the one thing a human needs to know before running
 * it — is it a harmless read, does it just refresh planner stats, or does it
 * take an exclusive lock and rewrite the file.
 *
 * Pure and dependency-free — the statements are constant, so this is trivially
 * `node --test`-driven and the panel just renders + runs what it returns.
 */

/**
 * What running the action costs you.
 *   - `read`    — a pure check; changes nothing, safe to run any time.
 *   - `stats`   — updates the query planner's statistics; cheap, safe.
 *   - `rewrite` — takes an exclusive lock and rewrites pages; do it in a quiet
 *                 moment, and (for VACUUM) with free disk equal to the file.
 */
export type SqliteImpact = 'read' | 'stats' | 'rewrite';

export interface SqliteMaintAction {
  id: string;
  label: string;
  detail: string;
  /** The exact statement run — shown to the user and executed verbatim. */
  sql: string;
  impact: SqliteImpact;
  /** Human label for the impact, shown as a badge. */
  impactLabel: string;
}

const IMPACT_LABEL: Record<SqliteImpact, string> = {
  read: 'read-only',
  stats: 'updates stats',
  rewrite: 'rewrites file · exclusive lock',
};

function a(id: string, label: string, sql: string, impact: SqliteImpact, detail: string): SqliteMaintAction {
  return { id, label, sql, impact, impactLabel: IMPACT_LABEL[impact], detail };
}

/**
 * The full guided list, grouped verify → stats → reclaim. `hasWal` gates the
 * WAL checkpoint (pointless in rollback-journal mode); `autoVacuumIncremental`
 * gates PRAGMA incremental_vacuum (only meaningful when auto_vacuum=INCREMENTAL).
 */
export function sqliteMaintenanceActions(opts?: {
  hasWal?: boolean;
  autoVacuumIncremental?: boolean;
}): SqliteMaintAction[] {
  const out: SqliteMaintAction[] = [
    a('quick_check', 'Quick check', 'PRAGMA quick_check;', 'read',
      'Fast structural check — catches most corruption by verifying the b-tree pages, without the full index cross-check. Returns "ok" when clean.'),
    a('integrity_check', 'Integrity check', 'PRAGMA integrity_check;', 'read',
      'Exhaustive check of every page and index. Reads the whole file, so it is slow on a large database, but it is the definitive answer.'),
    a('foreign_key_check', 'Foreign-key check', 'PRAGMA foreign_key_check;', 'read',
      'Lists rows that violate a declared foreign key. Empty result means every reference resolves.'),
    a('analyze', 'Analyze', 'ANALYZE;', 'stats',
      'Rebuilds the sqlite_stat tables the query planner uses to choose indexes. Worth running after large data changes.'),
    a('optimize', 'Optimize', 'PRAGMA optimize;', 'stats',
      'SQLite decides which tables actually need re-analyzing and does only those — the recommended periodic maintenance.'),
  ];
  if (opts?.hasWal) {
    out.push(a('wal_checkpoint', 'Checkpoint WAL', 'PRAGMA wal_checkpoint(TRUNCATE);', 'stats',
      'Flushes the write-ahead log back into the main file and truncates the -wal file to zero. Frees space the WAL was holding.'));
  }
  if (opts?.autoVacuumIncremental) {
    out.push(a('incremental_vacuum', 'Incremental vacuum', 'PRAGMA incremental_vacuum;', 'rewrite',
      'Reclaims free pages in bounded steps without a full rewrite. Available because auto_vacuum is INCREMENTAL.'));
  }
  out.push(a('vacuum', 'Vacuum', 'VACUUM;', 'rewrite',
    'Rewrites the whole file without its free pages: reclaims space and defragments. Takes an exclusive lock and needs free disk equal to the current file size while it runs.'));
  return out;
}
