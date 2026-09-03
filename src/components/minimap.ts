/**
 * Lightweight editor minimap (no dependency — none exists for CM6).
 *
 * An absolutely-positioned canvas pinned to the editor's right edge:
 *  - one bar per line (width ∝ content length), downsampled per pixel row
 *    when the document has more lines than the map has pixels;
 *  - a cheap string/comment state machine tints comment lines green-ish and
 *    string-heavy lines warm — fidelity is deliberately low, cost is O(doc)
 *    on a 300 ms debounce after edits, never on keystroke;
 *  - the viewport rectangle tracks scrolling (rAF-cheap transform update);
 *  - click/drag scrolls the editor;
 *  - matches of the CURRENT search query are drawn as accent markers, with a
 *    "current / total" badge at the top.
 *
 * Rebuild cost for a 100k-line script is one O(chars) scan plus O(pixels)
 * drawing — a few ms, off the typing path.
 */
import { ViewPlugin, EditorView } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { countSearchMatches } from '../utils/searchCount.ts';
import { getSearchQuery } from '@codemirror/search';
import type { EditorState } from '@codemirror/state';

const WIDTH = 88;
/** bar width saturates at this many characters of line content */
const FULL_CHARS = 120;
const RENDER_DEBOUNCE_MS = 300;

/** per-line: 0 = code, 1 = comment, 2 = string-heavy */
interface LineModel { kinds: Uint8Array; lens: Uint16Array; count: number }

/**
 * One pass over the document: content length per line, and whether the line
 * is dominated by a comment or a string. Mirrors the string/comment rules of
 * utils/sqlSplit (quotes, backticks, --, #, block comments, dollar quoting).
 */
function scanLines(doc: string): LineModel {
  const kinds: number[] = [];
  const lens: number[] = [];
  const n = doc.length;
  let i = 0;
  let lineLen = 0;
  let lineKind = 0;

  const endLine = () => {
    kinds.push(lineKind);
    lens.push(Math.min(lineLen, FULL_CHARS));
    lineLen = 0;
    lineKind = 0;
  };

  while (i < n) {
    const ch = doc[i];
    const next = i + 1 < n ? doc[i + 1] : '';
    if (ch === '\n') { endLine(); i++; continue; }
    if ((ch === '-' && next === '-') || ch === '#') {
      lineKind = 1;
      const nl = doc.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      lineLen += end - i;
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = doc.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      lineKind = 1;
      const seg = doc.slice(i, end);
      const parts = seg.split('\n');
      lineLen += parts[0].length;
      for (let p = 1; p < parts.length; p++) { endLine(); lineKind = 1; lineLen = parts[p].length; }
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      let j = i + 1;
      while (j < n) {
        if (doc[j] === '\\') { j += 2; continue; }
        if (doc[j] === '\n') break;
        if (doc[j] === q) { j++; break; }
        j++;
      }
      if (lineKind === 0) lineKind = 2;
      lineLen += j - i;
      i = j;
      continue;
    }
    if (ch === '$') {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(doc.slice(i, i + 64));
      if (m) {
        const close = doc.indexOf(m[0], i + m[0].length);
        const end = close === -1 ? n : close + m[0].length;
        if (lineKind === 0) lineKind = 2;
        lineLen += end - i; // multi-line bodies just count as one long line
        i = end;
        continue;
      }
    }
    if (!/\s/.test(ch)) lineLen++;
    i++;
  }
  endLine();
  return {
    kinds: Uint8Array.from(kinds),
    lens: Uint16Array.from(lens),
    count: kinds.length,
  };
}

