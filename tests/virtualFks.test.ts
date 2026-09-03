/**
 * Virtual foreign keys (src/store/virtualFks.ts).
 *
 * These used to be global. A relation declared against staging was therefore
 * drawn on production's ER diagram, offered by production's JOIN completion,
 * and followed by production's data browser — asserting a relationship that
 * may not exist there. Two servers sharing table names is the normal case, so
 * the store was wrong exactly where it mattered most.
 *
 * The module reads localStorage as it loads, so every test imports it fresh
 * after installing its own storage. A cache-busting query keeps the imports
 * from sharing one module instance.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

let seq = 0;

/** A fresh module instance over a storage of our choosing. */
async function withStore(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const mod = await import(`../src/store/virtualFks.ts?case=${seq++}`);
  return { mod, store };
}

const REL = { fromTable: 's.orders', fromColumn: 'cust', toTable: 's.customers', toColumn: 'id' };

describe('scoping', () => {
  /// The bug, stated as a test: two connections, one relation, one owner.
  test('a relation declared on one connection is invisible on another', async () => {
    const { mod } = await withStore();
    mod.addVirtualFk('conn-staging', REL);
    assert.equal(mod.listVirtualFks('conn-staging').length, 1);
    assert.deepEqual(mod.listVirtualFks('conn-prod'), []);
    assert.deepEqual(mod.virtualFksFor('conn-prod', 's.orders'), []);
  });

  test('the same relation can exist independently on both', async () => {
    const { mod } = await withStore();
    mod.addVirtualFk('a', REL);
    mod.addVirtualFk('b', REL);
    assert.equal(mod.listVirtualFks('a').length, 1);
    assert.equal(mod.listVirtualFks('b').length, 1);
    assert.notEqual(mod.listVirtualFks('a')[0].id, mod.listVirtualFks('b')[0].id);
  });

  test('a lookup finds a table on either side of the relation', async () => {
    const { mod } = await withStore();
    mod.addVirtualFk('a', REL);
    assert.equal(mod.virtualFksFor('a', 's.orders').length, 1);
    assert.equal(mod.virtualFksFor('a', 'S.CUSTOMERS').length, 1, 'case should not matter');
    assert.equal(mod.virtualFksFor('a', 's.unrelated').length, 0);
  });

  test('the same relation is not stored twice on one connection', async () => {
    const { mod } = await withStore();
    mod.addVirtualFk('a', REL);
    mod.addVirtualFk('a', { ...REL, fromTable: 'S.Orders' });
    assert.equal(mod.listVirtualFks('a').length, 1);
  });

  test('removing on one connection leaves the other alone', async () => {
    const { mod } = await withStore();
    mod.addVirtualFk('a', REL);
    mod.addVirtualFk('b', REL);
    mod.removeVirtualFk('a', mod.listVirtualFks('a')[0].id);
    assert.equal(mod.listVirtualFks('a').length, 0);
    assert.equal(mod.listVirtualFks('b').length, 1);
  });

  /// An id from another connection must not reach across.
  test('removing with a foreign id does nothing', async () => {
    const { mod } = await withStore();
    mod.addVirtualFk('a', REL);
    mod.addVirtualFk('b', REL);
    mod.removeVirtualFk('a', mod.listVirtualFks('b')[0].id);
    assert.equal(mod.listVirtualFks('a').length, 1);
  });

  test('forgetting a connection drops only its relations', async () => {
    const { mod } = await withStore();
    mod.addVirtualFk('a', REL);
    mod.addVirtualFk('b', REL);
    mod.forgetConnection('a');
    assert.deepEqual(mod.listVirtualFks('a'), []);
    assert.equal(mod.listVirtualFks('b').length, 1);
  });

  test('an unknown connection reads as empty rather than throwing', async () => {
    const { mod } = await withStore();
    assert.deepEqual(mod.listVirtualFks('never-seen'), []);
  });
});

describe('the pre-scoping store', () => {
  const v1 = JSON.stringify([
    { id: 'old-1', ...REL },
    { id: 'old-2', fromTable: 's.a', fromColumn: 'b_id', toTable: 's.b', toColumn: 'id' },
  ]);

  /// Discarding a user's work silently is not acceptable; applying it to every
  /// server is the bug. So it is held aside, inert.
  test('old relations are kept but affect no connection', async () => {
    const { mod } = await withStore({ 'dbgui.virtualFks.v1': v1 });
    assert.equal(mod.listLegacyVirtualFks().length, 2);
    assert.deepEqual(mod.listVirtualFks('a'), []);
    assert.deepEqual(mod.virtualFksFor('a', 's.orders'), []);
  });

  test('adopting one attaches it to that connection and no other', async () => {
    const { mod } = await withStore({ 'dbgui.virtualFks.v1': v1 });
    mod.adoptLegacyVirtualFk('a', 'old-1');
    assert.equal(mod.listVirtualFks('a').length, 1);
    assert.deepEqual(mod.listVirtualFks('b'), []);
    assert.equal(mod.listLegacyVirtualFks().length, 1, 'it should not still be pending');
  });

  test('discarding one removes it without attaching it anywhere', async () => {
    const { mod } = await withStore({ 'dbgui.virtualFks.v1': v1 });
    mod.discardLegacyVirtualFk('old-1');
    assert.equal(mod.listLegacyVirtualFks().length, 1);
    assert.deepEqual(mod.listVirtualFks('a'), []);
  });

  /// Once the list empties the key goes, so the migration prompt does not
  /// reappear forever on an empty array.
  test('the old key is deleted once nothing is left in it', async () => {
    const { mod, store } = await withStore({ 'dbgui.virtualFks.v1': v1 });
    mod.discardLegacyVirtualFk('old-1');
    mod.adoptLegacyVirtualFk('a', 'old-2');
    assert.equal(mod.listLegacyVirtualFks().length, 0);
    assert.equal(store.has('dbgui.virtualFks.v1'), false);
  });

  test('an unknown id is ignored by both actions', async () => {
    const { mod } = await withStore({ 'dbgui.virtualFks.v1': v1 });
    mod.adoptLegacyVirtualFk('a', 'nope');
    mod.discardLegacyVirtualFk('nope');
    assert.equal(mod.listLegacyVirtualFks().length, 2);
    assert.deepEqual(mod.listVirtualFks('a'), []);
  });
});

describe('damaged storage', () => {
  test('unparseable data reads as empty instead of throwing', async () => {
    const { mod } = await withStore({ 'dbgui.virtualFks.v2': '{oh no' });
    assert.deepEqual(mod.listVirtualFks('a'), []);
  });

  /// v1's array shape landing under the v2 key would make every lookup return
  /// nonsense; treating it as absent is the recoverable reading.
  test('a v1-shaped array under the v2 key is ignored', async () => {
    const { mod } = await withStore({ 'dbgui.virtualFks.v2': '[{"id":"x"}]' });
    assert.deepEqual(mod.listVirtualFks('a'), []);
    mod.addVirtualFk('a', REL);
    assert.equal(mod.listVirtualFks('a').length, 1);
  });

  test('what is written can be read back by a fresh load', async () => {
    const { mod, store } = await withStore();
    mod.addVirtualFk('a', REL);
    const raw = store.get('dbgui.virtualFks.v2')!;
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['a']);
  });
});
