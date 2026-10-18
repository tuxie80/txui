/**
 * SQL Server UDT derived-query builder (src/utils/mssqlUdt.ts).
 *
 * The contract being pinned: a user SELECT becomes a derived table, udt
 * columns are re-projected as .STAsBinary() (wkb — lands in the existing
 * 0x-hex → parseWkbHex stack) or .ToString() (wkt — text only, the
 * hierarchyid-capable fallback), and T-SQL's derived-table rules are honoured
 * (named unique columns, ORDER BY legalised with OFFSET 0 ROWS, OPTION
 * hoisted, batches and FOR XML/JSON refused).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUdtDerivedQuery, stripTrailingSemis, udtColumnNames, viewAsGeoAction,
  type ColumnLike,
} from '../src/utils/mssqlUdt.ts';

const col = (name: string, typeName: string): ColumnLike => ({ name, typeName });

function built(sql: string, cols: ColumnLike[], mode: 'wkb' | 'wkt' = 'wkb') {
  const r = buildUdtDerivedQuery(sql, cols, mode);
  assert.ok(r.ok, `expected ok, got refusal: ${r.ok ? '' : r.reason}`);
  return r;
}

function refused(sql: string, cols: ColumnLike[], mode: 'wkb' | 'wkt' = 'wkb'): string {
  const r = buildUdtDerivedQuery(sql, cols, mode);
  assert.ok(!r.ok, `expected refusal, got sql: ${r.ok ? r.query.sql : ''}`);
  return r.ok ? '' : r.reason;
}

// ── the happy path ────────────────────────────────────────────────────────────

test('substitute: udt column replaced by STAsBinary under the same alias', () => {
  const r = built(
    'SELECT id, geom FROM dbo.roads',
    [col('id', 'int'), col('geom', 'udt')],
  );
  assert.equal(r.query.strategy, 'substitute');
  assert.equal(
    r.query.sql,
    'SELECT txui_geo.[id], txui_geo.[geom].STAsBinary() AS [geom]\n' +
    'FROM (\nSELECT id, geom FROM dbo.roads\n) AS txui_geo');
  assert.deepEqual(r.query.wrapped, ['geom']);
  assert.match(r.logLine, /Derived query: 1 udt column \(geom\) wrapped with \.STAsBinary\(\)/);
  assert.match(r.logLine, /\[substitute\]/);
});

test('wkt mode wraps with ToString — the hierarchyid-capable fallback', () => {
  const r = built(
    'SELECT node FROM org.tree',
    [col('node', 'udt')],
    'wkt',
  );
  assert.match(r.query.sql, /txui_geo\.\[node\]\.ToString\(\) AS \[node\]/);
  assert.match(r.logLine, /WKT text/);
});

test('several udt columns wrap; plain columns pass through by name', () => {
  const r = built(
    'SELECT id, g1, label, g2 FROM t',
    [col('id', 'int'), col('g1', 'udt'), col('label', 'nvarchar'), col('g2', 'udt')],
  );
  assert.match(r.query.sql, /txui_geo\.\[g1\]\.STAsBinary\(\) AS \[g1\]/);
  assert.match(r.query.sql, /txui_geo\.\[g2\]\.STAsBinary\(\) AS \[g2\]/);
  assert.match(r.query.sql, /txui_geo\.\[label\]/);
  assert.deepEqual(r.query.wrapped, ['g1', 'g2']);
});

test('column order is preserved — an ordinal ORDER BY still resolves', () => {
  const r = built(
    'SELECT a, geom, b FROM t',
    [col('a', 'int'), col('geom', 'udt'), col('b', 'int')],
  );
  const list = r.query.sql.split('\n')[0];
  assert.ok(list.indexOf('[a]') < list.indexOf('[geom]'));
  assert.ok(list.indexOf('[geom]') < list.indexOf('[b]'));
});

test('hostile column names are bracket-escaped (]] doubles)', () => {
  const r = built(
    'SELECT [we]ird], geom FROM t',
    [col('we]ird]', 'int'), col('geom', 'udt')],
  );
  assert.ok(r.query.sql.includes('txui_geo.[we]]ird]]]'), r.query.sql);
  assert.match(r.query.sql, /txui_geo\.\[geom\]\.STAsBinary\(\) AS \[geom\]/);
});

test('a column literally named [order] is quoted, not parsed', () => {
  const r = built('SELECT [order], geom FROM t', [col('order', 'int'), col('geom', 'udt')]);
  assert.match(r.query.sql, /txui_geo\.\[order\],/);
});

// ── clause handling ───────────────────────────────────────────────────────────

test('ORDER BY is legalised inside with OFFSET 0 ROWS (TOP semantics preserved)', () => {
  const r = built(
    'SELECT TOP 10 id, geom FROM t ORDER BY id DESC',
    [col('id', 'int'), col('geom', 'udt')],
  );
  assert.match(r.query.sql, /ORDER BY id DESC\nOFFSET 0 ROWS\n\) AS txui_geo/);
  assert.deepEqual(r.query.clauseNotes, ['ORDER BY kept in place via OFFSET 0 ROWS']);
});

test('ORDER BY already carrying OFFSET/FETCH is left alone', () => {
  const r = built(
    'SELECT id, geom FROM t ORDER BY id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
    [col('id', 'int'), col('geom', 'udt')],
  );
  assert.equal(r.query.sql.match(/OFFSET/g)!.length, 1, 'no double OFFSET');
  assert.deepEqual(r.query.clauseNotes, ['ORDER BY already carries OFFSET/FETCH']);
});

test('OPTION is hoisted to the outer query (illegal inside a derived table)', () => {
  const r = built(
    'SELECT id, geom FROM t ORDER BY id OPTION (RECOMPILE)',
    [col('id', 'int'), col('geom', 'udt')],
  );
  assert.match(r.query.sql, /ORDER BY id\nOFFSET 0 ROWS\n\) AS txui_geo\nOPTION \(RECOMPILE\)$/);
  assert.ok(r.query.clauseNotes.some(n => n.includes('OPTION')));
});

test('ORDER BY inside a subquery stays inside; only the top-level one is legalised', () => {
  const r = built(
    'SELECT id, geom FROM t WHERE id IN (SELECT id FROM u ORDER BY id) ORDER BY id',
    [col('id', 'int'), col('geom', 'udt')],
  );
  // exactly one OFFSET 0 ROWS, appended after the TOP-LEVEL ORDER BY (the last one)
  const inner = r.query.sql.split('\n').slice(1, -1).join('\n');
  assert.equal(inner.match(/OFFSET 0 ROWS/g)!.length, 1);
  assert.match(inner, /ORDER BY id\nOFFSET 0 ROWS$/);
});

test('WITH…SELECT wraps as-is', () => {
  const r = built(
    'WITH x AS (SELECT 1 AS id) SELECT id, geom FROM x JOIN t ON t.id = x.id',
    [col('id', 'int'), col('geom', 'udt')],
  );
  assert.match(r.query.sql, /FROM \(\nWITH x AS/);
});

test('trailing semicolons and whitespace are stripped before wrapping', () => {
  const r = built(
    'SELECT id, geom FROM t;;  \n',
    [col('id', 'int'), col('geom', 'udt')],
  );
  assert.match(r.query.sql, /FROM \(\nSELECT id, geom FROM t\n\) AS txui_geo/);
});

test('a trailing line comment cannot swallow the closing paren', () => {
  const r = built(
    'SELECT id, geom FROM t -- the roads',
    [col('id', 'int'), col('geom', 'udt')],
  );
  assert.match(r.query.sql, /-- the roads\n\) AS txui_geo/);
});

test('a trailing line comment after ORDER BY cannot swallow OFFSET 0 ROWS either', () => {
  // The legaliser is newline-led: appended straight after `-- keep` it would
  // land INSIDE the comment and the wrap would die with Msg 1033.
  const r = built(
    'SELECT geom FROM t ORDER BY id -- keep',
    [col('geom', 'udt')],
  );
  assert.match(r.query.sql, /-- keep\nOFFSET 0 ROWS\n\) AS txui_geo/);
  assert.deepEqual(r.query.clauseNotes, ['ORDER BY kept in place via OFFSET 0 ROWS']);
});

test('strings/comments/brackets inside the statement are not mistaken for clauses', () => {
  const r = built(
    "SELECT 'ORDER BY trick' AS s, geom FROM t /* ORDER BY decoy */ WHERE s <> ';'",
    [col('s', 'varchar'), col('geom', 'udt')],
  );
  assert.equal(r.query.clauseNotes.length, 0, `false clause hits: ${r.query.clauseNotes}`);
  assert.ok(!r.query.sql.includes('OFFSET 0 ROWS'));
});

