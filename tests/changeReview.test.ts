import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewChanges } from '../src/utils/changeReview.ts';
import type { ChangeReviewEngine } from '../src/utils/changeReview.ts';
import { buildMarkdown, renderFindings } from '../src/utils/qualityReport.ts';
import type { SchemaSnapshot } from '../src/utils/schemaRules.ts';

const review = (sql: string, engine: ChangeReviewEngine = 'mysql', catalog?: SchemaSnapshot) =>
  reviewChanges({ sql, engine, catalog });
const titles = (sql: string, engine: ChangeReviewEngine = 'mysql', catalog?: SchemaSnapshot) =>
  review(sql, engine, catalog).findings.map(f => f.title);
const table = (result: ReturnType<typeof reviewChanges>, name: string) => {
  const found = result.tables.find(t => t.name === name);
  assert.ok(found, `missing table ${name}`);
  return found;
};

function catalog(): SchemaSnapshot {
  return {
    engine: 'mysql', schema: 'app', serverCharset: null, serverCollation: null,
    schemaCharset: null, schemaCollation: null,
    tables: [{ name: 'orders', engine: 'InnoDB', collation: null, rows: 1200,
      dataBytes: 40 * 1024 * 1024, indexBytes: 8 * 1024 * 1024, autoIncrement: null, comment: '' }],
    columns: [
      { table: 'orders', name: 'id', dataType: 'bigint', columnType: 'bigint unsigned', nullable: false,
        defaultValue: null, extra: '', charset: null, collation: null, charMaxLen: null, comment: '' },
      { table: 'orders', name: 'code', dataType: 'varchar', columnType: 'varchar(80)', nullable: true,
        defaultValue: null, extra: '', charset: null, collation: null, charMaxLen: 80, comment: '' },
    ],
    indexes: [{ table: 'orders', name: 'PRIMARY', unique: true, type: 'BTREE',
      columns: [{ name: 'id', seq: 1, subPart: null, cardinality: null }] }],
    foreignKeys: [], statsSource: 'test statistics',
  };
}

test('splits migrations with strings/comments and keeps statement source lines', () => {
  const sql = `-- migration; header\nCREATE TABLE t (\n  id INT PRIMARY KEY,\n  note VARCHAR(30) DEFAULT 'x;y'\n);\n\nALTER TABLE t\n  MODIFY COLUMN note VARCHAR(10);`;
  const result = review(sql);
  assert.equal(result.statements.length, 2);
  assert.deepEqual(result.statements.map(s => [s.line, s.kind, s.supported]), [
    [2, 'create-table', true], [7, 'alter-table', true],
  ]);
  assert.equal(table(result, 't').columns[1].type, 'VARCHAR(10)');
  const narrowing = result.findings.find(f => f.title.includes('narrows type'));
  assert.deepEqual(narrowing?.at, { line: 8, col: 17 });
});

test('CREATE TABLE builds columns, table constraints, indexes and foreign keys', () => {
  const result = review(`CREATE TABLE parents (id BIGINT UNSIGNED PRIMARY KEY);
    CREATE TABLE children (
      id BIGINT PRIMARY KEY,
      parent_id BIGINT UNSIGNED NOT NULL,
      email VARCHAR(100),
      CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE,
      UNIQUE KEY uq_email (email),
      KEY ix_parent (parent_id)
    );`);
  const child = table(result, 'children');
  assert.deepEqual(child.columns.map(c => c.name), ['id', 'parent_id', 'email']);
  assert.equal(child.columns[0].nullable, false);
  assert.deepEqual(child.indexes.map(i => [i.name, i.unique]), [
    ['PRIMARY', true], ['uq_email', true], ['ix_parent', false],
  ]);
  assert.deepEqual(child.foreignKeys[0], {
    name: 'fk_parent', columns: ['parent_id'], refTable: 'parents', refColumns: ['id'], onDelete: 'CASCADE',
  });
  assert.equal(result.summary.unsupported, 0);
});

