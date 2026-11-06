import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareMigrationFinalModel } from '../src/utils/migrationVerification.ts';
import { reviewChanges } from '../src/utils/changeReview.ts';
import {
  createMigrationDraft, markMigrationReady, markMigrationRehearsed, markMigrationReviewed,
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

function draft() {
  return markMigrationReviewed(createMigrationDraft({
    version: 1, engine: input.engine, database: 'source', sql: input.sql,
    sqlSha256: createHash('sha256').update(input.sql).digest('hex'),
    origin: 'editor', source: endpoint, target: endpoint,
  }), {
    anchor: {
      sqlSha256: createHash('sha256').update(input.sql).digest('hex'),
      source: endpoint, target: endpoint, database: 'source',
    },
    catalogComplete: true, review,
  });
}

function comparison(actualTables) {
  return compareMigrationFinalModel({
    engine: input.engine, snapshot, review, actualTables, catalogComplete: true,
  });
}

function rehearse(value, result) {
  return markMigrationRehearsed(value, {
    anchor: value.reviewProof.anchor,
    scratch: {
      sessionId: 'scratch-session', connectionId: 'scratch-connection',
      database: input.scratch, runKey: input.runKey,
    },
    execution: {
      runId: input.runKey, completedStatements: review.summary.statements,
      failedStatements: 0, cancelled: false,
    },
    finalTables: result.actualTables,
    differences: result.differences,
    unverified: result.unverified,
  });
}

const clean = comparison(input.actualTables);
assert.deepEqual(clean.differences, [], 'live final model differs');
assert.deepEqual(clean.unverified, [], 'live final model is incomplete');
assert.equal(markMigrationReady(rehearse(draft(), clean)).phase, 'ready');

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
  assert.ok(result.differences.length > 0, `${label} did not produce a difference`);
  assert.throws(() => rehearse(draft(), result), /unexplained final-object differences/, label);
}

console.log(JSON.stringify({
  tables: clean.actualTables.length,
  notes: clean.notes,
  plantedVariantsBlocked: variants.length,
  phase: 'ready',
}));
