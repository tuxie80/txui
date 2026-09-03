/**
 * Standards-based generators (Wave C Phase 3).
 *
 * Each family has a correct check-digit algorithm; every generator takes a
 * `valid` param (default true) and, when false, emits a structurally-shaped
 * value with a DELIBERATELY WRONG check digit. These tests do the check-digit
 * arithmetic independently (never by calling the generator's own helper), pin
 * an independently-known-good reference value per standard where one exists,
 * and assert that the invalid variant fails the very validator the valid one
 * passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERATOR_MAP, DEFAULT_PARAMS, makeRng, suggestGenerator } from '../src/utils/datagen.ts';
import type { GenParams } from '../src/utils/datagen.ts';

const P = (over: Partial<GenParams> = {}): GenParams => ({ ...DEFAULT_PARAMS, ...over });

function sample(id: string, p: GenParams, n = 200): string[] {
  const g = GENERATOR_MAP.get(id);
  assert.ok(g, `no generator ${id}`);
  const rng = makeRng(42);
  return Array.from({ length: n }, (_, i) => g.gen(rng, i, p, n) as string);
}

/** First value for a fixed seed — the cross-tier parity anchor (see Rust test). */
function firstOf(id: string, p: GenParams = P()): string {
  return sample(id, p, 1)[0];
}

// ── independent validators ───────────────────────────────────────────────────

function gs1Valid(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  const body = code.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === code.charCodeAt(code.length - 1) - 48;
}

function luhnValid(num: string): boolean {
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanValid(iban: string): boolean {
  const s = iban.slice(4) + iban.slice(0, 4);
  let mod = 0;
  for (const ch of s) {
    const d = /[0-9]/.test(ch) ? ch.charCodeAt(0) - 48 : ch.toUpperCase().charCodeAt(0) - 55;
    const str = String(d);
    for (let k = 0; k < str.length; k++) mod = (mod * 10 + (str.charCodeAt(k) - 48)) % 97;
  }
  return mod === 1;
}

function rodneValid(rc: string): boolean {
  if (!/^\d{10}$/.test(rc)) return false;
  let m = 0;
  for (const ch of rc) m = (m * 10 + (ch.charCodeAt(0) - 48)) % 11;
  return m === 0;
}

const NINO_DISALLOWED = ['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ'];
function ninoValid(nino: string): boolean {
  if (!/^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(nino)) return false;
  return !NINO_DISALLOWED.includes(nino.slice(0, 2));
}

function myNumberValid(mn: string): boolean {
  if (!/^\d{12}$/.test(mn)) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const pn = mn.charCodeAt(11 - n) - 48;
    const qn = n <= 6 ? n + 1 : n - 5;
    sum += pn * qn;
  }
  const r = sum % 11;
  return (r <= 1 ? 0 : 11 - r) === mn.charCodeAt(11) - 48;
}

function czVatValid(vat: string): boolean {
  if (!/^CZ\d{8}$/.test(vat)) return false;
  const d = vat.slice(2);
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (d.charCodeAt(i) - 48) * (8 - i);
  const m = sum % 11;
  const check = m === 0 ? 1 : m === 1 ? 0 : 11 - m;
  return check === d.charCodeAt(7) - 48;
}

