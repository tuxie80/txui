import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationCloneInput, foreignKeyColumns } from '../src/utils/migrationClone.ts';
import { reviewChanges } from '../src/utils/changeReview.ts';
import type { CatalogFk, SchemaSnapshot } from '../src/utils/schemaRules.ts';

const base: SchemaSnapshot = {
  engine: 'postgres', schema: 'public', serverCharset: null, serverCollation: null,
  schemaCharset: null, schemaCollation: null, tables: [
    { name: 'parents', engine: 'logged', collation: null, rows: null, dataBytes: null, indexBytes: null, autoIncrement: null, comment: '' },
    { name: 'children', engine: 'logged', collation: null, rows: null, dataBytes: null, indexBytes: null, autoIncrement: null, comment: '' },
  ],
  columns: [
    { table: 'parents', name: 'id', dataType: 'int', columnType: 'integer', nullable: false, defaultValue: null, extra: 'serial', charset: null, collation: null, charMaxLen: null, comment: '' },
    { table: 'children', name: 'parent_id', dataType: 'int', columnType: 'integer', nullable: false, defaultValue: null, extra: '', charset: null, collation: null, charMaxLen: null, comment: '' },
  ],
  indexes: [], foreignKeys: [],
};

test('affected objects and serial columns come from the live catalog, not final-model guesses', () => {
  const review = reviewChanges({ engine: 'postgres', sql: 'ALTER TABLE children ADD note text; CREATE TABLE brand_new(id int);' });
  const input = buildMigrationCloneInput(base, review);
  assert.deepEqual(input.affected, ['children']);
  assert.deepEqual(input.tables, [
    { name: 'parents', serial_columns: ['id'] },
    { name: 'children', serial_columns: [] },
  ]);
});

test('composite foreign keys stay ordered and retain PostgreSQL options', () => {
  const fk: CatalogFk = {
    name: 'fk_child_parent', table: 'children', column: 'parent_id', refTable: 'parents', refColumn: 'id',
    ordinal: 1, onDelete: 'CASCADE', onUpdate: 'SET NULL', validated: false,
    matchType: 'full', deferrable: true, deferred: true,
  };
  const snapshot = { ...base, foreignKeys: [fk] };
  const input = buildMigrationCloneInput(snapshot, reviewChanges({ engine: 'postgres', sql: 'ALTER TABLE children ADD note text;' }));
  assert.deepEqual(input.foreignKeys, [{
    name: 'fk_child_parent', table: 'children', columns: ['parent_id'], ref_table: 'parents', ref_columns: ['id'],
    on_delete: 'CASCADE', on_update: 'SET NULL', validated: false,
    match_type: 'full', deferrable: true, deferred: true,
  }]);
});

test('composite column pairing helper uses catalog ordinals', () => {
  const columns = foreignKeyColumns([
    { ...base.foreignKeys[0], name: 'fk', table: 'c', column: 'b', refTable: 'p', refColumn: 'y', ordinal: 2, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { ...base.foreignKeys[0], name: 'fk', table: 'c', column: 'a', refTable: 'p', refColumn: 'x', ordinal: 1, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  ]);
  assert.deepEqual(columns, { columns: ['a', 'b'], refColumns: ['x', 'y'] });
});
