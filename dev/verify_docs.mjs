import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const EXE = '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const url = pathToFileURL(process.cwd() + '/docs/index.html').href;
const b = await chromium.launch({ executablePath: EXE });
const p = await b.newPage({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
await p.screenshot({ path: 'docs/shots/_doc_overview.png' });
// jump to shortcuts, screenshot
await p.evaluate(() => document.getElementById('shortcuts').scrollIntoView());
await p.waitForTimeout(400);
await p.screenshot({ path: 'docs/shots/_doc_shortcuts.png' });
// toggle to Windows and confirm a kbd shows Ctrl
await p.click('#osToggle button[data-os="win"]');
await p.waitForTimeout(300);
const winKbd = await p.locator('#scTable .kbd .os-win').first().textContent();
const macHidden = await p.locator('#scTable .kbd .os-mac').first().isVisible();
// coverage matrix
await p.click('#osToggle button[data-os="mac"]');
await p.evaluate(() => document.getElementById('coverage').scrollIntoView());
await p.waitForTimeout(400);
await p.screenshot({ path: 'docs/shots/_doc_coverage.png' });
// global search test
await p.fill('#globalSearch', 'wait events');
await p.waitForTimeout(300);
const visSections = await p.locator('.doc-section:not([hidden])').count();
console.log('pageerrors:', errs.length ? errs.slice(0,3) : 'none');
console.log('win kbd sample:', JSON.stringify(winKbd), '| mac span hidden in win mode:', !macHidden);
console.log('sections visible after search "wait events":', visSections);
await b.close();
