/**
 * Line and case operations — Notepad++'s *Line Operations* and Sublime's
 * *Permute Lines*, as pure functions over an array of lines.
 *
 * These are the operations people actually perform on a generated `INSERT`
 * list or a column dump, and the SQL editor had none of them: no sort, no
 * dedupe, no case conversion for a selection (the formatter cases *keywords*,
 * which is a different thing).
 *
 * Everything takes and returns `string[]` so the CodeMirror side only has to
 * decide *which* lines — the whole document, or the ones the selection touches
 * — and never has to know how any of this works. Pure, so `node --test` covers
 * it.
 */

export type SortMode = 'asc' | 'desc' | 'numeric-asc' | 'numeric-desc';

/**
 * The leading number in a line, for numeric sort. `null` when there is none.
 *
 * Numeric sort exists because lexicographic order puts `10` before `9`, which
 * is wrong for anything derived from an id. Lines without a number sort after
 * the ones that have one rather than being treated as zero — burying them at
 * the top among real zeroes would hide them.
 */
export function leadingNumber(line: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(line);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function sortLines(lines: string[], mode: SortMode, caseSensitive = true): string[] {
  const out = [...lines];
  if (mode === 'asc' || mode === 'desc') {
    // localeCompare, not `<`: `Č` must sort next to `C`, not after `Z`.
    const cmp = caseSensitive
      ? (a: string, b: string) => a.localeCompare(b)
      : (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
    out.sort(cmp);
    if (mode === 'desc') out.reverse();
    return out;
  }
  out.sort((a, b) => {
    const na = leadingNumber(a), nb = leadingNumber(b);
    if (na === null && nb === null) return a.localeCompare(b);
    if (na === null) return 1;    // numberless lines go last, not to zero
    if (nb === null) return -1;
    return na - nb;
  });
  if (mode === 'numeric-desc') out.reverse();
  return out;
}

/**
 * Drop repeats, keeping the first of each.
 *
 * First rather than last so the order of what remains matches the order it was
 * written in — the usual reason for deduping a list is to keep reading it.
 */
export function removeDuplicateLines(lines: string[], caseSensitive = true): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const key = caseSensitive ? l : l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/** Only the lines that appear more than once — the inverse question. */
export function keepDuplicateLines(lines: string[], caseSensitive = true): string[] {
  const count = new Map<string, number>();
  for (const l of lines) {
    const key = caseSensitive ? l : l.toLowerCase();
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return lines.filter(l => (count.get(caseSensitive ? l : l.toLowerCase()) ?? 0) > 1);
}

export function reverseLines(lines: string[]): string[] {
  return [...lines].reverse();
}

/**
 * Shuffle, given a random source.
 *
 * The source is a parameter so the caller supplies `Math.random` and the test
 * supplies something predictable — a shuffle that cannot be tested is a
 * shuffle nobody can prove terminates on the right multiset.
 */
export function shuffleLines(lines: string[], rand: () => number = Math.random): string[] {
  const out = [...lines];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Blank (or whitespace-only) lines removed. */
export function removeBlankLines(lines: string[]): string[] {
  return lines.filter(l => l.trim() !== '');
}

/** Trailing spaces and tabs stripped from each line. */
export function trimTrailing(lines: string[]): string[] {
  return lines.map(l => l.replace(/[ \t]+$/, ''));
}

/** Collapse to one line, separated by `sep`. Notepad++ binds this to Ctrl+J. */
export function joinLines(lines: string[], sep = ' '): string[] {
  return [lines.map(l => l.trim()).filter(Boolean).join(sep)];
}

/** Leading indentation converted between tabs and spaces. Only the indent. */
export function convertIndent(lines: string[], to: 'tabs' | 'spaces', width = 4): string[] {
  return lines.map(l => {
    const m = /^[ \t]*/.exec(l)![0];
    if (!m) return l;
    const rest = l.slice(m.length);
    // Count in visual columns so a mixed indent converts to the right depth
    // rather than being counted character by character.
    let cols = 0;
    for (const ch of m) cols += ch === '\t' ? width - (cols % width) : 1;
    const indent = to === 'tabs'
      ? '\t'.repeat(Math.floor(cols / width)) + ' '.repeat(cols % width)
      : ' '.repeat(cols);
    return indent + rest;
  });
}

// ── Case ────────────────────────────────────────────────────────────────────

export type CaseMode = 'upper' | 'lower' | 'title' | 'swap';

/**
 * Case conversion for a selection.
 *
 * `title` uppercases the first letter of each word and lowercases the rest,
 * which is what every editor here means by it. Word boundaries are
 * non-letters, so `customer_id` becomes `Customer_Id` — deliberate, since that
 * is what the same command does in Notepad++ and Sublime.
 */
export function convertCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case 'upper': return text.toUpperCase();
    case 'lower': return text.toLowerCase();
    case 'title':
      return text.replace(/\p{L}[\p{L}\p{N}']*/gu,
        w => w[0].toUpperCase() + w.slice(1).toLowerCase());
    case 'swap':
      return [...text].map(c => {
        const u = c.toUpperCase(), l = c.toLowerCase();
        if (u === l) return c;
        return c === l ? u : l;
      }).join('');
  }
}

// ── Column editor ───────────────────────────────────────────────────────────

/**
 * The number sequence Notepad++'s Column Editor inserts down a block.
 *
 * The reason it earns its place: this is how a hundred-row `INSERT` gets built
 * in one gesture instead of a hundred keystrokes or a throwaway script.
 *
 * `pad` zero-fills to a fixed width, which matters when the numbers become
 * part of an identifier and have to sort.
 */
export function numberSequence(
  count: number, start: number, step: number, pad = 0, hex = false,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(0, count); i++) {
    const n = start + i * step;
    let s = hex ? Math.trunc(n).toString(16) : String(n);
    if (pad > 0 && s.length < pad) {
      // Pad after the sign, not before it: `-007`, never `00-7`.
      const neg = s.startsWith('-');
      const body = neg ? s.slice(1) : s;
      s = (neg ? '-' : '') + body.padStart(pad - (neg ? 1 : 0), '0');
    }
    out.push(s);
  }
  return out;
}

/**
 * How deep a line is indented, in units — the depth an indent guide is drawn
 * at.
 *
 * A tab advances to the next stop rather than counting as a fixed width, so a
 * file mixing tabs and spaces produces guides where the text actually sits.
 * Lives here rather than beside the CodeMirror plugin so it can be tested
 * without pulling the editor into a `node --test` run.
 */
export function indentLevels(text: string, unit: number): number {
  let cols = 0;
  for (const ch of text) {
    if (ch === '\t') cols += unit - (cols % unit);
    else if (ch === ' ') cols += 1;
    else break;
  }
  return Math.floor(cols / unit);
}
