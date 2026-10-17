/**
 * Standards-based check-digit algorithms for the generator wizard.
 *
 * Every function here is PURE: it takes an already-drawn body (a string of
 * digits, or the pieces a caller assembled from the seeded RNG) and returns the
 * check digit or the finished value. The RNG lives in the callers
 * (`utils/datagen.ts` and `src-tauri/src/commands/datagen.rs`), which draw in an
 * identical order on both tiers and then call the same algorithm here — so a
 * seed produces the same value in the browser and in the Rust volume engine.
 *
 * Each family exposes two shapes:
 *   - `…CheckDigit(body)` — the correct check digit, for validators and tests.
 *   - a builder that takes a `valid` flag: when `false` it emits a
 *     STRUCTURALLY-shaped value with a deliberately wrong check digit, for
 *     negative testing. The invalid form corrupts only the check digit (it does
 *     not touch the body), so toggling `valid` on a column changes exactly one
 *     character and nothing about the RNG draw order.
 *
 * References used in the tests (independently-known-good values):
 *   EAN-8   96385074            EAN-13 4006381333931
 *   UPC-A   036000291452        GTIN-14 10614141000415
 *   Luhn    79927398713         IBAN GB GB82WEST12345698765432
 *   GB VAT  434031494           JP corporate 7000012050002
 *   CZ IČO  00177041 (Škoda)    JP My Number 123456789018
 */

// ── GS1 barcodes (EAN-8/13, UPC-A, GTIN-14) — mod-10 ─────────────────────────

/**
 * GS1 mod-10 check digit for a numeric `body` of any length.
 *
 * Weights alternate 3,1,3,1… starting from the RIGHTMOST body digit (the one
 * next to the check digit gets weight 3). This is the single GS1 rule behind
 * every fixed-length barcode; for a 12-digit body it is identical to the older
 * EAN-13 "1,3 from the left" phrasing, so routing EAN-13 through here does not
 * change its output.
 */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** `body` + its GS1 check digit, or a deliberately wrong one when `!valid`. */
export function gs1(body: string, valid: boolean): string {
  const c = gs1CheckDigit(body);
  return body + String(valid ? c : (c + 1) % 10);
}

// ── Luhn (mod-10) — credit cards ─────────────────────────────────────────────

