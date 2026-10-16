import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvColumnType, csvCreateTableSql } from '../src/utils/csvImportSql.ts';

test('inferred types pass through unchanged on the SQL-standard engines', () => {
  for (const engine of ['mysql', 'postgres', 'sqlite', 'sqlserver']) {
    assert.equal(csvColumnType(engine, 'BIGINT'), 'BIGINT');
    assert.equal(csvColumnType(engine, 'VARCHAR(255)'), 'VARCHAR(255)');
    assert.equal(csvColumnType(engine, 'TEXT'), 'TEXT');
  }
});

test('ClickHouse gets real storage types, not aliases it half-supports', () => {
  assert.equal(csvColumnType('clickhouse', 'BIGINT'), 'Int64');
  assert.equal(csvColumnType('clickhouse', 'DOUBLE PRECISION'), 'Float64');
  assert.equal(csvColumnType('clickhouse', 'TIMESTAMP'), 'DateTime');
  assert.equal(csvColumnType('clickhouse', 'DATE'), 'Date');
  assert.equal(csvColumnType('clickhouse', 'BOOLEAN'), 'Bool');
  assert.equal(csvColumnType('clickhouse', 'VARCHAR(255)'), 'String');
  assert.equal(csvColumnType('clickhouse', 'TEXT'), 'String');
});

test('CREATE TABLE is the plain form except on ClickHouse', () => {
  const cols = [{ ident: '"id"', type: 'BIGINT' }, { ident: '"name"', type: 'String' }];
  assert.equal(
    csvCreateTableSql('postgres', '"t"', cols),
    'CREATE TABLE "t" (\n  "id" BIGINT,\n  "name" String\n)',
  );
});

test('ClickHouse appends the ENGINE clause a bare CREATE TABLE lacks', () => {
  // `default_table_engine` is None out of the box — without ENGINE the DDL
  // fails with "Table engine is not specified". tuple() = no sorting key.
  const cols = [{ ident: '`id`', type: 'Int64' }, { ident: '`name`', type: 'String' }];
  assert.equal(
    csvCreateTableSql('clickhouse', '`t`', cols),
    'CREATE TABLE `t` (\n  `id` Int64,\n  `name` String\n)\nENGINE = MergeTree\nORDER BY tuple()',
  );
});
