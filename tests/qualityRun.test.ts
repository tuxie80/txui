/**
 * The extracted SQL Quality pipeline (src/utils/qualityRun.ts, WP-16 16.5):
 * a fake io drives the whole run — the reason the extraction exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQualityAnalysis, type QualityIo, type QualityChecks } from '../src/utils/qualityRun.ts';

const CHECKS_OFF: QualityChecks = {
  lint: false, columnMap: false, stats: false, tables: false, types: false,
  ceilings: false, explain: false, explainJson: false, analyze: false,
};

function fakeIo(log: string[]): QualityIo {
  return {
    say: m => log.push(m),
    query: async () => ({ columns: [], rows: [], rows_affected: null, execution_ms: 0, fetch_ms: 0, warnings: [] }),
    getDdl: async () => 'CREATE TABLE t (id INT)',
    columnMap: async () => ({ parse_ok: false, parse_error: null, statement_kind: null, tables: [], columns: [], eq_cols: [], range_cols: [], sources: [] }),
    explainQuery: async () => ({ format: 'text', engine: 'mysql', content: '' }),
    explainWithWarnings: async () => ({ explain: { columns: [], rows: [], rows_affected: null, execution_ms: 0, fetch_ms: 0, warnings: [] }, warnings: null }),
    explainAnalyzeGuarded: async () => '',
  };
}

test('static lint runs offline and assembles a report', async () => {
  const log: string[] = [];
  const out = await runQualityAnalysis({
    sql: 'SELECT * FROM orders',
    engine: 'mysql', connectionName: 'test', isMysql: true,
    serverCapable: false, params: '', qCount: 0, varNames: [],
    checks: { ...CHECKS_OFF, lint: true }, timeoutSec: 5, dbOverride: '',
  }, fakeIo(log));
  assert.ok(out.sections.some(s => s.title === 'Static analysis'));
  assert.ok(out.findings.some(f => /SELECT \*/i.test(f.title) || /select \*/i.test(f.detail)),
    `lint should flag SELECT * — got ${JSON.stringify(out.findings.map(f => f.title))}`);
  assert.equal(out.meta.engine, 'mysql');
  assert.equal(out.meta.sql, 'SELECT * FROM orders');
  // buildRawTxt carries only sections' RAW blocks — the header proves the
  // assembly ran with this run's identity.
  assert.match(out.txt, /SQL QUALITY RAW OUTPUT — test \(mysql\)/);
  assert.equal(out.rawBlocks[0].label, '⚑ Findings');
  assert.ok(log.some(l => l.includes('Static analysis')));
});

test('pasted CREATE TABLE routes into the DDL audit, no server needed', async () => {
  const log: string[] = [];
  const out = await runQualityAnalysis({
    sql: 'CREATE TABLE t (id INT, name VARCHAR(255))',
    engine: 'mysql', connectionName: 'test', isMysql: true,
    serverCapable: false, params: '', qCount: 0, varNames: [],
    checks: CHECKS_OFF, timeoutSec: 5, dbOverride: '',
  }, fakeIo(log));
  assert.ok(out.sections.some(s => s.title.startsWith('Table design audit')),
    JSON.stringify(out.sections.map(s => s.title)));
});
