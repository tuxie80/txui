import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSchemaSql,
  dropSchemaSql,
  createDatabaseSql,
  dropDatabaseSql,
} from '../src/utils/schemaObjSql.ts';

// ── CREATE SCHEMA ─────────────────────────────────────────────────────────────

test('createSchemaSql: PostgreSQL, idempotent, double-quoted', () => {
  assert.equal(createSchemaSql({ engine: 'postgres', name: 'reporting' }),
    'CREATE SCHEMA IF NOT EXISTS "reporting";');
});

test('createSchemaSql: PostgreSQL AUTHORIZATION owner is quoted', () => {
  assert.equal(createSchemaSql({ engine: 'postgres', name: 'reporting', owner: 'app_user' }),
    'CREATE SCHEMA IF NOT EXISTS "reporting" AUTHORIZATION "app_user";');
});

test('createSchemaSql: a mixed-case name is quoted so it does not fold on PG', () => {
  assert.equal(createSchemaSql({ engine: 'postgres', name: 'Reporting' }),
    'CREATE SCHEMA IF NOT EXISTS "Reporting";');
});

test('createSchemaSql: MySQL uses back-ticks and ignores an owner', () => {
  assert.equal(createSchemaSql({ engine: 'mysql', name: 'shop', owner: 'root' }),
    'CREATE SCHEMA IF NOT EXISTS `shop`;');
});

test('createSchemaSql: blank owner adds no AUTHORIZATION clause', () => {
  assert.equal(createSchemaSql({ engine: 'postgres', name: 'reporting', owner: '   ' }),
    'CREATE SCHEMA IF NOT EXISTS "reporting";');
});

// ── DROP SCHEMA ───────────────────────────────────────────────────────────────

test('dropSchemaSql: plain (RESTRICT) by default', () => {
  assert.equal(dropSchemaSql({ engine: 'postgres', name: 'reporting' }),
    'DROP SCHEMA "reporting";');
});

test('dropSchemaSql: CASCADE on PostgreSQL when requested', () => {
  assert.equal(dropSchemaSql({ engine: 'postgres', name: 'reporting', cascade: true }),
    'DROP SCHEMA "reporting" CASCADE;');
});

test('dropSchemaSql: MySQL never emits CASCADE even if asked', () => {
  assert.equal(dropSchemaSql({ engine: 'mysql', name: 'shop', cascade: true }),
    'DROP SCHEMA `shop`;');
});

test('dropSchemaSql: a reserved word as a name is quoted', () => {
  assert.equal(dropSchemaSql({ engine: 'postgres', name: 'order' }),
    'DROP SCHEMA "order";');
});

// ── CREATE DATABASE ───────────────────────────────────────────────────────────

test('createDatabaseSql: MySQL, idempotent', () => {
  assert.equal(createDatabaseSql({ engine: 'mysql', name: 'shop' }),
    'CREATE DATABASE IF NOT EXISTS `shop`;');
});

test('createDatabaseSql: MySQL CHARACTER SET and COLLATE', () => {
  assert.equal(
    createDatabaseSql({ engine: 'mysql', name: 'shop', charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }),
    'CREATE DATABASE IF NOT EXISTS `shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');
});

test('createDatabaseSql: MySQL charset only', () => {
  assert.equal(createDatabaseSql({ engine: 'mysql', name: 'shop', charset: 'utf8mb4' }),
    'CREATE DATABASE IF NOT EXISTS `shop` CHARACTER SET utf8mb4;');
});

test('createDatabaseSql: an unsafe charset token is dropped, not injected', () => {
  assert.equal(
    createDatabaseSql({ engine: 'mysql', name: 'shop', charset: 'utf8; DROP TABLE t' }),
    'CREATE DATABASE IF NOT EXISTS `shop`;');
});

test('createDatabaseSql: PostgreSQL has no IF NOT EXISTS and takes an OWNER', () => {
  assert.equal(createDatabaseSql({ engine: 'postgres', name: 'analytics', owner: 'app_user' }),
    'CREATE DATABASE "analytics" OWNER "app_user";');
});

test('createDatabaseSql: PostgreSQL plain when no owner', () => {
  assert.equal(createDatabaseSql({ engine: 'postgres', name: 'analytics' }),
    'CREATE DATABASE "analytics";');
});

test('createDatabaseSql: PostgreSQL ignores MySQL charset/collate', () => {
  assert.equal(
    createDatabaseSql({ engine: 'postgres', name: 'analytics', charset: 'utf8mb4', collate: 'x' }),
    'CREATE DATABASE "analytics";');
});

