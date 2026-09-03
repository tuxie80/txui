/**
 * The generator catalogue and its parameters (src/utils/datagen.ts).
 *
 * The point of this suite is that a generator's *parameters actually do
 * something*. A generator that silently ignores the range, the distribution or
 * the geographic centre still produces plausible-looking data — which is the
 * worst failure mode available here, because nothing about the output says it
 * is wrong. `dist` was exactly that: it sat in `GenParams` from the start and
 * no generator ever read it, so every "normal" column came out uniform.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATORS, GENERATOR_MAP, DEFAULT_PARAMS, makeRng, generateRows, suggestGenerator,
} from '../src/utils/datagen.ts';
import type { GenParams } from '../src/utils/datagen.ts';
import { dict, meta, MIXED_PACKS, resolveRowLocale } from '../src/data/dictionaries.ts';

const P = (over: Partial<GenParams> = {}): GenParams => ({ ...DEFAULT_PARAMS, ...over });

/** One generator's value for a seed, at a given row and locale. */
function gen1(id: string, seed: number, row: number, locale: string, p: GenParams = P()): string {
  const g = GENERATOR_MAP.get(id);
  assert.ok(g, `no generator ${id}`);
  const rng = makeRng(seed);
  return g.gen(rng, row, p, 1, locale) as string;
}

/** Run one generator `n` times with a fixed seed. */
function sample(id: string, p: GenParams, n = 400): unknown[] {
  const g = GENERATOR_MAP.get(id);
  assert.ok(g, `no generator ${id}`);
  const rng = makeRng(42);
  // `n` is passed as the run total too: a series' trend is defined across the
  // whole dataset, so sampling 100 rows of a 1000-row run is a different curve
  // from generating 100 rows.
  return Array.from({ length: n }, (_, i) => g.gen(rng, i, p, n));
}

// ── catalogue integrity ─────────────────────────────────────────────────────

test('every generator has a unique id, a label and a group', () => {
  const ids = new Set<string>();
  for (const g of GENERATORS) {
    assert.ok(g.id, 'a generator has no id');
    assert.ok(!ids.has(g.id), `duplicate generator id: ${g.id}`);
    ids.add(g.id);
    assert.ok(g.label.length > 2, `${g.id} has no usable label`);
    assert.ok(g.group.length > 0, `${g.id} has no group — the picker needs one`);
  }
});

test('every generator produces a non-undefined value for the default params', () => {
  // A generator that throws or returns undefined writes NULL into a NOT NULL
  // column and fails at insert time, thousands of rows in.
  for (const g of GENERATORS) {
    const rng = makeRng(7);
    for (let i = 0; i < 5; i++) {
      const v = g.gen(rng, i, DEFAULT_PARAMS, 5);
      assert.notEqual(v, undefined, `${g.id} returned undefined`);
    }
  }
});

test('every generator that declares a param group is in the picker groups', () => {
  const known = new Set(['range', 'dates', 'list', 'decimals', 'step', 'affix', 'geo', 'series', 'ride',
    'validity', 'cardBrand', 'ibanCountry']);
  for (const g of GENERATORS) {
    for (const u of g.uses) {
      assert.ok(known.has(u), `${g.id} declares unknown param group ${u}`);
    }
  }
});

test('every generator suggestGenerator can return actually exists', () => {
  // The suggester names ids as strings; one rename away from pointing at
  // nothing, which would silently produce a column of NULLs.
  const names = ['id', 'email', 'first_name', 'last_name', 'username', 'name', 'city',
    'country', 'company', 'phone', 'uuid', 'ip', 'price', 'status', 'created_at',
    'birth_date', 'payload', 'notes', 'qty'];
  const types = ['INT', 'BIGINT', 'VARCHAR(64)', 'TEXT', 'DECIMAL(10,2)', 'TIMESTAMP',
    'DATE', 'JSON', 'BOOLEAN', 'DOUBLE'];
  for (const n of names) {
    for (const t of types) {
      for (const pk of [true, false]) {
        const id = suggestGenerator(n, t, pk);
        assert.ok(GENERATOR_MAP.has(id), `suggestGenerator(${n}, ${t}) → unknown id ${id}`);
      }
    }
  }
});