const minimapPlugin = ViewPlugin.fromClass(class {
  dom: HTMLElement;
  canvas: HTMLCanvasElement;
  viewportEl: HTMLElement;
  countEl: HTMLElement;
  renderTimer = 0;
  model: LineModel | null = null;
  dragging = false;
  onScroll: () => void;
  onMove: (e: MouseEvent) => void;
  onUp: () => void;
  // Explicit field, not a parameter property: erasableSyntaxOnly forbids them.
  readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-minimap';
    this.canvas = document.createElement('canvas');
    this.viewportEl = document.createElement('div');
    this.viewportEl.className = 'cm-minimap-viewport';
    this.countEl = document.createElement('div');
    this.countEl.className = 'cm-minimap-count';
    this.dom.append(this.canvas, this.viewportEl, this.countEl);
    view.dom.appendChild(this.dom);

    this.onScroll = () => this.updateViewport();
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.dom.addEventListener('mousedown', this.onMouseDown);
    this.onMove = e => { if (this.dragging) this.scrollTo(e); };
    this.onUp = () => { this.dragging = false; };
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);

    this.scheduleRender(0);
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      this.model = null;
      this.scheduleRender(RENDER_DEBOUNCE_MS);
    } else if (update.transactions.some(tr => tr.effects.length > 0)) {
      // search-query changes arrive as effects
      this.scheduleRender(120);
    }
    if (update.viewportChanged || update.geometryChanged) {
      if (update.geometryChanged) this.scheduleRender(0);
      this.updateViewport();
    }
  }

  scheduleRender(delay: number) {
    window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.render(), delay);
  }

  onMouseDown = (e: MouseEvent) => {
    this.dragging = true;
    this.scrollTo(e);
    e.preventDefault();
  };

  scrollTo(e: MouseEvent) {
    const rect = this.dom.getBoundingClientRect();
    if (rect.height <= 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const sd = this.view.scrollDOM;
    sd.scrollTop = frac * sd.scrollHeight - sd.clientHeight / 2;
  }

  updateViewport() {
    const sd = this.view.scrollDOM;
    const h = this.dom.clientHeight;
    if (h <= 0 || sd.scrollHeight <= 0) return;
    const top = (sd.scrollTop / sd.scrollHeight) * h;
    const height = Math.max(14, (sd.clientHeight / sd.scrollHeight) * h);
    this.viewportEl.style.transform = `translateY(${top}px)`;
    this.viewportEl.style.height = `${Math.min(height, h)}px`;
  }

  render() {
    const view = this.view;
    const h = this.dom.clientHeight;
    if (h <= 0) return;
    const doc = view.state.doc;
    if (!this.model) this.model = scanLines(doc.toString());
    const { kinds, lens, count } = this.model;

    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== WIDTH * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = WIDTH * dpr;
      this.canvas.height = h * dpr;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, h);

    const cs = getComputedStyle(view.dom);
    const colCode = cs.getPropertyValue('--text2').trim() || '#888';
    const colComment = cs.getPropertyValue('--green').trim() || '#6a6';
    const colString = cs.getPropertyValue('--yellow').trim() || '#cc5';

    // Aggregate lines into pixel rows (downsampling when count > h).
    const rowH = count <= h ? h / count : 1;
    if (count <= h) {
      const barH = Math.min(Math.max(1, rowH * 0.6), 3);
      for (let ln = 0; ln < count; ln++) {
        const w = Math.max(2, (lens[ln] / FULL_CHARS) * (WIDTH - 14));
        ctx.fillStyle = kinds[ln] === 1 ? colComment : kinds[ln] === 2 ? colString : colCode;
        ctx.globalAlpha = kinds[ln] === 0 ? 0.5 : 0.4;
        ctx.fillRect(2, ln * rowH, w, barH);
      }
    } else {
      const scale = count / h;
      for (let y = 0; y < h; y++) {
        const from = Math.floor(y * scale);
        const to = Math.min(count, Math.max(from + 1, Math.floor((y + 1) * scale)));
        let w = 0;
        let kind = 0;
        for (let ln = from; ln < to; ln++) {
          if (lens[ln] > w) w = lens[ln];
          if (kinds[ln] === 1) kind = 1;
          else if (kinds[ln] === 2 && kind === 0) kind = 2;
        }
        if (w === 0) continue;
        ctx.fillStyle = kind === 1 ? colComment : kind === 2 ? colString : colCode;
        ctx.globalAlpha = kind === 0 ? 0.5 : 0.4;
        ctx.fillRect(2, y, Math.max(2, (w / FULL_CHARS) * (WIDTH - 14)), 1);
      }
    }

    // Search matches: accent markers on the right edge + the count badge.
    const matches = countSearchMatches(view.state);
    if (matches && matches.total > 0) {
      const colAccent = cs.getPropertyValue('--accent').trim() || '#68f';
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = colAccent;
      for (const ln of searchQueryLines(view.state)) {
        const y = count <= h ? (ln - 1) * rowH : ((ln - 1) / count) * h;
        ctx.fillRect(WIDTH - 10, y, 8, Math.min(Math.max(2, rowH * 0.6), 3));
      }
      this.countEl.textContent = `${matches.current || '–'} / ${matches.total}`;
      this.countEl.style.display = '';
    } else {
      this.countEl.textContent = '';
      this.countEl.style.display = 'none';
    }

    ctx.globalAlpha = 1;
    this.updateViewport();
  }

  destroy() {
    window.clearTimeout(this.renderTimer);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
    this.dom.remove();
  }
});

/** 1-based line numbers of all matches of the current search query. */
function searchQueryLines(state: EditorState): number[] {
  const query = getSearchQuery(state);
  if (!query.valid) return [];
  const lines: number[] = [];
  const cursor = query.getCursor(state.doc);
  for (let i = 0; i < 100_000; i++) {
    const m = cursor.next();
    if (m.done) break;
    lines.push(state.doc.lineAt(m.value.from).number);
  }
  return lines;
}

const minimapTheme = EditorView.theme({
  '.cm-minimap': {
    position: 'absolute', top: '0', right: '0', bottom: '0', width: `${WIDTH}px`,
    zIndex: '3', cursor: 'pointer',
    borderLeft: '1px solid var(--border)',
    backgroundColor: 'color-mix(in srgb, var(--bg2) 55%, transparent)',
  },
  '.cm-minimap canvas': { display: 'block', width: '100%', height: '100%' },
  '.cm-minimap-viewport': {
    position: 'absolute', left: '0', right: '0', top: '0',
    border: '1px solid var(--accent)', borderRadius: '2px',
    backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    pointerEvents: 'none',
  },
  '.cm-minimap-count': {
    position: 'absolute', top: '2px', left: '0', right: '0', textAlign: 'center',
    fontSize: 'calc(10px * var(--font-scale, 1))', color: 'var(--yellow)',
    pointerEvents: 'none', textShadow: '0 1px 2px var(--bg)',
  },
  // keep the text clear of the overlay
  '.cm-content': { paddingRight: `${WIDTH + 10}px` },
});

export function minimap(): Extension {
  return [minimapPlugin, minimapTheme];
}
