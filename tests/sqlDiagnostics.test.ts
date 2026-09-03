/**
 * Live diagnostics (src/utils/sqlDiagnostics.ts) — the squiggles while typing.
 * Every check must be offset-precise and must stay QUIET when the schema data
 * it needs is not cached: a false "unknown column" is worse than no check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnose, emptyDiagContext, tableRefs, wherePredicates,
  findUnterminatedQuote, findUnbalancedParen, createdTables,
} from '../src/utils/sqlDiagnostics.ts';
import type { DiagContext } from '../src/utils/sqlDiagnostics.ts';

function ctx(over: Partial<DiagContext> = {}): DiagContext {
  return {
    ...emptyDiagContext(),
    objects: new Set(['orders', 'customers', 'shop.orders', 'shop.customers']),
    columns: new Map([
      ['orders', new Set(['id', 'customer_id', 'state', 'total'])],
      ['customers', new Set(['id', 'email', 'state'])],
    ]),
    ...over,
  };
}
const codes = (sql: string, c: DiagContext = ctx()) => diagnose(sql, c).map(d => d.code);
const find = (sql: string, code: string, c: DiagContext = ctx()) =>
  diagnose(sql, c).find(d => d.code === code);

test('an empty context produces no schema complaints at all', () => {
  const c = emptyDiagContext();
  assert.ok(!codes('SELECT x FROM nope n WHERE n.zzz = 1', c).includes('unknown-table'));
  assert.ok(!codes('SELECT x FROM nope n WHERE n.zzz = 1', c).includes('unknown-column'));
});

test('unknown table is flagged with the exact span', () => {
  const sql = 'SELECT 1 FROM ordres';
  const d = find(sql, 'unknown-table')!;
  assert.equal(d.severity, 'error');
  assert.equal(sql.slice(d.from, d.to), 'ordres');
  // known ones are silent, qualified or not
  assert.equal(find('SELECT 1 FROM orders', 'unknown-table'), undefined);
  assert.equal(find('SELECT 1 FROM shop.orders', 'unknown-table'), undefined);
});

test('a CTE or derived table is never an unknown table', () => {
  const c = ctx({ virtual: new Set(['recent']) });
  assert.equal(find('WITH recent AS (SELECT 1) SELECT * FROM recent', 'unknown-table', c), undefined);
});

test('unknown column on an alias is flagged, unknown table columns are not guessed', () => {
  const sql = 'SELECT o.stat FROM orders o';
  const d = find(sql, 'unknown-column')!;
  assert.equal(sql.slice(d.from, d.to), 'stat');
  assert.equal(find('SELECT o.state FROM orders o', 'unknown-column'), undefined);
  // table not cached → no opinion
  const c = ctx({ columns: new Map() });
  assert.equal(find('SELECT o.stat FROM orders o', 'unknown-column', c), undefined);
});

test('ambiguous unqualified column across joined tables', () => {
  const sql = 'SELECT state FROM orders o JOIN customers c ON c.id = o.customer_id';
  const d = find(sql, 'ambiguous-column')!;
  assert.equal(sql.slice(d.from, d.to), 'state');
  assert.match(d.message, /orders and customers/);
  // unique columns are fine
  assert.equal(find('SELECT total FROM orders o JOIN customers c ON c.id = o.customer_id',
    'ambiguous-column'), undefined);
});

test('= NULL is an error, IS NULL is not', () => {
  const sql = 'SELECT 1 FROM orders WHERE state = NULL';
  const d = find(sql, 'eq-null')!;
  assert.equal(d.severity, 'error');
  assert.match(d.message, /IS NULL/);
  assert.equal(find('SELECT 1 FROM orders WHERE state IS NULL', 'eq-null'), undefined);
  assert.ok(codes('SELECT 1 FROM orders WHERE state <> NULL').includes('eq-null'));
});

test('JOIN without ON is a cartesian warning; CROSS JOIN is deliberate', () => {
  assert.ok(codes('SELECT 1 FROM orders o JOIN customers c').includes('join-without-on'));
  assert.ok(!codes('SELECT 1 FROM orders o CROSS JOIN customers c').includes('join-without-on'));
  assert.ok(!codes('SELECT 1 FROM orders o JOIN customers c ON c.id = o.customer_id')
    .includes('join-without-on'));
  assert.ok(!codes('SELECT 1 FROM orders o JOIN customers c USING (id)')
    .includes('join-without-on'));
});

test('UPDATE/DELETE without WHERE is flagged while typing', () => {
  assert.ok(codes('DELETE FROM orders').includes('write-without-where'));
  assert.ok(codes('UPDATE orders SET state = 1').includes('write-without-where'));
  assert.ok(!codes('DELETE FROM orders WHERE id = 1').includes('write-without-where'));
});

test('a write with no default database warns about where it will land', () => {
  const c = ctx({ hasDefaultDb: false });
  const d = find('DELETE FROM orders WHERE id = 1', 'unqualified-write', c)!;
  assert.match(d.message, /No default database/);
  // qualified, or a plain SELECT → silent
  assert.equal(find('DELETE FROM shop.orders WHERE id = 1', 'unqualified-write', c), undefined);
  assert.equal(find('SELECT 1 FROM orders', 'unqualified-write', c), undefined);
});

test('a predicate no index starts with is flagged, an indexed one is not', () => {
  const c = ctx({ indexed: new Map([['orders', new Set(['id', 'customer_id'])]]) });
  const sql = 'SELECT 1 FROM orders o WHERE o.state = 5';
  const d = find(sql, 'no-index', c)!;
  assert.equal(sql.slice(d.from, d.from + 5), 'state');
  assert.equal(find('SELECT 1 FROM orders o WHERE o.customer_id = 5', 'no-index', c), undefined);
  // no index data → no opinion
  assert.equal(find(sql, 'no-index'), undefined);
});

test('informational: SELECT * across joins, and unbounded full scans only', () => {
  assert.ok(codes('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id')
    .includes('select-star-join'));
  assert.ok(!codes('SELECT * FROM orders').includes('select-star-join'));
  assert.ok(codes('SELECT id FROM orders').includes('full-scan'));
  assert.ok(!codes('SELECT id FROM orders LIMIT 10').includes('full-scan'));
  assert.ok(!codes('SELECT COUNT(*) FROM orders').includes('full-scan'));
  assert.ok(!codes('SELECT id FROM orders WHERE id = 1').includes('full-scan'),
    'a filtered SELECT is ordinary — squiggling it would train people to ignore squiggles');
});

test('catalog schemas are never "unknown tables"', () => {
  for (const sql of [
    'SELECT * FROM information_schema.PROCESSLIST',
    'SELECT * FROM performance_schema.data_locks',
    'SELECT * FROM sys.innodb_lock_waits',
    'SELECT * FROM mysql.user',
    'SELECT * FROM pg_catalog.pg_stat_activity',
  ]) {
    assert.equal(find(sql, 'unknown-table'), undefined, sql);
  }
});

test('tables the script itself creates are known for the rest of the script', () => {
  const sql = 'CREATE TEMPORARY TABLE tmp_fix (id int);\n'
    + 'INSERT INTO tmp_fix SELECT id FROM orders;\nSELECT * FROM tmp_fix';
  assert.equal(find(sql, 'unknown-table'), undefined);
  assert.deepEqual([...createdTables('CREATE TABLE shop.x (i int)')].sort(), ['shop.x', 'x']);
  assert.deepEqual([...createdTables('create or replace view v as select 1')], ['v']);
  assert.equal(createdTables('SELECT 1').size, 0);
});

test('syntax breakage: unterminated string, unbalanced parens, comma before FROM', () => {
  assert.equal(findUnterminatedQuote("SELECT 'abc' FROM t"), -1);
  assert.ok(findUnterminatedQuote("SELECT 'abc FROM t") >= 0);
  assert.equal(findUnterminatedQuote("SELECT 'it''s' FROM t"), -1, 'doubled quotes are escapes');
  assert.equal(findUnterminatedQuote("-- 'not a string\nSELECT 1"), -1, 'comments are skipped');
  assert.equal(findUnbalancedParen('SELECT (1 + 2) FROM t'), -1);
  assert.ok(findUnbalancedParen('SELECT (1 + 2 FROM t') >= 0);
  assert.ok(findUnbalancedParen('SELECT 1) FROM t') >= 0);
  assert.ok(codes('SELECT id, FROM orders').includes('comma-before-from'));
});

test('offsets are absolute across a multi-statement script', () => {
  const sql = 'SELECT 1 FROM orders LIMIT 1;\nSELECT 1 FROM ordres LIMIT 1';
  const d = find(sql, 'unknown-table')!;
  assert.equal(sql.slice(d.from, d.to), 'ordres');
  assert.ok(d.from > sql.indexOf('\n'), 'the offset points into the SECOND statement');
});

test('nothing is reported inside strings or comments', () => {
  const sql = "SELECT 'DELETE FROM orders' AS x FROM orders LIMIT 1;\n-- DELETE FROM orders";
  assert.ok(!codes(sql).includes('write-without-where'));
  assert.ok(!codes(sql).includes('unknown-table'));
});

test('the low-level scanners are usable on their own', () => {
  assert.deepEqual(tableRefs('select 1 from orders o join customers c on 1=1').map(r => r.name),
    ['orders', 'customers']);
  assert.deepEqual(wherePredicates('select 1 from t where a.x = 1 and y > 2').map(p => p.column),
    ['x', 'y']);
  assert.deepEqual(wherePredicates('select 1 from t').length, 0);
});

test('a star inside a literal or a multiplication is not a select-list star', () => {
  // guards the ⌘⇧8 expansion, which searches the BLANKED text for `SELECT *`,
  // `, *` or `alias.*` — never a bare `*`
  const starRe = /(?:\bselect\s+(?:distinct\s+)?|,\s*)((?:([A-Za-z_][\w$]*)\s*\.\s*)?\*)/gi;
  const hits = (sql: string) => [...sql.matchAll(starRe)].map(m => m[1]);
  assert.deepEqual(hits('SELECT price * qty FROM t'), [], 'multiplication is not a star');
  assert.deepEqual(hits('SELECT * FROM t'), ['*']);
  assert.deepEqual(hits('SELECT DISTINCT * FROM t'), ['*']);
  assert.deepEqual(hits('SELECT id, o.* FROM orders o'), ['o.*']);
  assert.deepEqual(hits('SELECT a, * FROM t'), ['*']);
});

// ── GROUP BY / ORDER BY: ordinals and non-grouped columns ────────────────────
// The ordinal check is dialect-neutral (every engine that allows ordinals
// errors on an out-of-range one); the not-in-GROUP-BY warning only fires where
// the server enforces it, and both stay quiet whenever the text cannot prove
// the select list's shape.

const codesFor = (sql: string, engine?: 'mysql' | 'postgres' | 'sqlite' | 'clickhouse' | 'duckdb') =>
  diagnose(sql, ctx(), ';', engine).map(d => d.code);
const findFor = (sql: string, code: string, engine?: 'mysql' | 'postgres') =>
  diagnose(sql, ctx(), ';', engine).find(d => d.code === code);

test('an ordinal past the end of the select list is an error at the exact span', () => {
  for (const sql of [
    'SELECT id, state, total FROM orders ORDER BY 4',
    'SELECT id, state, total FROM orders GROUP BY 4',
    'SELECT id FROM orders ORDER BY 0',          // ordinals start at 1
  ]) {
    const d = findFor(sql, 'ordinal-out-of-range')!;
    assert.ok(d, sql);
    assert.equal(d.severity, 'error');
    assert.match(sql.slice(d.from, d.to), /^\d+$/, `span of "${sql}"`);
  }
});

test('in-range ordinals and ordinary expressions are not flagged', () => {
  assert.equal(findFor('SELECT id, state FROM orders ORDER BY 2', 'ordinal-out-of-range'), undefined);
  assert.equal(findFor('SELECT id, state FROM orders GROUP BY 1, 2', 'ordinal-out-of-range'), undefined);
  assert.equal(findFor('SELECT id, state FROM orders ORDER BY state DESC, id', 'ordinal-out-of-range'), undefined);
  // dialect-neutral: fires with the engine known and with it unknown
  assert.ok(codesFor('SELECT id FROM orders ORDER BY 2').includes('ordinal-out-of-range'));
  assert.ok(codesFor('SELECT id FROM orders ORDER BY 2', 'sqlite').includes('ordinal-out-of-range'));
});

test('the ordinal check stays quiet when the column count is unknowable', () => {
  assert.equal(findFor('SELECT * FROM orders ORDER BY 4', 'ordinal-out-of-range'), undefined,
    'a star means the text says nothing about the count');
  assert.equal(findFor('SELECT id, o.* FROM orders o ORDER BY 9', 'ordinal-out-of-range'), undefined,
    'alias.* likewise');
  assert.equal(findFor('SELECT id FROM orders WHERE id IN (SELECT id FROM orders GROUP BY 4)',
    'ordinal-out-of-range'), undefined, 'a subquery anywhere → no opinion');
  assert.equal(findFor('SELECT id FROM orders GROUP BY 1 UNION SELECT id FROM orders GROUP BY 9',
    'ordinal-out-of-range'), undefined, 'UNION → no opinion');
  // a window function's ORDER BY is not a statement-level ordinal
  assert.equal(findFor('SELECT id, ROW_NUMBER() OVER (ORDER BY 9) FROM orders',
    'ordinal-out-of-range'), undefined);
});

test('not-in-group-by: a plain column neither aggregated nor grouped is flagged', () => {
  const sql = 'SELECT id, state FROM orders GROUP BY id';
  const d = findFor(sql, 'not-in-group-by', 'postgres')!;
  assert.equal(d.severity, 'warning');
  assert.equal(sql.slice(d.from, d.to), 'state');
  assert.match(d.message, /PostgreSQL/);
  assert.match(findFor(sql, 'not-in-group-by', 'mysql')!.message, /ONLY_FULL_GROUP_BY/);
});

test('not-in-group-by: grouped, ordinal-grouped, aliased and aggregated columns pass', () => {
  for (const sql of [
    'SELECT id, state FROM orders GROUP BY id, state',
    'SELECT id, state FROM orders GROUP BY 1, 2',               // ordinals resolve to entries
    'SELECT state AS st, id FROM orders GROUP BY st, id',       // MySQL groups by output alias
    'SELECT id, COUNT(*) FROM orders GROUP BY id',              // aggregated
    'SELECT id, state FROM orders o GROUP BY o.state, o.id',    // qualification either way
    'SELECT customer_id, SUM(total) FROM orders GROUP BY customer_id',
  ]) {
    assert.equal(findFor(sql, 'not-in-group-by', 'mysql'), undefined, sql);
    assert.equal(findFor(sql, 'not-in-group-by', 'postgres'), undefined, sql);
  }
});

test('not-in-group-by is gated by engine: permissive engines and unknown stay silent', () => {
  const sql = 'SELECT id, state FROM orders GROUP BY id';
  for (const engine of ['sqlite', 'clickhouse', 'duckdb'] as const) {
    assert.equal(findFor(sql, 'not-in-group-by', engine as never), undefined, engine);
  }
  assert.equal(findFor(sql, 'not-in-group-by'), undefined, 'unknown engine → no opinion');
  // the engine can also arrive via the context, which is how the editor wires it
  const withEngine = { ...ctx(), engine: 'postgres' as const };
  assert.ok(diagnose(sql, withEngine).some(d => d.code === 'not-in-group-by'));
});

test('not-in-group-by stays quiet when parsing is uncertain', () => {
  assert.equal(findFor('SELECT *, state FROM orders GROUP BY id', 'not-in-group-by', 'mysql'), undefined,
    'a star means the select list cannot be trusted');
  assert.equal(findFor('SELECT id, (SELECT MAX(x) FROM orders) AS m FROM orders GROUP BY id',
    'not-in-group-by', 'mysql'), undefined);
  assert.equal(findFor('SELECT id, state FROM orders GROUP BY ROLLUP(id)', 'not-in-group-by', 'mysql'), undefined);
  assert.equal(findFor('SELECT id, UPPER(state) FROM orders GROUP BY id', 'not-in-group-by', 'mysql'), undefined);
  const d = findFor('SELECT id, state FROM orders GROUP BY 1', 'not-in-group-by', 'postgres')!;
  assert.equal(d.message.includes('state'), true, 'GROUP BY 1 covers id, not state');
});

test('GROUP/ORDER BY inside strings or comments produces nothing', () => {
  assert.ok(!codes("SELECT 'GROUP BY 9' FROM orders", ctx({ engine: 'postgres' }))
    .includes('ordinal-out-of-range'));
});

// ── WP-08 8.7: backslash escapes are a dialect property ─────────────────────

test('a trailing backslash in a PG string is not an unterminated literal', () => {
  assert.equal(findUnterminatedQuote(String.raw`SELECT 'C:\';`, 'postgres'), -1);
  // …but on MySQL the backslash escapes the closing quote — genuinely open.
  assert.ok(findUnterminatedQuote(String.raw`SELECT 'C:\';`, 'mysql') >= 0);
  // MySQL escape still parses as one literal
  assert.equal(findUnterminatedQuote(String.raw`SELECT 'a\'b' FROM t`, 'mysql'), -1);
  // PG E'…' strings take backslash escapes even on PG
  assert.equal(findUnterminatedQuote(String.raw`SELECT E'a\'b' FROM t`, 'postgres'), -1);
  // a backslash inside a backtick identifier is never an escape
  assert.equal(findUnterminatedQuote('SELECT `a\\` FROM t', 'mysql'), -1);
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('SQL Server gets the GROUP BY warning — it is the engine most certain to reject', () => {
  // Msg 8120: "Column 'x' is invalid in the select list because it is not
  // contained in either an aggregate function or the GROUP BY clause."
  // Verified against SQL Server 2022. Leaving it out meant the one engine that
  // will definitely reject the query got no warning about it.
  const ctx = {
    objects: new Set(['t']), columns: new Map([['t', new Set(['a', 'b'])]]),
    indexed: new Map(), hasDefaultDb: true, virtual: new Set(),
  } as never;
  const d = diagnose('SELECT a, b, COUNT(*) FROM t GROUP BY a', ctx, ';', 'sqlserver')
    .filter(x => x.code === 'not-in-group-by');
  assert.equal(d.length, 1);
  // The REASON differs even where the verdict does not: quoting MySQL's
  // ONLY_FULL_GROUP_BY at a SQL Server user sends them looking for a setting
  // that does not exist.
  assert.match(d[0].message, /Msg 8120/);
  assert.ok(!d[0].message.includes('ONLY_FULL_GROUP_BY'), d[0].message);
});

test('the permissive engines still get no opinion', () => {
  const ctx = {
    objects: new Set(['t']), columns: new Map([['t', new Set(['a', 'b'])]]),
    indexed: new Map(), hasDefaultDb: true, virtual: new Set(),
  } as never;
  for (const e of ['sqlite', 'duckdb', 'clickhouse'] as const) {
    const d = diagnose('SELECT a, b, COUNT(*) FROM t GROUP BY a', ctx, ';', e)
      .filter(x => x.code === 'not-in-group-by');
    assert.equal(d.length, 0, e);
  }
});