// ── shared dictionary layer ─────────────────────────────────────────────────

test('the shared JSON dictionaries load with the expected lengths', () => {
  // These lengths must match the Rust engine's assertion (datagen.rs tests):
  // the two tiers read the same JSON, so a length drift means they diverged.
  const expected: [Parameters<typeof dict>[0], number][] = [
    ['firstNames', 160], ['lastNames', 160], ['cities', 120], ['countries', 60],
    ['companies', 60], ['domains', 12], ['streets', 60], ['streetKinds', 10],
    ['productAdjectives', 40], ['productNouns', 60], ['lorem', 63],
  ];
  for (const [name, len] of expected) {
    assert.equal(dict(name).length, len, `dictionary ${name}`);
  }
  assert.equal(dict('firstNames')[0], 'James');
  // An UNKNOWN locale falls back to `default` — the accessor seam.
  assert.equal(dict('firstNames', 'nope-XX').length, 160);
  // A list a real locale doesn't override also falls back to `default`.
  assert.equal(dict('lorem', 'cs-CZ'), dict('lorem'));
  assert.equal(dict('countries', 'ja-JP'), dict('countries'));
});

// ── Phase 2: localized corpora ──────────────────────────────────────────────

test('each locale pack has non-empty, correctly-sized lists', () => {
  // Lengths pinned so a Rust/JS drift or an accidental truncation is caught.
  // Must match the Rust assertion (datagen.rs) — both engines read this JSON.
  const expected: Record<string, Partial<Record<Parameters<typeof dict>[0], number>>> = {
    'cs-CZ': { firstNames: 100, lastNames: 100, cities: 60, companies: 60, streets: 60, streetKinds: 8 },
    'en-GB': { firstNames: 100, lastNames: 100, cities: 60, companies: 60, streets: 60, streetKinds: 14 },
    'ja-JP': { firstNames: 80, lastNames: 100, cities: 60, companies: 60, streets: 60, streetKinds: 8 },
  };
  for (const [loc, lists] of Object.entries(expected)) {
    for (const [name, len] of Object.entries(lists)) {
      const arr = dict(name as Parameters<typeof dict>[0], loc);
      assert.equal(arr.length, len, `${loc}/${name} length`);
      assert.ok(arr.every(s => s.length > 0), `${loc}/${name} has an empty entry`);
      assert.equal(new Set(arr).size, arr.length, `${loc}/${name} has duplicates`);
    }
  }
});

test('locale corpora are authentic and survive a unicode round-trip', () => {
  // Czech keeps its diacritics through JSON parse → JS string.
  assert.ok(dict('lastNames', 'cs-CZ').includes('Nováková'), 'cs-CZ diacritics lost');
  assert.ok(dict('lastNames', 'cs-CZ').includes('Dvořák'));
  assert.ok(dict('cities', 'cs-CZ').includes('Plzeň'));
  assert.ok(dict('cities', 'cs-CZ').includes('Praha'));
  // Japanese survives as kanji, not mojibake or transliteration.
  assert.ok(dict('lastNames', 'ja-JP').includes('佐藤'));
  assert.ok(dict('lastNames', 'ja-JP').includes('鈴木'));
  assert.ok(dict('cities', 'ja-JP').includes('東京'));
  assert.ok(dict('cities', 'ja-JP').includes('大阪'));
  // British lists are British, not the default mix.
  assert.ok(dict('lastNames', 'en-GB').includes('Smith'));
  assert.ok(dict('cities', 'en-GB').includes('Manchester'));
  // The three packs are genuinely distinct from each other.
  assert.notDeepEqual(dict('cities', 'cs-CZ'), dict('cities', 'ja-JP'));
});

// ── ranges ──────────────────────────────────────────────────────────────────

