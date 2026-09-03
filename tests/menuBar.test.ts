/**
 * The menu bar is File, Edit, View, Tools, Help — on every platform.
 *
 * That order is thirty years old and users navigate it without reading. TxUI
 * had drifted off it: macOS got no File menu at all (its items had been folded
 * into the application menu) and no Help menu, so two of the five places a
 * person looks for something were simply absent there.
 *
 * The other half of the rule is that **every item does something**. A menu is
 * the surface a user is entitled to assume is complete and live; one dead
 * entry teaches them the whole menu is decorative. So each item's id must be
 * dispatched in Rust and handled in the frontend, and this test walks that
 * chain rather than trusting it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const rust = readFileSync(join(ROOT, 'src-tauri/src/lib.rs'), 'utf8');
const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
const tabs = readFileSync(join(ROOT, 'src/components/QueryTabs.tsx'), 'utf8');

/** Submenu titles in the order `MenuBuilder` receives them. */
function menuOrder(): string[] {
  // The bar is built as `let mb = mb .item(&file_menu) …`. macOS prepends its
  // application menu in a separate, cfg-gated `let mb = mb.item(&app_menu);`
  // — that one is the platform's rule, not part of the classical five, so the
  // chain wanted here is specifically the one carrying File.
  const chain = /let mb = mb\s*((?:\s*\.item\(&\w+_menu\))*\.item\(&file_menu\)[\s\S]*?);/.exec(rust)
    ?? /let mb = mb\s*([\s\S]*?\.item\(&help_menu\))/.exec(rust);
  assert.ok(chain, 'could not find the menu-bar builder chain in lib.rs');
  return [...chain[1].matchAll(/\.item\(&(\w+)_menu\)/g)].map(m => m[1]);
}

test('the five menus are in the classical order', () => {
  assert.deepEqual(menuOrder(), ['file', 'edit', 'view', 'tools', 'help']);
});

test('File and Help are built unconditionally, not only off macOS', () => {
  // The regression this pins: `#[cfg(not(target_os = "macos"))]` on the menu
  // itself, which is how macOS ended up with neither.
  for (const name of ['file_menu', 'help_menu']) {
    const decl = new RegExp(`(.{80})let ${name} =`, 's').exec(rust);
    assert.ok(decl, `${name} is not declared`);
    assert.doesNotMatch(decl[1], /#\[cfg\(not\(target_os = "macos"\)\)\]\s*$/,
      `${name} is gated off macOS — every platform gets all five menus`);
  }
});

test('every File and Help item is dispatched by the Rust menu handler', () => {
  const ids = [...rust.matchAll(/with_id\("((?:file|help):[a-z-]+)"/g)].map(m => m[1]);
  assert.ok(ids.length >= 5, `expected a populated File/Help menu, found ${ids.length} items`);

  // One arm forwards the whole family, so what has to exist is that arm.
  assert.match(rust, /strip_prefix\("file:"\)[\s\S]{0,120}strip_prefix\("help:"\)/,
    'File/Help item ids are built but nothing forwards them to the frontend');
  assert.match(rust, /dbgui:menu-action/, 'the forwarding event is missing');
});

test('every File and Help item is handled in the frontend', () => {
  const ids = [...rust.matchAll(/with_id\("((?:file|help):[a-z-]+)"/g)].map(m => m[1]);
  const handler = /listen<string>\('dbgui:menu-action'[\s\S]*?\n {2}\}, \[\]\);/.exec(app);
  assert.ok(handler, 'App.tsx does not listen for dbgui:menu-action');

  const unhandled = ids.filter(id => !handler[0].includes(`'${id}'`));
  assert.deepEqual(unhandled, [],
    'these menu items would do nothing when clicked — a dead menu entry is '
    + 'worse than a missing one');
});

test('the window events the File menu fans out to have listeners', () => {
  // App.tsx re-dispatches most File actions as the window event the in-app
  // control already uses. If that event has no listener the menu item is dead
  // in a way nothing else would reveal.
  const handler = /listen<string>\('dbgui:menu-action'[\s\S]*?\n {2}\}, \[\]\);/.exec(app)![0];
  const fired = [...handler.matchAll(/fire\('(dbgui:[a-z-]+)'/g)].map(m => m[1]);
  assert.ok(fired.length >= 5, `expected several re-dispatched events, found ${fired.length}`);

  const everywhere = app + tabs;
  // QueryTabs registers its global shortcuts through its guarded `on(...)`
  // wrapper (WP-14 14.8) — both spellings count as a listener.
  const orphans = fired.filter(ev =>
    !everywhere.includes(`addEventListener('${ev}'`) && !everywhere.includes(`on('${ev}'`));
  assert.deepEqual(orphans, [], 'these events are dispatched by the menu but nothing listens');
});
