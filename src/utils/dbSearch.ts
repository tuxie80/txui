/**
 * Searching every table in a schema for a value.
 *
 * The question this answers — *where does this order id appear?* — is one a DBA
 * asks during an incident, and today the only way to answer it is to write a
 * query per table by hand. HeidiSQL has had it for years and it is the single
 * most-reached-for tool the rest of this product lacks.
 *
 * The whole difficulty is deciding **which columns can be searched at all**.
 * Casting every column to text and using LIKE would "work" and would also:
 *   - force a full scan of every table with no chance of an index,
 *   - fail outright on types with no text cast (PostgreSQL arrays, composites),
 *   - and quietly match `2026-08-07` inside a timestamp when the user typed a
 *     number, producing confident nonsense.
 *
 * So the planner picks columns by type, and says which ones it skipped and why.
 * A search that silently ignored half a table would be worse than no search.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

export type SearchMode = 'contains' | 'exact' | 'starts';

export interface SearchColumn {
  name: string;
  typeName: string;
}

export interface SearchTable {
  schema: string;
  name: string;
  columns: SearchColumn[];
  /** Approximate rows, when the catalog knows — used only for ordering. */
  estimatedRows?: number;
}

export interface SearchPlanTable {
  schema: string;
  name: string;
  /** Columns this search will actually look at. */
  columns: string[];
  /** Columns deliberately not searched, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
  sql: string;
}

export interface SearchPlan {
  tables: SearchPlanTable[];
  /** Tables with nothing searchable, so the UI can say so rather than imply zero hits. */
  emptyTables: Array<{ schema: string; name: string; reason: string }>;
}

export interface PlanOptions {
  engine: string;
  needle: string;
  mode?: SearchMode;
  caseSensitive?: boolean;
  /** Rows returned per table. */
  limit?: number;
  /** Also search numeric and date columns by casting them to text. */
  includeNonText?: boolean;
}

export const DEFAULT_LIMIT = 100;

/** Types a LIKE can be applied to directly, on either engine. */
const TEXT_TYPES = /^(char|varchar|text|tinytext|mediumtext|longtext|nchar|nvarchar|character|character varying|citext|name|json|jsonb|xml|uuid|enum|set|inet|cidr|macaddr)/i;

/** Types that can be cast to text meaningfully, if the user asks. */
const CASTABLE = /^(int|integer|bigint|smallint|tinyint|mediumint|numeric|decimal|float|double|real|money|serial|bigserial|bool|boolean|date|time|timestamp|datetime|year|interval)/i;

/**
 * Types that are never searched.
 *
 * Binary columns would match on encoding artefacts rather than content, and
 * arrays and composites have no portable text cast — attempting one turns a
 * whole-schema search into an error on one table.
 */
const NEVER = /^(blob|tinyblob|mediumblob|longblob|bytea|binary|varbinary|image|geometry|geography|point|polygon|bit|_|.*\[\])/i;

export type ColumnVerdict =
  | { search: true; cast: boolean }
  | { search: false; reason: string };

/** Decide whether a column can take part, and how. */
export function classifyColumn(typeName: string, includeNonText: boolean): ColumnVerdict {
  const t = (typeName ?? '').trim();
  if (!t) return { search: false, reason: 'unknown type' };
  if (NEVER.test(t)) return { search: false, reason: `${t} is binary or has no text form` };
  if (TEXT_TYPES.test(t)) return { search: true, cast: false };
  if (CASTABLE.test(t)) {
    return includeNonText
      ? { search: true, cast: true }
      : { search: false, reason: `${t} — enable "search numbers and dates" to include it` };
  }
  return { search: false, reason: `${t} has no reliable text form` };
}

/** Quote an identifier for the engine. */
export function q(name: string, engine: string): string {
  return quoteIdent(name, engine);
}

/**
 * A single-quoted SQL literal.
 *
 * Engine-aware: this used to double backslashes unconditionally, which is
 * right for MySQL and wrong for PostgreSQL — searching for `C:\temp` there
 * became a search for `C:\\temp` and found nothing.
 */
export function lit(value: string, engine: string): string {
  return sqlLiteral(value, engine);
}

/**
 * Escape LIKE's own wildcards in the needle.
 *
 * Searching for `50%` must not match everything starting with 50 — which is
 * exactly what an unescaped `%` does, and it looks like a working search right
 * up until someone trusts the result.
 */
export function escapeLike(needle: string): string {
  return needle.replace(/([\\%_])/g, '\\$1');
}

/** The LIKE pattern for a mode. */
export function patternFor(needle: string, mode: SearchMode): string {
  const e = escapeLike(needle);
  switch (mode) {
    case 'exact':  return e;
    // Plain interpolation. This ran the escaped needle through `errorDisplay`
    // — the error-FORMATTING helper — which happened to return a plain string
    // unchanged, so it worked by coincidence rather than by design. The give
    // away was `exact` not doing it: three modes, two behaviours, one slip.
    case 'starts': return `${e}%`;
    default:       return `%${e}%`;
  }
}

