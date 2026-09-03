/**
 * Building a schema snapshot (src/utils/schemaCollect.ts).
 *
 * Two things are being defended here, and the second is the one that bites.
 *
 *  1. **The schema is read, not disturbed.** No `COUNT(*)`, and the size
 *     columns of `information_schema.TABLES` — the ones that can trigger a
 *     per-table statistics dive under `innodb_stats_on_metadata` — are not in
 *     the main table query at all.
 *  2. **`NON_UNIQUE` is a double negative.** Reading it the wrong way round
 *     inverts every uniqueness rule at once, silently, and each of them then
 *     looks individually plausible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MYSQL_SNAPSHOT_SQL, PG_SNAPSHOT_SQL, mapTables, mapColumns, mapIndexes, mapForeignKeys,
  mapDefaults, applyStats, applySequences, statsAge, buildSnapshot,
} from '../src/utils/schemaCollect.ts';
import { reviewSchema } from '../src/utils/schemaRules.ts';

const grid = (columns: string[], rows: unknown[][]) => ({ columns, rows });

// ── the queries ─────────────────────────────────────────────────────────────

test('the table query does not ask for the columns that trigger a statistics dive', () => {
  const sql = MYSQL_SNAPSHOT_SQL.tables('shop');
  assert.doesNotMatch(sql, /DATA_LENGTH|INDEX_LENGTH|TABLE_ROWS/);
  assert.match(sql, /AUTO_INCREMENT/);
});

test('sizes and row counts come from the persisted statistics', () => {
  const sql = MYSQL_SNAPSHOT_SQL.stats('shop');
  assert.match(sql, /mysql\.innodb_table_stats/);
  assert.doesNotMatch(sql, /COUNT\(/i);
});

test('no snapshot query counts rows', () => {
  for (const [name, build] of Object.entries(MYSQL_SNAPSHOT_SQL)) {
    assert.doesNotMatch(build('shop'), /\bCOUNT\s*\(\s*\*/i, name);
  }
});

test('the schema name is escaped, not interpolated', () => {
  const sql = MYSQL_SNAPSHOT_SQL.columns("sh'op");
  assert.match(sql, /'sh''op'/);
});

// ── mapping ─────────────────────────────────────────────────────────────────

test('column names are matched case-insensitively', () => {
  // Servers and proxies disagree about the case of information_schema column
  // names; a snapshot that silently comes back empty is the worst outcome.
  const g = grid(['table_name', 'engine', 'table_collation', 'auto_increment', 'table_comment'],
    [['orders', 'InnoDB', 'utf8mb4_0900_ai_ci', 42, 'the orders']]);
  assert.deepEqual(mapTables(g)[0], {
    name: 'orders', engine: 'InnoDB', collation: 'utf8mb4_0900_ai_ci',
    rows: null, dataBytes: null, indexBytes: null, autoIncrement: 42, comment: 'the orders',
  });
});

test('NON_UNIQUE = 0 means unique', () => {
  const g = grid(
    ['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'],
    [
      ['t', 'PRIMARY', 0, 1, 'id', null, 1000, 'BTREE'],
      ['t', 'ix_name', 1, 1, 'name', 20, 900, 'BTREE'],
    ]);
  const idx = mapIndexes(g);
  assert.equal(idx.find(i => i.name === 'PRIMARY')!.unique, true);
  assert.equal(idx.find(i => i.name === 'ix_name')!.unique, false);
  assert.equal(idx.find(i => i.name === 'ix_name')!.columns[0].subPart, 20);
});

test('a multi-column index keeps its column order whatever order the rows arrive in', () => {
  // The order is the index: `(a, b)` and `(b, a)` answer different queries.
  const g = grid(
    ['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'],
    [
      ['t', 'ix_ab', 1, 2, 'b', null, 100, 'BTREE'],
      ['t', 'ix_ab', 1, 1, 'a', null, 10, 'BTREE'],
    ]);
  assert.deepEqual(mapIndexes(g)[0].columns.map(c => c.name), ['a', 'b']);
});

