/// Data generator backend (roadmap G2 — see docs/DATAGEN_DEEPDIVE.md).
///
/// The UI holds column SPECS; rows are produced here in chunks and streamed
/// to the database on a dedicated connection:
///
///   generator task (spawn_blocking, seeded RNG)
///        │  bounded mpsc(2) — backpressure, O(chunk) memory at any row count
///   writer loop: per-chunk transaction, multi-row INSERTs sized by rows AND
///        bytes (adaptive), or PostgreSQL COPY FROM STDIN (fast path)
///        │  Channel events: progress {rows_done, rows_per_sec} / done
///
/// `writers > 1` (Phase 2a) fans the pipeline out: N writer tasks on N pooled
/// connections, writer w owning the row indices i with i % N == w. Each writer
/// replays the SAME sequential RNG stream from row 0 and drops the rows it does
/// not own, so a row's values are a pure function of (seed, row_idx) — a seeded
/// run is bit-identical at any writer count. Chunks commit per writer, so an
/// aborted parallel run leaves partial data behind; the abort report names each
/// writer's committed count.
///
/// The RNG is a faithful port of the frontend's mulberry32 so a seed shown in
/// the UI stays meaningful, and `generate_preview` uses the same engine as the
/// real run — preview rows ARE the first inserted rows.
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::db::types::LiveSession;
use crate::db::connection::get_session_pub;
use crate::state::AppState;
use super::datagen_ident;

const CHUNK_ROWS: usize = 10_000;
const STMT_BYTES_CAP: usize = 4 * 1024 * 1024; // stay far under max_allowed_packet
const PREVIEW_CAP: u32 = 100;

// ── Seeded RNG — mulberry32, bit-identical to utils/datagen.ts ───────────────

struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
    fn int(&mut self, min: i64, max: i64) -> i64 {
        (self.next() * ((max - min + 1) as f64)).floor() as i64 + min
    }
    fn pick<'a>(&mut self, arr: &'a [String]) -> &'a str {
        &arr[(self.next() * arr.len() as f64).floor() as usize]
    }
}

// ── Corpora ───────────────────────────────────────────────────────────────────
// The SAME shared JSON the in-browser engine reads (src/data/dictionaries.json),
// embedded at compile time via `include_str!` and parsed once into a
// `LazyLock`. This is the single source of truth: the arrays used to be
// hand-retyped here and had grown to a superset of the JS copy, so a seed
// produced different rows on either side of the 200k row-count tier. Reading
// one file keeps the two tiers bit-identical. `include_str!` makes the JSON a
// build dependency, so editing it triggers a recompile.
//
// Sized so 10k+ row datasets don't look repetitive: names combine 160×160, and
// street/product values compose from parts, giving thousands of variants.

use std::collections::HashMap;
use std::sync::LazyLock;

/// Per-locale metadata (Wave C Phase 4) — the twin of `LocaleMeta` in
/// src/data/dictionaries.ts. Read from the SAME embedded JSON so a per-country
/// shape (phone/postcode/country/address) is defined once for both tiers.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocaleMeta {
    // Kept in the wire format for completeness; the JS tier reads them, and the
    // Rust generators localise through the format/name/code fields below.
    #[allow(dead_code)]
    phone_prefix: String,
    phone_format: String,
    postcode_format: String,
    country_name: String,
    country_code: String,
    #[allow(dead_code)]
    iban_country: String,
    address_format: String,
}

/// One locale's word lists (flattened) plus its optional metadata block.
#[derive(Debug, Deserialize)]
struct LocalePack {
    #[serde(flatten)]
    lists: HashMap<String, Vec<String>>,
    #[serde(default)]
    meta: Option<LocaleMeta>,
}

type Dictionaries = HashMap<String, LocalePack>;

static DICT: LazyLock<Dictionaries> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/data/dictionaries.json"))
        .expect("src/data/dictionaries.json is valid")
});

/// The word list for `name` in `locale`, falling back to `default`.
///
/// Phase 2 threads a real locale here; the signature already takes one so
/// callers need not change. Returns a `'static` slice — the parsed map lives
/// for the process.
fn dict(locale: &str, name: &str) -> &'static [String] {
    let d: &'static Dictionaries = LazyLock::force(&DICT);
    d.get(locale)
        .and_then(|p| p.lists.get(name))
        .or_else(|| d.get("default").and_then(|p| p.lists.get(name)))
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// The metadata block for `locale`, falling back to `default`. Mirrors `meta()`
/// in dictionaries.ts. `default` always carries one, so this never fails.
fn meta(locale: &str) -> &'static LocaleMeta {
    let d: &'static Dictionaries = LazyLock::force(&DICT);
    d.get(locale)
        .and_then(|p| p.meta.as_ref())
        .or_else(|| d.get("default").and_then(|p| p.meta.as_ref()))
        .expect("default locale carries a meta block")
}

// ── Mixed-locale + per-country helpers (Phase 4) ──────────────────────────────

/// Packs `mixed` mode draws a per-row locale from (matches MIXED_PACKS in
/// dictionaries.ts). `default` is excluded — it has no single coherent country.
const MIXED_PACKS: &[&str] = &["cs-CZ", "en-GB", "ja-JP"];

/// ISO-3166-1 alpha-2 codes the random `countryCode` draws from under `default`
/// (matches ISO2 in utils/datagen.ts, in the same order for seeded parity).
const ISO2: &[&str] = &[
    "CZ", "DE", "AT", "PL", "SK", "FR", "ES", "IT", "NL", "BE", "DK",
    "SE", "NO", "FI", "IE", "PT", "CH", "HU", "HR", "SI", "GB", "US",
];

/// Pure integer hash of the row index (Murmur3 finaliser), bit-identical to
/// `localeHash` in dictionaries.ts over the low 32 bits. Used ONLY to place a
/// row into a pack under `mixed`, never touching the shared row RNG.
fn locale_hash(row_idx: u64) -> u32 {
    let mut x = row_idx as u32;
    x = (x ^ (x >> 16)).wrapping_mul(0x045d_9f3b);
    x = (x ^ (x >> 16)).wrapping_mul(0x045d_9f3b);
    x ^ (x >> 16)
}

/// The locale a row generates under. A fixed locale is the identity (its seeded
/// stream is untouched); only `mixed` maps each row onto a single pack.
fn resolve_locale(locale: &str, row_idx: u64) -> &str {
    if locale == "mixed" {
        MIXED_PACKS[(locale_hash(row_idx) % MIXED_PACKS.len() as u32) as usize]
    } else {
        locale
    }
}

// Phase 2: the name/place/company/street/product generators resolve their list
// per row through `dict(locale, name)`, where `locale` is threaded down from the
// run request (see `gen_value`). `default` returns the exact same slice these
// used to cache, so a default-locale run stays bit-identical to the in-browser
// engine — the seeded parity the shared JSON exists to keep. `lorem` is the one
// list no locale overrides (the text generators are language-neutral filler and
// the JS side keeps it a constant too), so it stays a cached default slice; that
// keeps both engines resolving lorem the same way for every locale.
static LOREM: LazyLock<&'static [String]> = LazyLock::new(|| dict("default", "lorem"));

// ── Specs (wire format mirrors utils/datagen.ts) ──────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenParams {
    pub min: f64,
    pub max: f64,
    pub date_from: String,
    pub date_to: String,
    pub list: String,
    pub null_pct: f64,
    /// numeric/date distribution: "uniform" (default) | "normal" | "zipf"
    #[serde(default)]
    pub dist: Option<String>,
    /// FK generator: pull values from this parent (quoted) table + column
    #[serde(default)]
    pub fk_table: Option<String>,
    #[serde(default)]
    pub fk_column: Option<String>,
    /// Stepping (sequence/cycle): distance between consecutive rows. The TS
    /// engine has always honored it; the Rust engine used to ignore it, so a
    /// stepped sequence previewed one way and inserted another (Phase 0 parity).
    #[serde(default)]
    pub step: Option<f64>,
    /// Cycle generator: shift each row's position forward by up to this
    /// percentage of the cycle length (one RNG draw per row when > 0).
    #[serde(default)]
    pub jitter_pct: Option<f64>,
    /// Vehicle-track generators: pings per ride and the ping interval.
    #[serde(default)]
    pub ride_pings: Option<f64>,
    #[serde(default)]
    pub ping_sec: Option<f64>,
    /// Standards-based identifiers (Phase 3): emit a check-digit-correct value
    /// (None/true) or a deliberately-wrong one (Some(false)) for negative tests.
    #[serde(default)]
    pub valid: Option<bool>,
    /// Credit-card brand: "visa" | "mastercard" | "amex". None → legacy test range.
    #[serde(default)]
    pub brand: Option<String>,
    /// IBAN country: "CZ" | "GB" | "JP". None → CZ (the Phase-1 default).
    #[serde(default)]
    pub iban_country: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    pub name: String,
    /// e.g. "VARCHAR(20)" — the uniqueness tag must never push a value past it
    pub type_name: String,
    pub generator: String,
    pub params: GenParams,
    /// enforce uniqueness (mix the row index into the value)
    #[serde(default)]
    pub unique: bool,
}

// ── Values ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum GenValue {
    Null,
    Int(i64),
    Float(f64),
    Bool(bool),
    Str(String),
}

impl GenValue {
    #[cfg(test)]   // the hot path uses sql_literal_into; tests assert via this wrapper
    fn sql_literal(&self, mysql: bool) -> String {
        let mut out = String::new();
        self.sql_literal_into(mysql, &mut out);
        out
    }

    /// Append the literal to `out` — the hot-loop form (WP-11 11.2): the
    /// insert builder used to allocate one String per value per row.
    fn sql_literal_into(&self, mysql: bool, out: &mut String) {
        use std::fmt::Write;
        match self {
            GenValue::Null => out.push_str("NULL"),
            GenValue::Int(i) => { let _ = write!(out, "{i}"); }
            GenValue::Float(f) => { let _ = write!(out, "{f}"); }
            GenValue::Bool(b) => out.push_str(if *b { "TRUE" } else { "FALSE" }),
            GenValue::Str(s) => {
                // MySQL honors backslash escapes in literals; PG (standard
                // conforming strings) treats them literally.
                out.push('\'');
                for ch in s.chars() {
                    match ch {
                        '\'' => out.push_str("''"),
                        '\\' if mysql => out.push_str("\\\\"),
                        c => out.push(c),
                    }
                }
                out.push('\'');
            }
        }
    }

    /// CSV field for PostgreSQL COPY … FROM STDIN WITH (FORMAT csv).
    /// Unquoted empty = NULL; strings quoted with `"` doubling.
    fn csv_field(&self) -> String {
        match self {
            GenValue::Null => String::new(),
            GenValue::Int(i) => i.to_string(),
            GenValue::Float(f) => f.to_string(),
            GenValue::Bool(b) => if *b { "true".into() } else { "false".into() },
            GenValue::Str(s) => format!("\"{}\"", s.replace('"', "\"\"")),
        }
    }

    fn to_json(&self) -> serde_json::Value {
        match self {
            GenValue::Null => serde_json::Value::Null,
            GenValue::Int(i) => serde_json::json!(i),
            GenValue::Float(f) => crate::db::types::json_f64(*f),
            GenValue::Bool(b) => serde_json::json!(b),
            GenValue::Str(s) => serde_json::json!(s),
        }
    }
}

// ── Generator dispatch (port of GENERATORS in utils/datagen.ts) ───────────────

// ── Per-cell config parse memos (WP-11 11.1b) ───────────────────────────────
//
// `choice` re-split/re-parsed its weighted list string and `date`/`timestamp`
// re-parsed date_from/date_to through chrono FOR EVERY CELL. The parsed forms
// are memoized per thread, keyed by the config strings themselves (a string
// compare per cell instead of a parse; maps because several columns of the
// same kind alternate within one row). Content-keyed, so pooled generator
// threads can never serve a stale entry, and no RNG is involved, so seeded
// output is unchanged.
thread_local! {
    static DATE_RANGE_CACHE: std::cell::RefCell<std::collections::HashMap<(String, String), (i64, i64)>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static CHOICE_CACHE: std::cell::RefCell<std::collections::HashMap<String, std::rc::Rc<Vec<(String, f64)>>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

fn date_range_ms(p: &GenParams) -> (i64, i64) {
    DATE_RANGE_CACHE.with_borrow_mut(|cache| {
        if let Some(r) = cache.get(&(p.date_from.clone(), p.date_to.clone())) {
            return *r;
        }
        let parse = |s: &str, suffix: &str| {
            chrono::NaiveDateTime::parse_from_str(&format!("{s}{suffix}"), "%Y-%m-%d %H:%M:%S")
                .map(|d| d.and_utc().timestamp_millis())
                .unwrap_or(0)
        };
        let r = (parse(&p.date_from, " 00:00:00"), parse(&p.date_to, " 23:59:59"));
        cache.insert((p.date_from.clone(), p.date_to.clone()), r);
        r
    })
}

/// The parsed weighted list of a `choice` column — "a:70, b:25, c:5" →
/// weighted; plain "a,b,c" → uniform. Memoized per list string.
fn choice_list(list: &str) -> std::rc::Rc<Vec<(String, f64)>> {
    CHOICE_CACHE.with_borrow_mut(|cache| {
        if let Some(v) = cache.get(list) {
            return v.clone();
        }
        let parsed: Vec<(String, f64)> = list.split(',').filter_map(|s| {
            let s = s.trim();
            if s.is_empty() { return None; }
            match s.rsplit_once(':') {
                Some((v, w)) => w.trim().parse::<f64>().ok().map(|w| (v.trim().to_string(), w)),
                None => Some((s.to_string(), 1.0)),
            }
        }).collect();
        let rc = std::rc::Rc::new(parsed);
        cache.insert(list.to_string(), rc.clone());
        rc
    })
}

fn rand_date_ms(rng: &mut Rng, p: &GenParams) -> i64 {
    let (from, to) = date_range_ms(p);
    from + (rng.next() * ((to - from).max(1) as f64)) as i64
}

fn fmt_ms(ms: i64, with_time: bool) -> String {
    let dt = chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(0).unwrap());
    dt.format(if with_time { "%Y-%m-%d %H:%M:%S" } else { "%Y-%m-%d" }).to_string()
}

/// The declared length in a parenthesised type name — "VARCHAR(20)" → 20.
/// Anything unparsable (DECIMAL(10,2), BIGINT, no parens) → None.
fn paren_len(type_name: &str) -> Option<usize> {
    let open = type_name.find('(')?;
    let close = type_name[open..].find(')')? + open;
    type_name[open + 1..close].trim().parse().ok()
}

// ── Uniqueness by construction (never by retry) ──────────────────────────────
//
// Mirrored exactly in utils/datagen.ts (the constants are drift-guarded by
// tests/datagenParity.test.ts) and spelled in SQL for the server-side path by
// `uniqueSqlWrap` in utils/datagenSql.ts. Three shapes:
//
//   - integers: the row index is PERMUTED into [min, max] — a multiplicative
//     scramble `min + ((a·i + b) mod m)` with `a` coprime to the range size m,
//     a bijection over [0, m): O(1), stateless, reversible;
//   - decimals: the same scramble over the 2-decimal grid of [min, max];
//   - strings: the row index as a zero-padded suffix (`.NNN` before `@` for
//     emails), wide enough for the run's last row so the values stay sortable.
//
// The constants are chosen so `a·i + b` stays exact in an i64 AND an f64:
// a < 2^21, i < 2^31 (the 1e9-row cap) and b < m ≤ 2^31 − 1 keep the product
// under 2^52, which both arithmetics represent exactly.
const SCRAMBLE_M_CAP: i64 = 2_147_483_647; // 2^31 − 1
const SCRAMBLE_A_START: i64 = 2_097_151;   // 2^21 − 1 (odd; walk down by 2)

fn gcd(mut a: i64, mut b: i64) -> i64 {
    while b != 0 { let t = b; b = a % b; a = t; }
    a.abs()
}

/// The multiplier: the largest odd a ≤ SCRAMBLE_A_START coprime to `m`.
fn scramble_a(m: i64) -> i64 {
    if m <= 1 { return 1; }
    let mut a = SCRAMBLE_A_START;
    while gcd(a, m) != 1 { a -= 2; }
    a
}

/// Row `i` permuted within [0, m) — a bijection (gcd(a, m) = 1).
fn scramble_index(i: u64, m: i64, seed: u32) -> i64 {
    if m <= 1 { return 0; }
    let a = scramble_a(m);
    let b = seed as i64 % m;
    (a * (i as i64 % m) + b).rem_euclid(m)
}

/// A unique integer in [min, max] — the scrambled row index.
fn unique_int(i: u64, seed: u32, min: f64, max: f64) -> i64 {
    let (mut lo, mut hi) = (min.round() as i64, max.round() as i64);
    if hi < lo { std::mem::swap(&mut lo, &mut hi); }
    // A range wider than the cap is served by its first M_CAP values: still
    // inside [min, max], still a bijection, still exact in an f64.
    let m = hi.saturating_sub(lo).saturating_add(1).min(SCRAMBLE_M_CAP).max(1);
    lo + scramble_index(i, m, seed)
}

/// A unique decimal in [min, max] on the `decimals` grid (2 matches the JS twin).
fn unique_decimal(i: u64, seed: u32, min: f64, max: f64, decimals: u32) -> f64 {
    let grid = 10f64.powi(decimals as i32);
    let span = ((max - min) * grid).round() + 1.0;
    let m = span.min(SCRAMBLE_M_CAP as f64).max(1.0) as i64;
    let v = min + scramble_index(i, m, seed) as f64 / grid;
    (v * grid).round() / grid
}

/// Width of the uniqueness tag: the digits of the run's last row number.
fn unique_tag_width(total: u64) -> usize {
    total.saturating_sub(1).to_string().len().max(1)
}

/// The string uniqueness tag: `.NNN` before the `@` of an email, `_NNN`
/// otherwise, zero-padded to the run width so the values sort. The tag is
/// never truncated — the base's LEFT edge gives way when a VARCHAR(n) is
/// tight, because uniqueness is what the tag is for.
fn apply_unique_str(s: &str, row_idx: u64, total: u64, type_name: &str) -> String {
    let tag = format!("{:0>width$}", row_idx, width = unique_tag_width(total));
    let (base, domain) = match s.find('@') {
        Some(at) => (format!("{}.{tag}", &s[..at]), s[at..].to_string()),
        None => (format!("{s}_{tag}"), String::new()),
    };
    // The tag grows with the row count — a 17-char ISBN in a VARCHAR(20) fits
    // `_099` but overflows at `_100` ("Data too long" mid-run). Shrink the
    // base's LEFT edge (never the tag) so base+domain fits.
    if let Some(max) = paren_len(type_name) {
        let keep = max.saturating_sub(domain.chars().count());
        let base_chars: Vec<char> = base.chars().collect();
        if base_chars.len() > keep {
            let trimmed: String = base_chars[base_chars.len() - keep..].iter().collect();
            return format!("{trimmed}{domain}");
        }
    }
    format!("{base}{domain}")
}

/// Tiny reverse-regex expander: literals, [a-z]/[0-9]/[A-Z] classes with
/// {n} or {m,n} repeats, (a|b|c) alternation, \d \w shorthands. Enough for
/// SKUs / codes like `[A-Z]{2}-\d{4}`; unsupported syntax passes through.
fn expand_regex(pat: &str, rng: &mut Rng) -> String {
    let cs: Vec<char> = pat.chars().collect();
    let mut i = 0;
    let mut out = String::new();
    let pick = |rng: &mut Rng, set: &[char]| set[(rng.next() * set.len() as f64).floor() as usize];
    let class = |c: char| -> Option<Vec<char>> {
        match c {
            'd' => Some(('0'..='9').collect()),
            'w' => Some(('a'..='z').chain('0'..='9').collect()),
            _ => None,
        }
    };
    while i < cs.len() {
        let c = cs[i];
        let (atom, next): (Vec<char>, usize) = if c == '\\' && i + 1 < cs.len() {
            (class(cs[i + 1]).unwrap_or_else(|| vec![cs[i + 1]]), i + 2)
        } else if c == '[' {
            // char class [a-z0-9...]
            let mut set = Vec::new();
            let mut j = i + 1;
            while j < cs.len() && cs[j] != ']' {
                if j + 2 < cs.len() && cs[j + 1] == '-' {
                    for ch in cs[j]..=cs[j + 2] { set.push(ch); }
                    j += 3;
                } else { set.push(cs[j]); j += 1; }
            }
            (set, j + 1)
        } else if c == '(' {
            // alternation (a|bb|c)
            let mut j = i + 1; let mut depth = 1; let mut body = String::new();
            while j < cs.len() && depth > 0 {
                if cs[j] == '(' { depth += 1; } else if cs[j] == ')' { depth -= 1; if depth == 0 { break; } }
                body.push(cs[j]); j += 1;
            }
            let opts: Vec<&str> = body.split('|').collect();
            let chosen = opts[(rng.next() * opts.len() as f64).floor() as usize];
            out.push_str(chosen);
            i = j + 1;
            // repeats after a group are ignored for simplicity
            continue;
        } else {
            (vec![c], i + 1)
        };
        // repetition {n} or {m,n}
        i = next;
        let mut reps = 1usize;
        if i < cs.len() && cs[i] == '{' {
            let mut j = i + 1; let mut spec = String::new();
            while j < cs.len() && cs[j] != '}' { spec.push(cs[j]); j += 1; }
            i = j + 1;
            let parts: Vec<&str> = spec.split(',').collect();
            let lo: usize = parts[0].trim().parse().unwrap_or(1);
            let hi: usize = parts.get(1).and_then(|x| x.trim().parse().ok()).unwrap_or(lo);
            reps = lo + (rng.next() * ((hi - lo + 1) as f64)).floor() as usize;
        }
        for _ in 0..reps {
            if !atom.is_empty() { out.push(pick(rng, &atom)); }
        }
    }
    out
}

