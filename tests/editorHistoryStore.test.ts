/**
 * Persistent editor undo history envelope (src/utils/editorHistoryStore.ts).
 *
 * CodeMirror owns the serialization of a single undo stack; this module owns
 * the per-connection blob around it. The value under each buffer id is opaque
 * on purpose, so these tests treat it as opaque too — the contract is "what I
 * put in for a buffer id is what I get back out", plus "a blob I cannot read
 * degrades to nothing rather than throwing".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHistoryBlob, serializeHistoryBlob, getStoredHistory, withHistory, pruneHistory,
  MAX_HISTORY_BUFFERS, MAX_HISTORY_BLOB_CHARS,
} from '../src/utils/editorHistoryStore.ts';

// A stand-in for CodeMirror's opaque historyField JSON.
const hist = (n: number) => ({ done: [{ changes: n }], undone: [] });

test('a round-trip keeps each buffer’s stack under its id', () => {
  const blob = { 'a': hist(1), 'b': hist(2) };
  const restored = parseHistoryBlob(serializeHistoryBlob(blob, ['a', 'b']));
  assert.deepEqual(restored, blob);
  assert.deepEqual(getStoredHistory(restored, 'b'), hist(2));
});

test('a corrupt / foreign / empty blob degrades to nothing, never throws', () => {
  assert.deepEqual(parseHistoryBlob('not json at all {'), {});
  assert.deepEqual(parseHistoryBlob(null), {});
  assert.deepEqual(parseHistoryBlob(undefined), {});
  assert.deepEqual(parseHistoryBlob(JSON.stringify({ v: 99, hist: { a: hist(1) } })), {});
  assert.deepEqual(parseHistoryBlob(JSON.stringify({ v: 1 })), {});
  // A hand-edited blob whose value is null is treated as "no stack".
  assert.deepEqual(parseHistoryBlob(JSON.stringify({ v: 1, hist: { a: null } })), {});
  assert.equal(getStoredHistory({}, 'missing'), undefined);
  assert.equal(getStoredHistory({}, undefined), undefined);
});

test('serialize prunes to the buffers still open', () => {
  const blob = { 'open': hist(1), 'closed': hist(2) };
  const restored = parseHistoryBlob(serializeHistoryBlob(blob, ['open']));
  assert.deepEqual(Object.keys(restored), ['open']);
});

test('withHistory sets and clears immutably', () => {
  const a = { x: hist(1) };
  const b = withHistory(a, 'y', hist(2));
  assert.notEqual(a, b);
  assert.deepEqual(Object.keys(b).sort(), ['x', 'y']);
  const c = withHistory(b, 'x', null);
  assert.deepEqual(Object.keys(c), ['y']);
});

test('pruneHistory drops ids that are no longer open', () => {
  const pruned = pruneHistory({ a: hist(1), b: hist(2), c: hist(3) }, ['a', 'c']);
  assert.deepEqual(Object.keys(pruned).sort(), ['a', 'c']);
});

test('the buffer-count cap sheds the largest stacks first', () => {
  const blob: Record<string, unknown> = {};
  for (let i = 0; i < MAX_HISTORY_BUFFERS + 5; i++) {
    // Give higher indices deliberately bigger stacks so we can see who is shed.
    blob[`b${i}`] = { done: 'x'.repeat(i * 10 + 1) };
  }
  const restored = parseHistoryBlob(serializeHistoryBlob(blob, Object.keys(blob)));
  assert.equal(Object.keys(restored).length, MAX_HISTORY_BUFFERS);
  // The smallest (b0) survives; the biggest (highest index) is shed.
  assert.ok('b0' in restored);
  assert.ok(!(`b${MAX_HISTORY_BUFFERS + 4}` in restored));
});

test('the size cap keeps the blob under its char budget', () => {
  const blob: Record<string, unknown> = {
    small: { done: 'x'.repeat(10) },
    huge: { done: 'y'.repeat(MAX_HISTORY_BLOB_CHARS + 1000) },
  };
  const out = serializeHistoryBlob(blob, ['small', 'huge']);
  assert.ok(out.length <= MAX_HISTORY_BLOB_CHARS);
  // The small stack survives; the oversized one is shed to make it fit.
  const restored = parseHistoryBlob(out);
  assert.ok('small' in restored);
  assert.ok(!('huge' in restored));
});
