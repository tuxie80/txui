/**
 * Change-bar gutter — the thin coloured strip VS Code, DataGrip and Sublime
 * draw beside lines that differ from a baseline, so at a glance you see which
 * lines you hand-patched: added (green), changed (blue) and deletions (a small
 * marker where baseline lines were removed).
 *
 * The status comes from the pure `lineChangeStatus` diff. It is computed ONCE
 * per keystroke PAUSE into a StateField, not per visible line and not per
 * keystroke — the diff is O(lines²), so running it on every transaction would
 * hang a large script; doc changes keep the last bars until the debounced
 * recompute fires. The colours are theme CSS vars (see the `.cm-changebar-*`
 * rules in App.css), a sibling of the run-marker gutter.
 */
import { EditorView, gutter, GutterMarker, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { Annotation, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { lineChangeStatus } from '../utils/lineDiff';
import type { LineChangeStatus } from '../utils/lineDiff';

interface ChangeInfo {
  status: LineChangeStatus[];
  deletedBefore: Set<number>;
}

function compute(baseline: string, doc: string): ChangeInfo {
  const r = lineChangeStatus(baseline, doc);
  return { status: r.status, deletedBefore: new Set(r.deletedBefore) };
}

/** Marks the transactions that carry a fresh diff. */
const recompute = Annotation.define<boolean>();

/** One gutter bar. The class carries both the line's status and, if a deletion
 *  gap sits at this line, the deletion marker — a line can be both. */
class ChangeMarker extends GutterMarker {
  // Explicit field, not a parameter property: `erasableSyntaxOnly` /
  // type-stripping forbid the shorthand (it would need emitted code).
  readonly cls: string;
  constructor(cls: string) { super(); this.cls = cls; }
  override eq(other: ChangeMarker) { return other.cls === this.cls; }
  override toDOM() {
    const el = document.createElement('div');
    el.className = this.cls;
    return el;
  }
}

// Markers are immutable, so cache one per class string and reuse it.
const markerCache = new Map<string, ChangeMarker>();
function marker(status: LineChangeStatus, del: boolean): ChangeMarker | null {
  if (status === 'unchanged' && !del) return null;
  let cls = 'cm-changebar';
  if (status === 'added') cls += ' cm-changebar-added';
  else if (status === 'changed') cls += ' cm-changebar-changed';
  if (del) cls += ' cm-changebar-del';
  let m = markerCache.get(cls);
  if (!m) { m = new ChangeMarker(cls); markerCache.set(cls, m); }
  return m;
}

/**
 * Change-bar gutter for the document against `baseline`. Wrap in a Compartment
 * so the baseline can be reconfigured (e.g. on save) without rebuilding the
 * editor.
 */
export function changeBars(baseline: string): Extension {
  const field = StateField.define<ChangeInfo>({
    create: (state) => compute(baseline, state.doc.toString()),
    // A doc change deliberately keeps the last diff (it is stale by at most
    // one keystroke pause); the debounced plugin below dispatches a
    // `recompute` transaction that does the actual O(lines²) work.
    update: (value, tr) =>
      tr.annotation(recompute) ? compute(baseline, tr.state.doc.toString()) : value,
  });

  const debounce = ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | undefined;
    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      clearTimeout(this.timer);
      const view = update.view;
      this.timer = setTimeout(() => {
        view.dispatch({ annotations: recompute.of(true) });
      }, 300);
    }
    destroy() { clearTimeout(this.timer); }
  });

  return [
    field,
    debounce,
    gutter({
      class: 'cm-changebar-gutter',
      lineMarker(view, line) {
        const info = view.state.field(field, false);
        if (!info) return null;
        const idx = view.state.doc.lineAt(line.from).number - 1;
        const status = info.status[idx] ?? 'unchanged';
        // A deletion gap before this line, or (for a gap past the very last
        // line, reported as length) drawn on the last line.
        const del = info.deletedBefore.has(idx)
          || (idx === view.state.doc.lines - 1 && info.deletedBefore.has(idx + 1));
        return marker(status, del);
      },
      // Recompute the visible markers whenever the diff could have moved —
      // that is the doc changing OR a fresh diff arriving.
      lineMarkerChange: (update) =>
        update.docChanged || update.transactions.some(tr => tr.annotation(recompute)),
    }),
    EditorView.baseTheme({
      '.cm-changebar-gutter': { width: '3px', padding: '0' },
      '.cm-changebar-gutter .cm-gutterElement': { padding: '0' },
    }),
  ];
}
