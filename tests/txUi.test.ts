/**
 * Manual-transaction UI state machine (src/utils/txUi.ts) — mirrors the
 * backend truth in src-tauri/src/commands/query.rs (end_transaction removes
 * the held connection from the map BEFORE running COMMIT/ROLLBACK, so any
 * settled end — ok or failed — means no open transaction).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { txReduce, txIsOpen, txIsBusy, txControls } from '../src/utils/txUi.ts';

test('happy path: auto → pending → open → pending → auto', () => {
  let m = txReduce('auto', 'begin');
  assert.equal(m, 'pending');
  assert.ok(txIsBusy(m));
  m = txReduce(m, 'begin-ok');
  assert.equal(m, 'open');
  assert.ok(txIsOpen(m));
  m = txReduce(m, 'end');
  assert.equal(m, 'pending');
  m = txReduce(m, 'end-done');
  assert.equal(m, 'auto');
  assert.ok(!txIsOpen(m) && !txIsBusy(m));
});

test('failed begin returns to auto (stays on the AUTO toggle)', () => {
  const m = txReduce(txReduce('auto', 'begin'), 'begin-fail');
  assert.equal(m, 'auto');
});

test('failed commit/rollback still returns to auto (backend dropped the conn)', () => {
  const m = txReduce(txReduce('open', 'end'), 'end-done');
  assert.equal(m, 'auto');
});

test('clicks while pending are ignored (no double begin / double commit)', () => {
  assert.equal(txReduce('pending', 'begin'), 'pending');
  assert.equal(txReduce('pending', 'end'), 'pending');
});

test('out-of-order completions cannot corrupt state', () => {
  assert.equal(txReduce('auto', 'begin-ok'), 'auto', 'stale begin-ok ignored');
  assert.equal(txReduce('auto', 'end-done'), 'auto');
  assert.equal(txReduce('open', 'end-done'), 'open', 'end-done without end() ignored');
  assert.equal(txReduce('open', 'begin-fail'), 'open');
});

// ── toolbar enablement (txControls) ─────────────────────────────────────────
//
// Commit and Rollback are always on screen, so exactly when they are LIVE is
// the whole safety rule. A button that is clickable while no connection is
// pinned would settle whichever pooled connection it reached.

test('Commit and Rollback are dead until a connection is pinned', () => {
  assert.equal(txControls('auto', false, null).canSettle, false);
  assert.equal(txControls('open', false, null).canSettle, true);
});

test('an in-flight begin or commit disables everything', () => {
  // Otherwise a double-click fires a second COMMIT against a transaction that
  // has already been released.
  const c = txControls('pending', false, null);
  assert.equal(c.canSettle, false);
  assert.equal(c.canBegin, false);
});

test('with autocommit off there is nothing to begin — the session re-pins itself', () => {
  assert.equal(txControls('auto', true, null).canBegin, false);
  assert.equal(txControls('auto', false, null).canBegin, true);
});

test('an ordinary manual transaction is NOT a mismatch', () => {
  // @@autocommit stays 1 inside a plain BEGIN — verified against MySQL 8.0.
  // Comparing it to the held state would put a warning on every manual
  // transaction, which is how a real warning stops being read.
  assert.equal(txControls('open', false, true).mismatch, false);
});

test('an autocommit-off connection whose server says ON is a mismatch', () => {
  // The case this readout exists for: `SET autocommit = 0` typed in the editor
  // reaches one pooled connection and no others.
  assert.equal(txControls('open', true, true).mismatch, true);
  assert.equal(txControls('open', true, false).mismatch, false);
});

test('an autocommit-on connection whose server says OFF is a mismatch', () => {
  assert.equal(txControls('auto', false, false).mismatch, true);
});

test('an unknown server value never warns', () => {
  // PostgreSQL has no autocommit setting; a guess would be worse than silence.
  assert.equal(txControls('open', true, null).mismatch, false);
  assert.equal(txControls('auto', false, null).mismatch, false);
});
