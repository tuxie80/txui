// CSP render check — the headless answer to "does the production CSP white-
// screen the app?" without needing screen-recording permission on the host.
//
//   node dev/csp_check.mjs
//
// 1. Builds the real frontend in production mode with @tauri-apps/* aliased
//    to the docs mock (dev/vite.csp.config.ts → dev/.csp-dist/).
// 2. Serves it statically with the EXACT `app.security.csp` string from
//    src-tauri/tauri.conf.json as a response header on every response — the
//    same mechanism Tauri uses on its custom protocol.
// 3. Boots it in headless Chromium, opens a connection workspace (forcing the
//    lazy panel chunks to load), and fails on ANY of:
//      - a `securitypolicyviolation` event,
//      - a console error or pageerror,
//      - a failed request,
//      - the app shell not rendering (`.conn-item` never appears).
//
// Exits non-zero on failure. Screenshot at dev/.csp-check.png for eyeballing.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { mockFor, installMock } from './doc-fixtures.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dev/.csp-dist');
const SHOT = join(ROOT, 'dev/.csp-check.png');
const EXE = '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json',
  '.map': 'application/json',
};

function fail(msg) {
  console.error(`✗ CSP check FAILED: ${msg}`);
  process.exit(1);
}

// 1 — production build with the mock aliases.
console.log('1/3  Building production bundle with mock IPC (dev/vite.csp.config.ts)…');
execFileSync('node', ['node_modules/vite/bin/vite.js', 'build', '--config', 'dev/vite.csp.config.ts'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
if (!existsSync(join(DIST, 'index.html'))) fail('build produced no index.html');

// 2 — serve with the production CSP from tauri.conf.json on every response.
const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
const CSP = conf.app?.security?.csp;
if (!CSP) fail('no app.security.csp in tauri.conf.json');
console.log(`2/3  Serving dev/.csp-dist with CSP: ${CSP.slice(0, 60)}…`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!path.startsWith(DIST) || !existsSync(path)) path = join(DIST, 'index.html');
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'content-security-policy': CSP,
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404); res.end(String(e));
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// 3 — boot in Chromium, watch every channel a CSP break would surface on.
console.log('3/3  Booting the app in headless Chromium…');
const launchOpts = existsSync(EXE) ? { executablePath: EXE } : {};
const browser = await chromium.launch(launchOpts);
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const violations = [], consoleErrors = [], pageErrors = [], failedReqs = [];
  await page.addInitScript(() => {
    window.__CSP_VIOLATIONS__ = [];
    document.addEventListener('securitypolicyviolation', e => {
      window.__CSP_VIOLATIONS__.push(
        `${e.effectiveDirective}: blocked ${e.blockedURI || 'inline'} (${e.disposition})`);
    });
  });
  await page.addInitScript(installMock, mockFor('mysql'));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('requestfailed', r => failedReqs.push(`${r.url()} — ${r.failure()?.errorText}`));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  try {
    await page.waitForSelector('.conn-item', { timeout: 15000 });
  } catch {
    await page.screenshot({ path: SHOT });
    fail(`app shell never rendered (no .conn-item in 15 s) — screenshot at ${SHOT}\n` +
      `  pageerrors: ${pageErrors.join(' | ') || 'none'}\n` +
      `  console: ${consoleErrors.join(' | ') || 'none'}`);
  }

  // Open a connection workspace: forces the lazy panel/editor chunks through
  // the CSP as dynamic imports.
  const header = page.locator('.conn-item-header',
    { has: page.locator('.conn-name', { hasText: 'prod-orders' }) }).first();
  await header.scrollIntoViewIfNeeded();
  await header.dblclick();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: SHOT });

  violations.push(...await page.evaluate(() => window.__CSP_VIOLATIONS__));

  const problems = [];
  if (violations.length) problems.push(`CSP violations:\n    ${violations.join('\n    ')}`);
  if (pageErrors.length) problems.push(`page errors:\n    ${pageErrors.join('\n    ')}`);
  if (consoleErrors.length) problems.push(`console errors:\n    ${consoleErrors.join('\n    ')}`);
  if (failedReqs.length) problems.push(`failed requests:\n    ${failedReqs.join('\n    ')}`);

  const rootHtml = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0);
  if (rootHtml < 500) problems.push(`#root is nearly empty (${rootHtml} chars) — white screen`);

  if (problems.length) fail(`\n  ${problems.join('\n  ')}`);
  console.log(`\n✓ CSP check PASSED — shell + workspace rendered under the production CSP`);
  console.log(`  #root: ${rootHtml} chars, 0 violations, 0 console errors, 0 failed requests`);
  console.log(`  screenshot: ${SHOT}`);
} finally {
  await browser.close();
  server.close();
}
