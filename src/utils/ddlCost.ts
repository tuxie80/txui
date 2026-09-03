/**
 * What an `ALTER TABLE` will cost, before it runs.
 *
 * The question everyone asks and nobody can answer from the statement: *does
 * this lock the table, and for how long?* MySQL 8's online-DDL matrix decides
 * it — an `ADD COLUMN` is instant and an `ADD COLUMN … AFTER x` rebuilds the
 * whole table, and the two statements differ by three words. PostgreSQL has
 * its own version: adding a nullable column is a catalog change, adding one
 * with a volatile default rewrites every row, and `ALTER TYPE` usually does.
 *
 * Putting it in the confirmation dialog is the point. The same figures in a
 * report are interesting; in the dialog, half a second before the statement
 * runs, they change what happens.
 *
 * ## These are model estimates, and they say so
 *
 * Time is size ÷ a throughput constant. That is an order of magnitude for
 * scheduling, not a measurement, and every caller must present it as one —
 * see `ASSUMPTIONS`, which exists so the number can be checked rather than
 * believed.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

/** How the server will do it. */
export type DdlAlgorithm = 'INSTANT' | 'INPLACE' | 'COPY' | 'CATALOG' | 'REWRITE' | 'UNKNOWN';

/** What it does to everyone else meanwhile. */
export type DdlLock =
  | 'NONE'              // reads and writes continue
  | 'SHARED'            // reads continue, writes wait
  | 'EXCLUSIVE'         // everything waits
  | 'UNKNOWN';

export interface DdlCost {
  /** The operation, as a person would name it. */
  operation: string;
  algorithm: DdlAlgorithm;
  lock: DdlLock;
  /** True when every row is written again — the expensive kind. */
  rebuild: boolean;
  /** Seconds, from size ÷ throughput. Null when the size is unknown. */
  seconds: number | null;
  /** Of those seconds, how many block writes. */
  blockedSeconds: number | null;
  /** Extra disk the rebuild needs, in bytes. */
  diskBytes: number | null;
  /**
   * Replica lag this adds.
   *
   * DDL replicates as a single statement and is applied serially on each
   * replica, so a ten-minute ALTER is ten minutes of lag on every one of them
   * — the part that turns a maintenance window into an incident.
   */
  replicaLagSeconds: number | null;
  /** Why it is this algorithm, in one clause. */
  why: string;
}

/**
 * The constants. Named, exported and printed, because a number derived from a
 * guess must be checkable.
 */
export const ASSUMPTIONS = {
  /** Table rebuild throughput. Conservative for spinning disks, pessimistic
   *  for NVMe — deliberately, since the cost of underestimating is an outage. */
  rebuildMbPerSec: 40,
  /** Anything at or below this reads as "instant" rather than a fake number. */
  instantFloorSeconds: 0.05,
  /** A metadata-only change still costs a round trip and a metadata lock. */
  metadataFloorSeconds: 0.1,
} as const;

const MB = 1024 * 1024;

function estimateSeconds(bytes: number | null, rebuild: boolean): number | null {
  if (bytes == null) return null;
  if (!rebuild) return ASSUMPTIONS.metadataFloorSeconds;
  return Math.max(ASSUMPTIONS.instantFloorSeconds, bytes / MB / ASSUMPTIONS.rebuildMbPerSec);
}

