import test from 'node:test';
import assert from 'node:assert/strict';
import { errorGuidance } from '../src/utils/errorActions.ts';

const tables = ['customers', 'orders', 'order_items', 'products'];
const columns = ['id', 'customer_id', 'status', 'total', 'created_at'];

test('missing table gets a schema suggestion and no automatic execution', () => {
  const guide = errorGuidance("Table 'shop.ordres' doesn't exist", { sql: 'SELECT * FROM ordres', tables, columns })!;
  assert.match(guide.title, /orders/);
  assert.equal(guide.insertSql, 'orders');
  assert.equal(guide.schemaObject, 'orders');
  assert.match(guide.detail, /nothing runs automatically/);
});

test('missing column gets the closest column and an absolute PostgreSQL position', () => {
  const sql = 'SELECT customer FROM orders';
  const guide = errorGuidance('column "custome" does not exist at position 8', { sql, tables, columns })!;
  assert.equal(guide.insertSql, 'customer_id');
  assert.deepEqual(guide.goto, { from: 7, to: 8 });
});

test('ambiguous columns require an alias, not a guessed replacement', () => {
  const guide = errorGuidance("Column 'id' in field list is ambiguous", { sql: 'SELECT id FROM a, b', tables, columns })!;
  assert.match(guide.title, /ambiguous/);
  assert.equal(guide.insertSql, undefined);
});

test('permission and timeout guidance is actionable and cautious', () => {
  assert.match(errorGuidance({ code: 'permission_denied', message: 'denied' }, { sql: '' })!.detail, /privileges/);
  assert.match(errorGuidance({ code: 'timeout', message: 'deadline' }, { sql: '' })!.detail, /Narrow the result/);
});

test('line-based syntax errors map to the correct source range', () => {
  const guide = errorGuidance('You have an error in your sql syntax at line 2', { sql: 'SELECT 1;\nSELECT * FROM t', tables, columns })!;
  assert.deepEqual(guide.goto, { from: 10, to: 11 });
  assert.match(guide.detail, /not necessarily the root cause/);
});

test('unrecognized failures do not invent a fix', () => {
  assert.equal(errorGuidance('socket closed unexpectedly', { sql: 'SELECT 1', tables, columns }), null);
});
