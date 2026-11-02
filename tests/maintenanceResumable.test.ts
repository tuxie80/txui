import test from 'node:test';
import assert from 'node:assert/strict';
import { runTargets } from '../dev/render-smoke/run.mjs';
import * as fixtures from '../dev/doc-fixtures.mjs';

const FILE = 'src/components/MaintenancePanel.tsx';
const result = rows => ({ columns: [], rows, row_count: rows.length });
const delay = () => new Promise(resolve => setTimeout(resolve, 5));

function session(name) {
  return {
    connectionId: `connection-${name}`, sessionId: `session-${name}`,
    connectionName: name, engine: 'sqlserver', environment: 'dev', readOnly: false,
  };
}

function walk(node, found = []) {
  if (node.nodeType === 1) found.push(node);
  for (const child of node.childNodes ?? []) walk(child, found);
  return found;
}

function button(container, text, starts = false) {
  const found = walk(container).find(el => el.tagName === 'BUTTON'
    && (starts ? el.textContent.trim().startsWith(text) : el.textContent.trim() === text));
  if (!found) throw new Error(`button not found: ${text}`);
  return found;
}

async function click(ctx, text, starts = false) {
  const control = button(ctx.container, text, starts);
  await ctx.act(async () => {
    control.dispatchEvent(new Event('click', { bubbles: true }));
    await delay();
  });
}

function reactProps(el) {
  const key = Object.keys(el).find(name => name.startsWith('__reactProps'));
  if (!key) throw new Error(`no React props on ${el.tagName}`);
  return el[key];
}

async function check(ctx, text) {
  const label = walk(ctx.container).find(el => el.tagName === 'LABEL' && el.textContent.trim() === text);
  const input = label && walk(label).find(el => el.tagName === 'INPUT');
  if (!input) throw new Error(`checkbox not found: ${text}`);
  await ctx.act(async () => {
    reactProps(input).onChange({ target: { checked: true } });
    await delay();
  });
}

async function confirmOptimize(ctx) {
  const label = walk(ctx.container).find(el => el.className.includes('mnt-confirm'));
  const input = label && walk(label).find(el => el.tagName === 'INPUT');
  if (!input) throw new Error('OPTIMIZE confirmation input not found');
  await ctx.act(async () => {
    reactProps(input).onChange({ target: { value: 'OPTIMIZE' } });
    await delay();
  });
}

function target(name, { server = [16, 3], indexes = [['dbo', 'orders', 'ix', 2, 0, 0, 0]] } = {}) {
  return {
    name, file: FILE, tier: 'mount',
    props: { session: session(name), schema: 'dbo', onClose: () => {} },
    mock: {
      ...fixtures.mockFor('sqlserver'),
      monitor_query: args => {
        const sql = String(args.sql);
        if (sql.includes('ProductMajorVersion')) return result([server]);
        if (sql.includes('FROM sys.indexes')) return result(indexes);
        if (sql.includes('FROM sys.tables')) return result([['orders', '', '', '', 3, '']]);
        throw new Error(`unexpected monitor query: ${sql}`);
      },
      panel_query: () => result([]),
    },
  };
}

async function chooseResumable(ctx) {
  await click(ctx, 'Optimize', true);
  await check(ctx, 'orders');
  await check(ctx, 'Resumable online');
}

const targets = [
  {
    ...target('MaintenanceResumableRuns'),
    interact: async ctx => {
      await chooseResumable(ctx);
      await click(ctx, 'show SQL');
      if (!ctx.container.textContent.includes('WITH (ONLINE = ON, RESUMABLE = ON)')) {
        throw new Error('preview did not show resumable SQL');
      }
      await confirmOptimize(ctx);
      await click(ctx, 'Optimize 1 table');
    },
    assert: ({ calls }) => {
      const runs = calls.filter(c => c.cmd === 'panel_query' && String(c.args?.sql).includes('ALTER INDEX'));
      if (runs.length !== 1) return `expected one rebuild, got ${runs.length}`;
      if (!runs[0].args.sql.includes('WITH (ONLINE = ON, RESUMABLE = ON)')) return 'executed SQL was not resumable';
    },
  },
  {
    ...target('MaintenanceResumableServerBlocked', { server: [13, 3] }),
    interact: ctx => click(ctx, 'Optimize', true),
    assert: ({ html, calls }) => {
      if (!html.includes('requires SQL Server 2017')) return 'unsupported version reason missing';
      if (!html.includes('aria-disabled="true"')) return 'unsupported option was not greyed';
      if (calls.some(c => String(c.args?.sql).includes('RESUMABLE = ON'))) return 'unsupported server received resumable SQL';
    },
  },
  {
    ...target('MaintenanceResumableIndexBlocked', {
      indexes: [['dbo', 'orders', 'ix_filtered', 2, 0, 1, 0]],
    }),
    interact: async ctx => {
      await chooseResumable(ctx);
      await confirmOptimize(ctx);
      await click(ctx, 'Optimize 1 table');
    },
    assert: ({ html, calls }) => {
      if (!html.includes('ix_filtered is filtered')) return 'index-specific refusal missing';
      if (!html.includes('blocked')) return 'run was not marked blocked';
      if (calls.some(c => c.cmd === 'panel_query' && String(c.args?.sql).includes('ALTER INDEX'))) {
        return 'ineligible index reached ALTER INDEX';
      }
    },
  },
];

const results = await runTargets(targets, { fixtures });

for (const scenario of targets) {
  test(scenario.name, () => {
    const outcome = results.get(scenario.name);
    assert.ok(outcome, `${scenario.name} did not run`);
    assert.equal(outcome.status, 'mounted', outcome.error ?? outcome.status);
    assert.deepEqual(outcome.consoleErrors ?? [], []);
  });
}
