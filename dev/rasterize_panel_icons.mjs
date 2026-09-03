#!/usr/bin/env node
// Rasterize the panel icons that have no bundled Noto emoji PNG into
// src/assets/icons/plugins/<panel>.png.
//
// Why these exist: the native Tools menu (src-tauri/src/lib.rs, muda
// IconMenuItem) shows the same glyph the frontend's <PanelIcon> renders, and a
// native menu cannot draw an inline SVG — it needs a raster image. The six
// panels below are the ones PanelIcon still serves from its inline-SVG
// fallback, so their stroke artwork is baked here at the same `.pi-*` hue
// (App.css). The SVG source of truth stays in components/panelIcons.tsx — if
// you edit an icon there, edit it here too and re-run:
//
//   node dev/rasterize_panel_icons.mjs
//
// `scratch` is not a plugin panel: it is the Tools menu's scratch-buffer
// entry, and its artwork is the DuckdbLogo from components/engineLogos.tsx.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const OUT = 'src/assets/icons/plugins';
const SIZE = 160;

const stroke = (color, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 16 16" `
  + `fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">`
  + `${inner}</svg>`;

const ICONS = {
  querystore: stroke('#9b8ec8',
    '<rect x="2.2" y="2.4" width="11.6" height="11.2" rx="1"/>'
    + '<path d="M2.2 7.8h11.6"/><path d="M6.6 5h2.8"/>'
    + '<path d="M4.6 11.4l1.8-1.4 1.6 1 3.4-2.4"/>'),
  vacuum: stroke('#d1a85e',
    '<path d="M10.6 1.8L6.2 9"/>'
    + '<path d="M4.4 7.8l4 2.4-1.8 3.6a1.2 1.2 0 01-1.6.6L2 12.9a1.2 1.2 0 01-.6-1.6l1.8-3.2a1.2 1.2 0 011.2-.3z"/>'
    + '<path d="M11.5 12.5h2.5M10.5 14.2h3.5"/>'),
  find: stroke('#6c8fff',
    '<ellipse cx="6.8" cy="4" rx="4.4" ry="1.8"/>'
    + '<path d="M2.4 4v5.6c0 1 2 1.8 4.4 1.8.9 0 1.8-.1 2.5-.4"/>'
    + '<circle cx="10.8" cy="10.6" r="2.6"/><path d="M12.7 12.5l2 2"/>'),
  compare: stroke('#9b8ec8',
    '<rect x="1.6" y="3" width="4.6" height="10" rx="1"/>'
    + '<rect x="9.8" y="3" width="4.6" height="10" rx="1"/>'
    + '<path d="M6.2 5.9h3.6M8.4 4.7l1.4 1.2-1.4 1.2"/>'
    + '<path d="M9.8 10.1H6.2M7.6 8.9L6.2 10.1l1.4 1.2"/>'),
  binlog: stroke('#d1a85e',
    '<rect x="2.2" y="2.4" width="11.6" height="3" rx="0.8"/>'
    + '<rect x="2.2" y="6.6" width="11.6" height="3" rx="0.8"/>'
    + '<rect x="2.2" y="10.8" width="7" height="3" rx="0.8"/>'
    + '<path d="M11 10.8v3.4l1.4-1 1.4 1v-3.4z" fill="#d1a85e" stroke="none"/>'),
  slowlog: stroke('#e07a5f',
    '<circle cx="8" cy="9.2" r="4.9"/>'
    + '<path d="M8 6.6v2.6l1.8 1.2"/>'
    + '<path d="M6.3 1.6h3.4M8 1.6v2"/>'),
  scratch:
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 64 64">`
    + '<g fill="#FFD21F">'
    + '<path d="M8 40 C8 30 18 24 30 24 C40 24 48 30 50 38 L60 34 C61.6 33.4 62.8 35 61.8 36.2 L54 45 C48 52 38 56 29 56 C17 56 8 49 8 40 Z"/>'
    + '<circle cx="42" cy="16" r="10"/>'
    + '<path d="M34 20 C36 24 38 26 40 27 L44 25 C42 23 41 21 40 19 Z"/>'
    + '</g>'
    + '<path d="M51 13 L62 16.5 L51 20 Z" fill="#F08030"/>'
    + '<circle cx="45" cy="13.5" r="2.2" fill="#21313C"/>'
    + '</svg>',
};

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, svg] of Object.entries(ICONS)) {
  await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
  const el = page.locator('svg');
  const png = await el.screenshot({ omitBackground: true });
  const out = `${OUT}/${name}.png`;
  writeFileSync(out, png);
  console.log(`${out} (${png.length} bytes)`);
}
await browser.close();
