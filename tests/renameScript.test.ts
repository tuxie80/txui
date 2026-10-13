/**
 * Rename script builder (src/utils/renameScript.ts).
 *
 * The failure this whole feature exists to avoid: rewriting text on a `likely`
 * verdict and corrupting someone's view or routine. So the heavy tests are the
 * negatives — likely/possible occurrences, names inside strings, longer
 * identifiers, other tables' columns — plus the ordering: drop dependents →
 * rename → recreate.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRenameScript, dropStatement, invalidNewName, parseCorpusLabel, qualifyObjectName,
  renameColumnSupported, renameDdl, rewriteCertain,
  type RenameObject,
} from '../src/utils/renameScript.ts';

const obj = (over: Partial<RenameObject> & { sql: string }): RenameObject => ({
  id: over.id ?? 'o1', kind: over.kind ?? 'view', label: over.label ?? 'shop.v_open',
  ...over,
});

// ── rewriteCertain: the rewriter ─────────────────────────────────────────────

describe('rewriteCertain — what moves', () => {
  test('a FROM reference is rewritten', () => {
    const r = rewriteCertain('SELECT * FROM orders', { table: 'orders', newName: 'orders_v2' }, 'mysql')!;
    assert.equal(r.sql, 'SELECT * FROM orders_v2');
    assert.equal(r.rewritten, 1);
    assert.equal(r.review.length, 0);
  });

  test('a backtick-quoted occurrence keeps its backticks (MySQL)', () => {
    const r = rewriteCertain('SELECT * FROM `orders`', { table: 'orders', newName: 'orders_v2' }, 'mysql')!;
    assert.equal(r.sql, 'SELECT * FROM `orders_v2`');
  });

  test('a double-quoted occurrence keeps its double quotes (PostgreSQL)', () => {
    const r = rewriteCertain('SELECT * FROM "orders"', { table: 'orders', newName: 'orders_v2' }, 'postgres')!;
    assert.equal(r.sql, 'SELECT * FROM "orders_v2"');
  });

  test('a double-quoted "occurrence" on MySQL is a string and never moves', () => {
    const r = rewriteCertain('SELECT * FROM t WHERE x = "orders"', { table: 'orders', newName: 'n' }, 'mysql')!;
    assert.equal(r.sql, 'SELECT * FROM t WHERE x = "orders"');
    assert.equal(r.rewritten, 0);
  });

  test('matching is case-insensitive; the replacement is the new name verbatim', () => {
    const r = rewriteCertain('SELECT * FROM ORDERS', { table: 'orders', newName: 'OrdersArchive' }, 'mysql')!;
    assert.equal(r.sql, 'SELECT * FROM OrdersArchive');
  });

  test('a longer identifier that merely contains the name is untouched', () => {
    const r = rewriteCertain('SELECT * FROM orders_archive', { table: 'orders', newName: 'n' }, 'mysql')!;
    assert.equal(r.rewritten, 0);
    assert.equal(r.sql, 'SELECT * FROM orders_archive');
  });

  test('a name inside a comment or string is not rewritten and not even reported', () => {
    const sql = "SELECT * FROM orders -- orders\nWHERE note = 'orders'";
    const r = rewriteCertain(sql, { table: 'orders', newName: 'n' }, 'mysql')!;
    assert.equal(r.rewritten, 1);
    assert.equal(r.sql, "SELECT * FROM n -- orders\nWHERE note = 'orders'");
  });

  test('a bare occurrence is quoted when the new name needs it', () => {
    const r = rewriteCertain('SELECT * FROM orders', { table: 'orders', newName: 'order' }, 'mysql')!;
    assert.equal(r.sql, 'SELECT * FROM `order`');
  });

  test('PostgreSQL quotes a mixed-case new name so it does not fold', () => {
    const r = rewriteCertain('SELECT * FROM orders', { table: 'orders', newName: 'Orders' }, 'postgres')!;
    assert.equal(r.sql, 'SELECT * FROM "Orders"');
  });

  test('a quote character inside the new name doubles up', () => {
    const r = rewriteCertain('SELECT * FROM `orders`', { table: 'orders', newName: 'or`ders' }, 'mysql')!;
    assert.equal(r.sql, 'SELECT * FROM `or``ders`');
  });

  test('a qualified reference (schema.table) is rewritten', () => {
    const r = rewriteCertain('SELECT * FROM shop.orders', { table: 'orders', newName: 'n' }, 'mysql')!;
    assert.equal(r.sql, 'SELECT * FROM shop.n');
  });

  test('every certain occurrence is rewritten, not just the first', () => {
    const r = rewriteCertain('SELECT * FROM orders JOIN orders_archive USING (x) UNION SELECT * FROM orders',
      { table: 'orders', newName: 'n' }, 'mysql')!;
    assert.equal(r.rewritten, 2);
    assert.equal(r.sql, 'SELECT * FROM n JOIN orders_archive USING (x) UNION SELECT * FROM n');
  });
});

describe('rewriteCertain — what never moves (the corruption guard)', () => {
  /// A bare column name in a statement that mentions the table is `likely`.
  /// Rewriting it is exactly how a rename corrupts a script.
  test('a likely occurrence is left alone and reported', () => {
    const sql = 'SELECT id FROM orders';
    const r = rewriteCertain(sql, { table: 'orders', column: 'id', newName: 'order_id' }, 'mysql')!;
    assert.equal(r.sql, sql, 'a likely occurrence was rewritten');
    assert.equal(r.rewritten, 0);
    assert.equal(r.review.length, 1);
    assert.equal(r.review[0].confidence, 'likely');
  });

  test('a possible occurrence is left alone and reported', () => {
    const sql = 'SELECT id FROM customers';
    const r = rewriteCertain(sql, { table: 'orders', column: 'id', newName: 'order_id' }, 'mysql')!;
    assert.equal(r.sql, sql);
    assert.equal(r.review[0].confidence, 'possible');
  });

  test('another table\'s qualified column is not even reported', () => {
    const r = rewriteCertain('SELECT customers.id FROM customers',
      { table: 'orders', column: 'id', newName: 'order_id' }, 'mysql')!;
    assert.equal(r.rewritten, 0);
    assert.equal(r.review.length, 0);
  });

  test('a qualified column of the right table IS rewritten', () => {
    const r = rewriteCertain('SELECT orders.id FROM orders',
      { table: 'orders', column: 'id', newName: 'order_id' }, 'mysql')!;
    assert.equal(r.sql, 'SELECT orders.order_id FROM orders');
  });

  test('an alias-qualified column of the right table is rewritten', () => {
    const r = rewriteCertain('SELECT o.id FROM orders o',
      { table: 'orders', column: 'id', newName: 'order_id' }, 'mysql')!;
    assert.equal(r.sql, 'SELECT o.order_id FROM orders o');
  });

  test('NEW.col in a trigger body rewrites only when the trigger is on this table', () => {
    const body = 'BEGIN SET NEW.amount = OLD.amount * 2; END';
    const yes = rewriteCertain(body, { table: 'orders', column: 'amount', newName: 'total' }, 'mysql', 'orders')!;
    assert.equal(yes.sql, 'BEGIN SET NEW.total = OLD.total * 2; END');
    const no = rewriteCertain(body, { table: 'orders', column: 'amount', newName: 'total' }, 'mysql', 'invoices')!;
    assert.equal(no.sql, body);
    assert.equal(no.review.length, 2);
  });

  test('review entries carry line numbers and the line text', () => {
    const sql = 'SELECT 1;\nSELECT id FROM orders;';
    const r = rewriteCertain(sql, { table: 'orders', column: 'id', newName: 'x' }, 'mysql')!;
    assert.equal(r.review[0].line, 2);
    assert.equal(r.review[0].lineText, 'SELECT id FROM orders;');
  });
});

describe('rewriteCertain — table-as-qualifier (the whole point of a table rename)', () => {
  const opts = { qualifierIsTable: true as const };

  /// MySQL normalises every stored view to `select `orders`.`id` …`. Without
  /// this promotion the FROM reference moves and the qualifier does not, and
  /// the recreated view still points at the old name — a rename that breaks
  /// the very object it recreated.
  test('`orders`.id moves with the table', () => {
    const r = rewriteCertain('select `orders`.`id` AS `id` from `orders`',
      { table: 'orders', newName: 'orders_v2' }, 'mysql', undefined, opts)!;
    assert.equal(r.sql, 'select `orders_v2`.`id` AS `id` from `orders_v2`');
  });

  test('a three-part name is a schema reference — not promoted', () => {
    const r = rewriteCertain('SELECT orders.x.y FROM orders',
      { table: 'orders', newName: 'n' }, 'mysql', undefined, opts)!;
    assert.equal(r.sql, 'SELECT orders.x.y FROM n');
  });

  /// `FROM other orders` binds the word to another table. Promoting
  /// `orders.id` there rewrites the WRONG table's column.
  test('when the name is alias-shadowed by another table, nothing is promoted', () => {
    const sql = 'SELECT orders.id FROM invoices orders';
    const r = rewriteCertain(sql, { table: 'orders', newName: 'n' }, 'mysql', undefined, opts)!;
    assert.equal(r.sql, sql);
    // the qualifier occurrence AND the alias definition itself — both likely,
    // both reported, neither rewritten
    assert.equal(r.review.length, 2);
    assert.ok(r.review.every(x => x.confidence === 'likely'));
  });

  test('a self-alias does not disable the promotion', () => {
    const r = rewriteCertain('SELECT orders.id FROM orders orders',
      { table: 'orders', newName: 'n' }, 'mysql', undefined, opts)!;
    assert.equal(r.sql, 'SELECT n.id FROM n orders');
  });

  test('the promotion is off without the option — searching semantics unchanged', () => {
    const r = rewriteCertain('SELECT orders.id FROM orders',
      { table: 'orders', newName: 'n' }, 'mysql')!;
    assert.equal(r.rewritten, 1, 'only the FROM occurrence is certain');
    assert.equal(r.sql, 'SELECT orders.id FROM n');
  });
});

describe('rewriteCertain — trigger ON clause', () => {
  /// SHOW CREATE TRIGGER emits `ON `orders``; `on` is not a table keyword
  /// anywhere else, so it is an explicit per-call extra, not a global rule.
  test('ON <table> rewrites with the extra keyword, only when asked', () => {
    const sql = 'CREATE TRIGGER `t` AFTER INSERT ON `orders` FOR EACH ROW INSERT INTO orders VALUES (1)';
    const plain = rewriteCertain(sql, { table: 'orders', newName: 'n' }, 'mysql')!;
    assert.equal(plain.sql, 'CREATE TRIGGER `t` AFTER INSERT ON `orders` FOR EACH ROW INSERT INTO n VALUES (1)');
    const trig = rewriteCertain(sql, { table: 'orders', newName: 'n' }, 'mysql', undefined,
      { tableKeywords: new Set(['on']) })!;
    assert.equal(trig.sql, 'CREATE TRIGGER `t` AFTER INSERT ON `n` FOR EACH ROW INSERT INTO n VALUES (1)');
  });
});

describe('rewriteCertain — invalid names', () => {
  const sql = 'SELECT * FROM orders';
  test('empty, dotted, newline and same-name are refused', () => {
    assert.equal(rewriteCertain(sql, { table: 'orders', newName: '' }, 'mysql'), null);
    assert.equal(rewriteCertain(sql, { table: 'orders', newName: 'a.b' }, 'mysql'), null);
    assert.equal(rewriteCertain(sql, { table: 'orders', newName: 'a\nb' }, 'mysql'), null);
    assert.equal(rewriteCertain(sql, { table: 'orders', newName: 'orders' }, 'mysql'), null);
  });

  test('a case-only change is allowed (PostgreSQL case folding is real)', () => {
    assert.notEqual(rewriteCertain(sql, { table: 'orders', newName: 'Orders' }, 'postgres'), null);
  });
});

// ── corpus label parsing ─────────────────────────────────────────────────────

describe('parseCorpusLabel', () => {
  test('mysql view / event: schema.name', () => {
    assert.deepEqual(parseCorpusLabel('view', 'shop.v_open'), { schema: 'shop', name: 'v_open' });
  });

  test('mysql routine: schema.name (procedure|function)', () => {
    assert.deepEqual(parseCorpusLabel('routine', 'shop.p_report (procedure)'),
      { schema: 'shop', name: 'p_report', routineType: 'procedure' });
    assert.deepEqual(parseCorpusLabel('routine', 'shop.f_tax (function)'),
      { schema: 'shop', name: 'f_tax', routineType: 'function' });
  });

  test('postgres routine: schema.name(identity args)', () => {
    assert.deepEqual(parseCorpusLabel('routine', 'public.f_tax(integer, text)'),
      { schema: 'public', name: 'f_tax', args: '(integer, text)' });
  });

  test('trigger: the ownerTable suffix is stripped exactly', () => {
    assert.deepEqual(parseCorpusLabel('trigger', 'shop.trg_ai on orders', 'orders'),
      { schema: 'shop', name: 'trg_ai' });
  });

  test('a trigger whose name contains " on " still parses with ownerTable', () => {
    assert.deepEqual(parseCorpusLabel('trigger', 'shop.turn on on orders', 'orders'),
      { schema: 'shop', name: 'turn on' });
  });

  test('a label without a schema dot is refused', () => {
    assert.equal(parseCorpusLabel('view', 'no_dots_here'), null);
  });
});

// ── DDL dialects ─────────────────────────────────────────────────────────────

describe('renameDdl', () => {
  /// safeIdent doctrine: legal bare names stay bare — a DBA does not want
  /// backticks smeared over every statement.
  test('mysql table and column', () => {
    assert.equal(renameDdl('mysql', 'shop', 'orders', undefined, 'orders_v2'),
      'ALTER TABLE shop.orders RENAME TO shop.orders_v2;');
    assert.equal(renameDdl('mysql', 'shop', 'orders', 'total', 'grand_total'),
      'ALTER TABLE shop.orders RENAME COLUMN total TO grand_total;');
  });

  test('postgres table and column', () => {
    assert.equal(renameDdl('postgres', 'public', 'orders', undefined, 'orders_v2'),
      'ALTER TABLE public.orders RENAME TO orders_v2;');
    assert.equal(renameDdl('postgres', 'public', 'orders', 'total', 'grand_total'),
      'ALTER TABLE public.orders RENAME COLUMN total TO grand_total;');
  });

  test('names that need quoting get it', () => {
    assert.equal(renameDdl('postgres', 'public', 'orders', undefined, 'Order'),
      'ALTER TABLE public.orders RENAME TO "Order";');
    assert.equal(renameDdl('mysql', 'shop', 'orders', undefined, 'order'),
      'ALTER TABLE shop.orders RENAME TO shop.`order`;');
  });
});

describe('renameColumnSupported', () => {
  test('unknown means supported — greying a feature the user has is worse', () => {
    assert.equal(renameColumnSupported(undefined), true);
    assert.equal(renameColumnSupported('not-a-version'), true);
  });

  test('mysql needs 8.0, mariadb needs 10.5', () => {
    assert.equal(renameColumnSupported('8.0.36'), true);
    assert.equal(renameColumnSupported('5.7.44-log'), false);
    assert.equal(renameColumnSupported('10.6.12-MariaDB'), true);
    assert.equal(renameColumnSupported('10.4.32-MariaDB'), false);
    assert.equal(renameColumnSupported('11.4.2-MariaDB'), true);
  });
});

describe('dropStatement', () => {
  const p = (kind: Parameters<typeof parseCorpusLabel>[0], label: string, owner?: string) =>
    parseCorpusLabel(kind, label, owner)!;

  test('mysql forms', () => {
    assert.equal(dropStatement('mysql', 'view', p('view', 'shop.v')), 'DROP VIEW shop.v;');
    assert.equal(dropStatement('mysql', 'trigger', p('trigger', 'shop.t on orders', 'orders')),
      'DROP TRIGGER shop.t;');
    assert.equal(dropStatement('mysql', 'event', p('event', 'shop.e')), 'DROP EVENT shop.e;');
    assert.equal(dropStatement('mysql', 'routine', p('routine', 'shop.p (procedure)')),
      'DROP PROCEDURE shop.p;');
    assert.equal(dropStatement('mysql', 'routine', p('routine', 'shop.f (function)')),
      'DROP FUNCTION shop.f;');
  });

  test('postgres drops a function by its identity arguments', () => {
    assert.equal(dropStatement('postgres', 'routine', p('routine', 'public.f(integer)')),
      'DROP FUNCTION public.f(integer);');
  });

  test('kinds that are never dropped return null', () => {
    assert.equal(dropStatement('mysql', 'constraint', p('constraint', 'shop.fk_orders')), null);
    assert.equal(dropStatement('postgres', 'view', p('view', 'public.v')), null);
  });
});

// ── the script ───────────────────────────────────────────────────────────────

describe('qualifyObjectName', () => {
  /// The error this prevents: the drop ran, the CREATE failed with 1046
  /// (no database selected), and the dependent is gone.
  test('an unqualified routine name gets the schema', () => {
    assert.equal(
      qualifyObjectName('CREATE DEFINER=`root`@`%` FUNCTION `f_tax`(a INT) RETURNS int RETURN a', 'shop', 'mysql'),
      'CREATE DEFINER=`root`@`%` FUNCTION shop.f_tax(a INT) RETURNS int RETURN a');
    assert.equal(
      qualifyObjectName('CREATE TRIGGER `trg` AFTER INSERT ON `t` FOR EACH ROW SET @x = 1', 'shop', 'mysql'),
      'CREATE TRIGGER shop.trg AFTER INSERT ON `t` FOR EACH ROW SET @x = 1');
    assert.equal(
      qualifyObjectName('CREATE DEFINER=`root`@`%` EVENT `ev` ON SCHEDULE EVERY 1 DAY DO SELECT 1', 'shop', 'mysql'),
      'CREATE DEFINER=`root`@`%` EVENT shop.ev ON SCHEDULE EVERY 1 DAY DO SELECT 1');
  });

  test('an already-qualified name is untouched (SHOW CREATE VIEW emits one)', () => {
    const sql = 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `shop`.`v` AS select 1';
    assert.equal(qualifyObjectName(sql, 'shop', 'mysql'), sql);
    const pg = 'CREATE OR REPLACE FUNCTION public.f() RETURNS bigint LANGUAGE sql AS $$ SELECT 1 $$';
    assert.equal(qualifyObjectName(pg, 'public', 'postgres'), pg);
  });

  test('a definer whose name collides with a keyword is not the object keyword', () => {
    const sql = 'CREATE DEFINER=`event`@`%` PROCEDURE `p`() BEGIN SELECT 1; END';
    assert.equal(qualifyObjectName(sql, 'shop', 'mysql'),
      'CREATE DEFINER=`event`@`%` PROCEDURE shop.p() BEGIN SELECT 1; END');
  });

  test('no recognisable header — unchanged rather than wrong', () => {
    assert.equal(qualifyObjectName('SELECT 1', 'shop', 'mysql'), 'SELECT 1');
  });
});

const MYSQL_VIEW = {
  sql: 'select `orders`.`id` AS `id`,`orders`.`total` AS `total` from `orders`',
  createSql: 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_open` AS '
    + 'select `orders`.`id` AS `id`,`orders`.`total` AS `total` from `orders`',
};

describe('buildRenameScript — mysql table rename', () => {
  const build = (objects: RenameObject[], over: Partial<Parameters<typeof buildRenameScript>[0]> = {}) =>
    buildRenameScript({
      engine: 'mysql', schema: 'shop', table: 'orders', newName: 'orders_v2',
      objects, searched: 10, ...over,
    })!;

  test('the happy path: drop, rename, recreate — in that order', () => {
    const r = build([obj({ ...MYSQL_VIEW })]);
    const s = r.script;
    const drop = s.indexOf('DROP VIEW shop.v_open;');
    const rename = s.indexOf('ALTER TABLE shop.orders RENAME TO shop.orders_v2;');
    const create = s.indexOf('CREATE ALGORITHM=UNDEFINED');
    assert.ok(drop !== -1 && rename !== -1 && create !== -1, s);
    assert.ok(drop < rename && rename < create,
      'a delete-before-insert slip leaves a window where nothing works');
    // The recreated definition names the NEW table — qualifier and FROM alike.
    assert.ok(s.includes('select `orders_v2`.`id` AS `id`'), s);
    assert.ok(!s.includes('from `orders`'), s);
    assert.deepEqual(r.recreated, ['shop.v_open']);
  });

  test('a view whose full definition could not be fetched is NOT dropped', () => {
    const r = build([obj({ ...MYSQL_VIEW, createSql: undefined })]);
    assert.ok(!r.script.includes('DROP VIEW'), r.script);
    assert.equal(r.recreated.length, 0);
    assert.ok(r.review.some(x => /NOT dropped/.test(x.message)), JSON.stringify(r.review));
  });

  test('an object with only likely/possible hits is not touched, only listed', () => {
    const r = build([obj({ id: 'p', kind: 'routine', label: 'shop.p_report (procedure)',
      sql: 'BEGIN SELECT orders; END' })]);
    assert.equal(r.dropped.length, 0);
    assert.equal(r.review.length, 1);
    assert.equal(r.review[0].confidence, 'likely');
    assert.match(r.review[0].message, /not rewritten/);
  });

  test('likely occurrences inside a recreated definition are flagged, not rewritten', () => {
    const r = build([obj({ kind: 'routine', label: 'shop.p (procedure)',
      sql: 'BEGIN SELECT * FROM orders; SELECT orders; END',
      createSql: 'CREATE DEFINER=`root`@`%` PROCEDURE `p`()\nBEGIN\n'
        + 'SELECT * FROM orders;\nSELECT orders;\nEND' })]);
    assert.equal(r.recreated.length, 1);
    assert.ok(r.script.includes('SELECT * FROM orders_v2;'), r.script);
    assert.ok(r.script.includes('SELECT orders;'), 'the likely occurrence moved');
    const flagged = r.review.filter(x => x.confidence === 'likely');
    assert.equal(flagged.length, 1);
    assert.match(flagged[0].message, /left unchanged in the recreated routine/);
    assert.equal(flagged[0].line, 4);
  });

  test('a trigger recreate rewrites the ON clause too', () => {
    const r = build([obj({ kind: 'trigger', label: 'shop.trg_ai on orders', ownerTable: 'orders',
      sql: 'BEGIN DELETE FROM orders WHERE id = OLD.id; END',
      createSql: 'CREATE DEFINER=`root`@`%` TRIGGER `trg_ai` AFTER INSERT ON `orders` '
        + 'FOR EACH ROW BEGIN DELETE FROM orders WHERE id = OLD.id; END' })]);
    assert.ok(r.script.includes('ON `orders_v2`'), r.script);
    assert.ok(r.script.includes('DELETE FROM orders_v2'), r.script);
    assert.ok(r.script.includes('DROP TRIGGER shop.trg_ai;'), r.script);
  });

  test('foreign keys follow a table rename by themselves — noted, not dropped', () => {
    const r = build([obj({ kind: 'constraint', label: 'shop.fk_cust',
      sql: 'ALTER TABLE lines ADD CONSTRAINT fk_cust FOREIGN KEY (oid) REFERENCES orders (id)',
      ownerTable: 'lines' })]);
    assert.equal(r.dropped.length, 0);
    assert.equal(r.autoUpdated.length, 1);
    assert.match(r.autoUpdated[0].why, /InnoDB/);
  });

  test('an open script with a certain hit is a review item, never a DROP', () => {
    const r = build([obj({ kind: 'buffer', label: 'Buffer 2', sql: 'SELECT * FROM orders' })]);
    assert.equal(r.dropped.length, 0);
    assert.match(r.review[0].message, /a script you can edit/);
  });

  test('a DEFINER in a recreated definition produces a privileges warning', () => {
    const r = build([obj({ ...MYSQL_VIEW })]);
    assert.ok(r.warnings.some(w => /DEFINER/.test(w)), JSON.stringify(r.warnings));
  });

  test('no dependents: the script is the rename plus the honest note', () => {
    const r = build([]);
    assert.match(r.script, /ALTER TABLE shop\.orders RENAME TO shop.orders_v2;/);
    assert.match(r.script, /No dependent object needed recreating/);
    assert.match(r.script, /application code/);
  });
});

describe('buildRenameScript — mysql column rename', () => {
  const build = (objects: RenameObject[], over: Partial<Parameters<typeof buildRenameScript>[0]> = {}) =>
    buildRenameScript({
      engine: 'mysql', schema: 'shop', table: 'orders', column: 'total',
      newName: 'grand_total', objects, ...over,
    })!;

  test('a view is dropped and recreated with the column replaced', () => {
    const r = build([obj({ ...MYSQL_VIEW })]);
    assert.equal(r.rename, 'ALTER TABLE shop.orders RENAME COLUMN total TO grand_total;');
    // The DDL sections only — the review section quotes the original line.
    const ddl = r.script.split('-- ── Not touched')[0];
    assert.ok(ddl.includes('`orders`.`grand_total` AS `total`'), r.script);
    assert.ok(!ddl.includes('`orders`.`total`'), r.script);
    // The select-list output alias must NOT move — it is the view's output
    // column name, and renaming it breaks the view's callers. It is listed.
    assert.ok(r.review.some(x => x.confidence === 'likely'), JSON.stringify(r.review));
  });

  test('a generated column naming the renamed column is a review item, not a rewrite', () => {
    const r = build([obj({ kind: 'default', label: 'shop.orders.total_x2',
      sql: '(`total` * 2) ', ownerTable: 'orders' })]);
    assert.equal(r.dropped.length, 0);
    assert.equal(r.review.length, 1);
    assert.match(r.review[0].message, /generated-column expression/);
  });

  test('an old server gets a RENAME COLUMN warning in the script', () => {
    const r = build([], { serverVersion: '5.7.44-log' });
    assert.ok(r.warnings.some(w => /RENAME COLUMN/.test(w)));
    assert.match(r.script, /-- WARNING: .*RENAME COLUMN/);
  });

  test('a new server gets no warning', () => {
    assert.equal(build([], { serverVersion: '8.0.36' }).warnings.length, 0);
  });
});

describe('buildRenameScript — postgres', () => {
  const build = (objects: RenameObject[], over: Partial<Parameters<typeof buildRenameScript>[0]> = {}) =>
    buildRenameScript({
      engine: 'postgres', schema: 'public', table: 'orders', newName: 'orders_v2',
      objects, ...over,
    })!;

  /// PostgreSQL stores views/constraints/indexes/defaults as catalog
  /// references — they follow the rename. Dropping them would be wrong work.
  test('views, constraints, indexes and defaults follow automatically', () => {
    const r = build([
      obj({ id: 'v', kind: 'view', label: 'public.v_open', sql: 'SELECT orders.id FROM orders' }),
      obj({ id: 'c', kind: 'constraint', label: 'public.lines_fk',
        sql: 'FOREIGN KEY (oid) REFERENCES orders(id)', ownerTable: 'lines' }),
      obj({ id: 'i', kind: 'index', label: 'public.orders_expr_idx',
        sql: 'CREATE INDEX orders_expr_idx ON public.orders USING btree (upper(status))', ownerTable: 'orders' }),
    ]);
    assert.equal(r.dropped.length, 0);
    assert.equal(r.autoUpdated.length, 3);
    assert.ok(r.script.includes('follow'), r.script);
  });

  test('routine bodies are text — dropped and recreated', () => {
    const r = build([obj({ kind: 'routine', label: 'public.recalc()',
      sql: 'SELECT count(*) FROM orders',
      createSql: 'CREATE OR REPLACE FUNCTION public.recalc()\n RETURNS bigint\n LANGUAGE sql\n'
        + 'AS $function$ SELECT count(*) FROM orders $function$' })]);
    assert.ok(r.script.includes('DROP FUNCTION public.recalc();'), r.script);
    assert.ok(r.script.includes('AS $function$ SELECT count(*) FROM orders_v2 $function$;'), r.script);
  });

  test('a trigger binding follows; its function is the text that breaks', () => {
    const r = build([obj({ kind: 'trigger', label: 'public.trg on orders', ownerTable: 'orders',
      sql: 'CREATE TRIGGER trg AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION f()' })]);
    assert.equal(r.dropped.length, 0);
    assert.equal(r.autoUpdated.length, 1);
  });
});

describe('buildRenameScript — the contract', () => {
  test('an unusable new name produces no script at all', () => {
    assert.equal(buildRenameScript({ engine: 'mysql', schema: 's', table: 't',
      newName: 't', objects: [] }), null);
    assert.equal(buildRenameScript({ engine: 'mysql', schema: 's', table: 't',
      newName: 'has.dot', objects: [] }), null);
    assert.equal(invalidNewName('', 't'), 'the new name is empty');
  });

  test('only certain hits are ever rewritten — corpus-wide invariant', () => {
    // one certain (view FROM), one likely (bare name, not a table position)
    const r = buildRenameScript({
      engine: 'mysql', schema: 'shop', table: 'orders', newName: 'n',
      objects: [
        obj({ ...MYSQL_VIEW, id: 'v' }),
        obj({ id: 'r', kind: 'routine', label: 'shop.p (procedure)', sql: 'BEGIN SELECT orders; END' }),
        obj({ id: 'b', kind: 'buffer', label: 'Buffer 1', sql: 'SELECT orders FROM invoices' }),
      ],
    })!;
    assert.ok(!r.script.includes('SELECT n;'), 'a likely hit was rewritten');
    assert.equal(r.review.length, 2);
    assert.equal(r.recreated.length, 1);
  });

  test('the recreate keeps exactly one trailing semicolon', () => {
    const r = buildRenameScript({
      engine: 'mysql', schema: 'shop', table: 'orders', newName: 'n',
      objects: [obj({ ...MYSQL_VIEW, createSql: MYSQL_VIEW.createSql + ';\n' })],
    })!;
    assert.ok(!r.script.includes(';;'), r.script);
  });

  /// A procedure body is full of semicolons. Without a DELIMITER wrapper the
  /// client splits the CREATE at the body's first ';' — the drop ran, the
  /// recreate is a syntax error, and the procedure is gone.
  test('a compound body runs the recreate section under DELIMITER //', () => {
    const r = buildRenameScript({
      engine: 'mysql', schema: 'shop', table: 'orders', newName: 'n',
      objects: [obj({ kind: 'routine', label: 'shop.p (procedure)',
        sql: 'BEGIN SELECT COUNT(*) FROM orders; SELECT 1; END',
        createSql: 'CREATE PROCEDURE `p`()\nBEGIN\nSELECT COUNT(*) FROM orders;\nSELECT 1;\nEND' })],
    })!;
    assert.match(r.script, /DELIMITER \/\/\nCREATE PROCEDURE shop\.p\(\)\nBEGIN\nSELECT COUNT\(\*\) FROM n;\nSELECT 1;\nEND\n\/\/\n\nDELIMITER ;/);
    // the drop and the rename stay on the plain terminator
    assert.match(r.script, /DROP PROCEDURE shop\.p;\n\n/);
    assert.match(r.script, /RENAME TO shop\.n;\n\n/);
  });

  test('a view-only recreate needs no DELIMITER wrapper', () => {
    const r = buildRenameScript({
      engine: 'mysql', schema: 'shop', table: 'orders', newName: 'n',
      objects: [obj({ ...MYSQL_VIEW })],
    })!;
    assert.ok(!r.script.includes('DELIMITER'), r.script);
  });
});
