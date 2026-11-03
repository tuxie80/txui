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

async function verifyFlavorPersistence(browser) {
  const page = await openSession(browser);
  await page.waitForFunction(() =>
    (window.__CALLS__ ?? []).some(call => call.cmd === 'save_connection'
      && call.args?.config?.detected_flavor && call.args?.config?.detected_platform),
  null, { polling: 100, timeout: 5000 });
  const metadata = await page.evaluate(() =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'save_connection')
      .map(call => call.args.config)
      .find(config => config.detected_flavor && config.detected_platform));
  if (metadata.detected_flavor !== 'mysql' || metadata.detected_platform !== 'generic') {
    throw new Error(`unexpected detected metadata: ${JSON.stringify(metadata)}`);
  }
  console.log('PASS server probe persists fork and platform in hidden connection metadata');
  await page.close();
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
  await page.locator('.settings-tabs').evaluate(tabs => {
    const range = document.createRange();
    range.selectNodeContents(tabs);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('tab', { name: 'Editor', exact: true }).click();
  const selectedText = await page.evaluate(() => window.getSelection().toString());
  if (selectedText) throw new Error(`Settings text selection did not clear on outside click: ${selectedText}`);
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

  await page.getByRole('tab', { name: 'Editor', exact: true }).click();
  await page.getByRole('tablist', { name: 'Editor settings sections' }).waitFor();
  for (const [section, control] of [
    ['Visuals', 'Cursor shape'],
    ['Editing', 'Auto-format SQL'],
    ['Results', 'Include column headers when copying cells'],
    ['Execution', 'Beep when a long-running query finishes'],
  ]) {
    await page.getByRole('tab', { name: section, exact: true }).click();
    await page.getByText(control, { exact: false }).first().waitFor();
    if (section === 'Editing' && process.env.TXUI_EDITOR_SETTINGS_SHOT) {
      await page.screenshot({ path: process.env.TXUI_EDITOR_SETTINGS_SHOT });
    }
    const body = await page.locator('.settings-body').evaluate(element => ({
      client: element.clientHeight, scroll: element.scrollHeight,
    }));
    if (body.scroll > body.client + 1) {
      throw new Error(`${section} still needs vertical scrolling: ${JSON.stringify(body)}`);
    }
    const waste = await page.locator('.settings-modal').evaluate(modal => {
      const section = modal.querySelector('.settings-section');
      return modal.getBoundingClientRect().bottom - section.getBoundingClientRect().bottom;
    });
    if (waste > 32) throw new Error(`${section} leaves ${Math.round(waste)}px of unused space below its content`);
  }
  console.log('PASS Editor settings use four compact purpose-based sections');

  await page.getByRole('tab', { name: 'Updates' }).click();
  const automatic = page.getByRole('checkbox', { name: /Automatically check for updates/ });
  if (await automatic.isChecked()) throw new Error('automatic update checks are enabled by default');
  await page.evaluate(() => { window.__MOCK__.update_check = { latest: null, branch: null }; });
  const checkRow = page.locator('.settings-row').filter({ has: page.getByRole('button', { name: 'Check now' }) });
  const sectionHeight = await checkRow.evaluate(row => row.parentElement.getBoundingClientRect().height);
  await page.getByRole('button', { name: 'Check now' }).click();
  await page.waitForFunction(() =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'update_check').length === 1,
  null, { polling: 100 });
  await page.getByText(/You're up to date/).waitFor();
  const currentHeight = await checkRow.evaluate(row => row.parentElement.getBoundingClientRect().height);
  if (Math.abs(currentHeight - sectionHeight) > 1) {
    throw new Error(`up-to-date result moved the Updates section: ${sectionHeight} → ${currentHeight}`);
  }
  await checkRow.locator('.settings-update-result').waitFor();
  await page.clock.fastForward(11_000);
  if (await updateCalls() !== 1) throw new Error('manual check unexpectedly enabled scheduled checks');

  await automatic.check();
  await page.clock.fastForward(59_000);
  if (await updateCalls() !== 1) throw new Error('opt-in launch check ran before one minute');
  await page.clock.fastForward(1_000);
  await page.waitForFunction(() =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'update_check').length === 2,
  null, { polling: 100 });
  await automatic.uncheck();
  await page.clock.fastForward(6 * 60 * 60 * 1000 + 11_000);
  if (await updateCalls() !== 2) throw new Error('disabling automatic checks did not cancel the schedule');
  console.log('PASS update checks are opt-in; manual checks and disabling the schedule work');

  await page.evaluate(() => {
    window.__MOCK__.update_check = {
      latest: { version: '99.0.0', date: null, body: null },
      branch: { version: '99.0.0', date: null, body: null },
    };
  });
  await page.getByRole('button', { name: 'Check now' }).click();
  await page.getByText(/Update v99\.0\.0/).waitFor();
  const availableHeight = await checkRow.evaluate(row => row.parentElement.getBoundingClientRect().height);
  if (Math.abs(availableHeight - sectionHeight) > 1) {
    throw new Error(`update-available result moved the Updates section: ${sectionHeight} → ${availableHeight}`);
  }
  await checkRow.locator('.settings-update-result').waitFor();
  console.log('PASS update results stay inline without moving the Updates section');
  if (process.env.TXUI_UPDATES_SHOT) await page.screenshot({ path: process.env.TXUI_UPDATES_SHOT });

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

  const header = await page.locator('.settings-modal .modal-header').boundingBox();
  if (!header) throw new Error('Settings has no draggable header');
  await page.mouse.move(header.x + 60, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 150, header.y + header.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  const moved = await page.locator('.settings-modal').boundingBox();
  if (!newSize || !moved || Math.abs(moved.x - newSize.x - 90) > 2 || Math.abs(moved.y - newSize.y - 40) > 2) {
    throw new Error(`Settings did not move: ${JSON.stringify({ newSize, moved })}`);
  }
  console.log('PASS Settings clears text selection and moves by its header');
  await page.close();
}

async function verifyFirstLineDiagnostic(browser) {
  const page = await openSession(browser);
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('select * from nyc_taxi.gps_pings;');
  await page.waitForTimeout(700);
  const line = await page.locator('.cm-line').first().boundingBox();
  const toolbar = await page.locator('.editor-toolbar').first().boundingBox();
  if (!line || !toolbar) throw new Error('editor line or toolbar is not measurable');
  await page.mouse.move(line.x + 20, line.y + line.height / 2);
  const tip = page.locator('.cm-tooltip:visible').first();
  await tip.waitFor({ timeout: 3000 });
  const box = await tip.boundingBox();
  if (!box || box.y < toolbar.y + toolbar.height - 1) {
    throw new Error(`first-line diagnostic is clipped by the toolbar: ${JSON.stringify({ box, toolbar })}`);
  }
  console.log('PASS first-line diagnostic tooltip stays below the editor toolbar');
  await page.close();
}

async function verifyObjectNavigation(browser) {
  const page = await newPage(browser);
  await page.evaluate(() => {
    const original = window.__MOCK__.list_schema;
    window.__MOCK__.list_schema = args => {
      const nodes = original(args);
      return args?.context ? nodes : [...nodes, { kind: 'database', name: 'nyc_taxi' }];
    };
    const originalMonitor = window.__MOCK__.monitor_query;
    window.__MOCK__.monitor_query = args => {
      const result = originalMonitor(args);
      const sql = String(args?.sql ?? '');
      if (sql.includes('information_schema.schemata')) return { ...result, rows: [['nyc_taxi']] };
      if (sql.includes('information_schema.tables')) {
        return { ...result, rows: [['nyc_taxi', 'gps_pings', 'BASE TABLE']] };
      }
      if (/information_schema\.(routines|triggers|events|KEY_COLUMN_USAGE|STATISTICS)/i.test(sql)) {
        return { ...result, rows: [] };
      }
      return result;
    };
  });
  await page.evaluate(() => { window.dispatchEvent(new CustomEvent('dbgui:schema-changed')); });
  const header = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: 'prod-orders' }) }).first();
  await header.dblclick();
  await page.waitForSelector('.cm-content', { timeout: 15000 });
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('select * from nyc_taxi.gps_pings;');
  await page.waitForTimeout(500);
  const line = await page.locator('.cm-line').first().boundingBox();
  const editorToolbar = await page.locator('.editor-toolbar').first().boundingBox();
  if (!line || !editorToolbar) throw new Error('database identifier or toolbar is not measurable');
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('dbgui:goto-range', { detail: { from: 14, to: 22 } }));
  });
  await page.keyboard.press('Meta+l');
  await page.waitForFunction(() =>
    (window.__CALLS__ ?? []).some(call => call.cmd === 'set_session_db' && call.args?.db === 'nyc_taxi'),
  null, { polling: 100, timeout: 3000 });
  await page.mouse.move(line.x + 120, line.y + line.height / 2);
  const databaseTip = page.locator('.cm-tooltip:visible').filter({ hasText: 'default database' });
  await databaseTip.waitFor({ timeout: 3000 });
  const databaseTipBox = await databaseTip.boundingBox();
  if (!databaseTipBox || databaseTipBox.y < editorToolbar.y + editorToolbar.height - 1) {
    throw new Error(`first-line database tooltip is clipped by the toolbar: ${JSON.stringify({ databaseTipBox, editorToolbar })}`);
  }
  console.log('PASS first-line database tooltip stays below the editor toolbar');
  await page.mouse.move(0, 0);
  await page.keyboard.down('Meta');
  await page.mouse.click(line.x + 120, line.y + line.height / 2);
  await page.keyboard.up('Meta');
  await page.waitForFunction(() =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'set_session_db' && call.args?.db === 'nyc_taxi').length >= 2,
  null, { polling: 100, timeout: 3000 });
  const tableBrowses = await page.evaluate(() =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'browse_table').length);
  if (tableBrowses !== 0) throw new Error('database name incorrectly opened the table browser');
  console.log('PASS command-click and Mod-L select a database without browsing a table');
  await page.close();

  const tablePage = await newPage(browser);
  await tablePage.evaluate(() => {
    window.__MOCK__.get_table_meta = { ...window.__MOCK__.get_table_meta, pk_columns: [] };
    const originalMonitor = window.__MOCK__.monitor_query;
    window.__MOCK__.monitor_query = args => {
      const result = originalMonitor(args);
      const sql = String(args?.sql ?? '');
      if (sql === 'SELECT DATABASE()') return { ...result, rows: [['shop']] };
      if (sql.includes('information_schema.tables')) {
        return { ...result, rows: [['shop', 'orders', 'BASE TABLE']] };
      }
      if (sql.includes('information_schema.schemata')) return { ...result, rows: [['shop']] };
      if (/information_schema\.(routines|triggers|events|KEY_COLUMN_USAGE|STATISTICS)/i.test(sql)) {
        return { ...result, rows: [] };
      }
      return result;
    };
  });
  const tableHeader = tablePage.locator('.conn-item-header', { has: tablePage.locator('.conn-name', { hasText: 'prod-orders' }) }).first();
  await tableHeader.dblclick();
  await tablePage.waitForSelector('.cm-content', { timeout: 15000 });
  await tablePage.locator('.cm-content').first().click();
  await tablePage.keyboard.press('Meta+a');
  await tablePage.keyboard.type('select * from shop.orders;');
  await tablePage.waitForTimeout(500);
  const tablePoint = await tablePage.locator('.cm-line').first().evaluate(line => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const offset = node.textContent.indexOf('orders');
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 'orders'.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    return null;
  });
  if (!tablePoint) throw new Error('table identifier is not measurable');
  await tablePage.mouse.move(tablePoint.x, tablePoint.y);
  const tableTip = tablePage.locator('.cm-tooltip:visible').filter({ hasText: 'to browse it' });
  await tableTip.waitFor({ timeout: 3000 });
  if (!await tableTip.getByText('shop.orders', { exact: true }).count()) {
    throw new Error(`table hover shows the wrong target: ${await tableTip.textContent()}`);
  }
  console.log('PASS table hover shows schema, columns and browse hint');
  await tablePage.mouse.move(0, 0);
  await tablePage.evaluate(() => {
    window.dispatchEvent(new CustomEvent('dbgui:goto-range', { detail: { from: 19, to: 25 } }));
  });
  await tablePage.keyboard.press('Meta+l');
  await tablePage.waitForFunction(() =>
    (window.__CALLS__ ?? []).some(call => call.cmd === 'browse_table' && call.args?.params?.table === 'shop.orders'),
  null, { polling: 100 });
  console.log('PASS Mod-L on a table keeps its 100-row browser');
  await tablePage.close();
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
  const wasted = await page.locator('.conn-form').evaluate(form =>
    form.getBoundingClientRect().bottom - form.querySelector('.form-actions').getBoundingClientRect().bottom);
  if (wasted > 32) throw new Error(`connection form leaves ${Math.round(wasted)}px below its actions`);
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

