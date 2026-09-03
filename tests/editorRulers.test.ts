/**
 * Vertical rulers (src/components/editorRulers.ts).
 *
 * The plugin's DOM work needs a browser, but the load-bearing arithmetic — the
 * pixel x of each ruler column — is the pure `rulerOffsets`. The editor is
 * monospaced, so a column sits at `paddingLeft + column × charWidth`; these
 * pin that formula so a font/padding change can't silently shift the guides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulerOffsets } from '../src/components/editorRulers.ts';

test('each column maps to paddingLeft + column × charWidth', () => {
  // 8px glyphs, 6px left padding — the CodeMirror default line padding.
  assert.deepEqual(rulerOffsets([80, 120], 8, 6), [646, 966]);
});

test('the padding shifts every ruler by the same amount', () => {
  const noPad = rulerOffsets([80, 120], 8, 0);
  const withPad = rulerOffsets([80, 120], 8, 6);
  assert.deepEqual(noPad, [640, 960]);
  assert.deepEqual(withPad.map(x => x - 6), noPad);
});

test('one offset per input column, in the same order', () => {
  const offs = rulerOffsets([120, 80, 100], 10, 4);
  assert.equal(offs.length, 3);
  assert.deepEqual(offs, [1204, 804, 1004]);
});

test('a fractional character width is not rounded away', () => {
  // Real glyph widths are rarely whole pixels; the offset must keep the decimal
  // so 80 columns don't drift a pixel per handful of characters.
  assert.deepEqual(rulerOffsets([80], 7.5, 6), [606]);
});

test('an empty column list yields no offsets', () => {
  assert.deepEqual(rulerOffsets([], 8, 6), []);
});
