/**
 * The rulebook, applied to a schema that already exists.
 *
 * `../review` judges a *migration*: it parses DDL, works out the shape each
 * table will have afterwards, and reports what is wrong before it ships. That
 * needs a 1,900-line DDL parser.
 *
 * Two thirds of its rulebook does not. "An `id` column should be UNSIGNED",
 * "an indexed `VARCHAR(255)` reserves 1020 bytes per entry", "these two tables
 * disagree about `order_id`" — every one of those is a judgement about
 * **columns, keys, indexes and tables**, and a migration is only one way to be
 * shown some. The live catalog is another, and TxUI is already connected to
 * it. So this module takes a snapshot of `information_schema` / `pg_catalog`
 * and answers the same questions with no parser at all.
 *
 * Two rulebooks live here, dispatched on `snap.engine`. The MySQL one is the
 * original (InnoDB signedness, the charset/collation chain, utf8mb4 byte
 * math). The PostgreSQL one is deliberately **re-derived, not re-labelled**:
 * PG has no unsigned integers, no per-table charset, no hidden clustered key
 * and no 2038 ceiling, so those rules simply do not run — and the rules that
 * replace them are the judgements a PG DBA actually makes: `timestamp without
 * time zone` where `timestamptz` was meant, `serial` instead of identity,
 * `money`, blank-padded `char(n)`, unlogged tables, `NOT VALID` foreign keys,
 * FK columns PG never auto-indexed, and sequence headroom on identity
 * columns. What is genuinely engine-neutral (redundant prefix indexes, UNIQUE
 * over nullable columns, same-named columns declared two ways, reserved-word
 * names) runs for both, with the wording each engine's behaviour earns.
 *
 * ## Rules for the rules
 *
 * Every finding here has to survive three tests, because a report nobody
 * trusts is worse than no report:
 *
 * 1. **It names one thing and one reason.** "This table has 6 indexes" names
 *    neither. `../review` deleted that rule and the reasoning is quoted in its
 *    HANDOFF §5; the same deletions apply here and must not creep back.
 * 2. **The reader can act on it.** Server state, `my.cnf` settings and
 *    release-process concerns are not schema defects.
 * 3. **It is gated on magnitude.** A `VARCHAR(255)` on a 40-row lookup table
 *    is not a finding. A rule that fires on every schema teaches people to
 *    ignore the panel.
 *
 * ## The one policy decision worth knowing
 *
 * When a column disagrees with the rest of the schema, the fix follows the
 * **rulebook, not the majority**. In a schema that has been growing for eight
 * years the majority is usually the legacy mistake — `int signed` for ids,
 * `varchar(255)` for barcodes. So `UNSIGNED` beats signed and narrower beats
 * wider, whichever side has more columns.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { Finding, Severity } from './sqlLint.ts';
import { RESERVED_WORDS, MYSQL_RESERVED_WINDOWS, PG_RESERVED_WORDS, quoteIdent } from './sqlIdent.ts';

/** MySQL identifier for generated fix SQL — a backtick in a name must double,
 *  never break out of the identifier (WP-08 8.6). */
const mq = (name: string) => quoteIdent(name, 'mysql');

// ── the snapshot ─────────────────────────────────────────────────────────────

export interface CatalogColumn {
  table: string;
  name: string;
  /** `information_schema.DATA_TYPE` — `int`, `varchar`, `datetime`. */
  dataType: string;
  /** `COLUMN_TYPE` — `int unsigned`, `varchar(255)`, `enum('a','b')`. */
  columnType: string;
  nullable: boolean;
  defaultValue: string | null;
  /** `auto_increment`, `on update CURRENT_TIMESTAMP`, `STORED GENERATED`. */
  extra: string;
  charset: string | null;
  collation: string | null;
  charMaxLen: number | null;
  comment: string;
}

export interface IndexColumn {
  name: string;
  /** 1-based position within the index. */
  seq: number;
  /** Prefix length for a partial index, else null. */
  subPart: number | null;
  /** Distinct values at this prefix, as the optimizer sees it. */
  cardinality: number | null;
}

export interface CatalogIndex {
  table: string;
  name: string;
  unique: boolean;
  /** `BTREE`, `FULLTEXT`, `SPATIAL`, `HASH`. */
  type: string;
  columns: IndexColumn[];
  /** Bytes on disk, when known. */
  bytes?: number | null;
}

export interface CatalogTable {
  name: string;
  engine: string | null;
  collation: string | null;
  /** Row count from persisted statistics — never `COUNT(*)`. */
  rows: number | null;
  dataBytes: number | null;
  indexBytes: number | null;
  /**
   * The next value the counter will hand out (MySQL `AUTO_INCREMENT`). On a
   * PostgreSQL snapshot this carries the sequence's last handed-out value —
   * the same "how far along is the counter" number the headroom rule needs.
   */
  autoIncrement: number | null;
  comment: string;
}

export interface CatalogFk {
  name: string;
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  /** Position within a composite key, 1-based. */
  ordinal: number;
  onDelete: string;
  onUpdate: string;
  /**
   * PG `convalidated`: a NOT VALID foreign key checks new rows but has never
   * proven the existing ones, and the planner may not rely on it. Absent (or
   * true) means valid — MySQL has no such state.
   */
  validated?: boolean;
}

export interface SchemaSnapshot {
  engine: string;
  schema: string;
  /** Server default charset/collation — the top of the inheritance chain. */
  serverCharset: string | null;
  serverCollation: string | null;
  schemaCharset: string | null;
  schemaCollation: string | null;
  /** `@@version` — drives the reserved-word upgrade check (8.0 → 8.4). */
  serverVersion?: string | null;
  tables: CatalogTable[];
  columns: CatalogColumn[];
  indexes: CatalogIndex[];
  foreignKeys: CatalogFk[];
  /**
   * Where the row counts and sizes came from, and how stale they are. Carried
   * into every finding that quotes a number, because a report that mixes
   * measured and estimated figures without saying which is which will be
   * believed about the wrong one.
   */
  statsSource?: string;
  statsAge?: string;
}

// ── policy (visible, and overridable later) ─────────────────────────────────

/**
 * Column names too vague to compare across tables.
 *
 * `id` occurs in 221 tables of a real schema and means something different in
 * each; comparing them produced advice to match a type belonging to an
 * unrelated entity. Nothing is lost by dropping them — a signed `id` is still
 * caught by the integer rule, with better advice than "match the majority".
 */
export const VAGUE_COLUMN_NAMES = new Set([
  'id', 'name', 'type', 'status', 'value', 'version', 'state', 'kind', 'code',
  'title', 'label', 'description', 'comment', 'note', 'data', 'content',
  'amount', 'quantity', 'count', 'total', 'sum', 'price', 'position', 'order',
  'sector', 'zone', 'level', 'priority', 'category', 'group', 'source',
]);

/** Suffixes that make a name a *reference* — the ones that get joined. */
export const REFERENCE_SUFFIXES = [
  '_id', '_ean', '_uuid', '_code', '_ref', '_no', '_key', '_hash', '_sku', '_iban',
];

