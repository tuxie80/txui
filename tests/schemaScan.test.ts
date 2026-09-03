/**
 * The schema-scan status line (src/store/schemaScan.ts): one transient slot
 * the status bar shows while the object explorer refreshes. The rules that
 * matter: publishing notifies, re-publishing the same line does not, and a
 * clear only ever removes its OWN session's line — a finished refresh must
 * not wipe the one another session is still running.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  publishSchemaScan, clearSchemaScan, getSchemaScan, useSchemaScan,
} from '../src/store/schemaScan.ts';

// The hook needs a renderer to subscribe; the tests exercise the store core
// directly, so just prove the hook export is there for the status bar.
test('the subscription hook is exported for the status bar', () => {
  assert.equal(typeof useSchemaScan, 'function');
});

test('publishing stores the line, clearing removes it', () => {
  clearSchemaScan('s1'); // in case a previous test left one
  assert.equal(getSchemaScan(), null);
  publishSchemaScan('s1', 'scanning reporting.orders…');
  assert.deepEqual(getSchemaScan(), { sessionId: 's1', text: 'scanning reporting.orders…' });
  clearSchemaScan('s1');
  assert.equal(getSchemaScan(), null);
});

test('clearing with no line is a no-op', () => {
  clearSchemaScan('nobody');
  assert.equal(getSchemaScan(), null);
});

test('last writer wins across sessions', () => {
  publishSchemaScan('s1', 'scanning a…');
  publishSchemaScan('s2', 'scanning b…');
  assert.equal(getSchemaScan()?.text, 'scanning b…');
  clearSchemaScan('s2');
  assert.equal(getSchemaScan(), null);
});

test('a clear only removes its own session’s line', () => {
  publishSchemaScan('s1', 'scanning a…');
  publishSchemaScan('s2', 'scanning b…');
  clearSchemaScan('s1'); // s1's scan ended first — the line is s2's now
  assert.equal(getSchemaScan()?.text, 'scanning b…');
  clearSchemaScan('s2');
  assert.equal(getSchemaScan(), null);
});

test('re-publishing the identical line does not re-notify', () => {
  clearSchemaScan('s1');
  publishSchemaScan('s1', 'scanning a…');
  // publishSchemaScan emits through its listener set; hook a probe into a
  // fresh publish cycle by observing getSchemaScan identity stability.
  const before = getSchemaScan();
  publishSchemaScan('s1', 'scanning a…');
  assert.equal(getSchemaScan(), before); // same object — early return, no emit
  publishSchemaScan('s1', 'scanning a.b…');
  assert.notEqual(getSchemaScan(), before);
  clearSchemaScan('s1');
});
