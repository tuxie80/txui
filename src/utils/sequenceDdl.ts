/**
 * Sequences — reading them, and writing the DDL that changes them.
 *
 * The one schema object with an editor-shaped job and no editor. Procedures,
 * functions, triggers and events all have one; a sequence has been a thing you
 * hand-write `ALTER SEQUENCE` for, having first hand-written the `SELECT` that
 * tells you what it is currently set to.
 *
 * All three engines that have them — PostgreSQL, MariaDB from 10.3, and SQL
 * Server from 2012 — support a full `ALTER`, so nothing here ever needs to drop
 * and recreate. That matters: dropping a sequence a column defaults from breaks
 * the column, and a recreate silently resets the position.
 *
 * SQL Server is worth calling out because MySQL proper has no sequences at all
 * — `AUTO_INCREMENT` is a column property, not an object — so this is one of
 * the places SQL Server is closer to PostgreSQL than to MySQL.
 *
 * ## Every value is a string
 *
 * A sequence is `bigint`, and a bigint sequence's default maximum is
 * 9223372036854775807 — which as a JavaScript number becomes
 * 9223372036854776000. Reading a sequence into `number` and writing it back
 * therefore *changes it*, silently, on a perfectly ordinary sequence nobody
 * asked to modify. So the values are carried as text from the driver to the
 * generated SQL and never converted.
 *
 * ## MariaDB reserves the top value
 *
 * Measured: `MAXVALUE 9223372036854775807` on MariaDB reads back as
 * ...806. The server keeps the last value for itself. Nothing here corrects
 * for it — the read is what the server says, and rewriting the user's number
 * to match would be a worse lie — but it does mean a sequence created with the
 * absolute maximum shows one less afterwards, which is the server's answer and
 * not a rounding bug.
 *
 * Pure: no server, so `node --test` covers it.
 */
import { quoteIdent } from './sqlIdent.ts';

export type Engine = 'postgres' | 'mariadb' | 'sqlserver';

export interface SequenceDef {
  schema: string;
  name: string;
  /** PostgreSQL only: smallint | integer | bigint. */
  dataType?: string;
  start: string;
  increment: string;
  minValue: string;
  maxValue: string;
  cache: string;
  cycle: boolean;
  /**
   * PostgreSQL only — the column this sequence belongs to, `table.column`.
   * An owned sequence is dropped with its column, which is the whole reason
   * to show it: it says the sequence is not free-standing.
   */
  ownedBy?: string;
  /**
   * Where the sequence has actually got to. Read-only, and absent on a
   * PostgreSQL sequence that has never been used.
   */
  lastValue?: string | null;
}

export type Risk = 'safe' | 'lossy' | 'destructive';

export interface SequenceChange {
  kind: 'create' | 'alter' | 'restart' | 'drop';
  subject: string;
  risk: Risk;
  sql: string;
  /** Why this is not `safe`, when it is not. */
  warning?: string;
}

const q = (s: string, engine: Engine) =>
  quoteIdent(s, engine === 'postgres' ? 'postgres'
    : engine === 'sqlserver' ? 'sqlserver' : 'mysql');

const qualified = (d: Pick<SequenceDef, 'schema' | 'name'>, engine: Engine) =>
  `${q(d.schema, engine)}.${q(d.name, engine)}`;

/** A bare integer, so nothing else can reach the generated SQL. */
function num(v: string): string {
  const t = String(v ?? '').trim();
  return /^-?\d+$/.test(t) ? t : '';
}

/**
 * `NO CYCLE` on PostgreSQL and SQL Server, `NOCYCLE` on MariaDB.
 *
 * One space, and the statement is a syntax error on the other engines.
 * Verified against SQL Server 2022: `NO CYCLE`, with the space.
 */
const noCycle = (engine: Engine) => (engine === 'mariadb' ? 'NOCYCLE' : 'NO CYCLE');

// ── reading ──────────────────────────────────────────────────────────────────

