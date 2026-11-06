import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMigrationReport } from '../src/utils/migrationReport.ts';
import {
  createMigrationDraft, finishMigrationDeployment, markMigrationReady,
  markMigrationRehearsed, markMigrationReviewed, startMigrationDeployment,
} from '../src/utils/migrationPlan.ts';
import { reviewChanges } from '../src/utils/changeReview.ts';
import type { MigrationDraft } from '../src/utils/migrationPlan.ts';
import type { MigrationExecutionResult } from '../src/utils/migrationPreflight.ts';

const source = { sessionId: 'source-session', connectionId: 'source-connection' };
const target = { sessionId: 'target-session', connectionId: 'target-connection' };
const sql = 'ALTER TABLE orders ADD COLUMN note text;';

function reviewed(): MigrationDraft {
  const initial = createMigrationDraft({
    version: 1, engine: 'postgres', database: 'shop', sql,
    sqlSha256: 'a'.repeat(64), origin: 'schema-compare', source, target,
  });
  return markMigrationReviewed(initial, {
    anchor: { sqlSha256: initial.sqlSha256, source, target, database: 'shop' },
    catalogComplete: true, review: reviewChanges({ engine: 'postgres', sql }),
  });
}

function verifying(): MigrationDraft {
  const value = reviewed();
  const rehearsed = markMigrationRehearsed(value, {
    anchor: value.reviewProof!.anchor,
    scratch: { sessionId: 'scratch-session', connectionId: 'scratch-connection', database: 'txui_mig_test', runKey: 'scratch-run' },
    execution: { runId: 'scratch-run', completedStatements: 1, failedStatements: 0, cancelled: false },
    finalTables: value.reviewProof!.review.tables.map(table => ({ ...table, complete: true })),
    differences: [], unverified: [],
  });
  return finishMigrationDeployment(startMigrationDeployment(markMigrationReady(rehearsed), 'deployment-run'), {
    runId: 'deployment-run', completedStatements: 1, failedStatements: 0,
    unknownStatements: 0, notStartedStatements: 0, cancelled: false, ok: true,
  });
}

function execution(runKey: string): MigrationExecutionResult {
  return {
    run_key: runKey, sql_sha256: 'a'.repeat(64), backend_id: 42,
    statement_total: 1, executed: 1, committed: 1, unknown: 0, failed: 0, not_started: 0,
    statements: [{ number: 1, line: 1, ms: 12, rows_affected: 0, ok: true, error: null, error_code: '', db_code: '', sqlstate: '' }],
    ok: true, cancelled: false, partial: false, ms: 13, error: null,
  };
}

test('report deterministically includes identity, rehearsal, deployment timings and verification scope', () => {
  const draft = verifying();
  const input = {
    draft,
    review: { review: draft.reviewProof!.review, catalog: null, catalogComplete: true },
    preflight: null,
    sourceName: 'source-label', targetName: 'target-label',
    rehearsalExecution: execution('scratch-run'),
    deploymentExecution: execution('deployment-run'),
    targetVerification: { differences: [], unverified: [], notes: [], expectedTables: [], actualTables: [], outOfScopeTables: ['unrelated'] },
  };
  const report = renderMigrationReport(input);
  assert.equal(report, renderMigrationReport(input));
  for (const expected of [
    'SQL SHA-256', 'source-label', 'target-label', 'Scratch run ID', 'deployment-run',
    'Rehearsal execution', 'Deployment execution', 'source line 1 · 12 ms',
    'Unrelated target tables excluded | 1', 'Verified done | no',
    'Final target verification is not complete',
  ]) assert.ok(report.includes(expected), expected);
  assert.ok(!report.includes('sourceRows'));
  assert.ok(!report.includes('targetRows'));
  assert.doesNotMatch(report, /2026-\d\d-\d\d/);
});

test('incomplete and unknown evidence is explicit rather than a success claim', () => {
  const report = renderMigrationReport({
    draft: reviewed(), review: null, preflight: null,
    sourceName: 'source', targetName: 'target',
  });
  assert.ok(report.includes('**Outcome:** incomplete'));
  assert.ok(report.includes('Rehearsal proof is not complete'));
  assert.ok(report.includes('Deployment has not run'));
  assert.ok(report.includes('live before-state catalog is incomplete'));
  assert.ok(!report.includes('Verified done | yes'));
});

test('mismatched execution evidence is named and planted secrets or rows never enter the shape', () => {
  const draft = verifying();
  const report = renderMigrationReport({
    draft, review: null, preflight: null, sourceName: 'source', targetName: 'target',
    rehearsalExecution: execution('wrong-run'), deploymentExecution: execution('wrong-run'),
  });
  assert.ok(report.includes('Rehearsal execution evidence belongs to a different run'));
  assert.ok(report.includes('Deployment execution evidence belongs to a different run'));
  assert.ok(!report.includes('password'));
  assert.ok(!report.includes('private-row-value'));
});
