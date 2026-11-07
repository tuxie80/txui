import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRefreshCatalog } from '../src/utils/refreshCatalog.ts';
import { buildRefreshMaskPlan, createRefreshMaskRuntime } from '../src/utils/refreshMask.ts';
import { planRefreshRowSets } from '../src/utils/refreshRowSets.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import type { RefreshSpec } from '../src/utils/refreshSpec.ts';
import type { CatalogColumn, CatalogFk, CatalogIndex, CatalogTable, SchemaSnapshot } from '../src/utils/schemaRules.ts';
import type { Grid } from '../src/utils/schemaCollect.ts';

function column(table: string, name: string, type: string, nullable = false): CatalogColumn {
  const dataType = type.replace(/\(.*/, '');
  const length = /\((\d+)\)/.exec(type)?.[1];
  return {
    table, name, dataType, columnType: type, nullable, defaultValue: null, extra: '',
    charset: dataType === 'varchar' ? 'utf8mb4' : null,
    collation: dataType === 'varchar' ? 'utf8mb4_0900_ai_ci' : null,
    charMaxLen: length ? Number(length) : null, generationExpression: null, comment: '',
  };
}

function table(name: string): CatalogTable {
  return { name, engine: 'InnoDB', collation: 'utf8mb4_0900_ai_ci', rows: 2, dataBytes: 200, indexBytes: 100, autoIncrement: null, comment: '' };
}

function index(table: string): CatalogIndex {
  return { table, name: 'PRIMARY', unique: true, type: 'BTREE', columns: [{ name: 'id', seq: 1, subPart: null, cardinality: 2 }] };
}

function snapshot(schema: string): SchemaSnapshot {
  const fk: CatalogFk = {
    name: 'fk_parent', schema, table: 'children', column: 'parent_id', refSchema: schema,
    refTable: 'parents', refColumn: 'id', ordinal: 1, onDelete: 'NO ACTION', onUpdate: 'NO ACTION',
  };
  return {
    engine: 'mysql', schema, serverCharset: 'utf8mb4', serverCollation: 'utf8mb4_0900_ai_ci',
    schemaCharset: 'utf8mb4', schemaCollation: 'utf8mb4_0900_ai_ci',
    tables: [table('parents'), table('children')],
    columns: [
      column('parents', 'id', 'varchar(64)'), column('parents', 'email', 'varchar(64)'),
      column('parents', 'full_name', 'varchar(100)'), column('parents', 'code', 'varchar(10)'),
      column('parents', 'note', 'text', true), column('children', 'id', 'varchar(64)'),
      column('children', 'parent_id', 'varchar(64)'),
    ],
    indexes: [index('parents'), index('children')], foreignKeys: [fk],
  };
}

function spec(masks: RefreshSpec['masks'] = []): RefreshSpec {
  const value = createDefaultRefreshSpec({
    source: { connectionId: 'source', sessionId: 'source-session' }, schema: 'source', cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  value.target = { connectionId: 'target', sessionId: 'target-session' };
  value.schemaMappings = [{ source: 'source', target: 'target' }];
  value.tables = [{ table: 'children', policy: 'full' }];
  value.masks = masks;
  return value;
}

function fixture(masks: RefreshSpec['masks']) {
  const value = spec(masks);
  const catalog = analyzeRefreshCatalog({ spec: value, source: [snapshot('source')], target: [snapshot('target')] });
  assert.equal(catalog.complete, true);
  const plan = buildRefreshMaskPlan({ spec: value, catalog });
  return { spec: value, catalog, plan };
}

test('hash, seeded generators and format masks are deterministic across calls and chunks', () => {
  const current = fixture([
    { table: 'parents', column: 'email', rule: 'hash' },
    { table: 'parents', column: 'full_name', rule: 'fake', generator: 'person.full_name' },
    { table: 'parents', column: 'code', rule: 'fake', generator: 'format' },
    { table: 'parents', column: 'note', rule: 'preserve' },
  ]);
  assert.deepEqual(current.plan.blockers, []);
  const first = createRefreshMaskRuntime(current.plan, current.spec);
  const second = createRefreshMaskRuntime(current.plan, current.spec);
  const email = first.apply('source.parents', 'email', 'person@example.test');
  assert.equal(email.length, 64);
  assert.equal(email, second.apply('source.parents', 'email', 'person@example.test'));
  assert.notEqual(email, 'person@example.test');
  const fullName = first.apply('source.parents', 'full_name', 'Original Name');
  assert.ok(fullName.includes(' '));
  assert.equal(fullName, second.apply('source.parents', 'full_name', 'Original Name'));
  const formatted = first.apply('source.parents', 'code', 'Ab-19');
  assert.equal(formatted.length, 5);
  assert.match(formatted, /^[A-Z][a-z]-[0-9][0-9]$/);
  assert.equal(formatted, second.apply('source.parents', 'code', 'Ab-19'));
  assert.equal(first.apply('source.parents', 'note', null), null);
  assert.equal(first.apply('source.parents', 'note', 'unchanged'), 'unchanged');
});

test('matching FK masks share relational seeds and child-only masks are refused', () => {
  const matching = fixture([
    { table: 'parents', column: 'id', rule: 'hash' },
    { table: 'children', column: 'parent_id', rule: 'hash' },
  ]);
  assert.deepEqual(matching.plan.blockers, []);
  const runtime = createRefreshMaskRuntime(matching.plan, matching.spec);
  const parent = runtime.apply('source.parents', 'id', 'parent-1');
  const child = runtime.apply('source.children', 'parent_id', 'parent-1');
  assert.equal(child, parent);

  const childOnly = fixture([{ table: 'children', column: 'parent_id', rule: 'hash' }]);
  assert.equal(childOnly.plan.complete, false);
  assert.ok(childOnly.plan.blockers.some(blocker => blocker.includes('relational equality would break')));
  assert.throws(() => createRefreshMaskRuntime(childOnly.plan, childOnly.spec), /blockers/);

  childOnly.spec.allowFkBreaking = true;
  const breaking = buildRefreshMaskPlan({ spec: childOnly.spec, catalog: childOnly.catalog });
  assert.equal(breaking.complete, true);
  const allowed = createRefreshMaskRuntime(breaking, childOnly.spec);
  assert.notEqual(allowed.apply('source.children', 'parent_id', 'parent-1'), 'parent-1');
});

test('equal FK constants are safe and NULL/type/length contracts fail closed', () => {
  const constants = fixture([
    { table: 'parents', column: 'id', rule: 'constant', value: 'same' },
    { table: 'children', column: 'parent_id', rule: 'constant', value: 'same' },
  ]);
  assert.deepEqual(constants.plan.blockers, []);
  const runtime = createRefreshMaskRuntime(constants.plan, constants.spec);
  assert.equal(runtime.apply('source.parents', 'id', 'old'), 'same');
  assert.equal(runtime.apply('source.children', 'parent_id', 'old'), 'same');

  const invalid = fixture([
    { table: 'parents', column: 'id', rule: 'constant', value: null },
    { table: 'parents', column: 'code', rule: 'hash' },
    { table: 'parents', column: 'full_name', rule: 'fake', generator: 'not.a.generator' },
  ]);
  assert.ok(invalid.plan.blockers.some(blocker => blocker.includes('NOT NULL')));
  assert.ok(invalid.plan.blockers.some(blocker => blocker.includes('SHA-256 needs 64')));
  assert.ok(invalid.plan.blockers.some(blocker => blocker.includes('unknown seeded generator')));
});

test('non-key mask edits cannot change requested rows, closure or selection SQL', async () => {
  const before = fixture([]);
  const after = fixture([{ table: 'parents', column: 'full_name', rule: 'fake', generator: 'person.full_name' }]);
  const runGrid = async (_sessionId: string, sql: string): Promise<Grid> => {
    if (sql.includes('__txui_refresh_selection')) return { columns: ['id', 'parent_id'], rows: [['child', 'parent']] };
    if (sql.includes('FROM `source`.`parents`')) return { columns: ['id'], rows: [['parent']] };
    throw new Error(`unexpected query ${sql}`);
  };
  const queriesBefore: string[] = [];
  const queriesAfter: string[] = [];
  const first = await planRefreshRowSets({
    spec: before.spec, catalog: before.catalog,
    runGrid: async (sessionId, sql) => { queriesBefore.push(sql); return runGrid(sessionId, sql); },
  });
  const second = await planRefreshRowSets({
    spec: after.spec, catalog: after.catalog,
    runGrid: async (sessionId, sql) => { queriesAfter.push(sql); return runGrid(sessionId, sql); },
  });
  assert.deepEqual(second.tables, first.tables);
  assert.deepEqual(second.totals, first.totals);
  assert.deepEqual(queriesAfter, queriesBefore);
  assert.notEqual(second.specSha256, first.specSha256);
});

test('mask runtime refuses a different specification hash', () => {
  const current = fixture([{ table: 'parents', column: 'email', rule: 'hash' }]);
  const changed = structuredClone(current.spec);
  changed.seed = 'different-seed';
  assert.throws(() => createRefreshMaskRuntime(current.plan, changed), /different specification/);
});
