/**
 * Generating rows **on the server**, so they never cross the wire.
 *
 * The existing generator builds every row in JavaScript and ships them back as
 * multi-row `INSERT` statements. That is the right design up to a few hundred
 * thousand rows and hopeless past it: a hundred million rows is a hundred
 * million values built in a single-threaded VM, serialised into SQL text,
 * pushed through IPC, and parsed again by the server. The machine spends its
 * time on transport and text, and the browser process holds the whole batch.
 *
 * For volume the shape has to change: `INSERT INTO t (…) SELECT <expressions>
 * FROM <a source of N rows>`. The server generates, inserts and never sends
 * anything back. What crosses the wire is one statement per chunk — a few
 * hundred bytes to insert a million rows.
 *
 * ## The three decisions that matter
 *
 * **1. Where the rows come from.** Every engine can produce N rows from
 * nothing, and each does it differently:
 *
 *   - PostgreSQL `generate_series(1, n)` — purpose-built, streams, no limit
 *     worth caring about.
 *   - SQLite a recursive CTE — no depth limit in practice.
 *   - MySQL a **cross join of digit tables**, not a recursive CTE.
 *     `cte_max_recursion_depth` defaults to 1000, so the obvious CTE dies at a
 *     thousand rows; raising it works but recursion is also slow. Seven
 *     cross-joined digit tables give 10^7 rows per chunk with no session
 *     variable to set and nothing to undo.
 *
 * **2. Chunking, and why it is not optional.** One statement inserting a
 * hundred million rows is one transaction: an undo log that grows for an hour,
 * a WAL segment nothing can recycle, a replica that falls an hour behind and
 * then applies it all at once, and a rollback on cancel that takes as long as
 * the insert did. Chunks bound all four, and make progress and cancellation
 * mean something. They are also the only way `Cancel` can leave a usable
 * table rather than an hour of rollback.
 *
 * **3. Determinism is given up, deliberately.** The JS path is seeded and
 * reproducible. `RAND()` on the server is not. That is the trade for volume,
 * and the UI has to say so rather than let someone discover it by diffing two
 * runs.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';
import type { ColumnSpec } from './datagen.ts';
import {
  cycleLength, parenLen, scrambleA, SCRAMBLE_M_CAP, uniqueTagWidth,
  uniqueGroupMembers, validateUniqueGroups,
  CURRENCIES, TIMEZONES,
} from './datagen.ts';
import { dict, meta, DEFAULT_LOCALE, MIXED_LOCALE } from '../data/dictionaries.ts';
import {
  parseFormula, referencedColumns, FORMULA_FUNCTIONS,
} from './datagenFormula.ts';
import type { FormulaNode } from './datagenFormula.ts';

// ── how much ────────────────────────────────────────────────────────────────

export interface Sizing {
  id: string;
  label: string;
  rows: number;
  /** True when this is past what the in-browser path should ever attempt. */
  serverOnly: boolean;
}

/**
 * The ladder.
 *
 * Deliberately reaching absurd numbers: the point of a generator is to make a
 * table big enough that the thing you are testing actually behaves differently,
 * and "a million rows" stopped being that some years ago. The labels are rows,
 * not bytes, because bytes depend on the columns — `estimateBytes` turns the
 * two into a size the UI can show next to the choice.
 */
export const SIZINGS: Sizing[] = [
  { id: 'tiny',    label: '1 000',        rows: 1_000,         serverOnly: false },
  { id: 'small',   label: '10 000',       rows: 10_000,        serverOnly: false },
  { id: 'medium',  label: '100 000',      rows: 100_000,       serverOnly: false },
  { id: 'large',   label: '1 million',    rows: 1_000_000,     serverOnly: true },
  { id: 'xl',      label: '5 million',    rows: 5_000_000,     serverOnly: true },
  { id: 'xxl',     label: '10 million',   rows: 10_000_000,    serverOnly: true },
  { id: 'huge',    label: '25 million',   rows: 25_000_000,    serverOnly: true },
  { id: 'massive', label: '50 million',   rows: 50_000_000,    serverOnly: true },
  { id: 'giant',   label: '100 million',  rows: 100_000_000,   serverOnly: true },
  { id: 'extreme', label: '250 million',  rows: 250_000_000,   serverOnly: true },
  { id: 'absurd',  label: '500 million',  rows: 500_000_000,   serverOnly: true },
  { id: 'billion', label: '1 billion',    rows: 1_000_000_000, serverOnly: true },
  { id: 'ten-billion',     label: '10 billion',    rows: 10_000_000_000,    serverOnly: true },
  { id: 'hundred-billion', label: '100 billion',   rows: 100_000_000_000,   serverOnly: true },
  { id: 'trillion',        label: '1 trillion',    rows: 1_000_000_000_000, serverOnly: true },
];

/** Bytes a column of this type costs per row, roughly. */
function columnBytes(spec: ColumnSpec): number {
  const t = (spec.typeName ?? '').toLowerCase();
  if (/bigint|double|timestamp|datetime/.test(t)) return 8;
  if (/int|float|date/.test(t)) return 4;
  if (/bool|tinyint/.test(t)) return 1;
  if (/uuid/.test(t)) return 16;
  if (/decimal|numeric/.test(t)) return 8;
  const n = /\((\d+)\)/.exec(t);
  if (n) {
    // Half the declared width is a better guess than the whole of it for
    // generated text, and much better than assuming the maximum.
    return Math.max(4, Math.round(Number(n[1]) / 2));
  }
  if (/text|json|blob/.test(t)) return 64;
  return 16;
}

/**
 * Table size for this many rows of these columns.
 *
 * An estimate of the *data*, with a 30% allowance for per-row overhead and
 * page fill. It ignores indexes entirely, which is stated where it is shown —
 * a table with four secondary indexes can easily be twice this.
 */
