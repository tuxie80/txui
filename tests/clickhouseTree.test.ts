import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSchemaObjects } from '../src/utils/treeGrouping.ts';
import type { SchemaNode } from '../src/types/index.ts';

// ── ClickHouse Distributed tables in the schema tree ────────────────────────
//
// A Distributed-engine table is a proxy over a per-shard local table. It must
// NOT read as ordinary storage, so it buckets into its own "Distributed tables"
// group rather than "Tables".

const distributed = (name: string): SchemaNode => ({
  kind: 'distributed', name, schema: 'metrics',
  cluster: 'prod', target_db: 'metrics', target_table: `${name}_local`,
});
const table = (name: string): SchemaNode => ({
  kind: 'table', name, schema: 'metrics', row_count: null,
});

test('a Distributed table lands in its own group, never in Tables', () => {
  const { groups, ungrouped } = groupSchemaObjects([
    table('hits_local'), distributed('hits'),
  ]);
  const byKind = new Map(groups.map(g => [g.node.group, g]));
  assert.equal(byKind.get('tables')?.items.length, 1);
  assert.equal(byKind.get('tables')?.items[0].name, 'hits_local');
  assert.equal(byKind.get('distributed')?.items.length, 1);
  assert.equal(byKind.get('distributed')?.items[0].name, 'hits');
  assert.equal(byKind.get('distributed')?.node.name, 'Distributed tables');
  assert.equal(ungrouped.length, 0);
});

test('Distributed tables render right after real tables, before views', () => {
  const { groups } = groupSchemaObjects([
    { kind: 'view', name: 'v', schema: 'metrics' },
    distributed('hits'),
    table('hits_local'),
  ]);
  assert.deepEqual(groups.map(g => g.node.group), ['tables', 'distributed', 'views']);
});

test('a database with no Distributed tables shows no Distributed group', () => {
  const { groups } = groupSchemaObjects([table('plain')]);
  assert.ok(!groups.some(g => g.node.group === 'distributed'));
});

// A materialized view's storage target is emitted as a CHILD of the MV (via
// list_columns), so it never passes through groupSchemaObjects — it would fall
// to `ungrouped` if it ever did, which is the safe outcome.
test('a stray mat_view_target does not crash grouping (falls through)', () => {
  const target: SchemaNode = {
    kind: 'mat_view_target', name: '.inner_id.abc', schema: 'metrics',
    bytes: 2048, parts: 3,
  };
  const { groups, ungrouped } = groupSchemaObjects([table('t'), target]);
  assert.equal(groups.length, 1);
  assert.deepEqual(ungrouped, [target]);
});
