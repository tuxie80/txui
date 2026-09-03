/**
 * Semantic symbol references (src/utils/symbolRefs.ts).
 *
 * The contract: highlight only what the rename classifier calls `definite` —
 * provably the same symbol as the one under the caret. Textual lookalikes
 * (strings, comments, the OTHER table's same-named column) must stay dark.
 * The caret position is written as `|` in the SQL and stripped before the
 * call, as in the renameRefactor tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symbolRefs } from '../src/utils/symbolRefs.ts';
import { maskLiterals } from '../src/utils/findUsages.ts';

function refsAt(marked: string, engine = 'mysql', delimiter = ';') {
  const offset = marked.indexOf('|');
  assert.ok(offset >= 0, 'missing caret marker |');
  const sql = marked.replace('|', '');
  const res = symbolRefs(sql, offset, engine, delimiter);
  return { sql, res };
}

function slices(sql: string, ranges: { from: number; to: number }[]): string[] {
  return ranges.map(r => sql.slice(r.from, r.to));
}

test('alias: definition and every use, def marked separately', () => {
  const { sql, res } = refsAt(
    "SELECT o.id, o.total FROM orders o WHERE o.state = 'x' AND o|.id IS NOT NULL",
  );
  assert.ok(res);
  assert.deepEqual(slices(sql, res!.refs), ['o', 'o', 'o', 'o', 'o']);
  assert.equal(sql.slice(res!.def!.from, res!.def!.to), 'o');
  // The definition is the occurrence right after the table name.
  assert.equal(sql.slice(res!.def!.from - 8, res!.def!.from), ' orders ');
  // Every reference is one of the refs; the def is among them.
  assert.ok(res!.refs.some(r => r.from === res!.def!.from && r.to === res!.def!.to));
});

test('alias defined with AS is found as the definition', () => {
  const { sql, res } = refsAt('SELECT o|.id FROM orders AS o');
  assert.ok(res?.def);
  assert.equal(sql.slice(res!.def!.from, res!.def!.to), 'o');
  assert.ok(sql.slice(0, res!.def!.from).endsWith('AS '));
});

test('joined tables with same-named columns: only the right table\'s refs', () => {
  const { sql, res } = refsAt(
    'SELECT o.id|, c.id FROM orders o JOIN customers c ON o.customer_id = c.id',
  );
  assert.ok(res);
  assert.deepEqual(slices(sql, res!.refs), ['id']);
  // The single ref is o.id's column — c.id must NOT light up.
  assert.ok(sql.slice(0, res!.refs[0].from).endsWith('o.'));
  assert.equal(res!.def, undefined); // a column is defined in the schema, not here
});

test('CTE: definition, FROM reference and qualifier across the WITH statement', () => {
  const { sql, res } = refsAt(
    "WITH act|ive AS (SELECT id FROM users WHERE state = 'x') "
    + 'SELECT * FROM active WHERE active.id > 5;\n'
    + 'SELECT * FROM active;', // a second statement reusing the name — not in scope
  );
  assert.ok(res);
  // WITH def + FROM ref + the qualifier in `active.id` — and nothing from the
  // second statement (SQL scopes a CTE to its WITH statement).
  assert.deepEqual(slices(sql, res!.refs), ['active', 'active', 'active']);
  assert.equal(sql.slice(res!.def!.from, res!.def!.to), 'active');
  assert.ok(res!.refs.every(r => r.from < sql.indexOf(';')));
});

test('string and comment lookalikes are not highlighted', () => {
  const { sql, res } = refsAt(
    "SELECT * FROM ord|ers -- orders in a comment\nWHERE note = 'orders in a string'",
  );
  assert.ok(res);
  assert.deepEqual(slices(sql, res!.refs), ['orders']);
  assert.equal(res!.def, undefined); // a table is defined in the database, not here
});

test('bare column with no schema metadata stays unproven → no refs', () => {
  // Without column metadata the classifier cannot prove which table `total`
  // belongs to, so nothing is definite and there is nothing to paint.
  const { res } = refsAt('SELECT tot|al FROM orders');
  assert.equal(res, null);
});

test('caret on a keyword, number or whitespace → null', () => {
  assert.equal(refsAt('SEL|ECT 1').res, null);
  assert.equal(refsAt('SELECT 1|23').res, null);
  assert.equal(refsAt('SELECT | 1').res, null);
});

test('custom delimiter is honoured when locating the current statement', () => {
  const { sql, res } = refsAt('SELECT * FROM ord|ers//\nSELECT * FROM orders//', 'mysql', '//');
  // Only the first statement is in scope.
  assert.ok(res);
  assert.deepEqual(slices(sql, res!.refs), ['orders']);
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('a SQL Server reference written "quoted" is found, not masked away', () => {
  // `maskLiterals` already knew T-SQL's rules; the caller folded the engine
  // into `mysql` and threw them away. Under MySQL rules `"total"` is a STRING,
  // so the reference was blanked out and a rename silently skipped it.
  const sql = 'SELECT "total", [qty] FROM [sales].[orders] o WHERE o."total" > 0';
  const my = maskLiterals(sql, 'mysql');
  const ms = maskLiterals(sql, 'sqlserver');
  assert.ok(!my.includes('"total"'), 'MySQL rules should blank it — that is the bug');
  assert.ok(ms.includes('"total"'), 'SQL Server keeps it as an identifier');
  // …and the bracketed one survives both, since `[` is not a MySQL quote.
  assert.ok(ms.includes('[qty]'));
});

test('a single-quoted literal is still masked on SQL Server', () => {
  const masked = maskLiterals("SELECT a FROM t WHERE note = 'total [qty] \"x\"'", 'sqlserver');
  assert.ok(!masked.includes('[qty]'), masked);
  assert.ok(!masked.includes('total'), masked);
});

test('a doubled bracket inside a name does not end it', () => {
  const masked = maskLiterals('SELECT [we]]ird] FROM t', 'sqlserver');
  assert.ok(masked.includes('[we]]ird]'), masked);
});
