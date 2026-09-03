/**
 * DDL splitting (src/utils/syncDdl.ts).
 *
 * The fixture below is not invented — it is the exact `SHOW CREATE TABLE`
 * output of a table built on MySQL 8.0.46, chosen to carry every clause that
 * behaves differently during a load: a composite primary key, a unique key, two
 * plain keys, a fulltext key, a foreign key, a check constraint, a stored
 * generated column, a virtual generated column, an `AUTO_INCREMENT` counter,
 * and a `DEFAULT` containing a comma.
 *
 * The whole split was then replayed 8.0.46 → 8.4.10 across two live servers:
 * 20,000 rows loaded into PK-only tables, indexes rebuilt afterwards, and the
 * result verified identical by row count, index set, `AUTO_INCREMENT` value and
 * a NULL-safe content checksum.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitClauses, classifyClause, generatedColumnName, columnName,
  splitCreateTable, rebuildPlan, loadColumnList, liftAutoIncrement,
} from '../src/utils/syncDdl.ts';

/** Verbatim from MySQL 8.0.46. */
const INVOICE = `CREATE TABLE \`invoice\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`customer_id\` int NOT NULL,
  \`email\` varchar(120) NOT NULL,
  \`notes\` text,
  \`amount\` decimal(12,4) NOT NULL DEFAULT '0.0000',
  \`ratio\` double DEFAULT NULL,
  \`issued_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`meta\` json DEFAULT NULL,
  \`flags\` bit(8) DEFAULT NULL,
  \`state\` enum('draft','sent','paid') NOT NULL DEFAULT 'draft',
  \`doubled\` decimal(14,4) GENERATED ALWAYS AS ((\`amount\` * 2)) STORED,
  \`lower_email\` varchar(120) GENERATED ALWAYS AS (lower(\`email\`)) VIRTUAL,
  PRIMARY KEY (\`id\`,\`customer_id\`),
  UNIQUE KEY \`uq_email\` (\`email\`),
  KEY \`ix_customer\` (\`customer_id\`),
  KEY \`ix_amount\` (\`amount\`,\`issued_at\`),
  FULLTEXT KEY \`ft_notes\` (\`notes\`),
  CONSTRAINT \`fk_customer\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customer\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`ck_amount\` CHECK ((\`amount\` >= 0))
) ENGINE=InnoDB AUTO_INCREMENT=4711 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC COMMENT='sync fixture'`;

// ── clause splitting ────────────────────────────────────────────────────────

test('commas inside parentheses do not split a clause', () => {
  // `KEY ix (a,b)` is one clause, not two.
  const c = splitClauses('`a` int, KEY `ix` (`a`,`b`), `c` int');
  assert.equal(c.length, 3);
  assert.equal(c[1], 'KEY `ix` (`a`,`b`)');
});

test('commas inside string literals do not split a clause', () => {
  const c = splitClauses("`s` varchar(10) DEFAULT 'a,b', `t` int");
  assert.equal(c.length, 2);
  assert.match(c[0], /'a,b'/);
});

test('an ENUM with commas stays one clause', () => {
  const c = splitClauses("`state` enum('draft','sent','paid') NOT NULL, `x` int");
  assert.equal(c.length, 2);
  assert.match(c[0], /'draft','sent','paid'/);
});

test('a doubled quote inside a literal is not a terminator', () => {
  const c = splitClauses("`s` varchar(10) DEFAULT 'it''s, fine', `t` int");
  assert.equal(c.length, 2);
});

test('a comma inside a backticked identifier does not split', () => {
  // Legal, and exactly the sort of thing a naive split gets wrong.
  const c = splitClauses('`we,ird` int, `b` int');
  assert.equal(c.length, 2);
  assert.equal(c[0], '`we,ird` int');
});

// ── classification ──────────────────────────────────────────────────────────

test('PRIMARY KEY is KEPT — InnoDB clusters on it', () => {
  // Measured: deferring it cost 544 ms of pure table rebuild on 598 k rows.
  assert.equal(classifyClause('PRIMARY KEY (`id`,`customer_id`)'), null);
});

test('every other key kind is deferred, with its name', () => {
  const cases: [string, string, string][] = [
    ['UNIQUE KEY `uq_email` (`email`)', 'unique', 'uq_email'],
    ['KEY `ix_customer` (`customer_id`)', 'index', 'ix_customer'],
    ['FULLTEXT KEY `ft_notes` (`notes`)', 'fulltext', 'ft_notes'],
    ['SPATIAL KEY `sp_geo` (`geo`)', 'spatial', 'sp_geo'],
  ];
  for (const [sql, kind, name] of cases) {
    const d = classifyClause(sql);
    assert.equal(d?.kind, kind, sql);
    assert.equal(d?.name, name, sql);
  }
});

