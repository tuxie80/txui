/**
 * The extracted SQL Quality pipeline (src/utils/qualityRun.ts, WP-16 16.5):
 * a fake io drives the whole run — the reason the extraction exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQualityAnalysis, isStatementTimeout, type QualityIo, type QualityChecks } from '../src/utils/qualityRun.ts';

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

/**
 * A MariaDB measured plan, trimmed from MariaDB 11.8.8's ANALYZE FORMAT=JSON
 * — the t2 estimate is deliberately 50× low so the estimation finding fires.
 */
const MARIA_ANALYZE_JSON = JSON.stringify({
  query_optimization: { r_total_time_ms: 12.4 },
  query_block: {
    select_id: 1, cost: 1040, r_loops: 1, r_total_time_ms: 12.1,
    nested_loop: [
      { table: {
          table_name: 't2', access_type: 'ALL', loops: 1, r_loops: 1,
          rows: 100, r_rows: 5000, cost: 1030, r_total_time_ms: 11.9,
          filtered: 100, r_filtered: 40 } },
      { table: {
          table_name: 't1', access_type: 'eq_ref', key: 'PRIMARY',
          loops: 5000, r_loops: 5000, rows: 1, r_rows: 1, cost: 0.5,
          r_total_time_ms: 0.2, filtered: 100, r_filtered: 100 } },
    ],
  },
});

test('MariaDB: the guarded analyze parses ANALYZE FORMAT=JSON, not TREE text', async () => {
  const log: string[] = [];
  const io: QualityIo = {
    ...fakeIo(log),
    explainAnalyzeGuarded: async () => MARIA_ANALYZE_JSON,
  };
  const out = await runQualityAnalysis({
    sql: 'SELECT * FROM t2 JOIN t1 ON t1.id = t2.id',
    engine: 'mysql', connectionName: 'test', isMysql: true, isMariaDb: true,
    serverCapable: true, params: '', qCount: 0, varNames: [],
    checks: { ...CHECKS_OFF, analyze: true }, timeoutSec: 5, dbOverride: '',
  }, io);
  assert.ok(log.some(l => l.startsWith('ANALYZE FORMAT=JSON')), JSON.stringify(log));
  const section = out.sections.find(s => s.title.startsWith('ANALYZE FORMAT=JSON (measured'));
  assert.ok(section, JSON.stringify(out.sections.map(s => s.title)));
  // The 50× underestimate on t2 must surface as a finding — proof the JSON
  // went through the measured-plan analyzer rather than the TREE-text one
  // (which would have parsed nothing).
  assert.ok(
    out.findings.some(f => /[Uu]nderestimated|Estimation/.test(f.title)),
    `no estimation finding: ${JSON.stringify(out.findings.map(f => f.title))}`);
});

test('a non-timeout analyze failure is not dressed up as a timeout', async () => {
  const log: string[] = [];
  const io: QualityIo = {
    ...fakeIo(log),
    explainAnalyzeGuarded: async () => {
      throw new Error("You have an error in your SQL syntax near 'bogus'");
    },
  };
  const out = await runQualityAnalysis({
    sql: 'SELECT bogus FROM orders',
    engine: 'mysql', connectionName: 'test', isMysql: true,
    serverCapable: true, params: '', qCount: 0, varNames: [],
    checks: { ...CHECKS_OFF, analyze: true }, timeoutSec: 5, dbOverride: '',
  }, io);
  // The old catch-all reported ANY error as the red "did not finish" finding —
  // a fabricated timeout verdict inside an exported report.
  assert.ok(!out.findings.some(f => f.id === 'X1'),
    `fabricated timeout finding: ${JSON.stringify(out.findings.map(f => f.title))}`);
  assert.ok(!out.txt.includes('did not finish'), 'the export must not claim a timeout');
  const section = out.sections.find(s => s.title === 'EXPLAIN ANALYZE (failed)');
  assert.ok(section, JSON.stringify(out.sections.map(s => s.title)));
  assert.ok(section.md.includes('syntax'), section.md);
});

test('a genuine guard timeout is still the headline red finding', async () => {
  const log: string[] = [];
  const io: QualityIo = {
    ...fakeIo(log),
    explainAnalyzeGuarded: async () => {
      throw new Error('ERROR 3024 (HY000): Query execution was interrupted, maximum statement execution time exceeded');
    },
  };
  const out = await runQualityAnalysis({
    sql: 'SELECT * FROM orders',
    engine: 'mysql', connectionName: 'test', isMysql: true,
    serverCapable: true, params: '', qCount: 0, varNames: [],
    checks: { ...CHECKS_OFF, analyze: true }, timeoutSec: 5, dbOverride: '',
  }, io);
  const x1 = out.findings.find(f => f.id === 'X1');
  assert.ok(x1, 'the timeout finding must fire');
  assert.equal(x1.severity, 'red');
  assert.ok(x1.title.includes('did not finish in 5s'), x1.title);
  assert.ok(out.sections.some(s => s.title === 'EXPLAIN ANALYZE (timed out)'));
});

test('isStatementTimeout recognises each server\'s guard error and nothing else', () => {
  // MySQL 3024, MariaDB 1969 (max_statement_time — the guard the backend sets
  // on MariaDB), PostgreSQL statement_timeout.
  assert.equal(isStatementTimeout('ERROR 3024 (HY000): Query execution was interrupted, maximum statement execution time exceeded'), true);
  assert.equal(isStatementTimeout('ERROR 1969 (70100): Query execution was interrupted (max_statement_time exceeded)'), true);
  assert.equal(isStatementTimeout('ERROR: canceling statement due to statement timeout'), true);
  assert.equal(isStatementTimeout("You have an error in your SQL syntax near 'x'"), false);
  assert.equal(isStatementTimeout('connection reset by peer'), false);
});
