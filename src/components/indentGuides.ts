/**
 * Indent guides — the faint vertical rules at each indentation level.
 *
 * CodeMirror ships `highlightWhitespace` but no indent guides, so this is a
 * small view plugin: one absolutely-positioned line per level, drawn behind
 * the text.
 *
 * Only lines in the viewport are decorated, and the whole thing rebuilds on
 * viewport change rather than on every keystroke — the same discipline the ER
 * canvas needed. A 5,000-line migration would otherwise carry twenty thousand
 * decorations it never shows.
 */
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { indentLevels } from '../utils/lineOps';

/** One guide column. Absolutely positioned, so it never affects layout. */
class GuideWidget extends WidgetType {
  // Explicit fields, not constructor parameter properties: the repo's
  // `node --test` runs in type-stripping mode, which does not support them.
  readonly levels: number;
  readonly indentUnit: number;
  constructor(levels: number, indentUnit: number) {
    super();
    this.levels = levels;
    this.indentUnit = indentUnit;
  }

  eq(other: GuideWidget) {
    return other.levels === this.levels && other.indentUnit === this.indentUnit;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-indent-guides';
    wrap.setAttribute('aria-hidden', 'true');
    for (let i = 1; i <= this.levels; i++) {
      const bar = document.createElement('span');
      bar.className = 'cm-indent-guide';
      bar.style.left = `${i * this.indentUnit}ch`;
      wrap.appendChild(bar);
    }
    return wrap;
  }

  // The widget draws nothing the cursor can land in.
  ignoreEvent() { return false; }
}

export function indentGuides(unit = 2) {
  return [
    ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = build(view, unit); }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view, unit);
      }
    }, { decorations: v => v.decorations }),
    EditorView.baseTheme({
      '.cm-indent-guides': { position: 'relative' },
      '.cm-indent-guide': {
        position: 'absolute',
        top: '0',
        bottom: '0',
        width: '1px',
        // Faint on purpose: a guide that competes with the text is worse than
        // no guide. Derived from the caret colour so it follows the theme.
        background: 'currentColor',
        opacity: '0.14',
        pointerEvents: 'none',
      },
    }),
  ];
}

function build(view: EditorView, unit: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const levels = indentLevels(line.text, unit);
      // A blank line has no indent of its own; drawing none there is what
      // every editor does and avoids a ladder of stubs between blocks.
      if (levels > 0) {
        builder.add(line.from, line.from, Decoration.widget({
          widget: new GuideWidget(levels, unit),
          side: -1,
        }));
      }
      if (line.to + 1 > to) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}
