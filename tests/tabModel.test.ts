/**
 * Tab-bar behaviour (src/utils/tabModel.ts) — in particular the bug these rules
 * exist to prevent: a plugin panel that behaves like a modal, so "+" seems dead
 * and the panel appears "locked" on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelToggle, closeTab, sqlTabTarget, addTab, closeGuard, nextSqlLabel } from '../src/utils/tabModel.ts';
import type { TabLike } from '../src/utils/tabModel.ts';

const sql = (id: number, label?: string): TabLike => ({ id, label });
const panel = (id: number, p: string): TabLike => ({ id, panel: p });

// ── the "+ is locked" bug ─────────────────────────────────────────────────────

test('“+” adds a SQL tab and brings it to the front while a plugin tab stays open', () => {
  const tabs = [sql(1), panel(2, 'playground')];
  const r = addTab(tabs, sql(3));
  assert.deepEqual(r.tabs.map(t => t.id), [1, 2, 3]);
  assert.equal(r.activeId, 3, 'the new SQL tab must be in front, not hidden behind a panel');
  assert.ok(r.tabs.some(t => t.panel === 'playground'), 'the plugin tab is not closed by “+”');
});

test('a plugin tab never blocks another plugin tab from opening', () => {
  const tabs = [sql(1), panel(2, 'playground')];
  assert.deepEqual(panelToggle(tabs, 2, 'processes'), { action: 'create' });
  const r = addTab(tabs, panel(3, 'processes'));
  assert.equal(r.activeId, 3);
  assert.equal(r.tabs.length, 3);
});

// ── icon toggling ─────────────────────────────────────────────────────────────

test('clicking the icon of the panel in front closes that tab', () => {
  const tabs = [sql(1), panel(2, 'playground')];
  assert.deepEqual(panelToggle(tabs, 2, 'playground'), { action: 'close', id: 2 });
});

test('clicking the icon of a panel that is open but behind just focuses it', () => {
  const tabs = [sql(1), panel(2, 'playground'), sql(3)];
  assert.deepEqual(panelToggle(tabs, 3, 'playground'), { action: 'focus', id: 2 });
});

test('one tab per panel — a second click never opens a duplicate', () => {
  const tabs = [panel(2, 'processes'), sql(1)];
  const t = panelToggle(tabs, 1, 'processes');
  assert.equal(t.action, 'focus');
});

// ── closing ───────────────────────────────────────────────────────────────────

test('closing a plugin tab leaves the SQL tabs untouched', () => {
  const r = closeTab([sql(1), panel(2, 'playground'), sql(3)], 2, 2);
  assert.deepEqual(r.tabs.map(t => t.id), [1, 3]);
  assert.equal(r.activeId, 3, 'closing the active tab falls back to the last one');
});

test('closing a background tab does not steal focus', () => {
  const r = closeTab([sql(1), panel(2, 'locks'), sql(3)], 3, 2);
  assert.equal(r.activeId, 3);
});

test('closing the very last tab empties the list — the session stays connected', () => {
  assert.deepEqual(closeTab([panel(9, 'playground')], 9, 9), { tabs: [], activeId: null });
  assert.deepEqual(closeTab([sql(1)], 1, 1), { tabs: [], activeId: null });
});

// ── where a plugin sends SQL ──────────────────────────────────────────────────

test('SQL from a plugin goes to the SQL tab you came from', () => {
  const tabs = [sql(1), sql(4), panel(2, 'history')];
  assert.equal(sqlTabTarget(tabs, 1)?.id, 1);
});

test('…the newest SQL tab if that one is gone', () => {
  const tabs = [sql(1), sql(4), panel(2, 'history')];
  assert.equal(sqlTabTarget(tabs, 99)?.id, 4);
});

test('…and nothing when only plugin tabs are left (caller creates one)', () => {
  assert.equal(sqlTabTarget([panel(2, 'history'), panel(3, 'saved')], 2), null);
});

test('a plugin tab is never a SQL target, even if the id matches', () => {
  assert.equal(sqlTabTarget([panel(2, 'history')], 2), null);
});

// ── closing a tab that is still running something ─────────────────────────────

test('an idle tab closes without a question', () => {
  assert.deepEqual(closeGuard([]), { ask: false, canKeepRunning: false });
});

test('a running tab always asks first', () => {
  assert.equal(closeGuard([{ survives: true }]).ask, true);
  assert.equal(closeGuard([{ survives: false }]).ask, true);
});

test('“keep running” is offered only when everything survives the tab', () => {
  assert.equal(closeGuard([{ survives: true }, { survives: true }]).canKeepRunning, true);
  assert.equal(closeGuard([{ survives: true }, { survives: false }]).canKeepRunning, false,
    'one thing that dies with the tab removes the option');
});

test('which tab number is being closed does not matter — the connection outlives every tab', () => {
  // There is no isLastTab argument any more: closing the last tab is an
  // ordinary close, so survivable work keeps running on the still-open session.
  const g = closeGuard([{ survives: true }]);
  assert.equal(g.ask, true);
  assert.equal(g.canKeepRunning, true);
});

// ── numbering the next “+” tab ─────────────────────────────────────────────

test('the first tab of an empty list is “01” again', () => {
  assert.equal(nextSqlLabel([]), '01');
  assert.equal(nextSqlLabel([panel(9, 'playground')]), '01',
    'panel tabs alone do not move the SQL numbering');
});

test('the next label is one past the highest numeric SQL label', () => {
  assert.equal(nextSqlLabel([sql(1, '01')]), '02');
  assert.equal(nextSqlLabel([sql(1, '01'), sql(2, '03')]), '04');
});

test('panel tabs and renamed/non-numeric labels are ignored', () => {
  assert.equal(nextSqlLabel([sql(1, '01'), panel(2, 'history'), sql(3, 'scratchpad')]), '02');
  assert.equal(nextSqlLabel([sql(1, '05 @3h ago')]), '01',
    'a recovered snapshot label is not a number');
});
