/**
 * Review-only `SET GLOBAL` generation for MySQL/MariaDB server variables
 * (src/utils/serverVarEdit.ts). The two things that must hold: numbers stay bare
 * while everything else is a safely-escaped string literal, and every block
 * carries a persistence hint (SET GLOBAL reverts on restart).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNumericValue, formatVarValue, buildServerVarSql,
} from '../src/utils/serverVarEdit.ts';

test('isNumericValue: integers and decimals are bare, symbolics are not', () => {
  assert.equal(isNumericValue('500'), true);
  assert.equal(isNumericValue('-1'), true);
  assert.equal(isNumericValue('1.5'), true);
  assert.equal(isNumericValue(' 128 '), true);      // trimmed
  assert.equal(isNumericValue('ON'), false);
  assert.equal(isNumericValue(''), false);
  assert.equal(isNumericValue('1G'), false);        // 1G is not a SQL number literal
  assert.equal(isNumericValue('STRICT_TRANS_TABLES'), false);
});

test('formatVarValue: numbers bare, everything else a quoted literal', () => {
  assert.equal(formatVarValue('500'), '500');
  assert.equal(formatVarValue('ON'), "'ON'");
  assert.equal(formatVarValue(''), "''");
  assert.equal(formatVarValue('STRICT_TRANS_TABLES'), "'STRICT_TRANS_TABLES'");
});

test('formatVarValue: string escaping cannot break out of the literal', () => {
  // MySQL escapes backslash then quote — a crafted value stays inside the quotes.
  assert.equal(formatVarValue("a'b"), "'a''b'");
  assert.equal(formatVarValue('x\\y'), "'x\\\\y'");
});

test('buildServerVarSql: numeric value → SET GLOBAL, bare value', () => {
  const sql = buildServerVarSql('max_connections', '500');
  const first = sql.split('\n')[0];
  assert.equal(first, 'SET GLOBAL max_connections = 500;');
});

test('buildServerVarSql: string value → quoted literal', () => {
  const sql = buildServerVarSql('sql_mode', 'STRICT_TRANS_TABLES');
  assert.equal(sql.split('\n')[0], "SET GLOBAL sql_mode = 'STRICT_TRANS_TABLES';");
});

test('buildServerVarSql: always includes the [mysqld] persistence hint', () => {
  const sql = buildServerVarSql('max_connections', '500');
  assert.match(sql, /-- \[mysqld\]/);
  assert.match(sql, /^-- max_connections = 500$/m);
  assert.match(sql, /reverts on restart/);
  // Without persist there is no SET PERSIST line.
  assert.doesNotMatch(sql, /SET PERSIST/);
});

test('buildServerVarSql: persist option surfaces the MySQL 8.0+ SET PERSIST form', () => {
  const sql = buildServerVarSql('max_connections', '500', { persist: true });
  assert.match(sql, /^-- SET PERSIST max_connections = 500;$/m);
  // The primary statement is still the review-only SET GLOBAL.
  assert.equal(sql.split('\n')[0], 'SET GLOBAL max_connections = 500;');
  // And the [mysqld] fallback is still there.
  assert.match(sql, /-- \[mysqld\]/);
});

test('buildServerVarSql: odd variable names are safely quoted as identifiers', () => {
  // A name colliding with a reserved word gets backticked; plain names stay bare.
  assert.equal(buildServerVarSql('key', '1').split('\n')[0], 'SET GLOBAL `key` = 1;');
  assert.equal(buildServerVarSql('net_read_timeout', '30').split('\n')[0], 'SET GLOBAL net_read_timeout = 30;');
});
