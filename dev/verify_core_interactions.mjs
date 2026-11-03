import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mockFor, installMock } from './doc-fixtures.mjs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5273/';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ensureServer() {
  try {
    const response = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
    if (response.ok) return null;
  } catch { /* start below */ }
  const child = spawn('node', ['node_modules/vite/bin/vite.js', '--config', 'dev/vite.shots.config.ts'], {
    detached: true, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const response = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return child;
    } catch { /* poll */ }
  }
  process.kill(-child.pid);
  throw new Error('Vite mock server did not start');
}

const pages = [];

async function newPage(browser, multi = false, fakeTime = false) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  if (fakeTime) await page.clock.install();
  pages.push(page);
  page._coreErrors = [];
  page.on('pageerror', error => page._coreErrors.push(error.message));
  await page.addInitScript(installMock, mockFor('mysql'));
  if (multi) {
    await page.addInitScript(() => {
      const original = window.__MOCK__.execute_query;
      window.__MOCK__.execute_query = args => {
        const first = typeof original === 'function' ? original(args) : original;
        const second = {
          ...first,
          columns: first.columns.map(column => ({ ...column })),
          rows: [['s1', 's2', 's3', 's4', 's5'], ['s6', 's7', 's8', 's9', 's10']],
          result_sets: [],
        };
        return { ...first, result_sets: [second] };
      };
    });
  }
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return page;
}

async function openSession(browser, multi = false) {
  const page = await newPage(browser, multi);
  const header = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: 'prod-orders' }) }).first();
  await header.dblclick();
  await page.waitForSelector('.cm-content', { timeout: 15000 });
  return page;
}

async function openResult(browser, multi) {
  const page = await openSession(browser, multi);
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('SELECT id, customer, status, total, created_at FROM orders;');
  await page.keyboard.press('Meta+Enter');
  await page.waitForSelector('.fg-cell:visible', { timeout: 10000 });
  return page;
}

async function drag(page) {
  const first = await page.locator('.fg-cell:visible[data-r="0"][data-c="0"]').first().boundingBox();
  const second = await page.locator('.fg-cell:visible[data-r="1"][data-c="1"]').first().boundingBox();
  if (!first || !second) throw new Error('drag cells are not visible');
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  return page.locator('.fg-sel:visible').allTextContents();
}

async function copyTsv(page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE.slice(0, -1) });
  await page.locator('.result-grid-wrap:visible').getByRole('button', { name: 'Copy ▾' }).click();
  await page.getByRole('button', { name: 'TSV', exact: true }).click();
  await page.locator('.result-grid-wrap:visible .result-flash').waitFor();
  return page.evaluate(() => navigator.clipboard.readText());
}

async function verifySelections(browser) {
  const single = await openResult(browser, false);
  await single.locator('.fg-cell:visible[data-r="0"][data-c="0"]').first().click();
  const clicked = await single.locator('.fg-sel:visible').allTextContents();
  if (clicked.length !== 1) throw new Error(`single-cell click selected ${clicked.length}, expected 1`);
  const selected = await drag(single);
  if (selected.length !== 4) throw new Error(`single-result drag selected ${selected.length}, expected 4`);
  console.log('PASS single-cell click and single-result drag preserve selections');
  await single.close();

  const multi = await openResult(browser, true);
  const first = await drag(multi);
  if (first.length !== 4) throw new Error(`Result 1 drag selected ${first.length}, expected 4`);
  await multi.getByRole('button', { name: '▦ Result 2' }).click();
  const second = await drag(multi);
  if (second.length !== 4 || !second.every(value => /^s\d+$/.test(value))) {
    throw new Error(`Result 2 selection is wrong: ${JSON.stringify(second)}`);
  }
  await multi.getByRole('button', { name: '▦ Result 1' }).click();
  const firstAgain = await multi.locator('.fg-sel:visible').allTextContents();
  if (firstAgain.join('|') !== first.join('|')) {
    throw new Error(`Result 1 selection changed after switching: ${JSON.stringify(firstAgain)}`);
  }
  const firstCopied = await copyTsv(multi);
  const firstExpected = ['id\tcustomer', first.slice(0, 2).join('\t'), first.slice(2).join('\t')].join('\n');
  if (firstCopied !== firstExpected) {
    throw new Error(`Result 1 copied values changed after switching: ${JSON.stringify(firstCopied)}`);
  }
  await multi.getByRole('button', { name: '▦ Result 2' }).click();
  const secondAgain = await multi.locator('.fg-sel:visible').allTextContents();
  if (secondAgain.join('|') !== second.join('|')) {
    throw new Error(`Result 2 selection changed after switching: ${JSON.stringify(secondAgain)}`);
  }
  const secondCopied = await copyTsv(multi);
  const secondExpected = ['id\tcustomer', second.slice(0, 2).join('\t'), second.slice(2).join('\t')].join('\n');
  if (secondCopied !== secondExpected) {
    throw new Error(`Result 2 copied values changed after switching: ${JSON.stringify(secondCopied)}`);
  }
  console.log('PASS result-set switches preserve highlighted and copied selections');
  await multi.close();
}

