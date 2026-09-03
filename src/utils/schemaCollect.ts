/**
 * Reading a schema without disturbing it.
 *
 * The rules in `schemaRules.ts` take a plain `SchemaSnapshot`. This builds one
 * from a live MySQL or PostgreSQL server, and the *how* matters as much as
 * the *what*:
 *
 *  - **No `COUNT(*)`, ever.** Row counts come from `mysql.innodb_table_stats`
 *    (the persisted optimizer statistics) or `pg_stat_user_tables`. Counting
 *    rows on a 144-million-row table to tell someone their column should be
 *    UNSIGNED is not a trade anybody agreed to.
 *  - **Sizes come from the same place**, and only fall back to
 *    `information_schema.TABLES` when that table is unreadable — because with
 *    `innodb_stats_on_metadata = ON`, selecting the size columns out of
 *    `information_schema` triggers a statistics dive per table. The snapshot
 *    records which source it used and how old the numbers are, and every
 *    finding that quotes one says so.
 *  - **Every query stands alone.** A restricted account loses part of the
 *    report rather than failing the run: no `mysql.*` grant means no sizes,
 *    not no review.
 *
 * Pure: SQL builders and row mappers only, so the mapping is unit-tested and
 * the panel is left with `invoke` and layout.
 */
import { sqlLiteral } from './sqlIdent.ts';
import type {
  CatalogColumn, CatalogFk, CatalogIndex, CatalogTable, IndexColumn, SchemaSnapshot,
} from './schemaRules.ts';

/** A grid as the panel gets it back: column names plus rows of cells. */
export interface Grid {
  columns: string[];
  rows: unknown[][];
}

const s = (v: unknown): string => (v == null ? '' : String(v));
const n = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const yes = (v: unknown): boolean => {
  const t = s(v).toLowerCase();
  return t === 'yes' || t === '1' || t === 'true' || t === 't';
};

/** Read a row by column name, case-insensitively — servers differ on case. */
function reader(grid: Grid) {
  const idx = new Map(grid.columns.map((c, i) => [c.toLowerCase(), i]));
  return (row: unknown[], name: string): unknown => {
    const i = idx.get(name.toLowerCase());
    return i === undefined ? null : row[i];
  };
}

// ── the queries ─────────────────────────────────────────────────────────────

/**
 * Each query is named so a failure can be reported precisely ("sizes
 * unavailable" rather than "review failed"), and ordered cheapest first.
 */
export const MYSQL_SNAPSHOT_SQL = {
  defaults: (schema: string) => `SELECT @@character_set_server AS server_charset,
       @@collation_server AS server_collation,
       @@version AS server_version,
       s.DEFAULT_CHARACTER_SET_NAME AS schema_charset,
       s.DEFAULT_COLLATION_NAME AS schema_collation
FROM information_schema.SCHEMATA s
WHERE s.SCHEMA_NAME = ${sqlLiteral(schema, 'mysql')}`,

  // Deliberately WITHOUT TABLE_ROWS / DATA_LENGTH / INDEX_LENGTH: those are
  // the columns that can trigger a per-table statistics dive when
  // innodb_stats_on_metadata is ON. They come from `stats` below.
  tables: (schema: string) => `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, AUTO_INCREMENT, TABLE_COMMENT
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${sqlLiteral(schema, 'mysql')} AND TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME`,

  /** The persisted optimizer statistics — no dive, no scan. */
  stats: (schema: string) => `SELECT table_name, n_rows,
       clustered_index_size * @@innodb_page_size AS data_bytes,
       sum_of_other_index_sizes * @@innodb_page_size AS index_bytes,
       last_update
FROM mysql.innodb_table_stats
WHERE database_name = ${sqlLiteral(schema, 'mysql')}`,

  /** Fallback only — see the note above about the statistics dive. */
  statsFallback: (schema: string) => `SELECT TABLE_NAME AS table_name, TABLE_ROWS AS n_rows,
       DATA_LENGTH AS data_bytes, INDEX_LENGTH AS index_bytes, NULL AS last_update
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${sqlLiteral(schema, 'mysql')} AND TABLE_TYPE = 'BASE TABLE'`,

  columns: (schema: string) => `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
       COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME,
       CHARACTER_MAXIMUM_LENGTH, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ${sqlLiteral(schema, 'mysql')}
ORDER BY TABLE_NAME, ORDINAL_POSITION`,

  indexes: (schema: string) => `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
       SUB_PART, CARDINALITY, INDEX_TYPE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ${sqlLiteral(schema, 'mysql')}
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,

  foreignKeys: (schema: string) => `SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, k.COLUMN_NAME,
       k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, k.ORDINAL_POSITION,
       r.DELETE_RULE, r.UPDATE_RULE
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.REFERENTIAL_CONSTRAINTS r
  ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
WHERE k.TABLE_SCHEMA = ${sqlLiteral(schema, 'mysql')}
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
} as const;