/** Luhn check digit for a numeric `body` (the digit that makes body+d pass). */
export function luhnCheckDigit(body: string): number {
  let sum = 0;
  let double = true; // the check digit sits at position 0 from the right
  for (let i = body.length - 1; i >= 0; i--) {
    let d = body.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** `body` + its Luhn check digit, or a wrong one when `!valid`. */
export function luhnAppend(body: string, valid: boolean): string {
  const c = luhnCheckDigit(body);
  return body + String(valid ? c : (c + 1) % 10);
}

// ── ISO 13616 IBAN (MOD-97-10) ───────────────────────────────────────────────

/**
 * IBAN check digits for `bban` under `country`: move the country code and a
 * "00" placeholder to the end, map letters to digits (A=10…Z=35), take the
 * whole thing mod 97 digit-by-digit (nothing overflows), and the check is
 * 98 minus the remainder, zero-padded to two places.
 */
export function ibanCheckDigits(country: string, bban: string): string {
  // Letters ANYWHERE — inside the BBAN (GB carries a 4-letter bank code) as well
  // as the country code — expand to two digits (A=10…Z=35) before the mod.
  const rearranged = (bban + country.toUpperCase() + '00').toUpperCase();
  let mod = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const ch = rearranged.charCodeAt(i);
    if (ch >= 65) {
      mod = (mod * 10 + Math.floor((ch - 55) / 10)) % 97;   // tens digit of 10–35
      mod = (mod * 10 + ((ch - 55) % 10)) % 97;             // units digit
    } else {
      mod = (mod * 10 + (ch - 48)) % 97;
    }
  }
  const check = 98 - mod;
  return check < 10 ? '0' + check : String(check);
}

/**
 * Full IBAN for `country` + `bban`, with correct MOD-97 check digits — or, when
 * `!valid`, check digits that are off by one so the whole thing fails MOD-97.
 */
export function iban(country: string, bban: string, valid: boolean): string {
  const cd = ibanCheckDigits(country, bban);
  if (valid) return `${country}${cd}${bban}`;
  const wrong = String((Number(cd) + 1) % 100).padStart(2, '0');
  return `${country}${wrong}${bban}`;
}

// ── CZ rodné číslo (birth number), post-1954 10-digit form ───────────────────

/**
 * Check digit for the 9-digit prefix `YYMMDDSSS` of a modern (post-1954) rodné
 * číslo: the whole 10-digit number is divisible by 11, which — because
 * −10 ≡ 1 (mod 11) — means the check digit equals `prefix mod 11`. Callers must
 * reject prefixes whose remainder is 10 (no single-digit check exists; those
 * serials were never issued).
 */
export function rodneCisloCheck(prefix9: string): number {
  let m = 0;
  for (let i = 0; i < prefix9.length; i++) m = (m * 10 + (prefix9.charCodeAt(i) - 48)) % 11;
  return m;
}

/** `prefix9` + its check digit (caller guarantees remainder ≠ 10), or wrong. */
export function rodneCislo(prefix9: string, valid: boolean): string {
  const c = rodneCisloCheck(prefix9);
  return prefix9 + String(valid ? c : (c + 1) % 10);
}

// ── UK NINO ──────────────────────────────────────────────────────────────────

// First prefix letter never D, F, I, Q, U or V.
export const NINO_FIRST = 'ABCEGHJKLMNOPRSTWXYZ'.split('');
// Second prefix letter never D, F, I, O, Q, U or V.
export const NINO_SECOND = 'ABCEGHJKLMNPRSTWXYZ'.split('');
// Two-letter prefixes that are administratively never allocated.
export const NINO_DISALLOWED = ['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ'];
export const NINO_SUFFIX = ['A', 'B', 'C', 'D'];

export function ninoPrefixOk(a: string, b: string): boolean {
  return !NINO_DISALLOWED.includes(a + b);
}

// ── JP My Number (12 digits, individual) ─────────────────────────────────────

/**
 * Check digit (the 12th) for the first 11 digits of a My Number.
 * Qn = n+1 for n∈1..6, else n−5 for n∈7..11, with Pn the n-th digit from the
 * right of the 11-digit prefix; check = 11−(ΣPnQn mod 11), collapsing to 0 when
 * that remainder is 0 or 1.
 */
export function myNumberCheck(prefix11: string): number {
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const pn = prefix11.charCodeAt(11 - n) - 48;
    const qn = n <= 6 ? n + 1 : n - 5;
    sum += pn * qn;
  }
  const r = sum % 11;
  return r <= 1 ? 0 : 11 - r;
}

export function myNumber(prefix11: string, valid: boolean): string {
  const c = myNumberCheck(prefix11);
  return prefix11 + String(valid ? c : (c + 1) % 10);
}

// ── CZ DIČ / IČO (8-digit legal-entity form) — mod-11 ────────────────────────

/**
 * Check digit for the 8-digit Czech IČO / DIČ: the first 7 digits weighted
 * 8,7,6,5,4,3,2, summed, mod 11; the check is 11 minus that, with the two
 * boundary cases (remainder 0 → 1, remainder 1 → 0) the standard defines.
 */
export function icoCheckDigit(prefix7: string): number {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (prefix7.charCodeAt(i) - 48) * (8 - i);
  const m = sum % 11;
  if (m === 0) return 1;
  if (m === 1) return 0;
  return 11 - m;
}

/** `CZ` + 8 digits (7-digit body + check), or a wrong check when `!valid`. */
export function czVat(prefix7: string, valid: boolean): string {
  const c = icoCheckDigit(prefix7);
  return 'CZ' + prefix7 + String(valid ? c : (c + 1) % 10);
}

// ── GB VAT (9-digit) — 97-complement (mod-97) ────────────────────────────────

