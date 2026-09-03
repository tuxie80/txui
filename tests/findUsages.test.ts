/**
 * Find usages (src/utils/findUsages.ts).
 *
 * This is consulted before a `DROP COLUMN`, so the two failures that matter
 * are opposite and both expensive: a missed usage means dropping something a
 * view depends on, and a list full of noise gets skimmed, which produces the
 * same outcome by a different route.
 *
 * Most of these are therefore about *not matching* — inside comments, inside
 * strings, inside longer identifiers, and under another table's qualifier.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findUsages, maskLiterals, summarise,
  type UsageSource,
} from '../src/utils/findUsages.ts';
import { corpusKinds, corpusSql } from '../src/utils/usageSources.ts';

const src = (sql: string, over: Partial<UsageSource> = {}): UsageSource => ({
  id: over.id ?? 's1', kind: over.kind ?? 'view', label: over.label ?? 'v', sql,
  ...over,
});

const find = (sql: string, q: { table?: string; column?: string }, engine: 'mysql' | 'postgres' = 'mysql') =>
  findUsages([src(sql)], q, engine);

describe('masking', () => {
  test('a line comment is not searched', () => {
    assert.equal(find('SELECT 1 -- FROM orders', { table: 'orders' }).usages.length, 0);
  });

  test('a block comment is not searched', () => {
    assert.equal(find('SELECT /* orders */ 1', { table: 'orders' }).usages.length, 0);
  });

  test('a string literal is not searched', () => {
    assert.equal(find("SELECT 'orders' AS t", { table: 'orders' }).usages.length, 0);
  });

  /// `''` inside a string is an escaped quote, not the end of it — reading it
  /// as the end would leave the rest of the string unmasked.
  test('an escaped quote does not end the string early', () => {
    assert.equal(find("SELECT 'it''s orders here' AS t", { table: 'orders' }).usages.length, 0);
  });

  /// The difference that matters most: a backtick is a NAME in MySQL. The
  /// completion engine's `blank()` treats it as a string, which would drop
  /// every carefully-quoted reference.
  test('a backtick-quoted table is found on MySQL', () => {
    assert.equal(find('SELECT * FROM `orders`', { table: 'orders' }, 'mysql').usages.length, 1);
  });

  test('a double-quoted table is found on PostgreSQL', () => {
    assert.equal(find('SELECT * FROM "orders"', { table: 'orders' }, 'postgres').usages.length, 1);
  });

  /// …and the engines disagree, so the same text means different things.
  test('a double-quoted name is a string on MySQL', () => {
    assert.equal(find('SELECT "orders"', { table: 'orders' }, 'mysql').usages.length, 0);
  });

  /// A PostgreSQL function body lives inside `$$ … $$`. Masking it would make
  /// every routine in the database look unused.
  test('a dollar-quoted body is searched, not masked', () => {
    const sql = 'CREATE FUNCTION f() RETURNS int AS $$ SELECT count(*) FROM orders $$ LANGUAGE sql';
    assert.equal(find(sql, { table: 'orders' }, 'postgres').usages.length, 1);
  });

  test('masking preserves offsets so line numbers stay right', () => {
    const sql = "-- comment\nSELECT 'x'\nFROM orders";
    assert.equal(maskLiterals(sql, 'mysql').length, sql.length);
    assert.equal(find(sql, { table: 'orders' }).usages[0].line, 3);
  });
});

describe('whole-identifier matching', () => {
  /// The classic grep failure.
  test('a longer name containing the target does not match', () => {
    assert.equal(find('SELECT old_customer_id FROM t', { column: 'customer_id' }).usages.length, 0);
  });

  test('a name the target is a prefix of does not match', () => {
    assert.equal(find('SELECT * FROM orders_archive', { table: 'orders' }).usages.length, 0);
  });

  test('matching ignores case', () => {
    assert.equal(find('SELECT * FROM ORDERS', { table: 'orders' }).usages.length, 1);
  });

  test('a qualified reference is found', () => {
    assert.equal(find('SELECT * FROM shop.orders', { table: 'orders' }).usages.length, 1);
  });
});

