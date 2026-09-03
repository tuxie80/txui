/**
 * TODO / FIXME markers — the reminders a migration script accumulates
 * ("-- TODO: backfill before enabling the FK") should be VISIBLE while you
 * edit, and jumpable when you sweep the file before committing it to a ticket.
 *
 * Only COMMENTS are markers. The same word inside a string literal
 * (`'TODO: ask legal'`) is data, and the same word in code (`todo_list`) is an
 * identifier — neither gets painted. Comment ranges come from sqlAlias.blank:
 * strings and comments are both spaced out there, but blank() erases the
 * comment opener wholesale while KEEPING a string's quote chars — so a blanked
 * span that starts with `--`, `#` or `/*` AND is not preceded by a kept quote
 * is provably a comment (a string's interior always follows its quote, which
 * is what stops `'-- x'` from looking like one).
 *
 * Recognised keywords: TODO, FIXME, XXX, HACK — case-insensitive, bounded by
 * non-identifier characters (`TODOIST` and `HACKATHON` are not markers).
 * The decorated range is the whole comment, and `kind` is the FIRST keyword
 * in it — what a jump list would sort by.
 *
 * Pure: no React/Tauri imports — `node --test` covers it.
 */
import { blank } from './sqlAlias.ts';

export type TodoKind = 'todo' | 'fixme' | 'xxx' | 'hack';

export interface TodoMarker {
  /** The comment's range (opener included). */
  from: number;
  to: number;
  kind: TodoKind;
}

const KEYWORD = /(todo|fixme|xxx|hack)/gi;
const IDENT = /[A-Za-z0-9_$]/;

/** The first marker keyword inside `comment`, if one is present. */
function kindIn(comment: string): TodoKind | null {
  KEYWORD.lastIndex = 0;
  for (let m; (m = KEYWORD.exec(comment)) !== null;) {
    const before = m.index > 0 ? comment[m.index - 1] : '';
    const after = comment[m.index + m[0].length] ?? '';
    if (!IDENT.test(before) && !IDENT.test(after)) {
      return m[0].toLowerCase() as TodoKind;
    }
  }
  return null;
}

/**
 * Every comment in `text` that carries a marker keyword, in document order.
 *
 * Comment ranges are recovered by diffing against blank(): a maximal run of
 * blanked characters is a comment when its original text starts with a
 * comment opener. Spaces INSIDE a comment are indistinguishable from blanked
 * comment text — which is why the run is delimited by blanked alone, not by
 * the original's whitespace.
 */
export function todoMarkers(text: string): TodoMarker[] {
  const blanked = blank(text);
  const out: TodoMarker[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    // A blanked run: everything blank() erased (comment bodies, string
    // interiors). Real whitespace outside a comment has text[i] === ' ' and
    // starts no run — a run starts only where the original is NOT a space.
    if (blanked[i] !== ' ' || text[i] === ' ') { i++; continue; }
    let j = i + 1;
    while (j < n && blanked[j] === ' ') j++;
    const span = text.slice(i, j);
    if (isCommentSpan(text, blanked, i) && /^(--|#|\/\*)/.test(span)) {
      const kind = kindIn(span);
      if (kind) out.push({ from: i, to: j, kind });
    }
    i = j;
  }
  return out;
}

/**
 * Is the blanked run starting at `i` a comment rather than a string's
 * interior? blank() KEEPS a string's quote chars, so a string interior always
 * follows its kept opening quote. But a comment may itself directly follow a
 * string's closing quote (`'done'-- note`), so a preceding quote is only
 * damning when it is an OPENER: scan back over the blanked run before it —
 * finding a kept quote means the run between them was a string body and the
 * quote at `i-1` closed it (so this span is a comment); finding code or the
 * start means the quote opened a string and this span is its interior.
 */
function isCommentSpan(text: string, blanked: string, i: number): boolean {
  if (i === 0) return true;
  const q = text[i - 1];
  if (q !== "'" && q !== '"' && q !== '`') return true; // preceded by code — a comment
  if (blanked[i - 1] !== q) return true;                // not a kept quote — a comment
  for (let j = i - 2; j >= 0; j--) {
    if (blanked[j] === ' ') continue;
    return blanked[j] === q && text[j] === q; // kept quote found → q at i-1 was a closer
  }
  return false; // nothing before the quote — it opened the string this span lives in
}

/**
 * The marker to jump to from `pos`: the next one strictly ahead (or strictly
 * behind for dir -1), WRAPPING around the ends — a sweep should not stop at
 * the last marker and force a manual scroll back to the top.
 */
export function jumpTarget(
  markers: TodoMarker[], pos: number, dir: 1 | -1,
): TodoMarker | null {
  if (markers.length === 0) return null;
  if (dir === 1) {
    return markers.find(m => m.from > pos) ?? markers[0];
  }
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i].to < pos) return markers[i];
  }
  return markers[markers.length - 1];
}
