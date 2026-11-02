/**
 * Editor buffers surviving a restart (src/utils/bufferStore.ts).
 * The bug this prevents: a half-written migration lost because the app
 * restarted or the connection dropped with the editor still open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeBuffers, decodeBuffers, MAX_BUFFER_CHARS, MAX_TOTAL_CHARS, MAX_BUFFERS, bufferKey,
} from '../src/utils/bufferStore.ts';
import type { StoredBuffer } from '../src/utils/bufferStore.ts';

const buf = (label: string, sql: string, over: Partial<StoredBuffer> = {}): StoredBuffer =>
  ({ label, sql, ...over });

test('a round-trip keeps text, label, colour and which tab was in front', () => {
  const tabs = [buf('01', 'SELECT 1'), buf('migration', 'ALTER TABLE t ADD c int', { color: '#e05555', active: true })];
  const restored = decodeBuffers(JSON.stringify(encodeBuffers(tabs)));
  assert.deepEqual(restored, [
    { label: '01', color: undefined, sql: 'SELECT 1', active: false },
    { label: 'migration', color: '#e05555', sql: 'ALTER TABLE t ADD c int', active: true },
  ]);
});

test('empty and whitespace-only buffers are not stored', () => {
  assert.equal(encodeBuffers([buf('01', ''), buf('02', '   \n\t ')]), null);
  assert.equal(decodeBuffers(null).length, 0);
});

test('a huge buffer is truncated, not dropped', () => {
  const payload = encodeBuffers([buf('big', 'x'.repeat(MAX_BUFFER_CHARS + 5_000))]);
  assert.equal(payload!.tabs[0].sql.length, MAX_BUFFER_CHARS);
});

test('the total cap keeps the newest tabs', () => {
  // each buffer is already at the per-buffer cap, so only floor(total/buffer) fit
  const big = 'y'.repeat(MAX_BUFFER_CHARS);
  const fit = Math.floor(MAX_TOTAL_CHARS / MAX_BUFFER_CHARS);
  const labels = Array.from({ length: fit + 2 }, (_, i) => `t${i}`);
  const payload = encodeBuffers(labels.map(l => buf(l, big)));
  assert.equal(payload!.tabs.length, fit);
  assert.deepEqual(payload!.tabs.map(t => t.label), labels.slice(-fit),
    'the newest survive, the oldest are dropped');
});

test('the buffer-count cap keeps the newest tabs', () => {
  const many = Array.from({ length: MAX_BUFFERS + 5 }, (_, i) => buf(`t${i}`, `SELECT ${i}`));
  const payload = encodeBuffers(many);
  assert.equal(payload!.tabs.length, MAX_BUFFERS);
  assert.equal(payload!.tabs.at(-1)!.label, `t${MAX_BUFFERS + 4}`);
});

test('corrupt, foreign or future payloads are ignored, never half-read', () => {
  assert.deepEqual(decodeBuffers('not json'), []);
  assert.deepEqual(decodeBuffers('{}'), []);
  assert.deepEqual(decodeBuffers('[]'), []);
  assert.deepEqual(decodeBuffers(JSON.stringify({ v: 2, tabs: [buf('x', 'SELECT 1')] })), []);
  assert.deepEqual(decodeBuffers(JSON.stringify({ v: 1, tabs: 'nope' })), []);
  // a partially valid list keeps only the valid entries
  assert.deepEqual(
    decodeBuffers(JSON.stringify({ v: 1, tabs: [{ label: 'ok', sql: 'SELECT 1' }, { label: 5 }, null, { sql: '' }] }))
      .map(t => t.label),
    ['ok']);
});

test('keys are namespaced per connection', () => {
  assert.equal(bufferKey('abc'), 'dbgui.buffers.abc');
  assert.notEqual(bufferKey('a'), bufferKey('b'));
});

test('view-only plugin tabs and the active SQL view survive without result data', () => {
  const payload = encodeBuffers([
    buf('Processes', '', { panel: 'processes', active: true }),
    buf('query', 'SELECT 1', { view: 'log' }),
  ]);
  const restored = decodeBuffers(JSON.stringify(payload));
  assert.equal(restored[0].panel, 'processes');
  assert.equal(restored[0].sql, '');
  assert.equal(restored[0].active, true);
  assert.equal(restored[1].view, 'log');
  assert.equal('rows' in restored[1], false);
  assert.equal('running' in restored[1], false);
});

test('caret, selection, scrolling and folds round-trip', () => {
  const editor = {
    anchor: 7, head: 15, scrollTop: 420, scrollLeft: 12,
    folds: [{ from: 20, to: 80 }, { from: 100, to: 160 }],
  };
  const restored = decodeBuffers(JSON.stringify(encodeBuffers([
    buf('folded', 'SELECT 1', { editor }),
  ])));
  assert.deepEqual(restored[0].editor, editor);
});

test('invalid presentation state is dropped or clamped by allowlist', () => {
  const restored = decodeBuffers(JSON.stringify({ v: 1, tabs: [{
    label: 'safe', sql: 'SELECT 1', panel: 'bad panel; run', view: 'execute',
    editor: { anchor: -1, head: 4, scrollTop: 20, folds: [{ from: 9, to: 2 }] },
  }] }));
  assert.equal(restored[0].panel, undefined);
  assert.equal(restored[0].view, undefined);
  assert.equal(restored[0].editor, undefined);
});

test('an empty SQL tab is still dropped when it is not a plugin', () => {
  assert.equal(encodeBuffers([buf('empty', '', { view: 'grid' })]), null);
});
