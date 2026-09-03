/**
 * MySQL EXPLAIN ANALYZE (TREE) → plan model (src/utils/planTree.ts).
 *
 * This is the only MySQL plan with measured timings, and it arrives as
 * indented prose rather than JSON. The parsing rules that matter:
 *   - `actual time=..T` is PER LOOP and INCLUSIVE of children, so total is
 *     T × loops and self time subtracts the children's totals;
 *   - `rows=N` in the actual block is also per loop;
 *   - the operation labels are prose, so classification matches on phrases and
 *     the order of those checks is load-bearing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMysqlTree, treeKind, treeRelation, treeIndex, looksLikeTree } from '../src/utils/planTree.ts';
import { parsePlan } from '../src/utils/planParse.ts';
import { buildCostModel } from '../src/utils/planCost.ts';

/** Real-shaped output: a nested loop over a full scan, joined to a PK lookup. */
const TREE = `-> Sort: total DESC  (actual time=124.500..124.600 rows=50 loops=1)
    -> Table scan on <temporary>  (actual time=0.001..0.030 rows=50 loops=1)
        -> Aggregate using temporary table  (actual time=124.000..124.100 rows=50 loops=1)
            -> Nested loop inner join  (cost=1450.20 rows=820) (actual time=0.080..98.400 rows=1204 loops=1)
                -> Table scan on o  (cost=120.50 rows=1200) (actual time=0.040..72.300 rows=1204 loops=1)
                -> Single-row index lookup on c using PRIMARY (id=o.customer_id)  (cost=1.10 rows=1) (actual time=0.015..0.016 rows=1 loops=1204)`;

// ── shape ───────────────────────────────────────────────────────────────────

test('the tree is parsed into a single rooted plan', () => {
  const p = parseMysqlTree(TREE);
  assert.equal(p.engine, 'mysql');
  assert.equal(p.measured, true, 'EXPLAIN ANALYZE is measured, not estimated');
  assert.match(p.root.op, /^Sort/);
  assert.equal(p.root.children.length, 1);
});

test('nesting follows the indentation', () => {
  const p = parseMysqlTree(TREE);
  const agg = p.root.children[0].children[0];
  assert.match(agg.op, /Aggregate/);
  const join = agg.children[0];
  assert.match(join.op, /Nested loop/);
  assert.equal(join.children.length, 2, 'the join should have both inputs');
});

// ── the arithmetic, which is where this gets it wrong or right ──────────────

test('actual time is multiplied by loops to get total wall time', () => {
  const p = parseMysqlTree(TREE);
  const lookup = p.root.children[0].children[0].children[0].children[1];
  assert.match(lookup.op, /Single-row index lookup/);
  assert.equal(lookup.stats.loops, 1204);
  // 0.016 ms per loop × 1204 loops ≈ 19.3 ms — the loop multiplication is the
  // whole point: per-loop it looks free, in aggregate it is not.
  assert.ok(Math.abs(lookup.stats.msTotal! - 19.264) < 0.01,
    `got ${lookup.stats.msTotal}`);
});

test('actual rows are also per loop and get multiplied', () => {
  const p = parseMysqlTree(TREE);
  const lookup = p.root.children[0].children[0].children[0].children[1];
  assert.equal(lookup.stats.rowsActual, 1204, '1 row × 1204 loops');
});

test('self time subtracts the children, so the root is not the bottleneck', () => {
  const p = parseMysqlTree(TREE);
  const join = p.root.children[0].children[0].children[0];
  // The join's inclusive time is 98.4 ms; its children account for
  // 72.3 + 19.26, so its own work is the remainder — not the whole 98.4.
  assert.ok(join.stats.msSelf! < join.stats.msTotal!,
    'self time must exclude children');
  assert.ok(Math.abs(join.stats.msSelf! - (98.4 - 72.3 - 19.264)) < 0.05,
    `got ${join.stats.msSelf}`);
});

test('the cost model finds the real hottest node, not the root', () => {
  const model = buildCostModel(parseMysqlTree(TREE));
  assert.equal(model.basis, 'time');
  // The full table scan does the most actual work of any single node.
  assert.match(model.ranked[0].node.op, /Table scan/);
  assert.equal(model.ranked[0].node.stats.relation, 'o');
});

test('self times sum back to the execution time across a materialisation', () => {
  // The regression guard for MySQL's temp-table reporting: Sort 124.6 ms sits
  // above a <temporary> scan of 0.03 ms which sits above the 124.1 ms
  // Aggregate that filled it. Subtracting the immediate child made the self
  // times total 248 ms for a 124 ms query.
  const model = buildCostModel(parseMysqlTree(TREE));
  assert.ok(Math.abs(model.total - 124.6) < 0.1,
    `self times summed to ${model.total.toFixed(2)}, expected ~124.6`);
});

