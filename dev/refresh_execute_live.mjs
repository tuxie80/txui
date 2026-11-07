import assert from 'node:assert/strict';
import { readRefreshCatalogAnalysis } from '../src/utils/refreshCatalog.ts';
import { buildRefreshExecutionPlan } from '../src/utils/refreshExecution.ts';
import { buildRefreshExecutionInput } from '../src/utils/refreshExecute.ts';
import { buildRefreshMaskPlan } from '../src/utils/refreshMask.ts';
import { planRefreshRowSets } from '../src/utils/refreshRowSets.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import { MYSQL_SNAPSHOT_SQL } from '../src/utils/schemaCollect.ts';

function fixture(source, target, rows = 8) {
  const spec = createDefaultRefreshSpec({
    source: { connectionId: '00000000-0000-4000-8000-000000000011', sessionId: '00000000-0000-4000-8000-000000000001' },
    schema: source,
    cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  spec.target = { connectionId: '00000000-0000-4000-8000-000000000022', sessionId: '00000000-0000-4000-8000-000000000002' };
  spec.schemaMappings = [{ source, target }];
  spec.tables = [{ table: 'children', policy: 'predicate', where: `id <= ${rows} AND SLEEP(0.05) = 0` }];
  spec.masks = [{ table: 'parents', column: 'email', rule: 'hash' }];
  spec.limits.planningKeyBatch = 2;
  spec.limits.maxRowsPerChunk = 2;
  spec.acknowledgeUnmaskedSensitive = true;
  return spec;
}

if (process.argv[2] === '--queries') {
  const [, , , source, target, rows] = process.argv;
  const spec = fixture(source, target, Number(rows ?? 8));
  const queries = [];
  for (const [sessionId, schema] of [[spec.source.sessionId, source], [spec.target.sessionId, target]]) {
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
const catalog = await readRefreshCatalogAnalysis({ spec: input.spec, runGrid });
assert.equal(catalog.complete, true, catalog.blockers.join('\n'));
const childIds = Array.from({ length: input.rows }, (_, index) => index + 1);
const rowSets = await planRefreshRowSets({
  spec: input.spec,
  catalog,
  runGrid: async (_sessionId, sql) => {
    if (sql.includes('__txui_refresh_selection')) {
      const after = sql.match(/WHERE \(`id`\) > \((\d+)\)/);
      const first = after ? Number(after[1]) : 0;
      const ids = childIds.filter(id => id > first).slice(0, 2);
      return { columns: ['id', 'parent_id'], rows: ids.map(id => [id, (id - 1) % 3 + 1]), truncated: false };
    }
    if (sql.includes('FROM') && sql.includes('`parents`')) {
      const batch = sql.split(' IN ')[1] ?? '';
      const ids = [...batch.matchAll(/\((\d+)\)/g)].map(match => Number(match[1]));
      const parents = [[1, 'one@example.test'], [2, 'two@example.test'], [3, 'three@example.test']];
      return { columns: ['id', 'email'], rows: parents.filter(row => ids.includes(row[0])), truncated: false };
    }
    throw new Error(`unexpected row-set SQL: ${sql}`);
  },
});
assert.equal(rowSets.fixedPoint, true, rowSets.blockers.join('\n'));
const executionPlan = buildRefreshExecutionPlan({ spec: input.spec, catalog, rowSets });
assert.equal(executionPlan.executable, true, executionPlan.blockers.join('\n'));
const maskPlan = buildRefreshMaskPlan({ spec: input.spec, catalog });
assert.equal(maskPlan.complete, true, maskPlan.blockers.join('\n'));
const executionInput = buildRefreshExecutionInput({
  spec: input.spec, catalog, executionPlan, maskPlan,
  runKey: '00000000-0000-4000-8000-000000000000', productionConfirmation: null,
});
console.log(JSON.stringify({ input: executionInput, expectedRows: input.rows + 3 }));
