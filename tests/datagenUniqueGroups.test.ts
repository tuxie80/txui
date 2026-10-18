/**
 * Composite uniqueness groups (unique (tenant_id, seq)) — the last Phase-1
 * checkbox of docs/plans/plan-datagen-nextgen.md.
 *
 * Columns with `unique` on that share a `params.uniqueGroup` name are unique
 * as a COMBINATION. Exactly one member — the anchor, the one with the largest
 * uniqueness capacity (ties break to spec order) — carries the machinery (the
 * scramble / the tag); the other members generate exactly as if the flag were
 * off, so their distributions are untouched. The Rust twin lives in
 * datagen.rs (unique_groups / unique_anchor_capacity / validate_unique_groups
 * / normalize_unique_groups); the anchor vector below is pinned there too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PARAMS, generateRows, uniqueAnchorCapacity, uniqueGroups,
  uniqueGroupMembers, validateUniqueGroups,
} from '../src/utils/datagen.ts';
import type { ColumnSpec } from '../src/utils/datagen.ts';
import { buildServerPlan } from '../src/utils/datagenSql.ts';
import { parseGenerateSpec } from '../src/utils/generateSpec.ts';
import { capturePreset } from '../src/utils/datagenPresets.ts';

const P = (over: Partial<ColumnSpec['params']> = {}) => ({ ...DEFAULT_PARAMS, ...over });
const col = (
  name: string, typeName: string, generator: string,
  params = P(), unique = false, uniqueGroup?: string,
): ColumnSpec => ({
  name, typeName, generator, params,
  unique, ...(uniqueGroup ? { params: { ...params, uniqueGroup } } : {}),
});

// ── group formation and the anchor rule ─────────────────────────────────────

test('membership needs unique on and a non-blank name; ties anchor the earlier column', () => {
  const specs = [
    col('tenant_id', 'INT', 'int', P(), true, 'g'),
    col('other', 'INT', 'int', P(), false),
    col('seq', 'INT', 'int', P(), true, 'g'),
    col('note', 'INT', 'int', P(), true, ' h '),   // trimmed to "h"
    col('tag', 'INT', 'int', P(), true, 'h'),
  ];
  const groups = uniqueGroups(specs);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { name: 'g', members: [0, 2], anchor: 0 });
  assert.deepEqual(groups[1], { name: 'h', members: [3, 4], anchor: 3 });
  assert.deepEqual([...uniqueGroupMembers(specs)], [2, 4], 'the members, not the anchors');
});

test('the largest-capacity member anchors, wherever the columns sit', () => {
  // The canonical shape: tenant_id's 3 values can never anchor 50 rows, and an
  // existing table's column order is fixed — so order cannot be the rule.
  const specs = [
    col('tenant_id', 'INT', 'int', P({ min: 1, max: 3 }), true, 'g'),
    col('seq', 'INT', 'int', P({ min: 1, max: 1_000_000 }), true, 'g'),
  ];
  assert.equal(uniqueGroups(specs)[0].anchor, 1, 'the wide domain anchors');
  // A sequence is unbounded — it out-anchors any ranged int.
  const withSeq = [
    col('id', 'BIGINT', 'sequence', P(), true, 'g'),
    col('code', 'INT', 'int', P({ min: 1, max: 1_000_000 }), true, 'g'),
  ];
  assert.equal(uniqueGroups(withSeq)[0].anchor, 0);
});

test('the capacity metric is pinned against the Rust twin', () => {
  assert.equal(uniqueAnchorCapacity(col('c', 'BOOLEAN', 'bool', P(), true)), 0);
  assert.equal(uniqueAnchorCapacity(col('c', 'INT', 'fk', P(), true)), 0);
  assert.equal(uniqueAnchorCapacity(col('c', 'INT', 'formula', P({ expr: 'x' }), true)), 0);
  assert.equal(uniqueAnchorCapacity(col('c', 'INT', 'httpStatus', P(), true)), 0);
  assert.equal(uniqueAnchorCapacity(col('c', 'INT', 'int', P({ min: 1, max: 1000 }), true)), 1000);
  assert.equal(uniqueAnchorCapacity(col('c', 'INT', 'int', P({ min: 10, max: 29 }), true)), 20);
  assert.equal(uniqueAnchorCapacity(col('c', 'INT', 'int', P({ min: 0, max: Number.MAX_SAFE_INTEGER }), true)),
    2_147_483_647, 'capped at SCRAMBLE_M_CAP');
  assert.equal(uniqueAnchorCapacity(col('c', 'DECIMAL(10,2)', 'decimal', P({ min: 1, max: 2 }), true)), 101);
  assert.equal(uniqueAnchorCapacity(col('c', 'DECIMAL(5,1)', 'percent', P(), true)), 1_001);
  assert.equal(uniqueAnchorCapacity(col('c', 'INT', 'rating', P(), true)), 5);
  assert.equal(uniqueAnchorCapacity(col('c', 'INT', 'bitflags', P(), true)), 256);
  assert.equal(uniqueAnchorCapacity(col('c', 'BIGINT', 'sequence', P(), true)), Infinity);
  assert.equal(uniqueAnchorCapacity(col('c', 'VARCHAR(50)', 'email', P(), true)), Infinity);
  assert.equal(uniqueAnchorCapacity(col('c', 'VARCHAR(10)', 'cycle', P({ list: 'a,b,c' }), true)), 3);
});

// ── validation ───────────────────────────────────────────────────────────────

test('a single-member group is rejected, by name', () => {
  const problems = validateUniqueGroups([col('seq', 'INT', 'int', P(), true, 'g')]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].column, 'seq');
  assert.match(problems[0].reason, /single member/);
});

test('a column naming a group with unique off is an error, not a member', () => {
  const problems = validateUniqueGroups([
    col('tenant_id', 'INT', 'int', P(), false, 'g'),
    col('seq', 'INT', 'int', P(), true, 'g'),
  ]);
  // Both consequences are named: the flag-off member, and the group it
  // leaves behind, now single-membered.
  assert.equal(problems.length, 2);
  assert.match(problems[0].reason, /unique flag is off/);
  assert.match(problems[1].reason, /single member/);
});

test('a group nothing can anchor is rejected', () => {
  const problems = validateUniqueGroups([
    col('flag', 'BOOLEAN', 'bool', P(), true, 'g'),
    col('status', 'INT', 'httpStatus', P(), true, 'g'),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /no member of unique group "g" can carry uniqueness/);
});

test('a valid group passes', () => {
  assert.deepEqual(validateUniqueGroups([
    col('tenant_id', 'INT', 'int', P(), true, 'g'),
    col('seq', 'INT', 'int', P(), true, 'g'),
  ]), []);
});

// ── generation: the combination is unique, the members are free ─────────────

test('a group of 2 over a small member domain produces no duplicate pairs', () => {
  const specs = [
    col('tenant_id', 'INT', 'int', P({ min: 1, max: 3 }), true, 'g'),
    col('seq', 'INT', 'int', P({ min: 1, max: 1000 }), true, 'g'),
  ];
  assert.deepEqual(validateUniqueGroups(specs), []);
  const rows = generateRows(specs, 200, 42);
  const pairs = new Set(rows.map(r => `${r[0]}|${r[1]}`));
  assert.equal(pairs.size, 200, 'every (tenant_id, seq) combination is unique');
  // The member really does repeat on its own — that is the point of a group.
  assert.ok(new Set(rows.map(r => r[0])).size <= 3);
  // The anchor's first five values, pinned against the Rust writer
  // (group_member_passes_through_and_the_anchor_carries_uniqueness):
  // m=1000, a=2097151 ≡ 151 mod 1000, b=42 → 1 + (151·i + 42) mod 1000.
  assert.deepEqual(rows.slice(0, 5).map(r => r[1]), [43, 194, 345, 496, 647]);
});

test("the member's values and draws are exactly the non-unique run's", () => {
  const grouped = generateRows([
    col('tenant_id', 'INT', 'int', P({ min: 1, max: 3 }), true, 'g'),
    col('seq', 'INT', 'int', P({ min: 1, max: 1000 }), true, 'g'),
    col('tail', 'INT', 'int', P({ min: 1, max: 100 }), false),
  ], 100, 7);
  const plain = generateRows([
    col('tenant_id', 'INT', 'int', P({ min: 1, max: 3 }), false),
    col('seq', 'INT', 'int', P({ min: 1, max: 1000 }), false),
    col('tail', 'INT', 'int', P({ min: 1, max: 100 }), false),
  ], 100, 7);
  // Group machinery consumes no RNG draws: the member AND every trailing
  // column draw the same values as the unflagged run.
  assert.deepEqual(grouped.map(r => r[0]), plain.map(r => r[0]));
  assert.deepEqual(grouped.map(r => r[2]), plain.map(r => r[2]));
});

test('a string-anchored group tags the anchor and frees the member', () => {
  const rows = generateRows([
    col('tenant_id', 'INT', 'int', P({ min: 1, max: 5 }), true, 'g'),
    col('sku', 'VARCHAR(20)', 'choice', P({ list: 'ABC' }), true, 'g'),
  ], 12, 3);
  assert.deepEqual(rows.slice(0, 3).map(r => r[1]), ['ABC_00', 'ABC_01', 'ABC_02']);
  assert.equal(new Set(rows.map(r => `${r[0]}|${r[1]}`)).size, 12);
});

// ── the server path ──────────────────────────────────────────────────────────

test('server plan: the anchor carries the scramble, members pass through', () => {
  const specs = [
    col('tenant_id', 'INT', 'int', P({ min: 1, max: 3 }), true, 'g'),
    col('seq', 'INT', 'int', P({ min: 1, max: 1000 }), true, 'g'),
  ];
  for (const engine of ['mysql', 'postgres', 'sqlserver']) {
    const plan = buildServerPlan(engine, 't', specs, 300_000, undefined, 'default', 42);
    assert.deepEqual(plan.unsupported, [], `${engine}: ${JSON.stringify(plan.unsupported)}`);
    const stmt = plan.statements[0];
    // The seq anchor scrambles over m=1000; the tenant member (m=3) does NOT.
    assert.match(stmt, engine === 'sqlserver' ? /% 1000/ : /MOD\(.+, 1000\)/, `${engine} anchor`);
    assert.doesNotMatch(stmt, engine === 'sqlserver' ? /% 3\)/ : /MOD\(.+, 3\)/, `${engine} member stays free`);
  }
});

test('server plan: a sequence anchor passes through and the member stays plain', () => {
  const specs = [
    col('id', 'BIGINT', 'sequence', P(), true, 'g'),
    col('tenant_id', 'INT', 'int', P({ min: 1, max: 3 }), true, 'g'),
  ];
  const plan = buildServerPlan('mysql', 't', specs, 300_000, undefined, 'default', 1);
  assert.deepEqual(plan.unsupported, []);
  assert.doesNotMatch(plan.statements[0], /MOD/, 'nothing is scrambled — the sequence is unique already');
});

test('server plan: an invalid group is refused with the reason', () => {
  const specs = [col('seq', 'INT', 'int', P(), true, 'g')];
  const plan = buildServerPlan('mysql', 't', specs, 300_000, undefined, 'default', 1);
  assert.equal(plan.statements.length, 0);
  assert.deepEqual(plan.unsupported, [
    { column: 'seq', generator: 'int', reason: 'unique group "g" has a single member — a group needs '
      + 'at least two columns (a lone column is just unique; clear the group name)' },
  ]);
});

test('server plan: groups and the continuation offset compose', () => {
  const specs = [
    col('tenant_id', 'INT', 'int', P({ min: 1, max: 3 }), true, 'g'),
    col('seq', 'INT', 'int', P({ min: 1, max: 1000 }), true, 'g'),
  ];
  const plan = buildServerPlan('mysql', 't', specs, 300_000, undefined, 'default', 42, 7);
  assert.match(plan.statements[0], /\(i - 1 \+ 7\)/, 'the anchor starts past the existing rows');
});

// ── headless (TxShell) and presets ───────────────────────────────────────────

test('parseGenerateSpec carries uniqueGroup and rejects a bad group', () => {
  const ok = parseGenerateSpec(JSON.stringify({
    table: 't', rowCount: 10,
    specs: [
      { name: 'tenant_id', typeName: 'INT', generator: 'int', unique: true, params: { uniqueGroup: 'g' } },
      { name: 'seq', typeName: 'INT', generator: 'int', unique: true, params: { uniqueGroup: 'g' } },
    ],
  }));
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.join('; '));
  if (ok.ok) assert.equal(ok.spec.specs[0].params.uniqueGroup, 'g');

  const bad = parseGenerateSpec(JSON.stringify({
    table: 't', rowCount: 10,
    specs: [{ name: 'seq', typeName: 'INT', generator: 'int', unique: true, params: { uniqueGroup: 'g' } }],
  }));
  assert.ok(!bad.ok);
  if (!bad.ok) assert.ok(bad.errors.some(e => /single member/.test(e)));
});

test('presets never capture a group name — it is scoped to one spec', () => {
  const preset = capturePreset('p', col('seq', 'INT', 'int', P({ uniqueGroup: 'g' }), true, 'g'));
  assert.ok(!('error' in preset));
  if ('error' in preset) return;
  assert.equal(preset.params.uniqueGroup, undefined);
});
