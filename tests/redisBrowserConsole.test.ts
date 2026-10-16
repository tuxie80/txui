/**
 * RedisBrowser's Console tab and db strip — source pins (same convention as
 * tests/mongoGraphics.test.ts and tests/menuBar.test.ts).
 *
 * The audit finding they pin against: the Redis typed-command pipeline
 * (redisguard + redis_shape in db/redis.rs, execute_query's engine-aware
 * guard) and the INFO-keyspace db listing (redis::list_schema) were both live
 * in the backend but unreachable — a Redis session mounts RedisBrowser, never
 * QueryTabs, and RedisBrowser had Keys/Audit/INFO tabs only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { engineGapReason } from '../src/utils/engineGaps.ts';

const src = readFileSync('src/components/RedisBrowser.tsx', 'utf8');

test('the Console tab mounts the mini QueryEditor, not a third editor', () => {
  assert.ok(src.includes("import { QueryEditor } from './QueryEditor'"),
    'QueryEditor is the console — its execute_query wiring and redis placeholder already exist');
  assert.match(src, /tab === 'console' && <ConsolePanel session=\{session\} \/>/);
  assert.match(src, /<QueryEditor session=\{session\} \/>/);
  // SqlEditor's redis branch is wired to QueryTabs, which a Redis session
  // never mounts — importing it here would drag the whole SQL editor in.
  assert.ok(!src.includes("from './SqlEditor'"), 'do not pull SqlEditor into RedisBrowser');
});

test('the Console tab is a tab, alongside Keys / Audit / Server INFO', () => {
  assert.match(src, /\$\{tab === 'console' \? 'active' : ''\}/);
  assert.match(src, />Console<\/button>/);
});

test('read-only is surfaced, not pre-guessed: an explanatory note, backend refusal does the rest', () => {
  // redisguard classifies the typed command server-side (server-informed
  // write catalog) — the frontend must not duplicate that classification, so
  // there is no client-side write gate to pin. The note tells the user why a
  // write comes back refused.
  assert.match(src, /rb-console-ro/);
  assert.match(src, /session\.readOnly/);
});

test('the db strip is fed by list_schema labels and the connection config', () => {
  assert.ok(src.includes("import { parseRedisDbLabel, redisConfigDbIndex } from '../utils/redisDbs'"));
  assert.ok(src.includes('SchemaStore.listSchema(sessionId)'),
    'the dbN list with key counts is INFO keyspace via list_schema');
  assert.ok(src.includes('redisConfigDbIndex('),
    'the current db is the connection\'s database field — the value build_url connected with');
});

test('the strip is an indicator: the switcher is a registered gap, and Sentinel hides the strip', () => {
  // No set_session_db call — there is no Redis arm, and inventing a SELECT
  // on the shared connection would race concurrent commands (db/redis.rs).
  assert.ok(!src.includes('set_session_db'), 'no runtime db switch may be wired');
  const reason = engineGapReason('redis', 'databaseSelect');
  assert.ok(reason, 'the switcher gap must be registered so the strip can explain itself');
  assert.ok(src.includes("engineGapReason('redis', 'databaseSelect')"),
    'the strip\'s tooltip is the registered reason');
  assert.match(src, /sentinel\?\.mode !== 'sentinel' && \(\s*<DbStrip/,
    'a Sentinel port holds no keyspace — no dbs to indicate');
});
