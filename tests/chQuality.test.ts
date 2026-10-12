/**
 * The ClickHouse SQL Quality rulebook (src/utils/chQuality.ts): every rule
 * over the tests/fixtures/ch-* captures plus synthetic SQL, including the
 * no-false-positive cases — a pruned query must come back clean.
 *
 * The ch-* fixtures are CONSTRUCTED from the documented 26.x EXPLAIN output
 * shapes (no live server was reachable when they were written); the live
 * shape check is src-tauri/src/db/clickhouse_live_tests.rs
 * (clickhouse_live_quality_shapes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  chStaticRules, chMetadataRules, chExplainRules, chEstimateRules,
  chQueryLogFinding, parseChEstimate, chPredicates, keyEntries,
  CH_M2_LARGE_TABLE,
} from '../src/utils/chQuality.ts';
import type { ChTableMeta } from '../src/utils/chQuality.ts';

const fx = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const PRUNED = fx('ch-explain-indexes.txt');
const NOPRUNE = fx('ch-explain-indexes-noprune.txt');
const ESTIMATE = fx('ch-explain-estimate.tsv');

function mkMeta(over: Partial<ChTableMeta> = {}): ChTableMeta {
  return {
    name: 'default.events',
    engine: 'MergeTree',
    partitionKey: 'toYYYYMM(event_date)',
    sortingKey: 'user_id, event_time',
    primaryKey: 'user_id, event_time',
    totalRows: 500_000_000,
    columns: new Map([
      ['user_id', { inPartition: false, inSorting: true, inPrimary: true, type: 'UInt64' }],
      ['event_time', { inPartition: false, inSorting: true, inPrimary: true, type: 'DateTime' }],
      ['event_date', { inPartition: true, inSorting: false, inPrimary: false, type: 'Date' }],
      ['status', { inPartition: false, inSorting: false, inPrimary: false, type: 'LowCardinality(String)' }],
      ['amount', { inPartition: false, inSorting: false, inPrimary: false, type: 'Decimal(10, 2)' }],
    ]),
    ...over,
  };
}

const mapOf = (...ms: ChTableMeta[]) => new Map(ms.map(m => [m.name, m]));

const ids = (fs: { id: string }[]) => fs.map(f => f.id);

// ── key-expression parsing ──────────────────────────────────────────────────

test('keyEntries reads bare and monotonic-wrapped columns, rejects tuple()', () => {
  assert.deepEqual(keyEntries('tuple()'), []);
  const e = keyEntries('user_id, toYYYYMM(ts)');
  assert.equal(e[0].column, 'user_id');
  assert.equal(e[1].column, 'ts'); // monotonic wrapper is transparent
  assert.equal(keyEntries('murmurHash3_64(x)')[0].column, null); // opaque
});

// ── CH-S* static rules ──────────────────────────────────────────────────────

test('CH-S1 flags an unbounded read but not a bounded one', () => {
  assert.ok(ids(chStaticRules('SELECT x FROM t')).includes('CH-S1'));
  assert.ok(!ids(chStaticRules('SELECT x FROM t WHERE y = 1')).includes('CH-S1'));
  assert.ok(!ids(chStaticRules('SELECT x FROM t LIMIT 10')).includes('CH-S1'));
});

test('CH-S2 names the column count and width once metadata resolves', () => {
  const bare = chStaticRules('SELECT * FROM events');
  assert.equal(bare.find(f => f.id === 'CH-S2')?.severity, 'yellow');

  const wide = new Map(Array.from({ length: 25 }, (_, i) =>
    [`c${i}`, { inPartition: false, inSorting: false, inPrimary: false, type: 'String' }]));
  const m = mkMeta({ columns: wide as ChTableMeta['columns'] });
  const rich = chStaticRules('SELECT * FROM events', mapOf(m));
  const f = rich.find(x => x.id === 'CH-S2');
  assert.equal(f?.severity, 'orange');
  assert.match(f!.title, /25 columns/);
});

test('CH-S3 flags FINAL', () => {
  assert.ok(ids(chStaticRules('SELECT id FROM db.t FINAL WHERE id = 1')).includes('CH-S3'));
  assert.ok(!ids(chStaticRules('SELECT id FROM db.t WHERE id = 1')).includes('CH-S3'));
});

test('CH-S4 flags arrayJoin', () => {
  assert.ok(ids(chStaticRules('SELECT arrayJoin(tags) FROM t LIMIT 5')).includes('CH-S4'));
});

test('CH-S5 flags cartesian joins, keyed comma joins stay clean', () => {
  assert.ok(ids(chStaticRules('SELECT a.x FROM a CROSS JOIN b')).includes('CH-S5'));
  assert.ok(ids(chStaticRules('SELECT a.x FROM a, b')).includes('CH-S5'));
  const keyed = chStaticRules('SELECT a.x FROM a, b WHERE a.id = b.a_id');
  assert.ok(!ids(keyed).includes('CH-S5'), JSON.stringify(ids(keyed)));
});

test('CH-S6 flags ORDER BY without LIMIT', () => {
  assert.ok(ids(chStaticRules('SELECT x FROM t WHERE y = 1 ORDER BY x')).includes('CH-S6'));
  assert.ok(!ids(chStaticRules('SELECT x FROM t ORDER BY x LIMIT 10')).includes('CH-S6'));
});

test('CH-S7 flags leading-wildcard LIKE only', () => {
  assert.ok(ids(chStaticRules("SELECT x FROM t WHERE name LIKE '%son'")).includes('CH-S7'));
  assert.ok(!ids(chStaticRules("SELECT x FROM t WHERE name LIKE 'JOHN%'")).includes('CH-S7'));
});

test('CH-S8 flags function-wrapped predicates; monotonic ranges stay clean', () => {
  const eq = chStaticRules("SELECT x FROM t WHERE toDate(ts) = '2026-09-01'");
  assert.ok(ids(eq).includes('CH-S8'));
  assert.match(eq.find(f => f.id === 'CH-S8')!.fix!, /ts >= /);

  // a range through a monotonic function prunes fine in ClickHouse
  assert.ok(!ids(chStaticRules("SELECT x FROM t WHERE toDate(ts) >= '2026-09-01' AND toDate(ts) < '2026-10-01'"))
    .includes('CH-S8'));

  // an opaque wrapper is never prunable
  assert.ok(ids(chStaticRules("SELECT x FROM t WHERE lower(email) = 'a@b.c'")).includes('CH-S8'));
});

test('chPredicates separates plain and wrapped columns', () => {
  const p = chPredicates("SELECT 1 FROM t WHERE user_id = 5 AND toDate(ts) = '2026-01-01'");
  assert.deepEqual(p.plain, ['user_id']);
  assert.deepEqual(p.wrapped, [{ fn: 'todate', column: 'ts', op: '=' }]);
});

// ── CH-M* metadata rules ────────────────────────────────────────────────────

test('CH-M1 flags ORDER BY tuple() on a MergeTree table', () => {
  const m = mkMeta({ sortingKey: 'tuple()', primaryKey: 'tuple()' });
  const f = chMetadataRules('SELECT x FROM default.events WHERE status = \'a\'', mapOf(m));
  assert.ok(ids(f).includes('CH-M1'));
});

test('CH-M2 fires on a large table when predicates touch no pruning surface', () => {
  const m = mkMeta();
  const bad = chMetadataRules("SELECT x FROM default.events WHERE status = 'refunded'", mapOf(m));
  assert.ok(ids(bad).includes('CH-M2'), JSON.stringify(ids(bad)));

  // leading key column prunes
  const key = chMetadataRules('SELECT x FROM default.events WHERE user_id = 8793', mapOf(m));
  assert.ok(!ids(key).includes('CH-M2'));
  // partition-key column (bare, through the monotonic toYYYYMM wrapper) prunes
  const part = chMetadataRules("SELECT x FROM default.events WHERE event_date = '2026-09-01'", mapOf(m));
  assert.ok(!ids(part).includes('CH-M2'));
  // small tables are not worth the advice
  const small = mkMeta({ totalRows: CH_M2_LARGE_TABLE - 1 });
  const tiny = chMetadataRules("SELECT x FROM default.events WHERE status = 'refunded'", mapOf(small));
  assert.ok(!ids(tiny).includes('CH-M2'));
});

test('CH-M3 notes Distributed fan-out', () => {
  const m = mkMeta({ name: 'default.events_dist', engine: 'Distributed' });
  const f = chMetadataRules('SELECT x FROM default.events_dist WHERE user_id = 1', mapOf(m));
  assert.equal(f.find(x => x.id === 'CH-M3')?.severity, 'info');
});

test('CH-M4 flags a function hiding the partition key; the key expression itself is fine', () => {
  const m = mkMeta(); // partition key toYYYYMM(event_date)
  const bad = chMetadataRules("SELECT x FROM default.events WHERE toDate(event_date) = '2026-09-01'", mapOf(m));
  assert.ok(ids(bad).includes('CH-M4'), JSON.stringify(ids(bad)));
  const good = chMetadataRules('SELECT x FROM default.events WHERE toYYYYMM(event_date) = 202609', mapOf(m));
  assert.ok(!ids(good).includes('CH-M4'), JSON.stringify(ids(good)));
});

// ── CH-E* EXPLAIN indexes = 1 ───────────────────────────────────────────────

test('a pruned plan comes back CLEAN (no false positives)', () => {
  const sql = "SELECT user_id, event_time, amount FROM default.events WHERE event_date = '2026-09-01' AND user_id = 8793";
  const f = chExplainRules(sql, PRUNED, mapOf(mkMeta()));
  assert.deepEqual(ids(f).filter(i => i.startsWith('CH-E')), [], JSON.stringify(ids(f)));
});

test('CH-E1 is red when a WHERE prunes nothing, quoting parts verbatim', () => {
  const sql = "SELECT user_id FROM default.events WHERE status = 'refunded'";
  const f = chExplainRules(sql, NOPRUNE, mapOf(mkMeta()));
  const e1 = f.find(x => x.id === 'CH-E1');
  assert.equal(e1?.severity, 'red');
  assert.match(e1!.detail, /Parts: 12\/12/);
  assert.match(e1!.detail, /Granules: 98154\/98154/);
});

test('CH-E1 is orange without a WHERE', () => {
  const f = chExplainRules('SELECT user_id FROM default.events', NOPRUNE, mapOf(mkMeta()));
  assert.equal(f.find(x => x.id === 'CH-E1')?.severity, 'orange');
});

test('CH-E2 fires when a partitioned table shows no Partition/MinMax entry', () => {
  const planOnlyPk = [
    'Expression (Projection)',
    '  ReadFromMergeTree (default.events)',
    '    Indexes:',
    '      PrimaryKey',
    '        Condition: true',
    '        Parts: 12/12',
    '        Granules: 98154/98154',
  ].join('\n');
  const f = chExplainRules('SELECT x FROM default.events WHERE user_id = 1', planOnlyPk, mapOf(mkMeta()));
  assert.ok(ids(f).includes('CH-E2'), JSON.stringify(ids(f)));
});

// ── CH-T* EXPLAIN ESTIMATE ──────────────────────────────────────────────────

test('parseChEstimate reads the five-column TSV', () => {
  const rows = parseChEstimate(ESTIMATE);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { db: 'default', table: 'events', parts: 12, rows: 800_000_000, marks: 98154 });
  assert.throws(() => parseChEstimate('not an estimate'), /no EXPLAIN ESTIMATE rows/);
});

test('CH-T1 fires over the 1B threshold without LIMIT, stays clean with one', () => {
  const rows = parseChEstimate(ESTIMATE); // 1.12B total
  const big = chEstimateRules('SELECT x FROM default.events, default.events_archive', rows, mapOf(mkMeta()));
  assert.ok(ids(big).includes('CH-T1'));
  const bounded = chEstimateRules('SELECT x FROM default.events LIMIT 100', rows, mapOf(mkMeta()));
  assert.ok(!ids(bounded).includes('CH-T1'));
});

test('CH-T1 whole-table variant fires under the row threshold', () => {
  const rows = [{ db: 'default', table: 'events', parts: 12, rows: 490_000_000, marks: 98154 }];
  const f = chEstimateRules('SELECT x FROM default.events', rows, mapOf(mkMeta())); // 98% of 500M
  assert.ok(ids(f).includes('CH-T1'));
});

test('CH-T2 flags many parts with few rows each', () => {
  const rows = [{ db: 'default', table: 'events', parts: 80, rows: 400_000, marks: 400 }];
  const f = chEstimateRules('SELECT x FROM default.events LIMIT 1', rows, mapOf(mkMeta()));
  const t2 = f.find(x => x.id === 'CH-T2');
  assert.equal(t2?.severity, 'yellow');
  assert.match(t2!.title, /80 parts/);
  // healthy part sizes stay clean
  const ok = chEstimateRules('SELECT x FROM default.events LIMIT 1',
    [{ db: 'default', table: 'events', parts: 80, rows: 800_000_000, marks: 98154 }], mapOf(mkMeta()));
  assert.ok(!ids(ok).includes('CH-T2'));
});

// ── CH-Q1 system.query_log ──────────────────────────────────────────────────

test('CH-Q1 summarizes measured history and degrades honestly when empty', () => {
  const empty = chQueryLogFinding(null);
  assert.equal(empty.severity, 'info');
  assert.match(empty.title, /no completed runs/);

  const stats = chQueryLogFinding({ executions: 17, avgReadRows: 42_000_000, avgReadBytes: 3.2 * 1024 ** 3, avgDurationMs: 1840 });
  assert.equal(stats.severity, 'info');
  assert.match(stats.title, /17 runs/);
  assert.match(stats.title, /GiB/);
});