describe('table confidence', () => {
  test('after FROM it can only be the table', () => {
    assert.equal(find('SELECT * FROM orders', { table: 'orders' }).usages[0].confidence, 'certain');
  });

  test('after JOIN likewise', () => {
    assert.equal(find('SELECT * FROM a JOIN orders ON 1=1', { table: 'orders' })
      .usages.find(u => u.confidence === 'certain') !== undefined, true);
  });

  test('after UPDATE and INSERT INTO likewise', () => {
    assert.equal(find('UPDATE orders SET x = 1', { table: 'orders' }).usages[0].confidence, 'certain');
    assert.equal(find('INSERT INTO orders VALUES (1)', { table: 'orders' }).usages[0].confidence, 'certain');
  });

  /// A column called `orders` is a real possibility, so this is reported and
  /// flagged rather than dropped or promoted.
  test('the same name somewhere else is likely, not certain', () => {
    const u = find('SELECT orders FROM totals', { table: 'orders' }).usages[0];
    assert.equal(u.confidence, 'likely');
    assert.match(u.note!, /not in a table position/);
  });
});

describe('column confidence', () => {
  test('qualified by the table itself is certain', () => {
    const u = find('SELECT orders.id FROM orders', { table: 'orders', column: 'id' }).usages[0];
    assert.equal(u.confidence, 'certain');
  });

  test('qualified by an alias of the table is certain', () => {
    const u = find('SELECT o.id FROM orders o', { table: 'orders', column: 'id' }).usages[0];
    assert.equal(u.confidence, 'certain');
  });

  test('AS-style aliases resolve too', () => {
    const u = find('SELECT o.id FROM orders AS o', { table: 'orders', column: 'id' }).usages[0];
    assert.equal(u.confidence, 'certain');
  });

  /// The important negative: another table's column of the same name is a
  /// different column, and listing it would be wrong, not merely noisy.
  test('qualified by a different table is not a usage at all', () => {
    const r = find('SELECT customers.id FROM customers', { table: 'orders', column: 'id' });
    assert.equal(r.usages.length, 0);
  });

  test('bare, in a statement that references the table, is likely', () => {
    const u = find('SELECT id FROM orders', { table: 'orders', column: 'id' }).usages[0];
    assert.equal(u.confidence, 'likely');
    assert.match(u.note!, /references orders/);
  });

  test('bare, with the table nowhere in sight, is only possible', () => {
    const u = find('SELECT id FROM customers', { table: 'orders', column: 'id' }).usages[0];
    assert.equal(u.confidence, 'possible');
    assert.match(u.note!, /probably another table/);
  });

  test('a column with no table given is always ambiguous', () => {
    const u = find('SELECT id FROM anything', { column: 'id' }).usages[0];
    assert.equal(u.confidence, 'possible');
    assert.match(u.note!, /no table given/);
  });

  /// `orders WHERE` must not bind "where" as an alias, or every bare column in
  /// the statement would be reported as certain.
  test('a keyword after the table is not an alias', () => {
    const u = find('SELECT id FROM orders WHERE 1=1', { table: 'orders', column: 'id' }).usages[0];
    assert.equal(u.confidence, 'likely', 'a reserved word was bound as an alias');
  });
});

/**
 * A generated column's expression, a default, a constraint and an index all
 * live *on* a table without naming it. `(amount * 2)` mentions no table at
 * all, so without `ownerTable` the strongest dependency in the schema — drop
 * the column and the generated column goes with it — was reported as the
 * weakest verdict the matcher has.
 */
