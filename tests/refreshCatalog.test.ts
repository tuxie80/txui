import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeRefreshCatalog, buildRefreshGraph, readRefreshCatalogAnalysis,
} from '../src/utils/refreshCatalog.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import type { CatalogColumn, CatalogFk, CatalogIndex, CatalogTable, SchemaSnapshot } from '../src/utils/schemaRules.ts';
import type { Grid } from '../src/utils/schemaCollect.ts';

function column(table: string, name: string, type = 'int', over: Partial<CatalogColumn> = {}): CatalogColumn {
  const dataType = type.replace(/\s*\(.*/, '').replace(/\s+unsigned$/, '');
  const charMaxLen = /^varchar\((\d+)\)/.exec(type)?.[1];
  return {
    table, name, dataType, columnType: type, nullable: false, defaultValue: null, extra: '',
    charset: dataType === 'varchar' ? 'utf8mb4' : null,
    collation: dataType === 'varchar' ? 'utf8mb4_0900_ai_ci' : null,
    charMaxLen: charMaxLen ? Number(charMaxLen) : null, generationExpression: null, comment: '', ...over,
  };
}

function table(name: string): CatalogTable {
  return { name, engine: 'InnoDB', collation: 'utf8mb4_0900_ai_ci', rows: 10, dataBytes: 1024, indexBytes: 1024, autoIncrement: null, comment: '' };
}

function index(table: string, name: string, columns: string[], over: Partial<CatalogIndex> = {}): CatalogIndex {
  return {
    table, name, unique: true, type: 'BTREE',
    columns: columns.map((name, at) => ({ name, seq: at + 1, subPart: null, cardinality: 10 })), ...over,
  };
}

function fk(table: string, name: string, columns: string[], refTable: string, refColumns: string[], over: Partial<CatalogFk> = {}): CatalogFk {
  return columns.map((column, at) => ({
    name, schema: 'source', table, column, refSchema: 'source', refTable, refColumn: refColumns[at], ordinal: at + 1,
    onDelete: 'NO ACTION', onUpdate: 'NO ACTION', ...over,
  }));
}

function snapshot(schema: string, over: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    engine: 'mysql', schema, serverCharset: 'utf8mb4', serverCollation: 'utf8mb4_0900_ai_ci',
    schemaCharset: 'utf8mb4', schemaCollation: 'utf8mb4_0900_ai_ci', tables: [], columns: [], indexes: [], foreignKeys: [], ...over,
  };
}

function relationalSnapshot(schema: string): SchemaSnapshot {
  const generated = column('parents', 'computed', 'varchar(21)', {
    extra: 'STORED GENERATED', generationExpression: "concat(`code`,'!')",
  });
  return snapshot(schema, {
    tables: ['parents', 'children', 'cyc_a', 'cyc_b'].map(table),
    columns: [
      column('parents', 'id'), column('parents', 'seq'), column('parents', 'code', 'varchar(20)'), generated,
      column('children', 'id'), column('children', 'parent_id', 'int', { nullable: true }),
      column('children', 'parent_seq'), column('children', 'self_parent', 'int', { nullable: true }),
      column('children', 'created_on', 'date'),
      column('cyc_a', 'id'), column('cyc_a', 'b_id', 'int', { nullable: true }),
      column('cyc_b', 'id'), column('cyc_b', 'a_id', 'int', { nullable: true }),
    ],
    indexes: [
      index('parents', 'PRIMARY', ['id', 'seq']), index('parents', 'uq_code', ['code']),
      index('children', 'PRIMARY', ['id']), index('cyc_a', 'PRIMARY', ['id']), index('cyc_b', 'PRIMARY', ['id']),
    ],
    foreignKeys: [
      ...fk('children', 'fk_composite', ['parent_id', 'parent_seq'], 'parents', ['id', 'seq']),
      ...fk('children', 'fk_self', ['self_parent'], 'children', ['id']),
      ...fk('cyc_a', 'fk_a_b', ['b_id'], 'cyc_b', ['id']),
      ...fk('cyc_b', 'fk_b_a', ['a_id'], 'cyc_a', ['id']),
    ].map(part => ({ ...part, schema, refSchema: schema })),
  });
}

