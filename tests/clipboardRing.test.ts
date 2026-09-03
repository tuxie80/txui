/**
 * Clipboard history / paste ring (src/utils/clipboardRing.ts) — the bounded,
 * dedupe-to-front ring backing the ⌘⇧V paste-from-history command.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pushClip, clips, clipAt, clearClips } from '../src/utils/clipboardRing.ts';

describe('clipboardRing', () => {
  beforeEach(() => clearClips());

  test('newest clip comes first', () => {
    pushClip('a');
    pushClip('b');
    pushClip('c');
    assert.deepEqual(clips(), ['c', 'b', 'a']);
  });

  test('re-copying an entry moves it to the front, without duplicating', () => {
    pushClip('a');
    pushClip('b');
    pushClip('c');
    pushClip('a');
    assert.deepEqual(clips(), ['a', 'c', 'b']);
  });

  test('empty and whitespace-only text is ignored', () => {
    pushClip('');
    pushClip('   ');
    pushClip('\n\t');
    pushClip('x');
    assert.deepEqual(clips(), ['x']);
  });

  test('the ring is bounded and evicts the oldest', () => {
    for (let i = 0; i < 25; i++) pushClip(`clip-${i}`);
    const list = clips();
    assert.equal(list.length, 20);
    // Newest first, oldest five (0..4) evicted.
    assert.equal(list[0], 'clip-24');
    assert.equal(list[19], 'clip-5');
    assert.ok(!list.includes('clip-4'));
  });

  test('clipAt reads by index, 0 = newest', () => {
    pushClip('a');
    pushClip('b');
    assert.equal(clipAt(0), 'b');
    assert.equal(clipAt(1), 'a');
    assert.equal(clipAt(2), undefined);
  });

  test('clips() returns a copy that cannot mutate the ring', () => {
    pushClip('a');
    const list = clips();
    list.push('injected');
    assert.deepEqual(clips(), ['a']);
  });
});
