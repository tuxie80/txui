import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMigrationDraft, editMigrationDraft, markMigrationReviewed,
  markMigrationRehearsed, markMigrationReady, startMigrationDeployment,
  beginMigrationVerification, finishMigrationDeployment, markMigrationDone,
  failMigration, cancelMigration,
} from '../src/utils/migrationPlan.ts';
import type {
  MigrationDraft, MigrationProofAnchor, MigrationReviewProof,
  MigrationRehearsalProof,
} from '../src/utils/migrationPlan.ts';
import { reviewChanges } from '../src/utils/changeReview.ts';

const source = { sessionId: 'source-session', connectionId: 'source-connection' };
const target = { sessionId: 'target-session', connectionId: 'target-connection' };
const sql = 'ALTER TABLE orders ADD COLUMN note text;';
const digest = 'a'.repeat(64);

function draft(): MigrationDraft {
  return createMigrationDraft({
    version: 1, engine: 'postgres', database: 'shop', sql,
    sqlSha256: digest, origin: 'editor', source, target,
  });
}

function anchor(value: MigrationDraft): MigrationProofAnchor {
  return { sqlSha256: value.sqlSha256, source: value.source, target: value.target, database: value.database };
}

function reviewProof(value: MigrationDraft): MigrationReviewProof {
  return {
    anchor: anchor(value), catalogComplete: true,
    review: reviewChanges({ engine: 'postgres', sql: value.sql }),
  };
}

function rehearsalProof(value: MigrationDraft): MigrationRehearsalProof {
  return {
    anchor: anchor(value),
    scratch: {
      sessionId: 'scratch-session', connectionId: 'scratch-connection', database: 'txui_scratch_1', runKey: 'scratch-run',
    },
    execution: {
      runId: 'scratch-run', completedStatements: value.reviewProof!.review.summary.statements,
      failedStatements: 0, cancelled: false,
    },
    finalTables: value.reviewProof!.review.tables.map(table => ({ ...table, complete: true })),
    differences: [],
    unverified: [],
  };
}

test('a draft is deeply immutable and validates identity and digest', () => {
  const value = draft();
  assert.equal(value.phase, 'draft');
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.source));
  assert.throws(() => { value.source.sessionId = 'changed'; }, TypeError);
  assert.throws(() => createMigrationDraft({
    version: 1, engine: 'postgres', database: 'shop', sql, sqlSha256: 'bad', origin: 'editor', source, target,
  }));
  assert.throws(() => createMigrationDraft({
    version: 1, engine: 'postgres', database: 'shop', sql, sqlSha256: digest, origin: 'editor',
    source: { sessionId: '', connectionId: 'source' }, target,
  }));
});

test('the complete happy path cannot skip review, rehearsal, deployment or verification', () => {
  let value = draft();
  assert.throws(() => markMigrationReady(value), /expected phase rehearsed/);
  value = markMigrationReviewed(value, reviewProof(value));
  assert.equal(value.phase, 'reviewed');
  value = markMigrationRehearsed(value, rehearsalProof(value));
  value = markMigrationReady(value);
  value = startMigrationDeployment(value, 'run-1');
  assert.equal(value.deployment!.totalStatements, 1);
  value = beginMigrationVerification(value, {
    runId: 'run-1', completedStatements: 1, failedStatements: 0, cancelled: false,
  });
  value = markMigrationDone(value, { runId: 'run-1', differences: [], unverified: [] });
  assert.equal(value.phase, 'done');
  assert.throws(() => cancelMigration(value), /cannot cancel/);
});

test('SQL edits invalidate every proof and require a new hash', () => {
  let value = markMigrationReviewed(draft(), reviewProof(draft()));
  value = markMigrationRehearsed(value, rehearsalProof(value));
  assert.throws(() => editMigrationDraft(value, { sql: `${sql} SELECT 1;` }), /new SHA-256/);
  const edited = editMigrationDraft(value, { sql: `${sql} SELECT 1;`, sqlSha256: 'b'.repeat(64) });
  assert.equal(edited.phase, 'draft');
  assert.equal(edited.reviewProof, null);
  assert.equal(edited.rehearsalProof, null);
  assert.throws(() => markMigrationRehearsed(edited, rehearsalProof(value)), /expected phase reviewed/);
  assert.throws(() => markMigrationReviewed(edited, reviewProof(value)), /different migration draft/);
});

test('source, target and database edits invalidate later proofs; no-op edits do not', () => {
  const reviewed = markMigrationReviewed(draft(), reviewProof(draft()));
  assert.equal(editMigrationDraft(reviewed, {}), reviewed);
  for (const changes of [
    { database: 'other' },
    { source: { sessionId: 'new-source', connectionId: 'source-connection' } },
    { target: { sessionId: 'new-target', connectionId: 'target-connection' } },
  ]) {
    const edited = editMigrationDraft(reviewed, changes);
    assert.equal(edited.phase, 'draft');
    assert.equal(edited.reviewProof, null);
  }
});

