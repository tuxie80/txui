/**
 * Which MySQL-protocol server is this, really?
 *
 * TxUI has one `mysql` engine covering MySQL, MariaDB and Percona, which is
 * right for connecting — they speak the same wire protocol and the same SQL for
 * most of a working day. It is wrong for the DBA surface, where they have
 * diverged completely: MariaDB forked before `performance_schema` grew the
 * tables MySQL 8 built its monitoring on, kept the
 * `information_schema.INNODB_*` tables MySQL 8 deleted, and invented its own
 * replication vocabulary.
 *
 * The differences below were measured, not remembered — against MySQL 8.0.46
 * and 8.4.10 and MariaDB 10.6, 10.11, 11.4 and 11.8, all four MariaDB versions
 * behaving identically. See `dev/probe_my_views.mjs`, which re-runs the whole
 * DBA catalog against the fleet.
 *
 * Pure: version string in, capabilities out. `node --test` covers it.
 */

export type Flavor = 'mysql' | 'mariadb' | 'percona';

export interface ServerFlavor {
  flavor: Flavor;
  major: number;
  minor: number;
  patch: number;
  /** The unparsed string, kept because it is what a user recognises. */
  raw: string;
}

/**
 * Identify the server from `VERSION()` and, when available,
 * `@@version_comment`.
 *
 * MariaDB puts `-MariaDB` in the version string, which is the reliable signal —
 * but not the only thing worth reading. **MariaDB 10.x prefixes a fake `5.5.5-`
 * to the version in its handshake packet**, a workaround for old clients that
 * refuse to talk to a server numbered above 5. Read from the handshake — which
 * is where a driver gets it — MariaDB 10.6 announces itself as
 * `5.5.5-10.6.27-MariaDB`, and parsing the first number found would call it
 * 5.5 and take the wrong branch in every version gate below.
 *
 * Confirmed by reading the greeting packet off each fleet server: 10.6 and
 * 10.11 send the prefix, 11.4 and 11.8 do not, and `SELECT VERSION()` never
 * carries it on any of them. So the prefix cannot be assumed either way — it
 * has to be stripped when present.
 *
 * Percona identifies itself only in `version_comment`; its version string is
 * MySQL's.
 */
export function detectFlavor(version: string, versionComment = ''): ServerFlavor {
  const raw = version.trim();
  const lower = `${raw} ${versionComment}`.toLowerCase();

  // Strip the 5.5.5- compatibility prefix before reading any number.
  const cleaned = raw.replace(/^5\.5\.5-/, '');
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(cleaned);

  const flavor: Flavor = lower.includes('mariadb') ? 'mariadb'
    : lower.includes('percona') ? 'percona'
    : 'mysql';

  return {
    flavor,
    major: m ? Number(m[1]) : 0,
    minor: m ? Number(m[2]) : 0,
    patch: m ? Number(m[3]) : 0,
    raw,
  };
}

/** `true` when the server is at least this version. */
export function atLeast(v: ServerFlavor, major: number, minor = 0, patch = 0): boolean {
  if (v.major !== major) return v.major > major;
  if (v.minor !== minor) return v.minor > minor;
  return v.patch >= patch;
}

export const isMariaDb = (v: ServerFlavor): boolean => v.flavor === 'mariadb';

/**
 * What this server can actually do.
 *
 * Each field is a question some panel already asks badly — by running MySQL's
 * SQL and showing the error, or by showing an empty grid. Every value here was
 * confirmed against the fleet rather than inferred from documentation.
 */
export interface Capabilities {
  /** `performance_schema.data_locks` — MySQL 8 only. MariaDB never grew it. */
  dataLocks: boolean;
  /** `information_schema.INNODB_LOCKS` — MariaDB only; MySQL 8 deleted it. */
  innodbLocksTable: boolean;
  /** `performance_schema.replication_*` tables — MySQL only. */
  replicationPsTables: boolean;
  /** `EXPLAIN ANALYZE` (MySQL 8.0.18+). MariaDB spells it `ANALYZE`. */
  explainAnalyze: boolean;
  /** `ANALYZE FORMAT=JSON` — MariaDB's measured plan, and it is JSON. */
  analyzeFormatJson: boolean;
  /** `gtid_mode` / `gtid_executed`. MariaDB uses `gtid_binlog_pos` instead. */
  mysqlGtid: boolean;
  /** `CREATE SEQUENCE` — MariaDB 10.3+. */
  sequences: boolean;
  /** `information_schema.SEQUENCES` — MariaDB 11.0+, later than sequences. */
  sequencesInInformationSchema: boolean;
  /** `WITH SYSTEM VERSIONING` temporal tables — MariaDB 10.3+. */
  systemVersioning: boolean;
  /** `INSERT`/`DELETE … RETURNING` — MariaDB 10.5+. */
  returningClause: boolean;
  /** `CREATE OR REPLACE TABLE` — MariaDB only. */
  createOrReplace: boolean;
  /** A native `JSON` column type. MariaDB's `JSON` is an alias for LONGTEXT. */
  nativeJsonType: boolean;
  /** `mysql.global_priv` holds the grants; `mysql.user` is a view over it. */
  globalPrivTable: boolean;
  /** `innodb_redo_log_capacity` (MySQL 8.0.30+) vs `innodb_log_file_size`. */
  redoLogCapacity: boolean;
}

/**
 * Resolve capabilities for a server.
 *
 * Written as "what is true" rather than "what is missing" so a new engine
 * cannot inherit a MySQL answer by default — every field is decided here.
 */
export function capabilities(v: ServerFlavor): Capabilities {
  if (v.flavor === 'mariadb') {
    return {
      dataLocks: false,
      innodbLocksTable: true,
      replicationPsTables: false,
      explainAnalyze: false,
      analyzeFormatJson: true,
      mysqlGtid: false,
      sequences: atLeast(v, 10, 3),
      sequencesInInformationSchema: atLeast(v, 11),
      systemVersioning: atLeast(v, 10, 3),
      returningClause: atLeast(v, 10, 5),
      createOrReplace: true,
      nativeJsonType: false,
      globalPrivTable: atLeast(v, 10, 4),
      redoLogCapacity: false,
    };
  }
  // MySQL and Percona. Percona is MySQL plus instrumentation, and none of the
  // questions here are ones its extras change the answer to.
  return {
    dataLocks: atLeast(v, 8),
    // MySQL 8.0 removed INNODB_LOCKS in favour of performance_schema.
    innodbLocksTable: !atLeast(v, 8),
    replicationPsTables: atLeast(v, 5, 7),
    explainAnalyze: atLeast(v, 8, 0, 18),
    analyzeFormatJson: false,
    mysqlGtid: true,
    sequences: false,
    sequencesInInformationSchema: false,
    systemVersioning: false,
    returningClause: false,
    createOrReplace: false,
    nativeJsonType: atLeast(v, 5, 7),
    globalPrivTable: false,
    redoLogCapacity: atLeast(v, 8, 0, 30),
  };
}

/** `MariaDB 11.8.8`, for a status bar. */
export function flavorLabel(v: ServerFlavor): string {
  const name = v.flavor === 'mariadb' ? 'MariaDB'
    : v.flavor === 'percona' ? 'Percona' : 'MySQL';
  return `${name} ${v.major}.${v.minor}.${v.patch}`;
}
