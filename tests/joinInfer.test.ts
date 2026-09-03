/**
 * Name-convention join inference (src/utils/sqlComplete.ts `inferJoin`).
 *
 * This is a guess, offered only where the schema declares no foreign keys, and
 * its whole value depends on being wrong rarely. A suggestion that silently
 * inserts `orders.id = customers.id` is worse than no suggestion at all — it
 * looks right, runs, and returns nonsense. So the tests below care as much
 * about what it REFUSES as about what it finds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferJoin } from '../src/utils/sqlComplete.ts';

test('the classic singular-stem foreign key is found', () => {
  const r = inferJoin(['id', 'customer_id', 'total'], 'customers', ['id', 'name']);
  assert.deepEqual(r, { fromCol: 'customer_id', toCol: 'id' });
});

test('a plural table maps to its singular column stem', () => {
  // categories → category_id, companies → company_id
  assert.deepEqual(
    inferJoin(['id', 'category_id'], 'categories', ['id', 'label']),
    { fromCol: 'category_id', toCol: 'id' },
  );
  assert.deepEqual(
    inferJoin(['id', 'company_id'], 'companies', ['id']),
    { fromCol: 'company_id', toCol: 'id' },
  );
});

test('a table whose plural ends in -ses is handled', () => {
  assert.deepEqual(
    inferJoin(['id', 'address_id'], 'addresses', ['id', 'street']),
    { fromCol: 'address_id', toCol: 'id' },
  );
});

test('an already-singular table name still matches', () => {
  assert.deepEqual(
    inferJoin(['id', 'person_id'], 'person', ['id']),
    { fromCol: 'person_id', toCol: 'id' },
  );
});

test('the target key may be named after itself rather than `id`', () => {
  // customers(customer_id) rather than customers(id)
  assert.deepEqual(
    inferJoin(['id', 'customer_id'], 'customers', ['customer_id', 'name']),
    { fromCol: 'customer_id', toCol: 'customer_id' },
  );
});

test('a schema-qualified table name resolves on its bare name', () => {
  assert.deepEqual(
    inferJoin(['id', 'customer_id'], 'shop.customers', ['id']),
    { fromCol: 'customer_id', toCol: 'id' },
  );
});

test('matching *_id columns on both sides is accepted', () => {
  // Shared tenant_id is a real and common join.
  assert.deepEqual(
    inferJoin(['tenant_id', 'total'], 'invoices', ['tenant_id', 'amount']),
    { fromCol: 'tenant_id', toCol: 'tenant_id' },
  );
});

// ── the refusals, which matter more ─────────────────────────────────────────

test('id = id is NEVER suggested', () => {
  // Every table has an `id`; joining on it is meaningless and would look
  // plausible enough to get accepted.
  assert.equal(inferJoin(['id', 'total'], 'customers', ['id', 'name']), null);
});

test('unrelated tables produce nothing', () => {
  assert.equal(
    inferJoin(['id', 'sku', 'price'], 'countries', ['id', 'iso_code', 'name']),
    null,
  );
});

test('a plain shared column name is not enough', () => {
  // Both have `name` and `created_at`; neither is a key.
  assert.equal(
    inferJoin(['id', 'name', 'created_at'], 'suppliers', ['id', 'name', 'created_at']),
    null,
  );
});

test('an empty column list on either side yields nothing', () => {
  assert.equal(inferJoin([], 'customers', ['id']), null);
  assert.equal(inferJoin(['customer_id'], 'customers', []), null);
});

test('case differences do not defeat it, and the original casing is returned', () => {
  const r = inferJoin(['Id', 'CustomerID', 'Customer_Id'], 'Customers', ['ID', 'Name']);
  assert.ok(r, 'nothing matched');
  // Whatever it picked must be spelled exactly as the catalog spells it, since
  // the result goes straight into SQL on a case-sensitive engine.
  assert.ok(['CustomerID', 'Customer_Id'].includes(r.fromCol), `got ${r.fromCol}`);
  assert.equal(r.toCol, 'ID');
});