/** Strip comments and collapse whitespace so the matchers see one clean line. */
function normalize(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Rule {
  match: RegExp;
  operation: string;
  algorithm: DdlAlgorithm;
  lock: DdlLock;
  rebuild: boolean;
  why: string;
}

/**
 * MySQL 8.0. Order matters — the first match wins, so the *narrower* rule has
 * to come first: `ADD COLUMN … AFTER x` before `ADD COLUMN`, because the two
 * differ by three words and by a full table rebuild.
 */
const MYSQL_RULES: Rule[] = [
  { match: /\badd\s+(column\s+)?[^,]*\b(after|first)\b/i,
    operation: 'ADD COLUMN at a position', algorithm: 'INPLACE', lock: 'NONE', rebuild: true,
    why: 'placing a column anywhere but last rewrites every row' },
  { match: /\badd\s+column\b|\badd\s+`?\w+`?\s+(int|bigint|varchar|char|text|date|datetime|timestamp|decimal|json|tinyint|smallint|float|double|blob|enum)/i,
    operation: 'ADD COLUMN', algorithm: 'INSTANT', lock: 'NONE', rebuild: false,
    why: 'MySQL 8.0.12+ adds a trailing column as metadata only' },
  { match: /\bdrop\s+column\b/i,
    operation: 'DROP COLUMN', algorithm: 'INPLACE', lock: 'NONE', rebuild: true,
    why: 'the row format changes, so every row is written again' },
  { match: /\bmodify\s+column\b|\bchange\s+column\b|\bmodify\s+`/i,
    operation: 'MODIFY COLUMN', algorithm: 'COPY', lock: 'SHARED', rebuild: true,
    why: 'a type change is a copy: reads continue, writes wait' },
  { match: /\badd\s+(unique\s+)?(index|key)\b/i,
    operation: 'ADD INDEX', algorithm: 'INPLACE', lock: 'NONE', rebuild: false,
    why: 'the index is built alongside; writes continue' },
  { match: /\bdrop\s+(index|key)\b/i,
    operation: 'DROP INDEX', algorithm: 'INPLACE', lock: 'NONE', rebuild: false,
    why: 'metadata only' },
  { match: /\badd\s+(constraint\s+\S+\s+)?foreign\s+key\b/i,
    operation: 'ADD FOREIGN KEY', algorithm: 'INPLACE', lock: 'NONE', rebuild: false,
    why: 'INPLACE only while foreign_key_checks = 0; otherwise the child is scanned' },
  { match: /\bconvert\s+to\s+character\s+set\b/i,
    operation: 'CONVERT TO CHARACTER SET', algorithm: 'COPY', lock: 'SHARED', rebuild: true,
    why: 'every string column is re-encoded, so the table is rebuilt' },
  { match: /\bengine\s*=/i,
    operation: 'ENGINE change', algorithm: 'COPY', lock: 'SHARED', rebuild: true,
    why: 'the table is rewritten in the new engine' },
  { match: /\badd\s+primary\s+key\b|\bdrop\s+primary\s+key\b/i,
    operation: 'PRIMARY KEY change', algorithm: 'COPY', lock: 'SHARED', rebuild: true,
    why: 'the clustered index is the table, so changing it rewrites everything' },
  { match: /\brename\s+(to|as)\b/i,
    operation: 'RENAME', algorithm: 'INSTANT', lock: 'EXCLUSIVE', rebuild: false,
    why: 'metadata only, but it takes an exclusive lock for the moment it runs' },
];

/**
 * PostgreSQL. The vocabulary is different — there is no algorithm choice, only
 * whether the catalog changes or the heap is rewritten — and the lock level is
 * what matters, because an ACCESS EXCLUSIVE lock queues *everything* behind it.
 */
const PG_RULES: Rule[] = [
  { match: /\badd\s+column\b[^,]*\bdefault\b/i,
    operation: 'ADD COLUMN with a default', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'PostgreSQL 11+ stores a constant default in the catalog; a volatile one rewrites the table' },
  { match: /\badd\s+column\b/i,
    operation: 'ADD COLUMN', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'catalog only — but the ACCESS EXCLUSIVE lock still queues every query on the table' },
  { match: /\bdrop\s+column\b/i,
    operation: 'DROP COLUMN', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'the column is marked dropped; the space returns with the next rewrite' },
  { match: /\balter\s+column\b[^,]*\btype\b/i,
    operation: 'ALTER COLUMN TYPE', algorithm: 'REWRITE', lock: 'EXCLUSIVE', rebuild: true,
    why: 'the whole table and all its indexes are rewritten under an exclusive lock' },
  { match: /\bcreate\s+index\s+concurrently\b/i,
    operation: 'CREATE INDEX CONCURRENTLY', algorithm: 'INPLACE', lock: 'NONE', rebuild: false,
    why: 'two passes over the table, but reads and writes continue throughout' },
  { match: /\bcreate\s+(unique\s+)?index\b/i,
    operation: 'CREATE INDEX', algorithm: 'INPLACE', lock: 'SHARED', rebuild: false,
    why: 'writes wait for the whole build — use CONCURRENTLY on anything live' },
  { match: /\bset\s+not\s+null\b/i,
    operation: 'SET NOT NULL', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'a full scan to verify, under an exclusive lock (PG 12+ can use a CHECK constraint to skip it)' },
  { match: /\badd\s+constraint\b[^,]*\bnot\s+valid\b/i,
    operation: 'ADD CONSTRAINT … NOT VALID', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'no scan — the existing rows are not checked until VALIDATE CONSTRAINT' },
  { match: /\badd\s+constraint\b|\badd\s+(unique|primary\s+key|foreign\s+key|check)\b/i,
    operation: 'ADD CONSTRAINT', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'the table is scanned to verify it, under an exclusive lock — consider NOT VALID then VALIDATE' },
  { match: /\bvacuum\s+full\b|\bcluster\b/i,
    operation: 'VACUUM FULL / CLUSTER', algorithm: 'REWRITE', lock: 'EXCLUSIVE', rebuild: true,
    why: 'a full rewrite holding an exclusive lock for the duration' },
];

/** Does this statement even have a cost model? */
export function isDdl(sql: string): boolean {
  // `ALTER INDEX … REBUILD` is SQL Server's index maintenance, and an offline
  // rebuild is one of the most expensive things it can be asked to do — it was
  // falling through as "not DDL" and getting no cost estimate at all.
  // `CREATE … NONCLUSTERED INDEX` and `CREATE CLUSTERED INDEX` are T-SQL's
  // spellings, which the unique-only alternation did not admit either.
  return /^\s*(alter\s+table|alter\s+index|create\s+((unique|clustered|nonclustered|columnstore)\s+)*index|vacuum\s+full|cluster)\b/i
    .test(sql);
}

/**
 * SQL Server 2016+.
 *
 * The measurements behind these come from a 33,334-row table on SQL Server
 * 2022 — the numbers in each `why` are what that table actually did, not what
 * the documentation implies:
 *
 *   ADD <col> NULL                     4 ms   metadata
 *   ADD <col> NOT NULL DEFAULT …       4 ms   metadata
 *   DROP COLUMN                        4 ms   metadata
 *   ALTER COLUMN varchar(16)→(64)      0 ms   metadata
 *   ALTER COLUMN int→bigint          212 ms   every row rewritten
 *
 * **The lock model is not MySQL's, and this is the part that matters in a
 * confirmation dialog.** On MySQL `LOCK=NONE` means reads *and* writes keep
 * going for the whole operation. SQL Server has no such thing for `ALTER
 * TABLE`: every one of these takes a schema-modification (Sch-M) lock, which
 * blocks **readers too**. The difference between a cheap change and an
 * expensive one is how LONG that lock is held — a few milliseconds for a
 * metadata change, the whole rewrite otherwise — not whether anything is
 * blocked. So the cheap cases are `EXCLUSIVE` with a metadata-floor duration
 * rather than `NONE`; saying `NONE` would promise something the engine does
 * not do.
 *
 * Order matters: the narrower rule comes first.
 */
const TSQL_RULES: Rule[] = [
  // ── indexes ──
  { match: /\bcreate\b[\s\S]*\bindex\b[\s\S]*\bonline\s*=\s*on\b/i,
    operation: 'CREATE INDEX (ONLINE)', algorithm: 'INPLACE', lock: 'NONE', rebuild: true,
    why: 'ONLINE=ON builds the index alongside the table — Enterprise (and Azure) only; '
      + 'brief Sch-M locks at the start and end, not for the duration' },
  { match: /\balter\s+index\b[\s\S]*\breorganize\b/i,
    operation: 'ALTER INDEX REORGANIZE', algorithm: 'INPLACE', lock: 'NONE', rebuild: true,
    why: 'REORGANIZE is always online and interruptible — it compacts leaf pages '
      + 'without a blocking lock' },
  { match: /\balter\s+index\b[\s\S]*\brebuild\b[\s\S]*\bonline\s*=\s*on\b/i,
    operation: 'ALTER INDEX REBUILD (ONLINE)', algorithm: 'INPLACE', lock: 'NONE', rebuild: true,
    why: 'ONLINE=ON keeps the index readable while it rebuilds — Enterprise only' },
  { match: /\balter\s+index\b[\s\S]*\brebuild\b/i,
    operation: 'ALTER INDEX REBUILD', algorithm: 'REWRITE', lock: 'EXCLUSIVE', rebuild: true,
    why: 'an offline rebuild holds a schema-modification lock for the whole operation: '
      + 'the table is unreadable, not merely unwritable' },
  { match: /\bcreate\b[\s\S]*\bindex\b/i,
    operation: 'CREATE INDEX', algorithm: 'REWRITE', lock: 'EXCLUSIVE', rebuild: true,
    why: 'an offline index build holds a schema-modification lock until it finishes' },
  { match: /\bdrop\s+index\b/i,
    operation: 'DROP INDEX', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'metadata only — but dropping a CLUSTERED index rewrites the table into a heap' },

  // ── columns ──
  // A NOT NULL column with no default is REFUSED on a non-empty table
  // (Msg 4901), so it is not a cost at all — it is a statement that will not
  // run. Saying so beats estimating how long it would take.
  { match: /\badd\b(?![\s\S]*\bconstraint\b)[\s\S]*\bnot\s+null\b(?![\s\S]*\bdefault\b)/i,
    operation: 'ADD COLUMN (NOT NULL, no default)', algorithm: 'UNKNOWN', lock: 'UNKNOWN',
    rebuild: false,
    why: 'SQL Server REFUSES this on a table with any rows (Msg 4901) — add a DEFAULT, '
      + 'or make the column nullable' },
  { match: /\badd\b(?![\s\S]*\bconstraint\b[\s\S]*\b(primary|unique|foreign|check)\b)[\s\S]*\bdefault\b/i,
    operation: 'ADD COLUMN with DEFAULT', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'since 2012 a NOT NULL column with a default is stored as metadata — measured at '
      + '4 ms on 33k rows — but the Sch-M lock still blocks readers for that moment' },
  { match: /\bdrop\s+column\b/i,
    operation: 'DROP COLUMN', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'metadata only (4 ms on 33k rows): the values are orphaned rather than removed, '
      + 'and the space comes back on the next index rebuild' },
  // A widening varchar/nvarchar stays in place; anything else is a rewrite.
  { match: /\balter\s+column\b[\s\S]*\b(varchar|nvarchar|varbinary)\s*\(/i,
    operation: 'ALTER COLUMN (variable-length)', algorithm: 'CATALOG', lock: 'EXCLUSIVE',
    rebuild: false,
    why: 'WIDENING a varchar/nvarchar is metadata only (0 ms on 33k rows). Narrowing it, or '
      + 'changing NULL to NOT NULL, rewrites every row and can fail on data that does not fit' },
  { match: /\balter\s+column\b/i,
    operation: 'ALTER COLUMN', algorithm: 'REWRITE', lock: 'EXCLUSIVE', rebuild: true,
    why: 'a type change rewrites every row (int→bigint measured at 212 ms on 33k rows) under '
      + 'a schema-modification lock — nothing can read the table while it runs' },
  { match: /\badd\b[\s\S]*\bconstraint\b[\s\S]*\b(primary\s+key|unique)\b/i,
    operation: 'ADD PRIMARY KEY / UNIQUE', algorithm: 'REWRITE', lock: 'EXCLUSIVE', rebuild: true,
    why: 'builds an index over every row, and fails if the column already holds duplicates' },
  { match: /\badd\b[\s\S]*\bconstraint\b[\s\S]*\bforeign\s+key\b/i,
    operation: 'ADD FOREIGN KEY', algorithm: 'INPLACE', lock: 'EXCLUSIVE', rebuild: false,
    why: 'every existing row is checked against the parent unless WITH NOCHECK is used — '
      + 'and WITH NOCHECK leaves the constraint untrusted, which the optimiser then ignores' },
  { match: /\badd\b[\s\S]*\bconstraint\b[\s\S]*\bcheck\b/i,
    operation: 'ADD CHECK CONSTRAINT', algorithm: 'INPLACE', lock: 'EXCLUSIVE', rebuild: false,
    why: 'every existing row is verified; WITH NOCHECK skips that and leaves it untrusted' },
  { match: /\bdrop\s+constraint\b/i,
    operation: 'DROP CONSTRAINT', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'metadata only — but the guarantee it enforced is gone from that moment' },
  { match: /\badd\b/i,
    operation: 'ADD COLUMN', algorithm: 'CATALOG', lock: 'EXCLUSIVE', rebuild: false,
    why: 'a nullable column is metadata only (4 ms on 33k rows); the Sch-M lock is brief but '
      + 'blocks readers as well as writers' },
];

/**
 * Cost an `ALTER TABLE` (or index build) against a known table size.
 *
 * `null` when the statement is not one this models — which is the honest
 * answer far more often than a guess would be, and the caller simply shows
 * nothing.
 */
export function ddlCost(sql: string, engine: string, tableBytes: number | null): DdlCost | null {
  if (!isDdl(sql)) return null;
  const s = normalize(sql);
  // Three rule sets, not two. Folding SQL Server into MySQL's made the dialog
  // quote InnoDB behaviour at a T-SQL statement — `ALTER TABLE t ADD qty int`
  // matched the MySQL ADD COLUMN rule and was reported as "MySQL 8.0.12+ adds a
  // trailing column as metadata only", with `lock: NONE`. The conclusion was
  // even roughly right; the reason and the lock were not, and this is the one
  // dialog where being confidently wrong costs the most.
  const rules = engine === 'postgres' ? PG_RULES
    : engine === 'sqlserver' ? TSQL_RULES
    : MYSQL_RULES;
  const rule = rules.find(r => r.match.test(s));
  if (!rule) {
    return {
      operation: 'ALTER TABLE',
      algorithm: 'UNKNOWN', lock: 'UNKNOWN', rebuild: false,
      seconds: null, blockedSeconds: null, diskBytes: null, replicaLagSeconds: null,
      why: 'this shape is not in the model — read it carefully rather than trusting a number',
    };
  }

  const seconds = estimateSeconds(tableBytes, rule.rebuild);
  // Writes are blocked for the whole operation under a SHARED or EXCLUSIVE
  // lock, and not at all under NONE. There is no partial case worth modelling.
  const blockedSeconds = rule.lock === 'NONE' ? 0 : seconds;

  return {
    operation: rule.operation,
    algorithm: rule.algorithm,
    lock: rule.lock,
    rebuild: rule.rebuild,
    seconds,
    blockedSeconds,
    // A rebuild writes a second copy before dropping the first.
    diskBytes: rule.rebuild && tableBytes != null ? tableBytes : null,
    replicaLagSeconds: seconds,
    why: rule.why,
  };
}

/** One line for the confirmation dialog. */
export function describeCost(c: DdlCost): string {
  const bits = [c.operation, `algorithm ${c.algorithm}`, `lock ${c.lock}`];
  if (c.rebuild) bits.push('rebuilds the table');
  if (c.seconds != null) bits.push(`~${fmtSeconds(c.seconds)}`);
  if (c.blockedSeconds != null && c.blockedSeconds > 0) {
    bits.push(`writes blocked ${fmtSeconds(c.blockedSeconds)}`);
  } else if (c.lock === 'NONE') {
    bits.push('writes continue');
  }
  return bits.join(' · ');
}

export function fmtSeconds(s: number): string {
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** The assumptions, printed so the number can be checked rather than believed. */
export function assumptionsText(): string {
  return `Estimates, not measurements: rebuild throughput ${ASSUMPTIONS.rebuildMbPerSec} MB/s, `
    + `metadata floor ${ASSUMPTIONS.metadataFloorSeconds} s. `
    + 'Time comes from the table size divided by that constant — treat it as an order of '
    + 'magnitude for scheduling.';
}

/** The table an ALTER targets, for looking its size up. */
export function ddlTarget(sql: string): string | null {
  const m = /^\s*alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([`"\w$.]+)/i.exec(sql)
    ?? /^\s*create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?[`"\w$]+\s+on\s+(?:only\s+)?([`"\w$.]+)/i.exec(sql)
    ?? /^\s*(?:vacuum\s+full|cluster)\s+([`"\w$.]+)/i.exec(sql);
  if (!m) return null;
  const last = m[1].split('.').pop() ?? m[1];
  return last.replace(/^[`"]|[`"]$/g, '');
}

/**
 * The size of one table, for the estimate — from statistics, never a scan.
 *
 * MySQL's `information_schema.TABLES` and PostgreSQL's
 * `pg_total_relation_size` are both estimates maintained anyway. Paying for a
 * scan to warn someone about a scan would be its own joke.
 */
export function tableSizeSql(engine: string, schema: string, table: string): string {
  const s = schema.replace(/'/g, "''");
  const t = table.replace(/'/g, "''");
  if (engine === 'postgres') {
    return `SELECT pg_total_relation_size(c.oid)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = '${s}' AND c.relname = '${t}'`;
  }
  return `SELECT COALESCE(data_length, 0) + COALESCE(index_length, 0)
FROM information_schema.tables
WHERE table_schema = '${s}' AND table_name = '${t}'`;
}
