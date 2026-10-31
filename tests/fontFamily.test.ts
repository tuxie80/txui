import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_MONO_FONT, MONO_FONTS, monoFontStack } from '../src/utils/fontFamily.ts';
import { DEFAULT_SETTINGS, FONT_PRESETS } from '../src/store/gridSettings.ts';
import { PREFS } from '../src/store/preferences.ts';

test('TxUI Mono is the default code font everywhere', () => {
  assert.equal(DEFAULT_MONO_FONT, 'txui-mono');
  assert.equal(PREFS.monoFontFamily.default, 'txui-mono');
  assert.equal(DEFAULT_SETTINGS.fontFamily, "'TxUI Mono', monospace");
  assert.equal(FONT_PRESETS[0].value, "'TxUI Mono', monospace");
});

test('font choices have real stacks and unknown values fall back to TxUI Mono', () => {
  assert.equal(monoFontStack('jetbrains-mono'), "'JetBrains Mono', monospace");
  assert.equal(monoFontStack('not-a-font'), "'TxUI Mono', monospace");
  assert.ok(MONO_FONTS.some(font => font.id === 'txui-mono'));
});

test('the generated font and its OFL notice are shipped', () => {
  for (const weight of ['regular', 'medium', 'semibold', 'bold']) {
    const font = readFileSync(`src/assets/fonts/txui-mono-${weight}.woff2`);
    assert.ok(font.length > 1000, `${weight} font is unexpectedly small`);
    assert.equal(font.subarray(0, 4).toString('ascii'), 'wOF2');
  }
  const license = readFileSync('src/assets/fonts/OFL-TxUI-Mono.txt', 'utf8');
  assert.ok(license.includes('Copyright 2023 The Victor Mono Project Authors'));
  assert.ok(license.includes('SIL OPEN FONT LICENSE Version 1.1'));
  assert.ok(license.includes('TxUI Mono is a derivative of Victor Mono'));
});

test('Settings exposes the code font selector and license explanation', () => {
  const settings = readFileSync('src/components/SettingsModal.tsx', 'utf8');
  assert.ok(settings.includes('Code & data font'));
  assert.ok(settings.includes('FONT-LICENSES.md'));
  const css = readFileSync('src/App.css', 'utf8');
  assert.ok(css.includes("font-family: 'TxUI Mono'"));
});
