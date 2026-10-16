/**
 * SQL Server UDT display — the derived-query builder.
 *
 * A `geometry`/`geography`/`hierarchyid` column arrives through the vendored
 * tiberius as raw MS-SSCLRT bytes, which the grid renders as
 * `<udt: N bytes — not decodable; wrap with .ToString()>`. This module builds
 * the wrap the placeholder advertises: the user's SELECT becomes a derived
 * table and each UDT column is replaced by a decodable projection of it.
 *
 * Two modes:
 *
 *   - **wkb** (preferred): `col.STAsBinary()` → varbinary(max) → the backend
 *     renders `0x…` hex, which `parseWkbHex` already eats — the geometry
 *     badge, the cell viewer's drawn shape and the Map tab all light up with
 *     no new decode code. geometry and geography both have STAsBinary.
 *   - **wkt**: `col.ToString()` → nvarchar WKT. The frontend has no WKT
 *     parser, so this is a readable text view only — but it is the mode that
 *     also covers hierarchyid, which has no STAsBinary (a wkb wrap over a
 *     hierarchyid column fails with Msg 195 and the caller offers wkt).
 *
 * Execution goes through the normal query path — this module only builds SQL.
 * The result is deliberately honest about its strategy and clause handling so
 * the caller can log the derivation next to the run.
 */
import { quoteIdent } from './sqlIdent.ts';

export interface ColumnLike { name: string; typeName: string }

export type UdtViewMode = 'wkb' | 'wkt';

export interface UdtDerivedQuery {
  sql: string;
  /**
   * substitute: every column re-projected by name, UDT columns replaced by
   *   their method call under the same alias — needs unique, non-empty column
   *   names (a T-SQL derived table requires them).
   * append: `t.*` plus the decoded columns added as `<name>_wkb` / `<name>_wkt`
   *   — the raw `<udt: …>` placeholder column stays, honestly, beside the
   *   decoded one. Used when names are duplicated or unnamed.
   */
  strategy: 'substitute' | 'append';
  /** The UDT column names that were wrapped. */
  wrapped: string[];
  /** Clauses moved out of the derived table ('OPTION') or made legal inside
   *  it ('ORDER BY … OFFSET 0 ROWS'). */
  clauseNotes: string[];
}

export type UdtDerivedResult =
  | { ok: true; query: UdtDerivedQuery; logLine: string }
  | { ok: false; reason: string };

const DERIVED_ALIAS = 'txui_geo';

/** The columns of a result set that tiberius labelled CLR UDTs. */
export function udtColumnNames(columns: readonly ColumnLike[]): string[] {
  return columns.filter(c => c.typeName === 'udt').map(c => c.name);
}

// ── top-level scanner ─────────────────────────────────────────────────────────

interface TopLevelScan {
  /** Top-level semicolons (statement separators). */
  semicolons: number[];
  /** Position of the last top-level ORDER BY's `order`. */
  orderBy: number | null;
  /** Does a top-level OFFSET/FETCH follow that ORDER BY? */
  orderByHasOffsetFetch: boolean;
  /** Position of a top-level OPTION clause. */
  option: number | null;
  /** FOR XML / FOR JSON at the top level — illegal inside a derived table. */
  forClause: boolean;
  /** The first word of the statement, lower-cased. */
  firstWord: string;
}

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/**
 * One pass over the statement, skipping T-SQL strings ('' escape — T-SQL has
 * no backslash escapes), bracket and double-quote identifiers, `--` comments
 * and nestable block comments, tracking paren depth. Everything reported is
 * at depth 0.
 */
