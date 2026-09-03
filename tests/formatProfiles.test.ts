/**
 * Named formatting profiles (src/utils/formatProfiles.ts).
 *
 * A formatter that corrupts SQL is worse than one that formats it badly, so
 * the transforms here are held to the same rule as everything else in this
 * codebase: a comma inside `DECIMAL(10,2)` or inside a string is not a
 * separator, and re-indenting must not touch anything but leading whitespace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_PROFILES, DEFAULT_PROFILE_ID, indentOf, optionsFor,
  applyCommaStyle, applyIndent, applyProfile,
  loadProfiles, saveProfiles, activeProfile, setActiveProfile, duplicateProfile,
} from '../src/utils/formatProfiles.ts';
import type { FormatProfile } from '../src/utils/formatProfiles.ts';

const profile = (over: Partial<FormatProfile> = {}): FormatProfile => ({
  id: 'p', name: 'P', keywordCase: 'upper', indentWidth: 2,
  commaStyle: 'trailing', functionCase: 'preserve', preserveBlankLines: true,
  ...over,
});

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: k => { map.delete(k); },
    clear: () => map.clear(),
    key: i => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as Storage;
}

// ── the built-ins ───────────────────────────────────────────────────────────

test('the built-ins cover the styles that actually exist', () => {
  const ids = BUILT_IN_PROFILES.map(p => p.id);
  assert.ok(ids.includes(DEFAULT_PROFILE_ID));
  assert.ok(ids.includes('leading-comma'));
  assert.ok(ids.includes('lowercase'));
  assert.ok(ids.includes('tabs'));
  for (const p of BUILT_IN_PROFILES) {
    assert.equal(p.builtin, true, `${p.id} should be marked built-in`);
    assert.ok(p.name.length > 2, p.id);
  }
});

test('indent width 0 means a tab', () => {
  assert.equal(indentOf(profile({ indentWidth: 0 })), '\t');
  assert.equal(indentOf(profile({ indentWidth: 4 })), '    ');
});

test('a profile maps onto the beautifier options', () => {
  assert.deepEqual(optionsFor(profile({ keywordCase: 'lower' }), 'postgres'),
    { keywordCase: 'lower', engine: 'postgres' });
});

// ── indentation ─────────────────────────────────────────────────────────────

test('re-indenting converts levels, not arbitrary spaces', () => {
  const sql = 'SELECT\n  a,\n    b\nFROM t';
  assert.equal(applyIndent(sql, profile({ indentWidth: 4 })),
    'SELECT\n    a,\n        b\nFROM t');
  assert.equal(applyIndent(sql, profile({ indentWidth: 0 })),
    'SELECT\n\ta,\n\t\tb\nFROM t');
});

test('re-indenting leaves the default alone', () => {
  const sql = 'SELECT\n  a\nFROM t';
  assert.equal(applyIndent(sql, profile({ indentWidth: 2 })), sql);
});

test('re-indenting never touches anything but leading whitespace', () => {
  const sql = "SELECT\n  'a  b' AS x\nFROM t";
  const out = applyIndent(sql, profile({ indentWidth: 4 }));
  assert.ok(out.includes("'a  b'"), 'spaces inside a literal were changed');
});

// ── comma style ─────────────────────────────────────────────────────────────

test('leading commas move to the start of the next line', () => {
  const sql = 'SELECT\n  a,\n  b,\n  c\nFROM t';
  const out = applyCommaStyle(sql, 'leading');
  assert.match(out, /, b/);
  assert.match(out, /, c/);
  assert.ok(!/a,$/m.test(out), 'a trailing comma survived');
});

test('trailing style is a no-op', () => {
  const sql = 'SELECT\n  a,\n  b\nFROM t';
  assert.equal(applyCommaStyle(sql, 'trailing'), sql);
});

test('a comma that is not at end-of-line is left alone', () => {
  // `DECIMAL(10,2)` and `f(a, b)` are not list separators.
  const sql = 'SELECT CAST(x AS DECIMAL(10,2)), f(a, b)\nFROM t';
  const out = applyCommaStyle(sql, 'leading');
  assert.match(out, /DECIMAL\(10,2\)/);
  assert.match(out, /f\(a, b\)/);
});

test('a comma on the last line has nowhere to move and stays', () => {
  assert.equal(applyCommaStyle('SELECT a,', 'leading'), 'SELECT a,');
});

test('a blank line after a comma does not swallow the comma', () => {
  const sql = 'SELECT\n  a,\n\n  b';
  const out = applyCommaStyle(sql, 'leading');
  assert.ok(out.includes('a,'), 'the comma vanished into a blank line');
});

test('applyProfile runs both transforms', () => {
  const sql = 'SELECT\n  a,\n  b\nFROM t';
  const out = applyProfile(sql, profile({ indentWidth: 4, commaStyle: 'leading' }));
  assert.match(out, /^ {4}a$/m);
  assert.match(out, /, b/);
});

// ── storage ─────────────────────────────────────────────────────────────────

test('the built-ins are always present, even with empty storage', () => {
  const st = fakeStorage();
  assert.equal(loadProfiles(st).length, BUILT_IN_PROFILES.length);
});

test('custom profiles are stored alongside the built-ins', () => {
  const st = fakeStorage();
  const mine = profile({ id: 'mine', name: 'Mine' });
  saveProfiles([...BUILT_IN_PROFILES, mine], st);
  const all = loadProfiles(st);
  assert.equal(all.length, BUILT_IN_PROFILES.length + 1);
  assert.ok(all.some(p => p.id === 'mine'));
});

test('built-ins are never written to storage, so they can be changed in code', () => {
  const st = fakeStorage();
  saveProfiles(BUILT_IN_PROFILES, st);
  assert.equal(st.getItem('dbgui.formatProfiles'), '[]');
});

test('a custom profile cannot shadow a built-in', () => {
  const st = fakeStorage();
  st.setItem('dbgui.formatProfiles', JSON.stringify([profile({ id: 'default', name: 'Hijack' })]));
  const all = loadProfiles(st);
  assert.equal(all.filter(p => p.id === 'default').length, 1);
  assert.equal(all.find(p => p.id === 'default')?.name, 'TxUI default');
});

test('corrupt storage falls back to the built-ins rather than throwing', () => {
  const st = fakeStorage();
  st.setItem('dbgui.formatProfiles', 'not json');
  assert.equal(loadProfiles(st).length, BUILT_IN_PROFILES.length);
  st.setItem('dbgui.formatProfiles', '{"not":"array"}');
  assert.equal(loadProfiles(st).length, BUILT_IN_PROFILES.length);
});

test('the active profile falls back when it has been deleted', () => {
  const st = fakeStorage();
  setActiveProfile('gone', st);
  assert.equal(activeProfile(st).id, DEFAULT_PROFILE_ID);
  setActiveProfile('lowercase', st);
  assert.equal(activeProfile(st).id, 'lowercase');
});

test('duplicating a built-in produces an editable copy with a free id', () => {
  const base = BUILT_IN_PROFILES[0];
  const copy = duplicateProfile(base, BUILT_IN_PROFILES);
  assert.notEqual(copy.id, base.id);
  assert.equal(copy.builtin, false, 'a copy must be editable');
  assert.match(copy.name, /copy/);
  // A second copy must not collide with the first.
  const copy2 = duplicateProfile(base, [...BUILT_IN_PROFILES, copy]);
  assert.notEqual(copy2.id, copy.id);
});
