// Repro: 1.3.0 critical — after connecting (mysql), the editor is unusable.
// Boots the real frontend (vite shots server :5273 + Tauri mock, mysql engine),
// opens the workspace, then inspects the editor DOM and tries to type.
// Captures page errors, console errors, and DOM state at each step.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mockFor, installMock } from './doc-fixtures.mjs';

const EXE = '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5273/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureServer() {
  try {
    const r = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
    if (r.ok) { console.log('vite shots server already running'); return null; }
  } catch { /* spawn */ }
  console.log('starting vite shots server…');
  const child = spawn('node', ['node_modules/vite/bin/vite.js', '--config',
    'dev/vite.shots.config.ts'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return child;
    } catch { /* poll */ }
  }
  throw new Error('vite shots server did not come up');
}

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrs = [];
const consoleErrs = [];
page.on('pageerror', e => pageErrs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });

async function domState(tag) {
  const s = await page.evaluate(() => {
    const cm = document.querySelector('.cm-editor');
    const content = document.querySelector('.cm-content');
    const r = content?.getBoundingClientRect();
    return {
      cmEditor: !!cm,
      cmContentRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      contentEditable: content?.getAttribute('contenteditable') ?? null,
      cmLineCount: document.querySelectorAll('.cm-line').length,
      gutterText: [...document.querySelectorAll('.cm-gutterElement')].map(e => e.textContent).slice(0, 5),
      bodyTextLen: document.body.innerText.length,
      bodyTextHead: document.body.innerText.slice(0, 200),
      overlays: [...document.querySelectorAll('.modal-backdrop, .app-dialog-backdrop, [class*="overlay"], [class*="backdrop"]')]
        .filter(e => e.getBoundingClientRect().width > 0)
        .map(e => e.className),
    };
  });
  console.log(`\n[${tag}]`, JSON.stringify(s, null, 1));
}

try {
  await ensureServer();
  await page.addInitScript(installMock, mockFor('mysql'));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await sleep(1500);
  await domState('before connect');

  await page.waitForSelector('.conn-item', { timeout: 12000 });
  const header = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: 'prod-orders' }) }).first();
  await header.dblclick();
  await sleep(2500);
  await domState('after connect');

  // Try to click into the editor and type
  const cm = page.locator('.cm-content').first();
  if (await cm.count()) {
    await cm.click({ timeout: 3000 }).catch(e => console.log('CLICK FAILED:', String(e).slice(0, 200)));
    await page.keyboard.type('SELECT 1');
    await sleep(500);
    const text = await page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '(none)');
    console.log('\neditor text after typing:', JSON.stringify(text));
  } else {
    console.log('\nNO .cm-content FOUND');
  }
  await page.screenshot({ path: 'dev/editor-repro.png' });
  console.log('\nPAGE ERRORS:', pageErrs.length ? pageErrs : '(none)');
  console.log('CONSOLE ERRORS:', consoleErrs.length ? consoleErrs.slice(0, 10) : '(none)');
} finally {
  await browser.close();
}