function scanTopLevel(sql: string): TopLevelScan {
  const scan: TopLevelScan = {
    semicolons: [], orderBy: null, orderByHasOffsetFetch: false,
    option: null, forClause: false, firstWord: '',
  };
  const n = sql.length;
  let i = 0;
  let depth = 0;
  let afterOrderBy = false;

  const readWord = (at: number): { word: string; end: number } => {
    let end = at;
    while (end < n && isWordChar(sql[end])) end++;
    return { word: sql.slice(at, end).toLowerCase(), end };
  };

  /** Skip whitespace and comments; returns the next real position. */
  const skipTrivia = (at: number): number => {
    let j = at;
    for (;;) {
      while (j < n && /\s/.test(sql[j])) j++;
      if (sql[j] === '-' && sql[j + 1] === '-') {
        const eol = sql.indexOf('\n', j + 2);
        j = eol < 0 ? n : eol + 1;
      } else if (sql[j] === '/' && sql[j + 1] === '*') {
        let d = 1;
        j += 2;
        while (j < n && d > 0) {
          if (sql[j] === '/' && sql[j + 1] === '*') { d++; j += 2; }
          else if (sql[j] === '*' && sql[j + 1] === '/') { d--; j += 2; }
          else j++;
        }
      } else {
        return j;
      }
    }
  };

  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '[') {
      i++;
      while (i < n) {
        if (sql[i] === ']') {
          if (sql[i + 1] === ']') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { i = skipTrivia(i); continue; }
    if (c === '/' && sql[i + 1] === '*') { i = skipTrivia(i); continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && c === ';') { scan.semicolons.push(i); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      const { word, end } = readWord(i);
      if (depth === 0) {
        if (scan.firstWord === '') scan.firstWord = word;
        if (word === 'order') {
          const j = skipTrivia(end);
          const next = readWord(j);
          if (next.word === 'by') {
            scan.orderBy = i;
            scan.orderByHasOffsetFetch = false;
            afterOrderBy = true;
          }
        } else if (word === 'option') {
          const j = skipTrivia(end);
          if (sql[j] === '(') scan.option = i;
        } else if (word === 'for') {
          const j = skipTrivia(end);
          const next = readWord(j);
          if (next.word === 'xml' || next.word === 'json') scan.forClause = true;
        } else if (afterOrderBy && (word === 'offset' || word === 'fetch')) {
          scan.orderByHasOffsetFetch = true;
        }
      }
      i = end;
      continue;
    }
    i++;
  }
  return scan;
}

/**
 * Strip trailing semicolons (and trailing trivia) — the wrap puts the
 * statement between parens, where a terminator is a syntax error.
 */
export function stripTrailingSemis(sql: string): string {
  let s = sql.replace(/[\s;]+$/g, '');
  // A trailing line comment has no newline terminator — cutting whitespace
  // off the end can leave one; the wrap re-adds a newline before `)`, so it
  // is safe to keep comments, but a dangling `--` after the last semicolon
  // strip would comment out nothing of ours. Re-trim once for `; -- c`.
  s = s.replace(/[\s;]+$/g, '');
  return s;
}

// ── the builder ───────────────────────────────────────────────────────────────

/**
 * Build the derived query that makes UDT columns decodable, or a refusal
 * naming the obstacle (refusals are cheap and certain; a half-wrapped query
 * is a server error the user has to decode).
 */
export function buildUdtDerivedQuery(
  originalSql: string,
  columns: readonly ColumnLike[],
  mode: UdtViewMode,
): UdtDerivedResult {
  const udtNames = udtColumnNames(columns);
  if (udtNames.length === 0) {
    return { ok: false, reason: 'No udt columns in this result set.' };
  }
  // A UDT column with no name (unaliased expression) cannot be referenced in
  // the outer select at all — refuse when that is all there is, skip and say
  // so when it is one of several.
  const wrapNames = udtNames.filter(nm => nm !== '');
  if (wrapNames.length === 0) {
    return { ok: false, reason: 'The udt column has no name — alias it in the SELECT first.' };
  }
  const skippedUnnamed = udtNames.length - wrapNames.length;

  const sql = stripTrailingSemis(originalSql);
  if (sql === '') {
    return { ok: false, reason: 'The statement is empty.' };
  }
  const scan = scanTopLevel(sql);

  if (scan.firstWord !== 'select' && scan.firstWord !== 'with') {
    return { ok: false, reason: `Only a SELECT (or WITH…SELECT) can be wrapped — this starts with ${scan.firstWord.toUpperCase() || 'something else'}.` };
  }
  if (scan.semicolons.length > 0) {
    return { ok: false, reason: 'A multi-statement batch cannot be wrapped in a derived table — run one SELECT.' };
  }
  if (scan.forClause) {
    return { ok: false, reason: 'FOR XML / FOR JSON cannot live inside a derived table.' };
  }

  const clauseNotes: string[] = [];
  let inner = sql;
  let optionClause = '';
  // OPTION is only legal on the outermost query — hoist it out verbatim.
  if (scan.option !== null) {
    optionClause = sql.slice(scan.option).trim();
    inner = sql.slice(0, scan.option).trimEnd();
    clauseNotes.push('OPTION clause hoisted to the outer query');
  }
  // A top-level ORDER BY is illegal in a derived table unless TOP/OFFSET
  // accompanies it. Hoisting it would change TOP semantics (TOP picks by the
  // ORDER BY), so instead the inner ORDER BY gains `OFFSET 0 ROWS` — the
  // documented legaliser — unless it already carries OFFSET/FETCH.
  if (scan.orderBy !== null && !scan.orderByHasOffsetFetch) {
    // Newline-led: a trailing `-- comment` after the ORDER BY must not swallow
    // the legaliser (that was Msg 1033 waiting to happen).
    inner += '\nOFFSET 0 ROWS';
    clauseNotes.push('ORDER BY kept in place via OFFSET 0 ROWS');
  } else if (scan.orderBy !== null) {
    clauseNotes.push('ORDER BY already carries OFFSET/FETCH');
  }

  const q = (name: string) => quoteIdent(name, 'sqlserver');
  const method = mode === 'wkb' ? 'STAsBinary()' : 'ToString()';

  // Substitution needs exactly what a T-SQL derived table needs: every
  // output column named, no name twice.
  const names = columns.map(c => c.name);
  const unique = new Set(names.map(nm => nm.toLowerCase()));
  const substitutable = names.every(nm => nm !== '') && unique.size === names.length;

  let selectList: string;
  let strategy: UdtDerivedQuery['strategy'];
  if (substitutable) {
    strategy = 'substitute';
    selectList = columns.map(c => {
      const ref = `${DERIVED_ALIAS}.${q(c.name)}`;
      return c.typeName === 'udt' ? `${ref}.${method} AS ${q(c.name)}` : ref;
    }).join(', ');
  } else {
    strategy = 'append';
    const suffix = mode === 'wkb' ? '_wkb' : '_wkt';
    const taken = new Set(names.map(nm => nm.toLowerCase()));
    const extras = wrapNames.map(nm => {
      let alias = `${nm}${suffix}`;
      let k = 2;
      while (taken.has(alias.toLowerCase())) alias = `${nm}${suffix}_${k++}`;
      taken.add(alias.toLowerCase());
      return `${DERIVED_ALIAS}.${q(nm)}.${method} AS ${q(alias)}`;
    });
    selectList = `${DERIVED_ALIAS}.*, ${extras.join(', ')}`;
    clauseNotes.push('duplicate/unnamed columns — decoded columns appended, raw udt column kept');
  }
  if (skippedUnnamed > 0) {
    clauseNotes.push(`${skippedUnnamed} unnamed udt column${skippedUnnamed === 1 ? '' : 's'} skipped (cannot be referenced)`);
  }

  // Newline framing: a trailing `-- comment` inside the original must not
  // swallow the closing paren.
  const wrappedSql =
    `SELECT ${selectList}\nFROM (\n${inner}\n) AS ${DERIVED_ALIAS}${optionClause ? `\n${optionClause}` : ''}`;

  const verb = mode === 'wkb' ? '.STAsBinary() → WKB hex' : '.ToString() → WKT text';
  const logLine =
    `Derived query: ${wrapNames.length} udt column${wrapNames.length === 1 ? '' : 's'} ` +
    `(${wrapNames.join(', ')}) wrapped with ${verb} [${strategy}]`;

  return { ok: true, query: { sql: wrappedSql, strategy, wrapped: wrapNames, clauseNotes }, logLine };
}

// ── the grid-toolbar gate ─────────────────────────────────────────────────────

export interface ViewAsGeoAction {
  /** false → the button does not render at all (wrong engine, no udt columns). */
  show: boolean;
  /** non-null → the button renders greyed with this as the explained reason. */
  reason: string | null;
  /** The built query, present iff the button is runnable. */
  derived: UdtDerivedQuery | null;
  /** The derivation line, present iff runnable — which columns were wrapped
   *  and which clauses were moved, for the log next to the run. */
  logLine: string | null;
}

/**
 * Should the result toolbar offer "View as geo", and may it run? The button is
 * hidden only when it is irrelevant (not SQL Server, or the result has no udt
 * columns); when it is relevant but cannot run, the reason comes back so the
 * UI greys the button and explains — a blocked feature is shown, never hidden.
 * wkb only: STAsBinary lands in the existing 0x-hex → parseWkbHex stack; a
 * hierarchyid column fails server-side (Msg 195) and that error surfaces as
 * any query error would.
 */
export function viewAsGeoAction(
  engine: string | undefined,
  columns: readonly ColumnLike[],
  sourceSql: string | undefined,
): ViewAsGeoAction {
  const none: ViewAsGeoAction = { show: false, reason: null, derived: null, logLine: null };
  if (engine !== 'sqlserver') return none;
  if (udtColumnNames(columns).length === 0) return none;
  if (!sourceSql || sourceSql.trim() === '') {
    return {
      show: true,
      reason: 'No originating statement — the derived query needs the SQL that produced this result.',
      derived: null, logLine: null,
    };
  }
  const r = buildUdtDerivedQuery(sourceSql, columns, 'wkb');
  if (!r.ok) return { show: true, reason: r.reason, derived: null, logLine: null };
  return { show: true, reason: null, derived: r.query, logLine: r.logLine };
}
