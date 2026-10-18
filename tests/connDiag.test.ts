/**
 * connDiag.ts — the shaping behind the staged-diagnostics checklist
 * (plan-connections.md W3.1/W3.3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stageGlyph, failingStage, verdictLine, probeVersion, stagedToPing, stagedDeadlineMs,
} from '../src/utils/connDiag.ts';
import type { StagedConnectResult, ConnectStage } from '../src/utils/connDiag.ts';

function stage(id: ConnectStage['id'], status: ConnectStage['status'], ms = 0, detail?: string): ConnectStage {
  return { id, label: id.toUpperCase(), status, ms, ...(detail ? { detail } : {}) };
}

function run(stages: ConnectStage[], total_ms = 100): StagedConnectResult {
  return {
    stages,
    total_ms,
    verdict: stages.some(s => s.status === 'fail') ? 'fail' : 'ok',
  };
}

const ALL_OK = run([
  stage('dns', 'ok', 2, 'h → 1.2.3.4'),
  stage('tcp', 'ok', 10),
  stage('ssh', 'skipped', 0, 'no SSH tunnel configured'),
  stage('tls', 'ok', 40, 'TLSv1.3'),
  stage('auth', 'ok', 88),
  stage('probe', 'ok', 5, 'MySQL 8.0.36'),
], 145);

test('stageGlyph: one glyph per status', () => {
  assert.equal(stageGlyph('ok'), '✓');
  assert.equal(stageGlyph('fail'), '✗');
  assert.equal(stageGlyph('skipped'), '–');
});

test('failingStage finds the first fail, null when clean', () => {
  assert.equal(failingStage(ALL_OK), null);
  const r = run([stage('dns', 'ok'), stage('tcp', 'fail', 2000, 'refused')]);
  assert.equal(failingStage(r)?.id, 'tcp');
});

test('verdictLine on success carries the dial/TLS/auth split', () => {
  assert.equal(
    verdictLine(ALL_OK),
    'OK in 145 ms — dial 12 ms · TLS 40 ms · auth 88 ms · probe 5 ms',
  );
});

test('verdictLine leaves skipped stages out of the split', () => {
  // File engine: the whole network half is skipped; only auth + probe ran.
  const r = run([
    stage('dns', 'skipped'), stage('tcp', 'skipped'), stage('ssh', 'skipped'),
    stage('tls', 'skipped'), stage('auth', 'ok', 3), stage('probe', 'ok', 1),
  ], 4);
  assert.equal(verdictLine(r), 'OK in 4 ms — auth 3 ms · probe 1 ms');
});

test('verdictLine on failure names the stage, its ms and its detail', () => {
  const r = run([
    stage('dns', 'ok', 2), stage('tcp', 'fail', 2003, 'TCP connect to h:3306 failed'),
    stage('ssh', 'skipped', 0, 'not reached'),
  ], 2005);
  assert.equal(
    verdictLine(r),
    'Failed at TCP after 2003 ms — TCP connect to h:3306 failed (total 2005 ms)',
  );
});

test('probeVersion reads the successful probe detail only', () => {
  assert.equal(probeVersion(ALL_OK), 'MySQL 8.0.36');
  assert.equal(probeVersion(run([stage('probe', 'skipped')])), null);
});

test('stagedToPing maps a clean run onto a green PingResult', () => {
  assert.deepEqual(stagedToPing(ALL_OK), {
    ok: true, latency_ms: 145, server_version: 'MySQL 8.0.36', error: null,
  });
});

test('stagedToPing maps a failure onto a red PingResult naming the stage', () => {
  const p = stagedToPing(run([
    stage('auth', 'fail', 120, 'Access denied for user'),
    stage('probe', 'skipped'),
  ], 120));
  assert.equal(p.ok, false);
  assert.equal(p.server_version, null);
  assert.equal(p.error, 'AUTH: Access denied for user');
});

test('stagedDeadlineMs bounds the worst honest case: six stages per timeout', () => {
  assert.equal(stagedDeadlineMs({}), 15 * 6 * 1000 + 10_000);
  assert.equal(stagedDeadlineMs({ connect_timeout_secs: null }), 100_000);
  assert.equal(stagedDeadlineMs({ connect_timeout_secs: 5 }), 40_000);
  // An explicit 0 exempts the connection from timeouts — no deadline here either.
  assert.equal(stagedDeadlineMs({ connect_timeout_secs: 0 }), 0);
});
