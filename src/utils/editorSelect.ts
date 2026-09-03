/**
 * Editor selection commands the CodeMirror defaults don't cover:
 *   - select all occurrences of the current selection (VS Code ⌘⇧L),
 *   - split a multi-line selection into one cursor per line (⇧⌥I),
 *   - surround a non-empty selection with brackets/quotes instead of replacing
 *     it (closeBrackets only wraps an empty caret).
 *
 * Written directly against the CodeMirror state API so there is no dependency
 * on which selection helpers a given @codemirror/search version happens to
 * export. Pure command factories — SqlEditor wires them into the keymap.
 */
import { EditorSelection, type SelectionRange, type StateCommand } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** Select every occurrence of the primary selection's text (multi-cursor). */
export const selectAllOccurrences: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (sel.empty) return false;
  const query = state.sliceDoc(sel.from, sel.to);
  if (!query) return false;
  const doc = state.doc.toString();
  const ranges: SelectionRange[] = [];
  for (let i = doc.indexOf(query); i !== -1; i = doc.indexOf(query, i + query.length)) {
    ranges.push(EditorSelection.range(i, i + query.length));
  }
  if (ranges.length < 2) return false; // nothing gained over the existing selection
  dispatch(state.update({
    selection: EditorSelection.create(ranges),
    scrollIntoView: true,
    userEvent: 'select',
  }));
  return true;
};

/** Put a cursor at the end of each line the selection touches. */
export const splitSelectionIntoLines: StateCommand = ({ state, dispatch }) => {
  const ranges: SelectionRange[] = [];
  for (const r of state.selection.ranges) {
    if (r.empty) { ranges.push(r); continue; }
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let ln = first; ln <= last; ln++) {
      const line = state.doc.line(ln);
      // End of the line, but never past the selection's own end on the last line.
      ranges.push(EditorSelection.cursor(ln === last ? Math.min(line.to, r.to) : line.to));
    }
  }
  if (!ranges.length) return false;
  dispatch(state.update({ selection: EditorSelection.create(ranges), scrollIntoView: true }));
  return true;
};

const SURROUND: Record<string, string> = {
  '(': ')', '[': ']', '{': '}', "'": "'", '"': '"', '`': '`',
};

/**
 * Typing an opening bracket/quote with text selected wraps the selection rather
 * than replacing it. Falls through (returns false) when any range is empty, so
 * closeBrackets keeps handling the ordinary caret case.
 */
export const surroundInputHandler = EditorView.inputHandler.of((view, _from, _to, text) => {
  const close = SURROUND[text];
  if (!close) return false;
  const { state } = view;
  const rs = state.selection.ranges;
  if (!rs.length || rs.some(r => r.empty)) return false;
  const changes: { from: number; insert: string }[] = [];
  const newRanges: SelectionRange[] = [];
  let shift = 0; // two inserted chars accumulate per earlier range
  for (const r of rs) {
    changes.push({ from: r.from, insert: text }, { from: r.to, insert: close });
    newRanges.push(EditorSelection.range(r.from + shift + 1, r.to + shift + 1));
    shift += 2;
  }
  view.dispatch(state.update({
    changes,
    selection: EditorSelection.create(newRanges),
    userEvent: 'input.type',
  }));
  return true;
});