/** Two-digit check for a GB VAT: 97 − (Σ first-7 × [8,7,6,5,4,3,2]) mod 97. */
export function gbVatCheck(prefix7: string): number {
  const w = [8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (prefix7.charCodeAt(i) - 48) * w[i];
  return (97 - (sum % 97)) % 97;
}

/** 9-digit GB VAT (7-digit body + 2 check digits), or a wrong check. */
export function gbVat(prefix7: string, valid: boolean): string {
  const c = gbVatCheck(prefix7);
  const cc = valid ? c : (c + 1) % 97;
  return prefix7 + String(cc).padStart(2, '0');
}

// ── JP corporate number (13 digits) ──────────────────────────────────────────

/**
 * Leading check digit for a Japanese corporate number, computed on the trailing
 * 12 digits: Qn alternates 1 (odd n) / 2 (even n) with Pn the n-th digit from
 * the right; check = 9 − (ΣPnQn mod 9).
 */
export function jpCorporateCheck(body12: string): number {
  let sum = 0;
  for (let n = 1; n <= 12; n++) {
    const pn = body12.charCodeAt(12 - n) - 48;
    const qn = n % 2 === 1 ? 1 : 2;
    sum += pn * qn;
  }
  return 9 - (sum % 9);
}

/** 13-digit corporate number (check digit + 12-digit body), or a wrong check. */
export function jpCorporateNumber(body12: string, valid: boolean): string {
  const c = jpCorporateCheck(body12);
  return String(valid ? c : (c + 1) % 10) + body12;
}


// ── Phase 3 batch 1 — the identifier pack ────────────────────────────────────
//
// Same contract as the families above: PURE functions over a seeded
// `rnd: () => number` (mulberry32 from the caller), ported line-for-line in
// `src-tauri/src/commands/datagen_ident.rs` with the SAME draw order, so a seed
// produces the same identifier on both tiers. The time-ordered ids (UUID v7,
// ULID) take the row index so a run stays deterministic per (seed, rowIndex)
// while the values still sort in row order. Generators without a check digit
// (UUID, ULID, nanoID, DOI, crypto addresses) have no `valid` toggle; IMEI,
// VIN and ISIN keep it, corrupting ONLY the check digit exactly like above.

type Rnd = () => number;

const dgInt = (rnd: Rnd, min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;
const dgDigits = (rnd: Rnd, n: number) => Array.from({ length: n }, () => String(dgInt(rnd, 0, 9))).join('');
const dgPick = (rnd: Rnd, chars: string) => chars[Math.floor(rnd() * chars.length)];
const dgPickArr = <T,>(rnd: Rnd, arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const dgPad2 = (n: number) => String(n).padStart(2, '0');

// ── UUID v7 (RFC 9562 §5.7) — time-ordered ───────────────────────────────────

/**
 * UUIDv7: 48-bit unix epoch milliseconds, version field 7, variant 10, the
 * remaining 74 bits seeded-random. The timestamp is `baseEpochMs + rowIndex`
 * (1 ms per row) rather than wall-clock time, so a seed reproduces the run
 * exactly while the ids still sort in row order.
 */
export function uuidV7(rnd: Rnd, baseEpochMs: number, rowIndex: number): string {
  const ts = (Math.trunc(baseEpochMs) + Math.max(0, Math.trunc(rowIndex))) % 2 ** 48;
  const tsHex = ts.toString(16).padStart(12, '0');
  const h = () => Math.floor(rnd() * 16).toString(16);
  const randA = h() + h() + h();                            // 12 random bits
  const variant = (8 + Math.floor(rnd() * 4)).toString(16); // 10xx
  const rest1 = h() + h() + h();
  const rest2 = Array.from({ length: 12 }, h).join('');
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8)}-7${randA}-${variant}${rest1}-${rest2}`;
}

// ── ULID — 26-char Crockford base32, time-ordered ────────────────────────────

/** Crockford base32 (no I, L, O, U) — the ULID alphabet. */
export const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID: 48-bit millisecond timestamp as 10 Crockford chars + 80 seeded-random
 * bits as 16 more. Same determinism rule as `uuidV7`: `baseEpochMs + rowIndex`.
 */
export function ulid(rnd: Rnd, baseEpochMs: number, rowIndex: number): string {
  let ts = (Math.trunc(baseEpochMs) + Math.max(0, Math.trunc(rowIndex))) % 2 ** 48;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) { time[i] = ULID_ALPHABET[ts % 32]; ts = Math.floor(ts / 32); }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += dgPick(rnd, ULID_ALPHABET);
  return time.join('') + rand;
}

// ── nanoID — URL-safe, no structure ──────────────────────────────────────────

/** The nanoID URL alphabet (A-Za-z0-9 plus `-` and `_`), 64 characters. */
export const NANOID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** `size` (default 21) seeded draws from the URL-safe alphabet. */
export function nanoId(rnd: Rnd, size = 21): string {
  let out = '';
  for (let i = 0; i < size; i++) out += dgPick(rnd, NANOID_ALPHABET);
  return out;
}

// ── IMEI — 15 digits, Luhn check ─────────────────────────────────────────────

/** Reporting-body identifiers (the first two TAC digits) actually allocated:
 *  35 BABT, 01 CTIA, 86 TAF, 49 BZT, 91 MSAI. */
export const IMEI_RBIS = ['35', '01', '86', '49', '91'];

/**
 * IMEI: 8-digit TAC (a real reporting-body prefix + 6 drawn digits) + 6-digit
 * serial + Luhn check digit — or a wrong one when `!valid`.
 */
export function imei(rnd: Rnd, valid = true): string {
  const body = dgPickArr(rnd, IMEI_RBIS) + dgDigits(rnd, 12);
  return luhnAppend(body, valid);
}

// ── VIN — ISO 3779, position-9 weighted mod-11 check ─────────────────────────

/** VIN character set: A–Z and 0–9 without I, O, Q (33 characters). */
export const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
/** Real WMIs: 1HG Honda (US), WBA BMW, JM1 Mazda, TMB Škoda, WVW VW, WDB Mercedes. */
export const VIN_WMIS = ['1HG', 'WBA', 'JM1', 'TMB', 'WVW', 'WDB'];
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const VIN_VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
function vinValue(ch: string): number {
  return ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : VIN_VALUES[ch] ?? 0;
}

/**
 * ISO 3779 check character (position 9) for a 17-character VIN. Position 9 has
 * weight 0, so `vin17` may carry ANY placeholder there — only the other 16
 * characters matter. 10 is rendered as 'X'.
 */
export function vinCheckDigit(vin17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += vinValue(vin17[i]) * VIN_WEIGHTS[i];
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

/**
 * VIN: a real WMI + 5 drawn VDS characters + the ISO 3779 check + 8 drawn VIS
 * characters — or, when `!valid`, a wrong check character ('X' corrupts to
 * '0', digits step by one), keeping the 17-character no-I/O/Q shape.
 */
export function vin(rnd: Rnd, valid = true): string {
  const wmi = dgPickArr(rnd, VIN_WMIS);
  let vds = '';
  for (let i = 0; i < 5; i++) vds += dgPick(rnd, VIN_CHARS);
  let vis = '';
  for (let i = 0; i < 8; i++) vis += dgPick(rnd, VIN_CHARS);
  const c = vinCheckDigit(wmi + vds + '0' + vis);
  const check = valid ? c : c === 'X' ? '0' : String((Number(c) + 1) % 10);
  return wmi + vds + check + vis;
}

// ── ISIN — ISO 6166, Luhn over the letter-expanded digits ────────────────────

export const ISIN_COUNTRIES = ['CZ', 'DE', 'FR', 'GB', 'JP', 'US'];
const ISIN_NSIN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * ISIN check digit: expand the 11-character body (country + NSIN) letter-wise
 * (A=10…Z=35) into a digit string, then take the Luhn check digit of it.
 */
export function isinCheckDigit(body11: string): number {
  let expanded = '';
  for (const ch of body11) {
    const code = ch.charCodeAt(0);
    expanded += code >= 65 ? String(code - 55) : ch;
  }
  return luhnCheckDigit(expanded);
}

/** 2-letter country + 9 alphanumeric NSIN + Luhn check digit, or a wrong one. */
export function isin(rnd: Rnd, valid = true): string {
  const country = dgPickArr(rnd, ISIN_COUNTRIES);
  let nsin = '';
  for (let i = 0; i < 9; i++) nsin += dgPick(rnd, ISIN_NSIN_CHARS);
  const c = isinCheckDigit(country + nsin);
  return country + nsin + String(valid ? c : (c + 1) % 10);
}

// ── DOI — ISO 26324, no check digit ──────────────────────────────────────────

const DOI_SUFFIX_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789.-';

/**
 * `10.NNNNN/<suffix>`: a 4–5 digit registrant code and an opaque suffix of
 * 6–10 characters (alphanumeric plus `.` and `-`). The DOI standard defines
 * NO check digit — a DOI is an opaque string — so there is deliberately no
 * `valid` toggle on this generator.
 */
export function doi(rnd: Rnd): string {
  const registrant = dgInt(rnd, 1000, 99999);
  const len = dgInt(rnd, 6, 10);
  let suffix = '';
  for (let i = 0; i < len; i++) suffix += dgPick(rnd, DOI_SUFFIX_CHARS);
  return `10.${registrant}/${suffix}`;
}

// ── SHA-256 (pure, dependency-free) — needed for base58check ─────────────────

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr32 = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

/**
 * Pure SHA-256 over a byte array. Sized for base58check payloads (a few dozen
 * bytes), so the 64-bit length padding assumes < 2^32 bits — far past anything
 * here. Exported as hex only (`sha256Hex`) so tests can pin the FIPS vectors.
 */
function sha256Bytes(msg: number[]): number[] {
  const bytes = msg.slice();
  const bitLen = msg.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  bytes.push(0, 0, 0, 0,
    (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  for (let block = 0; block < bytes.length; block += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = ((bytes[block + t * 4] << 24) | (bytes[block + t * 4 + 1] << 16)
        | (bytes[block + t * 4 + 2] << 8) | bytes[block + t * 4 + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = (rotr32(w[t - 15], 7) ^ rotr32(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      const s1 = (rotr32(w[t - 2], 17) ^ rotr32(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const s1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + s1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const s0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out: number[] = [];
  for (const x of h) out.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  return out;
}

/** Lowercase hex digest of `bytes` under pure SHA-256. */
export function sha256Hex(bytes: number[]): string {
  return sha256Bytes(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── BTC address — base58check over a seeded hash160 ──────────────────────────

export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: number[]): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Repeated multiply-accumulate of a little-endian base-58 digit array.
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

/** `payload` + the first 4 bytes of its double SHA-256, base58-encoded. */
export function base58Check(payload: number[]): string {
  const checksum = sha256Bytes(sha256Bytes(payload)).slice(0, 4);
  return base58Encode([...payload, ...checksum]);
}

/**
 * A P2PKH-style bitcoin address: version byte 0x00 + 20 seeded bytes (the
 * "hash160" slot) + the 4-byte double-SHA-256 checksum, base58check-encoded.
 * The 20 bytes are drawn, not hashed out of a keypair — this is test data, not
 * a wallet; only the checksum has to be real, and it is.
 */
export function btcAddress(rnd: Rnd): string {
  const payload = [0x00];
  for (let i = 0; i < 20; i++) payload.push(Math.floor(rnd() * 256));
  return base58Check(payload);
}

// ── ETH address — 40 seeded hex nibbles ──────────────────────────────────────

/**
 * `0x` + 40 seeded hex nibbles, lowercase. The EIP-55 mixed-case checksum is
 * deliberately NOT applied: it is keyed on keccak-256 (the pre-standardisation
 * SHA-3 variant), which this dependency-free module does not carry, and a wrong
 * checksum would be worse than none — lowercase is what every tool accepts.
 */
export function ethAddress(rnd: Rnd): string {
  let out = '0x';
  for (let i = 0; i < 40; i++) out += Math.floor(rnd() * 16).toString(16);
  return out;
}

// ── Card expiry + CVV — the coherent companions of `creditCard` ──────────────

/**
 * `MM/YY` with the year drawn from [`fromYear`, `toYear`] but never earlier
 * than the reference date (`refYear`/`refMonth`, defaulting to January of
 * `fromYear`) — an expired card is a data bug in most fixtures, not a fixture.
 */
export function cardExpiry(
  rnd: Rnd, fromYear: number, toYear: number, refYear = fromYear, refMonth = 1,
): string {
  const lo = Math.max(fromYear, refYear);
  const hi = Math.max(lo, toYear);
  const year = dgInt(rnd, lo, hi);
  const monthLo = year === refYear ? Math.min(12, Math.max(1, refMonth)) : 1;
  const month = dgInt(rnd, monthLo, 12);
  return `${dgPad2(month)}/${dgPad2(year % 100)}`;
}

/** CVV: 3 digits, 4 for amex (CID) — matching the `creditCard` brand param. */
export function cardCvv(rnd: Rnd, brand = ''): string {
  return dgDigits(rnd, brand === 'amex' ? 4 : 3);
}
