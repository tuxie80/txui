/**
 * Find usages — where is this table or column actually referenced?
 *
 * The question before every `DROP COLUMN`, every rename, every "is anything
 * still reading this?". A `grep` over your own repository answers half of it;
 * the other half is inside the database, in view definitions, routine bodies
 * and trigger bodies that no editor has open. Those are the ones that break in
 * production, because nobody looked.
 *
 * ## Why this is not a substring search
 *
 * `grep customer_id` finds `old_customer_id`, the word inside a comment, and
 * the string `'customer_id'` in a log message. A result list that is mostly
 * noise gets skimmed, and skimming is how the one real usage is missed. So:
 *
 *   - **Comments and string literals are masked** before anything is matched.
 *   - **Quoted identifiers are not.** ```orders``` is a *name* in MySQL and
 *     `"orders"` is a name in PostgreSQL — masking those as strings, which is
 *     what the completion engine's `blank()` does, would silently drop every
 *     reference written the careful way.
 *   - Matches are **whole identifiers**, so `customer_id` never matches inside
 *     `old_customer_id`.
 *
 * ## Confidence, rather than a guess
 *
 * A bare column name is genuinely ambiguous: `id` appears in every table in the
 * schema. Rather than pretend, each hit says how sure it is — qualified as
 * `orders.id`, or bare in a statement that does mention `orders`, or bare in
 * one that does not. The last kind is usually a different table's column, and
 * saying so is more useful than either dropping it or listing it as equal.
 *
 * Pure: takes SQL text that someone else fetched, so `node --test` covers it.
 */

export type Engine = 'mysql' | 'postgres' | 'sqlserver';

/** Where a piece of SQL came from. Ordering below is the display order. */
export type SourceKind =
  | 'view' | 'matview' | 'routine' | 'trigger' | 'event'
  | 'constraint' | 'index' | 'default'
  // SQL Server: an expression over other columns, which a DROP COLUMN breaks
  // silently. No analogue in the other two engines' corpora.
  | 'computed'
  | 'buffer' | 'saved';

export interface UsageSource {
  /** Stable id, so a hit can be traced back to its origin. */
  id: string;
  kind: SourceKind;
  /** What to show: `public.v_open_orders`, `Buffer 3`, `nightly.sql`. */
  label: string;
  /** The definition or script text. */
  sql: string;
  /** Schema the object lives in, when it has one. */
  schema?: string;
  /**
   * The table this definition is *part of*, when it is part of one.
   *
   * A generated column's expression, a column default, a table constraint and
   * an index all live on a table without naming it — `(amount * 2)` mentions no
   * table at all. Without this they read as unqualified references in a
   * statement that does not mention the table, which is the weakest verdict the
   * matcher has, for what is in fact a hard dependency: drop the column and the
   * generated column goes with it.
   */
  ownerTable?: string;
}

/**
 * What to look for.
 *
 * `table` alone finds references to the table. `table` + `column` finds
 * references to that column and uses the table to judge how sure each is.
 * `column` alone is allowed and reports everything as ambiguous, which is the
 * honest answer when no table was named.
 */
export interface UsageQuery {
  table?: string;
  column?: string;
}

/**
 * How sure the match is.
 *
 * - `certain` — it can only be this. `orders.id`, `o.id` where `o` is `orders`,
 *   or the table named after `FROM` / `JOIN` / `UPDATE` / `INTO`.
 * - `likely` — the name matches and the statement does reference the table,
 *   but the reference itself is unqualified.
 * - `possible` — the name matches and nothing ties it to this table. Usually
 *   another table's column of the same name.
 */
export type Confidence = 'certain' | 'likely' | 'possible';

export interface Usage {
  sourceId: string;
  /** 1-based, for jumping to it. */
  line: number;
  column: number;
  /** The whole line, trimmed of trailing space, for the result list. */
  lineText: string;
  confidence: Confidence;
  /** Why it is not `certain`, when it is not. */
  note?: string;
}

export interface UsageReport {
  usages: Usage[];
  /** Sources with at least one hit, in display order. */
  hitSources: UsageSource[];
  certain: number;
  likely: number;
  possible: number;
  /** Sources that were searched — the denominator for "nothing found". */
  searched: number;
}

// ── masking ──────────────────────────────────────────────────────────────────

