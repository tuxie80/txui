/**
 * ER diagram geometry (src/utils/erLayout.ts): layered FK layout, edge
 * routing, focus sets and zoom-to-fit math.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ER_NODE_W, ER_ROW_H, contentBounds, erNodeH, fitTransform, focusSet,
  layoutEr, routeEdge, tableDepths,
  ER_HEADER_H, erNodeHAt, intersects, viewportRect, visibleColumns,
  type ErEdge, type ErTable,
} from '../src/utils/erLayout.ts';

const tbl = (name: string, cols: string[]): ErTable => ({
  name,
  columns: cols.map(c => ({ name: c, type: 'int', pk: c === 'id', fk: false, unique: false })),
});

// departments ← employees ← {assignments, salaries} (the hr_demo shape)
const TABLES = [
  tbl('departments', ['id', 'name']),
  tbl('employees', ['id', 'department_id', 'name', 'email']),
  tbl('assignments', ['id', 'employee_id', 'project']),
  tbl('salaries', ['id', 'employee_id', 'amount']),
];
const EDGES: ErEdge[] = [
  { fromTable: 'employees', fromCol: 'department_id', toTable: 'departments', toCol: 'id', constraint: 'employees_ibfk_1' },
  { fromTable: 'assignments', fromCol: 'employee_id', toTable: 'employees', toCol: 'id', constraint: 'assignments_ibfk_1' },
  { fromTable: 'salaries', fromCol: 'employee_id', toTable: 'employees', toCol: 'id', constraint: 'salaries_ibfk_1' },
];

test('depth: parents are shallower than their children', () => {
  const d = tableDepths(TABLES, EDGES);
  assert.equal(d.get('departments'), 0);
  assert.equal(d.get('employees'), 1);
  assert.equal(d.get('assignments'), 2);
  assert.equal(d.get('salaries'), 2);
});

test('depth: cycles terminate instead of recursing forever', () => {
  const cyc: ErEdge[] = [
    { fromTable: 'a', fromCol: 'b_id', toTable: 'b', toCol: 'id' },
    { fromTable: 'b', fromCol: 'a_id', toTable: 'a', toCol: 'id' },
  ];
  // Terminates; one side of the cycle gets depth 1, the other at most 2
  // (the back-edge is cut during the DFS).
  const d = tableDepths([tbl('a', ['id', 'b_id']), tbl('b', ['id', 'a_id'])], cyc);
  assert.ok(d.get('a')! <= 2 && d.get('b')! <= 2);
});

test('depth: self-references are ignored', () => {
  const d = tableDepths([tbl('cats', ['id', 'parent_id'])],
    [{ fromTable: 'cats', fromCol: 'parent_id', toTable: 'cats', toCol: 'id' }]);
  assert.equal(d.get('cats'), 0);
});

test('layout: every table gets a position, layers go left → right', () => {
  const pos = layoutEr(TABLES, EDGES);
  assert.equal(pos.size, TABLES.length);
  assert.ok(pos.get('departments')!.x < pos.get('employees')!.x);
  assert.ok(pos.get('employees')!.x < pos.get('assignments')!.x);
  assert.equal(pos.get('assignments')!.x, pos.get('salaries')!.x); // same layer
});

test('layout: no two tables in a layer overlap vertically', () => {
  const pos = layoutEr(TABLES, EDGES);
  const byX = new Map<number, { y: number; h: number }[]>();
  for (const t of TABLES) {
    const p = pos.get(t.name)!;
    if (!byX.has(p.x)) byX.set(p.x, []);
    byX.get(p.x)!.push({ y: p.y, h: erNodeH(t) });
  }
  for (const boxes of byX.values()) {
    boxes.sort((a, b) => a.y - b.y);
    for (let i = 1; i < boxes.length; i++) {
      assert.ok(boxes[i].y >= boxes[i - 1].y + boxes[i - 1].h,
        `overlap: ${JSON.stringify(boxes)}`);
    }
  }
});

test('layout: unrelated tables go to an island region, not layer 0', () => {
  const withIsland = [...TABLES, tbl('audit_log', ['id', 'msg'])];
  const pos = layoutEr(withIsland, EDGES);
  const layeredRight = Math.max(...TABLES.map(t => pos.get(t.name)!.x));
  assert.ok(pos.get('audit_log')!.x > layeredRight);
});

test('layout: a schema with no FKs still shelf-packs without overlap', () => {
  const many = Array.from({ length: 20 }, (_, i) => tbl(`t${i}`, ['id', 'a', 'b']));
  const pos = layoutEr(many, []);
  assert.equal(pos.size, 20);
  const seen = new Set<string>();
  for (const p of pos.values()) {
    const key = `${p.x},${p.y}`;
    assert.ok(!seen.has(key), `duplicate slot ${key}`);
    seen.add(key);
  }
});

test('route: forward edges exit right and enter left with a valid bezier', () => {
  const r = routeEdge({ x: 100, y: 100 }, 1, { x: 500, y: 40 }, 0, 'child', 'parent');
  assert.equal(r.sx, 100 + ER_NODE_W);
  assert.equal(r.tx, 500);
  assert.equal(r.srcSide, 'right');
  assert.equal(r.dstSide, 'left');
  assert.match(r.d, /^M [\d.]+ [\d.]+ C /);
  assert.equal(r.sy, 100 + 30 + 1 * ER_ROW_H + ER_ROW_H / 2);
  assert.equal(r.ty, 40 + 30 + ER_ROW_H / 2);
});

test('route: backward edges exit left and enter right', () => {
  const r = routeEdge({ x: 500, y: 100 }, 0, { x: 100, y: 100 }, 0, 'child', 'parent');
  assert.equal(r.sx, 500);
  assert.equal(r.tx, 100 + ER_NODE_W);
  assert.equal(r.srcSide, 'left');
  assert.equal(r.dstSide, 'right');
});

test('route: self-references loop off the right side', () => {
  const r = routeEdge({ x: 100, y: 100 }, 0, { x: 100, y: 100 }, 1, 'cats', 'cats');
  assert.ok(r.selfLoop);
  assert.equal(r.sx, 100 + ER_NODE_W);
  assert.equal(r.tx, 100 + ER_NODE_W);
});

test('focus: selection includes direct neighbours in both directions', () => {
  const f = focusSet('employees', EDGES);
  assert.deepEqual([...f].sort(), ['assignments', 'departments', 'employees', 'salaries']);
  assert.deepEqual([...focusSet('assignments', EDGES)].sort(), ['assignments', 'employees']);
  assert.equal(focusSet(null, EDGES).size, 0);
});

test('fit: large content shrinks to the viewport, centered', () => {
  const t = fitTransform({ w: 2000, h: 1000 }, 1000, 700);
  assert.ok(t.s <= 0.5);
  assert.equal(t.x, (1000 - 2000 * t.s) / 2);
  assert.equal(t.y, (700 - 1000 * t.s) / 2);
});

test('fit: small content is centered at 100%, never upscaled', () => {
  const t = fitTransform({ w: 400, h: 300 }, 1000, 700);
  assert.equal(t.s, 1);
  assert.equal(t.x, 300);
  assert.equal(t.y, 200);
});

test('bounds: cover all nodes with padding', () => {
  const pos = layoutEr(TABLES, EDGES);
  const b = contentBounds(TABLES, pos);
  for (const t of TABLES) {
    const p = pos.get(t.name)!;
    assert.ok(b.w >= p.x + ER_NODE_W);
    assert.ok(b.h >= p.y + erNodeH(t));
  }
});

// ── Density, viewport culling ───────────────────────────────────────────────
// Added with the saved-diagram work: a diagram you can keep is a diagram
// people fill up, so the canvas has to stay cheap at a few hundred tables.

const col = (name: string, k: Partial<{ pk: boolean; fk: boolean; unique: boolean }> = {}) =>
  ({ name, type: 'int', pk: !!k.pk, fk: !!k.fk, unique: !!k.unique });

test('density all keeps every column', () => {
  const cols = [col('id', { pk: true }), col('note'), col('x')];
  assert.equal(visibleColumns(cols, 'all').length, 3);
});

test('density keys keeps only the columns a relationship diagram is about', () => {
  const cols = [col('id', { pk: true }), col('cust', { fk: true }), col('sku', { unique: true }), col('note'), col('x')];
  assert.deepEqual(visibleColumns(cols, 'keys').map(c => c.name), ['id', 'cust', 'sku']);
});

test('density header keeps none', () => {
  assert.equal(visibleColumns([col('id', { pk: true })], 'header').length, 0);
});

test('node height follows the density', () => {
  const t = { columns: [col('id', { pk: true }), col('a'), col('b')] };
  assert.equal(erNodeHAt(t, 'all'), ER_HEADER_H + 3 * ER_ROW_H);
  assert.equal(erNodeHAt(t, 'keys'), ER_HEADER_H + 1 * ER_ROW_H);
  assert.equal(erNodeHAt(t, 'header'), ER_HEADER_H);
});

test('a node inside the viewport is kept and one far outside is culled', () => {
  const view = viewportRect({ x: 0, y: 0, s: 1 }, 800, 600, 0);
  assert.equal(intersects({ x: 10, y: 10 }, 230, 100, view), true);
  assert.equal(intersects({ x: 5000, y: 5000 }, 230, 100, view), false);
});

test('a node straddling the edge is kept, not clipped away', () => {
  const view = viewportRect({ x: 0, y: 0, s: 1 }, 800, 600, 0);
  assert.equal(intersects({ x: -100, y: 10 }, 230, 100, view), true, 'overlaps the left edge');
  assert.equal(intersects({ x: 790, y: 10 }, 230, 100, view), true, 'overlaps the right edge');
});

/// Nodes just off-screen must already be mounted, or panning flickers.
test('the margin keeps nearby nodes alive', () => {
  const tight = viewportRect({ x: 0, y: 0, s: 1 }, 800, 600, 0);
  const loose = viewportRect({ x: 0, y: 0, s: 1 }, 800, 600, 300);
  assert.equal(intersects({ x: 900, y: 10 }, 230, 100, tight), false);
  assert.equal(intersects({ x: 900, y: 10 }, 230, 100, loose), true);
});

test('zooming out widens the viewport in diagram coordinates', () => {
  const inClose = viewportRect({ x: 0, y: 0, s: 2 }, 800, 600, 0);
  const outFar  = viewportRect({ x: 0, y: 0, s: 0.5 }, 800, 600, 0);
  assert.equal(inClose.w, 400);
  assert.equal(outFar.w, 1600);
});

test('panning moves the viewport the opposite way', () => {
  const v = viewportRect({ x: -500, y: -250, s: 1 }, 800, 600, 0);
  assert.equal(v.x, 500);
  assert.equal(v.y, 250);
});

/// A zero scale would divide to Infinity and cull everything — the canvas
/// would go blank with no way back.
test('a zero scale does not produce an infinite viewport', () => {
  const v = viewportRect({ x: 0, y: 0, s: 0 }, 800, 600, 0);
  assert.ok(Number.isFinite(v.w) && v.w > 0, `got ${v.w}`);
});
