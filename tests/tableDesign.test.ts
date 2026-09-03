/**
 * Table designer change sets (src/utils/tableDesign.ts).
 *
 * The safety model in one line: editing a draft produces a *proposal*, never an
 * action. These tests are mostly about the risk labels, because a change
 * mislabelled safe is the one that costs someone their data.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  changesToScript, createTableSql, diffTable, isWidening, parseType, summarise,
  defaultConstraintName,
  type ColumnDraft, type TableDraft,
} from '../src/utils/tableDesign.ts';

const col = (name: string, type: string, over: Partial<ColumnDraft> = {}): ColumnDraft =>
  ({ name, type, nullable: true, default: null, ...over });

const tbl = (over: Partial<TableDraft> = {}): TableDraft => ({
  name: 'orders',
  columns: [col('id', 'INT', { nullable: false }), col('note', 'VARCHAR(100)')],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  ...over,
});

const kinds = (cs: ReturnType<typeof diffTable>) => cs.map(c => c.kind);
const find = (cs: ReturnType<typeof diffTable>, subject: string) =>
  cs.find(c => c.subject === subject)!;

describe('parseType', () => {
  test('splits base and arguments', () => {
    assert.deepEqual(parseType('VARCHAR(255)'), { base: 'varchar', args: [255] });
    assert.deepEqual(parseType('numeric(10,2)'), { base: 'numeric', args: [10, 2] });
    assert.deepEqual(parseType('INT'), { base: 'int', args: [] });
  });

  test('unsigned and spacing do not change the base', () => {
    assert.equal(parseType('BIGINT UNSIGNED').base, 'bigint');
    assert.equal(parseType('  double  precision ').base, 'double precision');
  });
});

describe('isWidening', () => {
  test('a longer varchar is safe, a shorter one is not', () => {
    assert.equal(isWidening('VARCHAR(50)', 'VARCHAR(100)'), true);
    assert.equal(isWidening('VARCHAR(100)', 'VARCHAR(50)'), false);
    assert.equal(isWidening('VARCHAR(50)', 'VARCHAR(50)'), true);
  });

  test('climbing the integer ladder is safe, descending is not', () => {
    assert.equal(isWidening('INT', 'BIGINT'), true);
    assert.equal(isWidening('TINYINT', 'INT'), true);
    assert.equal(isWidening('BIGINT', 'INT'), false);
  });

  test('char to varchar to text is safe in that direction only', () => {
    assert.equal(isWidening('CHAR(10)', 'VARCHAR(10)'), true);
    assert.equal(isWidening('VARCHAR(10)', 'TEXT'), true);
    assert.equal(isWidening('TEXT', 'VARCHAR(10)'), false);
  });

  test('fewer decimal places is not widening', () => {
    assert.equal(isWidening('NUMERIC(10,4)', 'NUMERIC(10,2)'), false);
    assert.equal(isWidening('NUMERIC(10,2)', 'NUMERIC(12,2)'), true);
  });

  /// Conservative by design: anything unprovable is lossy. Being told a safe
  /// change might truncate costs a moment; the reverse costs the data.
  test('an unrelated change is never called safe', () => {
    assert.equal(isWidening('VARCHAR(10)', 'INT'), false);
    assert.equal(isWidening('DATETIME', 'DATE'), false);
    assert.equal(isWidening('JSON', 'TEXT'), false);
  });
});

describe('creating a table', () => {
  test('emits columns, primary key and options', () => {
    const sql = createTableSql(
      tbl({ engine: 'InnoDB', charset: 'utf8mb4' }), 'shop', 'mysql');
    assert.match(sql, /CREATE TABLE `shop`\.`orders`/);
    assert.match(sql, /`id` INT NOT NULL/);
    assert.match(sql, /PRIMARY KEY \(`id`\)/);
    assert.match(sql, /ENGINE=InnoDB/);
    assert.match(sql, /DEFAULT CHARSET=utf8mb4/);
  });

  test('a create is one safe change', () => {
    const cs = diffTable(null, tbl(), 'shop', 'mysql');
    assert.deepEqual(kinds(cs), ['create-table']);
    assert.equal(cs[0].risk, 'safe');
  });

  /// PostgreSQL has no inline index syntax in CREATE TABLE.
  test('postgres gets its indexes as separate statements', () => {
    const d = tbl({ indexes: [{ name: 'ix_note', columns: ['note'], unique: false }] });
    const cs = diffTable(null, d, 'public', 'postgres');
    assert.deepEqual(kinds(cs), ['create-table', 'add-index']);
    assert.ok(!cs[0].sql.includes('KEY `ix_note`'));
    assert.match(cs[1].sql, /CREATE INDEX "ix_note" ON "public"\."orders"/);
  });

  test('AUTO_INCREMENT is MySQL-only — emitting it on postgres would be invalid', () => {
    const d = tbl({ columns: [col('id', 'INT', { nullable: false, autoIncrement: true })] });
    assert.match(createTableSql(d, 's', 'mysql'), /AUTO_INCREMENT/);
    assert.ok(!createTableSql(d, 's', 'postgres').includes('AUTO_INCREMENT'));
  });
});

describe('adding a column', () => {
  test('a nullable column is safe', () => {
    const cs = diffTable(tbl(), tbl({ columns: [...tbl().columns, col('extra', 'INT')] }), 's', 'mysql');
    assert.equal(find(cs, 'extra').risk, 'safe');
    assert.match(find(cs, 'extra').sql, /ADD COLUMN `extra` INT/);
  });

  /// The server rejects this on a non-empty table rather than inventing
  /// values, and finding that out at apply time is a wasted round trip.
  test('NOT NULL with no default is flagged before it is run', () => {
    const next = tbl({ columns: [...tbl().columns, col('extra', 'INT', { nullable: false })] });
    const c = find(diffTable(tbl(), next, 's', 'mysql'), 'extra');
    assert.equal(c.risk, 'lossy');
    assert.match(c.warning!, /refuse this if the table has any rows/);
  });

  test('NOT NULL with a default is safe', () => {
    const next = tbl({
      columns: [...tbl().columns, col('extra', 'INT', { nullable: false, default: '0' })],
    });
    assert.equal(find(diffTable(tbl(), next, 's', 'mysql'), 'extra').risk, 'safe');
  });
});

describe('modifying a column', () => {
  test('widening is safe', () => {
    const next = tbl({ columns: [tbl().columns[0], col('note', 'VARCHAR(500)')] });
    assert.equal(find(diffTable(tbl(), next, 's', 'mysql'), 'note').risk, 'safe');
  });

  test('narrowing is lossy and says why', () => {
    const next = tbl({ columns: [tbl().columns[0], col('note', 'VARCHAR(10)')] });
    const c = find(diffTable(tbl(), next, 's', 'mysql'), 'note');
    assert.equal(c.risk, 'lossy');
    assert.match(c.warning!, /truncated or rejected/);
    assert.match(c.warning!, /VARCHAR\(100\) → VARCHAR\(10\)/);
  });

  test('tightening to NOT NULL is lossy', () => {
    const next = tbl({ columns: [tbl().columns[0], col('note', 'VARCHAR(100)', { nullable: false })] });
    const c = find(diffTable(tbl(), next, 's', 'mysql'), 'note');
    assert.equal(c.risk, 'lossy');
    assert.match(c.warning!, /fails if any existing row is NULL/);
  });

  test('relaxing to NULL is safe and costs only metadata', () => {
    const before = tbl({ columns: [tbl().columns[0], col('note', 'VARCHAR(100)', { nullable: false })] });
    const c = find(diffTable(before, tbl(), 's', 'mysql'), 'note');
    assert.equal(c.risk, 'safe');
    assert.equal(c.cost, 'metadata');
  });

  /// Case and spacing are not a change; emitting an ALTER for them would
  /// rewrite a table for nothing.
  test('a cosmetic type difference is not a change at all', () => {
    const next = tbl({ columns: [col('id', 'int', { nullable: false }), col('note', ' VARCHAR(100) ')] });
    assert.deepEqual(diffTable(tbl(), next, 's', 'mysql'), []);
  });
});

/**
 * PostgreSQL renders a column change completely differently from MySQL, and
 * every test above is MySQL — which is how the original bug survived: the PG
 * branch emitted `ALTER COLUMN ... TYPE` and nothing else, so a nullability or
 * default edit produced valid SQL that silently did not make the edit, while
 * rewriting a type the user had not touched.
 */
