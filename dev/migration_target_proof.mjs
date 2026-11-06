import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareMigrationTargetModel } from '../src/utils/migrationVerification.ts';
import { reviewChanges } from '../src/utils/changeReview.ts';
import {
  createMigrationDraft, finishMigrationDeployment, markMigrationDone, markMigrationReady,
  markMigrationRehearsed, markMigrationReviewed, startMigrationDeployment,
} from '../src/utils/migrationPlan.ts';

let text = '';
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
const snapshot = {
  engine: input.engine, schema: 'source',
  serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null,
  tables: [], columns: [], indexes: [], foreignKeys: [],
};
const review = reviewChanges({ sql: input.sql, engine: input.engine, catalog: snapshot });
const endpoint = { sessionId: 'source-session', connectionId: 'source-connection' };
const sqlSha256 = createHash('sha256').update(input.sql).digest('hex');

function draft() {
  return markMigrationReviewed(createMigrationDraft({
    version: 1, engine: input.engine, database: 'source', sql: input.sql,
    sqlSha256, origin: 'editor', source: endpoint, target: endpoint,
  }), {
    anchor: { sqlSha256, source: endpoint, target: endpoint, database: 'source' },
    catalogComplete: true, review,
  });
}

function comparison(actualTables) {
  return compareMigrationTargetModel({
    engine: input.engine, snapshot, review, actualTables, catalogComplete: true,
  });
}

function rehearse(value, result) {
  return markMigrationRehearsed(value, {
    anchor: value.reviewProof.anchor,
    scratch: {
      sessionId: 'scratch-session', connectionId: 'scratch-connection',
      database: input.scratch, runKey: input.rehearsalRunKey,
    },
    execution: {
      runId: input.rehearsalRunKey, completedStatements: review.summary.statements,
      failedStatements: 0, cancelled: false,
    },
    finalTables: result.actualTables,
    differences: result.differences,
    unverified: result.unverified,
  });
}

const clean = comparison(input.actualTables);
function deployed() {
  const rehearsalEvidence = {
    actualTables: clean.expectedTables, differences: [], unverified: [],
  };
  const ready = markMigrationReady(rehearse(draft(), rehearsalEvidence));
  return finishMigrationDeployment(startMigrationDeployment(ready, input.runKey), {
    runId: input.runKey, completedStatements: review.summary.statements,
    failedStatements: 0, cancelled: false, ok: true,
  });
}

function verify(result) {
  return markMigrationDone(deployed(), {
    runId: input.runKey, differences: result.differences, unverified: result.unverified,
  });
}

if (input.expectDrift) {
  assert.ok(clean.differences.length > 0, 'external target drift was not detected');
  assert.throws(() => verify(clean), /differences or unverified checks/);
  console.log(JSON.stringify({ driftBlocked: true, differences: clean.differences }));
  process.exit(0);
}

assert.deepEqual(clean.differences, [], 'live deployed target differs');
assert.deepEqual(clean.unverified, [], 'live deployed target is incomplete');
assert.deepEqual(clean.outOfScopeTables, ['unrelated_target']);
assert.equal(verify(clean).phase, 'done');

const variants = [];
const missingIndex = structuredClone(input.actualTables);
missingIndex.find(table => table.name === 'children').indexes =
  missingIndex.find(table => table.name === 'children').indexes.filter(index => index.name !== 'idx_note');
variants.push(['missing index', missingIndex]);
const extraIndex = structuredClone(input.actualTables);
extraIndex.find(table => table.name === 'children').indexes.push({ name: 'idx_planted', columns: ['id'], unique: false });
variants.push(['extra index', extraIndex]);
const wrongNullability = structuredClone(input.actualTables);
wrongNullability.find(table => table.name === 'children').columns.find(column => column.name === 'note').nullable = false;
variants.push(['wrong nullability', wrongNullability]);
const droppedFk = structuredClone(input.actualTables);
droppedFk.find(table => table.name === 'children').foreignKeys = [];
variants.push(['dropped foreign key', droppedFk]);

for (const [label, actualTables] of variants) {
  const result = comparison(actualTables);
  assert.ok(result.differences.length > 0, `${label} did not produce a target difference`);
  assert.throws(() => verify(result), /differences or unverified checks/, label);
}

console.log(JSON.stringify({
  tables: clean.actualTables.length,
  outOfScopeTables: clean.outOfScopeTables,
  notes: clean.notes,
  plantedVariantsBlocked: variants.length,
  phase: 'done',
}));
