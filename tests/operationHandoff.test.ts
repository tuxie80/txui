import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HANDOFF_SQL_BYTES, OPEN_MIGRATION_EVENT, OPEN_QUERY_LAB_EVENT,
  parseMigrationHandoff, parseQueryLabHandoff,
} from '../src/utils/operationHandoff.ts';

const migration = {
  version: 1,
  engine: 'postgres',
  database: 'shop',
  sql: 'ALTER TABLE orders ADD COLUMN note text;',
  origin: 'schema-compare',
};

test('event names and a valid migration handoff are stable', () => {
  assert.equal(OPEN_MIGRATION_EVENT, 'dbgui:open-migration');
  assert.equal(OPEN_QUERY_LAB_EVENT, 'dbgui:open-query-lab');
  assert.deepEqual(parseMigrationHandoff(migration), migration);
  assert.deepEqual(parseMigrationHandoff({ ...migration, database: null }), { ...migration, database: null });
  const targeted = { ...migration, targetConnectionId: 'target-connection' };
  assert.deepEqual(parseMigrationHandoff(targeted), targeted);
  assert.throws(() => parseMigrationHandoff({ ...migration, targetConnectionId: '' }), /targetConnectionId/);
  assert.throws(() => parseMigrationHandoff({ ...migration, phase: 'done', rehearsalProof: {} }), /unexpected fields/);
});

test('migration rejects versions, engines, origins and malformed SQL', () => {
  for (const value of [
    { ...migration, version: 2 },
    { ...migration, engine: 'sqlserver' },
    { ...migration, origin: 'unknown' },
    { ...migration, sql: '' },
    { ...migration, sql: '   ' },
    { ...migration, database: '' },
  ]) assert.throws(() => parseMigrationHandoff(value));
});

test('migration rejects unexpected secret and row payloads', () => {
  for (const extra of [{ password: 'secret' }, { rows: [[1, 'private']] }, { credentials: {} }]) {
    assert.throws(() => parseMigrationHandoff({ ...migration, ...extra }), /unexpected fields/);
  }
});

test('migration rejects missing fields and non-objects', () => {
  for (const value of [null, [], 'sql', 1]) assert.throws(() => parseMigrationHandoff(value));
  const { sql: _sql, ...missing } = migration;
  assert.throws(() => parseMigrationHandoff(missing), /missing fields: sql/);
});

test('handoff SQL limit is measured in UTF-8 bytes', () => {
  const sql = `/* ${'ž'.repeat(MAX_HANDOFF_SQL_BYTES / 2 + 1)} */ SELECT 1`;
  assert.throws(() => parseMigrationHandoff({ ...migration, sql }), /handoff limit/);
});

test('query lab accepts bounded numeric evidence without rows', () => {
  const handoff = {
    ...migration,
    origin: 'editor',
    evidence: {
      mode: 'estimate',
      sqlSha256: 'a'.repeat(64),
      metrics: [{ name: 'plan.cost', value: 123.5, unit: 'cost' }, { name: 'runs', value: 7 }],
    },
  };
  assert.deepEqual(parseQueryLabHandoff(handoff), handoff);
});

test('query lab rejects malformed evidence and nested payloads', () => {
  const base = { ...migration, origin: 'editor' };
  for (const evidence of [
    { mode: 'runtime', sqlSha256: 'a'.repeat(64), metrics: [] },
    { mode: 'estimate', sqlSha256: 'A'.repeat(64), metrics: [] },
    { mode: 'estimate', sqlSha256: 'a'.repeat(64), metrics: [{ name: 'ms', value: NaN }] },
    { mode: 'estimate', sqlSha256: 'a'.repeat(64), metrics: [{ name: 'ms', value: 1 }, { name: 'ms', value: 2 }] },
    { mode: 'estimate', sqlSha256: 'a'.repeat(64), metrics: [], rows: [] },
  ]) assert.throws(() => parseQueryLabHandoff({ ...base, evidence }));
});

test('query lab requires a known source and rejects unknown top-level fields', () => {
  assert.throws(() => parseQueryLabHandoff({ ...migration, origin: 'schema-compare' }));
  assert.throws(() => parseQueryLabHandoff({ ...migration, origin: 'editor', resultRows: [] }), /unexpected fields/);
});
