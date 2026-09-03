/**
 * Plan geometry (src/utils/planLayout.ts) and the cost model behind it
 * (src/utils/planCost.ts).
 *
 * The layout is worth testing precisely because it is invisible when it works:
 * a collision at depth 4 of a wide plan looks like a rendering glitch, not a
 * geometry bug, and nobody reports it. These assertions are structural — no
 * overlaps at any depth, children centred under parents, determinism — so they
 * hold for any plan rather than for one fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, layoutIcicle, DEFAULT_LAYOUT } from '../src/utils/planLayout.ts';
import { buildCostModel, severityOf, misestimateOf, formatRows, formatWeight } from '../src/utils/planCost.ts';
import type { PlanNode, ParsedPlan, PlanNodeKind } from '../src/utils/planParse.ts';

// ── builders ────────────────────────────────────────────────────────────────

function node(
  op: string,
  children: PlanNode[] = [],
  stats: PlanNode['stats'] = {},
  kind: PlanNodeKind = 'other',
): PlanNode {
  return { op, detail: '', metrics: {}, severity: 0, kind, stats, children };
}
const plan = (root: PlanNode, measured = false): ParsedPlan => ({
  root, metricColumns: [], summary: '', measured, engine: 'postgres',
});

/** Every pair of boxes at the same depth must be clear of each other. */
function assertNoOverlaps(layout: ReturnType<typeof layoutGraph>) {
  const byDepth = new Map<number, typeof layout.nodes>();
  for (const n of layout.nodes) {
    const list = byDepth.get(n.depth) ?? [];
    list.push(n);
    byDepth.set(n.depth, list);
  }
  for (const [depth, list] of byDepth) {
    const sorted = [...list].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i].x - sorted[i].width / 2)
                - (sorted[i - 1].x + sorted[i - 1].width / 2);
      assert.ok(
        gap >= -0.01,
        `depth ${depth}: "${sorted[i - 1].node.op}" and "${sorted[i].node.op}" overlap by ${(-gap).toFixed(1)}px`,
      );
    }
  }
}

// ── tidy tree ───────────────────────────────────────────────────────────────

test('a single node lays out without collapsing to zero size', () => {
  const l = layoutGraph(node('Seq Scan'));
  assert.equal(l.nodes.length, 1);
  assert.ok(l.width > 0 && l.height > 0);
  assert.equal(l.edges.length, 0);
});

test('leaves sit at the bottom and the root at the top', () => {
  // Data flows upward: the scan is read first and drawn lowest.
  const l = layoutGraph(node('Result', [node('Seq Scan')]));
  const root = l.byPath.get('0')!;
  const leaf = l.byPath.get('0.0')!;
  assert.ok(leaf.y > root.y, 'the leaf must be below the root');
});

test('siblings never overlap, however lopsided the tree', () => {
  // One deep bushy branch beside a shallow one is the case a naive
  // "equal slice per subtree" layout gets wrong.
  const deep = node('Hash Join', [
    node('Hash Join', [
      node('Seq Scan'), node('Seq Scan'), node('Seq Scan'),
    ]),
    node('Hash Join', [node('Seq Scan'), node('Seq Scan')]),
  ]);
  const l = layoutGraph(node('Result', [deep, node('Index Scan')]));
  assertNoOverlaps(l);
});

test('a subtree reaching under two siblings is still cleared', () => {
  // The contour has to be checked against every earlier sibling, not just the
  // previous one — a wide third child can collide with the first.
  const l = layoutGraph(node('Append', [
    node('A', [node('a1'), node('a2'), node('a3'), node('a4')]),
    node('B'),
    node('C', [node('c1', [node('c1a'), node('c1b')]), node('c2')]),
  ]));
  assertNoOverlaps(l);
});

test('deep and wide plans stay overlap-free', () => {
  const build = (d: number): PlanNode =>
    d === 0 ? node('Seq Scan') : node(`Join ${d}`, [build(d - 1), build(d - 1)]);
  const l = layoutGraph(build(5));   // 63 nodes
  assert.equal(l.nodes.length, 63);
  assertNoOverlaps(l);
});

test('a parent is centred over its children', () => {
  const l = layoutGraph(node('Hash Join', [node('Seq Scan'), node('Index Scan')]));
  const root = l.byPath.get('0')!;
  const a = l.byPath.get('0.0')!;
  const b = l.byPath.get('0.1')!;
  assert.ok(Math.abs(root.x - (a.x + b.x) / 2) < 0.5, 'parent is not centred');
});

test('collapsing a subtree reclaims its space', () => {
  const tree = node('Result', [
    node('Hash Join', [node('Seq Scan'), node('Seq Scan'), node('Seq Scan')]),
    node('Index Scan'),
  ]);
  const open = layoutGraph(tree);
  const shut = layoutGraph(tree, new Set(['0.0']));
  assert.ok(shut.width < open.width, 'collapsing did not narrow the layout');
  assert.equal(shut.nodes.length, 3, 'collapsed children must not be laid out');
  assertNoOverlaps(shut);
});

