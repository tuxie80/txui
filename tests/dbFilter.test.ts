/**
 * Per-connection database visibility filter (src/utils/dbFilter.ts, W5.6).
 *
 * The behaviour this locks in: the field applies exactly to the four engines
 * whose tree top level is the server's database list (and NOT to PostgreSQL,
 * Redis or the file engines — the Rust twin is Engine::has_database_listing);
 * parsing is comma-separated, trimmed, deduped, and empty input means
 * "show all", which is what makes old configs backwards compatible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbFilterApplies, parseDbFilter, formatDbFilter } from '../src/utils/dbFilter.ts';
import type { Engine } from '../src/types/index.ts';

test('applies to the engines with a server-side database list', () => {
  const yes: Engine[] = ['mysql', 'clickhouse', 'mongodb', 'sqlserver'];
  const no: Engine[] = ['postgres', 'redis', 'sqlite', 'parquet', 'duckdb'];
  for (const e of yes) assert.equal(dbFilterApplies(e), true, e);
  for (const e of no) assert.equal(dbFilterApplies(e), false, e);
});

test('empty and whitespace input mean "show all"', () => {
  assert.deepEqual(parseDbFilter(''), []);
  assert.deepEqual(parseDbFilter('   '), []);
  assert.deepEqual(parseDbFilter(' , , '), []);
});

test('names are trimmed, empties dropped, duplicates removed', () => {
  assert.deepEqual(parseDbFilter('shop, staging ,,shop'), ['shop', 'staging']);
  assert.deepEqual(parseDbFilter('  db one ,db two'), ['db one', 'db two']);
});

test('case is preserved exactly — matching case rules are the engine’s', () => {
  assert.deepEqual(parseDbFilter('Shop, shop'), ['Shop', 'shop']);
});

test('round-trip through the stored shape', () => {
  assert.equal(formatDbFilter(['shop', 'staging']), 'shop, staging');
  assert.deepEqual(parseDbFilter(formatDbFilter(['shop', 'staging'])), ['shop', 'staging']);
  // An old config has no field at all — undefined formats to the empty input.
  assert.equal(formatDbFilter(undefined), '');
});