// ── DROP DATABASE ─────────────────────────────────────────────────────────────

test('dropDatabaseSql: MySQL back-ticked', () => {
  assert.equal(dropDatabaseSql({ engine: 'mysql', name: 'shop' }),
    'DROP DATABASE `shop`;');
});

test('dropDatabaseSql: PostgreSQL double-quoted', () => {
  assert.equal(dropDatabaseSql({ engine: 'postgres', name: 'analytics' }),
    'DROP DATABASE "analytics";');
});

test('dropDatabaseSql: an embedded quote cannot break out of the identifier', () => {
  assert.equal(dropDatabaseSql({ engine: 'postgres', name: 'a"b' }),
    'DROP DATABASE "a""b";');
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// Every statement below was executed against SQL Server 2022 — twice, to prove
// the idempotence each one claims.

test('SQL Server has no IF NOT EXISTS, so idempotence is an existence test', () => {
  // `CREATE DATABASE IF NOT EXISTS` is Msg 156, "Incorrect syntax near the
  // keyword 'IF'" — the MySQL form was a syntax error, not a portable one.
  const sql = createDatabaseSql({ engine: 'sqlserver', name: 'zz_db' });
  assert.equal(sql, "IF DB_ID('zz_db') IS NULL CREATE DATABASE [zz_db];");
  assert.ok(!sql.includes('IF NOT EXISTS'));
});

test('CREATE SCHEMA is wrapped in EXEC, because it must lead its batch', () => {
  // Msg 111: "'CREATE SCHEMA' must be the first statement in a query batch."
  // So it cannot simply follow an IF — the IF has to execute it as a string.
  const sql = createSchemaSql({ engine: 'sqlserver', name: 'zz_sch', owner: 'dbo' });
  assert.equal(sql,
    "IF SCHEMA_ID('zz_sch') IS NULL EXEC('CREATE SCHEMA [zz_sch] AUTHORIZATION [dbo]');");
});

test('the inner CREATE SCHEMA is quoted twice, and both rules apply', () => {
  // The identifier brackets `]` doubles; the surrounding string literal `'`
  // doubles. Getting one of the two right is not enough.
  const sql = createSchemaSql({ engine: 'sqlserver', name: "we]ird'x" });
  assert.equal(sql, "IF SCHEMA_ID('we]ird''x') IS NULL EXEC('CREATE SCHEMA [we]]ird''x]');");
});

test('SQL Server has IF EXISTS on the DROP side even though it has none on CREATE', () => {
  assert.equal(dropSchemaSql({ engine: 'sqlserver', name: 'zz_sch' }),
    'DROP SCHEMA IF EXISTS [zz_sch];');
  assert.equal(dropDatabaseSql({ engine: 'sqlserver', name: 'zz_db' }),
    'DROP DATABASE IF EXISTS [zz_db];');
});

test('CASCADE is never emitted for SQL Server — it has none', () => {
  // A schema still holding objects is refused, which is the safe default the
  // other engines get from RESTRICT.
  const sql = dropSchemaSql({ engine: 'sqlserver', name: 's', cascade: true });
  assert.ok(!sql.includes('CASCADE'), sql);
});

test('a database takes a COLLATION, not a character set', () => {
  const sql = createDatabaseSql({
    engine: 'sqlserver', name: 'zz_db',
    charset: 'utf8mb4', collate: 'Latin1_General_CI_AS',
  });
  // The code page rides with the collation there; CHARACTER SET is MySQL's.
  assert.match(sql, /COLLATE Latin1_General_CI_AS;$/);
  assert.ok(!sql.includes('CHARACTER SET'), sql);
  // …and a collation that is not a bare token is dropped rather than injected.
  assert.ok(!createDatabaseSql({
    engine: 'sqlserver', name: 'd', collate: "x'; DROP DATABASE y--",
  }).includes('DROP DATABASE y'));
});

test('the other engines are untouched by the SQL Server branch', () => {
  assert.match(createDatabaseSql({ engine: 'mysql', name: 'd' }), /IF NOT EXISTS/);
  assert.match(createSchemaSql({ engine: 'postgres', name: 's' }), /^CREATE SCHEMA IF NOT EXISTS/);
  assert.match(dropSchemaSql({ engine: 'postgres', name: 's', cascade: true }), /CASCADE/);
});
