// Frontend live-pass for the ❖ Galera cluster panel's per-row Kill (step ⑤).
//
// Drives the REAL frontend under the Tauri mock (dev/vite.shots.config.ts) in
// headless Chromium — the same pipeline as the docs screenshots — and asserts
// the whole kill flow end to end:
//
//   1. Kill buttons render ONLY on kind==='user' rows (applier/rollbacker/
//      system rows and cross-node groups get none).
//   2. The read-only node's rows grey the button (.unavail + data-tip reason +
//      aria-disabled, never `disabled`).
//   3. Normal node: inline confirm strip names node/thread/user@host/time/query;
//      "Kill query N" → invoke('galera_cluster_kill', { connectionConfig, id, mode })
//      with the RIGHT node's config; a session-log line and an audit_insert row
//      follow, attributed to the node with source 'Galera cluster processlist'.
//   4. Per-thread failure (ER_KILL_DENIED_ERROR) renders inline in the strip.
//   5. Prod node: the buttons stay DISARMED until the thread id is typed.
//   6. Settings → Safety → Interactive kill off greys every row "monitor only".
//
// Every invoke is recorded on window.__CALLS__ by dev/mock-tauri.ts; the
// fixtures come from __GALERA_PROC__ in dev/doc-fixtures.mjs.
//
// Usage:
//   node node_modules/vite/bin/vite.js --config dev/vite.shots.config.ts   # shell 1
//   node dev/verify_cluster_kill.mjs                                       # shell 2
//
// Screenshots (verification artifacts, NOT docs images) → dev/verify-shots/.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import {
  mockFor, installMock, galeraFixture, galeraProcesslistFixture,
  GALERA_KILL_CONNECTIONS,
} from './doc-fixtures.mjs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/'
     + 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5273/';
const OUT = 'dev/verify-shots';
const W = 1600, H = 1000;

mkdirSync(OUT, { recursive: true });

