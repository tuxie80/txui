//! Identifier generators — data-generator Phase 3 batch 1 ("identifier pack").
//!
//! Faithful ports of the identifier functions appended to
//! `src/utils/datagenStandards.ts`. Same contract as the Phase-3 ports in
//! `datagen.rs`: the seeded mulberry32 RNG is drawn in the SAME order on both
//! tiers, so a seed produces the same identifier in the browser and in the
//! volume engine. `valid == false` corrupts ONLY the check digit (IMEI, VIN,
//! ISIN); the time-ordered ids (UUID v7, ULID) derive their timestamp from a
//! base epoch + the row index so a run stays deterministic per (seed, row).
//!
//! WIRING (coordinator): these functions take `rng: &mut dyn FnMut() -> f64`
//! rather than `datagen.rs`'s private `Rng`, so the dispatch arms pass
//! `&mut || rng.next()` without exposing the RNG type:
//!
//! ```ignore
//! "imei" => GenValue::Str(datagen_ident::imei(&mut || rng.next(), valid_of(p))),
//! ```
//!
//! The module is deliberately dependency-free (SHA-256 for base58check is
//! implemented inline) so it also compiles standalone for a quick check:
//!
//! ```sh
//! rustc --edition 2021 --crate-type lib src/commands/datagen_ident.rs -o /tmp/datagen_ident_check.rlib
//! ```

// ── draw helpers (mirror the `dg…` helpers in datagenStandards.ts) ───────────

fn int(rng: &mut dyn FnMut() -> f64, min: i64, max: i64) -> i64 {
    (rng() * ((max - min + 1) as f64)).floor() as i64 + min
}

fn digits(rng: &mut dyn FnMut() -> f64, n: usize) -> String {
    (0..n).map(|_| std::char::from_digit(int(rng, 0, 9) as u32, 10).unwrap()).collect()
}

fn pick_char(rng: &mut dyn FnMut() -> f64, chars: &[u8]) -> char {
    chars[(rng() * chars.len() as f64).floor() as usize] as char
}

