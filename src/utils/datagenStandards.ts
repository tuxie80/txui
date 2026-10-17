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


// ── Phase 3 batch 2 — banks, national IDs, VAT, plates, airports, colors ─────
//
// Same contract as batch 1: PURE functions over the seeded `rnd`, ported
// line-for-line in `src-tauri/src/commands/datagen_ident.rs` with the SAME draw
// order. National IDs and VATs are per-country generators (usSsn, plPesel, …)
// rather than one locale-gated generator: the picker has no locale-gating
// mechanism for generator ids, and the czBirthNumber/ukNino/jpMyNumber
// precedent is one id per country. `valid: false` corrupts ONLY the check
// digit where the standard defines one; generators over standards with no
// public check digit (DE VAT, US EIN) have no toggle at all.

const dgPad3 = (n: number) => String(n).padStart(3, '0');

// ── US ABA routing number — 9 digits, 3-7-1 weighted checksum ───────────────

/**
 * ABA routing prefixes (the first two digits) actually assigned: 01–12 Federal
 * Reserve banks, 21–32 thrift institutions, 61–72 electronic transactions.
 * (80 is travelers' cheques — deliberately not generated.)
 */
export const ABA_PREFIXES: readonly string[] = [
  ...Array.from({ length: 12 }, (_, i) => dgPad2(i + 1)),
  ...Array.from({ length: 12 }, (_, i) => dgPad2(i + 21)),
  ...Array.from({ length: 12 }, (_, i) => dgPad2(i + 61)),
];

/** Check digit (d9) of an 8-digit ABA body: 3(d1+d4+d7)+7(d2+d5+d8)+(d3+d6) ≡ 0 (mod 10). */
export function abaCheckDigit(body8: string): number {
  const d = (i: number) => body8.charCodeAt(i) - 48;
  const sum = 3 * (d(0) + d(3) + d(6)) + 7 * (d(1) + d(4) + d(7)) + (d(2) + d(5));
  return (10 - (sum % 10)) % 10;
}

/** ABA routing number: real prefix + 6 digits + check digit, or a wrong check. */
export function abaRouting(rnd: Rnd, valid = true): string {
  const body = dgPickArr(rnd, ABA_PREFIXES) + dgDigits(rnd, 6);
  const c = abaCheckDigit(body);
  return body + String(valid ? c : (c + 1) % 10);
}

// ── IBAN BBAN shapes (ISO 13616 per-country) ─────────────────────────────────
//
// The MOD-97 check digits themselves are computed by `iban()` above; this
// draws the country-shaped body. CZ/GB/JP reproduce the pre-batch-2 registry
// arms draw-for-draw (byte-identical output for the same seed). FR's BBAN
// account field is officially alphanumeric — only the numeric subset is
// drawn here (documented simplification; the check digit handles letters
// either way).

/**
 * Draw the BBAN for `country` (CZ, GB, JP, DE, FR, ES, PL; anything else falls
 * back to the CZ shape). Total IBAN lengths: CZ 24, GB 22, JP 19 (synthetic —
 * Japan has no ISO IBAN scheme), DE 22, FR 27, ES 24, PL 28.
 */
