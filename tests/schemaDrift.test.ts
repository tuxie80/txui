import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDrift, driftSummary, type ErSnapshot } from '../src/utils/schemaDrift.ts';

const col = (name: string, type = 'int', pk = false, unique = false) => ({ name, type, pk, fk: false, unique });

const snap: ErSnapshot = {
  takenAt: 0,
  tables: [
    { name: 'users', columns: [col('id', 'int', true), col('email', 'varchar')] },
    { name: 'orders', columns: [col('id', 'int', true), col('user_id')] },
  ],
  edges: [{ fromTable: 'orders', fromCol: 'user_id', toTable: 'users', toCol: 'id' }],
};

test('identical model is clean', () => {
  const d = computeDrift(snap, snap.tables, snap.edges);
  assert.ok(d.clean);
  assert.equal(driftSummary(d), 'No drift since snapshot');
});

test('added and removed tables', () => {
  const tables = [
    snap.tables[0],
    { name: 'products', columns: [col('id', 'int', true)] },
  ];
  const d = computeDrift(snap, tables, []);
  assert.deepEqual(d.addedTables, ['products']);
  assert.deepEqual(d.removedTables, ['orders']);
  assert.ok(!d.clean);
});

test('column add/remove/retype/PK change is detected', () => {
  const tables = [
    { name: 'users', columns: [
      col('id', 'bigint', true),   // retyped int→bigint
      col('name'),                 // added
      // email removed
    ] },
    snap.tables[1],
  ];
  const d = computeDrift(snap, tables, snap.edges);
  const u = d.changedTables.get('users')!;
  assert.deepEqual(u.addedColumns, ['name']);
  assert.deepEqual(u.removedColumns, ['email']);
  assert.equal(u.changedColumns.length, 1);
  assert.match(u.changedColumns[0].what, /int → bigint/);
});

test('edge add/remove', () => {
  const d = computeDrift(snap, snap.tables, []);   // dropped the FK
  assert.equal(d.removedEdges.length, 1);
  assert.equal(d.addedEdges.length, 0);
});

test('summary lists the deltas', () => {
  const tables = [snap.tables[0], { name: 'x', columns: [col('id')] }];
  const s = driftSummary(computeDrift(snap, tables, []));
  assert.match(s, /\+1 table/);
  assert.match(s, /−1 table/);
});