test('integer and decimal stay inside their range', () => {
  for (const v of sample('int', P({ min: 10, max: 20 }))) {
    assert.ok(typeof v === 'number' && v >= 10 && v <= 20, `out of range: ${v}`);
  }
  for (const v of sample('decimal', P({ min: -5, max: 5, decimals: 3 }))) {
    assert.ok(typeof v === 'number' && v >= -5 && v <= 5, `out of range: ${v}`);
  }
});

test('decimals actually limits the decimal places', () => {
  for (const v of sample('decimal', P({ min: 0, max: 1, decimals: 2 }))) {
    const places = String(v).split('.')[1]?.length ?? 0;
    assert.ok(places <= 2, `${v} has more than 2 decimal places`);
  }
});

test('money is always 2 decimal places regardless of the decimals param', () => {
  for (const v of sample('money', P({ min: 0, max: 100, decimals: 7 }))) {
    const places = String(v).split('.')[1]?.length ?? 0;
    assert.ok(places <= 2, `${v} is not money-shaped`);
  }
});

// ── distributions ───────────────────────────────────────────────────────────

test('normal clusters in the middle and uniform does not', () => {
  // The regression this pins: `dist` being ignored, which made these identical.
  const mid = (vs: unknown[]) =>
    (vs as number[]).filter(v => v >= 40 && v <= 60).length / vs.length;

  const uniform = mid(sample('int', P({ min: 0, max: 100, dist: 'uniform' }), 3000));
  const normal = mid(sample('int', P({ min: 0, max: 100, dist: 'normal' }), 3000));

  assert.ok(normal > uniform * 1.5,
    `normal should concentrate near the middle (normal ${normal.toFixed(3)} vs uniform ${uniform.toFixed(3)})`);
});

test('zipf concentrates at the low end', () => {
  const low = (vs: unknown[]) => (vs as number[]).filter(v => v <= 25).length / vs.length;
  const uniform = low(sample('int', P({ min: 0, max: 100, dist: 'uniform' }), 3000));
  const zipf = low(sample('int', P({ min: 0, max: 100, dist: 'zipf' }), 3000));
  assert.ok(zipf > uniform * 1.5,
    `zipf should have a heavy head (zipf ${zipf.toFixed(3)} vs uniform ${uniform.toFixed(3)})`);
});

// ── stepping ────────────────────────────────────────────────────────────────

test('a stepped timestamp is evenly spaced', () => {
  const vs = sample('timestampStep',
    P({ dateFrom: '2026-01-01', step: 1, stepUnit: 'hour', jitterPct: 0 }), 10) as string[];
  const ts = vs.map(v => new Date(v.replace(' ', 'T') + 'Z').getTime());
  for (let i = 1; i < ts.length; i++) {
    assert.equal(ts[i] - ts[i - 1], 3_600_000, `gap ${i} is not one hour`);
  }
});