export function estimateBytes(specs: ColumnSpec[], rows: number): number {
  const perRow = specs.reduce((n, s) => n + columnBytes(s), 0);
  return Math.round(rows * perRow * 1.3);
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 5) return `${(n / 1024 ** 5).toFixed(1)} PiB`;
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TiB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${(n / 1024).toFixed(0)} KiB`;
}

// ── the honesty gate ──────────────────────────────────────────────────────────

/**
 * Past this many rows the Run button arms only after the user types the row
 * count back (the house typed-confirm pattern, as in data compare's APPLY).
 * A billion is a loud choice already; past it the cost has to be *repeated by
 * the user*, not merely shown — and the dialog states the estimated bytes and
 * the ETA range alongside the box.
 */
export const TYPED_CONFIRM_THRESHOLD = 1_000_000_000;

export function needsTypedConfirm(rows: number): boolean {
  return rows > TYPED_CONFIRM_THRESHOLD;
}

/**
 * Rows-per-second envelope for the server path, for the ETA the confirmation
 * dialog states before a very large run. The fast ends are the local-fixture
 * measurements (PostgreSQL ≈ 968k, MySQL ≈ 460k rows/s — see DataGenPanel);
 * the slow ends assume real hardware, real indexes and a busy server. SQL
 * Server is unmeasured, so its envelope is a conservative guess — say so in
 * the comment, never on screen as if it were measured.
 *
 * Deliberately a RANGE: a single number would be a promise, and the honest
 * answer at 10¹¹ rows is "hours, somewhere in this band".
 */
const SERVER_RPS: Record<string, { fast: number; slow: number }> = {
  postgres:  { fast: 1_000_000, slow: 250_000 },
  mysql:     { fast:   500_000, slow: 120_000 },
  sqlserver: { fast:   400_000, slow:  80_000 },   // unmeasured — conservative guess
};

/** Optimistic/pessimistic wall-clock seconds for a server-path run. */
export function etaRangeSeconds(engine: string, rows: number): { lo: number; hi: number } {
  const r = SERVER_RPS[engine] ?? { fast: 500_000, slow: 100_000 };
  return { lo: rows / r.fast, hi: rows / r.slow };
}

/** "17 minutes – 1.1 hours" — the ETA band for the typed-confirm dialog. */
export function etaRangeText(engine: string, rows: number): string {
  const { lo, hi } = etaRangeSeconds(engine, rows);
  const fmt = (s: number) =>
    s >= 3600 ? `${(s / 3600).toFixed(s >= 36_000 ? 0 : 1)} hours`
    : s >= 60 ? `${Math.round(s / 60)} minutes`
    : `${Math.max(1, Math.round(s))} seconds`;
  return `${fmt(lo)} – ${fmt(hi)}`;
}

// ── chunking ────────────────────────────────────────────────────────────────

/**
 * Rows per statement.
 *
 * Big enough that per-statement overhead disappears, small enough that one
 * chunk is a few seconds of work — which is what makes progress meaningful,
 * cancellation prompt, and the undo/WAL footprint bounded. A million rows of a
 * wide table is a large transaction; the width is taken into account.
 */
export function chunkSize(specs: ColumnSpec[], total: number): number {
  const perRow = Math.max(8, specs.reduce((n, s) => n + columnBytes(s), 0));
  // Target roughly 64 MiB of data per chunk.
  const byWidth = Math.floor((64 * 1024 * 1024) / perRow);
  return Math.max(10_000, Math.min(1_000_000, byWidth, Math.max(1, total)));
}

export interface ChunkPlan {
  chunks: number;
  chunkRows: number;
  lastChunkRows: number;
}

export function planChunks(specs: ColumnSpec[], total: number): ChunkPlan {
  const chunkRows = chunkSize(specs, total);
  const chunks = Math.ceil(total / chunkRows);
  const last = total - (chunks - 1) * chunkRows;
  return { chunks, chunkRows, lastChunkRows: chunks === 0 ? 0 : last };
}

// ── the row source ──────────────────────────────────────────────────────────

/**
 * `n` rows of a single column `i`, numbered from `offset + 1`.
 *
 * The offset is what makes a `sequence` column continue across chunks instead
 * of restarting at 1 in every one of them — the bug that turns a primary key
 * into a duplicate-key error on the second chunk.
 */
export function rowSource(engine: string, n: number, offset: number): string {
  const count = Math.max(0, Math.trunc(n));
  const from = Math.max(0, Math.trunc(offset));

  if (engine === 'postgres') {
    return `SELECT gs AS i FROM generate_series(${from + 1}, ${from + count}) AS gs`;
  }
  if (engine === 'sqlserver') {
    // A cross join of the catalog, not a recursive CTE: T-SQL's recursion
    // ceiling is 100 by default and raising it means an OPTION (MAXRECURSION)
    // hint on every generated statement. `sys.all_objects` has a few thousand
    // rows on any instance, so squaring it supplies millions — well past the
    // chunk clamp — and `TOP (n)` is what ends it.
    //
    // `ORDER BY (SELECT NULL)` is the idiom for "I need a row number and I do
    // not care about the order": an ORDER BY on a real column would sort
    // millions of catalog rows for nothing.
    return `SELECT TOP (${count}) ${from} + ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
