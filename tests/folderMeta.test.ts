/**
 * Folder metadata (src/store/folderMeta.ts).
 *
 * Folder attributes used to live in localStorage only, so a restore brought
 * back the servers and lost the sidebar. These cover the pure logic that makes
 * the tree recoverable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renamePaths } from '../src/store/folderMeta.ts';

test('renaming a folder moves its whole subtree', () => {
  const store = {
    'prod': { note: 'live' },
    'prod/eu': { color: '#123' },
    'prod/eu/warehouse': { replicaSet: true },
    'dev': { note: 'scratch' },
  };
  const out = renamePaths(store, 'prod', 'production');
  assert.deepEqual(Object.keys(out).sort(), [
    'dev', 'production', 'production/eu', 'production/eu/warehouse',
  ]);
  assert.equal(out['production'].note, 'live');
  assert.equal(out['production/eu'].color, '#123');
  assert.equal(out['production/eu/warehouse'].replicaSet, true);
  // An unrelated folder is untouched.
  assert.equal(out['dev'].note, 'scratch');
});

test('a sibling with a shared prefix is not swept up', () => {
  // The bug a naive startsWith() produces: renaming "prod" also renames
  // "production", silently merging two different folders.
  const store = { 'prod': { note: 'a' }, 'production': { note: 'b' } };
  const out = renamePaths(store, 'prod', 'staging');
  assert.equal(out['staging'].note, 'a');
  assert.equal(out['production'].note, 'b');
  assert.ok(!('prod' in out));
});

test('renaming a folder that has no metadata is a no-op', () => {
  const store = { 'dev': { note: 'x' } };
  assert.deepEqual(renamePaths(store, 'nope', 'other'), store);
});

test('renaming into an existing path keeps the moved folder', () => {
  // Last write wins, and the moved subtree is the one the user just acted on.
  const store = { 'a': { note: 'from' }, 'b': { note: 'to' } };
  assert.equal(renamePaths(store, 'a', 'b')['b'].note, 'from');
});
