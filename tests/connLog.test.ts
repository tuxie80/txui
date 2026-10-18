/**
 * `dbgui:conn-log` shaping and targeting (src/utils/connLog.ts, W5.0).
 *
 * The behaviour this locks in: a connection-lifecycle event becomes ONE
 * canonical session-log line; an explicit sessionId wins, the active session
 * is the fallback, and with neither the entry is dropped rather than written
 * to the wrong connection's log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connLogEntry, connLogTarget } from '../src/utils/connLog.ts';

test('a detail becomes a canonical CONNECT entry with an explicit line', () => {
  assert.deepEqual(connLogEntry({ level: 'err', msg: 'prod — connect refused (after 3s)' }), {
    level: 'err', action: 'CONNECT',
    detail: 'prod — connect refused (after 3s)',
    line: 'prod — connect refused (after 3s)',
  });
});

test('an empty message writes nothing', () => {
  assert.equal(connLogEntry({ level: 'info', msg: '   ' }), null);
  assert.equal(connLogEntry(null), null);
  assert.equal(connLogEntry({}), null);
});

test('an unknown level degrades to info, never crashes the listener', () => {
  assert.equal(connLogEntry({ level: 'loud', msg: 'x' })?.level, 'info');
  assert.equal(connLogEntry({ msg: 'x' })?.level, 'info');
});

test('targeting: explicit sessionId wins over the active session', () => {
  assert.equal(connLogTarget({ sessionId: 's1' }, 's2'), 's1');
});

test('targeting: no sessionId falls back to the active session', () => {
  assert.equal(connLogTarget({ msg: 'x' }, 's2'), 's2');
  assert.equal(connLogTarget({ sessionId: '' }, 's2'), 's2');
});

test('targeting: no sessionId and no active session drops silently', () => {
  assert.equal(connLogTarget({ msg: 'x' }, null), null);
  assert.equal(connLogTarget({ msg: 'x' }, ''), null);
});
