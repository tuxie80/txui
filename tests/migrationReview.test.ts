import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewMigrationWithCatalog } from '../src/utils/migrationReview.ts';
import { reviewChanges } from '../src/utils/changeReview.ts';
import { MYSQL_SNAPSHOT_SQL, PG_SNAPSHOT_SQL } from '../src/utils/schemaCollect.ts';
import type { Grid } from '../src/utils/schemaCollect.ts';

const empty = (columns: string[]): Grid => ({ columns, rows: [] });

function mysqlGrids(): Map<string, Grid> {
  return new Map([
    [MYSQL_SNAPSHOT_SQL.defaults('shop'), empty(['server_charset', 'server_collation', 'schema_charset', 'schema_collation', 'server_version'])],
    [MYSQL_SNAPSHOT_SQL.tables('shop'), empty(['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT'])],
    [MYSQL_SNAPSHOT_SQL.columns('shop'), empty(['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'CHARACTER_MAXIMUM_LENGTH', 'COLUMN_COMMENT'])],
    [MYSQL_SNAPSHOT_SQL.indexes('shop'), empty(['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'])],
    [MYSQL_SNAPSHOT_SQL.foreignKeys('shop'), empty(['CONSTRAINT_NAME', 'TABLE_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME', 'ORDINAL_POSITION', 'DELETE_RULE', 'UPDATE_RULE'])],
    [MYSQL_SNAPSHOT_SQL.stats('shop'), empty(['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'])],
    [MYSQL_SNAPSHOT_SQL.statsFallback('shop'), empty(['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'])],
  ]);
}

function postgresGrids(): Map<string, Grid> {
  const grids = new Map<string, Grid>();
  for (const name of ['defaults', 'tables', 'columns', 'indexes', 'foreignKeys', 'stats', 'statsFallback', 'sequences'] as const) {
    grids.set(PG_SNAPSHOT_SQL[name]('public'), empty([]));
  }
  return grids;
}

test('complete MySQL catalog and direct Change Review are identical', async () => {
  const grids = mysqlGrids();
  const logs: string[] = [];
  const sql = 'ALTER TABLE orders ADD COLUMN note varchar(40);';
  const result = await reviewMigrationWithCatalog({
    sql, engine: 'mysql', mariaDb: false, schema: 'shop',
    runGrid: async query => grids.get(query) ?? null,
    onLog: message => logs.push(message),
  });
  assert.equal(result.catalogComplete, true);
  assert.deepEqual(result.review, reviewChanges({
    sql, engine: 'mysql', catalog: result.catalog!, mariaDb: false,
  }));
  assert.ok(logs.some(line => line.includes('Seeded 0 live tables')));
  assert.ok(logs.at(-1)?.includes('1/1 statements modeled'));
});

test('PostgreSQL loads its sequence read and uses the same review engine', async () => {
  const grids = postgresGrids();
  const queries: string[] = [];
  const sql = 'CREATE TABLE example(id bigint PRIMARY KEY);';
  const result = await reviewMigrationWithCatalog({
    sql, engine: 'postgres', mariaDb: false, schema: 'public',
    runGrid: async query => { queries.push(query); return grids.get(query) ?? null; },
    onLog: () => {},
  });
  assert.equal(result.catalogComplete, true);
  assert.ok(queries.includes(PG_SNAPSHOT_SQL.sequences('public')));
  assert.deepEqual(result.review, reviewChanges({ sql, engine: 'postgres', catalog: result.catalog! }));
});

test('any failed core catalog read produces migration-only, never live-verified', async () => {
  const grids = mysqlGrids();
  grids.delete(MYSQL_SNAPSHOT_SQL.indexes('shop'));
  const logs: string[] = [];
  const sql = 'ALTER TABLE orders ADD COLUMN note varchar(40);';
  const result = await reviewMigrationWithCatalog({
    sql, engine: 'mysql', mariaDb: true, schema: 'shop',
    runGrid: async query => grids.get(query) ?? null,
    onLog: message => logs.push(message),
  });
  assert.equal(result.catalog, null);
  assert.equal(result.catalogComplete, false);
  assert.deepEqual(result.review, reviewChanges({ sql, engine: 'mysql', mariaDb: true }));
  assert.ok(logs.some(line => line.includes('migration-only analysis, not a complete live before-state')));
});

test('no selected schema performs no catalog query and stays migration-only', async () => {
  let calls = 0;
  const sql = 'CREATE TABLE example(id int PRIMARY KEY);';
  const result = await reviewMigrationWithCatalog({
    sql, engine: 'mysql', mariaDb: false, schema: '  ',
    runGrid: async () => { calls++; return null; }, onLog: () => {},
  });
  assert.equal(calls, 0);
  assert.equal(result.catalogComplete, false);
  assert.deepEqual(result.review, reviewChanges({ sql, engine: 'mysql' }));
});

test('final-state collection applies no migration and labels its evidence honestly', async () => {
  const grids = mysqlGrids();
  const logs: string[] = [];
  const result = await reviewMigrationWithCatalog({
    sql: '', engine: 'mysql', mariaDb: false, schema: 'shop', purpose: 'final-state',
    runGrid: async query => grids.get(query) ?? null,
    onLog: message => logs.push(message),
  });
  assert.equal(result.catalogComplete, true);
  assert.deepEqual(result.review, reviewChanges({ sql: '', engine: 'mysql', catalog: result.catalog! }));
  assert.ok(logs.some(line => line.includes('final-state catalog')));
  assert.ok(logs.some(line => line.includes('final-object comparison')));
  assert.ok(!logs.some(line => line.includes('applying migration statements')));
});