/// ISO 13616 IBAN check digits (MOD-97-10) for `bban` under `country`.
///
/// A faithful port of `ibanCheckDigits` in `utils/datagen.ts`: append the
/// country code as digits (A=10…Z=35) and a "00" placeholder, take the whole
/// thing mod 97 digit-by-digit (so nothing overflows), and the check is 98
/// minus the remainder, zero-padded. The old generator used random check
/// digits, so its IBANs never validated.
fn iban_check_digits(country: &str, bban: &str) -> String {
    // Letters anywhere — the BBAN (GB has a 4-letter bank code) and the country
    // code — expand to two digits (A=10…Z=35) before the mod.
    let rearranged = format!("{}{}00", bban, country).to_uppercase();
    let mut m: u64 = 0;
    for ch in rearranged.chars() {
        if ch.is_ascii_alphabetic() {
            let v = ch as u64 - 55;
            m = (m * 10 + v / 10) % 97;
            m = (m * 10 + v % 10) % 97;
        } else {
            m = (m * 10 + (ch as u64 - '0' as u64)) % 97;
        }
    }
    format!("{:02}", 98 - m)
}

// ── Standards-based check digits (Phase 3) ───────────────────────────────────
//
// Faithful ports of `src/utils/datagenStandards.ts`. The callers (in
// `gen_value`) draw from the seeded RNG in the SAME order as the in-browser
// generators and hand the drawn body here, so a seed yields the same identifier
// on both tiers. `valid == false` corrupts only the check digit.

const LETTERS: &[char] = &[
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
];
const ALNUM: &[char] = &[
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];
// UK NINO prefix letters: first never D,F,I,Q,U,V; second also never O.
const NINO_FIRST: &[char] = &[
    'A', 'B', 'C', 'E', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'W', 'X', 'Y', 'Z',
];
const NINO_SECOND: &[char] = &[
    'A', 'B', 'C', 'E', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'R', 'S', 'T', 'W', 'X', 'Y', 'Z',
];
const NINO_DISALLOWED: &[&str] = &["BG", "GB", "KN", "NK", "NT", "TN", "ZZ"];
const NINO_SUFFIX: &[char] = &['A', 'B', 'C', 'D'];

/// `n` random digits as a string — the identifier primitive (matches the JS
/// `digits(rng, n)` draw order exactly: one `int(0,9)` per digit).
fn digits(rng: &mut Rng, n: usize) -> String {
    (0..n).map(|_| std::char::from_digit(rng.int(0, 9) as u32, 10).unwrap()).collect()
}

/// Pick one element from a `char` set — one RNG draw, like `Rng::pick`.
fn pick_char(rng: &mut Rng, set: &[char]) -> char {
    set[(rng.next() * set.len() as f64).floor() as usize]
}

