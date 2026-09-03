/**
 * Script outline (src/utils/sqlOutline.ts).
 *
 * The outline's value is its *classification*, not its text — a list that
 * marks which statements write and which drop is what answers "where does this
 * migration actually change things". So these tests are mostly about kinds
 * being right, and about the two ways they go wrong: a keyword matched in the
 * wrong order (`CREATE OR REPLACE`, `INSERT … SELECT`), and a keyword found in
 * a comment or a string rather than in the SQL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  outline, classify, normalise, labelFor, outlineSummary, itemAt,
  toggleBookmark, nextBookmark, prevBookmark, shiftBookmarks,
  loadBookmarks, saveBookmarks, bookmarkKey,
} from '../src/utils/sqlOutline.ts';

// ── classification ──────────────────────────────────────────────────────────

test('the common statements are classified by their leading keyword', () => {
  assert.equal(classify('SELECT 1').kind, 'select');
  assert.equal(classify('WITH t AS (SELECT 1) SELECT * FROM t').kind, 'select');
  assert.equal(classify('UPDATE orders SET x = 1').kind, 'update');
  assert.equal(classify('DELETE FROM orders WHERE id = 1').kind, 'delete');
  assert.equal(classify('TRUNCATE TABLE orders').kind, 'truncate');
  assert.equal(classify('GRANT SELECT ON t TO u').kind, 'grant');
  assert.equal(classify('BEGIN').kind, 'transaction');
  assert.equal(classify('SET search_path TO x').kind, 'set');
  assert.equal(classify('CALL recalc(1)').kind, 'call');
  assert.equal(classify('EXPLAIN SELECT 1').kind, 'explain');
  assert.equal(classify('SHOW TABLES').kind, 'show');
});

test('INSERT … SELECT is an insert, not a select', () => {
  // The leading keyword decides; searching for "select" anywhere would get
  // this backwards and mark a write as a read.
  const c = classify('INSERT INTO archive SELECT * FROM orders');
  assert.equal(c.kind, 'insert');
  assert.equal(c.target, 'archive');
});

test('CREATE OR REPLACE is a create, and names its object', () => {
  // Must be tested before bare CREATE or the target comes out as "OR".
  const c = classify('CREATE OR REPLACE FUNCTION public.f() RETURNS int AS $$ $$');
  assert.equal(c.kind, 'create');
  // The bare name, not the signature — this is a margin label, not a DROP.
  assert.equal(c.target, 'public.f');
});

test('objects are named and unquoted', () => {
  assert.equal(classify('UPDATE `shop`.`orders` SET a = 1').target, 'shop.orders');
  assert.equal(classify('DELETE FROM "Orders" WHERE 1=0').target, 'Orders');
  assert.equal(classify('DROP TABLE IF EXISTS tmp').target, 'tmp');
  assert.equal(classify('ALTER TABLE orders ADD COLUMN x int').target, 'orders');
  assert.equal(classify('CREATE INDEX IF NOT EXISTS idx ON t (a)').target, 'idx');
});

test('a keyword inside a comment does not decide the kind', () => {
  // `-- DROP TABLE orders` above a SELECT must not mark it destructive.
  assert.equal(classify('-- DROP TABLE orders\nSELECT 1').kind, 'select');
  assert.equal(classify('/* UPDATE x */ SELECT 1').kind, 'select');
});

test('a keyword inside a string does not decide the kind', () => {
  assert.equal(classify("SELECT 'DROP TABLE orders' AS note").kind, 'select');
});

test('an unrecognised statement is `other`, not mis-filed', () => {
  assert.equal(classify('VACUUM ANALYZE').kind, 'other');
  assert.equal(classify('').kind, 'other');
});

// ── weight, which is what the margin shows ──────────────────────────────────

test('weight separates reads from writes from destruction', () => {
  const items = outline(`
    SELECT 1;
    UPDATE orders SET x = 1;
    CREATE TABLE t (a int);
    DROP TABLE t;
  `);
  assert.deepEqual(items.map(i => i.weight), ['read', 'write', 'ddl', 'destructive']);
});

test('every kind has a weight', () => {
  for (const sql of ['SELECT 1', 'INSERT INTO t VALUES (1)', 'UPDATE t SET a=1',
    'DELETE FROM t', 'CREATE TABLE t (a int)', 'ALTER TABLE t ADD b int',
    'DROP TABLE t', 'TRUNCATE t', 'GRANT ALL ON t TO u', 'BEGIN', 'SET a=1',
    'CALL p()', 'SHOW TABLES', 'EXPLAIN SELECT 1', 'VACUUM']) {
    const [item] = outline(sql + ';');
    assert.ok(item?.weight, sql);
  }
});

// ── the document ────────────────────────────────────────────────────────────

test('statements are numbered, positioned and located by line', () => {
  const doc = 'SELECT 1;\n\nUPDATE t SET a = 1;\n';
  const items = outline(doc);
  assert.deepEqual(items.map(i => i.index), [1, 2]);
  assert.equal(items[0].line, 1);
  assert.equal(items[1].line, 3, `got line ${items[1].line}`);
  // Offsets must address the real text, for click-to-jump.
  assert.equal(doc.slice(items[1].from, items[1].to), 'UPDATE t SET a = 1;');
});

