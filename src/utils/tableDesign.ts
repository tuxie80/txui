/**
 * Designing a table, as a *change set* rather than an action.
 *
 * The distinction is the whole safety model. A designer that applies edits as
 * you make them is a designer that alters production because somebody clicked
 * the wrong row. Here, editing a draft produces nothing but a list of proposed
 * changes; each one carries what it costs and what it can destroy; the SQL is
 * shown before anything runs; and the run itself still goes through the
 * server-side production guards (`sqlguard::check_prod_limits`), which refuse
 * destructive DDL on a prod-tagged connection unless it was explicitly
 * unlocked.
 *
 * Two facts drive the risk labels, and both are worse than they look:
 *
 * * **MySQL commits DDL implicitly.** There is no transaction around an
 *   `ALTER`, so "undo" does not exist. A dropped column is gone.
 * * **Several changes rewrite every row.** Changing a type or a charset is not
 *   a metadata edit; on a large table it is an outage. `bulkAlter.ts` already
 *   says this about its own operations and the same is true here.
 *
 * Pure and dependency-free, so `node --test` covers it.
 */
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

export type Engine = 'mysql' | 'postgres' | 'sqlserver';

export interface ColumnDraft {
  name: string;
  /** As typed: `INT`, `VARCHAR(255)`, `NUMERIC(10,2)`. */
  type: string;
  nullable: boolean;
  /** Raw SQL for the default (`0`, `'x'`, `CURRENT_TIMESTAMP`), or null. */
  default: string | null;
  autoIncrement?: boolean;
  comment?: string;
  /** Set when this column already exists under a different name. */
  originalName?: string;
  /**
   * SQL Server only: the name of the existing DEFAULT constraint on this
   * column, as read from `sys.default_constraints`.
   *
   * Needed because a default cannot be changed in place there — the old
   * constraint has to be dropped **by name**, and SQL Server auto-generates
   * names like `DF__orders__qty__3B75D760` that nothing can reconstruct.
   */
  defaultConstraint?: string;
  /**
   * Generated / computed column expression, e.g. `price * qty`. When set, the
   * column is `GENERATED ALWAYS AS (expr)` and DEFAULT / AUTO_INCREMENT do not
   * apply. `generatedStored` picks STORED vs VIRTUAL (PostgreSQL is always
   * STORED — it has no VIRTUAL generated columns).
   */
  generated?: string;
  generatedStored?: boolean;
  /**
   * ClickHouse only: wrap the type in `LowCardinality(…)` — the dictionary
   * encoding for low-cardinality string columns. Rendered outside `Nullable`
   * (`LowCardinality(Nullable(T))` — the reverse nesting is invalid there).
   */
  lowCardinality?: boolean;
  /** ClickHouse only: raw codec list for `CODEC(…)`, e.g. `Delta(4), ZSTD(3)`. */
  codec?: string;
  /**
   * ClickHouse only: what `generated` means — `materialized` computes the
   * expression on insert and stores it; `alias` computes it on read and stores
   * nothing. Ignored by the other dialects.
   */
  chExprKind?: 'materialized' | 'alias';
}

export interface IndexDraft {
  name: string;
  columns: string[];
  unique: boolean;
  /**
   * Hidden from the optimizer but still maintained — the "soft-drop before you
   * really drop" workflow. MySQL 8 spells it INVISIBLE; MariaDB spells it
   * IGNORED. MySQL/MariaDB only.
   */
  invisible?: boolean;
}

