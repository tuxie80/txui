/**
 * The ClickHouse SQL Quality pipeline (src/utils/qualityRunCh.ts): a fake
 * QualityIo drives the whole run end-to-end, mirroring tests/qualityRun.test.ts
 * — the reason the pipeline is a separate pure module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runChQualityAnalysis } from '../src/utils/qualityRunCh.ts';
import type { ChQualityChecks } from '../src/utils/qualityRunCh.ts';
import type { QualityIo } from '../src/utils/qualityRun.ts';
import type { QueryResult } from '../src/types';

const fx = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const NOPRUNE = fx('ch-explain-indexes-noprune.txt');
const ESTIMATE = fx('ch-explain-estimate.tsv');
const PIPELINE = fx('ch-explain-pipeline.txt');

const CHECKS_ON: ChQualityChecks = {
  lint: true, columnMap: true, tables: true, explain: true, queryLog: true,
};

function qr(columns: [string, string][], rows: unknown[][]): QueryResult {
  return {
    columns: columns.map(([name, t]) => ({
      name, type_name: t, nullable: t.includes('Nullable('),
    })),
    rows, rows_affected: null, execution_ms: 1, fetch_ms: 0, warnings: [],
  };
}

function fakeIo(log: string[], opts: { queryLogFails?: boolean } = {}): QualityIo {
  return {
    say: m => log.push(m),
    query: async (sql: string): Promise<QueryResult> => {
      if (/currentDatabase/.test(sql)) return qr([['currentDatabase()', 'String']], [['default']]);
      if (/FROM system\.tables WHERE name IN/.test(sql)) return qr([['name', 'String'], ['database', 'String']], [['events', 'default']]);
      if (/FROM system\.tables WHERE database/.test(sql)) {
        return qr(
          [['database', 'String'], ['name', 'String'], ['engine', 'String'], ['total_rows', 'Nullable(UInt64)'],
           ['total_bytes', 'Nullable(UInt64)'], ['partition_key', 'String'], ['sorting_key', 'String'], ['primary_key', 'String']],
          [['default', 'events', 'MergeTree', 800_000_000, 12_000_000_000, 'toYYYYMM(event_date)', 'user_id, event_time', 'user_id, event_time']]);
      }
      if (/FROM system\.columns/.test(sql)) {
        return qr(
          [['database', 'String'], ['table', 'String'], ['name', 'String'], ['type', 'String'],
           ['is_in_partition_key', 'UInt8'], ['is_in_sorting_key', 'UInt8'], ['is_in_primary_key', 'UInt8']],
          [
            ['default', 'events', 'user_id', 'UInt64', 0, 1, 1],
            ['default', 'events', 'event_time', 'DateTime', 0, 1, 1],
            ['default', 'events', 'event_date', 'Date', 1, 0, 0],
            ['default', 'events', 'status', 'LowCardinality(String)', 0, 0, 0],
            ['default', 'events', 'amount', 'Nullable(Decimal(10, 2))', 0, 0, 0],
          ]);
      }
      if (/LIMIT 0$/.test(sql)) {
        return qr(
          [['user_id', 'UInt64'], ['event_time', 'DateTime'], ['amount', 'Nullable(Decimal(10, 2))']],
          []);
      }
      if (/FROM system\.query_log/.test(sql)) {
        if (opts.queryLogFails) throw new Error('ACCESS_DENIED: Not enough privileges');
        return qr(
          [['executions', 'UInt64'], ['avg_read_rows', 'Float64'], ['avg_read_bytes', 'Float64'], ['avg_ms', 'Float64']],
          [[17, 42_000_000, 3.2 * 1024 ** 3, 1840]]);
      }
      throw new Error(`fake io: unexpected query: ${sql}`);
    },
    getDdl: async () => 'CREATE TABLE default.events (user_id UInt64, event_time DateTime) ENGINE = MergeTree ORDER BY (user_id, event_time)',
    columnMap: async () => { throw new Error('column_map has no ClickHouse arm — the panel must not call it'); },
    explainQuery: async (_sql, _db, mode) => ({
      format: 'text', engine: 'clickhouse',
      content: mode === 'estimate' ? ESTIMATE : mode === 'pipeline' ? PIPELINE : NOPRUNE,
    }),
    explainWithWarnings: async () => { throw new Error('MySQL-only path'); },
    explainAnalyzeGuarded: async () => { throw new Error('not offered for ClickHouse'); },
  };
}

const INPUT = {
  sql: 'SELECT user_id, event_time, amount FROM events',
  engine: 'clickhouse', connectionName: 'ch-test',
  params: '', qCount: 0, varNames: [] as string[],
  checks: CHECKS_ON, dbOverride: '',
};

test('a full CH run assembles every section and the CH findings', async () => {
  const log: string[] = [];
  const out = await runChQualityAnalysis(INPUT, fakeIo(log));

  const titles = out.sections.map(s => s.title);
  for (const t of [
    'Static analysis (ClickHouse rules)',
    'Column map',
    'Referenced tables (sizes + keys)',
    'EXPLAIN indexes = 1 (index pruning)',
    'Query plan (estimated)',
    'EXPLAIN PIPELINE (raw — no rules yet)',
    'Recent executions (system.query_log)',
  ]) assert.ok(titles.includes(t), `missing section ${t} — got ${JSON.stringify(titles)}`);

  const ids = out.findings.map(f => f.id);
  // unbounded SELECT over an 800M-row table: S1 + a measured T1 upgrade
  assert.ok(ids.includes('CH-S1'), JSON.stringify(ids));
  assert.ok(ids.includes('CH-T1'), JSON.stringify(ids));
  // no WHERE over the no-pruning plan: E1 orange (not red)
  assert.equal(out.findings.find(f => f.id === 'CH-E1')?.severity, 'orange');
  // query_log history summarized
  assert.match(out.findings.find(f => f.id === 'CH-Q1')?.title ?? '', /17 runs/);
  // column map came from LIMIT 0, not from a column_map command
  assert.ok(ids.includes('CM'));
  const cm = out.sections.find(s => s.title === 'Column map');
  assert.match(cm!.md, /Nullable\(Decimal\(10, 2\)\) {2}NULL/);

  assert.equal(out.meta.engine, 'clickhouse');
  assert.match(out.txt, /SQL QUALITY RAW OUTPUT — ch-test \(clickhouse\)/);
  assert.equal(out.rawBlocks[0].label, '⚑ Findings');
  assert.ok(log.some(l => l.includes('Static analysis')));
  assert.ok(log.some(l => l.includes('EXPLAIN ESTIMATE')));
});

test('the query_log section degrades honestly without the grant — the run survives', async () => {
  const log: string[] = [];
  const out = await runChQualityAnalysis(INPUT, fakeIo(log, { queryLogFails: true }));
  const s = out.sections.find(x => x.title === 'Recent executions (system.query_log)');
  assert.match(s!.md, /_Unavailable: ACCESS_DENIED/);
  assert.match(s!.md, /grant-gated/);
  // everything else still reported
  assert.ok(out.sections.some(x => x.title === 'EXPLAIN indexes = 1 (index pruning)'));
  assert.ok(!out.findings.some(f => f.id === 'CH-Q1'));
});

test('a WHERE that prunes nothing is the red E1 case end-to-end', async () => {
  const log: string[] = [];
  const out = await runChQualityAnalysis(
    { ...INPUT, sql: "SELECT user_id FROM events WHERE status = 'refunded'" }, fakeIo(log));
  assert.equal(out.findings.find(f => f.id === 'CH-E1')?.severity, 'red');
  // and the metadata rules join in: status is on no key of a large table
  assert.ok(out.findings.some(f => f.id === 'CH-M2'), JSON.stringify(out.findings.map(f => f.id)));
});