export function ibanBban(rnd: Rnd, country: string): string {
  switch (country) {
    case 'GB': {
      const bank = Array.from({ length: 4 }, () => dgPick(rnd, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')).join('');
      return bank + dgDigits(rnd, 6) + dgDigits(rnd, 8);       // bank + sort code + account
    }
    case 'JP':
      return dgDigits(rnd, 4) + dgDigits(rnd, 3) + dgDigits(rnd, 8); // bank + branch + account
    case 'DE':
      return dgDigits(rnd, 8) + dgDigits(rnd, 10);             // BLZ + account
    case 'FR':
      return dgDigits(rnd, 5) + dgDigits(rnd, 5) + dgDigits(rnd, 11) + dgDigits(rnd, 2);
    case 'ES':
      return dgDigits(rnd, 4) + dgDigits(rnd, 4) + dgDigits(rnd, 2) + dgDigits(rnd, 10);
    case 'PL':
      return dgDigits(rnd, 8) + dgDigits(rnd, 16);             // bank + account
    default: // CZ
      return String(dgInt(rnd, 1000, 9999)) + dgDigits(rnd, 16);
  }
}

// ── US SSN — area/group/serial issuance rules (no check digit) ───────────────

/**
 * US Social Security number `AAA-GG-SSSS` honouring the SSA issuance rules:
 * area is never 000, 666 or 9xx (drawn 001–899 with 666 redrawn), group never
 * 00, serial never 0000. The SSN has NO check digit, so the `valid: false`
 * form is structural — a 0000 serial — the same convention as ukNino's
 * out-of-range suffix: same draws, one field forced invalid.
 */
export function usSsn(rnd: Rnd, valid = true): string {
  let area: number;
  do { area = dgInt(rnd, 1, 899); } while (area === 666);
  const group = dgInt(rnd, 1, 99);
  const drawn = dgInt(rnd, 1, 9999); // drawn either way — the toggle must not shift the stream
  const serial = valid ? drawn : 0;
  return `${dgPad3(area)}-${dgPad2(group)}-${String(serial).padStart(4, '0')}`;
}

// ── PL PESEL — 11 digits, weighted mod-10 check + birthdate coherence ────────

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];

/** Check digit (the 11th) of a 10-digit PESEL prefix: Σ wᵢdᵢ mod 10, complemented. */
export function peselCheckDigit(body10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (body10.charCodeAt(i) - 48) * PESEL_WEIGHTS[i];
  return (10 - (sum % 10)) % 10;
}

/**
 * PESEL: YYMMDD + 3-digit serial + gender digit + check. Birthdate coherence:
 * years 00–24 are encoded as 2000s births (month + 20), 25–99 as 1900s births
 * (the 1800/2100/2200 encodings are not drawn — the month offset is the only
 * century signal and two centuries keep every produced value plausible).
 * The check digit is corrupted when `!valid`.
 */
export function plPesel(rnd: Rnd, valid = true): string {
  const yy = dgInt(rnd, 0, 99);
  const mmBase = dgInt(rnd, 1, 12);
  const mm = yy <= 24 ? mmBase + 20 : mmBase;
  const dd = dgInt(rnd, 1, 28);
  const body = dgPad2(yy) + dgPad2(mm) + dgPad2(dd) + dgDigits(rnd, 3) + String(dgInt(rnd, 0, 9));
  const c = peselCheckDigit(body);
  return body + String(valid ? c : (c + 1) % 10);
}

// ── DE Steuer-ID — 11 digits, ISO 7064 MOD 11,10 ─────────────────────────────

/**
 * Check digit (the 11th) of a German Steuerliche Identifikationsnummer over
 * its first 10 digits — the ISO 7064 MOD 11,10 iterative algorithm the BZSt
 * specifies. Known-good reference: 8609574271 → 9 (86095742719 is the worked
 * example in the public documentation of the scheme).
 */
export function steuerIdCheckDigit(first10: string): number {
  let p = 10;
  for (let i = 0; i < 10; i++) {
    let s = (first10.charCodeAt(i) - 48 + p) % 10;
    if (s === 0) s = 10;
    p = (2 * s) % 11;
  }
  return (11 - p) % 10;
}

/**
 * Among the first 10 digits, exactly one digit value must appear two or three
 * times and every other value exactly once — the structural rule the BZSt
 * assigns by. Bodies failing it are redrawn (identically in Rust).
 */
export function steuerIdDigitsOk(first10: string): boolean {
  const counts = new Map<string, number>();
  for (const ch of first10) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let twice = 0;
  for (const c of counts.values()) {
    if (c === 1) continue;
    if (c === 2 || c === 3) { twice++; continue; }
    return false; // a value appearing 4+ times is never assigned
  }
  return twice === 1;
}

/** Steuer-ID: first digit 1–9, the one-repeated-digit rule, ISO 7064 check. */
export function deSteuerId(rnd: Rnd, valid = true): string {
  let body: string;
  do {
    body = String(dgInt(rnd, 1, 9)) + dgDigits(rnd, 9);
  } while (!steuerIdDigitsOk(body));
  const c = steuerIdCheckDigit(body);
  return body + String(valid ? c : (c + 1) % 10);
}

// ── FR NIR (numéro de sécurité sociale) — 13 digits + 2-digit key ────────────

/** NIR key: 97 − (the 13-digit number mod 97), computed digit by digit. */
export function nirKey(body13: string): number {
  let m = 0;
  for (let i = 0; i < 13; i++) m = (m * 10 + (body13.charCodeAt(i) - 48)) % 97;
  return 97 - m;
}

/**
 * French NIR: sex (1/2) + YY + MM + department (01–95) + 3-digit commune +
 * 3-digit order + the 2-digit key. SIMPLIFICATION: Corsica's 2A/2B (whose key
 * arithmetic substitutes 19/18 with a million-place adjustment) are never
 * drawn — only mainland departments 01–95 — and overseas 97x are out of scope.
 * `!valid` shifts the key by one inside its 01–97 range.
 */
export function frNir(rnd: Rnd, valid = true): string {
  const body = String(dgInt(rnd, 1, 2)) + dgPad2(dgInt(rnd, 0, 99)) + dgPad2(dgInt(rnd, 1, 12))
    + dgPad2(dgInt(rnd, 1, 95)) + dgPad3(dgInt(rnd, 1, 999)) + dgPad3(dgInt(rnd, 1, 999));
  const k = nirKey(body);
  return body + dgPad2(valid ? k : (k % 97) + 1);
}

// ── ES DNI / NIE — letter = number mod 23 ────────────────────────────────────

/** The DNI control-letter table (position = number mod 23). */
export const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/**
 * Spanish DNI (8 digits + control letter) or NIE (X/Y/Z + 7 digits + letter,
 * the prefix counting as 0/1/2 in the mod-23 number). Reference: 12345678 → Z.
 * `!valid` steps the letter one position down the table.
 */
export function esDni(rnd: Rnd, valid = true): string {
  const isNie = dgInt(rnd, 0, 1) === 1;
  const prefix = isNie ? dgPick(rnd, 'XYZ') : '';
  const digits7 = dgInt(rnd, 0, 9999999);
  const last = dgInt(rnd, 0, 9); // the 8th digit for a DNI; unused draw for a NIE
  const number = (isNie ? 'XYZ'.indexOf(prefix) * 10000000 : 0)
    + (isNie ? digits7 : digits7 * 10 + last);
  const idx = number % 23;
  const letter = DNI_LETTERS[valid ? idx : (idx + 1) % 23];
  return isNie
    ? `${prefix}${String(digits7).padStart(7, '0')}${letter}`
    : `${String(digits7).padStart(7, '0')}${last}${letter}`;
}

// ── VAT IDs ──────────────────────────────────────────────────────────────────

/**
 * German USt-IdNr: `DE` + 9 digits, the first never 0. There is NO public
 * check digit for the German VAT id, so there is deliberately no `valid`
 * toggle — same reasoning as `doi`.
 */
export function deVat(rnd: Rnd): string {
  return 'DE' + String(dgInt(rnd, 1, 9)) + dgDigits(rnd, 8);
}

/** French TVA key for a 9-digit SIREN: (12 + 3 × (SIREN mod 97)) mod 97. */
export function frVatKey(siren9: string): number {
  let m = 0;
  for (let i = 0; i < 9; i++) m = (m * 10 + (siren9.charCodeAt(i) - 48)) % 97;
  return (12 + 3 * m) % 97;
}

/** French TVA intracommunautaire: `FR` + 2-digit key + 9-digit SIREN. */
export function frVat(rnd: Rnd, valid = true): string {
  const siren = dgDigits(rnd, 9);
  const k = frVatKey(siren);
  return `FR${dgPad2(valid ? k : (k + 1) % 97)}${siren}`;
}

/**
 * Spanish VAT in the entity (CIF) shape: `ES` + a mercantile-entity letter
 * (A–H only) + 7 digits + a DIGIT control. Simplifications, documented: the
 * letter-control variant (which some entity letters require), the K/L/M/X
 * letter prefixes and the individual ES+DNI-letter form are all out of scope.
 * Control: odd-position digits (1-based) doubled and digit-summed, even ones
 * added plain; control = (10 − total mod 10) mod 10.
 */
export const CIF_LETTERS = 'ABCDEFGH';
export function esVat(rnd: Rnd, valid = true): string {
  const letter = dgPick(rnd, CIF_LETTERS);
  const body = String(dgInt(rnd, 0, 9999999)).padStart(7, '0');
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    let d = body.charCodeAt(i) - 48;
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  const c = (10 - (sum % 10)) % 10;
  return `ES${letter}${body}${valid ? c : (c + 1) % 10}`;
}

const PL_VAT_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];

