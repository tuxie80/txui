import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareMigrationFinalModel, compareMigrationTargetModel } from '../src/utils/migrationVerification.ts';
import { reviewChanges } from '../src/utils/changeReview.ts';
import type { ChangeReviewResult, ReviewTable } from '../src/utils/changeReview.ts';
import type { SchemaSnapshot } from '../src/utils/schemaRules.ts';

function snapshot(): SchemaSnapshot {
  return {
    engine: 'mysql', schema: 'shop',
    serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null,
    tables: ['orders', 'parents', 'unrelated'].map(name => ({
      name, engine: 'InnoDB', collation: null, rows: 0, dataBytes: 0, indexBytes: 0, autoIncrement: null, comment: '',
    })),
    columns: [
      { table: 'orders', name: 'id', dataType: 'int', columnType: 'int', nullable: false, defaultValue: null, extra: '', charset: null, collation: null, charMaxLen: null, comment: '' },
      { table: 'orders', name: 'parent_id', dataType: 'int', columnType: 'int', nullable: true, defaultValue: null, extra: '', charset: null, collation: null, charMaxLen: null, comment: '' },
      { table: 'parents', name: 'id', dataType: 'int', columnType: 'int', nullable: false, defaultValue: null, extra: '', charset: null, collation: null, charMaxLen: null, comment: '' },
      { table: 'unrelated', name: 'id', dataType: 'int', columnType: 'int', nullable: false, defaultValue: null, extra: '', charset: null, collation: null, charMaxLen: null, comment: '' },
    ],
    indexes: ['orders', 'parents', 'unrelated'].map(table => ({
      table, name: 'PRIMARY', unique: true, type: 'BTREE', columns: [{ name: 'id', seq: 1, subPart: null, cardinality: null }],
    })),
    foreignKeys: [{
      name: 'fk_parent', table: 'orders', column: 'parent_id', refTable: 'parents', refColumn: 'id',
      ordinal: 1, onDelete: 'CASCADE', onUpdate: 'NO ACTION',
    }],
  };
}

function mysqlCase(): { snapshot: SchemaSnapshot; review: ChangeReviewResult; actualTables: ReviewTable[] } {
  const snap = snapshot();
  const review = reviewChanges({
    engine: 'mysql', catalog: snap,
    sql: 'ALTER TABLE orders ADD COLUMN note varchar(40) NULL; CREATE INDEX idx_note ON orders(note);',
  });
  return { snapshot: snap, review, actualTables: review.tables.filter(table => table.name !== 'unrelated') };
}

function compare(actualTables: ReviewTable[], catalogComplete = true) {
  const fixture = mysqlCase();
  return compareMigrationFinalModel({
    engine: 'mysql', snapshot: fixture.snapshot, review: fixture.review, actualTables, catalogComplete,
  });
}

function changed(mutate: (tables: ReviewTable[]) => void): ReviewTable[] {
  const tables = mysqlCase().actualTables;
  mutate(tables);
  return tables;
}

test('clean comparison covers only the affected/FK component, not unrelated source tables', () => {
  const result = compare(mysqlCase().actualTables);
  assert.deepEqual(result.expectedTables.map(table => table.name), ['orders', 'parents']);
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.unverified, []);
});

test('planted extra and missing indexes both block a clean comparison', () => {
  const missing = compare(changed(tables => {
    const orders = tables.find(table => table.name === 'orders')!;
    orders.indexes = orders.indexes.filter(index => index.name !== 'idx_note');
  }));
  assert.ok(missing.differences.some(line => line.includes('missing index idx_note')));
  const extra = compare(changed(tables => {
    tables.find(table => table.name === 'orders')!.indexes.push({ name: 'idx_planted', columns: ['id'], unique: false });
  }));
  assert.ok(extra.differences.some(line => line.includes('unexpected index idx_planted')));
});

test('planted wrong nullability and dropped foreign key block rehearsal evidence', () => {
  const nullable = compare(changed(tables => {
    const orders = tables.find(table => table.name === 'orders')!;
    orders.columns.find(column => column.name === 'note')!.nullable = false;
  }));
  assert.ok(nullable.differences.some(line => line.includes('note: nullability')));
  const droppedFk = compare(changed(tables => {
    tables.find(table => table.name === 'orders')!.foreignKeys = [];
  }));
  assert.ok(droppedFk.differences.some(line => line.includes('missing foreign key fk_parent')));
});

test('column, type, default and unexpected table drift are named', () => {
  const result = compare(changed(tables => {
    const orders = tables.find(table => table.name === 'orders')!;
    orders.columns.find(column => column.name === 'note')!.type = 'text';
    orders.columns.find(column => column.name === 'note')!.hasDefault = true;
    orders.columns.push({ name: 'planted', type: 'int', nullable: true, hasDefault: false });
    tables.push({ ...tables.find(table => table.name === 'parents')!, name: 'planted_table' });
  }));
  for (const expected of ['type varchar(40) became text', 'default presence expected false, actual true', 'unexpected column planted', 'unexpected table planted_table']) {
    assert.ok(result.differences.some(line => line.includes(expected)), expected);
  }
});

test('incomplete actual or expected evidence fails closed without invented differences', () => {
  const incomplete = compare(mysqlCase().actualTables, false);
  assert.deepEqual(incomplete.differences, []);
  assert.deepEqual(incomplete.unverified, ['scratch catalog could not be read completely']);
  const partial = compare(changed(tables => {
    tables.find(table => table.name === 'orders')!.complete = false;
  }));
  assert.ok(partial.unverified.some(line => line.includes('scratch table orders')));
  const fixture = mysqlCase();
  const actual = structuredClone(fixture.actualTables);
  fixture.review.tables.find(table => table.name === 'orders')!.complete = false;
  const expectedPartial = compareMigrationFinalModel({
    engine: 'mysql', snapshot: fixture.snapshot, review: fixture.review, actualTables: actual, catalogComplete: true,
  });
  assert.ok(expectedPartial.unverified.some(line => line.includes('expected table orders')));
});

