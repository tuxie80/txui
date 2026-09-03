// FastGrid fast-scroll repro/benchmark harness. NOT part of the docs pipeline.
//
// Usage: start the shots dev server in another shell —
//   node node_modules/vite/bin/vite.js --config dev/vite.shots.config.ts
// then:  node dev/grid-scroll-repro.mjs            # Chromium (default)
//        BROWSER=webkit node dev/grid-scroll-repro.mjs
//        BROWSER=webkit VIDEO=1 node dev/grid-scroll-repro.mjs   # + presented-
//        frame video → per-frame blank fraction (needs ffmpeg from the
//        Playwright cache and python3+PIL for pixel stats)
//
// Boots the real frontend (shots Vite server on :5273 + Tauri mock), injects a
// 100k-row result, drives violent scrolling (wheel bursts, instant scrollTop
// jumps, thumb drags), and records per frame: DOM window coverage of the
// viewport (JS window-calc health), scroll→commit latency (React work per
// commit), rAF gaps (main-thread health) and long tasks.
//
// Caveats learned while hunting the fast-scroll blank (see 0.64.x changelog):
// - Runs HEADED on purpose: headless Chromium rasters in software and inflates
//   frame costs far beyond what a real GPU-backed webview shows.
// - This is a Vite DEV build — React dev mode is ~2-3x slower than the
//   shipped production bundle, so absolute commit latencies read high.
// - page.screenshot() forces a fresh BeginFrame and therefore CANNOT capture
//   the transient compositor-ahead blank the user sees; trust the DOM-coverage
//   and commit-latency numbers, not mid-gesture screenshots. The VIDEO mode
//   below records the screencast (presented frames), which DOES show blank
//   presented frames if the rasterizer falls behind.
// - "BLANK-IN-DOM" frames read slightly pessimistic when commits are
//   rAF-coalesced: the probe's rAF can run before the grid's commit rAF within
//   the same frame; paint happens after both. The "verify" probe (rAF chained
//   via microtask after the scroll dispatch) measures post-commit/pre-paint.
//
// WebKit findings (Playwright WebKit 26.5, headed, 2x retina, 100k×8 result):
// - DOM coverage and post-commit/pre-paint verify were 100% in EVERY gesture
//   while the presented video frames were blank 67% of the time during
//   gestures — the blank is raster lag (checkerboarding), not JS.
// - Per-gesture presented-frame blank rate, BEFORE the paint-layer fix:
//   wheel 2400px/10ms 96%, instant jumps 0%, thumb drag 0%, wheel 900px/16ms
//   87%. AFTER (no per-row `contain`, gutter overlay instead of per-row
//   sticky): 80% / 0% / 0% / 17%.
// - Ablations that moved the needle, isolated: per-row `contain: layout paint`
//   removal (87→29% on the sustained flick) and per-row sticky row-number
//   removal (87→15%). Zebra/borders/backgrounds were marginal. The extreme
//   240k px/s flick stays raster-bound (~80%) in every configuration — that
//   is 4.5 fresh viewports of text per frame at 2x; no webview rasterizes
//   that. Native tools cap effective scroll speed by painting synchronously.
// - SCALE=1 (non-retina) roughly halves the blank rate: raster cost is pixel
//   volume, i.e. glyph painting, not layout.
// - Chromium screencast frames arrive with visible queuing delay — gesture
//   windows do not align with the marker, so Chromium VIDEO numbers are not
//   trustworthy. Use its DOM probes; use WebKit for presented-frame truth.
import { chromium, webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mockFor, installMock } from './doc-fixtures.mjs';

const BROWSER = process.env.BROWSER ?? 'chromium';
const VIDEO = !!process.env.VIDEO;
const EXE = '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const FFMPEG = '/Users/j/Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac';
const BASE = 'http://localhost:5273/';
const NROWS = 100_000;

const browser = BROWSER === 'webkit'
  ? await webkit.launch({ headless: false })
  : await chromium.launch({ executablePath: EXE, headless: false });
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: Number(process.env.SCALE ?? 2),
  ...(VIDEO ? { recordVideo: { dir: `/tmp/grid-video-${BROWSER}`, size: { width: 1600, height: 1000 } } } : {}),
});
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.addInitScript(installMock, mockFor('mysql'));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.conn-item', { timeout: 12000 });

