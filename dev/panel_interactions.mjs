// Real-Chromium interaction sweep for every plugins-menu panel. The backend is
// entirely mocked: no database write, external process, native dialog or saved
// connection is possible. Each visible enabled control is exercised from a
// freshly reopened panel and must produce an observable effect.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mockFor, installMock } from './doc-fixtures.mjs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5273/';
const OUT = process.env.TXUI_PANEL_OUT;
const ONLY = process.env.TXUI_PANEL_ONLY?.toLowerCase();
const ENGINE_ONLY = process.env.TXUI_PANEL_ENGINES?.split(',').map(value => value.trim());
const ENGINES = [
  { conn: 'prod-orders', eng: 'mysql' },
  { conn: 'analytics', eng: 'postgres' },
  { conn: 'warehouse', eng: 'clickhouse' },
  { conn: 'app.db', eng: 'sqlite' },
  { conn: 'events.parquet', eng: 'parquet' },
  { conn: 'scratch.duckdb', eng: 'duckdb' },
  { conn: 'documents', eng: 'mongodb' },
  { conn: 'sqlserver', eng: 'sqlserver' },
  { conn: 'cache', eng: 'redis' },
].filter(engine => !ENGINE_ONLY || ENGINE_ONLY.includes(engine.eng));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (OUT) mkdirSync(OUT, { recursive: true });

async function ensureServer() {
  try {
    const response = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
    if (response.ok) return null;
  } catch { /* start below */ }
  const child = spawn('node', ['node_modules/vite/bin/vite.js', '--config', 'dev/vite.shots.config.ts'], {
    detached: true, stdio: 'ignore',
  });
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

async function controls(page, rootSelector) {
  return page.locator(rootSelector).first().evaluate(root => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const controls = [...root.querySelectorAll('button, input, select, textarea, [role="button"]')]
      .filter(element => visible(element)
        && !element.disabled
        && element.getAttribute('aria-disabled') !== 'true'
        && !element.readOnly
        && !element.closest('.unavail')
        && !['hidden', 'file'].includes(element.type))
      .map((element, index) => ({
        index,
        tag: element.tagName.toLowerCase(),
        type: element.type ?? '',
        label: (element.getAttribute('aria-label') || element.textContent || element.title
          || element.placeholder || element.name || element.id || element.tagName).trim().replace(/\s+/g, ' ').slice(0, 100),
      }));
    return controls.map((control, index) => ({
      ...control,
      ordinal: controls.slice(0, index).filter(candidate => candidate.tag === control.tag
        && candidate.type === control.type && candidate.label === control.label).length,
    }));
  });
}

async function effectSnapshot(page, rootSelector) {
  return page.evaluate(selector => ({
    calls: window.__CALLS__?.length ?? 0,
    body: document.body.innerHTML,
    rootConnected: [...document.querySelectorAll(selector.replace(':visible', ''))]
      .some(element => getComputedStyle(element).display !== 'none'),
  }), rootSelector);
}

function valueFor(control, current) {
  if (control.type === 'number' || control.type === 'range') {
    const number = Number(current);
    return Number.isFinite(number) ? String(number + 1) : '1';
  }
  if (control.type === 'date') return '2026-02-03';
  if (control.type === 'datetime-local') return '2026-02-03T04:05';
  if (control.type === 'time') return '04:05';
  if (control.type === 'email') return 'smoke@example.test';
  if (control.type === 'url') return 'https://example.test/';
  if (control.type === 'password') return 'Smoke-password-123';
  return 'smoke-value';
}

const browser = await chromium.launch({ executablePath: EXE });
const server = await ensureServer();
const totals = { panels: 0, buttons: 0, fields: 0, selects: 0, effects: 0, skipped: 0, failures: 0 };
const failures = [];

function fail(engine, panel, control, reason) {
  totals.failures++;
  failures.push(`${engine} / ${panel} / ${control}: ${reason}`);
}

