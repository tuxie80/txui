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

async function openResult(browser, multi) {
  const page = await newPage(browser, multi);
  const header = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: 'prod-orders' }) }).first();
  await header.dblclick();
  await page.waitForSelector('.cm-content', { timeout: 15000 });
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
  if (metrics.modalWidth < 800 || metrics.scrollWidth > metrics.clientWidth + 1 || metrics.lastRight > metrics.tabsRight + 1) {
    throw new Error(`Settings tabs do not fit: ${JSON.stringify(metrics)}`);
  }
  console.log('PASS Settings shows all nine tabs without horizontal scrolling');

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
  await page.close();
}

const server = await ensureServer();
const browser = await chromium.launch({ executablePath: EXE });
try {
  await verifySelections(browser);
  await verifySettings(browser);
  await verifyConnectionForm(browser);
  const errors = pages.flatMap(page => page._coreErrors);
  if (errors.length) throw new Error(`uncaught browser errors: ${errors.join(' | ')}`);
  console.log('CORE INTERACTIONS OK');
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}
