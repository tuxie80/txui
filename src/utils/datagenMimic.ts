/**
 * "Mimic existing data" — map a column profile (the `datagen_profile_table`
 * command, src-tauri/src/commands/datagen_profile.rs) onto a generator +
 * params that reproduce the SHAPE of the column, never its values.
 *
 * Privacy contract: the only observed values that ever reach a spec are the
 * top-N of a CATEGORICAL column — few distinct values, where each value is a
 * category label ('active', 'disabled'), not content. Free-text columns
 * (notes, names, addresses) contribute only their length histogram and null
 * share; the values themselves never cross into a spec, and nothing here
 * carries a value the profiling did not already surface to the user's own
 * screen. A weighted choice over category labels is the whole reason the
 * profile collects frequencies at all.
 *
 * Pure module: no React, no Tauri — runnable under `node --test`.
 */

import { suggestGenerator } from './datagen.ts';
import type { GenParams } from './datagen.ts';

// ── Wire types (mirror the serde camelCase of datagen_profile.rs) ───────────

export interface ProfileTopValue { value: unknown; count: number }

export interface ColumnProfile {
  column: string;
  family: 'numeric' | 'temporal' | 'text' | 'bool' | 'other';
  /** Rows the sample actually held (≤ the backend's 100k cap). */
  sampledRows: number;
  nullPct: number;
  distinct: number | null;
  min: unknown;
  max: unknown;
  avgLen: number | null;
  maxLen: number | null;
  topValues: ProfileTopValue[];
  /** Set instead of failing the table when this column resisted profiling. */
  error: string | null;
}

/** What the panel knows about a column before profiling. */
export interface MimicColumn {
  name: string;
  typeName: string;
  /** The generator the name/type heuristic already picked — kept when the
   *  profile has nothing better to say (semantic matches beat shape). */
  generator?: string;
  unique?: boolean;
}

export interface MimicSuggestion {
  generator: string;
  /** Partial — merged over the column's current params by the caller. */
  params: Partial<GenParams>;
  /** undefined → keep the column's current flag. */
  unique?: boolean;
  /** One line for the session log: what was decided and on what evidence. */
  reason: string;
}

// ── Thresholds ──────────────────────────────────────────────────────────────

/**
 * A column is categorical when its distinct count fits the top-N window's
 * purpose: few enough values that the 8 most common carry the distribution.
 * Past this, treating values as categories would silently drop the tail, so
 * the column takes a range/semantic generator instead.
 */
export const CATEGORICAL_MAX_DISTINCT = 16;
/** ...or relative: under 5% of the rows, few values are categories regardless. */
export const CATEGORICAL_MAX_RATIO = 0.05;
/** distinct/rows at or above this reads as "every value different" → unique. */
export const ALL_DISTINCT_RATIO = 0.98;

/** Text fallback buckets, by average length (chars). */
const WORDS_AVG_MAX = 20;
const SENTENCE_AVG_MAX = 120;

/**
 * Engines the backend profiling command speaks (datagen_profile.rs) — the
 * panel greys the button for anything else, with the reason, per the
 * `.unavail` convention. SQLite is included so the day dataGen opens for it
 * the mimic button already works.
 */
export const MIMIC_ENGINES = new Set(['mysql', 'postgres', 'sqlite', 'sqlserver']);
/** Mirror of `PROFILE_SAMPLE_ROWS` in datagen_profile.rs, for the log line. */
export const MIMIC_SAMPLE_CAP = 100_000;

/** suggestGenerator's generic text fallbacks — everything else it returns is
 *  a SEMANTIC match (email, city, …) that mimic keeps over a shape guess. */
const GENERIC_TEXT_GENS = new Set(['words', 'sentence', 'paragraph']);

// ── Value coercion ──────────────────────────────────────────────────────────

/** Numbers arrive as JSON numbers; DECIMAL/NUMERIC decode as strings. */
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Dates arrive as "YYYY-MM-DD[ …]" strings; only the date part is used. */
function datePart(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : null;
}

function isIntegerType(typeName: string): boolean {
  const t = typeName.toUpperCase();
  return /INT|SERIAL|YEAR/.test(t) && !/DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|MONEY|FIXED/.test(t);
}

/** DECIMAL(10,2) → 2; anything else → the generator's 2dp default. */
function decimalsOf(typeName: string): number {
  const m = /,\s*(\d+)\)/.exec(typeName);
  return m ? Math.min(12, Math.max(0, Number(m[1]))) : 2;
}

/**
 * The observed non-null rows, derived (the wire carries nullPct, not the
 * count). Only ever used for ratios, so the rounding is immaterial.
 */