/** Identifier characters, for the whole-token test. */
const IDENT = /[A-Za-z0-9_$]/;

/**
 * Blank comments and string literals, preserving offsets.
 *
 * Quoted **identifiers** survive with their quotes, because they are names and
 * the whole point is to find names. Which quote means which depends on the
 * engine, and getting it backwards is not a rounding error: on MySQL,
 * `"orders"` is a string and ```orders``` a name; on PostgreSQL it is the
 * other way round and a backtick is not valid at all.
 *
 * Dollar-quoted bodies (`$$ … $$`) are left intact rather than masked: on
 * PostgreSQL that is where a function's whole body lives, and masking it would
 * make every routine look unused.
 */
export function maskLiterals(sql: string, engine: Engine): string {
  // Three engines, three ways to quote a name: MySQL backticks, PostgreSQL
  // double quotes, T-SQL brackets. SQL Server also accepts double quotes when
  // QUOTED_IDENTIFIER is ON (which the driver sets), so both are honoured
  // there — the closer is what differs.
  const identQuote = engine === 'mysql' ? '`' : '"';
  // A backslash is NOT an escape inside a T-SQL string literal; only the
  // doubled quote is. Treating it as one would swallow the character after it
  // and mask past the end of the literal.
  const backslashEscapes = engine === 'mysql';
  const stringQuote = engine === 'mysql' ? '"' : null;
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    // -- line comment, and MySQL's #
    if ((ch === '-' && next === '-') || (engine === 'mysql' && ch === '#')) {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    // /* block comment */ — not nested; PostgreSQL does nest them, but a
    // nested comment inside a definition is rare enough that treating the
    // first */ as the end costs less than mis-parsing the common case.
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    // Dollar quoting — kept, because a PostgreSQL routine body lives in it.
    if (engine === 'postgres' && ch === '$') {
      const tag = /^\$[A-Za-z_]\w*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        out += tag[0];
        i += tag[0].length;
        continue;
      }
    }
    // '' string literal — always a string, in both engines.
    if (ch === "'" || ch === stringQuote) {
      const q = ch;
      let j = i + 1;
      while (j < n) {
        if (backslashEscapes && sql[j] === '\\') { j += 2; continue; }
        // '' inside a string is an escaped quote, not the end.
        if (sql[j] === q && sql[j + 1] === q) { j += 2; continue; }
        if (sql[j] === q) { j++; break; }
        j++;
      }
      out += ' '.repeat(Math.min(j, n) - i);
      i = j;
      continue;
    }
    // [bracketed identifier] — T-SQL's own, kept verbatim like any other name.
    // `]]` inside is an escaped bracket, not the end.
    if (engine === 'sqlserver' && ch === '[') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ']' && sql[j + 1] === ']') { j += 2; continue; }
        if (sql[j] === ']') { j++; break; }
        j++;
      }
      const end = Math.min(j, n);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    // Quoted identifier — kept verbatim. It is a name.
    if (ch === identQuote) {
      let j = i + 1;
      while (j < n && sql[j] !== identQuote) j++;
      const end = Math.min(j + 1, n);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ── matching ─────────────────────────────────────────────────────────────────

/** Strip surrounding quotes from a name as written. */
function unquote(raw: string): string {
  return raw.replace(/^[`"]|[`"]$/g, '');
}

/**
 * Every position where `name` appears as a whole identifier.
 *
 * Case-insensitive. MySQL's table-name case sensitivity depends on the server's
 * filesystem and `lower_case_table_names`, and PostgreSQL folds unquoted names
 * to lower case — so matching case-sensitively would miss real usages on some
 * servers and none of them on others. Over-reporting here is recoverable;
 * missing the one view that breaks is not.
 */
function positionsOf(masked: string, name: string): number[] {
  const target = name.toLowerCase();
  const hay = masked.toLowerCase();
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(target, from);
    if (at === -1) break;
    from = at + 1;
    const before = at > 0 ? masked[at - 1] : '';
    const after = masked[at + target.length] ?? '';
    // A quote directly against the name is a boundary, not a continuation.
    const boundedLeft = !IDENT.test(before) || before === '';
    const boundedRight = !IDENT.test(after) || after === '';
    if (boundedLeft && boundedRight) out.push(at);
  }
  return out;
}

/** The qualifier immediately before an offset, if the reference is `x.name`. */
function qualifierAt(masked: string, at: number): string | null {
  let i = at - 1;
  // Step over the name's own opening quote. MySQL writes a view definition as
  // `` `db`.`orders` ``, so without this the very first character looked at is
  // a backtick, the dot is never reached, and every reference in every stored
  // definition looks unqualified — which is most of the corpus.
  if (i >= 0 && (masked[i] === '`' || masked[i] === '"')) i--;
  while (i >= 0 && /\s/.test(masked[i])) i--;
  if (i < 0 || masked[i] !== '.') return null;
  i--;
  while (i >= 0 && /\s/.test(masked[i])) i--;
  const end = i + 1;
  if (i >= 0 && (masked[i] === '`' || masked[i] === '"')) {
    const q = masked[i];
    i--;
    while (i >= 0 && masked[i] !== q) i--;
    return unquote(masked.slice(i, end));
  }
  while (i >= 0 && IDENT.test(masked[i])) i--;
  const name = masked.slice(i + 1, end);
  return name || null;
}

/** The word immediately before an offset — `FROM`, `JOIN`, `UPDATE`, … */
function keywordBefore(masked: string, at: number): string {
  let i = at - 1;
  while (i >= 0 && /[\s(]/.test(masked[i])) i--;
  const end = i + 1;
  while (i >= 0 && IDENT.test(masked[i])) i--;
  return masked.slice(i + 1, end).toLowerCase();
}

/** Keywords after which a name can only be a table. */
export const TABLE_POSITION = new Set([
  'from', 'join', 'update', 'into', 'table', 'only',
  'references', 'truncate', 'analyze', 'describe', 'desc',
]);

/**
 * Aliases bound to a table in this SQL: `orders o` / `orders AS o`.
 *
 * Deliberately narrow — the alias must sit directly after the table name. A
 * full FROM-clause parse is what `sqlAlias` does for completion, but there the
 * cost of a wrong answer is a bad suggestion; here it is a usage reported as
 * `certain` that is not one, and a confidence level nobody can trust is worse
 * than no confidence level.
 */
function aliasesFor(masked: string, table: string): Set<string> {
  const out = new Set<string>();
  const t = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The alias may itself be quoted. MySQL stores a view's definition
  // normalised — `` `orders` `o` `` — so an alias pattern that only accepted a
  // bare word matched nothing in the one source that matters most, and every
  // column reference in every MySQL view came back `likely` instead of
  // `certain`.
  const re = new RegExp(
    `[\`"]?\\b${t}\\b[\`"]?\\s+(?:as\\s+)?[\`"]?([A-Za-z_]\\w*)[\`"]?`, 'gi');
  for (;;) {
    const m = re.exec(masked);
    if (!m) break;
    const alias = m[1].toLowerCase();
    // `orders WHERE` is not an alias named "where".
    if (!RESERVED_AFTER_TABLE.has(alias)) out.add(alias);
  }
  return out;
}

/** Row aliases bound by the server inside a trigger body. */
const TRIGGER_ROWS = new Set(['new', 'old']);

const RESERVED_AFTER_TABLE = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'join',
  'left', 'right', 'inner', 'outer', 'cross', 'natural', 'on', 'using', 'set',
  'values', 'window', 'for', 'into', 'as', 'and', 'or', 'not', 'select',
  'returning', 'lateral', 'when', 'then', 'else', 'end', 'is', 'null',
]);

/** Line and column (both 1-based) of a character offset. */
function lineColOf(text: string, at: number): { line: number; column: number; lineText: string } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at; i++) {
    if (text[i] === '\n') { line++; lineStart = i + 1; }
  }
  let lineEnd = text.indexOf('\n', at);
  if (lineEnd === -1) lineEnd = text.length;
  return {
    line,
    column: at - lineStart + 1,
    lineText: text.slice(lineStart, lineEnd).replace(/\s+$/, ''),
  };
}

