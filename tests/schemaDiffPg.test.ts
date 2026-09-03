/**
 * PostgreSQL schema comparison (src/utils/schemaDiff.ts).
 *
 * These cover the behaviours that were established against the live PG
 * 16/17/18 servers and that a refactor could quietly break: engine isolation,
 * the PG-18 NOT NULL catalog change, column-order handling, and the migration
 * dialect (ALTER COLUMN rather than MODIFY COLUMN, standalone index
 * statements, verbatim constraint text, dependent-view drop/recreate).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, generateMigration } from '../src/utils/schemaDiff.ts';
import type { Snapshot, TableInfo, ColumnInfo } from '../src/utils/schemaDiff.ts';

// ── Builders ──────────────────────────────────────────────────────────────

function col(over: Partial<ColumnInfo> = {}): ColumnInfo {
  return { pos: 1, type: 'text', nullable: 'YES', dflt: '', charset: '', collation: '', extra: '', ...over };
}

function table(over: Partial<TableInfo> = {}): TableInfo {
  return {
    engine: '', rowFormat: '', collation: '', comment: '', partitionBy: '',
    columns: new Map(), indexes: new Map(), indexDdl: new Map(),
    constraints: new Map(), constraintDdl: new Map(),
    ...over,
  };
}

function snap(schema: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    engine: 'postgres', schema, charset: 'UTF8', collation: 'en_US.UTF-8',
    tables: new Map(), views: new Map(), routines: new Map(), triggers: new Map(),
    events: new Map(), matviews: new Map(), sequences: new Map(), types: new Map(),
    viewDdl: new Map(), viewDeps: new Map(),
    ...over,
  };
}

const changed = (d: ReturnType<typeof diffSnapshots>) => d.filter(e => e.status !== 'same');
const noDdl = async () => { throw new Error('no ddl'); };

// ── Engine isolation ──────────────────────────────────────────────────────

test('PostgreSQL-only families never appear for a MySQL pair', () => {
  const l = snap('a', { engine: 'mysql' });
  const r = snap('b', { engine: 'mysql' });
  const kinds = new Set(diffSnapshots(l, r).map(e => e.kind));
  for (const k of ['matview', 'sequence', 'type']) {
    assert.ok(!kinds.has(k as never), `${k} must not appear for MySQL`);
  }
});

test('matviews, sequences and types are compared for PostgreSQL', () => {
  const l = snap('s', {
    matviews: new Map([['mv', 'select 1']]),
    sequences: new Map([['seq', 'as bigint start 1']]),
    types: new Map([['st', "ENUM('a','b')"]]),
  });
  const r = snap('s', {
    matviews: new Map([['mv', 'select 2']]),
    sequences: new Map([['seq', 'as bigint start 1']]),
    types: new Map([['st', "ENUM('a')"]]),
  });
  const d = diffSnapshots(l, r);
  assert.equal(d.find(e => e.kind === 'matview')?.status, 'different');
  assert.equal(d.find(e => e.kind === 'sequence')?.status, 'same');
  const ty = d.find(e => e.kind === 'type');
  assert.equal(ty?.status, 'different');
  assert.match(ty!.details[0], /ENUM/);
});

// ── Column semantics ──────────────────────────────────────────────────────

test('column ORDER is ignored on PostgreSQL but not on MySQL', () => {
  // PostgreSQL cannot reposition a column, so treating order as drift would
  // make a successfully migrated schema report differences forever.
  const mk = (engine: 'mysql' | 'postgres', pos: number) => snap('s', {
    engine,
    tables: new Map([['t', table({ columns: new Map([['a', col({ pos })]]) })]]),
  });
  assert.equal(changed(diffSnapshots(mk('postgres', 1), mk('postgres', 5))).length, 0);
  assert.equal(changed(diffSnapshots(mk('mysql', 1), mk('mysql', 5))).length, 1);
});

test('type, nullability and default differences are still caught', () => {
  const l = snap('s', { tables: new Map([['t', table({
    columns: new Map([['a', col({ type: 'text', nullable: 'NO', dflt: "'x'::text" })]]) })]]) });
  const r = snap('s', { tables: new Map([['t', table({
    columns: new Map([['a', col({ type: 'character varying(20)', nullable: 'YES', dflt: '' })]]) })]]) });
  const details = diffSnapshots(l, r).find(e => e.kind === 'table')!.details.join('\n');
  assert.match(details, /type text ↔ character varying\(20\)/);
  assert.match(details, /nullable NO ↔ YES/);
  assert.match(details, /default/);
});

test('partitioning is compared', () => {
  const l = snap('s', { tables: new Map([['t', table({ partitionBy: 'RANGE (at)' })]]) });
  const r = snap('s', { tables: new Map([['t', table({ partitionBy: '' })]]) });
  assert.match(diffSnapshots(l, r).find(e => e.kind === 'table')!.details[0], /partitioning RANGE \(at\) ↔ none/);
});

// ── Migration dialect ─────────────────────────────────────────────────────

test('PostgreSQL migration uses ALTER COLUMN, not MySQL MODIFY COLUMN', async () => {
  const l = snap('src', { tables: new Map([['t', table({
    columns: new Map([
      ['keep', col({ type: 'text', nullable: 'NO', dflt: "'d'::text" })],
      ['added', col({ pos: 2, type: 'integer' })],
    ]) })]]) });
  const r = snap('dst', { tables: new Map([['t', table({
    columns: new Map([
      ['keep', col({ type: 'character varying(9)', nullable: 'YES' })],
      ['gone', col({ pos: 2, type: 'integer' })],
    ]) })]]) });

  const sql = await generateMigration(diffSnapshots(l, r), l, r, noDdl);
  assert.match(sql, /ALTER TABLE "dst"\."t"/);
  assert.match(sql, /ALTER COLUMN "keep" TYPE text/);
  assert.match(sql, /ALTER COLUMN "keep" SET NOT NULL/);
  assert.match(sql, /ALTER COLUMN "keep" SET DEFAULT 'd'::text/);
  assert.match(sql, /ADD COLUMN "added" integer/);
  assert.match(sql, /DROP COLUMN "gone"/);
  assert.ok(!/MODIFY COLUMN/.test(sql), 'MODIFY COLUMN is MySQL syntax');
  assert.ok(!/`/.test(sql), 'backticks are MySQL quoting');
});

test('indexes become standalone statements retargeted at the destination schema', async () => {
  const l = snap('src', { tables: new Map([['t', table({
    indexes: new Map([['i_a', 'create index i_a on t using btree (a)']]),
    indexDdl: new Map([['i_a', 'CREATE INDEX i_a ON src.t USING btree (a)']]),
  })]]) });
  const r = snap('dst', { tables: new Map([['t', table({
    indexes: new Map([['i_old', 'create index i_old on t using btree (b)']]),
    indexDdl: new Map([['i_old', 'CREATE INDEX i_old ON dst.t USING btree (b)']]),
  })]]) });

  const sql = await generateMigration(diffSnapshots(l, r), l, r, noDdl);
  // Retargeted at dst, and emitted verbatim rather than as the lowercased
  // comparison form.
  assert.match(sql, /CREATE INDEX i_a ON dst\.t USING btree \(a\)/);
  // IF EXISTS: dropping a column cascades to its indexes, so the index may
  // already be gone by the time this runs.
  assert.match(sql, /DROP INDEX IF EXISTS "dst"\."i_old"/);
  assert.ok(!/ADD INDEX/.test(sql), 'ADD INDEX inside ALTER is MySQL syntax');
});

test('constraints are emitted verbatim, preserving quoted identifiers', async () => {
  // normalizeDdl lowercases for comparison; emitting that would rename a
  // quoted column inside a CHECK and produce invalid SQL.
  const def = 'CHECK ((("MixedCase" >= 0)))';
  const l = snap('src', { tables: new Map([['t', table({
    constraints: new Map([['c_pos', def.toLowerCase()]]),
    constraintDdl: new Map([['c_pos', def]]),
  })]]) });
  const r = snap('dst', { tables: new Map([['t', table()]]) });

  const sql = await generateMigration(diffSnapshots(l, r), l, r, noDdl);
  assert.match(sql, /ADD CONSTRAINT "c_pos" CHECK \(\(\("MixedCase" >= 0\)\)\)/);
});

test('dependent views are dropped before a type change and recreated after', async () => {
  // PostgreSQL: "cannot alter type of a column used by a view or rule".
  const l = snap('src', {
    tables: new Map([['t', table({ columns: new Map([['a', col({ type: 'text' })]]) })]]),
    views: new Map([['v', 'select a from t']]),
    viewDdl: new Map([['v', 'CREATE OR REPLACE VIEW "src"."v" AS SELECT a FROM src.t']]),
  });
  const r = snap('dst', {
    tables: new Map([['t', table({ columns: new Map([['a', col({ type: 'integer' })]]) })]]),
    views: new Map([['v', 'select a from t']]),
    viewDdl: new Map([['v', 'CREATE OR REPLACE VIEW "dst"."v" AS SELECT a FROM dst.t']]),
    viewDeps: new Map([['t', ['v']]]),
  });

  const sql = await generateMigration(diffSnapshots(l, r), l, r, noDdl);
  const drop = sql.indexOf('DROP VIEW IF EXISTS "dst"."v"');
  const alter = sql.indexOf('ALTER COLUMN "a" TYPE text');
  const recreate = sql.indexOf('CREATE OR REPLACE VIEW "dst"."v"');
  assert.ok(drop >= 0, 'dependent view must be dropped');
  assert.ok(recreate >= 0, 'dependent view must be recreated');
  assert.ok(drop < alter && alter < recreate, `order was drop=${drop} alter=${alter} recreate=${recreate}`);
  assert.ok(!/;;/.test(sql), 'no doubled semicolons');
});

test('a view is not recreated twice when its table already handled it', async () => {
  const l = snap('src', {
    tables: new Map([['t', table({ columns: new Map([['a', col({ type: 'text' })]]) })]]),
    views: new Map([['v', 'select a from t']]),
    viewDdl: new Map([['v', 'CREATE OR REPLACE VIEW "src"."v" AS SELECT a FROM src.t']]),
  });
  const r = snap('dst', {
    tables: new Map([['t', table({ columns: new Map([['a', col({ type: 'integer' })]]) })]]),
    views: new Map([['v', 'select DIFFERENT from t']]),
    viewDdl: new Map([['v', 'CREATE OR REPLACE VIEW "dst"."v" AS SELECT DIFFERENT FROM dst.t']]),
    viewDeps: new Map([['t', ['v']]]),
  });
  const sql = await generateMigration(diffSnapshots(l, r), l, r, noDdl);
  const hits = sql.split('CREATE OR REPLACE VIEW "dst"."v"').length - 1;
  assert.equal(hits, 1, 'view must be recreated exactly once');
  assert.match(sql, /already recreated above/);
});

test('a type change with no dependent views does not emit view churn', async () => {
  const l = snap('src', { tables: new Map([['t', table({ columns: new Map([['a', col({ type: 'text' })]]) })]]) });
  const r = snap('dst', { tables: new Map([['t', table({ columns: new Map([['a', col({ type: 'integer' })]]) })]]) });
  const sql = await generateMigration(diffSnapshots(l, r), l, r, noDdl);
  assert.ok(!/DROP VIEW/.test(sql));
});

test('objects only on the target are dropped; only on the source are created', async () => {
  const l = snap('src', { tables: new Map([['keep', table()], ['onlyleft', table()]]) });
  const r = snap('dst', { tables: new Map([['keep', table()], ['onlyright', table()]]) });
  const sql = await generateMigration(diffSnapshots(l, r), l, r, async () => 'CREATE TABLE src.onlyleft (id int)');
  assert.match(sql, /DROP TABLE "dst"\."onlyright";/);
  assert.match(sql, /CREATE TABLE src\.onlyleft/);
});

test('database encoding differences are reported but not "fixed"', async () => {
  // Encoding and collation are fixed at CREATE DATABASE time — a generated
  // ALTER would be a lie.
  const l = snap('s', { charset: 'UTF8', collation: 'en_US.UTF-8' });
  const r = snap('s', { charset: 'LATIN1', collation: 'C' });
  const d = diffSnapshots(l, r);
  assert.equal(d.find(e => e.kind === 'schema')?.status, 'different');
  const sql = await generateMigration(d, l, r, noDdl);
  assert.match(sql, /Not alterable in place/);
  assert.ok(!/ALTER DATABASE/.test(sql));
});
