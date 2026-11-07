import assert from 'node:assert/strict';
import { readRefreshCatalogAnalysis } from '../src/utils/refreshCatalog.ts';
import { buildRefreshExecutionPlan } from '../src/utils/refreshExecution.ts';
import { planRefreshRowSets } from '../src/utils/refreshRowSets.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import { MYSQL_SNAPSHOT_SQL } from '../src/utils/schemaCollect.ts';

function fixture(source, target) {
  const spec = createDefaultRefreshSpec({
    source: { connectionId: 'live-source', sessionId: 'source-session' },
    schema: source,
    cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  spec.target = { connectionId: 'live-target', sessionId: 'target-session' };
  spec.schemaMappings = [{ source, target }];
  spec.masks = [];
  spec.tables = [
    { table: 'parents', policy: 'full' },
    { table: 'children', policy: 'time_window', column: 'created_on', mode: 'calendar_days', amount: 1, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
    { table: 'cyc_a', policy: 'full' },
  ];
  return spec;
}

if (process.argv[2] === '--queries') {
  const [, , , source, target] = process.argv;
  const spec = fixture(source, target);
  const queries = [];
  for (const [sessionId, schema] of [['source-session', source], ['target-session', target]]) {
    for (const name of ['defaults', 'tables', 'columns', 'indexes', 'foreignKeys', 'stats']) {
      queries.push({ sessionId, sql: MYSQL_SNAPSHOT_SQL[name](schema) });
    }
  }
  console.log(JSON.stringify({ spec, queries }));
  process.exit(0);
}

let text = '';
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
const grids = new Map(input.grids.map(item => [`${item.sessionId}\u0000${item.sql}`, item.grid]));
const runGrid = async (sessionId, sql) => {
  const grid = grids.get(`${sessionId}\u0000${sql}`);
  if (!grid) throw new Error(`missing live grid for ${sessionId}: ${sql}`);
  return grid;
};
const clean = await readRefreshCatalogAnalysis({ spec: input.spec, runGrid });
assert.deepEqual(clean.blockers, []);
assert.equal(clean.complete, true);
assert.equal(clean.scanned.sourceTables, 5);
assert.equal(clean.scanned.targetTables, 5);
assert.equal(clean.scanned.foreignKeys, 4);
assert.equal(clean.scanned.selfReferences, 1);
assert.equal(clean.scanned.cycles, 2);
const composite = clean.graph.foreignKeys.find(edge => edge.name === 'fk_composite');
assert.equal(composite.parts.length, 2);
assert.deepEqual(composite.parts.map(part => part.nullable), [true, false]);
assert.equal(clean.graph.foreignKeys.find(edge => edge.name === 'fk_self').selfReference, true);
assert.deepEqual(clean.tables.find(table => table.table.endsWith('.parents')).generatedColumns, ['computed']);
assert.ok(clean.plan.tables[1].sourceSql.includes("BETWEEN '2026-11-05' AND '2026-11-06'"));
assert.ok(!clean.plan.tables[1].sourceSql.includes('CONVERT_TZ'));

const missingKeySpec = structuredClone(input.spec);
missingKeySpec.tables.push({ table: 'no_key', policy: 'full' });
const missingKey = await readRefreshCatalogAnalysis({ spec: missingKeySpec, runGrid });
assert.ok(missingKey.blockers.some(error => error.includes('.no_key has no primary key or complete unique NOT-NULL index')));
assert.equal(missingKey.complete, false);

const changedGrids = structuredClone(input.grids);
const targetColumns = changedGrids.find(item => item.sessionId === 'target-session' && item.sql.includes('information_schema.COLUMNS'));
const typeIndex = targetColumns.grid.columns.findIndex(name => name.toLowerCase() === 'column_type');
const lengthIndex = targetColumns.grid.columns.findIndex(name => name.toLowerCase() === 'character_maximum_length');
const codeRow = targetColumns.grid.rows.find(row => row[0] === 'parents' && row[1] === 'code');
codeRow[typeIndex] = 'varchar(19)';
codeRow[lengthIndex] = 19;
const incompatible = await readRefreshCatalogAnalysis({
  spec: input.spec,
  runGrid: async (sessionId, sql) => changedGrids.find(item => item.sessionId === sessionId && item.sql === sql)?.grid ?? null,
});
assert.ok(incompatible.blockers.some(error => error.includes('type varchar(20) is incompatible')));
assert.equal(incompatible.complete, false);

const executionSpec = structuredClone(input.spec);
executionSpec.tables = [{ table: 'parents', policy: 'full' }];
const executionCatalog = await readRefreshCatalogAnalysis({ spec: executionSpec, runGrid });
const executionRows = await planRefreshRowSets({
  spec: executionSpec,
  catalog: executionCatalog,
  runGrid: async (_sessionId, sql) => {
    assert.ok(sql.includes('__txui_refresh_selection'));
    return { columns: ['id', 'seq', 'code', 'computed'], rows: [] };
  },
});
assert.equal(executionRows.fixedPoint, true);
const executionPlan = buildRefreshExecutionPlan({ spec: executionSpec, catalog: executionCatalog, rowSets: executionRows });
assert.equal(executionPlan.executable, true);
assert.deepEqual(executionPlan.insertionOrder, [`${executionSpec.schemaMappings[0].source}.parents`]);
const explainSql = executionPlan.tables[0].firstPageSql;
assert.ok(explainSql.includes('ORDER BY `id`, `seq`'));
assert.ok(!explainSql.includes('OFFSET'));

console.log(JSON.stringify({
  sourceTables: clean.scanned.sourceTables,
  targetTables: clean.scanned.targetTables,
  foreignKeys: clean.scanned.foreignKeys,
  selfReferences: clean.scanned.selfReferences,
  cycles: clean.scanned.cycles,
  generatedColumns: 1,
  missingKeyBlocked: true,
  incompatibleTargetBlocked: true,
  metadataQueries: input.grids.length,
  executionPlanExecutable: executionPlan.executable,
  explainSql,
}));
