// Site redesign verification shots → dev/site-shots/ (verification artifacts, not docs/).
// Serves nothing itself — expects `python3 -m http.server 8901 --directory site` running.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/'
     + 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:8901/';
const OUT = 'dev/site-shots';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE });

async function shoot(page, name, opts = {}) {
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  console.log('shot', name);
}

// ── desktop 1600×1000 ──
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await shoot(page, 'hero-desktop');

// install
await page.locator('#install').scrollIntoViewIfNeeded();
await page.waitForTimeout(700);
await shoot(page, 'install-desktop');

// engines — default tab
await page.locator('#engines').scrollIntoViewIfNeeded();
await page.waitForTimeout(700);
await shoot(page, 'engines-desktop');

// engines — second tab
await page.locator('#etab-scoped').click();
await page.waitForTimeout(300);
await shoot(page, 'engines-tab-scoped');

// screenshots — default tab
await page.locator('#screenshots').scrollIntoViewIfNeeded();
await page.waitForTimeout(700);
await shoot(page, 'shots-tab1-desktop');

// screenshots — DBA tab, second frame
await page.locator('#stab-dba').click();
await page.waitForTimeout(300);
await page.locator('#spane-dba .sv-next').click();
await page.waitForTimeout(300);
await shoot(page, 'shots-tab2-desktop');

// full page
await shoot(page, 'full-desktop', { fullPage: true });

await page.close();

// ── mobile 390×844 ──
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: 'networkidle' });
await mob.waitForTimeout(800);
await shoot(mob, 'hero-mobile');
await mob.locator('#install').scrollIntoViewIfNeeded();
await mob.waitForTimeout(600);
await shoot(mob, 'install-mobile');
await mob.locator('#screenshots').scrollIntoViewIfNeeded();
await mob.waitForTimeout(600);
await shoot(mob, 'shots-mobile');
await mob.locator('#stab-replay').click();
await mob.waitForTimeout(400);
await shoot(mob, 'shots-mobile-replay');
await shoot(mob, 'full-mobile', { fullPage: true });
await mob.close();

await browser.close();
console.log('done');
