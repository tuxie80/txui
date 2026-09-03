/**
 * Rename refactoring (src/utils/renameRefactor.ts).
 *
 * The design contract: an occurrence is rewritten only when it PROVABLY names
 * the symbol under the caret (`definite`); everything plausible-but-unprovable
 * is `review` and comes back in the report untouched. Most of these tests are
 * corruption guards — they assert what must NOT be rewritten.
 *
 * The caret position is written as a `|` marker in the SQL, stripped before
 * the call — far less fragile than offset arithmetic against the test text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renameTargetAt, planRename, applyRename,
  type RenameSchema,
} from '../src/utils/renameRefactor.ts';

const schema = (tables: Record<string, string[]>): RenameSchema => ({
  tables: Object.entries(tables).map(([name, columns]) => ({ name, columns })),
});

const SHOP = schema({
  orders: ['id', 'customer_id', 'total', 'state'],
  customers: ['id', 'name', 'email'],
  line_items: ['id', 'order_id', 'price'],
});

function planAt(marked: string, sch: RenameSchema = SHOP, engine = 'mysql') {
  const offset = marked.indexOf('|');
  assert.ok(offset >= 0, 'missing caret marker |');
  const sql = marked.replace('|', '');
  const target = renameTargetAt(sql, offset, engine);
  assert.ok(target, 'no rename target at |');
  return { sql, target: target!, plan: planRename(sql, target!, sch, engine) };
}

function rename(marked: string, newName: string, sch: RenameSchema = SHOP, engine = 'mysql') {
  const { sql, plan } = planAt(marked, sch, engine);
  const r = applyRename(sql, plan, newName, engine);
  assert.ok(r, 'applyRename returned null');
  return r!;
}

// ── target resolution ────────────────────────────────────────────────────────

test('caret on a keyword, number or whitespace yields no target', () => {
  assert.equal(renameTargetAt('SELECT o.id FROM orders o', 2, 'mysql'), null);
  assert.equal(renameTargetAt('SELECT 42', 8, 'mysql'), null);
  assert.equal(renameTargetAt('SELECT 1  FROM t', 9, 'mysql'), null); // on a space
});

test('caret in the schema position of a three-part name yields no target', () => {
  assert.equal(renameTargetAt('SELECT shop.orders.id FROM shop.orders', 9, 'mysql'), null);
});

test('caret just after a word still counts', () => {
  const t = renameTargetAt('SELECT * FROM orders', 'SELECT * FROM orders'.length, 'mysql');
  assert.equal(t?.kind, 'table');
  assert.equal(t?.name, 'orders');
});

// ── table rename ─────────────────────────────────────────────────────────────

test('table rename rewrites table positions across statements', () => {
  const r = rename(
    'SELECT * FROM ord|ers;\nUPDATE orders SET state = \'x\';\nINSERT INTO orders (id) VALUES (1);',
    'order_items');
  assert.equal(r.text,
    'SELECT * FROM order_items;\nUPDATE order_items SET state = \'x\';\nINSERT INTO order_items (id) VALUES (1);');
  assert.equal(r.rewritten, 3);
  assert.equal(r.reviews.length, 0);
});

test('table rename rewrites the table part of schema-qualified names only', () => {
  const r = rename('SELECT * FROM shop.ord|ers', 'order_items');
  assert.equal(r.text, 'SELECT * FROM shop.order_items');
  assert.equal(r.rewritten, 1);
});

test('table rename rewrites the table used as a column qualifier', () => {
  const r = rename('SELECT orders.id, orders.total FROM ord|ers', 'order_items');
  assert.equal(r.text, 'SELECT order_items.id, order_items.total FROM order_items');
  assert.equal(r.rewritten, 3);
});

test('table rename does NOT touch the name shadowed by an alias in another statement', () => {
  const r = rename(
    'SELECT * FROM ord|ers;\nSELECT orders.total FROM customers orders WHERE orders.id = 1;',
    'order_items');
  // Only the first statement's FROM rewrites; in the second statement `orders`
  // is provably an alias for customers — not the table.
  assert.equal(r.text,
    'SELECT * FROM order_items;\nSELECT orders.total FROM customers orders WHERE orders.id = 1;');
  assert.equal(r.rewritten, 1);
});

test('table rename does NOT touch a CTE that shadows the table name', () => {
  const r = rename(
    'WITH orders AS (SELECT 1 AS x) SELECT * FROM orders;\nSELECT * FROM ord|ers;',
    'order_items');
  assert.equal(r.text,
    'WITH orders AS (SELECT 1 AS x) SELECT * FROM orders;\nSELECT * FROM order_items;');
  assert.equal(r.rewritten, 1);
});

test('a table-name match outside a table position is review, not rewritten', () => {
  // `orders` in the select list over line_items — plausibly a column there.
  const sch = schema({
    orders: ['id', 'total'],
    line_items: ['id', 'orders'],
  });
  const r = rename('SELECT * FROM ord|ers;\nSELECT orders FROM line_items;', 'order_items', sch);
  assert.equal(r.text, 'SELECT * FROM order_items;\nSELECT orders FROM line_items;');
  assert.equal(r.rewritten, 1);
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0].reason, /not in a table position/);
  assert.equal(r.reviews[0].line, 2);
});

// ── column rename ────────────────────────────────────────────────────────────

test('column rename rewrites one joined table\'s column, not the other\'s', () => {
  const r = rename(
    'SELECT o.i|d, c.id FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.id > 5',
    'order_id');
  assert.equal(r.text,
    'SELECT o.order_id, c.id FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.order_id > 5');
  assert.equal(r.rewritten, 2);
});

test('bare column with a unique holder in scope is definite', () => {
  const r = rename('SELECT tot|al FROM orders o WHERE total > 10', 'grand_total');
  assert.equal(r.text, 'SELECT grand_total FROM orders o WHERE grand_total > 10');
  assert.equal(r.rewritten, 2);
});

test('bare column held by two in-scope tables is review, not rewritten', () => {
  const r = rename(
    'SELECT o.i|d, id FROM orders o JOIN customers c ON o.customer_id = c.id',
    'pk');
  assert.equal(r.text,
    'SELECT o.pk, id FROM orders o JOIN customers c ON o.customer_id = c.id');
  assert.equal(r.rewritten, 1); // only o.id is provably orders.id
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0].reason, /also has a column/);
});

test('bare column with unloaded schema is review; alias-qualified refs stay definite', () => {
  const r = rename('SELECT o.i|d, id FROM orders o', 'order_id', schema({}));
  assert.equal(r.text, 'SELECT o.order_id, id FROM orders o');
  assert.equal(r.rewritten, 1); // o.id provably binds to orders through the alias
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0].reason, /not loaded/);
});

test('an unresolvable binding leaves everything for review and rewrites nothing', () => {
  const r = rename('SELECT nob|ody FROM t', 'someone', schema({}));
  assert.equal(r.text, 'SELECT nobody FROM t');
  assert.equal(r.rewritten, 0);
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0].reason, /could not resolve/);
});

test('qualified vs unqualified: a qualifier that resolves elsewhere is skipped, unknown is review', () => {
  const sch = schema({
    orders: ['id', 'customer_id', 'total'],
    customers: ['id', 'name', 'total'],
  });
  const r = rename(
    'SELECT o.to|tal, c.total, mystery.total FROM orders o JOIN customers c ON o.customer_id = c.id',
    'grand_total', sch);
  assert.equal(r.text,
    'SELECT o.grand_total, c.total, mystery.total FROM orders o JOIN customers c ON o.customer_id = c.id');
  assert.equal(r.rewritten, 1);
  assert.equal(r.reviews.length, 1); // mystery.total — qualifier resolves to nothing
  assert.match(r.reviews[0].reason, /does not resolve/);
});

test('an output alias is a new name, not a reference — left alone', () => {
  const r = rename('SELECT o.to|tal AS total FROM orders o', 'grand_total');
  assert.equal(r.text, 'SELECT o.grand_total AS total FROM orders o');
  assert.equal(r.rewritten, 1);
  assert.equal(r.reviews.length, 0);
});

test('INSERT column list entries are provably the target table\'s columns', () => {
  const r = rename('INSERT INTO orders (id, to|tal) VALUES (1, 2)', 'grand_total');
  assert.equal(r.text, 'INSERT INTO orders (id, grand_total) VALUES (1, 2)');
  assert.equal(r.rewritten, 1);
});

test('three-part name: the column part binds through the middle qualifier', () => {
  const r = rename('SELECT shop.orders.i|d FROM shop.orders', 'order_id');
  assert.equal(r.text, 'SELECT shop.orders.order_id FROM shop.orders');
  assert.equal(r.rewritten, 1);
});

// ── alias / CTE rename (statement-scoped, regression of renameSymbol) ───────

test('alias rename rewrites definition and qualifier uses within the statement', () => {
  const r = rename('SELECT o.id FROM orders |o WHERE o.total = 1', 'ord');
  assert.equal(r.text, 'SELECT ord.id FROM orders ord WHERE ord.total = 1');
  assert.equal(r.rewritten, 3);
});

test('alias rename is statement-scoped — the same word elsewhere is untouched', () => {
  const r = rename('SELECT o.id FROM orders |o;\nSELECT o.name FROM customers o;', 'ord');
  assert.equal(r.text, 'SELECT ord.id FROM orders ord;\nSELECT o.name FROM customers o;');
  assert.equal(r.rewritten, 2);
});

test('alias rename does not touch a same-named column of another alias', () => {
  const sch = schema({ things: ['id', 'o'], orders: ['id'] });
  const r = rename('SELECT x.o FROM things x, orders |o WHERE o.id = x.id', 'ord', sch);
  assert.equal(r.text, 'SELECT x.o FROM things x, orders ord WHERE ord.id = x.id');
  assert.equal(r.rewritten, 2);
});

test('CTE rename rewrites definition and references within the statement', () => {
  const r = rename('WITH |c AS (SELECT 1 AS id) SELECT c.id FROM c', 'cte');
  assert.equal(r.text, 'WITH cte AS (SELECT 1 AS id) SELECT cte.id FROM cte');
  assert.equal(r.rewritten, 3);
});

test('caret on a CTE reference renames the CTE, not a real table of that name', () => {
  const { target } = planAt('WITH orders AS (SELECT 1 AS x) SELECT * FROM ord|ers');
  assert.equal(target.kind, 'cte');
});

// ── CTE column rename ────────────────────────────────────────────────────────

test('CTE column rename rewrites the projection alias and qualified refs', () => {
  const sch = schema({ users: ['id'] });
  const r = rename('WITH c AS (SELECT u.id AS nid FROM users u) SELECT c.n|id FROM c', 'user_id', sch);
  assert.equal(r.text, 'WITH c AS (SELECT u.id AS user_id FROM users u) SELECT c.user_id FROM c');
  assert.equal(r.rewritten, 2);
});

test('CTE column rename flags a bare projection source for review instead of rewriting it', () => {
  const sch = schema({ users: ['id'] });
  const r = rename('WITH c AS (SELECT u.id FROM users u) SELECT c.i|d FROM c', 'user_id', sch);
  // `c.id` rewrites; `u.id` projects the CTE column — rewriting it would rename
  // users.id, so it is reported, not touched.
  assert.equal(r.text, 'WITH c AS (SELECT u.id FROM users u) SELECT c.user_id FROM c');
  assert.equal(r.rewritten, 1);
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0].reason, /projects this as/);
});

// ── quoting ──────────────────────────────────────────────────────────────────

test('quoted occurrences keep their quote style (MySQL backticks)', () => {
  const r = rename('SELECT `id` FROM `ord|ers`', 'order_items');
  assert.equal(r.text, 'SELECT `id` FROM `order_items`');
  assert.equal(r.rewritten, 1);
});

test('quoted occurrences keep their quote style (PostgreSQL double quotes)', () => {
  const r = rename('SELECT "id" FROM "ord|ers"', 'order_items', SHOP, 'postgres');
  assert.equal(r.text, 'SELECT "id" FROM "order_items"');
  assert.equal(r.rewritten, 1);
});

test('a keyword as the new name forces quoting on bare occurrences', () => {
  const r = rename('SELECT * FROM ord|ers', 'order'); // ORDER is reserved
  assert.equal(r.text, 'SELECT * FROM `order`');
  assert.equal(r.rewritten, 1);
});

test('a keyword as the new name keeps quoted occurrences quoted without doubling', () => {
  const r = rename('SELECT * FROM `ord|ers`', 'order');
  assert.equal(r.text, 'SELECT * FROM `order`');
  assert.equal(r.rewritten, 1);
});

test('a keyword new name quotes with double quotes on PostgreSQL', () => {
  const r = rename('SELECT * FROM ord|ers', 'order', SHOP, 'postgres');
  assert.equal(r.text, 'SELECT * FROM "order"');
});

test('a plain new name is never quoted', () => {
  const r = rename('SELECT * FROM `ord|ers`', 'order_items'); // quoted stays quoted…
  assert.equal(r.text, 'SELECT * FROM `order_items`');
  const r2 = rename('SELECT * FROM ord|ers', 'order_items'); // …bare stays bare
  assert.equal(r2.text, 'SELECT * FROM order_items');
});

// ── strings and comments ─────────────────────────────────────────────────────

test('string literals and comments are never rewritten, always reported', () => {
  const r = rename("SELECT * FROM ord|ers WHERE note = 'see orders' -- orders here\n", 'order_items');
  assert.equal(r.text, "SELECT * FROM order_items WHERE note = 'see orders' -- orders here\n");
  assert.equal(r.rewritten, 1);
  assert.equal(r.reviews.length, 2);
  assert.ok(r.reviews.every(x => x.reason === 'inside a string literal or comment'));
  assert.equal(r.reviews[0].line, 1);
});

test('review entries carry correct line numbers', () => {
  const r = rename('SELECT * FROM ord|ers;\n\n-- TODO: drop orders soon\nSELECT 1;', 'order_items');
  assert.equal(r.rewritten, 1);
  assert.equal(r.reviews.length, 1);
  assert.equal(r.reviews[0].line, 3);
  assert.match(r.reviews[0].lineText, /TODO: drop orders/);
});

test('MySQL double-quoted strings are strings, not identifiers', () => {
  const r = rename('SELECT * FROM ord|ers WHERE note = "orders"', 'order_items');
  assert.equal(r.text, 'SELECT * FROM order_items WHERE note = "orders"');
  assert.equal(r.rewritten, 1);
  assert.equal(r.reviews.length, 1);
});

// ── the apply step ───────────────────────────────────────────────────────────

test('applyRename rejects unusable new names', () => {
  const { sql, plan } = planAt('SELECT * FROM ord|ers');
  assert.equal(applyRename(sql, plan, '', 'mysql'), null);
  assert.equal(applyRename(sql, plan, 'a.b', 'mysql'), null);
  assert.equal(applyRename(sql, plan, 'a\nb', 'mysql'), null);
});

test('offsets stay correct when an earlier occurrence is shorter than the new name', () => {
  const r = rename('SELECT o.id FROM orders |o', 'a_much_longer_alias');
  assert.equal(r.text, 'SELECT a_much_longer_alias.id FROM orders a_much_longer_alias');
});

test('mixed-case occurrences match case-insensitively', () => {
  const r = rename('SELECT * FROM Ord|ers', 'order_items');
  assert.equal(r.text, 'SELECT * FROM order_items');
});