describe('modifying a column on PostgreSQL', () => {
  const pgTbl = (over: Partial<TableDraft> = {}): TableDraft => tbl({
    columns: [
      col('id', 'integer', { nullable: false }),
      col('note', 'character varying(100)'),
    ],
    ...over,
  });
  const sqlFor = (next: TableDraft) => find(diffTable(pgTbl(), next, 's', 'postgres'), 'note').sql;

  test('setting NOT NULL emits the nullability subcommand, not a type rewrite', () => {
    const s = sqlFor(pgTbl({
      columns: [pgTbl().columns[0], col('note', 'character varying(100)', { nullable: false })],
    }));
    assert.match(s, /ALTER COLUMN "note" SET NOT NULL/);
    assert.doesNotMatch(s, /TYPE/, 'a type the user never touched was rewritten');
  });

  test('relaxing to NULL drops it rather than setting it', () => {
    const before = pgTbl({
      columns: [pgTbl().columns[0], col('note', 'character varying(100)', { nullable: false })],
    });
    const s = find(diffTable(before, pgTbl(), 's', 'postgres'), 'note').sql;
    assert.match(s, /ALTER COLUMN "note" DROP NOT NULL/);
  });

  /// A default is an expression, not a literal — quoting `now()` would store
  /// the string.
  test('a default is set as the expression it is', () => {
    const s = sqlFor(pgTbl({
      columns: [pgTbl().columns[0], col('note', 'character varying(100)', { default: 'now()' })],
    }));
    assert.match(s, /ALTER COLUMN "note" SET DEFAULT now\(\)/);
  });

  test('clearing a default drops it', () => {
    const before = pgTbl({
      columns: [pgTbl().columns[0], col('note', 'character varying(100)', { default: "'x'" })],
    });
    const s = find(diffTable(before, pgTbl(), 's', 'postgres'), 'note').sql;
    assert.match(s, /ALTER COLUMN "note" DROP DEFAULT/);
  });

  /// One statement, so the table is rewritten once and the edit is atomic.
  test('several changes to one column become one statement', () => {
    const s = sqlFor(pgTbl({
      columns: [pgTbl().columns[0],
        col('note', 'text', { nullable: false, default: "'x'" })],
    }));
    assert.equal(s.match(/ALTER TABLE/g)!.length, 1);
    assert.match(s, /TYPE text, ALTER COLUMN "note" SET NOT NULL, ALTER COLUMN "note" SET DEFAULT 'x'/);
  });

  /// `USING` would turn a cast the server rightly refuses into silent
  /// truncation, so it is deliberately absent.
  test('a narrowing type change carries no USING clause', () => {
    const s = sqlFor(pgTbl({
      columns: [pgTbl().columns[0], col('note', 'character varying(10)')],
    }));
    assert.match(s, /TYPE character varying\(10\)/);
    assert.doesNotMatch(s, /USING/);
  });
});

