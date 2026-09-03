/**
 * Connect-timeout preference (src/store/preferences.ts).
 *
 * The behaviour this pins: a default short enough that an unreachable host
 * fails fast. It used to be unbounded, so connecting to a machine that was off
 * sat on the OS's TCP retries for well over a minute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PREFS } from '../src/store/preferences.ts';

test('the default connect timeout is 5 seconds', () => {
  assert.equal(PREFS.connectTimeoutSecs.default, 5);
});

test('a missing or unparseable stored value falls back to the default', () => {
  const spec = PREFS.connectTimeoutSecs;
  assert.equal(spec.parse(null), 5);
  assert.equal(spec.parse('not a number'), 5);
  // A stored value is honoured as-is; the backend clamps the extremes.
  assert.equal(spec.parse('30'), 30);
  assert.equal(spec.serialize(12), '12');
});

test('an unset numeric preference is its default, not zero', () => {
  // The bug: Number(null) and Number('') are both 0, and 0 is finite — so a
  // preference that had never been set parsed to 0. On a fresh install that
  // silently meant "no row limit" and "prod cap off".
  for (const spec of [PREFS.defaultLimit, PREFS.prodRowCap, PREFS.appFontSize,
                      PREFS.connectTimeoutSecs]) {
    assert.equal(spec.parse(null), spec.default, `${spec.key} from null`);
    assert.equal(spec.parse(''), spec.default, `${spec.key} from ""`);
    assert.equal(spec.parse('   '), spec.default, `${spec.key} from whitespace`);
  }
  // A stored 0 is still honoured — it is a meaningful value for these
  // (no limit / cap off), just not the *absence* of one.
  assert.equal(PREFS.defaultLimit.parse('0'), 0);
  assert.equal(PREFS.prodRowCap.parse('0'), 0);
});
