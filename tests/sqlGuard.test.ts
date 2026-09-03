/**
 * Prod hard-limit guards (src/utils/sqlGuard.ts): isDangerousDdl must mirror
 * is_dangerous_ddl in src-tauri/src/sqlguard.rs exactly — blanked SQL,
 * per-`;`-statement first word ∈ drop/truncate/alter/rename/grant/revoke —
 * and isUnfilteredWrite stays in parity with the Rust port for the
 * single-statement cases the server enforces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDangerousDdl, isDmlStatement, isReadFamilyStatement, isUnfilteredWrite, isWriteStatement } from '../src/utils/sqlGuard.ts';

test('each destructive keyword is caught', () => {
  assert.ok(isDangerousDdl('DROP TABLE t'));
  assert.ok(isDangerousDdl('truncate t'));
  assert.ok(isDangerousDdl('ALTER TABLE t ADD COLUMN c INT'));
  assert.ok(isDangerousDdl('RENAME TABLE a TO b'));
  assert.ok(isDangerousDdl("GRANT ALL ON *.* TO 'u'@'%'"));
  assert.ok(isDangerousDdl("REVOKE ALL ON db.* FROM 'u'@'%'"));
});

test('a later statement in a script is caught', () => {
  assert.ok(isDangerousDdl('select 1; drop table t'));
  assert.ok(isDangerousDdl('SELECT 1;\n  GRANT SELECT ON db.* TO u'));
});

test('leading comments do not hide the keyword', () => {
  assert.ok(isDangerousDdl('/* x */ DROP TABLE t'));
  assert.ok(isDangerousDdl('-- note\nTRUNCATE t'));
});

test('lookalikes in strings and comments are ignored', () => {
  assert.ok(!isDangerousDdl("SELECT 'drop table t'"));
  assert.ok(!isDangerousDdl('-- drop table t\nSELECT 1'));
  assert.ok(!isDangerousDdl('/* alter table t */ SELECT 1'));
  assert.ok(!isDangerousDdl('SELECT `grant` FROM t'));
});

test('prefix lookalikes and non-destructive statements pass', () => {
  assert.ok(!isDangerousDdl('SELECT * FROM t'));
  assert.ok(!isDangerousDdl('SELECT dropper FROM t'));
  assert.ok(!isDangerousDdl('CREATE TABLE t (id INT)'));
  assert.ok(!isDangerousDdl('CREATE OR REPLACE VIEW v AS SELECT 1'));
  assert.ok(!isDangerousDdl('INSERT INTO t VALUES (1)'));
  assert.ok(!isDangerousDdl('UPDATE t SET a=1 WHERE id=2'));
});

test('DROP inside a procedure body is not flagged at statement level', () => {
  // One statement: first word is CREATE — the body is not inspected.
  assert.ok(!isDangerousDdl('CREATE PROCEDURE p() BEGIN DROP INDEX i ON t; END'));
  // …but a bare DROP after a real separator IS a statement of its own.
  assert.ok(isDangerousDdl('CREATE PROCEDURE p() BEGIN SELECT 1; DROP TABLE t; END'));
});

test('unfiltered-write parity with the server guard', () => {
  assert.ok(isUnfilteredWrite('UPDATE t SET a=1'));
  assert.ok(isUnfilteredWrite('DELETE FROM t'));
  assert.ok(isUnfilteredWrite('delete from t;'));
  assert.ok(isUnfilteredWrite('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'));
  assert.ok(isUnfilteredWrite("UPDATE t SET note='where was I'")); // where in a string doesn't count
  assert.ok(!isUnfilteredWrite('UPDATE t SET a=1 WHERE id=2'));
  assert.ok(!isUnfilteredWrite('DELETE FROM t WHERE id IN (SELECT id FROM s)'));
  assert.ok(!isUnfilteredWrite('SELECT * FROM t'));
  assert.ok(!isUnfilteredWrite('INSERT INTO t VALUES (1)'));
  assert.ok(!isUnfilteredWrite('SELECT somewhere FROM t'));
});

