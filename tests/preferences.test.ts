/**
 * Preference specs (src/store/preferences.ts).
 *
 * Only the pure half is exercised here: each spec's parse/serialize pair. That
 * is where the damage happens — a preference that mis-parses "absent" silently
 * turns a safety default off (a `defaultLimit` of 0 means no row cap at all),
 * and nothing in the UI announces it. `getPref`/`usePreference` need
 * localStorage and React, so they belong in a browser test, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PREFS } from '../src/store/preferences.ts';

/** Absent must mean the default for every preference, without exception. */
test('every preference falls back to its default when unset', () => {
  for (const [name, spec] of Object.entries(PREFS)) {
    assert.deepEqual(spec.parse(null), spec.default, `${name} mis-parses absent`);
  }
});

test('every preference round-trips through serialize', () => {
  for (const [name, spec] of Object.entries(PREFS)) {
    const raw = spec.serialize(spec.default as never);
    assert.equal(typeof raw, 'string', `${name} does not serialize to a string`);
    assert.deepEqual(spec.parse(raw), spec.default, `${name} does not round-trip`);
  }
});

// ── numbers ─────────────────────────────────────────────────────────────────

test('a numeric preference treats blank and garbage as unset', () => {
  // Number('') is 0, and 0 is finite — the trap that once turned the row cap off.
  for (const raw of ['', '   ', 'abc', 'NaN']) {
    assert.equal(PREFS.defaultLimit.parse(raw), PREFS.defaultLimit.default,
      `${JSON.stringify(raw)} was not treated as unset`);
  }
  assert.equal(PREFS.defaultLimit.parse('0'), 0, 'an explicit 0 must be honoured');
  assert.equal(PREFS.defaultLimit.parse('500'), 500);
});

// ── booleans ────────────────────────────────────────────────────────────────

test('a boolean preference reads only "1" as true', () => {
  assert.equal(PREFS.beepOnLongQuery.parse('1'), true);
  assert.equal(PREFS.beepOnLongQuery.parse('0'), false);
  assert.equal(PREFS.beepOnLongQuery.parse('true'), false);
});

// ── constrained strings ─────────────────────────────────────────────────────

test('a choice preference rejects values outside its set', () => {
  assert.equal(PREFS.scriptErrorMode.parse('stop'), 'stop');
  assert.equal(PREFS.scriptErrorMode.parse('ask'), 'ask');
  assert.equal(PREFS.scriptErrorMode.parse('ignore'), PREFS.scriptErrorMode.default);
  assert.equal(PREFS.scriptErrorMode.parse(''), PREFS.scriptErrorMode.default);
});

// ── free text ───────────────────────────────────────────────────────────────

test('the SQL delimiter never comes back empty', () => {
  // An empty delimiter matches at every offset and would split a script into
  // nothing, so blank has to mean "unset" rather than "no terminator".
  for (const raw of ['', '   ', '\t\n']) {
    assert.equal(PREFS.sqlDelimiter.parse(raw), ';',
      `${JSON.stringify(raw)} did not fall back to ;`);
  }
  assert.equal(PREFS.sqlDelimiter.parse('/'), '/');
  assert.equal(PREFS.sqlDelimiter.parse('GO'), 'GO');
  assert.equal(PREFS.sqlDelimiter.parse('$$'), '$$');
});

// ── the defaults the user asked for ─────────────────────────────────────────

test('the shipped defaults are the documented ones', () => {
  assert.equal(PREFS.beepOnLongQuery.default, true);
  assert.equal(PREFS.longQueryBeepSecs.default, 60);
  assert.equal(PREFS.sqlDelimiter.default, ';');
  assert.equal(PREFS.scriptErrorMode.default, 'ask');
});
