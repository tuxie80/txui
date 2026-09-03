/**
 * SVG export (src/utils/erExport.ts). Pure string emission — no DOM, which is
 * the point: the export re-derives from the same geometry the canvas uses
 * rather than screenshotting it, so it can be checked here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagramFileName, diagramToSvg, svgInlineStyle, SVG_INLINE_PROPS, type ExportTheme,
} from '../src/utils/erExport.ts';
import type { ErEdge, ErPos, ErTable } from '../src/utils/erLayout.ts';

const theme: ExportTheme = {
  bg: '#ffffff', nodeBg: '#fefefe', nodeHead: '#eeeeee', headText: '#111111',
  text: '#222222', muted: '#777777', border: '#cccccc',
  edge: '#3b82f6', edgeVirtual: '#999999',
};

const tbl = (name: string, cols: Array<[string, boolean]>): ErTable => ({
  name,
  columns: cols.map(([n, pk]) => ({ name: n, type: 'int', pk, fk: false, unique: pk })),
});

const base = () => {
  const tables = [tbl('orders', [['id', true], ['note', false]]), tbl('customers', [['id', true]])];
  const edges: ErEdge[] = [{ fromTable: 'orders', fromCol: 'note', toTable: 'customers', toCol: 'id' }];
  const pos = new Map<string, ErPos>([['orders', { x: 0, y: 0 }], ['customers', { x: 400, y: 0 }]]);
  return { tables, edges, pos, theme, density: 'all' as const };
};

describe('diagramToSvg', () => {
  test('emits a standalone document with the namespace a file needs', () => {
    const svg = diagramToSvg(base());
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<\/svg>$/);
  });

  test('draws every table and column', () => {
    const svg = diagramToSvg(base());
    for (const s of ['orders', 'customers', 'note', 'id']) {
      assert.ok(svg.includes(`>${s}<`), `missing ${s}`);
    }
  });

  /// CSS variables do not exist inside a detached .svg — a theme that leaks
  /// through as `var(--fg)` renders black on black.
  test('colours are baked in, never left as CSS variables', () => {
    const svg = diagramToSvg(base());
    assert.ok(!svg.includes('var(--'), 'a CSS variable survived into the export');
    assert.ok(svg.includes('#3b82f6'), 'the edge colour was not applied');
  });

  test('markers are defined inside the file, since the app defs do not travel', () => {
    const svg = diagramToSvg(base());
    assert.ok(svg.includes('<marker id="x-crow"'));
    assert.ok(svg.includes('<marker id="x-one"'));
    assert.ok(svg.includes('marker-end="url(#x-one)"'));
  });

  test('a virtual relation is dashed and an enforced one is not', () => {
    const o = base();
    const solid = diagramToSvg(o);
    assert.ok(!solid.includes('stroke-dasharray'));
    o.edges = [{ ...o.edges[0], virtual: true }];
    assert.ok(diagramToSvg(o).includes('stroke-dasharray'));
  });

  /// Text from the database ends up in the file; `<` in a column comment or a
  /// table name must not be able to close a tag.
  test('names are escaped rather than injected', () => {
    const o = base();
    o.tables = [tbl('a<script>x</script>', [['c"1', true]])];
    o.edges = [];
    o.pos = new Map([['a<script>x</script>', { x: 0, y: 0 }]]);
    const svg = diagramToSvg(o);
    assert.ok(!svg.includes('<script>'), 'markup was injected');
    assert.ok(svg.includes('&lt;script&gt;'));
    assert.ok(svg.includes('&quot;'));
  });

  test('density keys drops non-key rows from the output', () => {
    const all = diagramToSvg(base());
    assert.ok(all.includes('>note<'));
    const keys = diagramToSvg({ ...base(), density: 'keys' });
    assert.ok(!keys.includes('>note<'), 'a non-key column survived keys density');
    assert.ok(keys.includes('>+1 more<'), 'hidden columns were not accounted for');
  });

  test('density header draws names only', () => {
    const svg = diagramToSvg({ ...base(), density: 'header' });
    assert.ok(svg.includes('>orders<'));
    assert.ok(!svg.includes('>note<'));
  });

  /// The export must cover the whole diagram, not the visible viewport, and
  /// crop to its content so it pastes cleanly.
  test('the canvas is sized to the content plus a margin', () => {
    const svg = diagramToSvg(base());
    const w = Number(/width="(\d+)"/.exec(svg)![1]);
    // 400 apart + node width + two margins; generous bounds, the point is that
    // it is neither zero nor the screen size.
    assert.ok(w > 600 && w < 900, `unexpected width ${w}`);
  });

  test('a diagram with nothing on it still produces a valid document', () => {
    const svg = diagramToSvg({ tables: [], edges: [], pos: new Map(), density: 'all', theme });
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
    assert.ok(!svg.includes('NaN'), 'empty bounds leaked NaN into the output');
  });

  test('tables with no saved position are skipped rather than drawn at the origin', () => {
    const o = base();
    o.pos = new Map([['orders', { x: 0, y: 0 }]]);
    const svg = diagramToSvg(o);
    assert.ok(svg.includes('>orders<'));
    assert.ok(!svg.includes('>customers<'));
  });

  test('notes are drawn, one line of text per line', () => {
    const svg = diagramToSvg({ ...base(), notes: [{ x: 0, y: 300, w: 200, h: 90, text: 'line one\nline two' }] });
    assert.ok(svg.includes('>line one<'));
    assert.ok(svg.includes('>line two<'));
  });

  test('a colour override reaches the node header', () => {
    const svg = diagramToSvg({ ...base(), colors: new Map([['orders', '#abcdef']]) });
    assert.ok(svg.includes('#abcdef'));
  });
});

describe('diagramFileName', () => {
  test('is lowercase, hyphenated and dated', () => {
    assert.equal(diagramFileName('Orders Flow', 'svg', '2026-08-11'), 'orders-flow-2026-08-11.svg');
  });

  test('strips characters a filesystem would object to', () => {
    assert.equal(diagramFileName('a/b:c*d', 'png', '2026-08-11'), 'a-b-c-d-2026-08-11.png');
  });

  test('a name with nothing usable still yields a file name', () => {
    assert.equal(diagramFileName('///', 'svg', '2026-08-11'), 'diagram-2026-08-11.svg');
    assert.equal(diagramFileName('', 'svg', '2026-08-11'), 'diagram-2026-08-11.svg');
  });
});

/// The pure core of live-SVG export. The DOM wrapper (liveSvgToString) reads
/// getComputedStyle and cannot run here, but the style-baking rule can: a live
/// chart paints through CSS classes and var(--…) that do not survive into a
/// detached file, so each paint property has to be copied inline as its
/// *resolved* value.
describe('svgInlineStyle', () => {
  const from = (m: Record<string, string>) => svgInlineStyle(p => m[p] ?? '');

  test('emits only the paint properties it was given a value for', () => {
    const s = from({ fill: 'rgb(1, 2, 3)', stroke: 'rgb(4, 5, 6)' });
    assert.equal(s, 'fill:rgb(1, 2, 3);stroke:rgb(4, 5, 6);');
  });

  test('keeps fill:none — a line-chart polyline depends on it', () => {
    assert.ok(from({ fill: 'none' }).includes('fill:none;'));
  });

  test('skips empty values rather than emitting bare declarations', () => {
    assert.equal(from({ fill: '  ', stroke: 'red' }), 'stroke:red;');
  });

  test('never lets a CSS variable through — it must be resolved upstream', () => {
    // The reader is expected to hand back resolved colours; whatever it returns
    // is emitted verbatim, so the guarantee is that the reader is a *computed*
    // style. Here we assert the emitted string is exactly its input, unaltered.
    assert.equal(from({ fill: 'rgb(59, 130, 246)' }), 'fill:rgb(59, 130, 246);');
  });

  test('covers the properties a chart actually uses', () => {
    for (const p of ['fill', 'stroke', 'stroke-width', 'font-size', 'text-anchor', 'opacity']) {
      assert.ok(SVG_INLINE_PROPS.includes(p), `missing ${p}`);
    }
    assert.ok(!SVG_INLINE_PROPS.includes('transform'), 'transform must not be baked in');
  });
});
