// User-guide screenshot capture → docs/user-guide/screenshots/.
//
// docs/user-guide/SCREENSHOTS.md used to be a manual checklist: 19 images to
// take by hand against local servers. One of them ever got taken, so the guides
// carried 18 broken image links. This script captures all of them from the real
// frontend booted under the Tauri mock (dev/vite.shots.config.ts), which means
// they regenerate on demand and cannot drift from the UI.
//
// Three treatments, chosen per shot rather than uniformly:
//
//   full   — the whole window. For "this is what a session looks like".
//   crop   — one region, clipped to an element's box plus padding. A sidebar
//            or a palette photographed inside a 1600px window is mostly empty
//            space; the reader is being shown a control, not a desktop.
//   marks  — red rectangles with labels over either of the above. Red is the
//            same highlight the generated help site uses, so a reader moving
//            between the two documents reads one visual language.
//
// Usage:
//   node node_modules/vite/bin/vite.js --config dev/vite.shots.config.ts   # shell 1
//   node dev/shoot_userguide.mjs                                          # shell 2
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mockFor, installMock } from './doc-fixtures.mjs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/'
     + 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5273/';
const OUT = 'docs/user-guide/screenshots';
const W = 1600, H = 1000;

mkdirSync(OUT, { recursive: true });
const report = [];

// ── highlight ────────────────────────────────────────────────────────────────

/**
 * Draw labelled red boxes over elements. Positions are read at draw time and
 * the overlay is `position: fixed`, so it survives nothing — call it
 * immediately before the screenshot and clear it immediately after.
 */
async function mark(page, marks) {
  await page.evaluate(list => {
    document.querySelectorAll('.__ug_hl').forEach(n => n.remove());
    for (const { sel, label, nth = 0, pad = 4, text } of list) {
      // `text` narrows `sel` to the element whose own text contains it. This
      // runs as plain DOM, so Playwright's `:has-text()` is NOT available —
      // passing one silently matches nothing, which is why positional
      // selectors like `.toolbar-btn` nth(0) kept landing on the wrong button.
      const all = [...document.querySelectorAll(sel)];
      const el = text
        ? all.find(n => (n.textContent ?? '').includes(text))
        : all[nth];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const box = document.createElement('div');
      box.className = '__ug_hl';
      Object.assign(box.style, {
        position: 'fixed', left: `${r.left - pad}px`, top: `${r.top - pad}px`,
        width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
        border: '3px solid #ff2d2d', borderRadius: '8px',
        boxShadow: '0 0 0 3px rgba(255,45,45,0.22)',
        pointerEvents: 'none', zIndex: '2147483647',
      });
      document.body.appendChild(box);
      if (!label) continue;
      const tag = document.createElement('div');
      tag.className = '__ug_hl';
      tag.textContent = label;
      // Placement, in order of preference: above the box; else below it; else
      // inside at the top. A full-height element (the object explorer spans the
      // window) has room for neither above nor below, and the earlier two-way
      // rule pushed the label off the bottom of the frame — an invisible label
      // is a silent failure, so the last resort stays on screen.
      const H = window.innerHeight;
      const top = r.top - pad - 26 >= 4 ? r.top - pad - 26
        : r.bottom + pad + 4 + 24 <= H ? r.bottom + pad + 4
        : Math.min(H - 28, r.top + pad + 4);
      Object.assign(tag.style, {
        position: 'fixed', left: `${Math.max(4, r.left - pad)}px`,
        top: `${top}px`,
        background: '#ff2d2d', color: '#fff',
        font: '600 13px -apple-system, system-ui, sans-serif',
        padding: '3px 8px', borderRadius: '6px',
        pointerEvents: 'none', zIndex: '2147483647',
      });
      document.body.appendChild(tag);
    }
  }, marks);
}

const unmark = page => page.evaluate(
  () => document.querySelectorAll('.__ug_hl').forEach(n => n.remove()));

// ── capture ──────────────────────────────────────────────────────────────────