test('post-state evolves through ADD, MODIFY, CHANGE and DROP COLUMN', () => {
  const result = review(`CREATE TABLE t (id INT PRIMARY KEY, code VARCHAR(20), old INT);
    ALTER TABLE t ADD COLUMN extra DECIMAL(12,2) DEFAULT 0 AFTER code;
    ALTER TABLE t MODIFY COLUMN code VARCHAR(40) NOT NULL;
    ALTER TABLE t CHANGE COLUMN old renamed BIGINT NULL;
    ALTER TABLE t DROP COLUMN extra;`);
  const t = table(result, 't');
  assert.deepEqual(t.columns, [
    { name: 'id', type: 'INT', nullable: false, hasDefault: false },
    { name: 'code', type: 'VARCHAR(40)', nullable: false, hasDefault: false },
    { name: 'renamed', type: 'BIGINT', nullable: true, hasDefault: false },
  ]);
  assert.equal(result.statements[1].after[0].columns[2].name, 'extra');
  assert.equal(result.statements[4].after[0].columns.some(c => c.name === 'extra'), false);
});

test('VARCHAR narrowing is critical and widening is a conversion warning', () => {
  const narrow = review('CREATE TABLE t (c VARCHAR(80)); ALTER TABLE t MODIFY c VARCHAR(40);');
  assert.ok(narrow.findings.some(f => f.severity === 'red' && /maximum length falls/.test(f.detail)));
  const wide = review('CREATE TABLE t (c VARCHAR(40)); ALTER TABLE t MODIFY c VARCHAR(80);');
  assert.ok(wide.findings.some(f => f.severity === 'orange' && /changes type/.test(f.title)));
  assert.equal(wide.findings.some(f => /narrows type/.test(f.title)), false);
});

test('integer width and unsigned-to-signed narrowing are detected', () => {
  const result = review(`CREATE TABLE t (a BIGINT, b INT UNSIGNED);
    ALTER TABLE t MODIFY a INT, MODIFY b INT SIGNED;`);
  const risky = result.findings.filter(f => f.severity === 'red' && /narrows type/.test(f.title));
  assert.equal(risky.length, 2);
  assert.match(risky[0].detail, /wider range/);
  assert.match(risky[1].detail, /wider range|upper half/);
});

test('decimal precision, scale and integer-digit narrowing are detected', () => {
  for (const target of ['DECIMAL(8,2)', 'DECIMAL(10,1)', 'DECIMAL(9,3)']) {
    const result = review(`CREATE TABLE t (amount DECIMAL(10,2)); ALTER TABLE t MODIFY amount ${target};`);
    assert.ok(result.findings.some(f => f.severity === 'red' && /narrows type/.test(f.title)), target);
  }
});

test('changing NULL to NOT NULL is an explicit data-risk finding', () => {
  const result = review('CREATE TABLE t (c INT NULL); ALTER TABLE t MODIFY c INT NOT NULL;');
  assert.ok(result.findings.some(f => f.severity === 'orange' && /changes NULL → NOT NULL/.test(f.title)));
  assert.equal(table(result, 't').columns[0].nullable, false);
});

test('ADD NOT NULL without default warns for an existing table', () => {
  const result = review('CREATE TABLE t (id INT PRIMARY KEY); ALTER TABLE t ADD c INT NOT NULL;', 'mysql', catalog());
  assert.ok(result.findings.some(f => /NOT NULL without a default/.test(f.title)));
});

test('DROP COLUMN destroys data and removes dependent indexes/FKs from the model', () => {
  const result = review(`CREATE TABLE t (id INT PRIMARY KEY, c INT, KEY ix_c (c),
    CONSTRAINT fk_c FOREIGN KEY (c) REFERENCES p(id));
    ALTER TABLE t DROP COLUMN c;`);
  assert.ok(result.findings.some(f => f.severity === 'red' && /DROP COLUMN.*destroys data/.test(f.title)));
  assert.equal(table(result, 't').indexes.some(i => i.name === 'ix_c'), false);
  assert.equal(table(result, 't').foreignKeys.length, 0);
});

