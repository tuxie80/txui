import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryLabMigrationHandoff, queryLabIndexArtifact } from '../src/utils/queryLabMigration.ts';
import { parseMigrationHandoff } from '../src/utils/operationHandoff.ts';
import { sha256Hex } from '../src/utils/datagenStandards.ts';
import { createDefaultQueryLabExperiment } from '../src/utils/queryLabSpec.ts';

const specSha256 = 'a'.repeat(64);
const candidate = { id: 'customer-index', kind: 'index' as const, name: 'Orders by customer', table: 'orders', columns: ['customer_id'], unique: false, where: null };

test('PostgreSQL index artifact carries exact SQL and strict evidence without proof phase', () => {
  const handoff = buildQueryLabMigrationHandoff({
    engine: 'postgres', database: 'shop', specSha256, mode: 'estimate', candidate,
    correctness: 'not_applicable', verdict: 'lower_estimated_cost', indexUsed: true,
  });
  assert.equal(handoff.sql, `CREATE INDEX "idx_customer_index_aaaaaaaa" ON "orders" ("customer_id")`);
  assert.equal(handoff.origin, 'query-lab');
  assert.equal(handoff.labEvidence?.artifactSha256, sha256Hex(Array.from(new TextEncoder().encode(handoff.sql))));
  assert.equal(handoff.labEvidence?.indexUsed, true);
  assert.equal(handoff.labEvidence?.correctness, 'not_applicable');
  assert.equal('phase' in (handoff.labEvidence ?? {}), false);
  assert.deepEqual(parseMigrationHandoff(handoff), handoff);
});

test('MySQL qualified index SQL supports unique partial-safe identifiers and exact schema', () => {
  const sql = queryLabIndexArtifact({ ...candidate, table: 'shop.orders', unique: true }, 'mysql', specSha256);
  assert.equal(sql, 'CREATE UNIQUE INDEX `idx_customer_index_aaaaaaaa` ON `shop`.`orders` (`customer_id`)');
  const partial = queryLabIndexArtifact({ ...candidate, where: 'customer_id > 0' }, 'postgres', specSha256);
  assert.ok(partial.endsWith('WHERE customer_id > 0'));
});

test('rewrite handoff requires equality and index handoff requires actual use', () => {
  const experiment = createDefaultQueryLabExperiment({ engine: 'mysql', database: 'shop', sessionId: 's', connectionId: 'c' });
  const rewrite = experiment.candidates[0];
  const handoff = buildQueryLabMigrationHandoff({
    engine: 'mysql', database: 'shop', specSha256, mode: 'measured', candidate: rewrite,
    correctness: 'equal', verdict: 'improved',
  });
  assert.equal(handoff.labEvidence?.correctness, 'equal');
  assert.equal(handoff.labEvidence?.indexUsed, null);
  assert.throws(() => buildQueryLabMigrationHandoff({
    engine: 'mysql', database: 'shop', specSha256, mode: 'measured', candidate: rewrite,
    correctness: 'not_applicable', verdict: 'inconclusive',
  }), /equal rewrite results/);
  assert.throws(() => buildQueryLabMigrationHandoff({
    engine: 'postgres', database: 'shop', specSha256, mode: 'estimate', candidate,
    correctness: 'not_applicable', verdict: 'not_used', indexUsed: false,
  }), /index was used/);
});

test('evidence and hash tampering fail strict parsing', () => {
  const handoff = buildQueryLabMigrationHandoff({
    engine: 'postgres', database: 'shop', specSha256, mode: 'estimate', candidate,
    correctness: 'not_applicable', verdict: 'lower_estimated_cost', indexUsed: true,
  });
  assert.throws(() => parseMigrationHandoff({
    ...handoff, labEvidence: { ...handoff.labEvidence!, phase: 'done' },
  }), /unexpected fields/);
  assert.throws(() => parseMigrationHandoff({
    ...handoff, labEvidence: { ...handoff.labEvidence!, artifactSha256: 'not-a-hash' },
  }), /artifactSha256/);
  assert.throws(() => parseMigrationHandoff({
    ...handoff, labEvidence: { ...handoff.labEvidence!, correctness: 'unverified' },
  }), /correctness/);
  assert.notEqual(handoff.labEvidence!.artifactSha256, sha256Hex(Array.from(new TextEncoder().encode(`${handoff.sql}; DROP TABLE orders`))));
});
