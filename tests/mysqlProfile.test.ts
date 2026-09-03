/**
 * MySQL statement profiling (src/utils/mysqlProfile.ts).
 *
 * The numbers are easy; the interpretation is the feature. `Sending data` is
 * the most misread state in MySQL — it is not the network, it is the server
 * reading rows — and people spend afternoons tuning connections because of the
 * name. These tests pin the two things that make this useful: summing repeated
 * states, and only calling out a state that actually dominates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProfile, profileTotal, profileFindings, meaningOf, formatSeconds,
  supportsProfiling, STATE_MEANINGS, DOMINANT_SHARE,
} from '../src/utils/mysqlProfile.ts';

// Shaped like real SHOW PROFILE output: a state can appear several times.
const ROWS: unknown[][] = [
  ['starting', 0.000_1],
  ['checking permissions', 0.000_02],
  ['Sending data', 0.400],
  ['Sending data', 0.350],
  ['Sorting result', 0.050],
  ['end', 0.000_01],
];

test('repeated states are summed, not listed separately', () => {
  // MySQL reports `Sending data` once per table. Listing them apart makes the
  // biggest cost look like several small ones.
  const stages = parseProfile(ROWS);
  const sending = stages.find(s => s.state === 'Sending data');
  assert.ok(sending);
  assert.ok(Math.abs(sending.seconds - 0.75) < 1e-9, `got ${sending.seconds}`);
  assert.equal(stages.filter(s => s.state === 'Sending data').length, 1);
});

test('stages are ordered by cost, biggest first', () => {
  const stages = parseProfile(ROWS);
  assert.equal(stages[0].state, 'Sending data');
  assert.equal(stages[1].state, 'Sorting result');
});

test('shares sum to one', () => {
  const total = parseProfile(ROWS).reduce((n, s) => n + s.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares summed to ${total}`);
});

test('the total is the sum of the stages', () => {
  const stages = parseProfile(ROWS);
  assert.ok(Math.abs(profileTotal(stages) - 0.80013) < 1e-6);
});

test('malformed rows are skipped rather than poisoning the totals', () => {
  const stages = parseProfile([['ok', 1], ['bad', 'not a number'], [null, 5], []]);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].share, 1);
});

test('an empty profile does not divide by zero', () => {
  assert.deepEqual(parseProfile([]), []);
  assert.equal(profileTotal([]), 0);
  const zero = parseProfile([['a', 0]]);
  assert.equal(zero[0].share, 0);
});

// ── the interpretation ──────────────────────────────────────────────────────

test('Sending data is explained as reading, NOT the network', () => {
  // The single most valuable sentence in this module.
  const m = meaningOf('Sending data');
  assert.ok(m);
  assert.match(m.what, /READING|reading/);
  assert.match(m.what, /not the network/i);
  assert.match(m.concern!, /plan/);
});

test('state lookup ignores case and whitespace', () => {
  assert.ok(meaningOf('  SENDING DATA  '));
  assert.ok(meaningOf('Sorting result'));
});

test('an unknown state returns nothing rather than a guess', () => {
  assert.equal(meaningOf('some future state'), undefined);
});

test('lock waits are identified as concurrency, not query problems', () => {
  for (const s of ['Waiting for table level lock', 'Waiting for table metadata lock']) {
    const m = meaningOf(s);
    assert.ok(m?.concern, s);
    assert.match(m.concern, /concurrency|transaction|holding/i, s);
  }
});

test('every state with a concern also explains what it is', () => {
  for (const [state, m] of Object.entries(STATE_MEANINGS)) {
    assert.ok(m.what.length > 15, `${state}: what is too thin`);
    if (m.concern) assert.ok(m.concern.length > 25, `${state}: concern is too thin`);
  }
});

// ── findings: only what dominates ───────────────────────────────────────────

test('only a dominant state with a known concern becomes a finding', () => {
  const findings = profileFindings(parseProfile(ROWS));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].state, 'Sending data');
  assert.ok(findings[0].share > DOMINANT_SHARE);
});

test('a fast query dominated by `executing` produces NO findings', () => {
  // 95% of a 2 ms query being execution is not a problem, it is a fast query.
  const stages = parseProfile([['executing', 0.0019], ['starting', 0.0001]]);
  assert.deepEqual(profileFindings(stages), []);
});

test('a state below the threshold is not called out', () => {
  const stages = parseProfile([
    ['Sending data', 0.1], ['executing', 0.9],
  ]);
  assert.deepEqual(profileFindings(stages).map(f => f.state), []);
});

test('a disk temp table is flagged with the fix', () => {
  const stages = parseProfile([['Copying to tmp table on disk', 1], ['end', 0.01]]);
  const [f] = profileFindings(stages);
  assert.ok(f);
  assert.match(f.concern, /tmp_table_size|reduce/i);
});

// ── presentation ────────────────────────────────────────────────────────────

test('sub-millisecond times stay readable', () => {
  assert.equal(formatSeconds(1.5), '1.500 s');
  assert.equal(formatSeconds(0.0123), '12.30 ms');
  assert.equal(formatSeconds(0.000_012), '12 µs');
});

test('profiling is MySQL-only', () => {
  assert.equal(supportsProfiling('mysql'), true);
  assert.equal(supportsProfiling('postgres'), false);
  assert.equal(supportsProfiling('sqlite'), false);
});