describe('definitions that belong to a table', () => {
  const owned = (sql: string, ownerTable: string): UsageSource =>
    ({ id: 'g', kind: 'default', label: 'orders.amount_x2', sql, ownerTable });

  test('a bare column in the table\'s own expression is certain', () => {
    const r = findUsages([owned('(`amount` * 2)', 'orders')],
      { table: 'orders', column: 'amount' }, 'mysql');
    assert.equal(r.usages[0].confidence, 'certain');
  });

  test('the same expression on another table is not', () => {
    const r = findUsages([owned('(`amount` * 2)', 'invoices')],
      { table: 'orders', column: 'amount' }, 'mysql');
    assert.equal(r.usages[0].confidence, 'possible');
  });

  test('an owner still loses to an explicit foreign qualifier', () => {
    const r = findUsages([owned('customers.amount', 'orders')],
      { table: 'orders', column: 'amount' }, 'mysql');
    assert.equal(r.usages.length, 0, "another table's column is not this one");
  });
});

/**
 * `NEW.amount` is a column of whatever table the trigger fires on. Treating
 * NEW/OLD as "some other table's qualifier" dropped every trigger reference in
 * the schema — a false negative, and triggers are where a silently broken
 * reference does its damage quietly.
 */
describe('trigger row aliases', () => {
  const trig = (sql: string, ownerTable?: string): UsageSource =>
    ({ id: 't', kind: 'trigger', label: 't_orders', sql, ownerTable });

  test('NEW.col on a trigger whose table is known is certain', () => {
    const r = findUsages([trig('BEGIN SET NEW.amount = 1; END', 'orders')],
      { table: 'orders', column: 'amount' }, 'mysql');
    assert.equal(r.usages[0].confidence, 'certain');
  });

  test('OLD.col counts the same way', () => {
    const r = findUsages([trig('BEGIN SELECT OLD.amount; END', 'orders')],
      { table: 'orders', column: 'amount' }, 'mysql');
    assert.equal(r.usages[0].confidence, 'certain');
  });

  /// PostgreSQL keeps the body in a separate function, so the table is not
  /// recorded with it. Reported and flagged, never dropped.
  test('with no table recorded it is reported as possible, not dropped', () => {
    const r = findUsages([{ id: 'f', kind: 'routine', label: 'trg_f()',
      sql: 'BEGIN NEW.amount := NEW.amount; RETURN NEW; END' }],
      { table: 'orders', column: 'amount' }, 'postgres');
    assert.equal(r.usages.length, 2);
    assert.equal(r.usages[0].confidence, 'possible');
    assert.match(r.usages[0].note!, /whichever table this trigger fires on/);
  });

  test('a trigger on a different table is not this column', () => {
    const r = findUsages([trig('BEGIN SET NEW.amount = 1; END', 'invoices')],
      { table: 'orders', column: 'amount' }, 'mysql');
    assert.equal(r.usages[0].confidence, 'possible');
  });
});

describe('positions', () => {
  test('line, column and the line text are reported', () => {
    const u = find('SELECT 1\nFROM orders\nWHERE x', { table: 'orders' }).usages[0];
    assert.equal(u.line, 2);
    assert.equal(u.column, 6);
    assert.equal(u.lineText, 'FROM orders');
  });

  test('every occurrence is reported, not just the first', () => {
    const r = find('SELECT * FROM orders UNION SELECT * FROM orders', { table: 'orders' });
    assert.equal(r.usages.length, 2);
  });
});

describe('report', () => {
  const sources: UsageSource[] = [
    { id: 'v', kind: 'view', label: 'v_open', sql: 'SELECT * FROM orders' },
    { id: 'b', kind: 'buffer', label: 'Buffer 1', sql: 'SELECT * FROM orders' },
    { id: 'n', kind: 'routine', label: 'p_none', sql: 'SELECT 1' },
  ];

  test('only sources with a hit are listed', () => {
    const r = findUsages(sources, { table: 'orders' }, 'mysql');
    assert.deepEqual(r.hitSources.map(s => s.id), ['v', 'b']);
    assert.equal(r.searched, 3, 'the denominator counts everything searched');
  });

  /// Database objects first: a view that breaks is the reason to run this, and
  /// an open buffer is something you can already see.
  test('database objects are listed before scripts', () => {
    const reversed = [sources[1], sources[0]];
    const r = findUsages(reversed, { table: 'orders' }, 'mysql');
    assert.deepEqual(r.hitSources.map(s => s.kind), ['view', 'buffer']);
  });

  test('the counts add up', () => {
    const r = findUsages(sources, { table: 'orders' }, 'mysql');
    assert.equal(r.certain + r.likely + r.possible, r.usages.length);
  });
});