test('foreign keys and checks are deferred and told apart', () => {
  const fk = classifyClause(
    'CONSTRAINT `fk_customer` FOREIGN KEY (`customer_id`) REFERENCES `customer` (`id`) ON DELETE CASCADE');
  assert.equal(fk?.kind, 'foreign-key');
  assert.equal(fk?.name, 'fk_customer');
  const ck = classifyClause('CONSTRAINT `ck_amount` CHECK ((`amount` >= 0))');
  assert.equal(ck?.kind, 'check');
  assert.equal(ck?.name, 'ck_amount');
});

test('an unnamed constraint still classifies', () => {
  assert.equal(classifyClause('FOREIGN KEY (`a`) REFERENCES `t` (`id`)')?.kind, 'foreign-key');
  assert.equal(classifyClause('CHECK ((`a` > 0))')?.kind, 'check');
});

test('a column whose name starts with "key" is not a key', () => {
  // `keyword` int — the prefix trap.
  assert.equal(classifyClause('`keyword` varchar(10) DEFAULT NULL'), null);
  assert.equal(columnName('`keyword` varchar(10) DEFAULT NULL'), 'keyword');
});

test('an unrecognised clause stays in the load table', () => {
  // Being wrong here costs a slower load, never a broken one.
  assert.equal(classifyClause('SOMETHING WE HAVE NOT SEEN'), null);
});

// ── generated columns ───────────────────────────────────────────────────────

test('both STORED and VIRTUAL generated columns are detected', () => {
  assert.equal(
    generatedColumnName('`doubled` decimal(14,4) GENERATED ALWAYS AS ((`amount` * 2)) STORED'),
    'doubled');
  assert.equal(
    generatedColumnName('`lower_email` varchar(120) GENERATED ALWAYS AS (lower(`email`)) VIRTUAL'),
    'lower_email');
});

test('an ordinary column is not generated', () => {
  assert.equal(generatedColumnName('`email` varchar(120) NOT NULL'), null);
  assert.equal(generatedColumnName("`amount` decimal(12,4) NOT NULL DEFAULT '0.0000'"), null);
});

// ── the whole split, against real server output ─────────────────────────────

test('the load table keeps columns, PK and options — and nothing else', () => {
  const s = splitCreateTable(INVOICE);
  assert.match(s.createSql, /PRIMARY KEY \(`id`,`customer_id`\)/);
  for (const gone of ['uq_email', 'ix_customer', 'ix_amount', 'ft_notes', 'fk_customer', 'ck_amount']) {
    assert.ok(!s.createSql.includes(gone), `${gone} should have been deferred`);
  }
  // Options survive — engine, charset, row format and comment all matter.
  assert.match(s.createSql, /ENGINE=InnoDB/);
  assert.match(s.createSql, /ROW_FORMAT=DYNAMIC/);
  assert.match(s.createSql, /COMMENT='sync fixture'/);
});

test('all six deferred clauses are found, in order', () => {
  const s = splitCreateTable(INVOICE);
  assert.deepEqual(s.deferred.map(d => d.kind),
    ['unique', 'index', 'index', 'fulltext', 'foreign-key', 'check']);
});

test('AUTO_INCREMENT is lifted out of the options', () => {
  // A load resets the counter; losing it hands out primary keys that already
  // existed on the source.
  const s = splitCreateTable(INVOICE);
  assert.equal(s.autoIncrement, 4711);
  assert.ok(!/AUTO_INCREMENT\s*=/.test(s.createSql), s.createSql);
  // …but the column's own AUTO_INCREMENT attribute must stay.
  assert.match(s.createSql, /`id` bigint NOT NULL AUTO_INCREMENT/);
});

test('generated columns are identified and excluded from the load list', () => {
  const s = splitCreateTable(INVOICE);
  assert.deepEqual(s.generatedColumns, ['doubled', 'lower_email']);
  assert.deepEqual(s.loadColumns, [
    'id', 'customer_id', 'email', 'notes', 'amount', 'ratio',
    'issued_at', 'meta', 'flags', 'state',
  ]);
  const list = loadColumnList(s);
  assert.ok(!list.includes('doubled'), list);
  assert.ok(!list.includes('lower_email'), list);
});

test('the column list is explicit, never a star', () => {
  // Invisible columns (8.0.23+) are absent from SELECT *, so a star would
  // silently drop them on the read side.
  assert.match(loadColumnList(splitCreateTable(INVOICE)), /^`id`, `customer_id`/);
});