test('server-generated constraint names and MySQL FK support indexes are explained', () => {
  const snap = snapshot();
  const review = reviewChanges({
    engine: 'mysql', catalog: snap,
    sql: 'CREATE TABLE generated(id int PRIMARY KEY, email varchar(40) UNIQUE, parent_id int, FOREIGN KEY(parent_id) REFERENCES parents(id));',
  });
  const actual = structuredClone(review.tables.filter(table => table.name !== 'unrelated'));
  const generated = actual.find(table => table.name === 'generated')!;
  generated.indexes.find(index => index.name === 'unique_email')!.name = 'email';
  generated.foreignKeys[0].name = 'generated_parent_id_fkey';
  generated.indexes.push({ name: 'generated_parent_id_fkey', columns: ['parent_id'], unique: false });
  const result = compareMigrationFinalModel({
    engine: 'mysql', snapshot: snap, review, actualTables: actual, catalogComplete: true,
  });
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.unverified, []);
  assert.ok(result.notes.some(line => line.includes('generated index email')));
  assert.ok(result.notes.some(line => line.includes('foreign-key support index')));
});

test('PostgreSQL serial defaults and type aliases compare by meaning', () => {
  const snap = snapshot();
  const review = reviewChanges({ engine: 'postgres', sql: 'CREATE TABLE serial_items(id serial PRIMARY KEY, note timestamp);' });
  const actual = structuredClone(review.tables);
  const table = actual.find(item => item.name === 'serial_items')!;
  table.columns.find(column => column.name === 'id')!.type = 'integer';
  table.columns.find(column => column.name === 'id')!.hasDefault = true;
  table.columns.find(column => column.name === 'note')!.type = 'timestamp without time zone';
  const result = compareMigrationFinalModel({
    engine: 'postgres', snapshot: snap, review, actualTables: actual, catalogComplete: true,
  });
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.unverified, []);
});

test('MySQL display widths and RESTRICT/NO ACTION are not false drift', () => {
  const snap = snapshot();
  const review = reviewChanges({
    engine: 'mysql',
    sql: 'CREATE TABLE parents(id INT PRIMARY KEY); CREATE TABLE children(id INT PRIMARY KEY, parent_id INT, CONSTRAINT fk_parent FOREIGN KEY(parent_id) REFERENCES parents(id));',
  });
  const actual = structuredClone(review.tables);
  for (const table of actual) {
    for (const column of table.columns) column.type = 'int(11)';
    for (const fk of table.foreignKeys) fk.onDelete = 'RESTRICT';
  }
  const result = compareMigrationFinalModel({
    engine: 'mysql', snapshot: snap, review, actualTables: actual, catalogComplete: true,
  });
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.unverified, []);
});

test('target comparison excludes unrelated tables but still checks every scoped object', () => {
  const fixture = mysqlCase();
  const unrelated: ReviewTable = {
    name: 'unrelated_target', complete: true, source: 'catalog', rows: null, bytes: null,
    columns: [{ name: 'id', type: 'bigint', nullable: false, hasDefault: false }],
    indexes: [{ name: 'idx_external', columns: ['id'], unique: false }], foreignKeys: [],
  };
  const actual = [...structuredClone(fixture.actualTables), unrelated];
  const result = compareMigrationTargetModel({
    engine: 'mysql', snapshot: fixture.snapshot, review: fixture.review, actualTables: actual, catalogComplete: true,
  });
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.unverified, []);
  assert.deepEqual(result.outOfScopeTables, ['unrelated_target']);
  assert.ok(result.notes.some(line => line.includes('Excluded 1 unrelated target')));
  assert.ok(!result.actualTables.some(table => table.name === 'unrelated_target'));

  actual.find(table => table.name === 'orders')!.indexes.push({ name: 'idx_drift', columns: ['id'], unique: false });
  const drift = compareMigrationTargetModel({
    engine: 'mysql', snapshot: fixture.snapshot, review: fixture.review, actualTables: actual, catalogComplete: true,
  });
  assert.ok(drift.differences.some(line => line.includes('unexpected index idx_drift')));
});

test('an externally added table linked into the affected FK component is not hidden as unrelated', () => {
  const fixture = mysqlCase();
  const linked: ReviewTable = {
    name: 'external_child', complete: true, source: 'catalog', rows: null, bytes: null,
    columns: [{ name: 'order_id', type: 'int', nullable: true, hasDefault: false }],
    indexes: [],
    foreignKeys: [{ name: 'fk_external', columns: ['order_id'], refTable: 'orders', refColumns: ['id'], onDelete: 'CASCADE' }],
  };
  const result = compareMigrationTargetModel({
    engine: 'mysql', snapshot: fixture.snapshot, review: fixture.review,
    actualTables: [...fixture.actualTables, linked], catalogComplete: true,
  });
  assert.ok(result.differences.includes('unexpected table external_child'));
  assert.deepEqual(result.outOfScopeTables, []);
});

test('incomplete target evidence blocks verification with target-specific wording', () => {
  const fixture = mysqlCase();
  const result = compareMigrationTargetModel({
    engine: 'mysql', snapshot: fixture.snapshot, review: fixture.review,
    actualTables: fixture.actualTables, catalogComplete: false,
  });
  assert.deepEqual(result.unverified, ['target catalog could not be read completely']);
  assert.deepEqual(result.differences, []);
});