export interface ForeignKeyDraft {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface TableDraft {
  name: string;
  originalName?: string;
  columns: ColumnDraft[];
  primaryKey: string[];
  indexes: IndexDraft[];
  foreignKeys: ForeignKeyDraft[];
  comment?: string;
  /** MySQL: the storage engine. ClickHouse: the engine expression (`MergeTree()`). */
  engine?: string;
  charset?: string;
  /** MariaDB only: emit `CREATE OR REPLACE TABLE` (atomic drop-and-recreate). */
  orReplace?: boolean;
  /** MariaDB only: append `WITH SYSTEM VERSIONING` (temporal / history table). */
  systemVersioning?: boolean;
  /**
   * ClickHouse only: raw ORDER BY / PARTITION BY / TTL expressions, written
   * verbatim. ORDER BY is mandatory for the MergeTree family and forbidden
   * for the Log family and Memory. The PRIMARY KEY clause comes from
   * `primaryKey`, as on the other dialects.
   */
  orderBy?: string;
  partitionBy?: string;
  ttl?: string;
  /** SQLite only: STRICT table — column types restricted to the affinity set. */
  strict?: boolean;
  /** SQLite only: WITHOUT ROWID table — the primary key IS the storage. */
  withoutRowid?: boolean;
}

/**
 * The name of a T-SQL default constraint on `table.column`.
 *
 * SQL Server does not have a column-level default the way MySQL and PostgreSQL
 * do: a DEFAULT is a **separate named constraint**, and `ALTER COLUMN … DEFAULT`
 * is a syntax error. Changing one therefore means dropping a constraint by name
 * and adding another — and if the name was auto-generated (`DF__zz_des__qty__3B75D760`)
 * it has to be looked up, because it is not derivable.
 *
 * TxUI names the ones it creates, so its own defaults can always be found
 * again. `currentDefaultConstraint` on the draft carries the existing name when
 * the designer read one from the catalog.
 */
export function defaultConstraintName(table: string, column: string): string {
  return `DF_${table}_${column}`;
}

/** MySQL-family server flavour, for flavour-specific DDL. */
export type Flavor = 'mysql' | 'mariadb' | 'percona';

/**
 * What a change can cost you.
 *
 * `safe` — no data can be lost by doing it.
 * `lossy` — data may be truncated, coerced or rejected. Recoverable only from
 *   a backup.
 * `destructive` — data is deleted outright.
 *
 * Deliberately about *data*, not about duration. A change can be safe and
 * still take an hour; that is what `rebuild` is for.
 */
export type Risk = 'safe' | 'lossy' | 'destructive';

/** How much work the server does — the same vocabulary as `bulkAlter`. */
export type Cost = 'metadata' | 'rebuild';

export type ChangeKind =
  | 'create-table' | 'drop-table' | 'rename-table' | 'change-engine'
  | 'add-column' | 'drop-column' | 'modify-column' | 'rename-column'
  | 'add-index' | 'drop-index' | 'alter-index'
  | 'add-fk' | 'drop-fk'
  | 'add-partition' | 'drop-partition' | 'reorganize-partition'
  | 'table-option' | 'rebuild-table';

export interface SchemaChange {
  kind: ChangeKind;
  /** Column, index or constraint the change is about. */
  subject: string;
  risk: Risk;
  cost: Cost;
  /** Plain-language reason, shown next to the change. Always set when not safe. */
  warning?: string;
  /**
   * Empty when `blocked` is set: the draft requires this change but the
   * dialect cannot express it, so there is deliberately no SQL to run or copy.
   * A blocked change disables Apply — running the rest of the set would apply
   * less than was asked while claiming otherwise.
   */
  sql: string;
  /** Why this change cannot be produced (dialect limitation). */
  blocked?: string;
}

// ── Type comparison ──────────────────────────────────────────────────────────

/** `VARCHAR(255)` → `{ base: 'varchar', args: [255] }`. */
export function parseType(t: string): { base: string; args: number[] } {
  const m = /^\s*([A-Za-z_ ]+?)\s*(?:\(([^)]*)\))?\s*(unsigned)?\s*$/i.exec(t);
  if (!m) return { base: t.trim().toLowerCase(), args: [] };
  // Filter the blanks *before* converting: `''.split(',')` is `['']`, and
  // `Number('')` is 0, so a bare `INT` would otherwise parse as `int(0)` and
  // compare unequal to a genuine `INT` written elsewhere.
  const args = (m[2] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
    .map(Number)
    .filter(n => Number.isFinite(n));
  return { base: m[1].trim().toLowerCase().replace(/\s+/g, ' '), args };
}

/** Integer families, narrowest first — widening within the family is safe. */
const INT_ORDER = ['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'];
const TEXT_ORDER = ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext'];

/**
 * Is changing `from` to `to` guaranteed not to lose data?
 *
 * Conservative on purpose: anything this cannot prove safe is reported as
 * lossy. Being told a safe change might truncate costs a moment's thought;
 * being told a truncating change is safe costs the data.
 */
export function isWidening(from: string, to: string): boolean {
  const a = parseType(from);
  const b = parseType(to);
  if (a.base === b.base) {
    // Same family: every argument must be at least as large. A shorter
    // varchar truncates; fewer decimal places round.
    if (a.args.length !== b.args.length) return b.args.length === 0 ? false : a.args.length === 0;
    return a.args.every((n, i) => b.args[i] >= n);
  }
  const ai = INT_ORDER.indexOf(a.base), bi = INT_ORDER.indexOf(b.base);
  if (ai >= 0 && bi >= 0) return bi >= ai;
  const at = TEXT_ORDER.indexOf(a.base), bt = TEXT_ORDER.indexOf(b.base);
  // char→varchar and up the text ladder is safe; varchar→char is not, since
  // CHAR pads and truncates at its declared length.
  if (at >= 0 && bt >= 0) return bt >= at;
  return false;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function columnClause(c: ColumnDraft, engine: Engine): string {
  const q = (s: string) => quoteIdent(s, engine);
  if (engine === 'sqlserver') return mssqlColumnClause(c, q);
  const parts = [q(c.name), c.type];
  // Generated / computed column. DEFAULT and AUTO_INCREMENT are mutually
  // exclusive with GENERATED, so they are skipped here. PostgreSQL supports
  // only STORED; MySQL/MariaDB support VIRTUAL (default) and STORED.
  if (c.generated && c.generated.trim()) {
    const kind = engine === 'postgres' ? 'STORED' : (c.generatedStored ? 'STORED' : 'VIRTUAL');
    parts.push(`GENERATED ALWAYS AS (${c.generated}) ${kind}`);
    if (!c.nullable) parts.push('NOT NULL');
    if (c.comment && engine === 'mysql') parts.push(`COMMENT ${sqlLiteral(c.comment, engine)}`);
    return parts.join(' ');
  }
  if (!c.nullable) parts.push('NOT NULL');
  if (c.default !== null && c.default !== '') parts.push(`DEFAULT ${c.default}`);
  // AUTO_INCREMENT is MySQL's spelling; on PostgreSQL the type carries it
  // (SERIAL / GENERATED), so emitting a keyword here would be invalid SQL.
  if (c.autoIncrement && engine === 'mysql') parts.push('AUTO_INCREMENT');
  if (c.comment && engine === 'mysql') parts.push(`COMMENT ${sqlLiteral(c.comment, engine)}`);
  return parts.join(' ');
}

/**
 * A T-SQL column definition.
 *
 * Three differences from the shared clause, each of which is a syntax error the
 * other way round:
 *
 * - A **computed column has no type**: `total AS (qty * 2) PERSISTED`. Emitting
 *   the type as well is rejected.
 * - **IDENTITY replaces AUTO_INCREMENT** and is part of the column definition
 *   rather than a trailing keyword — and unlike AUTO_INCREMENT it can never be
 *   added to or removed from an existing column by ALTER at all.
 * - A **DEFAULT is a named constraint**. Inside CREATE TABLE it may be written
 *   inline, and naming it is what makes it findable later: an unnamed default
 *   gets a generated name like `DF__t__col__3B75D760` that nothing can
 *   reconstruct, and changing it then requires a catalog lookup first.
 */
function mssqlColumnClause(c: ColumnDraft, q: (s: string) => string, table?: string): string {
  if (c.generated && c.generated.trim()) {
    // PERSISTED is the analogue of STORED; without it the expression is
    // computed on every read and cannot be indexed.
    const parts = [q(c.name), `AS (${c.generated})`];
    if (c.generatedStored) parts.push('PERSISTED');
    // NOT NULL is only legal on a PERSISTED computed column.
    if (!c.nullable && c.generatedStored) parts.push('NOT NULL');
    return parts.join(' ');
  }
  const parts = [q(c.name), c.type];
  if (c.autoIncrement) parts.push('IDENTITY(1,1)');
  parts.push(c.nullable ? 'NULL' : 'NOT NULL');
  if (c.default !== null && c.default !== '') {
    const name = c.defaultConstraint
      ?? (table ? defaultConstraintName(table, c.name) : undefined);
    parts.push(name
      ? `CONSTRAINT ${q(name)} DEFAULT ${c.default}`
      : `DEFAULT ${c.default}`);
  }
  return parts.join(' ');
}

/** How an index's INVISIBLE/IGNORED clause is spelled for this flavour. */
function invisibleClause(maria: boolean): string {
  return maria ? 'IGNORED' : 'INVISIBLE';
}

export function createTableSql(draft: TableDraft, schema: string, engine: Engine, flavor?: Flavor): string {
  const maria = engine === 'mysql' && flavor === 'mariadb';
  const q = (s: string) => quoteIdent(s, engine);
  if (engine === 'sqlserver') return mssqlCreateTableSql(draft, schema, q);
  const lines = draft.columns.map(c => `  ${columnClause(c, engine)}`);
  if (draft.primaryKey.length) {
    lines.push(`  PRIMARY KEY (${draft.primaryKey.map(q).join(', ')})`);
  }
  for (const i of draft.indexes) {
    const inv = i.invisible ? ` ${invisibleClause(maria)}` : '';
    lines.push(`  ${i.unique ? 'UNIQUE ' : ''}KEY ${q(i.name)} (${i.columns.map(q).join(', ')})${inv}`);
  }
  for (const f of draft.foreignKeys) {
    lines.push(`  CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')})`
      + ` REFERENCES ${q(f.refTable)} (${f.refColumns.map(q).join(', ')})`
      + (f.onDelete ? ` ON DELETE ${f.onDelete}` : '')
      + (f.onUpdate ? ` ON UPDATE ${f.onUpdate}` : ''));
  }
  // PostgreSQL has no inline index syntax in CREATE TABLE, so those become
  // separate statements — handled by the caller through `diffTable`.
  const body = engine === 'postgres'
    ? lines.filter(l => !/^\s{2}(UNIQUE )?KEY /.test(l))
    : lines;
  // MariaDB's CREATE OR REPLACE is an atomic DROP-then-CREATE — a data-losing
  // verb, so it is opt-in and only offered on MariaDB.
  const verb = maria && draft.orReplace ? 'CREATE OR REPLACE TABLE' : 'CREATE TABLE';
  let sql = `${verb} ${q(schema)}.${q(draft.name)} (\n${body.join(',\n')}\n)`;
  if (engine === 'mysql') {
    if (draft.engine) sql += ` ENGINE=${draft.engine}`;
    if (draft.charset) sql += ` DEFAULT CHARSET=${draft.charset}`;
    if (draft.comment) sql += ` COMMENT=${sqlLiteral(draft.comment, engine)}`;
    // System-versioned (temporal) table — MariaDB keeps every historical row.
    if (maria && draft.systemVersioning) sql += ` WITH SYSTEM VERSIONING`;
  }
  return sql;
}

/**
 * A T-SQL `CREATE TABLE`.
 *
 * SQL Server sits between the other two on indexes: unlike PostgreSQL it CAN
 * declare a nonclustered index inline (2014+), so the whole table arrives in one
 * statement, and unlike MySQL the keyword is `INDEX`, never `KEY`.
 *
 * Constraints are named on purpose. An unnamed PRIMARY KEY, UNIQUE or DEFAULT
 * gets a generated name with a hash in it (`PK__zz_des__3213E83F24201A16`), and
 * a generated name cannot be written into a later `DROP CONSTRAINT` — so
 * anything the designer creates unnamed is something the designer cannot change
 * afterwards without a catalog lookup.
 */
function mssqlCreateTableSql(
  draft: TableDraft, schema: string, q: (s: string) => string,
): string {
  const t = draft.name;
  const lines = draft.columns.map(c => `  ${mssqlColumnClause(c, q, t)}`);
  if (draft.primaryKey.length) {
    lines.push(`  CONSTRAINT ${q(`PK_${t}`)} PRIMARY KEY (${draft.primaryKey.map(q).join(', ')})`);
  }
  for (const i of draft.indexes) {
    lines.push(i.unique
      // A UNIQUE index and a UNIQUE constraint are the same structure; the
      // constraint form is named and appears in sys.key_constraints, which is
      // where someone looks for it.
      ? `  CONSTRAINT ${q(i.name)} UNIQUE (${i.columns.map(q).join(', ')})`
      : `  INDEX ${q(i.name)} NONCLUSTERED (${i.columns.map(q).join(', ')})`);
  }
  for (const f of draft.foreignKeys) {
    lines.push(`  CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')})`
      + ` REFERENCES ${mssqlRef(f.refTable, schema, q)} (${f.refColumns.map(q).join(', ')})`
      + (f.onDelete ? ` ON DELETE ${f.onDelete}` : '')
      + (f.onUpdate ? ` ON UPDATE ${f.onUpdate}` : ''));
  }
  return `CREATE TABLE ${q(schema)}.${q(draft.name)} (\n${lines.join(',\n')}\n)`;
}

/**
 * A referenced table, qualified.
 *
 * `refTable` may arrive bare or as `schema.table`; an unqualified name in T-SQL
 * resolves against the *caller's* default schema, not the table's, so it is
 * qualified with the designer's schema rather than left to chance.
 */
function mssqlRef(refTable: string, schema: string, q: (s: string) => string): string {
  return refTable.includes('.')
    ? refTable.split('.').map(q).join('.')
    : `${q(schema)}.${q(refTable)}`;
}

/**
 * The PostgreSQL subcommands for one changed column — only for what changed.
 *
 * Exported for its own tests: getting this wrong is invisible in the UI, since
 * a discarded subcommand produces valid SQL that simply does less than asked.
 */
export function alterColumnParts(
  c: ColumnDraft,
  prev: ColumnDraft,
  q: (s: string) => string,
): string[] {
  const parts: string[] = [];
  if (parseTypeKey(prev.type) !== parseTypeKey(c.type)) {
    parts.push(`ALTER COLUMN ${q(c.name)} TYPE ${c.type}`);
  }
  if (prev.nullable !== c.nullable) {
    parts.push(`ALTER COLUMN ${q(c.name)} ${c.nullable ? 'DROP' : 'SET'} NOT NULL`);
  }
  if ((prev.default ?? '') !== (c.default ?? '')) {
    // A default is a raw expression, not a literal — `now()` must stay a call.
    parts.push(c.default === null || c.default === ''
      ? `ALTER COLUMN ${q(c.name)} DROP DEFAULT`
      : `ALTER COLUMN ${q(c.name)} SET DEFAULT ${c.default}`);
  }
  return parts;
}

// ── The diff ─────────────────────────────────────────────────────────────────

/**
 * Every change needed to turn `current` into `draft`.
 *
 * `current === null` means the table does not exist yet, which produces a
 * single `CREATE TABLE`. Otherwise the order matters: drops last, so a column
 * being replaced is added before its predecessor goes, and a mistake caught
 * mid-review has not already deleted anything.
 */
export function diffTable(
  current: TableDraft | null,
  draft: TableDraft,
  schema: string,
  engine: Engine,
  flavor?: Flavor,
): SchemaChange[] {
  const maria = engine === 'mysql' && flavor === 'mariadb';
  const q = (s: string) => quoteIdent(s, engine);
  const table = `${q(schema)}.${q(draft.originalName ?? draft.name)}`;
  const out: SchemaChange[] = [];

  if (!current) {
    out.push({
      // CREATE OR REPLACE silently drops an existing table first — mark it
      // destructive so the change list flags it like any other data loss.
      kind: 'create-table', subject: draft.name,
      risk: draft.orReplace ? 'destructive' : 'safe', cost: 'metadata',
      sql: createTableSql(draft, schema, engine, flavor),
    });
    if (engine === 'postgres') {
      for (const i of draft.indexes) {
        out.push({
          kind: 'add-index', subject: i.name, risk: 'safe', cost: 'rebuild',
          sql: `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(schema)}.${q(draft.name)}`
            + ` (${i.columns.map(q).join(', ')})`,
        });
      }
    }
    return out;
  }

  // ── Renames first: everything after refers to the new name.
  if (draft.originalName && draft.originalName !== draft.name) {
    out.push({
      kind: 'rename-table', subject: draft.name, risk: 'safe', cost: 'metadata',
      warning: 'Anything referring to the old name — views, code, grants — keeps referring to it.',
      sql: engine === 'mysql'
        ? `RENAME TABLE ${table} TO ${q(schema)}.${q(draft.name)}`
        // T-SQL has no RENAME statement at all — `ALTER TABLE … RENAME TO` is
        // a syntax error. The only way is the stored procedure, whose first
        // argument is a STRING and whose second is the bare new name.
        : engine === 'sqlserver'
        ? `EXEC sp_rename ${sqlLiteral(`${schema}.${draft.originalName}`, engine)}, `
          + `${sqlLiteral(draft.name, engine)}`
        : `ALTER TABLE ${table} RENAME TO ${q(draft.name)}`,
    });
  }

  const byOriginal = new Map(current.columns.map(c => [c.name, c]));
  const keptOriginals = new Set<string>();

  for (const c of draft.columns) {
    const prev = c.originalName ? byOriginal.get(c.originalName) : byOriginal.get(c.name);
    if (!prev) {
      // A new NOT NULL column with no default fails on a non-empty table —
      // the server rejects it rather than inventing values.
      const risky = !c.nullable && (c.default === null || c.default === '');
      out.push({
        kind: 'add-column', subject: c.name,
        risk: risky ? 'lossy' : 'safe',
        cost: 'rebuild',
        warning: risky
          ? 'NOT NULL with no default — the server will refuse this if the table has any rows.'
          : undefined,
        // T-SQL is `ADD <col>`, with no COLUMN keyword — including it is
        // "Incorrect syntax near the keyword 'COLUMN'".
        sql: engine === 'sqlserver'
          ? `ALTER TABLE ${table} ADD ${mssqlColumnClause(c, q, draft.name)}`
          : `ALTER TABLE ${table} ADD COLUMN ${columnClause(c, engine)}`,
      });
      continue;
    }
    keptOriginals.add(prev.name);

    if (c.originalName && c.originalName !== c.name) {
      out.push({
        kind: 'rename-column', subject: c.name, risk: 'safe', cost: 'metadata',
        warning: 'Queries and code using the old column name will break.',
        sql: engine === 'sqlserver'
          // Again sp_rename, with 'COLUMN' as the third argument. The first is
          // the THREE-part `schema.table.column` as a string.
          ? `EXEC sp_rename ${sqlLiteral(
              `${schema}.${draft.originalName ?? draft.name}.${c.originalName}`, engine)}, `
            + `${sqlLiteral(c.name, engine)}, 'COLUMN'`
          : `ALTER TABLE ${table} RENAME COLUMN ${q(c.originalName)} TO ${q(c.name)}`,
      });
    }

    const typeChanged = parseTypeKey(prev.type) !== parseTypeKey(c.type);
    const nullChanged = prev.nullable !== c.nullable;
    const defChanged = (prev.default ?? '') !== (c.default ?? '');
    if (typeChanged || nullChanged || defChanged) {
      const narrowing = typeChanged && !isWidening(prev.type, c.type);
      const tightening = nullChanged && !c.nullable;
      const reasons: string[] = [];
      if (narrowing) {
        reasons.push(`${prev.type} → ${c.type} is not a widening change — values that do not fit`
          + ' are truncated or rejected.');
      }
      if (tightening) {
        reasons.push('NULL → NOT NULL fails if any existing row is NULL.');
      }
      out.push({
        kind: 'modify-column', subject: c.name,
        risk: narrowing || tightening ? 'lossy' : 'safe',
        cost: typeChanged ? 'rebuild' : 'metadata',
        warning: reasons.length ? reasons.join(' ') : undefined,
        // MySQL's MODIFY COLUMN restates the whole definition, so one clause
        // carries every change. PostgreSQL's ALTER COLUMN does not: type,
        // nullability and default are separate subcommands, and emitting only
        // the type would silently discard the other two while rewriting a type
        // the user never touched. They go in one statement so the table is
        // rewritten once and the whole edit is atomic.
        //
        // No `USING` clause: it would turn casts the server rightly refuses
        // into silent truncation — varchar(50) → varchar(10) errors on its own
        // but quietly cuts every value with `USING col::varchar(10)`. When a
        // cast genuinely needs one, PostgreSQL says so and the script can be
        // edited before it runs.
        sql: engine === 'mysql'
          ? `ALTER TABLE ${table} MODIFY COLUMN ${columnClause(c, engine)}`
          : engine === 'sqlserver'
          ? mssqlModifyColumnSql(c, prev, table, draft.originalName ?? draft.name,
                                 typeChanged || nullChanged, defChanged, q, current.columns)
          : `ALTER TABLE ${table} ${alterColumnParts(c, prev, q).join(', ')}`,
      });
    }
  }

  // ── Drops last, so nothing is deleted before the rest has been reviewed.
  //
  // On SQL Server a column drop has to take its dependants with it (see
  // `mssqlDropColumnSql`), so those constraints and indexes are already gone by
  // the time the passes below run. Dropping them a second time is Msg 3728,
  // "'FK_…' is not a constraint" — a script that fails halfway on a statement
  // that was correct the first time.
  const consumedByColumnDrop = new Set<string>();
  for (const prev of current.columns) {
    if (keptOriginals.has(prev.name)) continue;
    out.push({
      kind: 'drop-column', subject: prev.name,
      risk: 'destructive', cost: 'rebuild',
      warning: engine === 'sqlserver'
        ? `Every value in ${prev.name} is deleted. SQL Server also REFUSES the drop while `
          + 'anything depends on the column — a DEFAULT constraint, a computed column, an '
          + 'index or a check — so those are dropped first, above.'
        : `Every value in ${prev.name} is deleted. MySQL commits DDL implicitly — there is `
          + 'no transaction to roll back.',
      sql: engine === 'sqlserver'
        // MySQL and PostgreSQL drop a column's dependants with it. SQL Server
        // REFUSES — Msg 5074, "The object 'FK_…' is dependent on column '…'" —
        // so every default constraint, foreign key and index that names the
        // column has to go first, in this same change. Leaving the user to
        // discover them one error at a time is not a review step, it is a
        // guessing game.
        ? mssqlDropColumnSql(prev, current, table, q)
        : `ALTER TABLE ${table} DROP COLUMN ${q(prev.name)}`,
    });
    if (engine === 'sqlserver') {
      for (const f of current.foreignKeys) {
        if (f.columns.includes(prev.name)) consumedByColumnDrop.add(f.name);
      }
      for (const i of current.indexes) {
        if (i.columns.includes(prev.name)) consumedByColumnDrop.add(i.name);
      }
    }
  }

  // ── Indexes, by name.
  const curIdx = new Map(current.indexes.map(i => [i.name, i]));
  const draftIdx = new Map(draft.indexes.map(i => [i.name, i]));
  for (const [name, i] of draftIdx) {
    const prev = curIdx.get(name);
    const sameShape = !!prev && prev.unique === i.unique && prev.columns.join() === i.columns.join();
    if (sameShape && !!prev!.invisible === !!i.invisible) continue;
    // Only visibility changed → a cheap metadata-only ALTER, no rebuild. This
    // is the whole point of invisible indexes (MySQL 8 / MariaDB 10.6+).
    if (sameShape && engine === 'mysql') {
      out.push({
        kind: 'alter-index', subject: name, risk: 'safe', cost: 'metadata',
        sql: `ALTER TABLE ${table} ALTER INDEX ${q(name)} ${
          i.invisible ? invisibleClause(maria) : (maria ? 'NOT IGNORED' : 'VISIBLE')}`,
        warning: i.invisible
          ? 'Hidden from the optimizer but still maintained on writes — test impact before dropping.'
          : undefined,
      });
      continue;
    }
    if (prev) {
      out.push({
        kind: 'drop-index', subject: name, risk: 'safe', cost: 'metadata',
        warning: 'Dropped and recreated because its definition changed. Queries relying on it '
          + 'are unindexed in between.',
        sql: dropIndexSql(name, table, schema, engine, q, prev.unique),
      });
    }
    const inv = i.invisible && engine === 'mysql' ? ` ${invisibleClause(maria)}` : '';
    out.push({
      kind: 'add-index', subject: name, risk: 'safe', cost: 'rebuild',
      sql: engine === 'mysql'
        ? `ALTER TABLE ${table} ADD ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} (${i.columns.map(q).join(', ')})${inv}`
        : `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${table} (${i.columns.map(q).join(', ')})`,
      warning: i.unique
        ? 'A UNIQUE index fails to build if the column already holds duplicates.'
        : undefined,
    });
  }
  for (const [name, prev] of curIdx) {
    if (draftIdx.has(name) || consumedByColumnDrop.has(name)) continue;
    out.push({
      kind: 'drop-index', subject: name, risk: 'safe', cost: 'metadata',
      warning: 'Queries that relied on this index will scan instead.',
      sql: dropIndexSql(name, table, schema, engine, q, prev.unique),
    });
  }

  // ── Foreign keys, by name.
  const curFk = new Map(current.foreignKeys.map(f => [f.name, f]));
  const draftFk = new Map(draft.foreignKeys.map(f => [f.name, f]));
  for (const [name, f] of draftFk) {
    if (curFk.has(name)) continue;
    out.push({
      kind: 'add-fk', subject: name, risk: 'lossy', cost: 'rebuild',
      warning: 'The constraint is rejected if any existing row has no matching parent.'
        + (f.onDelete === 'CASCADE'
          ? ' ON DELETE CASCADE means deleting a parent row silently deletes these.'
          : ''),
      sql: `ALTER TABLE ${table} ADD CONSTRAINT ${q(name)} FOREIGN KEY (${f.columns.map(q).join(', ')})`
        + ` REFERENCES ${q(f.refTable)} (${f.refColumns.map(q).join(', ')})`
        + (f.onDelete ? ` ON DELETE ${f.onDelete}` : '')
        + (f.onUpdate ? ` ON UPDATE ${f.onUpdate}` : ''),
    });
  }
  for (const [name] of curFk) {
    if (draftFk.has(name) || consumedByColumnDrop.has(name)) continue;
    out.push({
      kind: 'drop-fk', subject: name, risk: 'safe', cost: 'metadata',
      warning: 'Referential integrity is no longer enforced for this relationship.',
      // `DROP FOREIGN KEY` is MySQL's spelling only; the standard one, which
      // SQL Server and PostgreSQL both take, is DROP CONSTRAINT.
      sql: engine === 'mysql'
        ? `ALTER TABLE ${table} DROP FOREIGN KEY ${q(name)}`
        : `ALTER TABLE ${table} DROP CONSTRAINT ${q(name)}`,
    });
  }

  // ── Storage engine, last: it rewrites the whole table, so everything else
  // should already have succeeded before this is attempted.
  if (engine === 'mysql' && draft.engine
      && draft.engine.toLowerCase() !== (current.engine ?? '').toLowerCase()) {
    const to = draft.engine.toLowerCase();
    // The engines that quietly drop guarantees the table may be relying on.
    const noTransactions = ['myisam', 'aria', 'memory', 'csv', 'archive'].includes(to);
    const noData = to === 'blackhole';
    const reasons: string[] = [];
    if (noData) {
      reasons.push('BLACKHOLE discards every row written to it and returns none. '
        + 'The existing rows are lost by the conversion.');
    } else if (noTransactions) {
      // Measured on MySQL 8.0 and MariaDB 11.8: neither drops the constraint —
      // both REFUSE the conversion outright when the table is on either end of
      // a foreign key. Saying so in advance is worth more than usual here,
      // because MariaDB reports it as "Cannot delete or update a parent row"
      // (error 1217), which describes a completely different problem.
      reasons.push(`${draft.engine} is not transactional — no rollback, and it cannot hold `
        + 'foreign keys. The server refuses the conversion outright if this table is on '
        + 'either end of one; drop the constraints first if you mean it.');
    }
    if (to === 'memory') {
      reasons.push('A MEMORY table is emptied by a server restart.');
    }
    out.push({
      kind: 'change-engine', subject: draft.engine,
      risk: noData ? 'destructive' : noTransactions ? 'lossy' : 'safe',
      cost: 'rebuild',
      warning: reasons.length
        ? reasons.join(' ')
        : 'The table is copied row by row, which locks it for the duration on a large table.',
      sql: `ALTER TABLE ${table} ENGINE=${draft.engine}`,
    });
  }

  return out;
}

function dropIndexSql(
  name: string, table: string, schema: string, engine: Engine, q: (s: string) => string,
  unique = false,
): string {
  // A UNIQUE index created as a CONSTRAINT is not droppable as an index:
  // Msg 3723, "An explicit DROP INDEX is not allowed on index '…'. It is being
  // used for UNIQUE KEY constraint enforcement." Since `mssqlCreateTableSql`
  // declares unique indexes as constraints — so that they are named and appear
  // in sys.key_constraints — they have to come back out the same way.
  if (engine === 'sqlserver' && unique) {
    return `ALTER TABLE ${table} DROP CONSTRAINT ${q(name)}`;
  }
  return engine === 'mysql'
    ? `ALTER TABLE ${table} DROP INDEX ${q(name)}`
    // An index name is unique per TABLE in SQL Server, not per schema, so the
    // table has to be named: `DROP INDEX ix` alone is Msg 159, "Must specify
    // the table name and index name for the DROP INDEX statement".
    : engine === 'sqlserver'
    ? `DROP INDEX ${q(name)} ON ${table}`
    : `DROP INDEX ${q(schema)}.${q(name)}`;
}

/**
 * The statements that change one T-SQL column.
 *
 * This is where the dialect diverges most, and every part of it is a syntax
 * error in the other direction:
 *
 * - `ALTER COLUMN` takes the type and nullability **and nothing else** — adding
 *   `DEFAULT` to it is "Incorrect syntax near the keyword 'DEFAULT'".
 * - A DEFAULT is a **separate named constraint**, so changing one is a DROP and
 *   an ADD, and the drop needs the *old* name — which SQL Server generates with
 *   a hash in it unless someone named it.
 * - `ALTER COLUMN` restates the type even when only nullability changed, since
 *   there is no nullability-only form. That means a rewrite either way.
 * - IDENTITY cannot be added or removed by ALTER at all; the only route is a
 *   new table and a copy, which is far beyond a column edit and is said rather
 *   than attempted.
 */
function mssqlModifyColumnSql(
  c: ColumnDraft, prev: ColumnDraft, table: string, tableName: string,
  typeOrNullChanged: boolean, defChanged: boolean, q: (s: string) => string,
  dependents: readonly ColumnDraft[] = [],
): string {
  const out: string[] = [];

  if (!!c.autoIncrement !== !!prev.autoIncrement) {
    out.push('-- IDENTITY cannot be added to or removed from an existing column in SQL Server.');
    out.push('-- The only route is a new table with the desired definition, a copy, and a rename.');
  }

  // A computed column that references this one blocks the ALTER outright
  // (Msg 5074, "The column 'total' is dependent on column 'qty'"), and there is
  // no ordering that avoids it — the computed column has to be dropped and
  // recreated around the change. Saying so beats emitting a statement the
  // server will reject.
  const blocked = dependents.filter(d =>
    d.name !== c.name && d.generated
    && new RegExp(`(^|[^\\w])${escapeRe(prev.name)}([^\\w]|$)`, 'i').test(d.generated));
  for (const d of blocked) {
    out.push(`-- Computed column ${d.name} references ${prev.name}, and SQL Server refuses to`);
    out.push(`-- alter a column another one is computed from (Msg 5074). Drop and recreate it`);
    out.push(`-- around this change:`);
    out.push(`--   ALTER TABLE ${table} DROP COLUMN ${q(d.name)};`);
    out.push(`--   -- …the ALTER COLUMN below…`);
    out.push(`--   ALTER TABLE ${table} ADD ${mssqlColumnClause(d, q, tableName)};`);
    out.push('--');
  }

  // The DEFAULT constraint is dropped FIRST. It depends on the column, so
  // `ALTER COLUMN` while it exists fails with Msg 5074 — dropping it afterwards
  // is too late, and was how the first version of this failed against a real
  // server.
  const dropDefault = defChanged && prev.default !== null && prev.default !== '';
  if (dropDefault) {
    out.push(prev.defaultConstraint
      ? `ALTER TABLE ${table} DROP CONSTRAINT ${q(prev.defaultConstraint)}`
      // Without a name there is nothing to drop, and the name SQL Server
      // generated cannot be reconstructed — so the lookup is handed over
      // rather than guessed at.
      : `-- The existing DEFAULT has a server-generated name. Find it with:\n`
        + `--   SELECT dc.name FROM sys.default_constraints dc\n`
        + `--   JOIN sys.columns col ON col.object_id = dc.parent_object_id\n`
        + `--                       AND col.column_id = dc.parent_column_id\n`
        + `--   WHERE dc.parent_object_id = OBJECT_ID(${sqlLiteral(table, 'sqlserver')})\n`
        + `--     AND col.name = ${sqlLiteral(c.name, 'sqlserver')};\n`
        + `-- ALTER TABLE ${table} DROP CONSTRAINT <that name>`);
  }

  if (typeOrNullChanged) {
    // The type is restated even for a nullability-only change: T-SQL has no
    // form that alters nullability alone, and omitting the type would default
    // it back to the server's, silently changing the column.
    out.push(`ALTER TABLE ${table} ALTER COLUMN ${q(c.name)} ${c.type} `
      + `${c.nullable ? 'NULL' : 'NOT NULL'}`);
  }

  if (defChanged && c.default !== null && c.default !== '') {
    const name = c.defaultConstraint ?? defaultConstraintName(tableName, c.name);
    out.push(`ALTER TABLE ${table} ADD CONSTRAINT ${q(name)} `
      + `DEFAULT ${c.default} FOR ${q(c.name)}`);
  }

  // Statements are separated by `;`, comment lines are not — joining
  // everything with `;` puts one inside each comment and a doubled one after
  // any comment that already ends in a statement.
  return out
    .map((line, i) => {
      const isComment = line.trimStart().startsWith('--');
      const nextIsLast = i === out.length - 1;
      return isComment || nextIsLast ? line : `${line};`;
    })
    .join('\n');
}

/**
 * Dropping a T-SQL column, and everything that would refuse to let it go.
 *
 * The other two engines cascade a column's dependants away with it. SQL Server
 * does not: a DEFAULT constraint, a foreign key or an index that names the
 * column each block the drop with Msg 5074, one at a time. Emitting them
 * together is the difference between a reviewable script and four rounds of
 * run-read-error-edit.
 *
 * A computed column referencing it blocks the drop too, and cannot simply be
 * dropped alongside — it is data the user did not ask to lose — so that one is
 * named rather than silently included.
 */
function mssqlDropColumnSql(
  prev: ColumnDraft, current: TableDraft, table: string, q: (s: string) => string,
): string {
  const out: string[] = [];

  const computed = current.columns.filter(d =>
    d.name !== prev.name && d.generated
    && new RegExp(`(^|[^\\w])${escapeRe(prev.name)}([^\\w]|$)`, 'i').test(d.generated));
  for (const d of computed) {
    out.push(`-- Computed column ${d.name} is defined from ${prev.name} and blocks this drop.`);
    out.push(`-- Decide what happens to it first — dropping it here would remove a column`);
    out.push(`-- nobody asked to remove:`);
    out.push(`--   ALTER TABLE ${table} DROP COLUMN ${q(d.name)};`);
    out.push('--');
  }

  if (prev.defaultConstraint) {
    out.push(`ALTER TABLE ${table} DROP CONSTRAINT ${q(prev.defaultConstraint)}`);
  }
  for (const f of current.foreignKeys) {
    if (f.columns.includes(prev.name)) {
      out.push(`ALTER TABLE ${table} DROP CONSTRAINT ${q(f.name)}`);
    }
  }
  for (const i of current.indexes) {
    if (!i.columns.includes(prev.name)) continue;
    out.push(i.unique
      ? `ALTER TABLE ${table} DROP CONSTRAINT ${q(i.name)}`
      : `DROP INDEX ${q(i.name)} ON ${table}`);
  }
  out.push(`ALTER TABLE ${table} DROP COLUMN ${q(prev.name)}`);

  return out
    .map((line, i) => (line.trimStart().startsWith('--') || i === out.length - 1
      ? line : `${line};`))
    .join('\n');
}

/** Escape a name for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Type identity for comparison — case and spacing do not make a change. */
function parseTypeKey(t: string): string {
  const p = parseType(t);
  return `${p.base}(${p.args.join(',')})`;
}

// ── Partition management (MySQL / MariaDB) ───────────────────────────────────

/**
 * One RANGE partition: a name and the upper bound its rows fall under.
 *
 * `valuesLessThan` is **raw SQL**, not a literal — it is written into
 * `VALUES LESS THAN (…)` verbatim so `MAXVALUE`, an expression like
 * `TO_DAYS('2025-01-01')`, or a bare number all pass through unchanged. Quote
 * it yourself if it is a string bound.
 */
export interface PartitionDef {
  name: string;
  valuesLessThan: string;
}

/**
 * `ALTER TABLE … ADD PARTITION (PARTITION p VALUES LESS THAN (…))`.
 *
 * Non-destructive: it opens a new range for future rows and touches no existing
 * data, so on RANGE partitioning it is a metadata change. `table` is the
 * already-qualified, already-quoted reference (as `diffTable` builds it); the
 * partition name is quoted here.
 */
export function addPartitionSql(table: string, part: PartitionDef, engine: Engine): SchemaChange {
  const q = (s: string) => quoteIdent(s, engine);
  return {
    kind: 'add-partition', subject: part.name, risk: 'safe', cost: 'metadata',
    sql: `ALTER TABLE ${table} ADD PARTITION `
      + `(PARTITION ${q(part.name)} VALUES LESS THAN (${part.valuesLessThan}))`,
  };
}

/**
 * `ALTER TABLE … DROP PARTITION p`.
 *
 * **Destructive.** Dropping a partition deletes every row it holds outright —
 * this is not a metadata edit that leaves the data behind. As with any MySQL
 * DDL there is no transaction to roll back, so it carries the strongest label
 * the change model has, exactly like `drop-column`.
 */
export function dropPartitionSql(table: string, name: string, engine: Engine): SchemaChange {
  const q = (s: string) => quoteIdent(s, engine);
  return {
    kind: 'drop-partition', subject: name, risk: 'destructive', cost: 'metadata',
    warning: `Every row in partition ${name} is deleted. MySQL commits DDL implicitly — `
      + 'there is no transaction to roll back.',
    sql: `ALTER TABLE ${table} DROP PARTITION ${q(name)}`,
  };
}

/**
 * `ALTER TABLE … REORGANIZE PARTITION a, b INTO (PARTITION … VALUES LESS THAN (…), …)`.
 *
 * Splitting or merging partitions copies every row in the affected partitions
 * into the new layout — a full rebuild of that data, slow on a large table. It
 * is `lossy` rather than safe because a boundary that no longer covers an
 * existing row makes the server reject the statement, and a narrowed bound can
 * strand rows; the reorganised ranges must still span every value they held.
 */
export function reorganizePartitionSql(
  table: string, from: string[], into: PartitionDef[], engine: Engine,
): SchemaChange {
  const q = (s: string) => quoteIdent(s, engine);
  const intoClause = into
    .map(p => `PARTITION ${q(p.name)} VALUES LESS THAN (${p.valuesLessThan})`)
    .join(', ');
  return {
    kind: 'reorganize-partition', subject: from.join(', '), risk: 'lossy', cost: 'rebuild',
    warning: 'Rows in the reorganised partitions are copied into the new ones — slow on a '
      + 'large table, and the statement is rejected if the new ranges do not still cover '
      + 'every value the old ones held.',
    sql: `ALTER TABLE ${table} REORGANIZE PARTITION ${from.map(q).join(', ')} INTO (${intoClause})`,
  };
}

// ── Summarising a change set ─────────────────────────────────────────────────

export interface ChangeSummary {
  total: number;
  destructive: number;
  lossy: number;
  rebuilds: number;
  /** The single strongest warning, for the confirm button. */
  headline: string | null;
}

export function summarise(changes: SchemaChange[]): ChangeSummary {
  const destructive = changes.filter(c => c.risk === 'destructive').length;
  const lossy = changes.filter(c => c.risk === 'lossy').length;
  const rebuilds = changes.filter(c => c.cost === 'rebuild').length;
  let headline: string | null = null;
  if (destructive > 0) {
    const cols = changes.filter(c => c.risk === 'destructive').map(c => c.subject);
    headline = `${destructive} change${destructive === 1 ? '' : 's'} delete data: ${cols.join(', ')}.`;
  } else if (lossy > 0) {
    headline = `${lossy} change${lossy === 1 ? '' : 's'} can truncate or be rejected.`;
  } else if (rebuilds > 0) {
    headline = `${rebuilds} change${rebuilds === 1 ? '' : 's'} rewrite the table — slow on a large one.`;
  }
  return { total: changes.length, destructive, lossy, rebuilds, headline };
}

/**
 * The whole change set as a script, in apply order.
 *
 * Statements are separated by `;\n` and nothing else — no transaction wrapper,
 * because MySQL would not honour one around DDL and pretending otherwise in
 * the preview would be the most dangerous kind of reassurance.
 *
 * `blocked` changes carry no SQL — they are skipped here and block Apply in
 * the designer, so a copied script never silently does less than was asked.
 */
export function changesToScript(changes: SchemaChange[]): string {
  return changes.filter(c => c.sql.trim()).map(c => `${c.sql};`).join('\n');
}
