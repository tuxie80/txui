/**
 * Blast radius (src/utils/writePreview.ts): turning a write into its COUNT so
 * the confirmation can state how many rows it touches. It must be conservative
 * — a wrong number is worse than no number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countPlanFor, hasRowLimit, describeBlastRadius } from '../src/utils/writePreview.ts';

test('DELETE with a WHERE becomes the matching COUNT', () => {
  const p = countPlanFor("DELETE FROM orders WHERE state = 'cancelled' AND total < 10")!;
  assert.equal(p.kind, 'delete');
  assert.equal(p.table, 'orders');
  assert.equal(p.wholeTable, false);
  assert.equal(p.sql, "SELECT COUNT(*) FROM orders WHERE state = 'cancelled' AND total < 10");
});

test('UPDATE with a WHERE becomes the matching COUNT, SET is dropped', () => {
  const p = countPlanFor("UPDATE shop.orders SET state = 'x', total = 0 WHERE id IN (1,2,3)")!;
  assert.equal(p.kind, 'update');
  assert.equal(p.table, 'shop.orders');
  assert.equal(p.sql, 'SELECT COUNT(*) FROM shop.orders WHERE id IN (1,2,3)');
});

test('a WHERE-less write is reported as the whole table', () => {
  const d = countPlanFor('DELETE FROM orders')!;
  assert.equal(d.wholeTable, true);
  assert.equal(d.sql, 'SELECT COUNT(*) FROM orders');
  const u = countPlanFor('UPDATE orders SET state = 1')!;
  assert.equal(u.wholeTable, true);
});

test('ORDER BY / LIMIT are not folded into the count', () => {
  const p = countPlanFor('DELETE FROM orders WHERE state = 1 ORDER BY id LIMIT 10')!;
  assert.equal(p.sql, 'SELECT COUNT(*) FROM orders WHERE state = 1');
  assert.ok(hasRowLimit('DELETE FROM orders WHERE state = 1 LIMIT 10'));
  assert.ok(!hasRowLimit('DELETE FROM orders WHERE state = 1'));
});

test('literals containing SQL keywords survive intact', () => {
  const p = countPlanFor("DELETE FROM orders WHERE note = 'where limit order by'")!;
  assert.equal(p.sql, "SELECT COUNT(*) FROM orders WHERE note = 'where limit order by'");
});

test('quoted and back-ticked table names are kept as written', () => {
  assert.equal(countPlanFor('DELETE FROM `order` WHERE id = 1')!.table, '`order`');
  assert.equal(countPlanFor('UPDATE "Orders" SET a = 1 WHERE id = 2')!.table, '"Orders"');
});

test('anything it cannot translate safely returns null', () => {
  assert.equal(countPlanFor('SELECT 1'), null);
  assert.equal(countPlanFor('INSERT INTO t VALUES (1)'), null);
  assert.equal(countPlanFor('TRUNCATE TABLE t'), null);
  // multi-statement
  assert.equal(countPlanFor('DELETE FROM a WHERE id=1; DELETE FROM b WHERE id=2'), null);
  // CTE / RETURNING / multi-table
  assert.equal(countPlanFor('WITH x AS (SELECT 1) DELETE FROM a USING x WHERE a.id = x.id'), null);
  assert.equal(countPlanFor('DELETE FROM a WHERE id = 1 RETURNING *'), null);
  assert.equal(countPlanFor('UPDATE a JOIN b ON b.id = a.id SET a.x = 1 WHERE b.y = 2'), null);
  assert.equal(countPlanFor('UPDATE a, b SET a.x = 1 WHERE a.id = b.id'), null);
  assert.equal(countPlanFor('DELETE a FROM a JOIN b ON b.id = a.id WHERE b.y = 1'), null);
});

test('a trailing semicolon does not defeat it', () => {
  assert.equal(countPlanFor('DELETE FROM orders WHERE id = 1;')!.sql,
    'SELECT COUNT(*) FROM orders WHERE id = 1');
});

test('the wording states the consequence plainly', () => {
  const p = countPlanFor('DELETE FROM orders WHERE id = 1')!;
  assert.match(describeBlastRadius(p, 4711), /Affects 4,711 rows of orders/);
  assert.match(describeBlastRadius(p, 1), /Affects 1 row of orders/);
  assert.match(describeBlastRadius(p, 0), /would change nothing/);
  assert.match(describeBlastRadius(p, null), /unavailable/);
  const all = countPlanFor('DELETE FROM orders')!;
  assert.match(describeBlastRadius(all, 90_000), /EVERY row of orders: 90,000/);
});
