/**
 * Server-side generation (src/utils/datagenSql.ts).
 *
 * The in-browser generator builds every row in JavaScript and ships it back as
 * SQL text. That is right up to a few hundred thousand rows and hopeless past
 * it — a hundred million rows means a hundred million values built in one VM,
 * serialised, pushed through IPC and parsed again. For volume the work has to
 * happen where the data lands.
 *
 * Four things decide whether that works, and each has tests below:
 *
 *  - the row source must actually produce N rows **on that engine** — MySQL's
 *    recursive CTE dies at 1000 by default, which is the trap here;
 *  - the offset must carry across chunks, or a `sequence` primary key restarts
 *    at 1 in chunk two and the insert dies on a duplicate key;
 *  - chunking must bound the transaction, or cancel means an hour of rollback;
 *  - a generator with no faithful SQL form must be *reported*, not approximated
 *    into data that quietly differs from what the same generator produces at
 *    small sizes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZINGS, estimateBytes, formatBytes, chunkSize, planChunks, rowSource,
  valueSql, buildServerPlan, shouldUseServer, SERVER_THRESHOLD, rowSourceCapacity } from '../src/utils/datagenSql.ts';
import { DEFAULT_PARAMS } from '../src/utils/datagen.ts';
import type { ColumnSpec } from '../src/utils/datagen.ts';

const col = (name: string, typeName: string, generator: string): ColumnSpec =>
  ({ name, typeName, generator, params: { ...DEFAULT_PARAMS } });

const SPECS = [
  col('id', 'bigint', 'sequence'),
  col('name', 'varchar(80)', 'fullName'),
  col('city', 'varchar(60)', 'city'),
  col('score', 'int', 'int'),
];

// ── the ladder ──────────────────────────────────────────────────────────────

test('the ladder has more than ten rungs and reaches a billion rows', () => {
  assert.ok(SIZINGS.length >= 10, `${SIZINGS.length} sizings`);
  assert.equal(SIZINGS[SIZINGS.length - 1].rows, 1_000_000_000);
  // Monotonic, or the picker is a lottery.
  for (let i = 1; i < SIZINGS.length; i++) {
    assert.ok(SIZINGS[i].rows > SIZINGS[i - 1].rows, SIZINGS[i].id);
  }
});

test('everything past the in-browser threshold is marked server-only', () => {
  for (const s of SIZINGS) {
    if (s.rows >= SERVER_THRESHOLD) assert.equal(s.serverOnly, true, s.id);
  }
});

test('the size estimate reaches tens of GB, which is the point', () => {
  const bytes = estimateBytes(SPECS, 250_000_000);
  assert.ok(bytes > 10 * 1024 ** 3, formatBytes(bytes));
  assert.match(formatBytes(bytes), /GiB/);
});

test('a wider row estimates larger, and the units read sensibly', () => {
  const narrow = estimateBytes([col('id', 'int', 'sequence')], 1_000_000);
  const wide = estimateBytes([col('id', 'int', 'sequence'), col('t', 'text', 'words')], 1_000_000);
  assert.ok(wide > narrow * 2);
  assert.match(formatBytes(1024 ** 2 * 5), /MiB/);
  assert.match(formatBytes(1024 ** 4 * 2), /TiB/);
});

// ── chunking ────────────────────────────────────────────────────────────────

test('chunks are bounded, and a wide row gets fewer per chunk', () => {
  const narrow = chunkSize([col('id', 'int', 'sequence')], 100_000_000);
  const wide = chunkSize([col('t', 'text', 'words'), col('u', 'text', 'words')], 100_000_000);
  assert.ok(wide < narrow, 'width has to shrink the chunk or the transaction grows with it');
  assert.ok(narrow <= 1_000_000);
  assert.ok(wide >= 10_000);
});

test('the chunk plan covers every row exactly once', () => {
  for (const total of [1, 999, 100_000, 1_000_000, 7_777_777]) {
    const p = planChunks(SPECS, total);
    assert.equal((p.chunks - 1) * p.chunkRows + p.lastChunkRows, total, `total ${total}`);
    assert.ok(p.lastChunkRows > 0 && p.lastChunkRows <= p.chunkRows, `total ${total}`);
  }
});

// ── the row source, per engine ──────────────────────────────────────────────

test('MySQL uses cross-joined digits, NOT a recursive CTE', () => {
  // The trap: cte_max_recursion_depth defaults to 1000, so the obvious
  // recursive version fails at a thousand rows — and raising it means setting
  // a session variable the user did not ask for.
  const sql = rowSource('mysql', 1_000_000, 0);
  assert.doesNotMatch(sql, /RECURSIVE/i);
  assert.match(sql, /CROSS JOIN/);
  // Deterministic bound: a WHERE on the digit expression, never a bare LIMIT
  // — an unordered LIMIT leaves WHICH rows survive unspecified, so sequence
  // chunks could overlap or gap (WP-08 8.3).
  assert.match(sql, /WHERE \(.+\) < 1000000$/);
  assert.doesNotMatch(sql, /LIMIT/);
});

test('MySQL sequence chunks cannot overlap: chunk N and N+1 ranges are disjoint and exact', () => {
  // The i values a chunk's row source yields are from+1 … from+count, exactly
  // once each — provable from the WHERE bound: expr enumerates 0…10^k-1 and
  // survives iff expr < count.
  const a = rowSource('mysql', 1000, 0);
  const b = rowSource('mysql', 1000, 1000);
  assert.match(a, /SELECT 1 \+ \(/);
  assert.match(b, /SELECT 1001 \+ \(/);
  assert.match(a, /< 1000$/);
  assert.match(b, /< 1000$/);
});

test('PostgreSQL uses generate_series over the right window', () => {
  assert.match(rowSource('postgres', 1000, 0), /generate_series\(1, 1000\)/);
  assert.match(rowSource('postgres', 1000, 5000), /generate_series\(5001, 6000\)/);
});

test('SQLite uses a recursive CTE, which it has no limit on', () => {
  const sql = rowSource('sqlite', 500, 100);
  assert.match(sql, /WITH RECURSIVE/);
  assert.match(sql, /SELECT 101/);
  assert.match(sql, /i < 600/);
});

test('the offset carries across chunks on every engine', () => {
  // Without this a `sequence` primary key restarts at 1 in chunk two and the
  // whole run dies on a duplicate key — after the first chunk has committed.
  for (const engine of ['mysql', 'postgres', 'sqlite']) {
    const first = rowSource(engine, 1000, 0);
    const second = rowSource(engine, 1000, 1000);
    assert.notEqual(first, second, `${engine} produced the same rows twice`);
    assert.ok(second.includes('1001'), `${engine} second chunk must start at 1001`);
  }
});

// ── value expressions ───────────────────────────────────────────────────────

test('a sequence column is the row number, not a random value', () => {
  for (const engine of ['mysql', 'postgres', 'sqlite']) {
    assert.equal(valueSql(engine, 'sequence', SPECS[0]), 'i', engine);
  }
});

test('each engine gets its own random primitive', () => {
  assert.match(valueSql('mysql', 'int', SPECS[3])!, /RAND\(\)/);
  assert.match(valueSql('postgres', 'int', SPECS[3])!, /random\(\)/);
  assert.match(valueSql('sqlite', 'int', SPECS[3])!, /RANDOM\(\)/);
});

test('picking from a list uses the construct each engine actually has', () => {
  assert.match(valueSql('mysql', 'city', SPECS[2])!, /ELT\(/);
  assert.match(valueSql('postgres', 'city', SPECS[2])!, /ARRAY\[/);
  // SQLite has neither ELT nor arrays.
  assert.match(valueSql('sqlite', 'city', SPECS[2])!, /json_extract/);
});

test('the locale arg inlines that locale head into the server SQL', () => {
  // The server path inlines a bounded head per list; a Czech run must inline
  // Czech cities, a default run the default head — proving locale threads all
  // the way to the emitted literal.
  const czCity = valueSql('mysql', 'city', SPECS[2], 'i', undefined, 'cs-CZ')!;
  assert.match(czCity, /Praha/, 'cs-CZ city SQL has no Czech city');
  const jaCity = valueSql('postgres', 'city', SPECS[2], 'i', undefined, 'ja-JP')!;
  assert.match(jaCity, /東京/, 'ja-JP city SQL has no kanji city');
  // Default is unchanged: it inlines the default head (Prague), not Czech.
  const defCity = valueSql('mysql', 'city', SPECS[2])!;
  assert.match(defCity, /Prague/);
  assert.doesNotMatch(defCity, /Praha/);
  // buildServerPlan threads it through to the statements too.
  const plan = buildServerPlan('mysql', '`t`', [SPECS[2]], 1000, undefined, 'cs-CZ');
  assert.ok(plan.statements[0].includes('Praha'), 'plan did not use the cs-CZ head');
});

test('a generator with no faithful SQL form returns null rather than an approximation', () => {
  // Inventing one would produce data that silently differs from what the same
  // generator produces at smaller sizes.
  assert.equal(valueSql('mysql', 'uuid', col('u', 'char(36)', 'uuid')), null);
  assert.equal(valueSql('sqlite', 'uuid', col('u', 'char(36)', 'uuid')), null);
  // PostgreSQL has one built in — but only since 13, where `gen_random_uuid()`
  // became core. On 12 it lives in pgcrypto, so calling it would fail mid-run
  // with earlier chunks already committed. Unknown version counts as
  // unsupported: fall back to the path that works everywhere.
  assert.equal(valueSql('postgres', 'uuid', col('u', 'uuid', 'uuid')), null,
    'no version given — must not assume 13+');
  assert.equal(valueSql('postgres', 'uuid', col('u', 'uuid', 'uuid'), 'i', 120_000), null,
    'PostgreSQL 12 needs pgcrypto for it');
  assert.equal(valueSql('postgres', 'uuid', col('u', 'uuid', 'uuid'), 'i', 130_000),
    'gen_random_uuid()');

  assert.equal(valueSql('postgres', 'fk', col('f', 'int', 'fk')), null);
  assert.equal(valueSql('postgres', 'regex', col('r', 'text', 'regex')), null);
});

test('string values are escaped, not interpolated', () => {
  const spec = col('c', 'text', 'choice');
  spec.params.list = "O'Brien, Smith";
  const sql = valueSql('postgres', 'choice', spec)!;
  assert.match(sql, /'O''Brien'/);
});

// ── the statement ───────────────────────────────────────────────────────────

test('the plan is one INSERT … SELECT per chunk, and sends no rows', () => {
  const plan = buildServerPlan('postgres', '"public"."t"', SPECS, 5_000_000);
  assert.ok(plan.chunks > 1);
  assert.equal(plan.statements.length, plan.chunks);
  for (const s of plan.statements) {
    assert.match(s, /^INSERT INTO "public"\."t" \("id", "name", "city", "score"\)/);
    assert.match(s, /SELECT /);
    assert.match(s, /FROM \(SELECT gs AS i FROM generate_series/);
    // The whole point: no row data in the statement.
    assert.doesNotMatch(s, /VALUES/);
  }
  // A statement that inserts a million rows is a few hundred bytes.
  assert.ok(plan.statements[0].length < 2000, `${plan.statements[0].length} bytes`);
});

test('consecutive chunks continue the sequence', () => {
  const plan = buildServerPlan('postgres', 't', [col('id', 'bigint', 'sequence')], 3_000_000);
  const first = /generate_series\((\d+), (\d+)\)/.exec(plan.statements[0])!;
  const second = /generate_series\((\d+), (\d+)\)/.exec(plan.statements[1])!;
  assert.equal(Number(second[1]), Number(first[2]) + 1);
});

test('an unsupported generator stops the plan and names the column', () => {
  const plan = buildServerPlan('mysql', 't', [
    col('id', 'bigint', 'sequence'),
    col('ref', 'char(36)', 'uuid'),
  ], 1_000_000);
  assert.deepEqual(plan.statements, []);
  assert.deepEqual(plan.unsupported, [{ column: 'ref', generator: 'uuid' }]);
});

test('column names are quoted per engine', () => {
  const specs = [col('order', 'int', 'sequence')];   // a reserved word
  assert.match(buildServerPlan('mysql', 't', specs, 1000).statements[0], /`order`/);
  assert.match(buildServerPlan('postgres', 't', specs, 1000).statements[0], /"order"/);
});

// ── when to use it ──────────────────────────────────────────────────────────

test('small runs stay in the browser, where they are reproducible', () => {
  assert.equal(shouldUseServer('postgres', 1000), false);
  assert.equal(shouldUseServer('postgres', SERVER_THRESHOLD), true);
});

test('an engine without a row source is never sent down this path', () => {
  assert.equal(shouldUseServer('clickhouse', 10_000_000), false);
  assert.equal(shouldUseServer('redis', 10_000_000), false);
});

test('dates land inside the configured window, not a fixed guess', () => {
  // Caught by running it: a hard-coded five-year span put generated dates two
  // years past `dateTo` — data that differs from what the same spec produces
  // on the in-browser path, which is the silent divergence the `null` rule
  // above exists to prevent, committed in the one generator that had a range.
  const spec = col('d', 'date', 'date');
  spec.params.dateFrom = '2024-01-01';
  spec.params.dateTo = '2024-01-11';          // ten days
  for (const engine of ['mysql', 'postgres', 'sqlite']) {
    const sql = valueSql(engine, 'date', spec)!;
    assert.match(sql, /2024-01-01/, engine);
    assert.match(sql, /\b10\b/, `${engine} must span the configured ten days`);
    assert.doesNotMatch(sql, /1825/, `${engine} still has the hard-coded span`);
  }
});

test('a zero-length date range does not divide by zero', () => {
  const spec = col('d', 'date', 'date');
  spec.params.dateFrom = spec.params.dateTo = '2024-01-01';
  for (const engine of ['mysql', 'postgres', 'sqlite']) {
    assert.ok(valueSql(engine, 'date', spec), engine);
  }
});

// ── chunking invariants ─────────────────────────────────────────────────────

test('the MySQL row source always supplies more rows than the chunk asks for', () => {
  // It used to be a fixed seven digit tables — ten million rows — which
  // exceeds today's chunk clamp only by coincidence. Raising the clamp would
  // have produced short chunks silently: an insert reporting success while
  // writing fewer rows than asked.
  for (const n of [1, 999, 10_000, 780_335, 1_000_000, 10_000_000, 50_000_000]) {
    assert.ok(rowSourceCapacity('mysql', n) > n,
      `capacity ${rowSourceCapacity('mysql', n)} must exceed the ${n} requested`);
  }
});

test('the other engines have no ceiling to line up with', () => {
  assert.equal(rowSourceCapacity('postgres', 1e9), Number.POSITIVE_INFINITY);
  assert.equal(rowSourceCapacity('sqlite', 1e9), Number.POSITIVE_INFINITY);
});

test('a chunk never exceeds what any engine can supply, at every ladder rung', () => {
  const specs = [col('id', 'bigint', 'sequence'), col('t', 'varchar(80)', 'words')];
  for (const sizing of SIZINGS) {
    const p = planChunks(specs, sizing.rows);
    assert.ok(rowSourceCapacity('mysql', p.chunkRows) > p.chunkRows, sizing.id);
    // And the plan still covers the whole request.
    assert.equal((p.chunks - 1) * p.chunkRows + p.lastChunkRows, sizing.rows, sizing.id);
  }
});

test('a billion rows is many bounded chunks, not one enormous transaction', () => {
  // The property that makes cancel survivable: each chunk commits on its own,
  // so stopping leaves a usable table rather than an hour of rollback.
  const p = planChunks([col('id', 'bigint', 'sequence')], 1_000_000_000);
  assert.ok(p.chunks >= 1000, `${p.chunks} chunks`);
  assert.ok(p.chunkRows <= 1_000_000, `${p.chunkRows} rows per chunk`);
});

test('the plan refuses a uuid column unless the server is known to be 13+', () => {
  const specs = [col('id', 'bigint', 'sequence'), col('ref', 'uuid', 'uuid')];
  assert.deepEqual(buildServerPlan('postgres', 't', specs, 1_000_000).unsupported,
    [{ column: 'ref', generator: 'uuid' }]);
  assert.deepEqual(buildServerPlan('postgres', 't', specs, 1_000_000, 130_000).unsupported, []);
});

// ── Wave C Phase 4 — per-country country/countryCode + mixed fallback ─────────

test('country under a fixed pack emits a constant literal, default stays random', () => {
  const cz = valueSql('mysql', 'country', col('c', 'text', 'country'), 'i', undefined, 'cs-CZ');
  assert.equal(cz, "'Czechia'", `cs-CZ country should be a constant: ${cz}`);
  const gb = valueSql('postgres', 'countryCode', col('cc', 'char(2)', 'countryCode'), 'i', undefined, 'en-GB');
  assert.equal(gb, "'GB'", `en-GB countryCode should be a constant: ${gb}`);
  // default country keeps the random pick (an ELT/ARRAY over the head).
  const def = valueSql('mysql', 'country', col('c', 'text', 'country'))!;
  assert.match(def, /ELT\(/, 'default country should still be a random pick');
  // default countryCode has no compact set-based form → falls back.
  assert.equal(valueSql('mysql', 'countryCode', col('cc', 'char(2)', 'countryCode')), null);
});

test('mixed mode reports every locale-aware column unsupported (row-by-row fallback)', () => {
  for (const id of ['firstName', 'fullName', 'city', 'country', 'countryCode', 'company', 'phone', 'postcode', 'address']) {
    assert.equal(valueSql('mysql', id, col('x', 'text', id), 'i', undefined, 'mixed'), null,
      `${id} should be unsupported under mixed`);
  }
  // A non-locale column is still fine under mixed — it is coherent regardless.
  assert.equal(valueSql('mysql', 'sequence', col('id', 'bigint', 'sequence'), 'i', undefined, 'mixed'), 'i');
  // A table with a locale-aware column under mixed falls back wholesale.
  const specs = [col('id', 'bigint', 'sequence'), col('city', 'varchar(60)', 'city')];
  const plan = buildServerPlan('mysql', 't', specs, 1_000_000, undefined, 'mixed');
  assert.deepEqual(plan.unsupported, [{ column: 'city', generator: 'city' }]);
  assert.equal(plan.statements.length, 0);
});
