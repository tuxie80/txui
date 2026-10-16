/**
 * The measured-plan interpreters (src/utils/planAnalyze.ts).
 *
 * MySQL's EXPLAIN ANALYZE is TREE text (analyzePlanText); MariaDB's measured
 * plan is the ANALYZE FORMAT=JSON document (analyzeMariaJson) — the SQL
 * Quality pipeline routes by content, and each side is pinned here with
 * output trimmed from real servers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePlanText, analyzeMariaJson } from '../src/utils/planAnalyze.ts';

describe('analyzeMariaJson (MariaDB ANALYZE FORMAT=JSON)', () => {
  // Trimmed from MariaDB 11.8.8, with t2's estimate made 50× low so the
  // estimation finding has something to fire on.
  const plan = JSON.stringify({
    query_optimization: { r_total_time_ms: 12.4 },
    query_block: {
      select_id: 1, cost: 1040, r_loops: 1, r_total_time_ms: 12.1,
      nested_loop: [
        { table: {
            table_name: 't2', access_type: 'ALL', loops: 1, r_loops: 1,
            rows: 100, r_rows: 5000, cost: 1030, r_total_time_ms: 11.9,
            filtered: 100, r_filtered: 40 } },
        { table: {
            table_name: 't1', access_type: 'eq_ref', key: 'PRIMARY',
            loops: 5000, r_loops: 5000, rows: 1, r_rows: 1, cost: 0.5,
            r_total_time_ms: 0.2, filtered: 100, r_filtered: 100 } },
      ],
    },
  });

  test('a large underestimate is flagged, worst first', () => {
    const out = analyzeMariaJson(plan);
    const f = out.findings.find(x => /underestimated/i.test(x.title));
    assert.ok(f, `no estimation finding: ${JSON.stringify(out.findings.map(x => x.title))}`);
    assert.ok(f.title.includes('t2'), f.title);
    // 5000 actual vs 100 estimated per loop — the severe band.
    assert.equal(f.severity, 'red');
  });

  test('a well-estimated plan is quiet', () => {
    const clean = JSON.stringify({
      query_block: {
        select_id: 1, cost: 0.01, r_loops: 1, r_total_time_ms: 0.05,
        table: {
          table_name: 't', access_type: 'const', key: 'PRIMARY', loops: 1,
          r_loops: 1, rows: 1, r_rows: 1, cost: 0.01, r_total_time_ms: 0.05,
          filtered: 100, r_filtered: 100 },
      },
    });
    const out = analyzeMariaJson(clean);
    assert.deepEqual(out.findings, []);
  });

  test('the measured total reaches the markdown', () => {
    const out = analyzeMariaJson(plan);
    assert.match(out.md, /Total measured time/);
    assert.match(out.md, /t2/);
  });

  test('an inner loop is not misread as a miss by its loop count', () => {
    // t1: 1 row estimated per loop, 1 actual per loop over 5000 loops — a
    // PERFECT estimate. Comparing the totalled actual (5000) against the
    // per-loop estimate (1) would scream 5000×; misestimateOf normalises.
    const out = analyzeMariaJson(plan);
    assert.ok(!out.findings.some(f => f.title.includes('t1')),
      `t1 was falsely flagged: ${JSON.stringify(out.findings.map(f => f.title))}`);
  });

  test('a non-JSON document throws, so the caller can fall back', () => {
    assert.throws(() => analyzeMariaJson('-> Table scan on t'));
  });
});

describe('analyzePlanText (MySQL EXPLAIN ANALYZE tree)', () => {
  test('a MariaDB JSON document is NOT a tree — the routing must not send it here', () => {
    // Parse-zero-nodes is the failure mode qualityRun's content sniff exists
    // to avoid: the JSON plan must go to analyzeMariaJson instead.
    const out = analyzePlanText('{"query_block": {}}');
    assert.equal(out.findings.length, 0);
    assert.match(out.md, /Could not parse/);
  });
});