// Override execute_query with a 100k-row fabricator (in-page so nothing huge
// crosses the init-script JSON boundary).
await page.evaluate((n) => {
  const cols = [
    { name: 'id', type_name: 'bigint', nullable: false },
    { name: 'customer', type_name: 'varchar(120)', nullable: false },
    { name: 'status', type_name: 'varchar(16)', nullable: false },
    { name: 'total', type_name: 'decimal(10,2)', nullable: false },
    { name: 'currency', type_name: 'char(3)', nullable: false },
    { name: 'channel', type_name: 'varchar(24)', nullable: true },
    { name: 'note', type_name: 'varchar(200)', nullable: true },
    { name: 'created_at', type_name: 'timestamp', nullable: true },
  ];
  const statuses = ['shipped', 'pending', 'refunded', 'cancelled'];
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push([
      10000 + i, `Customer ${i} of some length`, statuses[i % 4],
      (i % 999) + '.99', 'EUR', i % 2 ? 'web' : 'mobile',
      `A reasonably long note value for row ${i} to give cells some width`,
      '2026-08-18 09:12:03',
    ]);
  }
  window.__MOCK__.execute_query = () => ({
    columns: cols, rows, rows_affected: null, execution_ms: 4.2, fetch_ms: 1.1, warnings: [],
  });
}, NROWS);

// Open the workspace and run a query.
const header = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: 'prod-orders' }) }).first();
await header.dblclick();
await page.waitForSelector('.cm-content', { timeout: 8000 });
await page.locator('.cm-content').first().click();
await page.keyboard.type('select * from big_table');
await page.keyboard.press('Meta+Enter');
await page.waitForSelector('.fg-scroll .fg-row', { timeout: 20000 });
await page.waitForTimeout(500);

