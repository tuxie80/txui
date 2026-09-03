/**
 * sqlBeautify (src/utils/sqlBeautify.ts): the pure formatter behind
 * "Beautify statement" (⇧⌥F) and auto-format-on-`;`.
 * Contract under test: clause layout, subquery indentation, string/comment
 * safety, keyword casing, and strict idempotency.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSql, tokenizeSql } from '../src/utils/sqlBeautify.ts';

const U = { keywordCase: 'upper' as const };
const L = { keywordCase: 'lower' as const };

/** every test case must be idempotent */
const idem = (s: string, opts = U) => assert.equal(formatSql(s, opts), s, 'not idempotent');

test('basic clause layout', () => {
  const out = formatSql("select id, name from users where status = 'a' and n > 1 order by name limit 10", U);
  assert.equal(out, [
    'SELECT id,',
    '  name',
    'FROM users',
    "WHERE status = 'a'",
    '  AND n > 1',
    'ORDER BY name',
    'LIMIT 10',
  ].join('\n'));
  idem(out);
});

test('joins keep their prefix on one line', () => {
  const out = formatSql('select a.x from t1 a left join t2 b on a.id = b.id inner join t3 c on b.id = c.id', U);
  assert.ok(out.includes('\nLEFT JOIN t2 b ON a.id = b.id\n'), out);
  assert.ok(out.includes('\nINNER JOIN t3 c ON b.id = c.id'), out);
  idem(out);
});

test('group by / having / order by break as pairs', () => {
  const out = formatSql('select a, sum(b) from t group by a, b having count(*) > 1 order by a desc', U);
  assert.ok(out.includes('\nGROUP BY a,\n  b\n'), out);
  assert.ok(out.includes('\nHAVING COUNT(*) > 1\n'), out);
  assert.ok(out.includes('\nORDER BY a DESC'), out);
  idem(out);
});

test('subqueries indent one level and close at the outer level', () => {
  const out = formatSql("select * from t where x in (select id from u where u.k = 'a')", U);
  assert.equal(out, [
    'SELECT *',
    'FROM t',
    'WHERE x IN (',
    '  SELECT id',
    '  FROM u',
    "  WHERE u.k = 'a'",
    ')',
  ].join('\n'));
  idem(out);
});

test('INSERT column lists and VALUES tuples stay inline', () => {
  const out = formatSql("insert into logs (a, b, c) values (1, 'x', null), (2, 'y', null)", U);
  assert.equal(out, [
    'INSERT INTO logs (a, b, c)',
    "VALUES (1, 'x', NULL),",
    "  (2, 'y', NULL)",
  ].join('\n'));
  idem(out);
});

test('DELETE FROM stays on one line; SET items break', () => {
  const out = formatSql('delete from t where id = 5', U);
  assert.ok(out.startsWith('DELETE FROM t\nWHERE id = 5'), out);
  idem(out);
  const upd = formatSql('update t set a = 1, b = 2 where id = 3', U);
  assert.equal(upd, 'UPDATE t\nSET a = 1,\n  b = 2\nWHERE id = 3');
  idem(upd);
});

test('strings containing keywords are never touched', () => {
  const src = "select 'select from where group by' as s, 'it''s ''quoted''' as q from t";
  const out = formatSql(src, U);
  assert.ok(out.includes("'select from where group by'"), out);
  assert.ok(out.includes("'it''s ''quoted'''"), out);
  idem(out);
});

test('quoted identifiers are never touched or cased', () => {
  const out = formatSql('select `select`, "From" from `my table`', U);
  assert.ok(out.includes('`select`'), out);
  assert.ok(out.includes('"From"'), out);
  assert.ok(out.includes('FROM `my table`'), out);
  idem(out);
});

test('line comments survive and force a newline after themselves', () => {
  const out = formatSql('select a -- pick a\nfrom t where x = 1', U);
  assert.ok(out.includes('SELECT a -- pick a\nFROM t'), out);
  idem(out);
  // a keyword-looking comment must not be uppercased
  const c = formatSql('select 1 -- select from where', U);
  assert.ok(c.includes('-- select from where'), c);
  idem(c);
});

test('block comments survive inline', () => {
  const out = formatSql('select /* hint: use index */ a from t', U);
  assert.ok(out.includes('/* hint: use index */'), out);
  idem(out);
});

test('PG dollar-quoted bodies pass through verbatim', () => {
  const body = '$$begin select; from; end$$';
  const out = formatSql(`select f(${body}, 1) from t`, { ...U, engine: 'postgres' });
  assert.ok(out.includes(body), out);
  idem(out, { ...U, engine: 'postgres' });
});

test('PG casts, concat and assignment ops', () => {
  const out = formatSql("select a::int, b || c from t where x >= -1 and y <= +2", { ...U, engine: 'postgres' });
  assert.ok(out.includes('a::INT,'), out);
  assert.ok(out.includes('b || c'), out);
  assert.ok(out.includes('x >= -1'), out);
  assert.ok(out.includes('y <= +2'), out);
  idem(out, { ...U, engine: 'postgres' });
});

test('lower-case preference lowercases keywords and functions', () => {
  const out = formatSql('SELECT ID, COUNT(*) FROM USERS WHERE X = 1 GROUP BY ID', L);
  assert.equal(out, [
    'select ID,',
    '  count(*)',
    'from USERS',   // identifiers the catalog does not know keep their case
    'where X = 1',
    'group by ID',
  ].join('\n'));
  idem(out, L);
});

