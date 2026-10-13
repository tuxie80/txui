/**
 * Execution-plan parsing (src/utils/planParse.ts).
 *
 * The distinction the whole plan view rests on is measured vs estimated, and
 * these cover the one server where a single JSON document can be either.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../src/utils/planParse.ts';
import type { PlanNode } from '../src/utils/planParse.ts';

/**
 * MariaDB's measured plan (src/utils/planParse.ts).
 *
 * MySQL's measured plan is indented TREE text and goes through
 * `planAnalyze.ts`; MariaDB's is the *same JSON document* as its estimated
 * plan with `r_`-prefixed measurements added. So the JSON parser is the only
 * place that can tell them apart, and getting it wrong labels real timings as
 * estimates — the one distinction the whole plan view is built on.
 *
 * The fixtures below are trimmed from actual output of MariaDB 11.8.8.
 */
describe('MariaDB ANALYZE FORMAT=JSON', () => {
  const analyzed = JSON.stringify({
    query_optimization: { r_total_time_ms: 0.13 },
    query_block: {
      select_id: 1, cost: 0.0148, r_loops: 1, r_total_time_ms: 0.044,
      nested_loop: [
        { table: {
            table_name: 't2', access_type: 'ALL', loops: 1, r_loops: 1,
            rows: 3, r_rows: 3, cost: 0.0113, r_total_time_ms: 0.011,
            filtered: 100, r_filtered: 66.67 } },
        { table: {
            table_name: 't1', access_type: 'eq_ref', key: 'PRIMARY',
            loops: 3, r_loops: 3, rows: 1, r_rows: 1, cost: 0.0035,
            r_total_time_ms: 0.0058, filtered: 100, r_filtered: 100 } },
      ],
    },
  });

  const estimated = JSON.stringify({
    query_block: {
      select_id: 1, cost: 0.0113,
      nested_loop: [{ table: {
        table_name: 't', access_type: 'ALL', loops: 1, rows: 3,
        cost: 0.0113, filtered: 100 } }],
    },
  });

  test('an ANALYZE plan is reported as measured', () => {
    assert.equal(parsePlan('mysql', analyzed).measured, true);
  });

  /// The same document without the r_ fields is an estimate, and calling it
  /// measured would put optimiser guesses under a "measured" banner.
  test('an EXPLAIN plan from the same server is not', () => {
    assert.equal(parsePlan('mysql', estimated).measured, false);
  });

  test('MySQL JSON is still an estimate', () => {
    const my = JSON.stringify({
      query_block: { select_id: 1, cost_info: { query_cost: '0.55' },
        table: { table_name: 't', access_type: 'ALL',
          rows_examined_per_scan: 3, filtered: '100.00',
          cost_info: { read_cost: '0.25', eval_cost: '0.30', prefix_cost: '0.55' } } },
    });
    assert.equal(parsePlan('mysql', my).measured, false);
  });

  /**
   * `r_rows` is rows per *loop*, not in total. An eq_ref probed 3 times
   * returning 1 row each produced 3 rows; reporting 1 would make the busiest
   * node in a nested loop look like the cheapest.
   */
  test('actual rows are multiplied by the loop count', () => {
    const p = parsePlan('mysql', analyzed);
    const nodes: PlanNode[] = [];
    const walk = (n: PlanNode) => { nodes.push(n); n.children.forEach(walk); };
    walk(p.root);
    const eqref = nodes.find(n => n.stats.relation === 't1')!;
    assert.equal(eqref.stats.rowsEst, 1, 'the estimate is per loop and stays so');
    assert.equal(eqref.stats.rowsActual, 3, 'r_rows 1 × r_loops 3');
    assert.equal(eqref.stats.loops, 3);
  });

  test('a single-loop node is not multiplied and records no loop count', () => {
    const p = parsePlan('mysql', analyzed);
    const nodes: PlanNode[] = [];
    const walk = (n: PlanNode) => { nodes.push(n); n.children.forEach(walk); };
    walk(p.root);
    const scan = nodes.find(n => n.stats.relation === 't2')!;
    assert.equal(scan.stats.rowsActual, 3);
    assert.equal(scan.stats.loops, undefined, 'one loop is not worth a column');
  });

  test('measured plans gain the measured columns and say so', () => {
    const p = parsePlan('mysql', analyzed);
    assert.ok(p.metricColumns.includes('Actual rows'));
    assert.ok(p.metricColumns.includes('Time (ms)'));
    assert.match(p.summary, /measured/);
    assert.ok((p.totalMs ?? 0) > 0);
  });

  /// MariaDB puts the per-table cost in `cost`; MySQL nests it under
  /// cost_info. Reading only MySQL's shape left every MariaDB node at cost 0
  /// and flattened the severity colouring to nothing.
  test('MariaDB per-node cost is read from its own field', () => {
    const p = parsePlan('mysql', estimated);
    const nodes: PlanNode[] = [];
    const walk = (n: PlanNode) => { nodes.push(n); n.children.forEach(walk); };
    walk(p.root);
    const table = nodes.find(n => n.stats.relation === 't')!;
    assert.ok((table.stats.costTotal ?? 0) > 0, 'MariaDB `cost` was not read');
  });
});

