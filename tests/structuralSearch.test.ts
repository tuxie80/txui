/**
 * Structural search & replace (src/utils/structuralSearch.ts).
 *
 * The module header states the semantics precisely; these tests pin them:
 * token-for-token matching with `$holes$` as shortest-balanced-run wildcards,
 * case-insensitive everywhere, comments invisible, strings as single tokens
 * that only equal strings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  structuralSearch, structuralReplace, substituteTemplate,
} from '../src/utils/structuralSearch.ts';

test('basic hole matching: one capture per match, shortest run', () => {
  const doc = 'SELECT * FROM orders; SELECT * FROM users u;';
  const matches = structuralSearch(doc, 'SELECT * FROM $t$');
  assert.equal(matches.length, 2);
  // A trailing hole captures its minimum — nothing after it forces it wider,
  // so `users u` yields just `users`.
  assert.deepEqual(matches.map(m => m.captures.t), ['orders', 'users']);
  assert.equal(doc.slice(matches[0].from, matches[0].to), 'SELECT * FROM orders');
});

test('multi-token holes capture a run up to the next pattern token', () => {
  const doc = 'SELECT * FROM t WHERE price * 2 = NULL';
  const [m] = structuralSearch(doc, 'WHERE $c$ = NULL');
  assert.equal(m.captures.c, 'price * 2');
});

test('holes capture balanced parenthesised groups, commas and all', () => {
  const doc = 'SELECT f(g(a, b)), f(x, y)';
  const matches = structuralSearch(doc, 'f($x$)');
  assert.deepEqual(matches.map(m => m.captures.x), ['g(a, b)', 'x, y']);
});

test('a hole never swallows an unbalanced paren prefix', () => {
  // `fn(a` is not a legal capture; the match must extend to the balanced group.
  const doc = 'SELECT fn(a, b) FROM t';
  const [m] = structuralSearch(doc, 'SELECT $e$ FROM $t$');
  assert.equal(m.captures.e, 'fn(a, b)');
  assert.equal(m.captures.t, 't');
});

test('matching is case-insensitive, quoted identifiers meet bare words', () => {
  const doc = 'select * from `ORDERS` where State = \'x\'';
  const [m] = structuralSearch(doc, 'SELECT * FROM $t$ WHERE $c$ = \'x\'');
  assert.equal(m.captures.t, '`ORDERS`');
  assert.equal(m.captures.c, 'State');
});

test('a string with a semicolon is one token and not a statement boundary', () => {
  const doc = "SELECT * FROM t WHERE s = 'a;b'; SELECT * FROM u";
  const matches = structuralSearch(doc, 'SELECT * FROM $t$');
  assert.deepEqual(matches.map(m => m.captures.t), ['t', 'u']);
  const [v] = structuralSearch(doc, 'WHERE s = $v$');
  assert.equal(v.captures.v, "'a;b'");
});

test('a pattern word never matches a string token', () => {
  const doc = "WHERE s = 'x'";
  assert.equal(structuralSearch(doc, "WHERE s = 'x'").length, 1);
  assert.equal(structuralSearch(doc, "WHERE s = 'y'").length, 0);
  assert.equal(structuralSearch(doc, 'WHERE s = x').length, 0); // word ≠ string
});

test('comments in the document never break a match', () => {
  const doc = 'SELECT a FROM t ORDER /* revisit the index */ BY c -- tail\n';
  const [m] = structuralSearch(doc, 'ORDER BY $c$');
  assert.equal(m.captures.c, 'c');
});

test('a hole never crosses a statement boundary', () => {
  const doc = 'DELETE FROM a; SELECT 1';
  // `$x$` cannot reach across the `;` to make `SELECT 1` part of one match.
  assert.equal(structuralSearch(doc, 'DELETE FROM $x$ SELECT 1').length, 0);
});

test('a repeated hole name must capture the same text (case-insensitive)', () => {
  assert.equal(structuralSearch('SELECT a = a', '$x$ = $x$').length, 1);
  assert.equal(structuralSearch('SELECT a = A', '$x$ = $x$').length, 1);
  assert.equal(structuralSearch('SELECT a = b', '$x$ = $x$').length, 0);
});

test('matches never overlap: the scan resumes after the match end', () => {
  // Documented policy: `x = y` matches; `y = z` is NOT reported afterwards.
  const matches = structuralSearch('x = y = z', '$a$ = $b$');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].captures.a, 'x');
  assert.equal(matches[0].captures.b, 'y');
});

test('a pattern with no holes is a plain token search', () => {
  const doc = 'SELECT a FROM t1; select A from t2';
  assert.equal(structuralSearch(doc, 'FROM').length, 2);
  assert.equal(structuralSearch(doc, 'select a from').length, 2);
});

test('empty pattern matches nothing', () => {
  assert.equal(structuralSearch('SELECT 1', '').length, 0);
  assert.equal(structuralSearch('SELECT 1', '   -- just a comment').length, 0);
});

test('replace fills the template with captured text', () => {
  const doc = 'SELECT * FROM orders WHERE total = NULL;';
  const r = structuralReplace(doc,
    'SELECT * FROM $t$ WHERE $c$ = NULL',
    'SELECT * FROM $t$ WHERE $c$ IS NULL');
  assert.equal(r.count, 1);
  assert.equal(r.text, 'SELECT * FROM orders WHERE total IS NULL;');
});

test('replace round-trips several matches and leaves non-matches alone', () => {
  const doc = 'WHERE a = NULL AND b = NULL; SELECT c = NULLx';
  const r = structuralReplace(doc, '$c$ = NULL', '$c$ IS NULL');
  assert.equal(r.count, 2);
  assert.equal(r.text, 'WHERE a IS NULL AND b IS NULL; SELECT c = NULLx');
});

test('substituteTemplate leaves uncaptured holes verbatim', () => {
  assert.equal(substituteTemplate('$a$ + $missing$', { a: 'one' }), 'one + $missing$');
});
