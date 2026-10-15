// Geo screenshot harness: mounts MapView in geometry-first mode (a spatial
// table with no lat/lon columns), MapView in track mode, and a CellViewer on
// a lon/lat polygon — all against the bundled basemap. Playwright shoots
// .shot targets; see dev/geo_shot.mjs.
import { createRoot } from 'react-dom/client';
import { createElement as h } from 'react';
import '../../src/App.css';
import { MapView } from '../../src/components/MapView';
import { CellViewer } from '../../src/components/CellViewer';
import { FastGrid } from '../../src/components/FastGrid';
import { loadBasemap } from '../../src/utils/basemap';

// Surface the basemap load result so the shot script can assert on it.
loadBasemap().then(p => {
  const el = document.createElement('div');
  el.id = 'basemap-probe';
  el.textContent = p ? `land:${p.length}` : 'land:null';
  document.body.appendChild(el);
});

// ── EWKB hex fixtures, encoded here (wkb.ts only parses) ──
function hexU32(v: number): string {
  return [0, 8, 16, 24].map(s => ((v >>> s) & 0xff).toString(16).padStart(2, '0')).join('');
}
function hexF64(v: number): string {
  const b = new ArrayBuffer(8);
  new DataView(b).setFloat64(0, v, true);
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function ewkb(type: number, srid: number, body: string): string {
  return '01' + hexU32(type | 0x20000000) + hexU32(srid) + body;
}
function polygonHex(rings: [number, number][][], srid = 4326): string {
  const body = hexU32(rings.length) + rings.map(r =>
    hexU32(r.length) + r.map(([x, y]) => hexF64(x) + hexF64(y)).join('')).join('');
  return ewkb(3, srid, body);
}
function pointHex(x: number, y: number, srid = 4326): string {
  return ewkb(1, srid, hexF64(x) + hexF64(y));
}

const sq = (cx: number, cy: number, r: number): [number, number][] =>
  [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r]];

const geoColumns = ['id', 'name', 'geom'];
const geoRows: unknown[][] = [
  [1, 'Iberia', polygonHex([sq(-4.0, 40.0, 1.8)])],
  [2, 'British Isles', polygonHex([sq(-2.0, 53.5, 1.4)])],
  [3, 'Bohemia', polygonHex([sq(15.0, 49.9, 1.4)])],
  [4, 'Jutland', polygonHex([sq(9.5, 56.0, 0.8)])],
  [5, 'Praha', pointHex(14.4378, 50.0755)],
  [6, 'Lisboa', pointHex(-9.1393, 38.7223)],
  [7, 'Roma', pointHex(12.4964, 41.9028)],
];

const trackColumns = ['captured_at', 'lat', 'lon'];
const trackRows: unknown[][] = [
  ['2026-10-01 10:00:00', 50.0755, 14.4378],
  ['2026-10-01 10:05:00', 50.0870, 14.4207],
  ['2026-10-01 10:10:00', 50.1020, 14.4500],
];

const which = new URLSearchParams(location.search).get('v') ?? 'geo';
const root = createRoot(document.getElementById('root')!);
if (which === 'geo') {
  root.render(h('div', { className: 'shot-box' },
    h(MapView, { columns: geoColumns, rows: geoRows, onSelectRow: () => {} })));
} else if (which === 'track') {
  root.render(h('div', { className: 'shot-box' },
    h(MapView, { columns: trackColumns, rows: trackRows })));
} else if (which === 'grid') {
  root.render(h('div', { className: 'shot-box' },
    h(FastGrid, {
      columns: geoColumns.map(name => ({ name, type_name: name === 'id' ? 'INT' : 'TEXT', nullable: true })),
      rows: geoRows,
    })));
} else {
  root.render(h(CellViewer, {
    column: 'geom', value: polygonHex([sq(14.42, 50.08, 0.06)]), onClose: () => {},
  }));
}
