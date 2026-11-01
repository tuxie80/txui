import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  referencedRelations, buildAiSchemaContext, AI_SCHEMA_MAX_CHARS,
} from '../src/utils/aiSchema.ts';
import type { AiRelation } from '../src/utils/aiSchema.ts';

const relations: AiRelation[] = [
  { label: 'customers', type: 'table', detail: 'shop' },
  { label: 'orders', type: 'table', detail: 'shop' },
  { label: 'order_items', type: 'table', detail: 'shop' },
  { label: 'orders_2024', type: 'table', detail: 'archive' },
  { label: 'customer_report', type: 'view', apply: 'analytics.customer_report' },
];

test('referenced relations match bare, qualified and quoted names without substring hits', () => {
  assert.deepEqual(referencedRelations(
    'SELECT * FROM shop.orders o JOIN customers c ON c.id = o.customer_id', relations, 'shop',
  ), ['shop.orders', 'shop.customers']);
  assert.deepEqual(referencedRelations('summarize `orders_2024`', relations, 'shop'), ['archive.orders_2024']);
  assert.deepEqual(referencedRelations('show customer_report', relations, 'shop'), ['analytics.customer_report']);
  assert.deepEqual(referencedRelations('show order_items', relations, 'shop'), ['shop.order_items']);
});

test('schema context carries types, keys, indexes and foreign keys but no row values', async () => {
  const context = await buildAiSchemaContext({
    text: 'top customers by orders', currentDb: 'shop', relations,
    getColumns: async table => table === 'shop.customers'
      ? [{ label: 'id', detail: 'BIGINT', pk: true }, { label: 'name', detail: 'VARCHAR(200)' }]
      : [{ label: 'customer_id', detail: 'BIGINT' }, { label: 'total', detail: 'DECIMAL(12,2)' }],
    getIndexedColumns: async () => new Set(['customer_id']),
    getFks: async table => table === 'shop.orders' ? [{
      fromTable: 'shop.orders', fromCols: ['customer_id'], toTable: 'shop.customers', toCols: ['id'],
    }] : [],
  });
  assert.deepEqual(context.tables, ['shop.customers', 'shop.orders']);
  assert.match(context.text, /id BIGINT \[PRIMARY KEY\]/);
  assert.match(context.text, /customer_id BIGINT \[indexed\]/);
  assert.match(context.text, /FK shop.orders/);
  assert.match(context.text, /Metadata only/);
  assert.ok(!context.text.includes('Alice'));
});

test('an unmatched request gets relation names only and a large context is bounded', async () => {
  const unmatched = await buildAiSchemaContext({
    text: 'unrelated request', relations,
    getColumns: async () => [], getIndexedColumns: async () => new Set(), getFks: async () => [],
  });
  assert.equal(unmatched.tables.length, 0);
  assert.match(unmatched.text, /columns were not supplied/);

  const many = Array.from({ length: 3000 }, (_, i) => ({ label: `c${i}`, detail: 'TEXT' }));
  const bounded = await buildAiSchemaContext({
    text: 'customers', relations,
    getColumns: async () => many, getIndexedColumns: async () => new Set(), getFks: async () => [],
  });
  assert.ok(bounded.truncated);
  assert.ok(bounded.text.length <= AI_SCHEMA_MAX_CHARS + 100);
});
