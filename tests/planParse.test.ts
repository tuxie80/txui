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
