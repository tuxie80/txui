import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mockFor, installMock } from './doc-fixtures.mjs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5273/';
const OUT = process.env.TXUI_DOC_OUT ?? 'dev/verify-shots';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync(OUT, { recursive: true });

async function ensureServer() {
  try {
    const response = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
    if (response.ok) return null;
  } catch { /* start below */ }
  const child = spawn('node', ['node_modules/vite/bin/vite.js', '--config', 'dev/vite.shots.config.ts'], { detached: true, stdio: 'ignore' });
  for (let index = 0; index < 60; index++) {
    await sleep(250);
    try {
      const response = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return child;
    } catch { /* poll */ }
  }
  process.kill(-child.pid);
  throw new Error('Vite mock server did not start');
}

function queryLabMock() {
  Object.assign(window.__MOCK__, {
    list_connections: [{
      id: 'c-lab', name: 'lab-visual', engine: 'mysql', host: '127.0.0.1', port: 3306,
      user: 'root', database: null, group: 'Visual', environment: 'dev', read_only: false,
      color: null, auto_connect: false, tags: [], labels: [],
      prod_allow_ddl: true, prod_allow_unfiltered_write: false,
    }],
    open_connection: () => 's-lab',
    migration_scratch_list: [],
    query_lab_rewrite_measure: args => ({
      run_key: args.input.baseline.run_key, spec_sha256: args.input.baseline.spec_sha256,
      candidate_id: args.input.candidate.id, backend_id: 45,
      correctness: 'equal', reason: null,
      row_order_policy: args.input.row_order_policy, max_rows: args.input.max_rows, max_bytes: args.input.max_bytes,
      baseline: {
        columns: [{ name: 'id', type_name: 'INT' }, { name: 'customer_id', type_name: 'INT' }],
        rows_observed: 2, bytes_observed: 24, sha256: 'a'.repeat(64), complete: true, unverified_reason: null,
      },
      candidate: {
        columns: [{ name: 'id', type_name: 'INT' }, { name: 'customer_id', type_name: 'INT' }],
        rows_observed: 2, bytes_observed: 24, sha256: 'a'.repeat(64), complete: true, unverified_reason: null,
      },
      cleanup: { timeout_restored: true, connection_closed: true },
    }),
    query_lab_benchmark: args => {
      const pairs = Array.from({ length: args.input.repetitions }, (_, index) => ({
        repetition: index + 1, order: index % 2 === 0 ? 'baseline_first' : 'candidate_first',
        baseline_ms: 10 + index, candidate_ms: 8 + index,
      }));
      return {
        run_key: args.input.rewrite.baseline.run_key, spec_sha256: args.input.rewrite.baseline.spec_sha256,
        candidate_id: args.input.rewrite.candidate.id, backend_id: 46,
        warmup_runs: args.input.warmup_runs, repetitions: args.input.repetitions,
        pairs,
        baseline_ms: pairs.map(pair => pair.baseline_ms), candidate_ms: pairs.map(pair => pair.candidate_ms),
        baseline: { count: pairs.length, min_ms: 10, median_ms: 13, p95_ms: 16, max_ms: 16 },
        candidate: { count: pairs.length, min_ms: 8, median_ms: 11, p95_ms: 14, max_ms: 14 },
        baseline_sha256: 'a'.repeat(64), candidate_sha256: 'a'.repeat(64),
        cleanup: { timeout_restored: true, connection_closed: true },
      };
    },
    save: () => '/mock/query-lab-report.md',
    write_text_file: null,
  });
}

async function click(page, text) {
  await page.locator('button:visible', { hasText: text }).first().click();
}

