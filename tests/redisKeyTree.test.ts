/**
 * The Redis key browser's namespace tree (src/utils/redisKeyTree.ts).
 *
 * The grouping rule must match the backend keyspace sweep
 * (db/redis.rs::list_prefixes): namespace = everything up to the FIRST of
 * `:`, `|` or `/`; keys with no separator are bare. These tests pin both that
 * rule and the display contract (largest namespace first, keys sorted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRedisKeyTree, autoExpandedPrefixes, AUTO_EXPAND_MAX,
} from '../src/utils/redisKeyTree.ts';

test('keys group by the first colon segment', () => {
  const tree = buildRedisKeyTree(['user:1', 'user:2', 'user:3', 'cache:page:home']);
  assert.equal(tree.bare.length, 0);
  assert.equal(tree.namespaces.length, 2);
  // Largest first: user: (3) before cache: (1).
  assert.deepEqual(tree.namespaces.map(n => n.name), ['user:', 'cache:']);
  assert.equal(tree.namespaces[0].count, 3);
  assert.deepEqual(tree.namespaces[0].keys, ['user:1', 'user:2', 'user:3']);
  assert.equal(tree.namespaces[0].children.length, 0);
});

test('nested namespaces become child nodes, and mid-level leaves stay put', () => {
  const tree = buildRedisKeyTree([
    'cache:page:home', 'cache:page:about', 'cache:session:abc', 'cache:hit',
  ]);
  const cache = tree.namespaces[0];
  assert.equal(cache.name, 'cache:');
  assert.equal(cache.count, 4);
  // "cache:hit" terminates at this level — a leaf, not swallowed by a child.
  assert.deepEqual(cache.keys, ['cache:hit']);
  assert.deepEqual(cache.children.map(n => n.name), ['page:', 'session:']);
  const page = cache.children[0];
  assert.equal(page.prefix, 'cache:page:');
  assert.equal(page.count, 2);
  assert.deepEqual(page.keys, ['cache:page:about', 'cache:page:home']);
});

test('pipe and slash are separators too, first one wins', () => {
  const tree = buildRedisKeyTree(['a|b', 'c/d/e', 'a|c:d']);
  const names = tree.namespaces.map(n => n.name);
  assert.ok(names.includes('a|'), names.join(','));
  assert.ok(names.includes('c/'), names.join(','));
  // "a|c:d" split at the pipe (position 1), not the colon — a| bucket of 2.
  const a = tree.namespaces.find(n => n.name === 'a|')!;
  assert.equal(a.count, 2);
});

test('keys without any separator are bare, sorted', () => {
  const tree = buildRedisKeyTree(['zebra', 'ns:k', 'apple']);
  assert.deepEqual(tree.bare, ['apple', 'zebra']);
  assert.deepEqual(tree.namespaces.map(n => n.name), ['ns:']);
});

test('a leading separator does not create an empty namespace', () => {
  // ":odd" has its first separator at index 0 — an empty segment would be a
  // rendering bug. It is a bare key with a weird name, not a namespace.
  const tree = buildRedisKeyTree([':odd', 'ok']);
  assert.equal(tree.namespaces.length, 0);
  assert.deepEqual(tree.bare, [':odd', 'ok']);
});

test('input order does not matter and the input array is untouched', () => {
  const input = ['b:2', 'a:1', 'b:1'];
  const tree = buildRedisKeyTree(input);
  assert.deepEqual(input, ['b:2', 'a:1', 'b:1']); // not mutated
  const b = tree.namespaces[0];
  assert.equal(b.name, 'b:'); // count 2 beats count 1
  assert.deepEqual(b.keys, ['b:1', 'b:2']);
});

test('auto-expand: a single namespace opens; small namespaces open; big ones stay closed', () => {
  const one = buildRedisKeyTree(['only:1', 'only:2']);
  assert.deepEqual([...autoExpandedPrefixes(one)], ['only:']);

  const many = buildRedisKeyTree([
    'big:' + Array.from({ length: AUTO_EXPAND_MAX + 1 }, (_, i) => i).join(':'),
    ...Array.from({ length: AUTO_EXPAND_MAX + 1 }, (_, i) => `huge:${i}`),
    'tiny:1',
  ]);
  const ex = autoExpandedPrefixes(many);
  assert.ok(ex.has('tiny:'), 'small namespace auto-expands');
  assert.ok(!ex.has('huge:'), 'a namespace above the cap stays closed');
});

test('counts add up', () => {
  const keys = ['a:1', 'a:2', 'a:x:1', 'b', 'c|d'];
  const tree = buildRedisKeyTree(keys);
  const total = tree.bare.length + tree.namespaces.reduce((n, ns) => n + ns.count, 0);
  assert.equal(total, keys.length);
  const a = tree.namespaces.find(n => n.name === 'a:')!;
  assert.equal(a.count, 3);
  assert.equal(a.keys.length + a.children.reduce((n, c) => n + c.count, 0), 3);
});
