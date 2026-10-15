// Shoot the geo harness: geometry-first map, track-mode map, CellViewer
// mini-map — each over the bundled basemap. Writes /tmp/geo-*.png.
import { chromium } from 'playwright';

const EXE = '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5279/';

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 940, height: 620 }, deviceScaleFactor: 2 });
page.on('pageerror', e => console.error('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });

for (const [name, url, sel] of [
  ['geo-map', `${BASE}?v=geo`, '.shot-box'],
  ['geo-track', `${BASE}?v=track`, '.shot-box'],
  ['geo-cell', `${BASE}?v=cell`, '.cv-modal'],
  ['geo-grid', `${BASE}?v=grid`, '.shot-box'],
]) {
  await page.goto(url);
  await page.waitForSelector(sel);
  await page.waitForTimeout(700);   // basemap dynamic import + canvas paint
  await page.locator(sel).screenshot({ path: `/tmp/${name}.png` });
  console.log(`wrote /tmp/${name}.png`);
}

// Hover the Bohemia shape on the geometry-first map: tooltip + highlight.
await page.goto(`${BASE}?v=geo`);
await page.waitForSelector('.shot-box canvas');
await page.waitForTimeout(700);
const canvasBox = await page.locator('.shot-box canvas').boundingBox();
// Canvas-relative centre of the Bohemia square at the auto-fit viewport.
await page.mouse.move(canvasBox.x + 612, canvasBox.y + 189);
await page.waitForTimeout(300);
await page.locator('.shot-box').screenshot({ path: '/tmp/geo-hover.png' });
console.log('wrote /tmp/geo-hover.png');
await browser.close();
