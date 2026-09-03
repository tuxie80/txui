// Documentation screenshot capture. Drives the REAL frontend (booted in
// Chromium via the Tauri mock) with sample data, on a retina (2x) macOS-style
// viewport, and writes annotated PNGs to docs/shots/. Red = unified highlight.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { mockFor, installMock } from './doc-fixtures.mjs';

const EXE = '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5273/';
const OUT = 'docs/shots';

// Sample backend responses come from dev/doc-fixtures.mjs — the same fixtures
// the user-guide capture uses. They used to be a second, thinner copy here,
// which meant the two screenshot sets showed different sample data and only one
// of them was maintained. `mockFor()` is per engine; the panel sweep below
// re-installs it as it moves from connection to connection.
const results = [];


async function withRedBox(page, selector, label) {
  // Draw a unified-red highlight box around an element for annotated shots.
  await page.evaluate(({ sel, lab }) => {
    document.querySelectorAll('.__doc_hl').forEach(n => n.remove());
    const el = document.querySelector(sel);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = '__doc_hl';
    Object.assign(box.style, {
      position: 'fixed', left: `${r.left - 4}px`, top: `${r.top - 4}px`,
      width: `${r.width + 8}px`, height: `${r.height + 8}px`,
      border: '3px solid #ff2d2d', borderRadius: '8px',
      boxShadow: '0 0 0 3px rgba(255,45,45,0.25)', pointerEvents: 'none', zIndex: '99999',
    });
    document.body.appendChild(box);
    if (lab) {
      const tag = document.createElement('div');
      tag.className = '__doc_hl';
      tag.textContent = lab;
      Object.assign(tag.style, {
        position: 'fixed', left: `${r.left - 4}px`, top: `${Math.max(2, r.top - 30)}px`,
        background: '#ff2d2d', color: '#fff', font: '600 13px system-ui', padding: '3px 8px',
        borderRadius: '6px', pointerEvents: 'none', zIndex: '99999',
      });
      document.body.appendChild(tag);
    }
  }, { sel: selector, lab: label });
}

async function clearRedBox(page) {
  await page.evaluate(() => document.querySelectorAll('.__doc_hl').forEach(n => n.remove()));
}

async function newPage(browser, engine = 'mysql', w = 1600, h = 1000) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  // installMock runs in the page: the payload crosses as JSON, so anything that
  // must vary by invoke argument is rebuilt on the other side.
  await page.addInitScript(installMock, mockFor(engine));
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page._errs = errs;
  return page;
}

async function shot(page, name, note = '') {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  results.push({ name, ok: true, note, errs: page._errs.slice(0, 3) });
  console.log(`  ✓ ${name}${note ? ' — ' + note : ''}`);
}

async function openWorkspace(page, connName = 'prod-orders') {
  // Double-click a connection to open the editor workspace.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.waitForSelector('.conn-item', { timeout: 12000 });
  // The header carries onDoubleClick; the name span lives inside it.
  const header = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: connName }) }).first();
  await header.scrollIntoViewIfNeeded();
  await header.dblclick();
  await page.waitForTimeout(1500);
  await page.waitForSelector('.pmenu-title', { timeout: 8000 });
}