test('DROP TABLE removes the post-state table and is destructive', () => {
  const result = review('CREATE TABLE t (id INT PRIMARY KEY); DROP TABLE t;');
  assert.equal(result.tables.length, 0);
  assert.ok(result.findings.some(f => f.severity === 'red' && /DROP TABLE t destroys/.test(f.title)));
});

test('DROP followed by CREATE is a migration-wide destructive rewrite', () => {
  const result = review('CREATE TABLE t (id INT PRIMARY KEY); DROP TABLE t; CREATE TABLE t (id INT PRIMARY KEY);');
  assert.ok(result.findings.some(f => f.severity === 'red' && /DROP\/CREATE rewrite/.test(f.title)));
  assert.equal(result.tables.length, 1);
});

test('TRUNCATE keeps the table but clears estimated rows and warns', () => {
  const result = review('TRUNCATE TABLE orders;', 'mysql', catalog());
  assert.equal(table(result, 'orders').rows, 0);
  assert.ok(result.findings.some(f => f.severity === 'red' && /TRUNCATE orders destroys every row/.test(f.title)));
});

test('unsupported statements are findings, never a clean review', () => {
  const result = review('CREATE TABLE t (id INT PRIMARY KEY); UPDATE t SET id = 1; CREATE VIEW v AS SELECT 1;');
  assert.equal(result.summary.unsupported, 2);
  assert.equal(result.findings.filter(f => /Unsupported statement/.test(f.title)).length, 2);
  assert.ok(result.findings.every(f => f.severity !== 'info'));
});

test('an unsupported ALTER action rolls back earlier action findings and post-state', () => {
  const result = review('CREATE TABLE t (id INT PRIMARY KEY, c INT); ALTER TABLE t DROP COLUMN c, MADE_UP ACTION;');
  assert.equal(result.statements[1].supported, false);
  assert.equal(result.findings.some(f => /DROP COLUMN/.test(f.title)), false);
  assert.equal(table(result, 't').columns.some(c => c.name === 'c'), true);
  assert.equal(result.findings.filter(f => /Unsupported or uncertain DDL/.test(f.title)).length, 1);
});

test('parser uncertainty is explicit for unterminated SQL', () => {
  const result = review("CREATE TABLE t (c VARCHAR(10) DEFAULT 'oops);");
  assert.equal(result.summary.supported, 0);
  assert.ok(result.findings.some(f => /Parser uncertainty/.test(f.title)));
});

test('PostgreSQL ALTER TYPE preserves the target type and detects widening honestly', () => {
  const result = review('CREATE TABLE t (id integer PRIMARY KEY); ALTER TABLE t ALTER COLUMN id TYPE bigint;', 'postgres');
  assert.equal(table(result, 't').columns[0].type, 'bigint');
  assert.ok(result.findings.some(f => /changes type integer → bigint/.test(f.title)));
  assert.equal(result.findings.some(f => /narrows type/.test(f.title)), false);
});

test('PostgreSQL bigint to integer narrowing is critical', () => {
  const result = review('CREATE TABLE t (id bigint PRIMARY KEY); ALTER TABLE t ALTER COLUMN id TYPE integer USING id::integer;', 'postgres');
  assert.ok(result.findings.some(f => f.severity === 'red' && /narrows type bigint → integer/.test(f.title)));
});

test('PostgreSQL SET NOT NULL updates state and warns', () => {
  const result = review('CREATE TABLE t (c text); ALTER TABLE t ALTER c SET NOT NULL;', 'postgres');
  assert.equal(table(result, 't').columns[0].nullable, false);
  assert.ok(result.findings.some(f => /changes NULL → NOT NULL/.test(f.title)));
});

