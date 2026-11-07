import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRefreshCatalog } from '../src/utils/refreshCatalog.ts';
import { buildGenerateInsteadHandoff, parseGenerateInsteadHandoff } from '../src/utils/refreshGenerate.ts';
import { buildRefreshMaskPlan } from '../src/utils/refreshMask.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import type { RefreshSpec, RefreshTablePolicy } from '../src/utils/refreshSpec.ts';
import type { CatalogColumn, CatalogFk, CatalogIndex, CatalogTable, SchemaSnapshot } from '../src/utils/schemaRules.ts';

function column(table: string, name: string, dataType = 'varchar', generated = false): CatalogColumn {
  return {
    table, name, dataType, columnType: dataType === 'varchar' ? 'varchar(64)' : dataType,
    nullable: name !== 'id', defaultValue: null, extra: generated ? 'STORED GENERATED' : '',
    charset: dataType === 'varchar' ? 'utf8mb4' : null,
    collation: dataType === 'varchar' ? 'utf8mb4_0900_ai_ci' : null,
    charMaxLen: dataType === 'varchar' ? 64 : null,
    generationExpression: generated ? "concat(`email`,'!')" : null, comment: '',
  };
}

function table(name: string): CatalogTable {
  return { name, engine: 'InnoDB', collation: null, rows: 10, dataBytes: 1000, indexBytes: 100, autoIncrement: null, comment: '' };
}

function index(table: string, name = 'PRIMARY', columnName = 'id'): CatalogIndex {
  return { table, name, unique: true, type: 'BTREE', columns: [{ name: columnName, seq: 1, subPart: null, cardinality: 10 }] };
}

function snapshot(schema: string, foreignKey = false): SchemaSnapshot {
  const columns = [
    column('customers', 'id', 'int'), column('customers', 'email'), column('customers', 'note'),
    column('customers', 'computed', 'varchar', true),
    ...(foreignKey ? [column('customers', 'parent_id', 'int'), column('parents', 'id', 'int')] : []),
  ];
  const foreignKeys: CatalogFk[] = foreignKey ? [{
    name: 'fk_parent', schema, table: 'customers', column: 'parent_id', refSchema: schema,
    refTable: 'parents', refColumn: 'id', ordinal: 1, onDelete: 'NO ACTION', onUpdate: 'NO ACTION',
  }] : [];
  return {
    engine: 'mysql', schema, serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null,
    tables: foreignKey ? [table('customers'), table('parents')] : [table('customers')], columns,
    indexes: foreignKey ? [index('customers'), index('parents')] : [index('customers')], foreignKeys,
  };
}

function fixture(foreignKey = false) {
  const spec = createDefaultRefreshSpec({
    source: { connectionId: 'c-source', sessionId: 's-source' }, schema: 'shop', cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  spec.target = { connectionId: 'c-target', sessionId: 's-target' };
  spec.schemaMappings = [{ source: 'shop', target: 'stage' }];
  spec.tables = [{ table: 'customers', policy: 'generate', rows: 25, seedOffset: 7 }];
  spec.masks = [
    { table: 'customers', column: 'email', rule: 'fake', generator: 'person.full_name' },
    { table: 'customers', column: 'note', rule: 'constant', value: 'constant-fixture' },
  ];
  const catalog = analyzeRefreshCatalog({ spec, source: [snapshot('shop', foreignKey)], target: [snapshot('stage', foreignKey)] });
  assert.equal(catalog.complete, true);
  const maskPlan = buildRefreshMaskPlan({ spec, catalog });
  assert.equal(maskPlan.complete, true);
  return { spec, catalog, maskPlan, policy: spec.tables[0] as Extract<RefreshTablePolicy, { policy: 'generate' }> };
}

test('generate handoff is deterministic, typed and omits generated/source-row data', () => {
  const current = fixture(true);
  const first = buildGenerateInsteadHandoff(current);
  const second = buildGenerateInsteadHandoff(current);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const { handoff } = first;
  assert.equal(handoff.targetSessionId, 's-target');
  assert.equal(handoff.targetConnectionId, 'c-target');
  assert.equal(handoff.generate.table, 'stage.customers');
  assert.equal(handoff.generate.rowCount, 25);
  assert.equal(handoff.generate.useCopy, false);
  assert.equal(handoff.generate.specs.some(spec => spec.name === 'computed'), false);
  assert.equal(handoff.generate.specs.find(spec => spec.name === 'email')?.generator, 'fullName');
  assert.equal(handoff.generate.specs.find(spec => spec.name === 'note')?.params.prefix, 'constant-fixture');
  assert.equal(handoff.generate.specs.find(spec => spec.name === 'parent_id')?.generator, 'fk');
  assert.equal(handoff.generate.specs.find(spec => spec.name === 'id')?.unique, true);
  assert.deepEqual(parseGenerateInsteadHandoff(handoff), handoff);
  assert.equal(JSON.stringify(handoff).includes('private-row'), false);
});

test('source-dependent hash and format masks refuse generation instead of changing semantics', () => {
  for (const mask of [
    { table: 'customers', column: 'email', rule: 'hash' } as const,
    { table: 'customers', column: 'email', rule: 'fake', generator: 'format' } as const,
  ]) {
    const current = fixture();
    current.spec.masks = [mask];
    current.maskPlan = buildRefreshMaskPlan({ spec: current.spec, catalog: current.catalog });
    const result = buildGenerateInsteadHandoff(current);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some(error => error.includes('source-value-dependent')));
  }
});

test('stale evidence and incomplete catalogs cannot open a generation handoff', () => {
  const current = fixture();
  current.maskPlan = { ...current.maskPlan, specSha256: '0'.repeat(64) };
  const stale = buildGenerateInsteadHandoff(current);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.ok(stale.errors.some(error => error.includes('different Refresh specification')));
  const incomplete = buildGenerateInsteadHandoff({ ...current, catalog: { ...current.catalog, complete: false } });
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.ok(incomplete.errors.some(error => error.includes('catalog compatibility')));
});

test('strict handoff parsing rejects tampering, extra payloads and wrong endpoint shapes', () => {
  const current = fixture();
  const result = buildGenerateInsteadHandoff(current);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { handoff } = result;
  assert.throws(() => parseGenerateInsteadHandoff({ ...handoff, rows: [['private-row']] }), /unexpected fields/);
  assert.throws(() => parseGenerateInsteadHandoff({ ...handoff, generate: { ...handoff.generate, autoRun: true } }), /unexpected fields/);
  assert.throws(() => parseGenerateInsteadHandoff({ ...handoff, targetSessionId: '' }), /targetSessionId/);
  assert.throws(() => parseGenerateInsteadHandoff({ ...handoff, specSha256: 'not-a-hash' }), /specSha256/);
  assert.throws(() => parseGenerateInsteadHandoff({ ...handoff, generate: { ...handoff.generate, rowCount: 0 } }), /rowCount/);
});
