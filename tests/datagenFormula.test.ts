/**
 * Cross-column formulas (plan-datagen-nextgen Phase 4) — the `formula`
 * generator's parser, evaluator, validator and SQL subset.
 *
 * The vectors here are pinned IDENTICALLY in the Rust twin,
 * src-tauri/src/commands/datagen_formula.rs (`mod tests`) — same expressions,
 * same rows, same results — so a semantic drift on either side fails loudly.
 * The generateRows vectors are additionally pinned in datagen.rs's test
 * module (formula_columns_evaluate_against_the_row).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFormula, validateFormula, evalFormula, referencedColumns,
  toNumStrict, jsNumStr, FORMULA_FUNCTIONS,
} from '../src/utils/datagenFormula.ts';
import type { FormulaNode } from '../src/utils/datagenFormula.ts';
import {
  DEFAULT_PARAMS, GENERATOR_MAP, generateRows, applyUnique, uniqueRowReason, makeRng,
} from '../src/utils/datagen.ts';
import type { ColumnSpec } from '../src/utils/datagen.ts';
import { buildServerPlan, valueSql, formulaSql } from '../src/utils/datagenSql.ts';

const P = (over: Partial<ColumnSpec['params']> = {}) => ({ ...DEFAULT_PARAMS, ...over });
const col = (
  name: string, typeName: string, generator: string,
  params = P(), unique = false,
): ColumnSpec => ({ name, typeName, generator, params, unique });

const ev = (src: string, row: Record<string, null | number | string | boolean> = {}) => {
  const p = parseFormula(src);
  assert.ok(p.ok, `parse '${src}': ${p.ok ? '' : p.error}`);
  return evalFormula((p as { ast: FormulaNode }).ast, n => row[n]);
};

// ── parser: precedence, associativity, literals ─────────────────────────────

test('precedence and parens — pinned in datagen_formula.rs', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('10 - 4 - 3'), 3);        // left associative
  assert.equal(ev('-2 * -3'), 6);
  assert.equal(ev('17 % 5'), 2);
  assert.equal(ev('7 / 2'), 3.5);
  assert.equal(ev("'a' || 'b' || 'c'"), 'abc');
  assert.equal(ev("1 + 2 || 'x'"), '3x');   // '||' binds looser than '+'
});

test('string literals: quotes and escaping', () => {
  assert.equal(ev("'it''s'"), "it's");
  assert.equal(ev("''"), '');
  // Quoted column names carry spaces/unicode.
  assert.equal(ev('"odd name" * 2', { 'odd name': 21 }), 42);
});

test('parse errors are named, never thrown', () => {
  const err = (src: string) => {
    const p = parseFormula(src);
    assert.ok(!p.ok, `'${src}' should not parse`);
    return p.ok ? '' : p.error;
  };
  assert.match(err(''), /empty/);
  assert.match(err('   '), /empty/);
  assert.match(err('price *'), /unexpected end/);
  assert.match(err('foo(1)'), /unknown function 'foo'/);
  assert.match(err('abs(1, 2)'), /exactly 1 argument/);
  assert.match(err('substr(\'x\')'), /2–3 arguments/);
  assert.match(err('min()'), /1–32 arguments/);
  assert.match(err('1 2'), /trailing/);
  assert.match(err("'abc"), /unterminated string/);
  assert.match(err('"abc'), /unterminated quoted column/);
  assert.match(err('1.2.3'), /malformed number/);
  assert.match(err('@'), /unexpected character '@'/);
  assert.match(err('(1 +'), /unexpected end/);
  // An identifier is a column UNLESS followed by '(' — so a column named
  // `round` is still reachable.
  assert.equal(ev('round', { round: 1.5 }), 1.5);
});

// ── evaluator: the operator rules ───────────────────────────────────────────

test('arithmetic and concat rules — pinned in datagen_formula.rs', () => {
  assert.equal(ev('price * qty', { price: 2.5, qty: 4 }), 10);
  assert.equal(ev("first + ' ' + last", { first: 'Ada', last: 'Lovelace' }), 'Ada Lovelace');
  // A string on either side of '+' concatenates, even a numeric-looking one…
  assert.equal(ev("a + 1", { a: '10' }), '101');
  // …while the other arithmetic operators strict-parse numeric strings.
  assert.equal(ev('a * 2', { a: '10' }), 20);
  assert.equal(ev('a * 2', { a: 'n/a' }), null);     // type error → NULL
  assert.equal(ev('1 / 0'), null);                   // never Infinity
  assert.equal(ev('5 % 0'), null);                   // never NaN
  assert.equal(ev('a + 1', { a: null }), null);      // NULL propagates
  assert.equal(ev("a || 'x'", { a: null }), null);
  assert.equal(ev('b + 1', { b: true }), null);      // booleans take no part
  assert.equal(ev('nope + 1'), null);                // unknown column → NULL, not a throw
});

test('functions — pinned in datagen_formula.rs', () => {
  assert.equal(ev('abs(0 - 3)'), 3);
  assert.equal(ev('round(2.5)'), 3);
  // Math.round semantics: half towards +∞, so -2.5 → -2. (Rust's own round()
  // would give -3; the Rust port spells the JS form out — this pins it.)
  assert.equal(ev('round(-2.5)'), -2);
  assert.equal(ev('round(1.005 * 3, 2)'), 3.01);
  assert.equal(ev('floor(2.7)'), 2);
  assert.equal(ev('ceil(2.1)'), 3);
  assert.equal(ev('min(3, 1, 2)'), 1);
  assert.equal(ev('max(3, 1, 2)'), 3);
  assert.equal(ev('min(a, 2)', { a: null }), null);  // NULL in → NULL out
  assert.equal(ev('length(s)', { s: 'héllo' }), 5);  // code points, not UTF-16 units
  assert.equal(ev('upper(s)', { s: 'héllo' }), 'HÉLLO');
  assert.equal(ev('lower(s)', { s: 'HÉLLO' }), 'héllo');
  assert.equal(ev('substr(s, 2, 3)', { s: 'abcdef' }), 'bcd');
  assert.equal(ev('substr(s, 4)', { s: 'abcdef' }), 'def');
  assert.equal(ev('substr(s, 0, 3)', { s: 'abcdef' }), 'abc');   // start clamps to 1
  assert.equal(ev('coalesce(a, b, 7)', { a: null, b: null }), 7);
  assert.equal(ev("coalesce(a, 'x')", { a: 'v' }), 'v');
  assert.equal(ev('slugify(s)', { s: 'Héllo World!' }), 'héllo-world');
});

test('number stringification is the JS form (jsNumStr)', () => {
  assert.equal(jsNumStr(3), '3');
  assert.equal(jsNumStr(2.5), '2.5');
  assert.equal(jsNumStr(0.1 + 0.2), '0.30000000000000004');
  assert.equal(jsNumStr(-42), '-42');
  assert.equal(ev("qty || ' items'", { qty: 3 }), '3 items');
});

test('strict numeric strings (toNumStrict) — pinned in datagen_formula.rs', () => {
  const cases: [string, number | null][] = [
    ['10', 10], [' 2.5 ', 2.5], ['-3', -3], ['.5', 0.5], ['5.', 5], ['1e3', 1000],
    ['', null], ['0x10', null], ['inf', null], ['NaN', null], ['12,5', null], ['1_000', null],
  ];
  for (const [s, want] of cases) assert.equal(toNumStrict(s), want, JSON.stringify(s));
});

// ── validation: earlier columns only ────────────────────────────────────────

test('validateFormula: unknown, later and self references are config errors', () => {
  assert.equal(validateFormula('price * qty', ['price', 'qty']), null);
  assert.equal(validateFormula('missing + 1', ['price'], ['price', 'total']), 'unknown column "missing"');
  // A column that exists but is LATER (or self) is named differently.
  assert.equal(
    validateFormula('qty + 1', ['price'], ['price', 'qty']),
    'column "qty" is not an earlier column — a formula can only reference columns to its left',
  );
  // Self-reference: not in the earlier list, but in the full list.
  assert.match(validateFormula('total + 1', [], ['total']) ?? '', /not an earlier column/);
  // Parse errors pass through.
  assert.match(validateFormula('price *', ['price']) ?? '', /unexpected end/);
  // Quoted refs validate against the same names.
  assert.equal(validateFormula('"weird col" + 1', ['weird col']), null);
  assert.deepEqual(referencedColumns((() => {
    const p = parseFormula('a + b * a'); return p.ok ? p.ast : null;
  })()!), ['a', 'b']);
});

// ── generateRows integration ────────────────────────────────────────────────

test('a formula column consumes NO seeded-RNG draws (stream unperturbed)', () => {
  const withFormula = generateRows([
    col('a', 'INT', 'int', P({ min: 1, max: 9 })),
    col('b', 'INT', 'formula', P({ expr: 'a * 10' })),
    col('k', 'INT', 'int', P({ min: 1, max: 9 })),
  ], 5, 42);
  const without = generateRows([
    col('a', 'INT', 'int', P({ min: 1, max: 9 })),
    col('k', 'INT', 'int', P({ min: 1, max: 9 })),
  ], 5, 42);
  assert.deepEqual(withFormula.map(r => r[0]), without.map(r => r[0]));
  assert.deepEqual(withFormula.map(r => r[2]), without.map(r => r[1]));
});

test('formula columns evaluate against the row — pinned in datagen.rs', () => {
  // Rows 0–2 are pinned identically in datagen.rs. Row 3's `qty` differs per
  // tier (the pre-existing int-arm difference: Rust floors over [min, max+1),
  // TS rounds over [min, max]) — the formula arithmetic itself is pinned
  // cross-tier by the evalFormula vectors.
  const specs = [
    col('price', 'DECIMAL(10,2)', 'decimal', P({ min: 1, max: 100 })),
    col('qty', 'INT', 'int', P({ min: 1, max: 5 })),
    col('total', 'DECIMAL(12,2)', 'formula', P({ expr: 'price * qty' })),
    col('label', 'TEXT', 'formula', P({ expr: "'item-' || qty" })),
    col('id', 'INT', 'sequence'),
    col('double_id', 'INT', 'formula', P({ expr: 'id * 2 + 1' })),
  ];
  const rows = generateRows(specs, 4, 42);
  assert.deepEqual(rows, [
    [60.51, 3, 181.53, 'item-3', 1, 3],
    [85.39, 4, 341.56, 'item-4', 2, 5],
    [18.31, 3, 54.92999999999999, 'item-3', 3, 7],
    [28.05, 3, 84.15, 'item-3', 4, 9],
  ]);
});

test('a formula can reference an EARLIER formula column — pinned in datagen.rs', () => {
  const specs = [
    col('a', 'INT', 'int', P({ min: 1, max: 9 })),
    col('b', 'INT', 'formula', P({ expr: 'a * 10' })),
    col('c', 'INT', 'formula', P({ expr: 'b + a' })),
  ];
  assert.deepEqual(generateRows(specs, 4, 7), [[1, 10, 11], [1, 10, 11], [9, 90, 99], [7, 70, 77]]);
});

test('nullPct on a formula column wins over the expression', () => {
  const specs = [
    col('a', 'INT', 'int', P({ min: 1, max: 9 })),
    col('b', 'INT', 'formula', P({ expr: 'a * 10', nullPct: 100 })),
  ];
  const rows = generateRows(specs, 3, 7);
  assert.deepEqual(rows, [[1, null], [9, null], [5, null]]);
});

test('an invalid expression yields NULL cells here (the config error surfaces earlier)', () => {
  const specs = [
    col('a', 'INT', 'int', P({ min: 1, max: 9 })),
    col('b', 'INT', 'formula', P({ expr: 'a **' })),
    col('c', 'INT', 'formula', P({ expr: 'later + 1' })),   // forward ref
  ];
  const rows = generateRows(specs, 2, 7);
  assert.ok(rows.every(r => r[1] === null && r[2] === null));
});

test('unique is not applied to formula columns (and the reason is named)', () => {
  const spec = col('b', 'INT', 'formula', P({ expr: 'a * 2' }), true);
  assert.equal(applyUnique(spec, 42, 0, 10, 1), 42);
  assert.match(uniqueRowReason(spec, 10) ?? '', /formula/);
  // The registry entry itself is the placeholder, drawing nothing.
  const g = GENERATOR_MAP.get('formula')!;
  const rng = makeRng(1);
  const before = rng();
  const rng2 = makeRng(1);
  assert.equal(g.gen(rng2, 0, P(), 10), '<formula>');
  assert.equal(rng2(), before, 'the placeholder consumed a draw');
});

// ── the SQL-expressible subset ──────────────────────────────────────────────

test('formulaSql emits SQL for the portable subset, referencing aliases', () => {
  const refs = new Map([
    ['price', { sql: 's.c0', kind: 'num' as const }],
    ['qty', { sql: 's.c1', kind: 'num' as const }],
    ['name', { sql: 's.c3', kind: 'str' as const }],
  ]);
  const sql = (engine: string, src: string) => {
    const p = parseFormula(src);
    assert.ok(p.ok);
    return formulaSql(engine, (p as { ast: FormulaNode }).ast, n => refs.get(n) ?? null);
  };
  assert.equal(sql('mysql', 'price * qty'), '(s.c0 * s.c1)');
  assert.equal(sql('postgres', 'price / qty'), '(s.c0 / NULLIF(s.c1, 0))');
  assert.equal(sql('mysql', 'qty % 2'), 'MOD((s.c1), NULLIF(2, 0))');
  assert.equal(sql('sqlserver', 'qty % 2'), '((s.c1) % NULLIF(2, 0))');
  assert.equal(sql('postgres', "upper(name) || ' #' || qty"), "UPPER(s.c3) || ' #' || (s.c1)::text");
  assert.equal(sql('mysql', 'round(price * qty, 2)'), 'ROUND((s.c0 * s.c1), 2)');
  // MySQL LEAST propagates NULL like the row engines; PostgreSQL's ignores
  // NULLs, so the CASE guard restores the row engines' answer.
  assert.equal(sql('mysql', 'min(price, qty)'), 'LEAST(s.c0, s.c1)');
  assert.equal(sql('postgres', 'min(price, qty)'),
    '(CASE WHEN s.c0 IS NULL OR s.c1 IS NULL THEN NULL ELSE LEAST(s.c0, s.c1) END)');
  // '+' commits to add only when both sides are statically numeric…
  assert.equal(sql('mysql', 'price + 1'), '(s.c0 + 1)');
  // …and to concat when a side is statically a string.
  assert.equal(sql('postgres', "name + 'x'"), "s.c3 || 'x'");
  // T-SQL's CONCAT maps NULL to '' where the row engines propagate it —
  // concat formulas are unsupported there, honestly.
  assert.equal(sql('sqlserver', "name || 'x'"), null);
  // substr: literal non-negative bounds only.
  assert.equal(sql('mysql', "substr(name, 2, 3)"), 'SUBSTRING(s.c3, 2, 3)');
  assert.equal(sql('mysql', 'substr(name, qty)'), null);
  // slugify has no SQL form — runtime-only, and the set says so.
  assert.equal(FORMULA_FUNCTIONS.slugify.sql, false);
  assert.equal(sql('mysql', 'slugify(name)'), null);
  // Unknown/unresolvable refs are unsupported, not guessed.
  assert.equal(sql('mysql', 'mystery + 1'), null);
});

test('server plan: formula columns get the two-level INSERT…SELECT', () => {
  const specs = [
    col('price', 'DECIMAL(10,2)', 'decimal', P({ min: 1, max: 100 })),
    col('qty', 'INT', 'int', P({ min: 1, max: 5 })),
    col('total', 'DECIMAL(12,2)', 'formula', P({ expr: 'round(price * qty, 2)' })),
    col('name', 'VARCHAR(100)', 'firstName'),
    col('label', 'TEXT', 'formula', P({ expr: "upper(name) || ' #' || qty" })),
  ];
  for (const engine of ['mysql', 'postgres']) {
    const plan = buildServerPlan(engine, 't', specs, 300_000, 150_002, 'default', 42);
    assert.deepEqual(plan.unsupported, [], engine);
    const stmt = plan.statementAt(0);
    // The inner SELECT computes each base column ONCE under an alias; the
    // formula reads the alias, so the values are the inserted values.
    assert.match(stmt, /FROM \(SELECT .+ AS c0/);
    assert.match(stmt, /AS s$/m);
    assert.match(stmt, /s\.c0 \* s\.c1/, engine);
    assert.match(stmt, /INSERT INTO t/, engine);
  }
  // SQL Server: the concat formula is unsupported there (NULL semantics) →
  // the whole run falls back, with the reason named.
  const ss = buildServerPlan('sqlserver', 't', specs, 300_000, undefined, 'default', 42);
  assert.equal(ss.statements.length, 0);
  assert.deepEqual(ss.unsupported.map(u => u.column), ['label']);
  assert.match(ss.unsupported[0].reason ?? '', /SQL-expressible subset/);
});

test('server plan: no formula columns → the byte-identical single-level shape', () => {
  const specs = [col('id', 'BIGINT', 'sequence'), col('c', 'VARCHAR(20)', 'choice', P({ list: 'x,y' }))];
  for (const engine of ['mysql', 'postgres', 'sqlserver']) {
    const plan = buildServerPlan(engine, 't', specs, 300_000, undefined, 'default', 42);
    assert.deepEqual(plan.unsupported, [], engine);
    assert.doesNotMatch(plan.statementAt(0), /FROM \(SELECT .+ AS c0/, `${engine} gained a wrapper`);
  }
});

test('server plan: formula refusals are named (slugify, formula-over-formula, bad refs)', () => {
  const slug = [col('n', 'TEXT', 'firstName'), col('s', 'TEXT', 'formula', P({ expr: 'slugify(n)' }))];
  const p1 = buildServerPlan('mysql', 't', slug, 300_000);
  assert.match(p1.unsupported[0].reason ?? '', /SQL-expressible subset/);

  const ff = [
    col('a', 'INT', 'int'), col('b', 'INT', 'formula', P({ expr: 'a * 2' })),
    col('c', 'INT', 'formula', P({ expr: 'b * 2' })),
  ];
  const p2 = buildServerPlan('mysql', 't', ff, 300_000);
  assert.match(p2.unsupported[0].reason ?? '', /itself a formula/);

  const bad = [col('a', 'INT', 'int'), col('c', 'INT', 'formula', P({ expr: 'missing + 1' }))];
  const p3 = buildServerPlan('mysql', 't', bad, 300_000);
  assert.match(p3.unsupported[0].reason ?? '', /unknown column "missing"/);

  const fwd = [col('c', 'INT', 'formula', P({ expr: 'a + 1' })), col('a', 'INT', 'int')];
  const p4 = buildServerPlan('mysql', 't', fwd, 300_000);
  assert.match(p4.unsupported[0].reason ?? '', /not an earlier column/);
});

test('server plan: a unique formula column is plain SQL, never scramble-wrapped', () => {
  const specs = [
    col('id', 'INT', 'sequence'),
    col('d', 'INT', 'formula', P({ expr: 'id * 2' }), true),
  ];
  const plan = buildServerPlan('mysql', 't', specs, 300_000, undefined, 'default', 1);
  assert.deepEqual(plan.unsupported, []);
  assert.match(plan.statementAt(0), /\(s\.c0 \* 2\)/);
});

test('valueSql has no standalone formula form (buildServerPlan owns it)', () => {
  assert.equal(valueSql('mysql', 'formula', col('x', 'INT', 'formula', P({ expr: '1' }))), null);
});