/** Check digit (the 10th) of a Polish NIP body: Σ wᵢdᵢ mod 11 (10 = no check). */
export function plVatCheckDigit(body9: string): number {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (body9.charCodeAt(i) - 48) * PL_VAT_WEIGHTS[i];
  return sum % 11;
}

/**
 * Polish NIP: `PL` + 9-digit body + mod-11 check. Bodies whose remainder is
 * 10 have no check digit and are never issued — redrawn, identically in Rust.
 * Reference: 1234563218 validates (check 8).
 */
export function plVat(rnd: Rnd, valid = true): string {
  let body: string;
  let c: number;
  do {
    body = dgDigits(rnd, 9);
    c = plVatCheckDigit(body);
  } while (c === 10);
  return `PL${body}${valid ? c : (c + 1) % 10}`;
}

/**
 * Real IRS campus prefix ranges for an Employer Identification Number
 * (Andover 01–06, Atlanta 60/67, Austin 50/53, Brookhaven 02–05/11–13/…,
 * Cincinnati 17/31, Fresno 88/94, Kansas City 43/48, Memphis 62/64, Ogden
 * 80–88, Philadelphia 23/33/…, plus the internet-assigned 20–27/45–47/81–84).
 * This list is a representative subset of the assigned prefixes, not all.
 */
