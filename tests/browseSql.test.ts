import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultBrowseSort, clampBrowseLimit, browseSqlText, BROWSE_LIMIT_DEFAULT,
  duckdbBrowseTarget,
} from '../src/utils/browseSql.ts';

test('defaultBrowseSort: first PK column DESC', () => {
  assert.deepEqual(defaultBrowseSort(['id']), [{ column: 'id', direction: 'desc' }]);
  assert.deepEqual(defaultBrowseSort(['a', 'b']), [{ column: 'a', direction: 'desc' }]);
  assert.deepEqual(defaultBrowseSort([]), []);
});

test('clampBrowseLimit: default on garbage, cap at max choice', () => {
  assert.equal(clampBrowseLimit(NaN), BROWSE_LIMIT_DEFAULT);
  assert.equal(clampBrowseLimit(0), BROWSE_LIMIT_DEFAULT);
  assert.equal(clampBrowseLimit(-5), BROWSE_LIMIT_DEFAULT);
  assert.equal(clampBrowseLimit(500), 500);
  assert.equal(clampBrowseLimit(999_999), 10000);
});

test('browseSqlText: plain browse with PK-desc default sort (mysql quoting)', () => {
  const sql = browseSqlText({
    table: 'shop.orders', filters: [], engine: 'mysql',
    sort: defaultBrowseSort(['id']), limit: 100, offset: 0,
  });
  assert.equal(sql, 'SELECT * FROM `shop`.`orders` ORDER BY `id` DESC LIMIT 100 OFFSET 0');
});

test('browseSqlText: no PK → no ORDER BY', () => {
  const sql = browseSqlText({
    table: 'logs', filters: [], sort: [], limit: 100, offset: 0, engine: 'mysql',
  });
  assert.equal(sql, 'SELECT * FROM `logs` LIMIT 100 OFFSET 0');
});

test('browseSqlText: filters inline values, identifier escaping (pg quoting)', () => {
  const sql = browseSqlText({
    table: 'public."weird', engine: 'postgres', sort: [], limit: 500, offset: 100,
    filters: [
      { column: 'name', op: 'like', value: "%o'hara%" },
      { column: 'deleted', op: 'is_null', value: null },
    ],
  });
  assert.equal(
    sql,
    `SELECT * FROM "public"."""weird" WHERE "name" LIKE '%o''hara%' AND "deleted" IS NULL LIMIT 500 OFFSET 100`,
  );
});

test('browseSqlText: mysql backtick escaping + multi sort', () => {
  const sql = browseSqlText({
    table: 'db.t`x', engine: 'mysql', limit: 100, offset: 0, filters: [],
    sort: [
      { column: 'a', direction: 'asc' },
      { column: 'b', direction: 'desc' },
    ],
  });
  assert.equal(sql, 'SELECT * FROM `db`.`t``x` ORDER BY `a` ASC, `b` DESC LIMIT 100 OFFSET 0');
});

test('browseSqlText: DuckDB takes the PG form — double quotes, never backticks', () => {
  // Mirrors db/browser.rs: DuckDB gets build_select(pg = true) because it
  // rejects backticks (measured: Parser Error at "`").
  const sql = browseSqlText({
    table: 'main.orders', engine: 'duckdb', sort: defaultBrowseSort(['id']),
    limit: 100, offset: 0,
    filters: [{ column: 'note', op: 'eq', value: "a\\'b" }],
  });
  assert.equal(
    sql,
    `SELECT * FROM "main"."orders" WHERE "note" = 'a\\''b' ORDER BY "id" DESC LIMIT 100 OFFSET 0`,
  );
});

test('browseSqlText: limit omitted → an unpaged SELECT (the GeoParquet export source)', () => {
  // The export re-runs the browse as COPY (<sql>) TO … — the page's
  // LIMIT/OFFSET must NOT be in it, or the file would hold only the page.
  assert.equal(
    browseSqlText({
      table: 'main.cities', engine: 'duckdb', filters: [],
      sort: [{ column: 'id', direction: 'desc' }],
    }),
    'SELECT * FROM "main"."cities" ORDER BY "id" DESC',
  );
  // Filters and literals inline the same as the paged form.
  assert.equal(
    browseSqlText({
      table: 't', engine: 'mysql', sort: [],
      filters: [{ column: 'a', op: 'eq', value: "o'hara" }],
    }),
    "SELECT * FROM `t` WHERE `a` = 'o''hara'",
  );
  // An offset without a limit is not a page — it is dropped, not emitted.
  assert.equal(
    browseSqlText({ table: 't', engine: 'postgres', filters: [], sort: [], offset: 200 }),
    'SELECT * FROM "t"',
  );
  // SQL Server: no TOP, no OFFSET … FETCH (which needs an ORDER BY anyway).
  assert.equal(
    browseSqlText({ table: 'dbo.t', engine: 'sqlserver', filters: [], sort: [] }),
    'SELECT * FROM [dbo].[t]',
  );
});

test('browseSqlText: three-part names quote every part (SQL Server db.schema.table)', () => {
  // Splitting on the first dot alone produced [mydb].[dbo.orders] — a table
  // literally named "dbo.orders" in database mydb.
  assert.equal(
    browseSqlText({ table: 'mydb.dbo.orders', engine: 'sqlserver', filters: [], sort: [] }),
    'SELECT * FROM [mydb].[dbo].[orders]',
  );
  assert.equal(
    browseSqlText({ table: 'a.b.c', engine: 'mysql', filters: [], sort: [], limit: 100, offset: 0 }),
    'SELECT * FROM `a`.`b`.`c` LIMIT 100 OFFSET 0',
  );
  // One- and two-part names are byte-identical to before.
  assert.equal(
    browseSqlText({ table: 'shop.orders', engine: 'mysql', filters: [], sort: [], limit: 100, offset: 0 }),
    'SELECT * FROM `shop`.`orders` LIMIT 100 OFFSET 0',
  );
});

test('duckdbBrowseTarget: the catalog segment is stripped for the SELECT builder', () => {
  // The tree names DuckDB objects three-level ("db.schema.table") — that form
  // addresses get_table_meta, but build_select splits a dotted name ONCE, so
  // the browse/value-count calls go out two-level ("schema.table").
  assert.equal(duckdbBrowseTarget('memory.main.orders'), 'main.orders');
  assert.equal(duckdbBrowseTarget('mydb.main.order lines'), 'main.order lines');
  // Two-level and bare names pass through untouched.
  assert.equal(duckdbBrowseTarget('main.orders'), 'main.orders');
  assert.equal(duckdbBrowseTarget('orders'), 'orders');
});
