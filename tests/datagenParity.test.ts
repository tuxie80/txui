/**
 * Cross-path parity for the data generator — Phase 0/1 of
 * docs/plans/plan-datagen-nextgen.md.
 *
 * The generator has three execution paths: the pure-TS engine
 * (`generateRows` — preview/library), the Rust row-by-row writer
 * (`gen_row` in src-tauri/src/commands/datagen.rs) and the server-side
 * INSERT…SELECT planner (datagenSql.ts). Phase 0 fixed the three ways they
 * disagreed: the Rust sequence ignored `step`, the TS engine dropped the
 * `unique` flag entirely, and the server path ignored `unique` silently.
 *
 * The vectors below are pinned IDENTICALLY in datagen.rs's test module
 * (marked "pinned in tests/datagenParity.test.ts" there) — if either engine
 * drifts, one side fails. The scramble constants are extracted from the Rust
 * source and compared, the same drift-guard pattern as
 * tests/sqlGuardDrift.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PARAMS, generateRows, SCRAMBLE_A_START, SCRAMBLE_M_CAP,
} from '../src/utils/datagen.ts';
import type { ColumnSpec } from '../src/utils/datagen.ts';
import { buildServerPlan, valueSql } from '../src/utils/datagenSql.ts';

const P = (over: Partial<ColumnSpec['params']> = {}) => ({ ...DEFAULT_PARAMS, ...over });
const col = (
  name: string, typeName: string, generator: string,
  params = P(), unique = false,
): ColumnSpec => ({ name, typeName, generator, params, unique });

// ── seeded vectors, pinned on both tiers ────────────────────────────────────

test('sequence honours step — Rust was contiguous, TS was stepped (BUG 1)', () => {
  const rows = generateRows([col('id', 'BIGINT', 'sequence', P({ step: 5 }))], 4, 1);
  assert.deepEqual(rows.map(r => r[0]), [1, 6, 11, 16]);
});

test('unique ints are the scrambled row index — pinned against Rust (BUG 2)', () => {
  // min 10, max 29 → m = 20; a = 2097151 (coprime), b = 42 mod 20 = 2.
  const spec = col('n', 'INT', 'int', P({ min: 10, max: 29 }), true);
  const rows = generateRows([spec], 10, 42);
  assert.deepEqual(rows.map(r => r[0]), [12, 23, 14, 25, 16, 27, 18, 29, 20, 11]);
  // The whole range exactly once: uniqueness by construction, not by retry.
  const all = generateRows([spec], 20, 42).map(r => r[0] as number);
  assert.equal(new Set(all).size, 20);
  assert.ok(all.every(v => v >= 10 && v <= 29));
});

test('a continuation offset shifts the same permutation — pinned against Rust', () => {
  // Same spec and seed with the existing-row offset 5 (i_eff = i + 5);
  // the Rust twin is unique_offset_continues_the_permutation_pinned.
  const spec = col('n', 'INT', 'int', P({ min: 10, max: 29 }), true);
  const rows = generateRows([spec], 10, 42, 'default', 5);
  assert.deepEqual(rows.map(r => r[0]), [27, 18, 29, 20, 11, 22, 13, 24, 15, 26]);
});

test('unique decimals land on the 2-decimal grid — pinned against Rust', () => {
  const spec = col('d', 'DECIMAL(10,2)', 'decimal', P({ min: 1, max: 2 }), true);
  const rows = generateRows([spec], 6, 42);
  assert.deepEqual(rows.map(r => r[0]), [1.42, 1.29, 1.16, 1.03, 1.91, 1.78]);
});

test('unique strings get a zero-padded tag — pinned against Rust (BUG 2)', () => {
  // total 15 → width 2. The single-item choice draws once per row either way.
  const spec = col('c', 'VARCHAR(20)', 'choice', P({ list: 'ABC' }), true);
  const rows = generateRows([spec], 15, 42);
  assert.deepEqual(rows.slice(0, 3).map(r => r[0]), ['ABC_00', 'ABC_01', 'ABC_02']);
  assert.equal(rows[14][0], 'ABC_14');
});

test('unique emails tag before the @ — pinned against Rust', () => {
  const spec = col('e', 'VARCHAR(255)', 'email', P(), true);
  const rows = generateRows([spec], 15, 42);
  assert.deepEqual(rows.slice(0, 3).map(r => r[0]), [
    'jiri.watson85.00@fastmail.dev',
    'iris.jelinek28.01@inbox.me',
    'jackson.price25.02@mailbox.cz',
  ]);
  // The tag consumes NO rng draws: the base values are the non-unique run's.
  const plain = generateRows([col('e', 'VARCHAR(255)', 'email', P(), false)], 15, 42);
  assert.equal((rows[0][0] as string).replace('.00@', '@'), plain[0][0]);
});

// ── the cycle generator (new in Phase 1) ────────────────────────────────────

test('cycle round-robins a list — pinned against Rust', () => {
  const rows = generateRows([col('c', 'VARCHAR(10)', 'cycle', P({ list: 'a,b,c' }))], 7, 42);
  assert.deepEqual(rows.map(r => r[0]), ['a', 'b', 'c', 'a', 'b', 'c', 'a']);
});

test('cycle round-robins a stepped range — pinned against Rust', () => {
  const spec = col('c', 'INT', 'cycle', P({ list: '', min: 5, max: 25, step: 5 }));
  const rows = generateRows([spec], 8, 42);
  assert.deepEqual(rows.map(r => r[0]), [5, 10, 15, 20, 25, 5, 10, 15]);
});

test('cycle jitter is one seeded draw per row — pinned against Rust', () => {
  const spec = col('c', 'VARCHAR(10)', 'cycle', P({ list: 'a,b,c,d', jitterPct: 50 }));
  const rows = generateRows([spec], 10, 42);
  assert.deepEqual(rows.map(r => r[0]), ['b', 'b', 'd', 'a', 'a', 'c', 'c', 'a', 'b', 'b']);
});

// ── TS ↔ Rust drift guard (same pattern as tests/sqlGuardDrift.test.ts) ─────

const ROOT = new URL('..', import.meta.url).pathname;

function rustI64Const(constName: string): number {
  const src = readFileSync(join(ROOT, 'src-tauri/src/commands/datagen.rs'), 'utf8');
  const m = src.match(new RegExp(String.raw`const ${constName}: i64 = ([\d_]+);`));
  assert.ok(m, `${constName} literal not found in datagen.rs`);
  return Number(m[1].replace(/_/g, ''));
}

test('scramble constants match the Rust literals (drift guard)', () => {
  assert.equal(SCRAMBLE_M_CAP, rustI64Const('SCRAMBLE_M_CAP'), 'SCRAMBLE_M_CAP drifted');
  assert.equal(SCRAMBLE_A_START, rustI64Const('SCRAMBLE_A_START'), 'SCRAMBLE_A_START drifted');
  // The constraint both arithmetics rely on: a·i + b < 2^52, exact in f64 AND i64.
  assert.ok(SCRAMBLE_A_START < 2 ** 21, 'a must stay under 2^21');
  assert.ok(SCRAMBLE_A_START * SCRAMBLE_M_CAP < 2 ** 53, 'a·m must stay f64-exact');
});

// ── the cross-path matrix ───────────────────────────────────────────────────
//
// The same spec through the TS engine and the server planner. Values may
// differ by design (the server path is non-deterministic), but shape and
// guarantees must not: a unique column either carries uniqueness machinery in
// its SQL (MOD scramble / padded tag / inherent row number) or is reported
// unsupported WITH a reason. Never silently non-unique.

test('a stepped sequence is spelled with the step on the server too', () => {
  const spec = col('id', 'BIGINT', 'sequence', P({ step: 5 }));
  for (const engine of ['mysql', 'postgres', 'sqlserver']) {
    assert.equal(valueSql(engine, 'sequence', spec), '((i - 1) * 5 + 1)', engine);
  }
  // step 1 keeps the bare row number (and the existing pinned behaviour).
  assert.equal(valueSql('postgres', 'sequence', col('id', 'BIGINT', 'sequence')), 'i');
});

test('server plan: unique int carries the MOD scramble, unique string the padded tag', () => {
  const specs = [
    col('n', 'INT', 'int', P({ min: 10, max: 29 }), true),
    col('c', 'VARCHAR(20)', 'choice', P({ list: 'x,y,z' }), true),
  ];
  for (const engine of ['mysql', 'postgres', 'sqlserver']) {
    const plan = buildServerPlan(engine, 't', specs, 300_000, undefined, 'default', 42);
    assert.deepEqual(plan.unsupported, [], `${engine}: ${JSON.stringify(plan.unsupported)}`);
    const stmt = plan.statements[0];
    assert.match(stmt, engine === 'sqlserver' ? /% 20/ : /MOD\(.+, 20\)/, `${engine} int scramble`);
    assert.match(stmt, /_/, `${engine} string tag separator`);
    assert.match(
      stmt,
      engine === 'mysql' ? /LPAD/ : engine === 'postgres' ? /LPAD/ : /RIGHT\('0000000000'/,
      `${engine} zero-padded tag`);
  }
});

test('server plan: unique columns that cannot be guaranteed are refused with a named reason', () => {
  const boolSpec = col('b', 'BOOLEAN', 'bool', P(), true);
  const dateSpec = col('d', 'DATE', 'date', P(), true);
  const cycleSpec = col('c', 'VARCHAR(10)', 'cycle', P({ list: 'a,b' }), true);
  const plan = buildServerPlan('mysql', 't', [boolSpec, dateSpec, cycleSpec], 300_000, undefined, 'default', 1);
  assert.equal(plan.statements.length, 0, 'a refused column stops the server plan');
  assert.deepEqual(plan.unsupported, [
    { column: 'b', generator: 'bool', reason: 'a boolean has two values' },
    { column: 'd', generator: 'date', reason: 'uniqueness has no faithful server-side form for this generator' },
    { column: 'c', generator: 'cycle', reason: 'a cycle of 2 value(s) repeats within 300,000 rows' },
  ]);
  // …while a run that fits in one lap is unique by construction and passes.
  const ok = buildServerPlan('mysql', 't', [cycleSpec], 2, undefined, 'default', 1);
  assert.deepEqual(ok.unsupported, []);
  assert.match(ok.statements[0], /MOD\(\(\(i - 1\)\), 2\)/);
});

test('server plan: sequence/email/username/uuid unique pass through unchanged', () => {
  const specs = [
    col('id', 'BIGINT', 'sequence', P(), true),
    col('e', 'VARCHAR(255)', 'email', P(), true),
    col('u', 'VARCHAR(100)', 'username', P(), true),
    col('g', 'uuid', 'uuid', P(), true),
  ];
  const plan = buildServerPlan('postgres', 't', specs, 300_000, 150_002, 'default', 1);
  assert.deepEqual(plan.unsupported, []);
  assert.match(plan.statements[0], /gen_random_uuid\(\)/);
});

test('cross-path shape matrix: every server-capable generator stays valid under unique', () => {
  // For each generator with a SQL form, the unique variant either wraps with
  // the construction or is refused with a reason — never a silent pass.
  const cases: [string, ColumnSpec][] = [
    ['sequence', col('s', 'BIGINT', 'sequence', P(), true)],
    ['int', col('n', 'INT', 'int', P(), true)],
    ['decimal', col('d', 'DECIMAL(10,2)', 'decimal', P(), true)],
    ['money', col('m', 'DECIMAL(12,2)', 'money', P(), true)],
    ['percent', col('p', 'DECIMAL(5,1)', 'percent', P(), true)],
    ['fullName', col('f', 'VARCHAR(200)', 'fullName', P(), true)],
    ['city', col('c', 'VARCHAR(60)', 'city', P(), true)],
    ['bool', col('b', 'BOOLEAN', 'bool', P(), true)],
    ['date', col('d', 'DATE', 'date', P(), true)],
    ['latitude', col('l', 'DOUBLE', 'latitude', P(), true)],
  ];
  for (const [id, spec] of cases) {
    const plain = valueSql('mysql', id, spec);
    const plan = buildServerPlan('mysql', 't', [spec], 300_000, undefined, 'default', 7);
    if (plain === null) {
      // No SQL form at all: unsupported, and no reason is required — the
      // fallback is about the generator, not about uniqueness.
      assert.deepEqual(plan.unsupported, [{ column: spec.name, generator: id }], id);
    } else if (plan.unsupported.length > 0) {
      assert.equal(plan.unsupported.length, 1, id);
      assert.ok(plan.unsupported[0].reason, `${id}: refused without a named reason`);
    } else {
      assert.ok(plan.statements.length > 0, id);
      // And the TS engine must produce a value for the same spec.
      const rows = generateRows([spec], 3, 7);
      assert.ok(rows.every(r => r[0] !== undefined), id);
    }
  }
});
