/**
 * TTL / type / encoding classification for the Redis key audit
 * (src/utils/redisAudit.ts).
 *
 * These rules are what the Audit tab renders; they pin the thresholds to
 * Redis' own defaults (listpack 128 entries, embstr 44 bytes) so a bumped
 * constant is a deliberate, reviewed change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditRedisKey, auditRedisKeys, summarizeFindings,
  BIG_STRING_BYTES, BIG_COLLECTION_ITEMS, COMPACT_ENCODING_MAX,
  type RedisKeyAuditRow,
} from '../src/utils/redisAudit.ts';

function row(partial: Partial<RedisKeyAuditRow>): RedisKeyAuditRow {
  return { key: 'k', key_type: 'string', ttl: 300, encoding: null, size: 10, ...partial };
}

test('a healthy key produces no findings', () => {
  assert.deepEqual(auditRedisKey(row({})), []);
  assert.deepEqual(auditRedisKey(row({ key_type: 'hash', encoding: 'listpack', size: 40 })), []);
});

test('persistent keys are the headline finding', () => {
  const f = auditRedisKey(row({ ttl: -1 }));
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'no-ttl');
  assert.equal(f[0].severity, 'warn');
});

test('a key that expired between scan and audit is explained, not misreported', () => {
  const f = auditRedisKey(row({ ttl: -2 }));
  assert.deepEqual(f.map(x => x.kind), ['expired']);
  // …and nothing else — a gone key must not also report "no ttl".
  assert.equal(f.length, 1);
});

test('big strings trip exactly above the byte threshold', () => {
  assert.deepEqual(auditRedisKey(row({ size: BIG_STRING_BYTES })), []);
  const f = auditRedisKey(row({ size: BIG_STRING_BYTES + 1 }));
  assert.deepEqual(f.map(x => x.kind), ['big-string']);
  // A big COLLECTION of the same size is a different finding.
  const g = auditRedisKey(row({ key_type: 'list', size: BIG_STRING_BYTES + 1 }));
  assert.ok(!g.some(x => x.kind === 'big-string'));
});

test('big collections trip exactly above the item threshold', () => {
  assert.deepEqual(auditRedisKey(row({ key_type: 'zset', size: BIG_COLLECTION_ITEMS })), []);
  const f = auditRedisKey(row({ key_type: 'zset', size: BIG_COLLECTION_ITEMS + 1 }));
  assert.deepEqual(f.map(x => x.kind), ['big-collection']);
});

test('a small collection on a non-compact encoding is flagged', () => {
  const f = auditRedisKey(row({ key_type: 'hash', encoding: 'hashtable', size: 5 }));
  assert.deepEqual(f.map(x => x.kind), ['non-compact-encoding']);
  assert.equal(f[0].severity, 'info');
  // The compact encodings are fine.
  assert.deepEqual(auditRedisKey(row({ key_type: 'hash', encoding: 'listpack', size: 5 })), []);
  assert.deepEqual(auditRedisKey(row({ key_type: 'set', encoding: 'intset', size: 5 })), []);
  assert.deepEqual(auditRedisKey(row({ key_type: 'zset', encoding: 'skiplist', size: 5 }))
    .map(x => x.kind), ['non-compact-encoding']);
});

test('past the compact threshold the non-compact encoding is the right one', () => {
  assert.deepEqual(
    auditRedisKey(row({ key_type: 'hash', encoding: 'hashtable', size: COMPACT_ENCODING_MAX + 1 })),
    []);
  // At exactly the threshold the compact encoding is still expected.
  assert.deepEqual(
    auditRedisKey(row({ key_type: 'hash', encoding: 'hashtable', size: COMPACT_ENCODING_MAX }))
      .map(x => x.kind),
    ['non-compact-encoding']);
});

test('a short string stored as raw is a minor note; lists have no compact alternative', () => {
  const f = auditRedisKey(row({ key_type: 'string', encoding: 'raw', size: 12 }));
  assert.deepEqual(f.map(x => x.kind), ['non-compact-encoding']);
  assert.deepEqual(auditRedisKey(row({ key_type: 'string', encoding: 'embstr', size: 12 })), []);
  // quicklist is the only modern list encoding — never a finding.
  assert.deepEqual(auditRedisKey(row({ key_type: 'list', encoding: 'quicklist', size: 3 })), []);
});

test('no encoding means no encoding finding (old servers, modules)', () => {
  assert.deepEqual(auditRedisKey(row({ key_type: 'hash', encoding: null, size: 5 })), []);
});

test('batch audit sorts warnings before info, then by key', () => {
  const findings = auditRedisKeys([
    row({ key: 'z:info', key_type: 'hash', encoding: 'hashtable', size: 3 }),
    row({ key: 'b:warn', ttl: -1 }),
    row({ key: 'a:warn', ttl: -1 }),
  ]);
  assert.deepEqual(findings.map(f => f.key), ['a:warn', 'b:warn', 'z:info']);
});

test('summarizeFindings counts per kind', () => {
  const s = summarizeFindings([
    { key: 'a', kind: 'no-ttl', severity: 'warn', message: '' },
    { key: 'b', kind: 'no-ttl', severity: 'warn', message: '' },
    { key: 'c', kind: 'big-string', severity: 'warn', message: '' },
  ]);
  assert.equal(s['no-ttl'], 2);
  assert.equal(s['big-string'], 1);
  assert.equal(s['expired'], undefined);
});
