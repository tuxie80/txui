/**
 * redisWrite.ts — classification semantics plus a TS↔Rust drift guard, the
 * same pattern as tests/sqlGuardDrift.test.ts.
 *
 * The module mirrors redisguard.rs's BASELINE tables (the offline vocabulary
 * — not the server-fetched `ACL CAT` catalog, which the preflight cannot have
 * seen yet). The drift tests extract the Rust constants from source and
 * compare them with the TS lists as sorted sets: a command added to one side
 * only means the multi-exec preflight and the backend judge it differently.
 *
 * Extraction is a tolerant regex over the array literal; keep the Rust
 * declarations in their current shape (`const NAME: &[&str] = &[ "word", … ];`
 * with no double-quoted strings inside the arrays' comments) or the tests
 * fail loudly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isRedisWrite, redisLineClass,
  REDIS_WRITE_COMMANDS, REDIS_ADMIN_COMMANDS, REDIS_CONTAINERS,
  REDIS_SAFE_SUBCOMMANDS, REDIS_KNOWN_READ,
} from '../src/utils/redisWrite.ts';

// ── classification semantics ────────────────────────────────────────────────

test('destructive commands are writes — the hole sqlguard left open', () => {
  for (const line of ['SET k v', 'DEL k', 'FLUSHALL', 'FLUSHDB', 'EXPIRE k 1',
    'HSET h f v', 'LPUSH l v', 'UNLINK k', 'GETDEL k', 'RENAME a b',
    'ZADD z 1 m', 'XADD s * f v', 'SPOP s', 'EVAL "return 1" 0']) {
    assert.ok(isRedisWrite(line), `${line} must not pass the preflight as a read`);
  }
});

test('server-state changers classify as admin, which also mutates', () => {
  for (const line of ['CONFIG SET maxmemory 0', 'SHUTDOWN', 'REPLICAOF host 1',
    'CLIENT KILL ID 5', 'DEBUG SLEEP 1', 'MODULE LOAD /x.so', 'BGSAVE']) {
    assert.equal(redisLineClass(line), 'admin', line);
    assert.ok(isRedisWrite(line), `${line} must trip the preflight too`);
  }
});

test('reads stay reads — including the container reads the panels rely on', () => {
  for (const line of ['GET k', 'MGET a b', 'SCAN 0', 'HGETALL h', 'INFO',
    'CONFIG GET maxmemory', 'CLIENT LIST', 'SLOWLOG GET 10', 'ACL WHOAMI',
    'CLUSTER INFO', 'XINFO STREAM s', 'MEMORY USAGE k', 'KEYS *']) {
    assert.equal(redisLineClass(line), 'read', line);
    assert.ok(!isRedisWrite(line), line);
  }
});

test('containers are judged by subcommand, unknowns fail closed', () => {
  assert.equal(redisLineClass('CONFIG SET maxmemory 0'), 'admin');
  assert.equal(redisLineClass('CONFIG GET maxmemory'), 'read');
  assert.equal(redisLineClass('XGROUP CREATE s g $'), 'write');
  assert.equal(redisLineClass('XINFO STREAM s'), 'read');
  // A module command nobody hardcoded must not be waved through.
  assert.equal(redisLineClass('JSON.SET doc $ {}'), 'write');
  // An unrecognised subcommand of a known container is worse.
  assert.equal(redisLineClass('CONFIG SOMETHINGNEW x'), 'admin');
  // A bare container name is a usage error; harmless.
  assert.equal(redisLineClass('CONFIG'), 'read');
});

test('a write on a later line still pre-flights as a write', () => {
  assert.ok(isRedisWrite('GET k\nSET k v'));
  assert.ok(!isRedisWrite('GET k\n\nTTL k'));
  assert.ok(!isRedisWrite(''));
});

test('case and whitespace do not matter', () => {
  assert.ok(isRedisWrite('  FlUsHaLl  '));
  assert.ok(isRedisWrite('config   set   appendonly   no'));
});

// ── TS↔Rust drift guard ─────────────────────────────────────────────────────

const ROOT = new URL('..', import.meta.url).pathname;

function rustWords(constName: string): string[] {
  const src = readFileSync(join(ROOT, 'src-tauri/src/redisguard.rs'), 'utf8');
  const re = new RegExp(constName + String.raw`:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];`);
  const m = src.match(re);
  assert.ok(m, `${constName} literal not found in redisguard.rs`);
  return [...m[1].matchAll(/"([a-z0-9_|-]+)"/g)].map(g => g[1]);
}

/** Documented one-sided exceptions — empty today; add with a reason or the
 *  comparison below fails on the difference it was written to catch. */
const TS_ONLY: string[] = [];
const RUST_ONLY: string[] = [];

function assertSameVocabulary(ts: readonly string[], rust: string[], name: string) {
  const rs = new Set(rust);
  const tsSet = new Set(ts);
  assert.deepEqual(ts.filter(x => !rs.has(x) && !TS_ONLY.includes(x)), [],
    `${name}: TS-only entries (add to TS_ONLY with a reason, or sync Rust)`);
  assert.deepEqual(rust.filter(x => !tsSet.has(x) && !RUST_ONLY.includes(x)), [],
    `${name}: Rust-only entries (add to RUST_ONLY with a reason, or sync TS)`);
}

test('the write vocabulary matches redisguard BASELINE_WRITE (drift guard)', () => {
  assertSameVocabulary(REDIS_WRITE_COMMANDS, rustWords('BASELINE_WRITE'), 'write');
});

test('the admin vocabulary matches redisguard BASELINE_ADMIN (drift guard)', () => {
  assertSameVocabulary(REDIS_ADMIN_COMMANDS, rustWords('BASELINE_ADMIN'), 'admin');
});

test('containers match redisguard CONTAINERS (drift guard)', () => {
  assertSameVocabulary(REDIS_CONTAINERS, rustWords('CONTAINERS'), 'containers');
});

test('safe subcommands match redisguard SAFE_SUBCOMMANDS (drift guard)', () => {
  assertSameVocabulary(REDIS_SAFE_SUBCOMMANDS, rustWords('SAFE_SUBCOMMANDS'), 'safe_sub');
});

test('known reads match redisguard KNOWN_READ (drift guard)', () => {
  assertSameVocabulary(REDIS_KNOWN_READ, rustWords('KNOWN_READ'), 'read');
});