test('layout is deterministic — same input, same geometry', () => {
  const tree = node('Result', [node('A', [node('a1'), node('a2')]), node('B')]);
  const a = layoutGraph(tree);
  const b = layoutGraph(tree);
  assert.deepEqual(a.nodes.map(n => [n.path, n.x, n.y]), b.nodes.map(n => [n.path, n.x, n.y]));
});

test('every box sits inside the reported canvas', () => {
  const l = layoutGraph(node('Result', [
    node('A', [node('a1'), node('a2'), node('a3')]),
    node('B', [node('b1')]),
  ]));
  for (const n of l.nodes) {
    assert.ok(n.x - n.width / 2 >= 0, `${n.node.op} escapes the left edge`);
    assert.ok(n.x + n.width / 2 <= l.width + 0.01, `${n.node.op} escapes the right edge`);
    assert.ok(n.y - n.height / 2 >= 0, `${n.node.op} escapes the top`);
    assert.ok(n.y + n.height / 2 <= l.height + 0.01, `${n.node.op} escapes the bottom`);
  }
});

// ── edges ───────────────────────────────────────────────────────────────────

test('edge weights are each child\'s share of the rows reaching the parent', () => {
  const l = layoutGraph(node('Hash Join', [
    node('Seq Scan', [], { rowsEst: 1_200_000 }),
    node('Index Scan', [], { rowsEst: 800 }),
  ]));
  const [big, small] = l.edges;
  assert.ok(big.weight > 0.99, 'the 1.2M-row side should dominate');
  assert.ok(small.weight < 0.01);
  assert.ok(Math.abs(big.weight + small.weight - 1) < 1e-9, 'weights must sum to 1');
});

test('edge weights fall back to an even split when no row counts exist', () => {
  const l = layoutGraph(node('Join', [node('A'), node('B')]));
  for (const e of l.edges) assert.equal(e.weight, 0.5);
});

test('edge paths start at the child and end at the parent', () => {
  const l = layoutGraph(node('Result', [node('Seq Scan')]));
  const e = l.edges[0];
  assert.match(e.d, /^M [\d.]+ [\d.]+ C /);
  assert.equal(e.from.path, '0.0');
  assert.equal(e.to.path, '0');
});

// ── cost model ──────────────────────────────────────────────────────────────

test('a measured plan is weighted by time, an estimated one by cost', () => {
  const measured = buildCostModel(plan(
    node('Result', [], { msSelf: 12, costSelf: 999 }), true));
  assert.equal(measured.basis, 'time');
  assert.equal(measured.nodes[0].weight, 12);

  const estimated = buildCostModel(plan(
    node('Result', [], { costSelf: 999 }), false));
  assert.equal(estimated.basis, 'cost');
  assert.equal(estimated.nodes[0].weight, 999);
});

test('severity is relative to the hottest node, not to absolute time', () => {
  // The same shape must read the same whether the plan took 2 ms or 40 s —
  // an absolute scale makes fast plans uniformly cold and slow plans uniformly
  // red, and in both cases tells you nothing.
  const shape = (scale: number) => buildCostModel(plan(node('Result', [
    node('Hot', [], { msSelf: 100 * scale }),
    node('Cold', [], { msSelf: 1 * scale }),
  ], { msSelf: 0 }), true));
  const fast = shape(0.02);
  const slow = shape(400);
  assert.deepEqual(
    fast.nodes.map(n => n.severity),
    slow.nodes.map(n => n.severity),
  );
  assert.equal(fast.byPath.get('0.0')!.severity, 'critical');
});

test('severity bands cover the whole 0..1 range in order', () => {
  assert.equal(severityOf(0), 'none');
  assert.equal(severityOf(0.01), 'none');
  assert.equal(severityOf(0.05), 'mild');
  assert.equal(severityOf(0.2), 'warm');
  assert.equal(severityOf(0.5), 'hot');
  assert.equal(severityOf(1), 'critical');
  assert.equal(severityOf(NaN), 'none');
});

test('shares sum to one across the plan', () => {
  const m = buildCostModel(plan(node('Result', [
    node('A', [], { msSelf: 30 }),
    node('B', [], { msSelf: 70 }),
  ], { msSelf: 0 }), true));
  const sum = m.nodes.reduce((s, n) => s + n.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `shares summed to ${sum}`);
});

test('a plan where every node weighs zero does not divide by zero', () => {
  const m = buildCostModel(plan(node('Result', [node('A'), node('B')])));
  assert.equal(m.total, 0);
  assert.equal(m.peak, 0);
  assert.deepEqual(m.ranked, []);
  for (const n of m.nodes) {
    assert.equal(n.share, 0);
    assert.equal(n.severity, 'none');
    assert.ok(Number.isFinite(n.relative));
  }
});

test('cumulative weight includes children', () => {
  const m = buildCostModel(plan(node('Root', [
    node('A', [], { msSelf: 10 }),
    node('B', [], { msSelf: 20 }),
  ], { msSelf: 5 }), true));
  assert.equal(m.byPath.get('0')!.weightTotal, 35);
  assert.equal(m.byPath.get('0')!.weight, 5, 'self weight excludes children');
});

