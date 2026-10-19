// Panel smoke — opens EVERY plugins-menu panel on EVERY fixture engine and
// asserts the workspace survives: no ErrorBoundary ("Something broke"), no
// page errors, no console errors. This is the harness that would have caught
// the FindPanel/ComparePanel "Too many re-renders" crash before it shipped.
//
// Requires the shots dev server:
//   node node_modules/vite/bin/vite.js --config dev/vite.shots.config.ts
// then:
//   node dev/panel_smoke.mjs
//
// Exit code 1 on any failure. Redis has no plugins menu (engine-gated) — its
// check is the browser itself rendering key rows.
import { chromium } from 'playwright';
import { mockFor, installMock } from './doc-fixtures.mjs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/'
     + 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5273/';

const ENGINES = [
  { conn: 'prod-orders', eng: 'mysql' },
  { conn: 'analytics', eng: 'postgres' },
  { conn: 'warehouse', eng: 'clickhouse' },
  { conn: 'app.db', eng: 'sqlite' },
  { conn: 'cache', eng: 'redis' },
];

const browser = await chromium.launch({ executablePath: EXE });
let failures = 0;
let opened = 0;

for (const { conn, eng } of ENGINES) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(installMock, mockFor(eng));
  const errs = [];
  page.on('pageerror', e => errs.push(`pageerror: ${e.message.slice(0, 160)}`));
  page.on('console', m => {
    if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 160)}`);
  });

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const header = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: conn }) }).first();
    await header.scrollIntoViewIfNeeded();
    await header.dblclick();
    await page.waitForTimeout(2000);

    if (eng === 'redis') {
      // No plugins menu on Redis — the browser IS the workspace.
      const rows = await page.locator('.rb-key-row, .rb-ns-row').count();
      const broken = await page.locator('text=Something broke').count();
      if (broken || rows === 0) {
        failures++;
        console.log(`XX redis browser — boundary:${broken} rows:${rows}`);
      } else {
        console.log(`OK  redis browser — ${rows} key rows, workspace alive`);
        opened++;
      }
      if (errs.length) { failures++; console.log(`XX redis errors: ${errs.slice(0, 3).join(' | ')}`); }
      await page.close();
      continue;
    }

    await page.waitForSelector('.pmenu-title', { timeout: 8000 });
    const groups = await page.locator('.pmenu-title').allTextContents();
    for (const gLabel of groups) {
      const clean = gLabel.replace('▾', '').trim();
      const openMenu = async () => {
        await page.locator('.pmenu-title', { hasText: clean }).first().click().catch(() => {});
        await page.waitForTimeout(250);
      };
      await openMenu();
      const items = page.locator('.pmenu-list .pmenu-item');
      const n = await items.count();
      const list = [];
      for (let k = 0; k < n; k++) {
        const item = items.nth(k);
        const label = (await item.locator('.pmenu-item-label').textContent().catch(() => ''))?.trim() ?? '';
        const blocked = (await item.getAttribute('aria-disabled')) === 'true';
        if (label && !blocked) list.push(label);
      }
      await page.keyboard.press('Escape').catch(() => {});
      for (const label of list) {
        await openMenu();
        await page.locator('.pmenu-list .pmenu-item', { has: page.locator('.pmenu-item-label', { hasText: label }) }).first().click().catch(() => {});
        await page.waitForTimeout(900);
        const broken = await page.locator('text=Something broke').count();
        if (broken) {
          failures++;
          console.log(`XX ${eng} / ${label} — ERROR BOUNDARY`);
          // Reload to recover for the next panel.
          await page.goto(BASE, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1500);
          const h2 = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: conn }) }).first();
          await h2.dblclick();
          await page.waitForTimeout(2000);
          await page.waitForSelector('.pmenu-title', { timeout: 8000 });
        } else {
          opened++;
          console.log(`OK  ${eng} / ${label}`);
        }
        // toggle closed
        await openMenu();
        await page.locator('.pmenu-list .pmenu-item', { has: page.locator('.pmenu-item-label', { hasText: label }) }).first().click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    const interesting = errs.filter(e => !/favicon|net::|404/.test(e));
    if (interesting.length) {
      failures++;
      console.log(`XX ${eng} console/page errors (first 5):`);
      interesting.slice(0, 5).forEach(e => console.log(`     ${e}`));
    }
  } catch (e) {
    failures++;
    console.log(`XX ${eng} — harness error: ${String(e).slice(0, 200)}`);
  }
  await page.close();
}

await browser.close();
console.log(`\nPANEL SMOKE: ${opened} panels opened clean, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