// Grid geometry + instrument.
const geo = await page.evaluate(() => {
  const sc = document.querySelector('.fg-scroll');
  const r0 = sc.querySelector('.fg-row');
  const rowH = parseFloat(r0.style.height);
  const content = sc.querySelector('.fg-content');
  const totalH = content.getBoundingClientRect().height;
  // Per-frame probe: scroll position vs DOM coverage.
  window.__probe = { frames: [], scrollEvents: [], commits: [], longtasks: [] };
  let pendingScrollT = 0;
  const mo = new MutationObserver(() => {
    window.__probe.commits.push({ t: performance.now(), sinceScroll: pendingScrollT ? performance.now() - pendingScrollT : -1 });
    pendingScrollT = 0;
  });
  mo.observe(content, { childList: true, subtree: false });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__probe.longtasks.push({ t: e.startTime, dur: e.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  sc.addEventListener('scroll', () => {
    pendingScrollT = performance.now();
    window.__probe.scrollEvents.push({ t: pendingScrollT, top: sc.scrollTop });
  }, { passive: true });
  // Late-verify: the rAF is chained via microtask, so it is registered after
  // React's root listener ran (and after the grid's commit rAF) — it lands
  // post-commit / pre-paint in the same frame. If the DOM covers the
  // event-time scrollTop HERE, the commit made this frame's paint and any
  // "blank" seen by the standing rAF probe is an ordering artifact.
  window.__probe.verify = [];
  sc.addEventListener('scroll', () => {
    const topAtEvent = sc.scrollTop;
    queueMicrotask(() => requestAnimationFrame(() => {
      const rows = sc.querySelectorAll('.fg-row');
      let minTop = Infinity, maxTop = -Infinity;
      for (const r of rows) {
        const t = parseFloat(r.style.top);
        if (t < minTop) minTop = t;
        const b = t + parseFloat(r.style.height);
        if (b > maxTop) maxTop = b;
      }
      const vpBot = topAtEvent + sc.clientHeight;
      window.__probe.verify.push({
        topAtEvent, minTop, maxTop,
        covered: rows.length > 0 && minTop <= topAtEvent + 60 && maxTop >= vpBot,
      });
    }));
  }, { passive: true });
  let lastT = 0;
  const sample = () => {
    const now = performance.now();
    const rows = sc.querySelectorAll('.fg-row');
    let minTop = Infinity, maxTop = -Infinity;
    for (const r of rows) {
      const t = parseFloat(r.style.top);
      if (t < minTop) minTop = t;
      const b = t + parseFloat(r.style.height);
      if (b > maxTop) maxTop = b;
    }
    const vpTop = sc.scrollTop, vpBot = vpTop + sc.clientHeight;
    window.__probe.frames.push({
      t: now, gap: lastT ? now - lastT : 0, scrollTop: vpTop,
      nRowsDom: rows.length, minTop, maxTop,
      covered: rows.length > 0 && minTop <= vpTop + 60 && maxTop >= vpBot,
    });
    lastT = now;
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  return { rowH, totalH, clientH: sc.clientHeight, scrollH: sc.scrollHeight, nRowsDom: sc.querySelectorAll('.fg-row').length };
});
console.log(`BROWSER=${BROWSER} VIDEO=${VIDEO ? 'on' : 'off'} SCALE=${process.env.SCALE ?? 2}`);
console.log('GRID GEOMETRY:', JSON.stringify(geo));
console.log(`  totalH ${geo.totalH}px vs 2^24 limit ${2 ** 24}px → ${(geo.totalH / 2 ** 24 * 100).toFixed(1)}% of limit`);

async function harvest(label) {
  const data = await page.evaluate(() => {
    const p = window.__probe;
    const out = { frames: p.frames, scrollEvents: p.scrollEvents, commits: p.commits, longtasks: p.longtasks, verify: p.verify };
    p.frames = []; p.scrollEvents = []; p.commits = []; p.longtasks = []; p.verify = [];
    return out;
  });
  const f = data.frames;
  const blank = f.filter(x => !x.covered);
  const slow = f.filter(x => x.gap > 40);
  const gaps = f.map(x => x.gap).filter(g => g > 0).sort((a, b) => a - b);
  const p50 = gaps[Math.floor(gaps.length * 0.5)] ?? 0;
  const p95 = gaps[Math.floor(gaps.length * 0.95)] ?? 0;
  const max = gaps[gaps.length - 1] ?? 0;
  const clat = data.commits.map(c => c.sinceScroll).filter(x => x >= 0).sort((a, b) => a - b);
  const lt = data.longtasks.reduce((s, t) => s + t.dur, 0);
  console.log(`\n== ${label}: ${f.length} frames, ${data.scrollEvents.length} scroll events, ${data.commits.length} content mutations`);
  console.log(`   BLANK-IN-DOM frames: ${blank.length} (${(blank.length / Math.max(1, f.length) * 100).toFixed(1)}%)`);
  console.log(`   frame gap ms: p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} max=${max.toFixed(1)}; >40ms frames: ${slow.length}`);
  console.log(`   commit latency (scroll→DOM mutation) ms: n=${clat.length} p50=${(clat[Math.floor(clat.length*0.5)] ?? 0).toFixed(1)} p95=${(clat[Math.floor(clat.length*0.95)] ?? 0).toFixed(1)} max=${(clat[clat.length-1] ?? 0).toFixed(1)}`);
  console.log(`   longtask total: ${lt.toFixed(0)}ms in ${data.longtasks.length} tasks`);
  if (data.verify?.length) {
    const un = data.verify.filter(v => !v.covered);
    console.log(`   post-commit/pre-paint verify: ${data.verify.length - un.length}/${data.verify.length} covered`);
    for (const v of un.slice(0, 5)) console.log(`     UNCOVERED at paint: top=${v.topAtEvent} dom=[${v.minTop},${v.maxTop}]`);
  }
  if (blank.length) {
    for (const b of blank.slice(0, 8)) {
      console.log(`   blank frame: top=${b.scrollTop.toFixed(0)} domRows=${b.nRowsDom} domRange=[${b.minTop.toFixed(0)},${b.maxTop.toFixed(0)}] gap=${b.gap.toFixed(1)}ms`);
    }
  }
  return { frames: f.length, blank: blank.length, p95, max };
}


// Bright green marker, visible only while a gesture runs, placed OUTSIDE the
// sampled band (x<17%, y<47%). The blankness script uses it to restrict the
// measurement to gesture-active presented frames.
async function mark(on) {
  await page.evaluate((on2) => {
    let m = document.getElementById('__marker');
    if (!m) {
      m = document.createElement('div');
      m.id = '__marker';
      Object.assign(m.style, { position: 'fixed', left: '60px', top: '420px',
        width: '34px', height: '34px', background: '#00ff00', zIndex: 99999 });
      document.body.appendChild(m);
    }
    m.style.display = on2 ? 'block' : 'none';
  }, on);
}

// CSS inject for paint-cost ablations: CSS_INJECT='name' applies a preset.
const CSS_PRESETS = {
  'no-row-contain': '.fg-row { contain: none !important; }',
  'no-sticky-rownum': '.fg-rownum { position: static !important; }',
  'no-rc-no-sticky': '.fg-row { contain: none !important; } .fg-rownum { position: static !important; }',
  'no-contain': '.fg-row { contain: none !important; } .fg-scroll { contain: none !important; }',
  'no-zebra': '.fg-odd { background: none !important; }',
  'minimal': '.fg-row { contain: none !important; } .fg-scroll { contain: none !important; } .fg-odd { background: none !important; } .fg-cell { border-right: none !important; } .fg-rownum { background: none !important; border-right: none !important; }',
};
if (process.env.CSS_INJECT && CSS_PRESETS[process.env.CSS_INJECT]) {
  await page.evaluate((css) => {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }, CSS_PRESETS[process.env.CSS_INJECT]);
  console.log('CSS_INJECT:', process.env.CSS_INJECT);
}

// Warm-up: calm state.
await page.waitForTimeout(1000);
await harvest('baseline (idle)');

// ── Gesture A: lightning wheel — 40 huge deltas, ~10ms apart ──
{
  await mark(true);
  const box = await page.locator('.fg-scroll').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(10);
  }
  await mark(false);
  await page.waitForTimeout(400);
  await harvest('A: 40x wheel(2400) @10ms');
}

// ── Gesture B: instant top→bottom→middle scrollTop jumps ──
{
  await mark(true);
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      const sc = document.querySelector('.fg-scroll');
      sc.scrollTop = sc.scrollHeight - sc.clientHeight;
    });
    await page.waitForTimeout(60);
    await page.evaluate(() => { document.querySelector('.fg-scroll').scrollTop = 0; });
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => {
    const sc = document.querySelector('.fg-scroll');
    sc.scrollTop = sc.scrollHeight / 2;
  });
  await mark(false);
  await page.waitForTimeout(400);
  await harvest('B: instant scrollTop jumps');
}

