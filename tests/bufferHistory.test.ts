/**
 * Buffer version history (src/utils/bufferHistory.ts).
 *
 * The policy is the whole design here, and its failure mode is silent: a
 * version that was never taken is not missing until the moment you need it.
 * So most of these tests are about the snapshot rules — especially the one
 * that matters, which is capturing a large deletion *immediately* rather than
 * waiting for a timer that will not fire before the work is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSnapshot, snapshot, describeVersion, diffLines, diffSummary,
  loadHistory, saveHistory, historyKey,
  MAX_VERSIONS, MIN_INTERVAL_MS, MIN_EDIT_DELTA, SHRINK_CHARS,
} from '../src/utils/bufferHistory.ts';
import type { BufferVersion } from '../src/utils/bufferHistory.ts';

const v = (text: string, at = 0): BufferVersion =>
  ({ text, at, reason: 'edit', delta: 0 });

const big = (n: number) => 'x'.repeat(n);

// ── the rule that matters ───────────────────────────────────────────────────

test('a large deletion is captured immediately, ignoring the timer', () => {
  // This is the case the module exists for: select-all, paste over. A
  // time-based rule would not have fired yet, and the work is already gone.
  const before = v(big(500), 1000);
  const d = shouldSnapshot(before, 'oops', 1001);   // 1ms later
  assert.equal(d.keep, true);
  assert.equal(d.reason, 'shrink');
});

test('a deletion is a shrink by absolute size OR by proportion', () => {
  // A small buffer losing most of itself matters as much as a big one losing
  // a paragraph.
  assert.equal(shouldSnapshot(v(big(SHRINK_CHARS + 50), 0), big(10), 1).keep, true);
  assert.equal(shouldSnapshot(v(big(100), 0), big(50), 1).reason, 'shrink');
});

test('routine typing does not create a version per keystroke', () => {
  const before = v('SELECT 1', 1000);
  // One character, immediately after.
  assert.equal(shouldSnapshot(before, 'SELECT 12', 1001).keep, false);
});

test('a routine edit needs BOTH enough time and enough change', () => {
  const before = v(big(100), 0);
  const enoughChange = big(100 + MIN_EDIT_DELTA);
  // Enough change, too soon.
  assert.equal(shouldSnapshot(before, enoughChange, MIN_INTERVAL_MS - 1).keep, false);
  // Enough time, too little change.
  assert.equal(shouldSnapshot(before, big(101), MIN_INTERVAL_MS + 1).keep, false);
  // Both.
  assert.equal(shouldSnapshot(before, enoughChange, MIN_INTERVAL_MS + 1).keep, true);
});

test('running a statement is always worth a version', () => {
  const before = v('SELECT 1', 1000);
  const d = shouldSnapshot(before, 'SELECT 2', 1001, 'run');
  assert.equal(d.keep, true);
  assert.equal(d.reason, 'run');
});

test('a manual save is always kept', () => {
  assert.equal(shouldSnapshot(v('a', 0), 'a2', 1, 'manual').reason, 'manual');
});

test('an empty buffer is NEVER a version', () => {
  // Recovering to nothing is not recovery.
  assert.equal(shouldSnapshot(v(big(500), 0), '', 99_999).keep, false);
  assert.equal(shouldSnapshot(v(big(500), 0), '   \n ', 99_999).keep, false);
  assert.equal(shouldSnapshot(undefined, '', 0, 'manual').keep, false);
});

test('an unchanged buffer is not versioned again', () => {
  assert.equal(shouldSnapshot(v('same', 0), 'same', 99_999).keep, false);
});

test('the first non-empty text is always kept', () => {
  assert.equal(shouldSnapshot(undefined, 'SELECT 1', 0).keep, true);
});

// ── the list ────────────────────────────────────────────────────────────────

test('snapshot returns the SAME array when nothing was kept', () => {
  // So a caller can skip a re-render by identity.
  const list = [v('SELECT 1', 0)];
  assert.equal(snapshot(list, 'SELECT 1', 1), list);
});

test('a kept version records its delta and reason', () => {
  const list = snapshot([v('ab', 0)], 'abcdef', 1, 'manual');
  assert.equal(list.length, 2);
  assert.equal(list[1].delta, 4);
  assert.equal(list[1].reason, 'manual');
});

test('history is capped from the front, keeping the newest', () => {
  let list: BufferVersion[] = [];
  for (let i = 0; i < MAX_VERSIONS + 10; i++) {
    list = snapshot(list, `q${i}`, i * 1000, 'manual');
  }
  assert.equal(list.length, MAX_VERSIONS);
  assert.equal(list[list.length - 1].text, `q${MAX_VERSIONS + 9}`);
});

// ── presentation ────────────────────────────────────────────────────────────

test('a version describes itself in relative time', () => {
  const now = 10 * 60 * 1000;
  assert.match(describeVersion({ at: now - 5000, text: 'a', reason: 'edit', delta: 3 }, now),
    /5s ago · edited \+3/);
  assert.match(describeVersion({ at: now - 120_000, text: 'a', reason: 'shrink', delta: -80 }, now),
    /2m ago · deleted −80/);
  assert.match(describeVersion({ at: 0, text: 'a', reason: 'run', delta: 0 }, 3 * 3600 * 1000),
    /3h ago · ran/);
});

// ── diff ────────────────────────────────────────────────────────────────────

test('the diff shows what was removed and what was added', () => {
  const d = diffLines('a\nb\nc', 'a\nX\nc');
  assert.deepEqual(d.map(l => l.kind + l.text), [' a', '-b', '+X', ' c']);
  assert.deepEqual(diffSummary(d), { added: 1, removed: 1 });
});

test('identical text diffs to no changes', () => {
  const d = diffLines('a\nb', 'a\nb');
  assert.deepEqual(diffSummary(d), { added: 0, removed: 0 });
});

test('a wholesale replacement shows both sides', () => {
  const d = diffLines('old', 'new');
  assert.deepEqual(diffSummary(d), { added: 1, removed: 1 });
});

test('an enormous buffer is summarised rather than freezing the UI', () => {
  const huge = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
  const d = diffLines(huge, huge + '\nmore');
  assert.ok(d.length <= 2, 'should degrade to a summary');
});

// ── storage ─────────────────────────────────────────────────────────────────

class FakeStorage implements Storage {
  map = new Map<string, string>();
  /** Throw once the payload exceeds this, to simulate a quota. */
  limit: number;
  constructor(limit = Infinity) { this.limit = limit; }
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, val: string) {
    if (val.length > this.limit) throw new Error('QuotaExceededError');
    this.map.set(k, val);
  }
}

