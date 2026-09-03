/**
 * Shared word-list dictionaries for the data generator.
 *
 * ONE source of truth — `dictionaries.json` — consumed by all three engines:
 * the in-browser JS engine (`utils/datagen.ts`), the server-side SQL emitter
 * (`utils/datagenSql.ts`), and the Rust streaming engine
 * (`src-tauri/src/commands/datagen.rs`, via `include_str!`). Before this the
 * arrays were hand-copied into each, and the copies had drifted (the Rust
 * superset was four times the size of the JS list), so a seed produced
 * different rows on either side of the 200k row-count tier. The JSON is the
 * union, and both tiers read it, so a seed means the same data at any size.
 *
 * The shape is **locale-keyed from day one** — only `default` exists today, but
 * Phase 2 drops in `cs-CZ` / `en-GB` / `ja-JP` as sibling keys (or lazily
 * loaded packs) with no change to this accessor or its callers.
 */
import data from './dictionaries.json' with { type: 'json' };

/** The dictionaries a locale provides. Add names here as new corpora land. */
export type DictName =
  | 'firstNames' | 'lastNames' | 'cities' | 'countries' | 'companies'
  | 'domains' | 'lorem' | 'streets' | 'streetKinds'
  | 'productAdjectives' | 'productNouns';

/**
 * Per-locale metadata (Wave C Phase 4). A small, data-driven block each engine
 * reads to make a row internally coherent: the phone prefix/format, postal-code
 * format, canonical country name + ISO-2 code, the IBAN country, and the
 * conventional address ordering. Adding a locale means adding one of these — no
 * generator code changes.
 *
 * The format mini-language (`phoneFormat`, `postcodeFormat`) is a template read
 * identically by both engines: `{a-b}` draws one integer in `[a,b]`, `A` draws
 * an uppercase letter, `9` draws a single digit, and every other character is a
 * literal. `default`'s formats are chosen so a default run stays byte-identical
 * to Phase 1 (`+420 …` phone, `NNN NN` postcode).
 *
 * `addressFormat` uses named tokens — `{street} {streetKind} {num} {city}
 * {postcode} {country}` — substituted after the parts are drawn, so display
 * order (Japan is large→small) never changes the RNG draw order.
 */
export interface LocaleMeta {
  phonePrefix: string;
  phoneFormat: string;
  postcodeFormat: string;
  countryName: string;
  countryCode: string;
  ibanCountry: string;
  addressFormat: string;
}

const DICTS = data as Record<string, Record<string, unknown>>;

export const DEFAULT_LOCALE = 'default';

/**
 * The `mixed` pseudo-locale: every row is independently assigned ONE of the
 * real packs below, so a row is entirely Czech, British, or Japanese and never
 * a blend. It is not a dictionary pack itself (it has no lists/meta of its own),
 * so `dict`/`meta` fall through to `default` if ever asked for it directly — the
 * generators resolve the per-row locale before they call either.
 */
export const MIXED_LOCALE = 'mixed';

/**
 * The packs `mixed` mode draws a per-row locale from. `default` is deliberately
 * excluded — it is the mixed-language corpus, so a row built from it would have
 * no single coherent country. These three each carry a distinct country/phone/
 * postcode identity, which is what makes a mixed row verifiably coherent.
 */
export const MIXED_PACKS = ['cs-CZ', 'en-GB', 'ja-JP'] as const;

/**
 * A pure integer hash of the row index (Murmur3 finaliser). `mixed` mode uses
 * it to choose a row's locale WITHOUT touching the shared row RNG — the whole
 * reason fixed-locale seeded output is unperturbed. Both engines compute it
 * bit-identically over the low 32 bits of the row index.
 */
export function localeHash(rowIdx: number): number {
  let x = rowIdx >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

/**
 * The locale a given row generates under. For any fixed locale this is the
 * identity (so nothing about the fixed-locale path changes); only `mixed`
 * derives a per-row pack, and only from `rowIdx`, never from the RNG.
 */
export function resolveRowLocale(locale: string, rowIdx: number): string {
  if (locale !== MIXED_LOCALE) return locale;
  return MIXED_PACKS[localeHash(rowIdx) % MIXED_PACKS.length];
}

/**
 * Locales the generator UI offers, in menu order. `default` is the original
 * mixed-language corpus (unchanged since Phase 1); the rest are the Phase-2
 * unicode/i18n packs. Each carries a human label for the dropdown; the id is
 * what threads into `dict()` and the generation commands.
 */
export const LOCALES: { id: string; label: string }[] = [
  { id: 'default', label: 'Default (mixed)' },
  { id: 'cs-CZ', label: 'Czech (cs-CZ)' },
  { id: 'en-GB', label: 'British English (en-GB)' },
  { id: 'ja-JP', label: 'Japanese (ja-JP)' },
  // Per-ROW locale: each generated row is wholly one of the packs above, so a
  // row's name/city/company/phone/postcode/country all agree (Phase 4).
  { id: MIXED_LOCALE, label: 'Mixed (per-row country)' },
];

/**
 * The word list for `name` in `locale`, falling back to `default`.
 *
 * Static import is deliberate while the lists are tiny (~13 KB of JSON): it
 * bundles once and needs no async plumbing. When Phase 2's locale packs grow to
 * hundreds of KB each, this is the single seam to swap for a lazy per-locale
 * dynamic import — every caller already goes through here.
 */
export function dict(name: DictName, locale: string = DEFAULT_LOCALE): string[] {
  return (DICTS[locale]?.[name] as string[] | undefined)
    ?? (DICTS[DEFAULT_LOCALE][name] as string[] | undefined)
    ?? [];
}

/**
 * The metadata block for `locale`, falling back to `default`. Every generator
 * that needs a per-country shape (phone, postcode, country, address) reads it,
 * so both engines localise from one source and no format is hard-coded twice.
 */
export function meta(locale: string = DEFAULT_LOCALE): LocaleMeta {
  return (DICTS[locale]?.meta as LocaleMeta | undefined)
    ?? (DICTS[DEFAULT_LOCALE].meta as LocaleMeta);
}
