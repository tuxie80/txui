import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeRefreshCatalog, buildRefreshGraph } from '../src/utils/refreshCatalog.ts';
import { planRefreshRowSets } from '../src/utils/refreshRowSets.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';

const KEYS = 1_000_000;
const BATCH = 100_000;
const HEAP_BUDGET = 1024 ** 3;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'txui-refresh-memory-'));
let peakHeap = 0;
const measure = () => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); };
const gc = () => { if (globalThis.gc) globalThis.gc(); };

function snapshot(schema) {
  const table = name => ({ name, engine: 'InnoDB', collation: null, rows: KEYS, dataBytes: null, indexBytes: null, autoIncrement: null, comment: '' });
  const column = (tableName, name, nullable = false) => ({
    table: tableName, name, dataType: 'int', columnType: 'int', nullable, defaultValue: null, extra: '',
    charset: null, collation: null, charMaxLen: null, generationExpression: null, comment: '',
  });
  const index = tableName => ({
    table: tableName, name: 'PRIMARY', unique: true, type: 'BTREE',
    columns: [{ name: 'id', seq: 1, subPart: null, cardinality: KEYS }],
  });
  return {
    engine: 'mysql', schema, serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null,
    tables: [table('parents'), table('children')],
    columns: [column('parents', 'id'), column('children', 'id'), column('children', 'parent_id')],
    indexes: [index('parents'), index('children')],
    foreignKeys: [{ name: 'fk_parent', schema, table: 'children', column: 'parent_id', refSchema: schema, refTable: 'parents', refColumn: 'id', ordinal: 1, onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }],
  };
}

const source = snapshot('source');
const target = snapshot('target');
const spec = createDefaultRefreshSpec({
  source: { connectionId: 'source', sessionId: 'source-session' }, schema: 'source', cutoffUtc: '2026-11-06T12:00:00.000Z',
});
spec.target = { connectionId: 'target', sessionId: 'target-session' };
spec.schemaMappings = [{ source: 'source', target: 'target' }];
spec.tables = [{ table: 'children', policy: 'full' }];
spec.masks = [];
spec.limits.planningKeyBatch = BATCH;
spec.limits.maxPlanningKeys = KEYS;
const catalog = analyzeRefreshCatalog({ spec, source: [source], target: [target] });
assert.equal(catalog.complete, true);

const columns = sql => [...sql.slice(7, sql.indexOf(' FROM ')).matchAll(/`([^`]+)`/g)].map(match => match[1]);
const runGrid = async (_sessionId, sql) => {
  await new Promise(resolve => setImmediate(resolve));
  const selected = columns(sql);
  let ids;
  if (sql.includes('__txui_refresh_selection')) {
    const after = /WHERE \(`id`\) > \((\d+)\)/.exec(sql);
    const limit = Number(/ LIMIT (\d+)$/.exec(sql)[1]);
    const start = after ? Number(after[1]) + 1 : 1;
    const end = Math.min(KEYS, start + limit - 1);
    ids = Array.from({ length: Math.max(0, end - start + 1) }, (_, at) => start + at);
  } else {
    const inClause = / IN \((.*)\)$/.exec(sql)[1];
    ids = [...inClause.matchAll(/\((\d+)\)/g)].map(match => Number(match[1]));
  }
  const rows = ids.map(id => selected.map(name => name === 'parent_id' ? id : id));
  measure();
  return { columns: selected, rows };
};

try {
  gc();
  const baselineHeap = process.memoryUsage().heapUsed;
  const result = await planRefreshRowSets({ spec, catalog, runGrid });
  gc();
  measure();
  assert.deepEqual(result.blockers, []);
  assert.equal(result.fixedPoint, true);
  assert.deepEqual(result.totals, { requested: KEYS, closureAdded: KEYS, final: 2 * KEYS });
  assert.equal(result.sourceQueries, 21);
  assert.equal(result.sourceRowsRead, 2 * KEYS);
  assert.equal(result.memory.fullRootKeysRetained, 0);
  assert.equal(result.memory.closureIdentities, KEYS);
  assert.equal(result.memory.peakRetainedKeys, KEYS);
  assert.equal(result.memory.peakFrontierRows, BATCH);
  assert.equal(result.memory.peakBufferedRows, BATCH);
  assert.ok(peakHeap < HEAP_BUDGET, `heap ${peakHeap} exceeded ${HEAP_BUDGET}`);
  assert.deepEqual(fs.readdirSync(temp), []);

  const manyTables = buildRefreshGraph([{
    ...snapshot('graph'),
    tables: Array.from({ length: 1000 }, (_, at) => ({ name: `t${at}`, engine: 'InnoDB', collation: null, rows: 0, dataBytes: null, indexBytes: null, autoIncrement: null, comment: '' })),
    columns: [], indexes: [], foreignKeys: [],
  }]);
  assert.equal(manyTables.tables.length, 1000);
  measure();
  assert.ok(peakHeap < HEAP_BUDGET, `graph pushed heap over budget: ${peakHeap}`);
  console.log(JSON.stringify({
    keysPerSide: KEYS,
    graphTables: manyTables.tables.length,
    sourceQueries: result.sourceQueries,
    sourceRowsRead: result.sourceRowsRead,
    totals: result.totals,
    memory: result.memory,
    baselineHeapMiB: Math.round(baselineHeap / 1024 / 1024),
    peakHeapMiB: Math.round(peakHeap / 1024 / 1024),
    budgetMiB: HEAP_BUDGET / 1024 / 1024,
    temporaryKeyFiles: 0,
    node: process.version,
    platform: process.platform,
  }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
