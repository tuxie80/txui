/**
 * The editor caret color is DERIVED from the theme kind (dark/light), never
 * per-theme data — this pins both values and the derivation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorColor, THEMES } from '../src/utils/themes.ts';

test('dark themes get the bright orange caret, light themes the deep one', () => {
  assert.equal(cursorColor(true), '#ffa94d');
  assert.equal(cursorColor(false), '#c2500a');
});

test('every shipped theme is one kind or the other (derivation covers all)', () => {
  for (const t of THEMES) assert.equal(typeof t.dark, 'boolean');
  assert.ok(THEMES.some(t => t.dark) && THEMES.some(t => !t.dark),
    'both branches of cursorColor ship');
});
