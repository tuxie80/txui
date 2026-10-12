/**
 * tests for src/utils/galeraDiscover.ts — host:port normalization across the
 * spellings wsrep and users each produce, the unsaved-member matching against
 * saved connections, display-name shaping, the id-preserving ad-hoc config
 * clone, and the dismiss-count banner predicate.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitHostPort, normalizeHostPort, findUnsavedMembers, memberDisplayName,
  buildAdhocConfig, shouldShowDiscoverBanner, DEFAULT_MYSQL_PORT,
} from '../src/utils/galeraDiscover.ts';
import type { ConnectionConfig } from '../src/types/index.ts';

function conn(over: Partial<ConnectionConfig> & { id: string }): ConnectionConfig {
  return {
    name: over.id,
    engine: 'mysql',
    host: null,
    port: null,
    user: null,
    database: null,
    ssl_mode: 'preferred',
    group: null,
    color: null,
    environment: null,
    read_only: false,
    autocommit: true,
    ...over,
  } as ConnectionConfig;
}

describe('splitHostPort', () => {
  test('host:port, bare host, brackets and AUTO', () => {
    assert.deepEqual(splitHostPort('127.0.0.1:3342'), { host: '127.0.0.1', port: 3342 });
    assert.deepEqual(splitHostPort('db-node-2'), { host: 'db-node-2', port: DEFAULT_MYSQL_PORT });
    assert.deepEqual(splitHostPort('[::1]:3342'), { host: '::1', port: 3342 });
    assert.deepEqual(splitHostPort('[fe80::1]'), { host: 'fe80::1', port: DEFAULT_MYSQL_PORT });
    assert.deepEqual(splitHostPort('::1'), { host: '::1', port: DEFAULT_MYSQL_PORT });
    assert.equal(splitHostPort('AUTO'), null);
    assert.equal(splitHostPort('auto'), null);
    assert.equal(splitHostPort(''), null);
    assert.equal(splitHostPort('   '), null);
    assert.equal(splitHostPort(':3306'), null);
    assert.equal(splitHostPort('db:notaport'), null);
    assert.equal(splitHostPort('db:0'), null);
    assert.equal(splitHostPort('db:99999'), null);
  });

  test('host is lowercased and trimmed', () => {
    assert.deepEqual(splitHostPort('  DB-Node.Example.COM:3307 '), { host: 'db-node.example.com', port: 3307 });
  });
});

describe('normalizeHostPort', () => {
  test('loopback spellings fold to one token', () => {
    const a = normalizeHostPort('localhost', 3341);
    assert.equal(a, '127.0.0.1:3341');
    assert.equal(normalizeHostPort('127.0.0.1', 3341), a);
    assert.equal(normalizeHostPort('::1', 3341), a);
    assert.equal(normalizeHostPort('[::1]', 3341), a);
    assert.equal(normalizeHostPort('LOCALHOST', 3341), a);
  });

  test('missing port fills the MySQL default; case and brackets fold', () => {
    assert.equal(normalizeHostPort('db', null), 'db:3306');
    assert.equal(normalizeHostPort('DB', 3306), 'db:3306');
    assert.equal(normalizeHostPort('[fe80::1]', 3306), 'fe80::1:3306');
    assert.notEqual(normalizeHostPort('db', 3307), 'db:3306');
  });
});

describe('findUnsavedMembers', () => {
  const saved = [
    conn({ id: 'self', host: 'localhost', port: 3341 }),
    conn({ id: 'node2', host: '127.0.0.1', port: 3342 }),
    conn({ id: 'pg', engine: 'postgres', host: '10.0.0.9', port: 5432 }),
  ];

  test('members covered by any saved mysql connection drop out', () => {
    const unsaved = findUnsavedMembers(
      ['127.0.0.1:3341', '127.0.0.1:3342', '127.0.0.1:3343'], saved, 'self');
    assert.deepEqual(unsaved, [{ host: '127.0.0.1', port: 3343 }]);
  });

  test('the localhost/127.0.0.1 spelling gap does not create phantom members', () => {
    // wsrep says 127.0.0.1, the user saved localhost — the SAME server.
    const unsaved = findUnsavedMembers(['127.0.0.1:3341'], saved, 'self');
    assert.deepEqual(unsaved, []);
  });

  test('self is excluded even when absent from the saved list', () => {
    const unsaved = findUnsavedMembers(
      ['127.0.0.1:3341', '127.0.0.1:3343'],
      [conn({ id: 'self', host: '127.0.0.1', port: 3341 })],
      'self');
    assert.deepEqual(unsaved, [{ host: '127.0.0.1', port: 3343 }]);
  });

  test('a postgres connection at the same address does not cover a mysql member', () => {
    const unsaved = findUnsavedMembers(['10.0.0.9:5432'], saved, 'self');
    assert.deepEqual(unsaved, [{ host: '10.0.0.9', port: 5432 }]);
  });

  test('AUTO, blanks and duplicates collapse away; port-less gets 3306', () => {
    const unsaved = findUnsavedMembers(
      ['AUTO', '', '  ', 'db3:3343', 'DB3:3343', 'db4'], saved, 'self');
    assert.deepEqual(unsaved, [
      { host: 'db3', port: 3343 },
      { host: 'db4', port: 3306 },
    ]);
  });

  test('everything covered → empty; nothing saved → all (minus self)', () => {
    assert.deepEqual(findUnsavedMembers(['127.0.0.1:3342'], saved, 'self'), []);
    assert.deepEqual(
      findUnsavedMembers(['a:1', 'b:2'], [], 'nothing'),
      [{ host: 'a', port: 1 }, { host: 'b', port: 2 }]);
  });
});

describe('memberDisplayName', () => {
  test('cluster name prefixed when known, bare address otherwise', () => {
    assert.equal(memberDisplayName('db', '127.0.0.1', 3342), 'db @ 127.0.0.1:3342');
    assert.equal(memberDisplayName(null, '127.0.0.1', 3342), '127.0.0.1:3342');
    assert.equal(memberDisplayName('  ', 'db3', 3306), 'db3:3306');
  });

  test('an over-long cluster name is truncated, the address never is', () => {
    const name = memberDisplayName('europe-west-production-galera-cluster', '10.0.0.9', 3306);
    assert.ok(name.length <= 31, `got ${name.length}: ${name}`);
    assert.ok(name.endsWith('@ 10.0.0.9:3306') || name.endsWith('… @ 10.0.0.9:3306'), name);
  });
});

describe('buildAdhocConfig', () => {
  test('keeps the seed id (secret resolution depends on it), swaps host/port and name', () => {
    const seed = conn({ id: 'seed-id', host: 'localhost', port: 3341, user: 'root', group: 'db' });
    const adhoc = buildAdhocConfig(seed, '127.0.0.1', 3342, 'db');
    assert.equal(adhoc.id, 'seed-id', 'the id is how the backend finds the seed password');
    assert.equal(adhoc.host, '127.0.0.1');
    assert.equal(adhoc.port, 3342);
    assert.equal(adhoc.name, 'db @ 127.0.0.1:3342');
    assert.equal(adhoc.user, 'root', 'everything else is the seed, cloned');
    assert.equal(adhoc.group, 'db');
    assert.notEqual(adhoc, seed);
    // The seed is not mutated.
    assert.equal(seed.host, 'localhost');
    assert.equal(seed.port, 3341);
  });
});

describe('shouldShowDiscoverBanner', () => {
  test('hidden when nothing unsaved, shown when never dismissed', () => {
    assert.equal(shouldShowDiscoverBanner(0, null), false);
    assert.equal(shouldShowDiscoverBanner(2, null), true);
  });

  test('dismissed at N stays hidden at ≤ N and reappears above N', () => {
    assert.equal(shouldShowDiscoverBanner(2, 2), false);
    assert.equal(shouldShowDiscoverBanner(1, 2), false);
    assert.equal(shouldShowDiscoverBanner(3, 2), true, 'the cluster grew — new information');
  });
});