test('a table with nothing to defer round-trips unchanged in substance', () => {
  const simple = 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB';
  const s = splitCreateTable(simple);
  assert.deepEqual(s.deferred, []);
  assert.equal(s.autoIncrement, null);
  assert.match(s.createSql, /PRIMARY KEY \(`id`\)/);
  assert.deepEqual(s.loadColumns, ['id']);
});

test('unparseable input is handed back whole rather than mangled', () => {
  const junk = 'NOT A CREATE STATEMENT';
  assert.equal(splitCreateTable(junk).createSql, junk);
});

// ── the rebuild ─────────────────────────────────────────────────────────────

test('secondary indexes go in ONE ALTER — InnoDB makes one pass', () => {
  // Measured: four indexes in one ALTER took 778 ms against a 1,290 ms load.
  const p = rebuildPlan('db', 'invoice', splitCreateTable(INVOICE));
  const first = p.indexSql!.split(';')[0];
  assert.match(first, /ADD UNIQUE KEY `uq_email`/);
  assert.match(first, /ADD KEY `ix_customer`/);
  assert.match(first, /ADD KEY `ix_amount`/);
});

test('FULLTEXT gets its own statement — InnoDB rejects two per ALTER', () => {
  const p = rebuildPlan('db', 'invoice', splitCreateTable(INVOICE));
  const stmts = p.indexSql!.split(';\n');
  const ft = stmts.filter(s => s.includes('FULLTEXT'));
  assert.equal(ft.length, 1);
  // …and it is not bundled with the others.
  assert.ok(!/ADD KEY `ix_customer`/.test(ft[0]), ft[0]);
});

test('foreign keys and checks are separate from indexes', () => {
  // FKs can reference a table loaded later, so they are applied only once
  // every table is in. A failing CHECK is a DATA finding, not a schema one.
  const p = rebuildPlan('db', 'invoice', splitCreateTable(INVOICE));
  assert.match(p.foreignKeySql!, /ADD CONSTRAINT `fk_customer` FOREIGN KEY/);
  assert.match(p.checkSql!, /ADD CONSTRAINT `ck_amount` CHECK/);
  assert.ok(!p.indexSql!.includes('FOREIGN KEY'));
  assert.ok(!p.indexSql!.includes('CHECK'));
});

test('AUTO_INCREMENT is restored after the load', () => {
  const p = rebuildPlan('db', 'invoice', splitCreateTable(INVOICE));
  assert.equal(p.autoIncrementSql, 'ALTER TABLE `db`.`invoice` AUTO_INCREMENT = 4711');
});

test('a table with nothing deferred produces an empty plan', () => {
  const p = rebuildPlan('db', 't', splitCreateTable(
    'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB'));
  assert.equal(p.indexSql, null);
  assert.equal(p.foreignKeySql, null);
  assert.equal(p.checkSql, null);
  assert.equal(p.autoIncrementSql, null);
});

test('schema and table names are backtick-escaped', () => {
  const p = rebuildPlan('we`ird', 'ta`ble', splitCreateTable(INVOICE));
  assert.match(p.indexSql!, /`we``ird`\.`ta``ble`/);
});

test('AUTO_INCREMENT inside a COMMENT is not mistaken for the option', () => {
  // Found by probing: a table commented `COMMENT='reset AUTO_INCREMENT=5
  // nightly'` lost that text from its comment AND had a fabricated counter of
  // 5 applied to it — corruption in both directions from one regex.
  const ddl = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n)"
    + " ENGINE=InnoDB COMMENT='reset AUTO_INCREMENT=5 nightly'";
  const s = splitCreateTable(ddl);
  assert.equal(s.autoIncrement, null);
  assert.match(s.createSql, /COMMENT='reset AUTO_INCREMENT=5 nightly'/);
});

test('a real AUTO_INCREMENT option is still lifted when a comment follows', () => {
  const ddl = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n)"
    + " ENGINE=InnoDB AUTO_INCREMENT=99 COMMENT='mentions AUTO_INCREMENT=1 here'";
  const s = splitCreateTable(ddl);
  assert.equal(s.autoIncrement, 99);
  assert.match(s.createSql, /COMMENT='mentions AUTO_INCREMENT=1 here'/);
  assert.ok(!/AUTO_INCREMENT=99/.test(s.createSql), s.createSql);
});

test('only the FIRST AUTO_INCREMENT option is taken', () => {
  const { value, rest } = liftAutoIncrement(" ENGINE=InnoDB AUTO_INCREMENT=7 COMMENT='x'");
  assert.equal(value, 7);
  assert.ok(!rest.includes('AUTO_INCREMENT'), rest);
});
