// Real-Chromium SQL script panel journey against the documented mock channel.
// Requires dev/vite.shots.config.ts on :5273. The live backend is covered
// separately by dbctl_mysql_sql_script_end_to_end.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { mockFor, installMock } from './doc-fixtures.mjs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/'
     + 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OUT = process.env.TXUI_DOC_OUT ?? 'dev/verify-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(installMock, mockFor('mysql'));

try {
  await page.goto('http://localhost:5273/', { waitUntil: 'networkidle' });
  await page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: 'prod-orders' }) }).first().dblclick();
  await page.waitForSelector('.pmenu-title', { timeout: 12000 });

  if (await page.locator('.sidebar-header [title="Dump / restore"]').count()) {
    throw new Error('legacy Dump / Restore sidebar action is still visible');
  }
  await page.locator('.pmenu-title', { hasText: 'Data' }).first().click();
  await page.locator('.pmenu-item-label', { hasText: 'SQL script' }).first().click();
  await page.waitForSelector('.ss-root');

  const source = page.locator('.ss-target input');
  await source.fill('/tmp/flashback.sql.gz');
  await page.locator('.run-btn', { hasText: 'Run script' }).click();
  await page.waitForFunction(() => document.querySelector('.ss-status')?.textContent?.includes('Completed'));

  const text = await page.locator('.ss-root').innerText();
  for (const expected of [
    '100%', '8.00 MiB', '3 / 3', '2', '42', '4,711', '132 ms',
    'Validation complete: 3 statements. Execution started.',
    '#3 · line 42 · 4.00 KiB · 1 rows affected · 17 ms',
    'Completed: 3 executed, 0 failed, 2 rows affected in 132 ms.',
  ]) {
    if (!text.includes(expected)) throw new Error(`missing panel text: ${expected}`);
  }

  const calls = await page.evaluate(() => globalThis.__CALLS__ ?? []);
  const run = calls.find(c => c.cmd === 'run_sql_script');
  if (!run) throw new Error('run_sql_script was not invoked');
  if (run.args.compression !== 'gzip' || run.args.continueOnError !== false
      || run.args.maxStatementBytes !== 64 * 1024 * 1024
      || typeof run.args.sessionId !== 'string' || !run.args.sessionId) {
    throw new Error(`wrong run_sql_script arguments: ${JSON.stringify(run.args)}`);
  }

  const layout = await page.evaluate(() => {
    const body = document.querySelector('.ss-body').getBoundingClientRect();
    const form = document.querySelector('.ss-form').getBoundingClientRect();
    const log = document.querySelector('.ss-log-pane').getBoundingClientRect();
    const input = document.querySelector('.ss-target input').getBoundingClientRect();
    return {
      bodyWidth: body.width, formRight: form.right, logRight: log.right,
      inputLeft: input.left, inputRight: input.right,
      viewport: window.innerWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  if (layout.horizontalOverflow || layout.formRight > layout.viewport
      || layout.logRight > layout.viewport + 1
      || layout.inputLeft < 0 || layout.inputRight > layout.viewport) {
    throw new Error(`panel layout overflow: ${JSON.stringify(layout)}`);
  }
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);

  await page.screenshot({ path: `${OUT}/sql-script.png`, fullPage: true });
  console.log(`SQL SCRIPT UI: PASS — real Chromium run flow, arguments, counters, log and 1600×1000 layout; screenshot ${OUT}/sql-script.png`);
} finally {
  await browser.close();
}
