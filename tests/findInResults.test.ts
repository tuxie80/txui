import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanCells,
  FIND_MATCH_CAP,
  FIND_CELL_CAP,
} from '../src/utils/findInResults.ts';

test('empty or whitespace query scans nothing and matches nothing', () => {
  const rows = [['a', 'b'], ['c', 'd']];
  assert.deepEqual(scanCells(rows, 2, ''), { matches: [], scanned: 0, capped: false, matchesCapped: false });
  assert.deepEqual(scanCells(rows, 2, '   '), { matches: [], scanned: 0, capped: false, matchesCapped: false });
});

test('substring match is case-insensitive on both sides', () => {
  const rows = [['Alice', 'SMITH'], ['bob', 'smithereens']];
  const scan = scanCells(rows, 2, 'smith');
  assert.deepEqual(scan.matches, [{ r: 0, c: 1 }, { r: 1, c: 1 }]);
  assert.equal(scan.scanned, 4);
  assert.equal(scan.capped, false);
  assert.equal(scan.matchesCapped, false);
});

test('null and undefined cells are skipped, never matched', () => {
  const rows: unknown[][] = [[null, undefined, 'null']];
  const scan = scanCells(rows, 3, 'null');
  // Only the string 'null' matches — a NULL cell must not find as the word.
  assert.deepEqual(scan.matches, [{ r: 0, c: 2 }]);
  assert.equal(scan.scanned, 3);
});

test('object cells are searched as their JSON text', () => {
  const rows: unknown[][] = [
    [{ a: 1, b: 'needle' }, 42],
    ['[object Object]', 'x'],
  ];
  const scan = scanCells(rows, 2, 'needle');
  assert.deepEqual(scan.matches, [{ r: 0, c: 0 }]);
  // And a number inside a JSON cell is findable too.
  assert.deepEqual(scanCells(rows, 2, '"a":1').matches, [{ r: 0, c: 0 }]);
});

test('numbers and booleans match their string form', () => {
  const rows: unknown[][] = [[1234, true]];
  assert.deepEqual(scanCells(rows, 2, '234').matches, [{ r: 0, c: 0 }]);
  assert.deepEqual(scanCells(rows, 2, 'true').matches, [{ r: 0, c: 1 }]);
});

test('match cap stops collection and reports matchesCapped', () => {
  const rows: unknown[][] = [['x', 'x', 'x', 'x']];
  const scan = scanCells(rows, 4, 'x', 3, 1000);
  assert.equal(scan.matches.length, 3);
  assert.equal(scan.matchesCapped, true);
  assert.equal(scan.capped, true);
  assert.equal(scan.scanned, 3);
});

test('cell cap stops the scan mid-grid and reports capped + scanned', () => {
  // 10×10 grid, cap at 25 cells → stops after 25, even with no matches.
  const rows: unknown[][] = Array.from({ length: 10 }, () => Array(10).fill('nope'));
  const scan = scanCells(rows, 10, 'absent', 5000, 25);
  assert.equal(scan.matches.length, 0);
  assert.equal(scan.capped, true);
  assert.equal(scan.scanned, 25);
});

test('a fully scanned grid is not capped, even at the cell count exactly', () => {
  const rows: unknown[][] = Array.from({ length: 5 }, () => Array(5).fill('nope'));
  const scan = scanCells(rows, 5, 'absent', 5000, 25);
  // 25 cells, cap 25 — the cap is checked BEFORE examining the next cell,
  // so an exact fit is a complete scan.
  assert.equal(scan.capped, false);
  assert.equal(scan.scanned, 25);
});

test('default caps are the shipped ones', () => {
  assert.equal(FIND_MATCH_CAP, 5000);
  assert.equal(FIND_CELL_CAP, 250_000);
});
