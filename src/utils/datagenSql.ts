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
import { dict, meta, DEFAULT_LOCALE, MIXED_LOCALE } from '../data/dictionaries.ts';

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
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TiB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${(n / 1024).toFixed(0)} KiB`;
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
    case 'sequence': return rowExpr;
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

// ── the statement ───────────────────────────────────────────────────────────

export interface ServerPlan {
  /** One statement per chunk, in order. */
  statements: string[];
  chunks: number;
  chunkRows: number;
  /** Generators with no server-side form — the caller must not pretend. */
  unsupported: { column: string; generator: string }[];
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
): ServerPlan {
  const unsupported: { column: string; generator: string }[] = [];
  const exprs: string[] = [];

  for (const spec of specs) {
    const sql = valueSql(engine, spec.generator, spec, 'i', serverVersionNum, locale);
    if (sql === null) {
      unsupported.push({ column: spec.name, generator: spec.generator });
      continue;
    }
    exprs.push(sql);
  }
  if (unsupported.length > 0) {
    return { statements: [], chunks: 0, chunkRows: 0, unsupported };
  }

  const { chunks, chunkRows } = planChunks(specs, totalRows);
  const cols = specs.map(s => quoteIdent(s.name, engine)).join(', ');
  const statements: string[] = [];

  for (let c = 0; c < chunks; c++) {
    const offset = c * chunkRows;
    const n = Math.min(chunkRows, totalRows - offset);
    const src = rowSource(engine, n, offset);
    // The row source is wrapped so its column is `i` whatever shape it took,
    // and so a MySQL `LIMIT` inside it cannot collide with anything outside.
    statements.push(
      `INSERT INTO ${table} (${cols})\nSELECT ${exprs.join(', ')}\nFROM (${src}) AS src`);
  }

  return { statements, chunks, chunkRows, unsupported: [] };
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
  if (engine !== 'mysql' && engine !== 'postgres' && engine !== 'sqlite'
      && engine !== 'sqlserver') return false;
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
