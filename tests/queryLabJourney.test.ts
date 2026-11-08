import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkVerdict } from '../src/utils/benchmark.ts';
import { buildQueryLabMigrationHandoff } from '../src/utils/queryLabMigration.ts';
import { createMigrationDraft } from '../src/utils/migrationPlan.ts';
import { createDefaultQueryLabExperiment } from '../src/utils/queryLabSpec.ts';
import { sha256Hex } from '../src/utils/datagenStandards.ts';

const specSha256 = 'b'.repeat(64);
const experiment = createDefaultQueryLabExperiment({ engine: 'postgres', database: 'shop', sessionId: 's', connectionId: 'c' });
const candidate = experiment.candidates[0];

test('winning real-index evidence enters Migration only at draft with exact artifact proof', () => {
  const verdict = benchmarkVerdict({
    baselineMs: [120, 100, 110], candidateMs: [10, 11, 9],
    baselineSha256: specSha256, candidateSha256: specSha256,
    improvementThresholdPct: 5, candidateKind: 'index', indexUsed: true,
  });
  assert.equal(verdict.verdict, 'improved');
  const handoff = buildQueryLabMigrationHandoff({
    engine: 'postgres', database: 'shop', specSha256, mode: 'measured', candidate,
    correctness: 'not_applicable', verdict: verdict.verdict, indexUsed: true,
  });
  const draft = createMigrationDraft({
    ...handoff, sqlSha256: sha256Hex(Array.from(new TextEncoder().encode(handoff.sql))),
    source: { sessionId: 's', connectionId: 'c' }, target: { sessionId: 's', connectionId: 'c' },
  });
  assert.equal(draft.phase, 'draft');
  assert.equal(draft.reviewProof, null);
  assert.equal(draft.rehearsalProof, null);
  assert.equal(draft.deployment, null);
  assert.equal(handoff.labEvidence?.verdict, 'improved');
});

test('losing and noisy candidates cannot become improvement verdicts', () => {
  const noisy = benchmarkVerdict({
    baselineMs: [100, 200, 100], candidateMs: [80, 90, 80],
    baselineSha256: specSha256, candidateSha256: specSha256,
    improvementThresholdPct: 5, candidateKind: 'index', indexUsed: true,
  });
  assert.equal(noisy.verdict, 'inconclusive');
  assert.throws(() => buildQueryLabMigrationHandoff({
    engine: 'postgres', database: 'shop', specSha256, mode: 'estimate', candidate,
    correctness: 'not_applicable', verdict: 'not_used', indexUsed: false,
  }), /index was used/);
});

test('invalid rewrite is rejected before a migration artifact or benchmark verdict', () => {
  const rewriteExperiment = createDefaultQueryLabExperiment({ engine: 'mysql', database: 'shop', sessionId: 's', connectionId: 'c' });
  const rewrite = rewriteExperiment.candidates[0];
  const invalid = benchmarkVerdict({
    baselineMs: [100, 101, 99], candidateMs: [10, 11, 9],
    baselineSha256: specSha256, candidateSha256: 'different',
    improvementThresholdPct: 5, candidateKind: 'rewrite',
  });
  assert.equal(invalid.verdict, 'invalid_results');
  assert.throws(() => buildQueryLabMigrationHandoff({
    engine: 'mysql', database: 'shop', specSha256, mode: 'measured', candidate: rewrite,
    correctness: 'not_applicable', verdict: invalid.verdict,
  }), /equal rewrite results/);
});
