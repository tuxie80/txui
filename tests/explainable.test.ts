/**
 * What EXPLAIN applies to (src/utils/explainable.ts).
 *
 * The bug: ⌘E on a `CREATE TABLE` sent `EXPLAIN CREATE TABLE …` to MySQL and
 * showed the user error 1064 — a syntax complaint about a statement they did
 * not write, since the app added the prefix, with no hint that the real answer
 * is "DDL has no plan".
 *
 * The engines differ in a way that matters: PostgreSQL explains
 * `CREATE TABLE … AS SELECT` because there is a query inside it, and MySQL
 * explains no DDL at all. A regex over "is this a SELECT" would get that wrong
 * in both directions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainVerdict, leadingKeyword } from '../src/utils/explainable.ts';

const CREATE_TABLE = `CREATE TABLE \`assignments\` (
  \`id\` bigint NOT NULL,
  \`employee_id\` bigint NOT NULL,
  PRIMARY KEY (\`id\`),
  CONSTRAINT \`assignments_ibfk_1\` FOREIGN KEY (\`employee_id\`) REFERENCES \`employees\` (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

// ── the keyword ─────────────────────────────────────────────────────────────

test('the leading keyword survives comments, parens and whitespace', () => {
  assert.equal(leadingKeyword('  SELECT 1'), 'SELECT');
  assert.equal(leadingKeyword('/* hint */ SELECT 1'), 'SELECT');
  assert.equal(leadingKeyword('-- a note\nUPDATE t SET x = 1'), 'UPDATE');
  assert.equal(leadingKeyword('(SELECT 1)'), 'SELECT');
  assert.equal(leadingKeyword(';\nDELETE FROM t'), 'DELETE');
  assert.equal(leadingKeyword('   '), '');
});

// ── the reported bug ────────────────────────────────────────────────────────

test('MySQL refuses to explain the CREATE TABLE from the bug report', () => {
  const v = explainVerdict(CREATE_TABLE, 'mysql');
  assert.equal(v.ok, false);
  assert.match(v.reason!, /cannot explain a CREATE statement/);
  assert.match(v.reason!, /DDL has no query plan/);
  // And it points somewhere useful rather than stopping at "no".
  assert.match(v.reason!, /the confirmation window states the/);
});

test('the message never mentions the server\'s syntax complaint', () => {
  // The old behaviour surfaced error 1064 about a statement the app had
  // rewritten. Anything resembling that is a regression.
  const v = explainVerdict(CREATE_TABLE, 'mysql');
  assert.doesNotMatch(v.reason!, /1064|syntax/i);
});

// ── what each engine will explain ───────────────────────────────────────────

test('MySQL explains the four data statements, and TABLE', () => {
  for (const sql of [
    'SELECT * FROM t',
    'WITH c AS (SELECT 1) SELECT * FROM c',
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET x = 1',
    'DELETE FROM t WHERE id = 1',
    'TABLE t',
  ]) {
    assert.equal(explainVerdict(sql, 'mysql').ok, true, sql);
  }
});

test('MySQL explains no DDL at all, including the one PostgreSQL would', () => {
  assert.equal(explainVerdict('CREATE TABLE t AS SELECT * FROM u', 'mysql').ok, false);
});

test('PostgreSQL explains a CREATE that wraps a query, and nothing else', () => {
  assert.equal(explainVerdict('CREATE TABLE t AS SELECT * FROM u', 'postgres').ok, true);
  assert.equal(explainVerdict('CREATE MATERIALIZED VIEW m AS SELECT 1', 'postgres').ok, true);
  assert.equal(explainVerdict('CREATE UNLOGGED TABLE t AS SELECT 1', 'postgres').ok, true);

  const plain = explainVerdict(CREATE_TABLE, 'postgres');
  assert.equal(plain.ok, false);
  assert.match(plain.reason!, /only explain a CREATE that wraps a query/);
  assert.match(plain.reason!, /AS SELECT/);
});

test('PostgreSQL explains MERGE and EXECUTE, which MySQL does not have', () => {
  assert.equal(explainVerdict('MERGE INTO t USING s ON t.id = s.id', 'postgres').ok, true);
  assert.equal(explainVerdict('EXECUTE plan(1)', 'postgres').ok, true);
});