/**
 * The PostgreSQL collectors — the same grid *shapes* as the MySQL ones, so the
 * same mappers turn them into one `SchemaSnapshot`, but read from `pg_catalog`
 * instead of `information_schema`, for the same reason the MySQL side avoids
 * the size columns of `information_schema.TABLES`: the catalog views are the
 * cheap, dive-free source, and they answer to a restricted account.
 *
 * Dialect notes a reader needs:
 *
 *  - **`data_type` is normalized to the rulebook's vocabulary** (`int2`→
 *    `smallint`, `int4`→`int`, `int8`→`bigint`, `float4`→`float`,
 *    `float8`→`double`, `bpchar`→`char`) so the integer/string rules read PG
 *    columns without learning a second spelling; `column_type` keeps the full
 *    `format_type()` rendering (`numeric(12,2)`, `timestamp without time
 *    zone`) for the type-mismatch and report text.
 *  - **The primary key's index is reported as `PRIMARY`.** PG names it
 *    `tbl_pkey`; the rules pattern-match on the MySQL convention, and the
 *    alias is cheaper than teaching them a second one.
 *  - **`extra` carries `identity` / `serial`** instead of `auto_increment`.
 *    Identity is detected through the dependency graph (`pg_depend.deptype =
 *    'i'`) rather than `pg_attribute.attidentity`, so the query still runs on
 *    a pre-10 server — the join simply matches nothing there.
 *  - **`pg_sequences.last_value` is NULL without SELECT on the sequence**, so
 *    the headroom rule sees "unknown" rather than failing — a restricted
 *    account loses one finding, never the review.
 *  - Expression index columns (`indkey = 0`) fall out of the attribute join;
 *    such an index is reported with the plain columns it does have.
 */
