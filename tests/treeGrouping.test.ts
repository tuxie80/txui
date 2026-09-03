import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSchemaObjects, isGroupNode, parentPath } from '../src/utils/treeGrouping.ts';
import type { SchemaNode } from '../src/types/index.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function table(name: string): SchemaNode {
  return { kind: 'table', name, schema: 'shop', row_count: null };
}
function view(name: string): SchemaNode {
  return { kind: 'view', name, schema: 'shop' };
}
function routine(name: string, routine_type: string): SchemaNode {
  return { kind: 'routine', name, schema: 'shop', routine_type };
}
function trigger(name: string): SchemaNode {
  return { kind: 'trigger', name, schema: 'shop' };
}
function event(name: string): SchemaNode {
  return { kind: 'event', name, schema: 'shop' };
}

// ── groupSchemaObjects ────────────────────────────────────────────────────────

test('groupSchemaObjects: flat list bucketed by kind in fixed order', () => {
  // MySQL-family list_schema(db) shape: tables, views, routines, triggers, events — flat.
  const flat: SchemaNode[] = [
    table('orders'), table('users'), view('v_orders'),
    routine('calc_total', 'FUNCTION'), routine('rebuild', 'PROCEDURE'),
    trigger('orders_bi'), event('nightly_rollup'),
  ];
  const { groups, ungrouped } = groupSchemaObjects(flat);

  assert.deepEqual(groups.map(g => g.node.group), ['tables', 'views', 'functions', 'procedures', 'triggers', 'events']);
  assert.deepEqual(groups.map(g => g.node.name), ['Tables', 'Views', 'Functions', 'Procedures', 'Triggers', 'Events']);
  assert.deepEqual(groups.map(g => g.node.count), [2, 1, 1, 1, 1, 1]);
  assert.deepEqual(groups[0].items.map(i => ('name' in i ? i.name : '')), ['orders', 'users']);
  assert.equal(ungrouped.length, 0);
  assert.ok(groups.every(g => isGroupNode(g.node)));
});

test('groupSchemaObjects: empty groups are suppressed', () => {
  // PG list_schema(schema) typically has no triggers/events.
  const { groups } = groupSchemaObjects([table('a'), view('v'), routine('f', 'FUNCTION')]);
  assert.deepEqual(groups.map(g => g.node.group), ['tables', 'views', 'functions']);
});

test('groupSchemaObjects: routines split by routine_type (case-insensitive)', () => {
  const { groups } = groupSchemaObjects([
    routine('fn1', 'function'), routine('fn2', 'FUNCTION'), routine('p1', 'procedure'),
  ]);
  assert.deepEqual(groups.map(g => g.node.group), ['functions', 'procedures']);
  assert.equal(groups[0].node.count, 2);
  assert.equal(groups[1].node.count, 1);
});

test('groupSchemaObjects: tables only (common case) → single Tables group', () => {
  const { groups, ungrouped } = groupSchemaObjects([table('a'), table('b'), table('c')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].node.name, 'Tables');
  assert.equal(groups[0].node.count, 3);
  assert.equal(ungrouped.length, 0);
});

test('groupSchemaObjects: unrecognized nodes fall through to ungrouped', () => {
  const column: SchemaNode = { kind: 'column', name: 'id', type_name: 'int', nullable: false, primary_key: true };
  const { groups, ungrouped } = groupSchemaObjects([table('a'), column]);
  assert.equal(groups.length, 1);
  assert.deepEqual(ungrouped, [column]);
});

test('groupSchemaObjects: empty input → no groups', () => {
  const { groups, ungrouped } = groupSchemaObjects([]);
  assert.deepEqual(groups, []);
  assert.deepEqual(ungrouped, []);
});

// ── parentPath (group-skipping "ns.object" builder) ───────────────────────────

test('parentPath: MySQL shape — table under group under database', () => {
  const chain = [
    { kind: 'table', name: 'orders' },
    { kind: 'group', name: 'Tables' },
    { kind: 'database', name: 'shop' },
  ];
  assert.equal(parentPath(chain), 'shop.orders');
});

