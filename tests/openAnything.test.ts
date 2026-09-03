/**
 * Open Anything ranking (src/utils/openAnything.ts).
 *
 * The unified ⌘K palette ranks through this module and nothing else, so the
 * tests below ARE the palette's contract: fixed section order, fuzzy ranking
 * inside a section, per-section and overall caps, and `table.column` matching
 * through the qualified name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchOpenAnything, SECTION_ORDER, SECTION_TITLES,
  DEFAULT_PER_SECTION, DEFAULT_LIMIT,
} from '../src/utils/openAnything.ts';
import type { OpenEntry, OpenSection } from '../src/utils/openAnything.ts';

const entry = (id: string, label: string, extra: Partial<OpenEntry> = {}): OpenEntry =>
  ({ id, label, ...extra });

// ── sections ──────────────────────────────────────────────────────────────────

test('every section has a title and a place in the order', () => {
  for (const s of SECTION_ORDER) assert.ok(SECTION_TITLES[s], `untitled section: ${s}`);
  assert.equal(new Set(SECTION_ORDER).size, SECTION_ORDER.length);
});

test('groups come back in SECTION_ORDER, empty sections omitted', () => {
  const out = searchOpenAnything([
    entry('t1', 'orders', { section: 'table' }),
    entry('c1', 'New connection…', { section: 'command' }),
    entry('s1', 'Saved: monthly report', { section: 'saved' }),
  ], '');
  assert.deepEqual(out.map(g => g.section), ['command', 'table', 'saved']);
  assert.deepEqual(out.map(g => g.title),
    ['Commands', 'Tables & objects', 'Saved queries']);
});

test('entries without a section default to the command section', () => {
  const out = searchOpenAnything([entry('x', 'Do a thing')], 'thing');
  assert.equal(out.length, 1);
  assert.equal(out[0].section, 'command');
});

// ── empty query ───────────────────────────────────────────────────────────────

test('an empty query keeps input order within each section', () => {
  const out = searchOpenAnything([
    entry('t2', 'users', { section: 'table' }),
    entry('t1', 'orders', { section: 'table' }),
    entry('a1', 'Settings…', { section: 'command' }),
  ], '');
  const tables = out.find(g => g.section === 'table')!;
  assert.deepEqual(tables.items.map(i => i.id), ['t2', 't1']);
});

test('a blank query behaves as empty', () => {
  const items = [entry('a', 'alpha'), entry('b', 'beta')];
  const out = searchOpenAnything(items, '   ');
  assert.equal(out.reduce((n, g) => n + g.items.length, 0), 2);
});

// ── fuzzy ranking within a section ────────────────────────────────────────────

test('a typed query ranks the best label match first within its section', () => {
  const out = searchOpenAnything([
    entry('a', 'Settings…', { section: 'command' }),
    entry('b', 'Server variables & status', { section: 'command' }),
  ], 'set');
  assert.equal(out[0].items[0].id, 'a');
});

test('non-matching entries are filtered out entirely', () => {
  const out = searchOpenAnything([
    entry('a', 'Settings…', { section: 'command' }),
    entry('t', 'orders', { section: 'table' }),
  ], 'ord');
  assert.equal(out.length, 1);
  assert.equal(out[0].section, 'table');
});

test('a query that matches nothing yields no groups', () => {
  assert.equal(searchOpenAnything([entry('a', 'Settings…')], 'qqzzxx').length, 0);
});

test('a label match outranks a keywords-only match', () => {
  const out = searchOpenAnything([
    entry('a', 'Aardvark', { keywords: 'lines', section: 'command' }),
    entry('b', 'Sort lines', { section: 'command' }),
  ], 'lines');
  assert.deepEqual(out[0].items.map(i => i.id), ['b', 'a']);
});

// ── qualified / table.column matching ─────────────────────────────────────────

test('schema.table queries match an object through its qualified name', () => {
  const out = searchOpenAnything([
    entry('t1', 'orders', { section: 'table', qualified: 'shop.orders' }),
    entry('t2', 'orders_archive', { section: 'table', qualified: 'shop.orders_archive' }),
  ], 'shop.orders');
  const tables = out.find(g => g.section === 'table')!;
  assert.equal(tables.items[0].id, 't1');
});

test('table.column queries reach the column through its qualified name', () => {
  const out = searchOpenAnything([
    entry('t', 'orders', { section: 'table', qualified: 'shop.orders' }),
    entry('c1', 'total', { section: 'column', qualified: 'shop.orders.total' }),
    entry('c2', 'status', { section: 'column', qualified: 'shop.orders.status' }),
  ], 'orders.total');
  const cols = out.find(g => g.section === 'column')!;
  assert.deepEqual(cols.items.map(i => i.id), ['c1']);
});

test('subsequence dotted queries thread through the qualified name', () => {
  const out = searchOpenAnything([
    entry('c', 'total', { section: 'column', qualified: 'shop.orders.total' }),
  ], 'ord.tot');
  assert.equal(out.length, 1);
  assert.equal(out[0].items[0].id, 'c');
});

test('a bare column query matches the column label directly', () => {
  const out = searchOpenAnything([
    entry('c', 'total', { section: 'column', qualified: 'shop.orders.total' }),
  ], 'total');
  assert.equal(out[0].items[0].id, 'c');
});

// ── caps and section restriction ──────────────────────────────────────────────

test('per-section cap bounds each group', () => {
  const items = Array.from({ length: DEFAULT_PER_SECTION + 5 }, (_, i) =>
    entry(`t${i}`, `table_${i}`, { section: 'table' }));
  const out = searchOpenAnything(items, '');
  assert.equal(out[0].items.length, DEFAULT_PER_SECTION);
});

test('the overall limit bounds the flattened result', () => {
  const items: OpenEntry[] = [];
  for (const s of SECTION_ORDER) {
    for (let i = 0; i < DEFAULT_PER_SECTION; i++) {
      items.push(entry(`${s}${i}`, `item_${s}_${i}`, { section: s }));
    }
  }
  const out = searchOpenAnything(items, '');
  const total = out.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, DEFAULT_LIMIT);
});

test('onlySections drops every other section (the ⌘P table filter)', () => {
  const out = searchOpenAnything([
    entry('a', 'Settings…', { section: 'command' }),
    entry('t', 'orders', { section: 'table', qualified: 'shop.orders' }),
    entry('c', 'total', { section: 'column', qualified: 'shop.orders.total' }),
    entry('s', 'Saved: report', { section: 'saved' }),
  ], '', { onlySections: ['table', 'column'] });
  assert.deepEqual(out.map(g => g.section), ['table', 'column']);
});

test('onlySections applies to typed queries too', () => {
  const out = searchOpenAnything([
    entry('a', 'Show orders report', { section: 'command' }),
    entry('t', 'orders', { section: 'table', qualified: 'shop.orders' }),
  ], 'orders', { onlySections: ['table'] });
  assert.deepEqual(out.map(g => g.section), ['table']);
});

test('a custom perSection cap widens go-to-table browsing', () => {
  const items = Array.from({ length: 40 }, (_, i) =>
    entry(`t${i}`, `table_${i}`, { section: 'table' }));
  const out = searchOpenAnything(items, '', { perSection: 25, onlySections: ['table'] });
  assert.equal(out[0].items.length, 25);
});

// ── scale ─────────────────────────────────────────────────────────────────────

test('10k objects + 8k columns rank in a few milliseconds', () => {
  const items: OpenEntry[] = [];
  for (let i = 0; i < 10000; i++) {
    items.push(entry(`t${i}`, `table_${i}`, {
      section: 'table', qualified: `schema_${i % 25}.table_${i}`,
    }));
  }
  for (let i = 0; i < 8000; i++) {
    items.push(entry(`c${i}`, `col_${i}`, {
      section: 'column', qualified: `schema_${i % 25}.table_${i % 10000}.col_${i}`,
    }));
  }
  const t0 = performance.now();
  const out = searchOpenAnything(items, 'table_42.col_7');
  const ms = performance.now() - t0;
  // The contract is < 50 ms on a dev machine; the bound is generous so a
  // loaded CI box cannot flake it — what it catches is a quadratic blow-up
  // (which would take seconds), not exact wall-clock speed.
  assert.ok(ms < 1000, `ranking 18k entries took ${ms.toFixed(1)} ms`);
  const cols = out.find(g => g.section === 'column');
  assert.ok(cols && cols.items.length > 0 && cols.items.length <= DEFAULT_PER_SECTION);
  assert.ok(out.reduce((n, g) => n + g.items.length, 0) <= DEFAULT_LIMIT);
});

test('sections survive as OpenSection-typed keys end to end', () => {
  const s: OpenSection = 'column';
  const out = searchOpenAnything([entry('c', 'x', { section: s })], 'x');
  assert.equal(out[0].section, 'column');
});