export const PG_SNAPSHOT_SQL = {
  defaults: (_schema: string) => `SELECT current_setting('server_version') AS server_version`,

  // relpersistence 'u' (unlogged) is the PG storage hazard the MySQL side
  // knows as a non-InnoDB engine; it rides the `engine` field.
  tables: (schema: string) => `SELECT c.relname AS table_name,
       CASE c.relpersistence WHEN 'u' THEN 'unlogged' WHEN 't' THEN 'temporary' ELSE 'logged' END AS engine,
       NULL AS table_collation,
       NULL AS auto_increment,
       COALESCE(obj_description(c.oid, 'pg_class'), '') AS table_comment
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${sqlLiteral(schema, 'postgres')} AND c.relkind IN ('r', 'p')
ORDER BY c.relname`,

  /** The planner's own row estimate plus measured on-disk sizes — no scan. */
  stats: (schema: string) => `SELECT c.relname AS table_name,
       s.n_live_tup AS n_rows,
       pg_catalog.pg_relation_size(c.oid) AS data_bytes,
       pg_catalog.pg_indexes_size(c.oid) AS index_bytes,
       GREATEST(s.last_analyze, s.last_autoanalyze) AS last_update
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = ${sqlLiteral(schema, 'postgres')} AND c.relkind IN ('r', 'p')`,

  /** Fallback when the statistics view is unreadable: reltuples estimates. */
  statsFallback: (schema: string) => `SELECT c.relname AS table_name,
       GREATEST(c.reltuples, 0)::bigint AS n_rows,
       pg_catalog.pg_relation_size(c.oid) AS data_bytes,
       pg_catalog.pg_indexes_size(c.oid) AS index_bytes,
       NULL AS last_update
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${sqlLiteral(schema, 'postgres')} AND c.relkind IN ('r', 'p')`,

  columns: (schema: string) => `SELECT c.relname AS table_name,
       a.attname AS column_name,
       CASE t.typname
         WHEN 'int2' THEN 'smallint' WHEN 'int4' THEN 'int' WHEN 'int8' THEN 'bigint'
         WHEN 'float4' THEN 'float' WHEN 'float8' THEN 'double'
         WHEN 'varchar' THEN 'varchar' WHEN 'bpchar' THEN 'char'
         ELSE t.typname END AS data_type,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type,
       CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
       pg_get_expr(d.adbin, d.adrelid) AS column_default,
       CASE WHEN depi.objid IS NOT NULL THEN 'identity'
            WHEN pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%' THEN 'serial'
            ELSE '' END AS extra,
       NULL AS character_set_name,
       CASE WHEN a.attcollation <> t.typcollation THEN coll.collname END AS collation_name,
       CASE WHEN a.atttypmod > 4 AND t.typname IN ('varchar', 'bpchar') THEN a.atttypmod - 4 END AS character_maximum_length,
       COALESCE(col_description(a.attrelid, a.attnum), '') AS column_comment
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = a.attcollation
LEFT JOIN pg_catalog.pg_depend depi
  ON depi.refobjid = a.attrelid AND depi.refobjsubid = a.attnum AND depi.deptype = 'i'
  AND depi.classid = 'pg_catalog.pg_class'::regclass
  AND depi.refclassid = 'pg_catalog.pg_class'::regclass
WHERE n.nspname = ${sqlLiteral(schema, 'postgres')} AND c.relkind IN ('r', 'p')
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum`,

  indexes: (schema: string) => `SELECT t.relname AS table_name,
       CASE WHEN ix.indisprimary THEN 'PRIMARY' ELSE ci.relname END AS index_name,
       CASE WHEN ix.indisunique THEN 0 ELSE 1 END AS non_unique,
       u.ord AS seq_in_index,
       a.attname AS column_name,
       NULL AS sub_part,
       NULL AS cardinality,
       upper(am.amname) AS index_type
FROM pg_catalog.pg_index ix
JOIN pg_catalog.pg_class ci ON ci.oid = ix.indexrelid
JOIN pg_catalog.pg_am am ON am.oid = ci.relam
JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS u(attnum, ord)
JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum
WHERE n.nspname = ${sqlLiteral(schema, 'postgres')}
ORDER BY t.relname, index_name, u.ord`,

  // convalidated rides along as is_valid: a NOT VALID foreign key is a
  // constraint the planner cannot trust, and the review says so.
  foreignKeys: (schema: string) => `SELECT con.conname AS constraint_name,
       src.relname AS table_name, sa.attname AS column_name,
       tgt.relname AS referenced_table_name, ta.attname AS referenced_column_name,
       u.ord AS ordinal_position,
       CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS delete_rule,
       CASE con.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS update_rule,
       con.convalidated AS is_valid
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = src.relnamespace
JOIN pg_catalog.pg_class tgt ON tgt.oid = con.confrelid
CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(satt, tatt, ord)
JOIN pg_catalog.pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = u.satt
JOIN pg_catalog.pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = u.tatt
WHERE con.contype = 'f' AND n.nspname = ${sqlLiteral(schema, 'postgres')}
ORDER BY src.relname, con.conname, u.ord`,

  /**
   * Identity/serial columns and the last value their sequence handed out —
   * the PG answer to `information_schema.TABLES.AUTO_INCREMENT`. `last_value`
   * is NULL when the account holds no SELECT on the sequence (documented
   * behaviour of the `pg_sequences` view), which the mapper keeps as
   * "unknown", never as zero.
   */
  sequences: (schema: string) => `SELECT t.relname AS table_name,
       a.attname AS column_name,
       CASE ty.typname WHEN 'int2' THEN 'smallint' WHEN 'int4' THEN 'int' ELSE 'bigint' END AS data_type,
       ps.last_value AS last_value
FROM pg_catalog.pg_depend dep
JOIN pg_catalog.pg_class sq ON sq.oid = dep.objid AND sq.relkind = 'S'
JOIN pg_catalog.pg_namespace ns ON ns.oid = sq.relnamespace
JOIN pg_catalog.pg_class t ON t.oid = dep.refobjid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
LEFT JOIN pg_catalog.pg_sequences ps
  ON ps.schemaname = ns.nspname AND ps.sequencename = sq.relname
WHERE dep.deptype IN ('a', 'i')
  AND dep.classid = 'pg_catalog.pg_class'::regclass
  AND dep.refclassid = 'pg_catalog.pg_class'::regclass
  AND n.nspname = ${sqlLiteral(schema, 'postgres')}
ORDER BY t.relname`,

  /** The same headroom read, scoped to a table list — the query-mode ceilings check. */
  sequencesForTables: (inList: string) => `SELECT n.nspname || '.' || t.relname AS table_name,
       a.attname AS column_name,
       CASE ty.typname WHEN 'int2' THEN 'smallint' WHEN 'int4' THEN 'int' ELSE 'bigint' END AS data_type,
       ps.last_value AS last_value
FROM pg_catalog.pg_depend dep
JOIN pg_catalog.pg_class sq ON sq.oid = dep.objid AND sq.relkind = 'S'
JOIN pg_catalog.pg_namespace ns ON ns.oid = sq.relnamespace
JOIN pg_catalog.pg_class t ON t.oid = dep.refobjid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
LEFT JOIN pg_catalog.pg_sequences ps
  ON ps.schemaname = ns.nspname AND ps.sequencename = sq.relname
WHERE dep.deptype IN ('a', 'i')
  AND dep.classid = 'pg_catalog.pg_class'::regclass
  AND dep.refclassid = 'pg_catalog.pg_class'::regclass
  AND n.nspname || '.' || t.relname IN (${inList})
ORDER BY table_name`,
} as const;

