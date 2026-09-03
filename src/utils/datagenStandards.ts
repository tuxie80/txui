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