test('estimates are kept alongside the measurements', () => {
  const p = parseMysqlTree(TREE);
  const scan = p.root.children[0].children[0].children[0].children[0];
  assert.equal(scan.stats.rowsEst, 1200);
  assert.equal(scan.stats.costTotal, 120.50);
  assert.equal(scan.stats.rowsActual, 1204);
});

// ── classification ──────────────────────────────────────────────────────────

test('operation labels are classified into the shared kinds', () => {
  assert.equal(treeKind('Table scan on o'), 'scan-seq');
  assert.equal(treeKind('Nested loop inner join'), 'join-nested');
  assert.equal(treeKind('Hash join (no condition)'), 'join-hash');
  assert.equal(treeKind('Sort: total DESC'), 'sort');
  assert.equal(treeKind('Aggregate using temporary table'), 'aggregate');
  assert.equal(treeKind('Limit: 10 row(s)'), 'limit');
  assert.equal(treeKind('Filter: (o.total > 100)'), 'other');
});

test('a single-row lookup is a constant, not a generic index scan', () => {
  // Order matters: the looser "index lookup" test must not win first.
  assert.equal(treeKind('Single-row index lookup on c using PRIMARY'), 'scan-const');
  assert.equal(treeKind('Index lookup on c using idx_cust'), 'scan-index');
  assert.equal(treeKind('Covering index scan on t using idx_a'), 'scan-index');
});

test('a scan over a temporary table is a materialisation, not a table scan', () => {
  // Flagging <temporary> as a full scan would fire a "missing index" warning
  // about an intermediate result the user cannot index.
  assert.equal(treeKind('Table scan on <temporary>'), 'materialize');
  assert.equal(treeKind('Table scan on <union1,2>'), 'materialize');
});

test('the relation and index are pulled out of the prose label', () => {
  assert.equal(treeRelation('Table scan on orders'), 'orders');
  assert.equal(treeRelation('Index lookup on c using PRIMARY (id=o.customer_id)'), 'c');
  assert.equal(treeIndex('Index lookup on c using PRIMARY (id=o.customer_id)'), 'PRIMARY');
  // A temporary is not a real relation and must not be reported as one.
  assert.equal(treeRelation('Table scan on <temporary>'), undefined);
  assert.equal(treeIndex('Table scan on orders'), undefined);
});

test('a full scan is flagged, a materialisation is not', () => {
  const p = parseMysqlTree(TREE);
  const scan = p.root.children[0].children[0].children[0].children[0];
  assert.ok(scan.stats.flags?.includes('full-scan'));
  const temp = p.root.children[0];
  assert.ok(!(temp.stats.flags ?? []).includes('full-scan'),
    '<temporary> must not be reported as a full table scan');
});

// ── format detection and routing ────────────────────────────────────────────

test('TREE text is distinguished from JSON', () => {
  assert.equal(looksLikeTree(TREE), true);
  assert.equal(looksLikeTree('{"query_block": {}}'), false);
  assert.equal(looksLikeTree('[{"Plan": {}}]'), false);
  assert.equal(looksLikeTree('some unrelated output'), false);
});

test('parsePlan routes MySQL TREE output without being told the format', () => {
  // The bug this closes: EXPLAIN ANALYZE on MySQL used to fall through to a
  // raw text dump, losing the graph for the only plan with real timings.
  const p = parsePlan('mysql', TREE);
  assert.equal(p.measured, true);
  assert.match(p.root.op, /^Sort/);
});

test('parsePlan still routes MySQL JSON to the estimate parser', () => {
  const json = JSON.stringify({ query_block: { select_id: 1, cost_info: { query_cost: '42.5' },
    table: { table_name: 't', access_type: 'ALL', rows_examined_per_scan: 900,
             cost_info: { prefix_cost: '42.5', read_cost: '30', eval_cost: '12.5' } } } });
  const p = parsePlan('mysql', json);
  assert.equal(p.measured, false, 'FORMAT=JSON is estimates only');
});

test('unparseable output throws so the caller can show the raw text', () => {
  assert.throws(() => parsePlan('mysql', 'Query OK, 0 rows affected'));
  assert.throws(() => parsePlan('postgres', 'not json at all'));
  assert.throws(() => parsePlan('clickhouse', 'Expression'));
});

test('a never-executed branch is recorded rather than dropped', () => {
  const t = `-> Nested loop inner join  (cost=2.0 rows=1) (actual time=0.1..0.2 rows=1 loops=1)
    -> Table scan on a  (cost=1.0 rows=1) (actual time=0.1..0.1 rows=1 loops=1)
    -> Index lookup on b using PRIMARY  (never executed)`;
  const p = parseMysqlTree(t);
  const never = p.root.children[1];
  assert.ok(never.stats.flags?.includes('never-executed'));
  // No timings to draw, but the node must still be in the graph.
  assert.equal(never.stats.msTotal, undefined);
});