// ── refusals ──────────────────────────────────────────────────────────────────

test('refuses when the result has no udt columns', () => {
  assert.match(refused('SELECT 1', [col('a', 'int')]), /No udt columns/);
});

test('refuses a multi-statement batch (top-level semicolon)', () => {
  assert.match(
    refused('SELECT 1; SELECT geom FROM t', [col('geom', 'udt')]),
    /multi-statement batch/);
  // A batch that does not even start with SELECT trips that gate first.
  assert.match(
    refused('SET NOCOUNT ON; SELECT geom FROM t', [col('geom', 'udt')]),
    /Only a SELECT/);
  // …but a semicolon inside a string is not a separator.
  const r = built("SELECT ';' AS s, geom FROM t", [col('s', 'varchar'), col('geom', 'udt')]);
  assert.ok(r.query.sql.length > 0);
});

test('refuses FOR XML / FOR JSON (illegal inside a derived table)', () => {
  assert.match(refused('SELECT geom FROM t FOR XML RAW', [col('geom', 'udt')]), /FOR XML \/ FOR JSON/);
  assert.match(refused('SELECT geom FROM t FOR JSON AUTO', [col('geom', 'udt')]), /FOR XML \/ FOR JSON/);
  // …but FOR SYSTEM_TIME (temporal) is not a FOR XML.
  const r = built('SELECT id, geom FROM t FOR SYSTEM_TIME ALL', [col('id', 'int'), col('geom', 'udt')]);
  assert.ok(r.query.sql.includes('FOR SYSTEM_TIME ALL'));
});

