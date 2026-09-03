/**
 * Turn the ER canvas into a file somebody else can open.
 *
 * The main reason anyone opens a diagram tool is to show the diagram to
 * someone else, and until now TxUI could show it to nobody — no image, no
 * file, no clipboard.
 *
 * The canvas is a hybrid: edges are already SVG, nodes are absolutely
 * positioned HTML. Rather than screenshotting the DOM (which needs the element
 * to be on screen, at the right zoom, with fonts settled), this re-emits the
 * whole thing as one standalone SVG from the same geometry the canvas lays out
 * from. The export therefore covers the entire diagram at full fidelity
 * regardless of where the viewport happens to be.
 *
 * **Colours are baked in, not inherited.** The app draws through CSS custom
 * properties which do not exist inside a detached `.svg` file — a themed
 * export that inherits them comes out black-on-black. The caller passes a
 * resolved palette read from the live document.
 */
import {
  columnRow, ER_HEADER_H, ER_NODE_W, ER_ROW_H, erNodeHAt, routeEdge, visibleColumns,
} from './erLayout.ts';
import type { ErEdge, ErPos, ErTable } from './erLayout.ts';
import type { Density } from './diagramModel.ts';

export interface ExportTheme {
  bg: string;
  nodeBg: string;
  nodeHead: string;
  headText: string;
  text: string;
  muted: string;
  border: string;
  edge: string;
  edgeVirtual: string;
}

