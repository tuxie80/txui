/**
 * The MongoDB panel gate (src/utils/mongoPanels.ts).
 *
 * Why it exists: a MongoDB session mounts MongoBrowser, not QueryTabs, so the
 * Tools menu's toggle-panel events need a gate there — and its answer must
 * match what QueryTabs' engineCaps gate would say for the same panel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONGO_PANELS, mongoPanel, mongoPanelAllowed } from '../src/utils/mongoPanels.ts';

test('the panel set is exactly what the v1 driver backs', () => {
  // currentOp/killOp → Processes; buildInfo/serverStatus → Server. Anything
  // more (tuner, DBA views) would be a button that errors when clicked.
  assert.deepEqual(MONGO_PANELS.map(p => p.id), ['processes', 'serverinfo']);
});

test('mongodb may open both, and nothing else', () => {
  assert.equal(mongoPanelAllowed('mongodb', 'processes'), true);
  assert.equal(mongoPanelAllowed('mongodb', 'serverinfo'), true);
  for (const p of ['tuner', 'dbaviews', 'erdiagram', 'datagen', 'quality', 'replication']) {
    assert.equal(mongoPanelAllowed('mongodb', p), false, p);
  }
});

test('the gate agrees with engineCaps for every listed panel', () => {
  // A panel with a capability is allowed iff the engine has it — mysql has
  // both too, parquet has neither.
  assert.equal(mongoPanelAllowed('mysql', 'processes'), true);
  assert.equal(mongoPanelAllowed('parquet', 'processes'), false);
  assert.equal(mongoPanelAllowed('parquet', 'serverinfo'), false);
});

test('mongoPanel looks up by id and misses unknown ids', () => {
  assert.equal(mongoPanel('processes')?.label, 'Processes');
  assert.equal(mongoPanel('nope'), undefined);
});
