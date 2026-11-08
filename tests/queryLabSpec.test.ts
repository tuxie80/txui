import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultQueryLabExperiment, parseQueryLabExperiment, queryLabIndexEvidenceMode,
  queryLabSpecSha256, validateQueryLabExperiment, validateQueryLabIndexEvidenceContract,
} from '../src/utils/queryLabSpec.ts';
import type { QueryLabExperiment } from '../src/utils/queryLabSpec.ts';

function fixture(engine: 'mysql' | 'postgres' = 'postgres'): QueryLabExperiment {
  return createDefaultQueryLabExperiment({
    engine, database: 'shop', sessionId: 's-lab', connectionId: 'c-lab', environment: 'dev', readOnly: false,
  });
}

test('default MySQL and PostgreSQL experiments are valid and deterministic', () => {
  for (const engine of ['mysql', 'postgres'] as const) {
    const experiment = fixture(engine);
    assert.deepEqual(validateQueryLabExperiment(experiment), []);
    const parsed = parseQueryLabExperiment(experiment);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.experiment.resolvedSql.includes(':customer_id'), false);
      assert.ok(parsed.experiment.resolvedSql.includes('customer_id = 1'));
      assert.equal(parsed.experiment.resolvedCandidates.length, 1);
    }
    assert.equal(queryLabSpecSha256(experiment), queryLabSpecSha256(structuredClone(experiment)));
  }
});

test('writes, data-modifying CTEs and EXPLAIN are rejected before invocation', () => {
  for (const sql of [
    'DELETE FROM orders',
    'WITH doomed AS (DELETE FROM orders RETURNING id) SELECT * FROM doomed',
    'EXPLAIN SELECT * FROM orders',
    'UPDATE orders SET customer_id = 1',
  ]) {
    const experiment = { ...fixture(), originalSql: sql };
    const errors = validateQueryLabExperiment(experiment);
    assert.ok(errors.length > 0, sql);
  }
});

test('multi-statements and client DELIMITER commands are not experiments', () => {
  assert.ok(validateQueryLabExperiment({ ...fixture(), originalSql: 'SELECT 1; SELECT 2' })
    .some(error => error.includes('exactly one statement')));
  assert.ok(validateQueryLabExperiment({ ...fixture(), originalSql: 'DELIMITER $$\nSELECT 1$$' })
    .some(error => error.includes('DELIMITER')));
});

test('every parameter must be concrete, named and used', () => {
  const missing = fixture();
  missing.parameters = {};
  assert.ok(validateQueryLabExperiment(missing).some(error => error.includes('unresolved parameter :customer_id')));
  const positional = { ...fixture(), originalSql: 'SELECT * FROM orders WHERE customer_id = $1' };
  assert.ok(validateQueryLabExperiment(positional).some(error => error.includes('unresolved positional parameters')));
  const unexpected = fixture();
  unexpected.parameters.extra = { kind: 'text', value: 'unused' };
  assert.ok(validateQueryLabExperiment(unexpected).some(error => error.includes('unexpected concrete parameter')));
  const invalid = fixture();
  invalid.parameters.customer_id = { kind: 'number', value: '1e999' };
  assert.ok(validateQueryLabExperiment(invalid).some(error => error.includes('finite exact number')));
});

test('estimate mode rejects measured evidence, settings and MySQL hypothetical indexes', () => {
  const evidence = fixture();
  evidence.evidence.timing = true;
  assert.ok(validateQueryLabExperiment(evidence).some(error => error.includes('plan/cost evidence only')));
  const index = fixture('mysql');
  index.candidates = [{ id: 'hypothetical', kind: 'index', name: 'Not supported', table: 'orders', columns: ['customer_id'], unique: false, where: null }];
  assert.ok(validateQueryLabExperiment(index).some(error => error.includes('PostgreSQL-only')));
  const setting = fixture();
  setting.candidates = [{ id: 'work-mem', kind: 'setting', name: 'work_mem', value: '64MB' }];
  assert.ok(validateQueryLabExperiment(setting).some(error => error.includes('require measured scratch execution')));
});