test('refuses a non-SELECT statement with an honest reason', () => {
  assert.match(refused('EXEC sp_who', [col('geom', 'udt')]), /Only a SELECT/);
  assert.match(refused('', [col('geom', 'udt')]), /empty/);
});

test('refuses when every udt column is unnamed (nothing to reference)', () => {
  assert.match(
    refused('SELECT geom FROM t', [col('', 'udt')]),
    /no name — alias it/);
});

// ── the append fallback ───────────────────────────────────────────────────────

test('duplicate column names → append strategy: t.* plus suffixed decoded columns', () => {
  const r = built(
    'SELECT 1 AS x, 2 AS x, geom FROM t',
    [col('x', 'int'), col('x', 'int'), col('geom', 'udt')],
  );
  assert.equal(r.query.strategy, 'append');
  assert.match(r.query.sql, /SELECT txui_geo\.\*, txui_geo\.\[geom\]\.STAsBinary\(\) AS \[geom_wkb\]/);
  assert.ok(r.query.clauseNotes.some(n => n.includes('appended')));
});

test('append alias never collides with an existing column', () => {
  const r = built(
    'SELECT 1 AS x, 2 AS x, geom, geom_wkb FROM t',
    [col('x', 'int'), col('x', 'int'), col('geom', 'udt'), col('geom_wkb', 'varbinary')],
  );
  assert.match(r.query.sql, /AS \[geom_wkb_2\]/);
});