/**
 * Storage engine changes.
 *
 * `ALTER TABLE … ENGINE=x` looks like a one-word edit and is a full table
 * rewrite that can drop guarantees the schema depends on: converting to a
 * non-transactional engine silently removes the table's foreign keys, and
 * BLACKHOLE discards the rows outright. Verified against the fleet that the
 * available engines genuinely differ — MariaDB has Aria and SEQUENCE, MySQL
 * has ARCHIVE and BLACKHOLE.
 */
describe('changing the storage engine', () => {
  const withEngine = (e?: string) => tbl({ engine: e });
  const change = (from: string | undefined, to: string) =>
    find(diffTable(withEngine(from), withEngine(to), 's', 'mysql'), to);

  test('a change emits one ALTER and rebuilds the table', () => {
    const c = change('InnoDB', 'Aria');
    assert.equal(c.kind, 'change-engine');
    assert.equal(c.cost, 'rebuild');
    assert.match(c.sql, /ALTER TABLE `s`\.`orders` ENGINE=Aria/);
  });

  /// Reading a table back gives the engine in the server's casing, which is
  /// not always the casing anyone would type.
  test('the same engine in different case is not a change', () => {
    assert.deepEqual(diffTable(withEngine('InnoDB'), withEngine('innodb'), 's', 'mysql'), []);
  });

  test('no engine on the draft means no opinion, not a change', () => {
    assert.deepEqual(diffTable(withEngine('InnoDB'), withEngine(undefined), 's', 'mysql'), []);
  });

  /// The consequence nobody expects: the conversion drops the foreign keys.
  test('converting to a non-transactional engine says what it costs', () => {
    for (const e of ['MyISAM', 'Aria', 'MEMORY']) {
      const c = change('InnoDB', e);
      assert.equal(c.risk, 'lossy', e);
      assert.match(c.warning!, /not transactional/, e);
      // The server refuses rather than dropping the constraint — measured on
      // both MySQL 8.0 (error 3776) and MariaDB 11.8 (error 1217, whose text
      // describes an unrelated problem).
      assert.match(c.warning!, /refuses the conversion/, e);
    }
  });

  test('MEMORY additionally warns that a restart empties it', () => {
    assert.match(change('InnoDB', 'MEMORY').warning!, /restart/);
  });

  /// BLACKHOLE is the one that loses the data rather than a guarantee.
  test('converting to BLACKHOLE is destructive, not merely lossy', () => {
    const c = change('InnoDB', 'BLACKHOLE');
    assert.equal(c.risk, 'destructive');
    assert.match(c.warning!, /discards every row/);
  });

  test('converting back to InnoDB is safe but still a rebuild', () => {
    const c = change('MyISAM', 'InnoDB');
    assert.equal(c.risk, 'safe');
    assert.equal(c.cost, 'rebuild');
    assert.match(c.warning!, /locks it for the duration/);
  });

  /// PostgreSQL has one storage engine; the field must not reach its SQL.
  test('PostgreSQL never emits an engine change', () => {
    assert.deepEqual(diffTable(withEngine('InnoDB'), withEngine('Aria'), 's', 'postgres'), []);
  });

  /// Last, because it rewrites everything — the cheaper changes should already
  /// have succeeded before this is attempted.
  test('the engine change is ordered after the column changes', () => {
    const before = tbl({ engine: 'InnoDB' });
    const after = tbl({ engine: 'Aria',
      columns: [tbl().columns[0], col('note', 'VARCHAR(500)')] });
    const kinds = diffTable(before, after, 's', 'mysql').map(c => c.kind);
    assert.equal(kinds[kinds.length - 1], 'change-engine');
  });
});