export const EIN_PREFIXES: readonly string[] = [
  '01', '02', '03', '04', '05', '06', '10', '11', '12', '13', '14', '15', '16',
  '20', '21', '22', '23', '26', '27', '30', '31', '32', '33', '34', '35', '36',
  '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47', '48',
  '50', '51', '52', '53', '54', '55', '56', '57', '58', '59', '60', '61', '62',
  '63', '64', '65', '66', '67', '68', '71', '72', '73', '74', '75', '76', '77',
  '80', '81', '82', '83', '84', '85', '86', '87', '88', '90', '91', '92', '93',
  '94', '95', '98', '99',
];

/** US EIN `XX-XXXXXXX` with a real campus prefix. No checksum → no toggle. */
export function usEin(rnd: Rnd): string {
  return `${dgPickArr(rnd, EIN_PREFIXES)}-${String(dgInt(rnd, 0, 9999999)).padStart(7, '0')}`;
}

// ── License plates (localized formats) ───────────────────────────────────────

/** Real German registration-district codes (a representative subset). */
export const DE_PLATE_DISTRICTS: readonly string[] = [
  'B', 'M', 'K', 'F', 'S', 'H', 'D', 'N', 'E', 'L', 'A', 'C', 'W', 'DD', 'HH', 'DO',
];
const PLATE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** German plate: district + 1–2 letters + 1–4 digits (`B AB 1234`). */
export function dePlate(rnd: Rnd): string {
  const district = dgPickArr(rnd, DE_PLATE_DISTRICTS);
  const n = dgInt(rnd, 1, 2);
  let letters = '';
  for (let i = 0; i < n; i++) letters += dgPick(rnd, PLATE_LETTERS);
  return `${district} ${letters} ${dgInt(rnd, 1, 9999)}`;
}

