/**
 * Data generation engine for the generator wizard.
 * Seeded RNG → reproducible datasets; generators auto-suggested from
 * column name + type; SQL literals emitted per engine.
 */

import { quoteIdent, sqlLiteral as lit } from './sqlIdent.ts';
import { ridePing } from './rideTracks.ts';
import { dict, meta, DEFAULT_LOCALE, resolveRowLocale } from '../data/dictionaries.ts';
import {
  gs1, luhnAppend, iban as ibanValue,
  rodneCislo, rodneCisloCheck,
  NINO_FIRST, NINO_SECOND, NINO_SUFFIX, ninoPrefixOk,
  myNumber, czVat, gbVat, jpCorporateNumber,
} from './datagenStandards.ts';

// ── Seeded RNG (mulberry32) ───────────────────────────────────────────────────

export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const pick = <T,>(rng: Rng, arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const int = (rng: Rng, min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min;

// ── Word lists ────────────────────────────────────────────────────────────────
// Pulled from the shared JSON dictionary layer (src/data/dictionaries.json),
// the ONE source of truth the Rust engine (>200k rows) and the SQL emitter read
// too — so a seed produces identical rows on either side of the size tier.
//
// Phase 2: the name/place/company generators resolve their list per row through
// `dict(name, locale)`, where `locale` is the fifth argument threaded into every
// `gen`. Passing `default` (the arg's own fallback when it is `undefined`)
// returns the exact same array the old module-level constants held, so a
// default-locale run draws byte-identically to Phase 1 — the parity the whole
// dictionary layer exists to keep. `lorem` is not localised (no locale ships a
// word list for it), so it stays a captured constant: every locale falls back
// to the default lorem anyway, and keeping it a constant avoids per-row lookups
// for the text generators.

const LOREM = dict('lorem');

// ── Generators ────────────────────────────────────────────────────────────────

export interface GenParams {
  min: number;
  max: number;
  dateFrom: string;   // YYYY-MM-DD
  dateTo: string;
  list: string;       // comma-separated for "choice" (item:weight for weighted)
  nullPct: number;    // 0–100
  dist?: 'uniform' | 'normal' | 'zipf';   // numeric/date shaping
  fkTable?: string;    // FK generator: parent table (quoted)
  fkColumn?: string;   // FK generator: parent column

  // ── precision ──────────────────────────────────────────────────────────
  /** Decimal places. 0 means integers; the default of 2 suits money. */
  decimals?: number;

  // ── stepping ───────────────────────────────────────────────────────────
  /**
   * Distance between consecutive rows, for the generators that walk rather
   * than draw at random. A sequence steps by this many; a stepped timestamp
   * advances by this many `stepUnit`s.
   *
   * Evenly spaced rows are what a line chart, a partition scan and a
   * time-bucketed aggregate all actually need — random timestamps inside a
   * range produce a jagged series that tests nothing about intervals.
   */
  step?: number;
  stepUnit?: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month';
  /** ± this much of the step, so a stepped series is regular but not synthetic. */
  jitterPct?: number;

  // ── affixes ────────────────────────────────────────────────────────────
  prefix?: string;
  suffix?: string;

  // ── geography ──────────────────────────────────────────────────────────
  /**
   * Centre and spread of generated points. Coordinates are only useful when
   * they land somewhere: a latitude drawn uniformly from −90…90 puts most
   * rows in an ocean, which looks like working data until someone plots it.
   */
  lat?: number;
  lon?: number;
  radiusKm?: number;

  // ── series shaping ─────────────────────────────────────────────────────
  /** Total drift across the whole dataset, as a percentage of the base. */
  trendPct?: number;
  /** Seasonal swing, as a percentage of the base. */
  seasonAmpPct?: number;
  /** Rows per seasonal cycle — 24 for hourly-with-daily-shape, 12 for months. */
  seasonPeriod?: number;
  /** Random noise, as a percentage of the base. */
  noisePct?: number;

  // ── vehicle tracks (GPS rides) ─────────────────────────────────────────
  /** Pings (rows) per car ride — one car_id spans this many consecutive rows. */
  ridePings?: number;
  /** Seconds between pings; the fleet start is `dateFrom`. */
  pingSec?: number;

  // ── standards-based identifiers (Wave C Phase 3) ───────────────────────
  /**
   * Emit a check-digit-correct value (the default) or, when `false`, a
   * structurally-shaped value with a DELIBERATELY WRONG check digit — for
   * exercising a validator's negative path. Only the check digit changes, so a
   * column toggled valid→invalid keeps the same body and the same RNG draws.
   */
  valid?: boolean;
  /** Credit-card brand: 'visa' | 'mastercard' | 'amex'. Empty → legacy test range. */
  brand?: string;
  /** IBAN country: 'CZ' | 'GB' | 'JP'. Empty → CZ (the Phase-1 default). */
  ibanCountry?: string;
}

export const DEFAULT_PARAMS: GenParams = {
  min: 1, max: 1000,
  dateFrom: '2024-01-01', dateTo: '2026-07-01',
  list: 'new,active,disabled',
  nullPct: 0,
  dist: 'uniform',
  decimals: 2,
  step: 1,
  stepUnit: 'hour',
  jitterPct: 0,
  // Prague. A default has to be *somewhere*, and somewhere on land beats the
  // Gulf of Guinea that (0, 0) gives you.
  lat: 50.08, lon: 14.44, radiusKm: 25,
  trendPct: 20, seasonAmpPct: 25, seasonPeriod: 24, noisePct: 8,
  ridePings: 200, pingSec: 2,
  // Check-digit generators default to VALID output; the toggle only ever makes
  // them invalid on purpose. brand/ibanCountry stay empty so the enhanced
  // creditCard/iban keep their Phase-1 (legacy CZ / test-range) output.
  valid: true,
};

/** Which parameter inputs a generator wants the UI to show. */
export type ParamGroup =
  | 'range' | 'dates' | 'list' | 'decimals' | 'step' | 'affix' | 'geo' | 'series' | 'ride'
  | 'validity' | 'cardBrand' | 'ibanCountry';

export interface Generator {
  id: string;
  label: string;
  /** Grouping in the picker — the list is long enough to need it. */
  group: string;
  /** which param inputs the UI shows */
  uses: ParamGroup[];
  /**
   * `total` is the number of rows the whole run will produce.
   *
   * Only the series generators need it, and they need it badly: "a 30% trend
   * across the dataset" is meaningless without knowing how long the dataset
   * is. Before it was threaded through, the trend was computed against a
   * hardcoded 1000 rows, so the same settings drifted by a third over 1000
   * rows and by almost nothing over 50.
   */
  gen: (rng: Rng, rowIdx: number, p: GenParams, total: number, locale: string) => unknown;
}

const pad = (n: number) => String(n).padStart(2, '0');
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * One draw in 0…1, shaped by `dist`.
 *
 * `dist` has been in `GenParams` since the generator was written and nothing
 * ever read it — every "normal" and "zipf" column came out uniform. It is read
 * here, once, so every numeric and date generator gets the shaping rather than
 * each re-deriving it.
 *
 * Real columns are rarely uniform, and the difference is not cosmetic: an
 * index on a uniformly-distributed column has a selectivity no production
 * index has, so a plan measured against it is measured against the wrong data.
 */
function shaped(rng: Rng, dist: GenParams['dist']): number {
  if (dist === 'normal') {
    // Box–Muller, centred at 0.5 and scaled so ±3σ lands inside 0…1. Clamped
    // rather than resampled: resampling would make the tails denser than the
    // distribution says, which is the opposite of the point.
    const u = Math.max(Number.EPSILON, rng());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    return clamp01(0.5 + z / 6);
  }
  if (dist === 'zipf') {
    // Heavy head, long tail — the shape of "most orders belong to a few
    // customers". Squaring is not Zipf's law exactly; it is the cheap
    // monotone approximation of it, and it is doing the job Zipf is asked for
    // here, which is to make a small part of the range far more common.
    const u = rng();
    return clamp01(u * u);
  }
  return rng();
}

/** Kilometres per degree of latitude — near enough anywhere on the ellipsoid. */
const KM_PER_DEG = 111.32;

/**
 * A point drawn uniformly from a disc around (`lat`, `lon`).
 *
 * `sqrt(u)` is what makes it uniform by *area*. Scaling the radius linearly
 * instead crowds points towards the centre, which shows up immediately on a
 * map as a bullseye rather than a city.
 *
 * The longitude offset is divided by cos(latitude) because degrees of
 * longitude get narrower towards the poles: without it a "25 km" spread is
 * 25 km tall and, in Prague, about 16 km wide.
 */
function geoPoint(rng: Rng, p: GenParams): { lat: number; lon: number } {
  const cLat = p.lat ?? 0;
  const cLon = p.lon ?? 0;
  const radDeg = Math.max(0, p.radiusKm ?? 0) / KM_PER_DEG;
  const w = radDeg * Math.sqrt(rng());
  const t = 2 * Math.PI * rng();
  const dLat = w * Math.cos(t);
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const dLon = (w * Math.sin(t)) / (Math.abs(cosLat) < 1e-6 ? 1e-6 : cosLat);
  return {
    lat: Math.max(-90, Math.min(90, cLat + dLat)),
    // Wrap rather than clamp: longitude is a circle, and clamping at ±180
    // would pile points onto the date line.
    lon: ((((cLon + dLon) + 180) % 360) + 360) % 360 - 180,
  };
}

const round = (v: number, decimals: number) => {
  const f = 10 ** Math.max(0, Math.min(12, decimals));
  return Math.round(v * f) / f;
};

/**
 * The value of a shaped series at row `i`: base × trend × season + noise.
 *
 * This is the generator a chart actually wants. A column of independent random
 * numbers plots as a band of static — it has no trend to see, no cycle to
 * spot, and no reason to be a line rather than a bar.
 */
function seriesValue(rng: Rng, i: number, p: GenParams, total: number): number {
  const base = p.min + (p.max - p.min) / 2;
  const span = Math.max(1, total - 1);
  const trend = 1 + ((p.trendPct ?? 0) / 100) * (i / span);
  const period = Math.max(1, p.seasonPeriod ?? 24);
  const season = 1 + ((p.seasonAmpPct ?? 0) / 100) * Math.sin((2 * Math.PI * i) / period);
  const noise = 1 + ((p.noisePct ?? 0) / 100) * (rng() * 2 - 1);
  return base * trend * season * noise;
}

function randDate(rng: Rng, p: GenParams): Date {
  const from = new Date(p.dateFrom + 'T00:00:00Z').getTime();
  const to = new Date(p.dateTo + 'T23:59:59Z').getTime();
  const t = from + shaped(rng, p.dist) * Math.max(1, to - from);
  return new Date(t);
}

const STEP_MS: Record<NonNullable<GenParams['stepUnit']>, number> = {
  second: 1000, minute: 60_000, hour: 3_600_000,
  day: 86_400_000, week: 604_800_000, month: 2_592_000_000,   // month ≈ 30 d
};

/** Row `i` of an evenly spaced series starting at `dateFrom`. */
function steppedDate(rng: Rng, i: number, p: GenParams): Date {
  const from = new Date(p.dateFrom + 'T00:00:00Z').getTime();
  const unit = STEP_MS[p.stepUnit ?? 'hour'];
  const stride = (p.step ?? 1) * unit;
  const jitter = ((p.jitterPct ?? 0) / 100) * stride * (rng() * 2 - 1);
  return new Date(from + i * stride + jitter);
}

// The Luhn, GS1/EAN and IBAN MOD-97 check-digit algorithms moved to
// `utils/datagenStandards.ts` in Phase 3 so the barcode, card, national-ID and
// VAT generators can share one pure, tested copy that the Rust engine mirrors.
// A short numeric-digit helper the identifier generators reuse:
const digits = (rng: Rng, n: number) =>
  Array.from({ length: n }, () => String(int(rng, 0, 9))).join('');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/**
 * Fill a phone/postcode template from the seeded RNG — a faithful twin of
 * `fill_pattern` in datagen.rs, drawing in the SAME order so both tiers produce
 * the same value for a seed. Tokens:
 *   `{a-b}` → one integer in `[a,b]` (a single draw, so `+420 {601-799}` keeps
 *             the Phase-1 mobile-prefix shape rather than three loose digits);
 *   `A`     → one uppercase letter;
 *   `9`     → one digit 0–9;
 *   anything else is a literal (so `+`, spaces and `-` pass through).
 * Unknown/garbled `{…}` runs pass through literally, matching the Rust side.
 */
function fillPattern(pat: string, rng: Rng): string {
  const cs = Array.from(pat);
  let i = 0;
  let out = '';
  while (i < cs.length) {
    const c = cs[i];
    if (c === '{') {
      let j = i + 1, spec = '';
      while (j < cs.length && cs[j] !== '}') { spec += cs[j]; j += 1; }
      const m = /^(\d+)-(\d+)$/.exec(spec);
      if (j < cs.length && m) {
        out += String(int(rng, Number(m[1]), Number(m[2])));
        i = j + 1;
      } else { out += c; i += 1; }   // not a valid group → literal '{'
    } else if (c === 'A') {
      out += pick(rng, LETTERS); i += 1;
    } else if (c === '9') {
      out += String(int(rng, 0, 9)); i += 1;
    } else {
      out += c; i += 1;
    }
  }
  return out;
}
// GB IBANs carry a 4-letter bank identifier (the SWIFT institution code).
const GB_BANK_LETTERS = LETTERS;

// The ISO-3166-1 alpha-2 codes the random `countryCode` generator draws from
// under `default`. A fixed locale overrides the pick with its own code; this
// list stays the `default` corpus, so a default run is byte-identical.
const ISO2 = ['CZ','DE','AT','PL','SK','FR','ES','IT','NL','BE','DK','SE','NO','FI','IE','PT','CH','HU','HR','SI','GB','US'];

/**
 * Tiny reverse-regex expander — a faithful port of `expand_regex` in
 * `src-tauri/src/commands/datagen.rs`, drawing from the same seeded RNG in the
 * same order so the in-browser tier and the Rust volume tier expand a pattern
 * to the same value. It used to return the pattern *verbatim* here while Rust
 * expanded it, so one column read `[A-Z]{2}-\d{4}` below 200k rows and
 * `QW-8130` above — the divergence this closes.
 *
 * Handles literals, `[a-z0-9]` classes (with ranges), `\d`/`\w` shorthands,
 * `{n}` / `{m,n}` repeats, and `(a|bb|c)` alternation. Unsupported syntax
 * passes through, matching the Rust behaviour exactly (including that a literal
 * character still consumes one RNG draw, so the streams stay aligned).
 */
function expandRegex(pat: string, rng: Rng): string {
  const cs = Array.from(pat);
  let i = 0;
  let out = '';
  const pickCh = (set: string[]): string => set[Math.floor(rng() * set.length)];
  const range = (a: string, b: string): string[] => {
    const r: string[] = [];
    for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) r.push(String.fromCharCode(c));
    return r;
  };
  const cls = (c: string): string[] | null => {
    if (c === 'd') return range('0', '9');
    if (c === 'w') return range('a', 'z').concat(range('0', '9'));
    return null;
  };
  while (i < cs.length) {
    const c = cs[i];
    let atom: string[];
    let next: number;
    if (c === '\\' && i + 1 < cs.length) {
      atom = cls(cs[i + 1]) ?? [cs[i + 1]];
      next = i + 2;
    } else if (c === '[') {
      const set: string[] = [];
      let j = i + 1;
      while (j < cs.length && cs[j] !== ']') {
        if (j + 2 < cs.length && cs[j + 1] === '-') {
          for (const ch of range(cs[j], cs[j + 2])) set.push(ch);
          j += 3;
        } else { set.push(cs[j]); j += 1; }
      }
      atom = set;
      next = j + 1;
    } else if (c === '(') {
      let j = i + 1, depth = 1, body = '';
      while (j < cs.length && depth > 0) {
        if (cs[j] === '(') depth += 1;
        else if (cs[j] === ')') { depth -= 1; if (depth === 0) break; }
        body += cs[j]; j += 1;
      }
      const opts = body.split('|');
      out += opts[Math.floor(rng() * opts.length)];
      i = j + 1;
      // Repeats after a group are ignored, matching the Rust expander.
      continue;
    } else {
      atom = [c];
      next = i + 1;
    }
    i = next;
    let reps = 1;
    if (i < cs.length && cs[i] === '{') {
      let j = i + 1, spec = '';
      while (j < cs.length && cs[j] !== '}') { spec += cs[j]; j += 1; }
      i = j + 1;
      const parts = spec.split(',');
      // Strict unsigned parse, mirroring Rust's `str::parse::<usize>()`: only
      // all-digit strings count, everything else falls back (lo→1, hi→lo).
      const usize = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);
      const lo = usize(parts[0]) ?? 1;
      const hi = parts.length > 1 ? (usize(parts[1]) ?? lo) : lo;
      reps = lo + Math.floor(rng() * (hi - lo + 1));
    }
    for (let k = 0; k < reps; k++) {
      if (atom.length > 0) out += pickCh(atom);
    }
  }
  return out;
}