test('isDmlStatement: row-modifying DML only, no DDL/DCL/admin', () => {
  assert.ok(isDmlStatement('UPDATE t SET a=1'));
  assert.ok(isDmlStatement('DELETE FROM t WHERE id=1'));
  assert.ok(isDmlStatement('INSERT INTO t VALUES (1)'));
  assert.ok(isDmlStatement('replace into t values (1)'));
  assert.ok(isDmlStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'));
  assert.ok(!isDmlStatement('CREATE TABLE t (id INT)'));
  assert.ok(!isDmlStatement('DROP TABLE t'));
  assert.ok(!isDmlStatement('SET GLOBAL super_read_only=OFF'));
  assert.ok(!isDmlStatement('GRANT ALL ON *.* TO u'));
  assert.ok(!isDmlStatement('SELECT * FROM t'));
});

test('isReadFamilyStatement: read-family keywords, writes excluded', () => {
  assert.ok(isReadFamilyStatement('SELECT 1'));
  assert.ok(isReadFamilyStatement('  -- c\n select 1'));
  assert.ok(isReadFamilyStatement('WITH x AS (SELECT 1) SELECT * FROM x'));
  assert.ok(isReadFamilyStatement('SHOW WARNINGS'));
  assert.ok(isReadFamilyStatement('DESCRIBE t'));
  assert.ok(isReadFamilyStatement('EXPLAIN SELECT 1'));
  assert.ok(!isReadFamilyStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'));
  assert.ok(!isReadFamilyStatement('EXPLAIN ANALYZE DELETE FROM t'));
  assert.ok(!isReadFamilyStatement('SET GLOBAL super_read_only=OFF'));
  assert.ok(!isReadFamilyStatement('UPDATE t SET a=1'));
});

// ── PostgreSQL parity (mirrors sqlguard::pg_tests in Rust) ────────────────
// These statements all change server state but were previously classified as
// reads, so a read-only PostgreSQL connection accepted them.

test('isWriteStatement: COPY direction decides', () => {
  assert.ok(isWriteStatement("COPY t FROM '/tmp/x.csv' WITH (FORMAT csv)"));
  assert.ok(isWriteStatement('COPY t (a,b) FROM STDIN'));
  assert.ok(!isWriteStatement("COPY t TO '/tmp/x.csv' WITH (FORMAT csv)"));
  // the FROM here lives inside the subquery — must not read as a load
  assert.ok(!isWriteStatement('COPY (SELECT * FROM t) TO STDOUT'));
});

test('isWriteStatement: anonymous DO block and PREPARE payload', () => {
  assert.ok(isWriteStatement('DO $$ BEGIN DELETE FROM t; END $$'));
  assert.ok(isWriteStatement('PREPARE w AS INSERT INTO t VALUES (1)'));
  assert.ok(!isWriteStatement('PREPARE r AS SELECT * FROM t WHERE id = $1'));
  assert.ok(isWriteStatement('EXECUTE w(1)'));
});

test('isWriteStatement: SELECT INTO creates a table', () => {
  assert.ok(isWriteStatement('SELECT * INTO backup FROM orders'));
  assert.ok(!isWriteStatement('SELECT * FROM orders'));
});

test('isWriteStatement: storage and catalog commands', () => {
  assert.ok(isWriteStatement('VACUUM FULL orders'));
  assert.ok(isWriteStatement('CLUSTER orders USING idx'));
  assert.ok(isWriteStatement('REINDEX TABLE orders'));
  assert.ok(isWriteStatement('REFRESH MATERIALIZED VIEW mv'));
  assert.ok(isWriteStatement("COMMENT ON TABLE t IS 'x'"));
  assert.ok(isWriteStatement('LOCK TABLE t IN ACCESS EXCLUSIVE MODE'));
});

test('isWriteStatement: EXPLAIN ANALYZE is still a read', () => {
  assert.ok(!isWriteStatement('EXPLAIN ANALYZE SELECT * FROM t'));
  assert.ok(!isWriteStatement('EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t'));
  assert.ok(isWriteStatement('EXPLAIN ANALYZE DELETE FROM t'));
});

test('isDangerousDdl: heavy-lock maintenance blocked on prod, online variants allowed', () => {
  assert.ok(isDangerousDdl('VACUUM FULL orders'));
  assert.ok(!isDangerousDdl('VACUUM orders'));
  assert.ok(!isDangerousDdl('ANALYZE orders'));
  assert.ok(isDangerousDdl('CLUSTER orders USING idx'));
  assert.ok(isDangerousDdl('REINDEX TABLE orders'));
  assert.ok(!isDangerousDdl('REINDEX INDEX CONCURRENTLY idx'));
  assert.ok(isDangerousDdl('REFRESH MATERIALIZED VIEW mv'));
  assert.ok(!isDangerousDdl('REFRESH MATERIALIZED VIEW CONCURRENTLY mv'));
  assert.ok(!isDangerousDdl('COPY t TO STDOUT'));
});

// ── SQL Server (T-SQL) parity (mirrors sqlguard::tsql_tests in Rust) ───────
// MERGE / TRUNCATE TABLE / DROP TABLE ride the engine-agnostic keywords;
// BULK INSERT is the one new write verb, and `SELECT … INTO t` — T-SQL's
// table-creating SELECT — is the existing select+into rule.

test('isWriteStatement: T-SQL writes are caught', () => {
  assert.ok(isWriteStatement('MERGE INTO target USING src ON target.id = src.id WHEN MATCHED THEN UPDATE SET v = src.v'));
  assert.ok(isWriteStatement('TRUNCATE TABLE t'));
  assert.ok(isWriteStatement("BULK INSERT t FROM 'C:\\data\\rows.csv' WITH (FIELDTERMINATOR = ',')"));
  assert.ok(isWriteStatement('DROP TABLE t'));
  // pre-2016 has no IF EXISTS — detection is the same either way
  assert.ok(isWriteStatement('DROP TABLE IF EXISTS t'));
});

test('isWriteStatement: SELECT INTO is a write in T-SQL, temp tables included', () => {
  assert.ok(isWriteStatement('SELECT * INTO backup FROM orders'));
  assert.ok(isWriteStatement('SELECT id INTO #tmp FROM t'));
  assert.ok(!isWriteStatement('SELECT * FROM orders'));
  assert.ok(!isWriteStatement('SELECT id, name FROM t WHERE id IN (1,2)'));
});

test('isWriteStatement: T-SQL reads stay reads', () => {
  assert.ok(!isWriteStatement('SELECT TOP 10 * FROM t'));
  assert.ok(!isWriteStatement('SELECT * FROM t CROSS APPLY (SELECT 1) x'));
  assert.ok(!isWriteStatement('SELECT * FROM t WITH (NOLOCK)'));
  assert.ok(!isWriteStatement("DBCC SHOW_STATISTICS('t', 'i')")); // read-only DBCC
});

test('isWriteStatement: a bracketed [into] identifier is a known, safe false positive', () => {
  // blank() does not strip […] quoting; blocking a read is the safe direction
  // (documented in sqlguard.rs's tsql_tests).
  assert.ok(isWriteStatement('SELECT * FROM [into]'));
});

test('T-SQL prod hard limits and DML classification', () => {
  assert.ok(isDangerousDdl('DROP TABLE t'));
  assert.ok(isDangerousDdl('TRUNCATE TABLE t'));
  assert.ok(isDangerousDdl('ALTER TABLE t ADD c int'));
  assert.ok(!isDangerousDdl('MERGE INTO t USING s ON 1=0 WHEN NOT MATCHED THEN INSERT VALUES (1)'));
  assert.ok(isUnfilteredWrite('UPDATE t SET v = 1'));
  assert.ok(!isUnfilteredWrite('UPDATE t SET v = 1 WHERE id = 2'));
  // BULK INSERT loads rows — DML for the "N rows affected" log line.
  assert.ok(isDmlStatement("BULK INSERT t FROM 'x.csv'"));
});

// ── WP-01 guard-hardening regressions (2026-08 review) — each case asserts a
// bypass is blocked AND its legitimate neighbor still passes; mirrors
// sqlguard::guard_bypass_tests in Rust.

test('versioned comments cannot smuggle writes', () => {
  assert.ok(isWriteStatement('/*!50000 DELETE FROM t*/'));
  assert.ok(isUnfilteredWrite('/*!50000 DELETE FROM t*/'));
  assert.ok(isWriteStatement('/*! DROP TABLE x */'));
  assert.ok(isDangerousDdl('/*! DROP TABLE x */'));
  // legitimate neighbors: plain comments stay comments, hints stay reads
  assert.ok(!isWriteStatement('SELECT 1 /* comment */'));
  assert.ok(!isWriteStatement('/* delete from t */ SELECT 1'));
  assert.ok(!isWriteStatement('SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1'));
  assert.ok(!isWriteStatement('SELECT /*!40001 SQL_NO_CACHE */ * FROM t'));
});

test('statement-leading admin verbs are writes', () => {
  assert.ok(isWriteStatement('SHUTDOWN'));
  assert.ok(isWriteStatement('PURGE BINARY LOGS BEFORE NOW()'));
  assert.ok(isWriteStatement("CHANGE REPLICATION SOURCE TO SOURCE_HOST='h'"));
  assert.ok(isWriteStatement('STOP REPLICA'));
  assert.ok(isWriteStatement('START REPLICA'));
  assert.ok(isWriteStatement("INSTALL PLUGIN x SONAME 'x.so'"));
  assert.ok(isWriteStatement('UNINSTALL PLUGIN x'));
  assert.ok(isWriteStatement('SET PERSIST max_connections = 1'));
  assert.ok(isWriteStatement('SET PERSIST_ONLY max_connections = 1'));
  // legitimate neighbors keep their classification
  assert.ok(!isWriteStatement('START TRANSACTION'));
  assert.ok(!isWriteStatement('START TRANSACTION READ ONLY'));
  assert.ok(!isWriteStatement('SET SESSION x = 1'));
  assert.ok(isWriteStatement('SET GLOBAL max_connections = 1'));
  assert.ok(!isWriteStatement('SELECT shutdown FROM t'));   // column, not verb
});

test('WHERE must sit at the write verb\'s own paren depth', () => {
  assert.ok(isUnfilteredWrite('WITH x AS (SELECT 1 WHERE true) DELETE FROM t'));
  assert.ok(!isUnfilteredWrite('WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)'));
  assert.ok(!isUnfilteredWrite('DELETE FROM t USING u WHERE t.id=u.id'));
  assert.ok(!isUnfilteredWrite('DELETE FROM t WHERE EXISTS(SELECT 1)'));
  // a subquery WHERE does not excuse the outer write either
  assert.ok(isUnfilteredWrite('UPDATE t SET a=(SELECT max(x) FROM s WHERE s.id=1)'));
  // a data-modifying CTE is judged by the WHERE inside its own parens
  assert.ok(isUnfilteredWrite('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'));
  assert.ok(!isUnfilteredWrite('WITH d AS (DELETE FROM t WHERE id=1 RETURNING *) SELECT * FROM d'));
});

test('T-SQL EXEC runs an invisible body — a write', () => {
  assert.ok(isWriteStatement("EXEC('DELETE FROM t')"));
  assert.ok(isWriteStatement("EXEC sp_executesql N'DROP TABLE t'"));
  assert.ok(!isWriteStatement('SELECT exec_count FROM stats'));
});