test('YES/NO nullability and NULL defaults survive the trip', () => {
  const g = grid(
    ['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_DEFAULT',
      'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'CHARACTER_MAXIMUM_LENGTH', 'COLUMN_COMMENT'],
    [
      ['t', 'a', 'int', 'int unsigned', 'NO', null, 'auto_increment', null, null, null, ''],
      ['t', 'b', 'varchar', 'varchar(20)', 'YES', '', '', 'utf8mb4', 'utf8mb4_0900_ai_ci', 20, 'note'],
    ]);
  const [a, b] = mapColumns(g);
  assert.equal(a.nullable, false);
  assert.equal(a.defaultValue, null);
  assert.equal(a.extra, 'auto_increment');
  assert.equal(b.nullable, true);
  assert.equal(b.defaultValue, '', 'an empty-string default is not the same as no default');
  assert.equal(b.charMaxLen, 20);
});

test('foreign keys carry their ordinal so a composite key pairs correctly', () => {
  const g = grid(
    ['CONSTRAINT_NAME', 'TABLE_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_NAME',
      'REFERENCED_COLUMN_NAME', 'ORDINAL_POSITION', 'DELETE_RULE', 'UPDATE_RULE'],
    [
      ['fk', 'lines', 'order_id', 'orders', 'id', 1, 'CASCADE', 'RESTRICT'],
      ['fk', 'lines', 'line_no', 'orders', 'seq', 2, 'CASCADE', 'RESTRICT'],
    ]);
  const fks = mapForeignKeys(g);
  assert.deepEqual(fks.map(f => [f.column, f.refColumn, f.ordinal]),
    [['order_id', 'id', 1], ['line_no', 'seq', 2]]);
  assert.equal(fks[0].onDelete, 'CASCADE');
});

test('the four charset levels are read as one row', () => {
  const g = grid(['server_charset', 'server_collation', 'schema_charset', 'schema_collation', 'server_version'],
    [['utf8mb4', 'utf8mb4_0900_ai_ci', 'latin1', 'latin1_swedish_ci', '8.0.44']]);
  assert.deepEqual(mapDefaults(g), {
    serverCharset: 'utf8mb4', serverCollation: 'utf8mb4_0900_ai_ci',
    schemaCharset: 'latin1', schemaCollation: 'latin1_swedish_ci',
    serverVersion: '8.0.44',
  });
});

test('the server version rides along for the reserved-word upgrade check', () => {
  assert.match(MYSQL_SNAPSHOT_SQL.defaults('shop'), /@@version AS server_version/);
  // An older grid without the column degrades to "version unknown", not a crash.
  const g = grid(['server_charset'], [['utf8mb4']]);
  assert.equal(mapDefaults(g).serverVersion, null);
});

// ── statistics ──────────────────────────────────────────────────────────────

test('statistics are folded into the tables they belong to', () => {
  const tables = mapTables(grid(['TABLE_NAME'], [['orders'], ['customers']]));
  const stats = grid(['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'],
    [['orders', 14_420_583, 4_294_967_296, 1_073_741_824, '2026-08-08 03:00:00']]);
  const merged = applyStats(tables, stats);
  assert.equal(merged[0].rows, 14_420_583);
  assert.equal(merged[0].dataBytes, 4_294_967_296);
  assert.equal(merged[1].rows, null, 'a table with no statistics row keeps unknown, not zero');
});

test('the age of the statistics is stated, and called stale past a month', () => {
  const now = new Date('2026-08-10T12:00:00');
  const g = (when: string) => grid(['table_name', 'last_update'], [['t', when]]);
  assert.equal(statsAge(g('2026-08-10 03:00:00'), now), 'updated today');
  assert.equal(statsAge(g('2026-08-09 03:00:00'), now), '1 day old');
  assert.match(statsAge(g('2026-06-01 03:00:00'), now)!, /stale, run ANALYZE TABLE/);
  assert.equal(statsAge(grid(['table_name', 'last_update'], [['t', null]]), now), undefined);
});

// ── assembly ────────────────────────────────────────────────────────────────

test('a restricted account gets a shorter report, never a broken one', () => {
  // No mysql.* grant: statistics are missing. Everything that does not need
  // them still works, and nothing claims a number it does not have.
  const snap = buildSnapshot({
    schema: 'shop', engine: 'mysql',
    defaults: grid(['server_charset', 'server_collation', 'schema_charset', 'schema_collation'],
      [['utf8mb4', 'utf8mb4_0900_ai_ci', 'utf8mb4', 'utf8mb4_0900_ai_ci']]),
    tables: grid(['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT'],
      [['orders', 'InnoDB', 'utf8mb4_0900_ai_ci', 2_500_000_000, '']]),
    stats: null,
    statsSource: 'mysql.innodb_table_stats',
    columns: grid(['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE',
      'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME',
      'CHARACTER_MAXIMUM_LENGTH', 'COLUMN_COMMENT'],
      [['orders', 'id', 'int', 'int unsigned', 'NO', null, 'auto_increment', null, null, null, '']]),
    indexes: null,
    foreignKeys: null,
  });

  assert.equal(snap.statsSource, undefined, 'no statistics means no source claimed');
  assert.equal(snap.tables[0].rows, null);
  // The AUTO_INCREMENT headroom rule needs no statistics at all, so it still fires.
  const f = reviewSchema(snap).findings.find(x => x.id === 'INT3')!;
  assert.equal(f.severity, 'orange');
});

test('a full snapshot reaches the rules with its provenance attached', () => {
  const snap = buildSnapshot({
    schema: 'shop', engine: 'mysql',
    defaults: null,
    tables: grid(['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT'],
      [['events', 'InnoDB', 'utf8mb4_0900_ai_ci', null, '']]),
    stats: grid(['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'],
      [['events', 5_000_000, 1024, 1024, '2026-08-09 03:00:00']]),
    statsSource: 'mysql.innodb_table_stats',
    columns: grid(['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE',
      'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME',
      'CHARACTER_MAXIMUM_LENGTH', 'COLUMN_COMMENT'],
      [['events', 'event_id', 'int', 'int unsigned', 'NO', null, '', null, null, null, '']]),
    indexes: grid(['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME',
      'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'], []),
    foreignKeys: grid(['CONSTRAINT_NAME'], []),
    now: new Date('2026-08-10T12:00:00'),
  });

  assert.equal(snap.statsSource, 'mysql.innodb_table_stats');
  assert.equal(snap.statsAge, '1 day old');
  // No PRIMARY KEY — and the finding quotes the row count with its source.
  const f = reviewSchema(snap).findings.find(x => x.id === 'KEY1')!;
  assert.equal(f.evidence![0].source, 'mysql.innodb_table_stats');
  assert.equal(f.evidence![0].age, '1 day old');
  assert.match(f.evidence![0].value, /5,000,000 rows/);
});

// ── the PostgreSQL collectors ───────────────────────────────────────────────

test('PG: no snapshot query counts rows either', () => {
  for (const [name, build] of Object.entries(PG_SNAPSHOT_SQL)) {
    if (name === 'sequencesForTables') {
      assert.doesNotMatch(build("'public.orders'"), /\bCOUNT\s*\(\s*\*/i, name);
    } else {
      assert.doesNotMatch(build('shop'), /\bCOUNT\s*\(\s*\*/i, name);
    }
  }
});

test('PG: the schema name is escaped with PG rules — doubled quote, backslash left alone', () => {
  const sql = PG_SNAPSHOT_SQL.columns("sh'op\\x");
  assert.match(sql, /'sh''op\\x'/);
});

test('PG: types are normalized to the rulebook vocabulary, and identity/serial ride `extra`', () => {
  const sql = PG_SNAPSHOT_SQL.columns('shop');
  assert.match(sql, /WHEN 'int4' THEN 'int'/);
  assert.match(sql, /WHEN 'float8' THEN 'double'/);
  assert.match(sql, /WHEN 'bpchar' THEN 'char'/);
  // Identity via the dependency graph, not attidentity — a pre-10 server
  // answers this query with an empty join instead of an error.
  assert.match(sql, /deptype = 'i'/);
  assert.match(sql, /LIKE 'nextval\(%' THEN 'serial'/);
});

test('PG: the primary key is aliased to PRIMARY for the rules', () => {
  assert.match(PG_SNAPSHOT_SQL.indexes('shop'), /WHEN ix\.indisprimary THEN 'PRIMARY'/);
});

test('PG: sequence headroom reads last_value through the privilege-aware view', () => {
  const sql = PG_SNAPSHOT_SQL.sequences('shop');
  assert.match(sql, /pg_sequences/);
  assert.match(sql, /last_value/);
  assert.match(sql, /deptype IN \('a', 'i'\)/);
});

test('PG: foreign keys carry convalidated, and the mapper defaults it to valid', () => {
  assert.match(PG_SNAPSHOT_SQL.foreignKeys('shop'), /convalidated AS is_valid/);
  const g = grid(
    ['CONSTRAINT_NAME', 'TABLE_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_NAME',
      'REFERENCED_COLUMN_NAME', 'ORDINAL_POSITION', 'DELETE_RULE', 'UPDATE_RULE', 'IS_VALID'],
    [
      ['fk_new', 'lines', 'order_id', 'orders', 'id', 1, 'CASCADE', 'RESTRICT', true],
      ['fk_old', 'lines', 'product_id', 'products', 'id', 1, 'NO ACTION', 'NO ACTION', false],
    ]);
  const fks = mapForeignKeys(g);
  assert.equal(fks[0].validated, true);
  assert.equal(fks[1].validated, false, 'a NOT VALID constraint must survive the trip');
  // A MySQL grid has no IS_VALID column at all — missing must read as valid.
  const my = mapForeignKeys(grid(
    ['CONSTRAINT_NAME', 'TABLE_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_NAME',
      'REFERENCED_COLUMN_NAME', 'ORDINAL_POSITION', 'DELETE_RULE', 'UPDATE_RULE'],
    [['fk', 'lines', 'order_id', 'orders', 'id', 1, 'CASCADE', 'RESTRICT']]));
  assert.equal(my[0].validated, true);
});

test('PG: sequence last values fold into the tables as the headroom counter', () => {
  const tables = mapTables(grid(['TABLE_NAME'], [['orders'], ['audit_log']]));
  const seqs = grid(['table_name', 'column_name', 'data_type', 'last_value'],
    [['orders', 'id', 'int', 2_100_000_000], ['audit_log', 'id', 'bigint', null]]);
  const merged = applySequences(tables, seqs);
  assert.equal(merged[0].autoIncrement, 2_100_000_000);
  assert.equal(merged[1].autoIncrement, null, 'no sequence privilege means unknown, never zero');
});

test('PG: a timestamptz last_update parses, bare-hours offset included', () => {
  const now = new Date('2026-08-10T12:00:00Z');
  const g = grid(['table_name', 'last_update'], [['t', '2026-08-09 03:00:00.123456+02']]);
  assert.equal(statsAge(g, now, 'postgres'), '1 day old');
  const stale = grid(['table_name', 'last_update'], [['t', '2026-06-01 03:00:00+00']]);
  assert.match(statsAge(stale, now, 'postgres')!, /stale, run ANALYZE$/);
  // MySQL keeps its own command name.
  assert.match(statsAge(stale, now, 'mysql')!, /stale, run ANALYZE TABLE$/);
});

test('PG: buildSnapshot applies sequences after statistics', () => {
  const snap = buildSnapshot({
    schema: 'public', engine: 'postgres',
    defaults: grid(['server_version'], [['16.4']]),
    tables: grid(['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT'],
      [['orders', 'logged', null, null, '']]),
    stats: grid(['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'],
      [['orders', 5_000_000, 1 << 20, 1 << 18, '2026-08-09 03:00:00+00']]),
    statsSource: 'pg_stat_user_tables + pg_relation_size',
    columns: grid(['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE',
      'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME',
      'CHARACTER_MAXIMUM_LENGTH', 'COLUMN_COMMENT'],
      [['orders', 'id', 'int', 'integer', 'NO', null, 'identity', null, null, null, '']]),
    indexes: grid(['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME',
      'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'],
      [['orders', 'PRIMARY', 0, 1, 'id', null, null, 'BTREE']]),
    foreignKeys: null,
    sequences: grid(['table_name', 'column_name', 'data_type', 'last_value'],
      [['orders', 'id', 'int', 2_100_000_000]]),
    now: new Date('2026-08-10T12:00:00Z'),
  });
  assert.equal(snap.tables[0].rows, 5_000_000);
  assert.equal(snap.tables[0].autoIncrement, 2_100_000_000);
  // …and the headroom rule consumes exactly that pairing.
  const f = reviewSchema(snap).findings.find(x => x.id === 'SEQ1')!;
  assert.equal(f.severity, 'red', 'a 98%-used int4 identity range is red');
  assert.match(f.fix!, /TYPE bigint/);
});
