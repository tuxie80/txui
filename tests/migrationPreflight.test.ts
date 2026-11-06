import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationPreflightStatements } from '../src/utils/migrationPreflight.ts';
import { reviewChanges } from '../src/utils/changeReview.ts';

test('metadata preserves order, kinds, objects, support and cost evidence', () => {
  const review = reviewChanges({
    engine: 'mysql',
    sql: 'ALTER TABLE orders ADD COLUMN note varchar(20); DROP TABLE old_orders;',
  });
  const statements = buildMigrationPreflightStatements(review);
  assert.equal(statements.length, 2);
  assert.deepEqual(statements.map(statement => statement.kind), ['alter-table', 'drop-table']);
  assert.deepEqual(statements.map(statement => statement.line), [1, 1]);
  assert.deepEqual(statements.map(statement => statement.table), ['orders', 'old_orders']);
  assert.deepEqual(statements.map(statement => statement.destructive), [false, true]);
  assert.equal(statements[0].cost?.operation, review.statements[0].cost?.operation);
  assert.equal(statements[0].cost?.blocked_seconds, review.statements[0].cost?.blockedSeconds);
  assert.equal(statements[0].cost?.disk_bytes, review.statements[0].cost?.diskBytes);
  assert.ok(statements[0].cost);
});

test('type narrowing and nullability changes are lossy, additive changes are not', () => {
  const review = reviewChanges({
    engine: 'postgres',
    sql: 'CREATE TABLE t(id int, note text); ALTER TABLE t ALTER COLUMN note TYPE varchar(3); ALTER TABLE t ADD extra int;',
  });
  const statements = buildMigrationPreflightStatements(review);
  assert.equal(statements[0].lossy, false);
  assert.equal(statements[1].lossy, true);
  assert.equal(statements[2].lossy, false);
});

test('NOT NULL without a default is a data-risk statement', () => {
  const review = reviewChanges({ engine: 'mysql', sql: 'ALTER TABLE t ADD required int NOT NULL;' });
  const [statement] = buildMigrationPreflightStatements(review);
  assert.equal(statement.lossy, true);
  assert.equal(statement.destructive, false);
});
