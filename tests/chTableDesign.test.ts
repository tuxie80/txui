/**
 * ClickHouse table designer dialect (src/utils/chTableDesign.ts).
 *
 * The two things these tests exist to pin down:
 *
 *   1. The MergeTree clauses are spelled right and *required* — a CREATE
 *      without ORDER BY must be refused before it reaches the server.
 *   2. Structural edits to an existing table come back `blocked` with an
 *      explanation and NO sql. A blocked change with SQL, or a rebuild emitted
 *      quietly, is exactly the failure this dialect was written to prevent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chCreateProblems, chCreateTableSql, chDiffTable, chEngineName, chIsMergeTree,
  chIsWidening, chParseType, chRenderType, CH_ENGINES,
} from '../src/utils/chTableDesign.ts';
import { changesToScript, type ColumnDraft, type TableDraft } from '../src/utils/tableDesign.ts';

const col = (name: string, type: string, over: Partial<ColumnDraft> = {}): ColumnDraft =>
  ({ name, type, nullable: false, default: null, ...over });

const tbl = (over: Partial<TableDraft> = {}): TableDraft => ({
  name: 'events',
  columns: [col('ts', 'DateTime'), col('user_id', 'UInt64'), col('msg', 'String', { nullable: true })],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
  engine: 'MergeTree()',
  orderBy: 'ts',
  ...over,
});

const find = (cs: ReturnType<typeof chDiffTable>, subject: string) =>
  cs.find(c => c.subject === subject)!;

// ── engine classification ───────────────────────────────────────────────────

describe('engine classification', () => {
  test('the MergeTree family is recognised by suffix, args included', () => {
    for (const e of ['MergeTree()', 'ReplacingMergeTree(ver)', 'SummingMergeTree()',
                     'AggregatingMergeTree()', 'ReplicatedMergeTree(\'/zk/p\',\'r\')']) {
      assert.ok(chIsMergeTree(e), e);
    }
    for (const e of ['Log', 'TinyLog', 'StripeLog', 'Memory']) {
      assert.ok(!chIsMergeTree(e), e);
    }
  });

  test('the offered list covers the MergeTree family, the Log family and Memory', () => {
    for (const e of ['MergeTree()', 'ReplacingMergeTree()', 'SummingMergeTree()',
                     'AggregatingMergeTree()', 'Log', 'TinyLog', 'StripeLog', 'Memory']) {
      assert.ok(CH_ENGINES.includes(e), e);
    }
    // Replicated* needs cluster arguments a form field would get wrong.
    assert.ok(!CH_ENGINES.some(e => e.startsWith('Replicated')));
  });

  test('chEngineName strips the argument list', () => {
    assert.equal(chEngineName('ReplacingMergeTree(ver)'), 'ReplacingMergeTree');
    assert.equal(chEngineName('Memory'), 'Memory');
  });
});

// ── type wrappers ────────────────────────────────────────────────────────────

describe('Nullable and LowCardinality wrappers', () => {
  /// Nullable inside LowCardinality — the only nesting ClickHouse accepts.
  test('rendering nests Nullable inside LowCardinality', () => {
    assert.equal(chRenderType(col('s', 'String', { nullable: true, lowCardinality: true })),
      'LowCardinality(Nullable(String))');
    assert.equal(chRenderType(col('s', 'String', { nullable: true })), 'Nullable(String)');
    assert.equal(chRenderType(col('s', 'String', { lowCardinality: true })), 'LowCardinality(String)');
    assert.equal(chRenderType(col('n', 'UInt32')), 'UInt32');
  });

  /// A round trip must not grow a second set of wrappers.
  test('parsing what the server reports strips the wrappers back off', () => {
    assert.deepEqual(chParseType('LowCardinality(Nullable(String))'),
      { base: 'String', nullable: true, lowCardinality: true });
    assert.deepEqual(chParseType('Nullable(DateTime)'),
      { base: 'DateTime', nullable: true, lowCardinality: false });
    assert.deepEqual(chParseType('UInt64'),
      { base: 'UInt64', nullable: false, lowCardinality: false });
  });

  test('a parsed wrapper does not double-wrap when re-rendered', () => {
    const p = chParseType('Nullable(String)');
    assert.equal(chRenderType(col('s', p.base, { nullable: p.nullable })), 'Nullable(String)');
  });
});

describe('chIsWidening', () => {
  test('climbing the integer ladders is safe, in family only', () => {
    assert.equal(chIsWidening('UInt8', 'UInt64'), true);
    assert.equal(chIsWidening('Int16', 'Int32'), true);
    assert.equal(chIsWidening('UInt64', 'UInt32'), false);
    /// Signed↔unsigned is never widening: each side has values the other
    /// cannot hold.
    assert.equal(chIsWidening('Int32', 'UInt32'), false);
    assert.equal(chIsWidening('UInt32', 'Int32'), false);
  });

  test('floats widen in one direction only, and unrelated types never do', () => {
    assert.equal(chIsWidening('Float32', 'Float64'), true);
    assert.equal(chIsWidening('Float64', 'Float32'), false);
    assert.equal(chIsWidening('String', 'UInt64'), false);
  });

  test('Decimal precision follows the same argument rule as the other dialects', () => {
    assert.equal(chIsWidening('Decimal(10,2)', 'Decimal(12,2)'), true);
    assert.equal(chIsWidening('Decimal(10,4)', 'Decimal(10,2)'), false);
  });
});

// ── CREATE TABLE ─────────────────────────────────────────────────────────────

describe('creating a ClickHouse table', () => {
  test('MergeTree gets its engine and ORDER BY, and optionally the rest', () => {
    const sql = chCreateTableSql(tbl({
      partitionBy: 'toYYYYMM(ts)', primaryKey: ['ts', 'user_id'], ttl: 'ts + INTERVAL 90 DAY',
    }), 'analytics');
    assert.match(sql, /CREATE TABLE `analytics`\.`events`/);
    assert.match(sql, /ENGINE = MergeTree\(\)/);
    assert.match(sql, /PARTITION BY toYYYYMM\(ts\)/);
    assert.match(sql, /ORDER BY ts/);
    assert.match(sql, /PRIMARY KEY \(`ts`, `user_id`\)/);
    assert.match(sql, /TTL ts \+ INTERVAL 90 DAY/);
  });

  test('the Log family and Memory take no MergeTree clauses', () => {
    const sql = chCreateTableSql(tbl({ engine: 'Log', orderBy: undefined }), 'd');
    assert.match(sql, /ENGINE = Log$/);
    assert.doesNotMatch(sql, /ORDER BY/);
  });

  /// The clause is the table's sorting key, not an optional index — a CREATE
  /// without it is a server error the designer should catch first.
  test('a MergeTree table without ORDER BY is a problem, not a statement', () => {
    const problems = chCreateProblems(tbl({ orderBy: undefined }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ORDER BY/);
    const cs = chDiffTable(null, tbl({ orderBy: undefined }), 'd');
    assert.equal(cs[0].sql, '', 'a statement the server rejects must not be offered');
    assert.ok(cs[0].blocked);
  });

  test('key clauses on a Log engine are refused too', () => {
    assert.equal(chCreateProblems(tbl({ engine: 'TinyLog' })).length, 1);
  });

  test('no engine at all is a problem — ClickHouse has no default', () => {
    assert.match(chCreateProblems(tbl({ engine: undefined }))[0], /no default table engine/);
  });

  test('materialized, alias, default and codec spell the column clause', () => {
    const sql = chCreateTableSql(tbl({
      columns: [
        col('ts', 'DateTime'),
        col('d', 'Date', { generated: 'toDate(ts)', chExprKind: 'materialized' }),
        col('label', 'String', { generated: "concat('u', toString(user_id))", chExprKind: 'alias' }),
        col('retries', 'UInt8', { default: '0' }),
        col('msg', 'String', { nullable: true, codec: 'ZSTD(3)' }),
      ],
    }), 'd');
    assert.match(sql, /`d` Date MATERIALIZED toDate\(ts\)/);
    assert.match(sql, /`label` String ALIAS concat\('u', toString\(user_id\)\)/);
    assert.match(sql, /`retries` UInt8 DEFAULT 0/);
    assert.match(sql, /`msg` Nullable\(String\) CODEC\(ZSTD\(3\)\)/);
  });
});

// ── ALTER: what is supported ─────────────────────────────────────────────────

describe('altering columns', () => {
  test('adding a column is safe metadata, and an expression warns about backfill', () => {
    const next = tbl({ columns: [...tbl().columns, col('extra', 'UInt32', { default: '0' })] });
    const c = find(chDiffTable(tbl(), next, 'd'), 'extra');
    assert.equal(c.risk, 'safe');
    assert.match(c.sql, /ALTER TABLE `d`\.`events` ADD COLUMN `extra` UInt32 DEFAULT 0/);
    assert.match(c.warning!, /not backfilled/);
  });

  test('dropping a column is destructive and a background mutation', () => {
    const next = tbl({ columns: tbl().columns.slice(0, 2) });
    const c = find(chDiffTable(tbl(), next, 'd'), 'msg');
    assert.equal(c.risk, 'destructive');
    assert.match(c.sql, /DROP COLUMN `msg`/);
    assert.match(c.warning!, /mutation/);
    assert.match(c.warning!, /no transaction to roll back/);
  });

  test('renaming a column is safe', () => {
    const next = tbl({
      columns: [tbl().columns[0], tbl().columns[1],
        col('message', 'String', { nullable: true, originalName: 'msg' })],
    });
    const cs = chDiffTable(tbl(), next, 'd');
    assert.deepEqual(cs.map(c => c.kind), ['rename-column']);
    assert.match(cs[0].sql, /RENAME COLUMN `msg` TO `message`/);
  });

  test('widening a type is safe but still a mutation', () => {
    const next = tbl({
      columns: [tbl().columns[0], col('user_id', 'UInt128'), tbl().columns[2]],
    });
    const c = find(chDiffTable(tbl(), next, 'd'), 'user_id');
    assert.equal(c.risk, 'safe');
    assert.equal(c.cost, 'rebuild');
    assert.match(c.sql, /MODIFY COLUMN `user_id` UInt128/);
  });

  test('narrowing a type is lossy and says so', () => {
    const next = tbl({
      columns: [tbl().columns[0], col('user_id', 'UInt16'), tbl().columns[2]],
    });
    const c = find(chDiffTable(tbl(), next, 'd'), 'user_id');
    assert.equal(c.risk, 'lossy');
    assert.match(c.warning!, /UInt64 → UInt16/);
  });

  /// Nullable→plain silently rewrites NULLs to 0/'' — the surprise worth a
  /// warning before it runs.
  test('dropping Nullable warns that NULLs become the type default', () => {
    const next = tbl({
      columns: [tbl().columns[0], tbl().columns[1], col('msg', 'String')],
    });
    const c = find(chDiffTable(tbl(), next, 'd'), 'msg');
    assert.equal(c.risk, 'lossy');
    assert.match(c.warning!, /type default/);
  });

  test('a codec-only change is a MODIFY COLUMN mutation', () => {
    const next = tbl({
      columns: [tbl().columns[0], tbl().columns[1],
        col('msg', 'String', { nullable: true, codec: 'ZSTD(3)' })],
    });
    const c = find(chDiffTable(tbl(), next, 'd'), 'msg');
    assert.equal(c.kind, 'modify-column');
    assert.match(c.sql, /CODEC\(ZSTD\(3\)\)/);
  });

  test('renaming the table uses RENAME TABLE', () => {
    const cs = chDiffTable(tbl(), tbl({ name: 'events_v2', originalName: 'events' }), 'd');
    assert.match(cs[0].sql, /RENAME TABLE `d`\.`events` TO `d`\.`events_v2`/);
  });

  test('TTL is a real ALTER — metadata, picked up as parts merge', () => {
    const next = tbl({ ttl: 'ts + INTERVAL 30 DAY' });
    const c = find(chDiffTable(tbl(), next, 'd'), 'TTL');
    assert.equal(c.kind, 'table-option');
    assert.equal(c.risk, 'safe');
    assert.match(c.sql, /ALTER TABLE `d`\.`events` MODIFY TTL ts \+ INTERVAL 30 DAY/);
    assert.match(c.warning!, /as they merge/);
  });
});

// ── ALTER: what is honestly refused ──────────────────────────────────────────

describe('structural changes are blocked, never silently rebuilt', () => {
  /// The whole safety promise of this dialect in one shape: sql is empty, the
  /// reason is on the change, and the script contains nothing for it.
  const assertBlocked = (cs: ReturnType<typeof chDiffTable>, subject: string, what: RegExp) => {
    const c = find(cs, subject);
    assert.equal(c.sql, '', `no SQL for ${subject}`);
    assert.match(c.blocked!, what);
    assert.ok(!changesToScript(cs).includes('CREATE TABLE'), 'no silent rebuild in the script');
  };

  test('changing the engine of an existing table', () => {
    const cs = chDiffTable(tbl(), tbl({ engine: 'ReplacingMergeTree()' }), 'd');
    assertBlocked(cs, 'ReplacingMergeTree()', /cannot alter the table engine/);
  });

  test('changing ORDER BY, PARTITION BY or PRIMARY KEY', () => {
    assertBlocked(chDiffTable(tbl(), tbl({ orderBy: 'user_id' }), 'd'), 'ORDER BY', /sorting key/);
    assertBlocked(
      chDiffTable(tbl(), tbl({ partitionBy: 'toYYYYMM(ts)' }), 'd'), 'PARTITION BY', /partition key/);
    assertBlocked(
      chDiffTable(tbl(), tbl({ primaryKey: ['ts'] }), 'd'), 'PRIMARY KEY', /primary key/);
  });

  test('the refusal names the honest path instead of emitting it', () => {
    const c = find(chDiffTable(tbl(), tbl({ orderBy: 'user_id' }), 'd'), 'ORDER BY');
    assert.match(c.blocked!, /INSERT INTO new SELECT/);
  });

  /// A cosmetic engine difference is not a change; blocking it would refuse
  /// something the user never asked for.
  test('the same engine in different spacing is not a change', () => {
    assert.deepEqual(chDiffTable(tbl(), tbl({ engine: ' MergeTree() ' }), 'd'), []);
  });
});
