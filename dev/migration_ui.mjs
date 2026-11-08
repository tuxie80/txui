// Real-Chromium Migration Cockpit visual and interaction gate.
// The real application/CSS runs against deterministic Tauri mocks; live database
// behavior is covered separately by the dbctl migration fixtures.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mockFor, installMock } from './doc-fixtures.mjs';

const EXE = process.env.TXUI_CHROMIUM
  ?? '/Users/j/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5273/';
const OUT = process.env.TXUI_DOC_OUT ?? 'dev/verify-shots';
const LONG_TABLE = 'orders_with_an_exceptionally_long_descriptive_name_that_keeps_wrapping_past_the_available_column_2026';
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
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const response = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return child;
    } catch { /* poll */ }
  }
  process.kill(-child.pid);
  throw new Error('Vite mock server did not start');
}

function migrationMock({ longTable }) {
  const state = { records: [], scratchExecuted: false, deployed: false, pending: null };
  const result = (columns, rows) => ({
    columns: columns.map(name => ({ name, type_name: 'text', nullable: true })),
    rows, rows_affected: null, execution_ms: 1, fetch_ms: 0, warnings: [],
  });
  const hash = async sql => {
    const bytes = new TextEncoder().encode(sql);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  };
  const statementsResult = (runKey, sqlSha256, statements, cancelled = false) => {
    const rows = statements.map((input, index) => ({
      number: index + 1, line: input.line, ms: 8 + index, rows_affected: 0,
      ok: !cancelled || index === 0,
      error: cancelled && index === 1 ? 'cancellation requested before this statement completed; its server outcome is unknown and no rollback is claimed' : null,
      error_code: cancelled && index === 1 ? 'cancelled' : '', db_code: '', sqlstate: '',
    }));
    return {
      run_key: runKey, sql_sha256: sqlSha256, backend_id: 4242,
      statement_total: statements.length,
      executed: cancelled ? 1 : statements.length,
      committed: cancelled ? 1 : statements.length,
      unknown: cancelled ? 1 : 0,
      failed: 0,
      not_started: cancelled ? 0 : 0,
      statements: rows,
      ok: !cancelled, cancelled, partial: cancelled, ms: 31,
      error: cancelled ? 'statement outcome unknown; no rollback claimed' : null,
    };
  };
  const catalog = (sql, final) => {
    const schema = /SCHEMATA/i.test(sql);
    const tables = /information_schema\.TABLES/i.test(sql) && /TABLE_COMMENT/i.test(sql);
    const columns = /information_schema\.COLUMNS/i.test(sql);
    const indexes = /information_schema\.STATISTICS/i.test(sql);
    const foreignKeys = /KEY_COLUMN_USAGE/i.test(sql);
    if (schema) return result(
      ['server_charset', 'server_collation', 'schema_charset', 'schema_collation', 'server_version'],
      [['utf8mb4', 'utf8mb4_0900_ai_ci', 'utf8mb4', 'utf8mb4_0900_ai_ci', '8.4.3']],
    );
    const finalCreate = final && !window.__MIG_UI_CASE__?.startsWith('high');
    if (tables) {
      if (window.__MIG_UI_CASE__?.startsWith('high')) {
        return result(['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT'], [[longTable, 'InnoDB', 'utf8mb4_0900_ai_ci', null, '']]);
      }
      return result(['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT'], finalCreate
        ? [[longTable, 'InnoDB', 'utf8mb4_0900_ai_ci', null, '']]
        : []);
    }
    if (columns) {
      if (window.__MIG_UI_CASE__?.startsWith('high')) {
        return result(['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'CHARACTER_MAXIMUM_LENGTH', 'COLUMN_COMMENT'], [[longTable, 'id', 'int', 'int', 'NO', null, '', null, null, null, '']]);
      }
      return result(['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'CHARACTER_MAXIMUM_LENGTH', 'COLUMN_COMMENT'], finalCreate
        ? [[longTable, 'id', 'int', 'int', 'NO', null, '', null, null, null, ''], [longTable, 'note', 'varchar', 'varchar(40)', 'YES', null, '', null, null, 40, '']]
        : []);
    }
    if (indexes) {
      if (window.__MIG_UI_CASE__?.startsWith('high')) {
        return result(['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'], [[longTable, 'PRIMARY', 0, 1, 'id', null, 1, 'BTREE']]);
      }
      return result(['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'], finalCreate
        ? [[longTable, 'PRIMARY', 0, 1, 'id', null, 1, 'BTREE'], [longTable, 'idx_visual_note', 1, 1, 'note', null, 1, 'BTREE']]
        : []);
    }
    if (foreignKeys) return result(['CONSTRAINT_NAME', 'TABLE_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME', 'ORDINAL_POSITION', 'DELETE_RULE', 'UPDATE_RULE'], []);
    return result(['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'], []);
  };
  const connection = id => ({
    id, name: `${id} visual`, engine: 'mysql', host: '127.0.0.1', port: 3306,
    user: 'root', database: null, group: 'Visual', environment: id === 'cprod' ? 'prod' : 'dev',
    read_only: id === 'cro', color: null, auto_connect: false, tags: [], labels: [],
    prod_allow_ddl: true, prod_allow_unfiltered_write: false,
  });
  window.__MIG_STATE__ = state;
  Object.assign(window.__MOCK__, {
    list_connections: [connection('cdev'), connection('cro'), connection('cprod')],
    open_connection: args => `sess-${args.id}`,
    set_session_db: null,
    migration_scratch_list: () => state.records,
    migration_rehearsal_create: args => {
      const record = {
        run_key: args.runKey, session_id: args.sessionId,
        connection_id: args.sessionId.replace('sess-', ''),
        engine: 'mysql', name: 'txui_mig_visual_with_a_very_long_scratch_schema_name_for_layout_verification',
        status: 'active', error: null, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
      };
      state.records = [record];
      return record;
    },
    migration_rehearsal_clone: args => ({
      run_key: args.runKey, tables_cloned: 1, statements_executed: 1,
      total_statements: 1, serial_sequences: 0, foreign_keys_added: 0,
    }),
    migration_rehearsal_execute: args => {
      state.scratchExecuted = true;
      state.records = state.records.map(record => ({ ...record, status: 'executed' }));
      return statementsResult(args.runKey, args.expectedSqlSha256, args.statements);
    },
    migration_rehearsal_cleanup: args => {
      const record = state.records.find(item => item.run_key === args.runKey);
      state.records = [];
      return { ...record, status: 'dropped' };
    },
    migration_deploy_execute: args => {
      const ch = args.onEvent;
      ch?.onmessage?.({ type: 'backend', backend_id: 4242 });
      if (window.__MIG_UI_CASE__ === 'cancel') {
        const first = {
          number: 1, line: args.statements[0].line, ms: 8, rows_affected: 0,
          ok: true, error: null, error_code: '', db_code: '', sqlstate: '',
        };
        ch?.onmessage?.({ type: 'statement', statement: first, committed: 1, unknown: 0, failed: 0, not_started: 1 });
        return new Promise(resolve => { state.pending = { resolve, args }; });
      }
      state.deployed = true;
      const outcome = statementsResult(args.runKey, args.expectedSqlSha256, args.statements);
      for (const statement of outcome.statements) {
        ch?.onmessage?.({ type: 'statement', statement, committed: statement.number, unknown: 0, failed: 0, not_started: outcome.statement_total - statement.number });
      }
      ch?.onmessage?.({ type: 'done', ok: true, cancelled: false, committed: outcome.committed, unknown: 0, failed: 0, not_started: 0 });
      return outcome;
    },
    cancel_watched: () => {
      if (!state.pending) return null;
      const { resolve, args } = state.pending;
      state.pending = null;
      const outcome = statementsResult(args.runKey, args.expectedSqlSha256, args.statements, true);
      args.onEvent?.onmessage?.({ type: 'statement', statement: outcome.statements[1], committed: 1, unknown: 1, failed: 0, not_started: 0 });
      args.onEvent?.onmessage?.({ type: 'done', ok: false, cancelled: true, committed: 1, unknown: 1, failed: 0, not_started: 0 });
      resolve(outcome);
      return null;
    },
    migration_preflight: async args => {
      if (args.sessionId === 'sess-cro') throw { code: 'guard_refused', message: 'connection is read-only — write statement rejected' };
      const objects = [...new Set(args.statements.map(statement => statement.table).filter(Boolean))].sort();
      return {
        sql_sha256: await hash(args.sql), statement_count: args.statements.length,
        affected_objects: objects,
        unsupported: args.statements.filter(statement => !statement.supported).length,
        destructive: args.statements.filter(statement => statement.destructive).length,
        lossy: args.statements.filter(statement => statement.lossy).length,
        implicit_commits: args.statements.length,
        statements: args.statements.map((statement, index) => ({ ...statement, number: index + 1, implicit_commit: true })),
        environment: args.sessionId === 'sess-cprod' ? 'prod' : 'dev',
        read_only: false, prod_allow_ddl: true, prod_allow_unfiltered_write: false,
        stop_on_first_error: true,
      };
    },
    monitor_query: args => {
      const sql = String(args.sql ?? '');
      if (sql === 'SELECT DATABASE()') return result(['DATABASE()'], [['shop']]);
      if (sql.includes('VERSION()')) return result(['v', 'c'], [['8.4.3', 'MySQL Community Server']]);
      if (sql.includes('information_schema') || sql.includes('pg_stat_user_tables')) {
        return catalog(sql, state.scratchExecuted || state.deployed);
      }
      return result([], []);
    },
    save: () => '/mock/migration-visual-report.md',
    write_text_file: null,
  });
}

const CREATE_SQL = `CREATE TABLE ${LONG_TABLE}(id int PRIMARY KEY, note varchar(40)); CREATE INDEX idx_visual_note ON ${LONG_TABLE}(note)`;
const HIGH_SQL = Array.from({ length: 105 }, (_, index) => `ALTER TABLE ${LONG_TABLE} DROP COLUMN missing_column_${index + 1}`).join('; ');

async function openMigration(page, connectionId, sql) {
  if (connectionId === 'cprod') {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('dbgui:open-connection', { detail: { connectionId: 'cprod' } })));
    await page.getByRole('button', { name: 'I understand — production' }).waitFor({ timeout: 12000 });
    await page.getByRole('button', { name: 'I understand — production' }).click();
    await page.waitForTimeout(400);
  }
  await page.evaluate(({ connectionId, sql }) => {
    window.dispatchEvent(new CustomEvent('dbgui:open-migration', { detail: {
      version: 1, engine: 'mysql', database: 'shop', sql,
      origin: 'schema-compare', targetConnectionId: connectionId,
    } }));
  }, { connectionId, sql });
  try {
    await page.locator('.proc-title:visible', { hasText: 'Migration Cockpit' }).first().waitFor({ timeout: 5000 });
  } catch (error) {
    console.error(await page.locator('body').innerText());
    console.error(await page.evaluate(() => globalThis.__CALLS__?.map(call => call.cmd)));
    await page.screenshot({ path: `${OUT}/migration-open-failure.png`, fullPage: true });
    throw error;
  }
}

async function review(page) {
  await page.locator('button:visible', { hasText: 'Review migration' }).first().click();
  await page.waitForFunction(() => document.querySelector('.sqp-right')?.textContent?.includes('Backend preflight'));
}

async function lifecycle(page, stopBeforeVerify = false, captureStage = null) {
  await review(page);
  if (captureStage) await captureStage('rehearsal');
  await page.locator('button:visible', { hasText: 'Create scratch' }).click();
  await page.locator('button:visible', { hasText: 'Clone before-state' }).waitFor();
  await page.locator('button:visible', { hasText: 'Clone before-state' }).click();
  await page.locator('button:visible', { hasText: 'Execute migration in scratch' }).waitFor();
  await page.locator('button:visible', { hasText: 'Execute migration in scratch' }).click();
  await page.locator('button:visible', { hasText: 'Compare final objects' }).waitFor();
  await page.locator('button:visible', { hasText: 'Compare final objects' }).click();
  if (captureStage) await captureStage('deploy-ready');
  try {
    await page.locator('button:visible', { hasText: 'Prepare target deployment' }).waitFor({ timeout: 5000 });
  } catch (error) {
    console.error(await page.locator('.proc-panel').innerText());
    await page.screenshot({ path: `${OUT}/migration-proof-failure.png`, fullPage: true });
    throw error;
  }
  await page.locator('button:visible', { hasText: 'Prepare target deployment' }).click();
  await page.locator('button:visible', { hasText: 'Deploy exact SQL now' }).click();
  if (stopBeforeVerify) return;
  await page.locator('button:visible', { hasText: 'Verify deployed target' }).waitFor();
  await page.locator('button:visible', { hasText: 'Verify deployed target' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('Phase: done'));
}

async function checkLayout(page, label) {
  const layout = await page.evaluate(() => {
    const rect = selector => {
      const element = [...document.querySelectorAll(selector)]
        .find(candidate => candidate.getBoundingClientRect().width > 0);
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
      viewport: innerWidth, scrolling, tiny, oversized,
      documentWidth: document.documentElement.scrollWidth,
      panel: rect('.proc-panel'), toolbar: rect('.proc-toolbar'),
      main: rect('.sqp-main'), left: rect('.sqp-left'), right: rect('.sqp-right'),
      buttons,
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

async function capture(page, theme, name, errors) {
  await page.locator('.op-panel .sqp-main:visible').evaluate(element => { element.scrollTop = 0; });
  const visiblePanel = await page.locator('.proc-panel:visible').innerText();
  if (!visiblePanel.includes('Migration Cockpit')) throw new Error(`${theme}/${name}: screenshot would not show Migration Cockpit`);
  await checkLayout(page, `${theme}/${name}`);
  await page.screenshot({ path: `${OUT}/migration-${theme}-${name}.png`, fullPage: true });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForTimeout(100);
  await checkLayout(page, `${theme}/${name}-compact`);
  await page.screenshot({ path: `${OUT}/migration-${theme}-${name}-compact.png`, fullPage: true });
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
    await page.addInitScript(migrationMock, { longTable: LONG_TABLE });
    await page.addInitScript(theme => localStorage.setItem('dbgui:theme', theme), theme);
    await page.goto(BASE, { waitUntil: 'networkidle' });

    await openMigration(page, 'cdev', CREATE_SQL);
    await capture(page, theme, 'review-empty', errors);
    await lifecycle(page, false, name => capture(page, theme, name, errors));
    await page.reload({ waitUntil: 'networkidle' });
    await openMigration(page, 'cdev', CREATE_SQL);
    await lifecycle(page);
    await capture(page, theme, 'done', errors);

    await page.evaluate(() => { window.__MIG_UI_CASE__ = 'cancel'; });
    await openMigration(page, 'cdev', CREATE_SQL);
    await lifecycle(page, true);
    await page.locator('button:visible', { hasText: 'Cancel deployment' }).waitFor();
    await page.waitForFunction(() => document.body.innerText.includes('1 committed') && document.body.innerText.includes('1 not started'));
    await capture(page, theme, 'progress', errors);
    await page.locator('button:visible', { hasText: 'Cancel deployment' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('1 unknown') && document.body.innerText.includes('Phase: cancelled'));
    await capture(page, theme, 'cancelled', errors);

    await page.evaluate(() => { window.__MIG_UI_CASE__ = 'high-findings'; });
    await openMigration(page, 'cro', HIGH_SQL);
    await review(page);
    try {
      await page.waitForFunction(() => document.body.innerText.includes('105/105 modeled'), { timeout: 5000 });
    } catch (error) {
      console.error(await page.locator('.proc-panel:visible').innerText());
      await page.screenshot({ path: `${OUT}/migration-findings-failure.png`, fullPage: true });
      throw error;
    }
    const findingCount = await page.locator('.sqp-right:visible .sqp-finding').count();
    if (findingCount < 200) throw new Error(`${theme}: expected 105 statements + 105 findings, found ${findingCount}`);
    await capture(page, theme, 'findings-readonly', errors);

    await page.evaluate(() => { window.__MIG_UI_CASE__ = 'production'; });
    await openMigration(page, 'cprod', CREATE_SQL);
    await review(page);
    await page.waitForFunction(() => document.body.innerText.includes('Environment: prod'));
    await capture(page, theme, 'production', errors);
    await page.close();
  }
  console.log(`MIGRATION UI OK — both themes, full reload, long identifiers, 105 findings, progress/cancel, read-only/prod; screenshots ${OUT}`);
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}