fn pick_str<'a>(rng: &mut dyn FnMut() -> f64, arr: &'a [&'a str]) -> &'a str {
    arr[(rng() * arr.len() as f64).floor() as usize]
}

fn hex_digit(rng: &mut dyn FnMut() -> f64) -> char {
    std::char::from_digit((rng() * 16.0) as u32, 16).unwrap()
}

/// Luhn check digit over ASCII-digit bytes (same rule as `luhnCheckDigit`).
fn luhn_check_digit(body: &[u8]) -> u32 {
    let mut sum = 0u32;
    let mut double = true;
    for &b in body.iter().rev() {
        let mut d = (b - b'0') as u32;
        if double {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
        double = !double;
    }
    (10 - (sum % 10)) % 10
}

fn corrupt10(c: u32) -> u32 {
    (c + 1) % 10
}

// ── UUID v7 (RFC 9562 §5.7) — time-ordered ───────────────────────────────────

/// UUIDv7: 48-bit unix epoch ms (`base_epoch_ms + row_idx`, 1 ms per row so the
/// ids sort in row order yet the run is reproducible), version 7, variant 10,
/// 74 seeded-random bits. Draw order: randA (3 hex), variant (1), 3 hex, 12 hex.
pub(crate) fn uuid_v7(rng: &mut dyn FnMut() -> f64, base_epoch_ms: u64, row_idx: u64) -> String {
    let ts = (base_epoch_ms + row_idx) % (1u64 << 48);
    let ts_hex = format!("{ts:012x}");
    let rand_a: String = (0..3).map(|_| hex_digit(rng)).collect();
    let variant = std::char::from_digit(8 + (rng() * 4.0) as u32, 16).unwrap();
    let rest1: String = (0..3).map(|_| hex_digit(rng)).collect();
    let rest2: String = (0..12).map(|_| hex_digit(rng)).collect();
    format!("{}-{}-7{rand_a}-{variant}{rest1}-{rest2}", &ts_hex[..8], &ts_hex[8..])
}

// ── ULID — 26-char Crockford base32, time-ordered ────────────────────────────

/// Crockford base32 (no I, L, O, U) — the ULID alphabet.
pub(crate) const ULID_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// ULID: 48-bit ms timestamp as 10 Crockford chars + 80 seeded-random bits as
/// 16 more. Same timestamp rule as `uuid_v7`.
pub(crate) fn ulid(rng: &mut dyn FnMut() -> f64, base_epoch_ms: u64, row_idx: u64) -> String {
    let mut ts = (base_epoch_ms + row_idx) % (1u64 << 48);
    let mut time = [b'0'; 10];
    for i in (0..10).rev() {
        time[i] = ULID_ALPHABET[(ts % 32) as usize];
        ts /= 32;
    }
    let rand: String = (0..16).map(|_| pick_char(rng, ULID_ALPHABET)).collect();
    format!("{}{rand}", std::str::from_utf8(&time).unwrap())
}

// ── nanoID — URL-safe, no structure ──────────────────────────────────────────

/// The nanoID URL alphabet (A-Za-z0-9 plus `-` and `_`), 64 characters.
pub(crate) const NANOID_ALPHABET: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/// `size` (21 by default) seeded draws from the URL-safe alphabet.
pub(crate) fn nano_id(rng: &mut dyn FnMut() -> f64, size: usize) -> String {
    (0..size).map(|_| pick_char(rng, NANOID_ALPHABET)).collect()
}

// ── IMEI — 15 digits, Luhn check ─────────────────────────────────────────────

/// Reporting-body identifiers (first two TAC digits) actually allocated:
/// 35 BABT, 01 CTIA, 86 TAF, 49 BZT, 91 MSAI.
pub(crate) const IMEI_RBIS: &[&str] = &["35", "01", "86", "49", "91"];

/// IMEI: 8-digit TAC (real reporting-body prefix + 6 drawn) + 6-digit serial +
/// Luhn check — or a wrong one when `!valid`.
pub(crate) fn imei(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let body = format!("{}{}", pick_str(rng, IMEI_RBIS), digits(rng, 12));
    let c = luhn_check_digit(body.as_bytes());
    format!("{body}{}", if valid { c } else { corrupt10(c) })
}

// ── VIN — ISO 3779, position-9 weighted mod-11 check ─────────────────────────

/// VIN character set: A–Z and 0–9 without I, O, Q (33 characters).
pub(crate) const VIN_CHARS: &[u8] = b"ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
/// Real WMIs: 1HG Honda (US), WBA BMW, JM1 Mazda, TMB Škoda, WVW VW, WDB Mercedes.
pub(crate) const VIN_WMIS: &[&str] = &["1HG", "WBA", "JM1", "TMB", "WVW", "WDB"];
const VIN_WEIGHTS: [u32; 17] = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

fn vin_value(c: u8) -> u32 {
    match c {
        b'0'..=b'9' => (c - b'0') as u32,
        b'A'..=b'H' => (c - b'A') as u32 + 1,
        b'J'..=b'N' => (c - b'J') as u32 + 1,
        b'P'..=b'R' => (c - b'P') as u32 + 7,
        b'S'..=b'Z' => (c - b'S') as u32 + 2,
        _ => 0,
    }
}

/// ISO 3779 check character (position 9) for a 17-character VIN. Position 9 has
/// weight 0, so `vin17` may carry ANY placeholder there. 10 renders as 'X'.
pub(crate) fn vin_check_digit(vin17: &str) -> char {
    let sum: u32 = vin17.bytes().zip(VIN_WEIGHTS).map(|(c, w)| vin_value(c) * w).sum();
    match sum % 11 {
        10 => 'X',
        r => std::char::from_digit(r, 10).unwrap(),
    }
}

/// VIN: real WMI + 5 drawn VDS chars + ISO 3779 check + 8 drawn VIS chars —
/// or, when `!valid`, a wrong check ('X' corrupts to '0', digits step by one).
pub(crate) fn vin(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let wmi = pick_str(rng, VIN_WMIS);
    let vds: String = (0..5).map(|_| pick_char(rng, VIN_CHARS)).collect();
    let vis: String = (0..8).map(|_| pick_char(rng, VIN_CHARS)).collect();
    let c = vin_check_digit(&format!("{wmi}{vds}0{vis}"));
    let check = if valid {
        c
    } else if c == 'X' {
        '0'
    } else {
        std::char::from_digit(corrupt10(c.to_digit(10).unwrap()), 10).unwrap()
    };
    format!("{wmi}{vds}{check}{vis}")
}

// ── ISIN — ISO 6166, Luhn over the letter-expanded digits ────────────────────

pub(crate) const ISIN_COUNTRIES: &[&str] = &["CZ", "DE", "FR", "GB", "JP", "US"];
const ISIN_NSIN_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/// ISIN check digit: expand the 11-char body (country + NSIN) letter-wise
/// (A=10…Z=35) into a digit string, then take its Luhn check digit.
pub(crate) fn isin_check_digit(body11: &str) -> u32 {
    let mut expanded = String::new();
    for c in body11.chars() {
        if c.is_ascii_uppercase() {
            expanded.push_str(&(c as u32 - 55).to_string());
        } else {
            expanded.push(c);
        }
    }
    luhn_check_digit(expanded.as_bytes())
}

/// 2-letter country + 9 alphanumeric NSIN + Luhn check digit, or a wrong one.
pub(crate) fn isin(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let country = pick_str(rng, ISIN_COUNTRIES);
    let nsin: String = (0..9).map(|_| pick_char(rng, ISIN_NSIN_CHARS)).collect();
    let c = isin_check_digit(&format!("{country}{nsin}"));
    format!("{country}{nsin}{}", if valid { c } else { corrupt10(c) })
}

// ── DOI — ISO 26324, no check digit ──────────────────────────────────────────

const DOI_SUFFIX_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789.-";

/// `10.NNNNN/<suffix>`: a 4–5 digit registrant code and an opaque 6–10 char
/// suffix (alphanumeric plus `.` and `-`). The DOI standard defines NO check
/// digit — a DOI is an opaque string — so there is deliberately no `valid`
/// toggle on this generator.
pub(crate) fn doi(rng: &mut dyn FnMut() -> f64) -> String {
    let registrant = int(rng, 1000, 99999);
    let len = int(rng, 6, 10) as usize;
    let suffix: String = (0..len).map(|_| pick_char(rng, DOI_SUFFIX_CHARS)).collect();
    format!("10.{registrant}/{suffix}")
}

// ── SHA-256 (pure, dependency-free) — needed for base58check ─────────────────

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// Pure SHA-256. Sized for base58check payloads (a few dozen bytes).
pub(crate) fn sha256(msg: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let bit_len = (msg.len() as u64) * 8;
    let mut data = msg.to_vec();
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());
    for block in data.chunks_exact(64) {
        let mut w = [0u32; 64];
        for t in 0..16 {
            w[t] = u32::from_be_bytes([
                block[t * 4], block[t * 4 + 1], block[t * 4 + 2], block[t * 4 + 3],
            ]);
        }
        for t in 16..64 {
            let s0 = w[t - 15].rotate_right(7) ^ w[t - 15].rotate_right(18) ^ (w[t - 15] >> 3);
            let s1 = w[t - 2].rotate_right(17) ^ w[t - 2].rotate_right(19) ^ (w[t - 2] >> 10);
            w[t] = w[t - 16]
                .wrapping_add(s0)
                .wrapping_add(w[t - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for t in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[t])
                .wrapping_add(w[t]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut out = [0u8; 32];
    for (i, x) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

// ── BTC address — base58check over a seeded hash160 ──────────────────────────

pub(crate) const BASE58_ALPHABET: &[u8] =
    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn base58_encode(bytes: &[u8]) -> String {
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    // Repeated multiply-accumulate of a little-endian base-58 digit array.
    let mut digits: Vec<u32> = vec![0];
    for &byte in bytes.iter().skip(zeros) {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += *d << 8;
            *d = carry % 58;
            carry /= 58;
        }
        while carry > 0 {
            digits.push(carry % 58);
            carry /= 58;
        }
    }
    let mut out = "1".repeat(zeros);
    for &d in digits.iter().rev() {
        out.push(BASE58_ALPHABET[d as usize] as char);
    }
    out
}

/// `payload` + the first 4 bytes of its double SHA-256, base58-encoded.
pub(crate) fn base58check_encode(payload: &[u8]) -> String {
    let first = sha256(payload);
    let second = sha256(&first);
    let mut full = payload.to_vec();
    full.extend_from_slice(&second[..4]);
    base58_encode(&full)
}

/// A P2PKH-style bitcoin address: version byte 0x00 + 20 seeded bytes (the
/// "hash160" slot) + the 4-byte double-SHA-256 checksum, base58check-encoded.
/// The 20 bytes are drawn, not hashed out of a keypair — this is test data,
/// not a wallet; only the checksum has to be real, and it is.
pub(crate) fn btc_address(rng: &mut dyn FnMut() -> f64) -> String {
    let mut payload = vec![0x00u8];
    for _ in 0..20 {
        payload.push((rng() * 256.0) as u8);
    }
    base58check_encode(&payload)
}

// ── ETH address — 40 seeded hex nibbles ──────────────────────────────────────

/// `0x` + 40 seeded hex nibbles, lowercase. The EIP-55 mixed-case checksum is
/// deliberately NOT applied: it is keyed on keccak-256 (the pre-standardisation
/// SHA-3 variant), which this dependency-free module does not carry, and a
/// wrong checksum would be worse than none — lowercase is what every tool
/// accepts.
pub(crate) fn eth_address(rng: &mut dyn FnMut() -> f64) -> String {
    let mut out = String::from("0x");
    for _ in 0..40 {
        out.push(hex_digit(rng));
    }
    out
}

// ── Card expiry + CVV — the coherent companions of `creditCard` ──────────────

/// `MM/YY` with the year drawn from [`from_year`, `to_year`] but never earlier
/// than the reference date (`ref_year`/`ref_month`) — an expired card is a
/// data bug in most fixtures, not a fixture.
pub(crate) fn card_expiry(
    rng: &mut dyn FnMut() -> f64,
    from_year: i64,
    to_year: i64,
    ref_year: i64,
    ref_month: i64,
) -> String {
    let lo = from_year.max(ref_year);
    let hi = lo.max(to_year);
    let year = int(rng, lo, hi);
    let month_lo = if year == ref_year { ref_month.clamp(1, 12) } else { 1 };
    let month = int(rng, month_lo, 12);
    format!("{month:02}/{:02}", year.rem_euclid(100))
}

/// CVV: 3 digits, 4 for amex (CID) — matching the `creditCard` brand param.
pub(crate) fn card_cvv(rng: &mut dyn FnMut() -> f64, brand: &str) -> String {
    digits(rng, if brand == "amex" { 4 } else { 3 })
}

// ── Phase 3 batch 2 — banks, national IDs, VAT, plates, airports, colors ─────
//
// Ports of the batch-2 section of `src/utils/datagenStandards.ts`. Same draw
// order, same `valid` convention (corrupt ONLY the check digit where the
// standard defines one; DE VAT and US EIN have no public check digit and no
// toggle). Per-country generator ids mirror the czBirthNumber/ukNino
// precedent — the picker has no locale-gating mechanism.

/// ABA routing prefix (first two digits) by drawn index 0–35: the TS
/// `ABA_PREFIXES` array is 01–12, 21–32, 61–72 concatenated, so index i maps
/// to i+1, i+9 or i+37 — the same list without materialising it.
fn aba_prefix(idx: i64) -> String {
    let v = if idx < 12 { idx + 1 } else if idx < 24 { idx + 9 } else { idx + 37 };
    format!("{v:02}")
}

/// Check digit (d9) of an 8-digit ABA body: 3(d1+d4+d7)+7(d2+d5+d8)+(d3+d6) ≡ 0.
pub(crate) fn aba_check_digit(body8: &str) -> u32 {
    let b = body8.as_bytes();
    let d = |i: usize| (b[i] - b'0') as u32;
    let sum = 3 * (d(0) + d(3) + d(6)) + 7 * (d(1) + d(4) + d(7)) + (d(2) + d(5));
    (10 - (sum % 10)) % 10
}

/// ABA routing number: real prefix + 6 digits + check digit, or a wrong check.
pub(crate) fn aba_routing(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let body = format!("{}{}", aba_prefix(int(rng, 0, 35)), digits(rng, 6));
    let c = aba_check_digit(&body);
    format!("{body}{}", if valid { c } else { corrupt10(c) })
}

// ── IBAN BBAN shapes (ISO 13616 per-country) ─────────────────────────────────

/// The BBAN for `country` (CZ, GB, JP, DE, FR, ES, PL; anything else → CZ),
/// drawn in the SAME order as `ibanBban` in datagenStandards.ts. FR's account
/// field is officially alphanumeric — only the numeric subset is drawn
/// (documented simplification; the MOD-97 check handles letters either way).
pub(crate) fn iban_bban(rng: &mut dyn FnMut() -> f64, country: &str) -> String {
    const L: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    match country {
        "GB" => {
            let bank: String = (0..4).map(|_| pick_char(rng, L)).collect();
            format!("{bank}{}{}", digits(rng, 6), digits(rng, 8))
        }
        "JP" => format!("{}{}{}", digits(rng, 4), digits(rng, 3), digits(rng, 8)),
        "DE" => format!("{}{}", digits(rng, 8), digits(rng, 10)),
        "FR" => format!("{}{}{}{}", digits(rng, 5), digits(rng, 5), digits(rng, 11), digits(rng, 2)),
        "ES" => format!("{}{}{}{}", digits(rng, 4), digits(rng, 4), digits(rng, 2), digits(rng, 10)),
        "PL" => format!("{}{}", digits(rng, 8), digits(rng, 16)),
        _ => format!("{}{}", int(rng, 1000, 9999), digits(rng, 16)), // CZ
    }
}

// ── US SSN — area/group/serial issuance rules (no check digit) ───────────────

/// SSN `AAA-GG-SSSS`: area never 000/666/9xx (666 redrawn), group never 00,
/// serial never 0000. No check digit exists, so `!valid` is structural — a
/// 0000 serial — with the serial still DRAWN so the stream does not shift.
pub(crate) fn us_ssn(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let mut area = int(rng, 1, 899);
    while area == 666 {
        area = int(rng, 1, 899);
    }
    let group = int(rng, 1, 99);
    let drawn = int(rng, 1, 9999);
    let serial = if valid { drawn } else { 0 };
    format!("{area:03}-{group:02}-{serial:04}")
}

// ── PL PESEL — 11 digits, weighted mod-10 check + birthdate coherence ────────

const PESEL_WEIGHTS: [u32; 10] = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];

/// Check digit (the 11th) of a 10-digit PESEL prefix.
pub(crate) fn pesel_check_digit(body10: &str) -> u32 {
    let sum: u32 = body10
        .bytes()
        .zip(PESEL_WEIGHTS)
        .map(|(b, w)| (b - b'0') as u32 * w)
        .sum();
    (10 - (sum % 10)) % 10
}

/// PESEL: YYMMDD (years 00–24 encode as 2000s births, month + 20) + 3-digit
/// serial + gender digit + check — or a wrong check when `!valid`.
pub(crate) fn pl_pesel(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let yy = int(rng, 0, 99);
    let mm_base = int(rng, 1, 12);
    let mm = if yy <= 24 { mm_base + 20 } else { mm_base };
    let dd = int(rng, 1, 28);
    let body = format!(
        "{yy:02}{mm:02}{dd:02}{}{}",
        digits(rng, 3),
        int(rng, 0, 9)
    );
    let c = pesel_check_digit(&body);
    format!("{body}{}", if valid { c } else { corrupt10(c) })
}

// ── DE Steuer-ID — 11 digits, ISO 7064 MOD 11,10 ─────────────────────────────

/// Check digit (the 11th) of a Steuer-ID over its first 10 digits — the ISO
/// 7064 MOD 11,10 iterative algorithm. Reference: 8609574271 → 9.
pub(crate) fn steuer_id_check_digit(first10: &str) -> u32 {
    let mut p = 10u32;
    for b in first10.bytes() {
        let mut s = ((b - b'0') as u32 + p) % 10;
        if s == 0 {
            s = 10;
        }
        p = (2 * s) % 11;
    }
    (11 - p) % 10
}

/// The BZSt structural rule for the first 10 digits: exactly one digit value
/// appears two or three times, every other value exactly once.
pub(crate) fn steuer_id_digits_ok(first10: &str) -> bool {
    let mut counts = [0u8; 10];
    for b in first10.bytes() {
        counts[(b - b'0') as usize] += 1;
    }
    let mut repeated = 0;
    for &c in &counts {
        match c {
            0 | 1 => {}
            2 | 3 => repeated += 1,
            _ => return false,
        }
    }
    repeated == 1
}

/// Steuer-ID: first digit 1–9, the one-repeated-digit rule (redrawn bodies),
/// ISO 7064 check — or a wrong check when `!valid`.
pub(crate) fn de_steuer_id(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let body = loop {
        let b = format!("{}{}", int(rng, 1, 9), digits(rng, 9));
        if steuer_id_digits_ok(&b) {
            break b;
        }
    };
    let c = steuer_id_check_digit(&body);
    format!("{body}{}", if valid { c } else { corrupt10(c) })
}

// ── FR NIR — 13 digits + 2-digit key ─────────────────────────────────────────

/// NIR key: 97 − (the 13-digit number mod 97), computed digit by digit.
pub(crate) fn nir_key(body13: &str) -> u32 {
    let mut m = 0u32;
    for b in body13.bytes() {
        m = (m * 10 + (b - b'0') as u32) % 97;
    }
    97 - m
}

/// French NIR: sex + YY + MM + department (01–95) + commune + order + key.
/// SIMPLIFICATION (documented in TS): Corsica 2A/2B and overseas departments
/// are never drawn. `!valid` shifts the key by one inside its 01–97 range.
pub(crate) fn fr_nir(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let body = format!(
        "{}{:02}{:02}{:02}{:03}{:03}",
        int(rng, 1, 2),
        int(rng, 0, 99),
        int(rng, 1, 12),
        int(rng, 1, 95),
        int(rng, 1, 999),
        int(rng, 1, 999)
    );
    let k = nir_key(&body);
    format!("{body}{:02}", if valid { k } else { (k % 97) + 1 })
}

// ── ES DNI / NIE — letter = number mod 23 ────────────────────────────────────

/// The DNI control-letter table (position = number mod 23).
pub(crate) const DNI_LETTERS: &[u8] = b"TRWAGMYFPDXBNJZSQVHLCKE";

/// DNI (8 digits + letter) or NIE (X/Y/Z counting as 0/1/2 + 7 digits +
/// letter). Reference: 12345678 → Z. `!valid` steps the letter one position.
/// The 8th-digit draw happens on the NIE branch too (unused there) so the
/// stream is identical whichever kind the first draw picked.
pub(crate) fn es_dni(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let is_nie = int(rng, 0, 1) == 1;
    let prefix = if is_nie { pick_char(rng, b"XYZ") } else { '\0' };
    let digits7 = int(rng, 0, 9_999_999);
    let last = int(rng, 0, 9);
    let number = if is_nie {
        (b"XYZ".iter().position(|&c| c == prefix as u8).unwrap() as i64) * 10_000_000 + digits7
    } else {
        digits7 * 10 + last
    };
    let idx = (number % 23) as usize;
    let letter = DNI_LETTERS[if valid { idx } else { (idx + 1) % 23 }] as char;
    if is_nie {
        format!("{prefix}{digits7:07}{letter}")
    } else {
        format!("{digits7:07}{last}{letter}")
    }
}

// ── VAT IDs ──────────────────────────────────────────────────────────────────

/// German USt-IdNr: `DE` + 9 digits, first never 0. NO public check digit →
/// deliberately no `valid` toggle (the `doi` convention).
pub(crate) fn de_vat(rng: &mut dyn FnMut() -> f64) -> String {
    format!("DE{}{}", int(rng, 1, 9), digits(rng, 8))
}

/// French TVA key for a 9-digit SIREN: (12 + 3 × (SIREN mod 97)) mod 97.
pub(crate) fn fr_vat_key(siren9: &str) -> u32 {
    let mut m = 0u32;
    for b in siren9.bytes() {
        m = (m * 10 + (b - b'0') as u32) % 97;
    }
    (12 + 3 * m) % 97
}

/// French TVA: `FR` + 2-digit key + 9-digit SIREN; `!valid` shifts the key.
pub(crate) fn fr_vat(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let siren = digits(rng, 9);
    let k = fr_vat_key(&siren);
    format!("FR{:02}{siren}", if valid { k } else { (k + 1) % 97 })
}

pub(crate) const CIF_LETTERS: &[u8] = b"ABCDEFGH";

/// Spanish VAT in the entity (CIF) shape: `ES` + letter A–H + 7 digits +
/// DIGIT control. Simplifications (documented in TS): no letter-control
/// variant, no K/L/M/X prefixes, no individual ES+DNI form. Control: odd
/// positions doubled and digit-summed, even added plain; (10 − sum%10) % 10.
pub(crate) fn es_vat(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let letter = pick_char(rng, CIF_LETTERS);
    let body7 = int(rng, 0, 9_999_999);
    let body = format!("{body7:07}");
    let mut sum = 0u32;
    for (i, b) in body.bytes().enumerate() {
        let mut d = (b - b'0') as u32;
        if i % 2 == 0 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    let c = (10 - (sum % 10)) % 10;
    format!("ES{letter}{body}{}", if valid { c } else { corrupt10(c) })
}

const PL_VAT_WEIGHTS: [u32; 9] = [6, 5, 7, 2, 3, 4, 5, 6, 7];

/// Check digit (the 10th) of a Polish NIP body: Σ wᵢdᵢ mod 11 (10 = no check).
pub(crate) fn pl_vat_check_digit(body9: &str) -> u32 {
    body9.bytes()
        .zip(PL_VAT_WEIGHTS)
        .map(|(b, w)| (b - b'0') as u32 * w)
        .sum::<u32>()
        % 11
}

/// Polish NIP: `PL` + 9-digit body + mod-11 check; remainder-10 bodies are
/// never issued and redrawn (identically in TS). Reference: 1234563218.
pub(crate) fn pl_vat(rng: &mut dyn FnMut() -> f64, valid: bool) -> String {
    let (body, c) = loop {
        let b = digits(rng, 9);
        let c = pl_vat_check_digit(&b);
        if c != 10 {
            break (b, c);
        }
    };
    format!("PL{body}{}", if valid { c } else { corrupt10(c) })
}

/// Real IRS campus prefixes for an EIN (representative subset — see TS).
pub(crate) const EIN_PREFIXES: &[&str] = &[
    "01", "02", "03", "04", "05", "06", "10", "11", "12", "13", "14", "15", "16",
    "20", "21", "22", "23", "26", "27", "30", "31", "32", "33", "34", "35", "36",
    "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48",
    "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62",
    "63", "64", "65", "66", "67", "68", "71", "72", "73", "74", "75", "76", "77",
    "80", "81", "82", "83", "84", "85", "86", "87", "88", "90", "91", "92", "93",
    "94", "95", "98", "99",
];

/// US EIN `XX-XXXXXXX` with a real campus prefix. No checksum → no toggle.
pub(crate) fn us_ein(rng: &mut dyn FnMut() -> f64) -> String {
    format!("{}-{:07}", pick_str(rng, EIN_PREFIXES), int(rng, 0, 9_999_999))
}

// ── License plates (localized formats) ───────────────────────────────────────

/// Real German registration-district codes (a representative subset).
pub(crate) const DE_PLATE_DISTRICTS: &[&str] = &[
    "B", "M", "K", "F", "S", "H", "D", "N", "E", "L", "A", "C", "W", "DD", "HH", "DO",
];
const PLATE_LETTERS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// German plate: district + 1–2 letters + 1–4 digits (`B AB 1234`).
pub(crate) fn de_plate(rng: &mut dyn FnMut() -> f64) -> String {
    let district = pick_str(rng, DE_PLATE_DISTRICTS);
    let n = int(rng, 1, 2) as usize;
    let letters: String = (0..n).map(|_| pick_char(rng, PLATE_LETTERS)).collect();
    format!("{district} {letters} {}", int(rng, 1, 9999))
}

// UK post-2001 letters exclude I and Q.
const UK_PLATE_CHARS: &[u8] = b"ABCDEFGHJKLMNOPRSTUVWXYZ";

/// UK post-2001 plate `AB51 CDE`: two local-tag letters, the age identifier
/// (one draw picks the 51–75 / 02–24 series, one the year), three letters.
pub(crate) fn uk_plate(rng: &mut dyn FnMut() -> f64) -> String {
    let a = format!("{}{}", pick_char(rng, UK_PLATE_CHARS), pick_char(rng, UK_PLATE_CHARS));
    let age = if int(rng, 0, 1) == 0 {
        format!("{}", int(rng, 51, 75))
    } else {
        format!("{:02}", int(rng, 2, 24))
    };
    let tail: String = (0..3).map(|_| pick_char(rng, UK_PLATE_CHARS)).collect();
    format!("{a}{age} {tail}")
}

/// Japanese plate issuing offices, romanized (the plates themselves use kanji).
pub(crate) const JP_PLATE_OFFICES: &[&str] = &[
    "SHINAGAWA", "NERIMA", "ADACHI", "YOKOHAMA", "NAGOYA", "OSAKA", "FUKUOKA", "SAPPORO",
];
/// Real 3-digit classification numbers: 3xx ordinary cars, 5xx kei cars.
pub(crate) const JP_PLATE_CLASSES: &[&str] = &[
    "301", "302", "303", "305", "500", "501", "502", "503", "505",
];

/// Japanese plate, ASCII-SAFE variant (documented in TS): romanized office +
/// real 3-digit class + one Latin letter for the hiragana slot + `NN-NN`.
pub(crate) fn jp_plate(rng: &mut dyn FnMut() -> f64) -> String {
    let office = pick_str(rng, JP_PLATE_OFFICES);
    let cls = pick_str(rng, JP_PLATE_CLASSES);
    let letter = pick_char(rng, PLATE_LETTERS);
    let num = format!("{:04}", int(rng, 1, 9999));
    format!("{office} {cls} {letter} {}-{}", &num[..2], &num[2..])
}

/// US plate, the generic 3-letters + 4-digits layout (`ABC 1234`).
pub(crate) fn us_plate(rng: &mut dyn FnMut() -> f64) -> String {
    let letters: String = (0..3).map(|_| pick_char(rng, PLATE_LETTERS)).collect();
    format!("{letters} {:04}", int(rng, 0, 9999))
}

// ── Airports — IATA code with its real coordinates ───────────────────────────

/// Fifty real international airports as (IATA, lat, lon) string triples —
/// coordinates stay STRINGS so both tiers emit the stored value verbatim.
pub(crate) const AIRPORTS: &[(&str, &str, &str)] = &[
    ("JFK", "40.6413", "-73.7781"), ("LAX", "33.9416", "-118.4085"),
    ("ORD", "41.9742", "-87.9073"), ("ATL", "33.6407", "-84.4277"),
    ("DFW", "32.8998", "-97.0403"), ("DEN", "39.8561", "-104.6737"),
    ("SFO", "37.6213", "-122.3790"), ("SEA", "47.4502", "-122.3088"),
    ("MIA", "25.7959", "-80.2870"), ("BOS", "42.3656", "-71.0096"),
    ("LHR", "51.4700", "-0.4543"), ("CDG", "49.0097", "2.5479"),
    ("AMS", "52.3105", "4.7683"), ("FRA", "50.0379", "8.5622"),
    ("MAD", "40.4983", "-3.5676"), ("BCN", "41.2974", "2.0833"),
    ("FCO", "41.8003", "12.2389"), ("ZRH", "47.4647", "8.5492"),
    ("VIE", "48.1103", "16.5697"), ("PRG", "50.1008", "14.2600"),
    ("WAW", "52.1657", "20.9671"), ("IST", "41.2753", "28.7519"),
    ("DXB", "25.2532", "55.3657"), ("DOH", "25.2731", "51.6081"),
    ("SIN", "1.3644", "103.9915"), ("HKG", "22.3080", "113.9185"),
    ("ICN", "37.4602", "126.4407"), ("NRT", "35.7720", "140.3929"),
    ("HND", "35.5494", "139.7798"), ("PEK", "40.0799", "116.6031"),
    ("PVG", "31.1443", "121.8083"), ("DEL", "28.5562", "77.1000"),
    ("BOM", "19.0896", "72.8656"), ("BKK", "13.6900", "100.7501"),
    ("KUL", "2.7456", "101.7099"), ("SYD", "-33.9399", "151.1753"),
    ("MEL", "-37.6690", "144.8410"), ("AKL", "-37.0082", "174.7850"),
    ("GRU", "-23.4356", "-46.4731"), ("EZE", "-34.8222", "-58.5358"),
    ("MEX", "19.4363", "-99.0721"), ("YYZ", "43.6777", "-79.6248"),
    ("YVR", "49.1967", "-123.1815"), ("JNB", "-26.1367", "28.2411"),
    ("CAI", "30.1219", "31.4056"), ("LOS", "6.5774", "3.3212"),
    ("NBO", "-1.3192", "36.9278"), ("CPH", "55.6180", "12.6560"),
    ("ARN", "59.6519", "17.9186"), ("OSL", "60.1939", "11.1004"),
];

/// One coherent airport value `JFK (40.6413, -73.7781)` — a single generator
/// by design: two generators would draw independently and disagree.
pub(crate) fn airport(rng: &mut dyn FnMut() -> f64) -> String {
    let (code, lat, lon) = AIRPORTS[(rng() * AIRPORTS.len() as f64).floor() as usize];
    format!("{code} ({lat}, {lon})")
}

// ── Colors ───────────────────────────────────────────────────────────────────

/// `#rrggbb` — the web/DB convention for a color column.
pub(crate) fn color_hex(rng: &mut dyn FnMut() -> f64) -> String {
    let mut out = String::from("#");
    for _ in 0..6 {
        out.push(hex_digit(rng));
    }
    out
}

/// CSS `rgb(r, g, b)`.
pub(crate) fn color_rgb(rng: &mut dyn FnMut() -> f64) -> String {
    format!(
        "rgb({}, {}, {})",
        int(rng, 0, 255),
        int(rng, 0, 255),
        int(rng, 0, 255)
    )
}

/// CSS `hsl(h, s%, l%)`.
pub(crate) fn color_hsl(rng: &mut dyn FnMut() -> f64) -> String {
    format!(
        "hsl({}, {}%, {}%)",
        int(rng, 0, 359),
        int(rng, 0, 100),
        int(rng, 0, 100)
    )
}

// ── Avatar initials ──────────────────────────────────────────────────────────

/// Two-letter initials from an already-drawn first/last name pair (the callers
/// draw from the shared firstNames/lastNames packs on both tiers).
pub(crate) fn avatar_initials(first: &str, last: &str) -> String {
    let mut s = String::new();
    if let Some(c) = first.chars().next() {
        s.push(c);
    }
    if let Some(c) = last.chars().next() {
        s.push(c);
    }
    s.to_uppercase()
}


// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// mulberry32 — bit-identical to `makeRng` in utils/datagen.ts and to
    /// `Rng` in datagen.rs, so the anchors below pin cross-tier parity.
    struct TestRng(u32);
    impl TestRng {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_add(0x6D2B_79F5);
            let a = self.0;
            let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
            t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
            ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
        }
    }
    fn rng(seed: u32) -> impl FnMut() -> f64 {
        let mut r = TestRng(seed);
        move || r.next()
    }

    /// 2024-01-01T00:00:00Z in unix ms — the TS tests' BASE_MS.
    const BASE_MS: u64 = 1_704_067_200_000;

    // ── independent verifiers ────────────────────────────────────────────

    fn luhn_valid(num: &str) -> bool {
        let mut sum = 0u32;
        let mut dbl = false;
        for &b in num.as_bytes().iter().rev() {
            let mut d = (b - b'0') as u32;
            if dbl {
                d *= 2;
                if d > 9 {
                    d -= 9;
                }
            }
            sum += d;
            dbl = !dbl;
        }
        sum % 10 == 0
    }

    fn vin_valid(v: &str) -> bool {
        let b = v.as_bytes();
        if b.len() != 17 {
            return false;
        }
        // Independent transliteration table, written out again on purpose.
        fn val(c: u8) -> u32 {
            match c {
                b'0'..=b'9' => (c - b'0') as u32,
                b'A' => 1, b'B' => 2, b'C' => 3, b'D' => 4, b'E' => 5, b'F' => 6,
                b'G' => 7, b'H' => 8, b'J' => 1, b'K' => 2, b'L' => 3, b'M' => 4,
                b'N' => 5, b'P' => 7, b'R' => 9, b'S' => 2, b'T' => 3, b'U' => 4,
                b'V' => 5, b'W' => 6, b'X' => 7, b'Y' => 8, b'Z' => 9,
                _ => 0,
            }
        }
        let w = [8u32, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
        let sum: u32 = b.iter().zip(w).map(|(&c, w)| val(c) * w).sum();
        let want = match sum % 11 {
            10 => b'X',
            r => b'0' + r as u8,
        };
        b[8] == want
    }

    fn isin_valid(s: &str) -> bool {
        let mut expanded = String::new();
        for c in s.chars() {
            if c.is_ascii_uppercase() {
                expanded.push_str(&(c as u32 - 55).to_string());
            } else {
                expanded.push(c);
            }
        }
        luhn_valid(&expanded)
    }

    fn sha256_hex(msg: &[u8]) -> String {
        sha256(msg).iter().map(|b| format!("{b:02x}")).collect()
    }

    // ── the primitives, proven on known-good references ──────────────────

    #[test]
    fn sha256_matches_fips_known_answer_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"The quick brown fox jumps over the lazy dog"),
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
        );
    }

    #[test]
    fn base58check_matches_the_known_all_zero_hash160_address() {
        assert_eq!(base58check_encode(&[0u8; 21]), "1111111111111111111114oLvT2");
    }

    #[test]
    fn vin_check_matches_the_canonical_iso3779_worked_example() {
        assert_eq!(vin_check_digit("1M8GDM9AXKP042788"), 'X');
        assert!(vin_valid("1M8GDM9AXKP042788"));
        assert!(!vin_valid("1M8GDM9A9KP042788"), "wrong check must fail");
    }

    #[test]
    fn isin_check_matches_a_real_isin() {
        assert_eq!(isin_check_digit("US037833100"), 5); // Apple
        assert!(isin_valid("US0378331005"));
        assert!(!isin_valid("US0378331006"), "wrong check must fail");
    }

    // ── structure + the valid toggle ─────────────────────────────────────

    #[test]
    fn uuid_v7_shape_version_variant_and_embedded_timestamp() {
        for i in 0..200u64 {
            let v = uuid_v7(&mut rng(i as u32 + 1), BASE_MS, i);
            let b = v.as_bytes();
            assert_eq!(v.len(), 36, "{v}");
            assert_eq!(b[8], b'-', "{v}");
            assert_eq!(b[13], b'-', "{v}");
            assert_eq!(b[18], b'-', "{v}");
            assert_eq!(b[23], b'-', "{v}");
            assert_eq!(b[14], b'7', "version nibble: {v}");
            assert!(matches!(b[19], b'8' | b'9' | b'a' | b'b'), "variant: {v}");
            let ts = u64::from_str_radix(&format!("{}{}", &v[..8], &v[9..13]), 16).unwrap();
            assert_eq!(ts, BASE_MS + i, "uuid v7 embeds base + row ms: {v}");
        }
        assert_eq!(
            uuid_v7(&mut rng(42), BASE_MS, 5),
            uuid_v7(&mut rng(42), BASE_MS, 5),
            "deterministic per (seed, row)"
        );
        assert_ne!(uuid_v7(&mut rng(42), BASE_MS, 5), uuid_v7(&mut rng(43), BASE_MS, 5));
        assert!(uuid_v7(&mut rng(42), BASE_MS, 9) > uuid_v7(&mut rng(42), BASE_MS, 8));
    }

    #[test]
    fn ulid_shape_and_embedded_timestamp() {
        for i in 0..200u64 {
            let v = ulid(&mut rng(i as u32 + 1), BASE_MS, i);
            assert_eq!(v.len(), 26, "{v}");
            assert!(v.bytes().all(|b| ULID_ALPHABET.contains(&b)), "{v}");
            let mut ts = 0u64;
            for &b in &v.as_bytes()[..10] {
                ts = ts * 32 + ULID_ALPHABET.iter().position(|&c| c == b).unwrap() as u64;
            }
            assert_eq!(ts, BASE_MS + i, "ULID embeds base + row ms: {v}");
        }
        assert_eq!(ulid(&mut rng(42), BASE_MS, 3), ulid(&mut rng(42), BASE_MS, 3));
        assert!(ulid(&mut rng(42), BASE_MS, 9) > ulid(&mut rng(42), BASE_MS, 8));
    }

    #[test]
    fn nano_id_shape_and_determinism() {
        for s in 0..100u32 {
            let v = nano_id(&mut rng(s), 21);
            assert_eq!(v.len(), 21);
            assert!(v.bytes().all(|b| NANOID_ALPHABET.contains(&b)), "{v}");
        }
        assert_eq!(nano_id(&mut rng(42), 21), nano_id(&mut rng(42), 21));
        assert_ne!(nano_id(&mut rng(42), 21), nano_id(&mut rng(43), 21));
        assert_eq!(nano_id(&mut rng(42), 10).len(), 10);
    }

    #[test]
    fn imei_luhn_and_the_valid_toggle() {
        for s in 0..300u32 {
            let v = imei(&mut rng(s), true);
            assert_eq!(v.len(), 15);
            assert!(v.bytes().all(|b| b.is_ascii_digit()), "{v}");
            assert!(IMEI_RBIS.contains(&&v[..2]), "RBI: {v}");
            assert!(luhn_valid(&v), "Luhn: {v}");
            let bad = imei(&mut rng(s), false);
            assert_eq!(bad.len(), 15);
            assert!(!luhn_valid(&bad), "must not validate: {bad}");
            assert_eq!(bad[..14], v[..14], "only the check digit may change");
        }
    }

    #[test]
    fn vin_iso3779_and_the_valid_toggle() {
        for s in 0..300u32 {
            let v = vin(&mut rng(s), true);
            assert_eq!(v.len(), 17);
            assert!(v.bytes().all(|b| VIN_CHARS.contains(&b)), "{v}");
            assert!(VIN_WMIS.contains(&&v[..3]), "WMI: {v}");
            assert!(vin_valid(&v), "ISO 3779: {v}");
            let bad = vin(&mut rng(s), false);
            assert!(!vin_valid(&bad), "must not validate: {bad}");
            assert_eq!(bad[..8], v[..8]);
            assert_eq!(bad[9..], v[9..]);
        }
    }

    #[test]
    fn isin_luhn_and_the_valid_toggle() {
        for s in 0..300u32 {
            let v = isin(&mut rng(s), true);
            assert_eq!(v.len(), 12);
            assert!(ISIN_COUNTRIES.contains(&&v[..2]), "country: {v}");
            assert!(isin_valid(&v), "Luhn: {v}");
            let bad = isin(&mut rng(s), false);
            assert!(!isin_valid(&bad), "must not validate: {bad}");
            assert_eq!(bad[..11], v[..11], "only the check digit may change");
        }
    }

    #[test]
    fn doi_shape_and_determinism() {
        for s in 0..200u32 {
            let v = doi(&mut rng(s));
            let (prefix, suffix) = v.split_once('/').unwrap_or(("", ""));
            assert!(prefix.starts_with("10."), "{v}");
            let reg = &prefix[3..];
            assert!((4..=5).contains(&reg.len()) && reg.bytes().all(|b| b.is_ascii_digit()), "{v}");
            assert!((6..=10).contains(&suffix.len()), "{v}");
            assert!(suffix.bytes().all(|b| b.is_ascii_lowercase()
                || b.is_ascii_digit() || b == b'.' || b == b'-'), "{v}");
        }
        assert_eq!(doi(&mut rng(42)), doi(&mut rng(42)));
        assert_ne!(doi(&mut rng(42)), doi(&mut rng(43)));
    }

    #[test]
    fn btc_address_is_base58check_with_version_zero() {
        for s in 0..100u32 {
            let v = btc_address(&mut rng(s));
            assert!(v.starts_with('1'), "version-0 payload starts with '1': {v}");
            assert!(v.bytes().all(|b| BASE58_ALPHABET.contains(&b)), "{v}");
        }
        assert_eq!(btc_address(&mut rng(42)), btc_address(&mut rng(42)));
        assert_ne!(btc_address(&mut rng(42)), btc_address(&mut rng(43)));
    }

    #[test]
    fn eth_address_is_40_lowercase_hex() {
        for s in 0..100u32 {
            let v = eth_address(&mut rng(s));
            assert_eq!(v.len(), 42);
            assert!(v.starts_with("0x"));
            assert!(v[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{v}");
        }
        assert_eq!(eth_address(&mut rng(42)), eth_address(&mut rng(42)));
    }

    #[test]
    fn card_expiry_stays_in_window_and_never_in_the_past() {
        for s in 0..300u32 {
            let v = card_expiry(&mut rng(s), 2020, 2030, 2026, 6);
            let mm: i64 = v[..2].parse().unwrap();
            let yy = 2000 + v[3..].parse::<i64>().unwrap();
            assert!((1..=12).contains(&mm), "{v}");
            assert!((2026..=2030).contains(&yy), "{v}");
            if yy == 2026 {
                assert!(mm >= 6, "must not predate the ref month: {v}");
            }
        }
    }

    #[test]
    fn card_cvv_length_by_brand() {
        for s in 0..100u32 {
            assert_eq!(card_cvv(&mut rng(s), "").len(), 3);
            assert_eq!(card_cvv(&mut rng(s), "amex").len(), 4);
            assert_eq!(card_cvv(&mut rng(s), "visa").len(), 3);
        }
        assert_eq!(card_cvv(&mut rng(42), ""), card_cvv(&mut rng(42), ""));
    }

    // ── seed-42 anchors — the SAME pins as tests/datagenIdent.test.ts ──────

    #[test]
    fn seed42_anchors_match_the_typescript_engine() {
        assert_eq!(uuid_v7(&mut rng(42), BASE_MS, 0), "018cc251-f400-797d-a284-9d73eb438a90");
        assert_eq!(uuid_v7(&mut rng(42), BASE_MS, 7), "018cc251-f407-797d-a284-9d73eb438a90");
        assert_eq!(ulid(&mut rng(42), BASE_MS, 0), "01HK153X00KEVN5G8KVF7WQ96G");
        assert_eq!(ulid(&mut rng(42), BASE_MS, 7), "01HK153X07KEVN5G8KVF7WQ96G");
        assert_eq!(nano_id(&mut rng(42), 21), "mc2qLhRn3eP4vTMgrnAe1");
        assert_eq!(imei(&mut rng(42), true), "494861526842875");
        assert_eq!(imei(&mut rng(42), false), "494861526842876");
        assert_eq!(vin(&mut rng(42), true), "TMBR5ZFU4KX5SJ61L");
        assert_eq!(vin(&mut rng(42), false), "TMBR5ZFU5KX5SJ61L");
        assert_eq!(isin(&mut rng(42), true), "GBQ4YGSJW5R7");
        assert_eq!(isin(&mut rng(42), false), "GBQ4YGSJW5R8");
        assert_eq!(doi(&mut rng(42)), "10.60509/6zgukx6r");
        assert_eq!(btc_address(&mut rng(42)), "1EzMyZN6Qkc8qu2TLNUu4hZRrnyjBdwEcZ");
        assert_eq!(eth_address(&mut rng(42)), "0x97da2849d73eb438a907d090402c802d7c570089");
        assert_eq!(card_expiry(&mut rng(42), 2024, 2030, 2024, 1), "06/28");
        assert_eq!(card_cvv(&mut rng(42), ""), "648");
        assert_eq!(card_cvv(&mut rng(42), "amex"), "6486");
    }

    // ── Phase 3 batch 2 — independent verifiers, reference vectors, anchors ──

    fn aba_valid(n: &str) -> bool {
        let b = n.as_bytes();
        if b.len() != 9 || !b.iter().all(u8::is_ascii_digit) {
            return false;
        }
        let d = |i: usize| (b[i] - b'0') as u32;
        // Weights 3-7-1 written out again on purpose.
        (3 * (d(0) + d(3) + d(6)) + 7 * (d(1) + d(4) + d(7)) + (d(2) + d(5) + d(8))) % 10 == 0
    }

    fn iban_valid(full: &str) -> bool {
        let rearranged = format!("{}{}", &full[4..], &full[..4]);
        let mut m = 0u32;
        for c in rearranged.chars() {
            if c.is_ascii_uppercase() {
                for d in (c as u32 - 55).to_string().bytes() {
                    m = (m * 10 + (d - b'0') as u32) % 97;
                }
            } else {
                m = (m * 10 + (c as u32 - 48)) % 97;
            }
        }
        m == 1
    }

    fn pesel_valid(p: &str) -> bool {
        let w = [1u32, 3, 7, 9, 1, 3, 7, 9, 1, 3, 1];
        let b = p.as_bytes();
        if b.len() != 11 || !b.iter().all(u8::is_ascii_digit) {
            return false;
        }
        b.iter().zip(w).map(|(&d, w)| (d - b'0') as u32 * w).sum::<u32>() % 10 == 0
    }

    fn steuer_id_valid(s: &str) -> bool {
        let b = s.as_bytes();
        if b.len() != 11 || !b.iter().all(u8::is_ascii_digit) || b[0] == b'0' {
            return false;
        }
        // ISO 7064 MOD 11,10, written out again.
        let mut p = 10u32;
        for &d in &b[..10] {
            let mut s = ((d - b'0') as u32 + p) % 10;
            if s == 0 {
                s = 10;
            }
            p = (2 * s) % 11;
        }
        (b'0' + ((11 - p) % 10) as u8) == b[10]
    }

    fn steuer_id_shape_ok(first10: &str) -> bool {
        // The one-repeated-digit rule, counted independently via a sorted copy.
        let mut ds: Vec<u8> = first10.bytes().map(|b| b - b'0').collect();
        ds.sort_unstable();
        let mut runs: Vec<u32> = Vec::new();
        let mut i = 0;
        while i < ds.len() {
            let mut j = i;
            while j < ds.len() && ds[j] == ds[i] {
                j += 1;
            }
            runs.push((j - i) as u32);
            i = j;
        }
        runs.iter().filter(|&&r| r == 2 || r == 3).count() == 1
            && runs.iter().all(|&r| r <= 3)
    }

    fn nir_valid(nir: &str) -> bool {
        let b = nir.as_bytes();
        if b.len() != 15 || !b.iter().all(u8::is_ascii_digit) {
            return false;
        }
        let mut m = 0u64;
        for &d in &b[..13] {
            m = (m * 10 + (d - b'0') as u64) % 97;
        }
        let key = 97 - m;
        let got = nir[13..].parse::<u64>().unwrap();
        key == got
    }

    fn dni_valid(v: &str) -> bool {
        const TABLE: &[u8] = b"TRWAGMYFPDXBNJZSQVHLCKE"; // written out again
        let (num, letter) = if v.as_bytes()[0].is_ascii_digit() {
            (v[..v.len() - 1].parse::<u64>().unwrap(), v.len() - 1)
        } else {
            let p = match &v[..1] {
                "X" => 0,
                "Y" => 1,
                "Z" => 2,
                _ => return false,
            };
            (p * 10_000_000 + v[1..v.len() - 1].parse::<u64>().unwrap(), v.len() - 1)
        };
        TABLE[(num % 23) as usize] as char == v.chars().nth(letter).unwrap()
    }

    fn fr_vat_valid(v: &str) -> bool {
        let siren = &v[4..];
        let mut m = 0u32;
        for b in siren.bytes() {
            m = (m * 10 + (b - b'0') as u32) % 97;
        }
        let key = (12 + 3 * m) % 97;
        v[2..4].parse::<u32>().unwrap() == key
    }

    fn es_vat_valid(v: &str) -> bool {
        let b = v.as_bytes();
        if b.len() != 11 || &v[..2] != "ES" || !b[2].is_ascii_uppercase() {
            return false;
        }
        let mut sum = 0u32;
        for (i, &d) in b[3..10].iter().enumerate() {
            let mut d = (d - b'0') as u32;
            if i % 2 == 0 {
                d *= 2;
                if d > 9 {
                    d -= 9;
                }
            }
            sum += d;
        }
        b[10] - b'0' == ((10 - (sum % 10)) % 10) as u8
    }

    fn pl_vat_valid(v: &str) -> bool {
        let w = [6u32, 5, 7, 2, 3, 4, 5, 6, 7];
        let b = v.as_bytes();
        if b.len() != 12 || &v[..2] != "PL" {
            return false;
        }
        let sum: u32 = b[2..11].iter().zip(w).map(|(&d, w)| (d - b'0') as u32 * w).sum();
        b[11] - b'0' == (sum % 11) as u8
    }

    // ── the primitives, proven on known-good references ──────────────────

    #[test]
    fn aba_matches_known_bank_routing_numbers() {
        assert_eq!(aba_check_digit("02100002"), 1); // JPMorgan Chase 021000021
        assert!(aba_valid("021000021"));
        assert!(aba_valid("011000015")); // Federal Reserve example
        assert!(aba_valid("111000025")); // Bank of America Texas
        assert!(!aba_valid("021000022"), "wrong check must fail");
    }

    #[test]
    fn iban_check_digits_match_official_examples() {
        // Each is an officially published example IBAN for its country.
        assert!(iban_valid("DE89370400440532013000"));
        assert!(iban_valid("GB29NWBK60161331926819"));
        assert!(iban_valid("ES9121000418450200051332"));
        assert!(iban_valid("PL61109010140000071219812874"));
        assert!(iban_valid("CZ6508000000192000145399"));
        assert!(iban_valid("FR7630006000011234567890189"));
        assert!(!iban_valid("DE88370400440532013000"), "off-by-one key must fail");
    }

    #[test]
    fn pesel_matches_the_documented_worked_example() {
        assert_eq!(pesel_check_digit("4405140135"), 9);
        assert!(pesel_valid("44051401359"));
        assert!(!pesel_valid("44051401358"));
    }

    #[test]
    fn steuer_id_matches_the_documented_worked_example() {
        assert_eq!(steuer_id_check_digit("8609574271"), 9);
        assert!(steuer_id_valid("86095742719"));
        assert!(steuer_id_shape_ok("8609574271"), "7 appears exactly twice");
        assert!(!steuer_id_valid("86095742710"));
    }

    #[test]
    fn nir_key_matches_a_worked_example() {
        // 1 55 12 75 012 116 → key 87 (a man born Dec 1955, Paris 12e).
        assert_eq!(nir_key("1551275012116"), 87);
        assert!(nir_valid("155127501211687"));
        assert!(!nir_valid("155127501211688"));
    }

    #[test]
    fn dni_letter_table_matches_the_canonical_example() {
        assert!(dni_valid("12345678Z")); // the canonical DNI example
        assert!(!dni_valid("12345678T"));
    }

    #[test]
    fn fr_vat_key_matches_the_formula_reference() {
        // SIREN 552 100 554 → key 96: 552100554 mod 97 = 28, (12+3·28) mod 97.
        assert_eq!(fr_vat_key("552100554"), 96);
        assert!(fr_vat_valid("FR96552100554"));
        assert!(!fr_vat_valid("FR95552100554"));
    }

    #[test]
    fn es_vat_control_matches_a_known_cif() {
        assert!(es_vat_valid("ESA58818501"));
        assert!(!es_vat_valid("ESA58818502"));
    }

    #[test]
    fn pl_vat_matches_the_documented_test_nip() {
        assert_eq!(pl_vat_check_digit("123456321"), 8);
        assert!(pl_vat_valid("PL1234563218"));
        assert!(!pl_vat_valid("PL1234563219"));
    }

    // ── structure + the valid toggle ─────────────────────────────────────

    #[test]
    fn aba_routing_structure_and_toggle() {
        for s in 0..300u32 {
            let v = aba_routing(&mut rng(s), true);
            assert_eq!(v.len(), 9);
            let prefix: u32 = v[..2].parse().unwrap();
            assert!(
                (1..=12).contains(&prefix) || (21..=32).contains(&prefix) || (61..=72).contains(&prefix),
                "prefix: {v}"
            );
            assert!(aba_valid(&v), "{v}");
            let bad = aba_routing(&mut rng(s), false);
            assert!(!aba_valid(&bad), "must not validate: {bad}");
            assert_eq!(bad[..8], v[..8], "only the check digit may change");
        }
    }

    #[test]
    fn iban_bban_lengths_and_toggle() {
        let want: [(&str, usize); 7] = [
            ("CZ", 24), ("GB", 22), ("JP", 19), ("DE", 22), ("FR", 27), ("ES", 24), ("PL", 28),
        ];
        for s in 0..200u32 {
            for (c, len) in want {
                let bban = iban_bban(&mut rng(s), c);
                assert_eq!(bban.len(), len - 4, "{c}: {bban}");
            }
        }
        // Validity of the composed IBAN is exercised through the anchors below
        // (the `iban` composer lives in datagen.rs and is pinned there too).
    }

    #[test]
    fn us_ssn_issuance_rules_and_toggle() {
        for s in 0..500u32 {
            let v = us_ssn(&mut rng(s), true);
            let b = v.as_bytes();
            assert_eq!(v.len(), 11, "{v}");
            assert_eq!(b[3], b'-');
            assert_eq!(b[6], b'-');
            let area: u32 = v[..3].parse().unwrap();
            assert!((1..=665).contains(&area) || (667..=899).contains(&area), "area: {v}");
            assert_ne!(&v[4..6], "00", "group: {v}");
            assert_ne!(&v[7..11], "0000", "serial: {v}");
            let bad = us_ssn(&mut rng(s), false);
            assert_eq!(&bad[7..11], "0000", "structural invalid form: {bad}");
            assert_eq!(&bad[..6], &v[..6], "area/group unchanged by the toggle");
        }
    }

    #[test]
    fn pl_pesel_birthdate_coherence_and_toggle() {
        for s in 0..500u32 {
            let v = pl_pesel(&mut rng(s), true);
            assert_eq!(v.len(), 11);
            let mm: u32 = v[2..4].parse().unwrap();
            let yy: u32 = v[..2].parse().unwrap();
            if yy <= 24 {
                assert!((21..=32).contains(&mm), "2000s month encoding: {v}");
            } else {
                assert!((1..=12).contains(&mm), "1900s month encoding: {v}");
            }
            assert!(pesel_valid(&v), "{v}");
            let bad = pl_pesel(&mut rng(s), false);
            assert!(!pesel_valid(&bad), "must not validate: {bad}");
            assert_eq!(bad[..10], v[..10], "only the check digit may change");
        }
    }

    #[test]
    fn de_steuer_id_rules_and_toggle() {
        for s in 0..300u32 {
            let v = de_steuer_id(&mut rng(s), true);
            assert_eq!(v.len(), 11);
            assert!(steuer_id_shape_ok(&v[..10]), "repeated-digit rule: {v}");
            assert!(steuer_id_valid(&v), "{v}");
            let bad = de_steuer_id(&mut rng(s), false);
            assert!(!steuer_id_valid(&bad), "must not validate: {bad}");
            assert_eq!(bad[..10], v[..10], "only the check digit may change");
        }
    }

    #[test]
    fn fr_nir_structure_and_toggle() {
        for s in 0..500u32 {
            let v = fr_nir(&mut rng(s), true);
            assert_eq!(v.len(), 15);
            assert!(matches!(v.as_bytes()[0], b'1' | b'2'), "{v}");
            let dept: u32 = v[5..7].parse().unwrap();
            assert!((1..=95).contains(&dept), "mainland departments only: {v}");
            assert!(nir_valid(&v), "{v}");
            let bad = fr_nir(&mut rng(s), false);
            assert!(!nir_valid(&bad), "must not validate: {bad}");
            assert_eq!(bad[..13], v[..13], "only the key may change");
        }
    }

    #[test]
    fn es_dni_nie_structure_and_toggle() {
        let mut saw_dni = false;
        let mut saw_nie = false;
        for s in 0..500u32 {
            let v = es_dni(&mut rng(s), true);
            if v.as_bytes()[0].is_ascii_digit() {
                saw_dni = true;
                assert_eq!(v.len(), 9, "{v}");
            } else {
                saw_nie = true;
                assert_eq!(v.len(), 9, "{v}");
                assert!(matches!(v.as_bytes()[0], b'X' | b'Y' | b'Z'), "{v}");
            }
            assert!(dni_valid(&v), "{v}");
            let bad = es_dni(&mut rng(s), false);
            assert!(!dni_valid(&bad), "must not validate: {bad}");
            assert_eq!(bad[..8], v[..8], "only the letter may change");
        }
        assert!(saw_dni && saw_nie, "both kinds drawn over 500 seeds");
    }

    #[test]
    fn vat_structure_and_toggles() {
        for s in 0..300u32 {
            let de = de_vat(&mut rng(s));
            assert_eq!(de.len(), 11);
            assert!(de.starts_with("DE") && de.as_bytes()[2] != b'0', "{de}");

            let fr = fr_vat(&mut rng(s), true);
            assert_eq!(fr.len(), 13);
            assert!(fr_vat_valid(&fr), "{fr}");
            assert!(!fr_vat_valid(&fr_vat(&mut rng(s), false)));

            let es = es_vat(&mut rng(s), true);
            assert!(es_vat_valid(&es), "{es}");
            assert!(!es_vat_valid(&es_vat(&mut rng(s), false)));

            let pl = pl_vat(&mut rng(s), true);
            assert!(pl_vat_valid(&pl), "{pl}");
            let bad_pl = pl_vat(&mut rng(s), false);
            assert!(!pl_vat_valid(&bad_pl), "must not validate: {bad_pl}");
            assert_eq!(&bad_pl[..11], &pl[..11], "only the check digit may change");

            let ein = us_ein(&mut rng(s));
            assert_eq!(ein.len(), 10, "{ein}");
            assert_eq!(ein.as_bytes()[2], b'-', "{ein}");
            assert!(EIN_PREFIXES.contains(&&ein[..2]), "campus prefix: {ein}");
        }
    }

    #[test]
    fn plates_match_their_local_formats() {
        for s in 0..300u32 {
            let de = de_plate(&mut rng(s));
            let mut parts = de.split(' ');
            let district = parts.next().unwrap();
            assert!(DE_PLATE_DISTRICTS.contains(&district), "{de}");
            let letters = parts.next().unwrap();
            assert!((1..=2).contains(&letters.len()), "{de}");
            let num: u32 = parts.next().unwrap().parse().unwrap();
            assert!((1..=9999).contains(&num), "{de}");

            let uk = uk_plate(&mut rng(s));
            assert_eq!(uk.len(), 8, "{uk}");
            assert_eq!(uk.as_bytes()[4], b' ', "{uk}");
            let age: u32 = uk[2..4].parse().unwrap();
            assert!((51..=75).contains(&age) || (2..=24).contains(&age), "{uk}");
            assert!(!uk[..2].contains(['I', 'Q']) && !uk[5..].contains(['I', 'Q']), "{uk}");

            let jp = jp_plate(&mut rng(s));
            let mut jp_parts = jp.split(' ');
            assert!(JP_PLATE_OFFICES.contains(&jp_parts.next().unwrap()), "{jp}");
            assert!(JP_PLATE_CLASSES.contains(&jp_parts.next().unwrap()), "{jp}");
            assert_eq!(jp_parts.next().unwrap().len(), 1, "{jp}");
            let num = jp_parts.next().unwrap();
            assert_eq!(num.len(), 5, "{jp}");
            assert_eq!(num.as_bytes()[2], b'-', "{jp}");

            let us = us_plate(&mut rng(s));
            assert_eq!(us.len(), 8, "{us}");
            assert_eq!(us.as_bytes()[3], b' ', "{us}");
        }
    }

    #[test]
    fn airport_is_a_real_code_with_its_coordinates() {
        for s in 0..200u32 {
            let v = airport(&mut rng(s));
            let (code, rest) = v.split_once(' ').unwrap_or(("", ""));
            let row = AIRPORTS.iter().find(|(c, _, _)| *c == code).unwrap_or_else(|| panic!("{v}"));
            assert_eq!(v, format!("{} ({}, {})", row.0, row.1, row.2), "coherent: {v}");
            assert!(rest.starts_with('(') && rest.ends_with(')'), "{v}");
        }
    }

    #[test]
    fn colors_are_css_literals() {
        for s in 0..200u32 {
            let h = color_hex(&mut rng(s));
            assert_eq!(h.len(), 7, "{h}");
            assert!(h.starts_with('#') && h[1..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{h}");
            let r = color_rgb(&mut rng(s));
            let nums: Vec<i64> = r[4..r.len() - 1].split(", ").map(|x| x.parse().unwrap()).collect();
            assert!(nums.iter().all(|&n| (0..=255).contains(&n)), "{r}");
            let l = color_hsl(&mut rng(s));
            assert!(l.starts_with("hsl(") && l.ends_with(')') && l.contains('%'), "{l}");
        }
    }

    #[test]
    fn avatar_initials_take_the_first_letter_of_each_name() {
        assert_eq!(avatar_initials("Jiri", "Novak"), "JN");
        assert_eq!(avatar_initials("anna", "smith"), "AS");
        assert_eq!(avatar_initials("Émile", "Łódź"), "ÉŁ");
    }

    // ── seed-42 anchors — the SAME pins as tests/datagenIdent2.test.ts ────

    #[test]
    fn seed42_batch2_anchors_match_the_typescript_engine() {
        assert_eq!(aba_routing(&mut rng(42), true), "304861521");
        assert_eq!(aba_routing(&mut rng(42), false), "304861522");
        assert_eq!(iban_bban(&mut rng(42), "CZ"), "64094861526842873156");
        assert_eq!(iban_bban(&mut rng(42), "GB"), "PLWR15268428731566");
        assert_eq!(iban_bban(&mut rng(42), "JP"), "648615268428731");
        assert_eq!(iban_bban(&mut rng(42), "DE"), "648615268428731566");
        assert_eq!(iban_bban(&mut rng(42), "FR"), "64861526842873156604805");
        assert_eq!(iban_bban(&mut rng(42), "ES"), "64861526842873156604");
        assert_eq!(iban_bban(&mut rng(42), "PL"), "648615268428731566048050");
        assert_eq!(us_ssn(&mut rng(42), true), "541-45-8524");
        assert_eq!(us_ssn(&mut rng(42), false), "541-45-0000");
        assert_eq!(pl_pesel(&mut rng(42), true), "60062461524");
        assert_eq!(pl_pesel(&mut rng(42), false), "60062461525");
        assert_eq!(de_steuer_id(&mut rng(42), true), "10346807929");
        assert_eq!(de_steuer_id(&mut rng(42), false), "10346807920");
        assert_eq!(fr_nir(&mut rng(42), true), "244116417552718");
        assert_eq!(fr_nir(&mut rng(42), false), "244116417552719");
        assert_eq!(es_dni(&mut rng(42), true), "Y8524657C");
        assert_eq!(es_dni(&mut rng(42), false), "Y8524657K");
        assert_eq!(de_vat(&mut rng(42)), "DE648615268");
        assert_eq!(fr_vat(&mut rng(42), true), "FR14648615268");
        assert_eq!(fr_vat(&mut rng(42), false), "FR15648615268");
        assert_eq!(es_vat(&mut rng(42), true), "ESE44829059");
        assert_eq!(es_vat(&mut rng(42), false), "ESE44829050");
        assert_eq!(pl_vat(&mut rng(42), true), "PL6486152687");
        assert_eq!(pl_vat(&mut rng(42), false), "PL6486152688");
        assert_eq!(us_ein(&mut rng(42)), "60-4482905");
        assert_eq!(de_plate(&mut rng(42)), "L W 6697");
        assert_eq!(uk_plate(&mut rng(42)), "PL17 ENG");
        assert_eq!(jp_plate(&mut rng(42)), "NAGOYA 500 W 66-97");
        assert_eq!(us_plate(&mut rng(42)), "PLW 6697");
        assert_eq!(airport(&mut rng(42)), "PVG (31.1443, 121.8083)");
        assert_eq!(color_hex(&mut rng(42)), "#97da28");
        assert_eq!(color_rgb(&mut rng(42)), "rgb(153, 114, 218)");
        assert_eq!(color_hsl(&mut rng(42)), "hsl(216, 45%, 86%)");
        assert_eq!(avatar_initials("Jiri", "Novak"), "JN");
    }
}