test('rehearsal refuses incomplete catalogs, unsupported SQL and unverified tables', () => {
  const value = markMigrationReviewed(draft(), reviewProof(draft()));
  const incomplete = { ...value.reviewProof!, catalogComplete: false };
  const incompleteDraft = { ...value, reviewProof: incomplete };
  assert.throws(() => markMigrationRehearsed(incompleteDraft, rehearsalProof(value)), /complete catalog/);
  const unsupportedDraft = createMigrationDraft({
    version: 1, engine: 'postgres', database: 'shop', sql: 'UPDATE orders SET note = NULL;',
    sqlSha256: digest, origin: 'editor', source, target,
  });
  const reviewedUnsupported = markMigrationReviewed(unsupportedDraft, reviewProof(unsupportedDraft));
  assert.ok(reviewedUnsupported.reviewProof!.review.summary.unsupported > 0);
  assert.throws(() => markMigrationRehearsed(reviewedUnsupported, rehearsalProof(reviewedUnsupported)), /fully supported/);
  assert.throws(() => markMigrationRehearsed(value, { ...rehearsalProof(value), unverified: ['index metadata'] }), /incomplete verification/);
  assert.throws(() => markMigrationRehearsed(value, { ...rehearsalProof(value), differences: ['missing index'] }), /unexplained final-object differences/);
  assert.throws(() => markMigrationRehearsed(value, {
    ...rehearsalProof(value), execution: { runId: 'other-run', completedStatements: 1, failedStatements: 0, cancelled: false },
  }), /different scratch run/);
  assert.throws(() => markMigrationRehearsed(value, {
    ...rehearsalProof(value), execution: { runId: 'scratch-run', completedStatements: 0, failedStatements: 0, cancelled: false },
  }), /complete successful scratch execution/);
});

test('only a complete successful run may enter verification', () => {
  let value = markMigrationReviewed(draft(), reviewProof(draft()));
  value = markMigrationRehearsed(value, rehearsalProof(value));
  value = markMigrationReady(value);
  value = startMigrationDeployment(value, 'run-1');
  for (const outcome of [
    { runId: 'other', completedStatements: 1, failedStatements: 0, cancelled: false },
    { runId: 'run-1', completedStatements: 0, failedStatements: 0, cancelled: false },
    { runId: 'run-1', completedStatements: 1, failedStatements: 1, cancelled: false },
    { runId: 'run-1', completedStatements: 1, failedStatements: 0, cancelled: true },
  ]) assert.throws(() => beginMigrationVerification(value, outcome));
});

test('done refuses differences and unverified checks', () => {
  let value = markMigrationReviewed(draft(), reviewProof(draft()));
  value = markMigrationRehearsed(value, rehearsalProof(value));
  value = markMigrationReady(value);
  value = startMigrationDeployment(value, 'run-1');
  value = beginMigrationVerification(value, { runId: 'run-1', completedStatements: 1, failedStatements: 0, cancelled: false });
  assert.throws(() => markMigrationDone(value, { runId: 'run-1', differences: ['missing index'], unverified: [] }));
  assert.throws(() => markMigrationDone(value, { runId: 'run-1', differences: [], unverified: ['row estimate'] }));
  assert.throws(() => markMigrationDone(value, { runId: 'other', differences: [], unverified: [] }), /different run/);
});

test('failure and cancellation retain evidence and terminal states cannot be reused', () => {
  const reviewed = markMigrationReviewed(draft(), reviewProof(draft()));
  const failed = failMigration(reviewed, 'catalog unavailable');
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.stopReason!.from, 'reviewed');
  assert.ok(failed.reviewProof);
  assert.throws(() => startMigrationDeployment(failed, 'run-2'), /expected phase ready/);
  const cancelled = cancelMigration(reviewed);
  assert.equal(cancelled.phase, 'cancelled');
  assert.throws(() => failMigration(cancelled, 'again'), /cannot fail/);
});

test('proofs returned by transitions are deeply immutable', () => {
  const value = markMigrationReviewed(draft(), reviewProof(draft()));
  assert.ok(Object.isFrozen(value.reviewProof));
  assert.ok(Object.isFrozen(value.reviewProof!.review.statements));
  assert.throws(() => { value.reviewProof!.catalogComplete = false; }, TypeError);
});

test('deployment completion retains partial evidence and only an explicit ok enters verification', () => {
  let value = markMigrationReviewed(draft(), reviewProof(draft()));
  value = markMigrationRehearsed(value, rehearsalProof(value));
  value = markMigrationReady(value);
  const deploying = startMigrationDeployment(value, 'deployment-run');
  const cancelled = finishMigrationDeployment(deploying, {
    runId: 'deployment-run', completedStatements: 0, failedStatements: 0,
    unknownStatements: 1, notStartedStatements: 0, cancelled: true, ok: false,
  }, 'server outcome unknown; no rollback claimed');
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.runOutcome!.unknownStatements, 1);
  assert.equal(cancelled.stopReason!.from, 'deploying');
  assert.match(cancelled.stopReason!.message, /no rollback/);
  assert.throws(() => beginMigrationVerification(cancelled, {
    runId: 'deployment-run', completedStatements: 1, failedStatements: 0, cancelled: false,
  }), /expected phase deploying/);

  const verifying = finishMigrationDeployment(deploying, {
    runId: 'deployment-run', completedStatements: 1, failedStatements: 0,
    unknownStatements: 0, notStartedStatements: 0, cancelled: false, ok: true,
  });
  assert.equal(verifying.phase, 'verifying');
  assert.equal(verifying.runOutcome!.completedStatements, 1);
  assert.throws(() => finishMigrationDeployment(deploying, {
    runId: 'other', completedStatements: 1, failedStatements: 0, cancelled: false, ok: true,
  }), /different run/);
});
