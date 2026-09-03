/**
 * The catalog-driven rulebook (src/utils/schemaRules.ts).
 *
 * These tests exist to keep two promises the panel makes:
 *
 *  - **a finding is earned.** Every rule is gated on magnitude as well as
 *    shape, because a rule that fires on every schema teaches people to close
 *    the panel. The negative cases below are as important as the positive ones.
 *  - **the advice follows the rulebook, not the vote.** In an old schema the
 *    majority is usually the legacy mistake, so `UNSIGNED` beats signed and
 *    narrower beats wider even when it is outnumbered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewSchema, isReferenceName, indexEntryBytes, targetCollation,
  typeMismatch, pickRecommended, VAGUE_COLUMN_NAMES,
} from '../src/utils/schemaRules.ts';
import type {
  CatalogColumn, CatalogIndex, CatalogTable, CatalogFk, SchemaSnapshot,
} from '../src/utils/schemaRules.ts';

// ── fixtures ────────────────────────────────────────────────────────────────

function col(over: Partial<CatalogColumn> & { table: string; name: string }): CatalogColumn {
  return {
    dataType: 'int', columnType: 'int unsigned', nullable: false, defaultValue: null,
    extra: '', charset: null, collation: null, charMaxLen: null, comment: '',
    ...over,
  };
}
function table(over: Partial<CatalogTable> & { name: string }): CatalogTable {
  return {
    engine: 'InnoDB', collation: 'utf8mb4_0900_ai_ci', rows: 10_000,
    dataBytes: 1024 * 1024, indexBytes: 256 * 1024, autoIncrement: null, comment: '',
    ...over,
  };
}
function index(over: Partial<CatalogIndex> & { table: string; name: string; columns: CatalogIndex['columns'] }): CatalogIndex {
  return { unique: false, type: 'BTREE', ...over };
}
function snap(over: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    engine: 'mysql', schema: 'shop',
    serverCharset: 'utf8mb4', serverCollation: 'utf8mb4_0900_ai_ci',
    schemaCharset: 'utf8mb4', schemaCollation: 'utf8mb4_0900_ai_ci',
    tables: [], columns: [], indexes: [], foreignKeys: [],
    statsSource: 'mysql.innodb_table_stats', statsAge: '2 days old',
    ...over,
  };
}
const ids = (s: SchemaSnapshot) => reviewSchema(s).findings.map(f => f.id);
const find = (s: SchemaSnapshot, id: string) => reviewSchema(s).findings.find(f => f.id === id);

// ── policy helpers ──────────────────────────────────────────────────────────

test('a reference name is a suffix or a globally unambiguous word', () => {
  assert.ok(isReferenceName('order_id'));
  assert.ok(isReferenceName('product_ean'));
  assert.ok(isReferenceName('email'));
  assert.ok(!isReferenceName('id'), 'bare id means something different in every table');
  assert.ok(!isReferenceName('status'));
  assert.ok(VAGUE_COLUMN_NAMES.has('version'));
});

test('an index entry reserves the declared width times the charset', () => {
  const c = col({ table: 't', name: 'sku', dataType: 'varchar', columnType: 'varchar(255)', charMaxLen: 255, charset: 'utf8mb4' });
  assert.equal(indexEntryBytes(c, null), 1020);
  assert.equal(indexEntryBytes(c, 20), 80, 'a prefix index reserves only the prefix');
  assert.equal(indexEntryBytes({ ...c, charset: 'latin1' }, null), 255);
});

// ── §1 integers ─────────────────────────────────────────────────────────────

test('a signed AUTO_INCREMENT throws away half its range', () => {
  const s = snap({
    tables: [table({ name: 'orders' })],
    columns: [col({ table: 'orders', name: 'id', columnType: 'int', extra: 'auto_increment' })],
  });
  const f = find(s, 'INT1')!;
  assert.match(f.title, /signed AUTO_INCREMENT/);
  assert.match(f.fix!, /MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT/);
});

test('an unsigned AUTO_INCREMENT is not a finding', () => {
  const s = snap({
    tables: [table({ name: 'orders' })],
    columns: [col({ table: 'orders', name: 'id', extra: 'auto_increment' })],
  });
  assert.ok(!ids(s).includes('INT1'));
});

test('AUTO_INCREMENT headroom escalates with how much is gone', () => {
  const at = (next: number) => find(snap({
    tables: [table({ name: 'orders', autoIncrement: next })],
    columns: [col({ table: 'orders', name: 'id', columnType: 'int unsigned', extra: 'auto_increment' })],
  }), 'INT3');

  assert.equal(at(100_000), undefined, 'a counter at 0.002% is not news');
  assert.equal(at(1_000_000_000)?.severity, 'yellow');   // 23%
  assert.equal(at(2_500_000_000)?.severity, 'orange');   // 58%
  assert.equal(at(4_000_000_000)?.severity, 'red');      // 93%
  assert.match(at(4_000_000_000)!.detail, /4,294,967,295/);
});

// ── §2/§6 column shape ──────────────────────────────────────────────────────

test('a wide indexed VARCHAR is reported, and only when it is indexed and the table is big', () => {
  const column = col({
    table: 'products', name: 'barcode', dataType: 'varchar',
    columnType: 'varchar(255)', charMaxLen: 255, charset: 'utf8mb4',
  });
  const idx = index({ table: 'products', name: 'ix_barcode', columns: [{ name: 'barcode', seq: 1, subPart: null, cardinality: 900 }] });

  const indexed = snap({ tables: [table({ name: 'products' })], columns: [column], indexes: [idx] });
  assert.match(find(indexed, 'STR1')!.detail, /1020 bytes/);

  const notIndexed = snap({ tables: [table({ name: 'products' })], columns: [column] });
  assert.ok(!ids(notIndexed).includes('STR1'), 'an unindexed column costs nothing per entry');

  const tiny = snap({ tables: [table({ name: 'products', rows: 40 })], columns: [column], indexes: [idx] });
  assert.ok(!ids(tiny).includes('STR1'), 'a 40-row lookup table is not a finding');
});

test('money in a binary float is critical', () => {
  const s = snap({
    tables: [table({ name: 'orders' })],
    columns: [col({ table: 'orders', name: 'total_price', dataType: 'double', columnType: 'double' })],
  });
  const f = find(s, 'NUM1')!;
  assert.equal(f.severity, 'red');
  assert.match(f.fix!, /DECIMAL\(14,2\)/);
});

test('a non-money double is left alone', () => {
  const s = snap({
    tables: [table({ name: 'sensors' })],
    columns: [col({ table: 'sensors', name: 'temperature', dataType: 'double', columnType: 'double' })],
  });
  assert.ok(!ids(s).includes('NUM1'));
});

// ── §3 collation, all four levels ───────────────────────────────────────────

test('the target is the schema default when it is full Unicode', () => {
  assert.equal(targetCollation(snap()), 'utf8mb4_0900_ai_ci');
});

test('otherwise the target is the commonest utf8mb4 collation actually present', () => {
  const s = snap({
    schemaCollation: 'latin1_swedish_ci',
    tables: [
      table({ name: 'a', collation: 'utf8mb4_unicode_ci' }),
      table({ name: 'b', collation: 'utf8mb4_unicode_ci' }),
      table({ name: 'c', collation: 'latin1_swedish_ci' }),
    ],
  });
  assert.equal(targetCollation(s), 'utf8mb4_unicode_ci');
});

test('a server/schema disagreement is reported, because bare CHARSET= then means two things', () => {
  const s = snap({ serverCollation: 'latin1_swedish_ci' });
  assert.ok(ids(s).includes('CHR5'));
});

test('deviating tables are ONE finding carrying the price, not one per table', () => {
  const s = snap({
    tables: [
      table({ name: 'a', collation: 'latin1_swedish_ci', dataBytes: 2 * 1024 ** 3, indexBytes: 0 }),
      table({ name: 'b', collation: 'latin1_swedish_ci', dataBytes: 1024 ** 3, indexBytes: 0 }),
      table({ name: 'ok' }),
    ],
  });
  const all = reviewSchema(s).findings.filter(f => f.id === 'CHR13');
  assert.equal(all.length, 1, 'one aggregate finding — a rebuild per table is one decision');
  assert.match(all[0].detail, /`a` \(latin1_swedish_ci\)/);
  assert.match(all[0].evidence![0].value, /3\.0 GiB to convert/);
  assert.equal(all[0].evidence![1].modelled, true, 'the disk figure is a model estimate and says so');
  // Smallest first, so a failure costs least.
  assert.match(all[0].fix!, /^ALTER TABLE `b`/);
});

test('a case-insensitive collation on a machine identifier is a real defect', () => {
  const s = snap({
    tables: [table({ name: 'products' })],
    columns: [col({
      table: 'products', name: 'barcode', dataType: 'varchar', columnType: 'varchar(32)',
      charMaxLen: 32, charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci',
    })],
  });
  const f = find(s, 'CHR20')!;
  assert.match(f.detail, /ABC` equal to `abc/);
  assert.match(f.fix!, /_as_cs/);
});

// ── §8/§9 keys and indexes ──────────────────────────────────────────────────

test('a table with no PRIMARY KEY is critical, and says why replication cares', () => {
  const s = snap({
    tables: [table({ name: 'events', rows: 5_000_000 })],
    columns: [col({ table: 'events', name: 'event_id' })],
  });
  const f = find(s, 'KEY1')!;
  assert.equal(f.severity, 'red');
  assert.match(f.why!, /row-based replication/);
});

test('an index that is a prefix of another is redundant — unless it is UNIQUE', () => {
  const cols = [col({ table: 't', name: 'a' }), col({ table: 't', name: 'b' })];
  const short = index({ table: 't', name: 'ix_a', columns: [{ name: 'a', seq: 1, subPart: null, cardinality: 10 }] });
  const long = index({
    table: 't', name: 'ix_ab',
    columns: [{ name: 'a', seq: 1, subPart: null, cardinality: 10 }, { name: 'b', seq: 2, subPart: null, cardinality: 100 }],
  });

  const redundant = snap({ tables: [table({ name: 't' })], columns: cols, indexes: [short, long] });
  assert.match(find(redundant, 'IDX1')!.fix!, /DROP INDEX `ix_a`/);

  const unique = snap({ tables: [table({ name: 't' })], columns: cols, indexes: [{ ...short, unique: true }, long] });
  assert.ok(!ids(unique).includes('IDX1'), 'a UNIQUE index is a constraint, never merely an access path');
});

test('a UNIQUE index over a nullable column permits the duplicates it exists to stop', () => {
  const s = snap({
    tables: [table({ name: 'users' })],
    columns: [col({ table: 'users', name: 'email', dataType: 'varchar', columnType: 'varchar(190)', charMaxLen: 190, nullable: true })],
    indexes: [index({ table: 'users', name: 'uk_email', unique: true, columns: [{ name: 'email', seq: 1, subPart: null, cardinality: 900 }] })],
  });
  assert.match(find(s, 'KEY3')!.why!, /NULLs as distinct/);
});

test('a non-transactional storage engine is reported', () => {
  const s = snap({
    tables: [table({ name: 'legacy', engine: 'MyISAM' })],
    columns: [col({ table: 'legacy', name: 'id' })],
    indexes: [index({ table: 'legacy', name: 'PRIMARY', unique: true, columns: [{ name: 'id', seq: 1, subPart: null, cardinality: 1 }] })],
  });
  assert.match(find(s, 'TBL1')!.fix!, /ENGINE=InnoDB/);
});

// ── references ──────────────────────────────────────────────────────────────

test('two columns match only when type, signedness, collation and width all do', () => {
  const child = col({ table: 'orders', name: 'customer_id', columnType: 'int unsigned' });
  const parent = col({ table: 'customers', name: 'id', columnType: 'int' });
  assert.match(typeMismatch(child, parent)!, /signedness differs/);
  assert.equal(typeMismatch(child, { ...child, table: 'customers', name: 'id' }), null);

  const a = col({ table: 'a', name: 'sku', dataType: 'varchar', columnType: 'varchar(64)', charMaxLen: 64, collation: 'utf8mb4_0900_ai_ci' });
  assert.match(typeMismatch(a, { ...a, collation: 'utf8mb4_bin' })!, /collation differs/);
  assert.match(typeMismatch(a, { ...a, charMaxLen: 128, columnType: 'varchar(128)' })!, /width differs/);
});

test('a declared foreign key whose sides disagree is critical', () => {
  const fk: CatalogFk = {
    name: 'fk_orders_customer', table: 'orders', column: 'customer_id',
    refTable: 'customers', refColumn: 'id', ordinal: 1, onDelete: 'RESTRICT', onUpdate: 'RESTRICT',
  };
  const s = snap({
    tables: [table({ name: 'orders' }), table({ name: 'customers' })],
    columns: [
      col({ table: 'orders', name: 'customer_id', columnType: 'int unsigned' }),
      col({ table: 'customers', name: 'id', columnType: 'int', extra: 'auto_increment' }),
    ],
    foreignKeys: [fk],
  });
  const f = find(s, 'REF1')!;
  assert.equal(f.severity, 'red');
  assert.match(f.title, /signedness differs/);
});

test('a name declared two ways across the schema is reported once, with every variant', () => {
  const s = snap({
    tables: [table({ name: 'a' }), table({ name: 'b' }), table({ name: 'c' })],
    columns: [
      col({ table: 'a', name: 'order_id', columnType: 'int' }),
      col({ table: 'b', name: 'order_id', columnType: 'int' }),
      col({ table: 'c', name: 'order_id', columnType: 'int unsigned' }),
    ],
  });
  const f = find(s, 'REF50')!;
  assert.match(f.title, /declared 2 different ways across 3 tables/);
  assert.match(f.detail, /`int` — 2×/);
  // The rulebook outranks the vote: UNSIGNED wins although it is outnumbered.
  assert.match(f.fix!, /align on int unsigned/);
});

test('vague names are never compared across tables', () => {
  const s = snap({
    tables: [table({ name: 'a' }), table({ name: 'b' })],
    columns: [
      col({ table: 'a', name: 'status', dataType: 'varchar', columnType: 'varchar(20)', charMaxLen: 20 }),
      col({ table: 'b', name: 'status', dataType: 'int', columnType: 'tinyint unsigned' }),
    ],
  });
  assert.ok(!ids(s).includes('REF50'), '`status` means something different in every table');
});

test('the recommendation prefers unsigned, then narrower', () => {
  const signed = col({ table: 'a', name: 'x', columnType: 'int' });
  const unsigned = col({ table: 'b', name: 'x', columnType: 'int unsigned' });
  assert.equal(pickRecommended([signed, unsigned]), unsigned);

  const wide = col({ table: 'a', name: 'x', dataType: 'varchar', columnType: 'varchar(255)', charMaxLen: 255 });
  const narrow = col({ table: 'b', name: 'x', dataType: 'varchar', columnType: 'varchar(64)', charMaxLen: 64 });
  assert.equal(pickRecommended([wide, narrow]), narrow);
});

// ── the whole review ────────────────────────────────────────────────────────

test('a clean schema produces nothing', () => {
  const s = snap({
    tables: [table({ name: 'orders', autoIncrement: 1000 })],
    columns: [
      col({ table: 'orders', name: 'id', columnType: 'bigint unsigned', dataType: 'bigint', extra: 'auto_increment' }),
      col({ table: 'orders', name: 'created_at', dataType: 'datetime', columnType: 'datetime(3)' }),
    ],
    indexes: [index({ table: 'orders', name: 'PRIMARY', unique: true, columns: [{ name: 'id', seq: 1, subPart: null, cardinality: 1000 }] })],
  });
  assert.deepEqual(reviewSchema(s).findings, []);
});

test('the same snapshot always produces the same report, in the same order', () => {
  const s = snap({
    tables: [table({ name: 'a', engine: 'MyISAM' }), table({ name: 'b' })],
    columns: [
      col({ table: 'a', name: 'id', columnType: 'int', extra: 'auto_increment' }),
      col({ table: 'b', name: 'total_amount', dataType: 'float', columnType: 'float' }),
    ],
  });
  const first = reviewSchema(s).findings;
  const second = reviewSchema(s).findings;
  assert.deepEqual(first, second);
  // Severest first, so the top of the report is the part that matters.
  assert.equal(first[0].severity, 'red');
});

test('the review says what it looked at, not only what it found', () => {
  const s = snap({
    tables: [table({ name: 'a' })],
    columns: [col({ table: 'a', name: 'id' })],
    indexes: [index({ table: 'a', name: 'PRIMARY', unique: true, columns: [{ name: 'id', seq: 1, subPart: null, cardinality: 1 }] })],
  });
  assert.deepEqual(reviewSchema(s).scanned, { tables: 1, columns: 1, indexes: 1, foreignKeys: 0 });
});

// ── reserved-word naming scan (the 8.0 → 8.4 upgrade check) ────────────────

test('a column named after a word reserved on this server is orange', () => {
  const s = snap({
    serverVersion: '8.0.44',
    tables: [table({ name: 'orders' })],
    columns: [col({ table: 'orders', name: 'rank', dataType: 'varchar', columnType: 'varchar(20)' })],
  });
  const f = find(s, 'NAME1')!;
  assert.equal(f.severity, 'orange');
  assert.match(f.title, /orders\.`rank`/);
  assert.match(f.title, /since MySQL 8\.0/);
});

test('a name reserved only in a LATER MySQL is the upgrade warning', () => {
  const s = snap({
    serverVersion: '8.0.44',
    tables: [table({ name: 'manual' })],
    columns: [col({ table: 'manual', name: 'id' })],
  });
  const f = find(s, 'NAME1')!;
  assert.equal(f.severity, 'yellow');
  assert.match(f.title, /becomes reserved in MySQL 8\.4/);
  assert.match(f.detail!, /8\.0/);
});

test('on 8.4 the same name is reserved now, not a future risk', () => {
  const s = snap({
    serverVersion: '8.4.3',
    tables: [table({ name: 'manual' })],
    columns: [col({ table: 'manual', name: 'id' })],
  });
  const f = find(s, 'NAME1')!;
  assert.equal(f.severity, 'orange');
  assert.match(f.title, /reserved word \(reserved since MySQL 8\.4\)/);
});

test('the 9.x reservations are known too (LIBRARY 9.2, EXTERNAL 9.4, SETS 9.6)', () => {
  const mk = (name: string, serverVersion: string) => snap({
    serverVersion,
    tables: [table({ name: 't' })],
    columns: [col({ table: 't', name, dataType: 'varchar', columnType: 'varchar(10)' })],
  });
  // before the reservation: the upgrade warning
  assert.match(find(mk('library', '9.1.0'), 'NAME1')!.title, /becomes reserved in MySQL 9\.2/);
  assert.match(find(mk('external', '9.3.0'), 'NAME1')!.title, /becomes reserved in MySQL 9\.4/);
  assert.match(find(mk('sets', '9.5.0'), 'NAME1')!.title, /becomes reserved in MySQL 9\.6/);
  // at/after it: reserved now
  assert.equal(find(mk('library', '9.2.0'), 'NAME1')!.severity, 'orange');
  assert.equal(find(mk('sets', '26.7.0'), 'NAME1')!.severity, 'orange');
});

test('MANUAL/PARALLEL were de-reserved in 9.7.2 — no finding from then on', () => {
  for (const name of ['manual', 'parallel']) {
    for (const serverVersion of ['9.7.2', '26.7.0']) {
      const s = snap({
        serverVersion,
        tables: [table({ name })],
        columns: [col({ table: name, name: 'id' })],
      });
      assert.equal(find(s, 'NAME1'), undefined, `${name} on ${serverVersion} is not reserved`);
    }
    // but on 9.7.1 the reservation still applies
    const s = snap({
      serverVersion: '9.7.1',
      tables: [table({ name })],
      columns: [col({ table: name, name: 'id' })],
    });
    assert.equal(find(s, 'NAME1')!.severity, 'orange', `${name} on 9.7.1 is still reserved`);
  }
});

test('MariaDB never took the 8.0/8.4 reservations — no false alarm', () => {
  const s = snap({
    serverVersion: '10.11.8-MariaDB',
    tables: [table({ name: 'manual' })],
    columns: [
      col({ table: 'manual', name: 'rank' }),
      // long-reserved words are still flagged on MariaDB
      col({ table: 'manual', name: 'select', dataType: 'varchar', columnType: 'varchar(10)' }),
    ],
  });
  const findings = reviewSchema(s).findings.filter(f => f.id === 'NAME1');
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /`select`/);
  assert.equal(findings[0].severity, 'orange');
});

test('an unknown version treats a newer reserved word as reserved now', () => {
  const s = snap({
    serverVersion: null,
    tables: [table({ name: 'qualify' })],
    columns: [col({ table: 'qualify', name: 'id' })],
  });
  const f = find(s, 'NAME1')!;
  assert.equal(f.severity, 'orange');
});

test('ordinary names produce no naming finding', () => {
  const s = snap({
    serverVersion: '8.0.44',
    tables: [table({ name: 'orders' })],
    columns: [col({ table: 'orders', name: 'order_status', dataType: 'varchar', columnType: 'varchar(20)' })],
  });
  assert.equal(find(s, 'NAME1'), undefined);
});

// ── the PostgreSQL rulebook ─────────────────────────────────────────────────
//
// The PG rules are re-derived, not re-labelled: MySQL-only judgements
// (signedness, charset chain, 2038, InnoDB index mechanics) must NOT fire on
// a PG snapshot, and the PG rules must NOT fire on a MySQL one. The fixture
// is shaped the way PG_SNAPSHOT_SQL + the mappers deliver it.

function pgCol(over: Partial<CatalogColumn> & { table: string; name: string }): CatalogColumn {
  return col({
    dataType: 'int', columnType: 'integer', nullable: false,
    ...over,
  });
}
function pgTable(over: Partial<CatalogTable> & { name: string }): CatalogTable {
  return table({ engine: 'logged', collation: null, ...over });
}
function pgSnap(over: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return snap({
    engine: 'postgres', schema: 'public',
    serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null,
    serverVersion: '16.4',
    statsSource: 'pg_stat_user_tables + pg_relation_size',
    ...over,
  });
}
const pgFind = (s: SchemaSnapshot, id: string) => reviewSchema(s).findings.filter(f => f.id === id);

test('PG: sequence headroom follows the column range, not the int8 sequence', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 'orders', autoIncrement: 2_100_000_000 })],
    columns: [pgCol({ table: 'orders', name: 'id', extra: 'identity' })],
  });
  const [f] = pgFind(s, 'SEQ1');
  assert.equal(f.severity, 'red', '97% of the int4 range');
  assert.match(f.fix!, /ALTER COLUMN "id" TYPE bigint/);
});

test('PG: below 20% used, and unknown last values, stay silent', () => {
  const low = pgSnap({
    tables: [pgTable({ name: 'orders', autoIncrement: 1000 })],
    columns: [pgCol({ table: 'orders', name: 'id', extra: 'identity' })],
  });
  assert.equal(pgFind(low, 'SEQ1').length, 0);
  const unknown = pgSnap({
    tables: [pgTable({ name: 'orders', autoIncrement: null })],
    columns: [pgCol({ table: 'orders', name: 'id', extra: 'serial' })],
  });
  assert.equal(pgFind(unknown, 'SEQ1').length, 0);
});

test('PG: timestamp without time zone is flagged; timestamptz is not', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 'events' })],
    columns: [
      pgCol({ table: 'events', name: 'created_at', dataType: 'timestamp', columnType: 'timestamp without time zone', nullable: true }),
      pgCol({ table: 'events', name: 'seen_at', dataType: 'timestamptz', columnType: 'timestamp with time zone', nullable: true }),
    ],
  });
  const f = pgFind(s, 'TIME2');
  assert.equal(f.length, 1);
  assert.match(f[0].title, /created_at/);
  assert.match(f[0].fix!, /timestamptz/);
});

test('PG: the money type is orange, with the locale reasoning', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 'prices' })],
    columns: [pgCol({ table: 'prices', name: 'unit_price', dataType: 'money', columnType: 'money', nullable: true })],
  });
  const [f] = pgFind(s, 'NUM2');
  assert.equal(f.severity, 'orange');
  assert.match(f.detail, /lc_monetary/);
});

test('PG: serial raises the identity note; a true identity column does not', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 'a' }), pgTable({ name: 'b' })],
    columns: [
      pgCol({ table: 'a', name: 'id', extra: 'serial' }),
      pgCol({ table: 'b', name: 'id', extra: 'identity' }),
    ],
  });
  const f = pgFind(s, 'TYP1');
  assert.equal(f.length, 1);
  assert.match(f[0].title, /^a\./);
});

test('PG: blank-padded char(n) is flagged; varchar is not', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 't' })],
    columns: [
      pgCol({ table: 't', name: 'code', dataType: 'char', columnType: 'character(8)', charMaxLen: 8, nullable: true }),
      pgCol({ table: 't', name: 'label', dataType: 'varchar', columnType: 'character varying(8)', charMaxLen: 8, nullable: true }),
    ],
  });
  const f = pgFind(s, 'TYP2');
  assert.equal(f.length, 1);
  assert.match(f[0].title, /char\(8\)/);
});

test('PG: varchar(255) is the reflex-width note, varchar(64) is not', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 't' })],
    columns: [
      pgCol({ table: 't', name: 'sku', dataType: 'varchar', columnType: 'character varying(255)', charMaxLen: 255, nullable: true }),
      pgCol({ table: 't', name: 'city', dataType: 'varchar', columnType: 'character varying(64)', charMaxLen: 64, nullable: true }),
    ],
  });
  const f = pgFind(s, 'TYP3');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.match(f[0].title, /sku/);
});

test('PG: text named like JSON is an inferred note', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 't' })],
    columns: [pgCol({ table: 't', name: 'payload_json', dataType: 'text', columnType: 'text', nullable: true })],
  });
  const [f] = pgFind(s, 'TYP4');
  assert.equal(f.confidence, 'inferred');
});

test('PG: an unlogged table is the engine-rule twin', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 'staging', engine: 'unlogged' })],
    columns: [pgCol({ table: 'staging', name: 'id' })],
  });
  const [f] = pgFind(s, 'TBL2');
  assert.equal(f.severity, 'orange');
  assert.match(f.fix!, /SET LOGGED/);
});

test('PG: a NOT VALID foreign key is named, with VALIDATE as the fix', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 'orders' }), pgTable({ name: 'lines' })],
    columns: [
      pgCol({ table: 'orders', name: 'id' }),
      pgCol({ table: 'lines', name: 'order_id', dataType: 'int', columnType: 'integer' }),
    ],
    foreignKeys: [{
      name: 'lines_order_fk', table: 'lines', column: 'order_id',
      refTable: 'orders', refColumn: 'id', ordinal: 1,
      onDelete: 'NO ACTION', onUpdate: 'NO ACTION', validated: false,
    }],
  });
  const [f] = pgFind(s, 'FKV1');
  assert.equal(f.severity, 'yellow');
  assert.match(f.fix!, /VALIDATE CONSTRAINT "lines_order_fk"/);
});

test('PG: a FK the child side has no index for is orange — PG builds none', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 'orders' }), pgTable({ name: 'lines' })],
    columns: [
      pgCol({ table: 'orders', name: 'id' }),
      pgCol({ table: 'lines', name: 'id' }),
      pgCol({ table: 'lines', name: 'order_id' }),
    ],
    indexes: [
      index({ table: 'orders', name: 'PRIMARY', columns: [{ name: 'id', seq: 1, subPart: null, cardinality: null }], unique: true }),
      index({ table: 'lines', name: 'PRIMARY', columns: [{ name: 'id', seq: 1, subPart: null, cardinality: null }], unique: true }),
    ],
    foreignKeys: [{
      name: 'lines_order_fk', table: 'lines', column: 'order_id',
      refTable: 'orders', refColumn: 'id', ordinal: 1,
      onDelete: 'CASCADE', onUpdate: 'NO ACTION',
    }],
  });
  const [f] = pgFind(s, 'FKS1');
  assert.equal(f.severity, 'orange');
  assert.match(f.fix!, /CREATE INDEX ON "lines" \("order_id"\)/);

  // A leading index on the FK column satisfies it.
  const covered = pgSnap({
    tables: [pgTable({ name: 'orders' }), pgTable({ name: 'lines' })],
    columns: [
      pgCol({ table: 'orders', name: 'id' }),
      pgCol({ table: 'lines', name: 'id' }),
      pgCol({ table: 'lines', name: 'order_id' }),
    ],
    indexes: [
      index({ table: 'lines', name: 'PRIMARY', columns: [{ name: 'id', seq: 1, subPart: null, cardinality: null }], unique: true }),
      index({
        table: 'lines', name: 'lines_order_id_idx', columns: [
          { name: 'order_id', seq: 1, subPart: null, cardinality: null },
          { name: 'id', seq: 2, subPart: null, cardinality: null },
        ],
      }),
    ],
    foreignKeys: [{
      name: 'lines_order_fk', table: 'lines', column: 'order_id',
      refTable: 'orders', refColumn: 'id', ordinal: 1,
      onDelete: 'CASCADE', onUpdate: 'NO ACTION',
    }],
  });
  assert.equal(pgFind(covered, 'FKS1').length, 0);
});

test('PG: reserved-word names are graded by PG strictness, not MySQL windows', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 'user' }), pgTable({ name: 'rankings' })],
    columns: [
      pgCol({ table: 'user', name: 'id' }),
      pgCol({ table: 'rankings', name: 'rank' }),
      pgCol({ table: 'rankings', name: 'team_id' }),
    ],
  });
  const f = pgFind(s, 'NAME1');
  // `user` — fully reserved on PG: orange. `rank` — reserved only on
  // MySQL: yellow. `team_id` — clean.
  assert.equal(f.length, 2);
  assert.equal(f.find(x => x.title.includes('"user"'))!.severity, 'orange');
  assert.equal(f.find(x => x.title.includes('"rank"'))!.severity, 'yellow');
});

test('PG: MySQL-only rules stay home — no unsigned, charset, or 2038 noise', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 't', autoIncrement: 3_000_000_000 })],
    columns: [
      // signed int identity: would be INT1/INT3 on MySQL
      pgCol({ table: 't', name: 'id', extra: 'identity' }),
      // timestamp: would be TIME1 (2038) on MySQL
      pgCol({ table: 't', name: 'expires_at', dataType: 'timestamp', columnType: 'timestamp without time zone', nullable: true }),
    ],
  });
  const found = reviewSchema(s).findings.map(f => f.id);
  for (const mysqlOnly of ['INT1', 'INT2', 'INT3', 'TIME1', 'CHR4', 'CHR5', 'CHR13', 'TBL1', 'KEY2', 'IDX50', 'STR1']) {
    assert.ok(!found.includes(mysqlOnly), `${mysqlOnly} must not fire on PostgreSQL`);
  }
  // …and the PG rules that DO apply are there instead.
  assert.ok(found.includes('SEQ1'));
  assert.ok(found.includes('TIME2'));
});

test('PG: the PG-only rules stay home on MySQL', () => {
  const s = snap({
    tables: [table({ name: 't', autoIncrement: 3_000_000_000 })],
    columns: [col({ table: 't', name: 'id', dataType: 'int', columnType: 'int', extra: 'auto_increment' })],
  });
  const found = reviewSchema(s).findings.map(f => f.id);
  for (const pgOnly of ['SEQ1', 'TIME2', 'NUM2', 'TYP1', 'TYP2', 'TYP3', 'TYP4', 'TBL2', 'FKV1', 'FKS1']) {
    assert.ok(!found.includes(pgOnly), `${pgOnly} must not fire on MySQL`);
  }
  assert.ok(found.includes('INT3'), 'the MySQL headroom rule still fires');
});

test('PG: engine-neutral rules still run — no PK, redundant index, UNIQUE over nullable', () => {
  const s = pgSnap({
    tables: [pgTable({ name: 'nopk' }), pgTable({ name: 'dupe' })],
    columns: [
      pgCol({ table: 'nopk', name: 'payload', dataType: 'text', columnType: 'text', nullable: true }),
      pgCol({ table: 'dupe', name: 'a', dataType: 'int', columnType: 'integer' }),
      pgCol({ table: 'dupe', name: 'b', dataType: 'int', columnType: 'integer' }),
      pgCol({ table: 'dupe', name: 'email', dataType: 'text', columnType: 'text', nullable: true }),
    ],
    indexes: [
      index({ table: 'dupe', name: 'PRIMARY', columns: [{ name: 'a', seq: 1, subPart: null, cardinality: null }], unique: true }),
      index({ table: 'dupe', name: 'ix_a', columns: [{ name: 'a', seq: 1, subPart: null, cardinality: null }] }),
      index({
        table: 'dupe', name: 'ix_ab', columns: [
          { name: 'a', seq: 1, subPart: null, cardinality: null },
          { name: 'b', seq: 2, subPart: null, cardinality: null },
        ],
      }),
      index({ table: 'dupe', name: 'uq_email', columns: [{ name: 'email', seq: 1, subPart: null, cardinality: null }], unique: true }),
    ],
  });
  const found = reviewSchema(s).findings;
  assert.match(found.find(f => f.id === 'KEY1')!.why!, /REPLICA IDENTITY/, 'the PG no-PK wording');
  const idx1 = found.find(f => f.id === 'IDX1')!;
  assert.match(idx1.fix!, /^DROP INDEX "ix_a";$/, 'the PG drop syntax');
  assert.match(found.find(f => f.id === 'KEY3')!.why!, /NULLS NOT DISTINCT/, 'the PG nullable-unique wording');
});

// ── WP-08 8.6: MySQL fix SQL quotes identifiers with escape-doubling ────────
// A backtick in a table name must double inside the identifier, never break
// out of it. (The PG branches already used quoteIdent; the MySQL fix strings
// interpolated raw backticks.)

test('a backtick in a table name is doubled in generated fix SQL', () => {
  const s = snap({ tables: [table({ name: 'a`b', engine: 'MyISAM' })] });
  const engineFix = reviewSchema(s).findings.find(f => f.fix?.includes('ENGINE=InnoDB'));
  assert.ok(engineFix, 'expected a storage-engine finding');
  assert.match(engineFix!.fix!, /ALTER TABLE `a``b` ENGINE=InnoDB;/);
});
