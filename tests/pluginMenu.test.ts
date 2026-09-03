/**
 * The plugin menu grouping (src/utils/pluginMenu.ts ↔ QueryTabs PANEL_META).
 *
 * The menu bar (Activity / Insights / Server / Schema / Data / Find & Compare /
 * SQL) is the only labelled
 * in-app surface that lists the panels — if a panel is added to PANEL_META
 * without a menu item here, it becomes reachable only by shortcut and the
 * native Tools menu, and nothing would break to say so. Same drift shape as
 * tests/toolsMenu.test.ts guards for the Rust-built menu, one level down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_MENU } from '../src/utils/pluginMenu.ts';
import { ENGINE_CAPS } from '../src/utils/engineCaps.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const tabs = readFileSync(join(ROOT, 'src/components/QueryTabs.tsx'), 'utf8');

/** Panel ids the frontend knows about. */
const metaBlock = /const PANEL_META[^{]*\{([\s\S]*?)\n\};/.exec(tabs)![1];
const panelIds = [...metaBlock.matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map(m => m[1]);

const menuPanels = PLUGIN_MENU.flatMap(g => g.items.map(i => i.panel));

test('every plugin appears in exactly one menu group', () => {
  const dupes = menuPanels.filter((p, i) => menuPanels.indexOf(p) !== i);
  assert.deepEqual(dupes, [], `listed twice: ${dupes}`);
  const missing = panelIds.filter(p => !menuPanels.includes(p));
  assert.deepEqual(missing, [],
    'add these to PLUGIN_MENU in src/utils/pluginMenu.ts — a panel with no menu '
    + 'item is reachable only by shortcut, and nothing else would break');
});

test('every menu item names a plugin that exists', () => {
  const unknown = menuPanels.filter(p => !panelIds.includes(p));
  assert.deepEqual(unknown, [], `no such panel in PANEL_META: ${unknown}`);
});

test('the grouping is the seven logical areas, none empty', () => {
  // Activity / Insights / Server / Schema / Data / Find & Compare / SQL —
  // seven, pinned so a regroup is a deliberate act that updates this test,
  // not silent drift.
  assert.equal(PLUGIN_MENU.length, 7,
    `${PLUGIN_MENU.length} groups — the menu bar is meant to be a handful of areas, not the icon row spelled out`);
  assert.deepEqual(PLUGIN_MENU.map(g => g.label),
    ['Activity', 'Insights', 'Server', 'Schema', 'Data', 'Find & Compare', 'SQL']);
  for (const g of PLUGIN_MENU) {
    assert.ok(g.label.length > 0 && g.items.length > 0, `empty group: ${g.id}`);
  }
});

test('every gate is a real engine capability or a named engine', () => {
  const caps = new Set(Object.keys(ENGINE_CAPS.mysql));
  for (const g of PLUGIN_MENU) {
    for (const it of g.items) {
      if (!it.when) continue;
      if (it.when === 'mysql' || it.when === 'postgres' || it.when === 'clickhouse') continue;
      assert.ok(caps.has(it.when), `${it.panel}: ${it.when} is not a capability in engineCaps`);
    }
  }
});

test('every item carries a label and a hover tip', () => {
  for (const g of PLUGIN_MENU) {
    for (const it of g.items) {
      assert.ok(it.label.length > 0 && it.tip.length > 0,
        `${it.panel}: the menu is the labelled surface — an item without a name is the icon bar all over again`);
    }
  }
});

test('the menu goes through the same opener and gates as everything else', () => {
  // Menu clicks call togglePanel through panelBlocked; the native Tools menu
  // re-dispatches the same window event. Neither is a second way in.
  assert.match(tabs, /if \(blocked\) return; setOpenMenu\(null\); togglePanel\(it\.panel\);/);
  assert.match(tabs, /menuItemVisible/);
});
