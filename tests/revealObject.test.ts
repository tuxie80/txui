/**
 * Reveal-in-tree name parsing and matching (src/utils/revealObject.ts).
 *
 * The editor hands the tree whatever the caret sat on — bare, qualified,
 * quoted — and the tree must find the same object the F12 go-to-object would
 * have opened. These cover the parse and the match rules; the tree walking
 * itself lives in SchemaTree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitQualifiedName, nameMatches, qualifierCandidates, REVEALABLE_KINDS,
} from '../src/utils/revealObject.ts';

// ── splitQualifiedName ────────────────────────────────────────────────────────

test('a bare name is one part', () => {
  assert.deepEqual(splitQualifiedName('orders'), ['orders']);
});

test('dotted names split into parts', () => {
  assert.deepEqual(splitQualifiedName('public.orders'), ['public', 'orders']);
  assert.deepEqual(splitQualifiedName('main.sales.orders'), ['main', 'sales', 'orders']);
});

test('quoted parts keep their dots and lose their quotes', () => {
  assert.deepEqual(splitQualifiedName('"my schema"."order lines"'), ['my schema', 'order lines']);
  assert.deepEqual(splitQualifiedName('`my db`.`t`'), ['my db', 't']);
  assert.deepEqual(splitQualifiedName('[dbo].[order.lines]'), ['dbo', 'order.lines']);
});

test('mixed quoted and bare parts', () => {
  assert.deepEqual(splitQualifiedName('public."Order Lines"'), ['public', 'Order Lines']);
});

test('doubled closers are escaped literals inside quotes', () => {
  assert.deepEqual(splitQualifiedName('"weird""name"'), ['weird"name']);
  assert.deepEqual(splitQualifiedName('`back``tick`'), ['back`tick']);
});

test('whitespace and empties are dropped', () => {
  assert.deepEqual(splitQualifiedName('  '), []);
  assert.deepEqual(splitQualifiedName(''), []);
  assert.deepEqual(splitQualifiedName(' public . orders '), ['public', 'orders']);
});

// ── nameMatches ───────────────────────────────────────────────────────────────

test('exact match, then case-insensitive fallback', () => {
  assert.ok(nameMatches('orders', 'orders'));
  assert.ok(nameMatches('Orders', 'orders'));
  assert.ok(!nameMatches('order', 'orders'));
});

// ── qualifierCandidates ───────────────────────────────────────────────────────

test('bare names search no specific container', () => {
  assert.deepEqual(qualifierCandidates(['orders']), []);
});

test('two-part names point at their one qualifier', () => {
  assert.deepEqual(qualifierCandidates(['public', 'orders']), ['public']);
});

test('three-part names try the full path first, then the last segment', () => {
  assert.deepEqual(qualifierCandidates(['main', 'sales', 'orders']), ['main.sales', 'sales']);
});

// ── REVEALABLE_KINDS ──────────────────────────────────────────────────────────

test('relations and DDL-only kinds are revealable; columns and groups are not', () => {
  for (const k of ['table', 'view', 'mat_view', 'distributed', 'routine']) {
    assert.ok(REVEALABLE_KINDS.has(k), `missing: ${k}`);
  }
  assert.ok(!REVEALABLE_KINDS.has('column'));
  assert.ok(!REVEALABLE_KINDS.has('group'));
  assert.ok(!REVEALABLE_KINDS.has('database'));
});
