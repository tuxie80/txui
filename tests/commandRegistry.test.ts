/**
 * Editor command registry (src/utils/commandRegistry.ts).
 *
 * The registry is the addressable list behind the ⌘⇧P Find Action palette and
 * the future macro feature (§5.9): ids are a contract a macro records, so they
 * must be unique and stable, and the fuzzy selection that ranks them is the
 * same code the palette runs — tested here directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITOR_COMMANDS, formatKeys, searchCommands,
} from '../src/utils/commandRegistry.ts';

// ── ids: unique + stable ──────────────────────────────────────────────────────

test('every command id is unique', () => {
  const ids = EDITOR_COMMANDS.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every command id is namespaced under editor.', () => {
  // The namespace is the stable part a macro (§5.9) stores — a bare "run"
  // would collide the moment another surface registers commands.
  for (const c of EDITOR_COMMANDS) {
    assert.match(c.id, /^editor\.[a-zA-Z]/, `bad id: ${c.id}`);
  }
});

test('known command ids stay stable (renames break saved macros / keymaps)', () => {
  const ids = new Set(EDITOR_COMMANDS.map(c => c.id));
  for (const id of ['editor.run', 'editor.runAll', 'editor.explain',
    'editor.expandStar', 'editor.renameAlias', 'editor.format',
    'editor.sortLinesAsc', 'editor.zoomIn', 'editor.gotoLine']) {
    assert.ok(ids.has(id), `missing stable id: ${id}`);
  }
});

test('every command carries a non-empty label and category', () => {
  for (const c of EDITOR_COMMANDS) {
    assert.ok(c.label.trim().length > 0, `empty label: ${c.id}`);
    assert.ok(c.category.trim().length > 0, `empty category: ${c.id}`);
  }
});

// ── searchCommands: the palette's ranking ─────────────────────────────────────

test('an empty query returns the list unchanged, in registry order', () => {
  const out = searchCommands(EDITOR_COMMANDS, '');
  assert.deepEqual(out.map(c => c.id), EDITOR_COMMANDS.map(c => c.id));
});

test('a blank (whitespace) query is treated as empty', () => {
  assert.equal(searchCommands(EDITOR_COMMANDS, '   ').length, EDITOR_COMMANDS.length);
});

test('a subsequence query ranks the best label match first', () => {
  assert.equal(searchCommands(EDITOR_COMMANDS, 'expand')[0].id, 'editor.expandStar');
  assert.equal(searchCommands(EDITOR_COMMANDS, 'rename')[0].id, 'editor.renameAlias');
});

test('non-matching entries are filtered out', () => {
  const out = searchCommands(EDITOR_COMMANDS, 'zoom');
  assert.ok(out.length > 0);
  assert.ok(out.every(c => c.id.startsWith('editor.zoom')));
});

test('a query that matches nothing yields no results', () => {
  assert.equal(searchCommands(EDITOR_COMMANDS, 'qqzzxx').length, 0);
});

test('a label match outranks a keywords-only (category) match', () => {
  const items = [
    { label: 'Aardvark', keywords: 'Lines' },   // only the category says "lines"
    { label: 'Sort lines', keywords: 'Misc' },  // the name itself says "lines"
  ];
  const out = searchCommands(items, 'lines');
  assert.equal(out[0].label, 'Sort lines');
  assert.equal(out.length, 2); // the category hit still counts, just ranked lower
});

test('a keywords match surfaces an item whose label does not match', () => {
  const items = [{ label: 'Trim trailing whitespace', keywords: 'Lines' }];
  assert.equal(searchCommands(items, 'lines').length, 1);
});

// ── formatKeys: platform-correct key labels ───────────────────────────────────

test('mac renders glyphs with no separator; ordering is mod, alt, shift', () => {
  assert.equal(formatKeys('Mod-Shift-8', 'mac'), '⌘⇧8');
  assert.equal(formatKeys('Mod-Alt-Shift-s', 'mac'), '⌘⌥⇧S');
  assert.equal(formatKeys('Mod-Enter', 'mac'), '⌘↵');
  assert.equal(formatKeys('Alt-ArrowUp', 'mac'), '⌥↑');
});

test('windows / linux spell modifiers and join with +', () => {
  assert.equal(formatKeys('Mod-Shift-8', 'windows'), 'Ctrl+Shift+8');
  assert.equal(formatKeys('Mod-e', 'linux'), 'Ctrl+E');
});

test('a bare function key has no modifiers', () => {
  assert.equal(formatKeys('F12', 'mac'), 'F12');
  assert.equal(formatKeys('Shift-F6', 'mac'), '⇧F6');
});

test('single-letter keys are upper-cased for display', () => {
  assert.equal(formatKeys('Mod-e', 'mac'), '⌘E');
  assert.equal(formatKeys('Mod-j', 'mac'), '⌘J');
});

test('every keybinding in the registry renders without throwing', () => {
  for (const c of EDITOR_COMMANDS) {
    if (!c.keys) continue;
    assert.ok(formatKeys(c.keys, 'mac').length > 0, `unrenderable: ${c.keys}`);
    assert.ok(formatKeys(c.keys, 'windows').length > 0, `unrenderable: ${c.keys}`);
  }
});
