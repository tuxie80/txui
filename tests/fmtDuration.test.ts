import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtDuration, fmtDurationCompact } from '../src/utils/fmtDuration.ts';

test('sub-second stays in ms', () => {
  assert.equal(fmtDuration(0), '0 ms');
  assert.equal(fmtDuration(118), '118 ms');
  assert.equal(fmtDuration(999), '999 ms');
});

test('seconds carry a ms remainder', () => {
  assert.equal(fmtDuration(1524), '1 s 524 ms');
  assert.equal(fmtDuration(59_999), '59 s 999 ms');
});

test('whole seconds drop the ms part', () => {
  assert.equal(fmtDuration(1000), '1 s');
  assert.equal(fmtDuration(2000), '2 s');
  assert.equal(fmtDuration(10_000), '10 s');
});

test('minutes', () => {
  assert.equal(fmtDuration(123_000), '2 min 3 s');
  assert.equal(fmtDuration(60_000), '1 min');
  assert.equal(fmtDuration(3_600_000), '60 min');
});

test('input is rounded and clamped', () => {
  assert.equal(fmtDuration(118.4), '118 ms');
  assert.equal(fmtDuration(1524.6), '1 s 525 ms');
  assert.equal(fmtDuration(-5), '0 ms');
});

// ── fmtDurationCompact: the gutter-sized sibling (run markers) ───────────────

test('compact: sub-second carries the ms unit', () => {
  assert.equal(fmtDurationCompact(0), '0ms');
  assert.equal(fmtDurationCompact(412), '412ms');
  assert.equal(fmtDurationCompact(999), '999ms');
});

test('compact: seconds ALWAYS carry one decimal — the text never jumps shape', () => {
  assert.equal(fmtDurationCompact(1000), '1.0s');
  assert.equal(fmtDurationCompact(1524), '1.5s');
  assert.equal(fmtDurationCompact(5000), '5.0s', 'the owner’s case: 5s must read 5.0s');
  assert.equal(fmtDurationCompact(9999), '10.0s');
  assert.equal(fmtDurationCompact(12_300), '12.3s');
  assert.equal(fmtDurationCompact(59_900), '59.9s');
});

test('compact: the seconds→minutes boundary promotes cleanly', () => {
  assert.equal(fmtDurationCompact(59_960), '1m00s', '60.0s would be a lie of shape');
  assert.equal(fmtDurationCompact(60_000), '1m00s');
  assert.equal(fmtDurationCompact(123_000), '2m03s', 'zero-padded seconds');
  assert.equal(fmtDurationCompact(3_600_000), '60m00s');
});

test('compact: input is rounded and clamped', () => {
  assert.equal(fmtDurationCompact(411.6), '412ms');
  assert.equal(fmtDurationCompact(-5), '0ms');
});

test('compact: a ticking counter flows smoothly', () => {
  // The 125 ms ticker cadence: constant unit and precision throughout.
  const ticks = Array.from({ length: 17 }, (_, n) => fmtDurationCompact(n * 125));
  assert.deepEqual(ticks.slice(0, 3), ['0ms', '125ms', '250ms']);
  assert.equal(ticks[8], '1.0s');
  assert.equal(ticks[16], '2.0s');
  for (const t of ticks) assert.match(t, /^\d+(ms|\.\ds)$/, `fixed shape: ${t}`);
});