// UK post-2001 letters exclude I and Q.
const UK_PLATE_CHARS = 'ABCDEFGHJKLMNOPRSTUVWXYZ';

/**
 * UK post-2001 plate `AB51 CDE`: two local-tag letters (I and Q never used),
 * the two-digit age identifier — one draw picks the half (51–75 September /
 * 02–24 March series), one the year — then three letters.
 */
export function ukPlate(rnd: Rnd): string {
  const a = dgPick(rnd, UK_PLATE_CHARS) + dgPick(rnd, UK_PLATE_CHARS);
  const age = dgInt(rnd, 0, 1) === 0 ? String(dgInt(rnd, 51, 75)) : dgPad2(dgInt(rnd, 2, 24));
  const tail = dgPick(rnd, UK_PLATE_CHARS) + dgPick(rnd, UK_PLATE_CHARS) + dgPick(rnd, UK_PLATE_CHARS);
  return `${a}${age} ${tail}`;
}

/** Japanese plate issuing offices, romanized (the plates themselves use kanji). */
export const JP_PLATE_OFFICES: readonly string[] = [
  'SHINAGAWA', 'NERIMA', 'ADACHI', 'YOKOHAMA', 'NAGOYA', 'OSAKA', 'FUKUOKA', 'SAPPORO',
];
/** Real 3-digit classification numbers: 3xx ordinary cars, 5xx kei cars. */
export const JP_PLATE_CLASSES: readonly string[] = [
  '301', '302', '303', '305', '500', '501', '502', '503', '505',
];

/**
 * Japanese plate, ASCII-SAFE variant: romanized office + real 3-digit class +
 * one Latin letter standing in for the hiragana + `NN-NN`. The genuine format
 * is 品川 500 あ 12-34; shipping test data into VARCHAR columns across engines
 * argues for ASCII, and the hiragana slot carries no checksum so a Latin
 * placeholder loses nothing. Documented simplification.
 */
export function jpPlate(rnd: Rnd): string {
  const office = dgPickArr(rnd, JP_PLATE_OFFICES);
  const cls = dgPickArr(rnd, JP_PLATE_CLASSES);
  const letter = dgPick(rnd, PLATE_LETTERS);
  const num = String(dgInt(rnd, 1, 9999)).padStart(4, '0');
  return `${office} ${cls} ${letter} ${num.slice(0, 2)}-${num.slice(2)}`;
}

/** US plate, the generic 3-letters + 4-digits layout (`ABC 1234`). */
export function usPlate(rnd: Rnd): string {
  const letters = dgPick(rnd, PLATE_LETTERS) + dgPick(rnd, PLATE_LETTERS) + dgPick(rnd, PLATE_LETTERS);
  return `${letters} ${String(dgInt(rnd, 0, 9999)).padStart(4, '0')}`;
}

// ── Airports — IATA code with its real coordinates, coherent by construction ──

/**
 * Fifty real international airports as `[IATA, lat, lon]` string triples.
 * Coordinates stay STRINGS so both tiers emit the stored value verbatim — a
 * float round-trip risks a formatting difference between JS and Rust.
 */
