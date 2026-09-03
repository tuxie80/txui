/**
 * Careful SQL beautifier (pure, no CM/React imports) — powers the editor's
 * "Beautify statement" command (⇧⌥F) and the optional auto-format-on-`;`.
 *
 * Design contract:
 *  - Tokenize, then re-emit. Every non-whitespace token is re-emitted
 *    verbatim, so strings, quoted identifiers and comments can NEVER be
 *    corrupted — the formatter only decides where whitespace goes.
 *  - Idempotent: format(format(x)) === format(x). Emission depends only on
 *    the token stream, never on the input's original whitespace.
 *  - Heuristic, not a parser. Weird edge cases may come out imperfectly
 *    spaced, but never with altered content.
 *
 * Style: major clauses on their own lines, one top-level select-list item
 * per line (trailing commas), AND/OR on continuation lines, subqueries
 * indented one level, VALUES tuples and function arguments stay inline.
 */

import { backslashEscapesStrings } from './sqlIdent.ts';
import { keywordCatalog } from './sqlKeywords.ts';
import type { Engine } from '../types';

export interface BeautifyOptions {
  /** Keyword casing from the editor preference (dbgui.editorKeywordCase). */
  keywordCase?: 'upper' | 'lower';
  engine?: Engine;
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

interface Token {
  /** raw text as it appeared in the source (after keyword casing for words) */
  text: string;
  kind: 'word' | 'qident' | 'string' | 'comment' | 'number' | 'op'
      | 'open' | 'close' | 'comma' | 'semi' | 'dot';
  /** line comments (`--`, `#`) force a newline after themselves */
  lineComment?: boolean;
}

const OP_CHARS = new Set('=<>+-*/%!&|^~?:'.split(''));

/** Words never keyword-cased — too common as real column names. */
const CASE_EXCLUDE = new Set(['COMMENT', 'NAME', 'VALUE', 'STATE', 'STATUS']);

/**
 * Type names: cased like keywords, but a following `(` stays tight
 * (`VARCHAR(10)`, never `VARCHAR (10)`).
 */
const TYPE_WORDS = [
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'VARCHAR',
  'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT', 'BLOB', 'DATETIME',
  'TIMESTAMP', 'DATE', 'TIME', 'YEAR', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE',
  'REAL', 'BOOLEAN', 'SERIAL', 'BIGSERIAL', 'UUID', 'JSON', 'JSONB', 'BYTEA',
  'ENUM', 'INTERVAL', 'PRECISION', 'VARYING',
];

/** Structural words that deserve casing even outside the catalogs. */
const EXTRA_CASE_WORDS = [
  'UNSIGNED', 'ZEROFILL', 'DUAL', 'RECURSIVE', 'LATERAL', 'SEPARATOR',
  'IGNORE', 'DUPLICATE', 'RESTRICT', 'CASCADE', 'TEMPORARY', 'CONFLICT',
  'NOTHING', 'ILIKE', 'ESCAPE', 'COLLATE', 'CHARSET', 'CHARACTER', 'ZONE',
];

/** Keywords that are written function-style: no space before `(`. */
const FN_LIKE_KEYWORDS = new Set(['CAST', 'TRIM', 'EXTRACT', 'SUBSTRING', 'POSITION', 'OVERLAY']);

interface WordSets {
  /** every word that gets keyword-cased */
  caseSet: Set<string>;
  /** catalog keyword words (type 'keyword') + structural extras */
  keySet: Set<string>;
  /** words whose following `(` attaches without a space */
  tightParen: Set<string>;
}

let wordSetCache: { engine: Engine; sets: WordSets } | null = null;

function wordSets(engine: Engine): WordSets {
  if (wordSetCache && wordSetCache.engine === engine) return wordSetCache.sets;
  const caseSet = new Set<string>();
  const keySet = new Set<string>();
  const tightParen = new Set<string>();
  for (const item of keywordCatalog(engine)) {
    // A catalog label can be a SNIPPET rather than a bare keyword — T-SQL's
    // `DECLARE @t TABLE` is one. Splitting it on punctuation leaks the
    // placeholder `t` into the case set, and from there every alias named `t`
    // in the buffer gets upper-cased. No SQL keyword is one character, so
    // dropping single-character words removes the whole class of it.
    for (const w of item.label.split(/[^A-Za-z0-9_]+/)) {
      const up = w.toUpperCase();
      if (!up || up.length < 2 || CASE_EXCLUDE.has(up)) continue;
      caseSet.add(up);
      if (item.type === 'keyword') keySet.add(up);
      if (item.type === 'function') tightParen.add(up);
    }
  }
  for (const w of EXTRA_CASE_WORDS) { caseSet.add(w); keySet.add(w); }
  for (const w of TYPE_WORDS) { caseSet.add(w); tightParen.add(w); }
  for (const w of FN_LIKE_KEYWORDS) tightParen.add(w);
  wordSetCache = { engine, sets: { caseSet, keySet, tightParen } };
  return wordSetCache.sets;
}

/**
 * Split SQL into tokens, skipping whitespace. Strings ('', $$…$$), quoted
 * identifiers (`…`, "…"), line/block comments and PG `::` / `:var` / `@var`
 * forms are all understood. Unterminated strings/comments run to EOF — the
 * text is still re-emitted unchanged.
 */
export function tokenizeSql(sql: string, engine?: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;

  // Sticky regexes match at lastIndex without slicing the rest of the
  // document — a per-token sql.slice(i) made large scripts O(n²).
  const varRe = /@*[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?/y;
  const numRe = /(?:0x[0-9a-fA-F]+|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
  const wordRe = /[A-Za-z_][\w$]*/y;

  // Backslash escapes are a dialect property (WP-08 8.7): honored in
  // MySQL-family string literals and PG `E'…'` strings, never inside quoted
  // identifiers. Getting this wrong shifted a string's boundary and leaked
  // its content into word tokens that keyword-casing then rewrote — breaking
  // the "content is never altered" contract.
  const bsInStrings = backslashEscapesStrings(engine);
  const scanQuoted = (q: string): number => {
    const eString = q === "'" && i > 0 && (sql[i - 1] === 'E' || sql[i - 1] === 'e')
      && (i < 2 || !/[\w$]/.test(sql[i - 2]));
    // On MySQL a double-quoted token is a string (ANSI_QUOTES off) and takes
    // backslash escapes; on PG/SQLite it is an identifier and does not.
    const bs = (q === "'" && (bsInStrings || eString)) || (q === '"' && bsInStrings);
    let j = i + 1;
    while (j < n) {
      if (bs && sql[j] === '\\') { j += 2; continue; }
      if (sql[j] === q) {
        if (q === "'" && j + 1 < n && sql[j + 1] === "'") { j += 2; continue; } // '' escape
        j++; break;
      }
      j++;
    }
    return Math.min(j, n);
  };

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (/\s/.test(ch)) { i++; continue; }

    // line comments
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out.push({ text: sql.slice(i, end), kind: 'comment', lineComment: true });
      i = end;
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out.push({ text: sql.slice(i, end), kind: 'comment' });
      i = end;
      continue;
    }
    // string
    if (ch === "'") {
      const end = scanQuoted("'");
      out.push({ text: sql.slice(i, end), kind: 'string' });
      i = end;
      continue;
    }
    // quoted identifier ("…" or `…`)
    if (ch === '"' || ch === '`') {
      const end = scanQuoted(ch);
      out.push({ text: sql.slice(i, end), kind: 'qident' });
      i = end;
      continue;
    }
    // PG dollar-quoted string: $$…$$ or $tag$…$tag$
    if (ch === '$') {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out.push({ text: sql.slice(i, end), kind: 'string' });
        i = end;
        continue;
      }
    }
    // session / bind variables: @x, @@global.x, :name
    if ((ch === '@' && /[A-Za-z_@]/.test(next)) || (ch === ':' && /[A-Za-z_]/.test(next))) {
      const start = ch === ':' ? i + 1 : i;
      varRe.lastIndex = start;
      const m = varRe.exec(sql);
      const body = m ? m[0] : '';
      if (!body) { out.push({ text: ch, kind: 'op' }); i++; continue; }
      out.push({ text: (ch === ':' ? ':' : '') + body, kind: 'word' });
      i = start + body.length;
      continue;
    }
    // number (incl. 1.5e-3, 0x1F, .5)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next))) {
      numRe.lastIndex = i;
      const m = numRe.exec(sql);
      out.push({ text: m![0], kind: 'number' });
      i += m![0].length;
      continue;
    }
    // bare word
    if (/[A-Za-z_]/.test(ch)) {
      wordRe.lastIndex = i;
      const m = wordRe.exec(sql);
      out.push({ text: m![0], kind: 'word' });
      i += m![0].length;
      continue;
    }
    if (ch === '(') { out.push({ text: '(', kind: 'open' }); i++; continue; }
    if (ch === ')') { out.push({ text: ')', kind: 'close' }); i++; continue; }
    if (ch === ',') { out.push({ text: ',', kind: 'comma' }); i++; continue; }
    if (ch === ';') { out.push({ text: ';', kind: 'semi' }); i++; continue; }
    if (ch === '.') { out.push({ text: '.', kind: 'dot' }); i++; continue; }
    // PG cast operator
    if (ch === ':' && next === ':') {
      out.push({ text: '::', kind: 'op' });
      i += 2;
      continue;
    }
    // maximal run of operator characters (>=, !=, ||, &&, :=, …)
    if (OP_CHARS.has(ch)) {
      let j = i + 1;
      while (j < n && OP_CHARS.has(sql[j])) {
        // stop before a comment opener
        if ((sql[j] === '-' && j + 1 < n && sql[j + 1] === '-') ||
            (sql[j] === '/' && j + 1 < n && sql[j + 1] === '*')) break;
        j++;
      }
      out.push({ text: sql.slice(i, j), kind: 'op' });
      i = j;
      continue;
    }
    // unknown char — keep it verbatim as its own op token
    out.push({ text: ch, kind: 'op' });
    i++;
  }
  return out;
}