async function browseOrders(page) {
  await page.evaluate(() => {
    window.__MOCK__.get_table_meta = { ...window.__MOCK__.get_table_meta, pk_columns: [] };
  });
  const shop = page.locator('.tree-row').filter({ has: page.locator('.tree-label').getByText('shop', { exact: true }) });
  await shop.locator('.tree-chevron').click();
  const tables = page.locator('.tree-row').filter({ has: page.locator('.tree-label').getByText('Tables', { exact: true }) });
  await tables.locator('.tree-chevron').click();
  const orders = page.locator('.tree-label').getByText('orders', { exact: true });
  await orders.waitFor({ timeout: 3000 });
  await orders.dblclick();
  await page.waitForSelector('.data-browser .fg-cell:visible', { timeout: 10000 });
}

async function verifyLiveDatabaseList(browser) {
  const page = await openSession(browser);
  await page.evaluate(() => {
    const original = window.__MOCK__.list_schema;
    window.__MOCK__.list_schema = args => {
      const nodes = original(args);
      return args?.context ? nodes : [...nodes, { kind: 'database', name: 'fresh_db' }];
    };
  });
  await page.locator('.db-roulette .mselect-btn').click();
  await page.getByRole('option', { name: 'fresh_db', exact: true }).waitFor({ timeout: 3000 });
  console.log('PASS database roulette refreshes its options when opened');
  await page.close();
}

async function verifyGraphicsConsistency(browser) {
  const browsed = await openSession(browser);
  await browseOrders(browsed);
  const browseGraphics = browsed.locator('.result-area > .rtab-bar').getByRole('button', { name: '📈 Graphics' });
  await browseGraphics.click({ timeout: 3000 });
  await browsed.locator('.data-browser:visible .graphics-view').waitFor({ timeout: 3000 });
  console.log('PASS table double-click exposes Graphics for the browsed rows');
  await browsed.close();

  const combined = await openResult(browser, false);
  await browseOrders(combined);
  const graphics = combined.locator('.result-area > .rtab-bar').getByRole('button', { name: '📈 Graphics' });
  await graphics.click();
  await combined.locator('.data-browser:visible .graphics-view').waitFor({ timeout: 3000 });
  await combined.locator('.result-area > .rtab-bar').getByRole('button', { name: 'Grid', exact: true }).click();
  await graphics.click();
  await combined.locator('.result-area > .graphics-view').waitFor({ timeout: 3000 });
  if (await combined.locator('.data-browser:visible').count() !== 0) {
    throw new Error('SQL Graphics left the table browser visible');
  }
  console.log('PASS Graphics follows the active SQL or browsed-table result');
  await combined.close();
}

