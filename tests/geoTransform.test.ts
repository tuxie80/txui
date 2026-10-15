/**
 * geoTransform — the derived "View in WGS 84" query builder: subselect
 * wrapping, identifier quoting, the multi-geometry and refusal cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransformQuery } from '../src/utils/geoTransform.ts';

test('a plain SELECT wraps as a subselect, only the geometry column transformed', () => {
  const r = buildTransformQuery(
    'SELECT id, name, geom FROM districts',
    ['id', 'name', 'geom'], 'geom');
  assert.ok(r.ok);
  assert.equal(r.sql,
    'SELECT "id", "name", ST_AsEWKB(ST_Transform("geom", 4326)) AS "geom"\n' +
    'FROM (\nSELECT id, name, geom FROM districts\n) AS txui_geo_src');
});

test('a trailing semicolon (and several) are stripped before wrapping', () => {
  const r = buildTransformQuery('SELECT geom FROM t;;  ;\n', ['geom'], 'geom');
  assert.ok(r.ok);
  assert.ok(!r.sql.includes(';\n) AS'), r.sql);
  assert.ok(r.sql.includes('FROM (\nSELECT geom FROM t\n) AS txui_geo_src'));
});

test('identifiers are double-quoted, embedded quotes doubled', () => {
  const r = buildTransformQuery(
    'SELECT "weird""col", geom FROM t',
    ['weird"col', 'geom'], 'geom');
  assert.ok(r.ok);
  assert.ok(r.sql.includes('"weird""col"'), r.sql);
  // reserved words and mixed case are quoted unconditionally
  const r2 = buildTransformQuery('SELECT "select", geom FROM t', ['select', 'geom'], 'geom');
  assert.ok(r2.ok && r2.sql.includes('"select"'), r2.ok && r2.sql);
});

test('a second geometry column passes through untransformed', () => {
  const r = buildTransformQuery(
    'SELECT geom, border FROM t', ['geom', 'border'], 'border');
  assert.ok(r.ok);
  assert.ok(r.sql.includes('"geom", ST_AsEWKB(ST_Transform("border", 4326)) AS "border"'), r.sql);
  assert.ok(!r.sql.includes('ST_Transform("geom"'), r.sql);
});

test('a CTE wraps whole — WITH stays inside the subquery', () => {
  const sql = 'WITH big AS (SELECT geom FROM t WHERE area > 10) SELECT id, geom FROM big';
  const r = buildTransformQuery(sql, ['id', 'geom'], 'geom');
  assert.ok(r.ok);
  assert.ok(r.sql.startsWith('SELECT "id", ST_AsEWKB('), r.sql);
  assert.ok(r.sql.includes(`FROM (\n${sql}\n) AS txui_geo_src`), r.sql);
});

test('ORDER BY / LIMIT stay inside the subquery, verbatim', () => {
  const sql = 'SELECT geom FROM t ORDER BY name DESC LIMIT 20';
  const r = buildTransformQuery(sql, ['geom'], 'geom');
  assert.ok(r.ok);
  assert.ok(r.sql.includes(`FROM (\n${sql}\n) AS txui_geo_src`), r.sql);
});

test('a parenthesised SELECT wraps (legal as a PostgreSQL subquery)', () => {
  const r = buildTransformQuery('(SELECT geom FROM t)', ['geom'], 'geom');
  assert.ok(r.ok);
  assert.ok(r.sql.includes('FROM (\n(SELECT geom FROM t)\n) AS txui_geo_src'), r.sql);
});

test('a leading comment does not defeat the SELECT-family check', () => {
  const r = buildTransformQuery('-- the districts\nSELECT geom FROM t', ['geom'], 'geom');
  assert.ok(r.ok);
  assert.ok(r.sql.includes('-- the districts\nSELECT geom FROM t'), r.sql);
});

test('a trailing comment after the semicolon is not a second statement', () => {
  const r = buildTransformQuery('SELECT geom FROM t; -- done\n', ['geom'], 'geom');
  assert.ok(r.ok);
  // …and the comment cannot leak into the subquery: only the runnable
  // statement's own text is wrapped.
  assert.ok(!r.sql.includes('-- done'), r.sql);
});

test('refusals: multiple statements', () => {
  const r = buildTransformQuery('SELECT geom FROM a; SELECT geom FROM b', ['geom'], 'geom');
  assert.ok(!r.ok);
  assert.match(r.reason, /2 statements/);
});

test('refusals: non-SELECT families cannot be wrapped', () => {
  for (const sql of ['UPDATE t SET x = 1', 'SHOW server_version', "SET work_mem = '64MB'",
    'EXPLAIN SELECT geom FROM t', 'DROP TABLE t']) {
    const r = buildTransformQuery(sql, ['geom'], 'geom');
    assert.ok(!r.ok, sql);
    assert.match(r.reason, /SELECT-family/);
  }
});

test('refusals: unknown geometry column, duplicate names, empty text', () => {
  const missing = buildTransformQuery('SELECT id FROM t', ['id'], 'geom');
  assert.ok(!missing.ok);
  assert.match(missing.reason, /no column named "geom"/);

  const dup = buildTransformQuery('SELECT 1 AS x, 2 AS x', ['x', 'x'], 'x');
  assert.ok(!dup.ok);
  assert.match(dup.reason, /two columns named "x"/);

  assert.ok(!buildTransformQuery('', ['geom'], 'geom').ok);
  assert.ok(!buildTransformQuery('   ;  ', ['geom'], 'geom').ok);
});
