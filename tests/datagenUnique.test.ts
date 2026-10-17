/**
 * Uniqueness by construction (src/utils/datagen.ts `applyUnique` and the
 * server-side spelling `uniqueSqlWrap` in datagenSql.ts) — Phase 1 of
 * docs/plans/plan-datagen-nextgen.md.
 *
 * The guarantee is constructive, never retry-based: integers are a
 * multiplicative scramble of the row index into [min, max] (a bijection when
 * the multiplier is coprime to the range size), decimals the same on their
 * precision grid, and strings get a zero-padded row-index tag that never
 * truncates. Anything that cannot be guaranteed is reported per column, on
 * the step-3 summary (`uniqueRowReason`) and in the server plan
 * (`unsupported` with a reason) — never silently duplicated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PARAMS, generateRows, applyUnique, applyUniqueStr, cycleLength,
  parenLen, scrambleA, scrambleIndex, uniqueDecimalValue, uniqueIntValue,
  uniqueRowReason, uniqueTag, uniqueTagWidth,
  SCRAMBLE_A_START, SCRAMBLE_M_CAP,
} from '../src/utils/datagen.ts';
import type { ColumnSpec } from '../src/utils/datagen.ts';
import {
  buildServerPlan, shouldUseServer, uniqueSqlRefusalReason, uniqueSqlWrap, valueSql,
} from '../src/utils/datagenSql.ts';

const P = (over: Partial<ColumnSpec['params']> = {}) => ({ ...DEFAULT_PARAMS, ...over });
const col = (
  name: string, typeName: string, generator: string,
  params = P(), unique = false,
): ColumnSpec => ({ name, typeName, generator, params, unique });

// ── the scramble ────────────────────────────────────────────────────────────

test('the scramble is a bijection over [0, m) — m rows, m distinct values', () => {
  for (const m of [1, 2, 3, 5, 17, 97, 1000, 999_983]) {
    const seen = new Set<number>();
    for (let i = 0; i < m; i++) {
      const v = scrambleIndex(i, m, 42);
      assert.ok(v >= 0 && v < m, `m=${m} i=${i} → ${v} escapes the range`);
      seen.add(v);
    }
    assert.equal(seen.size, m, `m=${m} is not a bijection`);
  }
});

test('the multiplier is odd, under 2^21, and coprime to m', () => {
  for (const m of [2, 4, 1024, 1_000_000, 999_983, 2_147_483_647]) {
    const a = scrambleA(m);
    assert.ok(a < 2 ** 21 && a % 2 === 1, `m=${m}: a=${a}`);
    // gcd via the Euclidean algorithm
    let x = a, y = m;
    while (y) { [x, y] = [y, x % y]; }
    assert.equal(Math.abs(x), 1, `m=${m}: a=${a} is not coprime`);
  }
  // The exactness bound both arithmetics rely on (f64 AND i64).
  assert.ok(SCRAMBLE_A_START * (SCRAMBLE_M_CAP - 1) + 2 ** 31 < 2 ** 53);
});

test('the seed shifts the permutation without changing its image', () => {
  const m = 500;
  const a = Array.from({ length: m }, (_, i) => scrambleIndex(i, m, 1));
  const b = Array.from({ length: m }, (_, i) => scrambleIndex(i, m, 2));
  assert.notDeepEqual(a, b, 'different seeds, same permutation — b never mixed in');
  assert.deepEqual(new Set(b), new Set(a), 'the image must stay [0, m)');
});

test('uniqueIntValue stays in range, swaps inverted bounds, caps wide ranges', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 100; i++) {
    const v = uniqueIntValue(i, 7, 5, 104);
    assert.ok(v >= 5 && v <= 104, `${v} out of range`);
    seen.add(v);
  }
  assert.equal(seen.size, 100);
  // Inverted min/max are normalised rather than producing a negative m.
  assert.equal(uniqueIntValue(0, 7, 104, 5), uniqueIntValue(0, 7, 5, 104));
  // A BIGINT-wide range is served by its first SCRAMBLE_M_CAP values: still
  // inside the range, still a bijection, still f64-exact.
  for (let i = 0; i < 50; i++) {
    const v = uniqueIntValue(i, 3, 0, Number.MAX_SAFE_INTEGER);
    assert.ok(v >= 0 && v < SCRAMBLE_M_CAP, `${v} escaped the capped window`);
  }
});

test('uniqueDecimalValue lands on the 2-decimal grid inside the range', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 201; i++) {
    const v = uniqueDecimalValue(i, 11, 0.5, 2.5);
    assert.ok(v >= 0.5 && v <= 2.5, `${v} out of range`);
    assert.equal(Math.round(v * 100) / 100, v, `${v} is not on the grid`);
    seen.add(v);
  }
  assert.equal(seen.size, 201, 'the grid has 201 values; all must be distinct');
});

// ── the string tag ──────────────────────────────────────────────────────────

test('the tag is zero-padded to the width of the last row number', () => {
  assert.equal(uniqueTagWidth(1), 1);
  assert.equal(uniqueTagWidth(15), 2);
  assert.equal(uniqueTagWidth(2_500), 4);
  assert.equal(uniqueTag(0, 1), '0');
  assert.equal(uniqueTag(7, 15), '07');
  assert.equal(uniqueTag(7, 2_500), '0007');
  assert.equal(uniqueTag(2_499, 2_500), '2499');
  // Sortable: lexicographic order is row order.
  const tags = Array.from({ length: 2_500 }, (_, i) => uniqueTag(i, 2_500));
  assert.deepEqual([...tags].sort(), tags);
});

test('parenLen reads the declared width like the Rust twin', () => {
  assert.equal(parenLen('VARCHAR(20)'), 20);
  assert.equal(parenLen('char(8)'), 8);
  assert.equal(parenLen('DECIMAL(10,2)'), null);
  assert.equal(parenLen('BIGINT'), null);
});

test('applyUniqueStr tags before the @ and truncates the base, never the tag', () => {
  assert.equal(applyUniqueStr('a.b@example.com', 3, 15, 'VARCHAR(255)'), 'a.b.03@example.com');
  assert.equal(applyUniqueStr('ABC', 7, 2_500, 'VARCHAR(20)'), 'ABC_0007');
  // 17-char base + `_0007` = 22 > VARCHAR(20): two chars off the LEFT edge.
  assert.equal(applyUniqueStr('978-12-34567-89-0', 7, 2_500, 'VARCHAR(20)'), '8-12-34567-89-0_0007');
  // No declared width → no truncation.
  assert.equal(applyUniqueStr('x', 0, 5, 'TEXT'), 'x_0');
});

// ── generateRows end to end ─────────────────────────────────────────────────

test('generateRows applies unique — the flag used to be dropped entirely (BUG 2)', () => {
  const unique = generateRows([col('n', 'INT', 'int', P({ min: 1, max: 50 }), true)], 50, 9);
  assert.equal(new Set(unique.map(r => r[0])).size, 50);
  // The non-unique run of 50 rows over 50 values WILL collide, and its draws
  // are the same ones the unique run made (uniqueness consumes no RNG).
  const plain = generateRows([col('n', 'INT', 'int', P({ min: 1, max: 50 }), false)], 50, 9);
  assert.ok(new Set(plain.map(r => r[0])).size < 50, 'fixture assumption: the plain run collides');
});

test('a unique constant column still differs per row', () => {
  const spec = col('c', 'VARCHAR(30)', 'constant', P({ prefix: 'T-' }), true);
  const rows = generateRows([spec], 12, 3);
  assert.equal(new Set(rows.map(r => r[0])).size, 12);
  assert.equal(rows[0][0], 'T-_00');
  assert.equal(rows[11][0], 'T-_11');
});

test('intrinsic-domain generators scramble over their real domain', () => {
  // rating ignores min/max: unique ratings must stay in 1..5, not [1,1000].
  const rows = generateRows([col('r', 'INT', 'rating', P(), true)], 5, 4);
  assert.deepEqual(new Set(rows.map(r => r[0])), new Set([1, 2, 3, 4, 5]));
  // percent: 0..100 at 1 decimal → 1001 distinct values.
  const pct = generateRows([col('p', 'DECIMAL(5,1)', 'percent', P(), true)], 1001, 4);
  assert.equal(new Set(pct.map(r => r[0])).size, 1001);
  assert.ok(pct.every(r => (r[0] as number) >= 0 && (r[0] as number) <= 100));
});

test('booleans and sequence/cycle pass through the unique application', () => {
  const spec = col('b', 'BOOLEAN', 'bool', P(), true);
  const v = applyUnique(spec, true, 3, 10, 1);
  assert.equal(v, true, 'a boolean cannot be scrambled — the panel warns instead');
  const seq = col('s', 'BIGINT', 'sequence', P({ step: 2 }), true);
  assert.equal(applyUnique(seq, 7, 3, 10, 1), 7, 'a sequence is unique already');
});

// ── the cycle generator ─────────────────────────────────────────────────────

test('cycleLength is the list length or the stepped range size', () => {
  assert.equal(cycleLength(P({ list: 'a,b,c' })), 3);
  assert.equal(cycleLength(P({ list: 'a, b ,c,' })), 3);   // whitespace/empties trimmed
  assert.equal(cycleLength(P({ list: '', min: 5, max: 25, step: 5 })), 5);
  assert.equal(cycleLength(P({ list: '', min: 0, max: 9, step: 3 })), 4);
  assert.equal(cycleLength(P({ list: '', min: 1, max: 1 })), 1);
});

test('jitter stays within its bound and is reproducible', () => {
  const spec = col('c', 'VARCHAR(10)', 'cycle', P({ list: 'a,b,c,d,e,f', jitterPct: 30 }));
  const rows = generateRows([spec], 200, 77).map(r => r[0] as string);
  // 30% of 6 → a shift of at most 1 position forward.
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const [i, v] of rows.entries()) {
    const ahead = (items.indexOf(v) + 6 - (i % 6)) % 6;
    assert.ok(ahead <= 1, `row ${i}: ${v} jumped ${ahead} positions`);
  }
  assert.deepEqual(generateRows([spec], 200, 77), generateRows([spec], 200, 77));
});

test('jitter of zero never touches the RNG stream', () => {
  // A trailing int column must be identical with and without a jitterless
  // cycle column before it — a stray draw would shift the whole stream.
  const withCycle = generateRows(
    [col('c', 'VARCHAR(4)', 'cycle', P({ list: 'a,b' })), col('n', 'INT', 'int', P())], 20, 5);
  const without = generateRows([col('n', 'INT', 'int', P())], 20, 5);
  assert.deepEqual(withCycle.map(r => r[1]), without.map(r => r[0]));
});

test('cycle has a deterministic SQL form per engine (MOD, not a random pick)', () => {
  const spec = col('c', 'VARCHAR(10)', 'cycle', P({ list: 'a,b,c' }));
  assert.equal(valueSql('mysql', 'cycle', spec), "ELT((MOD(((i - 1)), 3)) + 1, 'a', 'b', 'c')");
  assert.equal(valueSql('postgres', 'cycle', spec), "(ARRAY['a', 'b', 'c'])[(MOD(((i - 1)), 3)) + 1]");
  assert.match(valueSql('sqlserver', 'cycle', spec)!, /JSON_VALUE\('\["a","b","c"\]', '\$\[' \+ CAST\(\(\(\(\(i - 1\)\) % 3\)\) AS varchar\(10\)\)/);
  // The range form: min + position × step.
  const range = col('c', 'INT', 'cycle', P({ list: '', min: 5, max: 25, step: 5 }));
  assert.equal(valueSql('mysql', 'cycle', range), '(5 + MOD(((i - 1)), 5) * 5)');
  assert.equal(valueSql('postgres', 'cycle', range), '(5 + MOD(((i - 1)), 5) * 5)');
  // Jitter adds a bounded random shift.
  const jittered = col('c', 'VARCHAR(10)', 'cycle', P({ list: 'a,b,c', jitterPct: 50 }));
  assert.match(valueSql('mysql', 'cycle', jittered)!, /MOD\(\(\(i - 1\) \+ FLOOR\(RAND\(\) \* 0\.5 \* 3\)\), 3\)/);
});

// ── the server-side uniqueness spelling ─────────────────────────────────────

test('uniqueSqlWrap: the int scramble is shared-constant SQL', () => {
  const spec = col('n', 'INT', 'int', P({ min: 10, max: 29 }), true);
  // m = 20, a = 2097151, b = 42 % 20 = 2 — the same permutation as the engines.
  assert.equal(uniqueSqlWrap('mysql', spec, '(1 + FLOOR(RAND() * 20))', 'i', 1000, 42),
    '(10 + MOD((2097151 * (i - 1) + 2), 20))');
  assert.equal(uniqueSqlWrap('sqlserver', spec, 'x', 'i', 1000, 42),
    '(10 + ((2097151 * (i - 1) + 2) % 20))');
});

test('uniqueSqlWrap: decimals divide by a decimal literal (T-SQL int/int would truncate)', () => {
  const spec = col('d', 'DECIMAL(10,2)', 'decimal', P({ min: 1, max: 2 }), true);
  // m = round((2 − 1) × 100) + 1 = 101, a = 2097151, b = 42.
  assert.equal(uniqueSqlWrap('mysql', spec, 'x', 'i', 1000, 42),
    'ROUND(1 + ((0 + MOD((2097151 * (i - 1) + 42), 101))) / 100.0, 2)');
  assert.equal(uniqueSqlWrap('postgres', spec, 'x', 'i', 1000, 42),
    'round((1 + ((0 + MOD((2097151 * (i - 1) + 42), 101)))::numeric / 100.0)::numeric, 2)');
  // percent's server arm is 0–100 at one decimal, so its capacity is too.
  const pct = col('p', 'DECIMAL(5,1)', 'percent', P(), true);
  assert.match(uniqueSqlWrap('mysql', pct, 'x', 'i', 1000, 42)!, /MOD\(.+, 1001\)/);
});

test('uniqueSqlWrap: strings get the padded tag with a RIGHT() ceiling', () => {
  const spec = col('c', 'VARCHAR(20)', 'choice', P({ list: 'x,y' }), true);
  // total 300,000 → width 6.
  assert.equal(uniqueSqlWrap('mysql', spec, 'base', 'i', 300_000, 1),
    "RIGHT(CONCAT(base, '_', LPAD(CAST((i - 1) AS CHAR), 6, '0')), 20)");
  assert.equal(uniqueSqlWrap('postgres', spec, 'base', 'i', 300_000, 1),
    "RIGHT(base || '_' || LPAD(((i - 1))::text, 6, '0'), 20)");
  assert.match(uniqueSqlWrap('sqlserver', spec, 'base', 'i', 300_000, 1)!,
    /^RIGHT\(CONCAT\(base, '_', RIGHT\('0000000000' \+ CAST\(\(\(i - 1\)\) AS nvarchar\(10\)\), 6\)\), 20\)$/);
});

test('uniqueSqlWrap: passthrough and refusals are exactly the documented sets', () => {
  const base = 'BASE';
  for (const g of ['sequence', 'email', 'username', 'uuid']) {
    assert.equal(uniqueSqlWrap('mysql', col('c', 'TEXT', g, P(), true), base, 'i', 1000, 1), base, g);
  }
  for (const g of ['bool', 'date', 'timestamp', 'latitude', 'longitude']) {
    assert.equal(uniqueSqlWrap('mysql', col('c', 'TEXT', g, P(), true), base, 'i', 1000, 1), null, g);
  }
  // cycle: unique while the run fits in one lap.
  const cyc = col('c', 'VARCHAR(10)', 'cycle', P({ list: 'a,b,c' }), true);
  assert.equal(uniqueSqlWrap('mysql', cyc, base, 'i', 3, 1), base);
  assert.equal(uniqueSqlWrap('mysql', cyc, base, 'i', 4, 1), null);
  // a one-value int range cannot be unique past row 1.
  const one = col('n', 'INT', 'int', P({ min: 7, max: 7 }), true);
  assert.equal(uniqueSqlWrap('mysql', one, base, 'i', 100, 1), null);
});

test('refusal reasons name the obstacle', () => {
  assert.equal(uniqueSqlRefusalReason(col('b', 'BOOLEAN', 'bool', P(), true), 10), 'a boolean has two values');
  assert.equal(uniqueSqlRefusalReason(col('c', 'T', 'cycle', P({ list: 'a,b' }), true), 300_000),
    'a cycle of 2 value(s) repeats within 300,000 rows');
  assert.equal(uniqueSqlRefusalReason(col('n', 'INT', 'int', P({ min: 7, max: 7 }), true), 10),
    'the configured range holds a single value');
  assert.equal(uniqueSqlRefusalReason(col('d', 'DATE', 'date', P(), true), 10),
    'uniqueness has no faithful server-side form for this generator');
});

test('the seed reaches the server scramble (different b, same shape)', () => {
  const spec = col('n', 'INT', 'int', P({ min: 10, max: 29 }), true);
  const a = buildServerPlan('mysql', 't', [spec], 300_000, undefined, 'default', 1);
  const b = buildServerPlan('mysql', 't', [spec], 300_000, undefined, 'default', 2);
  assert.notEqual(a.statements[0], b.statements[0]);
  assert.match(a.statements[0], /\+ 1\), 20\)/);
  assert.match(b.statements[0], /\+ 2\), 20\)/);
});

// ── step-3 honesty: the per-column note ─────────────────────────────────────

test('uniqueRowReason names every unguaranteeable case and stays quiet otherwise', () => {
  // guaranteed → null
  assert.equal(uniqueRowReason(col('id', 'BIGINT', 'sequence', P(), true), 1e9), null);
  assert.equal(uniqueRowReason(col('e', 'VARCHAR(255)', 'email', P(), true), 1e9), null);
  assert.equal(uniqueRowReason(col('n', 'INT', 'int', P({ min: 1, max: 1000 }), true), 1000), null);
  assert.equal(uniqueRowReason(col('c', 'T', 'cycle', P({ list: 'a,b' }), true), 2), null);
  assert.equal(uniqueRowReason(col('b', 'BOOLEAN', 'bool', P(), true), 2), null);
  // not guaranteed → a reason
  assert.match(uniqueRowReason(col('b', 'BOOLEAN', 'bool', P(), true), 3)!, /two values/);
  assert.match(uniqueRowReason(col('c', 'T', 'cycle', P({ list: 'a,b' }), true), 3)!, /repeats from row 3/);
  assert.match(uniqueRowReason(col('n', 'INT', 'int', P({ min: 1, max: 10 }), true), 11)!, /11 rows/);
  assert.match(uniqueRowReason(col('d', 'DATE', 'date', P(), true), 5)!, /_NNN tag/);
  assert.match(uniqueRowReason(col('f', 'INT', 'fk', P(), true), 5)!, /parent pool/);
  assert.match(uniqueRowReason(col('h', 'INT', 'httpStatus', P(), true), 8)!, /seven HTTP status/);
  // no flag → no note
  assert.equal(uniqueRowReason(col('b', 'BOOLEAN', 'bool', P(), false), 1e9), null);
});

// ── the SQLite decision (Phase 0) ───────────────────────────────────────────

test('SQLite is not routed to the server path — the row-by-row writer has no arm for it', () => {
  // shouldUseServer used to list sqlite while engineCaps.sqlite.dataGen is
  // false: an unreachable arm. The valueSql/rowSource SQLite forms stay as
  // tested library functions; only the routing was drift.
  assert.equal(shouldUseServer('sqlite', 1_000_000_000), false);
  assert.equal(shouldUseServer('mysql', 1_000_000_000), true);
  assert.equal(shouldUseServer('sqlserver', 1_000_000_000), true);
});
