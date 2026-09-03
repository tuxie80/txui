/**
 * Which gutter line numbers light up for a selection — the decision behind
 * SqlEditor's number gutter. Stock CodeMirror lights only the caret's line
 * (highlightActiveLineGutter); the owner wants every line a selection COVERS
 * lit the same way, so the selection is visible in the number column.
 *
 * Rules:
 * - Empty ranges (bare carets) contribute nothing — the active-line style is
 *   the gutter's separate concern, unchanged from stock.
 * - A range lights every line it holds a character on. A range ending exactly
 *   AT a line's start (the common case after shift-clicking whole lines: the
 *   trailing newline is selected) holds nothing of that line — NOT lit.
 * - Reversed ranges (upward drags) normalize; multi-cursor unions.
 *
 * Pure: no React/Tauri/CodeMirror imports — unit-tested with node --test.
 */

export interface LineRange { from: number; to: number }

/** 1-based line numbers covered by any of the given ranges. */
export function selectedLineNumbers(doc: string, ranges: readonly LineRange[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const r of ranges) {
    const from = Math.min(r.from, r.to);
    const to = Math.max(r.from, r.to);
    if (to <= from) continue;
    let lineStart = 0;
    let n = 1;
    while (lineStart < to) {
      const nl = doc.indexOf('\n', lineStart);
      const lineEnd = nl === -1 ? doc.length : nl;
      // The range holds a character on this line iff it reaches into
      // [lineStart, lineEnd]: starts no later than the line's end, ends after
      // the line's start.
      if (from <= lineEnd && to > lineStart) out.add(n);
      if (nl === -1) break;
      lineStart = nl + 1;
      n++;
    }
  }
  return out;
}
