/**
 * Phase 3 batch 1 — the identifier pack (UUID v7, ULID, nanoID, IMEI, VIN,
 * ISIN, DOI, BTC/ETH addresses, card expiry/CVV).
 *
 * Same testing rules as datagenStandards.test.ts: check digits are verified by
 * INDEPENDENT verifiers written here (never by calling the generator's own
 * helper), reference values known-good outside the codebase pin the algorithms,
 * seeded anchors pin the exact output (and are mirrored in the Rust tests in
 * src-tauri/src/commands/datagen_ident.rs), and every `valid:false` arm must
 * FAIL the verifier the valid arm passes.
 *
 * These tests import datagenStandards.ts directly — the GENERATORS registry
 * wiring is the coordinator's merge step and is not under test here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uuidV7, ulid, nanoId, imei, vin, vinCheckDigit, isin, isinCheckDigit,
  doi, btcAddress, ethAddress, cardExpiry, cardCvv, sha256Hex, base58Check,
  ULID_ALPHABET, NANOID_ALPHABET, VIN_CHARS, VIN_WMIS, IMEI_RBIS, ISIN_COUNTRIES,
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

const BASE_MS = Date.parse('2024-01-01T00:00:00Z');

// ── independent verifiers ────────────────────────────────────────────────────

function luhnValid(num: string): boolean {
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

// ISO 3779, transliteration table written out again on purpose.
const VIN_VALS: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
function vinValid(v: string): boolean {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  const w = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = v[i];
    sum += (ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : VIN_VALS[ch]) * w[i];
  }
  const want = sum % 11 === 10 ? 'X' : String(sum % 11);
  return v[8] === want;
}

function isinValid(s: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s)) return false;
  let expanded = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    expanded += code >= 65 ? String(code - 55) : ch;
  }
  return luhnValid(expanded);
}

function base58Decode(s: string): number[] {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (const ch of s) {
    let carry = ALPHA.indexOf(ch);
    if (carry < 0) throw new Error(`bad base58 char ${ch}`);
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 58;
      digits[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { digits.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const out = Array(zeros).fill(0);
  for (let i = digits.length - 1; i >= 0; i--) out.push(digits[i]);
  return out;
}

// The checksum half of the verifier reuses the module's sha256Hex — which is
// itself pinned below against the FIPS known-answer vectors, independently of
// any address logic.
function btcValid(addr: string): boolean {
  const raw = base58Decode(addr);
  if (raw.length !== 25 || raw[0] !== 0x00) return false;
  const payload = raw.slice(0, 21);
  const check = raw.slice(21);
  const hex = sha256Hex(hexBytes(sha256Hex(payload)));
  return check.every((b, i) => b === parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}
function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

// ── the primitives, proven on known-good references ──────────────────────────

test('sha256Hex matches the FIPS 180-4 known-answer vectors', () => {
  assert.equal(sha256Hex([]),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex([97, 98, 99]),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex([...'The quick brown fox jumps over the lazy dog'].map(c => c.charCodeAt(0))),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('base58Check matches the known all-zero hash160 address', () => {
  // version 0x00 + 20 zero bytes → the famous "111…4oLvT2" burn address.
  assert.equal(base58Check(Array(21).fill(0)), '1111111111111111111114oLvT2');
  // …and the decoder verifier agrees, so both directions are pinned.
  assert.ok(btcValid('1111111111111111111114oLvT2'));
});

test('vinCheckDigit matches the canonical ISO 3779 worked example', () => {
  assert.equal(vinCheckDigit('1M8GDM9AXKP042788'), 'X');
  assert.ok(vinValid('1M8GDM9AXKP042788'));
  assert.ok(!vinValid('1M8GDM9A9KP042788'), 'wrong check must fail');
});

test('isinCheckDigit matches a real ISIN (Apple US0378331005)', () => {
  assert.equal(isinCheckDigit('US037833100'), 5);
  assert.ok(isinValid('US0378331005'));
  assert.ok(!isinValid('US0378331006'), 'wrong check must fail');
});

// ── UUID v7 ──────────────────────────────────────────────────────────────────

test('uuidV7: shape, version/variant bits, embedded timestamp', () => {
  for (let i = 0; i < 200; i++) {
    const v = uuidV7(makeRng(i + 1), BASE_MS, i);
    assert.match(v, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ts = parseInt(v.slice(0, 8) + v.slice(9, 13), 16);
    assert.equal(ts, BASE_MS + i, 'uuid v7 must embed base + rowIndex ms');
  }
});

test('uuidV7: deterministic per (seed, rowIndex), time-ordered across rows', () => {
  assert.equal(uuidV7(makeRng(42), BASE_MS, 5), uuidV7(makeRng(42), BASE_MS, 5));
  assert.notEqual(uuidV7(makeRng(42), BASE_MS, 5), uuidV7(makeRng(43), BASE_MS, 5));
  assert.ok(uuidV7(makeRng(42), BASE_MS, 9) > uuidV7(makeRng(42), BASE_MS, 8),
    'row-ordered ids must sort ascending');
});

// ── ULID ─────────────────────────────────────────────────────────────────────

function ulidTimestamp(u: string): number {
  let ts = 0;
  for (let i = 0; i < 10; i++) ts = ts * 32 + ULID_ALPHABET.indexOf(u[i]);
  return ts;
}

test('ulid: 26 Crockford chars, embedded timestamp = base + rowIndex', () => {
  const re = new RegExp(`^[${ULID_ALPHABET}]{26}$`);
  for (let i = 0; i < 200; i++) {
    const v = ulid(makeRng(i + 1), BASE_MS, i);
    assert.match(v, re);
    assert.equal(ulidTimestamp(v), BASE_MS + i);
  }
  assert.equal(ulid(makeRng(42), BASE_MS, 3), ulid(makeRng(42), BASE_MS, 3), 'deterministic');
  assert.notEqual(ulid(makeRng(42), BASE_MS, 3), ulid(makeRng(7), BASE_MS, 3), 'seed-sensitive');
  assert.ok(ulid(makeRng(42), BASE_MS, 9) > ulid(makeRng(42), BASE_MS, 8), 'sortable');
});

// ── nanoID ───────────────────────────────────────────────────────────────────

test('nanoId: 21 URL-safe chars by default, deterministic, size honoured', () => {
  const re = new RegExp(`^[${NANOID_ALPHABET.replace('-', '\\-')}]{21}$`);
  for (let s = 0; s < 100; s++) assert.match(nanoId(makeRng(s)), re);
  assert.equal(nanoId(makeRng(42)), nanoId(makeRng(42)));
  assert.notEqual(nanoId(makeRng(42)), nanoId(makeRng(43)));
  assert.equal(nanoId(makeRng(42), 10).length, 10);
});

// ── IMEI ─────────────────────────────────────────────────────────────────────

test('imei: 15 digits, real reporting-body prefix, Luhn-valid', () => {
  for (let s = 0; s < 300; s++) {
    const v = imei(makeRng(s));
    assert.match(v, /^\d{15}$/);
    assert.ok(IMEI_RBIS.includes(v.slice(0, 2)), `RBI: ${v}`);
    assert.ok(luhnValid(v), `Luhn: ${v}`);
  }
});

test('imei: valid:false keeps the shape and body but fails Luhn', () => {
  for (let s = 0; s < 300; s++) {
    const bad = imei(makeRng(s), false);
    assert.match(bad, /^\d{15}$/);
    assert.ok(!luhnValid(bad), `must not validate: ${bad}`);
    // The toggle corrupts ONLY the check digit — the 14-digit body is identical.
    assert.equal(bad.slice(0, 14), imei(makeRng(s)).slice(0, 14));
  }
});

// ── VIN ──────────────────────────────────────────────────────────────────────

test('vin: 17 chars from the VIN alphabet, real WMI, ISO 3779 check', () => {
  const re = new RegExp(`^[${VIN_CHARS}]{17}$`);
  for (let s = 0; s < 300; s++) {
    const v = vin(makeRng(s));
    assert.match(v, re);
    assert.ok(VIN_WMIS.includes(v.slice(0, 3)), `WMI: ${v}`);
    assert.ok(vinValid(v), `ISO 3779: ${v}`);
  }
});

test('vin: valid:false keeps shape and body but fails ISO 3779', () => {
  for (let s = 0; s < 300; s++) {
    const bad = vin(makeRng(s), false);
    assert.match(bad, new RegExp(`^[${VIN_CHARS}]{17}$`));
    assert.ok(!vinValid(bad), `must not validate: ${bad}`);
    const good = vin(makeRng(s));
    assert.equal(bad.slice(0, 8), good.slice(0, 8));
    assert.equal(bad.slice(9), good.slice(9));
  }
});

// ── ISIN ─────────────────────────────────────────────────────────────────────

test('isin: 2-letter country + 9 alnum + Luhn check digit', () => {
  for (let s = 0; s < 300; s++) {
    const v = isin(makeRng(s));
    assert.match(v, /^[A-Z]{2}[A-Z0-9]{9}\d$/);
    assert.ok(ISIN_COUNTRIES.includes(v.slice(0, 2)), `country: ${v}`);
    assert.ok(isinValid(v), `Luhn: ${v}`);
  }
});

test('isin: valid:false keeps shape and body but fails the check', () => {
  for (let s = 0; s < 300; s++) {
    const bad = isin(makeRng(s), false);
    assert.match(bad, /^[A-Z]{2}[A-Z0-9]{9}\d$/);
    assert.ok(!isinValid(bad), `must not validate: ${bad}`);
    assert.equal(bad.slice(0, 11), isin(makeRng(s)).slice(0, 11));
  }
});

// ── DOI ──────────────────────────────────────────────────────────────────────

test('doi: 10.NNNNN/<suffix> shape, deterministic (no check digit exists)', () => {
  for (let s = 0; s < 200; s++) {
    assert.match(doi(makeRng(s)), /^10\.\d{4,5}\/[a-z0-9.-]{6,10}$/);
  }
  assert.equal(doi(makeRng(42)), doi(makeRng(42)));
  assert.notEqual(doi(makeRng(42)), doi(makeRng(43)));
});

// ── BTC / ETH addresses ──────────────────────────────────────────────────────

test('btcAddress: base58check, version 0x00, checksum verifies', () => {
  for (let s = 0; s < 100; s++) {
    const v = btcAddress(makeRng(s));
    assert.match(v, /^1[1-9A-HJ-NP-Za-km-z]{25,33}$/);
    assert.ok(btcValid(v), `base58check: ${v}`);
  }
  assert.equal(btcAddress(makeRng(42)), btcAddress(makeRng(42)));
  assert.notEqual(btcAddress(makeRng(42)), btcAddress(makeRng(43)));
});

test('ethAddress: 0x + 40 lowercase hex (EIP-55 deliberately skipped)', () => {
  for (let s = 0; s < 100; s++) {
    assert.match(ethAddress(makeRng(s)), /^0x[0-9a-f]{40}$/);
  }
  assert.equal(ethAddress(makeRng(42)), ethAddress(makeRng(42)));
});

// ── card expiry + CVV ────────────────────────────────────────────────────────

test('cardExpiry: MM/YY inside the window and never in the past', () => {
  for (let s = 0; s < 300; s++) {
    const v = cardExpiry(makeRng(s), 2020, 2030, 2026, 6);   // ref: June 2026
    assert.match(v, /^(0[1-9]|1[0-2])\/\d{2}$/);
    const mm = Number(v.slice(0, 2));
    const yy = 2000 + Number(v.slice(3));
    assert.ok(yy >= 2026 && yy <= 2030, `year: ${v}`);
    if (yy === 2026) assert.ok(mm >= 6, `must not predate the ref month: ${v}`);
  }
  assert.equal(cardExpiry(makeRng(42), 2020, 2030), cardExpiry(makeRng(42), 2020, 2030));
});

test('cardCvv: 3 digits, 4 for amex', () => {
  for (let s = 0; s < 100; s++) {
    assert.match(cardCvv(makeRng(s)), /^\d{3}$/);
    assert.match(cardCvv(makeRng(s), 'amex'), /^\d{4}$/);
    assert.match(cardCvv(makeRng(s), 'visa'), /^\d{3}$/);
  }
  assert.equal(cardCvv(makeRng(42)), cardCvv(makeRng(42)));
});

// ── seed-42 anchors — the cross-tier parity pins (mirrored in the Rust tests) ──

test('seed-42 anchors pin the exact output of every identifier generator', () => {
  assert.equal(uuidV7(makeRng(42), BASE_MS, 0), '018cc251-f400-797d-a284-9d73eb438a90');
  assert.equal(uuidV7(makeRng(42), BASE_MS, 7), '018cc251-f407-797d-a284-9d73eb438a90');
  assert.equal(ulid(makeRng(42), BASE_MS, 0), '01HK153X00KEVN5G8KVF7WQ96G');
  assert.equal(ulid(makeRng(42), BASE_MS, 7), '01HK153X07KEVN5G8KVF7WQ96G');
  assert.equal(nanoId(makeRng(42)), 'mc2qLhRn3eP4vTMgrnAe1');
  assert.equal(imei(makeRng(42)), '494861526842875');
  assert.equal(imei(makeRng(42), false), '494861526842876');
  assert.equal(vin(makeRng(42)), 'TMBR5ZFU4KX5SJ61L');
  assert.equal(vin(makeRng(42), false), 'TMBR5ZFU5KX5SJ61L');
  assert.equal(isin(makeRng(42)), 'GBQ4YGSJW5R7');
  assert.equal(isin(makeRng(42), false), 'GBQ4YGSJW5R8');
  assert.equal(doi(makeRng(42)), '10.60509/6zgukx6r');
  assert.equal(btcAddress(makeRng(42)), '1EzMyZN6Qkc8qu2TLNUu4hZRrnyjBdwEcZ');
  assert.equal(ethAddress(makeRng(42)), '0x97da2849d73eb438a907d090402c802d7c570089');
  assert.equal(cardExpiry(makeRng(42), 2024, 2030), '06/28');
  assert.equal(cardCvv(makeRng(42)), '648');
  assert.equal(cardCvv(makeRng(42), 'amex'), '6486');
});