describe('dropping', () => {
  /// The label that matters most on the whole screen.
  test('dropping a column is destructive and says there is no rollback', () => {
    const next = tbl({ columns: [tbl().columns[0]] });
    const c = find(diffTable(tbl(), next, 's', 'mysql'), 'note');
    assert.equal(c.risk, 'destructive');
    assert.match(c.warning!, /Every value in note is deleted/);
    assert.match(c.warning!, /no transaction to roll back/);
  });

  /// A column being replaced must be added before its predecessor goes, so a
  /// mistake caught mid-review has not already deleted anything.
  test('drops are ordered last', () => {
    const next = tbl({ columns: [tbl().columns[0], col('memo', 'TEXT')] });
    assert.deepEqual(kinds(diffTable(tbl(), next, 's', 'mysql')), ['add-column', 'drop-column']);
  });
});

describe('renaming', () => {
  test('renaming a column is safe but warns about callers', () => {
    const next = tbl({ columns: [tbl().columns[0], col('memo', 'VARCHAR(100)', { originalName: 'note' })] });
    const cs = diffTable(tbl(), next, 's', 'mysql');
    assert.deepEqual(kinds(cs), ['rename-column']);
    assert.equal(cs[0].risk, 'safe');
    assert.match(cs[0].warning!, /old column name will break/);
  });

  /// A rename must not read as a drop plus an add — that would delete the data.
  test('a rename is never mistaken for a drop', () => {
    const next = tbl({ columns: [tbl().columns[0], col('memo', 'VARCHAR(100)', { originalName: 'note' })] });
    assert.ok(!kinds(diffTable(tbl(), next, 's', 'mysql')).includes('drop-column'));
  });

  test('renaming the table warns that references keep the old name', () => {
    const cs = diffTable(tbl(), tbl({ name: 'orders_v2', originalName: 'orders' }), 's', 'mysql');
    assert.equal(cs[0].kind, 'rename-table');
    assert.match(cs[0].warning!, /views, code, grants/);
  });
});

describe('indexes and foreign keys', () => {
  test('adding an index is safe but rebuilds', () => {
    const next = tbl({ indexes: [{ name: 'ix_note', columns: ['note'], unique: false }] });
    const c = find(diffTable(tbl(), next, 's', 'mysql'), 'ix_note');
    assert.equal(c.risk, 'safe');
    assert.equal(c.cost, 'rebuild');
  });

  test('a unique index warns about existing duplicates', () => {
    const next = tbl({ indexes: [{ name: 'ux', columns: ['note'], unique: true }] });
    assert.match(find(diffTable(tbl(), next, 's', 'mysql'), 'ux').warning!, /duplicates/);
  });

  test('a changed index is dropped and recreated, in that order', () => {
    const before = tbl({ indexes: [{ name: 'ix', columns: ['note'], unique: false }] });
    const after = tbl({ indexes: [{ name: 'ix', columns: ['id', 'note'], unique: false }] });
    assert.deepEqual(kinds(diffTable(before, after, 's', 'mysql')), ['drop-index', 'add-index']);
  });

  test('an unchanged index produces nothing', () => {
    const t = tbl({ indexes: [{ name: 'ix', columns: ['note'], unique: false }] });
    assert.deepEqual(diffTable(t, t, 's', 'mysql'), []);
  });

  /// A foreign key is rejected outright if the data does not already satisfy
  /// it, which is a surprise worth having before the apply.
  test('adding a foreign key warns about orphans, and about CASCADE', () => {
    const next = tbl({ foreignKeys: [{
      name: 'fk_c', columns: ['id'], refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE',
    }] });
    const c = find(diffTable(tbl(), next, 's', 'mysql'), 'fk_c');
    assert.equal(c.risk, 'lossy');
    assert.match(c.warning!, /no matching parent/);
    assert.match(c.warning!, /silently deletes these/);
  });

  test('dropping a foreign key says integrity stops being enforced', () => {
    const before = tbl({ foreignKeys: [{
      name: 'fk_c', columns: ['id'], refTable: 'customers', refColumns: ['id'],
    }] });
    const c = find(diffTable(before, tbl(), 's', 'mysql'), 'fk_c');
    assert.match(c.warning!, /no longer enforced/);
  });

  test('postgres drops a constraint, mysql drops a foreign key', () => {
    const before = tbl({ foreignKeys: [{
      name: 'fk_c', columns: ['id'], refTable: 'customers', refColumns: ['id'],
    }] });
    assert.match(find(diffTable(before, tbl(), 's', 'mysql'), 'fk_c').sql, /DROP FOREIGN KEY/);
    assert.match(find(diffTable(before, tbl(), 's', 'postgres'), 'fk_c').sql, /DROP CONSTRAINT/);
  });
});