async function verifySettings(browser) {
  const page = await newPage(browser, false, true);
  const updateCalls = () => page.evaluate(() =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'update_check').length);
  await page.clock.fastForward(11_000);
  if (await updateCalls() !== 0) throw new Error('default preferences triggered a launch update check');
  await page.keyboard.press('Meta+Comma');
  await page.waitForSelector('.settings-modal');
  const metrics = await page.evaluate(() => {
    const modal = document.querySelector('.settings-modal');
    const tabs = document.querySelector('.settings-tabs');
    const last = tabs.querySelector('.settings-tab:last-child');
    return {
      modalWidth: modal.getBoundingClientRect().width,
      clientWidth: tabs.clientWidth,
      scrollWidth: tabs.scrollWidth,
      tabsRight: tabs.getBoundingClientRect().right,
      lastRight: last.getBoundingClientRect().right,
    };
  });
  if (metrics.modalWidth < 680 || metrics.modalWidth > 760
      || metrics.scrollWidth > metrics.clientWidth + 1 || metrics.lastRight > metrics.tabsRight + 1) {
    throw new Error(`Settings is not compact with all tabs fitting: ${JSON.stringify(metrics)}`);
  }
  console.log('PASS Settings is compact and shows all nine tabs without scrolling');
  if (process.env.TXUI_SETTINGS_SHOT) await page.screenshot({ path: process.env.TXUI_SETTINGS_SHOT });

  await page.getByRole('tab', { name: 'Updates' }).click();
  const automatic = page.getByRole('checkbox', { name: /Automatically check for updates/ });
  if (await automatic.isChecked()) throw new Error('automatic update checks are enabled by default');
  await page.getByRole('button', { name: 'Check now' }).click();
  await page.waitForFunction(() =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'update_check').length === 1,
  null, { polling: 100 });
  await page.clock.fastForward(11_000);
  if (await updateCalls() !== 1) throw new Error('manual check unexpectedly enabled scheduled checks');

  await automatic.check();
  await page.clock.fastForward(11_000);
  await page.waitForFunction(() =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'update_check').length === 2,
  null, { polling: 100 });
  await automatic.uncheck();
  await page.clock.fastForward(6 * 60 * 60 * 1000 + 11_000);
  if (await updateCalls() !== 2) throw new Error('disabling automatic checks did not cancel the schedule');
  console.log('PASS update checks are opt-in; manual checks and disabling the schedule work');

  const handle = page.getByRole('button', { name: 'Resize Settings window' });
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error('Settings has no resize handle');
  const oldSize = await page.locator('.settings-modal').boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, handleBox.y + handleBox.height / 2 - 60, { steps: 6 });
  await page.mouse.up();
  const newSize = await page.locator('.settings-modal').boundingBox();
  if (!oldSize || !newSize || Math.abs(newSize.width - oldSize.width - 80) > 2
      || Math.abs(newSize.height - oldSize.height + 60) > 2) {
    throw new Error(`Settings did not resize: ${JSON.stringify({ oldSize, newSize })}`);
  }
  console.log('PASS Settings resizes in both dimensions');
  await page.close();
}

async function verifyTooltipLifetime(browser) {
  const page = await openSession(browser);
  const target = page.locator('.db-roulette .mselect-btn');
  const tip = page.locator('.dbgui-tip');
  await target.hover();
  await tip.waitFor({ state: 'visible' });
  await tip.waitFor({ state: 'hidden', timeout: 2500 });
  if (await target.getAttribute('title') === null) throw new Error('tooltip timeout did not restore the native title');

  await page.keyboard.press('Meta+Comma');
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await page.getByRole('combobox', { name: 'Tooltip display time' }).selectOption('3000');
  await page.locator('.settings-modal .modal-close').click();
  await target.hover();
  await tip.waitFor({ state: 'visible' });
  await page.waitForTimeout(1600);
  if (!await tip.isVisible()) throw new Error('custom tooltip timeout was not respected');
  await tip.waitFor({ state: 'hidden', timeout: 2000 });
  console.log('PASS tooltips time out by default and honor the configured lifetime');
  await page.close();
}

async function verifyCursorPreferences(browser) {
  const page = await openSession(browser);
  const width = () => page.locator('.cm-editor').first().evaluate(editor =>
    getComputedStyle(editor).getPropertyValue('--txui-cursor-width').trim());
  if (await width() !== '1px') throw new Error(`default bar cursor is not thin: ${await width()}`);
  await page.keyboard.press('Meta+Comma');
  await page.getByRole('tab', { name: 'Editor', exact: true }).click();
  const picker = page.getByRole('combobox', { name: 'Cursor bar width' });
  await picker.selectOption('1.5');
  await page.locator('.settings-modal .modal-close').click();
  if (await width() !== '1.5px') throw new Error(`cursor width did not update live: ${await width()}`);
  await page.keyboard.press('Meta+Comma');
  await page.getByRole('tab', { name: 'Editor', exact: true }).click();
  await picker.selectOption('2.5');
  await page.locator('.settings-modal .modal-close').click();
  if (await width() !== '2.5px') throw new Error(`previous bold cursor is not available: ${await width()}`);
  console.log('PASS cursor bar is thin by default and width choices apply live');
  await page.close();
}

