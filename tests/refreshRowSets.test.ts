import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRefreshCatalog } from '../src/utils/refreshCatalog.ts';
import type { RefreshCatalogAnalysis, RefreshForeignKeyEdge, RefreshGraphTable } from '../src/utils/refreshCatalog.ts';
import { buildRefreshParentLookupSql, planRefreshRowSets } from '../src/utils/refreshRowSets.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import type { RefreshSpec, RefreshTablePolicy } from '../src/utils/refreshSpec.ts';
import type { CatalogColumn, CatalogFk, CatalogIndex, CatalogTable, SchemaSnapshot } from '../src/utils/schemaRules.ts';
import type { Grid } from '../src/utils/schemaCollect.ts';

type Cell = string | number | null;

function column(table: string, name: string, nullable = false, dataType = 'int'): CatalogColumn {
  return {
    table, name, dataType, columnType: dataType, nullable, defaultValue: null, extra: '',
    charset: null, collation: null, charMaxLen: null, generationExpression: null, comment: '',
  };
}

function table(name: string): CatalogTable {
  return { name, engine: 'InnoDB', collation: null, rows: 2, dataBytes: 100, indexBytes: 100, autoIncrement: null, comment: '' };
}

function index(table: string, columns: string[]): CatalogIndex {
  return { table, name: 'PRIMARY', unique: true, type: 'BTREE', columns: columns.map((name, at) => ({ name, seq: at + 1, subPart: null, cardinality: 2 })) };
}

function foreign(table: string, columns: string[], parent: string, parentColumns: string[], name = `fk_${table}_${parent}`): CatalogFk[] {
  return columns.map((column, at) => ({
    name, schema: 'source', table, column, refSchema: 'source', refTable: parent, refColumn: parentColumns[at],
    ordinal: at + 1, onDelete: 'NO ACTION', onUpdate: 'NO ACTION',
  }));
}

function snapshot(schema: string, definitions: { name: string; columns: string[]; key: string[]; nullable?: string[]; dates?: string[] }[], edges: CatalogFk[] = []): SchemaSnapshot {
  return {
    engine: 'mysql', schema, serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null,
    tables: definitions.map(item => table(item.name)),
    columns: definitions.flatMap(item => item.columns.map(name => column(item.name, name, item.nullable?.includes(name), item.dates?.includes(name) ? 'date' : 'int'))),
    indexes: definitions.map(item => index(item.name, item.key)),
    foreignKeys: edges.map(edge => ({ ...edge, schema, refSchema: schema })),
  };
}

function spec(policies: RefreshTablePolicy[]): RefreshSpec {
  const value = createDefaultRefreshSpec({
    source: { connectionId: 'source', sessionId: 'source-session' }, schema: 'source', cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  value.target = { connectionId: 'target', sessionId: 'target-session' };
  value.schemaMappings = [{ source: 'source', target: 'target' }];
  value.tables = policies;
  value.masks = [];
  value.limits.planningKeyBatch = 1000;
  value.limits.maxPlanningKeys = 1000;
  return value;
}

function catalogWithSpec(source: SchemaSnapshot, value: RefreshSpec): RefreshCatalogAnalysis {
  const target = structuredClone(source);
  target.schema = 'target';
  for (const edge of target.foreignKeys) {
    edge.schema = 'target';
    edge.refSchema = 'target';
  }
  return analyzeRefreshCatalog({ spec: value, source: [source], target: [target] });
}

function catalog(source: SchemaSnapshot, policies: RefreshTablePolicy[]): RefreshCatalogAnalysis {
  return catalogWithSpec(source, spec(policies));
}

function selectedColumns(sql: string): string[] {
  const projection = sql.slice('SELECT '.length, sql.indexOf(' FROM '));
  return [...projection.matchAll(/`((?:[^`]|``)+)`/g)].map(match => match[1].replace(/``/g, '`'));
}

function literal(value: string): Cell {
  if (!value.startsWith("'")) return Number(value);
  return value.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, '\\').replace(/\\'/g, "'");
}

function gridRunner(
  datasets: Record<string, Record<string, Cell>[]>,
  rootRows: Record<string, Record<string, Cell>[]> = datasets,
) {
  const queries: string[] = [];
  const runGrid = async (_sessionId: string, sql: string): Promise<Grid> => {
    queries.push(sql);
    const relation = /FROM `source`\.`([^`]+)`/.exec(sql)?.[1];
    if (!relation) throw new Error('unexpected relation');
    const columns = selectedColumns(sql);
    let rows = datasets[relation];
    if (!sql.includes(' IN (')) rows = rootRows[relation];
    else {
      const match = /WHERE \(([^)]+)\) IN \((.*)\)$/.exec(sql);
      if (!match) throw new Error(`unrecognized parent query ${sql}`);
      const refs = [...match[1].matchAll(/`([^`]+)`/g)].map(item => item[1]);
      const wanted = [...match[2].matchAll(/\(([^)]*)\)/g)].map(item => item[1].split(', ').map(literal));
      rows = datasets[relation].filter(row => wanted.some(values => refs.every((ref, at) => row[ref] === values[at])));
    }
    return { columns, rows: rows.map(row => columns.map(name => row[name] ?? null)) };
  };
  return { queries, runGrid };
}