describe('summarise', () => {
  test('an empty change set has no headline', () => {
    assert.deepEqual(summarise([]), { total: 0, destructive: 0, lossy: 0, rebuilds: 0, headline: null });
  });

  /// Destructive outranks everything — it is the sentence on the confirm button.
  test('destructive outranks lossy and names the columns', () => {
    const next = tbl({ columns: [tbl().columns[0], col('x', 'VARCHAR(1)')] });
    const s = summarise(diffTable(tbl(), next, 's', 'mysql'));
    assert.equal(s.destructive, 1);
    assert.match(s.headline!, /delete data: note/);
  });

  test('a rebuild is reported when nothing worse is happening', () => {
    const next = tbl({ indexes: [{ name: 'ix', columns: ['note'], unique: false }] });
    const s = summarise(diffTable(tbl(), next, 's', 'mysql'));
    assert.equal(s.destructive, 0);
    assert.match(s.headline!, /rewrite the table/);
  });
});

describe('changesToScript', () => {
  test('joins statements with semicolons', () => {
    const next = tbl({ columns: [...tbl().columns, col('a', 'INT')] });
    const script = changesToScript(diffTable(tbl(), next, 's', 'mysql'));
    assert.match(script, /ADD COLUMN `a` INT;$/);
  });

  /// MySQL would not honour a transaction around DDL, and implying one in the
  /// preview is the most dangerous kind of reassurance.
  test('no transaction wrapper is emitted', () => {
    const next = tbl({ columns: [tbl().columns[0]] });
    const script = changesToScript(diffTable(tbl(), next, 's', 'mysql'));
    assert.ok(!/BEGIN|START TRANSACTION|COMMIT/i.test(script), script);
  });
});