function nonNullRows(p: ColumnProfile): number {
  return Math.max(0, p.sampledRows * (1 - p.nullPct / 100));
}

function isCategorical(p: ColumnProfile): boolean {
  const d = p.distinct;
  if (d === null || d < 2) return false;
  const nn = nonNullRows(p);
  return d <= CATEGORICAL_MAX_DISTINCT || (nn > 0 && d / nn <= CATEGORICAL_MAX_RATIO);
}

function isAllDistinct(p: ColumnProfile): boolean {
  const d = p.distinct;
  const nn = nonNullRows(p);
  return d !== null && nn > 0 && d >= ALL_DISTINCT_RATIO * nn;
}

/**
 * The weighted list for a `choice` spec, from observed frequencies — weights
 * as percentages of the non-null rows, one decimal. Returns null when a value
 * cannot survive the choice-list grammar (`item:weight,item:weight` — a comma
 * or colon IN a value would parse as a separator; there is no quoting).
 */
function weightedList(p: ColumnProfile): string | null {
  const nn = nonNullRows(p);
  if (nn <= 0 || p.topValues.length === 0) return null;
  const parts: string[] = [];
  for (const { value, count } of p.topValues) {
    const s = value === null || value === undefined ? '' : String(value);
    if (s === '' || s.includes(',') || s.includes(':')) return null;
    const w = Math.round((count / nn) * 1000) / 10;
    if (w <= 0) continue;   // rounds away — honestly absent rather than faked
    parts.push(`${s}:${w}`);
  }
  return parts.length ? parts.join(',') : null;
}

// ── The mapping ─────────────────────────────────────────────────────────────

/**
 * One column's suggestion. Never throws: any oddity in the profile degrades
 * to the name-based suggestion plus nullPct, with the reason saying so.
 */
export function mimicColumn(col: MimicColumn, p: ColumnProfile): MimicSuggestion {
  const nullPct = Math.round(Math.min(100, Math.max(0, p.nullPct)));
  const fallback = col.generator ?? suggestGenerator(col.name, col.typeName, false);

  if (p.error) {
    return { generator: fallback, params: {}, reason: `profiling failed (${p.error}) — kept the name-based suggestion` };
  }
  if (p.sampledRows === 0) {
    return { generator: fallback, params: {}, reason: 'no rows in the sample — kept the name-based suggestion' };
  }
  if (nullPct >= 100) {
    return { generator: fallback, params: { nullPct: 100 }, reason: 'entirely NULL in the sample' };
  }

  switch (p.family) {
    case 'bool':
      // The true/false split has no generator param to land on (bool is
      // 50/50); the split is quoted in the reason so the user can reach for
      // a weighted choice themselves when the skew matters.
      return { generator: 'bool', params: { nullPct }, reason: boolReason(p) };

    case 'numeric': return mimicNumeric(col, p, nullPct, fallback);
    case 'temporal': return mimicTemporal(col, p, nullPct, fallback);
    case 'text': return mimicText(p, nullPct, fallback);

    case 'other':
      if (/JSON/i.test(col.typeName)) {
        return { generator: 'json', params: { nullPct }, reason: 'JSON column — structure generator; values are never carried over' };
      }
      return { generator: fallback, params: { nullPct }, reason: 'type not profilable beyond the null share' };
  }
}

function boolReason(p: ColumnProfile): string {
  const nn = nonNullRows(p);
  const top = p.topValues[0];
  if (!top || nn <= 0) return 'boolean column';
  const pct = Math.round((top.count / nn) * 100);
  const label = String(top.value);
  return pct >= 55 || pct <= 45
    ? `boolean column — observed ${label} ${pct}% of rows (generator stays 50/50; use a weighted choice if the skew matters)`
    : 'boolean column';
}