function spec() {
  const value = createDefaultRefreshSpec({
    source: { connectionId: 'source', sessionId: 'source-session' }, schema: 'source', cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  value.target = { connectionId: 'target', sessionId: 'target-session' };
  value.schemaMappings = [{ source: 'source', target: 'target' }];
  value.masks = [];
  value.tables = [
    { table: 'parents', policy: 'full' },
    { table: 'children', policy: 'time_window', column: 'created_on', mode: 'calendar_days', amount: 1, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
    { table: 'cyc_a', policy: 'full' },
  ];
  return value;
}

test('graph preserves composite nullable parts, self references and cycles deterministically', () => {
  const first = buildRefreshGraph([relationalSnapshot('source')]);
  const second = buildRefreshGraph([relationalSnapshot('source')]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.blockers, []);
  assert.equal(first.foreignKeys.length, 4);
  const composite = first.foreignKeys.find(edge => edge.name === 'fk_composite')!;
  assert.deepEqual(composite.parts.map(part => [part.column, part.refColumn, part.nullable]), [
    ['parent_id', 'id', true], ['parent_seq', 'seq', false],
  ]);
  assert.equal(composite.nullable, true);
  assert.equal(first.foreignKeys.find(edge => edge.name === 'fk_self')!.selfReference, true);
  assert.deepEqual(first.cycles, [['source.children'], ['source.cyc_a', 'source.cyc_b']]);
});

test('complete source and target catalogs produce a DATE-aware plan with generated columns omitted later', () => {
  const target = relationalSnapshot('target');
  for (const item of target.columns) {
    if (item.dataType === 'int') item.columnType = 'int(11)';
  }
  const result = analyzeRefreshCatalog({ spec: spec(), source: [relationalSnapshot('source')], target: [target] });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.complete, true);
  assert.deepEqual(result.tables.map(item => item.action), ['time_window', 'full', 'dependency', 'full']);
  assert.ok(result.plan.tables[1].sourceSql!.includes("BETWEEN '2026-11-05' AND '2026-11-06'"));
  assert.ok(!result.plan.tables[1].sourceSql!.includes('CONVERT_TZ'));
  assert.deepEqual(result.tables.find(item => item.table === 'source.parents')!.generatedColumns, ['computed']);
  assert.equal(result.scanned.selfReferences, 1);
  assert.equal(result.scanned.cycles, 2);
});

test('missing keys on either side and nullable-only unique indexes are named blockers', () => {
  const source = relationalSnapshot('source');
  source.indexes = source.indexes.filter(item => item.table !== 'children');
  source.indexes.push(index('children', 'uq_nullable', ['parent_id'], { unique: true }));
  const target = relationalSnapshot('target');
  target.indexes = target.indexes.filter(item => item.table !== 'parents');
  const result = analyzeRefreshCatalog({ spec: spec(), source: [source], target: [target] });
  assert.ok(result.blockers.some(item => item.includes('source.children has no primary key')));
  assert.ok(result.blockers.some(item => item.includes('target.parents has no primary key')));
  assert.equal(result.complete, false);
});

test('generated expressions, target types, collations and foreign keys fail closed', () => {
  const target = relationalSnapshot('target');
  target.columns.find(item => item.table === 'parents' && item.name === 'computed')!.generationExpression = "concat(`code`,'?')";
  target.columns.find(item => item.table === 'parents' && item.name === 'code')!.columnType = 'varchar(19)';
  target.columns.find(item => item.table === 'parents' && item.name === 'code')!.charMaxLen = 19;
  target.columns.find(item => item.table === 'children' && item.name === 'parent_id')!.nullable = false;
  target.foreignKeys = target.foreignKeys.filter(item => item.name !== 'fk_self');
  const result = analyzeRefreshCatalog({ spec: spec(), source: [relationalSnapshot('source')], target: [target] });
  assert.ok(result.blockers.some(item => item.includes('generated expression/storage differs')));
  assert.ok(result.blockers.some(item => item.includes('type varchar(20) is incompatible')));
  assert.ok(result.blockers.some(item => item.includes('nullability differs')));
  assert.ok(result.blockers.some(item => item.includes('missing foreign key equivalent to source.children.fk_self')));
  const incomplete = relationalSnapshot('target');
  incomplete.columns.find(item => item.table === 'parents' && item.name === 'computed')!.generationExpression = null;
  const unknown = analyzeRefreshCatalog({ spec: spec(), source: [relationalSnapshot('source')], target: [incomplete] });
  assert.ok(unknown.blockers.some(item => item.includes('generated expression metadata is incomplete')));
});

test('sample and row-limit policies require existing columns and a proven unique tie-breaker', () => {
  const value = spec();
  value.tables = [
    { table: 'children', policy: 'sample', rows: 10, sampleSeed: 1, tieBreaker: ['parent_id'] },
    { table: 'parents', policy: 'row_limit', rows: 10, orderBy: ['id'], direction: 'desc', tieBreaker: ['id'] },
  ];
  const result = analyzeRefreshCatalog({ spec: value, source: [relationalSnapshot('source')], target: [relationalSnapshot('target')] });
  assert.ok(result.blockers.some(item => item.includes('tie-breaker (parent_id) is not a complete unique')));
  assert.ok(result.blockers.some(item => item.includes('duplicates a column between orderBy and tieBreaker')));
});

test('unsupported temporal columns never fall back to DATETIME semantics', () => {
  const value = spec();
  value.tables = [{ table: 'parents', policy: 'time_window', column: 'code', mode: 'rolling', amount: 1, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' }];
  const result = analyzeRefreshCatalog({ spec: value, source: [relationalSnapshot('source')], target: [relationalSnapshot('target')] });
  assert.ok(result.blockers.some(item => item.includes('expected DATE, DATETIME or TIMESTAMP')));
  assert.ok(result.plan.tables[0].sourceSql!.includes('CONVERT_TZ'), 'blocked preview remains explicitly provisional');
});

test('an excluded parent required by a selected child is refused before row planning', () => {
  const value = spec();
  value.tables = [{ table: 'children', policy: 'full' }, { table: 'parents', policy: 'exclude' }];
  const result = analyzeRefreshCatalog({ spec: value, source: [relationalSnapshot('source')], target: [relationalSnapshot('target')] });
  assert.ok(result.blockers.some(item => item.includes('source.parents is required by source.children but is excluded')));
});

function catalogGrid(sql: string, schema: string): Grid {
  if (sql.includes('information_schema.SCHEMATA')) return {
    columns: ['server_charset', 'server_collation', 'server_version', 'schema_charset', 'schema_collation'],
    rows: [['utf8mb4', 'utf8mb4_0900_ai_ci', '8.4.0', 'utf8mb4', 'utf8mb4_0900_ai_ci']],
  };
  if (sql.includes('mysql.innodb_table_stats')) return {
    columns: ['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'], rows: [['items', 0, 0, 0, null]],
  };
  if (sql.includes('information_schema.TABLES')) return {
    columns: ['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT'],
    rows: [['items', 'InnoDB', 'utf8mb4_0900_ai_ci', null, '']],
  };
  if (sql.includes('information_schema.COLUMNS')) return {
    columns: ['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'CHARACTER_MAXIMUM_LENGTH', 'GENERATION_EXPRESSION', 'COLUMN_COMMENT'],
    rows: [['items', 'id', 'int', 'int', 'NO', null, '', null, null, null, null, '']],
  };
  if (sql.includes('information_schema.STATISTICS')) return {
    columns: ['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'],
    rows: [['items', 'PRIMARY', 0, 1, 'id', null, 0, 'BTREE']],
  };
  if (sql.includes('KEY_COLUMN_USAGE')) return {
    columns: ['CONSTRAINT_NAME', 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_SCHEMA', 'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME', 'ORDINAL_POSITION', 'DELETE_RULE', 'UPDATE_RULE'], rows: [],
  };
  throw new Error(`unexpected query for ${schema}: ${sql}`);
}

test('catalog collection reads only metadata and produces compatibility proof', async () => {
  const value = spec();
  value.tables = [{ table: 'items', policy: 'full' }];
  const queries: string[] = [];
  const result = await readRefreshCatalogAnalysis({
    spec: value,
    runGrid: async (sessionId, sql) => {
      queries.push(sql);
      return catalogGrid(sql, sessionId === 'source-session' ? 'source' : 'target');
    },
  });
  assert.equal(result.complete, true);
  assert.equal(queries.length, 12);
  assert.ok(queries.every(sql => /information_schema|innodb_table_stats/.test(sql)));
  assert.ok(queries.every(sql => !/SELECT \* FROM `?(?:source|target)`?\./.test(sql)));
});

test('denied, missing and truncated core catalogs cannot become proof', async () => {
  const value = spec();
  value.tables = [{ table: 'items', policy: 'full' }];
  await assert.rejects(() => readRefreshCatalogAnalysis({
    spec: value,
    runGrid: async (sessionId, sql) => sql.includes('information_schema.COLUMNS') ? null : catalogGrid(sql, sessionId),
  }), /columns catalog read failed or was denied/);
  await assert.rejects(() => readRefreshCatalogAnalysis({
    spec: value,
    runGrid: async (_sessionId, sql) => ({ ...catalogGrid(sql, 'source'), truncated: sql.includes('information_schema.STATISTICS') }),
  }), /indexes catalog was truncated/);
  await assert.rejects(() => readRefreshCatalogAnalysis({
    spec: value,
    runGrid: async (sessionId, sql) => {
      const grid = catalogGrid(sql, sessionId);
      return sessionId === 'target-session' && sql.includes('information_schema.SCHEMATA') ? { ...grid, rows: [] } : grid;
    },
  }), /target schema target does not exist or is not visible/);
});
