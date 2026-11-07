import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRefreshCatalog } from '../src/utils/refreshCatalog.ts';
import { buildRefreshExecutionPlan } from '../src/utils/refreshExecution.ts';
import { applyRefreshExecutionEvent, buildRefreshExecutionInput, initialRefreshProgress } from '../src/utils/refreshExecute.ts';
import { buildRefreshMaskPlan } from '../src/utils/refreshMask.ts';
import { planRefreshRowSets } from '../src/utils/refreshRowSets.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';
import type { CatalogColumn, CatalogFk, CatalogIndex, CatalogTable, SchemaSnapshot } from '../src/utils/schemaRules.ts';

function column(table: string, name: string, generated = false): CatalogColumn {
  return {
    table, name, dataType: name === 'email' ? 'varchar' : 'int', columnType: name === 'email' ? 'varchar(64)' : 'int',
    nullable: false, defaultValue: null, extra: generated ? 'STORED GENERATED' : '',
    charset: name === 'email' ? 'utf8mb4' : null, collation: name === 'email' ? 'utf8mb4_0900_ai_ci' : null,
    charMaxLen: name === 'email' ? 64 : null, generationExpression: generated ? "concat(`email`,'!')" : null, comment: '',
  };
}

function table(name: string): CatalogTable {
  return { name, engine: 'InnoDB', collation: null, rows: 10, dataBytes: 1000, indexBytes: 100, autoIncrement: null, comment: '' };
}

function index(table: string, name = 'PRIMARY', columnName = 'id'): CatalogIndex {
  return { table, name, unique: true, type: 'BTREE', columns: [{ name: columnName, seq: 1, subPart: null, cardinality: 10 }] };
}

function snapshot(schema: string): SchemaSnapshot {
  return {
    engine: 'mysql', schema, serverCharset: null, serverCollation: null, schemaCharset: null, schemaCollation: null,
    tables: [table('parents'), table('children')],
    columns: [
      column('parents', 'id'), column('parents', 'email'), column('parents', 'computed', true),
      column('children', 'id'), column('children', 'parent_id'),
    ],
    indexes: [index('parents'), index('parents', 'uq_email', 'email'), index('children')],
    foreignKeys: [{
      name: 'fk_parent', schema, table: 'children', column: 'parent_id', refSchema: schema,
      refTable: 'parents', refColumn: 'id', ordinal: 1, onDelete: 'NO ACTION', onUpdate: 'NO ACTION',
    } satisfies CatalogFk],
  };
}