const affix = (p: GenParams, body: string) => `${p.prefix ?? ''}${body}${p.suffix ?? ''}`;
const fmtDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fmtTs = (d: Date) => `${fmtDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/**
 * The GPS ping for a row, from the vehicle-track params.
 *
 * Every `ride*` generator routes through here, so lat, lon, speed, heading,
 * car id and timestamp for one row all describe the same instant of the same
 * car — the whole point of a track. `dateFrom` is the fleet's start time.
 */
function ridePingFor(rowIdx: number, p: GenParams) {
  return ridePing(rowIdx, {
    ridePings: p.ridePings ?? 200,
    pingSec: p.pingSec ?? 2,
    baseEpochSec: Math.floor(new Date((p.dateFrom || '2026-01-01') + 'T08:00:00Z').getTime() / 1000),
  });
}

export const GENERATORS: Generator[] = [
  // ── Numbers ───────────────────────────────────────────────────────────────
  { id: 'sequence', label: 'Sequence (1, 2, 3…)', group: 'Numbers', uses: ['step'],
    gen: (_r, i, p) => 1 + i * (p.step ?? 1) },
  { id: 'int', label: 'Integer (range)', group: 'Numbers', uses: ['range'],
    gen: (r, _i, p) => Math.round(p.min + shaped(r, p.dist) * (p.max - p.min)) },
  { id: 'decimal', label: 'Decimal (range)', group: 'Numbers', uses: ['range', 'decimals'],
    gen: (r, _i, p) => round(p.min + shaped(r, p.dist) * (p.max - p.min), p.decimals ?? 2) },
  { id: 'money', label: 'Money (2 decimals)', group: 'Numbers', uses: ['range'],
    gen: (r, _i, p) => round(p.min + shaped(r, p.dist) * (p.max - p.min), 2) },
  { id: 'percent', label: 'Percentage (0–100)', group: 'Numbers', uses: ['decimals'],
    gen: (r, _i, p) => round(shaped(r, p.dist) * 100, p.decimals ?? 1) },
  { id: 'rating', label: 'Rating (1–5)', group: 'Numbers', uses: [],
    gen: r => 1 + Math.floor(shaped(r, 'zipf') * 5) },
  { id: 'bool', label: 'Boolean', group: 'Numbers', uses: [], gen: r => r() < 0.5 },
  { id: 'bitflags', label: 'Bit flags (integer mask)', group: 'Numbers', uses: [],
    gen: r => int(r, 0, 255) },

  // ── Series (what a chart wants) ───────────────────────────────────────────
  { id: 'series', label: 'Series — trend + season + noise', group: 'Series',
    uses: ['range', 'series', 'decimals'],
    gen: (r, i, p, n) => round(seriesValue(r, i, p, n), p.decimals ?? 2) },
  { id: 'seriesInt', label: 'Series, whole numbers', group: 'Series', uses: ['range', 'series'],
    gen: (r, i, p, n) => Math.max(0, Math.round(seriesValue(r, i, p, n))) },
  { id: 'randomWalk', label: 'Random walk (cumulative)', group: 'Series',
    uses: ['range', 'decimals'],
    // Deterministic per row rather than stateful: `generateRows` may be called
    // per chunk, and a walk that remembered its last value would restart at
    // every chunk boundary and put a step in the middle of the chart.
    gen: (r, i, p) => {
      const spanRows = Math.max(1, i);
      let v = p.min + (p.max - p.min) / 2;
      for (let k = 0; k < Math.min(spanRows, 500); k++) v += (r() - 0.5) * (p.max - p.min) / 50;
      return round(v, p.decimals ?? 2);
    } },

  // ── Dates and times ───────────────────────────────────────────────────────
  { id: 'date', label: 'Date (range)', group: 'Dates', uses: ['dates'],
    gen: (r, _i, p) => fmtDate(randDate(r, p)) },
  { id: 'timestamp', label: 'Timestamp (range)', group: 'Dates', uses: ['dates'],
    gen: (r, _i, p) => fmtTs(randDate(r, p)) },
  { id: 'timestampStep', label: 'Timestamp — even steps', group: 'Dates', uses: ['dates', 'step'],
    gen: (r, i, p) => fmtTs(steppedDate(r, i, p)) },
  { id: 'dateStep', label: 'Date — even steps', group: 'Dates', uses: ['dates', 'step'],
    gen: (r, i, p) => fmtDate(steppedDate(r, i, p)) },
  { id: 'businessHours', label: 'Timestamp — business hours only', group: 'Dates', uses: ['dates'],
    gen: (r, _i, p) => {
      const d = randDate(r, p);
      // Push weekends onto the Monday, then clamp into 09:00–17:59. Half the
      // point of a business-hours column is that the gaps are real.
      const dow = d.getUTCDay();
      if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
      if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
      d.setUTCHours(9 + Math.floor(r() * 9), Math.floor(r() * 60), Math.floor(r() * 60), 0);
      return fmtTs(d);
    } },
  { id: 'epoch', label: 'Unix timestamp (seconds)', group: 'Dates', uses: ['dates'],
    gen: (r, _i, p) => Math.floor(randDate(r, p).getTime() / 1000) },
  { id: 'timeOfDay', label: 'Time of day (HH:MM:SS)', group: 'Dates', uses: [],
    gen: r => `${pad(int(r, 0, 23))}:${pad(int(r, 0, 59))}:${pad(int(r, 0, 59))}` },
  { id: 'durationSec', label: 'Duration (seconds)', group: 'Dates', uses: ['range'],
    gen: (r, _i, p) => Math.round(p.min + shaped(r, p.dist) * (p.max - p.min)) },
  { id: 'weekday', label: 'Weekday name', group: 'Dates', uses: [],
    gen: r => pick(r, ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']) },
  { id: 'monthName', label: 'Month name', group: 'Dates', uses: [],
    gen: r => pick(r, ['January','February','March','April','May','June','July','August','September','October','November','December']) },
  { id: 'quarter', label: 'Quarter (Q1–Q4)', group: 'Dates', uses: [],
    gen: r => `Q${int(r, 1, 4)}` },

  // ── Geography ─────────────────────────────────────────────────────────────
  { id: 'latitude', label: 'Latitude', group: 'Geography', uses: ['geo'],
    gen: (r, _i, p) => round(geoPoint(r, p).lat, 6) },
  { id: 'longitude', label: 'Longitude', group: 'Geography', uses: ['geo'],
    gen: (r, _i, p) => round(geoPoint(r, p).lon, 6) },
  { id: 'latlon', label: 'Latitude, longitude (one column)', group: 'Geography', uses: ['geo'],
    gen: (r, _i, p) => { const g = geoPoint(r, p); return `${round(g.lat, 6)},${round(g.lon, 6)}`; } },
  { id: 'wktPoint', label: 'WKT POINT (PostGIS-ready)', group: 'Geography', uses: ['geo'],
    // lon first: WKT and GeoJSON are both x-then-y, and getting this backwards
    // puts Prague in Somalia without anything erroring.
    gen: (r, _i, p) => { const g = geoPoint(r, p); return `POINT(${round(g.lon, 6)} ${round(g.lat, 6)})`; } },
  { id: 'geoJsonPoint', label: 'GeoJSON Point', group: 'Geography', uses: ['geo'],
    gen: (r, _i, p) => { const g = geoPoint(r, p);
      return JSON.stringify({ type: 'Point', coordinates: [round(g.lon, 6), round(g.lat, 6)] }); } },
  { id: 'altitude', label: 'Altitude (metres)', group: 'Geography', uses: ['range'],
    gen: (r, _i, p) => Math.round(p.min + shaped(r, p.dist) * (p.max - p.min)) },
  { id: 'countryCode', label: 'Country code (ISO-2)', group: 'Geography', uses: [],
    // Always draw (RNG stream unchanged); a fixed pack pins its own ISO-2,
    // `default` keeps the random pick — byte-identical to before.
    gen: (r, _i, _p, _n, loc) => {
      const c = pick(r, ISO2);
      return loc === DEFAULT_LOCALE ? c : meta(loc).countryCode;
    } },
  { id: 'timezone', label: 'Time zone', group: 'Geography', uses: [],
    gen: r => pick(r, ['Europe/Prague','Europe/Berlin','Europe/Vienna','Europe/London','Europe/Madrid','Europe/Rome','Europe/Warsaw','America/New_York','America/Chicago','America/Los_Angeles','Asia/Tokyo','Asia/Singapore','Australia/Sydney','UTC']) },
  { id: 'city', label: 'City', group: 'Geography', uses: [],
    gen: (r, _i, _p, _n, loc) => pick(r, dict('cities', loc)) },
  { id: 'country', label: 'Country', group: 'Geography', uses: [],
    // Always draw (RNG stream unchanged); a fixed pack pins THAT country so a
    // cs-CZ row is Czechia, `default` keeps the random pick — byte-identical.
    gen: (r, _i, _p, _n, loc) => {
      const c = pick(r, dict('countries', loc));
      return loc === DEFAULT_LOCALE ? c : meta(loc).countryName;
    } },
  { id: 'street', label: 'Street address', group: 'Geography', uses: [],
    gen: (r, _i, _p, _n, loc) => `${pick(r, dict('cities', loc))} St ${int(r, 1, 240)}` },
  { id: 'address', label: 'Full address (locale-aware)', group: 'Geography', uses: [],
    // Street + city + postcode + country composed in the pack's conventional
    // order (Japan runs country→…→number). The parts are drawn in a FIXED order
    // regardless of display order, so both tiers stay in RNG lockstep; the
    // template only rearranges already-drawn text. Under `mixed` the row loop
    // hands this a single resolved pack, so an address is wholly one country.
    gen: (r, _i, _p, _n, loc) => {
      const m = meta(loc);
      const num = int(r, 1, 240);
      const street = pick(r, dict('streets', loc));
      const streetKind = pick(r, dict('streetKinds', loc));
      const city = pick(r, dict('cities', loc));
      const postcode = fillPattern(m.postcodeFormat, r);
      return m.addressFormat
        .replace('{num}', String(num))
        .replace('{street}', street)
        .replace('{streetKind}', streetKind)
        .replace('{city}', city)
        .replace('{postcode}', postcode)
        .replace('{country}', m.countryName);
    } },
  { id: 'postcode', label: 'Postal code', group: 'Geography', uses: [],
    gen: (r, _i, _p, _n, loc) => fillPattern(meta(loc).postcodeFormat, r) },

  // ── GPS tracks (correlated vehicle rides) ──────────────────────────────────
  // Each of these reads the SAME ping for a row (`ridePingFor`), so a table
  // wiring them together gets a real fleet: consecutive rows for one car_id
  // trace a Prague/NYC street at car speed. See utils/rideTracks.ts.
  { id: 'rideCarId', label: 'GPS track — car id', group: 'GPS tracks', uses: ['ride'],
    gen: (_r, i, p) => ridePingFor(i, p).carId },
  { id: 'rideTimestamp', label: 'GPS track — captured_at', group: 'GPS tracks', uses: ['ride', 'dates'],
    gen: (_r, i, p) => fmtTs(new Date(ridePingFor(i, p).epochSec * 1000)) },
  { id: 'rideLat', label: 'GPS track — latitude', group: 'GPS tracks', uses: ['ride'],
    gen: (_r, i, p) => ridePingFor(i, p).lat },
  { id: 'rideLon', label: 'GPS track — longitude', group: 'GPS tracks', uses: ['ride'],
    gen: (_r, i, p) => ridePingFor(i, p).lon },
  { id: 'rideSpeed', label: 'GPS track — speed (km/h)', group: 'GPS tracks', uses: ['ride'],
    gen: (_r, i, p) => ridePingFor(i, p).speedKmh },
  { id: 'rideHeading', label: 'GPS track — heading (°)', group: 'GPS tracks', uses: ['ride'],
    gen: (_r, i, p) => ridePingFor(i, p).headingDeg },
  { id: 'rideWkt', label: 'GPS track — WKT POINT', group: 'GPS tracks', uses: ['ride'],
    gen: (_r, i, p) => { const g = ridePingFor(i, p); return `POINT(${g.lon} ${g.lat})`; } },

  // ── People ────────────────────────────────────────────────────────────────
  { id: 'firstName', label: 'First name', group: 'People', uses: [],
    gen: (r, _i, _p, _n, loc) => pick(r, dict('firstNames', loc)) },
  { id: 'lastName', label: 'Last name', group: 'People', uses: [],
    gen: (r, _i, _p, _n, loc) => pick(r, dict('lastNames', loc)) },
  { id: 'fullName', label: 'Full name', group: 'People', uses: [],
    gen: (r, _i, _p, _n, loc) => `${pick(r, dict('firstNames', loc))} ${pick(r, dict('lastNames', loc))}` },
  { id: 'email', label: 'Email', group: 'People', uses: [],
    gen: (r, _i, _p, _n, loc) => `${pick(r, dict('firstNames', loc)).toLowerCase()}.${pick(r, dict('lastNames', loc)).toLowerCase()}${int(r, 1, 99)}@${pick(r, dict('domains', loc))}` },
  { id: 'username', label: 'Username', group: 'People', uses: [],
    gen: (r, _i, _p, _n, loc) => `${pick(r, dict('firstNames', loc)).toLowerCase()}${int(r, 10, 9999)}` },
  { id: 'phone', label: 'Phone', group: 'People', uses: [],
    // The pack's dialling format (CZ +420 NNN NNN NNN, GB +44 NNNN NNNNNN, JP
    // +81 N-NNNN-NNNN). `default`'s format reproduces the Phase-1 draws exactly.
    gen: (r, _i, _p, _n, loc) => fillPattern(meta(loc).phoneFormat, r) },
  { id: 'jobTitle', label: 'Job title', group: 'People', uses: [],
    gen: r => `${pick(r, ['Senior','Lead','Staff','Principal','Junior','Head of'])} ${pick(r, ['Engineer','Analyst','Designer','Manager','Architect','Consultant'])}` },
  { id: 'department', label: 'Department', group: 'People', uses: [],
    gen: r => pick(r, ['Engineering','Sales','Marketing','Finance','Operations','Support','Legal','People']) },
  { id: 'company', label: 'Company', group: 'People', uses: [],
    gen: (r, _i, _p, _n, loc) => pick(r, dict('companies', loc)) },

  // ── Identifiers and codes ─────────────────────────────────────────────────
  { id: 'uuid', label: 'UUID v4', group: 'Identifiers', uses: [], gen: r => {
      const h = () => Math.floor(r() * 16).toString(16);
      const s = (n: number) => Array.from({ length: n }, h).join('');
      return `${s(8)}-${s(4)}-4${s(3)}-${(8 + Math.floor(r() * 4)).toString(16)}${s(3)}-${s(12)}`;
    } },
  { id: 'sku', label: 'SKU / product code', group: 'Identifiers', uses: ['affix'],
    gen: (r, _i, p, _n, loc) => affix(p, `${pick(r, dict('companies', loc)).slice(0, 3).toUpperCase()}-${int(r, 1000, 9999)}`) },
  // ── GS1 barcodes ─ all share the mod-10 check; the `valid` toggle flips the
  //    check digit for negative testing. The bodies are drawn digit-by-digit in
  //    the SAME order as before, so a default (valid) run is byte-identical.
  { id: 'ean8', label: 'EAN-8 barcode', group: 'Identifiers', uses: ['validity'],
    gen: (r, _i, p) => gs1(digits(r, 7), p.valid !== false) },
  { id: 'ean13', label: 'EAN-13 barcode', group: 'Identifiers', uses: ['validity'],
    gen: (r, _i, p) => gs1(digits(r, 12), p.valid !== false) },
  { id: 'upcA', label: 'UPC-A barcode', group: 'Identifiers', uses: ['validity'],
    gen: (r, _i, p) => gs1(digits(r, 11), p.valid !== false) },
  { id: 'gtin14', label: 'GTIN-14', group: 'Identifiers', uses: ['validity'],
    gen: (r, _i, p) => gs1(digits(r, 13), p.valid !== false) },
  { id: 'isbn13', label: 'ISBN-13', group: 'Identifiers', uses: ['validity'],
    gen: (r, _i, p) => gs1('978' + digits(r, 9), p.valid !== false) },
  { id: 'creditCard', label: 'Card number (Luhn)', group: 'Identifiers', uses: ['cardBrand', 'validity'],
    // Brand → correct IIN range + length, Luhn-valid; the `valid` toggle flips
    // the Luhn check digit. Empty brand keeps the Phase-1 reserved test range
    // (4000 00… — a Luhn-valid number that is nobody's card), byte-identical.
    gen: (r, _i, p) => {
      const valid = p.valid !== false;
      switch (p.brand) {
        case 'visa':       return luhnAppend('4' + digits(r, 14), valid);
        case 'mastercard': return luhnAppend('5' + String(int(r, 1, 5)) + digits(r, 13), valid);
        case 'amex':       return luhnAppend('3' + pick(r, ['4', '7']) + digits(r, 12), valid);
        default:           return luhnAppend('400000' + digits(r, 9), valid);
      }
    } },
  { id: 'iban', label: 'IBAN (MOD-97)', group: 'Identifiers', uses: ['ibanCountry', 'validity'],
    // The BBAN shape is country-specific; the two check digits are COMPUTED
    // (MOD-97-10), not random, so the result validates. Empty country keeps the
    // Phase-1 CZ output byte-identical (bank 4 digits + account 16 digits).
    // Japan has no ISO IBAN scheme — 'JP' emits a plausible SYNTHETIC IBAN built
    // from Zengin fields (bank/branch/account) with a correct MOD-97 check, so
    // it round-trips through a validator but is not an officially assigned IBAN.
    gen: (r, _i, p) => {
      const valid = p.valid !== false;
      switch (p.ibanCountry) {
        case 'GB': {
          const bank = Array.from({ length: 4 }, () => pick(r, GB_BANK_LETTERS)).join('');
          const bban = bank + digits(r, 6) + digits(r, 8);   // 4 letters + sort + account
          return ibanValue('GB', bban, valid);
        }
        case 'JP': {
          const bban = digits(r, 4) + digits(r, 3) + digits(r, 8); // bank + branch + account
          return ibanValue('JP', bban, valid);
        }
        default: {
          const bban = String(int(r, 1000, 9999)) + digits(r, 16);
          return ibanValue('CZ', bban, valid);
        }
      }
    } },
  { id: 'bic', label: 'BIC / SWIFT code', group: 'Identifiers', uses: ['validity'],
    // 4 bank letters + 2 country letters + 2 location (alnum) [+ 3 branch].
    // Invalid puts a DIGIT in the bank block, which the 4-letter rule forbids.
    gen: (r, _i, p) => {
      const L = () => pick(r, LETTERS);
      const AN = () => pick(r, ALNUM);
      const bank = (p.valid !== false ? L() : String(int(r, 0, 9))) + L() + L() + L();
      const country = L() + L();
      const loc = AN() + AN();
      const branch = int(r, 0, 1) === 0 ? '' : AN() + AN() + AN();
      return bank + country + loc + branch;
    } },
  { id: 'licensePlate', label: 'Licence plate', group: 'Identifiers', uses: [],
    gen: r => `${int(r, 1, 9)}${pick(r, ['A','B','C','E','H','J','K','L','M','P','S','T','U','Z'])}${int(r, 1000, 9999)}` },
  { id: 'semver', label: 'Semantic version', group: 'Identifiers', uses: [],
    gen: r => `${int(r, 0, 4)}.${int(r, 0, 20)}.${int(r, 0, 40)}` },
  { id: 'hashHex', label: 'Hex hash (64 chars)', group: 'Identifiers', uses: [],
    gen: r => Array.from({ length: 64 }, () => Math.floor(r() * 16).toString(16)).join('') },

  // ── National IDs ─ locale-authentic, correct check algorithms. The `valid`
  //    toggle emits a structurally-shaped value that FAILS the check.
  { id: 'czBirthNumber', label: 'CZ rodné číslo (birth number)', group: 'National IDs', uses: ['validity'],
    // YYMMDD + 3-digit serial + mod-11 check (post-1954, divisible-by-11 form).
    // Women's month is +50. Serials whose 9-digit prefix ≡ 10 (mod 11) have no
    // single check digit and were never issued — redrawn, identically in Rust.
    gen: (r, _i, p) => {
      let prefix: string;
      do {
        const yy = pad(int(r, 0, 99));
        const mm = pad(int(r, 1, 12) + (int(r, 0, 1) === 1 ? 50 : 0));
        const dd = pad(int(r, 1, 28));
        const serial = digits(r, 3);
        prefix = yy + mm + dd + serial;
      } while (rodneCisloCheck(prefix) === 10);
      return rodneCislo(prefix, p.valid !== false);
    } },
  { id: 'ukNino', label: 'UK National Insurance number', group: 'National IDs', uses: ['validity'],
    // Two prefix letters from the valid sets (never an administratively unused
    // pair), six digits, suffix A–D. No checksum — the invalid form uses an
    // out-of-range suffix letter, keeping the 2-letter/6-digit shape.
    gen: (r, _i, p) => {
      let a: string, b: string;
      do { a = pick(r, NINO_FIRST); b = pick(r, NINO_SECOND); } while (!ninoPrefixOk(a, b));
      const suffix = p.valid !== false ? pick(r, NINO_SUFFIX) : 'Z';
      return `${a}${b}${digits(r, 6)}${suffix}`;
    } },
  { id: 'jpMyNumber', label: 'JP My Number (個人番号)', group: 'National IDs', uses: ['validity'],
    // 11 digits + the official mod-11 check digit.
    gen: (r, _i, p) => myNumber(digits(r, 11), p.valid !== false) },

  // ── Tax / VAT IDs ─ correct checksums; `valid` flips the check.
  { id: 'czVat', label: 'CZ DIČ (VAT, 8-digit)', group: 'Tax IDs', uses: ['validity'],
    // CZ + 8 digits: the legal-entity form, IČO mod-11 check on the first 7.
    gen: (r, _i, p) => czVat(digits(r, 7), p.valid !== false) },
  { id: 'gbVat', label: 'GB VAT number (9-digit)', group: 'Tax IDs', uses: ['validity'],
    // 7-digit body + 2 check digits via the 97-complement (MOD-97) algorithm.
    gen: (r, _i, p) => gbVat(digits(r, 7), p.valid !== false) },
  { id: 'jpCorporateNumber', label: 'JP corporate number (法人番号)', group: 'Tax IDs', uses: ['validity'],
    // 13 digits: a leading check digit over the trailing 12 (mod-9).
    gen: (r, _i, p) => jpCorporateNumber(digits(r, 12), p.valid !== false) },

  // ── Network ───────────────────────────────────────────────────────────────
  { id: 'ipv4', label: 'IPv4 address', group: 'Network', uses: [],
    gen: r => `${int(r, 1, 254)}.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 1, 254)}` },
  { id: 'ipv6', label: 'IPv6 address', group: 'Network', uses: [],
    gen: r => Array.from({ length: 8 },
      () => Array.from({ length: 4 }, () => Math.floor(r() * 16).toString(16)).join('')).join(':') },
  { id: 'macAddress', label: 'MAC address', group: 'Network', uses: [],
    gen: r => Array.from({ length: 6 },
      () => int(r, 0, 255).toString(16).padStart(2, '0')).join(':') },
  { id: 'domain', label: 'Domain name', group: 'Network', uses: [],
    gen: (r, _i, _p, _n, loc) => `${pick(r, dict('companies', loc)).toLowerCase().replace(/\s+/g, '')}.${pick(r, ['com','net','io','dev','cz'])}` },
  { id: 'url', label: 'URL', group: 'Network', uses: [],
    gen: (r, _i, _p, _n, loc) => `https://${pick(r, dict('companies', loc)).toLowerCase().replace(/\s+/g, '')}.com/${pick(r, LOREM)}/${int(r, 1, 9999)}` },
  { id: 'userAgent', label: 'User agent', group: 'Network', uses: [],
    gen: r => pick(r, [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/122.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) Version/17.0 Mobile Safari/604.1',
    ]) },
  { id: 'httpStatus', label: 'HTTP status code', group: 'Network', uses: [],
    // Weighted the way a real access log is: mostly 200, a scattering of the rest.
    gen: r => { const u = r();
      return u < 0.82 ? 200 : u < 0.88 ? 204 : u < 0.92 ? 301 : u < 0.95 ? 404
        : u < 0.97 ? 403 : u < 0.99 ? 500 : 503; } },

  // ── Text ──────────────────────────────────────────────────────────────────
  { id: 'words', label: 'Words (short text)', group: 'Text', uses: [],
    gen: r => Array.from({ length: int(r, 2, 4) }, () => pick(r, LOREM)).join(' ') },
  { id: 'sentence', label: 'Sentence (long text)', group: 'Text', uses: [],
    gen: r => { const w = Array.from({ length: int(r, 8, 16) }, () => pick(r, LOREM));
      return w[0][0].toUpperCase() + w.join(' ').slice(1) + '.'; } },
  { id: 'paragraph', label: 'Paragraph', group: 'Text', uses: [],
    gen: r => Array.from({ length: int(r, 3, 6) }, () => {
      const w = Array.from({ length: int(r, 8, 16) }, () => pick(r, LOREM));
      return w[0][0].toUpperCase() + w.join(' ').slice(1) + '.';
    }).join(' ') },
  { id: 'title', label: 'Title case phrase', group: 'Text', uses: [],
    gen: r => Array.from({ length: int(r, 2, 5) }, () => pick(r, LOREM))
      .map(w => w[0].toUpperCase() + w.slice(1)).join(' ') },
  { id: 'slug', label: 'URL slug', group: 'Text', uses: [],
    gen: r => Array.from({ length: int(r, 2, 4) }, () => pick(r, LOREM)).join('-') },
  { id: 'product', label: 'Product name', group: 'Text', uses: [],
    gen: (r, _i, _p, _n, loc) => `${pick(r, dict('companies', loc))} ${pick(r, LOREM)}` },
  { id: 'hexColor', label: 'Hex colour', group: 'Text', uses: [],
    gen: r => '#' + Array.from({ length: 6 }, () => Math.floor(r() * 16).toString(16)).join('') },
  { id: 'emoji', label: 'Emoji', group: 'Text', uses: [],
    gen: r => pick(r, ['😀','🎉','🚀','🔥','✅','⚠️','📈','🐬','🐘','🗃️']) },

  // ── Structured ────────────────────────────────────────────────────────────
  { id: 'json', label: 'Small JSON object', group: 'Structured', uses: [],
    gen: r => JSON.stringify({ tag: pick(r, LOREM), score: int(r, 0, 100), ok: r() < 0.5 }) },
  { id: 'jsonNested', label: 'Nested JSON object', group: 'Structured', uses: [],
    gen: (r, _i, _p, _n, loc) => JSON.stringify({
      id: int(r, 1, 99999),
      user: { name: `${pick(r, dict('firstNames', loc))} ${pick(r, dict('lastNames', loc))}`, city: pick(r, dict('cities', loc)) },
      tags: Array.from({ length: int(r, 1, 3) }, () => pick(r, LOREM)),
      meta: { score: int(r, 0, 100), active: r() < 0.7 },
    }) },
  { id: 'arrayInt', label: 'Array of integers', group: 'Structured', uses: ['range'],
    gen: (r, _i, p) => JSON.stringify(
      Array.from({ length: int(r, 1, 5) }, () => Math.round(p.min + r() * (p.max - p.min)))) },
  { id: 'arrayText', label: 'Array of words', group: 'Structured', uses: [],
    gen: r => JSON.stringify(Array.from({ length: int(r, 1, 4) }, () => pick(r, LOREM))) },

  // ── Controlled values ─────────────────────────────────────────────────────
  { id: 'choice', label: 'Pick from list / weighted', group: 'Controlled', uses: ['list'],
    gen: (r, _i, p) => {
      const items = p.list.split(',').map(s => s.trim()).filter(Boolean);
      if (!items.length) return '';
      // `item:weight` makes a status column look like production, where
      // 'active' outnumbers 'disabled' by a hundred to one.
      const parsed = items.map(s => {
        const m = /^(.*):(\d+(?:\.\d+)?)$/.exec(s);
        return m ? { value: m[1], weight: Number(m[2]) } : { value: s, weight: 1 };
      });
      const total = parsed.reduce((a, b) => a + b.weight, 0);
      let t = r() * total;
      for (const it of parsed) { t -= it.weight; if (t <= 0) return it.value; }
      return parsed[parsed.length - 1].value;
    } },
  { id: 'currencyCode', label: 'Currency code', group: 'Controlled', uses: [],
    gen: r => pick(r, ['CZK','EUR','USD','GBP','PLN','CHF','SEK','NOK','DKK','HUF']) },
  { id: 'regex', label: 'Pattern (reverse regex)', group: 'Controlled', uses: ['list'],
    // Reverse-expands the pattern (e.g. `[A-Z]{2}-\d{4}` → `QW-8130`), matching
    // the Rust volume tier exactly. It used to return the pattern verbatim.
    gen: (r, _i, p) => expandRegex(p.list || '', r) },
  { id: 'fk', label: 'Foreign key (pull from parent)', group: 'Controlled', uses: [],
    gen: () => '<fk>' },
  { id: 'constant', label: 'Constant value', group: 'Controlled', uses: ['affix'],
    gen: (_r, _i, p) => affix(p, '') },
];


