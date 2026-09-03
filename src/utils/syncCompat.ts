/**
 * Statements that changed name between MySQL versions.
 *
 * MySQL 8.4 removed the master/slave vocabulary outright — the old spellings are
 * not deprecated there, they are **syntax errors**. A sync tool that hardcodes
 * either spelling works against exactly one of the two servers it is meant to
 * move data between.
 *
 * Every row of the table below was verified against a live pair — MySQL 8.0.46
 * and MySQL 8.4.10, both on 127.0.0.1 — by issuing the statement and recording
 * whether the server accepted it:
 *
 * | Statement                     | 8.0 | 8.4 |
 * |-------------------------------|-----|-----|
 * | `SHOW MASTER STATUS`          | ok  | —   |
 * | `SHOW BINARY LOG STATUS`      | —   | ok  |
 * | `RESET MASTER`                | ok  | —   |
 * | `RESET BINARY LOGS AND GTIDS` | —   | ok  |
 * | `SHOW REPLICA STATUS`         | ok  | ok  |
 * | `RESET REPLICA`               | ok  | ok  |
 *
 * The last two matter as much as the first four: where a modern spelling works
 * on **both**, it is used unconditionally. Version-gating a statement that does
 * not need it is a branch that can only ever be wrong.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

import { escapeLiteral } from './sqlIdent.ts';

/** A parsed `major.minor.patch`, so comparisons are numeric not lexicographic. */
export interface ServerVersion {
  major: number;
  minor: number;
  patch: number;
  /** The string the server reported, kept for reports. */
  raw: string;
}

/**
 * Parse `@@version`.
 *
 * Real values carry suffixes — `8.4.10`, `8.0.46-0ubuntu0.22.04.1`,
 * `10.11.6-MariaDB` — so parsing stops at the first non-numeric component
 * rather than assuming a clean triple.
 */
export function parseVersion(raw: string): ServerVersion {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
  return {
    major: m ? Number(m[1]) : 0,
    minor: m ? Number(m[2]) : 0,
    patch: m && m[3] ? Number(m[3]) : 0,
    raw: raw.trim(),
  };
}

/** True when `v` is at least `major.minor`. */
export function atLeast(v: ServerVersion, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/** MariaDB keeps the legacy vocabulary and diverges elsewhere entirely. */
export function isMariaDb(v: ServerVersion): boolean {
  return /mariadb/i.test(v.raw);
}

/**
 * The statement that reads this server's own binary-log coordinates.
 *
 * Renamed in 8.4. Both spellings exist in exactly one version each, so this is
 * a genuine fork rather than a preference.
 */
export function binlogStatusStatement(v: ServerVersion): string {
  return !isMariaDb(v) && atLeast(v, 8, 4)
    ? 'SHOW BINARY LOG STATUS'
    : 'SHOW MASTER STATUS';
}

/**
 * The statement that clears the binary logs and `gtid_executed`.
 *
 * Needed on the target before `gtid_purged` can be set — see
 * docs/DBSYNC_DEEPDIVE.md §3.5.3. Destructive, so the tool generates it for
 * review rather than running it.
 */
export function resetBinlogStatement(v: ServerVersion): string {
  return !isMariaDb(v) && atLeast(v, 8, 4)
    ? 'RESET BINARY LOGS AND GTIDS'
    : 'RESET MASTER';
}

/**
 * Reading replication state.
 *
 * `SHOW REPLICA STATUS` was accepted by both servers tested, so there is no
 * fork here — only the legacy spelling would need one, and it is never used.
 */
export const REPLICA_STATUS_STATEMENT = 'SHOW REPLICA STATUS';

/** Likewise: accepted on 8.0 and 8.4 alike. */
export const RESET_REPLICA_STATEMENT = 'RESET REPLICA';

/**
 * `gtid_mode` has four values, and only one of them means "every transaction
 * has a GTID".
 *
 * The permissive modes are mid-migration states in which the GTID set is
 * *incomplete*. That is worse than `OFF` for seeding a replica, because the
 * value looks usable and is not — so it is classified as unusable here rather
 * than being allowed to read as "on".
 */
export type GtidAvailability = 'complete' | 'partial' | 'off' | 'unknown';

export function gtidAvailability(gtidMode: string | null | undefined): GtidAvailability {
  switch ((gtidMode ?? '').trim().toUpperCase()) {
    case 'ON':             return 'complete';
    case 'ON_PERMISSIVE':
    case 'OFF_PERMISSIVE': return 'partial';
    case 'OFF':            return 'off';
    default:               return 'unknown';
  }
}

/** Can a GTID-based replica be seeded from this server? */
export function canSeedByGtid(gtidMode: string | null | undefined): boolean {
  return gtidAvailability(gtidMode) === 'complete';
}

/**
 * What the run manifest should record about seeding, in plain words.
 *
 * Written into the manifest at capture time so that someone reading it later
 * knows which kind of seed they hold — rather than inferring it from an absent
 * field, which is how a coordinate-based copy gets mistaken for a GTID one.
 */
export function seedCapability(gtidMode: string | null | undefined): string {
  switch (gtidAvailability(gtidMode)) {
    case 'complete':
      return 'GTID set captured — the target can follow with SOURCE_AUTO_POSITION = 1.';
    case 'partial':
      return `gtid_mode is ${gtidMode} — a mid-migration state where the GTID set is `
        + 'INCOMPLETE. Seeding by GTID would silently skip or replay transactions; '
        + 'use the binary-log coordinates instead.';
    case 'off':
      return 'gtid_mode is OFF — no GTIDs exist. Seeding uses binary-log coordinates '
        + 'with SOURCE_AUTO_POSITION = 0.';
    default:
      return 'gtid_mode could not be read — seeding capability is unknown and must '
        + 'not be assumed.';
  }
}

/**
 * The `CHANGE REPLICATION SOURCE TO` statement for a captured position.
 *
 * Modern spelling only: `CHANGE MASTER TO` is a syntax error on 8.4, and the
 * modern form has been accepted since 8.0.23 — which is older than any server
 * this tool supports copying between.
 *
 * Generated for review, never executed. Starting replication is a topology
 * change, and this application's precedent for those is the users panel: emit
 * the exact statements, put them in the editor, let a person run them.
 */
export interface CapturedPosition {
  gtidExecuted: string | null;
  logFile: string | null;
  logPos: number | null;
}

export function changeSourceStatement(
  pos: CapturedPosition,
  conn: { host: string; port?: number | null; user: string },
): string {
  const lines = [
    'CHANGE REPLICATION SOURCE TO',
    `  SOURCE_HOST = '${escapeLiteral(conn.host, 'mysql')}',`,
    `  SOURCE_PORT = ${conn.port ?? 3306},`,
    `  SOURCE_USER = '${escapeLiteral(conn.user, 'mysql')}',`,
    "  SOURCE_PASSWORD = '<password>',",
  ];
  if (pos.gtidExecuted) {
    lines.push('  SOURCE_AUTO_POSITION = 1;');
  } else if (pos.logFile && pos.logPos !== null) {
    lines.push(`  SOURCE_LOG_FILE = '${escapeLiteral(pos.logFile, 'mysql')}',`);
    lines.push(`  SOURCE_LOG_POS = ${pos.logPos};`);
  } else {
    // Neither form available: emit something that cannot be run by accident.
    return '-- No replication position was captured; this copy cannot seed a replica.';
  }
  return lines.join('\n');
}
