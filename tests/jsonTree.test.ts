/**
 * Representing a parsed JSON value as a tree with copyable paths
 * (src/utils/jsonTree.ts).
 *
 * The two things the cell viewer leans on: a node has the right type,
 * children and path; and `jsonPath` produces something you could paste after
 * `->` or into a `jsonb_path_query` — dotted for identifiers, bracketed for
 * indices and awkward keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree, jsonPath, jsonType, preview, isExpandable,
} from '../src/utils/jsonTree.ts';

test('jsonType classifies every JSON kind', () => {
  assert.equal(jsonType(null), 'null');
  assert.equal(jsonType(undefined), 'null');
  assert.equal(jsonType(true), 'bool');
  assert.equal(jsonType(3), 'number');
  assert.equal(jsonType('x'), 'string');
  assert.equal(jsonType([]), 'array');
  assert.equal(jsonType({}), 'object');
});

test('jsonPath: root, identifiers, indices, awkward keys', () => {
  assert.equal(jsonPath([]), '$');
  assert.equal(jsonPath(['user', 'name']), '$.user.name');
  assert.equal(jsonPath(['user', 'address', 0, 'city']), '$.user.address[0].city');
  assert.equal(jsonPath(['a', 0, 1]), '$.a[0][1]');
  // Non-identifier keys fall back to bracketed, JSON-escaped strings.
  assert.equal(jsonPath(['a.b']), '$["a.b"]');
  assert.equal(jsonPath(['odd key']), '$["odd key"]');
  assert.equal(jsonPath(['with"quote']), '$["with\\"quote"]');
  assert.equal(jsonPath(['1abc']), '$["1abc"]'); // starts with a digit
  assert.equal(jsonPath(['$ok', '_ok']), '$.$ok._ok');
});

test('buildTree: nested object carries keys, paths and types', () => {
  const root = buildTree({ user: { name: 'Ada', age: 36 } });
  assert.equal(root.key, null);
  assert.deepEqual(root.path, []);
  assert.equal(root.type, 'object');
  assert.equal(jsonPath(root.path), '$');
  assert.equal(root.children?.length, 1);

  const user = root.children![0];
  assert.equal(user.key, 'user');
  assert.deepEqual(user.path, ['user']);
  assert.equal(user.type, 'object');

  const name = user.children!.find(c => c.key === 'name')!;
  assert.equal(name.type, 'string');
  assert.deepEqual(name.path, ['user', 'name']);
  assert.equal(jsonPath(name.path), '$.user.name');
  assert.equal(name.preview, '"Ada"');
  assert.equal(name.children, undefined); // primitive: no children

  const age = user.children!.find(c => c.key === 'age')!;
  assert.equal(age.type, 'number');
  assert.equal(age.preview, '36');
});

test('buildTree: array children are indexed by number', () => {
  const root = buildTree({ tags: ['a', 'b'] });
  const tags = root.children![0];
  assert.equal(tags.type, 'array');
  assert.equal(tags.preview, '[2]');
  assert.equal(tags.children!.length, 2);

  const first = tags.children![0];
  assert.equal(first.key, 0);
  assert.deepEqual(first.path, ['tags', 0]);
  assert.equal(jsonPath(first.path), '$.tags[0]');
  assert.equal(first.preview, '"a"');
});

test('buildTree: primitives, null and empties', () => {
  const n = buildTree(null);
  assert.equal(n.type, 'null');
  assert.equal(n.preview, 'null');
  assert.equal(n.children, undefined);

  const num = buildTree(42);
  assert.equal(num.type, 'number');
  assert.equal(num.preview, '42');

  const emptyObj = buildTree({});
  assert.equal(emptyObj.type, 'object');
  assert.equal(emptyObj.preview, '{0}');
  assert.deepEqual(emptyObj.children, []);
  assert.equal(isExpandable(emptyObj), false);

  const emptyArr = buildTree([]);
  assert.equal(emptyArr.type, 'array');
  assert.equal(emptyArr.preview, '[0]');
  assert.deepEqual(emptyArr.children, []);
  assert.equal(isExpandable(emptyArr), false);

  const b = buildTree(false);
  assert.equal(b.type, 'bool');
  assert.equal(b.preview, 'false');
});

test('preview: long strings are clipped', () => {
  const long = 'x'.repeat(200);
  const p = preview(long, 80);
  assert.ok(p.length < 90);
  assert.ok(p.endsWith('…"'));
});

test('buildTree: maxDepth stops the walk', () => {
  const deep = { a: { b: { c: { d: 1 } } } };
  const root = buildTree(deep, { maxDepth: 2 });
  const a = root.children![0];          // depth 1
  const b = a.children![0];             // depth 2 — its children are not built
  assert.equal(b.type, 'object');
  assert.equal(b.children, undefined);
});

test('buildTree: maxChildren caps and flags truncation', () => {
  const root = buildTree([1, 2, 3, 4, 5], { maxChildren: 2 });
  assert.equal(root.children!.length, 2);
  assert.equal(root.truncated, true);

  const full = buildTree([1, 2], { maxChildren: 2 });
  assert.equal(full.truncated, undefined);
});

test('isExpandable: only non-empty containers', () => {
  assert.equal(isExpandable(buildTree({ a: 1 })), true);
  assert.equal(isExpandable(buildTree([1])), true);
  assert.equal(isExpandable(buildTree('x')), false);
  assert.equal(isExpandable(buildTree({})), false);
});
