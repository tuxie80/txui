/**
 * Clone-a-table SQL builder (src/utils/duplicateTable.ts).
 * Covers: MySQL vs PostgreSQL create shape, with/without data, per-engine
 * identifier quoting, and schema qualification of both source and target.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateTableSql } from '../src/utils/duplicateTable.ts';

test('MySQL: structure only uses CREATE TABLE ... LIKE, backtick-quoted', () => {
  const stmts = duplicateTableSql({
    schema: 'shop', table: 'orders', newName: 'orders_copy', engine: 'mysql',
  });
  assert.deepEqual(stmts, [
    'CREATE TABLE `shop`.`orders_copy` LIKE `shop`.`orders`',
  ]);
});

test('MySQL: with data appends INSERT ... SELECT *', () => {
  const stmts = duplicateTableSql({
    schema: 'shop', table: 'orders', newName: 'orders_copy', withData: true, engine: 'mysql',
  });
  assert.deepEqual(stmts, [
    'CREATE TABLE `shop`.`orders_copy` LIKE `shop`.`orders`',
    'INSERT INTO `shop`.`orders_copy` SELECT * FROM `shop`.`orders`',
  ]);
});

test('PostgreSQL: uses (LIKE ... INCLUDING ALL) with double quotes', () => {
  const stmts = duplicateTableSql({
    schema: 'public', table: 'orders', newName: 'orders_copy', engine: 'postgres',
  });
  assert.deepEqual(stmts, [
    'CREATE TABLE "public"."orders_copy" (LIKE "public"."orders" INCLUDING ALL)',
  ]);
});

test('PostgreSQL: with data appends INSERT ... SELECT *', () => {
  const stmts = duplicateTableSql({
    schema: 'public', table: 'orders', newName: 'orders_copy', withData: true, engine: 'postgres',
  });
  assert.deepEqual(stmts, [
    'CREATE TABLE "public"."orders_copy" (LIKE "public"."orders" INCLUDING ALL)',
    'INSERT INTO "public"."orders_copy" SELECT * FROM "public"."orders"',
  ]);
});

test('MariaDB clones like MySQL (backticks, LIKE form)', () => {
  const stmts = duplicateTableSql({
    schema: 'shop', table: 'orders', newName: 'orders_copy', engine: 'mariadb',
  });
  assert.deepEqual(stmts, [
    'CREATE TABLE `shop`.`orders_copy` LIKE `shop`.`orders`',
  ]);
});

test('no schema: names are not qualified', () => {
  assert.deepEqual(
    duplicateTableSql({ table: 'orders', newName: 'orders_copy', engine: 'mysql' }),
    ['CREATE TABLE `orders_copy` LIKE `orders`'],
  );
  assert.deepEqual(
    duplicateTableSql({ table: 'orders', newName: 'orders_copy', engine: 'postgres' }),
    ['CREATE TABLE "orders_copy" (LIKE "orders" INCLUDING ALL)'],
  );
});

test('quoting: reserved words and case are handled per engine', () => {
  // PostgreSQL folds case, so a mixed-case target must stay double-quoted.
  const pg = duplicateTableSql({
    schema: 'public', table: 'Order', newName: 'OrderCopy', engine: 'postgres',
  });
  assert.equal(pg[0], 'CREATE TABLE "public"."OrderCopy" (LIKE "public"."Order" INCLUDING ALL)');

  // MySQL: reserved word `order` gets backticks; identifiers with a backtick
  // are escaped by doubling.
  const my = duplicateTableSql({
    table: 'order', newName: 'we`ird', engine: 'mysql',
  });
  assert.equal(my[0], 'CREATE TABLE `we``ird` LIKE `order`');
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('SQL Server has neither LIKE form — it uses SELECT INTO', () => {
  // `CREATE TABLE new LIKE old` (MySQL) and `(LIKE old INCLUDING ALL)` (PG) are
  // both syntax errors on SQL Server, so the previous output could not run.
  const out = duplicateTableSql({
    schema: 'sales', table: 'customers', newName: 'copy', engine: 'sqlserver',
  });
  const stmt = out.find(l => !l.startsWith('--'))!;
  assert.equal(stmt, 'SELECT * INTO [sales].[copy] FROM [sales].[customers] WHERE 1 = 0');
  assert.ok(!out.join('\n').includes('LIKE'));
});

test('structure-only and with-data are ONE statement, not two', () => {
  // SELECT INTO creates the table AND fills it, so a separate INSERT would be
  // inserting into a table this statement had already populated.
  const withData = duplicateTableSql({
    schema: 'sales', table: 'customers', newName: 'copy',
    withData: true, engine: 'sqlserver',
  }).filter(l => !l.startsWith('--'));
  assert.deepEqual(withData, ['SELECT * INTO [sales].[copy] FROM [sales].[customers]']);
});

test('the copy\'s missing indexes are stated, not discovered later', () => {
  // Measured on SQL Server 2022: all 6 columns and the IDENTITY come across;
  // indexes, keys and defaults are 0 of each. The other engines carry them.
  const out = duplicateTableSql({
    schema: 's', table: 't', newName: 'c', engine: 'sqlserver',
  }).join('\n');
  assert.match(out, /NOT the indexes/);
  assert.match(out, /primary key, defaults/);
});

test('the other engines keep their own form', () => {
  assert.deepEqual(
    duplicateTableSql({ schema: 's', table: 't', newName: 'c', engine: 'mysql' }),
    ['CREATE TABLE `s`.`c` LIKE `s`.`t`']);
  assert.deepEqual(
    duplicateTableSql({ schema: 's', table: 't', newName: 'c', engine: 'postgres' }),
    ['CREATE TABLE "s"."c" (LIKE "s"."t" INCLUDING ALL)']);
});