export const AIRPORTS: readonly (readonly [string, string, string])[] = [
  ['JFK', '40.6413', '-73.7781'], ['LAX', '33.9416', '-118.4085'],
  ['ORD', '41.9742', '-87.9073'], ['ATL', '33.6407', '-84.4277'],
  ['DFW', '32.8998', '-97.0403'], ['DEN', '39.8561', '-104.6737'],
  ['SFO', '37.6213', '-122.3790'], ['SEA', '47.4502', '-122.3088'],
  ['MIA', '25.7959', '-80.2870'], ['BOS', '42.3656', '-71.0096'],
  ['LHR', '51.4700', '-0.4543'], ['CDG', '49.0097', '2.5479'],
  ['AMS', '52.3105', '4.7683'], ['FRA', '50.0379', '8.5622'],
  ['MAD', '40.4983', '-3.5676'], ['BCN', '41.2974', '2.0833'],
  ['FCO', '41.8003', '12.2389'], ['ZRH', '47.4647', '8.5492'],
  ['VIE', '48.1103', '16.5697'], ['PRG', '50.1008', '14.2600'],
  ['WAW', '52.1657', '20.9671'], ['IST', '41.2753', '28.7519'],
  ['DXB', '25.2532', '55.3657'], ['DOH', '25.2731', '51.6081'],
  ['SIN', '1.3644', '103.9915'], ['HKG', '22.3080', '113.9185'],
  ['ICN', '37.4602', '126.4407'], ['NRT', '35.7720', '140.3929'],
  ['HND', '35.5494', '139.7798'], ['PEK', '40.0799', '116.6031'],
  ['PVG', '31.1443', '121.8083'], ['DEL', '28.5562', '77.1000'],
  ['BOM', '19.0896', '72.8656'], ['BKK', '13.6900', '100.7501'],
  ['KUL', '2.7456', '101.7099'], ['SYD', '-33.9399', '151.1753'],
  ['MEL', '-37.6690', '144.8410'], ['AKL', '-37.0082', '174.7850'],
  ['GRU', '-23.4356', '-46.4731'], ['EZE', '-34.8222', '-58.5358'],
  ['MEX', '19.4363', '-99.0721'], ['YYZ', '43.6777', '-79.6248'],
  ['YVR', '49.1967', '-123.1815'], ['JNB', '-26.1367', '28.2411'],
  ['CAI', '30.1219', '31.4056'], ['LOS', '6.5774', '3.3212'],
  ['NBO', '-1.3192', '36.9278'], ['CPH', '55.6180', '12.6560'],
  ['ARN', '59.6519', '17.9186'], ['OSL', '60.1939', '11.1004'],
];

/**
 * One coherent airport value: `JFK (40.6413, -73.7781)`. A single generator
 * rather than a code/lat/lon pair — two generators would draw independently
 * and the coordinates would not match the code, which is worse than one
 * combined string in a VARCHAR column.
 */
export function airport(rnd: Rnd): string {
  const [code, lat, lon] = dgPickArr(rnd, AIRPORTS);
  return `${code} (${lat}, ${lon})`;
}

// ── Colors ───────────────────────────────────────────────────────────────────

/** `#rrggbb` — the web/DB convention for a color column. */
export function colorHex(rnd: Rnd): string {
  let out = '#';
  for (let i = 0; i < 6; i++) out += Math.floor(rnd() * 16).toString(16);
  return out;
}

/** CSS `rgb(r, g, b)`. */
export function colorRgb(rnd: Rnd): string {
  return `rgb(${dgInt(rnd, 0, 255)}, ${dgInt(rnd, 0, 255)}, ${dgInt(rnd, 0, 255)})`;
}

/** CSS `hsl(h, s%, l%)`. */
export function colorHsl(rnd: Rnd): string {
  return `hsl(${dgInt(rnd, 0, 359)}, ${dgInt(rnd, 0, 100)}%, ${dgInt(rnd, 0, 100)}%)`;
}

// ── Avatar initials ──────────────────────────────────────────────────────────

/**
 * Two-letter initials from an already-drawn first/last name pair — the callers
 * (registry entry and Rust dispatch) draw from the SAME firstNames/lastNames
 * dictionary packs the name generators use, so the initials are consistent
 * with what a sibling fullName column would draw on the same stream.
 */
export function avatarInitials(first: string, last: string): string {
  const a = Array.from(first)[0] ?? '';
  const b = Array.from(last)[0] ?? '';
  return (a + b).toUpperCase();
}
