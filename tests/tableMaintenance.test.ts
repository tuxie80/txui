/**
 * Table maintenance and invalid-object probes (src/utils/tableMaintenance.ts).
 *
 * The risk here is not a wrong query — it is a button that looks harmless and
 * is not. `OPTIMIZE TABLE` on InnoDB rebuilds and locks the table; `REPAIR`
 * does nothing on InnoDB at all and can lose rows on MyISAM. Offering the four
 * operations as equal buttons is how one of them gets run on production by
 * someone who assumed they were all read-only, so most of these tests are
 * about the metadata that keeps them un-equal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPS, findOp, opsFor, maintenanceSql, invalidProbes, describeInvalid, invalidSummary,
  opSummary, opWarning, parseSamplePages, readOnlyProbeSql, readOnlyReason,
  statementSubject,
} from '../src/utils/tableMaintenance.ts';
import type { InvalidObject } from '../src/utils/tableMaintenance.ts';

const TABLES = [
  { schema: 'shop', name: 'orders' },
  { schema: 'shop', name: 'customers' },
];

// ── the operations, and which are dangerous ─────────────────────────────────

test('the destructive operations are marked destructive', () => {
  assert.equal(findOp('optimize')?.destructive, true);
  assert.equal(findOp('repair')?.destructive, true);
  assert.equal(findOp('analyze')?.destructive, false);
  assert.equal(findOp('check')?.destructive, false);
});

test('every destructive operation states its consequence before it runs', () => {
  for (const op of OPS.filter(o => o.destructive)) {
    assert.ok(op.warning, `${op.id} has no warning`);
    assert.ok(op.warning.length > 40, `${op.id}'s warning is too vague to act on`);
  }
});

test('the OPTIMIZE warning names the actual cost — a lock, not slowness', () => {
  assert.match(findOp('optimize')!.warning!, /REBUILD|rebuild/);
  assert.match(findOp('optimize')!.warning!, /lock/i);
});

test('the REPAIR warning says it does nothing on InnoDB', () => {
  // The most common misunderstanding: people run it on InnoDB and think it
  // helped.
  assert.match(findOp('repair')!.warning!, /InnoDB/);
});

test('operations are filtered to the engines that have them', () => {
  const pg = opsFor('postgres').map(o => o.id);
  assert.deepEqual(pg, ['analyze', 'prewarm'],
    'PostgreSQL has no CHECK/OPTIMIZE/REPAIR TABLE, but does get ANALYZE and prewarm');
  const my = opsFor('mysql').map(o => o.id);
  assert.ok(my.includes('check') && my.includes('optimize') && my.includes('repair'));
  assert.deepEqual(opsFor('sqlite'), []);
});

// ── the SQL ─────────────────────────────────────────────────────────────────

test('MySQL gets one statement per table, like every engine', () => {
  // Per-table statements buy a line per table with its own status and
  // milliseconds, progress while the run is in flight, and a cancel that
  // stops at a table boundary — the batched `CHECK TABLE a, b, c` had none.
  const sql = maintenanceSql('check', TABLES, 'mysql');
  assert.deepEqual(sql, ['CHECK TABLE `shop`.`orders`', 'CHECK TABLE `shop`.`customers`']);
});

test('PostgreSQL gets one statement per table', () => {
  // Its ANALYZE takes a single relation; pretending the engines are the same
  // would produce SQL that does not parse.
  const sql = maintenanceSql('analyze', TABLES, 'postgres');
  assert.equal(sql.length, 2);
  assert.equal(sql[0], 'ANALYZE "shop"."orders"');
});

test('an operation an engine does not have produces no SQL', () => {
  assert.deepEqual(maintenanceSql('optimize', TABLES, 'postgres'), []);
  assert.deepEqual(maintenanceSql('repair', TABLES, 'postgres'), []);
});

test('no tables means no statements', () => {
  assert.deepEqual(maintenanceSql('check', [], 'mysql'), []);
});

test('identifiers are quoted and escaped for their engine', () => {
  const my = maintenanceSql('check', [{ schema: 'a`b', name: 't' }], 'mysql');
  assert.match(my[0], /`a``b`/);
  const pg = maintenanceSql('analyze', [{ schema: 'a"b', name: 't' }], 'postgres');
  assert.match(pg[0], /"a""b"/);
});

// ── the analyze dials ─────────────────────────────────────────────────────────

test('MySQL ANALYZE without options is one statement per table', () => {
  assert.deepEqual(maintenanceSql('analyze', TABLES, 'mysql'),
    ['ANALYZE TABLE `shop`.`orders`', 'ANALYZE TABLE `shop`.`customers`']);
  assert.deepEqual(maintenanceSql('analyze', TABLES, 'mysql', {}),
    ['ANALYZE TABLE `shop`.`orders`', 'ANALYZE TABLE `shop`.`customers`']);
});

test('LOCAL goes between ANALYZE and TABLE, and stays out of the binlog', () => {
  assert.deepEqual(maintenanceSql('analyze', TABLES, 'mysql', { local: true }),
    ['ANALYZE LOCAL TABLE `shop`.`orders`', 'ANALYZE LOCAL TABLE `shop`.`customers`']);
});

test('sample pages turn the run into per-table ALTER+ANALYZE pairs', () => {
  // The ALTER is per table, so the ANALYZE must be too — and a cancel gets a
  // table boundary to stop at.
  assert.deepEqual(maintenanceSql('analyze', TABLES, 'mysql', { samplePages: 20 }), [
    'ALTER TABLE `shop`.`orders` STATS_SAMPLE_PAGES=20',
    'ANALYZE TABLE `shop`.`orders`',
    'ALTER TABLE `shop`.`customers` STATS_SAMPLE_PAGES=20',
    'ANALYZE TABLE `shop`.`customers`',
  ]);
});

test('the analyze dials combine, and touch no other operation', () => {
  assert.deepEqual(maintenanceSql('analyze', [{ schema: 's', name: 't' }], 'mysql',
    { local: true, samplePages: 5 }),
    ['ALTER TABLE `s`.`t` STATS_SAMPLE_PAGES=5', 'ANALYZE LOCAL TABLE `s`.`t`']);
  // Options are an Analyze thing; CHECK ignores them rather than mutating.
  assert.deepEqual(maintenanceSql('check', TABLES, 'mysql', { local: true, samplePages: 5 }),
    ['CHECK TABLE `shop`.`orders`', 'CHECK TABLE `shop`.`customers`']);
  // LOCAL is MySQL syntax; it must not leak into the PostgreSQL spelling.
  assert.deepEqual(maintenanceSql('analyze', TABLES, 'postgres', { local: true }),
    ['ANALYZE "shop"."orders"', 'ANALYZE "shop"."customers"']);
});

test('FULLSCAN is opt-in on SQL Server, and absent by default', () => {
  assert.deepEqual(maintenanceSql('analyze', TABLES, 'sqlserver', { fullscan: true }), [
    'UPDATE STATISTICS [shop].[orders] WITH FULLSCAN',
    'UPDATE STATISTICS [shop].[customers] WITH FULLSCAN',
  ]);
  assert.deepEqual(maintenanceSql('analyze', TABLES, 'sqlserver', { fullscan: false }), [
    'UPDATE STATISTICS [shop].[orders]',
    'UPDATE STATISTICS [shop].[customers]',
  ]);
});

test('the sample-pages field accepts a positive integer and nothing else', () => {
  assert.equal(parseSamplePages(''), null);
  assert.equal(parseSamplePages('  '), null);
  assert.equal(parseSamplePages('20'), 20);
  assert.equal(parseSamplePages('0'), 'invalid');
  assert.equal(parseSamplePages('-3'), 'invalid');
  assert.equal(parseSamplePages('2.5'), 'invalid');
  assert.equal(parseSamplePages('abc'), 'invalid');
});

// ── the read-only pre-flight ──────────────────────────────────────────────────

test('every ANALYZE engine has a probe, spelled its own way', () => {
  assert.match(readOnlyProbeSql('mysql')!, /super_read_only/);
  assert.match(readOnlyProbeSql('mysql')!, /read_only/);
  assert.match(readOnlyProbeSql('postgres')!, /pg_is_in_recovery\(\)/);
  assert.match(readOnlyProbeSql('sqlserver')!, /DATABASEPROPERTYEX.*Updateability/);
  // Engines with no ANALYZE have no probe.
  assert.equal(readOnlyProbeSql('sqlite'), null);
  assert.equal(readOnlyProbeSql('clickhouse'), null);
});

test('the probe answer is a reason a human can act on, or null', () => {
  assert.equal(readOnlyReason('mysql', [1, 0]), 'super_read_only=ON');
  assert.equal(readOnlyReason('mysql', [0, 1]), 'read_only=ON');
  assert.equal(readOnlyReason('mysql', ['true', 'false']), 'super_read_only=ON');
  assert.equal(readOnlyReason('mysql', [0, 0]), null);
  assert.equal(readOnlyReason('postgres', ['t']), 'standby server (in recovery)');
  assert.equal(readOnlyReason('postgres', ['true']), 'standby server (in recovery)');
  assert.equal(readOnlyReason('postgres', ['f']), null);
  assert.equal(readOnlyReason('sqlserver', ['READ_ONLY']), 'database is READ_ONLY');
  assert.equal(readOnlyReason('sqlserver', ['READ_WRITE']), null);
  // An empty row is not a verdict — the probe failed, let ANALYZE speak.
  assert.equal(readOnlyReason('mysql', []), null);
  assert.equal(readOnlyReason('postgres', []), null);
});

// ── prewarm: buffer-pool warming, read-only, engine-branched ────────────────

test('prewarm is a read-only operation on the engines that have a way to do it', () => {
  assert.equal(findOp('prewarm')?.destructive, false);
  const my = opsFor('mysql').map(o => o.id);
  const pg = opsFor('postgres').map(o => o.id);
  assert.ok(my.includes('prewarm'));
  assert.ok(pg.includes('prewarm'));
});

test('prewarm names its cost and the pg_prewarm extension it needs', () => {
  const w = findOp('prewarm')!.warning!;
  assert.match(w, /pg_prewarm/);
  assert.match(w, /CREATE EXTENSION/);
  // Honest about the limitation: only the table is warmed, not its indexes.
  assert.match(w, /secondary index/i);
});

test('PostgreSQL prewarm calls pg_prewarm per table with a quoted regclass literal', () => {
  const sql = maintenanceSql('prewarm', TABLES, 'postgres');
  assert.equal(sql.length, 2);
  // The relation is passed as a string literal of the fully-quoted name.
  assert.match(sql[0], /SELECT pg_prewarm\('"shop"\."orders"'\)/);
  assert.match(sql[1], /SELECT pg_prewarm\('"shop"\."customers"'\)/);
});

test('the pg_prewarm extension hint rides the first statement as a comment only', () => {
  const sql = maintenanceSql('prewarm', TABLES, 'postgres');
  // A review-only reminder — a comment, so executing the statement still warms.
  assert.match(sql[0], /^-- requires: CREATE EXTENSION IF NOT EXISTS pg_prewarm;\n/);
  // It is not repeated on every statement.
  assert.doesNotMatch(sql[1], /CREATE EXTENSION/);
});

test('MySQL prewarm forces the clustered index through the pool with COUNT(*)', () => {
  const sql = maintenanceSql('prewarm', TABLES, 'mysql');
  assert.equal(sql.length, 2);
  assert.equal(sql[0], 'SELECT COUNT(*) FROM `shop`.`orders`');
  assert.equal(sql[1], 'SELECT COUNT(*) FROM `shop`.`customers`');
});

test('prewarm quotes identifiers per engine', () => {
  const my = maintenanceSql('prewarm', [{ schema: 'a`b', name: 't' }], 'mysql');
  assert.match(my[0], /FROM `a``b`\.`t`/);
  const pg = maintenanceSql('prewarm', [{ schema: 'a"b', name: 't' }], 'postgres');
  assert.match(pg[0], /pg_prewarm\('"a""b"\."t"'\)/);
});

test('prewarm produces nothing on engines without a buffer pool to warm', () => {
  assert.deepEqual(maintenanceSql('prewarm', TABLES, 'sqlite'), []);
  assert.deepEqual(maintenanceSql('prewarm', TABLES, 'clickhouse'), []);
  assert.deepEqual(maintenanceSql('prewarm', TABLES, 'redis'), []);
  assert.deepEqual(maintenanceSql('prewarm', [], 'mysql'), []);
});

// ── invalid objects ─────────────────────────────────────────────────────────

test('every probe is valid-looking SQL naming its schema', () => {
  for (const engine of ['mysql', 'postgres']) {
    const probes = invalidProbes(engine, 'shop');
    assert.ok(probes.length > 0, engine);
    for (const p of probes) {
      assert.match(p.sql, /^SELECT/i, `${engine}/${p.kind}`);
      assert.match(p.sql, /'shop'/, `${engine}/${p.kind} does not filter by schema`);
      assert.ok(p.columns.length >= 2, `${engine}/${p.kind} returns too few columns`);
      assert.ok(p.label.length > 10, `${engine}/${p.kind} has no readable label`);
    }
  }
});

test('a schema name with a quote cannot break out of the probe', () => {
  for (const p of invalidProbes('mysql', "o'brien")) {
    assert.match(p.sql, /'o''brien'/);
  }
});

test('MySQL probes cover the three things a DROP leaves behind', () => {
  const kinds = invalidProbes('mysql', 's').map(p => p.kind);
  assert.ok(kinds.includes('view'));
  assert.ok(kinds.includes('foreign-key'));
  assert.ok(kinds.includes('trigger'));
});

test('every finding says what is wrong AND what to do', () => {
  for (const engine of ['mysql', 'postgres']) {
    for (const p of invalidProbes(engine, 's')) {
      const found = describeInvalid(p, ['s', 'thing', 'detail']);
      assert.equal(found.schema, 's');
      assert.equal(found.name, 'thing');
      assert.ok(found.problem.length > 20, `${p.kind}: problem`);
      assert.ok(found.action.length > 20, `${p.kind}: action`);
    }
  }
});

test('a broken foreign key names the target that is missing', () => {
  const probe = invalidProbes('mysql', 's').find(p => p.kind === 'foreign-key')!;
  const found = describeInvalid(probe, ['s', 'orders', 'customers']);
  assert.match(found.problem, /customers/);
});

test('the summary counts by kind, and says so plainly when clean', () => {
  assert.equal(invalidSummary([]), 'Nothing broken.');
  const found: InvalidObject[] = [
    { kind: 'view', schema: 's', name: 'a', problem: 'x', action: 'y' },
    { kind: 'view', schema: 's', name: 'b', problem: 'x', action: 'y' },
    { kind: 'trigger', schema: 's', name: 'c', problem: 'x', action: 'y' },
  ];
  const s = invalidSummary(found);
  assert.match(s, /2 views/);
  assert.match(s, /1 trigger\b/);
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('SQL Server offers the four operations it can actually perform', () => {
  const ms = opsFor('sqlserver').map(o => o.id);
  assert.deepEqual([...ms].sort(),
    ['analyze', 'check', 'optimize', 'prewarm', 'reorganize']);
  // REPAIR needs SINGLE_USER, which a pooled connection cannot arrange.
  assert.ok(!ms.includes('repair'));
});

test('ANALYZE on SQL Server is UPDATE STATISTICS, one statement per table', () => {
  assert.deepEqual(maintenanceSql('analyze', TABLES, 'sqlserver'), [
    'UPDATE STATISTICS [shop].[orders]',
    'UPDATE STATISTICS [shop].[customers]',
  ]);
});

test('CHECK asks for TABLERESULTS, or the findings never reach the panel', () => {
  const sql = maintenanceSql('check', [{ schema: 's', name: 'a' }], 'sqlserver');
  // DBCC takes the object as a STRING, not an identifier — bracket-quoting it
  // as an identifier is a syntax error.
  assert.match(sql[0], /DBCC CHECKTABLE \('\[s\]\.\[a\]'\)/);
  assert.match(sql[0], /TABLERESULTS/);
  assert.match(sql[0], /NO_INFOMSGS/);
});

test('rebuild and reorganize are different statements, and only one is destructive', () => {
  assert.deepEqual(maintenanceSql('optimize', [{ schema: 's', name: 'a' }], 'sqlserver'),
    ['ALTER INDEX ALL ON [s].[a] REBUILD']);
  assert.deepEqual(maintenanceSql('reorganize', [{ schema: 's', name: 'a' }], 'sqlserver'),
    ['ALTER INDEX ALL ON [s].[a] REORGANIZE']);
  assert.equal(findOp('optimize')!.destructive, true);
  assert.equal(findOp('reorganize')!.destructive, false);
});

test('REPAIR produces nothing for SQL Server rather than a statement that fails', () => {
  assert.deepEqual(maintenanceSql('repair', TABLES, 'sqlserver'), []);
});

test('reorganize is offered to no other engine', () => {
  for (const e of ['mysql', 'postgres', 'sqlite', 'duckdb', 'clickhouse']) {
    assert.ok(!opsFor(e).some(o => o.id === 'reorganize'), e);
    assert.deepEqual(maintenanceSql('reorganize', TABLES, e), [], e);
  }
});

test('prewarm on SQL Server reads the table, since there is no prewarm command', () => {
  assert.deepEqual(maintenanceSql('prewarm', TABLES, 'sqlserver'), [
    'SELECT COUNT(*) FROM [shop].[orders]',
    'SELECT COUNT(*) FROM [shop].[customers]',
  ]);
});

test('the OPTIMIZE warning describes THIS engine, not the other one', () => {
  const spec = findOp('optimize')!;
  // The MySQL wording talks about InnoDB, which is meaningless in front of a
  // SQL Server — and worse than meaningless, because it will be believed.
  assert.match(opWarning(spec, 'mysql')!, /InnoDB/);
  assert.ok(!/InnoDB/.test(opWarning(spec, 'sqlserver')!));
  assert.match(opWarning(spec, 'sqlserver')!, /schema-modification lock|Offline/i);
  assert.match(opSummary(spec, 'sqlserver'), /ALTER INDEX/);
  // An engine with no override falls back to the shared text.
  assert.equal(opWarning(spec, 'postgres'), spec.warning);
  assert.equal(opSummary(spec, 'postgres'), spec.summary);
});

test('every destructive op has a warning on every engine that offers it', () => {
  for (const op of OPS) {
    if (!op.destructive) continue;
    for (const e of op.engines) {
      assert.ok((opWarning(op, e) ?? '').length > 40, `${op.id} on ${e}`);
    }
  }
});

test('the SQL Server probes exclude the pseudo-tables every trigger references', () => {
  const view = invalidProbes('sqlserver', 'sales').find(p => p.kind === 'view')!;
  // `inserted` and `deleted` never resolve — matching them reports every
  // trigger in the database as broken.
  assert.match(view.sql, /'inserted', 'deleted'/);
  assert.match(view.sql, /NOT LIKE '#%'/);
  assert.match(view.sql, /referenced_id IS NULL/);
});

test('SQL Server probes the two silent failures the other engines cannot have', () => {
  const kinds = invalidProbes('sqlserver', 'sales').map(p => p.kind);
  assert.ok(kinds.includes('constraint'));
  assert.ok(kinds.includes('index'));
  // A foreign key pointing at nothing is not reachable in SQL Server, so it is
  // not probed for — an impossible check is noise, not diligence.
  assert.ok(!kinds.includes('foreign-key'));
});

test('the schema is a literal in every SQL Server probe, escaped', () => {
  for (const p of invalidProbes('sqlserver', "a'b")) {
    assert.match(p.sql, /'a''b'/, p.kind);
  }
});

test('a disabled trigger and a trigger with no table read differently', () => {
  const ms = invalidProbes('sqlserver', 's').find(p => p.kind === 'trigger')!;
  const my = invalidProbes('mysql', 's').find(p => p.kind === 'trigger')!;
  const off = describeInvalid(ms, ['s', 'trg', 'orders']);
  const gone = describeInvalid(my, ['s', 'trg', 'orders']);
  assert.match(off.problem, /Disabled/);
  assert.match(off.action, /ENABLE TRIGGER/);
  assert.match(gone.problem, /does not exist/);
  assert.notEqual(off.action, gone.action);
});

test('an untrusted constraint is explained as unverified, not as missing', () => {
  const p = invalidProbes('sqlserver', 's').find(x => x.kind === 'constraint')!;
  const f = describeInvalid(p, ['s', 'orders', 'ck_status (untrusted)']);
  assert.match(f.action, /WITH CHECK CHECK CONSTRAINT/);
  assert.match(f.action, /new rows only/);
});

test('a disabled clustered index is named as the outage it is', () => {
  const p = invalidProbes('sqlserver', 's').find(x => x.kind === 'index')!;
  assert.match(p.sql, /CLUSTERED — table is offline/);
  const f = describeInvalid(p, ['s', 'orders', 'ix (CLUSTERED — table is offline)']);
  assert.match(f.action, /unreadable/);
});

// ── statement subjects (the progress line) ──────────────────────────────────

test('statementSubject names the table of every generated shape', () => {
  const cases: Array<[string, string]> = [
    ['ANALYZE TABLE `shop`.`orders`', '`shop`.`orders`'],
    ['ANALYZE LOCAL TABLE `shop`.`orders`', '`shop`.`orders`'],
    ['CHECK TABLE `shop`.`orders`', '`shop`.`orders`'],
    ['OPTIMIZE TABLE `shop`.`orders`', '`shop`.`orders`'],
    ['REPAIR TABLE `shop`.`orders`', '`shop`.`orders`'],
    ['ANALYZE "shop"."orders"', '"shop"."orders"'],
    ['ALTER TABLE `shop`.`orders` STATS_SAMPLE_PAGES=20', '`shop`.`orders`'],
    ['UPDATE STATISTICS [shop].[orders] WITH FULLSCAN', '[shop].[orders]'],
    ['ALTER INDEX ALL ON [shop].[orders] REBUILD', '[shop].[orders]'],
    ['SELECT COUNT(*) FROM `shop`.`orders`', '`shop`.`orders`'],
    ["DBCC CHECKTABLE ('shop.orders') WITH NO_INFOMSGS, TABLERESULTS", 'shop.orders'],
    ["SELECT pg_prewarm('shop.orders')", 'shop.orders'],
  ];
  for (const [sql, want] of cases) {
    assert.equal(statementSubject(sql), want, sql);
  }
  // An unrecognized statement labels itself, never a made-up table.
  assert.equal(statementSubject('VACUUM FULL'), 'VACUUM FULL');
});
