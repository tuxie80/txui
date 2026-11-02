import test from 'node:test';
import assert from 'node:assert/strict';
import { runTargets } from '../dev/render-smoke/run.mjs';
import * as fixtures from '../dev/doc-fixtures.mjs';

const FILE = 'src/components/ResultSetTabs.tsx';
const result = {
  columns: [{ name: 'id', type_name: 'INT', nullable: false }],
  rows: [[1]],
  rows_affected: null, execution_ms: 1, fetch_ms: 1, warnings: [], truncated: false,
  result_sets: [{
    columns: [{ name: 'name', type_name: 'TEXT', nullable: true }],
    rows: [['second-set-value']], rows_affected: null,
    execution_ms: 2, fetch_ms: 1, warnings: [], truncated: false,
  }],
};
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
function walk(node, found = []) {
  if (node.nodeType === 1) found.push(node);
  for (const child of node.childNodes ?? []) walk(child, found);
  return found;
}

const targets = [{
  name: 'MultiResultTabs',
  file: FILE, tier: 'mount', export: 'ResultSetTabs',
  props: { result, engine: 'sqlite' },
  mock: fixtures.mockFor('sqlite'),
  assert: ({ html }) => {
    for (const text of ['▦ Result 1', '▦ Result 2']) if (!html.includes(text)) return `missing ${text}`;
  },
  interact: async ctx => {
    const button = walk(ctx.container).find(el => el.tagName === 'BUTTON' && el.textContent.trim() === '▦ Result 2');
    if (!button) throw new Error('second result-set tab missing');
    await ctx.act(async () => {
      button.dispatchEvent(new Event('click', { bubbles: true }));
      await delay();
    });
  },
  assert: ({ html }) => {
    for (const text of ['▦ Result 1', '▦ Result 2', 'second-set-value']) {
      if (!html.includes(text)) return `missing ${text}`;
    }
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
