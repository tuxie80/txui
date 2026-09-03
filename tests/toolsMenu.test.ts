/**
 * The Tools menu lists every plugin (src-tauri/src/lib.rs ↔ QueryTabs PANEL_META).
 *
 * The menu exists because the plugin strip was a row of unlabelled glyphs —
 * fine once you know them, useless the first week — and several panels were
 * reachable only from there. A menu is the one surface a user is entitled to
 * assume is complete. (The strip is a labelled menu itself now — Activity /
 * Insights / Server / Schema / Data / Find & Compare / SQL,
 * utils/pluginMenu.ts — and
 * this test keeps the native menu agreeing with the same PANEL_META, and the
 * same group shape, either way.)
 *
 * Which makes the drift the thing to guard: Tauri builds menus in Rust at
 * startup, so the list cannot be shared with the frontend, and a plugin added
 * to `PANEL_META` without a menu item would leave exactly the gap the menu was
 * added to close — invisibly, because nothing else would break.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_MENU } from '../src/utils/pluginMenu.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const rust = readFileSync(join(ROOT, 'src-tauri/src/lib.rs'), 'utf8');
const tabs = readFileSync(join(ROOT, 'src/components/QueryTabs.tsx'), 'utf8');

/** Panel ids the Rust menu builds items for. */
const menuIds = [...rust.matchAll(/with_id\("tool:([a-z]+)"/g)].map(m => m[1]);

/** Panel ids the frontend knows about. */
const metaBlock = /const PANEL_META[^{]*\{([\s\S]*?)\n\};/.exec(tabs)![1];
const panelIds = [...metaBlock.matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map(m => m[1]);

test('the frontend actually has a plugin table to compare against', () => {
  assert.ok(panelIds.length > 15, `found only ${panelIds.length} panels — the parse is wrong`);
});

test('every plugin has a Tools menu item', () => {
  const missing = panelIds.filter(p => !menuIds.includes(p));
  assert.deepEqual(missing, [],
    'add these to the Tools submenu in src-tauri/src/lib.rs — a menu that silently '
    + 'lacks a plugin is the gap the menu was added to close');
});

test('every Tools menu item names a plugin that exists', () => {
  const unknown = menuIds.filter(m => !panelIds.includes(m));
  assert.deepEqual(unknown, [],
    'these menu items open nothing — the frontend ignores an unknown panel id, so a '
    + 'renamed panel leaves a dead item behind rather than an error');
});

test('menu ids are unique', () => {
  assert.equal(new Set(menuIds).size, menuIds.length);
});

test('every Tools menu item has a bundled icon PNG', () => {
  // The native menu shows the same PNG the frontend's <PanelIcon> renders
  // (src/assets/icons/plugins, embedded via include_bytes! in lib.rs) — a
  // panel without one would build a menu item with no icon, which is exactly
  // the emoji/tofu regression the raster icons fixed. `scratch` is not a
  // plugin panel but carries an icon too (the DuckDB mark).
  const missing = [...menuIds, 'scratch'].filter(id =>
    !existsSync(join(ROOT, 'src/assets/icons/plugins', `${id}.png`)));
  assert.deepEqual(missing, [],
    'add these PNGs — six of the stroke fallback icons are baked by '
    + 'dev/rasterize_panel_icons.mjs, the rest are the bundled Noto set');
});

test('the native Tools submenus mirror PLUGIN_MENU group for group', () => {
  // The Rust side builds one `let m_<name> = SubmenuBuilder::new(app,
  // "<label>")…build()?;` per plugin-menu group; item references are the
  // `t_<panel>` variables, so the panel order inside each submenu is readable
  // straight from the builder chain. The scratch buffer sits above the
  // groups and is not part of this comparison.
  const groups = [...rust.matchAll(
    /let m_\w+ = SubmenuBuilder::new\(app, "([^"]+)"\)([\s\S]*?)\.build\(\)\?;/g,
  )].map(m => ({
    label: m[1],
    panels: [...m[2].matchAll(/\.item\(&t_([a-z]+)\)/g)].map(x => x[1]),
  }));
  assert.deepEqual(groups.map(g => g.label), PLUGIN_MENU.map(g => g.label),
    'submenu labels/order drifted from PLUGIN_MENU');
  for (let i = 0; i < PLUGIN_MENU.length; i++) {
    assert.deepEqual(groups[i]?.panels, PLUGIN_MENU[i].items.map(it => it.panel),
      `submenu "${groups[i]?.label}" items drifted from PLUGIN_MENU group "${PLUGIN_MENU[i].id}"`);
  }
});

test('the menu goes through the same opener as the plugin bar', () => {
  // Not a second way of opening a panel with its own rules: one already open
  // is focused rather than duplicated, and the engine and privilege gates are
  // the ones the bar already applies.
  assert.match(rust, /dbgui:open-tool/);
  assert.match(tabs, /dbgui:toggle-panel/);
  // The handlers read their gates through the listener env ref (WP-14 14.8),
  // so the spellings carry an `env().` prefix — the gates themselves are
  // unchanged.
  assert.match(tabs, /if \(env\(\)\.panelBlocked\(panel\)\) return;/);
  assert.match(tabs, /if \(cap && !can\(env\(\)\.engine, cap\)\) return;/);
});

test('every gated panel names an engine capability the table knows', () => {
  const capBlock = /const PANEL_ENGINE_CAP[^{]*\{([\s\S]*?)\n\};/.exec(tabs)![1];
  const caps = [...capBlock.matchAll(/:\s*'([a-zA-Z]+)'/g)].map(m => m[1]);
  const engineCaps = readFileSync(join(ROOT, 'src/utils/engineCaps.ts'), 'utf8');
  for (const c of caps) {
    assert.match(engineCaps, new RegExp(`\\b${c}\\??:`), `${c} is not a capability in engineCaps`);
  }
});