// ── Gesture C: scrollbar thumb drag, fast ──
{
  await mark(true);
  const box = await page.locator('.fg-scroll').boundingBox();
  const sx = box.x + box.width - 6; // scrollbar lane
  await page.mouse.move(sx, box.y + 60);
  await page.mouse.down();
  for (let i = 0; i < 25; i++) {
    await page.mouse.move(sx, box.y + 60 + (box.height - 120) * (i / 24), { steps: 1 });
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await mark(false);
  await page.waitForTimeout(400);
  await harvest('C: thumb drag down');
}

// ── Gesture D: sustained medium flicking (the "never blinks in DBeaver" case) ──
{
  await mark(true);
  const box = await page.locator('.fg-scroll').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(16);
  }
  await mark(false);
  await page.waitForTimeout(400);
  await harvest('D: 60x wheel(900) @16ms');
}

if (VIDEO) {
  // Flush the recording, then measure the presented-frame blank fraction:
  // extract every frame and count non-background pixels in the grid's center
  // band. A presented-but-unrasterized frame reads ~0% (solid --bg); a painted
  // grid reads ~8-10% (text/borders over the dark background).
  const video = page.video();
  await page.close();
  const vpath = await video.path();
  console.log(`\nvideo: ${vpath}`);
  const framesDir = `/tmp/grid-frames-${BROWSER}`;
  execFileSync('rm', ['-rf', framesDir]);
  execFileSync('mkdir', ['-p', framesDir]);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', vpath, `${framesDir}/f%05d.png`]);
  console.log(`frames extracted to ${framesDir} — run pixel stats:\n  python3 dev/grid-video-blankness.py ${framesDir}`);
}

await browser.close();