async function save(page, name, note, clip) {
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
  report.push({ name, ok: true, note });
  console.log(`  ✓ ${name}.png — ${note}`);
}

/** Whole window. */
async function full(page, name, note, marks) {
  if (marks) await mark(page, marks);
  await save(page, name, note);
  if (marks) await unmark(page);
}

/**
 * One region: the bounding box of `sel`, padded, clamped to the viewport.
 * Falls back to a full-window shot (and says so) if the element is missing —
 * a missing crop target must not silently produce a blank image.
 */
async function crop(page, name, sel, note, { pad = 12, marks } = {}) {
  if (marks) await mark(page, marks);
  const box = await page.locator(sel).first().boundingBox().catch(() => null);
  if (!box) {
    await save(page, name, `${note} [FALLBACK: '${sel}' not found — full window]`);
    report[report.length - 1].ok = false;
    if (marks) await unmark(page);
    return;
  }
  // A mark label is drawn ~26px ABOVE its box, so a crop padded only by `pad`
  // slices the label in half — which is worse than no label, because the
  // reader sees a red stub and wonders what was cut.
  const topPad = marks ? pad + 30 : pad;
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - topPad);
  await save(page, name, note, {
    x, y,
    width: Math.min(W - x, box.width + pad * 2),
    height: Math.min(H - y, box.height + topPad + pad),
  });
  if (marks) await unmark(page);
}

/**
 * Crop to `widthSel`'s width but only as far down as `contentSel` extends.
 * A full-height panel with a short list in it wastes most of the frame
 * otherwise, and a reader shown 900px of empty background learns nothing.
 */
async function cropTo(page, name, widthSel, contentSel, note, { pad = 10, marks } = {}) {
  if (marks) await mark(page, marks);
  const outer = await page.locator(widthSel).first().boundingBox().catch(() => null);
  const inner = await page.locator(contentSel).first().boundingBox().catch(() => null);
  if (!outer) {
    if (marks) await unmark(page);
    return crop(page, name, widthSel, note, { pad });
  }
  const bottom = inner ? Math.min(outer.y + outer.height, inner.y + inner.height + pad * 3)
                       : outer.y + outer.height;
  const x = Math.max(0, outer.x - pad), y = Math.max(0, outer.y - pad);
  await save(page, name, note, {
    x, y,
    width: Math.min(W - x, outer.width + pad * 2),
    height: Math.min(H - y, Math.max(120, bottom - y)),
  });
  if (marks) await unmark(page);
}

/**
 * Crop to the union of several elements' boxes.
 *
 * CodeMirror renders its completion tooltip OUTSIDE `.cm-editor`, just below
 * the cursor line, so a crop to the editor alone slices the popup off — the
 * one thing the shot exists to show. Selectors that match nothing are skipped,
 * so this degrades to "crop to whatever was there".
 */
async function cropUnion(page, name, sels, note, { pad = 12, marks } = {}) {
  if (marks) await mark(page, marks);
  const boxes = [];
  for (const sel of sels) {
    const b = await page.locator(sel).first().boundingBox().catch(() => null);
    if (b) boxes.push(b);
  }
  if (!boxes.length) {
    await save(page, name, `${note} [FALLBACK: none of ${sels.join(', ')} found]`);
    report[report.length - 1].ok = false;
    if (marks) await unmark(page);
    return;
  }
  const left = Math.min(...boxes.map(b => b.x));
  const top = Math.min(...boxes.map(b => b.y));
  const right = Math.max(...boxes.map(b => b.x + b.width));
  const bottom = Math.max(...boxes.map(b => b.y + b.height));
  const topPad = marks ? pad + 30 : pad;
  const x = Math.max(0, left - pad), y = Math.max(0, top - topPad);
  await save(page, name, note, {
    x, y,
    width: Math.min(W - x, right - left + pad * 2),
    height: Math.min(H - y, bottom - top + topPad + pad),
  });
  if (marks) await unmark(page);
}

