// Site redesign v2 verification shots → dev/site-shots-v2/ (verification artifacts, not docs/).
// Serves nothing itself — expects `python3 -m http.server 8901 --directory site` running.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/'
     + 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:8901/';
const OUT = 'dev/site-shots-v2';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE });

async function shoot(page, name, opts = {}) {
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  console.log('shot', name);
}

// ── desktop 1600×1000 ──
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
// headless renders frames lazily, which freezes the .reveal CSS transitions
// mid-start — force the end state so shots show what a real browser shows
await page.addStyleTag({ content: '.reveal{opacity:1!important;transform:none!important;transition:none!important}' });
await page.waitForTimeout(900);
await shoot(page, 'hero-desktop');

// mouse-reactive dots: hover the hero glyph, let particles displace
await page.mouse.move(1250, 250);
await page.waitForTimeout(120);
await page.mouse.move(1300, 280, { steps: 6 });
await page.waitForTimeout(400);
await shoot(page, 'hero-desktop-mouse');
await page.mouse.move(200, 900);

// install
await page.locator('#install').scrollIntoViewIfNeeded();
await page.waitForTimeout(700);
await shoot(page, 'install-desktop');

// engines — default tab
await page.locator('#engines').scrollIntoViewIfNeeded();
await page.waitForTimeout(700);
await shoot(page, 'engines-desktop');

// engines — scoped tab
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

// mid-page glass-over-dots proof: features + docs
for (const id of ['features', 'docs', 'safety']) {
  await page.locator('#' + id).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shoot(page, `section-${id}`);
}

// full page (single tall viewport — fullPage stitching is unreliable on this page)
const H = await page.evaluate(() => document.documentElement.scrollHeight);
await page.setViewportSize({ width: 1600, height: Math.min(H, 8000) });
await page.waitForTimeout(600);
await shoot(page, 'full-desktop');

await page.close();

// ── mobile 390×844 ──
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: 'networkidle' });
await mob.addStyleTag({ content: '.reveal{opacity:1!important;transform:none!important;transition:none!important}' });
await mob.waitForTimeout(800);
await shoot(mob, 'hero-mobile');
await mob.locator('#install').scrollIntoViewIfNeeded();
await mob.waitForTimeout(600);
await shoot(mob, 'install-mobile');
await mob.locator('#engines').scrollIntoViewIfNeeded();
await mob.waitForTimeout(600);
await shoot(mob, 'engines-mobile');
await mob.locator('#screenshots').scrollIntoViewIfNeeded();
await mob.waitForTimeout(600);
await shoot(mob, 'shots-mobile');
await mob.locator('#stab-replay').click();
await mob.waitForTimeout(400);
await shoot(mob, 'shots-mobile-replay');
await mob.close();

// ── reduced motion: static field must still render ──
const rm = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
await rm.goto(BASE, { waitUntil: 'networkidle' });
await rm.waitForTimeout(600);
await shoot(rm, 'hero-reduced-motion');
await rm.close();

await browser.close();
console.log('done');
