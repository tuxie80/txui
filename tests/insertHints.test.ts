/**
 * INSERT … VALUES inlay hints (utils/insertHints.ts).
 *
 * The contract is conservative pairing: a hint says "this value feeds THAT
 * column", so any uncertainty — arity mismatch, subquery, no column list,
 * INSERT … SELECT — must produce silence, never a wrong hint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertValueHints, INSERT_HINT_ROW_CAP } from '../src/utils/insertHints.ts';

/**
 * The readable assertion: labels in order (`a =`, `b =`, …), each hint's
 * position pointing at the start of its value (a naive comma-split would
 * break on strings like 'x,y' — startsWith doesn't).
 */
function assertHints(doc: string, expected: [col: string, value: string][], delimiter = ';') {
  const hints = insertValueHints(doc, delimiter);
  assert.equal(hints.length, expected.length,
    `hints: ${JSON.stringify(hints.map(h => h.label))}`);
  expected.forEach(([col, value], i) => {
    assert.equal(hints[i].label, `${col} =`);
    assert.ok(doc.startsWith(value, hints[i].pos),
      `hint ${i} (${col}): doc at pos ${hints[i].pos} does not start with ${JSON.stringify(value)}`);
  });
}

test('pairs each value with its column, in order', () => {
  assertHints("INSERT INTO users (id, name, active) VALUES (1, 'ada', TRUE);", [
    ['id', '1'], ['name', "'ada'"], ['active', 'TRUE'],
  ]);
});

test('multi-row VALUES hints every tuple up to the cap', () => {
  assertHints('INSERT INTO t (a, b) VALUES (1, 2), (3, 4), (5, 6);', [
    ['a', '1'], ['b', '2'], ['a', '3'], ['b', '4'], ['a', '5'], ['b', '6'],
  ]);
});

test('above the row cap only the first tuple is hinted', () => {
  const rows = Array.from({ length: INSERT_HINT_ROW_CAP + 2 }, (_, i) => `(${i * 2}, ${i * 2 + 1})`);
  assertHints(`INSERT INTO t (a, b) VALUES ${rows.join(', ')};`, [['a', '0'], ['b', '1']]);
});

test('exactly at the cap every row is still hinted', () => {
  const rows = Array.from({ length: INSERT_HINT_ROW_CAP }, () => '(1, 2)');
  const doc = `INSERT INTO t (a, b) VALUES ${rows.join(', ')};`;
  assert.equal(insertValueHints(doc).length, INSERT_HINT_ROW_CAP * 2);
});

test('arity mismatch silences the statement — never a mis-paired hint', () => {
  assertHints('INSERT INTO t (a, b, c) VALUES (1, 2);', []);
  assertHints('INSERT INTO t (a) VALUES (1, 2);', []);
  // …and a mismatch in the SECOND row silences everything, first row included
  assertHints('INSERT INTO t (a, b) VALUES (1, 2), (3);', []);
});

test('no explicit column list → out of scope, no hints', () => {
  assertHints('INSERT INTO t VALUES (1, 2);', []);
});

test('INSERT … SELECT is out of scope', () => {
  assertHints('INSERT INTO t (a, b) SELECT x, y FROM u;', []);
});

test('quoted commas and parens inside values do not split the tuple', () => {
  assertHints("INSERT INTO t (a, b, c) VALUES ('x,y', ')', 3);", [
    ['a', "'x,y'"], ['b', "')'"], ['c', '3'],
  ]);
});

test('ON DUPLICATE KEY UPDATE tail is not parsed as more values', () => {
  assertHints('INSERT INTO t (a, b) VALUES (1, 2) ON DUPLICATE KEY UPDATE b = 9;', [
    ['a', '1'], ['b', '2'],
  ]);
});

test('PG ON CONFLICT tail is not parsed as more values', () => {
  assertHints('INSERT INTO t (a, b) VALUES (1, 2) ON CONFLICT (a) DO NOTHING;', [
    ['a', '1'], ['b', '2'],
  ]);
});

test('a subquery value silences the statement', () => {
  assertHints('INSERT INTO t (a, b) VALUES ((SELECT MAX(id) FROM u), 2);', []);
});

test('quoted identifiers in the column list are stripped for the label', () => {
  assertHints("INSERT INTO `shop`.`orders` (`id`, \"state\") VALUES (7, 'new');", [
    ['id', '7'], ['state', "'new'"],
  ]);
});

test('positions are doc-absolute when the INSERT is not the first statement', () => {
  const doc = 'SELECT 1;\nINSERT INTO t (a, b) VALUES (1, 2);';
  const hints = insertValueHints(doc);
  assert.equal(hints.length, 2);
  assert.equal(doc.slice(hints[0].pos, hints[0].pos + 1), '1');
  assert.equal(doc.slice(hints[1].pos, hints[1].pos + 1), '2');
});

test('nested function calls and parens inside values pair fine', () => {
  assertHints("INSERT INTO t (a, b) VALUES (CONCAT('x', 'y'), COALESCE(NULL, 0));", [
    ['a', "CONCAT('x', 'y')"], ['b', 'COALESCE(NULL, 0)'],
  ]);
});

test('REPLACE gets the same treatment as INSERT', () => {
  assertHints('REPLACE INTO t (a, b) VALUES (1, 2);', [['a', '1'], ['b', '2']]);
});

test('no INSERT at all → no hints, and other statements are ignored', () => {
  assertHints('SELECT (1, 2) FROM t; UPDATE u SET a = 1;', []);
});