test('CTEs break out and close cleanly', () => {
  const out = formatSql('with r as (select region, sum(s) as t from sales group by region) select region, t from r where t > 10', U);
  assert.ok(out.startsWith('WITH r AS (\n  SELECT region, SUM(s) AS t\n  FROM sales\n  GROUP BY region\n)\nSELECT'), out);
  idem(out);
});

test('CASE expressions stay inline', () => {
  const out = formatSql("select case when a > 1 then 'big' else 'small' end as size from t", U);
  assert.ok(out.includes("CASE WHEN a > 1 THEN 'big' ELSE 'small' END AS size"), out);
  idem(out);
});

test('function calls and type params attach without a space', () => {
  const out = formatSql("select count( * ), concat(a, b) from t where name like 'x%'", U);
  assert.ok(out.includes('COUNT(*),'), out);
  assert.ok(out.includes('CONCAT(a, b)'), out);
  const ddl = formatSql("create table t (id int primary key, name varchar(50) not null)", U);
  assert.ok(ddl.includes('t (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL)'), ddl);
  idem(ddl);
});

test('qualified names and variables keep tight dots', () => {
  const out = formatSql('select u.id, @@global.sql_mode, :limit from db.users u', U);
  assert.ok(out.includes('u.id'), out);
  assert.ok(out.includes('@@global.sql_mode'), out);
  assert.ok(out.includes(':limit'), out);
  idem(out);
});

test('trailing semicolons and multi-statement fragments survive', () => {
  const out = formatSql('select 1; select 2;', U);
  assert.equal(out, 'SELECT 1;\nSELECT 2;');
  idem(out);
});

test('operator normalization collapses random spacing', () => {
  assert.equal(formatSql('select a  =  1 ,b>2 from t', U), 'SELECT a = 1,\n  b > 2\nFROM t');
});

test('empty and whitespace input', () => {
  assert.equal(formatSql('', U), '');
  assert.equal(formatSql('   \n  ', U), '');
});

test('tokenizer round-trips content: no non-whitespace char is ever lost', () => {
  // (whitespace INSIDE strings/comments is content, so samples keep those tight)
  const samples = [
    "select 'unterminated",
    'select /*unterminated',
    'select `weird', 'select a #comment to eof'.replace(' to eof', ''),
    'select 0x1F, 1.5e-3, .5 from t',
  ];
  for (const s of samples) {
    const toks = tokenizeSql(s);
    const stripped = s.replace(/\s+/g, '');
    const rejoined = toks.map(t => t.text).join('');
    assert.equal(rejoined, stripped, `token loss on ${JSON.stringify(s)}`);
  }
});

// ── WP-08 8.7: string boundaries are dialect-aware ──────────────────────────

test('a PG string ending in a backslash keeps its bytes through the beautifier', () => {
  const src = String.raw`select 'C:\' from t;`;
  const out = formatSql(src, { engine: 'postgres' });
  // the string token must survive byte-identical — a shifted boundary would
  // let keyword-casing rewrite string content
  assert.ok(out.includes(String.raw`'C:\'`), out);
});

test('a MySQL backslash-escaped quote is still one literal', () => {
  const toks = tokenizeSql(String.raw`select 'a\'b' from t`, 'mysql');
  const strings = toks.filter(t => t.kind === 'string').map(t => t.text);
  assert.deepEqual(strings, [String.raw`'a\'b'`]);
});

test('a backslash inside a backtick identifier does not extend it', () => {
  const toks = tokenizeSql('select `a\\` from t', 'mysql');
  const qids = toks.filter(t => t.kind === 'qident').map(t => t.text);
  assert.deepEqual(qids, ['`a\\`']);
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('a T-SQL buffer gets T-SQL vocabulary, not MySQL\'s', () => {
  // `keywordCatalog` already knew every dialect; the formatter folded the
  // engine into two and handed SQL Server MySQL's words — so `TOP`, `ISNULL`
  // and `GETDATE` went un-cased while MySQL-only words were cased in a
  // statement that cannot contain them.
  const sql = 'select top (10) isnull(a, 0), getdate() from t';
  const out = formatSql(sql, { engine: 'sqlserver', keywordCase: 'upper' });
  assert.match(out, /SELECT TOP \(10\)/);
  assert.match(out, /ISNULL\(a, 0\)/);
  assert.match(out, /GETDATE\(\)/);
});

test('a one-letter alias survives — a snippet label must not become a keyword', () => {
  // The catalog carries `DECLARE @t TABLE` as a label. Split on punctuation it
  // leaks a bare `t`, and every alias named `t` in the buffer was upper-cased.
  // No SQL keyword is one character.
  const out = formatSql('select a as t from x order by t', {
    engine: 'sqlserver', keywordCase: 'upper',
  });
  assert.match(out, /AS t\b/);
  assert.match(out, /ORDER BY t\b/);
  assert.ok(!/\bAS T\b/.test(out), out);
});

test('the other engines keep the words they had', () => {
  // MySQL's own vocabulary must not have shifted under it.
  assert.match(formatSql('select now() from t', { engine: 'mysql', keywordCase: 'upper' }),
    /NOW\(\)/);
  assert.match(formatSql('select a as t from x', { engine: 'mysql', keywordCase: 'upper' }),
    /AS t\b/);
});