test('MySQL MODIFY syntax on PostgreSQL is unsupported rather than mis-parsed', () => {
  const result = review('CREATE TABLE t (c int); ALTER TABLE t MODIFY c bigint;', 'postgres');
  assert.equal(result.summary.unsupported, 1);
  assert.match(result.findings[0].detail, /MySQL\/MariaDB syntax/);
});

test('PostgreSQL CREATE INDEX CONCURRENTLY evolves indexes without a write-blocking cost', () => {
  const result = review('CREATE TABLE t (c int); CREATE INDEX CONCURRENTLY ix_c ON t(c);', 'postgres');
  assert.equal(table(result, 't').indexes[0].name, 'ix_c');
  assert.equal(result.statements[1].cost?.algorithm, 'INPLACE');
  assert.equal(result.statements[1].cost?.lock, 'NONE');
});

test('CONCURRENTLY on MySQL is an explicit dialect error', () => {
  const result = review('CREATE TABLE t (c INT); CREATE INDEX CONCURRENTLY ix_c ON t(c);');
  assert.equal(result.summary.unsupported, 1);
  assert.match(result.findings[0].detail, /PostgreSQL syntax/);
});

test('PostgreSQL volatile defaults rewrite while constant defaults stay catalog-only', () => {
  const constant = review('CREATE TABLE t (id int); ALTER TABLE t ADD c timestamptz DEFAULT now();', 'postgres');
  assert.equal(constant.statements[1].cost?.rebuild, false);
  const volatile = review('CREATE TABLE t (id int); ALTER TABLE t ADD c uuid DEFAULT gen_random_uuid();', 'postgres');
  assert.equal(volatile.statements[1].cost?.rebuild, true);
  assert.ok(volatile.findings.some(f => /volatile default/.test(f.title)));
});

test('matching MySQL FK types pass while signedness mismatch is critical', () => {
  const good = review(`CREATE TABLE p (id BIGINT UNSIGNED PRIMARY KEY);
    CREATE TABLE c (pid BIGINT UNSIGNED, KEY ix_pid (pid), FOREIGN KEY (pid) REFERENCES p(id));`);
  assert.equal(good.findings.some(f => /incompatible column types/.test(f.title)), false);
  const bad = review(`CREATE TABLE p (id BIGINT UNSIGNED PRIMARY KEY);
    CREATE TABLE c (pid BIGINT SIGNED, FOREIGN KEY (pid) REFERENCES p(id));`);
  assert.ok(bad.findings.some(f => f.severity === 'red' && /incompatible column types/.test(f.title)));
});

test('a final FK to a missing table or column is critical', () => {
  const missingTable = review('CREATE TABLE c (pid INT, FOREIGN KEY (pid) REFERENCES p(id));');
  assert.ok(missingTable.findings.some(f => f.severity === 'red' && /references missing table/.test(f.title)));
  const missingColumn = review('CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (pid INT, FOREIGN KEY (pid) REFERENCES p(other));');
  assert.ok(missingColumn.findings.some(f => f.severity === 'red' && /references a missing column/.test(f.title)));
});

test('PostgreSQL FK without a child index warns, and a later prefix index resolves it', () => {
  const ddl = 'CREATE TABLE p (id int PRIMARY KEY); CREATE TABLE c (pid int REFERENCES p(id));';
  assert.ok(titles(ddl, 'postgres').some(t => /has no supporting index/.test(t)));
  const fixed = review(`${ddl} CREATE INDEX CONCURRENTLY ix_pid ON c(pid);`, 'postgres');
  assert.equal(fixed.findings.some(f => /has no supporting index/.test(f.title)), false);
});

test('DROP TABLE uses the modeled cascade graph for dependent consequences', () => {
  const result = review(`CREATE TABLE p (id INT PRIMARY KEY);
    CREATE TABLE c (pid INT, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE CASCADE);
    DROP TABLE p;`);
  assert.ok(result.findings.some(f => /dependent-table consequences/.test(f.title) && /cascades into 1 table/.test(f.detail)));
});

