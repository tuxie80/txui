/**
 * Phase 3 batch 2 — banks (ABA routing, IBAN country formats), national IDs
 * (US SSN, PL PESEL, DE Steuer-ID, FR NIR, ES DNI/NIE), VAT IDs (DE, FR, ES,
 * PL, US EIN), localized license plates (DE/UK/JP/US), the airport IATA +
 * coordinates pair, RGB/HSL colors and avatar initials.
 *
 * Same testing rules as datagenIdent.test.ts (batch 1): check digits are
 * verified by INDEPENDENT verifiers written here (never by calling the
 * generator's own helper), reference values known-good outside the codebase
 * pin the algorithms, seed-42 anchors pin the exact output (mirrored in the
 * Rust tests in src-tauri/src/commands/datagen_ident.rs), and every
 * `valid:false` arm must FAIL the verifier the valid arm passes.
 *
 * These tests import datagenStandards.ts directly — the GENERATORS registry
 * wiring is the coordinator's merge step and is not under test here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abaRouting, abaCheckDigit, ABA_PREFIXES,
  ibanBban, iban, ibanCheckDigits,
  usSsn, plPesel, peselCheckDigit, deSteuerId, steuerIdCheckDigit, steuerIdDigitsOk,
  frNir, nirKey, esDni, DNI_LETTERS,
  deVat, frVat, frVatKey, esVat, CIF_LETTERS, plVat, plVatCheckDigit, usEin, EIN_PREFIXES,
  dePlate, ukPlate, jpPlate, usPlate, DE_PLATE_DISTRICTS, JP_PLATE_OFFICES, JP_PLATE_CLASSES,
  airport, AIRPORTS, colorHex, colorRgb, colorHsl, avatarInitials,
} from '../src/utils/datagenStandards.ts';

// mulberry32 — the same seedable stream datagen.ts's makeRng produces, kept
// local so this file does not depend on the registry module.
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── independent verifiers ────────────────────────────────────────────────────

function abaValid(n: string): boolean {
  if (!/^\d{9}$/.test(n)) return false;
  const d = (i: number) => n.charCodeAt(i) - 48;
  // Weights 3-7-1 written out again on purpose.
  return (3 * (d(0) + d(3) + d(6)) + 7 * (d(1) + d(4) + d(7)) + (d(2) + d(5) + d(8))) % 10 === 0;
}

function ibanValid(full: string): boolean {
  const rearranged = full.slice(4) + full.slice(0, 4);
  let m = 0;
  for (const ch of rearranged) {
    const c = ch.charCodeAt(0);
    if (c >= 65) {
      for (const dd of String(c - 55)) m = (m * 10 + (dd.charCodeAt(0) - 48)) % 97;
    } else {
      m = (m * 10 + (c - 48)) % 97;
    }
  }
  return m === 1;
}

function peselValid(p: string): boolean {
  if (!/^\d{11}$/.test(p)) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3, 1];
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += (p.charCodeAt(i) - 48) * w[i];
  return sum % 10 === 0;
}

function steuerIdValid(s: string): boolean {
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  // ISO 7064 MOD 11,10, written out again.
  let p = 10;
  for (let i = 0; i < 10; i++) {
    let x = (s.charCodeAt(i) - 48 + p) % 10;
    if (x === 0) x = 10;
    p = (2 * x) % 11;
  }
  return s.charCodeAt(10) - 48 === (11 - p) % 10;
}

function nirValid(nir: string): boolean {
  if (!/^\d{15}$/.test(nir)) return false;
  let m = 0;
  for (let i = 0; i < 13; i++) m = (m * 10 + (nir.charCodeAt(i) - 48)) % 97;
  return 97 - m === Number(nir.slice(13));
}

function dniValid(v: string): boolean {
  const TABLE = 'TRWAGMYFPDXBNJZSQVHLCKE'; // written out again
  let num: number;
  let letter: string;
  if (/^\d/.test(v)) {
    num = Number(v.slice(0, -1));
    letter = v.slice(-1);
  } else {
    const p = { X: 0, Y: 1, Z: 2 }[v[0] as 'X' | 'Y' | 'Z'];
    if (p === undefined) return false;
    num = p * 10000000 + Number(v.slice(1, -1));
    letter = v.slice(-1);
  }
  return TABLE[num % 23] === letter;
}

function frVatValid(v: string): boolean {
  if (!/^FR\d{11}$/.test(v)) return false;
  let m = 0;
  for (let i = 4; i < 13; i++) m = (m * 10 + (v.charCodeAt(i) - 48)) % 97;
  return (12 + 3 * m) % 97 === Number(v.slice(2, 4));
}

function esVatValid(v: string): boolean {
  if (!/^ES[A-H]\d{8}$/.test(v)) return false;
  // The 7 body digits sit at indices 3..9; odd 1-based positions are doubled
  // and digit-summed, even ones added plain. Written out independently.
  let sum = 0;
  for (let pos = 1; pos <= 7; pos++) {
    let d = v.charCodeAt(2 + pos) - 48;
    if (pos % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return v.charCodeAt(10) - 48 === (10 - (sum % 10)) % 10;
}

function plVatValid(v: string): boolean {
  if (!/^PL\d{10}$/.test(v)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (v.charCodeAt(2 + i) - 48) * w[i];
  return v.charCodeAt(11) - 48 === sum % 11;
}

// ── the primitives, proven on known-good references ──────────────────────────

test('abaCheckDigit matches known bank routing numbers', () => {
  assert.equal(abaCheckDigit('02100002'), 1); // JPMorgan Chase 021000021
  assert.ok(abaValid('021000021'));
  assert.ok(abaValid('011000015')); // Federal Reserve example
  assert.ok(abaValid('111000025')); // Bank of America Texas
  assert.ok(!abaValid('021000022'), 'a wrong check digit must fail');
});

test('ibanCheckDigits match officially published example IBANs', () => {
  assert.equal(ibanCheckDigits('DE', '370400440532013000'), '89');
  assert.equal(ibanCheckDigits('GB', 'NWBK60161331926819'), '29');
  assert.equal(ibanCheckDigits('ES', '21000418450200051332'), '91');
  assert.equal(ibanCheckDigits('PL', '109010140000071219812874'), '61');
  assert.equal(ibanCheckDigits('CZ', '08000000192000145399'), '65');
  assert.equal(ibanCheckDigits('FR', '30006000011234567890189'), '76');
  for (const v of [
    'DE89370400440532013000', 'GB29NWBK60161331926819', 'ES9121000418450200051332',
    'PL61109010140000071219812874', 'CZ6508000000192000145399', 'FR7630006000011234567890189',
  ]) assert.ok(ibanValid(v), v);
  assert.ok(!ibanValid('DE88370400440532013000'), 'an off-by-one key must fail');
});

test('peselCheckDigit matches the documented worked example', () => {
  assert.equal(peselCheckDigit('4405140135'), 9);
  assert.ok(peselValid('44051401359'));
  assert.ok(!peselValid('44051401358'));
});

test('steuerIdCheckDigit matches the documented worked example', () => {
  assert.equal(steuerIdCheckDigit('8609574271'), 9);
  assert.ok(steuerIdValid('86095742719'));
  assert.ok(steuerIdDigitsOk('8609574271'), '7 appears exactly twice');
  assert.ok(!steuerIdDigitsOk('1112234567'), 'two repeated values are never assigned');
  assert.ok(!steuerIdDigitsOk('1111234567'), 'a value appearing 4+ times is never assigned');
  assert.ok(!steuerIdDigitsOk('1234567890'), 'an all-distinct body is never assigned');
  assert.ok(!steuerIdValid('86095742710'));
});

test('nirKey matches a worked example', () => {
  // 1 55 12 75 012 116 → key 87 (a man born Dec 1955, Paris 12e).
  assert.equal(nirKey('1551275012116'), 87);
  assert.ok(nirValid('155127501211687'));
  assert.ok(!nirValid('155127501211688'));
});

test('the DNI letter table matches the canonical example', () => {
  assert.equal(DNI_LETTERS[12345678 % 23], 'Z');
  assert.ok(dniValid('12345678Z')); // the canonical DNI example
  assert.ok(!dniValid('12345678T'));
});

test('frVatKey matches the formula reference', () => {
  // SIREN 552 100 554 → key 96: 552100554 mod 97 = 28, (12 + 3·28) mod 97.
  assert.equal(frVatKey('552100554'), 96);
  assert.ok(frVatValid('FR96552100554'));
  assert.ok(!frVatValid('FR95552100554'));
});

test('esVat control matches a known CIF', () => {
  assert.ok(esVatValid('ESA58818501'));
  assert.ok(!esVatValid('ESA58818502'));
});

test('plVatCheckDigit matches the documented test NIP', () => {
  assert.equal(plVatCheckDigit('123456321'), 8);
  assert.ok(plVatValid('PL1234563218'));
  assert.ok(!plVatValid('PL1234563219'));
});

// ── structure + the valid toggle ─────────────────────────────────────────────

test('ABA routing: real prefix ranges, checksum, valid toggle', () => {
  for (let s = 0; s < 300; s++) {
    const v = abaRouting(makeRng(s), true);
    const prefix = v.slice(0, 2);
    assert.ok(ABA_PREFIXES.includes(prefix), `prefix: ${v}`);
    assert.ok(abaValid(v), v);
    const bad = abaRouting(makeRng(s), false);
    assert.ok(!abaValid(bad), `must not validate: ${bad}`);
    assert.equal(bad.slice(0, 8), v.slice(0, 8), 'only the check digit may change');
  }
});

test('IBAN: per-country lengths and MOD-97 validity, valid toggle', () => {
  const want: Record<string, number> = { CZ: 24, GB: 22, JP: 19, DE: 22, FR: 27, ES: 24, PL: 28 };
  for (let s = 0; s < 200; s++) {
    for (const [country, len] of Object.entries(want)) {
      const full = iban(country, ibanBban(makeRng(s), country), true);
      assert.equal(full.length, len, `${country}: ${full}`);
      assert.ok(ibanValid(full), `${country}: ${full}`);
      const bad = iban(country, ibanBban(makeRng(s), country), false);
      assert.ok(!ibanValid(bad), `${country} must not validate: ${bad}`);
      assert.equal(bad.slice(4), full.slice(4), 'only the check digits may change');
    }
  }
});

test('US SSN: issuance rules, structural invalid form', () => {
  for (let s = 0; s < 500; s++) {
    const v = usSsn(makeRng(s), true);
    assert.match(v, /^\d{3}-\d{2}-\d{4}$/);
    const area = Number(v.slice(0, 3));
    assert.ok((area >= 1 && area <= 665) || (area >= 667 && area <= 899), `area: ${v}`);
    assert.notEqual(v.slice(4, 6), '00', `group: ${v}`);
    assert.notEqual(v.slice(7), '0000', `serial: ${v}`);
    const bad = usSsn(makeRng(s), false);
    assert.equal(bad.slice(7), '0000', `structural invalid form: ${bad}`);
    assert.equal(bad.slice(0, 6), v.slice(0, 6), 'area/group unchanged by the toggle');
  }
});

test('PL PESEL: birthdate coherence, checksum, valid toggle', () => {
  for (let s = 0; s < 500; s++) {
    const v = plPesel(makeRng(s), true);
    assert.match(v, /^\d{11}$/);
    const yy = Number(v.slice(0, 2));
    const mm = Number(v.slice(2, 4));
    if (yy <= 24) assert.ok(mm >= 21 && mm <= 32, `2000s month encoding: ${v}`);
    else assert.ok(mm >= 1 && mm <= 12, `1900s month encoding: ${v}`);
    assert.ok(peselValid(v), v);
    const bad = plPesel(makeRng(s), false);
    assert.ok(!peselValid(bad), `must not validate: ${bad}`);
    assert.equal(bad.slice(0, 10), v.slice(0, 10), 'only the check digit may change');
  }
});

test('DE Steuer-ID: repeated-digit rule, ISO 7064 check, valid toggle', () => {
  for (let s = 0; s < 300; s++) {
    const v = deSteuerId(makeRng(s), true);
    assert.match(v, /^\d{11}$/);
    assert.ok(steuerIdDigitsOk(v.slice(0, 10)), `repeated-digit rule: ${v}`);
    assert.ok(steuerIdValid(v), v);
    const bad = deSteuerId(makeRng(s), false);
    assert.ok(!steuerIdValid(bad), `must not validate: ${bad}`);
    assert.equal(bad.slice(0, 10), v.slice(0, 10), 'only the check digit may change');
  }
});

test('FR NIR: mainland departments, key, valid toggle', () => {
  for (let s = 0; s < 500; s++) {
    const v = frNir(makeRng(s), true);
    assert.match(v, /^\d{15}$/);
    assert.ok(v[0] === '1' || v[0] === '2', v);
    const dept = Number(v.slice(5, 7));
    assert.ok(dept >= 1 && dept <= 95, `mainland departments only: ${v}`);
    assert.ok(nirValid(v), v);
    const bad = frNir(makeRng(s), false);
    assert.ok(!nirValid(bad), `must not validate: ${bad}`);
    assert.equal(bad.slice(0, 13), v.slice(0, 13), 'only the key may change');
  }
});

test('ES DNI/NIE: both kinds, mod-23 letter, valid toggle', () => {
  let sawDni = false;
  let sawNie = false;
  for (let s = 0; s < 500; s++) {
    const v = esDni(makeRng(s), true);
    if (/^\d/.test(v)) { sawDni = true; assert.match(v, /^\d{8}[A-Z]$/); }
    else { sawNie = true; assert.match(v, /^[XYZ]\d{7}[A-Z]$/); }
    assert.ok(dniValid(v), v);
    const bad = esDni(makeRng(s), false);
    assert.ok(!dniValid(bad), `must not validate: ${bad}`);
    assert.equal(bad.slice(0, 8), v.slice(0, 8), 'only the letter may change');
  }
  assert.ok(sawDni && sawNie, 'both kinds drawn over 500 seeds');
});

test('VAT IDs: structure, checksums, toggles', () => {
  for (let s = 0; s < 300; s++) {
    const de = deVat(makeRng(s));
    assert.match(de, /^DE[1-9]\d{8}$/); // no public checksum → no toggle

    const fr = frVat(makeRng(s), true);
    assert.ok(frVatValid(fr), fr);
    assert.ok(!frVatValid(frVat(makeRng(s), false)));

    const es = esVat(makeRng(s), true);
    assert.ok(CIF_LETTERS.includes(es[2]), es);
    assert.ok(esVatValid(es), es);
    assert.ok(!esVatValid(esVat(makeRng(s), false)));

    const pl = plVat(makeRng(s), true);
    assert.ok(plVatValid(pl), pl);
    const badPl = plVat(makeRng(s), false);
    assert.ok(!plVatValid(badPl), `must not validate: ${badPl}`);
    assert.equal(badPl.slice(0, 11), pl.slice(0, 11), 'only the check digit may change');

    const ein = usEin(makeRng(s));
    assert.match(ein, /^\d{2}-\d{7}$/);
    assert.ok(EIN_PREFIXES.includes(ein.slice(0, 2)), `campus prefix: ${ein}`);
  }
});

test('license plates match their local formats', () => {
  for (let s = 0; s < 300; s++) {
    const de = dePlate(makeRng(s));
    const [district, letters, num] = de.split(' ');
    assert.ok(DE_PLATE_DISTRICTS.includes(district), de);
    assert.match(letters, /^[A-Z]{1,2}$/, de);
    assert.match(num, /^[1-9]\d{0,3}$/, de);

    const uk = ukPlate(makeRng(s));
    assert.match(uk, /^[A-Z]{2}\d{2} [A-Z]{3}$/);
    assert.ok(!/[IQ]/.test(uk), `I/Q never appear: ${uk}`);
    const age = Number(uk.slice(2, 4));
    assert.ok((age >= 51 && age <= 75) || (age >= 2 && age <= 24), `age identifier: ${uk}`);

    const jp = jpPlate(makeRng(s));
    const [office, cls, letter, jnum] = jp.split(' ');
    assert.ok(JP_PLATE_OFFICES.includes(office), jp);
    assert.ok(JP_PLATE_CLASSES.includes(cls), jp);
    assert.match(letter, /^[A-Z]$/, jp);
    assert.match(jnum, /^\d{2}-\d{2}$/, jp);

    const us = usPlate(makeRng(s));
    assert.match(us, /^[A-Z]{3} \d{4}$/);
  }
});

test('airport: a real IATA code with its own coordinates', () => {
  for (let s = 0; s < 200; s++) {
    const v = airport(makeRng(s));
    const code = v.slice(0, 3);
    const row = AIRPORTS.find(([c]) => c === code);
    assert.ok(row, `known code: ${v}`);
    assert.equal(v, `${row[0]} (${row[1]}, ${row[2]})`, `coherent: ${v}`);
  }
});

test('colors are CSS literals', () => {
  for (let s = 0; s < 200; s++) {
    assert.match(colorHex(makeRng(s)), /^#[0-9a-f]{6}$/);
    const rgb = colorRgb(makeRng(s));
    assert.match(rgb, /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);
    for (const n of rgb.slice(4, -1).split(', ').map(Number)) {
      assert.ok(n >= 0 && n <= 255, rgb);
    }
    const hsl = colorHsl(makeRng(s));
    const m = /^hsl\((\d{1,3}), (\d{1,3})%, (\d{1,3})%\)$/.exec(hsl);
    assert.ok(m, hsl);
    assert.ok(Number(m![1]) <= 359 && Number(m![2]) <= 100 && Number(m![3]) <= 100, hsl);
  }
});

test('avatarInitials take the first letter of each name', () => {
  assert.equal(avatarInitials('Jiri', 'Novak'), 'JN');
  assert.equal(avatarInitials('anna', 'smith'), 'AS');
  assert.equal(avatarInitials('Émile', 'Łódź'), 'ÉŁ');
});

// ── seed-42 anchors — the SAME pins as the Rust tests in datagen_ident.rs ────

test('seed-42 anchors (mirror of the Rust inline tests)', () => {
  assert.equal(abaRouting(makeRng(42), true), '304861521');
  assert.equal(abaRouting(makeRng(42), false), '304861522');
  assert.equal(ibanBban(makeRng(42), 'CZ'), '64094861526842873156');
  assert.equal(ibanBban(makeRng(42), 'GB'), 'PLWR15268428731566');
  assert.equal(ibanBban(makeRng(42), 'JP'), '648615268428731');
  assert.equal(ibanBban(makeRng(42), 'DE'), '648615268428731566');
  assert.equal(ibanBban(makeRng(42), 'FR'), '64861526842873156604805');
  assert.equal(ibanBban(makeRng(42), 'ES'), '64861526842873156604');
  assert.equal(ibanBban(makeRng(42), 'PL'), '648615268428731566048050');
  assert.equal(iban('CZ', ibanBban(makeRng(42), 'CZ'), true), 'CZ4464094861526842873156');
  assert.equal(iban('DE', ibanBban(makeRng(42), 'DE'), true), 'DE65648615268428731566');
  assert.equal(iban('DE', ibanBban(makeRng(42), 'DE'), false), 'DE66648615268428731566');
  assert.equal(usSsn(makeRng(42), true), '541-45-8524');
  assert.equal(usSsn(makeRng(42), false), '541-45-0000');
  assert.equal(plPesel(makeRng(42), true), '60062461524');
  assert.equal(plPesel(makeRng(42), false), '60062461525');
  assert.equal(deSteuerId(makeRng(42), true), '10346807929');
  assert.equal(deSteuerId(makeRng(42), false), '10346807920');
  assert.equal(frNir(makeRng(42), true), '244116417552718');
  assert.equal(frNir(makeRng(42), false), '244116417552719');
  assert.equal(esDni(makeRng(42), true), 'Y8524657C');
  assert.equal(esDni(makeRng(42), false), 'Y8524657K');
  assert.equal(deVat(makeRng(42)), 'DE648615268');
  assert.equal(frVat(makeRng(42), true), 'FR14648615268');
  assert.equal(frVat(makeRng(42), false), 'FR15648615268');
  assert.equal(esVat(makeRng(42), true), 'ESE44829059');
  assert.equal(esVat(makeRng(42), false), 'ESE44829050');
  assert.equal(plVat(makeRng(42), true), 'PL6486152687');
  assert.equal(plVat(makeRng(42), false), 'PL6486152688');
  assert.equal(usEin(makeRng(42)), '60-4482905');
  assert.equal(dePlate(makeRng(42)), 'L W 6697');
  assert.equal(ukPlate(makeRng(42)), 'PL17 ENG');
  assert.equal(jpPlate(makeRng(42)), 'NAGOYA 500 W 66-97');
  assert.equal(usPlate(makeRng(42)), 'PLW 6697');
  assert.equal(airport(makeRng(42)), 'PVG (31.1443, 121.8083)');
  assert.equal(colorHex(makeRng(42)), '#97da28');
  assert.equal(colorRgb(makeRng(42)), 'rgb(153, 114, 218)');
  assert.equal(colorHsl(makeRng(42)), 'hsl(216, 45%, 86%)');
  assert.equal(avatarInitials('Jiri', 'Novak'), 'JN');
});