const temporalPolicies: RefreshTablePolicy[] = [
  { table: 'parents', policy: 'sample', rows: 1, sampleSeed: 1, tieBreaker: ['id'] },
  { table: 'children', policy: 'time_window', column: 'created_on', mode: 'rolling', amount: 7, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
  { table: 'siblings', policy: 'time_window', column: 'created_on', mode: 'rolling', amount: 1, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
];

function temporalCatalog() {
  const edges = [...foreign('children', ['parent_id'], 'parents', ['id']), ...foreign('siblings', ['parent_id'], 'parents', ['id'])];
  const source = snapshot('source', [
    { name: 'parents', columns: ['id'], key: ['id'] },
    { name: 'children', columns: ['id', 'parent_id', 'created_on'], key: ['id'], dates: ['created_on'] },
    { name: 'siblings', columns: ['id', 'parent_id', 'created_on'], key: ['id'], dates: ['created_on'] },
  ], edges);
  return catalog(source, temporalPolicies);
}

test('last-7-day child + limited parent + last-1-day sibling reaches exact explained closure', async () => {
  const datasets = {
    parents: [{ id: 1 }, { id: 2 }],
    children: [{ id: 11, parent_id: 1, created_on: '2026-11-05' }],
    siblings: [{ id: 21, parent_id: 2, created_on: '2026-11-06' }],
  };
  const runner = gridRunner(datasets, {
    parents: [{ id: 2 }], children: datasets.children, siblings: datasets.siblings,
  });
  const sessions = new Set<string>();
  const result = await planRefreshRowSets({
    spec: spec(temporalPolicies), catalog: temporalCatalog(),
    runGrid: async (sessionId, sql) => { sessions.add(sessionId); return runner.runGrid(sessionId, sql); },
  });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.fixedPoint, true);
  assert.deepEqual(result.totals, { requested: 3, closureAdded: 1, final: 4 });
  assert.deepEqual(result.tables.map(row => [row.table, row.requested, row.closureAdded, row.final]), [
    ['source.children', 1, 0, 1], ['source.parents', 1, 1, 2], ['source.siblings', 1, 0, 1],
  ]);
  assert.ok(result.tables[1].notes[0].includes("outside this table's own selection"));
  assert.equal(result.sourceQueries, 4);
  assert.equal(result.sourceRowsRead, 4);
  assert.deepEqual([...sessions], ['source-session']);
  assert.ok(runner.queries.every(sql => !sql.includes('SELECT *')));
  assert.ok(!JSON.stringify(result).includes('2026-11-05'));
});

test('composite FKs with any NULL part skip parents and non-NULL tuples close exactly', async () => {
  const policies: RefreshTablePolicy[] = [{ table: 'children', policy: 'full' }];
  const source = snapshot('source', [
    { name: 'parents', columns: ['id', 'seq'], key: ['id', 'seq'] },
    { name: 'children', columns: ['id', 'parent_id', 'parent_seq'], key: ['id'], nullable: ['parent_id', 'parent_seq'] },
  ], foreign('children', ['parent_id', 'parent_seq'], 'parents', ['id', 'seq']));
  const runner = gridRunner({
    parents: [{ id: 2, seq: 20 }],
    children: [
      { id: 1, parent_id: null, parent_seq: 10 },
      { id: 2, parent_id: 2, parent_seq: null },
      { id: 3, parent_id: 2, parent_seq: 20 },
    ],
  });
  const result = await planRefreshRowSets({ spec: spec(policies), catalog: catalog(source, policies), runGrid: runner.runGrid });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.totals, { requested: 3, closureAdded: 1, final: 4 });
  assert.equal(result.sourceQueries, 2);
  assert.equal(result.tables.find(row => row.table === 'source.parents')!.action, 'dependency');
});

test('two-table cycles terminate at a fixed point with bounded parent batches', async () => {
  const policies: RefreshTablePolicy[] = [{ table: 'cyc_a', policy: 'sample', rows: 1, sampleSeed: 1, tieBreaker: ['id'] }];
  const source = snapshot('source', [
    { name: 'cyc_a', columns: ['id', 'b_id'], key: ['id'], nullable: ['b_id'] },
    { name: 'cyc_b', columns: ['id', 'a_id'], key: ['id'], nullable: ['a_id'] },
  ], [...foreign('cyc_a', ['b_id'], 'cyc_b', ['id']), ...foreign('cyc_b', ['a_id'], 'cyc_a', ['id'])]);
  const value = spec(policies);
  value.limits.planningKeyBatch = 1;
  const runner = gridRunner({
    cyc_a: [{ id: 1, b_id: 1 }, { id: 2, b_id: 2 }],
    cyc_b: [{ id: 1, a_id: 2 }, { id: 2, a_id: 1 }],
  }, { cyc_a: [{ id: 1, b_id: 1 }], cyc_b: [] });
  const result = await planRefreshRowSets({ spec: value, catalog: catalogWithSpec(source, value), runGrid: runner.runGrid });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.totals, { requested: 1, closureAdded: 3, final: 4 });
  assert.equal(result.iterations, 3);
  assert.equal(result.sourceQueries, 4);
  assert.equal(result.fixedPoint, true);
});