/// Fill a phone/postcode template from the RNG in the SAME draw order as
/// `fillPattern` in utils/datagen.ts. `{a-b}` → one int in `[a,b]` (a single
/// draw); `A` → one uppercase letter; `9` → one digit; every other character is
/// a literal. An unparsable `{…}` run passes through literally.
fn fill_pattern(pat: &str, rng: &mut Rng) -> String {
    let cs: Vec<char> = pat.chars().collect();
    let mut i = 0;
    let mut out = String::new();
    while i < cs.len() {
        let c = cs[i];
        if c == '{' {
            let mut j = i + 1;
            let mut spec = String::new();
            while j < cs.len() && cs[j] != '}' {
                spec.push(cs[j]);
                j += 1;
            }
            if j < cs.len() {
                if let Some((a, b)) = spec.split_once('-') {
                    if let (Ok(a), Ok(b)) = (a.parse::<i64>(), b.parse::<i64>()) {
                        out.push_str(&rng.int(a, b).to_string());
                        i = j + 1;
                        continue;
                    }
                }
            }
            out.push(c); // not a valid group → literal '{'
            i += 1;
        } else if c == 'A' {
            out.push(pick_char(rng, LETTERS));
            i += 1;
        } else if c == '9' {
            out.push(std::char::from_digit(rng.int(0, 9) as u32, 10).unwrap());
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn corrupt10(c: u32) -> u32 { (c + 1) % 10 }

/// `valid` param: None/Some(true) → correct check digit; Some(false) → wrong.
fn valid_of(p: &GenParams) -> bool { p.valid.unwrap_or(true) }

/// GS1 mod-10 check digit: weights 3,1,… from the rightmost body digit.
fn gs1_check_digit(body: &str) -> u32 {
    let b = body.as_bytes();
    let mut sum = 0u32;
    for i in 0..b.len() {
        let d = (b[b.len() - 1 - i] - b'0') as u32;
        sum += d * if i % 2 == 0 { 3 } else { 1 };
    }
    (10 - (sum % 10)) % 10
}
fn gs1(body: &str, valid: bool) -> String {
    let c = gs1_check_digit(body);
    format!("{body}{}", if valid { c } else { corrupt10(c) })
}

/// Luhn check digit for a numeric body.
fn luhn_check_digit(body: &str) -> u32 {
    let b = body.as_bytes();
    let mut sum = 0u32;
    let mut double = true;
    for i in (0..b.len()).rev() {
        let mut d = (b[i] - b'0') as u32;
        if double { d *= 2; if d > 9 { d -= 9; } }
        sum += d;
        double = !double;
    }
    (10 - (sum % 10)) % 10
}
fn luhn_append(body: &str, valid: bool) -> String {
    let c = luhn_check_digit(body);
    format!("{body}{}", if valid { c } else { corrupt10(c) })
}

/// Full IBAN with correct MOD-97 check digits, or off-by-one when `!valid`.
fn iban(country: &str, bban: &str, valid: bool) -> String {
    let cd = iban_check_digits(country, bban);
    if valid {
        format!("{country}{cd}{bban}")
    } else {
        let wrong = (cd.parse::<u32>().unwrap() + 1) % 100;
        format!("{country}{wrong:02}{bban}")
    }
}

/// CZ rodné číslo check: the 9-digit prefix mod 11 (callers reject a 10).
fn rodne_cislo_check(prefix9: &str) -> u32 {
    let mut m = 0u32;
    for ch in prefix9.bytes() { m = (m * 10 + (ch - b'0') as u32) % 11; }
    m
}
fn rodne_cislo(prefix9: &str, valid: bool) -> String {
    let c = rodne_cislo_check(prefix9);
    format!("{prefix9}{}", if valid { c } else { corrupt10(c) })
}

fn nino_prefix_ok(a: char, b: char) -> bool {
    let s: String = [a, b].iter().collect();
    !NINO_DISALLOWED.contains(&s.as_str())
}

/// JP My Number check digit (12th) over the 11-digit prefix.
fn my_number_check(prefix11: &str) -> u32 {
    let b = prefix11.as_bytes();
    let mut sum = 0u32;
    for n in 1..=11u32 {
        let pn = (b[11 - n as usize] - b'0') as u32;
        let qn = if n <= 6 { n + 1 } else { n - 5 };
        sum += pn * qn;
    }
    let r = sum % 11;
    if r <= 1 { 0 } else { 11 - r }
}
fn my_number(prefix11: &str, valid: bool) -> String {
    let c = my_number_check(prefix11);
    format!("{prefix11}{}", if valid { c } else { corrupt10(c) })
}

/// CZ IČO / DIČ mod-11 check digit over the 7-digit prefix.
fn ico_check_digit(prefix7: &str) -> u32 {
    let b = prefix7.as_bytes();
    let mut sum = 0u32;
    for (i, &digit) in b[..7].iter().enumerate() { sum += (digit - b'0') as u32 * (8 - i as u32); }
    let m = sum % 11;
    if m == 0 { 1 } else if m == 1 { 0 } else { 11 - m }
}
fn cz_vat(prefix7: &str, valid: bool) -> String {
    let c = ico_check_digit(prefix7);
    format!("CZ{prefix7}{}", if valid { c } else { corrupt10(c) })
}

/// GB VAT 2-digit check (97-complement).
fn gb_vat_check(prefix7: &str) -> u32 {
    let w = [8u32, 7, 6, 5, 4, 3, 2];
    let b = prefix7.as_bytes();
    let mut sum = 0u32;
    for i in 0..7 { sum += (b[i] - b'0') as u32 * w[i]; }
    (97 - (sum % 97)) % 97
}
fn gb_vat(prefix7: &str, valid: bool) -> String {
    let c = gb_vat_check(prefix7);
    let cc = if valid { c } else { (c + 1) % 97 };
    format!("{prefix7}{cc:02}")
}

/// JP corporate number leading check digit over the trailing 12 digits.
fn jp_corporate_check(body12: &str) -> u32 {
    let b = body12.as_bytes();
    let mut sum = 0u32;
    for n in 1..=12u32 {
        let pn = (b[12 - n as usize] - b'0') as u32;
        let qn = if n % 2 == 1 { 1 } else { 2 };
        sum += pn * qn;
    }
    9 - (sum % 9)
}
fn jp_corporate_number(body12: &str, valid: bool) -> String {
    let c = jp_corporate_check(body12);
    format!("{}{body12}", if valid { c } else { corrupt10(c) })
}

/// Shaped unit sample in [0,1): normal clusters mid-range, zipf skews low.
fn shaped_unit(rng: &mut Rng, dist: Option<&str>) -> f64 {
    match dist {
        Some("normal") => {
            // Box-Muller, clamped to [0,1), mean 0.5
            let u1 = (rng.next()).max(1e-9);
            let u2 = rng.next();
            let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
            (0.5 + z / 6.0).clamp(0.0, 0.999_999)
        }
        Some("zipf") => {
            // squared → heavy weight toward the low end
            let u = rng.next();
            u * u
        }
        _ => rng.next(),
    }
}

// ── Vehicle tracks — port of utils/rideTracks.ts (keep the math in sync) ──────
//
// Routes are the SAME real OSRM road geometry the frontend bundles, embedded
// once from db/nyc_routes.json (generated together with src/assets/nycRoutes.ts)
// so cars follow real streets and preview matches the insert.

type Pt = (f64, f64); // (lat, lon)

const R_EARTH_M: f64 = 6_371_000.0;

fn ride_routes() -> &'static Vec<Vec<Pt>> {
    static ROUTES: std::sync::OnceLock<Vec<Vec<Pt>>> = std::sync::OnceLock::new();
    ROUTES.get_or_init(|| {
        let raw: Vec<Vec<[f64; 2]>> = serde_json::from_str(include_str!("../db/nyc_routes.json"))
            .expect("nyc_routes.json is valid");
        raw.into_iter().map(|r| r.into_iter().map(|p| (p[0], p[1])).collect()).collect()
    })
}

#[derive(Clone, Copy)]
struct RidePing { car_id: i64, lat: f64, lon: f64, speed_kmh: f64, heading_deg: i64, epoch_sec: i64 }

// ── Ride caches (WP-11 11.1a) ────────────────────────────────────────────────
//
// Every `ride*` column used to call ride_ping(row_idx) independently, and each
// call rebuilt the route (clone of the point vec + cumulative distances) and
// re-simulated all k prior pings — a 7-column GPS table was
// O(rows × pings × columns). The generator runs one row after another on one
// thread, so three thread-locals make it O(rows):
//   • the route, keyed by ride_idx (consecutive rows share a ride);
//   • the travelled distance at ping k, so row N+1 advances ONE step;
//   • the finished ping, keyed by row (the row's 7 ride columns share it).
// Keys carry the parameters they depend on: generator threads may be pooled,
// so a later run with different params must never see a stale entry. All
// inputs are deterministic (no RNG draw), so caching cannot change output.
thread_local! {
    static RIDE_ROUTE: std::cell::RefCell<Option<(u32, RideRoute)>> =
        const { std::cell::RefCell::new(None) };
    /// (ride_idx, k, pings, ping_sec bits) → distance travelled at ping k.
    static RIDE_D: std::cell::Cell<Option<((u32, u32, u64, u64), f64)>> =
        const { std::cell::Cell::new(None) };
    /// (row_idx, pings, ping_sec bits, base_epoch) → the row's ping.
    static RIDE_PING_CACHE: std::cell::Cell<Option<((u64, u64, u64, i64), RidePing)>> =
        const { std::cell::Cell::new(None) };
    /// date_from → base epoch (chrono parse memo).
    static RIDE_EPOCH: std::cell::RefCell<Option<(String, i64)>> =
        const { std::cell::RefCell::new(None) };
}

/// 2-integer hash → u32, matching hash01 in utils/rideTracks.ts bit-for-bit.
fn ride_hash_u32(a: u32, b: u32) -> u32 {
    let mut x = a.wrapping_mul(0x9e37_79b1) ^ b;
    x = (x ^ 61) ^ (x >> 16);
    x = x.wrapping_add(x << 3);
    x ^= x >> 4;
    x = x.wrapping_mul(0x27d4_eb2d);
    x ^ (x >> 15)
}
fn ride_hash01(a: u32, b: u32) -> f64 { ride_hash_u32(a, b) as f64 / 4_294_967_296.0 }

fn ride_haversine_m(a: Pt, b: Pt) -> f64 {
    let d2r = std::f64::consts::PI / 180.0;
    let d_lat = (b.0 - a.0) * d2r;
    let d_lon = (b.1 - a.1) * d2r;
    let s = (d_lat / 2.0).sin().powi(2)
        + (a.0 * d2r).cos() * (b.0 * d2r).cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * R_EARTH_M * s.sqrt().min(1.0).asin()
}
fn ride_bearing_deg(a: Pt, b: Pt) -> f64 {
    let d2r = std::f64::consts::PI / 180.0;
    let y = ((b.1 - a.1) * d2r).sin() * (b.0 * d2r).cos();
    let x = (a.0 * d2r).cos() * (b.0 * d2r).sin()
        - (a.0 * d2r).sin() * (b.0 * d2r).cos() * ((b.1 - a.1) * d2r).cos();
    (y.atan2(x) / d2r + 360.0) % 360.0
}

struct RideRoute { pts: Vec<Pt>, cum: Vec<f64>, len: f64 }

fn ride_route_for(ride_idx: u32) -> RideRoute {
    let routes = ride_routes();
    let base = &routes[(ride_hash_u32(ride_idx, 1) as usize) % routes.len()];
    let mut pts: Vec<Pt> = base.clone();
    if ride_hash_u32(ride_idx, 2) & 1 == 1 { pts.reverse(); }
    let mut cum = vec![0.0f64];
    for i in 1..pts.len() { cum.push(cum[i - 1] + ride_haversine_m(pts[i - 1], pts[i])); }
    let len = *cum.last().unwrap();
    RideRoute { pts, cum, len }
}

fn ride_at(r: &RideRoute, d: f64) -> (f64, f64, f64) {
    let dd = d.max(0.0).min(r.len);
    let mut seg = 0usize;
    while seg < r.cum.len() - 2 && r.cum[seg + 1] < dd { seg += 1; }
    let a = r.pts[seg];
    let b = if seg + 1 < r.pts.len() { r.pts[seg + 1] } else { r.pts[seg] };
    let seg_len = (if seg + 1 < r.cum.len() { r.cum[seg + 1] } else { r.cum[seg] }) - r.cum[seg];
    let f = if seg_len > 0.0 { (dd - r.cum[seg]) / seg_len } else { 0.0 };
    (a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f, ride_bearing_deg(a, b))
}

fn ride_speed_at(r: &RideRoute, ride_idx: u32, j: u32, d: f64, ping_sec: f64) -> f64 {
    if d >= r.len { return 0.0; }
    // Red lights timed by ping, not distance (a distance-gated stop freezes d
    // and the car never leaves) — clears because j keeps advancing.
    let cycle = 40 + (30.0 * ride_hash01(ride_idx, 5)).floor() as u32;
    let red_len = 3 + (4.0 * ride_hash01(ride_idx, 6)).floor() as u32;
    if j % cycle < red_len && ride_hash01(ride_idx, 300 + j / cycle) < 0.5 { return 0.0; }
    let cruise = 34.0 + 20.0 * ride_hash01(ride_idx, 3);
    let ramp_up = ((j as f64 * ping_sec) / 8.0).min(1.0);
    let noise = 0.85 + 0.3 * ride_hash01(ride_idx, 1000 + j);
    cruise * ramp_up * noise
}

fn ride_base_epoch_sec(p: &GenParams) -> i64 {
    let d = if p.date_from.is_empty() { "2026-01-01" } else { p.date_from.as_str() };
    RIDE_EPOCH.with_borrow_mut(|slot| {
        if let Some((cached, epoch)) = slot.as_ref() {
            if cached == d { return *epoch; }
        }
        let epoch = chrono::NaiveDateTime::parse_from_str(&format!("{d} 08:00:00"), "%Y-%m-%d %H:%M:%S")
            .map(|dt| dt.and_utc().timestamp())
            .unwrap_or(0);
        *slot = Some((d.to_string(), epoch));
        epoch
    })
}

fn ride_ping(row_idx: u64, p: &GenParams) -> RidePing {
    let pings = (p.ride_pings.unwrap_or(200.0).floor() as u64).max(2);
    let ping_sec = p.ping_sec.unwrap_or(2.0).max(1.0);
    let base = ride_base_epoch_sec(p);
    let ping_key = (row_idx, pings, ping_sec.to_bits(), base);
    if let Some((key, ping)) = RIDE_PING_CACHE.get() {
        if key == ping_key { return ping; }
    }
    let ride_idx = (row_idx / pings) as u32;
    let k = (row_idx % pings) as u32;
    let mps = |kmh: f64| kmh * 1000.0 / 3600.0;
    let ping = RIDE_ROUTE.with_borrow_mut(|slot| {
        if !matches!(slot, Some((i, _)) if *i == ride_idx) {
            *slot = Some((ride_idx, ride_route_for(ride_idx)));
        }
        let r = &slot.as_ref().unwrap().1;
        // Continue from the cached step when this ping succeeds it (the
        // generation loop's shape); re-simulate from 0 on any other access.
        let mut from_j = 0u32;
        let mut d = 0.0f64;
        if let Some(((ri, kk, pg, ps), dd)) = RIDE_D.get() {
            if ri == ride_idx && kk <= k && pg == pings && ps == ping_sec.to_bits() {
                from_j = kk;
                d = dd;
            }
        }
        for j in from_j..k {
            d += mps(ride_speed_at(r, ride_idx, j, d, ping_sec)) * ping_sec;
            if d >= r.len { d = r.len; break; }
        }
        RIDE_D.set(Some(((ride_idx, k, pings, ping_sec.to_bits()), d)));
        let speed = ride_speed_at(r, ride_idx, k, d, ping_sec);
        let (lat, lon, heading) = ride_at(r, d);
        let start = base + ride_idx as i64 * 180;
        RidePing {
            car_id: ride_idx as i64 + 1,
            lat: (lat * 1e6).round() / 1e6,
            lon: (lon * 1e6).round() / 1e6,
            speed_kmh: (speed * 10.0).round() / 10.0,
            heading_deg: heading.round() as i64,
            epoch_sec: start + k as i64 * ping_sec as i64,
        }
    });
    RIDE_PING_CACHE.set(Some((ping_key, ping)));
    ping
}

fn gen_value(id: &str, rng: &mut Rng, row_idx: u64, seq_start: i64, p: &GenParams, locale: &str) -> GenValue {
    match id {
        // Step-honoring, like the TS engine and the SQL row source: a stepped
        // sequence used to preview stepped and insert contiguous (Phase 0).
        "sequence" => {
            let step = p.step.unwrap_or(1.0).round().max(1.0) as i64;
            GenValue::Int(seq_start + row_idx as i64 * step)
        }
        // Round-robin: row i takes position i mod n (the server path spells the
        // same thing with MOD). `jitter_pct` shifts each row's position forward
        // by up to that percentage of the cycle length — one RNG draw per row
        // when enabled, none when zero, so the seeded stream is stable either
        // way and both tiers draw in lockstep.
        "cycle" => {
            let items: Vec<&str> = p.list.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
            let step = p.step.unwrap_or(1.0).round().max(1.0) as i64;
            let lo = p.min.round() as i64;
            let n = if !items.is_empty() {
                items.len()
            } else {
                (((p.max.round() as i64 - lo) / step) + 1).max(1) as usize
            };
            let mut pos = (row_idx % n as u64) as usize;
            let j = p.jitter_pct.unwrap_or(0.0);
            if j > 0.0 {
                let shift = (rng.next() * (j / 100.0) * n as f64).floor() as usize;
                pos = (pos + shift) % n;
            }
            if !items.is_empty() {
                GenValue::Str(items[pos].to_string())
            } else {
                GenValue::Int(lo + pos as i64 * step)
            }
        }
        "int" => {
            let t = shaped_unit(rng, p.dist.as_deref());
            GenValue::Int((p.min + t * (p.max - p.min + 1.0)).floor() as i64)
        }
        "decimal" => {
            let t = shaped_unit(rng, p.dist.as_deref());
            let v = p.min + t * (p.max - p.min);
            GenValue::Float((v * 100.0).round() / 100.0)
        }
        "bool" => GenValue::Bool(rng.next() < 0.5),
        "firstName" => GenValue::Str(rng.pick(dict(locale, "firstNames")).into()),
        "lastName" => GenValue::Str(rng.pick(dict(locale, "lastNames")).into()),
        "fullName" => {
            let f = rng.pick(dict(locale, "firstNames"));
            let l = rng.pick(dict(locale, "lastNames"));
            GenValue::Str(format!("{f} {l}"))
        }
        "email" => {
            let f = rng.pick(dict(locale, "firstNames")).to_lowercase();
            let l = rng.pick(dict(locale, "lastNames")).to_lowercase();
            let n = rng.int(1, 99);
            let d = rng.pick(dict(locale, "domains"));
            GenValue::Str(format!("{f}.{l}{n}@{d}"))
        }
        "username" => {
            let f = rng.pick(dict(locale, "firstNames")).to_lowercase();
            let n = rng.int(10, 9999);
            GenValue::Str(format!("{f}{n}"))
        }
        "city" => GenValue::Str(rng.pick(dict(locale, "cities")).into()),
        "country" => {
            // Always draw (stream unchanged); a fixed pack pins THAT country,
            // `default` keeps the random pick — byte-identical to Phase 1.
            let picked = rng.pick(dict(locale, "countries")).to_string();
            GenValue::Str(if locale == "default" { picked } else { meta(locale).country_name.clone() })
        }
        "countryCode" => {
            let idx = (rng.next() * ISO2.len() as f64).floor() as usize;
            let picked = ISO2[idx];
            GenValue::Str(if locale == "default" { picked.to_string() } else { meta(locale).country_code.clone() })
        }
        "company" => GenValue::Str(rng.pick(dict(locale, "companies")).into()),
        "street" => {
            let n = rng.int(1, 240);
            let s = rng.pick(dict(locale, "streets"));
            let k = rng.pick(dict(locale, "streetKinds"));
            GenValue::Str(format!("{s} {k} {n}"))
        }
        "product" => {
            let a = rng.pick(dict(locale, "productAdjectives"));
            let n = rng.pick(dict(locale, "productNouns"));
            GenValue::Str(format!("{a} {n}"))
        }
        // Locale dialling format; `default` reproduces the Phase-1 +420 draws.
        "phone" => GenValue::Str(fill_pattern(&meta(locale).phone_format, rng)),
        // Locale postal-code shape; `default` reproduces the Phase-1 NNN NN draws.
        "postcode" => GenValue::Str(fill_pattern(&meta(locale).postcode_format, rng)),
        // Full address composed from the pack's parts in its conventional order.
        // Parts are drawn in a FIXED order so both tiers stay in RNG lockstep;
        // the template only rearranges the drawn text (Japan runs large→small).
        "address" => {
            let m = meta(locale);
            let num = rng.int(1, 240);
            let street = rng.pick(dict(locale, "streets")).to_string();
            let street_kind = rng.pick(dict(locale, "streetKinds")).to_string();
            let city = rng.pick(dict(locale, "cities")).to_string();
            let postcode = fill_pattern(&m.postcode_format, rng);
            GenValue::Str(
                m.address_format
                    .replacen("{num}", &num.to_string(), 1)
                    .replacen("{street}", &street, 1)
                    .replacen("{streetKind}", &street_kind, 1)
                    .replacen("{city}", &city, 1)
                    .replacen("{postcode}", &postcode, 1)
                    .replacen("{country}", &m.country_name, 1),
            )
        }
        "ipv4" => {
            let a = rng.int(1, 254);
            let b = rng.int(0, 255);
            let c = rng.int(0, 255);
            let d = rng.int(1, 254);
            GenValue::Str(format!("{a}.{b}.{c}.{d}"))
        }
        "uuid" => {
            fn hex(rng: &mut Rng, n: usize) -> String {
                (0..n).map(|_| std::char::from_digit((rng.next() * 16.0) as u32, 16).unwrap()).collect()
            }
            let a = hex(rng, 8);
            let b = hex(rng, 4);
            let c = hex(rng, 3);
            let variant = std::char::from_digit(8 + (rng.next() * 4.0) as u32, 16).unwrap();
            let d = hex(rng, 3);
            let e = hex(rng, 12);
            GenValue::Str(format!("{a}-{b}-4{c}-{variant}{d}-{e}"))
        }
        "words" => {
            let n = rng.int(2, 4);
            let w: Vec<&str> = (0..n).map(|_| rng.pick(*LOREM)).collect();
            GenValue::Str(w.join(" "))
        }
        "sentence" => {
            let n = rng.int(8, 16);
            let w: Vec<&str> = (0..n).map(|_| rng.pick(*LOREM)).collect();
            let joined = w.join(" ");
            let mut chars = joined.chars();
            let first = chars.next().map(|c| c.to_ascii_uppercase()).unwrap_or('L');
            GenValue::Str(format!("{first}{}.", chars.as_str()))
        }
        "date" => GenValue::Str(fmt_ms(rand_date_ms(rng, p), false)),
        "timestamp" => GenValue::Str(fmt_ms(rand_date_ms(rng, p), true)),
        "choice" => {
            let parsed = choice_list(&p.list);
            if parsed.is_empty() { GenValue::Str(String::new()) }
            else {
                let total: f64 = parsed.iter().map(|(_, w)| w).sum();
                let mut r = rng.next() * total;
                let mut chosen = parsed[0].0.clone();
                for (v, w) in parsed.iter() { if r < *w { chosen = v.clone(); break; } r -= w; }
                GenValue::Str(chosen)
            }
        }
        "regex" => GenValue::Str(expand_regex(&p.list, rng)),
        // ── Standards-based identifiers (Phase 3). Bodies drawn in the SAME
        //    order as utils/datagen.ts; `valid` toggles the check digit. ──
        "ean8" => GenValue::Str(gs1(&digits(rng, 7), valid_of(p))),
        "ean13" => GenValue::Str(gs1(&digits(rng, 12), valid_of(p))),
        "upcA" => GenValue::Str(gs1(&digits(rng, 11), valid_of(p))),
        "gtin14" => GenValue::Str(gs1(&digits(rng, 13), valid_of(p))),
        "isbn13" => GenValue::Str(gs1(&format!("978{}", digits(rng, 9)), valid_of(p))),
        "creditCard" => {
            let valid = valid_of(p);
            let s = match p.brand.as_deref() {
                Some("visa") => luhn_append(&format!("4{}", digits(rng, 14)), valid),
                Some("mastercard") => luhn_append(&format!("5{}{}", rng.int(1, 5), digits(rng, 13)), valid),
                Some("amex") => luhn_append(&format!("3{}{}", pick_char(rng, &['4', '7']), digits(rng, 12)), valid),
                _ => luhn_append(&format!("400000{}", digits(rng, 9)), valid),
            };
            GenValue::Str(s)
        }
        "iban" => {
            // BBAN shape is country-specific (datagen_ident::iban_bban); the
            // MOD-97 check digits are COMPUTED so the value validates. Empty
            // country → CZ, byte-identical to Phase 1. JP has no ISO IBAN
            // scheme — it emits a plausible SYNTHETIC one from Zengin fields.
            let country = p.iban_country.as_deref().unwrap_or("CZ");
            let bban = datagen_ident::iban_bban(&mut || rng.next(), country);
            GenValue::Str(iban(country, &bban, valid_of(p)))
        }
        "bic" => {
            let valid = valid_of(p);
            let first = if valid {
                pick_char(rng, LETTERS)
            } else {
                std::char::from_digit(rng.int(0, 9) as u32, 10).unwrap()
            };
            let bank: String = std::iter::once(first)
                .chain((0..3).map(|_| pick_char(rng, LETTERS)))
                .collect();
            let country: String = (0..2).map(|_| pick_char(rng, LETTERS)).collect();
            let loc: String = (0..2).map(|_| pick_char(rng, ALNUM)).collect();
            let branch: String = if rng.int(0, 1) == 0 {
                String::new()
            } else {
                (0..3).map(|_| pick_char(rng, ALNUM)).collect()
            };
            GenValue::Str(format!("{bank}{country}{loc}{branch}"))
        }
        // ── Identifier pack 2 (commands/datagen_ident.rs — bit-identical ports
        //    of utils/datagenStandards.ts). Time-ordered ids take the dates
        //    range's `from` as base epoch and tick +1 ms per row, matching the
    //    TS registry entries.
        "uuidV7" => {
            let (from, _) = date_range_ms(p);
            GenValue::Str(datagen_ident::uuid_v7(&mut || rng.next(), from.max(0) as u64, row_idx))
        }
        "ulid" => {
            let (from, _) = date_range_ms(p);
            GenValue::Str(datagen_ident::ulid(&mut || rng.next(), from.max(0) as u64, row_idx))
        }
        "nanoId" => GenValue::Str(datagen_ident::nano_id(&mut || rng.next(), 21)),
        "imei" => GenValue::Str(datagen_ident::imei(&mut || rng.next(), valid_of(p))),
        "vin" => GenValue::Str(datagen_ident::vin(&mut || rng.next(), valid_of(p))),
        "isin" => GenValue::Str(datagen_ident::isin(&mut || rng.next(), valid_of(p))),
        "doi" => GenValue::Str(datagen_ident::doi(&mut || rng.next())),
        "btcAddress" => GenValue::Str(datagen_ident::btc_address(&mut || rng.next())),
        "ethAddress" => GenValue::Str(datagen_ident::eth_address(&mut || rng.next())),
        "cardExpiry" => {
            let fy: i64 = p.date_from[..4].parse().unwrap_or(2026);
            let ty: i64 = p.date_to[..4].parse().unwrap_or(2030);
            GenValue::Str(datagen_ident::card_expiry(&mut || rng.next(), fy, ty, fy, 1))
        }
        "cardCvv" => GenValue::Str(datagen_ident::card_cvv(
            &mut || rng.next(), p.brand.as_deref().unwrap_or(""))),
        // ── Identifier pack 3 (batch 2 ports in datagen_ident.rs — banks,
        //    national IDs, VATs, plates, airports, colors). Row-by-row only,
        //    no server-side SQL form by design.
        "abaRouting" => GenValue::Str(datagen_ident::aba_routing(&mut || rng.next(), valid_of(p))),
        "usSsn" => GenValue::Str(datagen_ident::us_ssn(&mut || rng.next(), valid_of(p))),
        "plPesel" => GenValue::Str(datagen_ident::pl_pesel(&mut || rng.next(), valid_of(p))),
        "deSteuerId" => GenValue::Str(datagen_ident::de_steuer_id(&mut || rng.next(), valid_of(p))),
        "frNir" => GenValue::Str(datagen_ident::fr_nir(&mut || rng.next(), valid_of(p))),
        "esDni" => GenValue::Str(datagen_ident::es_dni(&mut || rng.next(), valid_of(p))),
        "deVat" => GenValue::Str(datagen_ident::de_vat(&mut || rng.next())),
        "frVat" => GenValue::Str(datagen_ident::fr_vat(&mut || rng.next(), valid_of(p))),
        "esVat" => GenValue::Str(datagen_ident::es_vat(&mut || rng.next(), valid_of(p))),
        "plVat" => GenValue::Str(datagen_ident::pl_vat(&mut || rng.next(), valid_of(p))),
        "usEin" => GenValue::Str(datagen_ident::us_ein(&mut || rng.next())),
        "dePlate" => GenValue::Str(datagen_ident::de_plate(&mut || rng.next())),
        "ukPlate" => GenValue::Str(datagen_ident::uk_plate(&mut || rng.next())),
        "jpPlate" => GenValue::Str(datagen_ident::jp_plate(&mut || rng.next())),
        "usPlate" => GenValue::Str(datagen_ident::us_plate(&mut || rng.next())),
        "airport" => GenValue::Str(datagen_ident::airport(&mut || rng.next())),
        "colorHex" => GenValue::Str(datagen_ident::color_hex(&mut || rng.next())),
        "colorRgb" => GenValue::Str(datagen_ident::color_rgb(&mut || rng.next())),
        "colorHsl" => GenValue::Str(datagen_ident::color_hsl(&mut || rng.next())),
        "avatarInitials" => {
            // The SAME firstNames/lastNames draws the name generators make.
            let f = rng.pick(dict(locale, "firstNames"));
            let l = rng.pick(dict(locale, "lastNames"));
            GenValue::Str(datagen_ident::avatar_initials(f, l))
        }
        "czBirthNumber" => {
            let mut prefix;
            loop {
                let yy = format!("{:02}", rng.int(0, 99));
                let base_mm = rng.int(1, 12);
                let female = rng.int(0, 1) == 1;
                let mm = format!("{:02}", base_mm + if female { 50 } else { 0 });
                let dd = format!("{:02}", rng.int(1, 28));
                let serial = digits(rng, 3);
                prefix = format!("{yy}{mm}{dd}{serial}");
                if rodne_cislo_check(&prefix) != 10 { break; }
            }
            GenValue::Str(rodne_cislo(&prefix, valid_of(p)))
        }
        "ukNino" => {
            let (mut a, mut b);
            loop {
                a = pick_char(rng, NINO_FIRST);
                b = pick_char(rng, NINO_SECOND);
                if nino_prefix_ok(a, b) { break; }
            }
            let suffix = if valid_of(p) { pick_char(rng, NINO_SUFFIX) } else { 'Z' };
            GenValue::Str(format!("{a}{b}{}{suffix}", digits(rng, 6)))
        }
        "jpMyNumber" => GenValue::Str(my_number(&digits(rng, 11), valid_of(p))),
        "czVat" => GenValue::Str(cz_vat(&digits(rng, 7), valid_of(p))),
        "gbVat" => GenValue::Str(gb_vat(&digits(rng, 7), valid_of(p))),
        "jpCorporateNumber" => GenValue::Str(jp_corporate_number(&digits(rng, 12), valid_of(p))),
        "json" => {
            let tag = rng.pick(*LOREM);
            let score = rng.int(0, 100);
            let ok = rng.next() < 0.5;
            GenValue::Str(format!("{{\"tag\":\"{tag}\",\"score\":{score},\"ok\":{ok}}}"))
        }
        // ── GPS tracks: each reads the same ping for a row, so lat/lon/speed/
        //    heading/car_id/time agree. Pure in row_idx — the shared RNG is
        //    untouched, which is what keeps the columns correlated.
        "rideCarId" => GenValue::Int(ride_ping(row_idx, p).car_id),
        "rideTimestamp" => GenValue::Str(fmt_ms(ride_ping(row_idx, p).epoch_sec * 1000, true)),
        "rideLat" => GenValue::Float(ride_ping(row_idx, p).lat),
        "rideLon" => GenValue::Float(ride_ping(row_idx, p).lon),
        "rideSpeed" => GenValue::Float(ride_ping(row_idx, p).speed_kmh),
        "rideHeading" => GenValue::Int(ride_ping(row_idx, p).heading_deg),
        "rideWkt" => {
            let g = ride_ping(row_idx, p);
            GenValue::Str(format!("POINT({} {})", g.lon, g.lat))
        }
        _ => GenValue::Null,
    }
}

/// One row, consuming the RNG in spec order (matches generateRows in TS:
/// the null-roll only draws when nullPct > 0). `total` is the whole run's row
/// count (the uniqueness tag is zero-padded to its width); `seed` feeds the
/// uniqueness scramble — both are pure in row_idx, never an RNG draw, so the
/// seeded stream is identical whether or not a column is unique.
#[allow(clippy::too_many_arguments)]
fn gen_row(specs: &[ColumnSpec], rng: &mut Rng, row_idx: u64, seq_start: i64,
           locale: &str, fk_pools: &[Option<Vec<GenValue>>], total: u64, seed: u32) -> Vec<GenValue> {
    // Resolve the row's locale from `row_idx` alone (a pure hash, no RNG draw),
    // so a fixed locale is the identity here and its seeded stream is untouched.
    // Only `mixed` maps the row onto a single pack; every generator in the row
    // then localises through it, so the row is internally coherent.
    let row_locale = resolve_locale(locale, row_idx);
    specs.iter().enumerate().map(|(idx, spec)| {
        if spec.params.null_pct > 0.0 && rng.next() * 100.0 < spec.params.null_pct {
            return GenValue::Null;
        }
        if spec.generator == "fk" {
            return match &fk_pools[idx] {
                // dist=zipf skews the pick toward early pool entries — "a few
                // parents own most children", how real data actually looks
                Some(pool) if !pool.is_empty() => {
                    let t = shaped_unit(rng, spec.params.dist.as_deref());
                    pool[(t * pool.len() as f64).floor() as usize].clone()
                }
                _ => GenValue::Null, // parent empty → NULL (honest, not a fake id)
            };
        }
        let v = gen_value(&spec.generator, rng, row_idx, seq_start, &spec.params, row_locale);
        if !spec.unique { return v; }
        // Uniqueness by construction — the twin of `applyUnique` in
        // utils/datagen.ts (and `uniqueSqlWrap` in datagenSql.ts on the server
        // path). `sequence` and `cycle` are index-driven already: a sequence
        // is always unique; a cycle only while rows ≤ its length, which the
        // panel reports per column rather than silently repeating.
        match spec.generator.as_str() {
            "sequence" | "cycle" => return v,
            _ => {}
        }
        match v {
            // The row index permuted into [min, max] by the scramble — not
            // seq_start + row_idx as before (that ignored the configured
            // range; cross-run continuation past existing values is a separate
            // Phase-1 checkbox, resolve_sequence_start is untouched).
            GenValue::Int(_) => GenValue::Int(unique_int(row_idx, seed, spec.params.min, spec.params.max)),
            GenValue::Float(_) => GenValue::Float(unique_decimal(row_idx, seed, spec.params.min, spec.params.max, 2)),
            GenValue::Str(s) => GenValue::Str(apply_unique_str(&s, row_idx, total, &spec.type_name)),
            other => other,
        }
    }).collect()
}

// ── Preview ───────────────────────────────────────────────────────────────────

/// Same engine as the real run — the preview rows ARE the first rows inserted.
#[tauri::command]
pub async fn generate_preview(
    specs: Vec<ColumnSpec>,
    count: u32,
    seed: u32,
    seq_start: i64,
    // Absent (older callers) → the default mixed corpus.
    locale: Option<String>,
    // The run's real row count — the uniqueness tag is padded to ITS width, so
    // a 15-row preview of a 2500-row run shows the values the insert will
    // write. Absent (older callers) → the preview count.
    total_rows: Option<u64>,
) -> Result<Vec<Vec<serde_json::Value>>, crate::apperror::AppError> {
    let n = count.min(PREVIEW_CAP);
    let locale = locale.unwrap_or_else(default_locale);
    let total = total_rows.unwrap_or(n as u64).max(n as u64);
    let mut rng = Rng(seed);
    // Preview is session-less — FK columns show <fk> placeholder (real pools
    // load at run time). Empty pools per column.
    let empty: Vec<Option<Vec<GenValue>>> = vec![None; specs.len()];
    Ok((0..n as u64)
        .map(|i| gen_row(&specs, &mut rng, i, seq_start, &locale, &empty, total, seed).iter().map(|v| v.to_json()).collect())
        .collect())
}

/// `COALESCE(MAX(col), 0) + 1` — fill-existing runs start sequences after the
/// data already there instead of colliding at 1. `table` arrives pre-quoted.
#[tauri::command]
pub async fn resolve_sequence_start(
    session_id: Uuid,
    table: String,
    column: String,
    state: State<'_, AppState>,
) -> Result<i64, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions).await?;
    let (quote, sql) = match session.as_ref() {
        LiveSession::Mysql(_) => ('`', "`"),
        LiveSession::Postgres(_) => ('"', "\""),
        // Brackets are not a symmetric pair, so the shared formatting below
        // cannot express them; SQL Server takes its own line.
        LiveSession::SqlServer(_) => (']', "]"),
        _ => return Err("not supported for this engine".into()),
    };
    let col = if matches!(session.as_ref(), LiveSession::SqlServer(_)) {
        ms_ident(&column)
    } else {
        format!("{q}{}{q}", column.replace(quote, &format!("{q}{q}", q = sql)), q = sql)
    };
    let query = format!("SELECT COALESCE(MAX({col}), 0) + 1 FROM {table}");
    let r = match session.as_ref() {
        LiveSession::Mysql(pool) => crate::db::mysql::execute(pool, &query).await,
        LiveSession::Postgres(pool) => crate::db::postgres::execute(pool, &query).await,
        LiveSession::SqlServer(s) => crate::db::sqlserver::execute(s, &query).await,
        _ => unreachable!(),
    }?;
    let v = r.rows.first().and_then(|row| row.first()).cloned().unwrap_or(serde_json::json!(1));
    Ok(v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(1))
}

