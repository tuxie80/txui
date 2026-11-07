import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRefreshReport } from '../src/utils/refreshReport.ts';
import type { RefreshReportInput } from '../src/utils/refreshReport.ts';
import { initialRefreshProgress } from '../src/utils/refreshExecute.ts';
import { buildRefreshPlan } from '../src/utils/refreshPlan.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';

function fixture(): RefreshReportInput {
  const spec = createDefaultRefreshSpec({
    source: { connectionId: 'c-source', sessionId: 's-source' }, schema: 'shop', cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  spec.target = { connectionId: 'c-target', sessionId: 's-target' };
  spec.seed = 'private-seed-value';
  spec.masks = [
    { table: 'customers', column: 'email', rule: 'constant', value: 'planted-row-value' },
    { table: 'customers', column: 'full_name', rule: 'fake', generator: 'person.full_name' },
  ];
  const progress = {
    ...initialRefreshProgress(),
    runKey: '00000000-0000-4000-8000-000000000099', phase: 'done' as const, status: 'completed' as const,
    requestedRows: 80, closureRows: 20, plannedRows: 100, committedRows: 100, rowsInserted: 100,
    remainingRows: 0, chunksCommitted: 4, sourceBytesRead: 4096, targetBytesWritten: 8192,
    rowsPerSecond: 12.5, elapsedMs: 8000, sourceBackendId: 41, targetBackendId: 42,
    error: 'planted-row-value',
    verification: {
      status: 'partial' as const,
      tables: [{
        table: 'shop.orders', target: 'stage.orders', selected_rows: 100, committed_rows: 100,
        target_rows: 100, count_status: 'verified', content_status: 'verified', content_sha256: 'c'.repeat(64),
        chunks_checked: 4, chunk_hashes: [{
          chunk_index: 4, rows: 20, outbound_sha256: 'a'.repeat(64), target_sha256: 'a'.repeat(64), matched: true,
        }], chunk_hashes_omitted: 2,
      }],
      foreign_keys: [{ name: 'fk_customer', child: 'shop.orders', parent: 'shop.customers', status: 'verified', orphan_rows: 0 }],
      unverified_columns: [{ table: 'shop.customers', column: 'computed', data_type: 'varchar', reason: 'target-generated' }],
      comparable_content_sha256: 'd'.repeat(64),
    },
  };
  const specSha256 = buildRefreshPlan(spec).specSha256;
  return {
    spec, sourceName: 'production source', targetName: 'staging target',
    executionPlan: null, maskPlan: {
      specSha256, catalogSha256: 'e'.repeat(64), complete: true,
      rules: [{ table: 'shop.customers', column: 'full_name', rule: 'fake', generator: 'fullName', relation: null, notes: [] }], blockers: [],
    },
    rowSetPlan: {
      readOnly: true, specSha256, fixedPoint: true, iterations: 3, sourceQueries: 7, sourceRowsRead: 100,
      tables: [{ table: 'shop.orders', action: 'time_window', requested: 80, closureAdded: 20, final: 100, notes: [] }],
      totals: { requested: 80, closureAdded: 20, final: 100 },
      memory: {
        maxPlanningKeys: 1000, planningKeyBatch: 100, closureIdentities: 20, recentRequestedIdentities: 80,
        peakRetainedKeys: 100, peakFrontierRows: 20, peakBufferedRows: 100, fullRootKeysRetained: 0,
      }, blockers: [],
    },
    preflight: { preflightSha256: 'f'.repeat(64), emptyTables: 3 }, progress,
  };
}

test('refresh report is deterministic and covers selection, scope, throughput and verification', () => {
  const input = fixture();
  const first = renderRefreshReport(input);
  const second = renderRefreshReport(input);
  assert.equal(first, second);
  for (const expected of [
    '# Safe Environment Refresh report', '**Outcome:** incomplete', 'Verification is partial',
    '2026-11-05T12:00:00.000Z', '2026-11-06T12:00:00.000Z',
    'requested 80 + closure 20 = final 100', 'Committed rows | 100', 'Measured committed rows/s | 12.5',
    'Comparable-content SHA-256', 'fk_customer', 'target-generated', 'chunk 4',
    'matching chunk hashes omitted from the bounded report', 'terminal error prose is intentionally omitted',
  ]) assert.ok(first.includes(expected), `missing ${expected}`);
  for (const forbidden of ['planted-row-value', 'private-seed-value']) {
    assert.equal(first.includes(forbidden), false, `report leaked ${forbidden}`);
  }
  assert.equal(first.includes('constant (value omitted)'), true);
  assert.equal(first.includes('Seed SHA-256 (seed omitted)'), true);
});

test('only a completed run with complete verification has a completed report outcome', () => {
  const input = fixture();
  input.progress.error = null;
  input.progress.verification!.status = 'verified';
  input.progress.verification!.unverified_columns = [];
  const report = renderRefreshReport(input);
  assert.ok(report.includes('**Outcome:** completed'));
  assert.equal(report.includes('## Incomplete evidence'), false);
});

test('a failed or uncertain run never becomes a success report', () => {
  const input = fixture();
  input.progress.status = 'uncertain';
  input.progress.inFlightRows = 10;
  input.progress.remainingRows = 10;
  const report = renderRefreshReport(input);
  assert.ok(report.includes('**Outcome:** failed'));
  assert.ok(report.includes('outcome is uncertain'));
  assert.ok(report.includes('In-flight rows | 10'));
});