test('parentPath: PG shape — table under group under schema under database', () => {
  // Only the NEAREST real ancestor joins the path (pre-grouping semantics),
  // so the PG database layer never leaks into "schema.table".
  const chain = [
    { kind: 'table', name: 'orders' },
    { kind: 'group', name: 'Tables' },
    { kind: 'schema', name: 'public' },
    { kind: 'database', name: 'postgres' },
  ];
  assert.equal(parentPath(chain), 'public.orders');
});

test('parentPath: column under table (group skipped further up)', () => {
  const chain = [
    { kind: 'column', name: 'id' },
    { kind: 'table', name: 'orders' },
    { kind: 'group', name: 'Tables' },
    { kind: 'database', name: 'shop' },
  ];
  assert.equal(parentPath(chain), 'orders.id');
});

test('parentPath: root node without parent is just its name', () => {
  assert.equal(parentPath([{ kind: 'database', name: 'shop' }]), 'shop');
  assert.equal(parentPath([]), '');
});

test('parentPath: routine under group — DDL path unchanged', () => {
  const chain = [
    { kind: 'routine', name: 'calc_total' },
    { kind: 'group', name: 'Functions' },
    { kind: 'database', name: 'shop' },
  ];
  assert.equal(parentPath(chain), 'shop.calc_total');
});

// ── PostgreSQL object kinds ───────────────────────────────────────────────
// Materialized views, sequences and user-defined types are PG-only and were
// previously either absent from list_schema or collapsed into "Views".

const pgNodes: SchemaNode[] = [
  { kind: 'table',    name: 'orders',   schema: 'txui_demo', row_count: null },
  { kind: 'view',     name: 'v_open',   schema: 'txui_demo' },
  { kind: 'mat_view', name: 'mv_totals', schema: 'txui_demo' },
  { kind: 'trigger',  name: 'trg_touch', schema: 'txui_demo' },
  { kind: 'sequence', name: 'invoice_seq', schema: 'txui_demo' },
  { kind: 'type',     name: 'order_status', schema: 'txui_demo', type_kind: 'ENUM' },
  { kind: 'type',     name: 'addr',     schema: 'txui_demo', type_kind: 'COMPOSITE' },
];

test('PostgreSQL objects land in their own groups, in display order', () => {
  const { groups, ungrouped } = groupSchemaObjects(pgNodes);
  assert.deepEqual(
    groups.map(g => [g.node.name, g.node.count]),
    [
      ['Tables', 1],
      ['Views', 1],
      ['Materialized views', 1],
      ['Triggers', 1],
      ['Sequences', 1],
      ['Types', 2],
    ],
  );
  assert.equal(ungrouped.length, 0);
});

test('a materialized view is never folded into Views', () => {
  const { groups } = groupSchemaObjects(pgNodes);
  const views = groups.find(g => g.node.group === 'views');
  assert.deepEqual(views?.items.map(i => i.name), ['v_open']);
  const mv = groups.find(g => g.node.group === 'matviews');
  assert.deepEqual(mv?.items.map(i => i.name), ['mv_totals']);
});

test('empty groups are dropped — a MySQL tree shows no PG-only headers', () => {
  const mysqlish: SchemaNode[] = [
    { kind: 'table', name: 't', schema: 'shop', row_count: null },
    { kind: 'event', name: 'e', schema: 'shop' },
  ];
  const { groups } = groupSchemaObjects(mysqlish);
  assert.deepEqual(groups.map(g => g.node.group), ['tables', 'events']);
  assert.ok(!groups.some(g => g.node.group === 'matviews'));
  assert.ok(!groups.some(g => g.node.group === 'sequences'));
});

test('parentPath: a sequence under its group resolves to schema.sequence', () => {
  assert.equal(
    parentPath([
      { kind: 'sequence', name: 'invoice_seq' },
      { kind: 'group', name: 'Sequences' },
      { kind: 'schema', name: 'txui_demo' },
    ]),
    'txui_demo.invoice_seq',
  );
});