test('history round-trips through storage', () => {
  const st = new FakeStorage();
  const key = historyKey('conn-1', 3);
  const list = [v('SELECT 1', 100), v('SELECT 2', 200)];
  saveHistory(key, list, st);
  assert.deepEqual(loadHistory(key, st).map(x => x.text), ['SELECT 1', 'SELECT 2']);
});

test('corrupt history reads as empty rather than throwing', () => {
  // Bad history must never stop the editor from opening.
  const st = new FakeStorage();
  st.setItem('k', 'not json');
  assert.deepEqual(loadHistory('k', st), []);
  st.setItem('k', '{"not":"an array"}');
  assert.deepEqual(loadHistory('k', st), []);
  st.setItem('k', '[{"bogus":true},{"at":1,"text":"ok"}]');
  assert.deepEqual(loadHistory('k', st).map(x => x.text), ['ok']);
});

test('a missing key reads as empty', () => {
  assert.deepEqual(loadHistory('nope', new FakeStorage()), []);
});

test('a quota failure sheds the oldest instead of losing everything', () => {
  // Storage is shared with the rest of the app; history shrinking is correct,
  // history taking the app down with it is not.
  const st = new FakeStorage(400);
  const key = 'k';
  const many = Array.from({ length: 40 }, (_, i) => v(`statement number ${i}`, i));
  saveHistory(key, many, st);
  const back = loadHistory(key, st);
  assert.ok(back.length > 0, 'everything was dropped');
  assert.ok(back.length < many.length, 'nothing was shed');
  // What survives is the NEWEST, which is what a reader wants.
  assert.equal(back[back.length - 1].text, 'statement number 39');
});

test('keys are per connection and per tab', () => {
  assert.notEqual(historyKey('a', 1), historyKey('a', 2));
  assert.notEqual(historyKey('a', 1), historyKey('b', 1));
});
