/**
 * Semantic expand/shrink selection — the pure half.
 *
 * Given the document and a caret (or the current range), compute the next
 * LARGER thing worth selecting, on a pragmatic ladder:
 *
 *   word → dotted identifier chain → string content → string incl. quotes
 *   → enclosing paren group (content, then incl. parens) → current statement
 *   → whole document
 *
 * Deliberately NOT a full SQL parser: string/comment awareness is borrowed
 * from sqlAlias.blank (paren matching runs on the blanked text, so parens
 * inside strings and comments never count) and the statement step is sqlSplit's
 * statementAtCaret, so it is blank-line and DELIMITER aware — the same bounds
 * ⌘↵ would run.
 *
 * Shrink is the caller's business: the editor keeps a small stack of the
 * ranges it expanded FROM and pops it. The ladder is recomputed on every
 * expand, so an edited buffer can never resurrect a stale step.
 */
import { blank } from './sqlAlias.ts';
import { statementAtCaret } from './sqlSplit.ts';

export interface SelRange { from: number; to: number }

const WORD = /[A-Za-z0-9_$]/;

/**
 * The quoted span (`'…'`, `"…"`, `` `…` ``) containing `pos`, scanned on the
 * RAW text with the same escape rules as sqlSplit (`''`, `\"`, `` `` `` all
 * double/escape). Returns the content range and the full range including the
 * quotes, or null when `pos` is not inside (or on) a quoted span.
 */
function quotedSpanAt(doc: string, pos: number): { content: SelRange; full: SelRange } | null {
  const n = doc.length;
  let i = 0;
  while (i < n) {
    const ch = doc[i];
    const next = i + 1 < n ? doc[i + 1] : '';
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = doc.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = doc.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      let j = i + 1;
      while (j < n) {
        if (doc[j] === '\\') { j += 2; continue; }
        if (doc[j] === q) {
          if (j + 1 < n && doc[j + 1] === q) { j += 2; continue; } // doubled quote
          j++;
          break;
        }
        j++;
      }
      // The span is [i, j): i = opening quote, j = just past the closing one.
      if (pos >= i && pos <= j && j > i + 1) {
        return { content: { from: i + 1, to: j - 1 }, full: { from: i, to: j } };
      }
      i = j;
      continue;
    }
    i++;
  }
  return null;
}

/** The word range around `pos`; a caret just past the last letter still counts. */
function wordAt(doc: string, pos: number): SelRange | null {
  const anchor = pos > 0 && !WORD.test(doc[pos] ?? '') && WORD.test(doc[pos - 1]) ? pos - 1 : pos;
  if (!WORD.test(doc[anchor] ?? '')) return null;
  let from = anchor;
  let to = anchor + 1;
  while (from > 0 && WORD.test(doc[from - 1])) from--;
  while (to < doc.length && WORD.test(doc[to])) to++;
  return from === to ? null : { from, to };
}

/** One chain segment ending at `end` (exclusive): ident chars or a quoted ident. */
function segmentBefore(doc: string, end: number): number | null {
  if (end <= 0) return null;
  const q = doc[end - 1];
  if (q === '`' || q === '"') {
    const open = doc.lastIndexOf(q, end - 2);
    return open >= 0 ? open : null;
  }
  let i = end;
  while (i > 0 && WORD.test(doc[i - 1])) i--;
  return i < end ? i : null;
}

/** One chain segment starting at `from`. */
function segmentAfter(doc: string, from: number): number | null {
  if (from >= doc.length) return null;
  const q = doc[from];
  if (q === '`' || q === '"') {
    const close = doc.indexOf(q, from + 1);
    return close >= 0 ? close + 1 : null;
  }
  let i = from;
  while (i < doc.length && WORD.test(doc[i])) i++;
  return i > from ? i : null;
}

/** Widen a word range over `schema`.`table` / `a.b.c` chains, quoted segments included. */
function chainAround(doc: string, r: SelRange): SelRange {
  let { from, to } = r;
  for (;;) {
    if (from >= 2 && doc[from - 1] === '.') {
      const seg = segmentBefore(doc, from - 1);
      if (seg != null && seg < from - 1) { from = seg; continue; }
    }
    if (to < doc.length && doc[to] === '.') {
      const seg = segmentAfter(doc, to + 1);
      if (seg != null && seg > to + 1) { to = seg; continue; }
    }
    break;
  }
  return { from, to };
}

/**
 * Every paren pair containing `pos`, innermost first, matched on the blanked
 * text (so parens inside strings and comments never count). Expand needs them
 * all: the ladder climbs one nesting level per step, and the step for an outer
 * pair is computed from the same caret — not by re-asking at a new position.
 */
function parensAt(doc: string, pos: number): { content: SelRange; full: SelRange }[] {
  const s = blank(doc);
  const stack: number[] = [];
  const pairs: { open: number; close: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') stack.push(i);
    else if (s[i] === ')') {
      const open = stack.pop();
      if (open === undefined) continue;
      if (open <= pos && pos <= i) pairs.push({ open, close: i });
    }
  }
  pairs.sort((a, b) => (a.close - a.open) - (b.close - b.open));
  return pairs.map(p => ({
    content: { from: p.open + 1, to: p.close },
    full: { from: p.open, to: p.close + 1 },
  }));
}

/**
 * The full expansion ladder at caret `pos`, smallest first. Every step
 * contains `pos` and is strictly larger than the step before it — steps that
 * would not grow (word == chain, statement == document) are dropped, so the
 * caller can always take the first step that beats its current range.
 */
export function expandSteps(doc: string, pos: number, delimiter = ';'): SelRange[] {
  const out: SelRange[] = [];
  const push = (r: SelRange | null) => {
    if (!r) return;
    if (r.from < 0 || r.to > doc.length || r.from >= r.to) return;
    if (r.from > pos || r.to < pos) return;                 // must contain the caret
    const prev = out[out.length - 1];
    if (prev && prev.from <= r.from && prev.to >= r.to) return; // not a growth — skip
    out.push(r);
  };

  const str = quotedSpanAt(doc, pos);
  if (str) {
    // Inside a string the word/chain steps would carve up literal text —
    // string content and string-with-quotes are the granular steps instead.
    push(str.content);
    push(str.full);
  } else {
    const word = wordAt(doc, pos);
    push(word);
    if (word) push(chainAround(doc, word));
  }

  for (const p of parensAt(doc, pos)) {
    push(p.content);
    push(p.full);
  }

  const stmt = statementAtCaret(doc, pos, delimiter);
  if (stmt) push({ from: stmt.from, to: stmt.to });

  if (doc.trim()) push({ from: 0, to: doc.length });
  return out;
}

/**
 * The next larger range for the selection `[from, to]`, or null at the top of
 * the ladder. A bare caret (from == to) takes the first step. An existing
 * range takes the first step that STRICTLY contains it — so expand after
 * expand keeps climbing instead of re-offering the step already selected.
 */
export function expandRange(doc: string, from: number, to: number, delimiter = ';'): SelRange | null {
  if (!doc.trim()) return null;
  for (const s of expandSteps(doc, from, delimiter)) {
    if (s.from <= from && s.to >= to && (s.from < from || s.to > to)) return s;
  }
  return null;
}
