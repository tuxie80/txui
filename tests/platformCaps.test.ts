/**
 * Platform feature availability (src/utils/platformCaps.ts).
 *
 * The rule this file defends: an unavailable feature is *shown, greyed and
 * explained*, and the explanation must be true. Telling a Windows user that
 * Unix sockets are "not implemented yet" invites them back next release to
 * check on something that is never coming; telling them the SSH tunnel is
 * "not available on Windows" full stop hides the fact that it is only
 * unwritten. The two wordings are the feature.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_FEATURES, availability, available, osName, tipFor,
  unavailableTip, unavailableProps, unavailableHere,
} from '../src/utils/platformCaps.ts';
import type { PlatformFeature } from '../src/utils/platformCaps.ts';
import { setPlatformForTests } from '../src/utils/platform.ts';

// ── the table ───────────────────────────────────────────────────────────────

test('ids are unique', () => {
  const ids = PLATFORM_FEATURES.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every feature works somewhere and is missing somewhere', () => {
  // A feature available on all three is not a platform gap and only adds a
  // row nobody reads; one available on none is not a platform gap either —
  // it is an unimplemented feature, which is a different conversation.
  for (const f of PLATFORM_FEATURES) {
    assert.ok(f.on.length > 0 && f.on.length < 3, `${f.id} is not platform-bound`);
  }
});

test('every reason is a lower-case clause with no trailing stop', () => {
  // The tip composes these into a sentence; a capital or a full stop mid-way
  // reads as two sentences jammed together.
  for (const f of PLATFORM_FEATURES) {
    assert.doesNotMatch(f.why, /\.$/, `${f.id} why ends with a stop`);
    assert.match(f.why, /^[a-z(]/, `${f.id} why starts upper-case`);
    if (f.instead) assert.doesNotMatch(f.instead, /\.$/, `${f.id} instead ends with a stop`);
  }
});

// ── availability ────────────────────────────────────────────────────────────

test('the table is empty of `todo` entries, and that is a claim', () => {
  // Every remaining gap is one the operating system will never close. If a
  // `todo` appears here again it is a promise to somebody, and the wording
  // rules below are what keep it honest.
  assert.deepEqual(PLATFORM_FEATURES.filter(f => f.kind === 'todo'), []);
});

test('Unix sockets are not applicable on Windows, not unwritten', () => {
  assert.equal(availability('unix-socket', 'windows'), 'na');
  assert.ok(available('unix-socket', 'linux'));
});

test('available() agrees with availability()', () => {
  for (const f of PLATFORM_FEATURES) {
    for (const p of ['mac', 'windows', 'linux'] as const) {
      assert.equal(available(f.id, p), availability(f.id, p) === 'ok');
    }
  }
});

// ── wording ─────────────────────────────────────────────────────────────────

test('an available feature has no tip and keeps the caller\'s props intact', () => {
  assert.equal(unavailableTip('unix-socket', 'mac'), null);
  assert.deepEqual(
    unavailableProps('unix-socket', { className: 'form-section', tip: 'Unix socket path' }, 'mac'),
    { className: 'form-section', 'data-tip': 'Unix socket path' },
  );
  assert.deepEqual(unavailableProps('unix-socket', {}, 'mac'), {});
});

/** A `todo` feature, so the wording rule stays tested with none in the table. */
const UNWRITTEN: PlatformFeature = {
  id: 'example', label: 'Example feature', on: ['mac', 'linux'], kind: 'todo',
  why: 'nobody has written the Windows half', instead: 'do it by hand meanwhile',
};

test('only the unwritten one says "yet"', () => {
  const todo = tipFor(UNWRITTEN, 'windows');
  const na = unavailableTip('unix-socket', 'windows')!;
  assert.match(todo, /not implemented on Windows yet/);
  assert.doesNotMatch(na, /yet/);
  assert.match(na, /not available on Windows/);
});

test('the tip names the feature, the OS, the obstacle and the way round it', () => {
  const tip = tipFor(UNWRITTEN, 'windows');
  assert.match(tip, /^Example feature/);
  assert.match(tip, /Windows/);
  assert.match(tip, /nobody has written the Windows half/);
  assert.match(tip, /Do it by hand meanwhile\./);
});

test('every tip on every platform is a complete sentence', () => {
  for (const f of PLATFORM_FEATURES) {
    for (const p of ['mac', 'windows', 'linux'] as const) {
      const tip = unavailableTip(f.id, p);
      if (tip === null) continue;
      assert.match(tip, /\.$/, `${f.id}/${p} tip does not end in a stop`);
      assert.ok(tip.startsWith(f.label), `${f.id}/${p} tip does not lead with the label`);
    }
  }
});

test('the OS is named the way its users name it', () => {
  assert.equal(osName('mac'), 'macOS');
  assert.equal(osName('windows'), 'Windows');
  assert.equal(osName('linux'), 'Linux');
});

// ── props ───────────────────────────────────────────────────────────────────

test('props grey the control without disabling it', () => {
  // `disabled` would suppress the pointer events the tooltip is delivered by,
  // so the control would go grey and refuse to say why — the exact failure
  // this module exists to prevent.
  const p = unavailableProps('unix-socket', {}, 'windows');
  assert.equal(p.className, 'unavail');
  assert.equal(p['aria-disabled'], true);
  assert.equal(p['data-tip'], unavailableTip('unix-socket', 'windows'));
  assert.ok(!('disabled' in p));
});

test('the base class is kept and the reason wins over the ordinary tooltip', () => {
  // Replacing the caller's class would strip the control's own styling, and
  // letting the ordinary tip survive would grey it while explaining nothing.
  const p = unavailableProps('unix-socket', { className: 'form-section', tip: 'Unix socket path' }, 'windows');
  assert.equal(p.className, 'form-section unavail');
  assert.match(p['data-tip']!, /not available on Windows/);
});

test('unavailableHere lists exactly what this desktop lacks', () => {
  assert.deepEqual(unavailableHere('mac'), []);
  assert.deepEqual(unavailableHere('linux'), []);
  assert.deepEqual(
    unavailableHere('windows').map(f => f.id),
    ['unix-socket', 'mydumper'],
  );
});

// ── the default argument ────────────────────────────────────────────────────

test('with no platform argument it reads the running one', () => {
  setPlatformForTests('windows');
  try {
    assert.equal(availability('unix-socket'), 'na');
    assert.match(unavailableTip('unix-socket')!, /Windows/);
    assert.equal(osName(), 'Windows');
  } finally {
    setPlatformForTests(null);
  }
});