test('self references add their ancestors and stop at NULL', async () => {
  const policies: RefreshTablePolicy[] = [{ table: 'nodes', policy: 'sample', rows: 1, sampleSeed: 1, tieBreaker: ['id'] }];
  const source = snapshot('source', [
    { name: 'nodes', columns: ['id', 'parent_id'], key: ['id'], nullable: ['parent_id'] },
  ], foreign('nodes', ['parent_id'], 'nodes', ['id'], 'fk_self'));
  const runner = gridRunner({ nodes: [{ id: 1, parent_id: 2 }, { id: 2, parent_id: null }] }, { nodes: [{ id: 1, parent_id: 2 }] });
  const result = await planRefreshRowSets({ spec: spec(policies), catalog: catalog(source, policies), runGrid: runner.runGrid });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.totals, { requested: 1, closureAdded: 1, final: 2 });
  assert.equal(result.sourceQueries, 2);
});

test('missing parents, key caps and generate policies never produce an executable plan', async () => {
  const policies: RefreshTablePolicy[] = [{ table: 'children', policy: 'full' }];
  const source = snapshot('source', [
    { name: 'parents', columns: ['id'], key: ['id'] },
    { name: 'children', columns: ['id', 'parent_id'], key: ['id'] },
  ], foreign('children', ['parent_id'], 'parents', ['id']));
  const analysis = catalog(source, policies);
  const orphan = await planRefreshRowSets({
    spec: spec(policies), catalog: analysis,
    runGrid: gridRunner({ parents: [], children: [{ id: 1, parent_id: 99 }] }).runGrid,
  });
  assert.equal(orphan.fixedPoint, false);
  assert.equal(orphan.totals.final, null);
  assert.ok(orphan.blockers[0].includes('requires a missing parent'));
  assert.ok(!JSON.stringify(orphan).includes('99'));

  const capped = spec(policies);
  capped.limits.maxPlanningKeys = 1;
  const overCap = await planRefreshRowSets({
    spec: capped, catalog: catalogWithSpec(source, capped),
    runGrid: gridRunner({ parents: [{ id: 2 }], children: [{ id: 1, parent_id: 2 }, { id: 2, parent_id: null }] }).runGrid,
  });
  assert.ok(overCap.blockers[0].includes('key cap'));
  assert.equal(overCap.fixedPoint, false);

  const generating = spec([{ table: 'parents', policy: 'generate', rows: 2, seedOffset: 0 }]);
  const generated = await planRefreshRowSets({ spec: generating, catalog: catalogWithSpec(source, generating), runGrid: gridRunner({ parents: [], children: [] }).runGrid });
  assert.ok(generated.blockers[0].includes('before deterministic generation supplies keys'));
  assert.equal(generated.totals.final, null);
});

test('catalog mismatches are refused before any application-row query', async () => {
  const policies: RefreshTablePolicy[] = [{ table: 'parents', policy: 'full' }];
  const source = snapshot('source', [{ name: 'parents', columns: ['id'], key: ['id'] }]);
  const analysis = catalog(source, policies);
  let calls = 0;
  const changed = spec(policies);
  changed.seed = 'different-spec';
  await assert.rejects(() => planRefreshRowSets({
    spec: changed, catalog: analysis,
    runGrid: async () => { calls += 1; return { columns: [], rows: [] }; },
  }), /different specification/);
  assert.equal(calls, 0);
});

test('parent lookup SQL quotes composite identifiers and string keys without a full-row projection', () => {
  const policies: RefreshTablePolicy[] = [{ table: 'children', policy: 'full' }];
  const source = snapshot('source', [
    { name: 'parents', columns: ['id', 'seq'], key: ['id', 'seq'] },
    { name: 'children', columns: ['id', 'parent_id', 'parent_seq'], key: ['id'] },
  ], foreign('children', ['parent_id', 'parent_seq'], 'parents', ['id', 'seq']));
  const analysis = catalog(source, policies);
  const parent: RefreshGraphTable = analysis.graph.tables.find(item => item.name === 'parents')!;
  const edge: RefreshForeignKeyEdge = analysis.graph.foreignKeys[0];
  const sql = buildRefreshParentLookupSql(parent, analysis, edge, [["a\\b'", 2]]);
  assert.ok(sql.startsWith('SELECT `id`, `seq` FROM `source`.`parents`'));
  assert.ok(sql.includes("('a\\\\b''', 2)"));
  assert.ok(!sql.includes('SELECT *'));
  assert.throws(() => buildRefreshParentLookupSql(parent, analysis, edge, []), /empty or malformed key batch/);
  assert.throws(() => buildRefreshParentLookupSql(parent, analysis, edge, [[1]]), /empty or malformed key batch/);
});