/** Bare words that are unambiguous across any schema. */
export const GLOBAL_COLUMN_NAMES = new Set(['email', 'ean', 'iban', 'sku', 'isbn', 'vat_id']);

/** Names that mean "a machine compares this exactly" — case folding is wrong. */
const IDENTIFIER_NAME = /(^|_)(code|ean|sku|uuid|guid|hash|token|barcode|iban|isbn|checksum|signature|slug)s?$/i;

/** Names that mean money. */
const MONEY_NAME = /(price|cost|amount|total|sum|fee|balance|salary|revenue|discount|vat|tax)/i;

/**
 * Signed/unsigned ceilings, for headroom arithmetic.
 *
 * The two BIGINT ceilings cannot be represented exactly by a double, so they
 * are written as the double that is nearest — which is what the runtime would
 * store anyway, and what the linter would otherwise flag as a silent loss.
 * This is only ever used as the denominator of a percentage, where an error of
 * one part in 2^53 changes nothing; nothing here ever hands a BIGINT back to
 * the server.
 */
const INT_CEILING: Record<string, { signed: number; unsigned: number }> = {
  tinyint:   { signed: 127, unsigned: 255 },
  smallint:  { signed: 32767, unsigned: 65535 },
  mediumint: { signed: 8388607, unsigned: 16777215 },
  int:       { signed: 2147483647, unsigned: 4294967295 },
  bigint:    { signed: 9.223372036854776e18, unsigned: 1.8446744073709552e19 },
};

/** Below this a schema-quality rule is noise: the table is a lookup. */
const SMALL_TABLE_ROWS = 1000;

// ── helpers ─────────────────────────────────────────────────────────────────

const isUnsigned = (c: CatalogColumn) => /\bunsigned\b/i.test(c.columnType);
const isInteger = (c: CatalogColumn) => c.dataType.toLowerCase() in INT_CEILING;
const isAutoInc = (c: CatalogColumn) => /auto_increment/i.test(c.extra);
/** PG: the column is fed by a sequence (`identity` or `serial` in `extra`). */
const isSequenceDriven = (c: CatalogColumn) => /identity|serial/i.test(c.extra);

export function isReferenceName(name: string): boolean {
  const n = name.toLowerCase();
  if (GLOBAL_COLUMN_NAMES.has(n)) return true;
  return REFERENCE_SUFFIXES.some(s => n.endsWith(s)) && !VAGUE_COLUMN_NAMES.has(n);
}