export const GENERATOR_MAP = new Map(GENERATORS.map(g => [g.id, g]));

/** Suggest a generator from column name + SQL type. */
export function suggestGenerator(name: string, typeName: string, isPk: boolean): string {
  const n = name.toLowerCase();
  const t = typeName.toUpperCase();
  const isInt = /INT|SERIAL|BIGINT|NUMBER/.test(t);
  if (isPk && isInt) return 'sequence';
  // Standards-based identifiers, matched on whole "words" so `mean`→ean etc.
  // never misfire. Checked before the generic name/ip heuristics below.
  const has = (w: string) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(n);
  if (has('ean') || has('ean13')) return 'ean13';
  if (has('ean8')) return 'ean8';
  if (has('upc') || has('upca')) return 'upcA';
  if (has('gtin')) return 'gtin14';
  if (has('isbn')) return 'isbn13';
  if (has('iban')) return 'iban';
  if (has('bic') || has('swift')) return 'bic';
  if (has('nino')) return 'ukNino';
  if (has('mynumber') || has('kojin')) return 'jpMyNumber';
  if (has('vat') || has('dic')) return 'gbVat';
  if (has('card')) return 'creditCard';
  if (n.includes('email')) return 'email';
  if (n.includes('first') && n.includes('name')) return 'firstName';
  if (n.includes('last') && n.includes('name')) return 'lastName';
  if (n.includes('username') || n.includes('login')) return 'username';
  if (n.includes('name')) return 'fullName';
  if (n.includes('city')) return 'city';
  // ISO-2 code vs. country name: a `country_code`/`iso` column wants the code.
  if (has('iso') || n.includes('country_code') || n.includes('countrycode')) return 'countryCode';
  if (n.includes('country')) return 'country';
  if (n.includes('company') || n.includes('vendor')) return 'company';
  if (n.includes('phone') || n.includes('tel') || n.includes('mobile')) return 'phone';
  if (has('zip') || n.includes('postcode') || n.includes('postal') || has('zipcode')) return 'postcode';
  if (n.includes('address') || n.includes('addr')) return 'address';
  if (n.includes('uuid') || n.includes('guid')) return 'uuid';
  if (n.includes('ip')) return 'ipv4';
  if (n.includes('price') || n.includes('amount') || n.includes('cost') || /DECIMAL|NUMERIC/.test(t)) return 'decimal';
  if (n.includes('status') || n.includes('state') || n.includes('type') || /ENUM/.test(t)) return 'choice';
  if (/BOOL|TINYINT\(1\)/.test(t)) return 'bool';
  if (/TIMESTAMP|DATETIME/.test(t) || n.endsWith('_at') || n.includes('time')) return 'timestamp';
  if (/DATE/.test(t) || n.includes('date') || n.includes('birth')) return 'date';
  if (/JSON/.test(t)) return 'json';
  if (isInt) return n.includes('id') ? 'sequence' : 'int';
  if (/FLOAT|DOUBLE|REAL/.test(t)) return 'decimal';
  if (/TEXT|CLOB/.test(t)) return 'sentence';
  return 'words';
}