// ── Layout rules ─────────────────────────────────────────────────────────────

/** Clause starters: newline before (unless first token), content same line. */
const BREAK_BEFORE = new Set([
  'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT',
  'EXCEPT', 'VALUES', 'SET', 'RETURNING', 'WINDOW', 'JOIN', 'WITH',
]);

/** Break before WORD only when followed by this word (GROUP BY, ORDER BY). */
const BREAK_PAIR: Record<string, string> = { GROUP: 'BY', ORDER: 'BY', FETCH: 'FIRST' };

/** LEFT/RIGHT/… start a join clause when JOIN (or OUTER JOIN) follows. */
const JOIN_PREFIX = new Set(['LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN']);

/** Keywords with a space before a following `(` (handled via keySet anyway). */
const SPACE_BEFORE_PAREN = new Set(['IN', 'VALUES', 'EXISTS']);

const IND = '  ';

function wordUpper(tokens: Token[], idx: number): string | null {
  const t = tokens[idx];
  return t && t.kind === 'word' ? t.text.toUpperCase() : null;
}

/** Does a newline come before token i (clause starter / AND / OR)? */
function breakIndentBefore(tokens: Token[], i: number, depth: number): number | null {
  const t = tokens[i];
  if (t.kind !== 'word' || i === 0) return null;
  const up = t.text.toUpperCase();
  if (up === 'AND' || up === 'OR') return depth + 1;
  // JOIN stays on the line of its LEFT/OUTER/… prefix
  if (up === 'JOIN') {
    const w0 = wordUpper(tokens, i - 1);
    if (w0 && (JOIN_PREFIX.has(w0) || w0 === 'OUTER')) return null;
    return depth;
  }
  if (BREAK_BEFORE.has(up)) {
    // DELETE FROM stays on one line
    if (up === 'FROM' && wordUpper(tokens, i - 1) === 'DELETE') return null;
    return depth;
  }
  if (BREAK_PAIR[up] && wordUpper(tokens, i + 1) === BREAK_PAIR[up]) return depth;
  if (JOIN_PREFIX.has(up)) {
    const w1 = wordUpper(tokens, i + 1);
    if (w1 === 'JOIN') return depth;
    if (w1 === 'OUTER' && wordUpper(tokens, i + 2) === 'JOIN') return depth;
  }
  return null;
}

