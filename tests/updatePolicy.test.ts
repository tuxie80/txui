import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUpdate, selectUpdateCandidates, updateAction } from '../src/utils/updatePolicy.ts';

// The full policy matrix: every version-delta class × both Settings prefs
// on/off, plus the cases that must never act — equal, downgrade, garbage.

test('classifyUpdate: the four classes', () => {
  assert.equal(classifyUpdate('1.1.0', '1.1.1'), 'patch');
  assert.equal(classifyUpdate('1.1.0', '1.2.0'), 'minor');
  assert.equal(classifyUpdate('1.1.0', '2.0.0'), 'major');
  assert.equal(classifyUpdate('1.1.0', '1.1.0'), 'none');
});

test('classifyUpdate: multi-level jumps take the highest class', () => {
  assert.equal(classifyUpdate('1.1.0', '1.2.3'), 'minor');
  assert.equal(classifyUpdate('1.1.0', '2.5.7'), 'major');
});

test('classifyUpdate: a downgrade or equal is none — never auto-act backwards', () => {
  assert.equal(classifyUpdate('1.2.0', '1.1.9'), 'none');
  assert.equal(classifyUpdate('2.0.0', '1.9.9'), 'none');
  assert.equal(classifyUpdate('1.1.1', '1.1.0'), 'none');
});

test('classifyUpdate: prerelease/build tags and a leading v are ignored', () => {
  assert.equal(classifyUpdate('1.1.0', '1.2.0-rc.1'), 'minor');
  assert.equal(classifyUpdate('1.1.0', 'v2.0.0+build.5'), 'major');
  assert.equal(classifyUpdate('v1.1.0', 'v1.1.0'), 'none');
});

test('classifyUpdate: an unparsable version is none, never a guess', () => {
  assert.equal(classifyUpdate('1.1.0', 'latest'), 'none');
  assert.equal(classifyUpdate('', '1.2.0'), 'none');
  assert.equal(classifyUpdate('1.1', '1.2.0'), 'none');
  assert.equal(classifyUpdate('1.1.0', '1.2'), 'none');
});

test('updateAction: nothing to do is ignored, whichever the prefs', () => {
  assert.equal(updateAction('none', { minor: true, major: true }), 'ignore');
  assert.equal(updateAction('none', { minor: false, major: false }), 'ignore');
});

test('updateAction: patch and minor follow the minor pref', () => {
  for (const cls of ['patch', 'minor'] as const) {
    assert.equal(updateAction(cls, { minor: true, major: false }), 'auto');
    assert.equal(updateAction(cls, { minor: true, major: true }), 'auto');
    assert.equal(updateAction(cls, { minor: false, major: true }), 'notify');
    assert.equal(updateAction(cls, { minor: false, major: false }), 'notify');
  }
});

test('updateAction: major follows only the major pref', () => {
  assert.equal(updateAction('major', { minor: true, major: true }), 'auto');
  assert.equal(updateAction('major', { minor: false, major: true }), 'auto');
  assert.equal(updateAction('major', { minor: true, major: false }), 'notify');
  assert.equal(updateAction('major', { minor: false, major: false }), 'notify');
});

// The pipeline as App.tsx drives it, end to end.
test('the whole decision: 1.1.0 with default prefs', () => {
  const defaults = { minor: true, major: false };
  assert.equal(updateAction(classifyUpdate('1.1.0', '1.1.1'), defaults), 'auto');
  assert.equal(updateAction(classifyUpdate('1.1.0', '1.2.0'), defaults), 'auto');
  assert.equal(updateAction(classifyUpdate('1.1.0', '2.0.0'), defaults), 'notify');
  assert.equal(updateAction(classifyUpdate('1.1.0', '1.1.0'), defaults), 'ignore');
});

test('candidate selection keeps a branch update and a separate major offer', () => {
  const latest = { version: '2.0.0' };
  const branch = { version: '1.3.2' };
  assert.deepEqual(selectUpdateCandidates('1.3.1', latest, branch), {
    update: branch,
    major: latest,
  });
});

test('candidate selection never treats an older branch release as an update', () => {
  const latest = { version: '2.0.0' };
  const branch = { version: '1.3.0' };
  assert.deepEqual(selectUpdateCandidates('1.3.1', latest, branch), {
    update: latest,
    major: latest,
  });
});

test('candidate selection uses the latest same-branch release when no separate branch is needed', () => {
  const latest = { version: '1.3.2' };
  assert.deepEqual(selectUpdateCandidates('1.3.1', latest, null), {
    update: latest,
    major: null,
  });
});
