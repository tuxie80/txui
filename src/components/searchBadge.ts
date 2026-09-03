/**
 * "3 of 17" badge for the CodeMirror search panel — the stock panel has no
 * match counter. A small ViewPlugin injects a span after the prev button and
 * refreshes it (debounced) on every update while the panel is open.
 */
import { ViewPlugin, EditorView } from '@codemirror/view';
import { countSearchMatches } from '../utils/searchCount.ts';

export const searchCountBadge = ViewPlugin.fromClass(class {
  timer = 0;
  span: HTMLElement | null = null;
  // Explicit field, not a parameter property: erasableSyntaxOnly forbids them.
  readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.schedule();
  }

  update() {
    this.schedule();
  }

  schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 120);
  }

  render() {
    const panel = this.view.dom.querySelector('.cm-panel.cm-search');
    if (!panel) { this.span = null; return; }
    if (!this.span || !this.span.isConnected) {
      this.span = document.createElement('span');
      this.span.className = 'cm-search-count';
      const prevBtn = panel.querySelector('button[name=prev]');
      if (prevBtn) prevBtn.after(this.span);
      else panel.appendChild(this.span);
    }
    const res = countSearchMatches(this.view.state);
    if (!res || res.total === 0) {
      this.span.textContent = res ? 'no results' : '';
      this.span.classList.toggle('cm-search-count-none', !!res && res.total === 0);
    } else {
      this.span.textContent = `${res.current || '–'} of ${res.total}`;
      this.span.classList.remove('cm-search-count-none');
    }
  }

  destroy() {
    window.clearTimeout(this.timer);
  }
});
