/**
 * Object-explorer refresh merge (src/utils/treeMerge.ts).
 *
 * The bug this prevents: right-click → Refresh on a database rebuilt its
 * subtree, and rebuilt nodes are born collapsed — so the whole tree you had
 * open snapped shut. Refreshing a list must replace the list, not the view.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preserveExpansion, openDescendantIds } from '../src/utils/treeMerge.ts';

interface N { id: string; expanded: boolean; children: N[] | null; label?: string }
const n = (id: string, expanded = false, children: N[] | null = null, label?: string): N =>
  ({ id, expanded, children, label });

test('an expanded node stays expanded across a refresh', () => {
  const prev = [n('db::t::orders', true, [n('col::id')])];
  const next = [n('db::t::orders', false, [n('col::id'), n('col::total')])];
  const [merged] = preserveExpansion(prev, next);
  assert.equal(merged.expanded, true);
  // …and shows the FRESH children, not the old ones.
  assert.deepEqual(merged.children?.map(c => c.id), ['col::id', 'col::total']);
});

test('expansion is preserved several levels down', () => {
  const prev = [n('db', true, [n('grp::Tables', true, [n('t::orders', true, [n('c::id')])])])];
  const next = [n('db', false, [n('grp::Tables', false, [n('t::orders', false, null)])])];
  const [db] = preserveExpansion(prev, next);
  assert.equal(db.expanded, true);
  const grp = db.children![0];
  assert.equal(grp.expanded, true, 'group stays open');
  const tbl = grp.children![0];
  assert.equal(tbl.expanded, true, 'table stays open');
  // The table's columns were not re-fetched (children === null in `next`), so
  // the ones already on screen are kept rather than blinking out.
  assert.deepEqual(tbl.children?.map(c => c.id), ['c::id']);
});

test('objects created since the last load arrive collapsed', () => {
  const prev = [n('t::orders', true, [n('c::id')])];
  const next = [n('t::orders', false, [n('c::id')]), n('t::invoices', false, [n('c::x')])];
  const merged = preserveExpansion(prev, next);
  assert.equal(merged.find(x => x.id === 't::orders')!.expanded, true);
  assert.equal(merged.find(x => x.id === 't::invoices')!.expanded, false);
});

test('objects dropped on the server disappear', () => {
  const prev = [n('t::orders', true, [n('c::id')]), n('t::gone', true, [n('c::y')])];
  const next = [n('t::orders', false, [n('c::id')])];
  const merged = preserveExpansion(prev, next);
  assert.deepEqual(merged.map(x => x.id), ['t::orders']);
});

test('known-empty stays open; unknown collapses', () => {
  // Emptied on the server: the level WAS loaded and the answer is "nothing".
  // That is worth showing as an open, empty node — same as a first load, which
  // expands regardless of how many children came back.
  const emptied = preserveExpansion([n('t::orders', true, [n('c::id')])],
                                    [n('t::orders', false, [])]);
  assert.equal(emptied[0].expanded, true);
  assert.deepEqual(emptied[0].children, []);

  // Nothing known either way — no children in the refresh AND none before.
  // There is nothing to render under an open chevron, so it closes.
  const unknown = preserveExpansion([n('t::orders', true, null)],
                                    [n('t::orders', false, null)]);
  assert.equal(unknown[0].expanded, false);
});

test('the first load (no previous tree) is untouched', () => {
  const next = [n('a'), n('b')];
  assert.equal(preserveExpansion(null, next), next);
  assert.equal(preserveExpansion([], next), next);
});

test('openDescendantIds finds the loaded, open nodes below a root', () => {
  const flat = [
    { id: 'db',      parent: null,  expanded: true,  children: [] as unknown[] },
    { id: 'grp',     parent: 'db',  expanded: true,  children: [] as unknown[] },
    { id: 'orders',  parent: 'grp', expanded: true,  children: [] as unknown[] },
    { id: 'closed',  parent: 'grp', expanded: false, children: [] as unknown[] },
    { id: 'unread',  parent: 'grp', expanded: true,  children: null },
    { id: 'other',   parent: null,  expanded: true,  children: [] as unknown[] },
  ];
  const ids = openDescendantIds(flat, 'db');
  // 'grp' and 'orders' are open with loaded children; 'closed' is shut,
  // 'unread' never loaded any, 'other' is not under 'db', and the root itself
  // is excluded because the caller just refreshed it.
  assert.deepEqual(ids.sort(), ['grp', 'orders']);
});

test('openDescendantIds does not confuse a name that prefixes another', () => {
  // Ids are path-like, so a naive startsWith() would call `db2` a child of `db`.
  const flat = [
    { id: 'db',  parent: null, expanded: true, children: [] as unknown[] },
    { id: 'db2', parent: null, expanded: true, children: [] as unknown[] },
  ];
  assert.deepEqual(openDescendantIds(flat, 'db'), []);
});

test('a cycle in the parent chain cannot hang the walk', () => {
  const flat = [
    { id: 'a', parent: 'b', expanded: true, children: [] as unknown[] },
    { id: 'b', parent: 'a', expanded: true, children: [] as unknown[] },
  ];
  assert.deepEqual(openDescendantIds(flat, 'root'), []);
});
