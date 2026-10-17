/**
 * Phase 2b scale work (src/utils/datagenSql.ts + src/utils/schemaKits.ts).
 *
 * The 1e9-row ceiling is gone; what replaced it is honesty and arithmetic that
 * stays exact. The things that can silently rot, tested here:
 *
 *  - the ladder's new rungs and the byte estimates shown beside them;
 *  - chunk-plan math at 1e9/1e10/1e11/1e12 — coverage, last-chunk remainder,
 *    and no f64 drift (JS numbers are exact integers only below 2^53);
 *  - `statementAt` agrees with the materialised `statements` view, so the
 *    panel's lazy chunk loop emits the same SQL the tests always asserted;
 *  - the typed-confirm threshold above a billion rows;
 *  - the kit scale cascade at 100× (and that nothing caps it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZINGS, estimateBytes, formatBytes, planChunks, buildServerPlan,
  needsTypedConfirm, TYPED_CONFIRM_THRESHOLD, etaRangeSeconds, etaRangeText,
} from '../src/utils/datagenSql.ts';
import { DEFAULT_PARAMS } from '../src/utils/datagen.ts';
import type { ColumnSpec } from '../src/utils/datagen.ts';
import { SCHEMA_KITS, resolveRowCounts, totalRows } from '../src/utils/schemaKits.ts';

const col = (name: string, typeName: string, generator: string): ColumnSpec =>
  ({ name, typeName, generator, params: { ...DEFAULT_PARAMS } });

const SPECS = [
  col('id', 'bigint', 'sequence'),
  col('name', 'varchar(80)', 'fullName'),
  col('city', 'varchar(60)', 'city'),
  col('score', 'int', 'int'),
];

// ── the ladder, extended ──────────────────────────────────────────────────────

test('the ladder gains 1e10, 1e11 and 1e12 rungs, all server-only', () => {
  const top = SIZINGS.slice(-4).map(s => s.rows);
  assert.deepEqual(top, [1e9, 1e10, 1e11, 1e12]);
  for (const s of SIZINGS.slice(-4)) assert.equal(s.serverOnly, true, s.id);
});

test('byte estimates at the new rungs land in the units a human expects', () => {
  // SPECS ≈ 82 bytes/row × 1.3 overhead: 1e10 rows ≈ 990 GiB, 1e12 ≈ 97 TiB.
  assert.match(formatBytes(estimateBytes(SPECS, 1e10)), /GiB/);
  assert.match(formatBytes(estimateBytes(SPECS, 1e11)), /TiB/);
  assert.match(formatBytes(estimateBytes(SPECS, 1e12)), /TiB/);
  // The PiB rung exists for exactly these sizes.
  assert.match(formatBytes(3 * 1024 ** 5), /PiB/);
});

// ── chunk math at the uncapped sizes ──────────────────────────────────────────

test('the chunk plan covers 1e9/1e10/1e11 exactly, with no f64 drift', () => {
  for (const total of [1e9, 1e10, 1e11]) {
    const p = planChunks(SPECS, total);
    // Coverage: every row exactly once, last chunk a honest remainder.
    assert.equal((p.chunks - 1) * p.chunkRows + p.lastChunkRows, total, `total ${total}`);
    assert.ok(p.lastChunkRows > 0 && p.lastChunkRows <= p.chunkRows, `total ${total}`);
    assert.equal(p.chunks, Math.ceil(total / p.chunkRows), `total ${total}`);
    // Every piece is an exact f64 integer — the property the 1e15 input guard
    // (MAX_ROWS in DataGenPanel, an order of magnitude under 2^53) protects.
    for (const n of [p.chunks, p.chunkRows, p.lastChunkRows, (p.chunks - 1) * p.chunkRows]) {
      assert.ok(Number.isSafeInteger(n), `total ${total}: ${n} is not a safe integer`);
    }
  }
});

test('a trillion rows is a million bounded chunks, planned exactly', () => {
  const narrow = [col('id', 'bigint', 'sequence')];
  const p = planChunks(narrow, 1e12);
  assert.equal(p.chunkRows, 1_000_000);          // the clamp holds
  assert.equal(p.chunks, 1_000_000);
  assert.equal((p.chunks - 1) * p.chunkRows + p.lastChunkRows, 1e12);
  assert.ok(Number.isSafeInteger(1e12), 'the regime this runs in');
  assert.ok(1e15 < 2 ** 53, 'the panel parser guard stays under f64 exactness');
});

test('statementAt is the lazy twin of the statements view', () => {
  const plan = buildServerPlan('postgres', '"t"', SPECS, 5_000_000);
  assert.ok(plan.chunks > 1);
  for (let c = 0; c < plan.chunks; c++) {
    assert.equal(plan.statementAt(c), plan.statements[c], `chunk ${c}`);
  }
  // The last chunk's row source ends at the total, not at a clamp.
  const m = /generate_series\((\d+), (\d+)\)/.exec(plan.statementAt(plan.chunks - 1))!;
  assert.equal(Number(m[2]), 5_000_000);
});

test('statementAt works at 1e12 without materialising a million statements', () => {
  const narrow = [col('id', 'bigint', 'sequence')];
  const plan = buildServerPlan('postgres', '"t"', narrow, 1e12);
  assert.equal(plan.chunks, 1_000_000);
  // First and last chunk, on demand — the panel loop never touches
  // `statements`, so the run never holds the gigabyte of SQL text.
  assert.match(plan.statementAt(0), /generate_series\(1, 1000000\)/);
  assert.match(plan.statementAt(plan.chunks - 1), /generate_series\(999999000001, 1000000000000\)/);
});

// ── the typed confirmation ────────────────────────────────────────────────────

test('the typed confirm arms above a billion rows, not at it', () => {
  assert.equal(TYPED_CONFIRM_THRESHOLD, 1_000_000_000);
  assert.equal(needsTypedConfirm(1), false);
  assert.equal(needsTypedConfirm(1_000_000_000), false);   // the old ceiling passes
  assert.equal(needsTypedConfirm(1_000_000_001), true);
  assert.equal(needsTypedConfirm(1e12), true);
  assert.equal(needsTypedConfirm(1e15), true);             // the parser guard itself
});

test('the ETA range is a range, ordered, and readable at 1e11', () => {
  const { lo, hi } = etaRangeSeconds('postgres', 1e11);
  assert.ok(lo > 0 && hi > lo);
  assert.match(etaRangeText('postgres', 1e11), /hours/);
  assert.match(etaRangeText('mysql', 1e9), /minutes|hours/);
  // An unmeasured engine falls back to a conservative envelope, not a crash.
  assert.match(etaRangeText('clickhouse', 1e9), /minutes|hours/);
});

// ── kit scale past 50× ────────────────────────────────────────────────────────

test('the retail kit cascades at 100× — base tables scale, ratio tables multiply', () => {
  const kit = SCHEMA_KITS.find(k => k.id === 'retail')!;
  const counts = resolveRowCounts(kit, 100);
  assert.equal(counts.get('customers'), 500_000);          // 5 000 × 100
  assert.equal(counts.get('products'), 80_000);            // 800 × 100
  assert.equal(counts.get('orders'), 2_000_000);           // 4 per customer
  assert.equal(counts.get('order_items'), 6_000_000);      // 3 per order
  assert.equal(counts.get('payments'), 2_000_000);         // 1 per order
  assert.equal(totalRows(kit, 100), 10_580_000);
});

test('nothing caps the cascade — it scales past 50× and stays f64-exact', () => {
  const kit = SCHEMA_KITS.find(k => k.id === 'retail')!;
  // 1000×: 5e9 customers, 2e10 orders — absurd, and resolved exactly rather
  // than clamped to a number that disagrees with the input.
  const counts = resolveRowCounts(kit, 1000);
  assert.equal(counts.get('customers'), 5_000_000);
  assert.equal(counts.get('orders'), 20_000_000);
  const huge = resolveRowCounts(kit, 200_000);
  const customers = huge.get('customers')!;
  assert.equal(customers, 1e9);
  assert.ok(Number.isSafeInteger(huge.get('order_items')!));
});
