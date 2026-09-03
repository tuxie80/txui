/**
 * Scope-aware alias/CTE rename (src/utils/renameSymbol.ts).
 *
 * The cost of getting this wrong is a corrupted script: a rename that rewrites
 * a string literal, a comment, a same-named column on another alias, or a
 * substring of a longer identifier silently changes what the SQL does. So most
 * of these tests are corruption guards — they assert what must NOT be touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameAliasAt } from '../src/utils/renameSymbol.ts';

/** Offset of the nth (0-based) occurrence of `needle` in `sql`. */
const at = (sql: string, needle: string, n = 0): number => {
  let idx = -1;
  for (let k = 0; k <= n; k++) idx = sql.indexOf(needle, idx + 1);
  return idx;
};

test('renames all three references to an alias', () => {
  const sql = 'SELECT o.id FROM orders o WHERE o.x=1';
  // caret on the definition `orders o`
  const r = renameAliasAt(sql, at(sql, 'orders o') + 'orders '.length, 'ord');
  assert.ok(r);
  assert.equal(r!.text, 'SELECT ord.id FROM orders ord WHERE ord.x=1');
});

test('renames when the caret is on a qualifier usage, not the definition', () => {
  const sql = 'SELECT o.id FROM orders o WHERE o.x=1';
  const r = renameAliasAt(sql, at(sql, 'o.id'), 'ord'); // caret on first `o`
  assert.ok(r);
  assert.equal(r!.text, 'SELECT ord.id FROM orders ord WHERE ord.x=1');
});

test('does NOT touch `o` inside a string literal', () => {
  const sql = "SELECT o.id, 'foo o bar' FROM orders o";
  const r = renameAliasAt(sql, at(sql, 'orders o') + 'orders '.length, 'ord');
  assert.ok(r);
  assert.equal(r!.text, "SELECT ord.id, 'foo o bar' FROM orders ord");
});

test('does NOT touch `o` inside a line comment', () => {
  const sql = 'SELECT o.id FROM orders o -- keep o here\n';
  const r = renameAliasAt(sql, at(sql, 'o.id'), 'ord');
  assert.ok(r);
  assert.equal(r!.text, 'SELECT ord.id FROM orders ord -- keep o here\n');
});

test('does NOT touch a column literally named `o` on a different alias', () => {
  // `x.o` is column o of alias x; alias o is defined by `orders o`.
  const sql = 'SELECT x.o FROM things x, orders o WHERE o.id = x.id';
  const r = renameAliasAt(sql, at(sql, 'orders o') + 'orders '.length, 'ord');
  assert.ok(r);
  assert.equal(r!.text, 'SELECT x.o FROM things x, orders ord WHERE ord.id = x.id');
});

test('does NOT rename inside a longer identifier', () => {
  const sql = 'SELECT o.id, foo, food FROM orders o';
  const r = renameAliasAt(sql, at(sql, 'o.id'), 'ord');
  assert.ok(r);
  // `foo` and `food` contain the letters but are whole words of their own.
  assert.equal(r!.text, 'SELECT ord.id, foo, food FROM orders ord');
});

test('renames a CTE name and its reference', () => {
  const sql = 'WITH c AS (SELECT 1 AS id) SELECT * FROM c';
  const r = renameAliasAt(sql, at(sql, 'WITH c') + 'WITH '.length, 'cte');
  assert.ok(r);
  assert.equal(r!.text, 'WITH cte AS (SELECT 1 AS id) SELECT * FROM cte');
});

test('renames a CTE from its usage site too', () => {
  const sql = 'WITH c AS (SELECT 1 AS id) SELECT c.id FROM c';
  const r = renameAliasAt(sql, at(sql, 'FROM c') + 'FROM '.length, 'cte');
  assert.ok(r);
  assert.equal(r!.text, 'WITH cte AS (SELECT 1 AS id) SELECT cte.id FROM cte');
});

test('returns null when the caret is on a table name', () => {
  const sql = 'SELECT o.id FROM orders o';
  assert.equal(renameAliasAt(sql, at(sql, 'orders'), 'x'), null);
});

test('returns null when the caret is on a keyword', () => {
  const sql = 'SELECT o.id FROM orders o';
  assert.equal(renameAliasAt(sql, at(sql, 'SELECT'), 'x'), null);
});

test('returns null when the caret is on a bare column, not an alias', () => {
  const sql = 'SELECT o.id FROM orders o';
  assert.equal(renameAliasAt(sql, at(sql, 'o.id') + 2, 'x'), null); // caret on `id`
});

test('returns null for an illegal new name', () => {
  const sql = 'SELECT o.id FROM orders o';
  assert.equal(renameAliasAt(sql, at(sql, 'orders o') + 'orders '.length, '1bad'), null);
  assert.equal(renameAliasAt(sql, at(sql, 'orders o') + 'orders '.length, 'no spaces'), null);
});

test('returns null when the caret is not on any identifier', () => {
  const sql = 'SELECT o.id FROM orders o';
  assert.equal(renameAliasAt(sql, at(sql, ' FROM'), 'x'), null); // on a space
});

test('matches alias references case-insensitively (SQL identifier semantics)', () => {
  const sql = 'SELECT O.id FROM orders o WHERE o.x=1';
  const r = renameAliasAt(sql, at(sql, 'orders o') + 'orders '.length, 'ord');
  assert.ok(r);
  assert.equal(r!.text, 'SELECT ord.id FROM orders ord WHERE ord.x=1');
});