function mimicNumeric(col: MimicColumn, p: ColumnProfile, nullPct: number, fallback: string): MimicSuggestion {
  const min = num(p.min), max = num(p.max);
  const integer = isIntegerType(col.typeName);

  if (isCategorical(p)) {
    const list = weightedList(p);
    if (list) {
      return { generator: 'choice', params: { list, nullPct }, unique: false,
        reason: `${p.distinct} distinct values — weighted choice over the observed categories` };
    }
  }
  if (min === null || max === null) {
    return { generator: fallback, params: { nullPct }, reason: 'no min/max in the sample — kept the name-based suggestion' };
  }
  const lo = Math.min(min, max), hi = Math.max(min, max);
  const single = lo === hi;

  if (isAllDistinct(p)) {
    // A PK loaded as `sequence` stays one — the panel resolves MAX(pk)+1 at
    // preview time, which a plain `int` + unique would not give it.
    if (col.generator === 'sequence') {
      return { generator: 'sequence', params: { nullPct }, unique: true,
        reason: 'all values distinct — kept the sequence (starts after the existing max)' };
    }
    const gen = integer ? 'int' : 'decimal';
    return { generator: gen, unique: true,
      params: integer
        ? { min: Math.floor(lo), max: Math.ceil(hi), nullPct }
        : { min: lo, max: hi, decimals: decimalsOf(col.typeName), nullPct },
      reason: single
        ? `one observed value (${lo}) — generated unique; widen the range or drop uniq if that is wrong`
        : `all values distinct — ${gen} in the observed range ${lo}…${hi}, unique by construction` };
  }

  const gen = integer ? 'int' : 'decimal';
  return {
    generator: gen,
    params: integer
      ? { min: Math.floor(lo), max: Math.ceil(hi), nullPct }
      : { min: lo, max: hi, decimals: decimalsOf(col.typeName), nullPct },
    reason: single
      ? `one observed value (${lo}) — a constant range; widen it if that is wrong`
      : `${gen} in the observed range ${lo}…${hi}`,
  };
}

function mimicTemporal(col: MimicColumn, p: ColumnProfile, nullPct: number, fallback: string): MimicSuggestion {
  const t = col.typeName.toUpperCase();
  // A bare TIME holds a clock reading, not a date — min/max as date bounds
  // would be nonsense.
  if (/^TIME/.test(t) && !/^TIMESTAMP/.test(t)) {
    return { generator: 'timeOfDay', params: { nullPct }, reason: 'time-of-day column' };
  }
  const from = datePart(p.min), to = datePart(p.max);
  if (!from || !to) {
    return { generator: fallback, params: { nullPct }, reason: 'no min/max dates in the sample — kept the name-based suggestion' };
  }
  // No unique here: the uniqueness tag corrupts a date column's values (the
  // panel's own uniqueRowReason says so) — distinct dates stay a range draw.
  const gen = /^TIMESTAMP|DATETIME/.test(t) ? 'timestamp' : 'date';
  return {
    generator: gen, params: { dateFrom: from, dateTo: to, nullPct },
    reason: from === to
      ? `one observed date (${from}) — a one-day range; widen it if that is wrong`
      : `${gen} between the observed ${from} and ${to}`,
  };
}

function mimicText(p: ColumnProfile, nullPct: number, fallback: string): MimicSuggestion {
  if (isCategorical(p)) {
    const list = weightedList(p);
    if (list) {
      return { generator: 'choice', params: { list, nullPct }, unique: false,
        reason: `${p.distinct} distinct values — weighted choice over the observed categories` };
    }
    // Categorical but unencodable (a comma/colon in a value) falls THROUGH to
    // the length/semantic rules — never a broken list.
  }
  // A semantic name match (email, city, phone, …) reproduces the column's
  // shape better than a length bucket — and carries no observed values.
  if (!GENERIC_TEXT_GENS.has(fallback)) {
    return { generator: fallback, params: { nullPct },
      reason: `kept the name-based suggestion (${fallback}) — the profile's free text is not carried over` };
  }
  if (isAllDistinct(p)) {
    // e.g. a code column the name heuristic missed: unique short strings.
    const gen = p.avgLen !== null && p.avgLen <= WORDS_AVG_MAX ? 'words' : 'sentence';
    return { generator: gen, params: { nullPct }, unique: true,
      reason: 'all values distinct — generated unique (row-index tag)' };
  }
  const avg = p.avgLen;
  if (avg === null) {
    return { generator: fallback, params: { nullPct }, reason: 'no length stats in the sample — kept the default text shape' };
  }
  const gen = avg <= WORDS_AVG_MAX ? 'words' : avg <= SENTENCE_AVG_MAX ? 'sentence' : 'paragraph';
  return { generator: gen, params: { nullPct },
    reason: `free text averaging ${Math.round(avg)} chars — ${gen}, values not carried over` };
}

/**
 * The one-line log summary for a mimic run: what the sample was, per engine
 * the same. Shown via addLog so the pre-fill is never silent.
 */
export function mimicLogLine(table: string, profiles: ColumnProfile[], applied: number, sampleCap: number): string {
  const sampled = profiles[0]?.sampledRows ?? 0;
  const failed = profiles.filter(p => p.error).length;
  const scope = sampled >= sampleCap ? `sample of ${sampled.toLocaleString('en-US')} rows` : `all ${sampled.toLocaleString('en-US')} rows`;
  return `mimic: profiled ${table} (${scope}) — pre-filled ${applied} column${applied === 1 ? '' : 's'}`
    + (failed ? `, ${failed} kept name-based suggestions (unprofilable type)` : '')
    + '; shapes only — no values copied';
}