test('group nodes are still identified as such', () => {
  const { groups } = groupSchemaObjects(pgNodes);
  assert.ok(groups.every(g => isGroupNode(g.node)));
});

// ── Aggregates ────────────────────────────────────────────────────────────
// PostgreSQL prokind 'a'/'w'. The Procedures matcher used to be "not
// FUNCTION", which would have swallowed these.

test('aggregates and window functions get their own group, not Procedures', () => {
  const nodes: SchemaNode[] = [
    { kind: 'routine', name: 'calc',        schema: 's', routine_type: 'FUNCTION' },
    { kind: 'routine', name: 'do_thing',    schema: 's', routine_type: 'PROCEDURE' },
    { kind: 'routine', name: 'total_cents', schema: 's', routine_type: 'AGGREGATE' },
    { kind: 'routine', name: 'rank_it',     schema: 's', routine_type: 'WINDOW' },
  ];
  const { groups } = groupSchemaObjects(nodes);
  const by = (g: string) => groups.find(x => x.node.group === g);
  assert.deepEqual(by('functions')?.items.map(i => i.name), ['calc']);
  assert.deepEqual(by('procedures')?.items.map(i => i.name), ['do_thing']);
  assert.deepEqual(by('aggregates')?.items.map(i => i.name).sort(), ['rank_it', 'total_cents']);
});

test('MySQL routines still split cleanly into Functions and Procedures', () => {
  const nodes: SchemaNode[] = [
    { kind: 'routine', name: 'f1', schema: 'shop', routine_type: 'FUNCTION' },
    { kind: 'routine', name: 'p1', schema: 'shop', routine_type: 'PROCEDURE' },
  ];
  const { groups, ungrouped } = groupSchemaObjects(nodes);
  assert.deepEqual(groups.map(g => g.node.group), ['functions', 'procedures']);
  assert.equal(ungrouped.length, 0, 'no MySQL routine may fall through to ungrouped');
});

// ── DuckDB macros ───────────────────────────────────────────────────────────
// list_objects() in db/duckdb.rs emits routine nodes with routine_type MACRO /
// TABLE_MACRO. Without a group they would scatter, ungrouped, between Tables
// and Views — a macro-heavy DuckDB file is exactly where they pile up.

test('DuckDB macros group as Macros, not as Functions or ungrouped strays', () => {
  const nodes: SchemaNode[] = [
    { kind: 'table', name: 'main.orders', schema: 'main', row_count: null },
    { kind: 'view', name: 'main.v_open', schema: 'main' },
    { kind: 'routine', name: 'main.norm', schema: 'main', routine_type: 'MACRO' },
    { kind: 'routine', name: 'main.top_n', schema: 'main', routine_type: 'TABLE_MACRO' },
  ];
  const { groups, ungrouped } = groupSchemaObjects(nodes);
  assert.deepEqual(groups.map(g => g.node.group), ['tables', 'views', 'macros']);
  const macros = groups.find(g => g.node.group === 'macros');
  assert.equal(macros?.node.name, 'Macros');
  assert.deepEqual(macros?.items.map(i => i.name), ['main.norm', 'main.top_n']);
  assert.equal(ungrouped.length, 0, 'no DuckDB routine may fall through to ungrouped');
});

test('the DuckDB parent path carries the database: db.schema.table', () => {
  // DuckDB is three-level; the table node name is already "schema.table", so
  // the nearest real ancestor (the database node) makes "db.schema.table" —
  // which is exactly what list_columns / get_ddl expect.
  const chain = [
    { kind: 'table', name: 'main.orders' },
    { kind: 'group', name: 'Tables' },
    { kind: 'database', name: 'memory' },
  ];
  assert.equal(parentPath(chain), 'memory.main.orders');
});

// ── PostgreSQL objects that used to be invisible ────────────────────────────

