/**
 * Grid edits → reviewable SQL. The cases that matter are the safety ones: a
 * keyed WHERE always, never a WHERE-less write, typed literals, and no editing
 * a table without a primary key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEditSql, literal, editCount, assembleEditSql, insertTemplate, type EditSet,
} from '../src/utils/gridEdits.ts';

const base: EditSet = {
  table: 'shop.orders',
  pkColumns: ['id'],
  types: { id: 'BIGINT', total: 'DECIMAL(10,2)', status: 'VARCHAR(20)', paid: 'TINYINT(1)', note: 'TEXT' },
  updates: [], inserts: [], deletes: [],
};

test('an UPDATE sets only the edited columns, keyed by the primary key', () => {
  const sql = buildEditSql({ ...base, updates: [{ pk: { id: 42 }, set: { status: 'shipped', total: '99.50' } }] }, 'mysql');
  assert.equal(sql.length, 1);
  assert.match(sql[0], /^UPDATE `shop`\.`orders` SET `status` = 'shipped', `total` = 99\.50 WHERE `id` = 42$/);
});

test('numbers and NULLs are bare; text is quoted and escaped', () => {
  assert.equal(literal('42', 'INT', 'mysql'), '42');
  assert.equal(literal('42', 'VARCHAR', 'mysql'), "'42'");          // a varchar "42" stays a string
  assert.equal(literal(7, 'INT', 'mysql'), '7');
  assert.equal(literal(null, 'INT', 'mysql'), 'NULL');
  assert.equal(literal('', 'TEXT', 'mysql'), 'NULL');               // empty edit → NULL (FastGrid convention)
  assert.equal(literal("O'Neil", 'TEXT', 'mysql'), "'O''Neil'");
  assert.equal(literal('1', 'TINYINT(1)', 'postgres'), 'TRUE');
  assert.equal(literal('0', 'TINYINT(1)', 'mysql'), '0');
});

test('a DELETE is keyed by the primary key, one row per statement', () => {
  const sql = buildEditSql({ ...base, deletes: [{ id: 1 }, { id: 2 }] }, 'mysql');
  assert.deepEqual(sql, [
    'DELETE FROM `shop`.`orders` WHERE `id` = 1',
    'DELETE FROM `shop`.`orders` WHERE `id` = 2',
  ]);
});

test('a composite key ANDs every key column', () => {
  const set: EditSet = {
    table: 'items', pkColumns: ['order_id', 'sku'],
    types: { order_id: 'INT', sku: 'VARCHAR', qty: 'INT' },
    updates: [{ pk: { order_id: 5, sku: 'ABC' }, set: { qty: '3' } }], inserts: [], deletes: [],
  };
  assert.match(buildEditSql(set, 'mysql')[0], /WHERE `order_id` = 5 AND `sku` = 'ABC'$/);
});

test('a table with no primary key refuses to build a write', () => {
  assert.throws(
    () => buildEditSql({ ...base, pkColumns: [], updates: [{ pk: {}, set: { status: 'x' } }] }, 'mysql'),
    /no primary key/);
});

test('an INSERT lists columns and typed values', () => {
  const sql = buildEditSql({ ...base, inserts: [{ id: '100', status: 'new', total: '0' }] }, 'mysql');
  assert.match(sql[0], /^INSERT INTO `shop`\.`orders` \(`id`, `status`, `total`\) VALUES \(100, 'new', 0\)$/);
});

test('PostgreSQL quoting uses double quotes for identifiers', () => {
  const sql = buildEditSql({ ...base, table: 'orders', deletes: [{ id: 9 }] }, 'postgres');
  assert.equal(sql[0], 'DELETE FROM "orders" WHERE "id" = 9');
});

test('assembleEditSql adapts its header to the session transaction mode', () => {
  const stmts = ['UPDATE t SET a = 1 WHERE id = 2', 'DELETE FROM t WHERE id = 3'];
  // Autocommit on: no fake transaction wrapper; warns each commits immediately.
  const auto = assembleEditSql(stmts, false);
  assert.doesNotMatch(auto, /START TRANSACTION|BEGIN;/);
  assert.match(auto, /Autocommit is ON/);
  assert.match(auto, /UPDATE t SET a = 1 WHERE id = 2;/);
  assert.match(auto, /DELETE FROM t WHERE id = 3;/);
  // Transaction held: runs inside the open transaction, Commit/Rollback decide.
  const held = assembleEditSql(stmts, true);
  assert.doesNotMatch(held, /START TRANSACTION|BEGIN;/);
  assert.match(held, /transaction is open/i);
  assert.match(held, /Commit; Rollback/);
  assert.equal(assembleEditSql([], false), '');
});

test('editCount tallies non-empty updates, inserts and deletes', () => {
  assert.equal(editCount({
    updates: [{ pk: { id: 1 }, set: { a: 1 } }, { pk: { id: 2 }, set: {} }],
    inserts: [{ a: 1 }], deletes: [{ id: 3 }],
  }), 3);
});

test('insertTemplate is a fill-in skeleton, not executable data', () => {
  const t = insertTemplate('orders', [{ name: 'id', type: 'BIGINT' }, { name: 'status', type: 'VARCHAR(20)' }], 'mysql');
  assert.match(t, /INSERT INTO `orders` \(`id`, `status`\)/);
  assert.match(t, /\/\* BIGINT \*\/ NULL/);
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// The statements below were executed inside a transaction against SQL Server
// 2022 and the resulting rows read back — the grid's edit mode is only as safe
// as this builder, and it is the one place the panel writes.

test('SQL Server DML is bracket-quoted and keyed, like every other engine', () => {
  const set = {
    table: 'dbo.zz_grid', pkColumns: ['id'],
    types: { id: 'int', name: 'nvarchar(120)', qty: 'int' },
    updates: [{ pk: { id: 1 }, set: { name: "O'Brien", qty: 42 } }],
    deletes: [{ id: 2 }],
    inserts: [{ name: 'new row', qty: 9 }],
  };
  assert.deepEqual(buildEditSql(set, 'sqlserver'), [
    "UPDATE [dbo].[zz_grid] SET [name] = 'O''Brien', [qty] = 42 WHERE [id] = 1",
    "INSERT INTO [dbo].[zz_grid] ([name], [qty]) VALUES ('new row', 9)",
    'DELETE FROM [dbo].[zz_grid] WHERE [id] = 2',
  ]);
});

test('a bit column takes 1/0 — T-SQL has no boolean literal', () => {
  const set = {
    table: 't', pkColumns: ['id'], types: { id: 'int', ok: 'bit' },
    updates: [{ pk: { id: 1 }, set: { ok: true } }], deletes: [], inserts: [],
  };
  const sql = buildEditSql(set, 'sqlserver')[0];
  assert.equal(sql, 'UPDATE [t] SET [ok] = 1 WHERE [id] = 1');
  assert.ok(!/\bTRUE\b/i.test(sql), sql);
  // PostgreSQL is the one that spells it as a keyword.
  assert.match(
    buildEditSql({
      table: 't', pkColumns: ['id'], types: { id: 'int', ok: 'boolean' },
      updates: [{ pk: { id: 1 }, set: { ok: true } }], deletes: [], inserts: [],
    }, 'postgres')[0],
    /= TRUE/);
});

test('a table with no primary key still cannot be edited', () => {
  // The keyed-WHERE rule is the whole safety model, and it is engine-agnostic.
  assert.throws(() => buildEditSql({
    table: 't', pkColumns: [], types: {},
    updates: [{ pk: {}, set: { a: 1 } }], deletes: [], inserts: [],
  }, 'sqlserver'), /no primary key/);
});
