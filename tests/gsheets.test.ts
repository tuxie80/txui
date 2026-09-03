/**
 * Google Sheets export payload shaping (src/utils/gsheets.ts) — the module is
 * pure so this drives it under node --test, no DOM or Tauri.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('sheetsCell keeps scalars and stringifies the rest', async () => {
  const { sheetsCell } = await import('../src/utils/gsheets.ts');
  assert.equal(sheetsCell('abc'), 'abc');
  assert.equal(sheetsCell(42), 42);
  assert.equal(sheetsCell(1.5), 1.5);
  assert.equal(sheetsCell(true), true);
  assert.equal(sheetsCell(null), '');
  assert.equal(sheetsCell(undefined), '');
  assert.equal(sheetsCell({ a: 1 }), '{"a":1}');
  assert.equal(sheetsCell([1, 2]), '[1,2]');
});

test('buildSheetValues puts the header first and converts every row', async () => {
  const { buildSheetValues } = await import('../src/utils/gsheets.ts');
  const values = buildSheetValues(['id', 'note'], [[1, 'x'], [2, null]]);
  assert.deepEqual(values, [['id', 'note'], [1, 'x'], [2, '']]);
});

test('buildSheetValues refuses a grid over the cell ceiling', async () => {
  const { buildSheetValues, MAX_SHEETS_CELLS } = await import('../src/utils/gsheets.ts');
  const rows = Array.from({ length: MAX_SHEETS_CELLS }, () => ['x']);
  assert.throws(() => buildSheetValues(['a', 'b'], rows), /Too much data/);
  // Exactly at the ceiling is allowed.
  const fit = Array.from({ length: MAX_SHEETS_CELLS - 1 }, () => ['x']);
  assert.equal(buildSheetValues(['a'], fit).length, MAX_SHEETS_CELLS);
});

test('sanitizeSheetName strips illegal chars, caps length, never empty', async () => {
  const { sanitizeSheetName } = await import('../src/utils/gsheets.ts');
  assert.equal(sanitizeSheetName('Sheet1'), 'Sheet1');
  assert.equal(sanitizeSheetName('orders[2026]: Q1*?'), 'orders2026 Q1');
  assert.equal(sanitizeSheetName('a/b\\c'), 'abc');
  assert.equal(sanitizeSheetName('  padded  '), 'padded');
  assert.equal(sanitizeSheetName(''), 'Sheet1');
  assert.equal(sanitizeSheetName('[:]'), 'Sheet1');
  assert.equal(sanitizeSheetName('x'.repeat(120)).length, 100);
});
