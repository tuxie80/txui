/**
 * Inlay hints for INSERT … VALUES — the pure half.
 *
 * For `INSERT INTO t (a, b, c) VALUES (1, 'x', NULL)` this returns one hint
 * per value, pairing it with the column it feeds: `{ pos, label }` where pos
 * is the doc offset of the value's first char and label reads `a =` — the
 * editor draws it inline before the value, so a wide tuple stops being a
 * counting exercise.
 *
 * Deliberately conservative — a hint that pairs the WRONG column is worse than
 * no hint, so anything uncertain yields nothing:
 *  - only an EXPLICIT column list (`INSERT INTO t (a, b) VALUES …`). Without
 *    one the pairing would be against the table's full column order, which
 *    this module cannot know. INSERT … SELECT, the MySQL `SET col = …` form
 *    and engine quirks (`VALUES ROW(…)`, PG's `ON CONFLICT (col)`) are all out
 *    of scope.
 *  - tuple arity must EQUAL the column count, in every hinted tuple — a
 *    mismatch silences the whole statement, not just the bad row.
 *  - a value that is (or contains) a subquery silences the statement: parsing
 *    further would be guesswork.
 *
 * Parsing runs on the blanked text (strings/comments spaced out, offsets
 * preserved), so a comma or ')' inside a string literal never splits a tuple.
 * The `ON DUPLICATE KEY UPDATE` / `ON CONFLICT …` tail is simply where tuple
 * parsing stops — it is never read as more values.
 */
import { blank } from './sqlAlias.ts';
import { splitStatements } from './sqlSplit.ts';

export interface InsertHint {
  /** Doc offset of the value's first non-whitespace char (hint drawn before it). */
  pos: number;
  /** `col =` — rendered inline before the value. */
  label: string;
}

/**
 * Above this many VALUE tuples only the FIRST row gets hints: a bulk insert's
 * later rows line up under the first, and repeating the column names down a
 * 200-row paste is noise, not help.
 */
export const INSERT_HINT_ROW_CAP = 8;

const INSERT_HEAD_RE =
  /^\s*(?:insert|replace)\s+(?:low_priority\s+|high_priority\s+|delayed\s+|ignore\s+)*into\b/i;

/** Index of the ')' closing the '(' at `open` in the (blanked) text, or -1. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Split a parenthesized body's span into top-level comma-separated entries,
 * each trimmed, with offsets into `s` (which shares the doc's coordinates).
 * `s` is the blanked text, so commas inside strings are already gone.
 */
function topLevelEntries(s: string, from: number, to: number): { from: number; to: number }[] | null {
  const out: { from: number; to: number }[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i <= to; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if ((c === ',' && depth === 0) || i === to) {
      const raw = s.slice(start, i);
      const lead = raw.length - raw.trimStart().length;
      const endLen = raw.trimEnd().length;
      if (!raw.trim()) return null; // an empty entry means the parse is lying
      out.push({ from: start + lead, to: start + endLen });
      start = i + 1;
    }
  }
  return out;
}

/** Hints for one statement's text (already isolated), or none. */
function statementHints(base: number, text: string): InsertHint[] {
  const s = blank(text);
  const head = INSERT_HEAD_RE.exec(s);
  if (!head) return [];

  // The column list opens at the first '(' after INTO. The table name in
  // between is never read — quoting rules differ per engine and the blanked
  // text holds spaces where a quoted name had letters, so trying to walk it
  // would only add failure modes. Without an explicit list the '(' found here
  // is the VALUES tuple opener and the `values` keyword check below refuses.
  const open = s.indexOf('(', head[0].length);
  if (open < 0) return [];
  let i = open;
  const colsClose = matchingParen(s, i);
  if (colsClose < 0) return [];
  const colEntries = topLevelEntries(s, i + 1, colsClose);
  if (!colEntries || colEntries.length === 0) return [];
  const columns = colEntries.map(c => text.slice(c.from, c.to).trim().replace(/[`"]/g, ''));
  if (columns.some(c => !c || /[()]/.test(c))) return [];

  // VALUES keyword directly after the column list
  const vals = /^\s*values\b/i.exec(s.slice(colsClose + 1));
  if (!vals) return [];
  i = colsClose + 1 + vals[0].length;

  // tuple loop: ( … ) separated by commas; anything else ends the VALUES list
  const tuples: { from: number; to: number }[][] = [];
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== '(') break;
    const close = matchingParen(s, i);
    if (close < 0) return [];
    const entries = topLevelEntries(s, i + 1, close);
    if (!entries) return [];
    // arity mismatch or a subquery value = the pairing would mislead — silence
    if (entries.length !== columns.length) return [];
    if (entries.some(e => /\bselect\b/i.test(s.slice(e.from, e.to)))) return [];
    tuples.push(entries);
    i = close + 1;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === ',') { i++; continue; }
    break; // ON DUPLICATE KEY UPDATE / ON CONFLICT / end of statement
  }
  if (tuples.length === 0) return [];

  const shown = tuples.length <= INSERT_HINT_ROW_CAP ? tuples : tuples.slice(0, 1);
  const out: InsertHint[] = [];
  for (const tuple of shown) {
    tuple.forEach((value, k) => {
      out.push({ pos: base + value.from, label: `${columns[k]} =` });
    });
  }
  return out;
}

/**
 * All INSERT … VALUES hints in a document. `delimiter` matches the editor's
 * configured terminator, like every other statement-aware pass.
 */
export function insertValueHints(doc: string, delimiter = ';'): InsertHint[] {
  const out: InsertHint[] = [];
  for (const stmt of splitStatements(doc, delimiter)) {
    if (!stmt.text.trim()) continue;
    out.push(...statementHints(stmt.from, stmt.text));
  }
  return out;
}
