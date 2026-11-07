import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRefreshCatalog } from '../src/utils/refreshCatalog.ts';
import { buildRefreshExecutionPlan, refreshCatalogSha256, refreshRowSetSha256, validateRefreshExecutionPlan } from '../src/utils/refreshExecution.ts';
import { buildRefreshPlan } from '../src/utils/refreshPlan.ts';
import type { RefreshRowSetPlan } from '../src/utils/refreshRowSets.ts';
import { planRefreshRowSets } from '../src/utils/refreshRowSets.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import type { CatalogColumn, CatalogFk, CatalogIndex, CatalogTable, SchemaSnapshot } from '../src/utils/schemaRules.ts';
import type { Grid } from '../src/utils/schemaCollect.ts';

function column(table: string, name: string, nullable = false): CatalogColumn {
  return {
    table, name, dataType: 'int', columnType: 'int', nullable, defaultValue: null, extra: '',
    charset: null, collation: null, charMaxLen: null, generationExpression: null, comment: '',
  };
}

function table(name: string): CatalogTable {
  return { name, engine: 'InnoDB', collation: null, rows: 1000, dataBytes: 100_000, indexBytes: 20_000, autoIncrement: null, comment: '' };
}

function index(table: string): CatalogIndex {
  return { table, name: 'PRIMARY', unique: true, type: 'BTREE', columns: [{ name: 'id', seq: 1, subPart: null, cardinality: 1000 }] };
}

function fk(table: string, columnName: string, refTable: string, name: string): CatalogFk {
  return { name, schema: 'source', table, column: columnName, refSchema: 'source', refTable, refColumn: 'id', ordinal: 1, onDelete: 'NO ACTION', onUpdate: 'NO ACTION' };
}

function snapshot(schema: string, cyclic = false): SchemaSnapshot {
  return {
    engine: 'mysql', schema, serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null,
    tables: cyclic ? [table('a'), table('b')] : [table('parents'), table('children')],
    columns: cyclic
      ? [column('a', 'id'), column('a', 'b_id', true), column('b', 'id'), column('b', 'a_id', true)]
      : [column('parents', 'id'), column('children', 'id'), column('children', 'parent_id')],
    indexes: cyclic ? [index('a'), index('b')] : [index('parents'), index('children')],
    foreignKeys: cyclic
      ? [fk('a', 'b_id', 'b', 'fk_a_b'), fk('b', 'a_id', 'a', 'fk_b_a')].map(edge => ({ ...edge, schema, refSchema: schema }))
      : [{ ...fk('children', 'parent_id', 'parents', 'fk_parent'), schema, refSchema: schema }],
  };
}