/**
 * Build the SQL for one table.
 *
 * Every searchable column becomes an OR'd predicate, and the matching column
 * is reported alongside the row — knowing a value is *in* a table is half an
 * answer; knowing which column holds it is the other half.
 */
export function tableSql(
  table: SearchTable, columns: string[], casts: Set<string>, opts: PlanOptions,
): string {
  const { engine, needle } = opts;
  const mode = opts.mode ?? 'contains';
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const insensitive = !opts.caseSensitive;
  const pattern = lit(patternFor(needle, mode), engine);
  const qualified = `${q(table.schema, engine)}.${q(table.name, engine)}`;

  const expr = (col: string) => {
    const ref = q(col, engine);
    const base = casts.has(col)
      ? (engine === 'postgres' ? `${ref}::text`
        // Unlengthed nvarchar silently truncates to 30 characters in T-SQL, so
        // a match past character 30 would simply not be found.
        : engine === 'sqlserver' ? `CAST(${ref} AS nvarchar(4000))`
        : `CAST(${ref} AS CHAR)`)
      : ref;
    // The backslash escape character is itself a string literal, and only
    // MySQL treats a backslash as special INSIDE one — hence the doubling
    // there and not elsewhere.
    const esc = engine === 'mysql' ? "ESCAPE '\\\\'" : "ESCAPE '\\'";
    if (!insensitive) {
      // MySQL's and SQL Server's default collations are case-INsensitive, so a
      // case-sensitive search has to say so explicitly or it silently is not.
      // T-SQL has no ILIKE; case is a collation, both ways.
      return engine === 'postgres' ? `${base} LIKE ${pattern} ${esc}`
        : engine === 'sqlserver'
          ? `${base} COLLATE Latin1_General_BIN2 LIKE ${pattern} ${esc}`
          : `${base} COLLATE utf8mb4_bin LIKE ${pattern} ${esc}`;
    }
    // Case-insensitive: PostgreSQL needs ILIKE; SQL Server forces a CI
    // collation rather than trusting the database's, which may be CS.
    return engine === 'postgres' ? `${base} ILIKE ${pattern} ${esc}`
      : engine === 'sqlserver'
        ? `${base} COLLATE Latin1_General_CI_AS LIKE ${pattern} ${esc}`
        : `${base} LIKE ${pattern} ${esc}`;
  };

  const where = columns.map(expr).join(' OR ');
  // The matching column travels with the row, so a hit is actionable.
  const which = columns
    .map(c => `WHEN ${expr(c)} THEN ${lit(c, engine)}`)
    .join(' ');
  // T-SQL caps with TOP at the front; everything else with LIMIT at the end.
  const head = engine === 'sqlserver' ? `SELECT TOP (${limit}) ` : 'SELECT ';
  const tail = engine === 'sqlserver' ? '' : ` LIMIT ${limit}`;
  return `${head}${lit(table.name, engine)} AS __table, CASE ${which} END AS __column, * `
    + `FROM ${qualified} WHERE ${where}${tail}`;
}

/**
 * Plan a whole-schema search.
 *
 * Smallest tables first. A search across a hundred tables should show its first
 * hits immediately rather than after the largest one finishes — and the table
 * you were thinking of is rarely the biggest.
 */
export function planSearch(tables: SearchTable[], opts: PlanOptions): SearchPlan {
  const includeNonText = opts.includeNonText ?? false;
  const out: SearchPlanTable[] = [];
  const emptyTables: SearchPlan['emptyTables'] = [];

  const ordered = [...tables].sort(
    (a, b) => (a.estimatedRows ?? 0) - (b.estimatedRows ?? 0));

  for (const t of ordered) {
    const columns: string[] = [];
    const casts = new Set<string>();
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const c of t.columns) {
      const verdict = classifyColumn(c.typeName, includeNonText);
      if (verdict.search) {
        columns.push(c.name);
        if (verdict.cast) casts.add(c.name);
      } else {
        skipped.push({ name: c.name, reason: verdict.reason });
      }
    }

    if (columns.length === 0) {
      emptyTables.push({
        schema: t.schema, name: t.name,
        reason: t.columns.length === 0
          ? 'no columns'
          : `no searchable columns (${skipped.length} skipped)`,
      });
      continue;
    }
    out.push({
      schema: t.schema, name: t.name, columns, skipped,
      sql: tableSql(t, columns, casts, opts),
    });
  }
  return { tables: out, emptyTables };
}

/** One-line summary of what a plan will do, shown before it runs. */
export function planSummary(plan: SearchPlan): string {
  const tables = plan.tables.length;
  const cols = plan.tables.reduce((n, t) => n + t.columns.length, 0);
  if (tables === 0) return 'Nothing searchable in this schema.';
  const parts = [
    `${tables} table${tables === 1 ? '' : 's'}`,
    `${cols} column${cols === 1 ? '' : 's'}`,
  ];
  if (plan.emptyTables.length) {
    parts.push(`${plan.emptyTables.length} skipped`);
  }
  return parts.join(' · ');
}