test('measured mode requires timing and an exact writable non-production scratch', () => {
  const measured = fixture();
  measured.executionMode = 'measured';
  measured.evidence.timing = true;
  measured.evidence.resultEquality = true;
  measured.candidates = [{ id: 'rewrite', kind: 'rewrite', name: 'Equivalent', sql: 'SELECT id, customer_id, created_at FROM orders WHERE customer_id = :customer_id AND id > 0 ORDER BY id LIMIT 1000' }];
  assert.deepEqual(validateQueryLabExperiment(measured), []);
  for (const mutate of [
    (experiment: QueryLabExperiment) => { experiment.scratch = null; },
    (experiment: QueryLabExperiment) => { experiment.scratch!.environment = 'prod'; },
    (experiment: QueryLabExperiment) => { experiment.scratch!.readOnly = true; },
    (experiment: QueryLabExperiment) => { experiment.scratch!.database = 'other'; },
  ]) {
    const invalid = structuredClone(measured);
    mutate(invalid);
    assert.ok(validateQueryLabExperiment(invalid).length > 0);
  }
  const noTiming = structuredClone(measured);
  noTiming.evidence.timing = false;
  assert.ok(validateQueryLabExperiment(noTiming).some(error => error.includes('requires timing evidence')));
  const noEquality = structuredClone(measured);
  noEquality.evidence.resultEquality = false;
  assert.ok(validateQueryLabExperiment(noEquality).some(error => error.includes('result-equality evidence')));
});

test('run bounds, evidence requirements and candidate identities fail closed', () => {
  for (const [key, value] of [['warmupRuns', 11], ['repetitions', 0], ['repetitions', 31], ['timeoutMs', 50], ['improvementThresholdPct', 101]] as const) {
    const experiment = { ...fixture(), [key]: value };
    assert.ok(validateQueryLabExperiment(experiment).length > 0, `${key}=${value}`);
  }
  const noPlan = fixture();
  noPlan.evidence.plan = false;
  assert.ok(validateQueryLabExperiment(noPlan).some(error => error.includes('evidence.plan is required')));
  const duplicates = fixture();
  duplicates.candidates = [
    { id: 'same', kind: 'rewrite', name: 'One', sql: 'SELECT 1' },
    { id: 'same', kind: 'rewrite', name: 'Two', sql: 'SELECT 2' },
  ];
  assert.ok(validateQueryLabExperiment(duplicates).some(error => error.includes('duplicates same')));
});

test('text, boolean and NULL parameters resolve to safe concrete SQL', () => {
  const experiment = fixture();
  experiment.originalSql = 'SELECT * FROM orders WHERE customer_id = :customer_id AND note = :note AND active = :active AND deleted_at IS :missing';
  experiment.parameters = {
    customer_id: { kind: 'number', value: '-2.50' },
    note: { kind: 'text', value: "private ' value" },
    active: { kind: 'boolean', value: 'true' },
    missing: { kind: 'null', value: '' },
  };
  const parsed = parseQueryLabExperiment(experiment);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.ok(parsed.experiment.resolvedSql.includes("note = 'private '' value'"));
    assert.ok(parsed.experiment.resolvedSql.includes('active = TRUE'));
    assert.ok(parsed.experiment.resolvedSql.includes('deleted_at IS NULL'));
  }
});

test('index evidence is hypothetical only for estimates and real only for measured scratch', () => {
  const rewrite = fixture('mysql');
  assert.equal(queryLabIndexEvidenceMode('estimate', rewrite.candidates), 'none');
  const index = fixture();
  assert.equal(queryLabIndexEvidenceMode('estimate', index.candidates), 'hypothetical');
  assert.equal(queryLabIndexEvidenceMode('measured', index.candidates), 'real');
  assert.deepEqual(validateQueryLabIndexEvidenceContract('estimate', 'hypothetical'), []);
  assert.deepEqual(validateQueryLabIndexEvidenceContract('measured', 'real'), []);
  assert.ok(validateQueryLabIndexEvidenceContract('estimate', 'real')[0].includes('incompatible'));
  assert.ok(validateQueryLabIndexEvidenceContract('measured', 'hypothetical')[0].includes('cannot produce measured runtime plans'));
});
