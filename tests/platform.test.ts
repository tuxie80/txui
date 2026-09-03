/**
 * Platform differences (src/utils/platform.ts).
 *
 * The bindings were always portable; what was not was everything the app says
 * and shows. A shortcut label reading `⌘↵` on Windows is not a cosmetic bug —
 * it is an instruction the user cannot follow, with nothing on screen to
 * suggest the app is at fault rather than them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPlatform, keyLabels, shortcut, runKey, basename, dirname,
  supportsUnixSocket, defaultEol, shortcuts,
} from '../src/utils/platform.ts';

// Real user-agent strings from the three webviews.
const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// ── detection ───────────────────────────────────────────────────────────────

test('each webview is recognised from its real user-agent', () => {
  assert.equal(detectPlatform(UA.mac), 'mac');
  assert.equal(detectPlatform(UA.windows), 'windows');
  assert.equal(detectPlatform(UA.linux), 'linux');
});

test('Windows is checked before Mac', () => {
  // WebView2 is Chromium, and a Chromium UA can carry "Macintosh"-shaped
  // tokens in odd builds. Windows must win outright.
  assert.equal(detectPlatform('Windows NT 10.0; Macintosh'), 'windows');
});

test('an unknown user-agent falls back to linux, not mac', () => {
  // A wrong `Ctrl` on a Mac is mildly annoying. A wrong `⌘` anywhere else is
  // an instruction nobody can carry out.
  assert.equal(detectPlatform(''), 'linux');
  assert.equal(detectPlatform('something else entirely'), 'linux');
});

// ── shortcut labels ─────────────────────────────────────────────────────────

test('macOS uses glyphs with no separator', () => {
  assert.equal(shortcut('Enter', {}, 'mac'), '⌘↵');
  assert.equal(shortcut('F', { shift: true }, 'mac'), '⌘⇧F');
  assert.equal(shortcut('Up', { alt: true, shift: true }, 'mac'), '⌘⌥⇧Up');
});

test('Windows and Linux spell them out and join with +', () => {
  assert.equal(shortcut('Enter', {}, 'windows'), 'Ctrl+Enter');
  assert.equal(shortcut('F', { shift: true }, 'windows'), 'Ctrl+Shift+F');
  assert.equal(shortcut('F', { shift: true }, 'linux'), 'Ctrl+Shift+F');
});

test('a shortcut without the mod key omits it', () => {
  assert.equal(shortcut('F2', { mod: false }, 'mac'), 'F2');
  assert.equal(shortcut('F2', { mod: false }, 'windows'), 'F2');
});

test('shortcuts are built from parts, never by rewriting a ⌘ string', () => {
  // The reason this takes parts: a find-and-replace over display strings gets
  // `Ctrl+⇧F` wrong on the first two-modifier shortcut it meets.
  const win = shortcut('F', { shift: true }, 'windows');
  assert.ok(!win.includes('⇧'), win);
  assert.ok(!win.includes('⌘'), win);
});

test('the run shortcut is right on every platform', () => {
  assert.equal(runKey('mac'), '⌘↵');
  assert.equal(runKey('windows'), 'Ctrl+Enter');
  assert.equal(runKey('linux'), 'Ctrl+Enter');
});

test('the label set is complete for every platform', () => {
  for (const p of ['mac', 'windows', 'linux'] as const) {
    const l = keyLabels(p);
    for (const [k, v] of Object.entries(l)) {
      if (k === 'sep') continue;
      assert.ok(v.length > 0, `${p}.${k} is empty`);
    }
  }
});

// ── paths ───────────────────────────────────────────────────────────────────

test('basename handles both separators', () => {
  // A save dialog on Windows returns a backslash path, so `split('/')` printed
  // the whole thing in every "Saved …" toast.
  assert.equal(basename('/Users/j/reports/q.csv'), 'q.csv');
  assert.equal(basename('C:\\Users\\j\\reports\\q.csv'), 'q.csv');
  // Windows accepts forward slashes too, and mixed paths do occur.
  assert.equal(basename('C:/Users/j/q.csv'), 'q.csv');
  assert.equal(basename('C:\\Users/j\\q.csv'), 'q.csv');
});

test('basename copes with trailing separators and bare names', () => {
  assert.equal(basename('/a/b/'), 'b');
  assert.equal(basename('C:\\a\\b\\'), 'b');
  assert.equal(basename('q.csv'), 'q.csv');
  assert.equal(basename(''), '');
});

test('a filename containing a space or dot survives', () => {
  assert.equal(basename('C:\\my reports\\2026.08 sales.csv'), '2026.08 sales.csv');
});

test('dirname is the mirror of basename', () => {
  assert.equal(dirname('/Users/j/q.csv'), '/Users/j');
  assert.equal(dirname('C:\\Users\\j\\q.csv'), 'C:\\Users\\j');
  assert.equal(dirname('q.csv'), '');
  assert.equal(dirname('/q.csv'), '/');
});

// ── capabilities ────────────────────────────────────────────────────────────

test('Unix sockets are offered everywhere except Windows', () => {
  // MySQL there uses a named pipe and PostgreSQL is TCP-only, so the field can
  // only ever produce an obscure connect error.
  assert.equal(supportsUnixSocket('mac'), true);
  assert.equal(supportsUnixSocket('linux'), true);
  assert.equal(supportsUnixSocket('windows'), false);
});

test('the default line ending follows the platform', () => {
  assert.equal(defaultEol('windows'), '\r\n');
  assert.equal(defaultEol('mac'), '\n');
  assert.equal(defaultEol('linux'), '\n');
});

// ── the label table ─────────────────────────────────────────────────────────

test('every label is free of Mac glyphs on Windows and Linux', () => {
  // The whole point: a label that slips through with a ⌘ in it is an
  // instruction a Windows user cannot follow.
  for (const p of ['windows', 'linux'] as const) {
    for (const [name, label] of Object.entries(shortcuts(p))) {
      assert.ok(!/[⌘⇧⌥↵]/.test(label), `${p}.${name} still shows a Mac glyph: ${label}`);
    }
  }
});

test('macOS keeps its glyphs', () => {
  const m = shortcuts('mac');
  assert.equal(m.run, '⌘↵');
  assert.equal(m.format, '⌘⇧F');
  assert.equal(m.wrap, '⌥Z');
  assert.equal(m.clickOpen, '⌘-click');
});

test('the Windows spellings are the ones people expect', () => {
  const w = shortcuts('windows');
  assert.equal(w.run, 'Ctrl+Enter');
  assert.equal(w.runAll, 'Ctrl+Shift+Enter');
  assert.equal(w.format, 'Ctrl+Shift+F');
  assert.equal(w.wrap, 'Alt+Z');
  assert.equal(w.clickOpen, 'Ctrl+click');
  assert.equal(w.shiftEnter, 'Shift+Enter');
});

test('no label is empty on any platform', () => {
  for (const p of ['mac', 'windows', 'linux'] as const) {
    for (const [name, label] of Object.entries(shortcuts(p))) {
      assert.ok(label.length > 0, `${p}.${name} is empty`);
    }
  }
});
