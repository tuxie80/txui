import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smokeVerdict } from '../src/utils/smoke.ts';

test('smoke verdict: all checks pass + no CSP violations → ok', () => {
  const v = smokeVerdict([{ id: 'a', ok: true }, { id: 'b', ok: true }], [], 1200);
  assert.equal(v.ok, true);
  assert.equal(v.ms, 1200);
});

test('smoke verdict: one failed check fails the run', () => {
  const v = smokeVerdict([{ id: 'a', ok: true }, { id: 'b', ok: false, detail: 'x' }], [], 5);
  assert.equal(v.ok, false);
});

test('smoke verdict: a CSP violation fails even with green checks', () => {
  // The 1.3.0 lesson: style-src-elem blocked CodeMirror's injected styles.
  const v = smokeVerdict([{ id: 'a', ok: true }], ['style-src-elem: inline'], 5);
  assert.equal(v.ok, false);
});