async function newPage(browser, engine) {
  const page = await browser.newPage({
    viewport: { width: W, height: H }, deviceScaleFactor: 2,
  });
  // installMock runs in the page: the payload crosses as JSON, and the
  // argument-dependent commands are rebuilt on the other side.
  await page.addInitScript(installMock, mockFor(engine));
  page.on('pageerror', e => console.log(`    [pageerror] ${e.message}`));
  return page;
}

const boot = async page => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.conn-item', { timeout: 15000 });
  await page.waitForTimeout(1200);
};

/**
 * Double-click a connection and wait for whatever workspace that engine opens.
 *
 * Not every engine gets the plugin menu bar: Redis opens the key browser with
 * no `.pmenu-title` at all, so waiting on that selector timed out and took the
 * whole run down at the fifth engine. Wait for any of the workspace anchors.
 */
async function connect(page, connName) {
  await boot(page);
  const header = page.locator('.conn-item-header', {
    has: page.locator('.conn-name', { hasText: connName }),
  }).first();
  await header.scrollIntoViewIfNeeded();
  await header.dblclick();
  await page.waitForSelector('.pmenu-title, .schema-tree, .rb-root, .workspace',
    { timeout: 15000 });
  await page.waitForTimeout(2000);
}

/**
 * Open a panel from the plugin menu bar by group + item label.
 *
 * Returns false rather than throwing when the item is missing OR **disabled**.
 * TxUI greys a panel the engine, platform or role cannot use and leaves it in
 * the menu on purpose, so `aria-disabled` is a normal state here — clicking it
 * blocks for the full Playwright timeout and takes the whole run down with it.
 */
async function openPanel(page, group, item) {
  await page.locator('.pmenu-title', { hasText: group }).first().click();
  await page.waitForTimeout(300);
  const entry = page.locator('.pmenu-list .pmenu-item', {
    has: page.locator('.pmenu-item-label', { hasText: item }),
  }).first();
  const close = async () => { await page.keyboard.press('Escape').catch(() => {}); };
  if (!(await entry.count())) { await close(); return false; }
  if ((await entry.getAttribute('aria-disabled')) === 'true') {
    const why = (await entry.getAttribute('data-tip'))?.split('\n')[0] ?? 'unavailable';
    console.log(`    (skipped ${group} → ${item}: ${why})`);
    await close();
    return false;
  }
  await entry.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1400);
  return true;
}

/**
 * Expand the first N object-tree rows so the explorer shows objects, not a
 * column of collapsed chevrons. Clicks the chevron rather than the row: a row
 * click selects, only the chevron expands.
 */
async function expandTree(page, n = 2) {
  // Wait for the tree itself, not just the workspace chrome. `connect()`
  // returns as soon as the plugin menu bar exists, which is well before
  // list_schema answers — without this the chevron count is 0, the loop breaks
  // immediately, and the session shots photograph a collapsed tree.
  await page.waitForSelector('.schema-tree .tree-chevron', { timeout: 10000 })
    .catch(() => console.log('    (no expandable tree rows appeared)'));
  for (let i = 0; i < n; i++) {
    const chev = page.locator('.schema-tree .tree-chevron').nth(i);
    if (!(await chev.count())) break;
    try {
      await chev.click({ timeout: 4000 });
    } catch {
      console.log(`    (tree chevron ${i} would not click)`);
      break;
    }
    await page.waitForTimeout(900);
  }
}

/**
 * Panels that open on an empty "press the button" state need the button
 * pressed, or the screenshot documents the splash instead of the feature.
 */
async function primePanel(page) {
  for (const label of ['Run analysis', 'Refresh', 'Load']) {
    const b = page.locator(`button:has-text("${label}")`).first();
    if (await b.count() && await b.isEnabled().catch(() => false)) {
      await b.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1200);
      return;
    }
  }
}

/**
 * Run one capture block. A block that throws must not take the run with it:
 * losing the ClickHouse shot because Redis timed out is how a whole suite ends
 * up half-captured with no report.
 */