async function runFlow(page) {
  await page.goto(`${BASE}dev/query-lab.html`, { waitUntil: 'networkidle' });
  try {
    await page.locator('.proc-title:visible', { hasText: 'Query Optimization Lab' }).waitFor({ timeout: 10000 });
  } catch (error) {
    console.error(await page.locator('body').innerText());
    console.error(await page.evaluate(() => window.__CALLS__.map(call => call.cmd)));
    console.error(await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /QueryLab|planCorrelation|queryLabReport|benchmark/.test(name))));
    console.error(await page.evaluate(() => [...document.querySelectorAll('*')].filter(element => element.children.length === 0 && element.textContent === 'Loading…').map(element => element.outerHTML)));
    console.error(await page.evaluate(() => performance.getEntriesByType('resource').slice(-20).map(entry => entry.name)));
    await page.screenshot({ path: `${OUT}/query-lab-open-failure.png`, fullPage: true });
    throw error;
  }
  const longSql = `SELECT id, customer_id, created_at FROM orders WHERE customer_id = :customer_id ${'AND id > 0 '.repeat(700)}ORDER BY id LIMIT 1000`;
  await page.locator('.sqp-left textarea').first().fill(longSql);
  await page.locator('select').filter({ has: page.locator('option[value="measured"]') }).first().selectOption('measured');
  await page.locator('label', { hasText: 'Measured timing' }).click();
  await page.locator('label', { hasText: 'Result equality' }).click();
  await click(page, 'Validate experiment');
  await click(page, 'Check rewrite results');
  await page.locator('section[aria-label="Rewrite correctness evidence"]').waitFor();
  await click(page, 'Benchmark rewrite');
  await page.locator('section[aria-label="Benchmark timing evidence"]').waitFor();
  await click(page, 'Export report .md');
  await page.waitForFunction(() => document.body.innerText.includes('Report saved to /mock/query-lab-report.md'));
  const calls = await page.evaluate(() => window.__CALLS__);
  const report = calls.find(call => call.cmd === 'write_text_file');
  if (!report?.args.contents.includes('# Query Optimization Lab report')) throw new Error('report was not written');
  for (const expected of ['Exact experiment mode | measured', 'Baseline raw timings ms | [10, 11, 12, 13, 14, 15, 16]', 'No query-result rows, credentials or report timestamp are included']) {
    if (!report.args.contents.includes(expected)) throw new Error(`report lacks ${expected}`);
  }
}

async function checkLayout(page, label) {
  const layout = await page.evaluate(() => {
    const rect = selector => {
      const element = [...document.querySelectorAll(selector)].find(candidate => candidate.getBoundingClientRect().width > 0);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    const overflowing = [...document.querySelectorAll('.proc-panel button, .proc-panel input, .proc-panel select')].filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
    }).map(element => element.textContent || element.getAttribute('aria-label') || element.tagName);
    return {
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      panel: rect('.proc-panel'), toolbar: rect('.proc-toolbar'), main: rect('.sqp-main'),
      left: rect('.sqp-left'), right: rect('.sqp-right'), overflowing,
    };
  });
  if (layout.documentWidth > layout.viewport + 1 || layout.overflowing.length) throw new Error(`${label}: horizontal overflow ${JSON.stringify(layout)}`);
  for (const key of ['panel', 'toolbar', 'main', 'left', 'right']) {
    const box = layout[key];
    if (box && (box.left < -1 || box.right > layout.viewport + 1 || box.width < 1)) throw new Error(`${label}: ${key} outside viewport ${JSON.stringify(box)}`);
  }
}

const server = await ensureServer();
const browser = await chromium.launch({ executablePath: EXE });
try {
  for (const theme of ['ayu-dark', 'ayu-light']) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
    page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error('CONSOLE ERROR', message.text()); } });
    page.on('requestfailed', request => console.error('REQUEST FAILED', request.url(), request.failure()?.errorText));
    page.on('response', response => { if (response.status() >= 400) console.error('HTTP ERROR', response.status(), response.url()); });
    await page.addInitScript(installMock, mockFor('mysql'));
    await page.addInitScript(queryLabMock);
    await page.addInitScript(theme => localStorage.setItem('dbgui:theme', theme), theme);
    await runFlow(page);
    await page.locator('section[aria-label="Benchmark timing evidence"]').scrollIntoViewIfNeeded();
    await checkLayout(page, `${theme}/1600`);
    await page.screenshot({ path: `${OUT}/query-lab-${theme}-1600.png`, fullPage: true });
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.waitForTimeout(150);
    await checkLayout(page, `${theme}/1100`);
    await page.screenshot({ path: `${OUT}/query-lab-${theme}-1100.png`, fullPage: true });
    if (errors.length) throw new Error(`${theme}: browser errors ${errors.join(' | ')}`);
    await page.close();
    console.log(`PASS ${theme} — long SQL, report export, 1600×1000 + 1100×760`);
  }
  console.log(`QUERY LAB UI OK — both themes and compact layouts; screenshots ${OUT}`);
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}
