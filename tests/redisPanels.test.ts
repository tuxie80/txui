/**
 * The Redis panel gate (src/utils/redisPanels.ts).
 *
 * The bug it replaces: a Redis session mounts RedisBrowser, not QueryTabs, and
 * only QueryTabs listened for `dbgui:toggle-panel` — so engineCaps advertised
 * redis.processList/serverInfo/tuner as true and the panels themselves spoke
 * Redis, yet no surface could open them on a Redis session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDIS_PANELS, redisPanel, redisPanelAllowed } from '../src/utils/redisPanels.ts';
import { can } from '../src/utils/engineCaps.ts';

test('Redis can open the panels its capability row advertises', () => {
  // CLIENT LIST / CLIENT KILL, CONFIG GET / INFO, and the Redis tuner rule set.
  assert.equal(redisPanelAllowed('redis', 'processes'), true);
  assert.equal(redisPanelAllowed('redis', 'serverinfo'), true);
  assert.equal(redisPanelAllowed('redis', 'tuner'), true);
  assert.equal(redisPanelAllowed('redis', 'dbaviews'), true);
});

test('every capped panel agrees with the engine capability table', () => {
  // The list must not claim a panel the table says Redis does not have —
  // the table is the source of truth, this is the consistency check.
  for (const p of REDIS_PANELS) {
    if (p.cap) assert.equal(can('redis', p.cap), true, `redis.${p.cap} for ${p.id}`);
  }
});

test('panels outside the Redis set are refused', () => {
  // A SQL-editor panel dispatched while a Redis session is active is ignored.
  for (const id of ['datagen', 'csvimport', 'quality', 'erdiagram', 'playground',
                    'history', 'saved', 'watch', 'locks', 'users', '']) {
    assert.equal(redisPanelAllowed('redis', id), false, id);
  }
});

test('the gate still honours the table for other engines', () => {
  // SQLite has no server-side surface: even a panel in the Redis set must
  // stay closed when the capability is false.
  assert.equal(redisPanelAllowed('sqlite', 'processes'), false);
  assert.equal(redisPanelAllowed('sqlite', 'serverinfo'), false);
  assert.equal(redisPanelAllowed('duckdb', 'tuner'), false);  // unknown engine
});

test('redisPanel carries the tab label and icon', () => {
  assert.deepEqual(redisPanel('tuner'), { id: 'tuner', icon: '💊', label: 'Tuner', cap: 'tuner' });
  assert.equal(redisPanel('nope'), undefined);
});