/** Every sequence in a schema, as `(name)`. */
export function listSql(schema: string, engine: Engine): string {
  if (engine === 'postgres') {
    return 'SELECT sequencename FROM pg_sequences '
      + `WHERE schemaname = ${lit(schema)} ORDER BY sequencename`;
  }
  if (engine === 'sqlserver') {
    return 'SELECT s.name FROM sys.sequences s '
      + 'JOIN sys.schemas sc ON sc.schema_id = s.schema_id '
      + `WHERE sc.name = ${lit(schema)} ORDER BY s.name`;
  }
  // TABLE_TYPE rather than information_schema.SEQUENCES: sequences arrived in
  // MariaDB 10.3 and that view only in 11.0, so the view would report none on
  // a server that has them.
  return 'SELECT TABLE_NAME FROM information_schema.TABLES '
    + `WHERE TABLE_SCHEMA = ${lit(schema)} AND TABLE_TYPE = 'SEQUENCE' ORDER BY TABLE_NAME`;
}

/** Single-quoted literal. Schema and sequence names arrive from the UI. */
function lit(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * One sequence's full definition.
 *
 * Column order is fixed and shared by both engines so the caller maps one
 * shape: start, increment, min, max, cache, cycle, last_value, data_type.
 *
 * Everything is cast to text in the query rather than in the client. A bigint
 * arriving as a JSON number has already lost precision by the time any code
 * here could object.
 */
export function readSql(schema: string, name: string, engine: Engine): string {
  if (engine === 'postgres') {
    return 'SELECT start_value::text, increment_by::text, min_value::text, max_value::text, '
      + 'cache_size::text, cycle, last_value::text, data_type::text '
      + `FROM pg_sequences WHERE schemaname = ${lit(schema)} AND sequencename = ${lit(name)}`;
  }
  if (engine === 'sqlserver') {
    // start/min/max/current are `sql_variant`, so the CAST is not cosmetic —
    // without it the driver gets a variant it has to guess at, and the whole
    // point of this module is that a bigint never goes near a JS number.
    // current_value is NULL until the sequence is first used; start_value is
    // the honest answer then, matching what NEXT VALUE FOR would hand out.
    return 'SELECT CAST(s.start_value AS varchar(40)), CAST(s.increment AS varchar(40)), '
      + 'CAST(s.minimum_value AS varchar(40)), CAST(s.maximum_value AS varchar(40)), '
      + 'CAST(ISNULL(s.cache_size, 0) AS varchar(20)), s.is_cycling, '
      + 'CAST(ISNULL(s.current_value, s.start_value) AS varchar(40)), '
      + 'TYPE_NAME(s.user_type_id) '
      + 'FROM sys.sequences s JOIN sys.schemas sc ON sc.schema_id = s.schema_id '
      + `WHERE sc.name = ${lit(schema)} AND s.name = ${lit(name)}`;
  }
  // MariaDB stores a sequence as a one-row table and that is the documented way
  // to read it — and the only way before 11.0 added information_schema.SEQUENCES.
  // `next_not_cached_value` is where it will resume, which is the honest
  // "current position" when a cache is in play.
  return 'SELECT CAST(start_value AS CHAR), CAST(increment AS CHAR), '
    + 'CAST(minimum_value AS CHAR), CAST(maximum_value AS CHAR), '
    + 'CAST(cache_size AS CHAR), cycle_option, '
    + "CAST(next_not_cached_value AS CHAR), 'bigint' "
    + `FROM ${q(schema, 'mariadb')}.${q(name, 'mariadb')}`;
}

// ── writing ──────────────────────────────────────────────────────────────────

/** `CREATE SEQUENCE`, with only the clauses the user actually set. */
export function createSql(def: SequenceDef, engine: Engine): string {
  const parts = [`CREATE SEQUENCE ${qualified(def, engine)}`];
  // PostgreSQL and SQL Server can both narrow the type (which also caps the
  // maximum); MariaDB has only bigint.
  if (engine !== 'mariadb' && def.dataType) parts.push(`AS ${def.dataType}`);
  if (num(def.start)) parts.push(`START WITH ${num(def.start)}`);
  if (num(def.increment)) parts.push(`INCREMENT BY ${num(def.increment)}`);
  if (num(def.minValue)) parts.push(`MINVALUE ${num(def.minValue)}`);
  if (num(def.maxValue)) parts.push(`MAXVALUE ${num(def.maxValue)}`);
  if (num(def.cache)) parts.push(`CACHE ${num(def.cache)}`);
  parts.push(def.cycle ? 'CYCLE' : noCycle(engine));
  if (engine === 'postgres' && def.ownedBy) parts.push(`OWNED BY ${def.ownedBy}`);
  return parts.join(' ');
}

export function dropSql(def: SequenceDef, engine: Engine, cascade = false): string {
  // Only PostgreSQL has CASCADE for sequences — and it is exactly the option
  // that turns a refused drop into a silent one. MariaDB and SQL Server have
  // no equivalent, so the flag is ignored rather than faked.
  const tail = engine === 'postgres' && cascade ? ' CASCADE' : '';
  return `DROP SEQUENCE ${qualified(def, engine)}${tail}`;
}

/**
 * Move a sequence's position.
 *
 * Split out from `alterSql` because it is a different act. Everything else
 * changes how the sequence will behave; this changes what it will hand out
 * next, and handing out a value that already exists is a duplicate-key error
 * in whatever table is using it.
 */
export function restartSql(def: SequenceDef, value: string, engine: Engine): SequenceChange {
  const v = num(value);
  return {
    kind: 'restart',
    subject: def.name,
    risk: 'destructive',
    sql: `ALTER SEQUENCE ${qualified(def, engine)} RESTART WITH ${v || '1'}`,
    warning: 'Moves the sequence to this value. If anything has already been issued at or '
      + 'above it, the next insert collides with an existing row — the failure appears in the '
      + 'application, not here. Restarting **backwards** on a sequence feeding a primary key '
      + 'is the usual way this goes wrong.',
  };
}

/**
 * Everything needed to turn `current` into `next` — only what changed.
 *
 * Position is deliberately not included even when it differs: `lastValue` moves
 * on its own every time the sequence is used, and generating a `RESTART` from
 * a stale read would quietly rewind a live sequence. Moving it is
 * `restartSql`, which the UI asks for separately.
 */
export function alterSql(
  current: SequenceDef, next: SequenceDef, engine: Engine,
): SequenceChange[] {
  const out: SequenceChange[] = [];
  const target = qualified(current, engine);
  const add = (clause: string, risk: Risk = 'safe', warning?: string) =>
    out.push({ kind: 'alter', subject: next.name, risk, sql: `ALTER SEQUENCE ${target} ${clause}`, warning });

  if (engine !== 'mariadb' && next.dataType && next.dataType !== current.dataType) {
    add(`AS ${next.dataType}`, 'lossy',
      `Narrowing to ${next.dataType} caps the maximum. The server refuses this if the `
      + 'sequence is already past the new type’s range.');
  }
  if (num(next.increment) && next.increment !== current.increment) {
    add(`INCREMENT BY ${num(next.increment)}`);
  }
  if (num(next.minValue) && next.minValue !== current.minValue) {
    add(`MINVALUE ${num(next.minValue)}`);
  }
  if (num(next.maxValue) && next.maxValue !== current.maxValue) {
    const shrinking = BigInt(num(next.maxValue) || '0') < BigInt(num(current.maxValue) || '0');
    add(`MAXVALUE ${num(next.maxValue)}`, shrinking ? 'lossy' : 'safe',
      shrinking
        ? 'Lowering the maximum. Once the sequence reaches it, every further request fails '
          + '— or wraps, if CYCLE is on.'
        : undefined);
  }
  if (num(next.cache) && next.cache !== current.cache) {
    add(`CACHE ${num(next.cache)}`, 'safe');
  }
  if (next.cycle !== current.cycle) {
    add(next.cycle ? 'CYCLE' : noCycle(engine), next.cycle ? 'lossy' : 'safe',
      next.cycle
        ? 'With CYCLE the sequence restarts at the minimum instead of failing, so it will '
          + 'eventually reissue values it has already given out.'
        : undefined);
  }
  // START WITH is what a future RESTART returns to, not the current position,
  // so changing it moves nothing today.
  if (num(next.start) && next.start !== current.start) {
    add(`START WITH ${num(next.start)}`, 'safe');
  }
  return out;
}

/** The strongest risk present, for the confirm dialog. */
export function worstRisk(changes: SequenceChange[]): Risk {
  if (changes.some(c => c.risk === 'destructive')) return 'destructive';
  if (changes.some(c => c.risk === 'lossy')) return 'lossy';
  return 'safe';
}

/** Statements joined for display and for running. */
export function toScript(changes: SequenceChange[]): string {
  return changes.map(c => `${c.sql};`).join('\n');
}