// ── assertion bookkeeping — collect everything, fail at the end ──────────────
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : (extra ? ` — ${extra}` : '')}`);
}

/** All recorded invoke args for one command (mock-tauri keeps them on
 *  window.__CALLS__; Channels serialise via their toJSON). */
const callsOf = (page, cmd) => page.evaluate(
  c => (window.__CALLS__ ?? []).filter(x => x.cmd === c).map(x => x.args), cmd);

/** The persisted joined run-log (addLog mirrors to localStorage, debounced). */
async function runLogLines(page) {
  await page.waitForTimeout(2100);   // persistRunLog debounces 1.5 s
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('dbgui.runlog.v1');
      return raw ? JSON.parse(raw).entries.map(e => `${e.level}|${e.action}|${e.detail}`) : [];
    } catch { return []; }
  });
}

async function newPage(browser, { killOff = false } = {}) {
  const page = await browser.newPage({
    viewport: { width: W, height: H }, deviceScaleFactor: 2,
  });
  if (killOff) {
    // Settings → Safety → Interactive kill: OFF. Preferences are localStorage
    // ('dbgui.interactiveKill', '1'/'0'), read at mount by usePreference.
    await page.addInitScript(() => localStorage.setItem('dbgui.interactiveKill', '0'));
  }
  await page.addInitScript(installMock, {
    ...mockFor('mysql'),
    list_connections: GALERA_KILL_CONNECTIONS,
    __GALERA__: galeraFixture(),
    __GALERA_PROC__: galeraProcesslistFixture(),
  });
  page.on('pageerror', e => console.log(`    [pageerror] ${e.message}`));
  return page;
}

/** Boot, connect to galera1, open Server → Galera cluster, switch to ▦ Processes. */
async function openProcessView(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.conn-item', { timeout: 15000 });
  await page.waitForTimeout(1000);
  const header = page.locator('.conn-item-header', {
    has: page.locator('.conn-name', { hasText: 'galera1' }),
  }).first();
  await header.scrollIntoViewIfNeeded();
  await header.dblclick();
  await page.waitForSelector('.pmenu-title, .schema-tree, .workspace', { timeout: 15000 });
  await page.waitForTimeout(1500);

  await page.locator('.pmenu-title', { hasText: 'Server' }).first().click();
  await page.waitForTimeout(300);
  const item = page.locator('.pmenu-list .pmenu-item', {
    has: page.locator('.pmenu-item-label', { hasText: 'Galera cluster' }),
  }).first();
  if (!(await item.count())) throw new Error('Server → Galera cluster not found');
  if ((await item.getAttribute('aria-disabled')) === 'true') {
    throw new Error(`Server → Galera cluster unavailable: ${await item.getAttribute('data-tip')}`);
  }
  await item.click({ timeout: 5000 });
  await page.waitForSelector('.galc-root', { timeout: 10000 });
  await page.waitForTimeout(800);
  // Close the node picker so the shot is the table, then swap to the processes.
  await page.locator('.gal-toolbar button', { hasText: 'Nodes' }).first().click().catch(() => {});
  await page.locator('.gal-toolbar button', { hasText: '▦ Processes' }).first().click();
  await page.waitForSelector('.galc-proc-grid', { timeout: 20000 });
  await page.waitForTimeout(600);
}

/** A single (user-thread) process row, located by its unique Info text. */
const rowByInfo = (page, info) => page.locator(
  `.galc-proc-grid tbody tr:has(td.galc-proc-info[title*="${info}"])`).first();

const browser = await chromium.launch({ executablePath: EXE });
try {
  // ══ A: rendering gates + success path + failure path + prod path ══════════
  {
    const page = await newPage(browser);
    await openProcessView(page);

    // ── 1. Kill buttons only on user rows ──────────────────────────────────
    // Fixture singles: g1 has 412/425 + probe 431, g2 has 777 + probe 781,
    // g3 has 901 + probe 909 → 7 user rows with an action button.
    const singles = page.locator('.galc-proc-grid tbody tr:has(td.galc-proc-act)');
    check('process table renders 7 user-thread rows',
      await singles.count() === 7, `got ${await singles.count()}`);
    check('every user row has a Kill button (armed or greyed)',
      await page.locator('.galc-proc-act button.proc-kill').count() === 7,
      `got ${await page.locator('.galc-proc-act button.proc-kill').count()}`);
    check('the cross-node "writeset apply" group header renders',
      await page.locator('.galc-proc-group', { hasText: 'writeset apply' }).count() === 1);
    check('group rows carry no Kill button',
      await page.locator('.galc-proc-group button.proc-kill').count() === 0);

    // System threads: open every node's collapsible, then prove no system row
    // (applier / rollbacker / event_scheduler) has a Kill button.
    const sysToggles = page.locator('.galc-proc-sys');
    const nSys = await sysToggles.count();
    check('3 per-node system-thread collapsibles render', nSys === 3, `got ${nSys}`);
    for (let i = 0; i < nSys; i++) await sysToggles.nth(i).click();
    await page.waitForTimeout(400);
    const sysRows = await page.locator('.galc-proc-sysrow').count();
    check('system rows render once expanded (3 nodes × 5 threads)', sysRows === 15, `got ${sysRows}`);
    check('no system row has a Kill button',
      await page.locator('.galc-proc-sysrow button.proc-kill').count() === 0);

    // ── 2. read-only node: greyed, explained, never disabled ───────────────
    const roRow = rowByInfo(page, 'SELECT * FROM shop.orders');   // g3 thread 901
    const roWrap = roRow.locator('.galc-proc-act span.unavail');
    check('read-only node row greys the Kill button (.unavail)',
      await roWrap.count() === 1);
    const roTip = await roWrap.getAttribute('data-tip').catch(() => null);
    check('read-only greying names the reason in data-tip',
      !!roTip && roTip.includes('read-only'), String(roTip));
    const roBtn = roRow.locator('button.proc-kill');
    check('greyed Kill uses aria-disabled, never the disabled attribute',
      (await roBtn.getAttribute('aria-disabled')) === 'true'
        && (await roBtn.getAttribute('disabled')) === null);
    // The handler guards with the same predicate: clicking opens no strip.
    await roBtn.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    check('clicking the greyed read-only Kill opens no confirm strip',
      await page.locator('.galc-kill-confirm').count() === 0);

    // Normal (g1) and prod (g2) rows are NOT greyed.
    check('normal node rows have an armed Kill button',
      await rowByInfo(page, 'SELECT o.id, o.total').locator('button.proc-kill:not([aria-disabled])').count() === 1);
    check('prod node rows have an armed Kill button (typed confirm comes later)',
      await rowByInfo(page, 'ALTER TABLE order_lines').locator('button.proc-kill:not([aria-disabled])').count() === 1);

    // Screenshot (a): the process view with its kill buttons.
    await page.mouse.move(800, 900);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/cluster-kill-process-view.png` });
    console.log('  ✓ screenshot: cluster-kill-process-view.png');

    // ── 3. success path: Kill query 412 on g1 ──────────────────────────────
    await rowByInfo(page, 'SELECT o.id, o.total').locator('button.proc-kill').click();
    await page.waitForSelector('.galc-kill-confirm', { timeout: 5000 });
    const strip = page.locator('.galc-kill-confirm');
    const stripText = await strip.innerText();
    check('confirm strip names the node', stripText.includes('galera1 (mysql)'), stripText.slice(0, 120));
    check('confirm strip names the thread id', stripText.includes('412'));
    check('confirm strip names user@host', stripText.includes('app_rw@10.0.2.31:51422'));
    check('confirm strip names the age', stripText.includes('184s'));
    check('confirm strip shows a query excerpt', stripText.includes('SELECT o.id, o.total FROM orders'));
    check('non-prod strip has no typed-confirm input',
      await strip.locator('input').count() === 0);

    // Screenshot (b): the inline confirm strip.
    await strip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await strip.boundingBox();
    if (box) {
      await page.screenshot({
        path: `${OUT}/cluster-kill-confirm-strip.png`,
        clip: { x: Math.max(0, box.x - 14), y: Math.max(0, box.y - 40),
                width: Math.min(W - box.x + 14, box.width + 28),
                height: Math.min(H, box.height + 90) },
      });
      console.log('  ✓ screenshot: cluster-kill-confirm-strip.png');
    }

    const killsBefore = (await callsOf(page, 'galera_cluster_kill')).length;
    await strip.locator('button', { hasText: 'Kill query 412' }).click();
    await page.waitForTimeout(800);

    const killCalls = await callsOf(page, 'galera_cluster_kill');
    check('one galera_cluster_kill invoke fired', killCalls.length === killsBefore + 1,
      `before=${killsBefore} after=${killCalls.length}`);
    const k = killCalls[killCalls.length - 1] ?? {};
    check('kill routed to the RIGHT node config (g1)',
      k.connectionConfig?.id === 'g1' && k.connectionConfig?.host === '127.0.0.1'
        && k.connectionConfig?.port === 3341,
      JSON.stringify({ id: k.connectionConfig?.id, host: k.connectionConfig?.host, port: k.connectionConfig?.port }));
    check('kill id is the numeric thread id', k.id === 412 && typeof k.id === 'number', String(k.id));
    check('kill mode is query', k.mode === 'query', String(k.mode));
    check('strip closes after a successful kill',
      await page.locator('.galc-kill-confirm').count() === 0);

    const audits = await callsOf(page, 'audit_insert');
    const a1 = audits.filter(a => a?.entry?.sql?.includes('KILL QUERY #412')).pop()?.entry ?? {};
    check('audit row written for the kill',
      !!a1.sql, JSON.stringify(audits.length));
    check('audit connection_name is the node display name',
      a1.connection_name === 'galera1 (mysql)', String(a1.connection_name));
    check("audit line carries source 'Galera cluster processlist'",
      (a1.sql ?? '').includes('via Galera cluster processlist'), String(a1.sql).slice(0, 160));
    check('audit row marks the kill ok', a1.ok === true);

    const lines1 = await runLogLines(page);
    check('session log carries the KILL line (addLog)',
      lines1.some(l => l.includes('KILL') && l.includes('KILL QUERY #412')
        && l.includes('via Galera cluster processlist')),
      lines1.filter(l => l.includes('KILL')).join(' || ').slice(0, 200));
    check('the log line is a success line', lines1.some(l => l.startsWith('ok|KILL')));

    // ── 4. failure path: kill of 425 comes back ER_KILL_DENIED_ERROR ───────
    await rowByInfo(page, 'SELECT channel, count(*)').locator('button.proc-kill').click();
    await page.waitForSelector('.galc-kill-confirm', { timeout: 5000 });
    await page.locator('.galc-kill-confirm button', { hasText: 'Kill query 425' }).click();
    await page.waitForTimeout(800);
    check('failed kill keeps the strip open',
      await page.locator('.galc-kill-confirm').count() === 1);
    const errText = await page.locator('.galc-kill-confirm .galc-error').innerText().catch(() => '');
    check('the server error renders inline in the strip',
      errText.includes('ER_KILL_DENIED_ERROR'), errText.slice(0, 120));
    const audits2 = await callsOf(page, 'audit_insert');
    const a2 = audits2.filter(a => a?.entry?.sql?.includes('KILL QUERY #425')).pop()?.entry ?? {};
    check('the failed kill is audited as failed',
      a2.ok === false && (a2.error ?? '').includes('ER_KILL_DENIED_ERROR'),
      JSON.stringify({ ok: a2.ok, error: a2.error }));
    check('failed kill is attributed to the row node',
      a2.connection_name === 'galera1 (mysql)', String(a2.connection_name));
    const lines2 = await runLogLines(page);
    check('session log carries the FAILED kill line',
      lines2.some(l => l.startsWith('err|KILL') && l.includes('KILL QUERY #425')
        && l.includes('ER_KILL_DENIED_ERROR')));
    await page.locator('.galc-kill-confirm button[title="Cancel"]').click();
    await page.waitForTimeout(300);

    // ── 5. prod path: typed confirm arms the buttons ───────────────────────
    await rowByInfo(page, 'ALTER TABLE order_lines').locator('button.proc-kill').click();
    await page.waitForSelector('.galc-kill-confirm', { timeout: 5000 });
    const pStrip = page.locator('.galc-kill-confirm');
    const pText = await pStrip.innerText();
    check('prod strip flags the prod connection', pText.includes('prod connection'));
    check('prod strip asks for the thread id', pText.includes('Type') && pText.includes('777'));
    const qBtn = pStrip.locator('button', { hasText: 'Kill query 777' });
    const cBtn = pStrip.locator('button', { hasText: 'Kill connection 777' });
    check('prod kill buttons start disarmed',
      (await qBtn.getAttribute('disabled')) !== null
        && (await cBtn.getAttribute('disabled')) !== null);
    // A disarmed click must not fire the invoke (the DOM won't even dispatch).
    const prodBefore = (await callsOf(page, 'galera_cluster_kill')).length;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.galc-kill-confirm button')]
        .find(x => x.textContent.includes('Kill query 777'));
      b?.click();
    });
    await page.waitForTimeout(400);
    check('disarmed prod click fires no kill invoke',
      (await callsOf(page, 'galera_cluster_kill')).length === prodBefore);

    // Screenshot (c): the prod typed-confirm state.
    await pStrip.scrollIntoViewIfNeeded();
    const pBox = await pStrip.boundingBox();
    if (pBox) {
      await page.screenshot({
        path: `${OUT}/cluster-kill-prod-typed-confirm.png`,
        clip: { x: Math.max(0, pBox.x - 14), y: Math.max(0, pBox.y - 40),
                width: Math.min(W - pBox.x + 14, pBox.width + 28),
                height: Math.min(H, pBox.height + 90) },
      });
      console.log('  ✓ screenshot: cluster-kill-prod-typed-confirm.png');
    }

    await pStrip.locator('input').fill('777');
    await page.waitForTimeout(300);
    check('typing the thread id arms the prod buttons',
      (await qBtn.getAttribute('disabled')) === null
        && (await cBtn.getAttribute('disabled')) === null);
    await cBtn.click();
    await page.waitForTimeout(800);
    const prodCalls = (await callsOf(page, 'galera_cluster_kill'))
      .filter(a => a?.connectionConfig?.id === 'g2');
    check('prod kill fired once, routed to g2', prodCalls.length === 1, `got ${prodCalls.length}`);
    check('prod kill used mode connection with numeric id 777',
      prodCalls[0]?.mode === 'connection' && prodCalls[0]?.id === 777,
      JSON.stringify(prodCalls[0] && { mode: prodCalls[0].mode, id: prodCalls[0].id }));
    check('prod kill shipped the prod-tagged config',
      prodCalls[0]?.connectionConfig?.environment === 'prod');
    const audits3 = await callsOf(page, 'audit_insert');
    const a3 = audits3.filter(a => a?.entry?.sql?.includes('KILL #777')).pop()?.entry ?? {};
    check('prod kill audited against galera2 (mysql)',
      a3.connection_name === 'galera2 (mysql)' && a3.ok === true,
      JSON.stringify({ name: a3.connection_name, ok: a3.ok }));
    check('prod strip closes after success',
      await page.locator('.galc-kill-confirm').count() === 0);

    await page.close();
  }

  // ══ B: Settings → Safety → Interactive kill OFF ═══════════════════════════
  {
    const page = await newPage(browser, { killOff: true });
    await openProcessView(page);
    const greyed = page.locator('.galc-proc-act span.unavail');
    check('interactiveKill off greys every row Kill button',
      await greyed.count() === 7, `got ${await greyed.count()}`);
    const tips = await greyed.evaluateAll(
      els => els.map(e => e.getAttribute('data-tip') ?? ''));
    check('every greyed button says "monitor only" with the Settings pointer',
      tips.every(t => t.includes('monitor only') && t.includes('Settings → Safety')),
      tips.find(t => !t.includes('monitor only')) ?? '');
    check('no armed Kill button remains',
      await page.locator('.galc-proc-act button.proc-kill:not([aria-disabled])').count() === 0);
    const before = (await callsOf(page, 'galera_cluster_kill')).length;
    await rowByInfo(page, 'SELECT o.id, o.total').locator('button.proc-kill').click()
      .catch(() => {});
    await page.waitForTimeout(400);
    check('greyed-by-pref Kill opens no strip and fires no invoke',
      await page.locator('.galc-kill-confirm').count() === 0
        && (await callsOf(page, 'galera_cluster_kill')).length === before);
    await page.close();
  }
} finally {
  await browser.close();
}

const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} assertions passed`);
if (bad.length) {
  console.log('FAILED:');
  for (const r of bad) console.log(`  ✗ ${r.name}`);
  process.exit(1);
}