/** Bytes an index entry reserves for this column — declared width, not data. */
export function indexEntryBytes(c: CatalogColumn, subPart: number | null): number {
  const chars = subPart ?? c.charMaxLen ?? 0;
  if (!chars) return 0;
  const cs = (c.charset ?? '').toLowerCase();
  const perChar = cs.startsWith('utf8mb4') ? 4 : cs.startsWith('utf8') ? 3 : cs.startsWith('ucs2') ? 2 : 1;
  return chars * perChar;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

interface Ctx {
  snap: SchemaSnapshot;
  byTable: Map<string, CatalogTable>;
  colsByTable: Map<string, CatalogColumn[]>;
  idxByTable: Map<string, CatalogIndex[]>;
  out: Finding[];
  n: { v: number };
}

function push(
  ctx: Ctx, id: string, severity: Severity, title: string, detail: string,
  extra: Partial<Finding> = {},
): void {
  ctx.out.push({ id, severity, title, detail, ...extra });
}

/** Statistics-derived numbers always name their source and their age. */
function statsEvidence(ctx: Ctx, value: string): Finding['evidence'] {
  return [{
    source: ctx.snap.statsSource ?? 'information_schema',
    value,
    age: ctx.snap.statsAge,
  }];
}

// ── §1 integers ──────────────────────────────────────────────────────────────

function integerRules(ctx: Ctx): void {
  // PostgreSQL has no UNSIGNED and no AUTO_INCREMENT — the signedness rules
  // cannot fire and the headroom rule needs its own wording and fix, so the
  // whole section is replaced, not patched over.
  if (ctx.snap.engine === 'postgres') return pgSequenceRules(ctx);
  for (const c of ctx.snap.columns) {
    if (!isInteger(c)) continue;

    // A surrogate key that can never be negative, declared as if it could:
    // half the range is thrown away, and the day it matters is the day the
    // counter passes 2,147,483,647 and inserts start failing.
    if (isAutoInc(c) && !isUnsigned(c)) {
      push(ctx, 'INT1', 'orange',
        `${c.table}.${c.name} is a signed AUTO_INCREMENT`,
        `Declared \`${c.columnType}\`. Half the range is unreachable and the negative half is never used.`,
        {
          why: 'The ceiling arrives at half the value you think it is, and it arrives as failing INSERTs on the busiest table you own.',
          fix: `ALTER TABLE ${mq(c.table)} MODIFY ${mq(c.name)} ${c.dataType} UNSIGNED NOT NULL AUTO_INCREMENT;`,
          ruleRef: 'rulebook §1 integers',
          confidence: 'certain',
        });
    }

    // A reference column must match its parent exactly; signedness is the
    // difference MySQL resolves by coercion, silently, with no warning.
    if (!isAutoInc(c) && isReferenceName(c.name) && !isUnsigned(c)) {
      push(ctx, 'INT2', 'yellow',
        `${c.table}.${c.name} is a signed reference column`,
        `Declared \`${c.columnType}\`. Reference columns are UNSIGNED by the rulebook, and a signed/unsigned pair cannot be joined without coercion.`,
        {
          why: 'A comparison across the signedness boundary coerces one side, and the index on the coerced side stops being usable — with no error and no warning.',
          ruleRef: 'rulebook §1 integers',
          confidence: 'certain',
        });
    }
  }

  // AUTO_INCREMENT headroom, from the live counter.
  for (const t of ctx.snap.tables) {
    if (t.autoIncrement == null) continue;
    const col = (ctx.colsByTable.get(t.name) ?? []).find(isAutoInc);
    if (!col) continue;
    const ceil = INT_CEILING[col.dataType.toLowerCase()];
    if (!ceil) continue;
    const limit = isUnsigned(col) ? ceil.unsigned : ceil.signed;
    const pct = (t.autoIncrement / limit) * 100;
    if (pct < 20) continue;
    const sev: Severity = pct >= 80 ? 'red' : pct >= 50 ? 'orange' : 'yellow';
    push(ctx, 'INT3', sev,
      `${t.name}.${col.name} has used ${pct.toFixed(1)}% of its AUTO_INCREMENT range`,
      `Next value ${t.autoIncrement.toLocaleString()} of a ${isUnsigned(col) ? 'UNSIGNED ' : ''}${col.dataType} ceiling of ${limit.toLocaleString()}.`,
      {
        why: 'At the ceiling every INSERT fails with a duplicate-key error on a column nobody is inserting into. Widening it afterwards is a full table rebuild, under pressure.',
        fix: `ALTER TABLE ${mq(t.name)} MODIFY ${mq(col.name)} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;`,
        evidence: [{ source: 'information_schema.TABLES.AUTO_INCREMENT', value: t.autoIncrement.toLocaleString() }],
        ruleRef: 'rulebook §1 integers',
        confidence: 'certain',
      });
  }
}

/**
 * §1 for PostgreSQL: sequence/identity headroom.
 *
 * PG sequences are always int8 counters, but the column they feed is not —
 * when the column is `integer`, the day the sequence passes 2,147,483,647 the
 * INSERT fails on the column's range, and the fix (`ALTER COLUMN … TYPE
 * bigint`) is a full table rewrite taken under pressure. `last_value` arrives
 * via `applySequences`; NULL (no sequence privilege) means unknown, and
 * unknown stays silent.
 */
function pgSequenceRules(ctx: Ctx): void {
  for (const t of ctx.snap.tables) {
    if (t.autoIncrement == null) continue;
    const col = (ctx.colsByTable.get(t.name) ?? []).find(isSequenceDriven);
    if (!col || !isInteger(col)) continue;
    const limit = INT_CEILING[col.dataType.toLowerCase()].signed;
    const pct = (t.autoIncrement / limit) * 100;
    if (pct < 20) continue;
    const sev: Severity = pct >= 80 ? 'red' : pct >= 50 ? 'orange' : 'yellow';
    push(ctx, 'SEQ1', sev,
      `${t.name}.${col.name} has used ${pct.toFixed(1)}% of its ${col.dataType} range`,
      `The sequence has handed out ${t.autoIncrement.toLocaleString()} against a ${col.dataType} ceiling of ${limit.toLocaleString()} — PostgreSQL has no unsigned escape hatch, so the whole range is what there is.`,
      {
        why: 'At the ceiling every INSERT fails on a column nobody inserts into. Widening to bigint afterwards is a full table rewrite, planned under incident pressure instead of at leisure.',
        fix: `ALTER TABLE ${quoteIdent(t.name, 'postgres')} ALTER COLUMN ${quoteIdent(col.name, 'postgres')} TYPE bigint;`,
        evidence: [{ source: 'pg_sequences.last_value', value: t.autoIncrement.toLocaleString() }],
        ruleRef: 'rulebook §1 integers (PostgreSQL)',
        confidence: 'certain',
      });
  }
}

// ── §2 strings, §6 numbers ──────────────────────────────────────────────────

function columnShapeRules(ctx: Ctx): void {
  const pg = ctx.snap.engine === 'postgres';
  const indexedCols = new Map<string, IndexColumn>();
  for (const idx of ctx.snap.indexes) {
    for (const ic of idx.columns) indexedCols.set(`${idx.table}.${ic.name}`, ic);
  }

  for (const c of ctx.snap.columns) {
    const table = ctx.byTable.get(c.table);
    const rows = table?.rows ?? 0;
    const dt = c.dataType.toLowerCase();

    // An index entry reserves the *declared* width, not the stored length.
    // InnoDB-only reasoning: on PostgreSQL a varchar limit is a CHECK, not a
    // reservation, so the rule would be confident and wrong there.
    if (!pg && (dt === 'varchar' || dt === 'char')) {
      const ic = indexedCols.get(`${c.table}.${c.name}`);
      if (ic && rows >= SMALL_TABLE_ROWS) {
        const bytes = indexEntryBytes(c, ic.subPart);
        if (bytes >= 400) {
          push(ctx, 'STR1', bytes >= 1000 ? 'orange' : 'yellow',
            `${c.table}.${c.name} is indexed and ${bytes} bytes wide`,
            `\`${c.columnType}\`${c.charset ? ` in ${c.charset}` : ''} reserves ${bytes} bytes per index entry`
            + `${ic.subPart ? ` (prefix ${ic.subPart})` : ''} across ~${rows.toLocaleString()} rows.`,
            {
              why: 'An index entry reserves the declared width whatever the data is, so an oversized VARCHAR inflates the index, halves how much of it fits in the buffer pool, and is the usual reason a "small" index is hundreds of megabytes.',
              evidence: statsEvidence(ctx, `${rows.toLocaleString()} rows`),
              ruleRef: 'rulebook §2 strings',
              confidence: 'certain',
            });
        }
      }
    }

    // Money through a binary float. The error is small, silent, and permanent.
    if ((dt === 'float' || dt === 'double') && MONEY_NAME.test(c.name)) {
      push(ctx, 'NUM1', 'red',
        `${c.table}.${c.name} stores money as ${c.dataType.toUpperCase()}`,
        `Binary floating point cannot represent 0.10 exactly, so sums drift and comparisons fail unpredictably.`,
        {
          why: 'Nothing errors. The totals are simply wrong, by amounts too small to notice until an audit adds them up.',
          fix: pg
            ? `ALTER TABLE ${quoteIdent(c.table, 'postgres')} ALTER COLUMN ${quoteIdent(c.name, 'postgres')} TYPE numeric(14,2);`
            : `ALTER TABLE ${mq(c.table)} MODIFY ${mq(c.name)} DECIMAL(14,2)${c.nullable ? '' : ' NOT NULL'};`,
          ruleRef: 'rulebook §6 numbers',
          confidence: 'inferred',
        });
    }

    // A date in a string is a date nothing can validate, sort correctly or
    // range-scan.
    if ((dt === 'varchar' || dt === 'char' || dt === 'int' || dt === 'bigint')
        && /(^|_)(date|time|datetime|timestamp|at)$/i.test(c.name)
        && !/(_id|count|num)$/i.test(c.name)) {
      push(ctx, 'TIME4', 'yellow',
        `${c.table}.${c.name} looks like a time stored as ${c.columnType}`,
        'A temporal value in a string or integer cannot be validated, compared across time zones, or range-scanned with an index the planner understands.',
        { ruleRef: 'rulebook §5 time', confidence: 'inferred' });
    }

    // TIMESTAMP runs out in 2038. That is inside the lifetime of most of the
    // schemas it is in. (MySQL only — a PG `timestamp` is good to ±294,000
    // years; its real hazard is the missing time zone, ruled on below.)
    if (!pg && dt === 'timestamp') {
      push(ctx, 'TIME1', 'yellow',
        `${c.table}.${c.name} is a TIMESTAMP (2038 ceiling)`,
        'TIMESTAMP cannot represent a date after 2038-01-19. DATETIME can.',
        {
          why: 'Any column holding a future date — a contract end, a retention date, an expiry — hits this long before 2038 does.',
          ruleRef: 'rulebook §5 time',
          confidence: 'certain',
        });
    }

    // A closed set declared as free text. The comment usually admits it.
    if (dt === 'varchar' && /\b(one of|values?:|allowed:|possible:)\b/i.test(c.comment)) {
      push(ctx, 'ENUM1', 'orange',
        `${c.table}.${c.name} is VARCHAR but its COMMENT enumerates the values`,
        `Comment: "${c.comment.replace(/\s+/g, ' ').slice(0, 120)}".`,
        {
          why: 'The set is enforced by convention only, so every typo becomes a new member and every consumer needs its own list.',
          ruleRef: 'rulebook §4 closed value sets',
          confidence: 'inferred',
        });
    }
  }
}

/**
 * §5/§6 for PostgreSQL — the type judgements that are PG's own, not MySQL's
 * re-labelled. PG has no unsigned/charset/2038 problems; it has these.
 */
function pgColumnRules(ctx: Ctx): void {
  for (const c of ctx.snap.columns) {
    const dt = c.dataType.toLowerCase();
    const q = quoteIdent(c.name, 'postgres');

    // The classic: a wall-clock timestamp pretending to be a point in time.
    // `timestamp without time zone` stores no zone, so the same value is a
    // different instant in every session whose TimeZone differs — and a DST
    // fold makes some wall clocks name two instants, or none.
    if (dt === 'timestamp') {
      push(ctx, 'TIME2', 'yellow',
        `${c.table}.${c.name} is timestamp without time zone`,
        'The value stored is a wall clock with no zone attached; what instant it means depends on the TimeZone of whoever reads it.',
        {
          why: 'timestamptz stores one unambiguous instant and renders it per session; timestamp stores "whatever was typed" and every cross-zone consumer — a replica, a report server, a developer laptop — can silently read a different time.',
          fix: `ALTER TABLE ${quoteIdent(c.table, 'postgres')} ALTER COLUMN ${q} TYPE timestamptz USING ${q} AT TIME ZONE 'UTC';`,
          ruleRef: 'rulebook §5 time (PostgreSQL)',
          confidence: 'certain',
        });
    }

    // `money`: fixed scale and currency-aware output taken from lc_monetary,
    // so a dump restored into a different locale reads back different text.
    if (dt === 'money') {
      push(ctx, 'NUM2', 'orange',
        `${c.table}.${c.name} uses the money type`,
        'money formats and parses through the server locale (lc_monetary) and its scale is fixed by that locale — the same value dumps and restores differently across environments.',
        {
          why: 'numeric(14,2) stores the same thing with an explicit scale and locale-independent text. The money type survives for backwards compatibility; the PG documentation itself advises against it.',
          fix: `ALTER TABLE ${quoteIdent(c.table, 'postgres')} ALTER COLUMN ${q} TYPE numeric(14,2) USING ${q}::numeric(14,2);`,
          ruleRef: 'rulebook §6 numbers (PostgreSQL)',
          confidence: 'certain',
        });
    }

    // `serial` is the pre-identity spelling: an invisible sequence owned
    // through a DEFAULT, with its own separate GRANT story. PG 10+ identity
    // columns are the SQL-standard form and fix the privileges surprise.
    if (/\bserial\b/i.test(c.extra)) {
      push(ctx, 'TYP1', 'yellow',
        `${c.table}.${c.name} is a serial, not an identity column`,
        'serial creates a hidden sequence reached through the column DEFAULT — owned implicitly, granted separately (a user with INSERT still needs USAGE on the sequence), and invisible to the SQL standard.',
        {
          why: 'GENERATED … AS IDENTITY ties the sequence to the column properly: it follows RENAME, is dropped with the column, and needs no separate grant. New tables should use it; this one only migrates when it is next touched.',
          ruleRef: 'rulebook §1 integers (PostgreSQL)',
          confidence: 'certain',
        });
    }

    // char(n) pads with blanks to the declared width and compares
    // blank-padded — almost always varchar/text was meant.
    if (dt === 'char' && c.charMaxLen != null) {
      push(ctx, 'TYP2', 'yellow',
        `${c.table}.${c.name} is char(${c.charMaxLen}) — blank-padded`,
        `Every value is stored padded to ${c.charMaxLen} characters and compared ignoring trailing blanks, so 'AB' equals 'AB  ' and LIKE patterns surprise.`,
        {
          why: 'Blank-padding is the SQL-92 semantics almost nobody intends; character varying stores what was written and compares what is there.',
          fix: `ALTER TABLE ${quoteIdent(c.table, 'postgres')} ALTER COLUMN ${q} TYPE varchar(${c.charMaxLen}) USING rtrim(${q});`,
          ruleRef: 'rulebook §2 strings (PostgreSQL)',
          confidence: 'certain',
        });
    }

    // The MySQL reflex, spotted on PG: varchar(255) exactly. On PG the limit
    // reserves nothing and speeds nothing up — it is a CHECK constraint
    // wearing a type's clothes.
    if (dt === 'varchar' && c.charMaxLen === 255) {
      push(ctx, 'TYP3', 'info',
        `${c.table}.${c.name} is varchar(255) — the reflex width`,
        'On PostgreSQL a varchar limit buys no storage and no speed (unlike MySQL index entries); 255 is the carried-over reflex. If the limit is real, text plus an explicit CHECK says so; if not, text alone.',
        { ruleRef: 'rulebook §2 strings (PostgreSQL)', confidence: 'inferred' });
    }

    // JSON stored as text: no validation, no operators, no jsonb indexes.
    if (dt === 'text' && /(^|_)jsons?$/i.test(c.name)) {
      push(ctx, 'TYP4', 'info',
        `${c.table}.${c.name} is text but named like JSON`,
        'A text column named *_json validates nothing and answers no jsonb operator or GIN index. If it holds JSON, jsonb (or json where key order/duplicates matter) is the type.',
        { ruleRef: 'rulebook §2 strings (PostgreSQL)', confidence: 'inferred' });
    }
  }
}

// ── §3 charset and collation, at all four levels ────────────────────────────

/**
 * The target collation for this schema.
 *
 * The schema default when it is a full-Unicode one, otherwise the most common
 * among the tables, otherwise `utf8mb4_0900_ai_ci`. Deliberately not "whatever
 * the server says": the server default is frequently the one nobody chose.
 */
export function targetCollation(snap: SchemaSnapshot): string {
  if (snap.schemaCollation?.startsWith('utf8mb4')) return snap.schemaCollation;
  const counts = new Map<string, number>();
  for (const t of snap.tables) {
    if (!t.collation) continue;
    counts.set(t.collation, (counts.get(t.collation) ?? 0) + 1);
  }
  let best: string | null = null, bestN = 0;
  for (const [c, n] of counts) {
    if (c.startsWith('utf8mb4') && (n > bestN || (n === bestN && best !== null && c < best))) {
      best = c; bestN = n;
    }
  }
  return best ?? 'utf8mb4_0900_ai_ci';
}

function collationRules(ctx: Ctx): void {
  // MySQL's four-level charset/collation chain has no PostgreSQL counterpart:
  // a PG database has one encoding and per-column collations, none of which
  // reserve bytes or coerce silently the way utf8mb3/utf8mb4 mixing does.
  if (ctx.snap.engine === 'postgres') return;
  const snap = ctx.snap;
  const target = targetCollation(snap);

  // A bare `CHARSET=` resolves differently per environment when the server and
  // the schema disagree — so the same DDL produces two different schemas.
  if (snap.serverCollation && snap.schemaCollation && snap.serverCollation !== snap.schemaCollation) {
    push(ctx, 'CHR5', 'yellow',
      `Server and schema defaults differ (${snap.serverCollation} vs ${snap.schemaCollation})`,
      `A CREATE TABLE without an explicit COLLATE resolves to the schema default here, and to the server default somewhere else.`,
      {
        why: 'The same migration applied to two environments produces two different collations, and the difference only surfaces as an unusable index on a join between them.',
        ruleRef: 'rulebook §3 charset and collation',
        confidence: 'certain',
      });
  }

  if (snap.schemaCollation && snap.schemaCollation !== target) {
    push(ctx, 'CHR4', 'orange',
      `Schema default collation is ${snap.schemaCollation}, not ${target}`,
      'Every table created without an explicit COLLATE inherits this.',
      {
        fix: `ALTER DATABASE ${mq(snap.schema)} CHARACTER SET utf8mb4 COLLATE ${target};`,
        ruleRef: 'rulebook §3 charset and collation',
        confidence: 'certain',
      });
  }

  // One aggregate finding, not one per table — and it carries the price,
  // because unification is a rebuild per table.
  const deviating = snap.tables.filter(t => t.collation && t.collation !== target);
  if (deviating.length) {
    const bytes = deviating.reduce((n, t) => n + (t.dataBytes ?? 0) + (t.indexBytes ?? 0), 0);
    const largest = Math.max(...deviating.map(t => (t.dataBytes ?? 0) + (t.indexBytes ?? 0)));
    push(ctx, 'CHR13', 'orange',
      `${deviating.length} table${deviating.length === 1 ? '' : 's'} do not use ${target}`,
      `${deviating.slice(0, 8).map(t => `\`${t.name}\` (${t.collation})`).join(', ')}`
      + `${deviating.length > 8 ? `, and ${deviating.length - 8} more` : ''}.`,
      {
        why: 'A comparison across two collations coerces one side and its index stops being usable — the slowest kind of bug, because nothing reports it.',
        fix: deviating
          .slice()
          .sort((a, b) => ((a.dataBytes ?? 0) + (a.indexBytes ?? 0)) - ((b.dataBytes ?? 0) + (b.indexBytes ?? 0)))
          .slice(0, 10)
          .map(t => `ALTER TABLE ${mq(t.name)} CONVERT TO CHARACTER SET utf8mb4 COLLATE ${target};`)
          .join('\n'),
        cost: { bytes, rows: undefined },
        evidence: [
          { source: ctx.snap.statsSource ?? 'information_schema', value: `${fmtBytes(bytes)} to convert`, age: ctx.snap.statsAge },
          { source: 'rebuild model', value: `peak free disk ≈ ${fmtBytes(largest)} (largest single table)`, modelled: true },
        ],
        ruleRef: 'rulebook §3 charset and collation',
        confidence: 'certain',
      });
  }

  // A column that overrides its table, and a case-insensitive collation on
  // something a machine compares exactly.
  for (const c of ctx.snap.columns) {
    const t = ctx.byTable.get(c.table);
    if (c.collation && t?.collation && c.collation !== t.collation) {
      push(ctx, 'CHR14', 'yellow',
        `${c.table}.${c.name} overrides its table's collation`,
        `Column is ${c.collation}; the table is ${t.collation}.`,
        {
          why: 'Every join or comparison against a column of the table collation coerces one side, and the coerced side loses its index.',
          ruleRef: 'rulebook §3 charset and collation',
          confidence: 'certain',
        });
    }
    if (c.collation?.endsWith('_ci') && IDENTIFIER_NAME.test(c.name)) {
      push(ctx, 'CHR20', 'orange',
        `${c.table}.${c.name} is case-insensitive but holds a machine identifier`,
        `Collation ${c.collation} makes \`ABC\` equal to \`abc\`.`,
        {
          why: 'Two identifiers that differ only in case collide: a UNIQUE constraint rejects the second one, and a lookup returns the wrong row. Nothing about that is visible in the schema.',
          fix: `ALTER TABLE ${mq(c.table)} MODIFY ${mq(c.name)} ${c.columnType} COLLATE utf8mb4_0900_as_cs${c.nullable ? '' : ' NOT NULL'};`,
          ruleRef: 'rulebook §3 charset and collation',
          confidence: 'inferred',
        });
    }
  }
}