test('an engine with no planner says so, rather than naming statements', () => {
  assert.match(explainVerdict('GET key', 'redis').reason!, /no query planner/);
  assert.match(explainVerdict('SELECT 1', 'parquet').reason!, /no query planner/);
});

test('DuckDB explains the data statements and refuses DDL, named as DuckDB', () => {
  // EXPLAIN / EXPLAIN ANALYZE pass through as text; the verdict gate runs first.
  for (const sql of ['SELECT * FROM t', 'WITH c AS (SELECT 1) SELECT * FROM c',
    'INSERT INTO t VALUES (1)', 'UPDATE t SET x = 1', 'DELETE FROM t WHERE id = 1']) {
    assert.equal(explainVerdict(sql, 'duckdb').ok, true, sql);
  }
  const ddl = explainVerdict('CREATE TABLE t (id INTEGER)', 'duckdb');
  assert.equal(ddl.ok, false);
  assert.match(ddl.reason!, /DuckDB cannot explain a CREATE statement/);
  assert.match(ddl.reason!, /DDL has no query plan/);
  // Transaction control and settings are not plans either.
  assert.match(explainVerdict('BEGIN', 'duckdb').reason!, /transaction control/);
  assert.match(explainVerdict('SET threads = 4', 'duckdb').reason!, /server state/);
});

// ── the wording carries the reason, per statement family ────────────────────

test('each family of unexplainable statement gets its own explanation', () => {
  assert.match(explainVerdict('SHOW TABLES', 'mysql').reason!, /server state/);
  assert.match(explainVerdict('SET autocommit = 1', 'mysql').reason!, /server state/);
  assert.match(explainVerdict('GRANT SELECT ON *.* TO u', 'mysql').reason!, /privilege changes/);
  assert.match(explainVerdict('BEGIN', 'mysql').reason!, /transaction control/);
  assert.match(explainVerdict('TRUNCATE t', 'mysql').reason!, /DDL has no query plan/);
});

test('an empty statement is not an engine complaint', () => {
  assert.match(explainVerdict('   ', 'mysql').reason!, /the statement is empty/);
});

test('every refusal names the engine the user is connected to', () => {
  assert.match(explainVerdict('DROP TABLE t', 'mysql').reason!, /MySQL/);
  assert.match(explainVerdict('DROP TABLE t', 'postgres').reason!, /PostgreSQL/);
  assert.match(explainVerdict('DROP TABLE t', 'clickhouse').reason!, /ClickHouse/);
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('SQL Server explains the data statements', () => {
  for (const sql of [
    'SELECT 1', 'WITH c AS (SELECT 1) SELECT * FROM c',
    'INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t',
    'MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1;',
  ]) {
    assert.equal(explainVerdict(sql, 'sqlserver').ok, true, sql);
  }
});

test('SQL Server explains EXEC — no other engine can show a procedure\'s plan', () => {
  // Under SET SHOWPLAN_XML ON the server plans every statement INSIDE the
  // procedure and returns them all.
  assert.equal(explainVerdict('EXEC sales.usp_close_orders @d = 1', 'sqlserver').ok, true);
  assert.equal(explainVerdict('EXECUTE p', 'sqlserver').ok, true);
  // MySQL and PostgreSQL have no equivalent, so they still refuse.
  assert.equal(explainVerdict('EXEC p', 'mysql').ok, false);
});

test('SQL Server refuses DDL before the round trip, not after an empty diagram', () => {
  // SHOWPLAN mode technically ACCEPTS a CREATE TABLE and returns a document —
  // one with no operator tree in it, verified against 2022. Refusing here means
  // the user reads why.
  const v = explainVerdict('CREATE TABLE t (id int)', 'sqlserver');
  assert.equal(v.ok, false);
  assert.match(v.reason!, /SQL Server/);
  assert.match(v.reason!, /DDL has no query plan/);
  assert.equal(explainVerdict('ALTER TABLE t ADD c int', 'sqlserver').ok, false);
  assert.equal(explainVerdict('DROP TABLE t', 'sqlserver').ok, false);
});

test('the SQL Server refusal names the engine properly, not its identifier', () => {
  const v = explainVerdict('GRANT SELECT ON t TO u', 'sqlserver');
  assert.equal(v.ok, false);
  assert.match(v.reason!, /SQL Server/);
  assert.ok(!v.reason!.includes('sqlserver'));
});
