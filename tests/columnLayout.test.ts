import test from 'node:test';
import assert from 'node:assert/strict';
import {
  columnLayoutReducer, layoutColumns, loadColumnLayout, saveColumnLayout,
} from '../src/utils/columnLayout.ts';

const names = ['id', 'customer', 'status', 'total', 'created'];

test('pin, hide and move preserve a stable original-column mapping', () => {
  let layout = columnLayoutReducer(names, loadColumnLayout('mysql', names), { kind: 'pin', column: 'total' });
  layout = columnLayoutReducer(names, layout, { kind: 'pin', column: 'customer' });
  layout = columnLayoutReducer(names, layout, { kind: 'hide', column: 'status' });
  layout = columnLayoutReducer(names, layout, { kind: 'move', column: 'created', direction: -1 });
  assert.deepEqual(layoutColumns(names, layout), [
    { name: 'total', index: 3 },
    { name: 'customer', index: 1 },
    { name: 'id', index: 0 },
    { name: 'created', index: 4 },
  ]);
  assert.deepEqual(layoutColumns(names, columnLayoutReducer(names, layout, { kind: 'pin', column: 'total' })).map(c => c.name),
    ['customer', 'total', 'id', 'created']);
});

test('hiding never loses source indexes and reset restores every column', () => {
  let layout = columnLayoutReducer(names, loadColumnLayout('mysql', names), { kind: 'hide', column: 'customer' });
  layout = columnLayoutReducer(names, layout, { kind: 'move', column: 'total', direction: -1 });
  assert.deepEqual(layoutColumns(names, layout).map(c => c.name), ['id', 'total', 'status', 'created']);
  assert.deepEqual(layoutColumns(names, columnLayoutReducer(names, layout, { kind: 'reset' })).map(c => c.name), names);
});

test('layouts persist by engine and column shape and tolerate corrupt state', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  saveColumnLayout('mysql', names, { order: ['total', 'id'], pinned: ['total'], hidden: ['status'] }, storage);
  assert.deepEqual(loadColumnLayout('mysql', names, storage), {
    order: ['total', 'id', 'customer', 'status', 'created'], pinned: ['total'], hidden: ['status'],
  });
  values.set('dbgui.columnlayout.v1.mysql.' + names.join('|'), '{broken');
  assert.deepEqual(loadColumnLayout('mysql', names, storage).order, names);
});

test('moves are bounded and never duplicate a column', () => {
  let layout = loadColumnLayout('mysql', names);
  layout = columnLayoutReducer(names, layout, { kind: 'move', column: 'id', direction: -1 });
  assert.deepEqual(layout.order, names);
  layout = columnLayoutReducer(names, layout, { kind: 'move', column: 'created', direction: 1 });
  assert.deepEqual(layout.order, names);
  layout = columnLayoutReducer(names, layout, { kind: 'move', column: 'created', direction: -1 });
  assert.deepEqual(layout.order, ['id', 'customer', 'status', 'created', 'total']);
  assert.equal(new Set(layout.order).size, names.length);
});
