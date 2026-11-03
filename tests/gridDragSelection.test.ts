import test from 'node:test';
import assert from 'node:assert/strict';
import { runTargets } from '../dev/render-smoke/run.mjs';
import * as fixtures from '../dev/doc-fixtures.mjs';

const result = {
  columns: [
    { name: 'id', type_name: 'INT', nullable: false },
    { name: 'total', type_name: 'DECIMAL', nullable: true },
    { name: 'status', type_name: 'TEXT', nullable: false },
  ],
  rows: [[1, 100, 'open'], [2, 200, 'paid'], [3, 300, 'void']],
  rows_affected: null, execution_ms: 1, fetch_ms: 1, warnings: [], truncated: false,
};
const second = {
  ...result,
  rows: [['s1', 's2', 's3'], ['s4', 's5', 's6'], ['s7', 's8', 's9']],
};
const delay = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
function walk(node, found = []) {
  if (node.nodeType === 1) found.push(node);
  for (const child of node.childNodes ?? []) walk(child, found);
  return found;
}
function isHidden(element) {
  for (let node = element; node; node = node.parentNode) {
    if (node.style?.display === 'none') return true;
  }
  return false;
}
function cell(container, row, column) {
  const found = walk(container).find(el => !isHidden(el)
    && el.getAttribute('data-r') === String(row) && el.getAttribute('data-c') === String(column));
  if (!found) throw new Error(`cell not rendered: ${row}/${column}`);
  found.dataset.r = String(row);
  found.dataset.c = String(column);
  found.closest = selector => selector === '[data-r]' ? found : null;
  return found;
}
function reactProps(element) {
  const key = Object.keys(element).find(name => name.startsWith('__reactProps'));
  if (!key) throw new Error(`no React props on ${element.className}`);
  return element[key];
}
async function drag(ctx) {
  const scroller = walk(ctx.container).find(el => !isHidden(el) && el.className?.split(' ').includes('fg-scroll'));
  await ctx.act(async () => {
    reactProps(scroller).onMouseDown({ button: 0, target: cell(ctx.container, 0, 0), preventDefault() {}, shiftKey: false });
    await delay();
  });
  await ctx.act(async () => {
    reactProps(scroller).onMouseMove({ target: cell(ctx.container, 1, 1), preventDefault() {} });
    await delay();
    ctx.shim.window.dispatchEvent(new Event('mouseup'));
    await delay();
  });
}
async function clickResult(ctx, index) {
  const button = walk(ctx.container).find(el => el.tagName === 'BUTTON' && el.textContent.trim() === `▦ Result ${index}`);
  if (!button) throw new Error(`result tab not found: ${index}`);
  await ctx.act(async () => {
    button.dispatchEvent(new Event('click', { bubbles: true }));
    await delay();
  });
}
function selectedCount(container) {
  return walk(container).filter(el => !isHidden(el) && el.className?.split(' ').includes('fg-sel')).length;
}
function selectedText(container) {
  return walk(container).filter(el => !isHidden(el) && el.className?.split(' ').includes('fg-sel'))
    .map(el => el.textContent);
}

const targets = [
  {
    name: 'SingleResultDragSelection', file: 'src/components/ResultGrid.tsx', tier: 'mount', export: 'ResultGrid',
    props: { result, engine: 'mysql' }, mock: fixtures.mockFor('mysql'), interact: drag,
    assert: ({ container }) => selectedCount(container) === 4 ? undefined : `expected a 2×2 selection after drag, got ${selectedCount(container)} selected cells`,
  },
  {
    name: 'MultiResultDragSelection', file: 'src/components/ResultSetTabs.tsx', tier: 'mount', export: 'ResultSetTabs',
    props: { result: { ...result, result_sets: [second] }, engine: 'mysql' },
    mock: fixtures.mockFor('mysql'),
    interact: async ctx => {
      await drag(ctx);
      await clickResult(ctx, 2);
      await drag(ctx);
      await clickResult(ctx, 1);
      if (selectedText(ctx.container).join('|') !== '1|100|2|200') {
        throw new Error(`first selection was not preserved: ${selectedText(ctx.container).join('|')}`);
      }
      await clickResult(ctx, 2);
      if (selectedText(ctx.container).join('|') !== 's1|s2|s4|s5') {
        throw new Error(`second selection was not preserved: ${selectedText(ctx.container).join('|')}`);
      }
      await clickResult(ctx, 1);
    },
    assert: ({ container }) => selectedCount(container) === 4 ? undefined : `expected a 2×2 selection inside the active result set, got ${selectedCount(container)} selected cells`,
  },
];

const results = await runTargets(targets, { fixtures });
for (const scenario of targets) {
  test(scenario.name, () => {
    const outcome = results.get(scenario.name);
    assert.ok(outcome);
    assert.equal(outcome.status, 'mounted', outcome.error ?? outcome.status);
    assert.deepEqual(outcome.consoleErrors ?? [], []);
  });
}