/** Read the theme off the live document so the export matches what is on screen. */
export function themeFromDocument(el: Element | null): ExportTheme {
  const cs = el ? getComputedStyle(el) : null;
  const v = (name: string, fallback: string) => {
    const got = cs?.getPropertyValue(name).trim();
    return got || fallback;
  };
  // These names are the app's own tokens (App.css `:root`), not invented ones.
  // Getting them wrong is silent: `v()` falls back and the export comes out in
  // light colours whatever the theme, which is exactly what happened the first
  // time this was written.
  return {
    bg:          v('--bg', '#ffffff'),
    nodeBg:      v('--bg2', '#ffffff'),
    nodeHead:    v('--bg3', '#eef1f5'),
    headText:    v('--text', '#1a1a1a'),
    text:        v('--text', '#1a1a1a'),
    muted:       v('--text2', '#6a6a6a'),
    border:      v('--border', '#d0d4da'),
    edge:        v('--accent', '#3b82f6'),
    edgeVirtual: v('--text2', '#8a8a8a'),
  };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface SvgOptions {
  tables: ErTable[];
  edges: ErEdge[];
  pos: Map<string, ErPos>;
  density: Density;
  /** Per-table header colour, when the diagram assigns one. */
  colors?: Map<string, string>;
  notes?: Array<{ x: number; y: number; w: number; h: number; text: string }>;
  theme: ExportTheme;
  title?: string;
}

/**
 * Serialise to a standalone SVG document.
 *
 * Pure: no DOM, no measurement — every coordinate comes from the same
 * `erLayout` geometry the canvas uses, which is why the output matches what
 * was on screen and why this is unit-testable.
 */
export function diagramToSvg(o: SvgOptions): string {
  const { tables, edges, pos, density, theme } = o;
  const drawn = tables.filter(t => pos.has(t.name));

  // Bounds over nodes *and* notes, with a margin, then translate everything so
  // the content starts at the origin — an SVG cropped to its content is what
  // pastes cleanly into a document.
  const M = 40;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  };
  for (const t of drawn) {
    const p = pos.get(t.name)!;
    grow(p.x, p.y, ER_NODE_W, erNodeHAt(t, density));
  }
  for (const n of o.notes ?? []) grow(n.x, n.y, n.w, n.h);
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }

  const w = Math.ceil(maxX - minX + M * 2);
  const h = Math.ceil(maxY - minY + M * 2);
  const dx = M - minX, dy = M - minY;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    o.title ? `<title>${esc(o.title)}</title>` : '',
    `<rect width="${w}" height="${h}" fill="${esc(theme.bg)}"/>`,
    // Markers must be defined inside the exported file; the app's live <defs>
    // do not travel with it.
    `<defs>`,
    `<marker id="x-crow" markerWidth="14" markerHeight="12" refX="13" refY="6" orient="auto-start-reverse" markerUnits="userSpaceOnUse">`,
    `<path d="M 2 6 L 13 0 M 2 6 L 13 12" fill="none" stroke="${esc(theme.edge)}" stroke-width="1.3"/></marker>`,
    `<marker id="x-one" markerWidth="10" markerHeight="12" refX="7" refY="6" orient="auto" markerUnits="userSpaceOnUse">`,
    `<path d="M 7 0 L 7 12" fill="none" stroke="${esc(theme.edge)}" stroke-width="1.3"/></marker>`,
    `</defs>`,
    `<g transform="translate(${dx},${dy})" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
  );

  // Edges first so nodes sit on top of them, matching the canvas.
  const shown = new Set(drawn.map(t => t.name));
  const byName = new Map(drawn.map(t => [t.name, t]));
  for (const e of edges) {
    if (!shown.has(e.fromTable) || !shown.has(e.toTable)) continue;
    const from = byName.get(e.fromTable)!, to = byName.get(e.toTable)!;
    const a = pos.get(e.fromTable)!, b = pos.get(e.toTable)!;
    const r = routeEdge(
      a, columnRow(from.columns, e.fromCol, density),
      b, columnRow(to.columns, e.toCol, density),
      e.fromTable, e.toTable,
    );
    const stroke = e.virtual ? theme.edgeVirtual : theme.edge;
    const dash = e.virtual ? ' stroke-dasharray="5 4"' : '';
    parts.push(
      `<path d="${r.d}" fill="none" stroke="${esc(stroke)}" stroke-width="1.3"${dash}`
      + ` marker-start="url(#x-crow)" marker-end="url(#x-one)"/>`,
    );
  }

  for (const t of drawn) {
    const p = pos.get(t.name)!;
    const cols = visibleColumns(t.columns, density);
    const nh = erNodeHAt(t, density);
    const head = o.colors?.get(t.name) ?? theme.nodeHead;
    parts.push(
      `<g transform="translate(${p.x},${p.y})">`,
      `<rect width="${ER_NODE_W}" height="${nh}" rx="4" fill="${esc(theme.nodeBg)}" stroke="${esc(theme.border)}"/>`,
      `<path d="M0 4 a4 4 0 0 1 4 -4 h${ER_NODE_W - 8} a4 4 0 0 1 4 4 v${ER_HEADER_H - 4} h-${ER_NODE_W} z" fill="${esc(head)}"/>`,
      `<text x="8" y="${ER_HEADER_H - 10}" font-size="11.5" font-weight="600" fill="${esc(theme.headText)}">${esc(t.name)}</text>`,
      `<text x="${ER_NODE_W - 8}" y="${ER_HEADER_H - 10}" font-size="10" text-anchor="end" fill="${esc(theme.muted)}">${t.columns.length}</text>`,
    );
    cols.forEach((c, i) => {
      const y = ER_HEADER_H + i * ER_ROW_H + ER_ROW_H - 6;
      const badge = c.pk ? 'PK' : c.fk ? 'FK' : c.unique ? 'U' : '';
      parts.push(
        `<text x="8" y="${y}" font-size="10" fill="${esc(theme.muted)}">${esc(badge)}</text>`,
        `<text x="30" y="${y}" font-size="10.5" fill="${esc(theme.text)}"${c.pk ? ' font-weight="600"' : ''}>${esc(c.name)}</text>`,
        `<text x="${ER_NODE_W - 8}" y="${y}" font-size="9.5" text-anchor="end" fill="${esc(theme.muted)}">${esc(c.type)}</text>`,
      );
    });
    const hidden = t.columns.length - cols.length;
    if (hidden > 0 && density !== 'header') {
      const y = ER_HEADER_H + cols.length * ER_ROW_H + ER_ROW_H - 6;
      parts.push(`<text x="8" y="${y}" font-size="9.5" fill="${esc(theme.muted)}">+${hidden} more</text>`);
    }
    parts.push('</g>');
  }

  for (const n of o.notes ?? []) {
    parts.push(
      `<g transform="translate(${n.x},${n.y})">`,
      `<rect width="${n.w}" height="${n.h}" rx="3" fill="${esc(theme.nodeHead)}" stroke="${esc(theme.border)}"/>`,
    );
    // No text wrapping in SVG, so lay the lines out here at the same width the
    // canvas uses.
    n.text.split('\n').forEach((line, i) => {
      parts.push(`<text x="9" y="${18 + i * 15}" font-size="11" fill="${esc(theme.text)}">${esc(line)}</text>`);
    });
    parts.push('</g>');
  }

  parts.push('</g>', '</svg>');
  return parts.filter(Boolean).join('\n');
}

/** Rasterise an SVG string to a PNG blob at `scale`× for a crisp result. */
export function svgToPng(svg: string, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // A data URL rather than a blob URL: the image is same-origin either way,
    // but a data URL keeps the canvas untainted on every platform, and a
    // tainted canvas cannot be exported at all.
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('no 2d context')); return; }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas produced no image')), 'image/png');
    };
    img.onerror = () => reject(new Error('the diagram could not be rasterised'));
    img.src = url;
  });
}

/** Offer a file to the user. */
export function downloadSvg(svg: string, filename: string): void {
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), filename);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some engines; a tick is
  // enough and the object is small.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `orders-2026-08-11.svg` — a name that sorts and says what it is. */
export function diagramFileName(name: string, ext: 'svg' | 'png', today: string): string {
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram';
  return `${safe}-${today}.${ext}`;
}

// ── Exporting a *live* SVG node ───────────────────────────────────────────────
//
// `diagramToSvg` re-emits the ER canvas from geometry, but the chart and the
// plan graph already render a real `<svg>` in the DOM. The cheapest correct
// export for those is to serialise the node that is already on screen — with
// one catch that is the whole reason this exists: those SVGs paint through CSS
// classes and `var(--…)` custom properties (App.css), none of which exist
// inside a detached `.svg` file. Serialised verbatim they come out blank on a
// white page, exactly as an ER export did before its colours were baked in.

/**
 * Paint-affecting properties copied inline onto each node when a live SVG is
 * serialised. Deliberately *excludes* `transform`: the live view may be panned
 * or zoomed via an inline transform, and the export should land in the SVG's
 * own coordinate space rather than wherever the viewport happened to sit.
 */
export const SVG_INLINE_PROPS = [
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin',
  'opacity', 'color',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'letter-spacing',
];

/**
 * Build an inline `style` string from a computed-style reader, keeping only the
 * paint properties an exported SVG needs. Pure — the reader is injected — so it
 * is the unit-testable core of `liveSvgToString`. `none`/`normal` values are
 * kept deliberately: `fill:none` on a line-chart polyline is load-bearing, and
 * dropping it would flood the export with solid fills.
 */
export function svgInlineStyle(read: (prop: string) => string): string {
  let out = '';
  for (const p of SVG_INLINE_PROPS) {
    const v = read(p)?.trim();
    if (v) out += `${p}:${v};`;
  }
  return out;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Serialise a live `<svg>` element to a standalone, theme-safe SVG string.
 *
 * Deep-clones the node, bakes each element's resolved paint styles inline (see
 * `svgInlineStyle`), stamps the intrinsic size from the viewBox, and — since a
 * detached file has no page behind it — paints `background` across the viewBox
 * so a dark-theme export is not black-on-transparent when dropped on white.
 *
 * DOM-bound by nature (it reads `getComputedStyle`); everything pure lives in
 * `svgInlineStyle`.
 */
export function liveSvgToString(
  svg: SVGSVGElement, opts: { background?: string; title?: string } = {},
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  for (let i = 0; i < src.length; i++) {
    const cs = getComputedStyle(src[i]);
    (dst[i] as SVGElement).setAttribute('style', svgInlineStyle(p => cs.getPropertyValue(p)));
  }
  clone.setAttribute('xmlns', SVG_NS);
  clone.removeAttribute('class');

  const vb = svg.viewBox?.baseVal;
  const w = vb && vb.width ? vb.width : (svg.getBoundingClientRect().width || 1);
  const h = vb && vb.height ? vb.height : (svg.getBoundingClientRect().height || 1);
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);

  if (opts.title) {
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = opts.title;
    clone.insertBefore(t, clone.firstChild);
  }
  if (opts.background) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(vb?.x ?? 0));
    rect.setAttribute('y', String(vb?.y ?? 0));
    rect.setAttribute('width', String(vb?.width || w));
    rect.setAttribute('height', String(vb?.height || h));
    rect.setAttribute('fill', opts.background);
    // Behind the title too, but the first *renderable* node — so it paints
    // under the content, never over it.
    clone.insertBefore(rect, clone.firstChild);
  }
  return new XMLSerializer().serializeToString(clone);
}