test('RLS policies and extensions get their own groups', () => {
  // Both were absent from the tree entirely: a policy decides which rows a
  // role can see at all, and an extension decides what the server can do.
  const { groups } = groupSchemaObjects([
    { kind: 'table', name: 'orders', schema: 'public', row_count: null },
    { kind: 'policy', name: 'orders_tenant', schema: 'public', table: 'orders', command: 'ALL' },
    { kind: 'extension', name: 'pg_stat_statements', schema: 'public', version: '1.10', default_version: '1.11' },
  ]);
  const byKind = new Map(groups.map(g => [g.node.group, g]));
  assert.equal(byKind.get('policies')?.items.length, 1);
  assert.equal(byKind.get('extensions')?.items.length, 1);
  assert.equal(byKind.get('tables')?.items.length, 1);
});

test('a schema with neither shows neither group', () => {
  // Groups with no members are dropped — a MySQL connection must not grow an
  // empty "RLS policies" heading.
  const { groups } = groupSchemaObjects([
    { kind: 'table', name: 'orders', schema: 'shop', row_count: null },
  ]);
  assert.deepEqual(groups.map(g => g.node.group), ['tables']);
});

test('the new groups come after the objects they describe', () => {
  // Order is fixed and meaningful: relations, then code, then the declarative
  // PostgreSQL objects.
  const { groups } = groupSchemaObjects([
    { kind: 'extension', name: 'e', schema: 'public', version: '1', default_version: null },
    { kind: 'policy', name: 'p', schema: 'public', table: 't', command: 'SELECT' },
    { kind: 'table', name: 't', schema: 'public', row_count: null },
  ]);
  assert.deepEqual(groups.map(g => g.node.group), ['tables', 'policies', 'extensions']);
});

// ── PG cluster-global objects + foreign tables (new tree kinds) ─────────────

test('cluster-global PG objects each land in their own group', () => {
  // Publications, event triggers, tablespaces and foreign servers are listed
  // at the connection root; foreign tables sit inside their schema.
  const { groups } = groupSchemaObjects([
    { kind: 'publication', name: 'pub_all', schema: null, all_tables: true, table_count: 0 },
    { kind: 'event_trigger', name: 'et_audit', schema: null, event: 'ddl_command_start', enabled: true },
    { kind: 'tablespace', name: 'fast_ssd', schema: null, owner: 'postgres', location: '/mnt/ssd' },
    { kind: 'foreign_server', name: 'remote_pg', schema: null, fdw: 'postgres_fdw' },
  ]);
  const byKind = new Map(groups.map(g => [g.node.group, g]));
  assert.equal(byKind.get('publications')?.items.length, 1);
  assert.equal(byKind.get('event_triggers')?.items.length, 1);
  assert.equal(byKind.get('tablespaces')?.items.length, 1);
  assert.equal(byKind.get('foreign_servers')?.items.length, 1);
  assert.deepEqual(byKind.get('publications')?.node.name && [
    byKind.get('publications')?.node.name,
    byKind.get('event_triggers')?.node.name,
    byKind.get('tablespaces')?.node.name,
    byKind.get('foreign_servers')?.node.name,
  ], ['Publications', 'Event triggers', 'Tablespaces', 'Foreign servers']);
});

test('foreign tables group apart from ordinary tables', () => {
  const { groups } = groupSchemaObjects([
    { kind: 'table', name: 'orders', schema: 'public', row_count: null },
    { kind: 'foreign_table', name: 'remote_users', schema: 'public', server: 'remote_pg' },
  ]);
  const byKind = new Map(groups.map(g => [g.node.group, g]));
  assert.equal(byKind.get('tables')?.items.length, 1);
  assert.equal(byKind.get('foreign_tables')?.items.length, 1);
  // Foreign tables render right after real tables/partitions, before views.
  assert.deepEqual(groups.map(g => g.node.group), ['tables', 'foreign_tables']);
});

test('a MySQL root grows none of the PG-global groups', () => {
  // Databases match no group def → ungrouped (rendered flat), no headings.
  const { groups, ungrouped } = groupSchemaObjects([
    { kind: 'database', name: 'shop' },
    { kind: 'database', name: 'blog' },
  ]);
  assert.deepEqual(groups, []);
  assert.equal(ungrouped.length, 2);
});
