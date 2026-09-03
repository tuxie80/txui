/**
 * Scratch-buffer naming (src/utils/scratch.ts) — every scratch session is an
 * independent in-memory DuckDB, so the tabs are numbered by the smallest free
 * integer: a closed number is reused, and two live scratch tabs never share a
 * name (a plain count+1 collides the moment an earlier tab closes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextScratchName, SCRATCH_BASE } from '../src/utils/scratch.ts';

test('the first scratch is Scratch 1', () => {
  assert.equal(nextScratchName([]), 'Scratch 1');
});

test('numbers climb while all previous ones are open', () => {
  assert.equal(nextScratchName(['Scratch 1']), 'Scratch 2');
  assert.equal(nextScratchName(['Scratch 1', 'Scratch 2']), 'Scratch 3');
});

test('a closed number is reused rather than skipped', () => {
  // Scratch 2 of three closed: the gap fills before a new high-water mark.
  assert.equal(nextScratchName(['Scratch 1', 'Scratch 3']), 'Scratch 2');
});

test('unrelated session names do not occupy scratch numbers', () => {
  assert.equal(nextScratchName(['prod-eu', 'Scratchpad', 'Scratch']), 'Scratch 1');
  assert.equal(nextScratchName(['Scratch 1', 'prod-eu']), 'Scratch 2');
});

test('the base name is the prefix the sidebar and tab strip show', () => {
  assert.equal(SCRATCH_BASE, 'Scratch');
  assert.ok(nextScratchName([]).startsWith(`${SCRATCH_BASE} `));
});
