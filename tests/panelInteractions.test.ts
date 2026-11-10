import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const harness = readFileSync('dev/panel_interactions.mjs', 'utf8');
const mock = readFileSync('dev/mock-tauri.ts', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

test('panel interaction sweep is a documented project command', () => {
  assert.equal(packageJson.scripts['test:panels'], 'node dev/panel_interactions.mjs');
});

test('panel interaction sweep discovers every menu panel on all fixture engines', () => {
  for (const engine of ['mysql', 'postgres', 'clickhouse', 'sqlite', 'parquet', 'duckdb', 'mongodb', 'sqlserver', 'redis']) {
    assert.match(harness, new RegExp(`eng: '${engine}'`));
  }
  assert.match(harness, /page\.locator\('\.pmenu-title'\)/);
  assert.match(harness, /menuList\(\)\.locator\('\.pmenu-item'\)/);
  assert.match(harness, /getAttribute\('aria-disabled'\) !== 'true'/);
  assert.match(harness, /for \(const label of labels\)/);
});

test('panel interactions cover enabled controls with mocked I/O and observable effects', () => {
  assert.match(harness, /button, input, select, textarea, \[role="button"\]/);
  for (const guard of ['!element.disabled', "aria-disabled", '!element.readOnly', "!element.closest('.unavail')"]) {
    assert.ok(harness.includes(guard), `missing enabled-control guard: ${guard}`);
  }
  assert.match(harness, /after\.calls > before\.calls \|\| after\.body !== before\.body/);
  assert.match(harness, /edited value did not stick/);
  assert.match(harness, /checkbox state did not toggle/);
  assert.match(harness, /selected value did not change/);
  assert.match(harness, /await showPanel\(\)/);
  assert.match(harness, /page\.addInitScript\(installMock, mockFor\(engine\.eng\)\)/);
  assert.match(harness, /localStorage\.clear\(\)/);
  assert.match(harness, /sessionStorage\.clear\(\)/);
  assert.match(harness, /const active = async \(\) => await page\.locator\('\.qtab-panel-wrap:visible'\)\.count\(\) > 0/);
  assert.match(harness, /clipboard:writeText/);
  assert.match(mock, /record\('dialog:open', opts\)/);
  assert.match(mock, /record\('dialog:save', opts\)/);
});
