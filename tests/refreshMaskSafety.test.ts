import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRefreshCatalog } from '../src/utils/refreshCatalog.ts';
import {
  analyzeRefreshMaskSafety, createRefreshMaskCollisionTracker, refreshInsertColumns,
} from '../src/utils/refreshMaskSafety.ts';
import type { RefreshCommittedScope } from '../src/utils/refreshMaskSafety.ts';
import { planRefreshRowSets } from '../src/utils/refreshRowSets.ts';
import type { RefreshRowSetPlan } from '../src/utils/refreshRowSets.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import type { RefreshSpec } from '../src/utils/refreshSpec.ts';
import type { CatalogColumn, CatalogIndex, CatalogTable, SchemaSnapshot } from '../src/utils/schemaRules.ts';
import type { Grid } from '../src/utils/schemaCollect.ts';

function column(table: string, name: string, type: string, over: Partial<CatalogColumn> = {}): CatalogColumn {
  const dataType = type.replace(/\(.*/, '');
  const length = /\((\d+)(?:,\d+)?\)/.exec(type)?.[1];
  return {
    table, name, dataType, columnType: type, nullable: false, defaultValue: null, extra: '',
    charset: dataType === 'varchar' || dataType === 'text' ? 'utf8mb4' : null,
    collation: dataType === 'varchar' || dataType === 'text' ? 'utf8mb4_0900_ai_ci' : null,
    charMaxLen: length ? Number(length) : null, generationExpression: null, comment: '', ...over,
  };
}

function table(name: string): CatalogTable {
  return { name, engine: 'InnoDB', collation: 'utf8mb4_0900_ai_ci', rows: 2, dataBytes: 200, indexBytes: 100, autoIncrement: null, comment: '' };
}

function index(table: string, name: string, columns: string[]): CatalogIndex {
  return { table, name, unique: true, type: 'BTREE', columns: columns.map((name, at) => ({ name, seq: at + 1, subPart: null, cardinality: 2 })) };
}

function snapshot(schema: string): SchemaSnapshot {
  return {
    engine: 'mysql', schema, serverCharset: 'utf8mb4', serverCollation: 'utf8mb4_0900_ai_ci',
    schemaCharset: 'utf8mb4', schemaCollation: 'utf8mb4_0900_ai_ci',
    tables: [table('parents'), table('lines')],
    columns: [
      column('parents', 'id', 'varchar(64)'), column('parents', 'email', 'varchar(64)'),
      column('lines', 'id', 'int'), column('lines', 'email', 'varchar(64)', { nullable: true }),
      column('lines', 'tenant_id', 'int'), column('lines', 'amount', 'decimal(12,2)'),
      column('lines', 'full_name', 'varchar(100)'), column('lines', 'payload', 'varbinary(64)'),
      column('lines', 'computed', 'varchar(21)', { extra: 'STORED GENERATED', generationExpression: "concat(`full_name`,'!')" }),
    ],
    indexes: [
      index('parents', 'PRIMARY', ['id']), index('parents', 'uq_email', ['email']),
      index('lines', 'PRIMARY', ['id']), index('lines', 'uq_email_tenant', ['email', 'tenant_id']),
      index('lines', 'uq_amount', ['amount']),
    ],
    foreignKeys: [],
  };
}

function spec(masks: RefreshSpec['masks'], acknowledge = true): RefreshSpec {
  const value = createDefaultRefreshSpec({
    source: { connectionId: 'source', sessionId: 'source-session' }, schema: 'source', cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  value.target = { connectionId: 'target', sessionId: 'target-session' };
  value.schemaMappings = [{ source: 'source', target: 'target' }];
  value.tables = [{ table: 'parents', policy: 'full' }, { table: 'lines', policy: 'full' }];
  value.masks = masks;
  value.acknowledgeUnmaskedSensitive = acknowledge;
  return value;
}

async function fixture(masks: RefreshSpec['masks'], acknowledge = true) {
  const value = spec(masks, acknowledge);
  const catalog = analyzeRefreshCatalog({ spec: value, source: [snapshot('source')], target: [snapshot('target')] });
  assert.equal(catalog.complete, true);
  const runGrid = async (_sessionId: string, sql: string): Promise<Grid> => {
    if (sql.includes('FROM `source`.`parents`')) return { columns: ['id', 'email'], rows: [['p1', 'p1@example.test'], ['p2', 'p2@example.test']] };
    if (sql.includes('FROM `source`.`lines`')) return { columns: ['id', 'amount'], rows: [[1, '1.00']] };
    throw new Error(`unexpected query ${sql}`);
  };
  const rowSets = await planRefreshRowSets({ spec: value, catalog, runGrid });
  assert.equal(rowSets.fixedPoint, true, JSON.stringify(rowSets.blockers));
  const safety = analyzeRefreshMaskSafety({ spec: value, catalog, rowSets });
  return { spec: value, catalog, rowSets, safety };
}

const scope = (committedRows: number): RefreshCommittedScope => ({ committedRows, inFlightRows: 1 });

test('unique masked emails collide at runtime and report committed scope without row values', async () => {
  const current = await fixture([
    { table: 'parents', column: 'email', rule: 'hash' },
    { table: 'lines', column: 'email', rule: 'hash' },
    { table: 'lines', column: 'amount', rule: 'constant', value: 1.00 },
  ]);
  assert.deepEqual(current.safety.blockers, []);
  assert.equal(current.safety.uniqueChecks.length, 3);
  const tracker = createRefreshMaskCollisionTracker(current);
  tracker.check('source.parents', { id: 'p1', email: 'same@example.test' }, scope(0));
  assert.equal(tracker.acceptedRows(), 1);
  assert.throws(
    () => tracker.check('source.parents', { id: 'p2', email: 'same@example.test' }, scope(1)),
    error => {
      assert.equal(error.code, 'collision');
      assert.deepEqual(error.committedScope, scope(1));
      assert.ok(!error.message.includes('same@example.test'));
      return true;
    },
  );
  assert.equal(tracker.acceptedRows(), 1);
});

test('composite unique keys, NULLs, Unicode collations and exact decimals are respected', async () => {
  const current = await fixture([
    { table: 'parents', column: 'email', rule: 'hash' },
    { table: 'lines', column: 'email', rule: 'hash' },
    { table: 'lines', column: 'amount', rule: 'constant', value: 1.00 },
  ]);
  const tracker = createRefreshMaskCollisionTracker(current);
  tracker.check('source.lines', { id: 1, email: null, tenant_id: 1, amount: '1.00', full_name: 'A', payload: 'x' }, scope(0));
  tracker.check('source.lines', { id: 2, email: null, tenant_id: 1, amount: '2.00', full_name: 'B', payload: 'y' }, scope(1));
  tracker.check('source.lines', { id: 3, email: 'A@example.test', tenant_id: 1, amount: '3.00', full_name: 'C', payload: 'z' }, scope(2));
  tracker.check('source.lines', { id: 4, email: 'A@example.test', tenant_id: 2, amount: '4.00', full_name: 'D', payload: 'q' }, scope(3));
  assert.equal(tracker.acceptedRows(), 4);
  assert.throws(
    () => tracker.check('source.lines', { id: 5, email: 'a@example.test', tenant_id: 1, amount: '5.00', full_name: 'E', payload: 'r' }, scope(4)),
    error => error.code === 'collision' && error.committedScope.committedRows === 4,
  );
  assert.throws(
    () => tracker.check('source.lines', { id: 6, email: 'different@example.test', tenant_id: 1, amount: '1.0', full_name: 'F', payload: 's' }, scope(4)),
    error => error.code === 'collision' && error.index === 'uq_amount' && error.committedScope.committedRows === 4,
  );
});

test('constant masks with multiple selected rows are guaranteed preflight collisions', async () => {
  const current = await fixture([{ table: 'lines', column: 'amount', rule: 'constant', value: 1.00 }]);
  const rowSets: RefreshRowSetPlan = structuredClone(current.rowSets);
  rowSets.tables.find(table => table.table === 'source.lines')!.final = 2;
  const safety = analyzeRefreshMaskSafety({ spec: current.spec, catalog: current.catalog, rowSets });
  assert.equal(safety.complete, false);
  assert.ok(safety.blockers.some(blocker => blocker.includes('guarantee a collision on unique index uq_amount')));
  assert.throws(() => createRefreshMaskCollisionTracker({ ...current, safety }), /blockers/);
});

test('generated columns are omitted and generated insert attempts are refused', async () => {
  const current = await fixture([]);
  assert.deepEqual(refreshInsertColumns(current.catalog.graph.tables.find(table => table.key === 'source.lines')!),
    ['id', 'email', 'tenant_id', 'amount', 'full_name', 'payload']);
  const tracker = createRefreshMaskCollisionTracker(current);
  assert.throws(
    () => tracker.check('source.lines', { id: 1, computed: 'generated' }, scope(7)),
    error => error.code === 'generated_insert' && error.committedScope.committedRows === 7,
  );
});

test('binary/generated mask refusal and sensitive acknowledgment are explicit', async () => {
  const invalid = await fixture([
    { table: 'lines', column: 'payload', rule: 'hash' },
    { table: 'lines', column: 'computed', rule: 'fake', generator: 'format' },
  ]);
  assert.ok(invalid.safety.blockers.some(blocker => blocker.includes('unsupported varbinary')));
  assert.ok(invalid.safety.blockers.some(blocker => blocker.includes('generated and must be recomputed')));

  const unacknowledged = await fixture([], false);
  assert.equal(unacknowledged.safety.complete, false);
  assert.ok(unacknowledged.safety.sensitiveUnmasked.includes('source.lines.full_name'));
  assert.ok(unacknowledged.safety.blockers.some(blocker => blocker.includes('explicitly acknowledge')));
  const acknowledged = analyzeRefreshMaskSafety({
    spec: { ...unacknowledged.spec, acknowledgeUnmaskedSensitive: true },
    catalog: unacknowledged.catalog, rowSets: unacknowledged.rowSets,
  });
  assert.equal(acknowledged.complete, true);
  assert.ok(acknowledged.notes.some(note => note.includes('not execution proof')));
});

test('collision tracking has a hard key cap with committed scope', async () => {
  const current = await fixture([{ table: 'parents', column: 'email', rule: 'hash' }]);
  current.spec.limits.maxPlanningKeys = 1;
  const tracker = createRefreshMaskCollisionTracker(current);
  tracker.check('source.parents', { id: 'p1', email: 'one@example.test' }, scope(0));
  assert.throws(
    () => tracker.check('source.parents', { id: 'p2', email: 'two@example.test' }, scope(1)),
    error => error.code === 'planning_cap' && error.committedScope.committedRows === 1,
  );
});