const KIND_ORDER: SourceKind[] = [
  'view', 'matview', 'routine', 'trigger', 'event',
  'constraint', 'index', 'default', 'computed', 'buffer', 'saved',
];

/**
 * Find every usage of the query's symbol across the given sources.
 *
 * Sources are searched independently; nothing here talks to a server.
 */
export function findUsages(
  sources: UsageSource[], query: UsageQuery, engine: Engine,
): UsageReport {
  const usages: Usage[] = [];
  const hit = new Set<string>();
  const table = query.table ? unquote(query.table) : undefined;
  const column = query.column ? unquote(query.column) : undefined;

  for (const src of sources) {
    const masked = maskLiterals(src.sql, engine);

    if (column) {
      // Does this source mention the table at all? That decides whether a bare
      // column reference is `likely` or merely `possible`.
      const mentionsTable = !!table && positionsOf(masked, table).length > 0;
      const aliases = table ? aliasesFor(masked, table) : new Set<string>();

      for (const at of positionsOf(masked, column)) {
        const qual = qualifierAt(masked, at);
        let confidence: Confidence;
        let note: string | undefined;

        if (qual && table && (qual.toLowerCase() === table.toLowerCase()
            || aliases.has(qual.toLowerCase()))) {
          confidence = 'certain';
        } else if (TRIGGER_ROWS.has(qual?.toLowerCase() ?? '')) {
          // `NEW.amount` / `OLD.amount` in a trigger body is a column of the
          // table the trigger fires on. Dropping these as "qualified by
          // something else" lost every trigger reference in the schema, which
          // is a false negative in the one place a silent break is most likely.
          if (src.ownerTable && table
              && src.ownerTable.toLowerCase() === table.toLowerCase()) {
            confidence = 'certain';
          } else {
            confidence = 'possible';
            note = `${qual!.toUpperCase()} refers to whichever table this trigger fires on, `
              + 'which is not recorded here';
          }
        } else if (qual) {
          // Qualified by something else — `customers.id` is not `orders.id`.
          continue;
        } else if (src.ownerTable && table
            && src.ownerTable.toLowerCase() === table.toLowerCase()) {
          // The definition belongs to the table, so a bare column name in it
          // is that table's column — there is nothing else it could be.
          confidence = 'certain';
        } else if (mentionsTable) {
          confidence = 'likely';
          note = `unqualified, but this statement references ${table}`;
        } else {
          confidence = 'possible';
          note = table
            ? `unqualified and ${table} is not referenced here — probably another table's column`
            : 'no table given, so any column of this name matches';
        }
        const pos = lineColOf(src.sql, at);
        usages.push({ sourceId: src.id, ...pos, confidence, note });
        hit.add(src.id);
      }
      continue;
    }

    if (table) {
      for (const at of positionsOf(masked, table)) {
        const kw = keywordBefore(masked, at);
        const qual = qualifierAt(masked, at);
        let confidence: Confidence;
        let note: string | undefined;
        if (TABLE_POSITION.has(kw) || qual) {
          confidence = 'certain';
        } else {
          confidence = 'likely';
          note = 'the name matches but is not in a table position — check it is not a column or alias';
        }
        const pos = lineColOf(src.sql, at);
        usages.push({ sourceId: src.id, ...pos, confidence, note });
        hit.add(src.id);
      }
    }
  }

  const order = new Map(sources.map((s, i) => [s.id, i]));
  const hitSources = sources
    .filter(s => hit.has(s.id))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      || (order.get(a.id)! - order.get(b.id)!));

  return {
    usages,
    hitSources,
    certain: usages.filter(u => u.confidence === 'certain').length,
    likely: usages.filter(u => u.confidence === 'likely').length,
    possible: usages.filter(u => u.confidence === 'possible').length,
    searched: sources.length,
  };
}

/**
 * One sentence for the top of the panel.
 *
 * States the denominator. "No usages found" on its own invites the reading
 * "safe to drop", which is only true if the search covered anything — and it
 * never covers application code.
 */
export function summarise(report: UsageReport, what: string): string {
  const { certain, likely, possible, searched, hitSources } = report;
  if (!report.usages.length) {
    return `No reference to ${what} in ${searched} database object${searched === 1 ? '' : 's'} `
      + 'and open script(s). Nothing here searches your application code.';
  }
  const bits = [`${certain} certain`];
  if (likely) bits.push(`${likely} likely`);
  if (possible) bits.push(`${possible} possible`);
  return `${report.usages.length} reference${report.usages.length === 1 ? '' : 's'} to ${what} `
    + `across ${hitSources.length} object${hitSources.length === 1 ? '' : 's'} — ${bits.join(', ')}.`;
}