function spec(cyclic = false) {
  const value = createDefaultRefreshSpec({
    source: { connectionId: 'source', sessionId: 'source-session' }, schema: 'source', cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  value.target = { connectionId: 'target', sessionId: 'target-session' };
  value.schemaMappings = [{ source: 'source', target: 'target' }];
  value.tables = [{ table: cyclic ? 'a' : 'children', policy: 'full' }];
  value.masks = [];
  value.limits.planningKeyBatch = 10;
  return value;
}

async function fixture(cyclic = false) {
  const value = spec(cyclic);
  const source = snapshot('source', cyclic);
  const target = snapshot('target', cyclic);
  const catalog = analyzeRefreshCatalog({ spec: value, source: [source], target: [target] });
  assert.equal(catalog.complete, true);
  const runGrid = async (_sessionId: string, sql: string): Promise<Grid> => {
    if (sql.includes('__txui_refresh_selection')) return cyclic
      ? { columns: ['id', 'b_id'], rows: [[1, 1]] }
      : { columns: ['id', 'parent_id'], rows: [[1, 1]] };
    if (sql.includes('FROM `source`.`parents`')) return { columns: ['id'], rows: [[1]] };
    if (sql.includes('FROM `source`.`a`')) return { columns: ['id', 'b_id'], rows: [[1, 1]] };
    if (sql.includes('FROM `source`.`b`')) return { columns: ['id', 'a_id'], rows: [[1, 1]] };
    return { columns: ['id'], rows: [] };
  };
  const rowSets = await planRefreshRowSets({ spec: value, catalog, runGrid });
  assert.equal(rowSets.fixedPoint, true);
  const plan = buildRefreshExecutionPlan({ spec: value, catalog, rowSets });
  return { spec: value, catalog, rowSets, plan };
}

test('execution plan has exact first-page SQL, unique batches and parent-before-child order', async () => {
  const { plan } = await fixture();
  assert.equal(plan.readOnly, true);
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.insertionOrder, ['source.parents', 'source.children']);
  const child = plan.tables.find(table => table.table === 'source.children')!;
  const parent = plan.tables.find(table => table.table === 'source.parents')!;
  assert.equal(child.selectedRows, 1);
  assert.equal(child.batchRows, 10);
  assert.equal(child.estimatedDataBatches, 1);
  assert.equal(child.estimatedChunkBytes, 1000);
  assert.equal(child.sourceStatsRows, 1000);
  assert.equal(child.keySource, 'PRIMARY');
  assert.deepEqual(child.keyColumns, ['id']);
  assert.ok(child.firstPageSql!.startsWith('SELECT `id`, `parent_id` FROM (SELECT `id`, `parent_id` FROM `source`.`children`'));
  assert.ok(child.firstPageSql!.endsWith('ORDER BY `id` LIMIT 10'));
  assert.ok(!child.firstPageSql!.includes('OFFSET'));
  assert.equal(parent.action, 'dependency');
  assert.equal(parent.firstPageSql, null);
  assert.equal(parent.selectedRows, 1);
});

test('spec, schema and row-set drift each invalidate the exact execution plan', async () => {
  const current = await fixture();
  assert.deepEqual(validateRefreshExecutionPlan(current), []);
  const changedSpec = structuredClone(current.spec);
  changedSpec.seed = 'changed-seed';
  assert.ok(validateRefreshExecutionPlan({ ...current, spec: changedSpec }).includes('specification hash changed'));

  const changedCatalog = structuredClone(current.catalog);
  changedCatalog.graph.tables.find(table => table.name === 'children')!.columns[0].columnType = 'bigint';
  assert.equal(refreshCatalogSha256(changedCatalog) === refreshCatalogSha256(current.catalog), false);
  assert.ok(validateRefreshExecutionPlan({ ...current, catalog: changedCatalog }).includes('source schema/catalog changed'));

  const changedRows = structuredClone(current.rowSets);
  changedRows.tables.find(table => table.table === 'source.children')!.final = 2;
  changedRows.totals.final = 3;
  assert.equal(refreshRowSetSha256(changedRows) === refreshRowSetSha256(current.rowSets), false);
  assert.ok(validateRefreshExecutionPlan({ ...current, rowSets: changedRows }).includes('requested/closure row sets changed'));
});

test('self/cyclic dependencies refuse insertion order instead of guessing', async () => {
  const { plan } = await fixture(true);
  assert.equal(plan.executable, false);
  assert.deepEqual(plan.insertionOrder, []);
  assert.ok(plan.blockers.some(blocker => blocker.includes('self/cyclic dependencies')));
});

test('incomplete row-set proof cannot become an executable plan', async () => {
  const current = await fixture();
  const rowSets = structuredClone(current.rowSets);
  rowSets.fixedPoint = false;
  const plan = buildRefreshExecutionPlan({ ...current, rowSets });
  assert.equal(plan.executable, false);
  assert.ok(plan.blockers.includes('row-set planning has not reached a clean fixed point'));
});

test('a 64-table dependency chain has deterministic parent-before-child insertion order', () => {
  const depth = 64;
  const names = Array.from({ length: depth }, (_, index) => `chain_${String(index).padStart(3, '0')}`);
  const deepSnapshot = (schema: string): SchemaSnapshot => ({
    engine: 'mysql', schema, serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null,
    tables: names.map(table),
    columns: names.flatMap((name, index) => [
      column(name, 'id'),
      ...(index === 0 ? [] : [column(name, 'parent_id')]),
    ]),
    indexes: names.map(index),
    foreignKeys: names.slice(1).map((name, offset) => ({
      ...fk(name, 'parent_id', names[offset], `fk_${name}`), schema, refSchema: schema,
    })),
  });
  const value = spec();
  value.tables = [{ table: names[depth - 1], policy: 'full' }];
  const catalog = analyzeRefreshCatalog({ spec: value, source: [deepSnapshot('source')], target: [deepSnapshot('target')] });
  assert.equal(catalog.complete, true);
  const tables = catalog.tables.map(table => ({
    table: table.table, action: table.action,
    requested: table.action === 'full' ? 1 : 0,
    closureAdded: table.action === 'dependency' ? 1 : 0,
    final: 1, notes: [],
  }));
  const rowSets: RefreshRowSetPlan = {
    readOnly: true, specSha256: buildRefreshPlan(value).specSha256, fixedPoint: true,
    iterations: depth, sourceQueries: depth, sourceRowsRead: depth, tables,
    totals: { requested: 1, closureAdded: depth - 1, final: depth },
    memory: {
      maxPlanningKeys: 10000, planningKeyBatch: 10, closureIdentities: depth,
      recentRequestedIdentities: 1, peakRetainedKeys: depth, peakFrontierRows: 1,
      peakBufferedRows: 1, fullRootKeysRetained: 0,
    },
    blockers: [],
  };
  const plan = buildRefreshExecutionPlan({ spec: value, catalog, rowSets });
  assert.equal(plan.executable, true, plan.blockers.join('\n'));
  assert.equal(plan.insertionOrder.length, depth);
  assert.deepEqual(plan.insertionOrder, names.map(name => `source.${name}`));
  const positions = new Map(plan.insertionOrder.map((name, index) => [name, index]));
  for (const edge of catalog.graph.foreignKeys) {
    assert.ok(positions.get(`${edge.refSchema}.${edge.refTable}`)! < positions.get(`${edge.schema}.${edge.table}`)!);
  }
  assert.equal(plan.tables.reduce((sum, table) => sum + table.selectedRows, 0), depth);
});
