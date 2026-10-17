/**
 * The TxShell `\generate` spec file (src/utils/generateSpec.ts): valid specs
 * parse with the documented defaults, params merge over DEFAULT_PARAMS (the
 * Rust wire format requires a complete GenParams), and every error class is
 * collected rather than thrown at the first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGenerateSpec, GENERATE_MAX_ROWS } from '../src/utils/generateSpec.ts';
import { DEFAULT_PARAMS } from '../src/utils/datagen.ts';

const MINIMAL = JSON.stringify({
  table: 'shop.customers',
  rowCount: 1000,
  specs: [
    { name: 'id', typeName: 'BIGINT', generator: 'sequence', unique: true },
    { name: 'email', typeName: 'VARCHAR(255)', generator: 'email', params: { nullPct: 5 } },
  ],
});

test('a minimal spec parses with the documented defaults', () => {
  const r = parseGenerateSpec(MINIMAL);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.spec.table, 'shop.customers');
  assert.equal(r.spec.rowCount, 1000);
  assert.equal(r.spec.seed, 1);            // scripts default to reproducible
  assert.equal(r.spec.locale, 'default');
  assert.equal(r.spec.useCopy, true);
  assert.equal(r.spec.createDdl, null);
  assert.equal(r.spec.specs.length, 2);
  assert.equal(r.spec.specs[0].unique, true);
  assert.equal(r.spec.specs[1].unique, undefined);
});

test('params merge over DEFAULT_PARAMS — the wire format wants a complete set', () => {
  const r = parseGenerateSpec(MINIMAL);
  assert.ok(r.ok);
  if (!r.ok) return;
  const email = r.spec.specs[1];
  assert.equal(email.params.nullPct, 5);              // from the spec
  assert.equal(email.params.min, DEFAULT_PARAMS.min); // defaulted
  assert.equal(email.params.list, DEFAULT_PARAMS.list);
});

test('a full spec round-trips every field', () => {
  const r = parseGenerateSpec(JSON.stringify({
    table: '`shop`.`orders`', rowCount: 5e6, seed: 42, locale: 'cs',
    useCopy: false, createDdl: 'CREATE TABLE `shop`.`orders` (id BIGINT)',
    specs: [{ name: 'n', typeName: 'INT', generator: 'int', params: { min: 1, max: 9 } }],
  }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.spec.seed, 42);
  assert.equal(r.spec.locale, 'cs');
  assert.equal(r.spec.useCopy, false);
  assert.match(r.spec.createDdl ?? '', /CREATE TABLE/);
  assert.equal(r.spec.specs[0].params.max, 9);
});

test('not JSON / not an object', () => {
  const r1 = parseGenerateSpec('{oops');
  assert.ok(!r1.ok && /not valid JSON/.test(r1.errors[0]));
  const r2 = parseGenerateSpec('42');
  assert.ok(!r2.ok && /JSON object/.test(r2.errors[0]));
});

test('table and rowCount are required and bounded', () => {
  const r = parseGenerateSpec(JSON.stringify({ rowCount: 10, specs: [{ name: 'a', typeName: 'INT', generator: 'int' }] }));
  assert.ok(!r.ok && r.errors.some(e => /^table:/.test(e)));

  for (const [rc, re] of [
    ['ten', /must be an integer/],
    [0, /outside 1/],
    [1e16, /outside 1/],
  ] as [unknown, RegExp][]) {
    const rr = parseGenerateSpec(JSON.stringify({
      table: 't', rowCount: rc, specs: [{ name: 'a', typeName: 'INT', generator: 'int' }],
    }));
    assert.ok(!rr.ok && rr.errors.some(e => re.test(e)), `${re} for rowCount=${rc}`);
  }
  assert.ok(Number.isInteger(GENERATE_MAX_ROWS));
});

test('column specs: missing fields, duplicates, unknown generator', () => {
  const noSpecs = parseGenerateSpec(JSON.stringify({ table: 't', rowCount: 1, specs: [] }));
  assert.ok(!noSpecs.ok && noSpecs.errors.some(e => /specs: at least one/.test(e)));

  const r = parseGenerateSpec(JSON.stringify({
    table: 't', rowCount: 1,
    specs: [
      { name: 'a', typeName: 'INT' },                       // missing generator
      { name: 'a', generator: 'int' },                      // duplicate + missing typeName
      { name: 'b', typeName: 'INT', generator: 'randoom' }, // unknown generator
    ],
  }));
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(r.errors.some(e => /a: missing generator/.test(e)));
  assert.ok(r.errors.some(e => /a: duplicate column name/.test(e)));
  assert.ok(r.errors.some(e => /a: missing typeName/.test(e)));
  assert.ok(r.errors.some(e => /unknown generator "randoom"/.test(e)));
});

test('params type errors and sanitizer warnings both fail the spec', () => {
  const r = parseGenerateSpec(JSON.stringify({
    table: 't', rowCount: 1,
    specs: [
      { name: 'a', typeName: 'INT', generator: 'int', params: { min: 'low' } },
      { name: 'b', typeName: 'INT', generator: 'int', params: { nullPct: 500 } },
      { name: 'c', typeName: 'INT', generator: 'int', params: { typo: 1 } },
    ],
  }));
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(r.errors.some(e => /a: param "min" must be a finite number/.test(e)));
  // In a file there is nobody to notice a clamp, so it is an error here.
  assert.ok(r.errors.some(e => /b: nullPct 500 clamped to 100/.test(e)));
  assert.ok(r.errors.some(e => /c: unknown param "typo"/.test(e)));
});

test('unique and seed must have their types', () => {
  const r = parseGenerateSpec(JSON.stringify({
    table: 't', rowCount: 1, seed: -3,
    specs: [{ name: 'a', typeName: 'INT', generator: 'int', unique: 'yes' }],
  }));
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(r.errors.some(e => /seed: must be a non-negative integer/.test(e)));
  assert.ok(r.errors.some(e => /unique must be true or false/.test(e)));
});