async function verifyConnectionForm(browser) {
  const page = await newPage(browser);
  await page.locator('button[title^="New connection"]').first().click();
  await page.waitForSelector('.conn-form');
  const before = await page.evaluate(() => {
    const main = document.querySelector('.cf-iam-main');
    const row = main.closest('.cf-row');
    const chip = document.querySelector('.cf-chip');
    return {
      mainHeight: main.getBoundingClientRect().height,
      rowHeight: row.getBoundingClientRect().height,
      formHeight: document.querySelector('.conn-form').getBoundingClientRect().height,
      formWidth: document.querySelector('.conn-form').getBoundingClientRect().width,
      credentialVisibility: getComputedStyle(main.querySelector('.cf-iam-path')).visibility,
      chipWidth: chip.getBoundingClientRect().width,
      chipHeight: chip.getBoundingClientRect().height,
      paletteWidth: document.querySelector('.cf-palette').getBoundingClientRect().width,
    };
  });
  if (before.credentialVisibility !== 'hidden') throw new Error('unchecked IAM credential field is not reserved invisibly');
  await page.locator('.cf-iam-main input[type="checkbox"]').check();
  const after = await page.evaluate(() => {
    const main = document.querySelector('.cf-iam-main');
    const row = main.closest('.cf-row');
    return {
      mainHeight: main.getBoundingClientRect().height,
      rowHeight: row.getBoundingClientRect().height,
      formHeight: document.querySelector('.conn-form').getBoundingClientRect().height,
      credentialVisibility: getComputedStyle(main.querySelector('.cf-iam-path')).visibility,
    };
  });
  for (const key of ['mainHeight', 'rowHeight', 'formHeight']) {
    if (Math.abs(after[key] - before[key]) > 1) {
      throw new Error(`IAM toggling changed ${key}: ${before[key]} → ${after[key]}`);
    }
  }
  if (after.credentialVisibility !== 'visible') throw new Error('checked IAM credential field is not visible');
  if (before.chipWidth > 16 || before.chipHeight > 14 || before.paletteWidth > 310) {
    throw new Error(`palette is too large: ${JSON.stringify(before)}`);
  }
  console.log('PASS Cloud SQL IAM does not jump; color swatches are compact');
  if (before.formWidth > 740) throw new Error(`connection form is too wide: ${before.formWidth}px`);

  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await page.locator('.cf-advanced').waitFor();
  if (process.env.TXUI_CONNECTION_SHOT) await page.screenshot({ path: process.env.TXUI_CONNECTION_SHOT });
  if (await page.locator('.cf-advanced-group').count() !== 3) {
    throw new Error('Advanced fields are not organized into three compact groups');
  }
  const handle = page.getByRole('button', { name: 'Resize connection window' });
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error('connection form has no resize handle');
  const oldSize = await page.locator('.conn-form').boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, handleBox.y + handleBox.height / 2 - 60, { steps: 6 });
  await page.mouse.up();
  const newSize = await page.locator('.conn-form').boundingBox();
  if (!oldSize || !newSize || Math.abs(newSize.width - oldSize.width - 80) > 2
      || Math.abs(newSize.height - oldSize.height + 60) > 2) {
    throw new Error(`connection form did not resize: ${JSON.stringify({ oldSize, newSize })}`);
  }
  const overflow = await page.locator('.conn-form').evaluate(form => form.scrollWidth - form.clientWidth);
  if (overflow > 1) throw new Error(`Advanced form overflows horizontally by ${overflow}px`);
  console.log('PASS connection form is compact, Advanced is grouped, and resizing works');
  await page.close();
}

const server = await ensureServer();
const browser = await chromium.launch({ executablePath: EXE });
try {
  await verifySelections(browser);
  await verifyLiveDatabaseList(browser);
  await verifyGraphicsConsistency(browser);
  await verifySettings(browser);
  await verifyTooltipLifetime(browser);
  await verifyCursorPreferences(browser);
  await verifyConnectionForm(browser);
  const errors = pages.flatMap(page => page._coreErrors);
  if (errors.length) throw new Error(`uncaught browser errors: ${errors.join(' | ')}`);
  console.log('CORE INTERACTIONS OK');
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}
