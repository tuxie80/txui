/**
 * Static SQL lint (src/utils/sqlLint.ts) — reserved-word CREATE TABLE rule.
 * A column named after a reserved word "works" when quoted, but every query,
 * ORM and dump must remember the quotes forever — the lint says so up front.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSql } from '../src/utils/sqlLint.ts';
import type { Finding } from '../src/utils/sqlLint.ts';

const reserved = (f: Finding) => /reserved word/i.test(f.title);

test('bare reserved-word column is an orange finding', () => {
  const findings = lintSql('CREATE TABLE t (\n  id INT PRIMARY KEY,\n  order INT,\n  name VARCHAR(20)\n)').filter(reserved);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'orange');
  assert.match(findings[0].title, /order/);
  assert.match(findings[0].detail, /rename the column/i);
});

test('quoted reserved-word column still warns, softer', () => {
  for (const sql of [
    'CREATE TABLE t (`order` INT, `desc` VARCHAR(20))',
    'CREATE TABLE t ("order" INT)', // PostgreSQL-style quoting
  ]) {
    const findings = lintSql(sql).filter(reserved);
    assert.ok(findings.length >= 1, `expected a finding for: ${sql}`);
    assert.ok(findings.every(f => f.severity === 'yellow'));
  }
});

test('clean column names produce no reserved-word finding', () => {
  const findings = lintSql(
    'CREATE TABLE orders (\n  id INT UNSIGNED PRIMARY KEY,\n  order_status VARCHAR(20),\n  delivery_date DATE,\n  KEY idx_status (order_status)\n)').filter(reserved);
  assert.equal(findings.length, 0);
});

test('constraint lines are not mistaken for columns', () => {
  const findings = lintSql(
    'CREATE TABLE t (\n  id INT,\n  grp_id INT,\n  PRIMARY KEY (id),\n  UNIQUE KEY uq_grp (grp_id),\n  CONSTRAINT fk_grp FOREIGN KEY (grp_id) REFERENCES g (id),\n  KEY idx_grp (grp_id),\n  CHECK (id > 0)\n)').filter(reserved);
  assert.equal(findings.length, 0);
});

test('a column literally named after a constraint introducer is still a column', () => {
  // `key INT` is a column named `key` (reserved), not a KEY constraint line
  for (const sql of ['CREATE TABLE t (key INT, note TEXT)', 'CREATE TABLE t (unique INT)']) {
    const findings = lintSql(sql).filter(reserved);
    assert.ok(findings.length >= 1, `expected a finding for: ${sql}`);
  }
});

test('commas inside types do not split definitions', () => {
  const findings = lintSql(
    "CREATE TABLE t (\n  `values` DECIMAL(10,2),\n  mood ENUM('a','b'),\n  amount DECIMAL(12, 4)\n)").filter(reserved);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /values/);
});

test('CREATE TABLE … AS SELECT / LIKE have no column list to check', () => {
  assert.equal(lintSql('CREATE TABLE t2 AS SELECT `order`, max(total) FROM t1').filter(reserved).length, 0);
  assert.equal(lintSql('CREATE TABLE t2 LIKE t1').filter(reserved).length, 0);
});

test('several offending columns are each reported', () => {
  const findings = lintSql('CREATE TABLE t (key INT, `values` TEXT, rank INT, note TEXT)').filter(reserved);
  assert.equal(findings.length, 3);
});

// ── leading-wildcard LIKE: real predicates only, never comments/strings ──

const likeWildcard = (f: Finding) => /leading wildcard/i.test(f.title);

test('a real leading-wildcard LIKE is still flagged', () => {
  assert.equal(lintSql("SELECT a FROM t WHERE c LIKE '%foo'").filter(likeWildcard).length, 1);
  // …but a trailing-only wildcard is fine.
  assert.equal(lintSql("SELECT a FROM t WHERE c LIKE 'foo%'").filter(likeWildcard).length, 0);
});

test('LIKE-wildcard text inside a comment or string is not a predicate', () => {
  assert.equal(
    lintSql("SELECT a FROM t WHERE b = 1 -- LIKE '%foo' would scan").filter(likeWildcard).length, 0);
  assert.equal(
    lintSql("SELECT a FROM t /* LIKE '%foo' */ WHERE b = 1").filter(likeWildcard).length, 0);
  assert.equal(
    lintSql("SELECT 'a like ''%foo'' example' AS note FROM t WHERE b = 1").filter(likeWildcard).length, 0);
});

// ── GROUP BY determinism: the owning-SELECT lookup matches whole words ──

test('columns named selection/wherefrom do not confuse the owning-SELECT lookup', () => {
  // The bare-substring search found `select` inside `selection` and `from`
  // inside `wherefrom`, then flagged the fragments as non-aggregated columns.
  const findings = lintSql('SELECT selection, wherefrom FROM t GROUP BY selection, wherefrom')
    .filter(f => /Non-aggregated columns/i.test(f.title));
  assert.equal(findings.length, 0);
});