// ── Run ───────────────────────────────────────────────────────────────────────

/// The dictionary pack a run draws names/places/companies from. Absent on the
/// wire (older frontends, tests) means `default`, whose lists are the original
/// mixed corpus — so a request without a locale behaves exactly as before.
fn default_locale() -> String {
    "default".into()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenRun {
    pub session_id: Uuid,
    /// Pre-quoted, possibly schema-qualified (the UI builds it engine-correctly)
    pub table: String,
    pub specs: Vec<ColumnSpec>,
    pub row_count: u64,
    pub seed: u32,
    pub seq_start: i64,
    /// Dictionary pack for name/place/company columns (Phase 2).
    #[serde(default = "default_locale")]
    pub locale: String,
    /// CREATE TABLE to run first (design-new-table mode)
    pub create_ddl: Option<String>,
    /// PostgreSQL COPY FROM STDIN fast path
    pub use_copy: bool,
    /// Parallel writers (Phase 2a): N pooled connections writing disjoint row
    /// ranges (`row_idx % writers == writer_index`). Absent/1 = the original
    /// single-writer pipeline, byte-identical; clamped to [1, MAX_WRITERS].
    /// Ignored on SQL Server, whose session IS one pinned connection.
    #[serde(default)]
    pub writers: Option<u32>,
    pub run_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GenEvent {
    Progress { rows_done: u64, rows_total: u64, rows_per_sec: u64 },
    Done { rows: u64, ms: u64, cancelled: bool },
}

#[tauri::command]
pub async fn generate_data(
    run: GenRun,
    on_event: Channel<GenEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    if state.is_read_only(&run.session_id).await {
        return Err("connection is read-only — data generation is blocked".into());
    }
    state.check_prod_bulk(&run.session_id, "data generation").await?;
    // Generation runs on its own pooled connections with its own transactions,
    // so it cannot join a pinned one. Writing anyway would put every generated
    // row outside the transaction the user believes they are inside — and a
    // later Rollback would leave all of them in place.
    if state.has_open_transaction(&run.session_id).await {
        return Err("a transaction is open on this session — commit or roll back first. \
                    Generation writes on its own connections, so its rows would not be \
                    part of your transaction and Rollback would not remove them.".into());
    }
    let session = get_session_pub(run.session_id, &state.sessions).await?;

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    // Session-prefixed so `cancel_session_work` finds it on close; the cancel
    // command resolves the bare key via `take_ext_job`.
    let run_key = crate::state::ext_job_key(run.session_id, &run.run_key);
    state.ext_jobs.write().await.insert(run_key.clone(), cancel_tx);
    let result = match session.as_ref() {
        LiveSession::Mysql(pool) => write_mysql(pool.clone(), run, on_event, cancel_rx).await,
        LiveSession::Postgres(pool) => write_postgres(pool.clone(), run, on_event, cancel_rx).await,
        LiveSession::SqlServer(_) => write_sqlserver(session.clone(), run, on_event, cancel_rx).await,
        _ => Err("data generation is not supported for this engine".into()),
    };
    state.ext_jobs.write().await.remove(&run_key);
    result
}

/// Kill a running generation at the next statement/chunk boundary; the open
/// transaction rolls back, so a cancel never leaves a torn chunk.
#[tauri::command]
pub async fn cancel_datagen(run_key: String, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    if let Some(tx) = crate::state::take_ext_job(&state.ext_jobs, &run_key).await {
        let _ = tx.send(());
    }
    Ok(())
}

/// COPY … FROM STDIN on the dedicated connection (PG fast path).
async fn copy_pg(
    conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
    copy_sql: &str,
    data: &[u8],
) -> Result<(), crate::apperror::AppError> {
    let mut sink = conn.copy_in_raw(copy_sql).await.map_err(|e| format!("COPY failed: {e}"))?;
    if let Err(e) = sink.send(data).await {
        let _ = sink.abort("send failed").await;
        return Err(format!("COPY stream failed: {e}").into());
    }
    sink.finish().await.map_err(|e| format!("COPY finish failed: {e}"))?;
    Ok(())
}


/// Quote one identifier with `quote`, doubling embedded quote chars — the
/// same rule column_list applies to the INSERT head. A reserved-word or
/// spaced FK column/table must not break (or worse, silently change) the
/// pool query.
fn qident(name: &str, quote: char) -> String {
    format!("{q}{}{q}", name.replace(quote, &format!("{q}{q}", q = quote)), q = quote)
}

/// The FK pool query for one (table, column) pair.
fn fk_pool_sql(table: &str, column: &str, quote: char) -> String {
    let t = qident(table, quote);
    let c = qident(column, quote);
    format!("SELECT DISTINCT {c} FROM {t} WHERE {c} IS NOT NULL LIMIT 10000")
}

/// Load parent PK/value pools for every `fk` column (up to 10k distinct
/// values each) so children reference real parent rows. A pool that FAILS to
/// load is a hard error, not a silent None: every child row getting a NULL FK
/// because of a mistyped column, discovered after inserting millions of rows,
/// is worse than stopping.
async fn load_fk_pools_my(conn: &mut sqlx::MySqlConnection, specs: &[ColumnSpec]) -> Result<Vec<Option<Vec<GenValue>>>, String> {
    let mut out = Vec::with_capacity(specs.len());
    for spec in specs {
        out.push(match (&spec.params.fk_table, &spec.params.fk_column) {
            (Some(t), Some(c)) if spec.generator == "fk" => {
                let sql = fk_pool_sql(t, c, '`');
                let r = crate::db::mysql::execute(&mut *conn, &sql).await
                    .map_err(|e| format!("FK pool for column '{}' ({t}.{c}) failed: {e:#}", spec.name))?;
                Some(r.rows.into_iter().filter_map(|row| json_to_genvalue(row.into_iter().next())).collect())
            }
            _ => None,
        });
    }
    Ok(out)
}
async fn load_fk_pools_pg(conn: &mut sqlx::PgConnection, specs: &[ColumnSpec]) -> Result<Vec<Option<Vec<GenValue>>>, String> {
    let mut out = Vec::with_capacity(specs.len());
    for spec in specs {
        out.push(match (&spec.params.fk_table, &spec.params.fk_column) {
            (Some(t), Some(c)) if spec.generator == "fk" => {
                let sql = fk_pool_sql(t, c, '"');
                let r = crate::db::postgres::execute(&mut *conn, &sql).await
                    .map_err(|e| format!("FK pool for column '{}' ({t}.{c}) failed: {e:#}", spec.name))?;
                Some(r.rows.into_iter().filter_map(|row| json_to_genvalue(row.into_iter().next())).collect())
            }
            _ => None,
        });
    }
    Ok(out)
}
fn json_to_genvalue(v: Option<serde_json::Value>) -> Option<GenValue> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_i64().map(GenValue::Int)
            .or_else(|| n.as_f64().map(GenValue::Float)),
        Some(serde_json::Value::String(s)) => Some(GenValue::Str(s)),
        Some(serde_json::Value::Bool(b)) => Some(GenValue::Bool(b)),
        _ => None,
    }
}