// ── Generated columns & invisible indexes (added feature) ─────────────────────
describe('generated columns and invisible indexes', () => {
  const base = (over = {}) => ({
    name: 't', columns: [{ name: 'a', type: 'INT', nullable: true, default: null }],
    primaryKey: [], indexes: [], foreignKeys: [], ...over,
  });

  test('generated column emits GENERATED ALWAYS AS (VIRTUAL default, STORED opt-in)', () => {
    const d = base({ columns: [
      { name: 'price', type: 'INT', nullable: true, default: null },
      { name: 'qty', type: 'INT', nullable: true, default: null },
      { name: 'total', type: 'INT', nullable: false, default: null, generated: 'price*qty' },
      { name: 'total2', type: 'INT', nullable: true, default: null, generated: 'price*qty', generatedStored: true },
    ] });
    const sql = createTableSql(d, 's', 'mysql');
    assert.match(sql, /`total` INT GENERATED ALWAYS AS \(price\*qty\) VIRTUAL NOT NULL/);
    assert.match(sql, /`total2` INT GENERATED ALWAYS AS \(price\*qty\) STORED/);
  });

  test('PostgreSQL generated columns are always STORED', () => {
    const d = base({ columns: [{ name: 'c', type: 'int', nullable: true, default: null, generated: 'a+1' }] });
    assert.match(createTableSql(d, 's', 'postgres'), /GENERATED ALWAYS AS \(a\+1\) STORED/);
  });

  test('invisible index emits INVISIBLE on MySQL and IGNORED on MariaDB', () => {
    const d = base({ indexes: [{ name: 'ix', columns: ['a'], unique: false, invisible: true }] });
    assert.match(createTableSql(d, 's', 'mysql'), /KEY `ix` \(`a`\) INVISIBLE/);
    assert.match(createTableSql(d, 's', 'mysql', 'mariadb'), /KEY `ix` \(`a`\) IGNORED/);
  });

  test('toggling only index visibility is a cheap ALTER INDEX, not a rebuild', () => {
    const cur = base({ indexes: [{ name: 'ix', columns: ['a'], unique: false }] });
    const draft = base({ indexes: [{ name: 'ix', columns: ['a'], unique: false, invisible: true }] });
    const cs = diffTable(cur, draft, 's', 'mysql');
    const alter = cs.find(c => c.kind === 'alter-index');
    assert.ok(alter, 'expected an alter-index change');
    assert.match(alter!.sql, /ALTER INDEX `ix` INVISIBLE/);
    assert.equal(alter!.cost, 'metadata');
    assert.ok(!cs.some(c => c.kind === 'drop-index' || c.kind === 'add-index'), 'no rebuild');
  });
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// Every statement asserted here was executed against SQL Server 2022, and the
// resulting table read back out of `sys.columns` / `sys.indexes` matched the
// draft. Four of these tests exist because the first version was *rejected* by
// that server — each names the message it got.

const msCol = (name: string, type: string, over: Partial<ColumnDraft> = {}): ColumnDraft =>
  ({ name, type, nullable: true, default: null, ...over });

const MS_TABLE: TableDraft = {
  name: 'zz_des',
  originalName: 'zz_des',
  columns: [
    msCol('id', 'int', { nullable: false, autoIncrement: true }),
    msCol('code', 'nvarchar(20)', { nullable: false }),
    msCol('qty', 'int', { nullable: false, default: '0', defaultConstraint: 'DF_zz_des_qty' }),
    msCol('total', 'int', { nullable: false, generated: 'qty * 2', generatedStored: true }),
    msCol('cust_id', 'int'),
  ],
  primaryKey: ['id'],
  indexes: [
    { name: 'IX_zz_des_code', columns: ['code'], unique: false },
    { name: 'UQ_zz_des_code2', columns: ['code'], unique: true },
  ],
  foreignKeys: [{
    name: 'FK_zz_des_cust', columns: ['cust_id'],
    refTable: 'sales.customers', refColumns: ['id'], onDelete: 'SET NULL',
  }],
};

const msSql = (changes: ReturnType<typeof diffTable>, kind: string, subject?: string) =>
  changes.find(c => c.kind === kind && (subject === undefined || c.subject === subject))!.sql;

test('a T-SQL CREATE TABLE names every constraint it makes', () => {
  const sql = createTableSql(MS_TABLE, 'dbo', 'sqlserver');
  // An unnamed constraint gets a hashed name (`PK__zz_des__3213E83F24201A16`)
  // that cannot be written into a later DROP — so anything created unnamed is
  // something the designer cannot change afterwards.
  assert.match(sql, /CONSTRAINT \[PK_zz_des\] PRIMARY KEY \(\[id\]\)/);
  assert.match(sql, /CONSTRAINT \[DF_zz_des_qty\] DEFAULT 0/);
  assert.match(sql, /CONSTRAINT \[UQ_zz_des_code2\] UNIQUE \(\[code\]\)/);
  assert.match(sql, /CONSTRAINT \[FK_zz_des_cust\] FOREIGN KEY/);
});

test('IDENTITY replaces AUTO_INCREMENT, and a computed column has no type', () => {
  const sql = createTableSql(MS_TABLE, 'dbo', 'sqlserver');
  assert.match(sql, /\[id\] int IDENTITY\(1,1\) NOT NULL/);
  assert.ok(!sql.includes('AUTO_INCREMENT'), sql);
  // `total int AS (…)` is rejected — a computed column is declared by its
  // expression alone.
  assert.match(sql, /\[total\] AS \(qty \* 2\) PERSISTED NOT NULL/);
  assert.ok(!/\[total\] int AS/.test(sql), sql);
});

test('a nonclustered index goes inline, which PostgreSQL cannot do', () => {
  const sql = createTableSql(MS_TABLE, 'dbo', 'sqlserver');
  // SQL Server 2014+ allows it, and the keyword is INDEX, never MySQL's KEY.
  assert.match(sql, /INDEX \[IX_zz_des_code\] NONCLUSTERED \(\[code\]\)/);
  assert.ok(!/\bKEY \[IX_/.test(sql), sql);
});

test('a referenced table is qualified, since an unqualified one resolves elsewhere', () => {
  // In T-SQL a bare name resolves against the CALLER's default schema.
  assert.match(createTableSql(MS_TABLE, 'dbo', 'sqlserver'),
    /REFERENCES \[sales\]\.\[customers\] \(\[id\]\)/);
  const bare = { ...MS_TABLE, foreignKeys: [{ ...MS_TABLE.foreignKeys[0], refTable: 'customers' }] };
  assert.match(createTableSql(bare, 'dbo', 'sqlserver'), /REFERENCES \[dbo\]\.\[customers\]/);
});

test('ADD takes no COLUMN keyword — including it is Msg 156', () => {
  const draft: TableDraft = {
    ...MS_TABLE,
    columns: [...MS_TABLE.columns, msCol('note', 'nvarchar(100)')],
  };
  const sql = msSql(diffTable(MS_TABLE, draft, 'dbo', 'sqlserver'), 'add-column', 'note');
  assert.match(sql, /^ALTER TABLE \[dbo\]\.\[zz_des\] ADD \[note\] nvarchar\(100\) NULL$/);
});

test('renaming uses sp_rename — T-SQL has no RENAME statement at all', () => {
  // `ALTER TABLE … RENAME COLUMN` is Msg 102, "Incorrect syntax near 'RENAME'".
  const draft: TableDraft = {
    ...MS_TABLE,
    name: 'zz_new',
    columns: MS_TABLE.columns.map(c =>
      c.name === 'code' ? { ...c, name: 'code2', originalName: 'code' } : c),
  };
  const changes = diffTable(MS_TABLE, draft, 'dbo', 'sqlserver');
  assert.equal(msSql(changes, 'rename-table'), "EXEC sp_rename 'dbo.zz_des', 'zz_new'");
  // The column form takes a THREE-part name and 'COLUMN' as its third argument.
  assert.equal(msSql(changes, 'rename-column'),
    "EXEC sp_rename 'dbo.zz_des.code', 'code2', 'COLUMN'");
});

test('the DEFAULT constraint is dropped BEFORE the ALTER COLUMN, never after', () => {
  // Msg 5074, "The object 'DF_zz_des_qty' is dependent on column 'qty'" —
  // the first version of this emitted the drop afterwards and the server
  // rejected the whole change.
  const draft: TableDraft = {
    ...MS_TABLE,
    columns: MS_TABLE.columns.map(c =>
      c.name === 'qty' ? { ...c, type: 'bigint', nullable: true, default: '7' } : c),
  };
  const sql = msSql(diffTable(MS_TABLE, draft, 'dbo', 'sqlserver'), 'modify-column', 'qty');
  const lines = sql.split('\n').filter(l => !l.trimStart().startsWith('--'));
  assert.equal(lines[0], 'ALTER TABLE [dbo].[zz_des] DROP CONSTRAINT [DF_zz_des_qty];');
  assert.equal(lines[1], 'ALTER TABLE [dbo].[zz_des] ALTER COLUMN [qty] bigint NULL;');
  assert.equal(lines[2],
    'ALTER TABLE [dbo].[zz_des] ADD CONSTRAINT [DF_zz_des_qty] DEFAULT 7 FOR [qty]');
  // A DEFAULT cannot ride on ALTER COLUMN: that is Msg 156.
  assert.ok(!/ALTER COLUMN[^\n]*DEFAULT/.test(sql), sql);
});

test('a computed column that reads the altered column is named, not ignored', () => {
  // `total` is computed from `qty`; SQL Server refuses the ALTER while it
  // exists, and no ordering avoids it.
  const draft: TableDraft = {
    ...MS_TABLE,
    columns: MS_TABLE.columns.map(c => (c.name === 'qty' ? { ...c, type: 'bigint' } : c)),
  };
  const sql = msSql(diffTable(MS_TABLE, draft, 'dbo', 'sqlserver'), 'modify-column', 'qty');
  assert.match(sql, /Computed column total references qty/);
  assert.match(sql, /Msg 5074/);
  // It is a comment, not a statement: dropping it would remove a column nobody
  // asked to remove.
  assert.match(sql, /--\s+ALTER TABLE \[dbo\]\.\[zz_des\] DROP COLUMN \[total\];/);
});

test('the type is restated for a nullability-only change, since T-SQL has no other form', () => {
  const draft: TableDraft = {
    ...MS_TABLE,
    columns: MS_TABLE.columns.map(c => (c.name === 'code' ? { ...c, nullable: true } : c)),
  };
  const sql = msSql(diffTable(MS_TABLE, draft, 'dbo', 'sqlserver'), 'modify-column', 'code');
  // Omitting the type would let the server default it, silently changing the
  // column the edit was not about.
  assert.equal(sql, 'ALTER TABLE [dbo].[zz_des] ALTER COLUMN [code] nvarchar(20) NULL');
});

test('IDENTITY cannot be altered on, and the script says so instead of trying', () => {
  const draft: TableDraft = {
    ...MS_TABLE,
    columns: MS_TABLE.columns.map(c =>
      (c.name === 'id' ? { ...c, autoIncrement: false, type: 'bigint' } : c)),
  };
  const sql = msSql(diffTable(MS_TABLE, draft, 'dbo', 'sqlserver'), 'modify-column', 'id');
  assert.match(sql, /IDENTITY cannot be added to or removed from an existing column/);
});

test('dropping a column drops what would block it, in one change', () => {
  // Msg 5074 again: a foreign key, an index or a default constraint naming the
  // column each refuse the drop, one at a time. MySQL and PostgreSQL cascade
  // them away; SQL Server does not.
  const draft: TableDraft = {
    ...MS_TABLE,
    columns: MS_TABLE.columns.filter(c => c.name !== 'cust_id'),
    foreignKeys: [],
  };
  const changes = diffTable(MS_TABLE, draft, 'dbo', 'sqlserver');
  const sql = msSql(changes, 'drop-column', 'cust_id');
  assert.equal(sql,
    'ALTER TABLE [dbo].[zz_des] DROP CONSTRAINT [FK_zz_des_cust];\n'
    + 'ALTER TABLE [dbo].[zz_des] DROP COLUMN [cust_id]');
  // …and it is NOT dropped a second time by the foreign-key pass, which would
  // be Msg 3728, "'FK_zz_des_cust' is not a constraint".
  assert.equal(changes.filter(c => c.kind === 'drop-fk').length, 0);
});

test('a UNIQUE constraint is dropped as a constraint, not as an index', () => {
  // Msg 3723: "An explicit DROP INDEX is not allowed on index '…'. It is being
  // used for UNIQUE KEY constraint enforcement."
  const draft: TableDraft = {
    ...MS_TABLE,
    indexes: MS_TABLE.indexes.filter(i => !i.unique),
  };
  const sql = msSql(diffTable(MS_TABLE, draft, 'dbo', 'sqlserver'), 'drop-index', 'UQ_zz_des_code2');
  assert.equal(sql, 'ALTER TABLE [dbo].[zz_des] DROP CONSTRAINT [UQ_zz_des_code2]');
});

test('a plain index drop names the table — an index name is unique per table', () => {
  // Msg 159: "Must specify the table name and index name for the DROP INDEX
  // statement."
  const draft: TableDraft = {
    ...MS_TABLE,
    indexes: MS_TABLE.indexes.filter(i => i.unique),
  };
  const sql = msSql(diffTable(MS_TABLE, draft, 'dbo', 'sqlserver'), 'drop-index', 'IX_zz_des_code');
  assert.equal(sql, 'DROP INDEX [IX_zz_des_code] ON [dbo].[zz_des]');
});

test('a foreign key is dropped with DROP CONSTRAINT, not MySQL\'s DROP FOREIGN KEY', () => {
  const draft: TableDraft = { ...MS_TABLE, foreignKeys: [] };
  const sql = msSql(diffTable(MS_TABLE, draft, 'dbo', 'sqlserver'), 'drop-fk', 'FK_zz_des_cust');
  assert.equal(sql, 'ALTER TABLE [dbo].[zz_des] DROP CONSTRAINT [FK_zz_des_cust]');
});

test('a server-generated DEFAULT name is looked up, never guessed', () => {
  // SQL Server names an unnamed default `DF__orders__qty__3B75D760`. The hash
  // is not derivable from anything, so inventing one produces a DROP that
  // fails.
  const current: TableDraft = {
    ...MS_TABLE,
    columns: MS_TABLE.columns.map(c =>
      (c.name === 'qty' ? { ...c, defaultConstraint: undefined } : c)),
  };
  const draft: TableDraft = {
    ...current,
    columns: current.columns.map(c => (c.name === 'qty' ? { ...c, default: '9' } : c)),
  };
  const sql = msSql(diffTable(current, draft, 'dbo', 'sqlserver'), 'modify-column', 'qty');
  assert.match(sql, /server-generated name/);
  assert.match(sql, /sys\.default_constraints/);
  // The ADD still uses the deterministic name, so the next edit CAN find it.
  assert.match(sql, /ADD CONSTRAINT \[DF_zz_des_qty\] DEFAULT 9 FOR \[qty\]/);
  assert.equal(defaultConstraintName('zz_des', 'qty'), 'DF_zz_des_qty');
});

test('a bracket inside an identifier doubles everywhere it appears', () => {
  const weird: TableDraft = {
    name: 'we]ird', columns: [msCol('c]ol', 'int')],
    primaryKey: [], indexes: [], foreignKeys: [],
  };
  const sql = createTableSql(weird, 'sch]ema', 'sqlserver');
  assert.match(sql, /CREATE TABLE \[sch\]\]ema\]\.\[we\]\]ird\]/);
  assert.match(sql, /\[c\]\]ol\] int NULL/);
});

test('nothing MySQL-only leaks into the T-SQL script', () => {
  const draft: TableDraft = {
    ...MS_TABLE, name: 'zz2',
    columns: [...MS_TABLE.columns, msCol('extra', 'nvarchar(10)')],
    indexes: [], foreignKeys: [],
  };
  const script = changesToScript(diffTable(MS_TABLE, draft, 'dbo', 'sqlserver'));
  for (const alien of ['AUTO_INCREMENT', 'ADD COLUMN', 'MODIFY COLUMN',
                       'DROP FOREIGN KEY', 'ENGINE=', 'COMMENT ', 'RENAME TABLE',
                       'RENAME COLUMN', 'VIRTUAL', 'GENERATED ALWAYS']) {
    assert.ok(!script.includes(alien), `${alien} leaked: ${script}`);
  }
});
