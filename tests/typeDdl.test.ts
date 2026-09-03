/**
 * User-defined type DDL (src/utils/typeDdl.ts).
 *
 * PostgreSQL only. The failures that matter here are the same as the routine
 * editor's: an identifier or a literal inserted unquoted is broken SQL, and an
 * enum value silently "dropped" is a lie — Postgres cannot drop one, and the
 * editor must say so rather than emit a statement that does nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSql, dropSql, alterSql, alterEnumSql, listSql,
  readCompositeSql, readEnumSql, readDomainSql, stripCheck,
  worstRisk, toScript, typeSignature,
  type TypeDef,
} from '../src/utils/typeDdl.ts';

const composite = (over: Partial<TypeDef> = {}): TypeDef => ({
  schema: 'app', name: 'addr', kind: 'composite',
  attrs: [{ name: 'street', type: 'text' }, { name: 'zip', type: 'varchar(10)' }],
  ...over,
});
const enumDef = (over: Partial<TypeDef> = {}): TypeDef => ({
  schema: 'app', name: 'mood', kind: 'enum',
  values: ['sad', 'ok', 'happy'],
  ...over,
});
const domain = (over: Partial<TypeDef> = {}): TypeDef => ({
  schema: 'app', name: 'us_zip', kind: 'domain',
  baseType: 'text', notNull: true,
  checks: [{ expr: "VALUE ~ '^\\d{5}$'" }],
  ...over,
});

// ── composite ────────────────────────────────────────────────────────────────

describe('composite types', () => {
  test('CREATE TYPE AS (…) with each attribute quoted', () => {
    const sql = createSql(composite());
    assert.match(sql, /CREATE TYPE "app"\."addr" AS \(/);
    assert.match(sql, /"street" text/);
    assert.match(sql, /"zip" varchar\(10\)/);
  });

  test('a reserved-word attribute name is quoted', () => {
    // `order` bare is a syntax error; the quoter must catch it.
    const sql = createSql(composite({ attrs: [{ name: 'order', type: 'int' }] }));
    assert.match(sql, /"order" int/);
  });

  test('adding, dropping and retyping attributes each produce one ALTER', () => {
    const before = composite();
    const after = composite({
      attrs: [{ name: 'street', type: 'varchar(120)' }, { name: 'country', type: 'text' }],
    });
    const changes = alterSql(before, after);
    const sqls = changes.map(c => c.sql);
    assert.ok(sqls.some(s => /DROP ATTRIBUTE "zip"/.test(s)), 'zip removed');
    assert.ok(sqls.some(s => /ADD ATTRIBUTE "country" text/.test(s)), 'country added');
    assert.ok(sqls.some(s => /ALTER ATTRIBUTE "street" TYPE varchar\(120\)/.test(s)), 'street retyped');
    assert.equal(worstRisk(changes), 'destructive', 'a dropped attribute is destructive');
  });

  test('an unchanged composite generates no ALTER', () => {
    assert.deepEqual(alterSql(composite(), composite()), []);
  });
});

// ── enum ─────────────────────────────────────────────────────────────────────

describe('enum types', () => {
  test('CREATE TYPE AS ENUM with single-quoted values', () => {
    const sql = createSql(enumDef());
    assert.match(sql, /CREATE TYPE "app"\."mood" AS ENUM \('sad', 'ok', 'happy'\)/);
  });

  test("a value with an apostrophe is escaped, not left to break the literal", () => {
    const sql = createSql(enumDef({ values: ["it's fine"] }));
    assert.match(sql, /'it''s fine'/);
  });

  test('a newly appended value becomes ADD VALUE', () => {
    const changes = alterEnumSql(enumDef(), enumDef({ values: ['sad', 'ok', 'happy', 'elated'] }));
    assert.equal(changes.length, 1);
    assert.match(changes[0].sql, /ALTER TYPE "app"\."mood" ADD VALUE 'elated'/);
    assert.match(changes[0].warning ?? '', /transaction block before/i);
  });

  test('an in-place edit becomes RENAME VALUE, not drop-and-add', () => {
    const changes = alterEnumSql(enumDef(), enumDef({ values: ['sad', 'fine', 'happy'] }));
    assert.equal(changes.length, 1);
    assert.match(changes[0].sql, /RENAME VALUE 'ok' TO 'fine'/);
  });

  test('removing a value is refused with a comment, never an executable DROP', () => {
    const changes = alterEnumSql(enumDef(), enumDef({ values: ['sad', 'happy'] }));
    // No statement pretends to drop it; the one change is a comment marker.
    assert.ok(changes.every(c => !/DROP VALUE/i.test(c.sql)), 'there is no DROP VALUE');
    const note = changes.find(c => c.risk === 'destructive');
    assert.ok(note, 'the impossible removal is surfaced');
    assert.match(note!.sql, /^--/, 'it is a comment, not a statement');
    assert.match(note!.warning ?? '', /no ALTER TYPE … DROP VALUE|cannot drop/i);
  });

  test('toScript keeps the impossible-drop marker as a comment', () => {
    const script = toScript(alterEnumSql(enumDef(), enumDef({ values: ['sad', 'happy'] })));
    assert.match(script, /^-- PostgreSQL cannot drop enum value/m);
    assert.doesNotMatch(script, /^-- PostgreSQL cannot drop enum value.*;$/m, 'no trailing semicolon on the comment');
  });
});

// ── domain ───────────────────────────────────────────────────────────────────

describe('domain types', () => {
  test('CREATE DOMAIN AS base with DEFAULT, NOT NULL and CHECK', () => {
    const sql = createSql(domain({ default: "'00000'" }));
    assert.match(sql, /CREATE DOMAIN "app"\."us_zip" AS text/);
    assert.match(sql, /DEFAULT '00000'/);
    assert.match(sql, /NOT NULL/);
    assert.match(sql, /CHECK \(VALUE ~ '\^\\d\{5\}\$'\)/);
  });

  test('flipping NOT NULL on is lossy and off is safe', () => {
    const on = alterSql(domain({ notNull: false }), domain({ notNull: true }));
    assert.match(on[0].sql, /SET NOT NULL/);
    assert.equal(on[0].risk, 'lossy');
    const off = alterSql(domain({ notNull: true }), domain({ notNull: false }));
    assert.match(off[0].sql, /DROP NOT NULL/);
    assert.equal(off[0].risk, 'safe');
  });

  test('changing the default emits SET or DROP DEFAULT', () => {
    const set = alterSql(domain({ default: '' }), domain({ default: "'x'" }));
    assert.match(set[0].sql, /SET DEFAULT 'x'/);
    const drop = alterSql(domain({ default: "'x'" }), domain({ default: '' }));
    assert.match(drop[0].sql, /DROP DEFAULT/);
  });

  test('a new CHECK is added by name, a removed one dropped by name', () => {
    const before = domain({ checks: [{ name: 'us_zip_check', expr: 'length(VALUE) = 5' }] });
    const after = domain({ checks: [{ expr: "VALUE <> ''" }] });
    const changes = alterSql(before, after);
    assert.ok(changes.some(c => /DROP CONSTRAINT "us_zip_check"/.test(c.sql)));
    assert.ok(changes.some(c => /ADD CONSTRAINT "us_zip_check" CHECK \(VALUE <> ''\)/.test(c.sql)));
  });

  test('DROP DOMAIN uses the DOMAIN keyword, DROP TYPE the TYPE keyword', () => {
    assert.match(dropSql(domain()), /^DROP DOMAIN "app"\."us_zip"$/);
    assert.match(dropSql(composite()), /^DROP TYPE "app"\."addr"$/);
    assert.match(dropSql(enumDef(), true), /^DROP TYPE "app"\."mood" CASCADE$/);
  });
});

// ── reads and helpers ─────────────────────────────────────────────────────────

describe('reads and helpers', () => {
  test('the list query narrows composites to standalone ones and tags each kind', () => {
    const sql = listSql('public');
    assert.match(sql, /n\.nspname = 'public'/);
    assert.match(sql, /'enum'/);
    assert.match(sql, /'domain'/);
    assert.match(sql, /relkind = 'c'/, 'table row types are excluded');
  });

  test('read queries filter by both schema and name', () => {
    for (const sql of [
      readCompositeSql('app', 'addr'),
      readEnumSql('app', 'mood'),
      readDomainSql('app', 'us_zip'),
    ]) {
      assert.match(sql, /'app'/);
    }
  });

  test('stripCheck unwraps CHECK ((expr)) to the bare expression', () => {
    assert.equal(stripCheck('CHECK ((VALUE > 0))'), '(VALUE > 0)');
    assert.equal(stripCheck('CHECK (length(x) = 5)'), 'length(x) = 5');
    assert.equal(stripCheck('VALUE > 0'), 'VALUE > 0', 'already bare is left alone');
  });

  test('signatures read like a developer would write them', () => {
    assert.equal(typeSignature(composite()), 'addr (street, zip)');
    assert.equal(typeSignature(enumDef()), 'mood {sad, ok, happy}');
    assert.equal(typeSignature(domain()), 'us_zip AS text');
  });
});