// ── §8 keys, §9 indexes, §11 table level ────────────────────────────────────

function keyAndIndexRules(ctx: Ctx): void {
  const pg = ctx.snap.engine === 'postgres';
  for (const t of ctx.snap.tables) {
    const idxs = ctx.idxByTable.get(t.name) ?? [];
    const cols = ctx.colsByTable.get(t.name) ?? [];
    const pk = idxs.find(i => i.name === 'PRIMARY');

    // InnoDB gives a PK-less table a hidden 6-byte one you cannot use, every
    // secondary index points at it, and row-based replication has to match
    // rows by scanning. PostgreSQL adds no hidden key at all — the cost lands
    // on logical replication and on anyone trying to identify a row.
    if (!pk && cols.length > 0) {
      push(ctx, 'KEY1', 'red',
        `${t.name} has no PRIMARY KEY`,
        `${(t.rows ?? 0).toLocaleString()} rows.`,
        {
          why: pg
            ? 'A table without a PK has no REPLICA IDENTITY for logical replication — UPDATE/DELETE cannot be decoded for subscribers without falling back to REPLICA IDENTITY FULL (every row change ships the whole before-image) — and no row can be addressed, deduplicated or ON CONFLICT-targeted.'
            : 'InnoDB adds an invisible clustered key you cannot reference; row-based replication falls back to a full scan per changed row, and an UPDATE of 1,000 rows on a replica becomes 1,000 table scans.',
          evidence: statsEvidence(ctx, `${(t.rows ?? 0).toLocaleString()} rows`),
          ruleRef: 'rulebook §8 keys',
          confidence: 'certain',
        });
    }

    // Every secondary index carries the PK, so a wide one is paid for again
    // in every index on the table. (InnoDB-only: a PG index entry points at
    // the heap ctid and never stores the PK, so wide PKs cost nothing there.)
    if (!pg && pk && pk.columns.length) {
      const pkCols = pk.columns.map(pc => cols.find(c => c.name === pc.name)).filter(Boolean) as CatalogColumn[];
      const pkBytes = pkCols.reduce((n, c) => n + (isInteger(c) ? 8 : indexEntryBytes(c, null) || 16), 0);
      if (pkBytes > 40 && (t.rows ?? 0) >= SMALL_TABLE_ROWS && idxs.length > 1) {
        push(ctx, 'KEY2', 'yellow',
          `${t.name} has a ${pkBytes}-byte PRIMARY KEY and ${idxs.length - 1} secondary index${idxs.length === 2 ? '' : 'es'}`,
          `PK: ${pk.columns.map(c => c.name).join(', ')}.`,
          {
            why: 'Every secondary index stores the whole primary key as its row pointer, so a wide PK is paid for once per index per row.',
            ruleRef: 'rulebook §8 keys',
            confidence: 'certain',
          });
      }
    }

    // Redundant index: one whose columns are a leading prefix of another's.
    // The prefix is already served by the longer index and costs writes.
    for (const a of idxs) {
      if (a.name === 'PRIMARY' || a.type !== 'BTREE') continue;
      for (const b of idxs) {
        if (a === b || b.type !== 'BTREE') continue;
        if (a.columns.length >= b.columns.length) continue;
        const isPrefix = a.columns.every((c, i) => b.columns[i]?.name === c.name);
        // A UNIQUE index is a constraint, not only an access path, so it is
        // never redundant even when its columns are a prefix.
        if (isPrefix && !a.unique) {
          push(ctx, 'IDX1', 'yellow',
            `${t.name}.${a.name} is redundant — it is a prefix of ${b.name}`,
            `\`${a.name}\` (${a.columns.map(c => c.name).join(', ')}) ⊂ \`${b.name}\` (${b.columns.map(c => c.name).join(', ')}).`,
            {
              why: 'The longer index already answers every query the shorter one does. The shorter one is pure write cost and buffer-pool space.',
              fix: pg
                ? `DROP INDEX ${quoteIdent(a.name, 'postgres')};`
                : `ALTER TABLE ${mq(t.name)} DROP INDEX ${mq(a.name)};`,
              ruleRef: 'rulebook §9 indexes',
              confidence: 'certain',
            });
          break;
        }
      }
    }

    // An index MySQL named, because nobody did. (PG's own convention —
    // `tbl_col_idx` — is at least self-describing, so there is no PG twin.)
    if (!pg) {
      for (const i of idxs) {
        if (i.name === 'PRIMARY') continue;
        const lead = i.columns[0]?.name;
        if (lead && (i.name === lead || new RegExp(`^${lead}_\\d+$`).test(i.name))) {
          push(ctx, 'IDX50', 'info',
            `${t.name}.${i.name} has an auto-generated name`,
            'MySQL names an unnamed index after its first column (`col`, `col_2`), which says nothing about what it is for.',
            { ruleRef: 'rulebook §9 indexes', confidence: 'certain' });
        }
      }
    }

    // Indexes outweighing the data they index.
    if ((t.dataBytes ?? 0) > 64 * 1024 * 1024 && (t.indexBytes ?? 0) > (t.dataBytes ?? 0)) {
      push(ctx, 'IDX80', 'yellow',
        `${t.name} carries more index than data`,
        `${fmtBytes(t.indexBytes ?? 0)} of indexes over ${fmtBytes(t.dataBytes ?? 0)} of rows, across ${idxs.length} indexes.`,
        {
          evidence: statsEvidence(ctx, `data ${fmtBytes(t.dataBytes ?? 0)} · indexes ${fmtBytes(t.indexBytes ?? 0)}`),
          ruleRef: 'rulebook §9 indexes',
          confidence: 'certain',
        });
    }

    // A storage engine with no transactions, no crash recovery and table locks.
    // (MySQL-only judgement; the PG persistence hazard is TBL2 below.)
    if (!pg && t.engine && !/innodb|rocksdb/i.test(t.engine) && !/memory|csv/i.test(t.engine)) {
      push(ctx, 'TBL1', 'orange',
        `${t.name} uses the ${t.engine} storage engine`,
        'No transactions, no crash recovery, and writes take a table lock.',
        {
          fix: `ALTER TABLE ${mq(t.name)} ENGINE=InnoDB;`,
          ruleRef: 'rulebook §11 table level',
          confidence: 'certain',
        });
    }

    // UNLOGGED: no WAL, so a crash truncates the table and streaming/logical
    // replicas never see its rows. Legitimate for caches and staging; a
    // defect anywhere data is expected to survive.
    if (pg && t.engine === 'unlogged') {
      push(ctx, 'TBL2', 'orange',
        `${t.name} is UNLOGGED`,
        `${(t.rows ?? 0).toLocaleString()} rows with no WAL: an unclean shutdown truncates the table to zero, and standbys never receive its contents.`,
        {
          why: 'Unlogged is the right call for derived, rebuildable data and the wrong one for anything else — and nothing about the table, once created, says which was intended.',
          fix: `ALTER TABLE ${quoteIdent(t.name, 'postgres')} SET LOGGED;`,
          evidence: statsEvidence(ctx, `${(t.rows ?? 0).toLocaleString()} rows`),
          ruleRef: 'rulebook §11 table level (PostgreSQL)',
          confidence: 'certain',
        });
    }
  }

  // A UNIQUE index over a nullable column does not do what its name says:
  // both engines allow any number of rows where the column is NULL.
  for (const idx of ctx.snap.indexes) {
    if (!idx.unique || idx.name === 'PRIMARY') continue;
    const cols = ctx.colsByTable.get(idx.table) ?? [];
    const nullable = idx.columns
      .map(ic => cols.find(c => c.name === ic.name))
      .filter((c): c is CatalogColumn => !!c && c.nullable);
    if (nullable.length) {
      push(ctx, 'KEY3', 'orange',
        `${idx.table}.${idx.name} is UNIQUE over nullable column${nullable.length === 1 ? '' : 's'}`,
        `Nullable: ${nullable.map(c => c.name).join(', ')}.`,
        {
          why: pg
            ? 'PostgreSQL treats NULLs as distinct (unless the index was declared NULLS NOT DISTINCT, 15+), so the constraint permits unlimited rows whose value is NULL — the duplicates it exists to prevent are exactly the ones it allows.'
            : 'MySQL treats NULLs as distinct, so the constraint permits unlimited rows whose value is NULL — the duplicates it exists to prevent are exactly the ones it allows.',
          ruleRef: 'rulebook §8 keys',
          confidence: 'certain',
        });
    }
  }
}