FROM sys.all_objects a CROSS JOIN sys.all_objects b`;
  }
  if (engine === 'sqlite') {
    // No recursion limit worth planning around, and SQLite has no other way.
    return `WITH RECURSIVE seq(i) AS (
  SELECT ${from + 1}
  UNION ALL SELECT i + 1 FROM seq WHERE i < ${from + count}
) SELECT i FROM seq`;
  }
  // MySQL: a cross join of digit tables, NOT a recursive CTE.
  //
  // `cte_max_recursion_depth` is 1000 by default, so the obvious recursive
  // version fails at a thousand rows — and raising it means setting a session
  // variable the user did not ask for and would have to be put back.
  //
  // The number of digit tables is **derived from the count**, not fixed. A
  // fixed seven gives ten million rows, which happens to exceed today's chunk
  // clamp — so the whole thing works by coincidence, and raising that clamp
  // would silently produce short chunks: an insert that reports success and
  // writes fewer rows than asked, which is the worst shape a bug can take
  // here. One extra table is added beyond the requirement so the LIMIT, not
  // the supply, is always what ends it.
  const tableCount = Math.max(2, Math.ceil(Math.log10(Math.max(10, count))) + 1);
  const digits = 'SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 '
    + 'UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 '
    + 'UNION ALL SELECT 8 UNION ALL SELECT 9';
  const tables = Array.from({ length: tableCount }, (_, k) => `(${digits}) d${k}`).join(' CROSS JOIN ');
  const expr = Array.from({ length: tableCount }, (_, k) => `d${k}.d * ${10 ** k}`).join(' + ');
  // The start is folded into a single literal rather than left as `from + 1`:
  // the statement is read by people when a run goes wrong, and arithmetic in
  // the generated SQL is one more thing to check.
  //
  // The bound is a WHERE on the digit expression, NOT a bare `LIMIT count`:
  // without an ORDER BY, WHICH rows survive a LIMIT is unspecified, so
  // `sequence` values could be non-contiguous and spill past this chunk's
  // range into the next one's — duplicate keys (or silent gaps) at exactly
  // the ≥1M-row sizes this server-side path exists for. The WHERE is
  // deterministic and costs no sort.
  return `SELECT ${from + 1} + (${expr}) AS i FROM ${tables} WHERE (${expr}) < ${count}`;
}

// ── the value expressions ───────────────────────────────────────────────────

/** A random float in [0,1) — the primitive everything else is built on. */
//
// Why there is no per-statement seed here, though two engines almost offer
// one (Phase 2 asked; the answer is a documented refusal, not a half-feature):
//
//   PostgreSQL `setseed(x)` is SESSION state. Run as its own statement it
//   lands on whichever pooled connection happens to pick it up — not
//   necessarily the connection the INSERT then runs on. Folded into the
//   statement as `WITH s AS (SELECT setseed(x)) INSERT … SELECT …, s`, the
//   evaluation order of the CTE against the volatile `random()` calls in the
//   main query is unspecified, so whether the seed is in effect depends on
//   the planner. Both shapes are flaky; neither ships.
//
//   MySQL `RAND(N)` with a constant N is initialised once when the statement
//   is prepared — so it IS repeatable, but per statement: every chunk would
//   draw the identical sequence of values, chunk 2 reproducing chunk 1's
//   randoms exactly (only columns mixed with the row number would differ).
//   Re-seeding per chunk (`RAND(seed + c)`) is expressible, but then "the
//   same seed" means something different from the row-by-row engine's seed,
//   and partial determinism reads as a promise this path does not keep.
//
// So the module-header trade stands: the server path is non-deterministic,
// and the UI says so.
function rnd(engine: string): string {
  if (engine === 'mysql') return 'RAND()';
  if (engine === 'sqlite') return '(ABS(RANDOM()) / 9223372036854775807.0)';
  if (engine === 'sqlserver') {
    // **`RAND()` alone is constant for the whole statement in T-SQL.** It is
    // evaluated once, not once per row, so a generated table comes out with
    // the identical value in all ten million rows — measured on SQL Server
    // 2022, where `SELECT TOP (4) RAND() FROM sys.all_objects` returns four
    // copies of one number. Seeding it from `NEWID()` — which IS evaluated per
    // row — is what makes it vary.
    return 'RAND(CHECKSUM(NEWID()))';
  }
  return 'random()';
}

/** Pick element `k` of a literal list, 1-based, per engine. */
function pickFrom(engine: string, items: string[]): string {
  const lits = items.map(v => sqlLiteral(v, engine));
  const n = items.length;
  if (n === 0) return sqlLiteral('', engine);
  if (engine === 'mysql') {
    return `ELT(1 + FLOOR(${rnd('mysql')} * ${n}), ${lits.join(', ')})`;
  }
  if (engine === 'postgres') {
    return `(ARRAY[${lits.join(', ')}])[1 + floor(${rnd('postgres')} * ${n})::int]`;
  }
  // SQLite has neither ELT nor arrays; JSON1 ships in every build TxUI opens.
  if (engine === 'sqlserver') {
    // Neither obvious form works, and both fail *quietly*:
    //
    //   CHOOSE(1 + ABS(CHECKSUM(NEWID())) % n, …)  → NULL in ~29% of rows.
    //   CASE ABS(CHECKSUM(NEWID())) % n WHEN 0 …   → 1005/666/1329 over 3000
    //                                                rows where uniform is 1000.
    //
    // Both because the index expression is re-evaluated for every branch, and
    // each evaluation draws a fresh NEWID(). CHOOSE falls off the end of the
    // list; CASE lands in its ELSE far too often. Measured on SQL Server 2022,
    // not deduced.
    //
    // Indexing into a JSON array evaluates the draw exactly once — the same
    // shape SQLite's branch below uses, and it measures uniform (1047/972/981).
    const doc = sqlLiteral(JSON.stringify(items), 'sqlserver');
    return `JSON_VALUE(${doc}, '$[' + CAST(ABS(CHECKSUM(NEWID())) % ${n} AS varchar(10)) + ']')`;
  }
  const json = sqlLiteral(JSON.stringify(items), 'sqlite');
  return `json_extract(${json}, '$[' || CAST(ABS(RANDOM()) % ${n} AS TEXT) || ']')`;
}

/** `x mod m` in the engine's spelling — T-SQL and SQLite have no MOD() function. */
function modExpr(engine: string, x: string, m: number): string {
  return engine === 'sqlserver' || engine === 'sqlite' ? `((${x}) % ${m})` : `MOD((${x}), ${m})`;
}

/** A random forward shift in [0, j% of n) — the cycle generator's jitter. */
function jitterShift(engine: string, r: string, jPct: number, n: number): string {
  const f = jPct / 100;
  if (engine === 'postgres') return `floor(${r} * ${f} * ${n})::int`;
  if (engine === 'sqlserver') return `CAST(FLOOR(${r} * ${f} * ${n}) AS int)`;
  if (engine === 'sqlite') return `CAST(${r} * ${f} * ${n} AS INTEGER)`;
  return `FLOOR(${r} * ${f} * ${n})`;
}

/**
 * Element `posExpr` (0-based) of a literal list, per engine — the
 * deterministic twin of `pickFrom`, which draws at random.
 */
function indexFrom(engine: string, items: string[], posExpr: string): string {
  const lits = items.map(v => sqlLiteral(v, engine));
  if (engine === 'mysql') return `ELT((${posExpr}) + 1, ${lits.join(', ')})`;
  if (engine === 'postgres') return `(ARRAY[${lits.join(', ')}])[(${posExpr}) + 1]`;
  if (engine === 'sqlserver') {
    const doc = sqlLiteral(JSON.stringify(items), 'sqlserver');
    return `JSON_VALUE(${doc}, '$[' + CAST((${posExpr}) AS varchar(10)) + ']')`;
  }
  const json = sqlLiteral(JSON.stringify(items), 'sqlite');
  return `json_extract(${json}, '$[' || CAST((${posExpr}) AS TEXT) || ']')`;
}

// Drawn from the SAME shared JSON dictionaries as the in-browser and Rust
// engines — no hand-copied arrays — but capped to a bounded head per list.
//
// The server path inlines these values into an ELT/ARRAY literal that is
// repeated in EVERY chunk statement, so the full 160-name corpus would put a
// few kilobytes of word list into each of a thousand chunks. The whole design
// property here is "a few hundred bytes to insert a million rows" (see the
// module header and its test), and the server tier is non-deterministic
// (`RAND()`) regardless, so a representative head gives plausible variety at a
// fraction of the statement size. Row-by-row runs still use the full corpus.
//
// The head is resolved per `locale` inside `valueSql` (Phase 2): a Czech run
// inlines the head of the Czech lists, `default` inlines exactly what it did
// before locales existed.
const HEAD = 10;

/**
 * Generators whose output depends on the locale. Under `mixed` (per-row pack)
 * they have no faithful set-based SQL form, so they are reported unsupported and
 * the run falls back to the row-by-row engine. (`phone`/`postcode`/`address`
 * have no server form under any locale anyway; they are listed for clarity.)
 */
const LOCALE_AWARE_GENERATORS = new Set([
  'firstName', 'lastName', 'fullName', 'email', 'username',
  'city', 'country', 'countryCode', 'company', 'phone', 'postcode', 'address',
  // Phase-4 personas: under `mixed` these draw from the row's per-row pack
  // (currency/timezone pinned, coordinates inside the pack's bounding box) —
  // as inexpressible set-based as the name lists.
  'currencyCode', 'timezone', 'latitude', 'longitude',
]);

/**
 * The SQL expression for one generator.
 *
 * `null` means this generator has no server-side form, which is a real answer
 * and not a failure — the caller falls back to the in-browser path and says
 * why. Inventing an approximation would produce data that does not match what
 * the same generator produces at smaller sizes, silently.
 */
export function valueSql(
  engine: string, generatorId: string, spec: ColumnSpec, rowExpr = 'i',
  serverVersionNum?: number, locale: string = DEFAULT_LOCALE,
): string | null {
  const r = rnd(engine);
  const p = spec.params;
  const FIRST = dict('firstNames', locale).slice(0, HEAD);
  const LAST = dict('lastNames', locale).slice(0, HEAD);
  const CITIES = dict('cities', locale).slice(0, HEAD);
  const COUNTRIES = dict('countries', locale).slice(0, HEAD);
  const COMPANIES = dict('companies', locale).slice(0, HEAD);
  const WORDS = dict('lorem', locale).slice(0, HEAD);
  const int = (min: number, max: number) =>
    engine === 'postgres'
      ? `(${min} + floor(${r} * ${max - min + 1})::bigint)`
      // FLOOR keeps the float type in T-SQL, so a column typed `int` gets an
      // implicit conversion per row; the CAST makes it explicit and free.
      : engine === 'sqlserver'
      ? `(${min} + CAST(FLOOR(${r} * ${max - min + 1}) AS bigint))`
      : `(${min} + FLOOR(${r} * ${max - min + 1}))`;

  // `mixed` assigns a locale PER ROW (a pure hash of the row index), which a
  // set-based `INSERT … SELECT` cannot express: every locale-aware column would
  // otherwise inline `default`'s head and silently break the per-row coherence
  // the mode exists for. Report those columns unsupported so the caller falls
  // back to the row-by-row engine, which does resolve a per-row pack. Columns
  // with no locale (sequence/int/…) still emit fine and stay coherent.
  if (locale === MIXED_LOCALE && LOCALE_AWARE_GENERATORS.has(generatorId)) return null;

  switch (generatorId) {
    // The row source is 1-based; the in-browser engines count rows from 0, so
    // the stepped form is `1 + (i − 1)·step` — the same values, both tiers.
    case 'sequence': {
      const step = Math.max(1, Math.round(p?.step ?? 1));
      return step === 1 ? rowExpr : `((${rowExpr} - 1) * ${step} + 1)`;
    }
    case 'cycle': {
      // Round-robin: position (i − 1) mod n, where n is the list length or the
      // stepped range size — deterministic, unlike pickFrom's random draw.
      const items = (p?.list ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const j = Math.max(0, p?.jitterPct ?? 0);
      const base = `(${rowExpr} - 1)`;
      const pos = (n: number) => modExpr(engine,
        j > 0 ? `${base} + ${jitterShift(engine, r, j, n)}` : base, n);
      if (items.length) return indexFrom(engine, items, pos(items.length));
      const step = Math.max(1, Math.round(p?.step ?? 1));
      const lo = Math.round(p?.min ?? 1), hi = Math.round(p?.max ?? 1000);
      const n = Math.max(1, Math.floor((hi - lo) / step) + 1);
      return `(${lo} + ${pos(n)} * ${step})`;
    }
    case 'int':      return int(p?.min ?? 1, p?.max ?? 1000);
    case 'decimal': {
      const min = p?.min ?? 0, max = p?.max ?? 1000;
      return engine === 'postgres'
        ? `round((${min} + ${r} * ${max - min})::numeric, 2)`
        : `ROUND(${min} + ${r} * ${max - min}, 2)`;
    }
    case 'bool':
      // T-SQL has no boolean *value*: `SELECT (1 < 2)` is a syntax error, and
      // a `bit` column takes 1/0. Every other engine here accepts the
      // comparison as a value.
      if (engine === 'sqlserver') return `CASE WHEN ${r} < 0.5 THEN 1 ELSE 0 END`;
      return `(${r} < 0.5)`;
    case 'firstName': return pickFrom(engine, FIRST);
    case 'lastName':  return pickFrom(engine, LAST);
    case 'fullName':
      return concat(engine, [pickFrom(engine, FIRST), sqlLiteral(' ', engine), pickFrom(engine, LAST)]);
    case 'city':      return pickFrom(engine, CITIES);
    case 'country':
      // A fixed pack always emits its own country → a clean constant literal
      // (matching the row-by-row engines). The mixed corpus (`default`) keeps
      // the random pick from the head. `mixed` already returned null above.
      return locale === DEFAULT_LOCALE
        ? pickFrom(engine, COUNTRIES)
        : sqlLiteral(meta(locale).countryName, engine);
    case 'countryCode':
      // Only a fixed pack has a single ISO-2 (a constant). `default` draws over
      // the full ISO list, which has no compact set-based form → fall back.
      return locale === DEFAULT_LOCALE ? null : sqlLiteral(meta(locale).countryCode, engine);
    case 'currencyCode':
      // `default` draws from the list (a pickFrom like any other); a fixed
      // pack pins its own currency — a constant. `mixed` returned null above.
      return locale === DEFAULT_LOCALE
        ? pickFrom(engine, CURRENCIES)
        : sqlLiteral(meta(locale).currency, engine);
    case 'timezone':
      return locale === DEFAULT_LOCALE
        ? pickFrom(engine, TIMEZONES)
        : sqlLiteral(meta(locale).timezone, engine);
    case 'company':   return pickFrom(engine, COMPANIES);
    case 'words':     return concat(engine, [pickFrom(engine, WORDS), sqlLiteral(' ', engine), pickFrom(engine, WORDS)]);
    case 'email':
      return concat(engine, [
        pickFrom(engine, FIRST.map(f => f.toLowerCase())),
        sqlLiteral('.', engine),
        castText(engine, rowExpr),
        sqlLiteral('@example.com', engine),
      ]);
    case 'username':
      return concat(engine, [pickFrom(engine, FIRST.map(f => f.toLowerCase())), castText(engine, rowExpr)]);
    case 'choice': {
      const items = (p?.list ?? '').split(',').map(s => s.trim()).filter(Boolean);
      return items.length ? pickFrom(engine, items) : sqlLiteral('', engine);
    }
    case 'uuid':
      // `gen_random_uuid()` became a **core** function in PostgreSQL 13. On 12
      // and earlier it lives in pgcrypto, and calling it on a server without
      // that extension fails mid-run — after earlier chunks have committed.
      //
      // So it is claimed only when the version is known to be 13 or later.
      // Unknown counts as unsupported: the caller falls back to the row-by-row
      // path, which works everywhere, rather than starting something that dies
      // partway through. Every other engine has no built-in at all, and a
      // hand-rolled string that is not really a UUID would be worse than
      // saying no.
      // SQL Server has had NEWID() forever and it is evaluated per row, so
      // there is no version gate and no hand-rolled string to be wary of.
      if (engine === 'sqlserver') return 'NEWID()';
      return engine === 'postgres' && (serverVersionNum ?? 0) >= 130_000
        ? 'gen_random_uuid()'
        : null;
    case 'date':
    case 'timestamp': {
      // The window is the one the user configured, not a fixed guess. A
      // hard-coded five years put generated dates two years past `dateTo` —
      // data that differs from what the same spec produces on the in-browser
      // path, which is precisely the silent divergence the `null` rule above
      // exists to prevent.
      const from = p?.dateFrom ?? '2024-01-01';
      const to = p?.dateTo ?? from;
      const days = Math.max(1, Math.round(
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
      if (engine === 'postgres') {
        const base = `(${sqlLiteral(from, engine)}::timestamp + (floor(${r} * ${days})::int || ' days')::interval)`;
        return generatorId === 'date' ? `(${base})::date` : base;
      }
      if (engine === 'mysql') {
        const base = `DATE_ADD(${sqlLiteral(from, engine)}, INTERVAL FLOOR(${r} * ${days}) DAY)`;
        return generatorId === 'date' ? base : `TIMESTAMP(${base})`;
      }
      if (engine === 'sqlserver') {
        const base = `DATEADD(DAY, CAST(FLOOR(${r} * ${days}) AS int), `
          + `CAST(${sqlLiteral(from, engine)} AS datetime2(0)))`;
        return generatorId === 'date' ? `CAST(${base} AS date)` : base;
      }
      return `date(${sqlLiteral(from, engine)}, '+' || CAST(ABS(RANDOM()) % ${days} AS TEXT) || ' days')`;
    }
    case 'money': {
      const min = p?.min ?? 0, max = p?.max ?? 1000;
      return engine === 'postgres'
        ? `round((${min} + ${r} * ${max - min})::numeric, 2)`
        : `ROUND(${min} + ${r} * ${max - min}, 2)`;
    }
    case 'percent':
      return engine === 'postgres'
        ? `round((${r} * 100)::numeric, 1)`
        : `ROUND(${r} * 100, 1)`;

    // ── geography ────────────────────────────────────────────────────────
    //
    // The same disc as the in-browser generator: `sqrt(random())` for the
    // radius so points are uniform by *area* rather than crowded at the
    // centre, and the longitude offset divided by cos(latitude) because
    // degrees of longitude narrow towards the poles.
    //
    // These two are worth having server-side precisely because coordinates
    // are what people generate ten million of.
    case 'latitude':
    case 'longitude': {
      // Persona bounding box (Phase 4): under a fixed locale the point comes
      // from the pack's box, which is a plain `min + RAND() * span` — happily
      // set-based. (`mixed` already returned null above: the box is per-row.)
      if (locale !== DEFAULT_LOCALE) {
        const m = meta(locale);
        const lo = generatorId === 'latitude' ? m.latMin : m.lonMin;
        // Rounded to kill the f64 subtraction noise (45.6 − 30 → 15.6000…01):
        // the box edges are data, and the emitted statement is read by people.
        const span = Math.round((generatorId === 'latitude' ? m.latMax - m.latMin : m.lonMax - m.lonMin) * 1e10) / 1e10;
        const v = `(${lo} + ${r} * ${span})`;
        return engine === 'postgres' ? `round(${v}::numeric, 6)` : `ROUND(${v}, 6)`;
      }
      const lat = p?.lat ?? 0, lon = p?.lon ?? 0;
      const radDeg = Math.max(0, p?.radiusKm ?? 0) / 111.32;
      // One `r` per call, and this expression uses two draws — that is
      // correct here: latitude and longitude are separate columns and each
      // gets its own independent point. They are not meant to be the same
      // point, which is why the panel offers `latlon` for when they must be.
      const w = `(${radDeg} * sqrt(${r}))`;
      const t = `(2 * ${engine === 'mysql' || engine === 'sqlserver' ? 'PI()' : 'pi()'} * ${r})`;
      if (generatorId === 'latitude') {
        const v = `(${lat} + ${w} * cos(${t}))`;
        return engine === 'postgres' ? `round(${v}::numeric, 6)` : `ROUND(${v}, 6)`;
      }
      const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-6;
      const v = `(${lon} + ${w} * sin(${t}) / ${cosLat})`;
      return engine === 'postgres' ? `round(${v}::numeric, 6)` : `ROUND(${v}, 6)`;
    }

    // ── evenly spaced timestamps ─────────────────────────────────────────
    //
    // Driven by the row number rather than by random, so the series comes out
    // ordered and regular — which is the entire reason to choose a stepped
    // timestamp over a random one. Jitter is deliberately NOT applied here:
    // it would need a random term whose scale depends on the step, and a
    // server-side series that is subtly less regular than the in-browser one
    // is the silent divergence this module refuses elsewhere.
    //
    // **MySQL `TIMESTAMP` columns and daylight saving.** An hourly series over
    // a year crosses the spring-forward gap, and the local times inside it do
    // not exist. MySQL rejects them:
    //
    //     ERROR 1292: Incorrect datetime value: '2024-03-31 02:00:00'
    //
    // on a server whose time zone observes CEST — found by
    // `dev/probe_datagen.mjs`, which now uses DATETIME for exactly this
    // reason. `DATETIME` stores what it is given and is unaffected;
    // `TIMESTAMP` converts through the session zone and has a one-hour hole in
    // it every spring. This is a property of the target column, not of the
    // series, so it is not something this expression can fix — generate into
    // DATETIME, or set the session zone to UTC before running.
    case 'timestampStep':
    case 'dateStep': {
      if ((p?.jitterPct ?? 0) > 0) return null;
      const from = p?.dateFrom ?? '2024-01-01';
      const step = Math.max(1, p?.step ?? 1);
      const unit = (p?.stepUnit ?? 'hour').toUpperCase();
      if (engine === 'postgres') {
        const base = `(${sqlLiteral(from, engine)}::timestamp + (${rowExpr} * ${step})`
          + ` * interval '1 ${unit.toLowerCase()}')`;
        return generatorId === 'dateStep' ? `(${base})::date` : base;
      }
      if (engine === 'mysql') {
        const base = `DATE_ADD(${sqlLiteral(from, engine)}, INTERVAL (${rowExpr} * ${step}) ${unit})`;
        return generatorId === 'dateStep' ? `DATE(${base})` : `TIMESTAMP(${base})`;
      }
      if (engine === 'sqlserver') {
        // DATEADD's unit is a keyword, not a string, and its offset is an int —
        // the row number can exceed 2^31 on a large run, so it is cast rather
        // than left to overflow at the 2.1-billionth row.
        const base = `DATEADD(${unit}, CAST((${rowExpr} * ${step}) AS int), `
          + `CAST(${sqlLiteral(from, engine)} AS datetime2(0)))`;
        return generatorId === 'dateStep' ? `CAST(${base} AS date)` : base;
      }
      return null;
    }

    // Everything else has no faithful server-side form, so it returns null and
    // the caller falls back to the row-by-row (Rust/JS) path rather than emit
    // something that quietly differs at scale. Notable members:
    //   - `regex` — reverse-expanding a pattern needs the seeded RNG in the
    //     exact draw order the row-by-row engines use; an approximation here
    //     would diverge from what the same column produces below 200k rows.
    //   - `iban` — the MOD-97-10 check runs over a 24-digit number, which
    //     overflows native SQL integers; the row-by-row engines compute it
    //     digit-by-digit. Better to fall back than emit invalid IBANs.
    //   - the Phase-3 check-digit identifiers — `ean8`/`ean13`/`upcA`/`gtin14`/
    //     `isbn13` (GS1 mod-10), `creditCard` (Luhn), `bic`, the national IDs
    //     (`czBirthNumber`, `ukNino`, `jpMyNumber`) and the VAT numbers
    //     (`czVat`, `gbVat`, `jpCorporateNumber`). Each carries a checksum whose
    //     digit-by-digit computation (and the `valid` toggle that deliberately
    //     corrupts it) has no faithful set-based SQL form, so they fall back to
    //     the row-by-row engine exactly like `iban`.
    //   - foreign keys, JSON, IPs, phone numbers, and the shaped series (whose
    //     trend is defined across the whole dataset a per-row expression cannot
    //     see).
    default: return null;
  }
}

function concat(engine: string, parts: string[]): string {
  // T-SQL's `+` concatenation returns NULL if any operand is NULL, and
  // propagates a `numeric` type through a string join. CONCAT does neither —
  // it casts and treats NULL as an empty string, which is the behaviour the
  // other engines' generated values already assume.
  if (engine === 'mysql' || engine === 'sqlserver') return `CONCAT(${parts.join(', ')})`;
  return parts.join(' || ');
}

function castText(engine: string, expr: string): string {
  if (engine === 'postgres') return `(${expr})::text`;
  if (engine === 'mysql') return `CAST(${expr} AS CHAR)`;
  // An unlengthed `nvarchar` truncates at 30 characters in a CAST — the single
  // most common way T-SQL loses data silently. The length is always stated.
  if (engine === 'sqlserver') return `CAST(${expr} AS nvarchar(4000))`;
  return `CAST(${expr} AS TEXT)`;
}

// ── uniqueness on the server path ─────────────────────────────────────────────
//
// The row-by-row engines guarantee a `unique` column by construction (the
// multiplicative scramble for numbers, the zero-padded row-index tag for
// strings — see applyUnique in utils/datagen.ts). The server path used to
// ignore the flag entirely and ship duplicates at exactly the sizes uniqueness
// matters for. The constructions are SQL-expressible (MOD + arithmetic), so
// they are spelled here; a generator whose uniqueness has no faithful SQL form
// is refused with a named reason and the run falls back to row-by-row.

/** String generators with a server form the uniqueness tag can hang off. */
const STRING_UNIQUE_SQL = new Set([
  'firstName', 'lastName', 'fullName', 'city', 'country', 'company', 'words', 'choice',
]);

/** Zero-padded row index, width-stable across the run — the sortable tag. */
function padExpr(engine: string, x: string, w: number): string {
  if (engine === 'mysql') return `LPAD(CAST(${x} AS CHAR), ${w}, '0')`;
  if (engine === 'postgres') return `LPAD((${x})::text, ${w}, '0')`;
  // w ≤ 10 (a billion rows is ten digits), so ten literal zeroes always suffice.
  if (engine === 'sqlserver') return `RIGHT('0000000000' + CAST((${x}) AS nvarchar(10)), ${w})`;
  return `substr('0000000000' || CAST((${x}) AS TEXT), -${w})`;
}

/** Why a `unique` column was refused on the server path — for the plan's unsupported list. */
export function uniqueSqlRefusalReason(spec: ColumnSpec, totalRows: number): string {
  const g = spec.generator;
  if (g === 'bool') return 'a boolean has two values';
  if (g === 'cycle') {
    return `a cycle of ${cycleLength(spec.params)} value(s) repeats within ${totalRows.toLocaleString('en-US')} rows`;
  }
  if (g === 'int' || g === 'decimal' || g === 'money' || g === 'percent') {
    return 'the configured range holds a single value';
  }
  return 'uniqueness has no faithful server-side form for this generator';
}

/**
 * The SQL form of the uniqueness construction, wrapped around a column's value
 * expression. `null` means unique cannot be guaranteed server-side — a real
 * answer, not a failure: the caller reports the column (with
 * `uniqueSqlRefusalReason`) and falls back to row-by-row generation rather
 * than silently producing duplicates.
 *
 * The scramble constants and arithmetic are shared with the row-by-row engines
 * (`scrambleA` / `SCRAMBLE_M_CAP` in datagen.ts); a < 2^21 and the 1e9-row cap
 * keep `a·i + b` inside what both an f64 and a bigint represent exactly.
 *
 * `uniqueOffset` is the cross-run continuation base (the existing row count of
 * a fill-existing target — see the uniqueness header in datagen.ts): the row
 * source counts from `1 + offset`, so the scramble and the tag start past the
 * slots previous runs occupied. 0 (the default) emits byte-identical SQL.
 */
export function uniqueSqlWrap(
  engine: string,
  spec: ColumnSpec,
  baseSql: string,
  rowExpr: string,
  totalRows: number,
  seed: number,
  uniqueOffset = 0,
): string | null {
  const g = spec.generator;
  // Already unique by construction: a sequence is the row number; the server
  // email/username forms already carry the row number; a UUID collides on
  // average at 2^61 rows, not at any size this tool generates.
  if (g === 'sequence' || g === 'email' || g === 'username' || g === 'uuid') return baseSql;
  if (g === 'bool') return null;
  // Round-robin is unique exactly while the run fits in one lap.
  if (g === 'cycle') return totalRows <= cycleLength(spec.params) ? baseSql : null;

  const off = Math.max(0, Math.trunc(uniqueOffset));
  // The row source is 1-based; the scramble counts from 0 — and from `off`
  // when continuing a populated table (i_eff = i − 1 + off).
  const i0 = off > 0 ? `(${rowExpr} - 1 + ${off})` : `(${rowExpr} - 1)`;
  if (g === 'int') {
    let lo = Math.round(spec.params.min), hi = Math.round(spec.params.max);
    if (hi < lo) [lo, hi] = [hi, lo];
    const m = Math.max(1, Math.min(hi - lo + 1, SCRAMBLE_M_CAP));
    if (m <= 1) return null;   // a one-value range cannot be unique past row 1
    return scrambleRangeSql(engine, i0, lo, m, seed);
  }
  if (g === 'decimal' || g === 'money' || g === 'percent') {
    const d = g === 'percent' ? 1 : 2;   // the rounding the value arm itself uses
    const lo = g === 'percent' ? 0 : spec.params.min;
    const hi = g === 'percent' ? 100 : spec.params.max;
    const grid = 10 ** d;
    const m = Math.max(1, Math.min(Math.round((hi - lo) * grid) + 1, SCRAMBLE_M_CAP));
    if (m <= 1) return null;
    const scr = scrambleRangeSql(engine, i0, 0, m, seed);
    // A decimal divisor forces float/numeric division — T-SQL's int/int would
    // truncate the fraction away.
    return engine === 'postgres'
      ? `round((${lo} + (${scr})::numeric / ${grid}.0)::numeric, ${d})`
      : `ROUND(${lo} + (${scr}) / ${grid}.0, ${d})`;
  }
  if (STRING_UNIQUE_SQL.has(g)) {
    // Width of the run's last tag — with the continuation base added, so a
    // tag like (offset + total − 1) always fits the padding.
    const w = uniqueTagWidth(totalRows + off);
    let s = concat(engine, [baseSql, sqlLiteral('_', engine), padExpr(engine, i0, w)]);
    // The declared VARCHAR(n) is a hard ceiling: keep the tag and give way at
    // the base's LEFT edge — RIGHT(x, n) of the concatenation does exactly that.
    const max = parenLen(spec.typeName);
    if (max !== null) s = engine === 'sqlite' ? `substr(${s}, -${max})` : `RIGHT(${s}, ${max})`;
    return s;
  }
  return null;
}

/** `lo + ((a·i + b) mod m)` — the multiplicative scramble, in SQL. */
function scrambleRangeSql(engine: string, i0: string, lo: number, m: number, seed: number): string {
  const a = scrambleA(m);
  const b = seed % m;
  return `(${lo} + ${modExpr(engine, `${a} * ${i0} + ${b}`, m)})`;
}

// ── cross-column formulas (Phase 4) ─────────────────────────────────────────
//
// A `formula` column's expression references EARLIER columns of the same row.
// On the server path those references resolve to the aliases of a wrapping
// subquery (buildServerPlan emits the two-level form only when a formula is
// present) — NEVER to an inlined copy of the referenced column's expression,
// which would draw fresh RAND()s and produce a `total` that disagrees with
// the `price`/`qty` actually inserted: the exact anti-correlation the
// generator exists to avoid.
//
// The expressible subset: literals, refs, + - * / % (numeric), || (concat),
// and the FORMULA_FUNCTIONS whose `sql` flag is set — with `+` claimed only
// when static kinds decide its runtime branch (both numbers → add; a known
// string on either side → concat) and `substr` only with non-negative integer
// literal bounds. Anything else returns null → the column is reported
// unsupported and the run falls back to the row-by-row engine.

/** The static value kind of a referenced column, from its generator. */
type FormulaKind = 'num' | 'str' | 'bool' | 'unknown';

const NUMERIC_GENERATORS = new Set([
  'sequence', 'int', 'decimal', 'money', 'percent', 'rating', 'bitflags',
  'series', 'seriesInt', 'randomWalk', 'epoch', 'durationSec',
  'latitude', 'longitude', 'altitude',
  'rideCarId', 'rideLat', 'rideLon', 'rideSpeed', 'rideHeading', 'httpStatus',
]);

/**
 * What a column's generator produces. `fk`/`formula` are unknown (a pool value
 * or a computed one). Everything unlisted produces strings — including
 * `choice`/`regex`, whose values ARE strings at runtime even when they look
 * numeric, so `+` on them concatenates on both paths (and arithmetic on them
 * is refused here, falling back to the row engine's strict parse).
 */
function formulaRefKind(generatorId: string): FormulaKind {
  if (NUMERIC_GENERATORS.has(generatorId)) return 'num';
  if (generatorId === 'bool') return 'bool';
  if (generatorId === 'fk' || generatorId === 'formula') return 'unknown';
  return 'str';
}

/**
 * The SQL expression for a parsed formula. `ref(name)` resolves a column to
 * its wrapping-subquery alias and static kind, or null when it cannot be
 * referenced (unknown/later column, another formula column, or a column with
 * no SQL form of its own). Returns null when the expression is outside the
 * expressible subset — the caller reports it unsupported WITH the reason.
 */
export function formulaSql(
  engine: string,
  node: FormulaNode,
  ref: (name: string) => { sql: string; kind: FormulaKind } | null,
): string | null {
  /** The node, its SQL and its kind — or null when inexpressible. */
  function go(n: FormulaNode): { sql: string; kind: FormulaKind } | null {
    switch (n.t) {
      case 'num': return { sql: String(n.v), kind: 'num' };
      case 'str': return { sql: sqlLiteral(n.v, engine), kind: 'str' };
      case 'col': return ref(n.name);
      case 'neg': {
        const a = go(n.a);
        return a && a.kind === 'num' ? { sql: `(-(${a.sql}))`, kind: 'num' } : null;
      }
      case 'bin': {
        const a = go(n.a), b = go(n.b);
        if (!a || !b) return null;
        const bothNum = a.kind === 'num' && b.kind === 'num';
        // Concatenation: NULL propagates in PG/MySQL/SQLite (matching the row
        // engines); T-SQL's CONCAT maps NULL to '', so a concat formula is
        // unsupported there rather than silently different.
        const cat = (): { sql: string; kind: FormulaKind } | null => {
          if (engine === 'sqlserver') return null;
          if (a.kind === 'bool' || b.kind === 'bool' || a.kind === 'unknown' || b.kind === 'unknown') return null;
          const asText = (x: { sql: string; kind: FormulaKind }) =>
            x.kind === 'num' ? castText(engine, x.sql) : x.sql;
          return { sql: concat(engine, [asText(a), asText(b)]), kind: 'str' };
        };
        switch (n.op) {
          case '||': return cat();
          case '+':
            // The runtime branch (add vs concat) is decided per row from the
            // values; SQL can only commit when the static kinds decide it too.
            if (bothNum) return { sql: `(${a.sql} + ${b.sql})`, kind: 'num' };
            if (a.kind === 'str' || b.kind === 'str') return cat();
            return null;
          case '-': return bothNum ? { sql: `(${a.sql} - ${b.sql})`, kind: 'num' } : null;
          case '*': return bothNum ? { sql: `(${a.sql} * ${b.sql})`, kind: 'num' } : null;
          // NULLIF guards division/remainder by zero: the row engines yield
          // NULL there, and a bare `/` would ERROR mid-run on PostgreSQL.
          case '/': return bothNum ? { sql: `(${a.sql} / NULLIF(${b.sql}, 0))`, kind: 'num' } : null;
          case '%': {
            if (!bothNum) return null;
            const denom = `NULLIF(${b.sql}, 0)`;
            return {
              sql: engine === 'sqlserver' || engine === 'sqlite'
                ? `((${a.sql}) % ${denom})`
                : `MOD((${a.sql}), ${denom})`,
              kind: 'num',
            };
          }
        }
        return null;
      }
      case 'fn': {
        if (!FORMULA_FUNCTIONS[n.name]?.sql) return null;   // e.g. slugify
        const args = n.args.map(go);
        if (args.some(x => x === null)) return null;
        const a = args as { sql: string; kind: FormulaKind }[];
        const numArgs = a.every(x => x.kind === 'num');
        const asStr = (x: { sql: string; kind: FormulaKind }) =>
          x.kind === 'str' ? x.sql : x.kind === 'num' ? castText(engine, x.sql) : null;
        switch (n.name) {
          case 'abs':
            return numArgs ? { sql: `ABS(${a[0].sql})`, kind: 'num' } : null;
          case 'round': {
            if (!numArgs) return null;
            if (a.length === 1) {
              return { sql: engine === 'sqlserver' ? `ROUND(${a[0].sql}, 0)` : `ROUND(${a[0].sql})`, kind: 'num' };
            }
            // PG's two-arg round exists only for numeric, so cast explicitly.
            return { sql: engine === 'postgres' ? `round((${a[0].sql})::numeric, ${a[1].sql})` : `ROUND(${a[0].sql}, ${a[1].sql})`, kind: 'num' };
          }
          case 'floor':
            return numArgs ? { sql: `FLOOR(${a[0].sql})`, kind: 'num' } : null;
          case 'ceil':
            return numArgs
              ? { sql: `${engine === 'sqlite' ? 'CEIL' : 'CEILING'}(${a[0].sql})`, kind: 'num' }
              : null;
          case 'min': case 'max': {
            if (!numArgs) return null;
            // MySQL LEAST/GREATEST and SQLite's multi-arg min/max propagate
            // NULL like the row engines; PostgreSQL's and SQL Server's IGNORE
            // NULLs, so the CASE restores the row engines' answer.
            const f = n.name === 'min' ? 'LEAST' : 'GREATEST';
            const list = a.map(x => x.sql).join(', ');
            const core = engine === 'sqlite'
              ? `${n.name}(${list})`
              : `${f}(${list})`;
            if (engine === 'mysql' || engine === 'sqlite') return { sql: core, kind: 'num' };
            const guard = a.map(x => `${x.sql} IS NULL`).join(' OR ');
            return { sql: `(CASE WHEN ${guard} THEN NULL ELSE ${core} END)`, kind: 'num' };
          }
          case 'length': {
            const s = asStr(a[0]);
            if (s === null) return null;
            const f = engine === 'mysql' ? 'CHAR_LENGTH' : engine === 'sqlserver' ? 'LEN' : 'LENGTH';
            return { sql: `${f}(${s})`, kind: 'num' };
          }
          case 'upper': case 'lower': {
            const s = asStr(a[0]);
            return s === null ? null : { sql: `${n.name.toUpperCase()}(${s})`, kind: 'str' };
          }
          case 'substr': {
            // Literal, non-negative integer bounds only: the runtime clamps
            // computed/negative starts, and each SQL engine does something
            // different with them — refuse rather than pick one.
            const s = asStr(a[0]);
            const start = n.args[1];
            const len = n.args[2];
            if (s === null) return null;
            if (start.t !== 'num' || !Number.isInteger(start.v) || start.v < 1) return null;
            if (len !== undefined && (len.t !== 'num' || !Number.isInteger(len.v) || len.v < 0)) return null;
            const f = engine === 'sqlite' ? 'substr' : 'SUBSTRING';
            const lenV = len && len.t === 'num' ? len.v : undefined;
            return {
              sql: lenV === undefined ? `${f}(${s}, ${start.v})` : `${f}(${s}, ${start.v}, ${lenV})`,
              kind: 'str',
            };
          }
          case 'coalesce':
            // Mixed kinds coerce inside the DB — the honest approximation the
            // non-deterministic server tier already allows.
            return { sql: `COALESCE(${a.map(x => x.sql).join(', ')})`, kind: 'unknown' };
          default:
            return null;
        }
      }
    }
  }
  return go(node)?.sql ?? null;
}

// ── the statement ───────────────────────────────────────────────────────────

export interface ServerPlan {
  /**
   * One statement per chunk, in order. Lazily materialised: a 1e12-row run is
   * a million chunks, and building a million statements up front is the
   * better part of a gigabyte of strings held for the whole run. Callers
   * looping over chunks should use `statementAt(c)`; this view exists for the
   * callers (tests) that genuinely iterate all of them.
   */
  statements: string[];
  /** The statement for chunk `c` (0-based), built on demand. */
  statementAt(c: number): string;
  chunks: number;
  chunkRows: number;
  /** Generators with no server-side form — the caller must not pretend.
   *  `reason` is set when the generator HAS a SQL form but the column's
   *  `unique` flag does not — the run falls back to row-by-row, which can
   *  guarantee uniqueness, rather than shipping silent duplicates. */
  unsupported: { column: string; generator: string; reason?: string }[];
}

/**
 * Build the chunked `INSERT … SELECT`.
 *
 * Returns `unsupported` rather than throwing when a column's generator has no
 * SQL form: the caller decides whether to fall back to the row-by-row path or
 * ask the user to choose a different generator, and either way the reason is
 * nameable.
 */
export function buildServerPlan(
  engine: string,
  table: string,
  specs: ColumnSpec[],
  totalRows: number,
  /** `server_version_num`, when known. Absent means "assume the oldest". */
  serverVersionNum?: number,
  /** Dictionary pack the name/place/company columns inline. */
  locale: string = DEFAULT_LOCALE,
  /** Seeds the uniqueness permutation (the scramble's b). The server path is
   *  non-deterministic anyway; this just decorrelates runs. */
  seed = 0,
  /** Cross-run continuation base: the existing row count of a fill-existing
   *  target. Unique scrambles/tags start at row i + offset; 0 (default) is
   *  byte-identical to the offset-less plan. */
  uniqueOffset = 0,
): ServerPlan {
  const unsupported: { column: string; generator: string; reason?: string }[] = [];
  const exprs: string[] = [];
  const hasFormula = specs.some(s => s.generator === 'formula');
  // The inner SELECT's aliased base expressions — only populated (and only
  // emitted) when a formula column needs them.
  const inner: { alias: string; sql: string }[] = [];

  // Composite uniqueness groups: a config error (single-member group, an
  // anchor that cannot carry uniqueness, a member with the flag off) refuses
  // the server plan with the reason — the run falls back to the row-by-row
  // engine, whose validate_unique_groups rejects it by name before a row is
  // written. A VALID group's non-anchor members generate freely (no wrap);
  // the anchor alone carries the uniqueness, so the combination is unique.
  for (const p of validateUniqueGroups(specs)) {
    unsupported.push({
      column: p.column,
      generator: specs.find(s => s.name === p.column)?.generator ?? 'unknown',
      reason: p.reason,
    });
  }
  const freeMembers = uniqueGroupMembers(specs);
  // Row-index-driven generators whose server spelling embeds the row number:
  // on a continuation run (offset > 0) the number must count past the rows
  // already in the table, or the "already unique by construction" passthrough
  // would collide with exactly them.
  const off = Math.max(0, Math.trunc(uniqueOffset));
  const ROW_NUMBER_GENS = new Set(['sequence', 'email', 'username']);
  const rowExprFor = (i: number, spec: ColumnSpec) =>
    spec.unique && off > 0 && !freeMembers.has(i) && ROW_NUMBER_GENS.has(spec.generator)
      ? `(i + ${off})` : 'i';

  if (!hasFormula) {
    for (let si = 0; si < specs.length; si++) {
      const spec = specs[si];
      const sql = valueSql(engine, spec.generator, spec, rowExprFor(si, spec), serverVersionNum, locale);
      if (sql === null) {
        unsupported.push({ column: spec.name, generator: spec.generator });
        continue;
      }
      if (spec.unique && !freeMembers.has(si)) {
        const wrapped = uniqueSqlWrap(engine, spec, sql, 'i', totalRows, seed, off);
        if (wrapped === null) {
          unsupported.push({
            column: spec.name, generator: spec.generator,
            reason: uniqueSqlRefusalReason(spec, totalRows),
          });
          continue;
        }
        exprs.push(wrapped);
        continue;
      }
      exprs.push(sql);
    }
  } else {
    // With formula columns the statement is TWO levels: an inner SELECT
    // computes every non-formula column ONCE under an alias, and the outer
    // SELECT references those aliases — so the values a formula reads are the
    // values actually inserted (inlining a referenced column's expression
    // would draw fresh RAND()s and corrupt the very correlation the formula
    // exists to create).
    const refByName = new Map<string, { sql: string; kind: FormulaKind }>();
    const formulas: { idx: number; spec: ColumnSpec }[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (spec.generator === 'formula') { formulas.push({ idx: i, spec }); continue; }
      const sql = valueSql(engine, spec.generator, spec, rowExprFor(i, spec), serverVersionNum, locale);
      if (sql === null) {
        unsupported.push({ column: spec.name, generator: spec.generator });
        continue;
      }
      let final = sql;
      if (spec.unique && !freeMembers.has(i)) {
        const wrapped = uniqueSqlWrap(engine, spec, sql, 'i', totalRows, seed, off);
        if (wrapped === null) {
          unsupported.push({
            column: spec.name, generator: spec.generator,
            reason: uniqueSqlRefusalReason(spec, totalRows),
          });
          continue;
        }
        final = wrapped;
      }
      const alias = `c${i}`;
      inner.push({ alias, sql: final });
      refByName.set(spec.name, { sql: `s.${alias}`, kind: formulaRefKind(spec.generator) });
      exprs[i] = `s.${alias}`;
    }
    const allNames = specs.map(s => s.name);
    for (const { idx, spec } of formulas) {
      const src = spec.params.expr ?? '';
      const parsed = parseFormula(src);
      if (!parsed.ok) {
        unsupported.push({ column: spec.name, generator: 'formula', reason: parsed.error });
        continue;
      }
      // A formula may reference an earlier FORMULA column on the row-by-row
      // paths; on the server path that value lives in no subquery, so it is
      // refused by name rather than dropped into a wrong statement.
      const viaFormula = referencedColumns(parsed.ast)
        .find(n => specs.find(s2 => s2.name === n)?.generator === 'formula');
      if (viaFormula) {
        unsupported.push({
          column: spec.name, generator: 'formula',
          reason: `"${viaFormula}" is itself a formula — not SQL-expressible; the run falls back to row-by-row`,
        });
        continue;
      }
      // Unknown/later column references — the same config error the panel
      // shows inline, here as the refusal reason.
      const earlier = new Set(specs.slice(0, idx).map(s => s.name));
      const badRef = referencedColumns(parsed.ast).find(n => !earlier.has(n));
      if (badRef) {
        unsupported.push({
          column: spec.name, generator: 'formula',
          reason: allNames.includes(badRef)
            ? `"${badRef}" is not an earlier column`
            : `unknown column "${badRef}"`,
        });
        continue;
      }
      const sql = formulaSql(engine, parsed.ast, name => refByName.get(name) ?? null);
      if (sql === null) {
        unsupported.push({
          column: spec.name, generator: 'formula',
          reason: 'the expression is outside the SQL-expressible subset; the run falls back to row-by-row',
        });
        continue;
      }
      // unique is NOT applied to formula columns on any path (applyUnique /
      // gen_row pass them through) — the expression decides the value.
      exprs[idx] = sql;
    }
  }
  if (unsupported.length > 0) {
    return { statements: [], statementAt: () => '', chunks: 0, chunkRows: 0, unsupported };
  }

  const { chunks, chunkRows } = planChunks(specs, totalRows);
  const cols = specs.map(s => quoteIdent(s.name, engine)).join(', ');

  // The arithmetic stays exact at the uncapped sizes: totals are capped at
  // 1e15 by the panel (see MAX_ROWS there), comfortably under 2^53 ≈ 9.0e15,
  // so `c * chunkRows` and `totalRows - offset` are exact f64 integers. Counts
  // only — a row's identity is never carried in an f64 anywhere.
  const at = (c: number): string => {
    const offset = c * chunkRows;
    const n = Math.min(chunkRows, totalRows - offset);
    const src = rowSource(engine, n, offset);
    // The row source is wrapped so its column is `i` whatever shape it took,
    // and so a MySQL `LIMIT` inside it cannot collide with anything outside.
    if (!hasFormula) {
      return `INSERT INTO ${table} (${cols})\nSELECT ${exprs.join(', ')}\nFROM (${src}) AS src`;
    }
    const innerSql = inner.map(x => `${x.sql} AS ${x.alias}`).join(', ');
    // No base columns at all (every column is a formula over literals): no
    // inner level is needed — such formulas reference nothing by definition.
    if (inner.length === 0) {
      return `INSERT INTO ${table} (${cols})\nSELECT ${exprs.join(', ')}\nFROM (${src}) AS src`;
    }
    return `INSERT INTO ${table} (${cols})\nSELECT ${exprs.join(', ')}\n`
      + `FROM (SELECT ${innerSql} FROM (${src}) AS src) AS s`;
  };

  let cached: string[] | null = null;
  return {
    get statements() { return cached ??= Array.from({ length: chunks }, (_, c) => at(c)); },
    statementAt: at,
    chunks,
    chunkRows,
    unsupported: [],
  };
}

/**
 * Should this run server-side?
 *
 * The in-browser generator is reproducible and supports every generator, so it
 * stays the default for sizes where it is fast enough. Past that the transport
 * cost dominates and the choice makes itself.
 */
export const SERVER_THRESHOLD = 200_000;

export function shouldUseServer(engine: string, rows: number): boolean {
  // SQLite is deliberately NOT here: its panel capability is off (the
  // row-by-row writer has no SQLite arm, so the panel could only ever work
  // past 200k rows — half a panel), which made this arm unreachable dead code.
  // The rowSource/valueSql SQLite forms stay as tested library functions; the
  // routing decision is what must not drift.
  if (engine !== 'mysql' && engine !== 'postgres' && engine !== 'sqlserver') return false;
  return rows >= SERVER_THRESHOLD;
}

/**
 * How many rows a row source can supply — for the invariant that the `LIMIT`,
 * not the supply, is what ends a chunk.
 *
 * Only MySQL has a ceiling that can be computed here (the cross join produces
 * exactly 10^tables rows); the others are unbounded. Exported so a test can
 * assert the relationship rather than trusting that two constants happen to
 * line up.
 *
 * SQL Server's source is `sys.all_objects` crossed with itself, whose size is a
 * property of the *instance* rather than of the statement — a few thousand
 * objects squared is millions of rows, far past the chunk clamp, but it is not
 * knowable from here. Treated as unbounded, because a number invented at build
 * time would be a worse answer than none: the `TOP (n)` is what ends the source
 * either way.
 */
export function rowSourceCapacity(engine: string, requested: number): number {
  if (engine !== 'mysql') return Number.POSITIVE_INFINITY;
  const count = Math.max(0, Math.trunc(requested));
  const tableCount = Math.max(2, Math.ceil(Math.log10(Math.max(10, count))) + 1);
  return 10 ** tableCount;
}