/**
 * Format one statement (or any SQL fragment). The result has no leading or
 * trailing whitespace; a trailing `;` in the input is preserved.
 */
export function formatSql(source: string, opts: BeautifyOptions = {}): string {
  const tokens = tokenizeSql(source, opts.engine);
  if (tokens.length === 0) return '';

  // The engine is passed through, not folded into two. `keywordCatalog`
  // already knows every dialect — collapsing SQL Server to `mysql` handed a
  // T-SQL buffer MySQL's vocabulary, so `OUTPUT`, `MERGE`, `TOP`, `NVARCHAR`
  // and `GETDATE` went un-cased while MySQL-only words were cased in a
  // statement that cannot contain them.
  const sets = wordSets(opts.engine ?? 'mysql');
  const upper = opts.keywordCase !== 'lower';
  // Case keywords in place (words only — strings/qidents/comments untouched).
  for (const t of tokens) {
    if (t.kind === 'word' && sets.caseSet.has(t.text.toUpperCase())) {
      t.text = upper ? t.text.toUpperCase() : t.text.toLowerCase();
    }
  }

  const out: string[] = [];
  let depth = 0;
  /** paren stack: true when that paren opened a broken-out subquery block */
  const brokeParen: boolean[] = [];
  /** indent level for the newline that must precede the NEXT token */
  let pendingNewline: number | null = null;
  /** whether the next token (absent a newline) wants a space before it */
  let needSep = false;
  let prev: Token | null = null;

  const newline = (level: number) => {
    out.push('\n' + IND.repeat(Math.max(0, level)));
  };

  const emit = (t: Token, noSpaceBefore: boolean) => {
    if (pendingNewline !== null) {
      newline(pendingNewline);
      pendingNewline = null;
    } else if (needSep && !noSpaceBefore) {
      out.push(' ');
    }
    out.push(t.text);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const up = t.kind === 'word' ? t.text.toUpperCase() : null;

    // Structural break BEFORE this token.
    const brk = breakIndentBefore(tokens, i, depth);
    if (brk !== null) pendingNewline = brk;

    switch (t.kind) {
      case 'open': {
        const nextUp = wordUpper(tokens, i + 1);
        const isSub = nextUp === 'SELECT' || nextUp === 'WITH';
        const prevUp = prev && prev.kind === 'word' ? prev.text.toUpperCase() : null;
        const prevPrevUp = wordUpper(tokens, i - 2);
        // `IN (`, `VALUES (`, keyword-grouped `OVER (` … but `f(`, `VARCHAR(`.
        const spaceBefore = prev !== null && prev.kind === 'word' && prevUp !== null &&
          ((sets.keySet.has(prevUp) && !sets.tightParen.has(prevUp)) ||
           SPACE_BEFORE_PAREN.has(prevUp) ||
           prevPrevUp === 'INTO' || prevPrevUp === 'TABLE');
        emit(t, !spaceBefore);
        depth++;
        brokeParen.push(isSub);
        if (isSub) pendingNewline = depth;
        needSep = false;
        break;
      }
      case 'close': {
        depth = Math.max(0, depth - 1);
        if (brokeParen.pop()) pendingNewline = depth;
        emit(t, true);
        needSep = true;
        break;
      }
      case 'comma': {
        emit(t, true);
        if (depth === 0) pendingNewline = depth + 1;
        else out.push(' ');
        needSep = false;
        break;
      }
      case 'semi': {
        emit(t, true);
        if (i < tokens.length - 1) pendingNewline = depth;
        needSep = false;
        break;
      }
      case 'dot': {
        emit(t, true);
        needSep = false;
        break;
      }
      case 'op': {
        const unary = (t.text === '-' || t.text === '+') &&
          (!prev || prev.kind === 'op' || prev.kind === 'open' ||
           prev.kind === 'comma' || prev.kind === 'semi' ||
           (prev.kind === 'word' && sets.keySet.has(prev.text.toUpperCase())));
        if (t.text === '::') {
          emit(t, true);
          needSep = false;
        } else if (unary) {
          // sign attaches to what follows: space before, none after
          emit(t, prev === null || prev.kind === 'open');
          needSep = false;
        } else {
          emit(t, false);
          needSep = true;
        }
        break;
      }
      case 'comment': {
        emit(t, false);
        needSep = true;
        if (t.lineComment && i < tokens.length - 1) pendingNewline = depth;
        break;
      }
      default: {
        // words, quoted identifiers, strings, numbers
        void up;
        emit(t, false);
        needSep = true;
      }
    }
    prev = t;
  }

  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}