const browser = await chromium.launch({ executablePath: EXE });
try {
  // ── 1. App shell / connection manager ──
  {
    const page = await newPage(browser);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await shot(page, '01-shell', 'connection sidebar + welcome');
    await page.close();
  }

  // ── 2. Settings modal (all tabs) ──
  {
    const page = await newPage(browser);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.keyboard.press('Meta+Comma');
    await page.waitForTimeout(600);
    await shot(page, '02-settings', 'Settings modal (default tab)');
    // Capture each settings tab by clicking tab buttons if present.
    const tabs = await page.locator('[role="tab"], .settings-tab, .tab').allTextContents().catch(() => []);
    let i = 0;
    for (const t of ['Editor', 'Connections', 'AI', 'Safety', 'Logging', 'Security']) {
      const btn = page.locator(`text="${t}"`).first();
      if (await btn.count()) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(350);
        await shot(page, `02-settings-${t.toLowerCase()}`, `Settings → ${t}`);
        i++;
      }
    }
    results.push({ name: '02-settings-tabs', ok: true, note: `tabs found: ${tabs.length}, captured: ${i}` });
    await page.close();
  }

  // ── 3. Command palette ──
  {
    const page = await newPage(browser);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(500);
    await shot(page, '03-command-palette', 'Cmd+K command palette');
    await page.close();
  }

  // ── 4. Editor workspace + result grid ──
  {
    const page = await newPage(browser);
    await openWorkspace(page, 'prod-orders');
    await shot(page, '04-workspace', 'editor workspace after connect');
    const cm = page.locator('.cm-content').first();
    if (await cm.count()) {
      await cm.click();
      await page.keyboard.type('SELECT id, customer, status, total, created_at\nFROM orders\nWHERE status = \'shipped\'\nORDER BY created_at DESC;');
      await page.waitForTimeout(300);
      await page.keyboard.press('Meta+Enter');
      await page.waitForTimeout(900);
      await shot(page, '05-editor-results', 'SQL + result grid (with autocomplete)');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      // Annotated hero: highlight the Run button + transaction controls.
      await withRedBox(page, '.cm-content', 'SQL editor');
      await shot(page, '05b-editor-annotated', 'editor annotated');
      await clearRedBox(page);
    }
    await page.close();
  }

  // ── 5. Plugin menus + every panel, per engine ──
  const capturedPanels = new Set();
  const panelShot = {};   // panelId -> filename
  for (const { conn, eng } of [
    { conn: 'prod-orders', eng: 'mysql' },
    { conn: 'analytics', eng: 'postgres' },
    { conn: 'warehouse', eng: 'clickhouse' },
    { conn: 'cache', eng: 'redis' },
    { conn: 'app.db', eng: 'sqlite' },
  ]) {
    const page = await newPage(browser, eng);
    try {
      await openWorkspace(page, conn);
    } catch { results.push({ name: `connect-${eng}`, ok: false, note: 'connect failed' }); await page.close(); continue; }

    const groups = await page.locator('.pmenu-title').allTextContents();
    for (const gLabel of groups) {
      const clean = gLabel.replace('▾', '').trim();
      const openMenu = async () => { await page.locator('.pmenu-title', { hasText: clean }).first().click().catch(() => {}); await page.waitForTimeout(250); };
      await openMenu();
      // Capture the open menu once (mysql pass) for the Plugins-menu figures.
      if (eng === 'mysql') { await shot(page, `06-menu-${clean.toLowerCase()}`, `Plugins menu: ${clean}`); }
      // Collect the item labels + blocked state up front (menu closes on click).
      const items = page.locator('.pmenu-list .pmenu-item');
      const n = await items.count();
      const list = [];
      for (let k = 0; k < n; k++) {
        const item = items.nth(k);
        const label = (await item.locator('.pmenu-item-label').textContent().catch(() => ''))?.trim() ?? '';
        const blocked = (await item.getAttribute('aria-disabled')) === 'true';
        list.push({ label, blocked });
      }
      await page.keyboard.press('Escape').catch(() => {});
      for (const { label, blocked } of list) {
        const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!slug || capturedPanels.has(slug) || blocked) continue;
        const clickItem = async () => {
          await openMenu();
          await page.locator('.pmenu-list .pmenu-item', { has: page.locator('.pmenu-item-label', { hasText: label }) }).first().click().catch(() => {});
          await page.waitForTimeout(700);
        };
        await clickItem();                 // open the panel
        try {
          await shot(page, `panel-${slug}`, `${label} (${eng})`);
          capturedPanels.add(slug);
          panelShot[slug] = `panel-${slug}`;
        } catch { results.push({ name: `panel-${slug}`, ok: false, note: `render failed (${eng})` }); }
        await clickItem();                 // toggle the panel closed → clean tab bar
      }
    }
    await page.close();
  }
  results.push({ name: '_panel-coverage', ok: true, note: `panels captured: ${capturedPanels.size} — ${[...capturedPanels].sort().join(', ')}` });
  writeFileSync(`${OUT}/_panelshots.json`, JSON.stringify(panelShot, null, 2));

  writeFileSync(`${OUT}/_report.json`, JSON.stringify(results, null, 2));
  console.log('\nSCENE REPORT:');
  for (const r of results) console.log(`  ${r.ok ? 'OK ' : 'XX '} ${r.name}${r.note ? ' — ' + r.note : ''}${r.errs?.length ? ' [err: ' + r.errs.join('; ') + ']' : ''}`);
} finally {
  await browser.close();
}
