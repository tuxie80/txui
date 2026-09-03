/**
 * View / materialized-view DDL (src/utils/viewDdl.ts).
 *
 * A view is inert data-wise, so the failures worth guarding are structural:
 * generating `CREATE OR REPLACE` on an engine that lacks it, quoting an
 * identifier with the wrong bracket, or silently dropping a materialized
 * view's rows without saying so. The builder is pure, so `node --test` covers
 * every branch without a server.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSql, dropSql, refreshSql, changesFor, parseBody, parseClickhouseMatview,
  listSql, schemaListSql, worstRisk, toScript,
  type ViewDef,
} from '../src/utils/viewDdl.ts';

const view = (over: Partial<ViewDef> = {}): ViewDef => ({
  schema: 'app', name: 'v_orders', kind: 'view',
  body: 'SELECT id, total FROM orders WHERE total > 0',
  ...over,
});
const matview = (over: Partial<ViewDef> = {}): ViewDef =>
  view({ name: 'mv_daily', kind: 'matview', ...over });

describe('creating a plain view', () => {
  test('PostgreSQL uses CREATE OR REPLACE and double quotes', () => {
    const sql = createSql(view(), 'postgres');
    assert.match(sql, /CREATE OR REPLACE VIEW "app"\."v_orders" AS/);
    assert.match(sql, /SELECT id, total FROM orders WHERE total > 0/);
    assert.doesNotMatch(sql, /MATERIALIZED/);
  });

  test('MySQL uses backticks', () => {
    const sql = createSql(view(), 'mysql');
    assert.match(sql, /CREATE OR REPLACE VIEW `app`\.`v_orders` AS/);
  });

  test('ClickHouse uses backticks and OR REPLACE', () => {
    const sql = createSql(view(), 'clickhouse');
    assert.match(sql, /CREATE OR REPLACE VIEW `app`\.`v_orders` AS/);
  });

  test('SQLite has no OR REPLACE — plain CREATE VIEW with double quotes', () => {
    const sql = createSql(view(), 'sqlite');
    assert.match(sql, /^CREATE VIEW "app"\."v_orders" AS/);
    assert.doesNotMatch(sql, /OR REPLACE/);
  });

  test('a reserved-word name is quoted so it still resolves', () => {
    const sql = createSql(view({ name: 'order' }), 'postgres');
    assert.match(sql, /VIEW "app"\."order" AS/);
  });

  test('a leading AS and a trailing semicolon in the body are trimmed', () => {
    const sql = createSql(view({ body: 'AS SELECT 1;' }), 'postgres');
    assert.match(sql, /AS\nSELECT 1$/);
    assert.doesNotMatch(sql, /AS\nAS/);
  });

  test('an empty schema is not qualified', () => {
    const sql = createSql(view({ schema: '' }), 'sqlite');
    assert.match(sql, /CREATE VIEW "v_orders" AS/);
  });
});

describe('creating a materialized view (PostgreSQL)', () => {
  test('CREATE MATERIALIZED VIEW … WITH DATA by default', () => {
    const sql = createSql(matview(), 'postgres');
    assert.match(sql, /CREATE MATERIALIZED VIEW "app"\."mv_daily" AS/);
    assert.match(sql, /WITH DATA$/);
    assert.doesNotMatch(sql, /OR REPLACE/);
  });

  test('WITH NO DATA when asked to build it empty', () => {
    const sql = createSql(matview({ withData: false }), 'postgres');
    assert.match(sql, /WITH NO DATA$/);
  });

  test('a matview never gets OR REPLACE even when requested', () => {
    const sql = createSql(matview(), 'postgres', true);
    assert.doesNotMatch(sql, /OR REPLACE/);
  });
});

describe('creating a materialized view (ClickHouse)', () => {
  const chmv = (over: Partial<ViewDef> = {}): ViewDef =>
    matview({ body: 'SELECT day, count() AS c FROM events GROUP BY day', ...over });

  test('TO-form targets a table and has no ENGINE or POPULATE', () => {
    const sql = createSql(chmv({ chTarget: 'to', chTo: 'app.mv_target' }), 'clickhouse');
    assert.match(sql, /CREATE MATERIALIZED VIEW `app`\.`mv_daily`/);
    assert.match(sql, /\nTO `app`\.`mv_target`\n/);
    assert.match(sql, /\nAS\nSELECT day, count\(\) AS c FROM events GROUP BY day$/);
    assert.doesNotMatch(sql, /ENGINE/);
    assert.doesNotMatch(sql, /POPULATE/);
  });

  test('a bare TO target (no db) is quoted as one part', () => {
    const sql = createSql(chmv({ chTarget: 'to', chTo: 'mv_target' }), 'clickhouse');
    assert.match(sql, /\nTO `mv_target`\n/);
  });

  test('ENGINE-form carries ENGINE, ORDER BY, PARTITION BY and POPULATE', () => {
    const sql = createSql(chmv({
      chTarget: 'engine', chEngine: 'MergeTree()',
      chOrderBy: '(day)', chPartitionBy: 'toYYYYMM(day)', populate: true,
    }), 'clickhouse');
    assert.match(sql, /CREATE MATERIALIZED VIEW `app`\.`mv_daily`\nENGINE = MergeTree\(\)/);
    assert.match(sql, /\nORDER BY \(day\)/);
    assert.match(sql, /\nPARTITION BY toYYYYMM\(day\)/);
    assert.match(sql, /\nPOPULATE\nAS\n/);
    assert.doesNotMatch(sql, /\bTO\b/);
  });

  test('ENGINE-form without POPULATE or PARTITION BY omits them', () => {
    const sql = createSql(chmv({ chTarget: 'engine', chEngine: 'MergeTree()', chOrderBy: '(day)' }), 'clickhouse');
    assert.doesNotMatch(sql, /POPULATE/);
    assert.doesNotMatch(sql, /PARTITION BY/);
  });

  test('a new CH matview is a single safe CREATE; POPULATE adds a one-shot warning', () => {
    const cs = changesFor(null, chmv({ chTarget: 'engine', chEngine: 'MergeTree()', chOrderBy: '(day)', populate: true }), 'clickhouse');
    assert.equal(cs.length, 1);
    assert.equal(cs[0].kind, 'create');
    assert.equal(worstRisk(cs), 'safe');
    assert.match(cs[0].warning!, /one-shot|NOT captured/i);
  });

  test('editing a CH matview is a destructive drop (DROP VIEW) then recreate', () => {
    const before = chmv({ chTarget: 'to', chTo: 'app.t' });
    const after = chmv({ chTarget: 'to', chTo: 'app.t', body: 'SELECT day FROM events' });
    const cs = changesFor(before, after, 'clickhouse');
    assert.equal(cs.length, 2);
    assert.equal(cs[0].kind, 'drop');
    assert.equal(cs[0].risk, 'destructive');
    assert.equal(cs[0].sql, 'DROP VIEW `app`.`mv_daily`');
    assert.doesNotMatch(cs[0].sql, /MATERIALIZED/);
    assert.match(cs[0].warning!, /insert trigger stops|does not backfill/i);
    assert.equal(cs[1].kind, 'create');
    assert.equal(worstRisk(cs), 'destructive');
  });
});

describe('parseClickhouseMatview: reading get_ddl output back', () => {
  test('TO form', () => {
    const p = parseClickhouseMatview('CREATE MATERIALIZED VIEW `app`.`mv` TO `app`.`t` AS SELECT 1');
    assert.equal(p.chTarget, 'to');
    assert.equal(p.chTo, 'app.t');
  });
  test('ENGINE form with ORDER BY, PARTITION BY and POPULATE', () => {
    const ddl = 'CREATE MATERIALIZED VIEW `app`.`mv` ENGINE = MergeTree() '
      + 'PARTITION BY toYYYYMM(day) ORDER BY (day) POPULATE AS SELECT day FROM t';
    const p = parseClickhouseMatview(ddl);
    assert.equal(p.chTarget, 'engine');
    assert.equal(p.chEngine, 'MergeTree()');
    assert.equal(p.chOrderBy, '(day)');
    assert.equal(p.chPartitionBy, 'toYYYYMM(day)');
    assert.equal(p.populate, true);
  });
});

describe('dropping', () => {
  test('DROP VIEW for a view', () => {
    assert.equal(dropSql(view(), 'postgres'), 'DROP VIEW "app"."v_orders"');
  });
  test('DROP MATERIALIZED VIEW for a matview', () => {
    assert.equal(dropSql(matview(), 'postgres'), 'DROP MATERIALIZED VIEW "app"."mv_daily"');
  });
  test('CASCADE only on PostgreSQL', () => {
    assert.match(dropSql(view(), 'postgres', { cascade: true }), /CASCADE$/);
    assert.doesNotMatch(dropSql(view(), 'mysql', { cascade: true }), /CASCADE/);
  });
  test('IF EXISTS when asked', () => {
    assert.match(dropSql(view(), 'sqlite', { ifExists: true }), /DROP VIEW IF EXISTS "app"\."v_orders"/);
  });
});

describe('refreshing (PostgreSQL matview)', () => {
  test('plain refresh, with a lock warning', () => {
    const c = refreshSql(matview());
    assert.equal(c.sql, 'REFRESH MATERIALIZED VIEW "app"."mv_daily"');
    assert.match(c.warning!, /exclusive lock/i);
  });
  test('CONCURRENTLY, with the unique-index warning', () => {
    const c = refreshSql(matview(), true);
    assert.match(c.sql, /REFRESH MATERIALIZED VIEW CONCURRENTLY "app"\."mv_daily"/);
    assert.match(c.warning!, /UNIQUE index/i);
  });
});

describe('changesFor: create vs replace vs drop-recreate', () => {
  test('no name or no body → nothing', () => {
    assert.deepEqual(changesFor(null, view({ name: '' }), 'postgres'), []);
    assert.deepEqual(changesFor(null, view({ body: '  ' }), 'postgres'), []);
  });

  test('a new view is a single safe CREATE', () => {
    const cs = changesFor(null, view(), 'postgres');
    assert.equal(cs.length, 1);
    assert.equal(cs[0].kind, 'create');
    assert.equal(worstRisk(cs), 'safe');
  });

  test('editing a PG view is a single OR REPLACE, with the add-only caveat', () => {
    const cs = changesFor(view(), view({ body: 'SELECT id FROM orders' }), 'postgres');
    assert.equal(cs.length, 1);
    assert.equal(cs[0].kind, 'replace');
    assert.match(cs[0].sql, /CREATE OR REPLACE VIEW/);
    assert.match(cs[0].warning!, /add columns at the end/i);
  });

  test('editing a SQLite view is DROP IF EXISTS then CREATE', () => {
    const cs = changesFor(view(), view({ body: 'SELECT 1' }), 'sqlite');
    assert.equal(cs.length, 2);
    assert.equal(cs[0].kind, 'drop');
    assert.match(cs[0].sql, /DROP VIEW IF EXISTS/);
    assert.equal(cs[1].kind, 'create');
    assert.doesNotMatch(cs[1].sql, /OR REPLACE/);
    assert.equal(worstRisk(cs), 'safe');
  });

  test('editing a matview is a destructive drop-and-recreate', () => {
    const cs = changesFor(matview(), matview({ body: 'SELECT 2' }), 'postgres');
    assert.equal(cs.length, 2);
    assert.equal(cs[0].kind, 'drop');
    assert.equal(cs[0].risk, 'destructive');
    assert.match(cs[0].warning!, /discarding its stored rows/i);
    assert.equal(worstRisk(cs), 'destructive');
    assert.equal(toScript(cs),
      'DROP MATERIALIZED VIEW "app"."mv_daily";\n'
      + 'CREATE MATERIALIZED VIEW "app"."mv_daily" AS\nSELECT 2\nWITH DATA;');
  });
});

describe('parseBody: pulling the SELECT out of get_ddl output', () => {
  test('PostgreSQL CREATE OR REPLACE VIEW', () => {
    const ddl = 'CREATE OR REPLACE VIEW "app"."v_orders" AS\n SELECT id, total\n   FROM orders;';
    assert.equal(parseBody(ddl), 'SELECT id, total\n   FROM orders');
  });

  test('MySQL SHOW CREATE VIEW, with a DEFINER prologue', () => {
    const ddl = 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` '
      + 'SQL SECURITY DEFINER VIEW `app`.`v` AS select `o`.`id` AS `id` from `orders` `o`';
    assert.equal(parseBody(ddl), 'select `o`.`id` AS `id` from `orders` `o`');
  });

  test('a matview DDL with trailing index defs keeps only the SELECT', () => {
    const ddl = 'CREATE MATERIALIZED VIEW "app"."mv" AS\n SELECT a FROM t;\n\n'
      + 'CREATE INDEX mv_a ON "app"."mv" (a);';
    assert.equal(parseBody(ddl), 'SELECT a FROM t');
  });

  test('a body whose first column has an AS alias is not truncated at that AS', () => {
    const ddl = 'CREATE VIEW v AS SELECT 1 AS one, 2 AS two';
    assert.equal(parseBody(ddl), 'SELECT 1 AS one, 2 AS two');
  });
});

describe('reading helpers name the right catalogs', () => {
  test('schema list per engine', () => {
    assert.match(schemaListSql('postgres'), /information_schema\.schemata/);
    assert.match(schemaListSql('clickhouse'), /system\.databases/);
    assert.match(schemaListSql('sqlite'), /pragma_database_list/);
  });
  test('view list distinguishes matviews on PostgreSQL', () => {
    const sql = listSql('app', 'postgres');
    assert.match(sql, /relkind IN \('v','m'\)/);
    assert.match(sql, /'matview'/);
    assert.match(sql, /'app'/);
  });
  test('MySQL view list has no matview kind', () => {
    assert.match(listSql('app', 'mysql'), /information_schema\.VIEWS/);
  });
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// Every statement below was executed against SQL Server 2022. Before this the
// Views panel refused a SQL Server connection with "this connection has none to
// edit", which was simply wrong — it has views.

test('T-SQL spells it CREATE OR ALTER, and OR REPLACE is a syntax error there', () => {
  const def = { schema: 'sales', name: 'v', kind: 'view' as const,
                body: 'SELECT id FROM sales.customers' };
  const sql = createSql(def, 'sqlserver');
  assert.match(sql, /^CREATE OR ALTER VIEW \[sales\]\.\[v\] AS\n/);
  assert.ok(!sql.includes('OR REPLACE'), sql);
  // …and the non-replacing form is plain CREATE, as everywhere else.
  assert.match(createSql(def, 'sqlserver', false), /^CREATE VIEW \[sales\]\.\[v\] AS\n/);
});

test('a view drop takes IF EXISTS but never CASCADE', () => {
  const def = { schema: 'sales', name: 'v', kind: 'view' as const };
  const sql = dropSql(def, 'sqlserver', { ifExists: true, cascade: true });
  assert.equal(sql, 'DROP VIEW IF EXISTS [sales].[v]');
  // `DROP VIEW … CASCADE` is Msg 156 on SQL Server.
  assert.ok(!sql.includes('CASCADE'), sql);
});

test('SQL Server reports every view as a view — it has no materialized kind', () => {
  // Its nearest thing is an INDEXED view: an ordinary view carrying a unique
  // clustered index. That is storage the editor does not own, so calling it a
  // matview would offer a REFRESH that does not exist.
  const sql = listSql('sales', 'sqlserver');
  assert.match(sql, /FROM sys\.views v/);
  assert.match(sql, /'view'/);
  assert.ok(!sql.includes('matview'), sql);
});

test('the schema picker skips the fixed-role schemas', () => {
  const sql = schemaListSql('sqlserver');
  assert.match(sql, /schema_id < 16384/);
  assert.match(sql, /sys.*INFORMATION_SCHEMA.*guest/);
});

test('a schema name is escaped into the view list', () => {
  assert.match(listSql("it's", 'sqlserver'), /sc\.name = 'it''s'/);
});