function gbVatValid(vat: string): boolean {
  if (!/^\d{9}$/.test(vat)) return false;
  const w = [8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (vat.charCodeAt(i) - 48) * w[i];
  sum += (vat.charCodeAt(7) - 48) * 10 + (vat.charCodeAt(8) - 48);
  return sum % 97 === 0;
}

function jpCorpValid(cn: string): boolean {
  if (!/^\d{13}$/.test(cn)) return false;
  const body = cn.slice(1);
  let sum = 0;
  for (let n = 1; n <= 12; n++) {
    const pn = body.charCodeAt(12 - n) - 48;
    const qn = n % 2 === 1 ? 1 : 2;
    sum += pn * qn;
  }
  return 9 - (sum % 9) === cn.charCodeAt(0) - 48;
}

const bicRe = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

// ── the validators themselves, proven on known-good references ────────────────

test('validators accept independently-known-good reference values', () => {
  assert.ok(gs1Valid('96385074'), 'EAN-8 96385074');
  assert.ok(gs1Valid('4006381333931'), 'EAN-13 4006381333931');
  assert.ok(gs1Valid('036000291452'), 'UPC-A 036000291452');
  assert.ok(gs1Valid('10614141000415'), 'GTIN-14 10614141000415');
  assert.ok(luhnValid('79927398713'), 'Luhn 79927398713');
  assert.ok(luhnValid('4111111111111111'), 'Visa test 4111…');
  assert.ok(ibanValid('GB82WEST12345698765432'), 'reference GB IBAN');
  assert.ok(gbVatValid('434031494'), 'GB VAT 434031494');
  assert.ok(czVatValid('CZ00177041'), 'CZ IČO 00177041 (Škoda Auto)');
  assert.ok(jpCorpValid('7000012050002'), 'JP corporate 7000012050002 (NTA)');
  assert.ok(myNumberValid('123456789018'), 'JP My Number 123456789018');
  // negative controls, so a validator that says yes to everything fails here
  assert.ok(!gs1Valid('4006381333930'), 'bad EAN-13 check');
  assert.ok(!luhnValid('4111111111111112'), 'bad Luhn');
  assert.ok(!gbVatValid('434031495'), 'bad GB VAT');
  assert.ok(!jpCorpValid('8000012050002'), 'bad JP corporate');
});

// ── every standards generator: valid passes, invalid fails ────────────────────

const CASES: [string, (v: string) => boolean, RegExp][] = [
  ['ean8', gs1Valid, /^\d{8}$/],
  ['ean13', gs1Valid, /^\d{13}$/],
  ['upcA', gs1Valid, /^\d{12}$/],
  ['gtin14', gs1Valid, /^\d{14}$/],
  ['isbn13', gs1Valid, /^978\d{10}$/],
  ['creditCard', luhnValid, /^\d{16}$/],
  ['czBirthNumber', rodneValid, /^\d{10}$/],
  ['ukNino', ninoValid, /^[A-Z]{2}\d{6}[A-Z]$/],
  ['jpMyNumber', myNumberValid, /^\d{12}$/],
  ['czVat', czVatValid, /^CZ\d{8}$/],
  ['gbVat', gbVatValid, /^\d{9}$/],
  ['jpCorporateNumber', jpCorpValid, /^\d{13}$/],
];

for (const [id, valid, shape] of CASES) {
  test(`${id}: default output is check-valid and correctly shaped`, () => {
    for (const v of sample(id, P(), 300)) {
      assert.match(v, shape, `${id} bad shape: ${v}`);
      assert.ok(valid(v), `${id} should validate: ${v}`);
    }
  });
  test(`${id}: valid:false fails validation but keeps the shape`, () => {
    for (const v of sample(id, P({ valid: false }), 300)) {
      assert.match(v, shape, `${id} invalid variant lost its shape: ${v}`);
      assert.ok(!valid(v), `${id} invalid variant must NOT validate: ${v}`);
    }
  });
}

// ── BIC / SWIFT ───────────────────────────────────────────────────────────────

test('bic: structure is valid, and the invalid variant breaks it', () => {
  for (const v of sample('bic', P(), 300)) {
    assert.match(v, bicRe, `bad BIC: ${v}`);
    assert.ok(v.length === 8 || v.length === 11, `BIC length: ${v}`);
  }
  for (const v of sample('bic', P({ valid: false }), 300)) {
    assert.ok(!bicRe.test(v), `invalid BIC must not match: ${v}`);
  }
});

// ── credit-card brands ────────────────────────────────────────────────────────

test('credit-card brands use the right IIN range and length, all Luhn-valid', () => {
  for (const v of sample('creditCard', P({ brand: 'visa' }), 200)) {
    assert.match(v, /^4\d{15}$/, `Visa: ${v}`);
    assert.ok(luhnValid(v), `Visa Luhn: ${v}`);
  }
  for (const v of sample('creditCard', P({ brand: 'mastercard' }), 200)) {
    assert.match(v, /^5[1-5]\d{14}$/, `Mastercard: ${v}`);
    assert.ok(luhnValid(v), `Mastercard Luhn: ${v}`);
  }
  for (const v of sample('creditCard', P({ brand: 'amex' }), 200)) {
    assert.match(v, /^3[47]\d{13}$/, `Amex: ${v}`);
    assert.ok(luhnValid(v), `Amex Luhn: ${v}`);
  }
});

// ── IBAN countries ────────────────────────────────────────────────────────────

test('IBAN country selection produces the right shape with a valid MOD-97', () => {
  for (const v of sample('iban', P(), 100)) {           // default = CZ
    assert.match(v, /^CZ\d{22}$/, `CZ IBAN: ${v}`);
    assert.ok(ibanValid(v), `CZ MOD-97: ${v}`);
  }
  for (const v of sample('iban', P({ ibanCountry: 'GB' }), 100)) {
    assert.match(v, /^GB\d{2}[A-Z]{4}\d{14}$/, `GB IBAN: ${v}`);
    assert.ok(ibanValid(v), `GB MOD-97: ${v}`);
  }
  for (const v of sample('iban', P({ ibanCountry: 'JP' }), 100)) {
    assert.match(v, /^JP\d{17}$/, `JP synthetic IBAN: ${v}`);
    assert.ok(ibanValid(v), `JP MOD-97: ${v}`);
  }
  for (const v of sample('iban', P({ ibanCountry: 'GB', valid: false }), 100)) {
    assert.match(v, /^GB\d{2}[A-Z]{4}\d{14}$/, `GB invalid shape: ${v}`);
    assert.ok(!ibanValid(v), `GB invalid must fail MOD-97: ${v}`);
  }
});

// ── enhancing existing generators must not change the default output ──────────
// ean13/isbn13/creditCard/iban were routed through the shared helpers. The
// helpers must reproduce the exact string the old private functions produced for
// the SAME body — proven here over random bodies. Combined with the draw order
// being unchanged (same number of `int(0,9)` draws), a default run is
// byte-identical to Phase 1.

function oldEan13(twelve: string): string {   // pre-Phase-3 private helper
  let sum = 0;
  for (let i = 0; i < twelve.length; i++) sum += (twelve.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  return twelve + String((10 - (sum % 10)) % 10);
}
function oldLuhn(d: string): string {
  let sum = 0, double = true;
  for (let i = d.length - 1; i >= 0; i--) {
    let x = d.charCodeAt(i) - 48;
    if (double) { x *= 2; if (x > 9) x -= 9; }
    sum += x; double = !double;
  }
  return d + String((10 - (sum % 10)) % 10);
}

test('the shared helpers reproduce the pre-Phase-3 EAN/Luhn output exactly', async () => {
  const { gs1, luhnAppend } = await import('../src/utils/datagenStandards.ts');
  const rng = makeRng(7);
  for (let k = 0; k < 500; k++) {
    // ean13/isbn13 only ever fed a 12-digit body; GS1 weight-from-right agrees
    // with the old weight-from-left exactly for even-length bodies (which 12 is).
    const body = Array.from({ length: 12 }, () => String(Math.floor(rng() * 10))).join('');
    assert.equal(gs1(body, true), oldEan13(body), `gs1 diverged for ${body}`);
    // Luhn walks from the right in both, so it matches at any length.
    const cardBody = Array.from({ length: 6 + Math.floor(rng() * 12) }, () => String(Math.floor(rng() * 10))).join('');
    assert.equal(luhnAppend(cardBody, true), oldLuhn(cardBody), `luhn diverged for ${cardBody}`);
  }
});

test('enhanced ean13/creditCard/iban keep the Phase-1 shape by default', () => {
  for (const v of sample('ean13', P(), 50)) assert.ok(oldEan13(v.slice(0, 12)) === v);
  for (const v of sample('creditCard', P(), 50)) assert.match(v, /^400000\d{10}$/);
  for (const v of sample('iban', P(), 50)) assert.match(v, /^CZ\d{22}$/);
});

test('seed-42 anchors for the cross-tier parity check (mirrored in Rust)', () => {
  // Printed so the Rust test's hard-coded expectations can be regenerated.
  const ids = ['ean8', 'ean13', 'gtin14', 'upcA', 'isbn13', 'creditCard',
    'czBirthNumber', 'ukNino', 'jpMyNumber', 'czVat', 'gbVat', 'jpCorporateNumber'];
  const anchors = Object.fromEntries(ids.map(id => [id, firstOf(id)]));
  assert.ok(myNumberValid(anchors.jpMyNumber));
  assert.ok(gbVatValid(anchors.gbVat));
  console.log('seed-42 anchors:', JSON.stringify(anchors));
});

// ── suggestGenerator name heuristics ──────────────────────────────────────────

test('suggestGenerator maps standards-based column names', () => {
  assert.equal(suggestGenerator('ean', 'VARCHAR', false), 'ean13');
  assert.equal(suggestGenerator('barcode_ean13', 'VARCHAR', false), 'ean13');
  assert.equal(suggestGenerator('upc', 'VARCHAR', false), 'upcA');
  assert.equal(suggestGenerator('gtin', 'VARCHAR', false), 'gtin14');
  assert.equal(suggestGenerator('isbn', 'VARCHAR', false), 'isbn13');
  assert.equal(suggestGenerator('iban', 'VARCHAR', false), 'iban');
  assert.equal(suggestGenerator('swift_bic', 'VARCHAR', false), 'bic');
  assert.equal(suggestGenerator('nino', 'VARCHAR', false), 'ukNino');
  assert.equal(suggestGenerator('vat_number', 'VARCHAR', false), 'gbVat');
  assert.equal(suggestGenerator('credit_card', 'VARCHAR', false), 'creditCard');
  // false-positive guard: "private" contains the letters "vat" but is not a VAT.
  assert.notEqual(suggestGenerator('private', 'VARCHAR', false), 'gbVat');
  assert.notEqual(suggestGenerator('meantime', 'VARCHAR', false), 'ean13');
});