// ── SQL emission ──────────────────────────────────────────────────────────────

// Re-exported rather than redefined: this module used to carry its own copy,
// and three components import it from here. `utils/sqlIdent` is the one home.
export { quoteIdent };

/**
 * A generated value as a literal. Engine-aware because MySQL treats a
 * backslash as an escape and PostgreSQL does not — generated text containing
 * one was being written to MySQL wrong before this took the engine.
 */
export function sqlLiteral(v: unknown, engine: string): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return lit(String(v), engine);
}

export interface ColumnSpec {
  name: string;
  typeName: string;     // display / DDL type
  generator: string;    // generator id
  params: GenParams;
  unique?: boolean;     // enforce uniqueness (backend mixes in the row index)
}

/**
 * Generate `count` rows for the given specs.
 *
 * `locale` selects the dictionary pack the name/place/company generators draw
 * from; it defaults to `default`, for which every list resolves to the exact
 * Phase-1 array and the output is byte-identical to before locales existed.
 * The draw order is unchanged — locale only swaps which list a `pick` reads,
 * never how many times the RNG is advanced — so the seeded parity with the
 * Rust engine holds per locale.
 */
export function generateRows(
  specs: ColumnSpec[], count: number, seed: number, locale: string = DEFAULT_LOCALE,
): unknown[][] {
  const rng = makeRng(seed);
  const rows: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    // Resolve the row's locale from `rowIdx` alone — a pure hash, never an RNG
    // draw — so a fixed locale is the identity here and its seeded stream is
    // untouched. Only `mixed` maps each row onto a single pack, and every
    // generator in the row then localises through the same pack (coherence).
    const rowLocale = resolveRowLocale(locale, i);
    rows.push(specs.map(spec => {
      if (spec.params.nullPct > 0 && rng() * 100 < spec.params.nullPct) return null;
      const g = GENERATOR_MAP.get(spec.generator);
      return g ? g.gen(rng, i, spec.params, count, rowLocale) : null;
    }));
  }
  return rows;
}

/** Multi-row INSERT statements in batches. */
export function buildInserts(
  table: string,
  specs: ColumnSpec[],
  rows: unknown[][],
  engine: string,
  batchSize = 500,
): string[] {
  const cols = specs.map(s => quoteIdent(s.name, engine)).join(', ');
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const values = rows.slice(i, i + batchSize)
      .map(r => `(${r.map(v => sqlLiteral(v, engine)).join(', ')})`)
      .join(',\n');
    out.push(`INSERT INTO ${table} (${cols}) VALUES\n${values}`);
  }
  return out;
}

export function buildCreateTable(
  table: string,
  specs: { name: string; typeName: string; pk: boolean; nullable: boolean }[],
  engine: string,
): string {
  const lines = specs.map(s => {
    const parts = [quoteIdent(s.name, engine), s.typeName];
    if (!s.nullable) parts.push('NOT NULL');
    return '  ' + parts.join(' ');
  });
  const pks = specs.filter(s => s.pk).map(s => quoteIdent(s.name, engine));
  if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(', ')})`);
  return `CREATE TABLE ${table} (\n${lines.join(',\n')}\n)`;
}
