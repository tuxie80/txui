/**
 * CodeMirror commands for the line and case operations in `utils/lineOps.ts`,
 * plus the column-editor number insert.
 *
 * The split is deliberate: `lineOps` is pure and unit-tested, and this file is
 * only the CodeMirror glue — work out which lines the selection covers, run the
 * pure function, dispatch one transaction. Nothing here decides *what* an
 * operation means.
 *
 * Every command is a single transaction, so one undo puts the document back.
 */
import type { Command, EditorView } from '@codemirror/view';
import {
  convertCase, convertIndent, joinLines, keepDuplicateLines, numberSequence,
  removeBlankLines, removeDuplicateLines, reverseLines, shuffleLines, sortLines,
  trimTrailing, type CaseMode, type SortMode,
} from '../utils/lineOps';

/**
 * The whole lines the selection touches, or the whole document when there is
 * no selection.
 *
 * Whole-document is the right default and matches Notepad++: "sort" with
 * nothing selected means sort the file. Partial lines are extended to their
 * ends, because sorting half a line is not a thing anyone wants.
 */
function lineRange(view: EditorView): { from: number; to: number; lines: string[] } {
  const { state } = view;
  const sel = state.selection.main;
  const empty = sel.empty;
  const fromLine = state.doc.lineAt(empty ? 0 : sel.from);
  const toLine = state.doc.lineAt(empty ? state.doc.length : sel.to);
  const text = state.sliceDoc(fromLine.from, toLine.to);
  return { from: fromLine.from, to: toLine.to, lines: text.split('\n') };
}

/** Run a pure line transform over the selection (or document) as one change. */
function transformLines(view: EditorView, fn: (lines: string[]) => string[]): boolean {
  const { from, to, lines } = lineRange(view);
  const next = fn(lines).join('\n');
  if (next === view.state.sliceDoc(from, to)) return false;   // nothing to do
  view.dispatch({
    changes: { from, to, insert: next },
    // Keep the transformed block selected so the next operation can chain —
    // sort, then dedupe, then trim, without re-selecting each time.
    selection: { anchor: from, head: from + next.length },
    scrollIntoView: true,
    userEvent: 'input.lineop',
  });
  return true;
}

export const sortLinesCmd = (mode: SortMode, caseSensitive = true): Command =>
  view => transformLines(view, ls => sortLines(ls, mode, caseSensitive));

export const dedupeLinesCmd = (caseSensitive = true): Command =>
  view => transformLines(view, ls => removeDuplicateLines(ls, caseSensitive));

export const keepDuplicatesCmd: Command = view => transformLines(view, keepDuplicateLines);
export const reverseLinesCmd: Command = view => transformLines(view, reverseLines);
export const shuffleLinesCmd: Command = view => transformLines(view, ls => shuffleLines(ls));
export const removeBlankLinesCmd: Command = view => transformLines(view, removeBlankLines);
export const trimTrailingCmd: Command = view => transformLines(view, trimTrailing);
export const joinLinesCmd: Command = view => transformLines(view, ls => joinLines(ls));
export const indentToTabsCmd: Command = view => transformLines(view, ls => convertIndent(ls, 'tabs'));
export const indentToSpacesCmd: Command = view => transformLines(view, ls => convertIndent(ls, 'spaces'));

/**
 * Case conversion over every selection range.
 *
 * Ranges, plural: with multiple cursors each selection converts independently,
 * which is what makes this useful for renaming a handful of identifiers at
 * once. With nothing selected it does nothing rather than shouting the whole
 * document — an accidental ⌘U on a 500-line script is not recoverable in one
 * undo's worth of attention.
 */
export const convertCaseCmd = (mode: CaseMode): Command => view => {
  const ranges = view.state.selection.ranges.filter(r => !r.empty);
  if (!ranges.length) return false;
  view.dispatch({
    changes: ranges.map(r => ({
      from: r.from, to: r.to,
      insert: convertCase(view.state.sliceDoc(r.from, r.to), mode),
    })),
    userEvent: 'input.case',
  });
  return true;
};

/**
 * Insert a counter at each cursor — Notepad++'s Column Editor, without a
 * dialog.
 *
 * Alt-drag a column, or scatter cursors with ⌘D, then run this: the first gets
 * `start`, the next `start + step`, and so on. That is how a hundred-row
 * `INSERT` gets built in one gesture.
 *
 * Padding is derived from the largest number produced, so the column lines up
 * without the user having to work out the width in advance.
 */
export const insertNumberSequenceCmd = (
  start = 1, step = 1, pad: number | 'auto' = 'auto',
): Command => view => {
  const ranges = view.state.selection.ranges;
  if (ranges.length < 2) return false;   // one cursor is just typing a number
  const width = pad === 'auto'
    ? Math.max(
        String(start).length,
        String(start + step * (ranges.length - 1)).length,
      )
    : pad;
  // Only pad when the numbers actually differ in width; otherwise "auto"
  // would zero-fill a plain 1..9 for no reason.
  const plain = numberSequence(ranges.length, start, step, 0);
  const widths = new Set(plain.map(s => s.length));
  const seq = widths.size > 1 ? numberSequence(ranges.length, start, step, width) : plain;
  view.dispatch({
    changes: ranges.map((r, i) => ({ from: r.from, to: r.to, insert: seq[i] })),
    userEvent: 'input.sequence',
  });
  return true;
};
