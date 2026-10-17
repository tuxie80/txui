/**
 * Correlated personas (plan-datagen-nextgen Phase 4): the one row-level locale
 * pick — fixed or `mixed`-resolved — now drives not just names/phones/
 * postcodes but the street/address shape, the coordinate bounding box, the
 * currency and the timezone. A row that drew a Czech name gets CZK,
 * Europe/Prague and a point inside Czechia.
 *
 * Byte-identity rules pinned here:
 *   - under `default` every touched generator behaves EXACTLY as before
 *     (the override draws first, then discards — the country/countryCode
 *     pattern), so the seeded stream never moves;
 *   - the same literals are pinned in datagen.rs's test module
 *     (`persona_*` tests) — if either tier drifts, one side fails;
 *   - CURRENCIES/TIMEZONES are duplicated as Rust consts in datagen.rs; the
 *     drift guard below compares them (the datagenParity pattern).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PARAMS, generateRows, CURRENCIES, TIMEZONES,
} from '../src/utils/datagen.ts';
import type { ColumnSpec } from '../src/utils/datagen.ts';
import { meta, resolveRowLocale, MIXED_PACKS } from '../src/data/dictionaries.ts';
import { buildServerPlan, valueSql } from '../src/utils/datagenSql.ts';

const P = (over: Partial<ColumnSpec['params']> = {}) => ({ ...DEFAULT_PARAMS, ...over });
const col = (name: string, typeName: string, generator: string, params = P()): ColumnSpec =>
  ({ name, typeName, generator, params });

const personaCols = () => [
  col('cur', 'TEXT', 'currencyCode'),
  col('tz', 'TEXT', 'timezone'),
  col('lat', 'DOUBLE', 'latitude'),
  col('lon', 'DOUBLE', 'longitude'),
  col('ll', 'TEXT', 'latlon'),
  col('st', 'TEXT', 'street'),
];

// ── the data block ────────────────────────────────────────────────────────────

test('every locale meta carries the persona block', () => {
  for (const loc of ['default', 'cs-CZ', 'en-GB', 'ja-JP']) {
    const m = meta(loc);
    assert.match(m.currency, /^[A-Z]{3}$/, `${loc} currency`);
    assert.ok(m.timezone.includes('/'), `${loc} timezone`);
    assert.ok(m.latMin < m.latMax && m.lonMin < m.lonMax, `${loc} bounding box`);
    assert.ok(m.latMin >= -90 && m.latMax <= 90, `${loc} lat range sane`);
    assert.ok(m.lonMin >= -180 && m.lonMax <= 180, `${loc} lon range sane`);
  }
  assert.equal(meta('cs-CZ').currency, 'CZK');
  assert.equal(meta('en-GB').currency, 'GBP');
  assert.equal(meta('ja-JP').currency, 'JPY');
  assert.equal(meta('en-GB').timezone, 'Europe/London');
});

// ── coherence under a fixed pack ──────────────────────────────────────────────

test('fixed locale pins currency, timezone and coordinates — pinned in datagen.rs', () => {
  const rows = generateRows(personaCols(), 3, 42, 'cs-CZ');
  assert.deepEqual(rows, [
    ['CZK', 'Europe/Prague', 50.689689, 15.655032, '49.235802,16.319521', 'Karmelitská náměstí 208'],
    ['CZK', 'Europe/Prague', 49.320574, 16.738363, '50.082658,12.116017', 'Růžová ulice 113'],
    ['CZK', 'Europe/Prague', 49.22006, 17.394615, '49.881142,12.273627', 'Růžová nábřeží 42'],
  ]);
  assert.deepEqual(generateRows(personaCols(), 2, 42, 'en-GB'), [
    ['GBP', 'Europe/London', 57.401699, -2.934075, '52.304406,-1.952553', 'Oxford Avenue 208'],
    ['GBP', 'Europe/London', 52.601613, -1.33388, '55.273464,-8.16157', 'Churchill Street 113'],
  ]);
  assert.deepEqual(generateRows(personaCols(), 2, 42, 'ja-JP'), [
    ['JPY', 'Asia/Tokyo', 43.298466, 137.952073, '34.262357,139.620659', '荻窪 通り 208'],
    ['JPY', 'Asia/Tokyo', 34.789224, 140.672404, '39.525686,129.06533', '御徒町 丁目 113'],
  ]);
});

test('persona coordinates stay inside the pack bounding box (all packs, 200 rows)', () => {
  const cols = [
    col('lat', 'DOUBLE', 'latitude'), col('lon', 'DOUBLE', 'longitude'),
    col('wkt', 'TEXT', 'wktPoint'), col('gj', 'TEXT', 'geoJsonPoint'),
  ];
  for (const loc of ['cs-CZ', 'en-GB', 'ja-JP']) {
    const m = meta(loc);
    for (const [lat, lon, wkt, gj] of generateRows(cols, 200, 7, loc) as [number, number, string, string][]) {
      assert.ok(lat >= m.latMin - 1e-9 && lat <= m.latMax + 1e-9, `${loc} lat ${lat}`);
      assert.ok(lon >= m.lonMin - 1e-9 && lon <= m.lonMax + 1e-9, `${loc} lon ${lon}`);
      const wm = /^POINT\((-?[\d.]+) (-?[\d.]+)\)$/.exec(wkt);
      assert.ok(wm, wkt);
      assert.ok(Number(wm![2]) >= m.latMin - 1e-9 && Number(wm![2]) <= m.latMax + 1e-9, `${loc} wkt lat`);
      const g = JSON.parse(gj);
      assert.ok(g.coordinates[1] >= m.latMin - 1e-9 && g.coordinates[1] <= m.latMax + 1e-9, `${loc} geojson`);
    }
  }
});

test('mixed mode: every row is wholly one persona (currency ↔ zone ↔ coords ↔ country)', () => {
  const specs = [
    col('country', 'TEXT', 'country'),
    col('cur', 'TEXT', 'currencyCode'),
    col('tz', 'TEXT', 'timezone'),
    col('lat', 'DOUBLE', 'latitude'),
    col('lon', 'DOUBLE', 'longitude'),
  ];
  const rows = generateRows(specs, 300, 42, 'mixed') as [string, string, string, number, number][];
  rows.forEach(([country, cur, tz, lat, lon], i) => {
    const pack = resolveRowLocale('mixed', i);
    const m = meta(pack);
    assert.equal(country, m.countryName, `row ${i} country`);
    assert.equal(cur, m.currency, `row ${i} currency`);
    assert.equal(tz, m.timezone, `row ${i} timezone`);
    assert.ok(lat >= m.latMin && lat <= m.latMax && lon >= m.lonMin && lon <= m.lonMax,
      `row ${i} coords outside ${pack}`);
  });
  const seen = new Set(rows.map((_, i) => resolveRowLocale('mixed', i)));
  assert.ok(seen.size >= 2, 'mixed produced only one pack');
  assert.deepEqual([...seen].sort(), [...MIXED_PACKS].filter(p => seen.has(p)).sort());
});

// ── byte-identity of the default run ──────────────────────────────────────────

test('default locale is byte-identical to the pre-persona behavior — pinned in datagen.rs', () => {
  // The override draws first and discards; `default` keeps the random pick.
  // These literals are the values the same specs produced before personas
  // existed (the geoPoint disc with the DEFAULT_PARAMS Prague centre).
  const rows = generateRows(personaCols(), 3, 42, 'default');
  assert.deepEqual(rows, [
    ['SEK', 'Europe/Warsaw', 49.979805, 14.415665, '49.99686,14.310856', 'South Road 208'],
    ['DKK', 'Asia/Tokyo', 50.120488, 14.211741, '50.255439,14.446603', 'Vodickova Street 113'],
    ['CHF', 'Europe/Prague', 50.187401, 14.292533, '50.241178,14.483224', 'Vodickova Boulevard 42'],
  ]);
  assert.ok(CURRENCIES.includes(rows[0][0] as string) && TIMEZONES.includes(rows[0][1] as string));
});

test('persona columns never move the seeded stream (trailing column identical)', () => {
  const specs = [
    col('c', 'TEXT', 'currencyCode'), col('z', 'TEXT', 'timezone'),
    col('la', 'DOUBLE', 'latitude'),
    col('k', 'INT', 'int', P({ min: 1, max: 1000 })),
  ];
  // The pinned literals are per-tier: the Rust `int` arm floors over
  // [min, max+1) where TS rounds over [min, max] — a pre-existing difference
  // outside the persona change (datagen.rs pins its own [831, 63, 645]). The
  // parity property here is locale-invariance WITHIN a tier.
  for (const loc of ['default', 'cs-CZ', 'en-GB', 'ja-JP', 'mixed']) {
    assert.deepEqual(generateRows(specs, 3, 321, loc).map(r => r[3]), [830, 64, 645], loc);
  }
});

test('street uses the pack street lists (aligned with the Rust arm) — pinned in datagen.rs', () => {
  // Was "<city> St <num>" on the TS side while the Rust writer drew
  // streets/streetKinds — one generator, two shapes, depending on tier.
  assert.deepEqual(generateRows([col('s', 'TEXT', 'street')], 3, 42).map(r => r[0]),
    ['Green Way 145', 'River Drive 161', 'Orchard Way 66']);
});

// ── TS ↔ Rust corpus drift guard (the datagenParity pattern) ─────────────────

const ROOT = new URL('..', import.meta.url).pathname;

function rustStrList(constName: string): string[] {
  const src = readFileSync(join(ROOT, 'src-tauri/src/commands/datagen.rs'), 'utf8');
  const m = src.match(new RegExp(String.raw`const ${constName}: &\[&str\] = &\[([\s\S]*?)\];`));
  assert.ok(m, `${constName} not found in datagen.rs`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map(x => x[1]);
}

test('CURRENCIES/TIMEZONES match the Rust consts (drift guard)', () => {
  assert.deepEqual(CURRENCIES, rustStrList('CURRENCIES'));
  assert.deepEqual(TIMEZONES, rustStrList('TIMEZONES'));
});

// ── the server path ───────────────────────────────────────────────────────────

test('server plan: persona columns under a fixed locale are constants / bbox expressions', () => {
  const specs = [
    col('cur', 'CHAR(3)', 'currencyCode'),
    col('tz', 'VARCHAR(40)', 'timezone'),
    col('lat', 'DOUBLE', 'latitude'),
  ];
  const plan = buildServerPlan('mysql', 't', specs, 300_000, undefined, 'cs-CZ', 1);
  assert.deepEqual(plan.unsupported, []);
  const stmt = plan.statementAt(0);
  assert.match(stmt, /'CZK'/);
  assert.match(stmt, /'Europe\/Prague'/);
  assert.match(stmt, /48\.55 \+ RAND\(\) \* 2\.51/);
});

test('server plan: persona columns under mixed fall back (per-row pack is not set-based)', () => {
  const specs = [col('cur', 'CHAR(3)', 'currencyCode')];
  const plan = buildServerPlan('postgres', 't', specs, 300_000, undefined, 'mixed', 1);
  assert.deepEqual(plan.unsupported, [{ column: 'cur', generator: 'currencyCode' }]);
  // …while under `default` currencyCode/timezone draw from the list.
  assert.ok(valueSql('mysql', 'currencyCode', col('c', 'TEXT', 'currencyCode')) !== null);
  assert.ok(valueSql('mysql', 'timezone', col('t', 'TEXT', 'timezone')) !== null);
  assert.ok(valueSql('mysql', 'latitude', col('l', 'DOUBLE', 'latitude')) !== null);
});
