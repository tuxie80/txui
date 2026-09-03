/**
 * brokenRefs — the drill-down behind "this view is invalid": which table or
 * column is gone, and what it was probably renamed to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDefinition, buildCatalog, catalogSql, closest, reportSummary,
} from '../src/utils/brokenRefs.ts';

const catalog = buildCatalog(
  [
    ['reporting', 'orders'],
    ['reporting', 'r_fin_order_cancelled'],
    ['sales', 'customers'],
  ],
  [
    ['reporting', 'orders', 'id'],
    ['reporting', 'orders', 'customer_id'],
    ['reporting', 'orders', 'cancelled_at'],
    ['sales', 'customers', 'id'],
    ['sales', 'customers', 'name'],
  ],
);

// ── catalogSql ───────────────────────────────────────────────────────────────

test('catalogSql: one objects + one columns sweep per supported engine', () => {
  for (const engine of ['mysql', 'postgres', 'sqlserver']) {
    const q = catalogSql(engine);
    assert.ok(q, engine);
    assert.match(q!.objects, /FROM/i);
    assert.match(q!.columns, /FROM/i);
    assert.notEqual(q!.objects, q!.columns);
  }
  assert.equal(catalogSql('redis'), null);
  assert.equal(catalogSql('parquet'), null);
});

test('catalogSql: sweeps every user schema, system schemas excluded', () => {
  assert.match(catalogSql('mysql')!.objects, /NOT IN \('information_schema'/);
  assert.match(catalogSql('postgres')!.objects, /NOT IN \('pg_catalog'/);
});

// ── buildCatalog ─────────────────────────────────────────────────────────────

test('buildCatalog registers bare and schema-qualified names, lower-cased', () => {
  assert.ok(catalog.objects.has('orders'));
  assert.ok(catalog.objects.has('reporting.orders'));
  assert.ok(catalog.objects.has('sales.customers'));
});

test('buildCatalog folds case so an upper-case server catalog still matches', () => {
  const loud = buildCatalog([['REPORTING', 'ORDERS']], [['REPORTING', 'ORDERS', 'ID']]);
  const r = analyzeDefinition('SELECT o.id FROM Orders o', loud, 'mysql');
  assert.equal(r.broken.length, 0);
});

// ── analyzeDefinition: tables ────────────────────────────────────────────────

test('a missing table is named, with a rename suggestion when one is close', () => {
  const r = analyzeDefinition('SELECT * FROM custmer', catalog, 'mysql');
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].kind, 'table');
  assert.equal(r.broken[0].name, 'custmer');
  assert.deepEqual(r.broken[0].suggestions, ['customers']);
});

test('a schema-qualified reference verifies against that schema', () => {
  const ok = analyzeDefinition('SELECT * FROM sales.customers', catalog, 'mysql');
  assert.equal(ok.broken.length, 0);
  const bad = analyzeDefinition('SELECT * FROM sales.gone', catalog, 'mysql');
  assert.equal(bad.broken.length, 1);
  assert.equal(bad.broken[0].name, 'sales.gone');
});

test('the same missing table reported once, however often it is referenced', () => {
  const r = analyzeDefinition(
    'SELECT * FROM gone g JOIN gone g2 ON g2.id = g.id', catalog, 'mysql');
  assert.equal(r.broken.filter(b => b.kind === 'table').length, 1);
});

// ── analyzeDefinition: columns ───────────────────────────────────────────────

test('a missing column is resolved to its table through the alias', () => {
  const r = analyzeDefinition(
    'SELECT o.id, o.canceled_at FROM reporting.orders o', catalog, 'mysql');
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].kind, 'column');
  assert.equal(r.broken[0].name, 'canceled_at');
  assert.equal(r.broken[0].table, 'reporting.orders');
  assert.deepEqual(r.broken[0].suggestions, ['cancelled_at']);
});

test('existing columns produce no findings', () => {
  const r = analyzeDefinition(
    'SELECT o.id, c.name FROM reporting.orders o JOIN sales.customers c ON c.id = o.customer_id',
    catalog, 'mysql');
  assert.equal(r.broken.length, 0);
});

// ── analyzeDefinition: quiet when it cannot prove ────────────────────────────

test('a CTE is part of the definition, never "missing"', () => {
  const r = analyzeDefinition(
    'WITH recent AS (SELECT id FROM reporting.orders) SELECT * FROM recent',
    catalog, 'mysql');
  assert.equal(r.broken.length, 0);
});

test('a derived table and its projected columns are not flagged', () => {
  const r = analyzeDefinition(
    'SELECT d.id FROM (SELECT id FROM reporting.orders) d', catalog, 'mysql');
  assert.equal(r.broken.length, 0);
});

test('references into system schemas are never flagged', () => {
  const r = analyzeDefinition(
    'SELECT * FROM information_schema.tables', catalog, 'mysql');
  assert.equal(r.broken.length, 0);
});

// ── closest ──────────────────────────────────────────────────────────────────

test('closest ranks by edit distance and respects the bar', () => {
  assert.deepEqual(closest('nam', ['name', 'naming', 'xyz']), ['name']);
  // a short name gets no wild guesses
  assert.deepEqual(closest('x', ['customer_id']), []);
  // identical name is never suggested
  assert.deepEqual(closest('orders', ['orders', 'order']), ['order']);
});

// ── reportSummary ────────────────────────────────────────────────────────────

test('reportSummary names the definer cause when nothing is missing', () => {
  const s = reportSummary({ broken: [] });
  assert.match(s, /definer|rights/);
});

test('reportSummary counts missing tables and columns', () => {
  const s = reportSummary({
    broken: [
      { kind: 'table', name: 'gone', suggestions: [] },
      { kind: 'column', name: 'c1', table: 'orders', suggestions: [] },
      { kind: 'column', name: 'c2', table: 'orders', suggestions: [] },
    ],
  });
  assert.equal(s, '1 missing table · 2 missing columns');
});
