// Tests for src/utils/gridWindow.ts — FastGrid's vertical window math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridWindow } from '../src/utils/gridWindow.ts';

const BASE = {
  scrollTop: 0,
  jumpPx: 0,
  viewH: 500,
  rowH: 25,
  headerH: 31,
  nRows: 100_000,
  overscanFloor: 12,
  maxOverscanVp: 2,
};

test('at rest the window covers the viewport plus one viewport of overscan', () => {
  const w = gridWindow({ ...BASE, scrollTop: 5000 });
  // vpRows = 20; overscan = max(12, min(40, 0 + 20)) = 20
  assert.equal(w.overscanRows, 20);
  // visible rows: (5000-31)/25 = 198.76 → 198 .. (5500-31)/25 = 218.76 → 219
  assert.equal(w.rowStart, 198 - 20);
  assert.equal(w.rowEnd, 219 + 20);
});

test('floor applies when one viewport is fewer rows than the floor', () => {
  // rowH 100 → vpRows = 5 < floor 12
  const w = gridWindow({ ...BASE, rowH: 100, scrollTop: 2000 });
  assert.equal(w.overscanRows, 12);
});

test('overscan scales with the uncommitted gap', () => {
  const w = gridWindow({ ...BASE, scrollTop: 5000, jumpPx: 500 }); // 20 rows of gap
  // gap rows + 1 viewport = 20 + 20 = 40, within the 2-viewport cap (40)
  assert.equal(w.overscanRows, 40);
});

test('overscan is capped at maxOverscanVp viewports per side', () => {
  const w = gridWindow({ ...BASE, scrollTop: 5000, jumpPx: 100_000 });
  assert.equal(w.overscanRows, 40); // 2 × vpRows(20), not 4020
  // …and the viewport itself is still fully covered despite the cap
  const firstVisible = Math.floor((5000 - 31) / 25);
  const lastVisible = Math.ceil((5000 + 500 - 31) / 25);
  assert.ok(w.rowStart <= firstVisible);
  assert.ok(w.rowEnd >= lastVisible);
});

test('stale scrollTop beyond the shrunk content is clamped — window never empty', () => {
  const w = gridWindow({ ...BASE, nRows: 100, scrollTop: 500_000 });
  // totalH = 31 + 2500 = 2531; effTop = 2531 - 500 = 2031
  assert.equal(w.effTop, 2031);
  assert.ok(w.rowStart < w.rowEnd, 'window must not be empty');
  assert.equal(w.rowEnd, 100);
});

test('window at row 0 never goes negative', () => {
  const w = gridWindow({ ...BASE, scrollTop: 0 });
  assert.equal(w.rowStart, 0);
  assert.ok(w.rowEnd > 0);
});

test('empty result stays empty', () => {
  const w = gridWindow({ ...BASE, nRows: 0, scrollTop: 100 });
  assert.equal(w.rowStart, 0);
  assert.equal(w.rowEnd, 0);
});
