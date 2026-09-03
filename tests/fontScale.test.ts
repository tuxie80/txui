/**
 * App font-size clamping (src/utils/fontScale.ts) — the Settings stepper and
 * the --font-scale computation both rely on clampFontSize staying inside
 * 10–20 with whole-pixel steps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_BASE,
} from '../src/utils/fontScale.ts';

test('values inside the range pass through unchanged', () => {
  assert.equal(clampFontSize(13), 13);
  assert.equal(clampFontSize(FONT_SIZE_MIN), FONT_SIZE_MIN);
  assert.equal(clampFontSize(FONT_SIZE_MAX), FONT_SIZE_MAX);
});

test('out-of-range values clamp to the bounds', () => {
  assert.equal(clampFontSize(5), FONT_SIZE_MIN);
  assert.equal(clampFontSize(9.9), FONT_SIZE_MIN);
  assert.equal(clampFontSize(99), FONT_SIZE_MAX);
  assert.equal(clampFontSize(-3), FONT_SIZE_MIN);
});

test('fractional values snap to whole pixels (step 1)', () => {
  assert.equal(clampFontSize(13.4), 13);
  assert.equal(clampFontSize(13.5), 14);
});

test('non-finite input falls back to the base size', () => {
  assert.equal(clampFontSize(NaN), FONT_SIZE_BASE);
  assert.equal(clampFontSize(Infinity), FONT_SIZE_BASE);
  assert.equal(clampFontSize(-Infinity), FONT_SIZE_BASE);
});
