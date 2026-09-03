/**
 * Redis editor completion (src/utils/redisComplete.ts).
 *
 * Redis is not SQL — the SQL completion source was offering SELECT/FROM on a
 * Redis connection. These cover the position logic that makes the Redis source
 * useful: command vs subcommand vs argument, and the generated catalog itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineContext, resolveCommand, redisSignature } from '../src/utils/redisComplete.ts';
import { REDIS_COMMANDS, REDIS_BY_NAME } from '../src/utils/redisCommands.ts';

const ctx = (line: string) => lineContext(line, 0, line.length);

test('lineContext splits words from the partial under the cursor', () => {
  assert.deepEqual(ctx(''), { words: [], partial: '', from: 0 });
  assert.deepEqual(ctx('GE'), { words: [], partial: 'GE', from: 0 });
  assert.deepEqual(ctx('GET '), { words: ['GET'], partial: '', from: 4 });
  assert.deepEqual(ctx('GET use'), { words: ['GET'], partial: 'use', from: 4 });
  assert.deepEqual(ctx('CONFIG SET max'), { words: ['CONFIG', 'SET'], partial: 'max', from: 11 });
});

test('resolveCommand understands container subcommands', () => {
  // The whole reason containers need special handling: CONFIG alone is not a
  // runnable command, and CONFIG GET / CONFIG SET are different entries.
  assert.equal(resolveCommand(['GET'])?.name, 'GET');
  assert.equal(resolveCommand(['config', 'set'])?.name, 'CONFIG SET');
  assert.equal(resolveCommand(['CONFIG', 'GET'])?.name, 'CONFIG GET');
  assert.equal(resolveCommand(['CONFIG'])?.name, undefined, 'bare container is not runnable');
  assert.equal(resolveCommand([]), undefined);
  assert.equal(resolveCommand(['NOSUCHCOMMAND']), undefined);
});

test('signature shows real syntax and summary', () => {
  const sig = redisSignature('SET k ', 0, 6)!;
  assert.match(sig, /^SET key value/);
  assert.match(sig, /\[NX \| XX/, 'optional groups must be bracketed');
  assert.match(sig, /—/, 'summary appended');

  const sub = redisSignature('CONFIG SET ', 0, 11)!;
  assert.match(sub, /^CONFIG SET/);
});

// ── the generated catalog ────────────────────────────────────────────────

test('catalog covers the commands people actually type', () => {
  for (const name of ['GET', 'SET', 'DEL', 'SCAN', 'HGETALL', 'ZADD', 'XADD',
                      'EXPIRE', 'TTL', 'INFO', 'KEYS', 'MEMORY USAGE',
                      'CONFIG GET', 'CONFIG SET', 'CLIENT LIST', 'SLOWLOG GET',
                      'XINFO STREAM', 'ACL WHOAMI', 'OBJECT ENCODING']) {
    assert.ok(REDIS_BY_NAME.has(name), `${name} missing from the catalog`);
  }
  assert.ok(REDIS_COMMANDS.length > 300, `only ${REDIS_COMMANDS.length} commands`);
});

test('container subcommands are present as their own entries', () => {
  // Most tools list only the container ("CONFIG") and leave the user guessing.
  const subs = REDIS_COMMANDS.filter(c => c.name.startsWith('CONFIG '));
  assert.ok(subs.length >= 4, `CONFIG subcommands: ${subs.map(s => s.name)}`);
  assert.ok(REDIS_COMMANDS.filter(c => c.name.includes(' ')).length > 80,
            'container subcommands should dominate the long tail');
});

test('every entry carries the metadata the hint panel renders', () => {
  for (const c of REDIS_COMMANDS) {
    assert.ok(c.name && c.name === c.name.toUpperCase(), `bad name ${c.name}`);
    assert.ok(c.summary.length > 0, `${c.name} has no summary`);
    assert.notEqual(c.arity, 0, `${c.name} has arity 0 — COMMAND INFO lookup failed`);
  }
});

test('syntax reproduces the documented form, brackets included', () => {
  // Regression: optionality lives in a `flags` ARRAY in COMMAND DOCS, not as a
  // top-level boolean. Reading it wrong rendered every optional group as
  // mandatory.
  assert.equal(REDIS_BY_NAME.get('SCAN')!.syntax,
               'cursor [MATCH pattern] [COUNT count] [TYPE type]');
  assert.equal(REDIS_BY_NAME.get('HSET')!.syntax, 'key field value [field value ...]');
  assert.match(REDIS_BY_NAME.get('SET')!.syntax, /^key value \[NX \| XX/);
  assert.match(REDIS_BY_NAME.get('ZADD')!.syntax, /\[NX \| XX\] \[GT \| LT\] \[CH\] \[INCR\]/);
});

test('write commands are flagged, reads are not', () => {
  assert.ok(REDIS_BY_NAME.get('SET')!.flags.includes('write'));
  assert.ok(REDIS_BY_NAME.get('DEL')!.flags.includes('write'));
  assert.ok(!REDIS_BY_NAME.get('GET')!.flags.includes('write'));
  assert.ok(REDIS_BY_NAME.get('GET')!.flags.includes('readonly'));
});
