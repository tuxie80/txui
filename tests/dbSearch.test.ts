/**
 * Whole-schema search planning (src/utils/dbSearch.ts).
 *
 * Two failure modes matter, and both produce a search that looks like it
 * worked:
 *   1. **Silently skipping columns.** If a type is excluded without saying so,
 *      the user concludes the value is not in the database when it is.
 *   2. **Unescaped wildcards.** Searching for `50%` with `%` left live matches
 *      everything beginning with 50 — a confident wrong answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSearch, planSummary, classifyColumn, escapeLike, patternFor, q, lit, tableSql,
} from '../src/utils/dbSearch.ts';
import type { SearchTable } from '../src/utils/dbSearch.ts';

const table = (name: string, cols: Array<[string, string]>, rows?: number): SearchTable => ({
  schema: 'shop', name,
  columns: cols.map(([n, t]) => ({ name: n, typeName: t })),
  estimatedRows: rows,
});

const ORDERS = table('orders', [
  ['id', 'int'], ['email', 'varchar(255)'], ['notes', 'text'],
  ['total', 'decimal(10,2)'], ['payload', 'blob'], ['created', 'timestamp'],
]);

// ── which columns can be searched ───────────────────────────────────────────

test('text columns are searched without a cast', () => {
  for (const t of ['varchar(255)', 'text', 'char(10)', 'longtext', 'jsonb', 'citext', 'uuid']) {
    const v = classifyColumn(t, false);
    assert.ok(v.search, t);
    assert.equal(v.search && v.cast, false, `${t} should not need a cast`);
  }
});

test('binary columns are NEVER searched, whatever the options', () => {
  // A LIKE on bytes matches encoding artefacts, not content.
  for (const t of ['blob', 'bytea', 'varbinary(64)', 'geometry', 'longblob']) {
    for (const include of [false, true]) {
      const v = classifyColumn(t, include);
      assert.ok(!v.search, `${t} with includeNonText=${include}`);
    }
  }
});

test('numbers and dates are opt-in, and say how to opt in', () => {
  const off = classifyColumn('decimal(10,2)', false);
  assert.ok(!off.search);
  assert.match(off.reason, /enable/, 'the reason must tell the user what to do');

  const on = classifyColumn('decimal(10,2)', true);
  assert.ok(on.search && on.cast, 'should be searched via a cast when enabled');
});

test('an unknown type is skipped with a reason rather than guessed at', () => {
  const v = classifyColumn('some_custom_type', true);
  assert.ok(!v.search);
  assert.match(v.reason, /no reliable text form/);
  assert.ok(!classifyColumn('', true).search);
});

test('a PostgreSQL array is skipped — there is no portable text cast', () => {
  assert.ok(!classifyColumn('_text', true).search);
  assert.ok(!classifyColumn('integer[]', true).search);
});

// ── the plan reports what it skipped ────────────────────────────────────────

test('skipped columns are reported per table, not silently dropped', () => {
  const plan = planSearch([ORDERS], { engine: 'mysql', needle: 'x' });
  const t = plan.tables[0];
  assert.deepEqual(t.columns, ['email', 'notes']);
  const skippedNames = t.skipped.map(s => s.name);
  assert.ok(skippedNames.includes('payload'), 'the blob should be reported');
  assert.ok(skippedNames.includes('total'), 'the number should be reported');
  for (const s of t.skipped) assert.ok(s.reason.length > 3, `${s.name} has no reason`);
});

test('a table with nothing searchable is listed, not omitted', () => {
  // Omitting it would read as "searched, no hits".
  const plan = planSearch([table('blobs', [['id', 'int'], ['data', 'blob']])],
    { engine: 'mysql', needle: 'x' });
  assert.equal(plan.tables.length, 0);
  assert.equal(plan.emptyTables.length, 1);
  assert.match(plan.emptyTables[0].reason, /no searchable columns/);
});

test('enabling numbers and dates brings them in', () => {
  const plan = planSearch([ORDERS], { engine: 'mysql', needle: '42', includeNonText: true });
  assert.deepEqual(plan.tables[0].columns, ['id', 'email', 'notes', 'total', 'created']);
  assert.ok(!plan.tables[0].columns.includes('payload'), 'the blob must stay out');
});

test('smallest tables are searched first', () => {
  // The table you were thinking of is rarely the biggest, and early hits are
  // what make a hundred-table search feel responsive.
  const plan = planSearch([
    table('big', [['a', 'text']], 5_000_000),
    table('small', [['a', 'text']], 12),
    table('mid', [['a', 'text']], 4_000),
  ], { engine: 'mysql', needle: 'x' });
  assert.deepEqual(plan.tables.map(t => t.name), ['small', 'mid', 'big']);
});

// ── the wildcard trap ───────────────────────────────────────────────────────

test("LIKE's own wildcards are escaped in the needle", () => {
  // Searching for `50%` must not match every value starting with 50.
  assert.equal(escapeLike('50%'), '50\\%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.equal(escapeLike('back\\slash'), 'back\\\\slash');
  assert.equal(patternFor('50%', 'contains'), '%50\\%%');
  assert.equal(patternFor('50%', 'exact'), '50\\%');
  assert.equal(patternFor('abc', 'starts'), 'abc%');
});

test('every generated statement declares its ESCAPE', () => {
  // Without it the backslashes above are literal and the escaping is undone.
  for (const engine of ['mysql', 'postgres']) {
    const plan = planSearch([ORDERS], { engine, needle: '50%' });
    assert.match(plan.tables[0].sql, /ESCAPE/, engine);
  }
});

test('a quote in the needle cannot break out of the literal', () => {
  const plan = planSearch([ORDERS], { engine: 'mysql', needle: "o'brien" });
  assert.match(plan.tables[0].sql, /o''brien/);
  assert.equal(lit("it's"), "'it''s'");
});

// ── generated SQL ───────────────────────────────────────────────────────────

test('the hit carries its table AND the column that matched', () => {
  // Knowing a value is in a table is half an answer.
  const plan = planSearch([ORDERS], { engine: 'mysql', needle: 'x' });
  const sql = plan.tables[0].sql;
  assert.match(sql, /AS __table/);
  assert.match(sql, /CASE WHEN .* THEN 'email'/);
  assert.match(sql, /AS __column/);
});

test('columns are OR-ed and the result is capped', () => {
  const plan = planSearch([ORDERS], { engine: 'mysql', needle: 'x', limit: 25 });
  assert.match(plan.tables[0].sql, / OR /);
  assert.match(plan.tables[0].sql, /LIMIT 25$/);
});

test('PostgreSQL uses ILIKE for an insensitive search, MySQL plain LIKE', () => {
  const pg = planSearch([ORDERS], { engine: 'postgres', needle: 'x' }).tables[0].sql;
  assert.match(pg, /ILIKE/);
  const my = planSearch([ORDERS], { engine: 'mysql', needle: 'x' }).tables[0].sql;
  assert.match(my, /LIKE/);
  assert.ok(!/ILIKE/.test(my));
});

test('a case-SENSITIVE search on MySQL forces a binary collation', () => {
  // MySQL's default collation is case-insensitive, so without this the option
  // would appear to work and change nothing.
  const my = planSearch([ORDERS], { engine: 'mysql', needle: 'x', caseSensitive: true })
    .tables[0].sql;
  assert.match(my, /COLLATE utf8mb4_bin/);
  const pg = planSearch([ORDERS], { engine: 'postgres', needle: 'x', caseSensitive: true })
    .tables[0].sql;
  assert.match(pg, /LIKE/);
  assert.ok(!/ILIKE/.test(pg));
});

test('a cast is applied only to the columns that need one', () => {
  const plan = planSearch([ORDERS], { engine: 'postgres', needle: '42', includeNonText: true });
  const sql = plan.tables[0].sql;
  assert.match(sql, /"total"::text/);
  assert.ok(!/"email"::text/.test(sql), 'a text column must not be cast');
});

test('identifiers are quoted for their engine and escaped', () => {
  assert.equal(q('orders', 'mysql'), '`orders`');
  assert.equal(q('orders', 'postgres'), '"orders"');
  assert.equal(q('we`ird', 'mysql'), '`we``ird`');
  assert.equal(q('we"ird', 'postgres'), '"we""ird"');
});

// ── summary ─────────────────────────────────────────────────────────────────

test('the summary says what will be searched before it runs', () => {
  const plan = planSearch([ORDERS, table('blobs', [['d', 'blob']])],
    { engine: 'mysql', needle: 'x' });
  const s = planSummary(plan);
  assert.match(s, /1 table/);
  assert.match(s, /2 columns/);
  assert.match(s, /1 skipped/);
});

test('a schema with nothing searchable says so plainly', () => {
  const plan = planSearch([table('blobs', [['d', 'blob']])], { engine: 'mysql', needle: 'x' });
  assert.match(planSummary(plan), /Nothing searchable/);
  assert.match(planSummary(planSearch([], { engine: 'mysql', needle: 'x' })), /Nothing searchable/);
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// Behaviour checked against SQL Server 2022, not just syntax: a case-sensitive
// search for 'de' returns 0 rows where 'DE' returns 5, and searching for a
// literal '%' returns 0 rather than matching all 1334 rows.

const msOpts = (needle: string, extra: Record<string, unknown> = {}) =>
  ({ engine: 'sqlserver', needle, limit: 20, ...extra } as never);
const T = { schema: 'sales', name: 'customers' };

test('T-SQL caps with TOP at the front, never LIMIT', () => {
  const sql = tableSql(T, ['name'], new Set(), msOpts('x'));
  assert.match(sql, /^SELECT TOP \(20\) /);
  assert.ok(!/LIMIT/i.test(sql));
});

test('case-insensitive forces a CI collation rather than trusting the database', () => {
  // The database collation may be case-SENSITIVE; a plain LIKE would then
  // quietly do the opposite of what the checkbox says.
  const sql = tableSql(T, ['name'], new Set(), msOpts('x'));
  assert.match(sql, /COLLATE Latin1_General_CI_AS LIKE/);
  // T-SQL has no ILIKE.
  assert.ok(!/ILIKE/i.test(sql));
});

test('case-sensitive uses a binary collation', () => {
  const sql = tableSql(T, ['name'], new Set(), msOpts('x', { caseSensitive: true }));
  assert.match(sql, /COLLATE Latin1_General_BIN2 LIKE/);
});

test('the escape character is a single backslash outside MySQL', () => {
  // Only MySQL treats a backslash as special inside a string literal, so only
  // there does the escape clause need doubling.
  const ms = tableSql(T, ['n'], new Set(), msOpts('x'));
  assert.ok(ms.includes("ESCAPE '\\'"), `single backslash expected, got: ${ms.match(/ESCAPE '.*?'/)?.[0]}`);
  // MySQL doubles it, because there a backslash is special inside the literal.
  const my = tableSql(T, ['n'], new Set(), { engine: 'mysql', needle: 'x', limit: 5 } as never);
  assert.ok(my.includes("ESCAPE '\\\\'"), `doubled backslash expected on MySQL`);
});

test('a cast column gets a LENGTH, or T-SQL truncates at 30', () => {
  // CAST(x AS nvarchar) with no length silently gives 30 characters, so a
  // match past character 30 would simply not be found.
  const sql = tableSql(T, ['id'], new Set(['id']), msOpts('42'));
  assert.match(sql, /CAST\(\[id\] AS nvarchar\(4000\)\)/);
});

test('LIKE wildcards in the needle are escaped, not honoured', () => {
  // Verified live: searching for '%' returns 0 rows, not every row.
  const sql = tableSql(T, ['email'], new Set(), msOpts('%'));
  assert.match(sql, /LIKE '%\\%%'/);
});