test('a comment-only chunk is not counted as a statement', () => {
  // Otherwise a commented-out block inflates the count and the numbering.
  const items = outline('-- just a note\n\nSELECT 1;');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'select');
});

test('the outline splits the same way the runner does', () => {
  // A `;` inside a string is not a boundary — an outline that disagreed with
  // execution would be worse than no outline.
  assert.equal(outline("SELECT 'a;b';").length, 1);
  assert.equal(outline('SELECT 1 GO SELECT 2 GO', 'GO').length, 2);
});

test('an empty document outlines to nothing', () => {
  assert.deepEqual(outline(''), []);
  assert.deepEqual(outline('   \n\n '), []);
});

// ── presentation ────────────────────────────────────────────────────────────

test('labels are one line and bounded', () => {
  const long = 'SELECT ' + 'a, '.repeat(80) + 'b FROM t';
  const l = labelFor(long);
  assert.ok(l.length <= 56, `label was ${l.length} chars`);
  assert.ok(!l.includes('\n'));
  assert.ok(l.endsWith('…'));
  // A multi-line statement collapses rather than wrapping the margin.
  assert.equal(labelFor('SELECT\n  1'), 'SELECT 1');
});

test('normalise strips every comment form', () => {
  assert.equal(normalise('SELECT 1 -- x'), 'SELECT 1');
  assert.equal(normalise('SELECT /* x */ 1'), 'SELECT 1');
  assert.equal(normalise('# x\nSELECT 1'), 'SELECT 1');
});

test('the summary counts what matters, not everything', () => {
  const items = outline('SELECT 1; UPDATE t SET a=1; DROP TABLE x;');
  const s = outlineSummary(items);
  assert.match(s, /3 statements/);
  assert.match(s, /1 write/);
  assert.match(s, /1 destructive/);
  // Reads are the default and are not worth a badge.
  assert.ok(!/read/.test(s));
  assert.equal(outlineSummary([]), 'No statements');
});

test('the caret maps to the statement it sits in', () => {
  const doc = 'SELECT 1;\nUPDATE t SET a = 1;';
  const items = outline(doc);
  assert.equal(itemAt(items, 2)?.index, 1);
  assert.equal(itemAt(items, 15)?.index, 2);
  // Past the end, the previous statement wins — matching the editor's rule.
  assert.equal(itemAt(items, doc.length + 5)?.index, 2);
  assert.equal(itemAt([], 0), undefined);
});

// ── bookmarks ───────────────────────────────────────────────────────────────

test('toggling adds and removes, keeping the list sorted', () => {
  let m = toggleBookmark([], 5);
  m = toggleBookmark(m, 2);
  assert.deepEqual(m.map(b => b.line), [2, 5]);
  m = toggleBookmark(m, 5);
  assert.deepEqual(m.map(b => b.line), [2]);
});

test('next and previous wrap around', () => {
  // Cycling with one key is the whole interaction; stopping at the end makes
  // it two keys.
  const m = [{ line: 2 }, { line: 7 }];
  assert.equal(nextBookmark(m, 1)?.line, 2);
  assert.equal(nextBookmark(m, 2)?.line, 7);
  assert.equal(nextBookmark(m, 9)?.line, 2, 'should wrap to the first');
  assert.equal(prevBookmark(m, 8)?.line, 7);
  assert.equal(prevBookmark(m, 1)?.line, 7, 'should wrap to the last');
  assert.equal(nextBookmark([], 1), undefined);
  assert.equal(prevBookmark([], 1), undefined);
});

test('bookmarks follow an edit that adds or removes lines', () => {
  // A bookmark pointing at the wrong statement is worse than a lost one,
  // because it is trusted.
  const m = [{ line: 3 }, { line: 10 }];
  assert.deepEqual(shiftBookmarks(m, 5, 2).map(b => b.line), [3, 12],
    'only marks at or below the edit move');
  assert.deepEqual(shiftBookmarks(m, 1, 4).map(b => b.line), [7, 14]);
  assert.deepEqual(shiftBookmarks(m, 1, -20).map(b => b.line), [],
    'marks pushed above line 1 are dropped, not left negative');
  assert.deepEqual(shiftBookmarks(m, 5, 0), m, 'no change means no work');
});

test('bookmarks round-trip through storage and survive corruption', () => {
  const store = new Map<string, string>();
  const st = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as Storage;

  const key = bookmarkKey('c1', 2);
  saveBookmarks(key, [{ line: 4 }, { line: 1 }], st);
  assert.deepEqual(loadBookmarks(key, st).map(b => b.line), [1, 4], 'sorted on read');

  saveBookmarks(key, [], st);
  assert.deepEqual(loadBookmarks(key, st), [], 'an empty list clears the entry');

  st.setItem(key, 'not json');
  assert.deepEqual(loadBookmarks(key, st), []);
  st.setItem(key, '[{"line":"x"},{"line":3}]');
  assert.deepEqual(loadBookmarks(key, st).map(b => b.line), [3]);
});

test('bookmark keys are per connection and per tab', () => {
  assert.notEqual(bookmarkKey('a', 1), bookmarkKey('a', 2));
  assert.notEqual(bookmarkKey('a', 1), bookmarkKey('b', 1));
});