test('an unnamed udt column among named ones is skipped, and the note says so', () => {
  const r = built(
    'SELECT 1 AS x, 2 AS x, geom FROM t',
    [col('x', 'int'), col('x', 'int'), col('', 'udt'), col('geom', 'udt')],
  );
  assert.deepEqual(r.query.wrapped, ['geom']);
  assert.ok(r.query.clauseNotes.some(n => n.includes('unnamed udt')));
});

test('udtColumnNames picks exactly the udt-typed columns', () => {
  assert.deepEqual(
    udtColumnNames([col('a', 'int'), col('g', 'udt'), col('h', 'udt'), col('s', 'nvarchar')]),
    ['g', 'h']);
  assert.deepEqual(udtColumnNames([]), []);
});

test('stripTrailingSemis handles trivia tails', () => {
  assert.equal(stripTrailingSemis('SELECT 1;'), 'SELECT 1');
  assert.equal(stripTrailingSemis('SELECT 1 ; ; \n\t'), 'SELECT 1');
  assert.equal(stripTrailingSemis('SELECT 1'), 'SELECT 1');
});

// ── viewAsGeoAction — the grid-toolbar gate ──────────────────────────────────
// Hidden only when irrelevant (wrong engine, no udt columns); relevant but
// unrunnable → shown with the reason, so the UI greys and explains.

const SQL = 'SELECT id, geom FROM dbo.roads';
const GEO_COLS = [col('id', 'int'), col('geom', 'udt')];

test('hidden on any engine but sqlserver, even with udt columns', () => {
  for (const engine of ['mysql', 'postgres', undefined]) {
    const a = viewAsGeoAction(engine, GEO_COLS, SQL);
    assert.equal(a.show, false);
    assert.equal(a.derived, null);
  }
});

test('hidden on sqlserver when the result has no udt columns', () => {
  const a = viewAsGeoAction('sqlserver', [col('id', 'int'), col('name', 'nvarchar')], SQL);
  assert.equal(a.show, false);
});

test('runnable: sqlserver + udt columns + originating statement', () => {
  const a = viewAsGeoAction('sqlserver', GEO_COLS, SQL);
  assert.equal(a.show, true);
  assert.equal(a.reason, null);
  assert.ok(a.derived);
  assert.match(a.derived.sql, /txui_geo\.\[geom\]\.STAsBinary\(\) AS \[geom\]/);
  assert.match(a.logLine ?? '', /Derived query: 1 udt column \(geom\)/);
});

test('blocked without an originating statement — greyed with the reason', () => {
  for (const src of [undefined, '', '   ']) {
    const a = viewAsGeoAction('sqlserver', GEO_COLS, src);
    assert.equal(a.show, true);
    assert.match(a.reason ?? '', /No originating statement/);
    assert.equal(a.derived, null);
  }
});

test('blocked when the builder refuses — the builder reason is passed through', () => {
  const a = viewAsGeoAction('sqlserver', GEO_COLS, 'SELECT 1; SELECT 2');
  assert.equal(a.show, true);
  assert.match(a.reason ?? '', /multi-statement batch/);
  assert.equal(a.derived, null);
});

test('wkt mode wraps with ToString() under the same gate rules', () => {
  const a = viewAsGeoAction('sqlserver', GEO_COLS, SQL, 'wkt');
  assert.equal(a.show, true);
  assert.equal(a.reason, null);
  assert.ok(a.derived);
  assert.match(a.derived.sql, /txui_geo\.\[geom\]\.ToString\(\) AS \[geom\]/);
  assert.match(a.logLine ?? '', /\.ToString\(\) → WKT text/);
  // The gate rules are mode-independent: no statement still greys and explains.
  const blocked = viewAsGeoAction('sqlserver', GEO_COLS, undefined, 'wkt');
  assert.equal(blocked.show, true);
  assert.match(blocked.reason ?? '', /No originating statement/);
  assert.equal(blocked.derived, null);
});
