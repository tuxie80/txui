/**
 * Vertical rulers — the faint right-margin guides at fixed columns (VS Code's
 * `editor.rulers`, Sublime, Notepad++). One thin vertical line per configured
 * column, so you can see where 80 or 120 characters land without counting.
 *
 * A sibling of indentGuides.ts, but where those follow each line's indentation
 * this draws at fixed character columns. It is a DOM overlay rather than a
 * per-line widget: the lines span the whole document height at a constant x,
 * so a single absolutely-positioned element per column is cheaper than a
 * widget on every visible line.
 *
 * The x of a column is the content's left padding plus `column ×
 * defaultCharacterWidth` — the editor is monospaced, so that is exact. The
 * offset maths is the pure `rulerOffsets` below, which is what the test drives.
 */
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';

/**
 * Pixel x-offset of each ruler column. Pure: given the monospace character
 * width and the content's left padding, a column's line sits at
 * `paddingLeft + column × charWidth`. One offset per input column, in order.
 */
export function rulerOffsets(columns: number[], charWidth: number, paddingLeft: number): number[] {
  return columns.map(col => paddingLeft + col * charWidth);
}

/** The x where column 0 sits: the content box padding plus a line's own. */
function contentPaddingLeft(view: EditorView): number {
  let pad = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
  // Lines carry their own left padding (CodeMirror's default is 6px); the text
  // starts after it, so a ruler must too.
  const line = view.contentDOM.querySelector('.cm-line');
  if (line) pad += parseFloat(getComputedStyle(line).paddingLeft) || 0;
  return pad;
}

/**
 * A ruler at each column. An empty list is off (no plugin, no theme), so the
 * caller gates purely on the preference value.
 */
export function rulers(columns: number[]) {
  // Only sane, positive columns — a 0 or NaN column would sit on the gutter.
  const cols = columns.filter(c => Number.isFinite(c) && c > 0);
  if (cols.length === 0) return [];
  return [
    ViewPlugin.fromClass(class {
      // Explicit fields, not constructor parameter properties: the repo's
      // `node --test` runs in type-stripping mode, which does not support them.
      wrap: HTMLElement;
      bars: HTMLElement[];
      constructor(view: EditorView) {
        this.wrap = document.createElement('div');
        this.wrap.className = 'cm-rulers';
        this.wrap.setAttribute('aria-hidden', 'true');
        this.bars = cols.map(() => {
          const bar = document.createElement('div');
          bar.className = 'cm-ruler';
          this.wrap.appendChild(bar);
          return bar;
        });
        view.contentDOM.appendChild(this.wrap);
        this.draw(view);
      }
      update(u: ViewUpdate) {
        // The x only moves when the font (and so the character width) changes,
        // which is a geometry change — no need to touch the DOM on keystrokes.
        if (u.geometryChanged) this.draw(u.view);
      }
      draw(view: EditorView) {
        const offsets = rulerOffsets(cols, view.defaultCharacterWidth, contentPaddingLeft(view));
        offsets.forEach((x, i) => { this.bars[i].style.left = `${x}px`; });
      }
      destroy() { this.wrap.remove(); }
    }),
    EditorView.baseTheme({
      // Anchor the overlay to the content, not the scroller, so a ruler tracks
      // the text under horizontal scroll and clears the gutter.
      '.cm-content': { position: 'relative' },
      '.cm-rulers': {
        position: 'absolute', top: '0', bottom: '0', left: '0', right: '0',
        pointerEvents: 'none',
      },
      '.cm-ruler': {
        position: 'absolute',
        top: '0',
        bottom: '0',
        width: '1px',
        // Faint on purpose: a margin guide that competes with the text is worse
        // than none. Derived from the caret colour so it follows the theme,
        // exactly like the indent guides.
        background: 'currentColor',
        opacity: '0.14',
        pointerEvents: 'none',
      },
    }),
  ];
}
