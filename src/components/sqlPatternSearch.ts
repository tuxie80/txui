/**
 * "SQL pattern" mode for the stock CodeMirror search panel
 * (utils/structuralSearch.ts does the matching).
 *
 * The stock panel does literal/regex text search; flipping the injected
 * `SQL` toggle switches it to shape search: the search field holds a pattern
 * with `$holes$` (`SELECT * FROM $t$ WHERE $c$ = NULL`), matches come from
 * structuralSearch instead of SearchQuery, and the panel's own next / prev /
 * replace / replace-all buttons are intercepted (capture-phase, so the stock
 * handlers never fire) and re-routed to structural semantics — replace fills
 * the replace field as a template with the match's captured holes.
 *
 * The DOM surgery (inject button, inject count span, capture clicks) follows
 * the precedent of searchBadge.ts: the stock panel is not extensible, so we
 * augment it and leave the literal-find path completely untouched — with the
 * toggle off, this plugin does nothing at all.
 *
 * Deliberate leftovers, documented rather than solved:
 * - the stock literal-match highlight still runs underneath (a pattern like
 *   `$t$` has no literal occurrences in practice, so nothing double-paints);
 * - the stock "3 of 17" badge still counts literal matches — CSS hides it
 *   while pattern mode is on (`.cm-sql-pattern-on .cm-search-count`).
 */
import { EditorView, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import {
  structuralSearch, structuralReplace, substituteTemplate, type StructMatch,
} from '../utils/structuralSearch.ts';

const MATCH = Decoration.mark({ class: 'cm-struct-match' });

export const sqlPatternSearch = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none;
  /** Pattern mode on/off — panel-local, resets when the panel is closed. */
  active = false;
  matches: StructMatch[] = [];
  /** Cache keys: recompute only when the inputs actually moved. */
  lastDoc: unknown = null;
  lastQuery = '';
  timer = 0;
  btn: HTMLButtonElement | null = null;
  countSpan: HTMLElement | null = null;
  /** The panel element the click capture is attached to (recreated per open). */
  hookedPanel: Element | null = null;
  // Explicit field, not a parameter property: erasableSyntaxOnly forbids them.
  readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.schedule();
  }

  update(u: ViewUpdate) {
    const open = searchPanelOpen(u.state);
    if (!open && this.active) this.active = false; // closing the panel drops the mode
    const q = open ? getSearchQuery(u.state).search : '';
    if (!this.active || !q) {
      if (this.decorations !== Decoration.none) {
        this.decorations = Decoration.none;
        this.matches = [];
      }
      this.lastDoc = u.state.doc;
      this.lastQuery = q;
    } else if (u.state.doc !== this.lastDoc || q !== this.lastQuery) {
      this.lastDoc = u.state.doc;
      this.lastQuery = q;
      this.matches = structuralSearch(u.state.doc.toString(), q);
      this.decorations = this.matches.length
        ? Decoration.set(this.matches.map(m => MATCH.range(m.from, m.to)), true)
        : Decoration.none;
    }
    this.schedule();
  }

  /** Debounced DOM sync, same shape as searchBadge's. */
  schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.syncDom(), 120);
  }

  syncDom() {
    const panel = this.view.dom.querySelector('.cm-panel.cm-search');
    if (!panel) { this.btn = null; this.countSpan = null; this.hookedPanel = null; return; }

    if (!this.btn || !this.btn.isConnected) {
      const btn = document.createElement('button');
      btn.className = 'cm-sql-pattern-toggle';
      btn.type = 'button';
      btn.textContent = 'SQL';
      btn.title = 'SQL pattern search: $holes$ match any expression — '
        + 'e.g. SELECT * FROM $t$ WHERE $c$ = NULL';
      btn.addEventListener('click', () => {
        this.active = !this.active;
        this.btn?.setAttribute('aria-pressed', String(this.active));
        this.btn?.classList.toggle('cm-sql-pattern-on', this.active);
        // Invalidate the recompute cache so update() repaints immediately —
        // the toggle changes neither doc nor query, which are its cache keys.
        this.lastDoc = null;
        // An empty dispatch still runs the update cycle, which is where the
        // decorations recompute — the toggle itself changes no editor state.
        this.view.dispatch({});
        this.schedule();
      });
      const searchInput = panel.querySelector('input[name=search]');
      if (searchInput) searchInput.after(btn);
      else panel.appendChild(btn);
      this.btn = btn;
    }
    if (!this.countSpan || !this.countSpan.isConnected) {
      const span = document.createElement('span');
      span.className = 'cm-sql-pattern-count';
      this.btn.after(span);
      this.countSpan = span;
    }
    this.countSpan.textContent = this.active && this.lastQuery
      ? (this.matches.length
        ? `${this.matches.length} pattern match${this.matches.length === 1 ? '' : 'es'}`
        : 'no pattern matches')
      : '';
    panel.classList.toggle('cm-sql-pattern-on', this.active);

    // One capture listener per panel instance; it dies with the panel's DOM.
    if (this.hookedPanel !== panel) {
      this.hookedPanel = panel;
      panel.addEventListener('click', ev => this.onPanelClick(ev, panel), true);
    }
  }

  /** Intercept the stock buttons while pattern mode is on. */
  onPanelClick(ev: Event, panel: Element) {
    if (!this.active) return;
    const btn = (ev.target as HTMLElement | null)?.closest('button');
    const name = btn?.getAttribute('name');
    if (name !== 'next' && name !== 'prev' && name !== 'replace' && name !== 'replaceAll') return;
    ev.preventDefault();
    ev.stopPropagation();

    const view = this.view;
    const doc = view.state.doc.toString();
    const query = getSearchQuery(view.state).search;
    if (!query) return;
    const matches = structuralSearch(doc, query);
    this.matches = matches;
    if (matches.length === 0) { this.schedule(); return; }
    const head = view.state.selection.main.head;

    if (name === 'next' || name === 'prev') {
      const m = name === 'next'
        ? (matches.find(x => x.from >= head) ?? matches[0])
        : ([...matches].reverse().find(x => x.to <= head) ?? matches[matches.length - 1]);
      view.dispatch({ selection: { anchor: m.from, head: m.to }, scrollIntoView: true });
      view.focus();
      return;
    }

    const template = panel.querySelector<HTMLInputElement>('input[name=replace]')?.value ?? '';
    if (name === 'replaceAll') {
      const r = structuralReplace(doc, query, template);
      if (r.count === 0) return;
      // One change for the whole buffer: the undo history records a single
      // "replace all", and our own update() recomputes the matches after it.
      view.dispatch({ changes: { from: 0, to: doc.length, insert: r.text } });
      view.focus();
      return;
    }
    // replace: the first match at/after the caret (wrapping), like stock find.
    const m = matches.find(x => x.from >= head) ?? matches[0];
    const insert = substituteTemplate(template, m.captures);
    view.dispatch({
      changes: { from: m.from, to: m.to, insert },
      selection: { anchor: m.from + insert.length },
    });
    view.focus();
  }

  destroy() {
    window.clearTimeout(this.timer);
  }
}, { decorations: v => v.decorations });