async function verifyErrorPresentation(browser) {
  const page = await openSession(browser);
  await page.evaluate(() => {
    window.__MOCK__.ai_has_key = false;
    window.__MOCK__.execute_query = () => {
      throw new Error("ERROR 1064 (42000): You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near 'sdf sdf sdf sdf sf' at line 1");
    };
    window.dispatchEvent(new CustomEvent('dbgui:ai-config-changed'));
  });
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('sdf sdf sdf sdf sf');
  await page.keyboard.press('Meta+Enter');
  const error = page.locator('.query-error');
  await error.waitFor({ timeout: 5000 });
  const metrics = await error.evaluate(element => {
    const guidance = element.querySelector('.query-error-guidance');
    const title = guidance.querySelector('strong');
    const detail = guidance.querySelector('span');
    return {
      height: element.getBoundingClientRect().height,
      message: element.querySelector('.query-error-msg').textContent,
      titleBottom: title.getBoundingClientRect().bottom,
      detailTop: detail.getBoundingClientRect().top,
    };
  });
  if (metrics.height > 220) throw new Error(`query error consumes excessive height: ${JSON.stringify(metrics)}`);
  if (!metrics.message.includes('ERROR 1064')) throw new Error('server error message is not visible');
  if (metrics.detailTop < metrics.titleBottom - 1) {
    throw new Error(`error guidance title and detail are not separated: ${JSON.stringify(metrics)}`);
  }
  const fix = page.getByRole('button', { name: '✦ Fix with AI' });
  if (await fix.getAttribute('aria-disabled') !== 'true') {
    throw new Error('unconfigured AI action is presented as available');
  }
  await page.waitForFunction(() =>
    document.querySelector('.query-error-fix')?.closest('[data-tip]')?.getAttribute('data-tip')?.includes('Settings → AI'),
  null, { polling: 100, timeout: 3000 });
  const reason = await fix.evaluate(button => button.closest('[data-tip]')?.getAttribute('data-tip') ?? '');
  if (!reason.includes('Settings → AI')) throw new Error('unconfigured AI action does not explain the fix');
  await fix.dispatchEvent('click');
  if (await page.locator('.ai-modal').count() !== 0) throw new Error('unconfigured AI action opened the assistant');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Meta+i');
  if (await page.locator('.ai-modal').count() !== 0) throw new Error('AI shortcut bypassed the configuration guard');

  await page.evaluate(() => {
    window.__MOCK__.ai_has_key = true;
    window.__MOCK__.ai_complete = () => 'SELECT 1';
    window.dispatchEvent(new CustomEvent('dbgui:ai-config-changed'));
  });
  await page.waitForFunction(() =>
    document.querySelector('.query-error-fix')?.getAttribute('aria-disabled') === 'false',
  null, { polling: 100, timeout: 3000 });
  await fix.click();
  await page.locator('.ai-modal').waitFor();
  await page.locator('.ai-result').getByText('SELECT 1', { exact: true }).waitFor();
  await page.locator('.ai-modal .icon-btn').click();
  console.log('PASS compact errors and live AI availability guards work');
  if (process.env.TXUI_ERROR_SHOT) await page.screenshot({ path: process.env.TXUI_ERROR_SHOT });

  const sample = "show global status like '%cnt%';\nshow global variables;\nshow processlist;\nshow replica status;\n\n\nUser;Host;db;Command;Time;State\nroot;localhost:57587;;Sleep;45;";
  const failing = 'root;localhost:57587;;Sleep;45;';
  await page.evaluate(sample => {
    window.__MOCK__.execute_query = () => {
      throw new Error("ERROR 1064 (42000): You have an error in your SQL syntax near 'root' at line 2");
    };
    window.dispatchEvent(new CustomEvent('dbgui:replace-sql', { detail: { sql: sample } }));
  }, sample);
  await page.locator('.cm-content').first().click();
  await page.evaluate(from => {
    window.dispatchEvent(new CustomEvent('dbgui:goto-range', { detail: { from, to: from } }));
  }, sample.indexOf(failing) + 2);
  const executeCalls = await page.evaluate(() =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'execute_query').length);
  await page.locator('.run-btn-go').click();
  await page.waitForFunction(before =>
    (window.__CALLS__ ?? []).filter(call => call.cmd === 'execute_query').length > before,
  executeCalls, { polling: 100, timeout: 3000 });
  await page.waitForTimeout(100);
  await page.locator('.query-error').waitFor();
  await page.getByRole('button', { name: 'Go to error' }).click();
  await page.waitForFunction(() =>
    document.querySelector('.cm-activeLine')?.textContent?.includes('root;localhost:57587'),
  null, { polling: 100, timeout: 3000 });
  console.log('PASS Go to error maps statement-relative positions into the buffer');

  const actionTexts = await page.locator('.query-error-actions button').allTextContents();
  if (actionTexts.at(-1) !== '✦ Fix with AI' || !actionTexts.includes('Copy diagnostics')) {
    throw new Error(`error actions are not consolidated: ${JSON.stringify(actionTexts)}`);
  }
  await page.close();
  const markerPage = await openSession(browser);
  {
    const page = markerPage;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const markerSample = "show global variables;\nshow processlist;\nshow replica status;\nUser;Host;db;Command;Time;State\nsystem user;;;Sleep;340666;wsrep aborter idle\nroot;localhost:57584;;Sleep;0;\nroot;localhost:57586;;Query;0;starting\nroot;localhost:57587;;Sleep;45;";
    await page.evaluate(sample => {
      window.__MOCK_OK__ = window.__MOCK__.execute_query;
      window.__MOCK__.execute_query = () => {
        throw new Error("ERROR 1064 (42000): You have an error in your SQL syntax near 'db' at line 1");
      };
      window.dispatchEvent(new CustomEvent('dbgui:replace-sql', { detail: { sql: sample } }));
    }, markerSample);
    const targets = [
      'User;Host;db;Command;Time;State',
      'system user;;;Sleep;340666;wsrep aborter idle',
      'root;localhost:57584;;Sleep;0;',
      'root;localhost:57586;;Query;0;starting',
    ];
    const caretColumns = new Map([[targets[0], 7], [targets[1], 2]]);
    const priorMarkers = new Map();
    for (const target of targets) {
      const targetLine = page.locator('.cm-content .cm-line').filter({ hasText: target }).first();
      await targetLine.click();
      await page.keyboard.press('Home');
      const caretColumn = caretColumns.get(target);
      if (caretColumn === undefined) await page.keyboard.press('End');
      else for (let i = 0; i < caretColumn; i++) await page.keyboard.press('ArrowRight');
      const targetLineNumber = await targetLine.evaluate(element =>
        [...element.parentElement.children].indexOf(element) + 1);
      const before = await page.evaluate(() =>
        (window.__CALLS__ ?? []).filter(call => call.cmd === 'execute_query').length);
      await page.locator('.run-btn-go').click();
      await page.waitForFunction(count =>
        (window.__CALLS__ ?? []).filter(call => call.cmd === 'execute_query').length > count,
      before, { polling: 100, timeout: 3000 });
      await page.waitForFunction(count =>
        document.querySelectorAll('.cm-run-gutter .cm-run-error').length === count,
      priorMarkers.size + 1, { polling: 16, timeout: 3000 });
      await page.locator('.query-error').waitFor();
      const markers = await page.evaluate(() => {
        const codeLines = [...document.querySelectorAll('.cm-content .cm-line')].map((element, index) => ({
          number: index + 1,
          text: element.textContent,
          top: element.getBoundingClientRect().top,
          bottom: element.getBoundingClientRect().bottom,
        }));
        return [...document.querySelectorAll('.cm-run-gutter .cm-run-error')].map(element => {
          const rect = element.closest('.cm-gutterElement').getBoundingClientRect();
          const y = rect.top + rect.height / 2;
          const line = codeLines.find(candidate => y >= candidate.top && y <= candidate.bottom);
          return { line: line?.number, lineText: line?.text, text: element.textContent, title: element.getAttribute('title') };
        });
      });
      const expected = [...priorMarkers.keys(), targetLineNumber].sort((a, b) => a - b);
      if (JSON.stringify(markers.map(marker => marker.line)) !== JSON.stringify(expected)) {
        throw new Error(`run on ${target} moved or replaced timestamps: ${JSON.stringify({ expected, markers })}`);
      }
      for (const [line, marker] of priorMarkers) {
        const current = markers.find(candidate => candidate.line === line);
        if (!current || current.text !== marker.text || current.title !== marker.title) {
          throw new Error(`run on ${target} rewrote line ${line}: ${JSON.stringify({ marker, current })}`);
        }
      }
      for (const marker of markers) priorMarkers.set(marker.line, marker);
    }
    console.log('PASS sequential failures keep each timestamp on its executed line');
    const proofMarker = page.locator('.cm-run-gutter .cm-run-error').first();
    await proofMarker.hover();
    const proofTip = page.locator('.dbgui-tip');
    await proofTip.waitFor({ state: 'visible' });
    await page.waitForTimeout(1400);
    if (!await proofTip.isVisible()) throw new Error('run-proof tooltip expired with ordinary tooltips');
    if (!await proofTip.textContent().then(text => text?.includes('Click to copy timestamp + statement'))) {
      throw new Error('run-proof tooltip does not explain click-to-copy');
    }
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE.slice(0, -1) });
    await proofMarker.click();
    const proof = await page.evaluate(() => navigator.clipboard.readText());
    if (!/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/.test(proof)
        || !proof.includes('Host; → error') || proof.includes('User;')) {
      throw new Error(`marker copied the wrong proof: ${JSON.stringify(proof)}`);
    }
    await page.mouse.move(0, 0);
    await proofTip.waitFor({ state: 'hidden' });
    console.log('PASS run-proof tooltip persists and click copies timestamp plus exact SQL');
    const redSnapshot = () => page.locator('.cm-run-gutter .cm-run-error').evaluateAll(elements => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')].map((line, index) => ({
        number: index + 1,
        text: line.textContent,
        top: line.getBoundingClientRect().top,
        bottom: line.getBoundingClientRect().bottom,
      }));
      return elements.map(element => {
        const rect = element.closest('.cm-gutterElement').getBoundingClientRect();
        const y = rect.top + rect.height / 2;
        const line = lines.find(candidate => y >= candidate.top && y <= candidate.bottom);
        return { line: line?.number, lineText: line?.text,
          text: element.textContent, title: element.getAttribute('title') };
      });
    });
    const redBeforeClose = await redSnapshot();
    await page.getByRole('button', { name: 'Close error', exact: true }).click();
    await page.locator('.query-error').waitFor({ state: 'hidden' });
    if (JSON.stringify(await redSnapshot()) !== JSON.stringify(redBeforeClose)) {
      throw new Error('dismissing the error panel removed or changed red statement timings');
    }
    console.log('PASS error actions stay together and dismissing preserves red timings');

    await page.evaluate(() => { window.__MOCK__.execute_query = window.__MOCK_OK__; });
    const successTarget = page.locator('.cm-content .cm-line').filter({ hasText: 'show global variables' }).first();
    await successTarget.click();
    await page.locator('.run-btn-go').click();
    await page.locator('.cm-run-gutter .cm-run-ok').waitFor();
    await page.waitForTimeout(200);
    if (JSON.stringify(await redSnapshot()) !== JSON.stringify(redBeforeClose)) {
      throw new Error(`a successful statement removed earlier red timings: ${JSON.stringify(await redSnapshot())}`);
    }
    await page.evaluate(() => {
      window.__MOCK__.execute_query = () => { throw new Error('ERROR 1064 (42000): forced failure'); };
    });
    await page.locator('.cm-content .cm-line').filter({ hasText: targets.at(-1) }).first().click();
    await page.locator('.run-btn-go').click();
    await page.locator('.query-error').waitFor();
    await page.waitForTimeout(100);
    if (await page.locator('.cm-run-gutter .cm-run-ok').count() !== 1) {
      throw new Error('a later failure removed the successful statement timing');
    }
    console.log('PASS red and green timings coexist across mixed runs');
    const redAfterMixed = await redSnapshot();
    await page.evaluate(() => { window.__MOCK__.execute_query = window.__MOCK_OK__; });
    await page.getByRole('button', { name: 'Close error', exact: true }).click();
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('Meta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('SELECT 42;');
    await page.locator('.run-btn-go').click();
    await page.waitForFunction(() => document.querySelectorAll('.cm-run-gutter .cm-run-ok').length === 2,
      null, { polling: 100, timeout: 3000 });
    if (JSON.stringify(await redSnapshot()) !== JSON.stringify(redAfterMixed)) {
      throw new Error(`adding and running new SQL removed earlier red timings: ${JSON.stringify(await redSnapshot())}`);
    }
    console.log('PASS editing and running new SQL preserves every earlier red timing');

    const redBeforeSelection = await redSnapshot();
    await page.locator('.cm-content .cm-line').filter({ hasText: 'show global variables' }).first().click();
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    const beforeSelection = await page.evaluate(() =>
      (window.__CALLS__ ?? []).filter(call => call.cmd === 'execute_query').length);
    await page.locator('.run-btn-go').click();
    await page.waitForFunction(before =>
      (window.__CALLS__ ?? []).filter(call => call.cmd === 'execute_query').length >= before + 3,
    beforeSelection, { polling: 100, timeout: 5000 });
    await page.locator('.run-btn-go').waitFor();
    if (JSON.stringify(await redSnapshot()) !== JSON.stringify(redBeforeSelection)) {
      throw new Error(`successful selection erased unrelated red timings: ${JSON.stringify({
        before: redBeforeSelection, after: await redSnapshot(),
      })}`);
    }
    console.log('PASS a successful multi-line selection preserves unrelated red timings');

    await page.evaluate(() => {
      const succeed = window.__MOCK_OK__;
      window.__MOCK__.execute_query = args => /^(?:show|select)\b/i.test(args.sql.trim())
        ? (typeof succeed === 'function' ? succeed(args) : succeed)
        : (() => { throw new Error('ERROR 1064 (42000): forced script failure'); })();
    });
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('Meta+Shift+Enter');
    await page.getByRole('button', { name: 'Ignore all', exact: true }).click();
    await page.locator('.run-btn-go').waitFor({ timeout: 10000 });
    await page.waitForTimeout(200);
    const redAfterScript = await redSnapshot();
    if (redAfterScript.length === 0) throw new Error('script run produced no error markers for the fold test');
    await page.locator('.cm-content .cm-line').filter({ hasText: 'show global variables' }).first().click();
    await page.locator('.run-btn-go').click();
    await page.waitForTimeout(250);
    if (JSON.stringify(await redSnapshot()) !== JSON.stringify(redAfterScript)) {
      throw new Error(`single run after a script removed red timings: ${JSON.stringify({
        before: redAfterScript, after: await redSnapshot(),
      })}`);
    }
    console.log('PASS folding a finished script into a single run preserves red timings');
    const redBeforeRefresh = await redSnapshot();
    const refreshTarget = redBeforeRefresh.find(marker => marker.lineText?.includes(targets.at(-1)));
    if (!refreshTarget) throw new Error('cannot locate the failed statement for its single-run refresh');
    await page.evaluate(() => {
      window.__MOCK__.execute_query = () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('ERROR 1064 (42000): delayed single-run failure')), 60);
      });
    });
    await page.locator('.cm-content .cm-line').filter({ hasText: targets.at(-1) }).first().click();
    await page.locator('.run-btn-go').click();
    await page.locator('.query-error').waitFor();
    await page.waitForTimeout(150);
    const redAfterRefresh = await redSnapshot();
    const refreshed = redAfterRefresh.find(marker => marker.line === refreshTarget.line);
    if (!refreshed || refreshed.text === refreshTarget.text) {
      throw new Error(`single failure did not refresh its old script timing: ${JSON.stringify({
        before: refreshTarget, after: refreshed,
      })}`);
    }
    for (const before of redBeforeRefresh) {
      if (before.line === refreshTarget.line) continue;
      const after = redAfterRefresh.find(marker => marker.line === before.line);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error(`single failure changed an unrelated red marker: ${JSON.stringify({ before, after })}`);
      }
    }
    console.log('PASS a single failure after Ignore all refreshes only its own old timing');
    await page.close();
  }
}

const server = await ensureServer();
const browser = await chromium.launch({ executablePath: EXE });
try {
  await verifySelections(browser);
  await verifyLiveDatabaseList(browser);
  await verifyFlavorPersistence(browser);
  await verifyGraphicsConsistency(browser);
  await verifySettings(browser);
  await verifyFirstLineDiagnostic(browser);
  await verifyObjectNavigation(browser);
  await verifyErrorPresentation(browser);
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