// ── references: declared, and same-named across the schema ──────────────────

/** Two column types are join-compatible only if all of this matches. */
export function typeMismatch(child: CatalogColumn, parent: CatalogColumn): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm(child.dataType) !== norm(parent.dataType)) {
    return `type differs — ${child.columnType} vs ${parent.columnType}`;
  }
  if (isInteger(child) && isUnsigned(child) !== isUnsigned(parent)) {
    return `signedness differs — ${child.columnType} vs ${parent.columnType}`;
  }
  if ((child.collation ?? null) !== (parent.collation ?? null)) {
    return `collation differs — ${child.collation ?? 'none'} vs ${parent.collation ?? 'none'}`;
  }
  if ((child.charMaxLen ?? 0) !== (parent.charMaxLen ?? 0)) {
    return `declared width differs — ${child.columnType} vs ${parent.columnType}`;
  }
  return null;
}

function referenceRules(ctx: Ctx): void {
  const pg = ctx.snap.engine === 'postgres';
  const col = (table: string, name: string) =>
    (ctx.colsByTable.get(table) ?? []).find(c => c.name === name);

  // Declared foreign keys whose two sides do not match. MySQL will not even
  // create such a key — so when this fires, the FK predates the change that
  // broke it, or one side was altered around it. MySQL-only: PG's coercion
  // rules keep index access across the int-width and varchar-width pairs this
  // check compares, so the "the index dies" reasoning does not translate, and
  // a red finding that is wrong about the consequence is worse than none.
  if (!pg) {
    for (const fk of ctx.snap.foreignKeys) {
      const c = col(fk.table, fk.column);
      const p = col(fk.refTable, fk.refColumn);
      if (!c || !p) continue;
      const problem = typeMismatch(c, p);
      if (problem) {
        push(ctx, 'REF1', 'red',
          `${fk.table}.${fk.column} does not match ${fk.refTable}.${fk.refColumn} — ${problem}`,
          `Declared by foreign key \`${fk.name}\`.`,
          {
            why: 'The comparison is resolved by coercion, so the index on the coerced side becomes unusable — every join and every referential check degrades to a scan, silently.',
            ruleRef: 'rulebook §8 keys',
            confidence: 'certain',
          });
      }
    }
  }

  // Columns that share a name across tables get joined sooner or later, so
  // they have to agree. Vague names are excluded — see VAGUE_COLUMN_NAMES.
  const byName = new Map<string, CatalogColumn[]>();
  for (const c of ctx.snap.columns) {
    if (!isReferenceName(c.name)) continue;
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }

  for (const [name, cols] of byName) {
    if (cols.length < 2) continue;
    const shapes = new Map<string, CatalogColumn[]>();
    for (const c of cols) {
      const key = `${c.columnType}|${c.collation ?? ''}`;
      const list = shapes.get(key) ?? [];
      list.push(c);
      shapes.set(key, list);
    }
    if (shapes.size < 2) continue;

    // The rulebook outranks the majority: UNSIGNED beats signed, and among
    // integers the narrower declaration wins, whichever has more columns.
    const variants = [...shapes.entries()].sort((a, b) => b[1].length - a[1].length);
    const recommended = pickRecommended(variants.map(v => v[1][0]));
    push(ctx, 'REF50', pg ? 'yellow' : 'orange',
      `\`${name}\` is declared ${shapes.size} different ways across ${cols.length} tables`,
      variants
        .map(([, list]) => `\`${list[0].columnType}\`${list[0].collation ? ` ${list[0].collation}` : ''} — ${list.length}×: `
          + list.slice(0, 5).map(c => c.table).join(', ') + (list.length > 5 ? `, +${list.length - 5}` : ''))
        .join('\n\n'),
      {
        why: pg
          ? 'PostgreSQL joins across these shapes without losing index access, so nothing breaks today — but the same concept declared two ways means every consumer guesses which shape it gets, and the narrowest declaration is where the overflow eventually happens.'
          : 'Columns that share a name get joined eventually, and a join across two declarations coerces one side — losing its index with no error and no warning.',
        ruleRef: 'rulebook §1 integers, §2 strings, §3 collation',
        confidence: 'certain',
        fix: recommended
          ? `-- align on ${recommended.columnType}${recommended.collation ? ` ${recommended.collation}` : ''}`
          : undefined,
      });
  }
}