async function exerciseControl(page, engine, _group, label, control, rootSelector, showPanel, hidePanel) {
  await showPanel();
  await page.evaluate(() => {
    document.querySelectorAll('[data-txui-smoke-target]').forEach(element => element.removeAttribute('data-txui-smoke-target'));
  });
  const root = page.locator(rootSelector).first();
  await root.evaluate((element, desired) => {
    const visible = candidate => {
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const eligible = [...element.querySelectorAll('button, input, select, textarea, [role="button"]')]
      .filter(candidate => visible(candidate)
        && !candidate.disabled
        && candidate.getAttribute('aria-disabled') !== 'true'
        && !candidate.readOnly
        && !candidate.closest('.unavail')
        && !['hidden', 'file'].includes(candidate.type))
      .filter(candidate => candidate.tagName.toLowerCase() === desired.tag
        && (candidate.type ?? '') === desired.type
        && (candidate.getAttribute('aria-label') || candidate.textContent || candidate.title
          || candidate.placeholder || candidate.name || candidate.id || candidate.tagName)
          .trim().replace(/\s+/g, ' ').slice(0, 100) === desired.label);
    eligible[desired.ordinal]?.setAttribute('data-txui-smoke-target', 'true');
  }, control);
  const current = root.locator('[data-txui-smoke-target="true"]');
  if (!await current.count()) {
    fail(engine.eng, label, `#${control.index} ${control.label}`, 'control disappeared after reopening');
    return;
  }
  try {
    if (control.tag === 'select') {
      const multiple = await current.evaluate(element => element.multiple);
      const options = await current.locator('option:not([disabled])').evaluateAll(items => items.map(item => item.value));
      const selected = await current.locator('option').evaluateAll(items => items.filter(item => item.selected).map(item => item.value));
      const next = options.findLast(value => !selected.includes(value));
      if (next === undefined) {
        totals.skipped++;
        return;
      }
      totals.selects++;
      const before = await effectSnapshot(page, rootSelector);
      await current.selectOption(next);
      let retained;
      if (multiple) {
        const after = await current.locator('option').evaluateAll(items => items.filter(item => item.selected).map(item => item.value));
        retained = after.includes(next);
      } else {
        retained = await current.inputValue() === next;
      }
      if (!retained) {
        const after = await effectSnapshot(page, rootSelector);
        if (after.calls === before.calls && after.body === before.body) throw new Error('selected value did not change');
      }
      totals.effects++;
    } else if (control.tag === 'textarea' || control.tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(control.type)) {
      totals.fields++;
      const next = valueFor(control, await current.inputValue());
      await current.fill(next);
      const actual = await current.inputValue();
      if (actual !== next && !actual.includes(next)) throw new Error('edited value did not stick');
      totals.effects++;
    } else {
      const before = await effectSnapshot(page, rootSelector);
      if (control.type === 'checkbox' || control.type === 'radio') {
        totals.fields++;
        const checked = await current.isChecked();
        await current.click({ timeout: 3000 });
        if (control.type === 'checkbox' && await current.isChecked() === checked) throw new Error('checkbox state did not toggle');
        if (control.type === 'radio' && !await current.isChecked()) throw new Error('radio did not become selected');
        totals.effects++;
      } else {
        totals.buttons++;
        const alreadyActive = await current.evaluate(element => !!element.closest('.active, .selected, .pg-card-on, [aria-pressed="true"], [aria-selected="true"]'));
        await current.click({ timeout: 3000 });
        await page.waitForTimeout(60);
        const after = await effectSnapshot(page, rootSelector);
        const changed = after.calls > before.calls || after.body !== before.body || after.rootConnected !== before.rootConnected;
        const alreadyEmptySelection = control.label === 'none' && before.body.includes('0 selected');
        if (!changed && (alreadyActive || alreadyEmptySelection)) {
          totals.skipped++;
          return;
        }
        if (!changed) {
          fail(engine.eng, label, `#${control.index} ${control.label}`, 'click produced no invocation or DOM effect');
          return;
        }
        totals.effects++;
      }
    }
  } catch (error) {
    fail(engine.eng, label, `#${control.index} ${control.label}`, String(error?.message ?? error).slice(0, 240));
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await hidePanel();
  }
}

try {
  for (const engine of ENGINES) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(installMock, mockFor(engine.eng));
    await page.addInitScript(() => {
      const connection = (id, name, engine, host, port) => ({
        id, name, engine, host, port, group: 'Interaction', environment: 'dev', read_only: false,
      });
      window.__MOCK__.list_connections = [
        connection('c1', 'prod-orders (mysql)', 'mysql', '10.0.0.4', 3306),
        connection('c2', 'analytics (postgres)', 'postgres', '10.0.0.9', 5432),
        connection('c3', 'warehouse (clickhouse)', 'clickhouse', '10.0.0.20', 9000),
        connection('c4', 'cache (redis)', 'redis', '127.0.0.1', 6379),
        connection('c5', 'app.db (sqlite)', 'sqlite', null, null),
        connection('c6', 'events.parquet', 'parquet', null, null),
        connection('c7', 'scratch.duckdb', 'duckdb', null, null),
        connection('c8', 'documents', 'mongodb', '127.0.0.1', 27017),
        connection('c9', 'sqlserver', 'sqlserver', '127.0.0.1', 1433),
      ];
    });
    await page.addInitScript(() => {
      const record = (cmd, length) => {
        const calls = (window.__CALLS__ ??= []);
        calls.push({ cmd, args: { length } });
        if (calls.length > 5000) calls.splice(0, calls.length - 5000);
      };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async text => record('clipboard:writeText', String(text).length) },
      });
      const execCommand = document.execCommand?.bind(document);
      document.execCommand = (command, ...args) => {
        if (command === 'copy') record('dom:copy', 0);
        return execCommand ? execCommand(command, ...args) : true;
      };
      const clearRect = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        record('canvas:clearRect', 0);
        return clearRect.apply(this, args);
      };
    });
    const errors = [];
    let currentPanel = 'workspace';
    page.on('pageerror', error => errors.push(`pageerror: ${currentPanel}: ${error.message.slice(0, 200)}`));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(`console: ${currentPanel}: ${message.text().slice(0, 200)}`);
    });
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const header = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: engine.conn }) }).first();
      await header.scrollIntoViewIfNeeded();
      await header.dblclick();
      await page.waitForTimeout(1200);

      if (['redis', 'mongodb'].includes(engine.eng)) {
        const root = '.redis-browser';
        const initial = await controls(page, root);
        const reset = async () => {
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          });
          await page.goto(BASE, { waitUntil: 'domcontentloaded' });
          await header.dblclick({ timeout: 5000 });
          await page.waitForTimeout(900);
        };
        const browserLabel = engine.eng === 'redis' ? 'Redis browser' : 'MongoDB browser';
        for (const control of initial) {
          if (ONLY && !browserLabel.toLowerCase().includes(ONLY)) break;
          await exerciseControl(page, engine, null, browserLabel, control, root, async () => {}, reset);
        }
        totals.panels++;
        console.log(`OK  ${engine.eng} / ${browserLabel} — ${initial.length} controls inspected`);
      } else {
        await page.waitForSelector('.pmenu-title', { timeout: 8000 });
        const groups = await page.locator('.pmenu-title').allTextContents();
        for (const groupLabel of groups) {
          const group = groupLabel.replace('▾', '').trim();
          const menuList = () => page.locator('.pmenu', { has: page.locator('.pmenu-title', { hasText: group }) }).locator('.pmenu-list');
          const openMenu = async () => {
            if (!await menuList().count()) {
              await page.locator('.pmenu-title', { hasText: group }).first().click();
              await page.waitForTimeout(50);
            }
          };
          await openMenu();
          const items = menuList().locator('.pmenu-item');
          const labels = [];
          for (let index = 0; index < await items.count(); index++) {
            const item = items.nth(index);
            const label = (await item.locator('.pmenu-item-label').textContent())?.trim() ?? '';
            if (label && await item.getAttribute('aria-disabled') !== 'true') labels.push(label);
          }
          await page.keyboard.press('Escape');
          for (const label of labels) {
            if (ONLY && !label.toLowerCase().includes(ONLY)) continue;
            currentPanel = label;
            const menuItem = () => menuList().locator('.pmenu-item', { has: page.locator('.pmenu-item-label', { hasText: label }) }).first();
            const active = async () => await page.locator('.qtab-panel-wrap:visible').count() > 0;
            const showPanel = async () => {
              if (await active()) return;
              await openMenu();
              await menuItem().click({ timeout: 3000 });
              await page.locator('.qtab-panel-wrap:visible').first().waitFor({ state: 'visible', timeout: 5000 });
              await page.waitForTimeout(900);
            };
            const hidePanel = async () => {
              await page.evaluate(() => {
                localStorage.clear();
                sessionStorage.clear();
              });
              await page.goto(BASE, { waitUntil: 'domcontentloaded' });
              const freshHeader = page.locator('.conn-item-header', { has: page.locator('.conn-name', { hasText: engine.conn }) }).first();
              await freshHeader.dblclick({ timeout: 5000 });
              await page.waitForTimeout(700);
            };
            console.log(`OPEN ${engine.eng} / ${label}`);
            await showPanel();
            if (process.env.TXUI_PANEL_DEBUG) {
              console.log(await page.evaluate(() => ({
                tabs: [...document.querySelectorAll('.qtab')].map(tab => ({ text: tab.textContent, cls: tab.className })),
                wraps: [...document.querySelectorAll('.qtab-panel-wrap')].map(wrap => ({ display: wrap.style.display, text: wrap.textContent?.slice(0, 100) })),
                errors: document.body.textContent?.includes('Something broke'),
              })));
            }
            const root = '.qtab-panel-wrap:visible';
            const initial = await controls(page, root);
            totals.panels++;
            const failuresBefore = totals.failures;
            for (const control of initial) {
              await exerciseControl(page, engine, group, label, control, root, showPanel, hidePanel);
            }
            if (OUT) await page.screenshot({ path: `${OUT}/${engine.eng}-${label.replace(/[^a-z0-9]+/gi, '-')}.png` });
            console.log(`${totals.failures === failuresBefore ? 'OK' : 'FAIL'}  ${engine.eng} / ${label} — ${initial.length} controls inspected`);
            await hidePanel();
          }
        }
      }
      const relevantErrors = errors.filter(error => !/favicon|net::|404/.test(error));
      if (relevantErrors.length) {
        fail(engine.eng, 'browser', 'console', relevantErrors.slice(0, 5).join(' | '));
      }
    } catch (error) {
      fail(engine.eng, 'workspace', 'harness', String(error?.message ?? error).slice(0, 300));
      if (errors.length) fail(engine.eng, 'workspace', 'browser', errors.slice(0, 3).join(' | '));
      if (OUT) await page.screenshot({ path: `${OUT}/${engine.eng}-harness-failure.png` }).catch(() => {});
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}

console.log('\nPANEL INTERACTIONS SUMMARY');
console.log(`  Panels: ${totals.panels}; buttons: ${totals.buttons}; text/checkbox/radio fields: ${totals.fields}; selects: ${totals.selects}`);
console.log(`  Observable effects: ${totals.effects}; idempotent/single-option controls skipped: ${totals.skipped}; failures: ${totals.failures}`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
console.log(totals.failures ? 'PANEL INTERACTIONS FAILED' : 'PANEL INTERACTIONS OK');
process.exit(totals.failures ? 1 : 0);