// ── WP-09 9.8: MariaDB ANALYZE often reports only ONE of the two time terms —
// the total must be the sum of the finite ones, never NaN-dropped.

test('a single r_total_time_ms term still yields a total', () => {
  const json = JSON.stringify({
    query_block: {
      select_id: 1,
      r_total_time_ms: 12.5,
      table: { table_name: 't', access_type: 'ALL' },
    },
  });
  const p = parsePlan('mysql', json);
  assert.equal(p.totalMs, 12.5);
});

// ── PostgreSQL EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON) ────────
//
// The fixture is shaped like real PG 17 output: per-node Shared Hit/Read
// Blocks and Workers Planned/Launched (BUFFERS + parallel gather), top-level
// Settings and WAL counters beside Plan/Planning Time/Execution Time.

describe('PostgreSQL plan depth (BUFFERS / WAL / SETTINGS / workers)', () => {
  const analyzed = JSON.stringify([{
    Plan: {
      'Node Type': 'Gather',
      'Startup Cost': 1000.42, 'Total Cost': 17258.43,
      'Plan Rows': 96, 'Plan Width': 32,
      'Actual Startup Time': 145.209, 'Actual Total Time': 198.733,
      'Actual Rows': 96, 'Actual Loops': 1,
      'Workers Planned': 4, 'Workers Launched': 2,
      'Shared Hit Blocks': 240, 'Shared Read Blocks': 12000,
      // WAL counters are per-node fields in real output; the statement total
      // sits on the root plan node, NOT at the document's top level.
      'WAL Records': 2018, 'WAL FPI': 0, 'WAL Bytes': 131192,
      Plans: [
        {
          'Node Type': 'Nested Loop', 'Join Type': 'Inner',
          'Startup Cost': 1000.42, 'Total Cost': 16258.01,
          'Plan Rows': 96, 'Plan Width': 32,
          'Actual Startup Time': 145.104, 'Actual Total Time': 195.201,
          'Actual Rows': 32, 'Actual Loops': 3,
          'Shared Hit Blocks': 240, 'Shared Read Blocks': 11800,
          Plans: [
            {
              'Node Type': 'Parallel Seq Scan',
              'Relation Name': 'orders',
              'Startup Cost': 0, 'Total Cost': 14000,
              'Plan Rows': 10, 'Plan Width': 24,
              'Actual Startup Time': 0.052, 'Actual Total Time': 140.011,
              'Actual Rows': 666667, 'Actual Loops': 3,
              'Filter': "(status = 'open'::text)",
              'Shared Hit Blocks': 100, 'Shared Read Blocks': 60000,
            },
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'customers',
              'Index Name': 'customers_pkey',
              'Startup Cost': 0.43, 'Total Cost': 8.45,
              'Plan Rows': 12, 'Plan Width': 8,
              'Actual Startup Time': 0.011, 'Actual Total Time': 0.014,
              'Actual Rows': 15, 'Actual Loops': 2000,
              'Index Cond': '(id = orders.customer_id)',
              'Shared Hit Blocks': 140, 'Shared Read Blocks': 4000,
            },
          ],
        },
      ],
    },
    Settings: { work_mem: '64MB', enable_seqscan: 'off' },
    'Planning Time': 0.412,
    'Execution Time': 205.917,
  }]);

  const estimated = JSON.stringify([{
    Plan: {
      'Node Type': 'Seq Scan', 'Relation Name': 'orders',
      'Startup Cost': 0, 'Total Cost': 18334,
      'Plan Rows': 10, 'Plan Width': 24,
    },
    'Planning Time': 0.089,
  }]);

  test('top-level Settings are captured, and absent without the SETTINGS option', () => {
    const p = parsePlan('postgres', analyzed);
    assert.deepEqual(p.settings, { work_mem: '64MB', enable_seqscan: 'off' });
    assert.equal(parsePlan('postgres', estimated).settings, undefined);
  });

  test('top-level WAL counters are captured, and absent without the WAL option', () => {
    const p = parsePlan('postgres', analyzed);
    assert.deepEqual(p.wal, { records: 2018, fpi: 0, bytes: 131192 });
    assert.equal(parsePlan('postgres', estimated).wal, undefined);
  });

  test('per-node shared hit/read blocks land in stats and the tree table', () => {
    const p = parsePlan('postgres', analyzed);
    const nodes: PlanNode[] = [];
    const walk = (n: PlanNode) => { nodes.push(n); n.children.forEach(walk); };
    walk(p.root);
    const scan = nodes.find(n => n.stats.relation === 'orders')!;
    assert.deepEqual(scan.stats.buffers, { hit: 100, read: 60000 });
    assert.equal(scan.metrics['Buffers hit/read'], '100/60,000');
    assert.ok(p.metricColumns.includes('Buffers hit/read'));
  });

  test('a plan captured without BUFFERS grows no empty column', () => {
    const p = parsePlan('postgres', estimated);
    assert.deepEqual(p.metricColumns, ['Cost', 'Rows (est)']);
  });

  test('planned and launched workers are read per node', () => {
    const p = parsePlan('postgres', analyzed);
    assert.equal(p.root.stats.workersPlanned, 4);
    assert.equal(p.root.stats.workersLaunched, 2);
    assert.equal(p.root.metrics['Workers'], '2/4');
    assert.ok(p.metricColumns.includes('Workers'));
    // Only Gather nodes carry worker counts; children must not inherit them.
    assert.equal(p.root.children[0].stats.workersPlanned, undefined);
  });

  /// The headline case: a node estimating 10 rows and scanning 2M. Both PG
  /// figures are PER LOOP, so the loop count must not multiply the miss.
  test('the mis-estimate is per loop, not multiplied by it', async () => {
    const { buildCostModel } = await import('../src/utils/planCost.ts');
    const model = buildCostModel(parsePlan('postgres', analyzed));
    const scan = model.byPath.get('0.0.0')!;
    assert.equal(scan.node.stats.rowsEst, 10);
    assert.equal(scan.node.stats.rowsActual, 2000001, 'per-loop 666667 × 3 loops');
    assert.ok(scan.misestimate! > 60_000, `the 2M-vs-10 miss, got ${scan.misestimate}`);
    // The looped index scan is WELL estimated per loop (12 vs 15); comparing
    // totals instead would invent a 2500× miss.
    const idx = model.byPath.get('0.0.1')!;
    assert.equal(idx.node.stats.rowsActual, 30000, 'per-loop 15 × 2000 loops');
    assert.ok(idx.misestimate === undefined || idx.misestimate < 2,
      `a well-estimated looped node must not scream, got ${idx.misestimate}`);
  });
});
