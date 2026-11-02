import test from 'node:test';
import assert from 'node:assert/strict';
import { runTargets } from '../dev/render-smoke/run.mjs';
import * as fixtures from '../dev/doc-fixtures.mjs';

const FILE = 'src/components/ResultGrid.tsx';
const result = {
  columns: [
    { name: 'id', type_name: 'INT', nullable: false },
    { name: 'total', type_name: 'DECIMAL', nullable: true },
    { name: 'status', type_name: 'TEXT', nullable: false },
  ],
  rows: [[1, 100, 'open']],
  rows_affected: null, execution_ms: 1, fetch_ms: 1, warnings: [], truncated: false,
};
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
function walk(node, found = []) {
  if (node.nodeType === 1) found.push(node);
  for (const child of node.childNodes ?? []) walk(child, found);
  return found;
}
async function layoutAction(ctx, column, action) {
  const header = walk(ctx.container).find(el => el.className?.includes('fg-hcell') && el.textContent.includes(column));
  if (!header) throw new Error(`header not found: ${column}`);
  const propsKey = Object.keys(header).find(key => key.startsWith('__reactProps'));
  if (!propsKey) throw new Error('header has no React layout handler');
  await ctx.act(async () => {
    header[propsKey].onContextMenu({ preventDefault() {}, clientX: 20, clientY: 20 });
    await delay();
  });
  const item = walk(ctx.container).find(el => el.className?.includes('context-menu-item') && el.textContent.trim() === action);
  if (!item) throw new Error(`layout action not found: ${action}`);
  const itemPropsKey = Object.keys(item).find(key => key.startsWith('__reactProps'));
  if (!itemPropsKey) throw new Error('layout menu item has no React click handler');
  await ctx.act(async () => {
    item[itemPropsKey].onClick();
    await delay();
  });
}

const targets = [{
  name: 'ColumnLayoutActions',
  file: FILE, tier: 'mount', export: 'ResultGrid',
  props: { result, engine: 'mysql' },
  mock: fixtures.mockFor('mysql'),
  interact: async ctx => {
    await layoutAction(ctx, 'total', 'Pin column left');
    await layoutAction(ctx, 'status', 'Hide column');
  },
  assert: ({ html }) => {
    if (!html.includes('total · DECIMAL · pinned left')) return html.slice(0, 5000);
    if (html.includes('status · TEXT')) return 'hidden column is still rendered';
    if (!html.includes('100')) return 'row value mapping was lost after layout changes';
  },
}];

const results = await runTargets(targets, { fixtures });
for (const scenario of targets) {
  test(scenario.name, () => {
    const outcome = results.get(scenario.name);
    assert.ok(outcome);
    assert.equal(outcome.status, 'mounted', outcome.error ?? outcome.status);
    assert.deepEqual(outcome.consoleErrors ?? [], []);
  });
}