/// Quoted column list for the INSERT/COPY heads.
fn column_list(specs: &[ColumnSpec], quote: char) -> String {
    specs.iter()
        .map(|s| format!("{q}{}{q}", s.name.replace(quote, &format!("{q}{q}", q = quote)), q = quote))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Generator task: chunks through a bounded channel — the generator runs at
/// most one chunk ahead of the writer, so memory stays O(chunk) at any count.
fn spawn_generator(
    specs: Vec<ColumnSpec>,
    total: u64,
    seed: u32,
    seq_start: i64,
    locale: String,
    fk_pools: Vec<Option<Vec<GenValue>>>,
) -> tokio::sync::mpsc::Receiver<Vec<Vec<GenValue>>> {
    spawn_generator_partition(specs, total, seed, seq_start, locale, fk_pools, 0, 1)
}

/// Parallel writers (Phase 2a): absent/0/1 is today's single-writer pipeline.
/// Capped at 8 — past that the server, not the client, is the wall, and each
/// writer replays the full RNG stream (see below), so writer N costs N×
/// generator CPU.
const MAX_WRITERS: u32 = 8;

fn effective_writers(writers: Option<u32>) -> u32 {
    writers.unwrap_or(1).clamp(1, MAX_WRITERS)
}

/// Rows owned by writer `w` of `n` over `[0, total)` under the
/// `i % n == w` partition. Summed over all writers this is exactly `total`.
/// The production predicate is the modulo check in `spawn_generator_partition`;
/// this counting twin exists so the tests can prove the split is disjoint and
/// complete (and exact at u64 scale).
#[cfg(test)]
fn partition_count(total: u64, w: u32, n: u32) -> u64 {
    debug_assert!(w < n);
    total.saturating_sub(w as u64).saturating_add((n as u64) - 1) / n as u64
}

/// rows/s for progress events. Saturating: a speculative u64-scale row count
/// must never overflow the ×1000 — the release profile is panic=abort, so an
/// overflow here would crash the app, not print a wrong number.
fn rate_per_sec(rows_done: u64, ms: u64) -> u64 {
    rows_done.saturating_mul(1000) / ms.max(1)
}

/// The partitioned generator behind the parallel-writer path: writer
/// `writer_index` of `writers` owns exactly the row indices `i` with
/// `i % writers == writer_index` — a disjoint, complete split of `[0, total)`
/// (asserted by the tests). `writers == 1` degrades to the exact chunk stream
/// the original `spawn_generator` produced.
///
/// Row VALUES stay a pure function of `(seed, row_idx)`: the single-writer run
/// draws one sequential mulberry32 stream, so each writer replays that same
/// stream from row 0 and drops the rows it does not own — the draws still
/// happen, keeping the stream position exact. Generation is ~10⁷ rows/s of CPU
/// while the write it feeds is ~10⁵ rows/s of round-trips (docs/DATAGEN_DEEPDIVE
/// §G2), so N writers paying N× generator CPU to remove the writer wall is the
/// right trade — and it is what keeps a seeded run bit-identical at any writer
/// count.
#[allow(clippy::too_many_arguments)]
fn spawn_generator_partition(
    specs: Vec<ColumnSpec>,
    total: u64,
    seed: u32,
    seq_start: i64,
    locale: String,
    fk_pools: Vec<Option<Vec<GenValue>>>,
    writer_index: u32,
    writers: u32,
) -> tokio::sync::mpsc::Receiver<Vec<Vec<GenValue>>> {
    debug_assert!(writers >= 1 && writer_index < writers);
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<Vec<GenValue>>>(2);
    tokio::task::spawn_blocking(move || {
        let mut rng = Rng(seed);
        let mut row_idx: u64 = 0;
        while row_idx < total {
            let mut chunk: Vec<Vec<GenValue>> =
                Vec::with_capacity(((total - row_idx).min(CHUNK_ROWS as u64)) as usize);
            while row_idx < total && chunk.len() < CHUNK_ROWS {
                let row = gen_row(&specs, &mut rng, row_idx, seq_start, &locale, &fk_pools, total, seed);
                if writers == 1 || row_idx % writers as u64 == writer_index as u64 {
                    chunk.push(row);
                }
                row_idx += 1;
            }
            if chunk.is_empty() {
                break; // this writer owns no rows in the remainder (writers > total)
            }
            if tx.blocking_send(chunk).is_err() {
                return; // writer gone (cancel/error) — stop generating
            }
        }
    });
    rx
}

/// One cancel in, N out. `generate_data` registers a single oneshot in
/// `ext_jobs` (so `cancel_datagen` and `cancel_session_work` keep working
/// unchanged); for a parallel run this fan-out forwards that one signal to
/// every writer, and a failed writer fires it too, so the rest stop at their
/// next statement boundary.
struct CancelFanout(std::sync::Mutex<Vec<tokio::sync::oneshot::Sender<()>>>);

impl CancelFanout {
    fn with_receivers(n: u32) -> (Self, Vec<tokio::sync::oneshot::Receiver<()>>) {
        let mut senders = Vec::with_capacity(n as usize);
        let mut receivers = Vec::with_capacity(n as usize);
        for _ in 0..n {
            let (tx, rx) = tokio::sync::oneshot::channel();
            senders.push(tx);
            receivers.push(rx);
        }
        (Self(std::sync::Mutex::new(senders)), receivers)
    }

    /// Idempotent: every registered writer is signalled, exactly once each.
    fn fire(&self) {
        if let Ok(mut senders) = self.0.lock() {
            for tx in senders.drain(..) {
                let _ = tx.send(());
            }
        }
    }
}

/// Live per-writer counters shared between the writer tasks and the
/// orchestrator. `done` tracks the writer's open chunk too (it feeds the live
/// rate); `committed` advances only after a chunk's COMMIT — that is the
/// number the abort report owes the user, because parallel per-chunk commits
/// mean a failed run leaves partial data behind.
struct WriterStats {
    done: Vec<std::sync::atomic::AtomicU64>,
    committed: Vec<std::sync::atomic::AtomicU64>,
}

impl WriterStats {
    fn new(n: u32) -> Self {
        Self {
            done: (0..n).map(|_| std::sync::atomic::AtomicU64::new(0)).collect(),
            committed: (0..n).map(|_| std::sync::atomic::AtomicU64::new(0)).collect(),
        }
    }
    fn set_done(&self, w: usize, v: u64) {
        self.done[w].store(v, std::sync::atomic::Ordering::Relaxed);
    }
    fn set_committed(&self, w: usize, v: u64) {
        self.committed[w].store(v, std::sync::atomic::Ordering::Relaxed);
    }
    fn total_done(&self) -> u64 {
        self.done.iter().map(|a| a.load(std::sync::atomic::Ordering::Relaxed)).sum()
    }
    fn committed_snapshot(&self) -> Vec<u64> {
        self.committed.iter().map(|a| a.load(std::sync::atomic::Ordering::Relaxed)).collect()
    }
}

fn send_progress(on_event: &Channel<GenEvent>, started: std::time::Instant, rows_done: u64, total: u64) {
    let ms = started.elapsed().as_millis().max(1) as u64;
    let _ = on_event.send(GenEvent::Progress {
        rows_done,
        rows_total: total,
        rows_per_sec: rate_per_sec(rows_done, ms),
    });
}

/// One chunk, one transaction. Returns Ok(true) when the run was cancelled
/// mid-chunk (the transaction was rolled back). Keeping the connection borrow
/// INSIDE this call (never live across the channel recv await) is what keeps
/// rustc's auto-trait checker happy — see rustc#102211.
/// `progress` fires with the running rows_done after every statement — the
/// caller decides what event to emit (single-table vs whole-database run).
#[allow(clippy::too_many_arguments)]
async fn write_chunk_my<F: Fn(u64) + Send + Sync>(
    conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
    table: &str,
    cols: &str,
    chunk: &[Vec<GenValue>],
    rows_per_stmt: &mut usize,
    rows_done: &mut u64,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    progress: &F,
) -> Result<bool, crate::apperror::AppError> {
    crate::db::mysql::execute(&mut **conn, "BEGIN").await.map(|_| ())?;
    let mut i = 0;
    while i < chunk.len() {
        if cancel_rx.try_recv().is_ok() {
            let _ = crate::db::mysql::execute(&mut **conn, "ROLLBACK").await;
            return Ok(true);
        }
        let (stmt, n) = build_insert(table, cols, &chunk[i..], *rows_per_stmt, true);
        let t0 = std::time::Instant::now();
        if let Err(e) = crate::db::mysql::execute(&mut **conn, &stmt).await {
            let _ = crate::db::mysql::execute(&mut **conn, "ROLLBACK").await;
            return Err(format!("insert failed after {rows_done} committed rows: {e}").into());
        }
        *rows_per_stmt = adapt(*rows_per_stmt, t0.elapsed().as_millis());
        i += n;
        *rows_done += n as u64;
        progress(*rows_done);
    }
    crate::db::mysql::execute(&mut **conn, "COMMIT").await.map(|_| ())?;
    Ok(false)
}

/// One single-table generator writer per engine (WP-16 16.3, the
/// run_engine!/browse_runner! pattern): the scaffolding — acquire, optional
/// CREATE, FK pools, generator channel, adaptive chunk loop, Done event — is
/// identical; only the driver module, the identifier quote and the chunk
/// writer differ, and the byte-cap/progress logic had already begun to drift
/// between the copies. `$($use_copy)?` threads PG's COPY fast-path flag;
/// MySQL has no equivalent argument.
///
/// `writers > 1` (Phase 2a) takes the parallel branch below: N writer tasks,
/// each on its OWN pooled connection with its own partitioned sub-generator
/// and adaptive sizing, one oneshot fan-out for cancel, and per-writer
/// committed counts in the abort report. `writers == 1` runs the original
/// single-writer body unchanged.
macro_rules! gen_writer {
    ($name:ident, $pool:ty, $exec:path, $load_pools:path, $quote:literal, $write_chunk:ident $(, $use_copy:ident)?) => {
        async fn $name(
            pool: $pool,
            run: GenRun,
            on_event: Channel<GenEvent>,
            mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
        ) -> Result<(), crate::apperror::AppError> {
            let writers = effective_writers(run.writers);
            let started = std::time::Instant::now();
            let cols = column_list(&run.specs, $quote);
            let mut conn = pool.acquire().await?;
            if let Some(ddl) = &run.create_ddl {
                $exec(&mut *conn, ddl).await.map(|_| ()).map_err(|e| format!("CREATE failed: {e}"))?;
            }
            let fk_pools = $load_pools(&mut conn, &run.specs).await?;
            if writers == 1 {
                let mut rx = spawn_generator(run.specs.clone(), run.row_count, run.seed, run.seq_start, run.locale.clone(), fk_pools);
                let mut rows_done: u64 = 0;
                let mut rows_per_stmt: usize = 2_000;
                let mut cancelled = false;
                let progress = |done: u64| send_progress(&on_event, started, done, run.row_count);
                while let Some(chunk) = rx.recv().await {
                    if $write_chunk(&mut conn, &run.table, &cols, &chunk, $(run.$use_copy,)?
                        &mut rows_per_stmt, &mut rows_done, &mut cancel_rx, &progress).await?
                    {
                        cancelled = true;
                        break;
                    }
                }
                rx.close();
                let _ = on_event.send(GenEvent::Done {
                    rows: rows_done, ms: started.elapsed().as_millis() as u64, cancelled,
                });
                return Ok(());
            }

            // ── Parallel writers ────────────────────────────────────────────
            // The DDL is already applied and the FK pools loaded on `conn`;
            // every writer clones the pools and acquires its own connection.
            drop(conn);
            $(let $use_copy = run.$use_copy;)?
            let total = run.row_count;
            let stats = std::sync::Arc::new(WriterStats::new(writers));
            let (fanout, receivers) = CancelFanout::with_receivers(writers);
            let fanout = std::sync::Arc::new(fanout);
            let on_event = std::sync::Arc::new(on_event);
            // The one registered cancel fans out to every writer; a failed
            // writer fires the same fan-out to stop the rest.
            let forwarder = {
                let fanout = fanout.clone();
                tokio::spawn(async move { let _ = cancel_rx.await; fanout.fire(); })
            };
            let mut set = tokio::task::JoinSet::new();
            for (w, mut writer_cancel) in receivers.into_iter().enumerate() {
                let pool = pool.clone();
                let specs = run.specs.clone();
                let table = run.table.clone();
                let cols = cols.clone();
                let locale = run.locale.clone();
                let fk_pools = fk_pools.clone();
                let stats = stats.clone();
                let on_event = on_event.clone();
                let (seed, seq_start) = (run.seed, run.seq_start);
                set.spawn(async move {
                    let mut conn = pool.acquire().await
                        .map_err(|e| format!("writer {w}: connection acquire failed: {e}"))?;
                    let mut rx = spawn_generator_partition(
                        specs, total, seed, seq_start, locale, fk_pools, w as u32, writers);
                    let mut rows_done: u64 = 0;
                    let mut committed: u64 = 0;
                    let mut rows_per_stmt: usize = 2_000;
                    let progress = |done: u64| {
                        stats.set_done(w, done);
                        send_progress(&on_event, started, stats.total_done(), total);
                    };
                    let mut cancelled = false;
                    while let Some(chunk) = rx.recv().await {
                        if $write_chunk(&mut conn, &table, &cols, &chunk, $($use_copy,)?
                            &mut rows_per_stmt, &mut rows_done, &mut writer_cancel, &progress)
                            .await
                            .map_err(|e| format!("writer {w}: {e}"))?
                        {
                            cancelled = true;
                            break;
                        }
                        // COMMIT landed — only now does the chunk count as
                        // committed, the number the abort report owes the user.
                        committed += chunk.len() as u64;
                        stats.set_committed(w, committed);
                    }
                    rx.close();
                    Ok::<bool, crate::apperror::AppError>(cancelled)
                });
            }
            let mut first_err: Option<String> = None;
            let mut cancelled = false;
            while let Some(res) = set.join_next().await {
                match res {
                    Ok(Ok(was_cancelled)) => cancelled |= was_cancelled,
                    Ok(Err(e)) => {
                        if first_err.is_none() { first_err = Some(e.to_string()); }
                        fanout.fire(); // stop the rest at their next statement
                    }
                    Err(e) => {
                        if first_err.is_none() { first_err = Some(format!("a writer task failed: {e}")); }
                        fanout.fire();
                    }
                }
            }
            forwarder.abort();
            let committed = stats.committed_snapshot();
            let total_committed: u64 = committed.iter().sum();
            if let Some(e) = first_err {
                // Honesty over tidiness: per-chunk commits on N connections
                // cannot be undone together, so say exactly what stayed.
                let breakdown = committed.iter().enumerate()
                    .map(|(w, n)| format!("writer {w} committed {n}"))
                    .collect::<Vec<_>>().join(", ");
                return Err(format!(
                    "{e} — parallel run aborted; the committed chunks stay in the table \
                     ({breakdown}; {total_committed} of {total} rows committed)"
                ).into());
            }
            let _ = on_event.send(GenEvent::Done {
                rows: total_committed, ms: started.elapsed().as_millis() as u64, cancelled,
            });
            Ok(())
        }
    };
}

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// Not built from `gen_writer!`, and not because of a missing generic: the macro
// is written around `pool.acquire()`, and a SQL Server session is not a pool —
// it IS one pinned connection. Which is what this path wants anyway, since the
// per-chunk transaction has to land on the same connection as the inserts.

/// The most rows a T-SQL `INSERT … VALUES` will accept.
///
/// A hard server limit, not a tuning choice: 1001 tuples is Msg 10738, *"The
/// number of row value expressions in the INSERT statement exceeds the maximum
/// allowed number of 1000 row values"* — verified on SQL Server 2022. The
/// adaptive sizing below grows towards 10,000 on the other engines, so this cap
/// is applied on every iteration rather than once at the start.
const MSSQL_MAX_VALUES_ROWS: usize = 1000;

/// Bracket-quote an identifier for T-SQL; `]` doubles.
fn ms_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// The column list, bracket-quoted.
fn ms_column_list(specs: &[ColumnSpec]) -> String {
    specs.iter().map(|s| ms_ident(&s.name)).collect::<Vec<_>>().join(", ")
}

/// Parent value pools for `fk` columns.
///
/// `LIMIT 10000` is not T-SQL — the other engines' `fk_pool_sql` cannot be
/// reused, and sending it produces *"Incorrect syntax near 'LIMIT'"*, which is
/// exactly the failure this engine has already had once.
async fn load_fk_pools_ms(
    session: &crate::db::sqlserver::SqlServerSession,
    specs: &[ColumnSpec],
) -> Result<Vec<Option<Vec<GenValue>>>, String> {
    let mut out = Vec::with_capacity(specs.len());
    for spec in specs {
        out.push(match (&spec.params.fk_table, &spec.params.fk_column) {
            (Some(t), Some(c)) if spec.generator == "fk" => {
                let col = ms_ident(c);
                // The table may arrive qualified (`schema.table`), so each part
                // is bracketed separately — `[sales.orders]` is one identifier
                // with a dot in its name, which is not what was meant.
                let tbl = t.split('.').map(ms_ident).collect::<Vec<_>>().join(".");
                let sql = format!(
                    "SELECT DISTINCT TOP (10000) {col} FROM {tbl} WHERE {col} IS NOT NULL");
                let r = crate::db::sqlserver::execute(session, &sql).await
                    .map_err(|e| format!("FK pool for column '{}' ({t}.{c}) failed: {e:#}", spec.name))?;
                Some(r.rows.into_iter().filter_map(|row| json_to_genvalue(row.into_iter().next())).collect())
            }
            _ => None,
        });
    }
    Ok(out)
}

/// One chunk, in its own transaction.
async fn write_chunk_ms<F: Fn(u64) + Send + Sync>(
    session: &crate::db::sqlserver::SqlServerSession,
    table: &str,
    cols: &str,
    chunk: &[Vec<GenValue>],
    rows_per_stmt: &mut usize,
    rows_done: &mut u64,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    progress: &F,
) -> Result<bool, crate::apperror::AppError> {
    use crate::db::sqlserver::execute as ms;
    // `BEGIN` alone opens a statement BLOCK in T-SQL, not a transaction, and
    // the batch is rejected outright (Msg 102).
    ms(session, "BEGIN TRANSACTION").await.map(|_| ())?;
    let mut i = 0;
    while i < chunk.len() {
        if cancel_rx.try_recv().is_ok() {
            let _ = ms(session, "ROLLBACK").await;
            return Ok(true);
        }
        let batch = (*rows_per_stmt).min(MSSQL_MAX_VALUES_ROWS);
        // `false`: T-SQL does not treat a backslash as an escape, so doubling
        // it the MySQL way would write two backslashes into the column.
        let (stmt, n) = build_insert(table, cols, &chunk[i..], batch, false);
        let t0 = std::time::Instant::now();
        if let Err(e) = ms(session, &stmt).await {
            let _ = ms(session, "ROLLBACK").await;
            return Err(format!("insert failed after {rows_done} committed rows: {e}").into());
        }
        *rows_per_stmt = adapt(*rows_per_stmt, t0.elapsed().as_millis()).min(MSSQL_MAX_VALUES_ROWS);
        i += n;
        *rows_done += n as u64;
        progress(*rows_done);
    }
    ms(session, "COMMIT").await.map(|_| ())?;
    Ok(false)
}

async fn write_sqlserver(
    session: std::sync::Arc<crate::db::types::LiveSession>,
    run: GenRun,
    on_event: Channel<GenEvent>,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), crate::apperror::AppError> {
    let crate::db::types::LiveSession::SqlServer(s) = session.as_ref() else {
        return Err("not a SQL Server session".into());
    };
    // `run.writers` is deliberately ignored: a SQL Server session IS one
    // pinned connection (see the section header above), so there is no pool
    // to parallelize across. The UI greys the control for this engine.
    let started = std::time::Instant::now();
    let cols = ms_column_list(&run.specs);
    if let Some(ddl) = &run.create_ddl {
        crate::db::sqlserver::execute(s, ddl).await
            .map(|_| ()).map_err(|e| format!("CREATE failed: {e}"))?;
    }
    let fk_pools = load_fk_pools_ms(s, &run.specs).await?;
    let mut rx = spawn_generator(
        run.specs.clone(), run.row_count, run.seed, run.seq_start, run.locale.clone(), fk_pools);
    let mut rows_done: u64 = 0;
    // Start at the cap rather than the shared 2,000: the first statement would
    // otherwise be rejected before the adaptive sizing ever ran.
    let mut rows_per_stmt: usize = MSSQL_MAX_VALUES_ROWS;
    let mut cancelled = false;
    let progress = |done: u64| send_progress(&on_event, started, done, run.row_count);
    while let Some(chunk) = rx.recv().await {
        if write_chunk_ms(s, &run.table, &cols, &chunk,
                          &mut rows_per_stmt, &mut rows_done, &mut cancel_rx, &progress).await?
        {
            cancelled = true;
            break;
        }
    }
    rx.close();
    let _ = on_event.send(GenEvent::Done {
        rows: rows_done, ms: started.elapsed().as_millis() as u64, cancelled,
    });
    Ok(())
}

// ── MySQL LOAD DATA LOCAL INFILE: evaluated and DECLINED (Phase 2a, 2026-10-17)
//
// By the numbers, not by taste:
//   • This row-by-row writer only ever serves runs BELOW the server-path
//     threshold (SERVER_THRESHOLD = 200_000 rows, utils/datagenSql.ts); past
//     that the panel switches to server-side INSERT…SELECT, measured
//     ~285–300k rows/s (docs/DATAGEN_DEEPDIVE.md §G2). The whole tier this
//     writer serves is ~1.5 s of inserting at the measured 137k rows/s
//     (debug build, local PG, 200k×3 cols) — the single writer is not the
//     wall where this path is actually used.
//   • adapt() converges to its designed ceiling (10k rows / 4 MiB per
//     statement) within a handful of statements on any connection faster
//     than 50 ms/round-trip, so the client side is at maximum early in a
//     run; LOAD DATA's estimated 300k–1M rows/s would shave ~1 s off a
//     workload this path never sees at scale.
//   • sqlx has no streaming LOCAL INFILE support (the client pushes the file
//     inline in the protocol handshake), so the path would mean a SECOND
//     MySQL driver — a whole extra auth/TLS/pool stack in the dependency
//     tree for one fast path — and LOCAL INFILE is off by default on current
//     MySQL (local_infile=0) and commonly stripped in hardened deployments,
//     so the fast path would regularly not exist at runtime anyway.
//   • When the single connection IS the wall (slow LAN / SSH tunnel, where
//     per-statement RTT dominates), the parallel writers above multiply
//     throughput without any new dependency.
// Revisit only with a measured run where adaptive INSERT saturates below the
// 200k threshold AND writers=MAX_WRITERS is already on.
gen_writer!(write_mysql, sqlx::MySqlPool, crate::db::mysql::execute, load_fk_pools_my, '`', write_chunk_my);
gen_writer!(write_postgres, sqlx::PgPool, crate::db::postgres::execute, load_fk_pools_pg, '"', write_chunk_pg, use_copy);

/// PG chunk writer — INSERT path (per-chunk transaction) or COPY fast path
/// (one atomic COPY per chunk). Same cancel/borrow/progress contract as the
/// MySQL one.
#[allow(clippy::too_many_arguments)]
async fn write_chunk_pg<F: Fn(u64) + Send + Sync>(
    conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
    table: &str,
    cols: &str,
    chunk: &[Vec<GenValue>],
    use_copy: bool,
    rows_per_stmt: &mut usize,
    rows_done: &mut u64,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    progress: &F,
) -> Result<bool, crate::apperror::AppError> {
    if cancel_rx.try_recv().is_ok() {
        return Ok(true);
    }
    if use_copy {
        let mut csv = String::with_capacity(chunk.len() * 64);
        for row in chunk {
            let line: Vec<String> = row.iter().map(|v| v.csv_field()).collect();
            csv.push_str(&line.join(","));
            csv.push('\n');
        }
        let copy_sql = format!("COPY {table} ({cols}) FROM STDIN WITH (FORMAT csv)");
        copy_pg(conn, &copy_sql, csv.as_bytes()).await
            .map_err(|e| format!("{e} (after {rows_done} rows)"))?;
        *rows_done += chunk.len() as u64;
        progress(*rows_done);
        return Ok(false);
    }
    crate::db::postgres::execute(&mut **conn, "BEGIN").await.map(|_| ())?;
    let mut i = 0;
    while i < chunk.len() {
        if cancel_rx.try_recv().is_ok() {
            let _ = crate::db::postgres::execute(&mut **conn, "ROLLBACK").await;
            return Ok(true);
        }
        let (stmt, n) = build_insert(table, cols, &chunk[i..], *rows_per_stmt, false);
        let t0 = std::time::Instant::now();
        if let Err(e) = crate::db::postgres::execute(&mut **conn, &stmt).await {
            let _ = crate::db::postgres::execute(&mut **conn, "ROLLBACK").await;
            return Err(format!("insert failed after {rows_done} committed rows: {e}").into());
        }
        *rows_per_stmt = adapt(*rows_per_stmt, t0.elapsed().as_millis());
        i += n;
        *rows_done += n as u64;
        progress(*rows_done);
    }
    crate::db::postgres::execute(&mut **conn, "COMMIT").await.map(|_| ())?;
    Ok(false)
}

// ── Whole-database run (roadmap G3/G4) ────────────────────────────────────────
//
// One transactional-chunked run over MANY tables, parents first: the frontend
// sends tables already topologically ordered by their FK graph. FK pools for a
// child load right before that child generates — after its parents were
// inserted — so children always reference real parent rows.

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRun {
    /// Pre-quoted, schema-qualified name for SQL
    pub table: String,
    /// Bare name for progress display
    pub label: String,
    pub specs: Vec<ColumnSpec>,
    pub row_count: u64,
    pub seq_start: i64,
    /// CREATE TABLE (+ separate CREATE INDEX statements on PG) run before inserting
    pub create_ddl: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbGenRun {
    pub session_id: Uuid,
    /// Statements run once, before any table (CREATE DATABASE/SCHEMA, USE …)
    pub pre_ddl: Vec<String>,
    /// Topologically ordered: every FK parent precedes its children
    pub tables: Vec<TableRun>,
    pub seed: u32,
    /// One dictionary pack for the whole database run (Phase 2).
    #[serde(default = "default_locale")]
    pub locale: String,
    pub use_copy: bool,
    pub run_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DbGenEvent {
    /// A new table starts (index is 0-based)
    Table { index: usize, count: usize, label: String },
    Progress {
        label: String,
        rows_done: u64,
        rows_total: u64,
        total_done: u64,
        total_rows: u64,
        rows_per_sec: u64,
    },
    Done { rows: u64, tables: usize, ms: u64, cancelled: bool },
}

#[tauri::command]
pub async fn generate_database(
    run: DbGenRun,
    on_event: Channel<DbGenEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    if state.is_read_only(&run.session_id).await {
        return Err("connection is read-only — data generation is blocked".into());
    }
    // This one also CREATEs and DROPs tables, so the border matters more here.
    state.check_prod_bulk(&run.session_id, "database generation").await?;
    if state.has_open_transaction(&run.session_id).await {
        return Err("a transaction is open on this session — commit or roll back first. \
                    Generation writes on its own connections, so its rows would not be \
                    part of your transaction and Rollback would not remove them.".into());
    }
    let session = get_session_pub(run.session_id, &state.sessions).await?;

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    // Session-prefixed so `cancel_session_work` finds it on close.
    let run_key = crate::state::ext_job_key(run.session_id, &run.run_key);
    state.ext_jobs.write().await.insert(run_key.clone(), cancel_tx);
    let result = match session.as_ref() {
        LiveSession::Mysql(pool) => db_write_mysql(pool.clone(), run, on_event, cancel_rx).await,
        LiveSession::Postgres(pool) => db_write_postgres(pool.clone(), run, on_event, cancel_rx).await,
        LiveSession::SqlServer(_) =>
            db_write_sqlserver(session.clone(), run, on_event, cancel_rx).await,
        _ => Err("data generation is not supported for this engine".into()),
    };
    state.ext_jobs.write().await.remove(&run_key);
    result
}

fn db_progress(
    on_event: &Channel<DbGenEvent>,
    started: std::time::Instant,
    label: &str,
    rows_done: u64,
    rows_total: u64,
    total_done: u64,
    total_rows: u64,
) {
    let ms = started.elapsed().as_millis().max(1) as u64;
    let _ = on_event.send(DbGenEvent::Progress {
        label: label.to_string(),
        rows_done,
        rows_total,
        total_done,
        total_rows,
        rows_per_sec: rate_per_sec(total_done, ms),
    });
}

/// The whole-database twin of gen_writer! — many tables, parents first
/// (frontend sends them FK-topologically ordered), per-table seed offsets so
/// the run stays reproducible; same engine-parameterization (WP-16 16.3).
macro_rules! db_gen_writer {
    ($name:ident, $pool:ty, $exec:path, $load_pools:path, $quote:literal, $write_chunk:ident $(, $use_copy:ident)?) => {
        async fn $name(
            pool: $pool,
            run: DbGenRun,
            on_event: Channel<DbGenEvent>,
            mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
        ) -> Result<(), crate::apperror::AppError> {
            let started = std::time::Instant::now();
            let mut conn = pool.acquire().await?;
            for ddl in &run.pre_ddl {
                $exec(&mut *conn, ddl).await.map(|_| ())
                    .map_err(|e| format!("DDL failed: {e}\n{ddl}"))?;
            }
            let total_rows: u64 = run.tables.iter().map(|t| t.row_count).sum();
            let table_count = run.tables.len();
            let mut total_done: u64 = 0;
            let mut cancelled = false;
            for (ti, t) in run.tables.iter().enumerate() {
                let _ = on_event.send(DbGenEvent::Table { index: ti, count: table_count, label: t.label.clone() });
                for ddl in &t.create_ddl {
                    $exec(&mut *conn, ddl).await.map(|_| ())
                        .map_err(|e| format!("CREATE {} failed: {e}", t.label))?;
                }
                // Parents are already inserted (topological order) — pools see them.
                let fk_pools = $load_pools(&mut conn, &t.specs).await?;
                // Per-table seed offset: each table gets its own stream, still
                // fully reproducible from the run seed.
                let mut rx = spawn_generator(t.specs.clone(), t.row_count,
                    run.seed.wrapping_add(ti as u32), t.seq_start, run.locale.clone(), fk_pools);
                let cols = column_list(&t.specs, $quote);
                let mut rows_done: u64 = 0;
                let mut rows_per_stmt: usize = 2_000;
                let base = total_done;
                let progress = |done: u64| db_progress(&on_event, started, &t.label,
                    done, t.row_count, base + done, total_rows);
                while let Some(chunk) = rx.recv().await {
                    if $write_chunk(&mut conn, &t.table, &cols, &chunk, $(run.$use_copy,)?
                        &mut rows_per_stmt, &mut rows_done, &mut cancel_rx, &progress).await
                        .map_err(|e| format!("{}: {e}", t.label))?
                    {
                        cancelled = true;
                        break;
                    }
                }
                rx.close();
                total_done = base + rows_done;
                if cancelled { break; }
            }
            let _ = on_event.send(DbGenEvent::Done {
                rows: total_done, tables: table_count,
                ms: started.elapsed().as_millis() as u64, cancelled,
            });
            Ok(())
        }
    };
}

/// The whole-database twin of `write_sqlserver`.
///
/// Same reason it is not built from `db_gen_writer!`: a SQL Server session is
/// one pinned connection, not a pool. Which is also what the per-table
/// transactions want — every chunk commits on the same connection the CREATEs
/// ran on, so a cancel leaves a coherent database rather than half a table
/// belonging to a connection that has gone back to the pool.
async fn db_write_sqlserver(
    session: std::sync::Arc<crate::db::types::LiveSession>,
    run: DbGenRun,
    on_event: Channel<DbGenEvent>,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), crate::apperror::AppError> {
    let crate::db::types::LiveSession::SqlServer(s) = session.as_ref() else {
        return Err("not a SQL Server session".into());
    };
    use crate::db::sqlserver::execute as ms;

    let started = std::time::Instant::now();
    for ddl in &run.pre_ddl {
        ms(s, ddl).await.map(|_| ())
            .map_err(|e| format!("DDL failed: {e}\n{ddl}"))?;
    }
    let total_rows: u64 = run.tables.iter().map(|t| t.row_count).sum();
    let table_count = run.tables.len();
    let mut total_done: u64 = 0;
    let mut cancelled = false;

    for (ti, t) in run.tables.iter().enumerate() {
        let _ = on_event.send(DbGenEvent::Table {
            index: ti, count: table_count, label: t.label.clone(),
        });
        for ddl in &t.create_ddl {
            ms(s, ddl).await.map(|_| ())
                .map_err(|e| format!("CREATE {} failed: {e}", t.label))?;
        }
        // Parents are inserted first (the frontend sends the tables in FK
        // topological order), so the pools see real parent rows.
        let fk_pools = load_fk_pools_ms(s, &t.specs).await?;
        let mut rx = spawn_generator(t.specs.clone(), t.row_count,
            run.seed.wrapping_add(ti as u32), t.seq_start, run.locale.clone(), fk_pools);
        let cols = ms_column_list(&t.specs);
        let mut rows_done: u64 = 0;
        // Starts AT the cap rather than the shared 2,000 — a first statement of
        // 2,000 VALUES rows is Msg 10738 before the adaptive sizing ever runs.
        let mut rows_per_stmt: usize = MSSQL_MAX_VALUES_ROWS;
        let base = total_done;
        let progress = |done: u64| db_progress(&on_event, started, &t.label,
            done, t.row_count, base + done, total_rows);
        while let Some(chunk) = rx.recv().await {
            if write_chunk_ms(s, &t.table, &cols, &chunk,
                              &mut rows_per_stmt, &mut rows_done, &mut cancel_rx, &progress)
                .await.map_err(|e| format!("{}: {e}", t.label))?
            {
                cancelled = true;
                break;
            }
        }
        rx.close();
        total_done = base + rows_done;
        if cancelled { break; }
    }

    let _ = on_event.send(DbGenEvent::Done {
        rows: total_done, tables: table_count,
        ms: started.elapsed().as_millis() as u64, cancelled,
    });
    Ok(())
}

db_gen_writer!(db_write_mysql, sqlx::MySqlPool, crate::db::mysql::execute, load_fk_pools_my, '`', write_chunk_my);
db_gen_writer!(db_write_postgres, sqlx::PgPool, crate::db::postgres::execute, load_fk_pools_pg, '"', write_chunk_pg, use_copy);

/// Multi-row INSERT from the head of `rows`, capped by row count AND bytes.
/// Returns (statement, rows consumed).
fn build_insert(table: &str, cols: &str, rows: &[Vec<GenValue>], max_rows: usize, mysql: bool) -> (String, usize) {
    let mut sql = format!("INSERT INTO {table} ({cols}) VALUES\n");
    // Literals are written straight into the statement buffer — no per-value
    // or per-tuple Strings (WP-11 11.2). The byte cap is enforced by writing
    // the tuple, then truncating it back out if it overflowed (never for the
    // first tuple: one row must always fit or nothing ever sends).
    let mut n = 0;
    for row in rows.iter().take(max_rows) {
        let mark = sql.len();
        if n > 0 { sql.push_str(",\n"); }
        sql.push('(');
        let mut first = true;
        for v in row {
            if !first { sql.push_str(", "); }
            first = false;
            v.sql_literal_into(mysql, &mut sql);
        }
        sql.push(')');
        if n > 0 && sql.len() > STMT_BYTES_CAP {
            sql.truncate(mark);
            break;
        }
        n += 1;
    }
    (sql, n)
}

/// Self-tuning statement size: fast round-trips grow it, slow ones shrink it —
/// local sockets and SSH tunnels converge to sensible sizes on their own.
fn adapt(rows_per_stmt: usize, elapsed_ms: u128) -> usize {
    if elapsed_ms < 50 {
        (rows_per_stmt * 2).min(10_000)
    } else if elapsed_ms > 1_000 {
        (rows_per_stmt / 2).max(250)
    } else {
        rows_per_stmt
    }
}

/// The row-by-row generator against a real SQL Server.
///
/// The path that matters below 200k rows, where the server-side `INSERT …
/// SELECT` is not used — and the one whose T-SQL differences (the VALUES cap,
/// the transaction keyword, backslash-free escaping) a SQLite test cannot
/// reach. Skipped without an endpoint; see docs/MSSQL_DEV.md.
#[cfg(test)]
mod mssql_datagen_live_tests {
    use super::*;
    use crate::db::sqlserver::{self, live_tests::live_session};

    /// The same shape the panel sends; the two numeric bounds are the only
    /// fields these generators read.
    fn params(min: f64, max: f64) -> GenParams {
        GenParams {
            min, max, date_from: "2024-01-01".into(), date_to: "2024-12-31".into(),
            list: String::new(), null_pct: 0.0, dist: None, fk_table: None, fk_column: None,
            ride_pings: None, ping_sec: None,
            step: None, jitter_pct: None,
            valid: None, brand: None, iban_country: None,
        }
    }

    fn spec(name: &str, generator: &str, params: GenParams) -> ColumnSpec {
        ColumnSpec {
            name: name.into(), type_name: String::new(),
            generator: generator.into(), params, unique: false,
        }
    }

    #[test]
    fn the_values_cap_is_a_server_limit_not_a_tuning_choice() {
        // `adapt` grows towards 10,000 on the other engines; T-SQL rejects
        // anything past 1000 outright (Msg 10738), so the cap has to be
        // reapplied on every iteration rather than set once.
        assert_eq!(MSSQL_MAX_VALUES_ROWS, 1000);
        assert!(adapt(MSSQL_MAX_VALUES_ROWS, 10) > MSSQL_MAX_VALUES_ROWS,
                "adapt would grow past the cap, which is exactly why it is re-applied");
        assert_eq!(adapt(MSSQL_MAX_VALUES_ROWS, 10).min(MSSQL_MAX_VALUES_ROWS),
                   MSSQL_MAX_VALUES_ROWS);
    }

    #[test]
    fn a_qualified_fk_table_is_bracketed_part_by_part() {
        // `[sales.orders]` is ONE identifier with a dot in its name.
        assert_eq!(ms_ident("orders"), "[orders]");
        assert_eq!(ms_ident("we]ird"), "[we]]ird]");
        let parts = "sales.orders".split('.').map(ms_ident).collect::<Vec<_>>().join(".");
        assert_eq!(parts, "[sales].[orders]");
    }

    /// The whole-database path: DDL, several tables, FK pools between them.
    ///
    /// Separate from the single-table test because the interesting failures are
    /// between the tables — a child inserted before its parent, or FK pools
    /// loaded from an empty table, produce rows that violate the constraints
    /// the run just created.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn generate_a_whole_database_with_foreign_keys() {
        let Some(s) = live_session().await else {
            println!("no endpoint configured — see docs/MSSQL_DEV.md");
            return;
        };
        sqlserver::execute(&s, "IF OBJECT_ID('dbo.zz_child') IS NOT NULL DROP TABLE dbo.zz_child")
            .await.ok();
        sqlserver::execute(&s, "IF OBJECT_ID('dbo.zz_parent') IS NOT NULL DROP TABLE dbo.zz_parent")
            .await.ok();

        let parent_specs = vec![
            spec("id", "sequence", params(1.0, 1000.0)),
            spec("name", "fullName", params(1.0, 1000.0)),
        ];
        let child_specs = vec![
            spec("id", "sequence", params(1.0, 1000.0)),
            spec("parent_id", "fk", {
                let mut p = params(1.0, 1000.0);
                p.fk_table = Some("dbo.zz_parent".into());
                p.fk_column = Some("id".into());
                p
            }),
        ];

        let run = DbGenRun {
            session_id: uuid::Uuid::nil(),
            pre_ddl: vec![],
            tables: vec![
                TableRun {
                    label: "zz_parent".into(), table: "[dbo].[zz_parent]".into(),
                    create_ddl: vec![
                        "CREATE TABLE dbo.zz_parent (id int PRIMARY KEY, name nvarchar(100))".into()],
                    specs: parent_specs, row_count: 300, seq_start: 1,
                },
                TableRun {
                    label: "zz_child".into(), table: "[dbo].[zz_child]".into(),
                    create_ddl: vec![
                        "CREATE TABLE dbo.zz_child (id int PRIMARY KEY, parent_id int NOT NULL \
                         CONSTRAINT fk_zz REFERENCES dbo.zz_parent(id))".into()],
                    specs: child_specs, row_count: 1200, seq_start: 1,
                },
            ],
            seed: 7, locale: "default".into(), use_copy: false,
            run_key: "livetest".into(),
        };

        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();
        let ch: Channel<DbGenEvent> = Channel::new(|_| Ok(()));
        let session = std::sync::Arc::new(crate::db::types::LiveSession::SqlServer(s));
        db_write_sqlserver(session.clone(), run, ch, rx).await.expect("db generate");

        let crate::db::types::LiveSession::SqlServer(s2) = session.as_ref() else { unreachable!() };
        let r = sqlserver::execute(s2,
            "SELECT (SELECT COUNT(*) FROM dbo.zz_parent), (SELECT COUNT(*) FROM dbo.zz_child), \
                    (SELECT COUNT(*) FROM dbo.zz_child c \
                     WHERE NOT EXISTS (SELECT 1 FROM dbo.zz_parent p WHERE p.id = c.parent_id))")
            .await.expect("read back");
        let row = &r.rows[0];
        assert_eq!(row[0].as_i64(), Some(300), "parent rows");
        // 1,200 rows is past the 1000-row VALUES cap, so the chunk really split.
        assert_eq!(row[1].as_i64(), Some(1_200), "child rows");
        // The FK held: every child points at a parent that exists. A pool
        // loaded before the parents were inserted would fail the constraint
        // outright, so reaching this line at all is most of the assertion.
        assert_eq!(row[2].as_i64(), Some(0), "orphaned children");

        sqlserver::execute(s2, "DROP TABLE dbo.zz_child").await.ok();
        sqlserver::execute(s2, "DROP TABLE dbo.zz_parent").await.ok();
    }

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn generate_rows_row_by_row() {
        let Some(s) = live_session().await else {
            println!("no endpoint configured — see docs/MSSQL_DEV.md");
            return;
        };
        sqlserver::execute(&s, "DROP TABLE IF EXISTS dbo.zz_datagen").await.ok();
        sqlserver::execute(&s,
            "CREATE TABLE dbo.zz_datagen (id bigint, name nvarchar(100), score int)")
            .await.expect("create target");

        let specs = vec![
            spec("id", "sequence", params(1.0, 1000.0)),
            spec("name", "fullName", params(1.0, 1000.0)),
            spec("score", "int", params(1.0, 100.0)),
        ];
        let cols = ms_column_list(&specs);
        assert_eq!(cols, "[id], [name], [score]");

        // 2,500 rows — deliberately more than the 1000-row VALUES cap, so the
        // chunk really does have to split.
        let fk_pools = load_fk_pools_ms(&s, &specs).await.expect("fk pools");
        let mut rx = spawn_generator(specs.clone(), 2_500, 42, 1, "default".into(), fk_pools);
        let (_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let mut rows_per_stmt = MSSQL_MAX_VALUES_ROWS;
        let mut rows_done = 0u64;
        let noop = |_: u64| {};
        while let Some(chunk) = rx.recv().await {
            let cancelled = write_chunk_ms(
                &s, "[dbo].[zz_datagen]", &cols, &chunk,
                &mut rows_per_stmt, &mut rows_done, &mut cancel_rx, &noop,
            ).await.expect("write chunk");
            assert!(!cancelled);
        }
        rx.close();
        assert_eq!(rows_done, 2_500);

        let r = sqlserver::execute(&s,
            "SELECT COUNT(*), COUNT(DISTINCT id), MIN(id), MAX(id), \
                    MIN(score), MAX(score), COUNT(DISTINCT name) \
             FROM dbo.zz_datagen").await.expect("read back");
        let row = &r.rows[0];
        assert_eq!(row[0].as_i64(), Some(2_500));
        // A sequence that restarts per chunk is the bug this asserts against.
        assert_eq!(row[1].as_i64(), Some(2_500), "sequence values are not distinct");
        assert_eq!(row[2].as_i64(), Some(1));
        assert_eq!(row[3].as_i64(), Some(2_500));
        // The bounds the spec asked for, not the generator's defaults.
        assert!(row[4].as_i64().unwrap_or(0) >= 1);
        assert!(row[5].as_i64().unwrap_or(0) <= 100);
        assert!(row[6].as_i64().unwrap_or(0) > 1, "every name is identical");

        // The cap was never exceeded, however fast the inserts were.
        assert!(rows_per_stmt <= MSSQL_MAX_VALUES_ROWS, "grew to {rows_per_stmt}");

        sqlserver::execute(&s, "DROP TABLE dbo.zz_datagen").await.ok();
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn specs() -> Vec<ColumnSpec> {
        let p = GenParams {
            min: 1.0, max: 1000.0,
            date_from: "2024-01-01".into(), date_to: "2026-07-01".into(),
            list: "new,active,disabled".into(), null_pct: 0.0, dist: None,
            fk_table: None, fk_column: None,
            ride_pings: None, ping_sec: None,
            step: None, jitter_pct: None,
            valid: None, brand: None, iban_country: None,
        };
        vec![
            ColumnSpec { name: "id".into(), type_name: "BIGINT".into(), generator: "sequence".into(), params: p.clone(), unique: false },
            ColumnSpec { name: "email".into(), type_name: "VARCHAR".into(), generator: "email".into(), params: p.clone(), unique: false },
            ColumnSpec { name: "created".into(), type_name: "TIMESTAMP".into(), generator: "timestamp".into(), params: p, unique: false },
        ]
    }

    #[test]
    fn seeded_runs_are_identical() {
        let s = specs();
        let mut a = Rng(42);
        let mut b = Rng(42);
        for i in 0..500 {
            let ra: Vec<String> = gen_row(&s, &mut a, i, 1, "default", &[None,None,None], 500, 42).iter().map(|v| v.sql_literal(true)).collect();
            let rb: Vec<String> = gen_row(&s, &mut b, i, 1, "default", &[None,None,None], 500, 42).iter().map(|v| v.sql_literal(true)).collect();
            assert_eq!(ra, rb);
        }
    }

    /// The Rust track port must match utils/rideTracks.ts to the precision the
    /// data is stored at. Reference values captured from the TS model
    /// (ridePings=200, pingSec=2, fleet start 2026-06-01T08:00Z) over the real
    /// NYC routes. If this drifts, preview and the real insert have diverged.
    #[test]
    fn ride_port_matches_the_typescript_model() {
        let p = GenParams {
            min: 1.0, max: 1000.0, date_from: "2026-06-01".into(), date_to: "2026-07-01".into(),
            list: String::new(), null_pct: 0.0, dist: None, fk_table: None, fk_column: None,
            ride_pings: Some(200.0), ping_sec: Some(2.0),
            step: None, jitter_pct: None,
            valid: None, brand: None, iban_country: None,
        };
        // (row, carId, lat, lon, speedKmh, headingDeg, epochSec)
        let cases: &[(u64, i64, f64, f64, f64, i64, i64)] = &[
            (0,   1, 40.735940, -73.991193, 0.0,   26, 1_780_300_800),
            (1,   1, 40.735940, -73.991193, 0.0,   26, 1_780_300_802),
            (50,  1, 40.744241, -73.987620, 51.2,  29, 1_780_300_900),
            (199, 1, 40.768416, -73.981900, 0.0,   68, 1_780_301_198),
            (200, 2, 40.644574, -73.777403, 0.0,    1, 1_780_300_980),
            (517, 3, 40.704254, -73.994388, 43.4, 136, 1_780_301_394),
        ];
        for &(row, car, lat, lon, spd, hdg, epoch) in cases {
            let g = ride_ping(row, &p);
            assert_eq!(g.car_id, car, "car_id row {row}");
            assert!((g.lat - lat).abs() < 1e-6, "lat row {row}: {} vs {lat}", g.lat);
            assert!((g.lon - lon).abs() < 1e-6, "lon row {row}: {} vs {lon}", g.lon);
            assert!((g.speed_kmh - spd).abs() < 0.05, "speed row {row}: {} vs {spd}", g.speed_kmh);
            assert!((g.heading_deg - hdg).abs() <= 1, "heading row {row}: {} vs {hdg}", g.heading_deg);
            assert_eq!(g.epoch_sec, epoch, "epoch row {row}");
            // Every point sits inside the NYC bounding box.
            assert!(g.lat > 40.5 && g.lat < 40.95, "lat {} out of NYC", g.lat);
            assert!(g.lon > -74.1 && g.lon < -73.7, "lon {} out of NYC", g.lon);
        }
    }

    #[test]
    fn sequence_respects_start() {
        let s = specs();
        let mut rng = Rng(1);
        let row = gen_row(&s, &mut rng, 0, 5_000, "default", &[None,None,None], 1, 1);
        assert!(matches!(row[0], GenValue::Int(5_000)));
    }

    #[test]
    fn paren_len_reads_declared_size() {
        assert_eq!(paren_len("VARCHAR(20)"), Some(20));
        assert_eq!(paren_len("char(8)"), Some(8));
        assert_eq!(paren_len("DECIMAL(10,2)"), None);
        assert_eq!(paren_len("BIGINT"), None);
    }

    /// Regression: the library kit's isbn is a 17-char regex value in a
    /// VARCHAR(20) UNIQUE column. The `_rowIdx` uniqueness tag fits at rows
    /// 0–99 but pushed the value to 21 chars at row 100 (MySQL's "row 101")
    /// — "Data too long for column 'isbn'". The tag must shrink the base,
    /// never the column.
    #[test]
    fn unique_tag_never_overflows_column_length() {
        let mut p = params();
        p.list = "97[89]-\\d{2}-\\d{5}-\\d{2}-\\d".into();
        let s = vec![ColumnSpec {
            name: "isbn".into(), type_name: "VARCHAR(20)".into(),
            generator: "regex".into(), params: p, unique: true,
        }];
        let mut rng = Rng(42);
        let mut seen = std::collections::HashSet::new();
        for i in 0..2_500u64 {
            let row = gen_row(&s, &mut rng, i, 1, "default", &[None], 2_500, 42);
            let v = as_str(row.into_iter().next().unwrap());
            assert!(v.chars().count() <= 20, "row {i}: {v} ({} chars)", v.chars().count());
            assert!(seen.insert(v.clone()), "row {i}: duplicate {v}");
        }
    }

    /// The same overflow guard on the email path: the tag lives before the
    /// '@', so the base shrinks while the domain survives intact.
    #[test]
    fn unique_tag_keeps_email_domain_when_truncating() {
        let s = vec![ColumnSpec {
            name: "email".into(), type_name: "VARCHAR(24)".into(),
            generator: "email".into(), params: params(), unique: true,
        }];
        let mut rng = Rng(7);
        let mut seen = std::collections::HashSet::new();
        for i in 0..2_500u64 {
            let row = gen_row(&s, &mut rng, i, 1, "default", &[None], 2_500, 42);
            let v = as_str(row.into_iter().next().unwrap());
            assert!(v.chars().count() <= 24, "row {i}: {v} ({} chars)", v.chars().count());
            assert!(v.contains('@'), "row {i}: lost the domain: {v}");
            assert!(seen.insert(v.clone()), "row {i}: duplicate {v}");
        }
    }

    fn as_str(v: GenValue) -> String {
        match v { GenValue::Str(s) => s, other => panic!("expected Str, got {other:?}") }
    }

    /// The check-digit algorithms, proven against the SAME independently-known
    /// -good reference values the TypeScript suite uses.
    #[test]
    fn check_digit_algorithms_match_known_references() {
        assert_eq!(gs1("9638507", true), "96385074");         // EAN-8
        assert_eq!(gs1("400638133393", true), "4006381333931"); // EAN-13
        assert_eq!(gs1("03600029145", true), "036000291452");   // UPC-A
        assert_eq!(gs1("1061414100041", true), "10614141000415"); // GTIN-14
        assert_eq!(luhn_append("7992739871", true), "79927398713");
        assert_eq!(gb_vat("4340314", true), "434031494");
        assert_eq!(cz_vat("0017704", true), "CZ00177041");      // Škoda Auto IČO
        assert_eq!(jp_corporate_number("000012050002", true), "7000012050002"); // NTA
        assert_eq!(my_number("12345678901", true), "123456789018");
        // GB IBAN reference validates through the shared MOD-97 check.
        assert_eq!(
            format!("GB{}WEST12345698765432", iban_check_digits("GB", "WEST12345698765432")),
            "GB82WEST12345698765432");
        // Invalid variants corrupt exactly the check position.
        assert_ne!(gs1("400638133393", false), "4006381333931");
        assert_ne!(luhn_append("7992739871", false), "79927398713");
        assert_ne!(gb_vat("4340314", false), "434031494");
    }

    /// A fixed seed must give the byte-identical value on BOTH tiers. These
    /// anchors are captured from tests/datagenStandards.test.ts (seed 42, row 0);
    /// if the Rust draw order drifts from the browser's, this fails.
    #[test]
    fn standards_generators_match_the_typescript_engine_for_seed_42() {
        let cases = [
            ("ean8", "64861524"),
            ("ean13", "6486152684284"),
            ("gtin14", "64861526842875"),
            ("upcA", "648615268424"),
            ("isbn13", "9786486152686"),
            ("creditCard", "4000006486152688"),
            ("czBirthNumber", "6056191526"),
            ("ukNino", "PL615268D"),
            ("jpMyNumber", "648615268429"),
            ("czVat", "CZ64861520"),
            ("gbVat", "648615217"),
            ("jpCorporateNumber", "3648615268428"),
        ];
        let p = params();
        for (id, want) in cases {
            let mut rng = Rng(42);
            assert_eq!(as_str(gen_value(id, &mut rng, 0, 1, &p, "default")), want, "generator {id}");
        }
    }

    /// The `valid:false` variant emits the same shape with a WRONG check digit.
    #[test]
    fn invalid_variant_fails_its_own_check() {
        let mut inv = params();
        inv.valid = Some(false);
        let mut rng = Rng(3);
        for _ in 0..200 {
            let v = as_str(gen_value("ean13", &mut rng, 0, 1, &inv, "default"));
            assert_eq!(v.len(), 13);
            let last = (v.as_bytes()[12] - b'0') as u32;
            assert_ne!(gs1_check_digit(&v[..12]), last, "invalid EAN-13 still validated: {v}");
        }
        let mut rng = Rng(3);
        for _ in 0..200 {
            let v = as_str(gen_value("creditCard", &mut rng, 0, 1, &inv, "default"));
            let last = (v.as_bytes()[v.len() - 1] - b'0') as u32;
            assert_ne!(luhn_check_digit(&v[..v.len() - 1]), last, "invalid card still Luhn-valid: {v}");
        }
        // A brand still lands in its IIN range even when the check is corrupted.
        let mut visa = params();
        visa.valid = Some(false);
        visa.brand = Some("visa".into());
        let mut rng = Rng(9);
        let v = as_str(gen_value("creditCard", &mut rng, 0, 1, &visa, "default"));
        assert!(v.starts_with('4') && v.len() == 16, "visa shape: {v}");
    }

    #[test]
    fn literals_escape_per_engine() {
        let v = GenValue::Str("O'Neil \\ co".into());
        assert_eq!(v.sql_literal(true), "'O''Neil \\\\ co'");   // MySQL doubles both
        assert_eq!(v.sql_literal(false), "'O''Neil \\ co'");    // PG only the quote
        assert_eq!(GenValue::Null.sql_literal(true), "NULL");
    }

    #[test]
    fn csv_escapes_quotes_and_null() {
        assert_eq!(GenValue::Str("say \"hi\"".into()).csv_field(), "\"say \"\"hi\"\"\"");
        assert_eq!(GenValue::Null.csv_field(), "");
        assert_eq!(GenValue::Bool(true).csv_field(), "true");
    }

    #[test]
    fn insert_builder_caps_rows_and_bytes() {
        let rows: Vec<Vec<GenValue>> = (0..100).map(|i| vec![GenValue::Int(i)]).collect();
        let (sql, n) = build_insert("t", "\"c\"", &rows, 10, false);
        assert_eq!(n, 10);
        assert!(sql.starts_with("INSERT INTO t (\"c\") VALUES"));
        assert_eq!(sql.matches('(').count() - 1, 10); // 10 tuples + the column list
    }

    /// Real end-to-end run against a local PostgreSQL. Ignored by default:
    /// cargo test --lib datagen -- --ignored --nocapture
    ///
    /// Defaults to port 5433 with `root`/`root`, matching the fixture the rest
    /// of the live tests use (`db::postgres::live_tests`, docs/POSTGRES_DEV.md).
    /// It used to default to `postgres://j@127.0.0.1/postgres`, which predated
    /// that convention and pointed at 5432 — the **md5 auth fixture** — so a
    /// passwordless connect there failed with 28P01 and looked like a product
    /// bug rather than a stale default. Override with $PGURL.
    #[tokio::test]
    #[ignore]
    async fn pg_pipeline_end_to_end() {
        let url = std::env::var("PGURL")
            .unwrap_or_else(|_| "postgres://root:root@127.0.0.1:5433/postgres".into());
        let pool = sqlx::PgPool::connect(&url).await.expect("local PG");
        sqlx::raw_sql("DROP TABLE IF EXISTS datagen_bench").execute(&pool).await.unwrap();

        for use_copy in [false, true] {
            sqlx::raw_sql("DROP TABLE IF EXISTS datagen_bench").execute(&pool).await.unwrap();
            let run = GenRun {
                session_id: Uuid::nil(),
                table: "datagen_bench".into(),
                specs: specs(),
                row_count: 200_000,
                seed: 42,
                seq_start: 1,
                locale: "default".into(),
                create_ddl: Some("CREATE TABLE datagen_bench (id BIGINT PRIMARY KEY, email VARCHAR(255), created TIMESTAMP)".into()),
                use_copy,
                writers: None,
                run_key: "test".into(),
            };
            let (_tx, rx) = tokio::sync::oneshot::channel::<()>();
            let chan = Channel::new(|_body| Ok(()));
            let t0 = std::time::Instant::now();
            write_postgres(pool.clone(), run, chan, rx).await.expect("pipeline run");
            let ms = t0.elapsed().as_millis();
            let n: i64 = sqlx::query_scalar("SELECT count(*) FROM datagen_bench")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(n, 200_000);
            // determinism: same seed → same first row every run
            let first: (i64, String) = sqlx::query_as("SELECT id, email FROM datagen_bench ORDER BY id LIMIT 1")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(first.0, 1);
            println!("{} path: 200k rows in {ms} ms ({} rows/s), first email {}",
                if use_copy { "COPY " } else { "INSERT" }, 200_000_000 / ms.max(1), first.1);
        }
        sqlx::raw_sql("DROP TABLE datagen_bench").execute(&pool).await.unwrap();
    }

    #[test]
    fn adapt_grows_and_shrinks() {
        assert_eq!(adapt(2_000, 10), 4_000);
        assert_eq!(adapt(10_000, 10), 10_000);
        assert_eq!(adapt(2_000, 2_000), 1_000);
        assert_eq!(adapt(300, 5_000), 250);
        assert_eq!(adapt(2_000, 500), 2_000);
    }

    fn params() -> GenParams {
        GenParams {
            min: 1.0, max: 1000.0, date_from: "2024-01-01".into(), date_to: "2026-07-01".into(),
            list: String::new(), null_pct: 0.0, dist: None, fk_table: None, fk_column: None,
            ride_pings: None, ping_sec: None,
            step: None, jitter_pct: None,
            valid: None, brand: None, iban_country: None,
        }
    }

    /// The embedded JSON is the single source of truth shared with the JS
    /// engine. If it fails to parse, or a list is the wrong length, the two
    /// tiers have drifted — which is the whole failure this layer prevents.
    #[test]
    fn embedded_dictionaries_parse_and_have_expected_lengths() {
        for (name, len) in [
            ("firstNames", 160), ("lastNames", 160), ("cities", 120), ("countries", 60),
            ("companies", 60), ("domains", 12), ("streets", 60), ("streetKinds", 10),
            ("productAdjectives", 40), ("productNouns", 60), ("lorem", 63),
        ] {
            assert_eq!(dict("default", name).len(), len, "dictionary {name}");
        }
        // The accessor falls back to `default` for an UNKNOWN locale, and for a
        // list a real locale does not override.
        assert_eq!(dict("nope-XX", "firstNames").len(), 160);
        assert_eq!(dict("cs-CZ", "lorem"), dict("default", "lorem"));
        assert_eq!(dict("ja-JP", "countries"), dict("default", "countries"));
        // First entries are pinned, so a reordering of the JSON is caught here.
        assert_eq!(dict("default", "firstNames")[0], "James");
        assert_eq!(dict("default", "cities")[0], "Prague");
    }

    /// The Phase-2 locale packs must parse from the same embedded JSON with the
    /// lengths the JS suite pins (both engines read one file), stay unicode
    /// through the parse, and be genuinely distinct from the default corpus.
    #[test]
    fn locale_packs_parse_with_expected_lengths_and_unicode() {
        let expected: [(&str, &[(&str, usize)]); 3] = [
            ("cs-CZ", &[("firstNames", 100), ("lastNames", 100), ("cities", 60),
                        ("companies", 60), ("streets", 60), ("streetKinds", 8)]),
            ("en-GB", &[("firstNames", 100), ("lastNames", 100), ("cities", 60),
                        ("companies", 60), ("streets", 60), ("streetKinds", 14)]),
            ("ja-JP", &[("firstNames", 80), ("lastNames", 100), ("cities", 60),
                        ("companies", 60), ("streets", 60), ("streetKinds", 8)]),
        ];
        for (loc, lists) in expected {
            for (name, len) in lists {
                let arr = dict(loc, name);
                assert_eq!(arr.len(), *len, "{loc}/{name} length");
                assert!(arr.iter().all(|s| !s.is_empty()), "{loc}/{name} empty entry");
            }
        }
        // Diacritics and kanji survive `include_str!` → parse.
        assert!(dict("cs-CZ", "lastNames").iter().any(|s| s == "Nováková"));
        assert!(dict("cs-CZ", "cities").iter().any(|s| s == "Plzeň"));
        assert!(dict("ja-JP", "lastNames").iter().any(|s| s == "佐藤"));
        assert!(dict("ja-JP", "cities").iter().any(|s| s == "東京"));
        assert!(dict("en-GB", "lastNames").iter().any(|s| s == "Smith"));
    }

    /// A locale-selected run draws from that locale's lists, a default run is
    /// bit-for-bit what it was before locales existed, and switching locale does
    /// not change the RNG draw order (a non-dictionary column is identical).
    #[test]
    fn locale_threads_through_generation_without_moving_the_default() {
        let name_spec = vec![
            ColumnSpec { name: "n".into(), type_name: "VARCHAR".into(),
                generator: "fullName".into(), params: params(), unique: false },
            ColumnSpec { name: "c".into(), type_name: "VARCHAR".into(),
                generator: "city".into(), params: params(), unique: false },
        ];
        // Every cs-CZ city produced is a cs-CZ city.
        let cz_cities: std::collections::HashSet<&str> =
            dict("cs-CZ", "cities").iter().map(String::as_str).collect();
        let mut rng = Rng(12345);
        for i in 0..60 {
            let row = gen_row(&name_spec, &mut rng, i, 1, "cs-CZ", &[None, None], 60, 12345);
            if let GenValue::Str(city) = &row[1] {
                assert!(cz_cities.contains(city.as_str()), "{city} is not a cs-CZ city");
            } else {
                panic!("city column was not a string");
            }
        }
        // Same seed, different locale → different bytes (locale took effect).
        let default_row = {
            let mut r = Rng(999);
            gen_row(&name_spec, &mut r, 0, 1, "default", &[None, None], 1, 999)
                .iter().map(|v| v.sql_literal(true)).collect::<Vec<_>>()
        };
        let ja_row = {
            let mut r = Rng(999);
            gen_row(&name_spec, &mut r, 0, 1, "ja-JP", &[None, None], 1, 999)
                .iter().map(|v| v.sql_literal(true)).collect::<Vec<_>>()
        };
        assert_ne!(default_row, ja_row);

        // The draw ORDER is unchanged: a sequence + int row is identical across
        // locales, so locale never adds or drops an RNG draw.
        let plain = vec![
            ColumnSpec { name: "id".into(), type_name: "BIGINT".into(),
                generator: "sequence".into(), params: params(), unique: false },
            ColumnSpec { name: "k".into(), type_name: "INT".into(),
                generator: "int".into(), params: params(), unique: false },
        ];
        let mut a = Rng(55);
        let mut b = Rng(55);
        for i in 0..30 {
            let ra: Vec<String> = gen_row(&plain, &mut a, i, 1, "ja-JP", &[None, None], 30, 55)
                .iter().map(|v| v.sql_literal(true)).collect();
            let rb: Vec<String> = gen_row(&plain, &mut b, i, 1, "default", &[None, None], 30, 55)
                .iter().map(|v| v.sql_literal(true)).collect();
            assert_eq!(ra, rb, "locale changed the draw order at row {i}");
        }
    }

    /// Validate an IBAN by the ISO 13616 rule: move the first four characters to
    /// the end, turn letters into digits, and the whole number mod 97 must be 1.
    fn iban_valid(iban: &str) -> bool {
        let s = format!("{}{}", &iban[4..], &iban[..4]);
        let mut m: u64 = 0;
        for ch in s.chars() {
            let d = if ch.is_ascii_digit() {
                ch as u64 - '0' as u64
            } else {
                ch.to_ascii_uppercase() as u64 - 'A' as u64 + 10
            };
            if d >= 10 { m = (m * 10 + d / 10) % 97; m = (m * 10 + d % 10) % 97; }
            else { m = (m * 10 + d) % 97; }
        }
        m == 1
    }

    #[test]
    fn generated_ibans_pass_mod97() {
        let p = params();
        let mut rng = Rng(2024);
        for i in 0..300 {
            let v = gen_value("iban", &mut rng, i, 1, &p, "default");
            let s = match v { GenValue::Str(s) => s, _ => panic!("iban not a string") };
            assert!(s.starts_with("CZ"), "{s} is not a CZ IBAN");
            assert_eq!(s.len(), 24, "CZ IBAN is 24 chars: {s}");
            assert!(iban_valid(&s), "{s} fails MOD-97");
        }
        // The known ISO reference IBAN validates, proving `iban_valid` itself.
        assert!(iban_valid("GB82WEST12345698765432"));
    }

    #[test]
    fn regex_expands_representative_patterns() {
        let mut rng = Rng(7);
        for _ in 0..100 {
            let v = expand_regex("[A-Z]{2}-\\d{4}", &mut rng);
            let b = v.as_bytes();
            assert_eq!(v.len(), 7, "{v}");
            assert!(b[0].is_ascii_uppercase() && b[1].is_ascii_uppercase(), "{v}");
            assert_eq!(b[2], b'-', "{v}");
            assert!(b[3..].iter().all(|c| c.is_ascii_digit()), "{v}");
        }
        // Alternation picks one option verbatim.
        for _ in 0..50 {
            let v = expand_regex("(cat|dog|fish)", &mut rng);
            assert!(["cat", "dog", "fish"].contains(&v.as_str()), "{v}");
        }
        // A literal string with no metacharacters comes back unchanged.
        assert_eq!(expand_regex("ABC-123", &mut rng), "ABC-123");
        // \w ranges cover a-z and 0-9.
        for _ in 0..50 {
            let v = expand_regex("\\w{5}", &mut rng);
            assert_eq!(v.len(), 5);
            assert!(v.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()), "{v}");
        }
    }

    // ── Wave C Phase 4 — per-country generators + row-level coherence ─────────

    fn gen_at(id: &str, seed: u32, row: u64, locale: &str) -> String {
        let p = params();
        let mut rng = Rng(seed);
        as_str(gen_value(id, &mut rng, row, 1, &p, locale))
    }

    /// The meta block parses for every pack and carries the expected identity.
    #[test]
    fn locale_meta_parses_for_every_pack() {
        for (loc, name, code) in [
            ("default", "Czechia", "CZ"),
            ("cs-CZ", "Czechia", "CZ"),
            ("en-GB", "United Kingdom", "GB"),
            ("ja-JP", "Japan", "JP"),
        ] {
            let m = meta(loc);
            assert_eq!(m.country_name, name, "{loc} country name");
            assert_eq!(m.country_code, code, "{loc} country code");
            assert!(!m.phone_format.is_empty() && !m.postcode_format.is_empty(), "{loc} formats");
        }
        // An unknown locale falls back to default's meta.
        assert_eq!(meta("nope-XX").country_code, "CZ");
    }

    /// Phone/postcode take the pack's format; default reproduces Phase 1.
    #[test]
    fn per_locale_phone_and_postcode_shapes() {
        let re = |s: &str, pat: &dyn Fn(&str) -> bool, msg: &str| assert!(pat(s), "{msg}: {s}");
        // default/cs-CZ phone: +420 NNN NNN NNN
        for loc in ["default", "cs-CZ"] {
            let v = gen_at("phone", 7, 0, loc);
            re(&v, &|s| s.starts_with("+420 ") && s.matches(' ').count() == 3, "cz phone");
        }
        // GB: +44 NNNN NNNNNN ; JP: +81 N-NNNN-NNNN
        assert!(gen_at("phone", 7, 0, "en-GB").starts_with("+44 "));
        assert!(gen_at("phone", 7, 0, "ja-JP").starts_with("+81 "));
        // postcode shapes
        let cz_pc = gen_at("postcode", 7, 0, "cs-CZ");
        re(&cz_pc, &|s| s.len() == 6 && s.as_bytes()[3] == b' ', "cz postcode NNN NN");
        let gb_pc = gen_at("postcode", 7, 0, "en-GB");
        re(&gb_pc, &|s| {
            let b = s.as_bytes();
            // AA9A 9AA — eight characters, space at index 4.
            b.len() == 8 && b[0].is_ascii_uppercase() && b[1].is_ascii_uppercase()
                && b[2].is_ascii_digit() && b[3].is_ascii_uppercase() && b[4] == b' '
                && b[5].is_ascii_digit() && b[6].is_ascii_uppercase() && b[7].is_ascii_uppercase()
        }, "gb postcode AANA NAA");
        let jp_pc = gen_at("postcode", 7, 0, "ja-JP");
        re(&jp_pc, &|s| s.len() == 8 && s.as_bytes()[3] == b'-', "jp postcode NNN-NNNN");
    }

    /// A fixed pack pins its own country/code; default draws at random.
    #[test]
    fn country_is_constant_under_a_fixed_pack() {
        for s in 1..40 {
            assert_eq!(gen_at("country", s, 0, "cs-CZ"), "Czechia");
            assert_eq!(gen_at("countryCode", s, 0, "cs-CZ"), "CZ");
            assert_eq!(gen_at("country", s, 0, "en-GB"), "United Kingdom");
            assert_eq!(gen_at("countryCode", s, 0, "en-GB"), "GB");
            assert_eq!(gen_at("country", s, 0, "ja-JP"), "Japan");
            assert_eq!(gen_at("countryCode", s, 0, "ja-JP"), "JP");
        }
        let varied: std::collections::HashSet<String> =
            (1..60).map(|s| gen_at("country", s, 0, "default")).collect();
        assert!(varied.len() > 5, "default country should vary across seeds");
    }

    /// A fixed value must be byte-identical on BOTH tiers. These strings are
    /// pinned identically in tests/datagenParams.test.ts (seed 42, row 0); if
    /// either engine's draw order drifts, one side fails.
    #[test]
    fn phase4_generators_match_the_typescript_engine_for_seed_42() {
        assert_eq!(gen_at("phone", 42, 0, "default"), "+420 720 503 867");
        assert_eq!(gen_at("postcode", 42, 0, "default"), "640 50");
        assert_eq!(gen_at("phone", 42, 0, "en-GB"), "+44 6409 503461");
        assert_eq!(gen_at("phone", 42, 0, "ja-JP"), "+81 6-5034-8672");
        assert_eq!(gen_at("postcode", 42, 0, "en-GB"), "PL8R 1NH");
        assert_eq!(gen_at("postcode", 42, 0, "ja-JP"), "648-6152");
        assert_eq!(gen_at("address", 42, 0, "cs-CZ"), "Ječná náves 145, 257 57 Litvínov, Czechia");
        assert_eq!(gen_at("address", 42, 0, "ja-JP"), "Japan 〒152-6842 柏高円寺本町145");
    }

    /// The country/countryCode override draws exactly one pick, so a trailing
    /// non-locale column is byte-identical across packs (stream unperturbed).
    #[test]
    fn country_override_does_not_move_the_stream() {
        let specs = |id: &str| vec![
            ColumnSpec { name: "a".into(), type_name: "TEXT".into(),
                generator: id.into(), params: params(), unique: false },
            ColumnSpec { name: "k".into(), type_name: "INT".into(),
                generator: "int".into(), params: params(), unique: false },
        ];
        for id in ["country", "countryCode"] {
            for loc in ["cs-CZ", "en-GB", "ja-JP"] {
                let s = specs(id);
                let mut a = Rng(321);
                let mut b = Rng(321);
                for i in 0..20 {
                    let ra = gen_row(&s, &mut a, i, 1, loc, &[None, None], 20, 321)[1].sql_literal(true);
                    let rb = gen_row(&s, &mut b, i, 1, "default", &[None, None], 20, 321)[1].sql_literal(true);
                    assert_eq!(ra, rb, "{id}/{loc} moved the RNG stream at row {i}");
                }
            }
        }
    }

    /// `mixed` derives a per-row locale from a pure hash of row_idx (no RNG),
    /// bit-identical to dictionaries.ts `localeHash`; a fixed locale is identity.
    #[test]
    fn mixed_resolves_a_per_row_pack_without_touching_the_rng() {
        // Pinned against the JS localeHash (rows 0..7 → these packs).
        let want = ["cs-CZ", "en-GB", "cs-CZ", "cs-CZ", "en-GB", "ja-JP", "en-GB", "cs-CZ"];
        for (i, w) in want.iter().enumerate() {
            assert_eq!(resolve_locale("mixed", i as u64), *w, "row {i}");
        }
        // Fixed locale resolves to itself — the fixed-locale path is untouched.
        assert_eq!(resolve_locale("cs-CZ", 5), "cs-CZ");
        assert_eq!(resolve_locale("default", 5), "default");
    }

    /// In mixed mode every row is internally coherent: its country, ISO code,
    /// phone prefix and city all come from the SAME per-row pack.
    #[test]
    fn mixed_rows_are_internally_coherent() {
        let specs = vec![
            ColumnSpec { name: "country".into(), type_name: "TEXT".into(),
                generator: "country".into(), params: params(), unique: false },
            ColumnSpec { name: "cc".into(), type_name: "TEXT".into(),
                generator: "countryCode".into(), params: params(), unique: false },
            ColumnSpec { name: "phone".into(), type_name: "TEXT".into(),
                generator: "phone".into(), params: params(), unique: false },
            ColumnSpec { name: "city".into(), type_name: "TEXT".into(),
                generator: "city".into(), params: params(), unique: false },
        ];
        let mut rng = Rng(42);
        let mut seen = std::collections::HashSet::new();
        for i in 0..300u64 {
            let row = gen_row(&specs, &mut rng, i, 1, "mixed", &[None, None, None, None], 300, 42);
            let pack = resolve_locale("mixed", i);
            seen.insert(pack);
            let m = meta(pack);
            let cities: std::collections::HashSet<&str> =
                dict(pack, "cities").iter().map(String::as_str).collect();
            assert_eq!(as_str(row[0].clone()), m.country_name, "row {i} country");
            assert_eq!(as_str(row[1].clone()), m.country_code, "row {i} code");
            assert!(as_str(row[2].clone()).starts_with(&m.phone_prefix), "row {i} phone");
            assert!(cities.contains(as_str(row[3].clone()).as_str()), "row {i} city not in {pack}");
        }
        assert!(seen.len() >= 2, "mixed produced only one pack");
    }

    /// A `default` (and cs-CZ) run must be byte-identical to before Phase 4 for
    /// the touched generators — the seeded-parity guarantee the whole layer keeps.
    #[test]
    fn default_run_is_unchanged_for_touched_generators() {
        // A fixed-locale seeded run is deterministic (same seed → same rows).
        let specs = vec![
            ColumnSpec { name: "p".into(), type_name: "TEXT".into(),
                generator: "phone".into(), params: params(), unique: false },
            ColumnSpec { name: "z".into(), type_name: "TEXT".into(),
                generator: "postcode".into(), params: params(), unique: false },
            ColumnSpec { name: "c".into(), type_name: "TEXT".into(),
                generator: "country".into(), params: params(), unique: false },
        ];
        let mut a = Rng(99);
        let mut b = Rng(99);
        for i in 0..100 {
            let ra: Vec<String> = gen_row(&specs, &mut a, i, 1, "default", &[None, None, None], 100, 99)
                .iter().map(|v| v.sql_literal(true)).collect();
            let rb: Vec<String> = gen_row(&specs, &mut b, i, 1, "default", &[None, None, None], 100, 99)
                .iter().map(|v| v.sql_literal(true)).collect();
            assert_eq!(ra, rb);
        }
    }
    /// WP-08 8.4: the FK pool query quotes both identifiers, so a
    /// reserved-word or backtick-carrying name cannot break out of (or
    /// silently change) the statement.
    #[test]
    fn fk_pool_sql_quotes_reserved_and_hostile_identifiers() {
        assert_eq!(
            fk_pool_sql("order", "key", '`'),
            "SELECT DISTINCT `key` FROM `order` WHERE `key` IS NOT NULL LIMIT 10000"
        );
        assert_eq!(
            fk_pool_sql("a`b", "c", '`'),
            "SELECT DISTINCT `c` FROM `a``b` WHERE `c` IS NOT NULL LIMIT 10000"
        );
        assert_eq!(
            fk_pool_sql("Order", "user", '"'),
            "SELECT DISTINCT \"user\" FROM \"Order\" WHERE \"user\" IS NOT NULL LIMIT 10000"
        );
    }

    /// WP-11 11.1a: the ride caches (route / distance continuation / row ping)
    /// are pure memoization — a jump-access (cache-busting) computation must
    /// produce bit-identical pings to the sequential pass that filled them.
    #[test]
    fn ride_ping_caches_do_not_change_output() {
        let p = params();
        let seq: Vec<RidePing> = (0..500u64).map(|i| ride_ping(i, &p)).collect();
        for &i in &[499u64, 0, 250, 123, 250, 1] {
            let cold = ride_ping(i, &p);
            let want = &seq[i as usize];
            assert_eq!(cold.car_id, want.car_id, "row {i}");
            assert_eq!(cold.lat.to_bits(), want.lat.to_bits(), "row {i} lat");
            assert_eq!(cold.lon.to_bits(), want.lon.to_bits(), "row {i} lon");
            assert_eq!(cold.speed_kmh.to_bits(), want.speed_kmh.to_bits(), "row {i} speed");
            assert_eq!(cold.heading_deg, want.heading_deg, "row {i} heading");
            assert_eq!(cold.epoch_sec, want.epoch_sec, "row {i} epoch");
        }
    }

    // ── Phase 0/1: path parity + uniqueness by construction ─────────────────
    // The pinned vectors below are shared with tests/datagenParity.test.ts —
    // if either engine drifts, one side fails.

    /// The sequence used to ignore `step` here while the TS engine honored it —
    /// stepped on preview, contiguous on insert (Phase 0, BUG 1).
    #[test]
    fn sequence_honours_step() {
        let mut p = params();
        p.step = Some(5.0);
        let mut rng = Rng(1);
        for (i, want) in [1i64, 6, 11, 16].iter().enumerate() {
            match gen_value("sequence", &mut rng, i as u64, 1, &p, "default") {
                GenValue::Int(v) => assert_eq!(v, *want, "row {i}"),
                other => panic!("expected Int, got {other:?}"),
            }
        }
    }

    /// The scramble is a bijection over [0, m): m rows, m distinct values.
    #[test]
    fn scramble_is_a_full_permutation_of_the_range() {
        for m in [1i64, 2, 3, 17, 97, 1000, 999_983] {
            let seen: std::collections::HashSet<i64> =
                (0..m as u64).map(|i| scramble_index(i, m, 42)).collect();
            assert_eq!(seen.len(), m as usize, "m={m} is not a bijection");
            assert!(seen.iter().all(|&v| (0..m).contains(&v)), "m={m} escapes [0, m)");
        }
        // The invariants the SQL spelling and the f64 twin rely on.
        assert_eq!(SCRAMBLE_A_START, 2_097_151);
        assert_eq!(SCRAMBLE_M_CAP, 2_147_483_647);
        let a = scramble_a(1_000_000);
        assert!(a < (1 << 21) && a % 2 == 1 && gcd(a, 1_000_000) == 1);
        // a·i + b stays under 2^53: exact in an f64 AND an i64.
        assert!((SCRAMBLE_A_START as u128) * (SCRAMBLE_M_CAP as u128) < (1u128 << 53));
    }

    /// Unique ints: the whole [10, 29] range exactly once, in the order the TS
    /// engine produces for seed 42 (pinned in tests/datagenParity.test.ts).
    #[test]
    fn unique_int_scramble_matches_the_typescript_engine() {
        let mut p = params();
        p.min = 10.0;
        p.max = 29.0;
        let s = vec![ColumnSpec {
            name: "n".into(), type_name: "INT".into(),
            generator: "int".into(), params: p, unique: true,
        }];
        let mut rng = Rng(42);
        let got: Vec<i64> = (0..10u64).map(|i| {
            match gen_row(&s, &mut rng, i, 1, "default", &[None], 10, 42).into_iter().next().unwrap() {
                GenValue::Int(v) => v,
                other => panic!("expected Int, got {other:?}"),
            }
        }).collect();
        assert_eq!(got, [12, 23, 14, 25, 16, 27, 18, 29, 20, 11]);
    }

    /// Unique decimals land on the 2-decimal grid, pinned against TS (seed 42).
    #[test]
    fn unique_decimal_scramble_matches_the_typescript_engine() {
        let mut p = params();
        p.min = 1.0;
        p.max = 2.0;
        let s = vec![ColumnSpec {
            name: "d".into(), type_name: "DECIMAL(10,2)".into(),
            generator: "decimal".into(), params: p, unique: true,
        }];
        let mut rng = Rng(42);
        let got: Vec<f64> = (0..6u64).map(|i| {
            match gen_row(&s, &mut rng, i, 1, "default", &[None], 6, 42).into_iter().next().unwrap() {
                GenValue::Float(v) => v,
                other => panic!("expected Float, got {other:?}"),
            }
        }).collect();
        assert_eq!(got, [1.42, 1.29, 1.16, 1.03, 1.91, 1.78]);
    }

    /// Unique strings: zero-padded to the run width, pinned against TS.
    #[test]
    fn unique_strings_are_zero_padded_and_pinned() {
        let mut p = params();
        p.list = "ABC".into();
        let s = vec![ColumnSpec {
            name: "c".into(), type_name: "VARCHAR(20)".into(),
            generator: "choice".into(), params: p, unique: true,
        }];
        let mut rng = Rng(42);
        let got: Vec<String> = (0..3u64).map(|i| {
            as_str(gen_row(&s, &mut rng, i, 1, "default", &[None], 15, 42).into_iter().next().unwrap())
        }).collect();
        assert_eq!(got, ["ABC_00", "ABC_01", "ABC_02"]);
    }

    /// Email keeps the tag before the '@', padded, pinned against TS (seed 42).
    #[test]
    fn unique_email_tag_is_pinned_to_the_typescript_engine() {
        let s = vec![ColumnSpec {
            name: "e".into(), type_name: "VARCHAR(255)".into(),
            generator: "email".into(), params: params(), unique: true,
        }];
        let mut rng = Rng(42);
        let got: Vec<String> = (0..3u64).map(|i| {
            as_str(gen_row(&s, &mut rng, i, 1, "default", &[None], 15, 42).into_iter().next().unwrap())
        }).collect();
        assert_eq!(got, [
            "jiri.watson85.00@fastmail.dev",
            "iris.jelinek28.01@inbox.me",
            "jackson.price25.02@mailbox.cz",
        ]);
    }

    /// The tag is as wide as the run, and truncation still shrinks the base,
    /// never the tag.
    #[test]
    fn unique_tag_width_tracks_the_run_size() {
        assert_eq!(unique_tag_width(1), 1);
        assert_eq!(unique_tag_width(15), 2);
        assert_eq!(unique_tag_width(2_500), 4);
        assert_eq!(apply_unique_str("ABC", 7, 2_500, "VARCHAR(20)"), "ABC_0007");
        // 17-char base + `_0007` = 22 > VARCHAR(20): two chars off the LEFT.
        assert_eq!(
            apply_unique_str("978-12-34567-89-0", 7, 2_500, "VARCHAR(20)"),
            "8-12-34567-89-0_0007");
        assert_eq!(
            apply_unique_str("a.b@example.com", 3, 15, "VARCHAR(255)"),
            "a.b.03@example.com");
    }

    /// Cycle: wraparound + the stepped range form, pinned against TS.
    #[test]
    fn cycle_wraps_around_and_matches_the_typescript_engine() {
        let mut p = params();
        p.list = "a,b,c".into();
        let got: Vec<String> = (0..7u64).map(|i| {
            // jitter off: no draws, the seed is irrelevant
            let mut rng = Rng(42);
            as_str(gen_value("cycle", &mut rng, i, 1, &p, "default"))
        }).collect();
        assert_eq!(got, ["a", "b", "c", "a", "b", "c", "a"]);

        let mut p2 = params();
        p2.list = String::new();
        p2.min = 5.0;
        p2.max = 25.0;
        p2.step = Some(5.0);
        let got: Vec<i64> = (0..8u64).map(|i| {
            let mut rng = Rng(42);
            match gen_value("cycle", &mut rng, i, 1, &p2, "default") {
                GenValue::Int(v) => v,
                other => panic!("expected Int, got {other:?}"),
            }
        }).collect();
        assert_eq!(got, [5, 10, 15, 20, 25, 5, 10, 15]);
    }

    /// A jittered cycle draws once per row from the shared seeded stream —
    /// pinned against the TS engine (seed 42), so the streams stay in lockstep.
    #[test]
    fn cycle_jitter_is_seeded_and_bounded() {
        let mut p = params();
        p.list = "a,b,c,d".into();
        p.jitter_pct = Some(50.0);
        let mut rng = Rng(42);
        let got: Vec<String> = (0..10u64)
            .map(|i| as_str(gen_value("cycle", &mut rng, i, 1, &p, "default")))
            .collect();
        assert_eq!(got, ["b", "b", "d", "a", "a", "c", "c", "a", "b", "b"]);
        // Jitter bound: the shift is under 50% of the 4-item cycle, so row i
        // never lands further than (i mod 4) + 1 positions ahead (mod 4).
        for (i, v) in got.iter().enumerate() {
            let base = i % 4;
            let pos = "abcd".find(v.as_str().chars().next().unwrap()).unwrap();
            assert!((pos + 4 - base) % 4 <= 1, "row {i}: {v} jumped too far");
        }
    }

}

// ── Phase 2a tests: parallel writers + u64 scale ─────────────────────────────

#[cfg(test)]
mod parallel_writer_tests {
    use super::*;

    fn params() -> GenParams {
        GenParams {
            min: 1.0, max: 1000.0, date_from: "2024-01-01".into(), date_to: "2026-07-01".into(),
            list: String::new(), null_pct: 0.0, dist: None, fk_table: None, fk_column: None,
            ride_pings: None, ping_sec: None,
            step: None, jitter_pct: None,
            valid: None, brand: None, iban_country: None,
        }
    }

    /// The mix a purity proof has to cover: an index-driven column (sequence),
    /// plain RNG draws (int, email — dictionary-backed), an RNG null draw, and
    /// the row_idx-scrambled unique paths.
    fn specs() -> Vec<ColumnSpec> {
        let mut nullable = params();
        nullable.null_pct = 25.0;
        vec![
            ColumnSpec { name: "id".into(), type_name: "BIGINT".into(),
                generator: "sequence".into(), params: params(), unique: false },
            ColumnSpec { name: "n".into(), type_name: "INT".into(),
                generator: "int".into(), params: params(), unique: true },
            ColumnSpec { name: "email".into(), type_name: "VARCHAR(255)".into(),
                generator: "email".into(), params: params(), unique: true },
            ColumnSpec { name: "nick".into(), type_name: "VARCHAR(64)".into(),
                generator: "username".into(), params: nullable, unique: false },
        ]
    }

    fn literals(row: &[GenValue]) -> Vec<String> {
        row.iter().map(|v| v.sql_literal(true)).collect()
    }

    #[test]
    fn writers_clamp_to_1_through_8() {
        assert_eq!(effective_writers(None), 1);
        assert_eq!(effective_writers(Some(0)), 1);
        assert_eq!(effective_writers(Some(1)), 1);
        assert_eq!(effective_writers(Some(2)), 2);
        assert_eq!(effective_writers(Some(8)), 8);
        assert_eq!(effective_writers(Some(64)), MAX_WRITERS);
    }

    /// The `i % writers == w` partition: disjoint, and its union is every row.
    #[test]
    fn partition_covers_every_row_exactly_once() {
        for writers in 1..=MAX_WRITERS {
            for total in [0u64, 1, 2, 7, 8, 9, 10_000, 100_003, 100_000_000_000] {
                let sum: u64 = (0..writers).map(|w| partition_count(total, w, writers)).sum();
                assert_eq!(sum, total, "writers={writers} total={total}");
            }
            for i in 0..1_000u64 {
                let owners = (0..writers).filter(|&w| i % writers as u64 == w as u64).count();
                assert_eq!(owners, 1, "row {i} owned {owners}× with {writers} writers");
            }
        }
    }

    /// The guarantee the whole design rests on: value(row_idx) must not depend
    /// on the writer count. Each writer replays the shared RNG stream and drops
    /// the rows it does not own, so its kept rows must equal the single-writer
    /// run's rows at the same indices, byte for byte.
    #[test]
    fn partitioned_values_are_identical_to_the_single_writer_run() {
        let total = 500u64;
        let s = specs();
        let empty: Vec<Option<Vec<GenValue>>> = vec![None; s.len()];
        let reference: Vec<Vec<String>> = {
            let mut rng = Rng(42);
            (0..total)
                .map(|i| literals(&gen_row(&s, &mut rng, i, 1, "default", &empty, total, 42)))
                .collect()
        };
        for writers in 2..=4u32 {
            for w in 0..writers {
                let mut rng = Rng(42);
                for i in 0..total {
                    let row = gen_row(&s, &mut rng, i, 1, "default", &empty, total, 42);
                    if i % writers as u64 != w as u64 { continue; }
                    assert_eq!(literals(&row), reference[i as usize],
                        "writers={writers} writer={w} row {i}");
                }
            }
        }
    }

    /// End to end through the REAL partitioned generator (the mpsc chunk
    /// stream), not a re-simulation: reassembled by index math, the writers'
    /// output is the single-writer stream, and the chunk sizes still respect
    /// CHUNK_ROWS.
    #[tokio::test]
    async fn partitioned_generator_stream_matches_the_single_writer_stream() {
        let total = 25_000u64; // spans multiple chunks per writer
        let s = specs();
        let empty: Vec<Option<Vec<GenValue>>> = vec![None; s.len()];
        let mut reference: Vec<Vec<String>> = Vec::new();
        let mut rx = spawn_generator(s.clone(), total, 42, 1, "default".into(), empty.clone());
        while let Some(chunk) = rx.recv().await {
            assert!(chunk.len() <= CHUNK_ROWS);
            reference.extend(chunk.iter().map(|r| literals(r)));
        }
        assert_eq!(reference.len() as u64, total);

        let writers = 3u32;
        let mut merged: Vec<Option<Vec<String>>> = vec![None; total as usize];
        for w in 0..writers {
            let mut rx = spawn_generator_partition(
                s.clone(), total, 42, 1, "default".into(), empty.clone(), w, writers);
            let mut owned = 0u64;
            while let Some(chunk) = rx.recv().await {
                assert!(chunk.len() <= CHUNK_ROWS);
                for row in chunk {
                    // Writer w's k-th owned row is global index w + k·writers.
                    merged[(w as u64 + owned * writers as u64) as usize] = Some(literals(&row));
                    owned += 1;
                }
            }
            assert_eq!(owned, partition_count(total, w, writers), "writer {w} row count");
        }
        for (i, row) in merged.into_iter().enumerate() {
            assert_eq!(row.expect("every row owned by exactly one writer"), reference[i], "row {i}");
        }
    }

    /// One registered cancel must reach every writer; firing twice is a no-op,
    /// not a panic (a cancel racing a writer error fires twice by design).
    #[test]
    fn cancel_fanout_reaches_every_writer_once() {
        let (fanout, mut receivers) = CancelFanout::with_receivers(3);
        fanout.fire();
        for rx in &mut receivers {
            assert!(rx.try_recv().is_ok());
        }
        fanout.fire();
    }

    /// The count path is u64 end to end: a 1e11-row spec partitions exactly,
    /// aggregates exactly, and the rate math saturates instead of overflowing —
    /// panic=abort makes an overflow a crash, not a wrong number.
    #[test]
    fn u64_scale_math_holds_for_a_1e11_row_spec() {
        let total = 100_000_000_000u64;
        let sum: u64 = (0..MAX_WRITERS).map(|w| partition_count(total, w, MAX_WRITERS)).sum();
        assert_eq!(sum, total);
        assert_eq!(partition_count(total, 0, MAX_WRITERS), 12_500_000_000);
        // Rate math: exact at real scale, saturating at the theoretical edge.
        assert_eq!(rate_per_sec(total, 1_000), total);
        assert_eq!(rate_per_sec(2_000, 1), 2_000_000);
        assert_eq!(rate_per_sec(0, 0), 0);
        assert_eq!(rate_per_sec(u64::MAX, 1), u64::MAX);
        // Aggregated progress across writers stays exact at 1e11 rows.
        let stats = WriterStats::new(MAX_WRITERS);
        for w in 0..MAX_WRITERS as usize {
            stats.set_done(w, partition_count(total, w as u32, MAX_WRITERS));
            stats.set_committed(w, partition_count(total, w as u32, MAX_WRITERS));
        }
        assert_eq!(stats.total_done(), total);
        let committed: u64 = stats.committed_snapshot().iter().sum();
        assert_eq!(committed, total);
    }
}