/**
 * The PostgreSQL foreign-key rules — both about what PG does NOT do where
 * InnoDB would: it does not re-validate a NOT VALID constraint, and it does
 * not index the child side of a FK.
 */
function pgForeignKeyRules(ctx: Ctx): void {
  // Group the per-column rows back into whole constraints.
  const byConstraint = new Map<string, CatalogFk[]>();
  for (const fk of ctx.snap.foreignKeys) {
    const key = `${fk.table}.${fk.name}`;
    const list = byConstraint.get(key) ?? [];
    list.push(fk);
    byConstraint.set(key, list);
  }

  for (const [key, cols] of byConstraint) {
    const fk = cols[0];

    // NOT VALID: existing rows were never checked, and the planner ignores
    // the constraint — it is documentation that checks new writes only.
    if (fk.validated === false) {
      push(ctx, 'FKV1', 'yellow',
        `${fk.table}: foreign key ${fk.name} is NOT VALID`,
        `References ${fk.refTable}. New and updated rows are checked, but the existing rows were never verified — the constraint's name promises something that has never been proven.`,
        {
          why: 'A NOT VALID constraint is how a migration added a FK without locking the table — fine as a transition, a defect as a resting state: half the table may violate the rule the name promises.',
          fix: `ALTER TABLE ${quoteIdent(fk.table, 'postgres')} VALIDATE CONSTRAINT ${quoteIdent(fk.name, 'postgres')};`,
          ruleRef: 'rulebook §8 keys (PostgreSQL)',
          confidence: 'certain',
        });
    }

    // InnoDB auto-creates (or requires) a child-side index; PostgreSQL
    // creates nothing. Every parent UPDATE/DELETE then probes the child with
    // a scan, and the probe takes locks while it scans.
    const fkCols = cols.slice().sort((a, b) => a.ordinal - b.ordinal).map(c => c.column);
    const supported = (ctx.idxByTable.get(fk.table) ?? []).some(ix =>
      ix.columns.length >= fkCols.length
      && fkCols.every((c, i) => ix.columns[i]?.name === c));
    if (!supported) {
      push(ctx, 'FKS1', 'orange',
        `${key} has no index on (${fkCols.join(', ')})`,
        `PostgreSQL does not index the child side of a foreign key. Every DELETE or key UPDATE on ${fk.refTable} probes ${fk.table} with a sequential scan while holding locks on it.`,
        {
          why: 'The cost lands on the parent table\'s writes, far from the missing index, and grows with the child table — the classic "deleting one customer locks the database" incident.',
          fix: `CREATE INDEX ON ${quoteIdent(fk.table, 'postgres')} (${fkCols.map(c => quoteIdent(c, 'postgres')).join(', ')});`,
          ruleRef: 'rulebook §8 keys (PostgreSQL)',
          confidence: 'certain',
        });
    }
  }
}

