/**
 * Match counting for the editor search panel ("3 of 17").
 * Pure with respect to the DOM — testable under node --test.
 */
import type { EditorState } from '@codemirror/state';
import { getSearchQuery } from '@codemirror/search';

export interface SearchMatchCount {
  total: number;
  /** 1-based index of the current match (at/after the caret); 0 when none. */
  current: number;
}

/**
 * Count matches of the current search query, and which one is "current":
 * the match containing the caret, else the first match after it.
 * Returns null when there is no valid (non-empty) query.
 */
export function countSearchMatches(state: EditorState): SearchMatchCount | null {
  const query = getSearchQuery(state);
  if (!query.valid) return null;
  const head = state.selection.main.head;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(state.doc);
  while (total < 1_000_000) {           // paranoia cap — a match is never empty
    const m = cursor.next();
    if (m.done) break;
    total++;
    if (current === 0) {
      if (m.value.from <= head && head <= m.value.to) current = total;
      else if (m.value.from > head) current = total;
    }
  }
  return { total, current };
}
