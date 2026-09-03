/**
 * SQLite table designer dialect (src/utils/sqliteTableDesign.ts).
 *
 * The promise being pinned down: SQLite has no ALTER COLUMN, so the diff
 * either stays inside what ALTER TABLE can genuinely do, or it emits the
 * 12-step rebuild as one labelled script — never a silent stand-in, and never
 * an `ALTER COLUMN` that does not exist.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sqliteCreateProblems, sqliteCreateTableSql, sqliteDiffTable, sqliteParseTableSql,
  sqliteRebuildScript, SQLITE_STRICT_TYPES,
} from '../src/utils/sqliteTableDesign.ts';
import { changesToScript, type ColumnDraft, type TableDraft } from '../src/utils/tableDesign.ts';

const col = (name: string, type: string, over: Partial<ColumnDraft> = {}): ColumnDraft =>
  ({ name, type, nullable: true, default: null, ...over });

const tbl = (over: Partial<TableDraft> = {}): TableDraft => ({
  name: 'orders',
  columns: [col('id', 'INTEGER', { nullable: false }), col('note', 'TEXT')],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  ...over,
});

const find = (cs: ReturnType<typeof sqliteDiffTable>, subject: string) =>
  cs.find(c => c.subject === subject)!;
const kinds = (cs: ReturnType<typeof sqliteDiffTable>) => cs.map(c => c.kind);

// ── CREATE TABLE ─────────────────────────────────────────────────────────────

describe('creating a SQLite table', () => {
  test('columns, primary key and foreign keys are inline; indexes are separate', () => {
    const d = tbl({
      foreignKeys: [{ name: 'fk_c', columns: ['id'], refTable: 'customers', refColumns: ['id'],
        onDelete: 'CASCADE' }],
      indexes: [{ name: 'ix_note', columns: ['note'], unique: false }],
    });
    const cs = sqliteDiffTable(null, d, 'main');
    assert.deepEqual(kinds(cs), ['create-table', 'add-index']);
    assert.match(cs[0].sql, /CREATE TABLE "main"\."orders"/);
    assert.match(cs[0].sql, /PRIMARY KEY \("id"\)/);
    assert.match(cs[0].sql, /CONSTRAINT "fk_c" FOREIGN KEY \("id"\) REFERENCES "customers" \("id"\) ON DELETE CASCADE/);
    assert.match(cs[1].sql, /CREATE INDEX "main"\."ix_note" ON "orders" \("note"\)/);
  });

  test('STRICT and WITHOUT ROWID are trailing options', () => {
    const sql = sqliteCreateTableSql(tbl({ strict: true, withoutRowid: true }), 'main');
    assert.match(sql, /\) STRICT, WITHOUT ROWID$/);
  });

  test('generated columns keep both kinds — SQLite has VIRTUAL and STORED', () => {
    const d = tbl({ columns: [
      col('price', 'REAL'), col('qty', 'REAL'),
      col('total', 'REAL', { generated: 'price*qty' }),
      col('total2', 'REAL', { generated: 'price*qty', generatedStored: true }),
    ], primaryKey: [] });
    const sql = sqliteCreateTableSql(d, 'main');
    assert.match(sql, /"total" REAL GENERATED ALWAYS AS \(price\*qty\) VIRTUAL/);
    assert.match(sql, /"total2" REAL GENERATED ALWAYS AS \(price\*qty\) STORED/);
  });

  /// STRICT's type list is the server's rule, caught before the round trip.
  test('a STRICT table with a non-affinity type is refused, not shipped', () => {
    const d = tbl({ strict: true, columns: [col('v', 'VARCHAR(10)')], primaryKey: [] });
    const problems = sqliteCreateProblems(d);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /VARCHAR/);
    const cs = sqliteDiffTable(null, d, 'main');
    assert.equal(cs[0].sql, '');
    assert.ok(cs[0].blocked);
  });

  test('the affinity set itself passes', () => {
    for (const t of SQLITE_STRICT_TYPES) {
      assert.equal(sqliteCreateProblems(
        tbl({ strict: true, columns: [col('v', t)], primaryKey: [] })).length, 0, t);
    }
  });

  test('WITHOUT ROWID without a primary key is refused', () => {
    const d = tbl({ withoutRowid: true, primaryKey: [] });
    assert.match(sqliteCreateProblems(d)[0], /primary key/);
  });
});

// ── Reading sqlite_master.sql back ───────────────────────────────────────────

describe('sqliteParseTableSql', () => {
  test('finds generated expressions, STRICT and WITHOUT ROWID', () => {
    const info = sqliteParseTableSql(
      `CREATE TABLE "t" ("a" INTEGER PRIMARY KEY, "b" TEXT, `
      + `"c" REAL GENERATED ALWAYS AS ("a" * 2) VIRTUAL, `
      + `"d" TEXT AS (upper("b")) STORED, CONSTRAINT "ck" CHECK ("a" > 0)) STRICT, WITHOUT ROWID`);
    assert.equal(info.strict, true);
    assert.equal(info.withoutRowid, true);
    assert.deepEqual(info.generated.c, { expr: '"a" * 2', stored: false });
    assert.deepEqual(info.generated.d, { expr: 'upper("b")', stored: true });
    assert.equal(info.generated.a, undefined);
  });

  test('a plain table yields nothing', () => {
    const info = sqliteParseTableSql('CREATE TABLE t (a INT, b TEXT)');
    assert.deepEqual(info, { generated: {}, strict: false, withoutRowid: false });
  });

  /// Caught by executing the generated SQL, not by reading it: SQLite's
  /// grammar is `CREATE INDEX [schema.]ix ON table` — qualifying the TABLE in
  /// the ON clause is a syntax error.
  test('the ON clause of CREATE INDEX never qualifies the table', () => {
    const d = tbl({ indexes: [{ name: 'ix_note', columns: ['note'], unique: false }] });
    const cs = sqliteDiffTable(null, d, 'main');
    assert.match(cs[1].sql, /CREATE INDEX "main"\."ix_note" ON "orders"/);
    assert.doesNotMatch(cs[1].sql, /ON "main"\./);
  });

  /// Commas and parens inside strings/defaults must not split the column list.
  test('punctuation inside strings does not break the parse', () => {
    const info = sqliteParseTableSql(
      `CREATE TABLE t (a TEXT DEFAULT 'x,(y)', b TEXT AS (a || ',') STORED)`);
    assert.deepEqual(info.generated.b, { expr: "a || ','", stored: true });
  });
});

// ── Incremental ALTER ────────────────────────────────────────────────────────

describe('what ALTER TABLE can do', () => {
  test('adding a nullable column is safe metadata', () => {
    const next = tbl({ columns: [...tbl().columns, col('extra', 'INTEGER')] });
    const c = find(sqliteDiffTable(tbl(), next, 'main'), 'extra');
    assert.equal(c.risk, 'safe');
    assert.equal(c.cost, 'metadata');
    assert.match(c.sql, /ALTER TABLE "main"\."orders" ADD COLUMN "extra" INTEGER/);
  });

  /// SQLite's own rule, not a guess: NOT NULL needs a non-null default.
  test('adding NOT NULL without a default is flagged before it runs', () => {
    const next = tbl({ columns: [...tbl().columns, col('extra', 'INTEGER', { nullable: false })] });
    const c = find(sqliteDiffTable(tbl(), next, 'main'), 'extra');
    assert.equal(c.risk, 'lossy');
    assert.match(c.warning!, /refuses ADD COLUMN/);
  });

  test('renaming a column is safe (3.25+)', () => {
    const next = tbl({ columns: [tbl().columns[0], col('memo', 'TEXT', { originalName: 'note' })] });
    const cs = sqliteDiffTable(tbl(), next, 'main');
    assert.deepEqual(kinds(cs), ['rename-column']);
    assert.match(cs[0].sql, /RENAME COLUMN "note" TO "memo"/);
  });

  test('dropping a column is destructive but native (3.35+, and TxUI bundles 3.51.3)', () => {
    const next = tbl({ columns: [tbl().columns[0]] });
    const c = find(sqliteDiffTable(tbl(), next, 'main'), 'note');
    assert.equal(c.risk, 'destructive');
    assert.match(c.sql, /DROP COLUMN "note"/);
    assert.match(c.warning!, /3\.51\.3/);
  });

  test('renaming the table is ALTER TABLE … RENAME TO a bare name', () => {
    const cs = sqliteDiffTable(tbl(), tbl({ name: 'orders_v2', originalName: 'orders' }), 'main');
    assert.match(cs[0].sql, /ALTER TABLE "main"\."orders" RENAME TO "orders_v2"/);
    /// A schema-qualified rename target is a syntax error in SQLite.
    assert.doesNotMatch(cs[0].sql, /RENAME TO "main"\./);
  });

  test('index changes are schema-level DROP/CREATE INDEX', () => {
    const before = tbl({ indexes: [{ name: 'ix', columns: ['note'], unique: false }] });
    const after = tbl({ indexes: [{ name: 'ix', columns: ['id', 'note'], unique: false }] });
    const cs = sqliteDiffTable(before, after, 'main');
    assert.deepEqual(kinds(cs), ['drop-index', 'add-index']);
    assert.match(cs[0].sql, /DROP INDEX "main"\."ix"/);
    assert.match(cs[1].sql, /CREATE INDEX "main"\."ix" ON "orders" \("id", "note"\)/);
  });
});

// ── The rebuild ──────────────────────────────────────────────────────────────

describe('what requires the 12-step rebuild', () => {
  /// The one thing this dialect must never do.
  test('no path ever emits ALTER COLUMN', () => {
    const narrowed = tbl({ columns: [tbl().columns[0], col('note', 'INT')] });
    const cs = sqliteDiffTable(tbl(), narrowed, 'main');
    assert.ok(!changesToScript(cs).match(/ALTER COLUMN/i), changesToScript(cs));
  });

  test('a type change rebuilds: new table, copy, drop, rename', () => {
    const next = tbl({ columns: [tbl().columns[0], col('note', 'INT')] });
    const cs = sqliteDiffTable(tbl(), next, 'main');
    assert.deepEqual(kinds(cs), ['rebuild-table']);
    const c = cs[0];
    assert.equal(c.risk, 'destructive');
    assert.equal(c.cost, 'rebuild');
    assert.match(c.warning!, /12-step rebuild/);
    assert.match(c.warning!, /no ALTER COLUMN/);
    const s = c.sql;
    assert.match(s, /^PRAGMA foreign_keys=OFF/);
    assert.match(s, /CREATE TABLE "main"\."__txui_rebuild_orders"/);
    assert.match(s, /"note" INT/);
    assert.match(s, /INSERT INTO "main"\."__txui_rebuild_orders" \("id", "note"\)\n {2}SELECT "id", "note" FROM "main"\."orders"/);
    assert.match(s, /DROP TABLE "main"\."orders"/);
    assert.match(s, /ALTER TABLE "main"\."__txui_rebuild_orders" RENAME TO "orders"/);
    assert.match(s, /PRAGMA foreign_keys=ON$/);
    /// The order is load-bearing: keys off first, keys back on last, and the
    /// copy must exist before the original is dropped.
    assert.ok(s.indexOf('foreign_keys=OFF') < s.indexOf('CREATE TABLE'));
    assert.ok(s.indexOf('INSERT INTO') < s.indexOf('DROP TABLE'));
    assert.ok(s.indexOf('DROP TABLE') < s.indexOf('RENAME TO'));
  });

  test('nullability, default and generated-expression changes rebuild too', () => {
    for (const next of [
      tbl({ columns: [tbl().columns[0], col('note', 'TEXT', { nullable: false })] }),
      tbl({ columns: [tbl().columns[0], col('note', 'TEXT', { default: "'x'" })] }),
      tbl({ columns: [tbl().columns[0], col('note', 'TEXT', { generated: 'upper(id)' })] }),
    ]) {
      assert.deepEqual(kinds(sqliteDiffTable(tbl(), next, 'main')), ['rebuild-table']);
    }
  });

  test('primary key, foreign key and STRICT/WITHOUT ROWID changes rebuild', () => {
    assert.deepEqual(kinds(sqliteDiffTable(tbl(), tbl({ primaryKey: ['id', 'note'] }), 'main')),
      ['rebuild-table']);
    assert.deepEqual(kinds(sqliteDiffTable(tbl(), tbl({
      foreignKeys: [{ name: 'f', columns: ['id'], refTable: 'c', refColumns: ['id'] }],
    }), 'main')), ['rebuild-table']);
    assert.deepEqual(kinds(sqliteDiffTable(tbl(), tbl({ strict: true }), 'main')), ['rebuild-table']);
    assert.deepEqual(kinds(sqliteDiffTable(tbl(), tbl({ withoutRowid: true }), 'main')),
      ['rebuild-table']);
  });

  test('adding a STORED generated column rebuilds — ALTER cannot add one', () => {
    const next = tbl({ columns: [...tbl().columns,
      col('big', 'TEXT', { generated: 'upper(note)', generatedStored: true })] });
    assert.deepEqual(kinds(sqliteDiffTable(tbl(), next, 'main')), ['rebuild-table']);
  });

  test('a VIRTUAL generated column adds incrementally — ALTER can do that one', () => {
    const next = tbl({ columns: [...tbl().columns, col('big', 'TEXT', { generated: 'upper(note)' })] });
    const cs = sqliteDiffTable(tbl(), next, 'main');
    assert.deepEqual(kinds(cs), ['add-column']);
    assert.match(cs[0].sql, /ADD COLUMN "big" TEXT GENERATED ALWAYS AS \(upper\(note\)\) VIRTUAL/);
  });

  test('the rebuild recreates the draft indexes after the rename', () => {
    const next = tbl({
      columns: [tbl().columns[0], col('note', 'INT')],
      indexes: [{ name: 'ix_note', columns: ['note'], unique: true }],
    });
    const s = find(sqliteDiffTable(tbl(), next, 'main'), 'orders').sql;
    assert.match(s, /RENAME TO "orders";\nCREATE UNIQUE INDEX "main"\."ix_note" ON "orders" \("note"\)/);
  });

  test('a rename folded into a rebuild maps the data by original name', () => {
    const next = tbl({
      name: 'orders_v2', originalName: 'orders',
      columns: [tbl().columns[0], col('memo', 'INT', { originalName: 'note' })],
    });
    const cs = sqliteDiffTable(tbl(), next, 'main');
    assert.deepEqual(kinds(cs), ['rebuild-table'], 'no separate rename — the rebuild lands on the new name');
    assert.match(cs[0].sql, /INSERT INTO "main"\."__txui_rebuild_orders" \("id", "memo"\)\n {2}SELECT "id", "note"/);
    assert.match(cs[0].sql, /RENAME TO "orders_v2"/);
  });

  /// The copy cannot invent values: a new NOT NULL defaultless column in a
  /// rebuild has nothing to be, so the change is blocked, not emitted broken.
  test('a rebuild with a new NOT NULL defaultless column is blocked', () => {
    const next = tbl({ columns: [
      tbl().columns[0], col('note', 'INT'),
      col('must', 'INTEGER', { nullable: false }),
    ] });
    const cs = sqliteDiffTable(tbl(), next, 'main');
    assert.deepEqual(kinds(cs), ['rebuild-table']);
    assert.equal(cs[0].sql, '');
    assert.match(cs[0].blocked!, /nothing to put there/);
  });

  test('a genuinely new column is copied as its default, not a source column', () => {
    const next = tbl({ columns: [
      tbl().columns[0], col('note', 'INT'),
      col('extra', 'TEXT', { default: "'new'" }),
    ] });
    const s = find(sqliteDiffTable(tbl(), next, 'main'), 'orders').sql;
    assert.match(s, /INSERT INTO "main"\."__txui_rebuild_orders" \("id", "note"\)/);
    assert.doesNotMatch(s, /SELECT.*"extra"/);
  });

  test('sqliteRebuildScript is exported for direct testing of the pattern', () => {
    const s = sqliteRebuildScript(tbl(), tbl({ columns: [tbl().columns[0], col('note', 'INT')] }), 'main');
    assert.match(s, /PRAGMA foreign_keys=OFF/);
    assert.match(s, /PRAGMA foreign_keys=ON/);
  });
});