async function section(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`  ✗ ${label} — ${String(e).split('\n')[0]}`);
    report.push({ name: label, ok: false, note: String(e).split('\n')[0] });
  }
}

const browser = await chromium.launch({ executablePath: EXE });
try {
  // ══ 00 — first run (First steps guide) ═══════════════════════════════════
  // The welcome screen a brand-new install shows: with zero saved connections
  // the five-step how-to renders instead of the activity feed (App.tsx keys on
  // connCount === 0). list_connections normally comes from mock-tauri's SAMPLE,
  // which always has six rows — so this shot injects an empty list, which the
  // mock now lets win over SAMPLE for exactly this case.
  await section('00-first-run', async () => {
    const page = await browser.newPage({
      viewport: { width: W, height: H }, deviceScaleFactor: 2,
    });
    await page.addInitScript(installMock, { ...mockFor('mysql'), list_connections: [] });
    page.on('pageerror', e => console.log(`    [pageerror] ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    // boot() waits for .conn-item, which a zero-connection sidebar never has.
    await page.waitForSelector('.ws-start-steps', { timeout: 15000 });
    await page.waitForTimeout(1200);
    await full(page, '00-first-run',
      'first launch, no connections yet: the welcome screen lists the five first steps', [
        { sel: '.ws-start-steps', label: 'Your five first steps', pad: 6 },
        // No label on this one: it would sit on top of the "No connections
        // yet." line right above the button. The red box alone reads fine.
        { sel: 'button', text: 'Add connection', pad: 3 },
      ]);
    await page.close();
  });

  // ══ Overall UI (README.md) ═══════════════════════════════════════════════
  {
    const page = await newPage(browser, 'mysql');
    await boot(page);

    await full(page, '01-welcome', 'start screen: sidebar + welcome prompt', [
      { sel: '.sidebar', label: 'Saved connections', pad: 2 },
    ]);

    // 03 — the sidebar alone. A crop, because the point is the tree, not the
    // 1300px of empty workspace beside it.
    // The sidebar element is full-window height and mostly empty below the
    // last row, so the crop is clamped to the content rather than the box.
    await cropTo(page, '03-sidebar', '.sidebar', '.conn-list',
      'sidebar: folders, engine icons, connection rows', {
        marks: [
          { sel: '.conn-group', label: 'Folder', nth: 1 },
          { sel: '.engine-icon', label: 'Engine', nth: 2, pad: 2 },
        ],
      });

    // 08 — command palette, cropped to the dialog.
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(600);
    await page.keyboard.type('proc');
    await page.waitForTimeout(500);
    await crop(page, '08-command-palette', '.cp-modal',
      'command palette (⌘K) with a fuzzy query typed', {
        pad: 18,
        marks: [{ sel: '.cp-input', label: 'Fuzzy match', pad: 3 }],
      });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 09 — settings dialog, cropped to the modal.
    await page.keyboard.press('Meta+Comma');
    await page.waitForTimeout(900);
    await crop(page, '09-settings', '.settings-modal', 'Settings dialog', { pad: 18 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await page.close();
  }

  // 02 — the connection form, on its own page.
  //
  // It used to share the page above and came out with the Settings modal still
  // floating over it: Escape did not clear that dialog, and a screenshot cannot
  // tell you it is showing two screens at once. A fresh page costs a second and
  // removes the whole class of leaked-state bug.
  //
  // There is no sidebar "+" button; the form is a view the app switches to,
  // reachable from the palette's "New connection…" action (App.tsx
  // `act-new-conn`). The native File menu also does it, but that arrives over a
  // Tauri event the mock cannot deliver.
  {
    const page = await newPage(browser, 'mysql');
    await boot(page);
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(500);
    await page.keyboard.type('New connection');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    await crop(page, '02-add-connection', '.conn-form',
      'New connection form, Connection tab: engine, host/port, colour, environment', {
        pad: 10,
        marks: [
          { sel: '.cf-engine', label: 'Engine', pad: 3 },
          { sel: '.cf-palette', label: 'Colour + pattern', pad: 3 },
        ],
      });
    await page.close();
  }

  // ══ Connected MySQL session — 04, 05, 06, 07, 10, 11, 12, 13 ═════════════
  {
    const page = await newPage(browser, 'mysql');
    await connect(page, 'prod-orders');
    await expandTree(page, 2);

    await full(page, '04-session', 'connected session: explorer, query tab, session log', [
      { sel: '.schema-tree', label: 'Object explorer', pad: 2 },
      { sel: '.cm-editor', label: 'SQL editor' },
      { sel: '.tab-bar', label: 'Session tabs', pad: 2 },
    ]);

    await full(page, '10-mysql-session',
      'MySQL session with the object explorer expanded', [
        { sel: '.schema-tree', label: 'Tables · views · routines · events', pad: 2 },
      ]);

    // Type SQL, trigger the completion popup, crop to the editor.
    // The completion popup is deliberately NOT part of this shot. It never
    // opens under the mock: the completion source is fed by
    // useSchemaCompletions' metadata sweep, which needs backend responses the
    // fixtures do not reproduce, and neither typing a prefix nor an explicit
    // Ctrl+Space produces a `.cm-tooltip-autocomplete`. Rather than ship an
    // image captioned "completion popup" that does not contain one, this
    // documents the editor and its toolbar, which it does show. If the
    // completion pipeline is ever mocked, add the tooltip back to the union.
    const cm = page.locator('.cm-content').first();
    await cm.click();
    await page.keyboard.type("SELECT id, customer, status, total\n"
      + "FROM orders\nWHERE status = 'shipped'\nORDER BY created_at DESC;");
    await page.waitForTimeout(900);
    await cropUnion(page, '05-query-editor', ['.cm-editor'],
      'SQL editor: dialect-aware highlighting, run and transaction controls', {
        pad: 14,
        marks: [{ sel: 'button', text: 'Run', label: 'Run (⌘↵)', pad: 3 }],
      });

    // Run it → result grid, whole window (both scrollbars are the point).
    await page.keyboard.press('Escape');
    await cm.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT * FROM orders ORDER BY created_at DESC;');
    await page.waitForTimeout(300);
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(1400);
    await full(page, '06-result-grid', 'result grid: many columns and rows', [
      { sel: '.status-bar', label: 'Rows · timing', pad: 2 },
    ]);

    for (const [name, group, item, note, marks] of [
      // Target the kill buttons by their own text: `.toolbar-btn` nth(0) is
      // whichever toolbar button happens to render first anywhere on screen,
      // which was the sidebar's.
      ['11-mysql-processlist', 'Monitor', 'Processes',
        'Processlist with rows and the kill / lock-chain controls',
        [{ sel: 'button', text: 'Kill query', label: 'Kill', pad: 3 }]],
      ['13-mysql-tuner', 'Server', 'Tuner', 'Tuner report: score and findings', null],
    ]) {
      if (await openPanel(page, group, item)) {
        await primePanel(page);
        await full(page, name, note, marks ?? undefined);
        await openPanel(page, group, item);   // toggle closed
      } else {
        report.push({ name, ok: false, note: `menu item ${group} → ${item} not found` });
        console.log(`  ✗ ${name}.png — ${group} → ${item} not found`);
      }
    }

    // 12 — EXPLAIN. Driven by the editor's own event so it does not depend on
    // a toolbar label.
    await cm.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type("SELECT o.id, o.total FROM orders o JOIN order_lines l"
      + " ON l.order_id = o.id WHERE o.created_at > '2026-08-01';");
    await page.waitForTimeout(300);
    await page.evaluate(sql => window.dispatchEvent(
      new CustomEvent('dbgui:explain-statement', { detail: { sql } })),
      'SELECT o.id FROM orders o');
    await page.waitForTimeout(1600);
    await full(page, '12-mysql-explain', 'EXPLAIN visualization of a join');
    await page.close();
  }

  // ══ 07 — data browser ════════════════════════════════════════════════════
  {
    const page = await newPage(browser, 'mysql');
    await connect(page, 'prod-orders');
    await expandTree(page, 1);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent(
      'dbgui:browse-table', { detail: { name: 'shop.orders' } })));
    await page.waitForTimeout(1800);
    await full(page, '07-data-browser', 'read-only data browser on a table', [
      { sel: '.status-bar', label: 'Read-only — no inline editing', pad: 2 },
    ]);
    await page.close();
  }

  // ══ PostgreSQL — 20, 21 ══════════════════════════════════════════════════
  {
    const page = await newPage(browser, 'postgres');
    await connect(page, 'analytics');
    await expandTree(page, 3);
    await full(page, '20-pg-session',
      'PostgreSQL session: tables, partitions, matviews, sequences', [
        { sel: '.schema-tree', label: 'Object explorer', pad: 2 },
      ]);
    for (const item of ['Wait events', 'Processes']) {
      if (await openPanel(page, 'Monitor', item)) {
        await primePanel(page);
        await full(page, '21-pg-activity', `pg_stat_activity — ${item} panel`);
        break;
      }
    }
    await page.close();
  }

  // ══ Redis — 30 ═══════════════════════════════════════════════════════════
  await section('30-redis-browser', async () => {
    const page = await newPage(browser, 'redis');
    await connect(page, 'cache');
    // The value pane says "Select a key to inspect it" until one is clicked,
    // and the guide promises a value viewer — so click a LEAF key (a row with
    // a full key name), not one of the collapsible prefix groups.
    await page.waitForSelector('.rb-key-row', { timeout: 8000 }).catch(() => {});
    const leaf = page.locator('.rb-key-row', {
      has: page.locator('.rb-key-name'),
    }).filter({ hasText: ':' }).first();
    if (await leaf.count()) {
      await leaf.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
    await page.mouse.move(900, 700);   // drop any hover tooltip over the list
    await page.waitForTimeout(400);
    await full(page, '30-redis-browser', 'Redis key browser: key list + value viewer', [
      { sel: '.rb-key-list', label: 'Keys by prefix', pad: 2 },
      { sel: '.rb-detail', label: 'Value', pad: 2 },
    ]);
    await page.close();
  });

  // ══ ClickHouse — 40 ══════════════════════════════════════════════════════
  await section('40-clickhouse-session', async () => {
    const page = await newPage(browser, 'clickhouse');
    await connect(page, 'warehouse');
    await expandTree(page, 2);
    await full(page, '40-clickhouse-session',
      'ClickHouse session: databases, tables, materialized views', [
        { sel: '.schema-tree', label: 'Object explorer', pad: 2 },
      ]);
    await page.close();
  });

  // ══ SQLite / Parquet — 50, 51 ════════════════════════════════════════════
  await section('50-sqlite-session', async () => {
    const page = await newPage(browser, 'sqlite');
    await connect(page, 'app.db');
    await expandTree(page, 2);
    await full(page, '50-sqlite-session', 'SQLite session: the file is the connection', [
      { sel: '.schema-tree', label: 'Tables in the file', pad: 2 },
    ]);
    await page.close();
  });
  await section('51-parquet', async () => {
    const page = await newPage(browser, 'parquet');
    await connect(page, 'events.parquet');
    await expandTree(page, 2);
    await full(page, '51-parquet', 'Parquet inspector: schema and file metadata', [
      { sel: '.schema-tree', label: 'Columns and nested structs', pad: 2 },
    ]);
    await page.close();
  });

  writeFileSync(`${OUT}/_report.json`, JSON.stringify(report, null, 2));
  const bad = report.filter(r => !r.ok);
  console.log(`\n${report.length - bad.length}/${report.length} captured`);
  if (bad.length) {
    console.log('NEEDS ATTENTION:');
    for (const r of bad) console.log(`  ✗ ${r.name} — ${r.note}`);
  }
} finally {
  await browser.close();
}
