import assert from 'node:assert/strict';
import { readRefreshCatalogAnalysis } from '../src/utils/refreshCatalog.ts';
import { buildRefreshExecutionPlan } from '../src/utils/refreshExecution.ts';
import { buildRefreshExecutionInput } from '../src/utils/refreshExecute.ts';
import { buildRefreshMaskPlan } from '../src/utils/refreshMask.ts';
import { planRefreshRowSets } from '../src/utils/refreshRowSets.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import { MYSQL_SNAPSHOT_SQL } from '../src/utils/schemaCollect.ts';

const CUTOFF = '2026-11-06T12:00:00.000Z';

function fixture(source, target) {
  const spec = createDefaultRefreshSpec({
    source: { connectionId: '00000000-0000-4000-8000-000000000011', sessionId: '00000000-0000-4000-8000-000000000001' },
    schema: source, cutoffUtc: CUTOFF,
  });
  spec.target = { connectionId: '00000000-0000-4000-8000-000000000022', sessionId: '00000000-0000-4000-8000-000000000002' };
  spec.schemaMappings = [{ source, target }];
  spec.tables = [
    { table: 'countries', policy: 'full' },
    { table: 'customers', policy: 'row_limit', rows: 1, orderBy: ['created_at'], direction: 'desc', tieBreaker: ['id'], limitKind: 'soft' },
    { table: 'orders', policy: 'time_window', column: 'created_at', mode: 'rolling', amount: 7, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: CUTOFF },
    { table: 'events', policy: 'time_window', column: 'created_at', mode: 'rolling', amount: 1, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: CUTOFF },
    { table: 'audit_logs', policy: 'sample', rows: 2, sampleSeed: 42, tieBreaker: ['id'], limitKind: 'soft' },
    { table: 'notes', policy: 'predicate', where: 'tenant_id = 1' },
  ];
  spec.masks = [{ table: 'customers', column: 'email', rule: 'hash' }];
  spec.acknowledgeUnmaskedSensitive = true;
  spec.limits.planningKeyBatch = 10;
  spec.limits.maxRowsPerChunk = 2;
  spec.limits.maxBytesPerChunk = 65536;
  return spec;
}

const data = {
  countries: { columns: ['id'], rows: [[1], [2]], requested: [1, 2] },
  customers: {
    columns: ['id', 'email'], rows: [
      [1, 'older@example.test'], [2, 'second@example.test'], [3, 'third@example.test'], [4, 'newest@example.test'],
    ], requested: [4],
  },
  orders: { columns: ['id', 'customer_id'], rows: [[1, 4], [2, 4], [3, 1]], requested: [1, 2] },
  events: { columns: ['id', 'order_id'], rows: [[1, 3], [2, 3], [3, 1]], requested: [1, 2] },
  audit_logs: { columns: ['id'], rows: [[1], [2], [3], [4]], requested: [1, 2] },
  notes: { columns: ['id', 'country_id'], rows: [[1, 1], [2, 1], [3, 2]], requested: [1, 2] },
};

function ids(sql) {
  return [...sql.matchAll(/\((\d+)\)/g)].map(match => Number(match[1]));
}

function selected(table, sql) {
  const wanted = ids(sql);
  return table.rows.filter(row => wanted.includes(row[0]));
}

function rootRows(table) {
  const wanted = new Set(table.requested);
  return table.rows.filter(row => wanted.has(row[0]));
}

if (process.argv[2] === '--queries') {
  const [, , , source, target] = process.argv;
  const spec = fixture(source, target);
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
const rowSets = await planRefreshRowSets({
  spec: input.spec,
  catalog,
  runGrid: async (_sessionId, sql) => {
    const name = Object.keys(data).find(table => sql.includes(`\`${table}\``));
    assert.ok(name, `unexpected mixed-policy SQL: ${sql}`);
    const table = data[name];
    if (sql.includes('__txui_refresh_membership')) {
      const rows = rootRows(table).filter(row => ids(sql).includes(row[0]));
      return { columns: ['id'], rows: rows.map(row => [row[0]]), truncated: false };
    }
    if (sql.includes('__txui_refresh_selection')) {
      return { columns: table.columns, rows: rootRows(table), truncated: false };
    }
    return { columns: table.columns, rows: selected(table, sql), truncated: false };
  },
});
assert.equal(rowSets.fixedPoint, true, rowSets.blockers.join('\n'));
assert.deepEqual(rowSets.totals, { requested: 11, closureAdded: 2, final: 13 });
const expected = {
  countries: { requested: 2, closureAdded: 0, final: 2 },
  customers: { requested: 1, closureAdded: 1, final: 2 },
  orders: { requested: 2, closureAdded: 1, final: 3 },
  events: { requested: 2, closureAdded: 0, final: 2 },
  audit_logs: { requested: 2, closureAdded: 0, final: 2 },
  notes: { requested: 2, closureAdded: 0, final: 2 },
};
for (const [name, counts] of Object.entries(expected)) {
  const table = rowSets.tables.find(candidate => candidate.table.endsWith(`.${name}`));
  assert.ok(table, `missing row-set table ${name}`);
  assert.equal(table.requested, counts.requested, name);
  assert.equal(table.closureAdded, counts.closureAdded, name);
  assert.equal(table.final, counts.final, name);
}
const executionPlan = buildRefreshExecutionPlan({ spec: input.spec, catalog, rowSets });
assert.equal(executionPlan.executable, true, executionPlan.blockers.join('\n'));
const maskPlan = buildRefreshMaskPlan({ spec: input.spec, catalog });
assert.equal(maskPlan.complete, true, maskPlan.blockers.join('\n'));
const executionInput = buildRefreshExecutionInput({
  spec: input.spec, catalog, executionPlan, maskPlan,
  runKey: '00000000-0000-4000-8000-000000000000', productionConfirmation: null,
});
console.log(JSON.stringify({ input: executionInput, expectedRows: 13, expected }));