/**
 * Which declaration the others should be aligned to.
 *
 * Not a vote. UNSIGNED beats signed (§1) and narrower beats wider (§2, because
 * widening is a metadata-only ALTER and shrinking is a full copy), so a schema
 * whose majority is the legacy mistake is told to fix the majority.
 */
export function pickRecommended(variants: CatalogColumn[]): CatalogColumn | null {
  if (variants.length === 0) return null;
  return variants.slice().sort((a, b) => {
    const au = isUnsigned(a) ? 0 : 1, bu = isUnsigned(b) ? 0 : 1;
    if (au !== bu) return au - bu;
    const aw = a.charMaxLen ?? 0, bw = b.charMaxLen ?? 0;
    if (aw !== bw) return aw - bw;
    return a.columnType.localeCompare(b.columnType);
  })[0];
}

// ── § naming: reserved words, today and after the next upgrade ──────────────

/**
 * The live-schema twin of the CREATE TABLE lint: names that already exist and
 * collide with a reserved word. The grade depends on the server version and
 * the word's reservation window (MYSQL_RESERVED_WINDOWS, verified against the
 * MySQL manual's per-version keyword tables, 9.0 through 26.7):
 *
 *  - **reserved on this server** — the object only exists because its DDL
 *    quoted the name, and every ad-hoc query, ORM and dump must keep quoting
 *    it forever.
 *  - **reserved in a later MySQL** — legal bare today, a syntax error the day
 *    the upgrade lands. Found now, renamed at leisure; found by the upgrade,
 *    renamed under pressure.
 *  - **reservation already lifted** (MANUAL/PARALLEL on ≥ 9.7.2) — not a
 *    finding at all.
 *
 * MariaDB never took the 8.0+ reservations, so on a MariaDB version string
 * the windowed words are not flagged at all.
 *
 * On PostgreSQL there are no per-version reservation windows — the keyword
 * table is stable in the ways that matter here — so the grade is PG's own
 * strictness (PG_RESERVED_WORDS, the manual's "reserved" category):
 *
 *  - **reserved on PostgreSQL** — the object exists only because its DDL
 *    double-quoted it, and every query must keep quoting it forever: orange.
 *  - **in the MySQL ∪ PG union only** — legal bare here (a MySQL-only
 *    reservation, or a PG keyword from a weaker category): yellow, because
 *    the name still collides on the other engine and in cross-engine tooling.
 */
