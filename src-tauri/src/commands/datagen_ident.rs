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
}