test('ranked lists the hottest node first', () => {
  const m = buildCostModel(plan(node('Root', [
    node('Cheap', [], { msSelf: 2 }),
    node('Expensive', [], { msSelf: 90 }),
  ], { msSelf: 1 }), true));
  assert.equal(m.ranked[0].node.op, 'Expensive');
});

// ── mis-estimation ──────────────────────────────────────────────────────────

test('mis-estimation is symmetric and ignores trivial row counts', () => {
  assert.equal(misestimateOf(node('n', [], { rowsEst: 100, rowsActual: 10_000 })), 100);
  assert.equal(misestimateOf(node('n', [], { rowsEst: 10_000, rowsActual: 100 })), 100);
  // Both sides tiny — a 12× "error" on 1 row is noise, not a finding.
  assert.equal(misestimateOf(node('n', [], { rowsEst: 1, rowsActual: 9 })), undefined);
  // Missing measurement means nothing to compare against.
  assert.equal(misestimateOf(node('n', [], { rowsEst: 500 })), undefined);
});

test('an estimate of zero rows does not produce Infinity', () => {
  const r = misestimateOf(node('n', [], { rowsEst: 0, rowsActual: 50_000 }));
  assert.ok(Number.isFinite(r!), `got ${r}`);
  assert.equal(r, 50_000);
});

// ── icicle ──────────────────────────────────────────────────────────────────

test('icicle children are packed inside their parent and never exceed it', () => {
  const tree = node('Root', [
    node('A', [], { msSelf: 30 }),
    node('B', [], { msSelf: 60 }),
  ], { msSelf: 10 });
  const cells = layoutIcicle(tree, buildCostModel(plan(tree, true)));
  const root = cells.find(c => c.path === '0')!;
  assert.equal(root.x0, 0);
  assert.equal(root.x1, 1);
  for (const c of cells) {
    assert.ok(c.x0 >= -1e-9 && c.x1 <= 1 + 1e-9, `${c.node.op} escapes [0,1]`);
    assert.ok(c.x1 >= c.x0, `${c.node.op} has negative width`);
  }
  // B did twice the work of A, so it gets twice the width.
  const a = cells.find(c => c.path === '0.0')!;
  const b = cells.find(c => c.path === '0.1')!;
  assert.ok(Math.abs((b.x1 - b.x0) / (a.x1 - a.x0) - 2) < 1e-6);
});

test('a node\'s own self cost shows as the gap its children do not fill', () => {
  // Root does 50 of the 100 units itself; children may cover only half.
  const tree = node('Root', [node('A', [], { msSelf: 50 })], { msSelf: 50 });
  const cells = layoutIcicle(tree, buildCostModel(plan(tree, true)));
  const a = cells.find(c => c.path === '0.0')!;
  assert.ok(Math.abs((a.x1 - a.x0) - 0.5) < 1e-9, 'child should fill half the parent');
});

test('a weightless plan gets uniform widths, not an empty view or NaN geometry', () => {
  // ClickHouse plans carry no weights at all (no cost model): the icicle still
  // shows the plan's shape, with siblings sharing the parent's span equally.
  const tree = node('Root', [node('A'), node('B', [node('C'), node('D')])]);
  const cells = layoutIcicle(tree, buildCostModel(plan(tree)));
  const byPath = new Map(cells.map(c => [c.path, c]));
  const a = byPath.get('0.0')!;
  const b = byPath.get('0.1')!;
  assert.ok(Math.abs((a.x1 - a.x0) - 0.5) < 1e-9, `A width ${a.x1 - a.x0}`);
  assert.ok(Math.abs(b.x0 - 0.5) < 1e-9 && Math.abs(b.x1 - 1) < 1e-9);
  const c = byPath.get('0.1.0')!;
  const d = byPath.get('0.1.1')!;
  assert.ok(Math.abs((c.x1 - c.x0) - 0.25) < 1e-9, `C width ${c.x1 - c.x0}`);
  assert.ok(Math.abs((d.x1 - d.x0) - 0.25) < 1e-9, `D width ${d.x1 - d.x0}`);
  for (const cell of cells) {
    assert.ok(Number.isFinite(cell.x0) && Number.isFinite(cell.x1));
  }
});

// ── formatting ──────────────────────────────────────────────────────────────

test('weights read in the unit they are actually in', () => {
  assert.equal(formatWeight(0.42, 'time'), '0.42 ms');
  assert.equal(formatWeight(31.24, 'time'), '31.2 ms');
  assert.equal(formatWeight(4200, 'time'), '4.20 s');
  assert.match(formatWeight(18400, 'cost'), /^cost 18,400$/);
});

test('row counts compact without lying about magnitude', () => {
  assert.equal(formatRows(812), '812');
  assert.equal(formatRows(4800), '4.8k');
  assert.equal(formatRows(1_200_000), '1.2M');
  assert.equal(formatRows(undefined), '—');
});

test('layout constants are sane', () => {
  assert.ok(DEFAULT_LAYOUT.nodeWidth > 0 && DEFAULT_LAYOUT.nodeHeight > 0);
  assert.ok(DEFAULT_LAYOUT.hGap > 0 && DEFAULT_LAYOUT.vGap > 0);
});