function namingRules(ctx: Ctx): void {
  if (ctx.snap.engine === 'postgres') return pgNamingRules(ctx);
  const version = ctx.snap.serverVersion ?? '';
  const maria = /mariadb/i.test(version);
  const vm = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  type V = [number, number, number];
  const ver: V | null = vm ? [+vm[1], +vm[2], +(vm[3] ?? 0)] : null;
  const rel = (r: string): V => { const p = r.split('.').map(Number); return [p[0], p[1] ?? 0, p[2] ?? 0]; };
  const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  const check = (kind: 'table' | 'column', table: string, name: string): void => {
    const w = name.toLowerCase();
    if (!RESERVED_WORDS.has(w)) return;
    const win = MYSQL_RESERVED_WINDOWS[w];
    if (win && maria) return; // not reserved on MariaDB
    const label = kind === 'table' ? `\`${name}\`` : `${table}.\`${name}\``;

    if (win && ver) {
      const since = rel(win.since);
      if (cmp(ver, since) < 0) {
        // Not reserved yet on this server — the upgrade blocker.
        push(ctx, 'NAME1', 'yellow',
          `${label} is a ${kind} name that becomes reserved in MySQL ${win.since}`,
          `Legal bare on this ${ver[0]}.${ver[1]} server — a syntax error the moment the MySQL ${win.since} upgrade lands, in every query, view, dump and ORM mapping that does not quote it. Rename it now, at leisure (a domain name: \`${w}_value\`, \`${w}_status\`…).`
          + (win.until ? ` (The reservation is lifted again from MySQL ${win.until}.)` : ''),
          {
            why: 'The upgrade precheck finds this the night before the maintenance window. Renaming now is a quiet ALTER; renaming then is an incident.',
            ruleRef: 'rulebook § naming',
            confidence: 'certain',
          });
        return;
      }
      if (win.until && cmp(ver, rel(win.until)) >= 0) return; // lifted again — nothing to say
    }
    push(ctx, 'NAME1', 'orange',
      `${label} is a ${kind} name that is a reserved word${win ? ` (reserved since MySQL ${win.since})` : ''}`,
      'It exists only because the DDL quoted it — every hand-written query, ORM mapping, view and dump must remember the backticks forever, and the one that forgets is a syntax error. Rename beats quoting.',
      {
        why: 'Nothing warns at write time. The failure arrives later, in someone else\'s query, as a syntax error pointing at a name that looks perfectly reasonable.',
        ruleRef: 'rulebook § naming',
        confidence: 'certain',
      });
  };

  for (const t of ctx.snap.tables) check('table', t.name, t.name);
  for (const c of ctx.snap.columns) check('column', c.table, c.name);
}

/** The PostgreSQL grading of the same collision scan — see namingRules. */
function pgNamingRules(ctx: Ctx): void {
  const check = (kind: 'table' | 'column', table: string, name: string): void => {
    const w = name.toLowerCase();
    const label = kind === 'table' ? `"${name}"` : `${table}."${name}"`;

    if (PG_RESERVED_WORDS.has(w)) {
      push(ctx, 'NAME1', 'orange',
        `${label} is a ${kind} name that is a reserved word in PostgreSQL`,
        'It exists only because the DDL double-quoted it — every hand-written query, ORM mapping, view and dump must remember the double quotes forever (and get the case exactly right: unquoted identifiers fold to lower case). Rename beats quoting.',
        {
          why: 'Nothing warns at write time. The failure arrives later, in someone else\'s query, as a syntax error pointing at a name that looks perfectly reasonable.',
          ruleRef: 'rulebook § naming',
          confidence: 'certain',
        });
      return;
    }
    if (RESERVED_WORDS.has(w)) {
      push(ctx, 'NAME1', 'yellow',
        `${label} is a ${kind} name that is reserved on MySQL (legal bare here)`,
        `PostgreSQL accepts \`${w}\` unquoted, but the MySQL ∪ PG reserved set rejects it — a cross-engine migration, a federation tool or a future MySQL twin of this schema breaks on the name. A domain name (${w}_value, ${w}_status…) survives both.`,
        {
          why: 'Found now, it is a quiet rename at leisure; found by the migration, it is a syntax-error hunt under pressure.',
          ruleRef: 'rulebook § naming',
          confidence: 'certain',
        });
    }
  };

  for (const t of ctx.snap.tables) check('table', t.name, t.name);
  for (const c of ctx.snap.columns) check('column', c.table, c.name);
}

// ── entry point ─────────────────────────────────────────────────────────────

export interface SchemaReviewResult {
  findings: Finding[];
  /** Counted so the report can say what it looked at, not only what it found. */
  scanned: { tables: number; columns: number; indexes: number; foreignKeys: number };
}

/**
 * Review a schema as it stands.
 *
 * Deterministic and side-effect free: the same snapshot always produces the
 * same findings in the same order, which is what makes a diff between two runs
 * meaningful.
 */
export function reviewSchema(snap: SchemaSnapshot): SchemaReviewResult {
  const ctx: Ctx = {
    snap,
    byTable: new Map(snap.tables.map(t => [t.name, t])),
    colsByTable: new Map(),
    idxByTable: new Map(),
    out: [],
    n: { v: 1 },
  };
  for (const c of snap.columns) {
    const list = ctx.colsByTable.get(c.table) ?? [];
    list.push(c);
    ctx.colsByTable.set(c.table, list);
  }
  for (const i of snap.indexes) {
    const list = ctx.idxByTable.get(i.table) ?? [];
    list.push(i);
    ctx.idxByTable.set(i.table, list);
  }

  integerRules(ctx);
  columnShapeRules(ctx);
  if (snap.engine === 'postgres') {
    pgColumnRules(ctx);
    pgForeignKeyRules(ctx);
  }
  collationRules(ctx);
  keyAndIndexRules(ctx);
  referenceRules(ctx);
  namingRules(ctx);

  // Stable order: severity first, then the id, then the title — so two runs of
  // the same schema produce byte-identical reports.
  const SEV: Record<Severity, number> = { red: 0, orange: 1, yellow: 2, info: 3 };
  ctx.out.sort((a, b) =>
    SEV[a.severity] - SEV[b.severity] || a.id.localeCompare(b.id) || a.title.localeCompare(b.title));

  return {
    findings: ctx.out,
    scanned: {
      tables: snap.tables.length,
      columns: snap.columns.length,
      indexes: snap.indexes.length,
      foreignKeys: snap.foreignKeys.length,
    },
  };
}
