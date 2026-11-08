// Real-Chromium Refresh visual and interaction gate. Live database behavior is
// proven separately by dev/refresh_mixed_live.mjs and the Rust dbctl fixture.
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

function refreshMock() {
  const result = (columns, rows) => ({
    columns: columns.map(name => ({ name, type_name: 'text', nullable: true })),
    rows, rows_affected: null, execution_ms: 1, fetch_ms: 0, warnings: [], truncated: false,
  });
  const names = ['countries', 'customers', 'orders', 'events', 'audit_logs', 'notes'];
  const data = {
    countries: { columns: ['id'], rows: [[1], [2]], requested: [1, 2] },
    customers: { columns: ['id', 'email'], rows: [[1, 'older@example.test'], [2, 'second@example.test'], [3, 'third@example.test'], [4, 'newest@example.test']], requested: [4] },
    orders: { columns: ['id', 'customer_id'], rows: [[1, 4], [2, 4], [3, 1]], requested: [1, 2] },
    events: { columns: ['id', 'order_id'], rows: [[1, 3], [2, 3], [3, 1]], requested: [1, 2] },
    audit_logs: { columns: ['id'], rows: [[1], [2], [3], [4]], requested: [1, 2] },
    notes: { columns: ['id', 'country_id'], rows: [[1, 1], [2, 1], [3, 2]], requested: [1, 2] },
  };
  const rootRows = table => table.rows.filter(row => table.requested.includes(row[0]));
  const ids = sql => [...sql.matchAll(/\((\d+)\)/g)].map(match => Number(match[1]));
  const table = name => {
    const columns = [[name, 'id', 'int', 'int', 'NO', null, '', null, null, null, null, '']];
    const text = (column, type = 'varchar', length = 64) => [name, column, type, `${type}(${length})`, 'NO', null, '', 'utf8mb4', 'utf8mb4_0900_ai_ci', length, null, ''];
    const integer = column => [name, column, 'int', 'int', 'NO', null, '', null, null, null, null, ''];
    if (name === 'countries') columns.push(text('code', 'varchar', 20));
    if (name === 'customers') columns.push(text('email'), [name, 'created_at', 'datetime', 'datetime', 'NO', null, '', null, null, null, null, '']);
    if (name === 'orders') columns.push(integer('customer_id'), [name, 'created_at', 'datetime', 'datetime', 'NO', null, '', null, null, null, null, '']);
    if (name === 'events') columns.push(integer('order_id'), [name, 'created_at', 'datetime', 'datetime', 'NO', null, '', null, null, null, null, '']);
    if (name === 'audit_logs') columns.push(text('message', 'varchar', 80));
    if (name === 'notes') columns.push(integer('country_id'), integer('tenant_id'), text('body', 'varchar', 80));
    return columns;
  };
  const indexes = name => {
    const rows = [[name, 'PRIMARY', 0, 1, 'id', null, 0, 'BTREE']];
    if (name === 'customers') rows.push([name, 'uq_email', 0, 1, 'email', null, 0, 'BTREE']);
    if (name === 'orders') rows.push([name, 'idx_customer', 1, 1, 'customer_id', null, 0, 'BTREE']);
    if (name === 'events') rows.push([name, 'idx_order', 1, 1, 'order_id', null, 0, 'BTREE']);
    if (name === 'notes') rows.push([name, 'idx_country', 1, 1, 'country_id', null, 0, 'BTREE']);
    return rows;
  };
  const foreignKeys = [
    ['fk_order_customer', 'orders', 'customer_id', 'customers', 'id'],
    ['fk_event_order', 'events', 'order_id', 'orders', 'id'],
    ['fk_note_country', 'notes', 'country_id', 'countries', 'id'],
  ];
  const connection = (id, name, readOnly) => ({
    id, name, engine: 'mysql', host: '127.0.0.1', port: 3306,
    user: 'root', database: null, group: 'Visual', environment: 'dev', read_only: readOnly,
    color: null, auto_connect: false, tags: [], labels: [],
    prod_allow_ddl: true, prod_allow_unfiltered_write: false,
  });
  Object.assign(window.__MOCK__, {
    list_connections: [connection('c1', 'prod-orders', true), connection('c2', 'staging-refresh', false)],
    open_connection: args => `sess-${args.id}`,
    monitor_query: args => {
      const sql = String(args.sql ?? '');
      const schema = args.sessionId === 'sess-c2' ? 'stage' : 'shop';
      if (sql.includes('information_schema.SCHEMATA')) return result(
        ['server_charset', 'server_collation', 'server_version', 'schema_charset', 'schema_collation'],
        [['utf8mb4', 'utf8mb4_0900_ai_ci', '8.4.0', 'utf8mb4', 'utf8mb4_0900_ai_ci']]);
      if (sql.includes('mysql.innodb_table_stats')) return result(
        ['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'], names.map(name => [name, 0, 0, 0, null]));
      if (sql.includes('information_schema.TABLES')) return result(
        ['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT'],
        names.map(name => [name, 'InnoDB', 'utf8mb4_0900_ai_ci', null, '']));
      if (sql.includes('information_schema.COLUMNS')) return result(
        ['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'CHARACTER_MAXIMUM_LENGTH', 'GENERATION_EXPRESSION', 'COLUMN_COMMENT'],
        names.flatMap(table));
      if (sql.includes('information_schema.STATISTICS')) return result(
        ['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'], names.flatMap(indexes));
      if (sql.includes('KEY_COLUMN_USAGE')) return result(
        ['CONSTRAINT_NAME', 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_SCHEMA', 'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME', 'ORDINAL_POSITION', 'DELETE_RULE', 'UPDATE_RULE'],
        foreignKeys.map(([name, table, column, refTable, refColumn]) => [name, schema, table, column, schema, refTable, refColumn, 1, 'NO ACTION', 'NO ACTION']));
      const name = names.find(candidate => sql.includes(`\`${candidate}\``));
      if (name) {
        const current = data[name];
        if (sql.includes('__txui_refresh_membership')) {
          return result(['id'], rootRows(current).filter(row => ids(sql).includes(row[0])).map(row => [row[0]]));
        }
        if (sql.includes('__txui_refresh_selection')) return result(current.columns, rootRows(current));
        return result(current.columns, current.rows.filter(row => ids(sql).includes(row[0])));
      }
      return result([], []);
    },
    open: () => '/mock/mixed-refresh.json',
    refresh_spec_load: () => JSON.stringify({
      version: 1, engine: 'mysql',
      source: { connectionId: 'c1', sessionId: null }, target: { connectionId: 'c2', sessionId: null },
      schemaMappings: [{ source: 'shop', target: 'stage' }], seed: 'mixed-visual-seed',
      allowFkBreaking: false, acknowledgeUnmaskedSensitive: true,
      tables: [
        { table: 'countries', policy: 'full' },
        { table: 'customers', policy: 'row_limit', rows: 1, orderBy: ['created_at'], direction: 'desc', tieBreaker: ['id'], limitKind: 'soft' },
        { table: 'orders', policy: 'time_window', column: 'created_at', mode: 'rolling', amount: 7, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
        { table: 'events', policy: 'time_window', column: 'created_at', mode: 'rolling', amount: 1, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
        { table: 'audit_logs', policy: 'sample', rows: 2, sampleSeed: 42, tieBreaker: ['id'], limitKind: 'soft' },
        { table: 'notes', policy: 'predicate', where: 'tenant_id = 1' },
      ],
      masks: [{ table: 'customers', column: 'email', rule: 'hash' }],
      limits: { maxRowsPerChunk: 2, maxBytesPerChunk: 65536, planningKeyBatch: 10, maxPlanningKeys: 1000000 },
      verification: { exactCounts: true, foreignKeyOrphans: true, contentSha256: true },
    }),
    refresh_spec_save: null,
    refresh_mask_apply: () => ({ rows: [], accepted_rows: 1, masked_cells: 1, unique_keys: 1, elapsed_ms: 2 }),
    refresh_preflight: args => ({
      ok: true, preflight_sha256: 'f'.repeat(64),
      tables: args.input.tables.map(table => ({ ...table, empty: true })),
    }),
    refresh_execute: args => {
      const runKey = args.input.run_key;
      const expected = { countries: 2, customers: 2, orders: 3, events: 2, audit_logs: 2, notes: 2 };
      const tables = Object.entries(expected).map(([name, rows]) => ({
        table: `shop.${name}`, target: `stage.${name}`, selected_rows: rows, committed_rows: rows,
        target_rows: rows, count_status: 'verified', content_status: 'verified', content_sha256: 'c'.repeat(64),
        chunks_checked: 1, chunk_hashes: [{ chunk_index: 1, rows, outbound_sha256: 'a'.repeat(64), target_sha256: 'a'.repeat(64), matched: true }],
        chunk_hashes_omitted: 0,
      }));
      const verification = {
        status: 'verified', tables,
        foreign_keys: foreignKeys.map(([name, table, , parent]) => ({ name, child: `shop.${table}`, parent: `shop.${parent}`, status: 'verified', orphan_rows: 0 })),
        unverified_columns: [], comparable_content_sha256: 'd'.repeat(64),
      };
      const counts = {
        status: 'completed', requested_rows: 11, closure_rows: 2, planned_rows: 13,
        committed_rows: 13, rows_inserted: 13, in_flight_rows: 0, remaining_rows: 0,
        chunks_committed: 6, key_rows_read: 13, source_rows_read: 13, source_bytes_read: 4096,
        target_bytes_written: 8192, rows_per_second: 10, eta_seconds: null, elapsed_ms: 1300,
        source_backend_id: 41, target_backend_id: 42, verification,
      };
      args.onEvent.onmessage?.({ type: 'started', run_key: runKey, source_backend_id: 41, target_backend_id: 42 });
      args.onEvent.onmessage?.({ type: 'chunk', run_key: runKey, table: 'shop.notes', table_index: 6, table_count: 6,
        chunk_index: 6, outcome: 'committed', rows: 2, ...counts,
        current_key_range: { start_sha256: 'a'.repeat(64), end_sha256: 'b'.repeat(64) } });
      args.onEvent.onmessage?.({ type: 'done', run_key: runKey, table: 'shop.notes', table_index: 6, table_count: 6, error: null, ...counts });
      return counts;
    },
    refresh_cancel: () => null,
    save: () => '/mock/environment-refresh-report.md',
    write_text_file: null,
  });
}

async function openRefresh(page, afterReload = false) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dbgui:open-connection', { detail: { connectionId: 'c1' } })));
  await page.waitForTimeout(500);
  await page.locator('.query-tabs-container').first().waitFor({ timeout: 15000 });
  for (const id of ['c2', 'c1']) {
    await page.evaluate(connectionId => window.dispatchEvent(new CustomEvent('dbgui:open-connection', { detail: { connectionId } })), id);
    await page.waitForTimeout(400);
  }
  if (!afterReload) await page.evaluate(() => window.dispatchEvent(new CustomEvent('dbgui:toggle-panel', { detail: { panel: 'refresh' } })));
  try {
    await page.locator('.proc-title:visible, .mx-empty:visible').filter({ hasText: 'Safe Environment Refresh' }).first().waitFor({ timeout: 3000 });
  } catch (error) {
    console.error(await page.locator('body').innerText());
    console.error(await page.evaluate(() => window.__CALLS__.map(call => call.cmd)));
    await page.screenshot({ path: `${OUT}/refresh-reload-open-failure.png`, fullPage: true });
    throw error;
  }
}

async function click(page, text) {
  await page.locator('button:visible', { hasText: text }).first().click();
}

async function runFlow(page, afterReload, captureStage = null) {
  const executionsBefore = await page.evaluate(() => window.__CALLS__.filter(call => call.cmd === 'refresh_execute').length);
  if (executionsBefore !== 0) throw new Error(`${afterReload ? 'reload' : 'initial'}: Refresh executed before an explicit run`);
  await click(page, 'Import JSON');
  await page.waitForFunction(() => document.body.innerText.includes('Connection IDs are hints only'));
  await page.locator('.sqp-left select').nth(0).selectOption('sess-c1');
  await page.locator('.sqp-left select').nth(1).selectOption('sess-c2');
  await click(page, 'Reconfirm source and target');
  if (captureStage) {
    await captureStage('setup-confirmed');
    await click(page, 'Tables & masks');
    await captureStage('policies');
    await click(page, 'Setup');
  }
  await click(page, 'Analyze catalogs');
  await page.waitForFunction(() => document.body.innerText.includes('Catalog compatibility proven'));
  await click(page, 'Plan row sets');
  try {
    await page.waitForFunction(() => document.body.innerText.includes('Requested 11 + closure 2 = final 13'), undefined, { timeout: 5000 });
  } catch (error) {
    console.error(await page.locator('.proc-panel:visible').innerText());
    console.error(await page.evaluate(() => window.__CALLS__.filter(call => call.cmd === 'monitor_query').map(call => call.args.sql)));
    await page.screenshot({ path: `${OUT}/refresh-rowset-failure.png`, fullPage: true });
    throw error;
  }
  await click(page, 'Verify Rust masking');
  await page.waitForFunction(() => document.body.innerText.includes('Rust masking verified'));
  await click(page, 'Check target empty');
  await page.waitForFunction(() => document.body.innerText.includes('Target preflight passed: 6 selected tables are empty'));
  await click(page, 'Run Refresh');
  await page.waitForFunction(() => document.body.innerText.includes('Verification verified'));
  const text = await page.locator('.proc-panel:visible').innerText();
  for (const expected of ['13 committed', '6/6 exact table counts', '3/3 FK checks', '0 unverified columns', 'Copy and all count, FK and comparable-content checks passed']) {
    if (!text.includes(expected)) throw new Error(`missing final evidence ${expected}: ${text}`);
  }
  const executions = await page.evaluate(() => window.__CALLS__.filter(call => call.cmd === 'refresh_execute').length);
  if (executions !== 1) throw new Error(`expected one explicit Refresh execution, got ${executions}`);
  if (captureStage) await captureStage('verified-top');
}

async function checkLayout(page, label) {
  const layout = await page.evaluate(() => {
    const rect = selector => {
      const element = [...document.querySelectorAll(selector)].find(candidate => candidate.getBoundingClientRect().width > 0);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    const buttons = [...document.querySelectorAll('.proc-panel button')].filter(button => {
      const style = getComputedStyle(button);
      const box = button.getBoundingClientRect();
      return style.display !== 'none' && box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
    }).map(button => button.textContent);
    const scroller = [...document.querySelectorAll('.op-panel .sqp-main')].find(element => element.getBoundingClientRect().width > 0);
    let scrolling = null;
    if (scroller) {
      const before = scroller.scrollTop;
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = Math.max(0, max);
      const reached = scroller.scrollTop;
      scroller.scrollTop = before;
      scrolling = { overflowY: getComputedStyle(scroller).overflowY, max, reached };
    }
    const visibleControls = [...document.querySelectorAll('.op-panel input, .op-panel select, .op-panel textarea, .op-panel button')]
      .filter(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
    const tiny = visibleControls.filter(element => element.matches('input:not([type="checkbox"]), select, textarea') && element.getBoundingClientRect().height < 32)
      .map(element => element.getAttribute('aria-label') || element.tagName);
    const oversized = visibleControls.filter(element => element.tagName === 'BUTTON' && element.getBoundingClientRect().height > 64)
      .map(element => element.textContent);
    return {
      viewport: innerWidth, scrolling, tiny, oversized, documentWidth: document.documentElement.scrollWidth,
      panel: rect('.proc-panel'), toolbar: rect('.proc-toolbar'), main: rect('.sqp-main'),
      left: rect('.sqp-left'), right: rect('.sqp-right'), buttons,
    };
  });
  if (layout.documentWidth > layout.viewport + 1 || layout.buttons.length) {
    throw new Error(`${label}: horizontal overflow ${JSON.stringify(layout)}`);
  }
  if (!layout.scrolling || !['auto', 'scroll'].includes(layout.scrolling.overflowY)
    || (layout.scrolling.max > 0 && layout.scrolling.reached < 1)
    || layout.tiny.length || layout.oversized.length) {
    throw new Error(`${label}: scrolling or control sizing failed ${JSON.stringify(layout)}`);
  }
  for (const key of ['panel', 'toolbar', 'main', 'left', 'right']) {
    const box = layout[key];
    if (box && (box.left < -1 || box.right > layout.viewport + 1 || box.width < 1)) {
      throw new Error(`${label}: ${key} outside viewport ${JSON.stringify(box)}`);
    }
  }
}

async function captureStage(page, theme, name, errors) {
  await page.locator('.op-panel .sqp-main:visible').evaluate(element => { element.scrollTop = 0; });
  await checkLayout(page, `${theme}/${name}`);
  await page.screenshot({ path: `${OUT}/refresh-${theme}-${name}.png`, fullPage: true });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForTimeout(100);
  await checkLayout(page, `${theme}/${name}-compact`);
  await page.screenshot({ path: `${OUT}/refresh-${theme}-${name}-compact.png`, fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  if (errors.length) throw new Error(`${theme}/${name}: browser errors: ${errors.join(' | ')}`);
  console.log(`PASS ${theme}/${name} — stage, 1600×1000 + 1100×760`);
}

async function capture(page, theme, name, errors) {
  await page.locator('section[aria-label="Refresh execution progress"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const visiblePanel = await page.locator('.proc-panel:visible').innerText();
  if (!visiblePanel.includes('Safe Environment Refresh') || !visiblePanel.includes('Verification verified')) {
    throw new Error(`${theme}/${name}: screenshot would not show verified Refresh`);
  }
  await checkLayout(page, `${theme}/${name}`);
  await page.screenshot({ path: `${OUT}/refresh-${theme}-${name}.png`, fullPage: true });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForTimeout(150);
  await checkLayout(page, `${theme}/${name}-compact`);
  await page.screenshot({ path: `${OUT}/refresh-${theme}-${name}-compact.png`, fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  if (errors.length) throw new Error(`${theme}/${name}: browser errors: ${errors.join(' | ')}`);
  console.log(`PASS ${theme}/${name} — 1600×1000 + 1100×760`);
}

const server = await ensureServer();
const browser = await chromium.launch({ executablePath: EXE });
try {
  for (const theme of ['ayu-dark', 'ayu-light']) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(installMock, mockFor('mysql'));
    await page.addInitScript(refreshMock);
    await page.addInitScript(theme => localStorage.setItem('dbgui:theme', theme), theme);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await openRefresh(page);
    await runFlow(page, false, name => captureStage(page, theme, name, errors));
    await capture(page, theme, 'verified-initial', errors);
    const savedBuffers = await page.evaluate(() => localStorage.getItem('dbgui.buffers.c1'));
    if (!savedBuffers?.includes('Safe Environment Refresh')) throw new Error(`Refresh tab was not persisted before reload: ${savedBuffers}`);

    await page.reload({ waitUntil: 'networkidle' });
    await openRefresh(page, true);
    await page.getByText('Restored without loading data or starting background activity.').waitFor({ timeout: 12000 });
    const restoredExecutions = await page.evaluate(() => window.__CALLS__.filter(call => call.cmd === 'refresh_execute').length);
    if (restoredExecutions !== 0) throw new Error('full reload restarted Refresh automatically');
    await click(page, 'Refresh');
    await page.locator('.proc-title:visible', { hasText: 'Safe Environment Refresh' }).first().waitFor();
    await runFlow(page, true);
    await capture(page, theme, 'verified-reload', errors);
    await page.close();
  }
  console.log(`REFRESH UI OK — both themes, compact layouts, full reload and inert revival; screenshots ${OUT}`);
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}
