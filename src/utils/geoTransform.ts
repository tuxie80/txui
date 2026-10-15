/**
 * "View in WGS 84" — the derived-query builder behind the map's transform
 * button (PostgreSQL/PostGIS only).
 *
 * When a result's geometry column is in a projected CRS, the map refuses to
 * plot it (projected metres are not degrees). The escape hatch is an EXPLICIT
 * user action that runs a new query derived from the one on screen:
 *
 * ```sql
 * SELECT "id", "name", ST_AsEWKB(ST_Transform("geom", 4326)) AS "geom"
 * FROM (
 *   <the original query, verbatim>
 * ) AS txui_geo_src
 * ```
 *
 * Why this shape:
 *
 *  - The original text goes in UNTOUCHED as a subselect — CTEs, ORDER BY,
 *    LIMIT, parenthesised SELECTs all survive wrapping, because PostgreSQL
 *    accepts all of them in a FROM subquery. No rewriting of the user's SQL
 *    means nothing to get silently wrong.
 *  - The outer SELECT list is built from the result's column metadata, so
 *    only the detected geometry column is transformed and every other column
 *    passes through byte-identical — including a SECOND geometry column,
 *    which stays in its own CRS (transforming both would be a decision the
 *    user did not make).
 *  - ST_AsEWKB keeps the SRID in the payload, so the hex decodes client-side
 *    through the exact same parseWkbHex path as any other PostGIS result and
 *    isLonLat sees the 4326.
 *
 * Geography columns need none of this — PostGIS geography is always stored
 * lon/lat, so a geography column never reaches the refusal path this action
 * lives on.
 *
 * Refusal is a first-class outcome, never a broken query: multiple
 * statements, non-SELECT families, a geometry column the metadata does not
 * name, and duplicate column names (ambiguous in the outer SELECT) all come
 * back as `ok: false` with the reason the UI shows.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { quoteIdent } from './sqlIdent.ts';
import { splitStatements } from './sqlSplit.ts';

export type TransformQuery =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

/** The first real keyword, skipping leading line/block comments. '' when the
 *  text starts with something that is not a word (e.g. a parenthesis). */
function firstKeyword(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.trimStart();
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n');
      if (nl < 0) return '';
      s = t.slice(nl + 1);
      continue;
    }
    if (t.startsWith('/*')) {
      const end = t.indexOf('*/', 2);
      if (end < 0) return '';
      s = t.slice(end + 2);
      continue;
    }
    const m = /^[a-zA-Z]+/.exec(t);
    return m ? m[0].toLowerCase() : '';
  }
}

/** The statement forms PostgreSQL accepts as a FROM subquery. EXPLAIN / SHOW /
 *  SET are read-family but cannot be wrapped — the list is deliberate. A
 *  leading '(' is a parenthesised select-statement, also legal as a subquery. */
function wrappable(sql: string): boolean {
  if (sql.trimStart().startsWith('(')) return true;
  return ['select', 'with', 'table', 'values'].includes(firstKeyword(sql));
}

/** Strip trailing statement terminators and the whitespace around them.
 *  A trailing `-- comment` keeps its line: the wrapper puts the closing
 *  paren on a NEW line, so the comment cannot eat it. */
function unterminate(sql: string): string {
  let s = sql.trim();
  while (s.endsWith(';')) s = s.slice(0, -1).trimEnd();
  return s;
}

/**
 * Build the derived "transformed to WGS 84" query, or refuse with a reason.
 *
 * @param sql     the query text that produced the result on screen
 * @param columns the result's column names, in order
 * @param geomCol the detected geometry column to transform (others pass through)
 */
export function buildTransformQuery(sql: string, columns: string[], geomCol: string): TransformQuery {
  // One runnable statement only. Comment-only chunks are not statements for
  // this purpose (a trailing `-- done` must not turn one query into "two");
  // the wrapper takes the runnable statement's own text, so nothing after a
  // top-level `;` — comment or second query — can leak into the subquery.
  const runnable = splitStatements(sql)
    .filter(s => firstKeyword(s.text) !== '' || s.text.trimStart().startsWith('('));
  if (runnable.length !== 1) {
    return { ok: false, reason: `the editor holds ${runnable.length} statements — run the one you want transformed, then map it` };
  }
  const body = unterminate(runnable[0].text);
  if (!body) return { ok: false, reason: 'there is no query text to derive from' };
  if (!wrappable(body)) {
    return { ok: false, reason: 'only a SELECT-family statement can be wrapped as a subquery' };
  }
  if (!columns.includes(geomCol)) {
    return { ok: false, reason: `the result has no column named "${geomCol}"` };
  }
  // `SELECT "x" FROM (… two columns both named x …)` is ambiguous in
  // PostgreSQL — a runtime error, which the user reads as the action being
  // broken. Caught here instead.
  const dup = columns.find((c, i) => columns.indexOf(c) !== i);
  if (dup !== undefined) {
    return { ok: false, reason: `the result has two columns named "${dup}" — alias one in the query first` };
  }

  const q = (name: string) => quoteIdent(name, 'postgres');
  const selectList = columns
    .map(c => (c === geomCol ? `ST_AsEWKB(ST_Transform(${q(c)}, 4326)) AS ${q(c)}` : q(c)))
    .join(', ');
  return {
    ok: true,
    sql: `SELECT ${selectList}\nFROM (\n${body}\n) AS txui_geo_src`,
  };
}