test('step size and unit are both honoured', () => {
  const vs = sample('dateStep',
    P({ dateFrom: '2026-01-01', step: 7, stepUnit: 'day', jitterPct: 0 }), 4) as string[];
  assert.deepEqual(vs, ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22']);
});

test('jitter perturbs the steps without reordering them', () => {
  const vs = sample('timestampStep',
    P({ dateFrom: '2026-01-01', step: 1, stepUnit: 'hour', jitterPct: 20 }), 50) as string[];
  const ts = vs.map(v => new Date(v.replace(' ', 'T') + 'Z').getTime());
  // ±20% of an hour cannot overtake the next step, so the series stays sorted.
  for (let i = 1; i < ts.length; i++) {
    assert.ok(ts[i] > ts[i - 1], `jitter reordered the series at ${i}`);
  }
  assert.ok(new Set(ts.map((t, i) => t - i * 3_600_000)).size > 5, 'jitter had no effect');
});

test('a sequence steps by the configured amount', () => {
  assert.deepEqual(sample('sequence', P({ step: 5 }), 4), [1, 6, 11, 16]);
});

// ── geography ───────────────────────────────────────────────────────────────

test('generated points land within the requested radius of the centre', () => {
  const p = P({ lat: 50.08, lon: 14.44, radiusKm: 25 });
  const lats = sample('latitude', p, 500) as number[];
  for (const lat of lats) {
    // 25 km is about 0.225° of latitude; allow a hair for rounding.
    assert.ok(Math.abs(lat - 50.08) <= 0.24, `${lat} is outside the radius`);
  }
});

test('coordinates are not uniform over the whole globe', () => {
  // The failure this prevents: a latitude drawn from −90…90, which looks like
  // data until it is plotted and every point is in an ocean.
  const lats = sample('latitude', P({ lat: 50.08, lon: 14.44, radiusKm: 25 }), 300) as number[];
  assert.ok(Math.max(...lats) - Math.min(...lats) < 1, 'points are scattered far too widely');
});

test('WKT is longitude-first and GeoJSON agrees with it', () => {
  // Getting this backwards puts Prague in Somalia without anything erroring.
  const p = P({ lat: 50.08, lon: 14.44, radiusKm: 5 });
  const wkt = sample('wktPoint', p, 1)[0] as string;
  const m = /^POINT\((-?[\d.]+) (-?[\d.]+)\)$/.exec(wkt);
  assert.ok(m, `unexpected WKT: ${wkt}`);
  assert.ok(Math.abs(Number(m[1]) - 14.44) < 0.2, 'first WKT ordinate should be longitude');
  assert.ok(Math.abs(Number(m[2]) - 50.08) < 0.2, 'second WKT ordinate should be latitude');

  const geo = JSON.parse(sample('geoJsonPoint', p, 1)[0] as string);
  assert.equal(geo.type, 'Point');
  assert.ok(Math.abs(geo.coordinates[0] - 14.44) < 0.2, 'GeoJSON is [lon, lat]');
  assert.ok(Math.abs(geo.coordinates[1] - 50.08) < 0.2, 'GeoJSON is [lon, lat]');
});

// ── series ──────────────────────────────────────────────────────────────────

test('a series with a trend actually trends', () => {
  const vs = sample('series',
    P({ min: 100, max: 100, trendPct: 100, seasonAmpPct: 0, noisePct: 0 }), 100) as number[];
  assert.ok(vs[99] > vs[0] * 1.5, `no trend: ${vs[0]} → ${vs[99]}`);
});

test('a series with a season oscillates', () => {
  const vs = sample('series',
    P({ min: 100, max: 100, trendPct: 0, seasonAmpPct: 50, seasonPeriod: 10, noisePct: 0 }), 40) as number[];
  const base = 100;
  assert.ok(vs.some(v => v > base * 1.2), 'season never peaks');
  assert.ok(vs.some(v => v < base * 0.8), 'season never troughs');
});

test('a flat series is flat — no shaping means no shape', () => {
  const vs = sample('series',
    P({ min: 50, max: 50, trendPct: 0, seasonAmpPct: 0, noisePct: 0 }), 20) as number[];
  assert.deepEqual(new Set(vs), new Set([50]));
});

// ── check digits ────────────────────────────────────────────────────────────

function luhnValid(num: string): boolean {
  let sum = 0, double = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d; double = !double;
  }
  return sum % 10 === 0;
}

test('generated card numbers pass the Luhn check', () => {
  // A card column that fails validation is useless for testing the validation.
  for (const v of sample('creditCard', P(), 200)) {
    assert.ok(luhnValid(v as string), `${v} fails Luhn`);
  }
});