// ── the mappers ─────────────────────────────────────────────────────────────

export function mapTables(grid: Grid): CatalogTable[] {
  const get = reader(grid);
  return grid.rows.map(r => ({
    name: s(get(r, 'TABLE_NAME')),
    engine: s(get(r, 'ENGINE')) || null,
    collation: s(get(r, 'TABLE_COLLATION')) || null,
    rows: null,
    dataBytes: null,
    indexBytes: null,
    autoIncrement: n(get(r, 'AUTO_INCREMENT')),
    comment: s(get(r, 'TABLE_COMMENT')),
  }));
}

/** Fold the statistics grid into the tables, in place of a second pass. */
export function applyStats(tables: CatalogTable[], grid: Grid): CatalogTable[] {
  const get = reader(grid);
  const byName = new Map<string, { rows: number | null; data: number | null; index: number | null }>();
  for (const r of grid.rows) {
    byName.set(s(get(r, 'table_name')), {
      rows: n(get(r, 'n_rows')),
      data: n(get(r, 'data_bytes')),
      index: n(get(r, 'index_bytes')),
    });
  }
  return tables.map(t => {
    const st = byName.get(t.name);
    return st ? { ...t, rows: st.rows, dataBytes: st.data, indexBytes: st.index } : t;
  });
}

