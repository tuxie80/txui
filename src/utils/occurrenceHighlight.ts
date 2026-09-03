/**
 * Highlight every occurrence of the identifier under the caret — without having
 * to select it first (CodeMirror's highlightSelectionMatches only fires on a
 * selection). Reading a query, this instantly shows where an alias or column is
 * used. Viewport-scoped and word-boundaried, so it's cheap and doesn't light up
 * substrings.
 */
import { EditorView, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

const OCCURRENCE = Decoration.mark({ class: 'cm-occurrence' });

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const occurrenceHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: v => v.decorations },
);

function build(view: EditorView): DecorationSet {
  const sel = view.state.selection.main;
  // Only for a bare caret — a real selection is handled by highlightSelectionMatches.
  if (!sel.empty) return Decoration.none;
  const w = view.state.wordAt(sel.head);
  if (!w) return Decoration.none;
  const word = view.state.sliceDoc(w.from, w.to);
  if (word.length < 2) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const re = new RegExp(`\\b${escapeRe(word)}\\b`, 'g');
  let count = 0;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      count++;
      builder.add(from + m.index, from + m.index + word.length, OCCURRENCE);
    }
  }
  // A single occurrence (the word the caret is on) isn't worth decorating.
  return count > 1 ? builder.finish() : Decoration.none;
}