describe('summarise', () => {
  /// "No usages found" alone reads as "safe to drop". It is not — nothing here
  /// has seen the application.
  test('an empty result says what was not searched', () => {
    const r = findUsages([src('SELECT 1')], { table: 'orders' }, 'mysql');
    const s = summarise(r, 'orders');
    assert.match(s, /1 database object/);
    assert.match(s, /application code/);
  });

  test('a populated result breaks the count down by confidence', () => {
    const r = findUsages([
      src('SELECT o.id FROM orders o', { id: 'a' }),
      src('SELECT id FROM customers', { id: 'b' }),
    ], { table: 'orders', column: 'id' }, 'mysql');
    const s = summarise(r, 'orders.id');
    assert.match(s, /1 certain/);
    assert.match(s, /1 possible/);
  });

  test('singular and plural are both right', () => {
    const one = findUsages([src('SELECT * FROM orders')], { table: 'orders' }, 'mysql');
    assert.match(summarise(one, 'orders'), /1 reference to orders across 1 object/);
  });
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('T-SQL bracketed identifiers survive masking', () => {
  // A name is not a literal. Masking [customers] would make every object that
  // references it look unused — the exact failure this feature exists to
  // prevent, reported as "nothing depends on this, safe to drop".
  const sql = "SELECT [c].[name] FROM [sales].[customers] c";
  const masked = maskLiterals(sql, 'sqlserver');
  assert.ok(masked.includes('[sales].[customers]'));
  assert.ok(masked.includes('[c].[name]'));
});

test('an escaped bracket does not end the identifier early', () => {
  // `]]` inside brackets is a literal ]. Stopping at the first one would split
  // the name and lose the rest of the statement.
  const masked = maskLiterals('SELECT [od]]d] FROM t', 'sqlserver');
  assert.ok(masked.includes('[od]]d]'), masked);
  assert.ok(masked.includes('FROM t'), masked);
});

test('a backslash is NOT an escape inside a T-SQL string', () => {
  // MySQL treats it as one; T-SQL does not. Skipping the character after a
  // backslash would mask past the closing quote and swallow real SQL.
  const masked = maskLiterals("SELECT 'a\\' AS x, [keep] FROM t", 'sqlserver');
  assert.ok(masked.includes('[keep]'), masked);
  assert.ok(masked.includes('FROM t'), masked);
});

test('the SQL Server corpus covers the kinds only it has', () => {
  const kinds = corpusKinds('sqlserver');
  // Filtered indexes carry a WHERE that can name a column appearing nowhere
  // else; a computed column is an expression a DROP COLUMN silently breaks.
  assert.ok(kinds.includes('index'));
  assert.ok(kinds.includes('computed'));
  // No matview: SQL Server's equivalent is an indexed VIEW, already covered.
  assert.ok(!kinds.includes('matview'));
  assert.ok(!kinds.includes('event'));
});

test('the corpus reads catalogs only, and every branch returns five columns', () => {
  const sql = corpusSql('sales', 'sqlserver');
  assert.equal((sql.match(/UNION ALL/g) ?? []).length, 7);
  assert.match(sql, /OBJECT_DEFINITION/);
  assert.match(sql, /sys\.computed_columns/);
  assert.match(sql, /filter_definition IS NOT NULL/);
  // Foreign keys have no text, so one is synthesised — the dependency is real.
  assert.match(sql, /FOREIGN KEY REFERENCES/);
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/.test(sql), 'corpus must be read-only');
});