/** The newest `last_update` in the statistics grid — how fresh the numbers are. */
export function statsAge(grid: Grid, now: Date, engine?: string): string | undefined {
  const get = reader(grid);
  let newest: number | null = null;
  for (const r of grid.rows) {
    const raw = s(get(r, 'last_update'));
    if (!raw) continue;
    // MySQL hands back `YYYY-MM-DD HH:MM:SS`; make it unambiguous for Date.
    // PostgreSQL hands back a timestamptz (`…+02`), whose bare-hours offset is
    // not ISO — pad it to `+02:00` so Date.parse cannot refuse it.
    const t = Date.parse(raw.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  if (newest === null) return undefined;
  const days = Math.floor((now.getTime() - newest) / 86_400_000);
  if (days <= 0) return 'updated today';
  if (days === 1) return '1 day old';
  // Past a month the statistics are old enough that cardinality-derived advice
  // should be read with suspicion, so the wording changes. The command differs
  // by dialect: `ANALYZE TABLE t` on MySQL, `ANALYZE t` on PostgreSQL.
  // SQL Server has no ANALYZE at all — its equivalent is UPDATE STATISTICS,
  // and advice naming a statement the server would reject is advice nobody can
  // act on.
  const cmd = engine === 'postgres' ? 'ANALYZE'
    : engine === 'sqlserver' ? 'UPDATE STATISTICS'
    : 'ANALYZE TABLE';
  return days > 30 ? `${days} days old — stale, run ${cmd}` : `${days} days old`;
}

export function mapColumns(grid: Grid): CatalogColumn[] {
  const get = reader(grid);
  return grid.rows.map(r => ({
    table: s(get(r, 'TABLE_NAME')),
    name: s(get(r, 'COLUMN_NAME')),
    dataType: s(get(r, 'DATA_TYPE')),
    columnType: s(get(r, 'COLUMN_TYPE')),
    nullable: yes(get(r, 'IS_NULLABLE')),
    defaultValue: get(r, 'COLUMN_DEFAULT') == null ? null : s(get(r, 'COLUMN_DEFAULT')),
    extra: s(get(r, 'EXTRA')),
    charset: s(get(r, 'CHARACTER_SET_NAME')) || null,
    collation: s(get(r, 'COLLATION_NAME')) || null,
    charMaxLen: n(get(r, 'CHARACTER_MAXIMUM_LENGTH')),
    comment: s(get(r, 'COLUMN_COMMENT')),
  }));
}

/**
 * `information_schema.STATISTICS` is one row per index *column*; the rules
 * want one entry per index with its columns in order.
 */
export function mapIndexes(grid: Grid): CatalogIndex[] {
  const get = reader(grid);
  const byKey = new Map<string, CatalogIndex>();
  for (const r of grid.rows) {
    const table = s(get(r, 'TABLE_NAME'));
    const name = s(get(r, 'INDEX_NAME'));
    const key = `${table}\u0000${name}`;
    let idx = byKey.get(key);
    if (!idx) {
      idx = {
        table, name,
        // NON_UNIQUE is 0 for a unique index — the double negative is the
        // catalog's, and getting it backwards would invert every uniqueness
        // rule at once.
        unique: n(get(r, 'NON_UNIQUE')) === 0,
        type: s(get(r, 'INDEX_TYPE')) || 'BTREE',
        columns: [],
      };
      byKey.set(key, idx);
    }
    const c: IndexColumn = {
      name: s(get(r, 'COLUMN_NAME')),
      seq: n(get(r, 'SEQ_IN_INDEX')) ?? idx.columns.length + 1,
      subPart: n(get(r, 'SUB_PART')),
      cardinality: n(get(r, 'CARDINALITY')),
    };
    idx.columns.push(c);
  }
  for (const idx of byKey.values()) idx.columns.sort((a, b) => a.seq - b.seq);
  return [...byKey.values()];
}

export function mapForeignKeys(grid: Grid): CatalogFk[] {
  const get = reader(grid);
  return grid.rows.map(r => ({
    name: s(get(r, 'CONSTRAINT_NAME')),
    table: s(get(r, 'TABLE_NAME')),
    column: s(get(r, 'COLUMN_NAME')),
    refTable: s(get(r, 'REFERENCED_TABLE_NAME')),
    refColumn: s(get(r, 'REFERENCED_COLUMN_NAME')),
    ordinal: n(get(r, 'ORDINAL_POSITION')) ?? 1,
    onDelete: s(get(r, 'DELETE_RULE')),
    onUpdate: s(get(r, 'UPDATE_RULE')),
    // Only PG's convalidated feeds IS_VALID; a grid without the column (MySQL,
    // where NOT VALID does not exist) must read as valid, not as false.
    validated: get(r, 'IS_VALID') == null ? true : yes(get(r, 'IS_VALID')),
  }));
}

/**
 * Fold the PG sequences grid into the tables: the last value handed out for
 * the table's identity/serial column rides the `autoIncrement` field, which
 * is exactly the "how far along is the counter" number the headroom rule
 * needs, whichever dialect counts it. A NULL `last_value` (no sequence
 * privilege) stays `null` — unknown, never zero.
 */
export function applySequences(tables: CatalogTable[], grid: Grid): CatalogTable[] {
  const get = reader(grid);
  const lastByTable = new Map<string, number | null>();
  for (const r of grid.rows) {
    lastByTable.set(s(get(r, 'table_name')), n(get(r, 'last_value')));
  }
  return tables.map(t => {
    if (!lastByTable.has(t.name)) return t;
    return { ...t, autoIncrement: lastByTable.get(t.name) ?? null };
  });
}

export function mapDefaults(grid: Grid): Pick<SchemaSnapshot,
  'serverCharset' | 'serverCollation' | 'schemaCharset' | 'schemaCollation' | 'serverVersion'> {
  const get = reader(grid);
  const r = grid.rows[0];
  if (!r) {
    return { serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null, serverVersion: null };
  }
  return {
    serverCharset: s(get(r, 'server_charset')) || null,
    serverCollation: s(get(r, 'server_collation')) || null,
    schemaCharset: s(get(r, 'schema_charset')) || null,
    schemaCollation: s(get(r, 'schema_collation')) || null,
    serverVersion: s(get(r, 'server_version')) || null,
  };
}

/**
 * Assemble a snapshot from whatever came back.
 *
 * `null` for a grid means that query failed or was not permitted. The
 * corresponding part of the snapshot is simply empty, and the rules that
 * needed it produce nothing — a restricted account gets a shorter report,
 * never a broken one.
 */
export function buildSnapshot(input: {
  schema: string;
  engine: string;
  defaults: Grid | null;
  tables: Grid | null;
  stats: Grid | null;
  statsSource: string;
  columns: Grid | null;
  indexes: Grid | null;
  foreignKeys: Grid | null;
  /** PG only: identity/serial sequence positions. Absent on MySQL. */
  sequences?: Grid | null;
  now?: Date;
}): SchemaSnapshot {
  let tables = input.tables ? mapTables(input.tables) : [];
  if (input.stats) tables = applyStats(tables, input.stats);
  if (input.sequences) tables = applySequences(tables, input.sequences);
  return {
    engine: input.engine,
    schema: input.schema,
    ...(input.defaults
      ? mapDefaults(input.defaults)
      : { serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null, serverVersion: null }),
    tables,
    columns: input.columns ? mapColumns(input.columns) : [],
    indexes: input.indexes ? mapIndexes(input.indexes) : [],
    foreignKeys: input.foreignKeys ? mapForeignKeys(input.foreignKeys) : [],
    statsSource: input.stats ? input.statsSource : undefined,
    statsAge: input.stats ? statsAge(input.stats, input.now ?? new Date(), input.engine) : undefined,
  };
}