async function fixture() {
  const spec = createDefaultRefreshSpec({
    source: { connectionId: '00000000-0000-4000-8000-000000000011', sessionId: '00000000-0000-4000-8000-000000000001' },
    schema: 'source', cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  spec.target = { connectionId: '00000000-0000-4000-8000-000000000022', sessionId: '00000000-0000-4000-8000-000000000002' };
  spec.schemaMappings = [{ source: 'source', target: 'target' }];
  spec.tables = [{ table: 'children', policy: 'full' }];
  spec.masks = [{ table: 'parents', column: 'email', rule: 'hash' }];
  spec.acknowledgeUnmaskedSensitive = true;
  const catalog = analyzeRefreshCatalog({ spec, source: [snapshot('source')], target: [snapshot('target')] });
  assert.equal(catalog.complete, true);
  const rowSets = await planRefreshRowSets({
    spec, catalog,
    runGrid: async (_sessionId, sql) => sql.includes('__txui_refresh_selection')
      ? { columns: ['id', 'parent_id'], rows: [[2, 1]], truncated: false }
      : { columns: ['id', 'email'], rows: [[1, 'private@example.test']], truncated: false },
  });
  assert.equal(rowSets.fixedPoint, true);
  const executionPlan = buildRefreshExecutionPlan({ spec, catalog, rowSets });
  assert.equal(executionPlan.executable, true);
  const maskPlan = buildRefreshMaskPlan({ spec, catalog });
  assert.equal(maskPlan.complete, true);
  return { spec, catalog, executionPlan, maskPlan };
}

test('execution input carries qualified dependency mappings and no application rows', async () => {
  const current = await fixture();
  const input = buildRefreshExecutionInput({
    ...current, runKey: '00000000-0000-4000-8000-000000000099', productionConfirmation: null,
  }) as unknown as {
    tables: {
      source_schema: string; target_schema: string; table: string; action: string; root_sql: string | null;
      columns: { name: string; generation_expression: string | null }[];
    }[];
    mask: { rows: unknown[] }; preflight: { spec_sha256: string }; expected_row_set_sha256: string;
    verification: { exact_counts: boolean; foreign_key_orphans: boolean; content_sha256: boolean };
  };
  assert.equal(input.tables.length, 2);
  assert.deepEqual(input.tables.map(table => `${table.source_schema}.${table.table}`), ['source.parents', 'source.children']);
  assert.equal(input.tables[0].target_schema, 'target');
  assert.equal(input.tables[0].root_sql, null);
  assert.equal(input.tables[0].action, 'dependency');
  assert.equal(input.tables[1].root_sql, 'SELECT `id`, `parent_id` FROM `source`.`children`');
  assert.equal(input.tables[0].columns.find(column => column.name === 'computed')?.generation_expression, "concat(`email`,'!')");
  assert.deepEqual(input.mask.rows, []);
  assert.equal(input.preflight.spec_sha256, current.executionPlan.specSha256);
  assert.equal(input.expected_row_set_sha256, current.executionPlan.rowSetSha256);
  assert.deepEqual(input.verification, { exact_counts: true, foreign_key_orphans: true, content_sha256: true });
  assert.equal(JSON.stringify(input).includes('private@example.test'), false);
});

test('execution input refuses mismatched evidence before invoking a backend', async () => {
  const current = await fixture();
  const maskPlan = { ...current.maskPlan, catalogSha256: '0'.repeat(64) };
  assert.throws(() => buildRefreshExecutionInput({
    ...current, maskPlan, runKey: '00000000-0000-4000-8000-000000000099', productionConfirmation: null,
  }), /different specification or catalog hashes/);
});

test('progress keeps committed, in-flight and remaining rows distinct through uncertain completion', () => {
  let state = initialRefreshProgress();
  state = applyRefreshExecutionEvent(state, { type: 'started', run_key: 'run', source_backend_id: 10, target_backend_id: 20 });
  state = applyRefreshExecutionEvent(state, {
    type: 'progress', run_key: 'run', phase: 'copying', table: 'source.children', table_index: 2, table_count: 2,
    requested_rows: 80, closure_rows: 20, planned_rows: 100, key_rows_read: 100,
    source_rows_read: 40, committed_rows: 40, in_flight_rows: 10, remaining_rows: 60,
    chunks_committed: 4, source_bytes_read: 5000, target_bytes_written: 3000, elapsed_ms: 1200,
  });
  assert.equal(state.phase, 'copying');
  assert.equal(state.sourceBackendId, 10);
  assert.equal(state.targetBackendId, 20);
  assert.equal(state.committedRows, 40);
  assert.equal(state.inFlightRows, 10);
  assert.equal(state.remainingRows, 60);
  state = applyRefreshExecutionEvent(state, {
    type: 'done', run_key: 'run', status: 'uncertain', table_index: 2, table_count: 2,
    requested_rows: 80, closure_rows: 20, planned_rows: 100, committed_rows: 40,
    in_flight_rows: 10, remaining_rows: 60, chunks_committed: 4, elapsed_ms: 1250,
    error: 'commit outcome uncertain',
  });
  assert.equal(state.phase, 'done');
  assert.equal(state.status, 'uncertain');
  assert.equal(state.committedRows, 40);
  assert.equal(state.inFlightRows, 10);
  assert.equal(state.remainingRows, 60);
  assert.equal(state.elapsedMs, 1250);
  assert.equal(state.error, 'commit outcome uncertain');
});

test('chunk progress exposes outcomes, measured throughput and hashes without raw keys', () => {
  let state = initialRefreshProgress();
  state = applyRefreshExecutionEvent(state, {
    type: 'chunk', run_key: 'run', table: 'source.children', table_index: 2, table_count: 2,
    chunk_index: 5, outcome: 'inserted_uncommitted', rows: 10,
    requested_rows: 80, closure_rows: 20, planned_rows: 100,
    committed_rows: 40, rows_inserted: 50, in_flight_rows: 10, remaining_rows: 60,
    chunks_committed: 4, rows_per_second: 12.5, eta_seconds: 5, elapsed_ms: 3200,
    source_backend_id: 41, target_backend_id: 42,
    current_key_range: { start_sha256: 'a'.repeat(64), end_sha256: 'b'.repeat(64) },
  });
  assert.equal(state.phase, 'copying');
  assert.equal(state.chunkIndex, 5);
  assert.equal(state.chunkOutcome, 'inserted_uncommitted');
  assert.equal(state.chunkRows, 10);
  assert.equal(state.rowsInserted, 50);
  assert.equal(state.committedRows, 40);
  assert.equal(state.rowsPerSecond, 12.5);
  assert.equal(state.etaSeconds, 5);
  assert.equal(state.currentKeyRange?.startSha256, 'a'.repeat(64));
  assert.equal(state.currentKeyRange?.endSha256, 'b'.repeat(64));
  assert.equal(JSON.stringify(state).includes('private-key'), false);
  state = applyRefreshExecutionEvent(state, {
    type: 'done', run_key: 'run', status: 'uncertain', committed_rows: 40,
    rows_inserted: 50, in_flight_rows: 10, remaining_rows: 60, eta_seconds: null,
  });
  assert.equal(state.status, 'uncertain');
  assert.equal(state.etaSeconds, null);
  assert.equal(state.rowsInserted, 50);
  assert.equal(state.inFlightRows, 10);
});

test('terminal verification retains coverage and hashes without row values', () => {
  const verification = {
    status: 'partial' as const,
    tables: [{
      table: 'source.children', target: 'target.children', selected_rows: 2, committed_rows: 2,
      target_rows: 2, count_status: 'verified', content_status: 'verified', content_sha256: 'c'.repeat(64),
      chunks_checked: 1, chunk_hashes: [{
        chunk_index: 1, rows: 2, outbound_sha256: 'a'.repeat(64), target_sha256: 'a'.repeat(64), matched: true,
      }], chunk_hashes_omitted: 0,
    }],
    foreign_keys: [{ name: 'fk_parent', child: 'source.children', parent: 'source.parents', status: 'verified', orphan_rows: 0 }],
    unverified_columns: [{ table: 'source.parents', column: 'computed', data_type: 'varchar', reason: 'target-generated' }],
    comparable_content_sha256: 'd'.repeat(64),
  };
  let state = applyRefreshExecutionEvent(initialRefreshProgress(), {
    type: 'progress', run_key: 'run', phase: 'verifying', committed_rows: 2,
  });
  assert.equal(state.phase, 'verifying');
  assert.equal(state.verification, null);
  state = applyRefreshExecutionEvent(state, {
    type: 'done', run_key: 'run', status: 'completed', committed_rows: 2, verification,
  });
  assert.equal(state.verification?.status, 'partial');
  assert.equal(state.verification?.tables[0].target_rows, 2);
  assert.equal(state.verification?.foreign_keys[0].orphan_rows, 0);
  assert.equal(state.verification?.unverified_columns.length, 1);
  assert.equal(JSON.stringify(state).includes('private-note'), false);
});