test('generated EAN-13 and ISBN-13 have correct check digits', () => {
  const check = (code: string) => {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += (code.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10 === code.charCodeAt(12) - 48;
  };
  for (const v of sample('ean13', P(), 100)) {
    assert.equal((v as string).length, 13);
    assert.ok(check(v as string), `${v} has a bad check digit`);
  }
  for (const v of sample('isbn13', P(), 100)) {
    assert.ok((v as string).startsWith('978'), `${v} is not an ISBN prefix`);
    assert.ok(check(v as string), `${v} has a bad check digit`);
  }
});

test('MAC addresses are six two-character groups', () => {
  for (const v of sample('macAddress', P(), 100)) {
    assert.match(v as string, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/, `bad MAC: ${v}`);
  }
});

// ── IBAN (MOD-97-10) ─────────────────────────────────────────────────────────
// The old generator appended two RANDOM check digits, so nothing it produced
// ever validated. These pin the fix: the check is computed, and the IBANs pass.

/** ISO 13616: move the first four chars to the end, letters→digits, mod 97 == 1. */
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

test('generated IBANs pass the MOD-97-10 check', () => {
  // The known ISO reference IBAN validates, proving the validator itself.
  assert.ok(ibanValid('GB82WEST12345698765432'), 'reference IBAN should validate');
  assert.ok(!ibanValid('CZ00000000000000000000'), 'a bogus IBAN must not validate');
  for (const v of sample('iban', P(), 300) as string[]) {
    assert.match(v, /^CZ\d{22}$/, `not a CZ IBAN: ${v}`);
    assert.ok(ibanValid(v), `${v} fails MOD-97`);
  }
});

// ── reverse-regex expansion ──────────────────────────────────────────────────
// `regex` used to return the pattern verbatim in JS while the Rust volume tier
// expanded it — so one column read `[A-Z]{2}-\d{4}` below 200k rows and a real
// value above. These pin the ported expander to the documented expansion.

test('the regex generator expands, it no longer returns the pattern verbatim', () => {
  for (const v of sample('regex', P({ list: '[A-Z]{2}-\\d{4}' }), 100) as string[]) {
    assert.notEqual(v, '[A-Z]{2}-\\d{4}', 'pattern returned verbatim — not expanded');
    assert.match(v, /^[A-Z]{2}-\d{4}$/, `bad expansion: ${v}`);
  }
});

test('regex classes, ranges, repeats and alternation all expand', () => {
  for (const v of sample('regex', P({ list: '\\w{5}' }), 60) as string[]) {
    assert.match(v, /^[a-z0-9]{5}$/, `\\w{5} → ${v}`);
  }
  for (const v of sample('regex', P({ list: '[abc]{3}' }), 60) as string[]) {
    assert.match(v, /^[abc]{3}$/, `[abc]{3} → ${v}`);
  }
  for (const v of sample('regex', P({ list: '(cat|dog|fish)' }), 60) as string[]) {
    assert.ok(['cat', 'dog', 'fish'].includes(v), `alternation → ${v}`);
  }
  // A {m,n} repeat stays within its bounds.
  for (const v of sample('regex', P({ list: '\\d{2,4}' }), 100) as string[]) {
    assert.match(v, /^\d{2,4}$/, `\\d{2,4} → ${v}`);
  }
  // A literal with no metacharacters comes back unchanged.
  assert.equal((sample('regex', P({ list: 'ORDER-42' }), 1) as string[])[0], 'ORDER-42');
});

// ── weighted choice ─────────────────────────────────────────────────────────

test('weights in a choice list are respected', () => {
  const vs = sample('choice', P({ list: 'active:95,disabled:5' }), 2000) as string[];
  const active = vs.filter(v => v === 'active').length / vs.length;
  assert.ok(active > 0.85 && active < 0.99, `weighting is off: ${active.toFixed(3)} active`);
  assert.ok(vs.includes('disabled'), 'the rare value never appeared');
});

test('an unweighted list still works', () => {
  const vs = new Set(sample('choice', P({ list: 'a,b,c' }), 300) as string[]);
  assert.deepEqual(vs, new Set(['a', 'b', 'c']));
});

// ── whole-row generation ────────────────────────────────────────────────────

test('the same seed produces the same rows', () => {
  const specs = [
    { name: 'id', typeName: 'INT', generator: 'sequence', params: P() },
    { name: 'lat', typeName: 'DOUBLE', generator: 'latitude', params: P() },
    { name: 'v', typeName: 'DECIMAL', generator: 'series', params: P() },
  ];
  assert.deepEqual(generateRows(specs, 20, 99), generateRows(specs, 20, 99));
});

// ── Phase 2: locale threading through whole-row generation ───────────────────

const LOCALE_SPECS = [
  { name: 'name', typeName: 'TEXT', generator: 'fullName', params: P() },
  { name: 'city', typeName: 'TEXT', generator: 'city', params: P() },
  { name: 'co', typeName: 'TEXT', generator: 'company', params: P() },
];

test('default locale output is byte-identical to Phase 1 (pinned seed)', () => {
  // The whole point of the locale param: unset/`default` must not move a single
  // byte, or the seeded parity with the Rust engine (and every saved run) breaks.
  const pinned = [
    ['Isaac Collins', 'Lublin', 'Ironwood'],
    ['Sofia Cook', 'Warsaw', 'VanArsdel'],
    ['Sofie Foster', 'Linz', 'Zenith'],
  ];
  assert.deepEqual(generateRows(LOCALE_SPECS, 3, 12345), pinned);
  // Omitting the arg and passing 'default' explicitly are the same run.
  assert.deepEqual(
    generateRows(LOCALE_SPECS, 25, 777),
    generateRows(LOCALE_SPECS, 25, 777, 'default'),
  );
});

test('a locale-selected generator draws from that locale, not default', () => {
  const cz = generateRows(LOCALE_SPECS, 40, 12345, 'cs-CZ');
  const czCities = new Set(dict('cities', 'cs-CZ'));
  const czCompanies = new Set(dict('companies', 'cs-CZ'));
  for (const [, city, co] of cz as string[][]) {
    assert.ok(czCities.has(city), `${city} is not a cs-CZ city`);
    assert.ok(czCompanies.has(co), `${co} is not a cs-CZ company`);
  }
  // Same seed, different locale → different data (locale actually took effect).
  assert.notDeepEqual(generateRows(LOCALE_SPECS, 10, 12345, 'cs-CZ'),
    generateRows(LOCALE_SPECS, 10, 12345));
  // The draw ORDER is unchanged: switching locale must not add or drop RNG
  // draws, so a non-dictionary column is identical across locales.
  const seqSpec = [{ name: 'id', typeName: 'INT', generator: 'sequence', params: P() },
    { name: 'n', typeName: 'INT', generator: 'int', params: P() }];
  assert.deepEqual(generateRows(seqSpec, 30, 55, 'ja-JP'), generateRows(seqSpec, 30, 55));
});

test('generated Japanese/Czech rows survive a JSON round-trip as unicode', () => {
  const ja = generateRows(LOCALE_SPECS, 2, 12345, 'ja-JP') as string[][];
  const roundTripped = JSON.parse(JSON.stringify(ja));
  assert.deepEqual(roundTripped, ja);
  // Kanji, not ASCII fallback.
  assert.ok(ja.flat().some(s => /[一-鿿]/.test(s)), 'no kanji in ja-JP output');
  const cz = generateRows(LOCALE_SPECS, 20, 12345, 'cs-CZ') as string[][];
  assert.ok(cz.flat().some(s => /[ěščřžýáíéúůňďťóĚŠČŘŽ]/.test(s)), 'no Czech diacritics');
});

test('nullPct produces nulls, and 0 produces none', () => {
  const spec = (nullPct: number) =>
    [{ name: 'v', typeName: 'INT', generator: 'int', params: P({ nullPct }) }];
  const none = generateRows(spec(0), 200, 1).flat();
  assert.ok(!none.includes(null), 'nullPct 0 still produced nulls');

  const some = generateRows(spec(50), 400, 1).flat();
  const ratio = some.filter(v => v === null).length / some.length;
  assert.ok(ratio > 0.35 && ratio < 0.65, `nullPct 50 gave ${(ratio * 100).toFixed(0)}%`);
});

// ── Wave C Phase 4 — per-country generators + row-level coherence ────────────

test('per-locale phone honours the pack dialling format', () => {
  // default reproduces the Phase-1 shape exactly; the packs take their own.
  assert.match(gen1('phone', 7, 0, 'default'), /^\+420 \d{3} \d{3} \d{3}$/);
  assert.match(gen1('phone', 7, 0, 'cs-CZ'), /^\+420 \d{3} \d{3} \d{3}$/);
  assert.match(gen1('phone', 7, 0, 'en-GB'), /^\+44 \d{4} \d{6}$/);
  assert.match(gen1('phone', 7, 0, 'ja-JP'), /^\+81 \d-\d{4}-\d{4}$/);
});

test('per-locale postcode honours the pack format', () => {
  assert.match(gen1('postcode', 7, 0, 'default'), /^\d{3} \d{2}$/);
  assert.match(gen1('postcode', 7, 0, 'cs-CZ'), /^\d{3} \d{2}$/);
  assert.match(gen1('postcode', 7, 0, 'en-GB'), /^[A-Z]{2}\d[A-Z] \d[A-Z]{2}$/);
  assert.match(gen1('postcode', 7, 0, 'ja-JP'), /^\d{3}-\d{4}$/);
});

test('country/countryCode under a fixed pack emit THAT country, default stays random', () => {
  for (let s = 1; s < 40; s++) {
    assert.equal(gen1('country', s, 0, 'cs-CZ'), 'Czechia');
    assert.equal(gen1('countryCode', s, 0, 'cs-CZ'), 'CZ');
    assert.equal(gen1('country', s, 0, 'en-GB'), 'United Kingdom');
    assert.equal(gen1('countryCode', s, 0, 'en-GB'), 'GB');
    assert.equal(gen1('country', s, 0, 'ja-JP'), 'Japan');
    assert.equal(gen1('countryCode', s, 0, 'ja-JP'), 'JP');
  }
  // default is a random draw over the corpus — not pinned to one value.
  const countries = new Set(Array.from({ length: 60 }, (_, s) => gen1('country', s + 1, 0, 'default')));
  assert.ok(countries.size > 5, 'default country should vary across seeds');
});

test('country/countryCode override adds or drops no RNG draw', () => {
  // country/countryCode always draw exactly one pick and override only the
  // returned string, so a trailing non-locale column is byte-identical across
  // EVERY pack — the override never perturbs the stream (this is what lets a
  // mixed-mode row swap the pack per row without shifting anything).
  const specs = (id: string) => [
    { name: 'a', typeName: 'TEXT', generator: id, params: P() },
    { name: 'k', typeName: 'INT', generator: 'int', params: P() },
  ];
  for (const id of ['country', 'countryCode']) {
    for (const loc of ['cs-CZ', 'en-GB', 'ja-JP']) {
      const a = generateRows(specs(id), 20, 321, loc).map(r => r[1]);
      const b = generateRows(specs(id), 20, 321, 'default').map(r => r[1]);
      assert.deepEqual(a, b, `${id}/${loc} moved the RNG stream`);
    }
  }
  // cs-CZ shares default's phone/postcode FORMAT, so it also draws the identical
  // stream (a different format legitimately draws a different count — that is
  // the point of GB/JP formats, not a determinism break).
  for (const id of ['phone', 'postcode']) {
    const a = generateRows(specs(id), 20, 321, 'cs-CZ').map(r => r[1]);
    const b = generateRows(specs(id), 20, 321, 'default').map(r => r[1]);
    assert.deepEqual(a, b, `${id}/cs-CZ moved the RNG stream`);
  }
});

test('address composes street+city+postcode+country in the pack order', () => {
  const ja = gen1('address', 42, 0, 'ja-JP');
  // Japanese address runs large→small: it opens with the country.
  assert.ok(ja.startsWith('Japan'), `ja address not reversed: ${ja}`);
  assert.ok(/[一-鿿]/.test(ja), `ja address has no kanji: ${ja}`);
  const gb = gen1('address', 42, 0, 'en-GB');
  assert.ok(gb.endsWith('United Kingdom'), `gb address does not end in country: ${gb}`);
  // Number-first, British convention.
  assert.match(gb, /^\d+ /, `gb address is not number-first: ${gb}`);
  const cz = gen1('address', 42, 0, 'cs-CZ');
  assert.ok(cz.endsWith('Czechia'), cz);
});

test('the cross-tier seed-42 anchors (row 0) — mirrored in the Rust suite', () => {
  // These exact strings are pinned identically in datagen.rs so a drift in
  // either engine's draw order fails on one side.
  assert.equal(gen1('phone', 42, 0, 'en-GB'), '+44 6409 503461');
  assert.equal(gen1('phone', 42, 0, 'ja-JP'), '+81 6-5034-8672');
  assert.equal(gen1('postcode', 42, 0, 'en-GB'), 'PL8R 1NH');
  assert.equal(gen1('postcode', 42, 0, 'ja-JP'), '648-6152');
  assert.equal(gen1('address', 42, 0, 'cs-CZ'), 'Ječná náves 145, 257 57 Litvínov, Czechia');
  assert.equal(gen1('address', 42, 0, 'ja-JP'), 'Japan 〒152-6842 柏高円寺本町145');
  assert.equal(gen1('phone', 42, 0, 'default'), '+420 720 503 867');
  assert.equal(gen1('postcode', 42, 0, 'default'), '640 50');
});

test('mixed mode: the per-row locale is a pure hash of rowIdx, not an RNG draw', () => {
  // resolveRowLocale never touches the RNG, so it is stable regardless of run.
  const first = Array.from({ length: 16 }, (_, i) => resolveRowLocale('mixed', i));
  const again = Array.from({ length: 16 }, (_, i) => resolveRowLocale('mixed', i));
  assert.deepEqual(first, again);
  for (const l of first) assert.ok(MIXED_PACKS.includes(l as (typeof MIXED_PACKS)[number]), l);
  // A fixed locale resolves to itself (identity — no perturbation).
  assert.equal(resolveRowLocale('cs-CZ', 5), 'cs-CZ');
  assert.equal(resolveRowLocale('default', 5), 'default');
});

test('mixed mode: every row is internally coherent (country ↔ phone ↔ city agree)', () => {
  const specs = [
    { name: 'country', typeName: 'TEXT', generator: 'country', params: P() },
    { name: 'phone', typeName: 'TEXT', generator: 'phone', params: P() },
    { name: 'city', typeName: 'TEXT', generator: 'city', params: P() },
    { name: 'cc', typeName: 'TEXT', generator: 'countryCode', params: P() },
  ];
  const rows = generateRows(specs, 300, 42, 'mixed') as string[][];
  const cityPacks = new Map(MIXED_PACKS.map(l => [l, new Set(dict('cities', l))]));
  rows.forEach(([country, phone, city, cc], i) => {
    const pack = resolveRowLocale('mixed', i);
    const m = meta(pack);
    assert.equal(country, m.countryName, `row ${i} country ≠ pack`);
    assert.equal(cc, m.countryCode, `row ${i} code ≠ pack`);
    assert.ok(phone.startsWith(m.phonePrefix), `row ${i} phone ${phone} ≠ ${m.phonePrefix}`);
    assert.ok(cityPacks.get(pack)!.has(city), `row ${i} city ${city} not in ${pack}`);
  });
  // The mode actually mixes — more than one pack appears across the rows.
  const seen = new Set(rows.map((_, i) => resolveRowLocale('mixed', i)));
  assert.ok(seen.size >= 2, 'mixed produced only one pack');
});

test('suggestGenerator maps phone/postcode/address/country columns', () => {
  assert.equal(suggestGenerator('mobile_phone', 'VARCHAR', false), 'phone');
  assert.equal(suggestGenerator('zip', 'VARCHAR', false), 'postcode');
  assert.equal(suggestGenerator('postal_code', 'VARCHAR', false), 'postcode');
  assert.equal(suggestGenerator('home_address', 'TEXT', false), 'address');
  assert.equal(suggestGenerator('country', 'VARCHAR', false), 'country');
  assert.equal(suggestGenerator('country_code', 'CHAR', false), 'countryCode');
  assert.equal(suggestGenerator('iso', 'CHAR', false), 'countryCode');
});