test('multiple rebuilds of one table produce a migration-wide warning', () => {
  const result = review(`CREATE TABLE t (a INT, b INT);
    ALTER TABLE t MODIFY a BIGINT;
    ALTER TABLE t DROP COLUMN b;`);
  assert.ok(result.findings.some(f => /Migration rewrites t 2 times/.test(f.title)));
  assert.equal(result.summary.rebuilds, 2);
});

test('a non-unique left-prefix index is redundant in the final model', () => {
  const result = review('CREATE TABLE t (a INT, b INT, KEY ix_a (a), KEY ix_ab (a, b));');
  assert.ok(result.findings.some(f => /ix_a is a redundant prefix of ix_ab/.test(f.title)));
});

test('a live catalog supplies drift, type history, row counts and modelled cost', () => {
  const result = review('ALTER TABLE orders MODIFY COLUMN code VARCHAR(20) NOT NULL;', 'mysql', catalog());
  assert.ok(result.findings.some(f => /orders.code narrows type varchar\(80\) → VARCHAR\(20\)/.test(f.title)));
  assert.ok(result.findings.some(f => /changes NULL → NOT NULL/.test(f.title)));
  const cost = result.findings.find(f => f.evidence?.some(e => e.source === 'DDL cost model'));
  assert.ok(cost?.cost?.seconds && cost.cost.seconds > 1);
  assert.equal(table(result, 'orders').source, 'catalog');
});

test('unknown before-state is partial and cannot produce a clean review', () => {
  const result = review('ALTER TABLE mystery ADD COLUMN c INT;');
  assert.equal(table(result, 'mystery').complete, false);
  assert.ok(result.findings.some(f => /Before-state of mystery is unknown/.test(f.title)));
  assert.match(result.sections[1].md, /PARTIAL/);
});

test('mixed MySQL ALTER actions retain the most expensive rebuild cost', () => {
  const result = review('CREATE TABLE t (id INT PRIMARY KEY, c INT); ALTER TABLE t ADD x INT, DROP COLUMN c;');
  assert.equal(result.statements[1].cost?.rebuild, true);
  assert.equal(result.summary.rebuilds, 1);
});

test('partitioned, empty and trailing-comma CREATE definitions are uncertainty findings', () => {
  for (const sql of [
    'CREATE TABLE t (id INT) PARTITION BY HASH(id);',
    'CREATE TABLE t ();',
    'CREATE TABLE t (id INT,);',
  ]) {
    const result = review(sql);
    assert.equal(result.summary.unsupported, 1, sql);
    assert.ok(result.findings.some(f => /Unsupported or uncertain DDL/.test(f.title)), sql);
  }
});

test('MariaDB labels reused MySQL online-DDL costs as version-dependent', () => {
  const result = reviewChanges({ engine: 'mysql', mariaDb: true,
    sql: 'CREATE TABLE t (id INT PRIMARY KEY); ALTER TABLE t ADD c INT;' });
  assert.ok(result.findings.some(f => /MariaDB online-DDL behavior is version-dependent/.test(f.title)));
});

test('findings and post-state sections integrate with the existing quality report', () => {
  const result = review('CREATE TABLE t (id INT PRIMARY KEY, c VARCHAR(20));\nALTER TABLE t MODIFY c VARCHAR(5);');
  const meta = { connectionName: 'local', engine: 'mysql', date: '2026-10-30 12:00', sql: 'migration' };
  const md = buildMarkdown(meta, result.findings, result.sections, { level: 'deep' });
  assert.match(md, /Statement plan/);
  assert.match(md, /Change review/);
  assert.match(md, /Post-migration table model/);
  assert.match(md, /Line 2/);
  assert.match(md, /model estimate, not a measurement/);
  assert.match(renderFindings(result.findings, { level: 'oneline' }), /CR1\s+L2/);
});
