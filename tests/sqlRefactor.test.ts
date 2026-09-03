import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  wrapInSubquery, extractCte, parseSelect, transformStatement,
  selectToInsert, selectToCreateTable, selectToCreateView, selectToDelete, selectToUpdate,
} from '../src/utils/sqlRefactor.ts';

function fakeView(doc: string, from: number, to: number): EditorView {
  let state = EditorState.create({ doc, selection: { anchor: from, head: to } });
  return { get state() { return state; }, dispatch: (tr: Transaction) => { state = tr.state; } } as unknown as EditorView;
}

test('wrapInSubquery wraps the current statement when there is no selection', () => {
  const v = fakeView('SELECT id FROM users;', 3, 3);
  assert.equal(wrapInSubquery(v), true);
  const out = v.state.doc.toString();
  assert.match(out, /SELECT \*\nFROM \(/);
  assert.match(out, /\) AS sub/);
  assert.match(out, /SELECT id FROM users;/);
});

test('extractCte lifts the selection into a new WITH and references it', () => {
  const doc = 'SELECT * FROM (SELECT id FROM users) t;';
  const from = doc.indexOf('SELECT id FROM users');
  const v = fakeView(doc, from, from + 'SELECT id FROM users'.length);
  assert.equal(extractCte(v, 'u'), true);
  const out = v.state.doc.toString();
  assert.match(out, /^WITH u AS \(/);
  assert.match(out, /\bfrom \(u\) t;/i.test(out) ? /from \(u\)/i : /\(u\)/); // selection replaced by name
  assert.ok(out.includes('(u)'), `expected reference to CTE name, got: ${out}`);
});

test('extractCte splices into an existing WITH list', () => {
  const doc = 'WITH a AS (SELECT 1) SELECT * FROM (SELECT id FROM t) x;';
  const from = doc.indexOf('SELECT id FROM t');
  const v = fakeView(doc, from, from + 'SELECT id FROM t'.length);
  assert.equal(extractCte(v, 'b'), true);
  const out = v.state.doc.toString();
  assert.match(out, /^WITH b AS \(/);      // spliced right after WITH
  assert.ok(out.includes('a AS (SELECT 1)'), 'kept the original CTE');
});

test('extractCte needs a selection', () => {
  assert.equal(extractCte(fakeView('SELECT 1;', 2, 2)), false);
});

// ── statement transforms: SELECT → INSERT / CTAS / VIEW / DELETE / UPDATE ────

test('selectToInsert pairs the select list with the FROM table', () => {
  assert.equal(
    selectToInsert('SELECT id, name AS n FROM users WHERE active = 1;'),
    'INSERT INTO users (id, n)\nSELECT id, name AS n FROM users WHERE active = 1',
  );
});

test('selectToInsert omits the column list for SELECT * (invented names would lie)', () => {
  assert.equal(
    selectToInsert('SELECT * FROM shop.orders'),
    'INSERT INTO shop.orders\nSELECT * FROM shop.orders',
  );
});

test('selectToInsert keeps quoted/qualified table names as written', () => {
  assert.equal(
    selectToInsert('SELECT id FROM `shop`.`order items`'),
    'INSERT INTO `shop`.`order items` (id)\nSELECT id FROM `shop`.`order items`',
  );
});

test('selectToCreateTable names the scratch table after its source', () => {
  assert.equal(
    selectToCreateTable('SELECT a, b FROM t WHERE x > 0;'),
    'CREATE TABLE t_copy AS\nSELECT a, b FROM t WHERE x > 0',
  );
  assert.equal(selectToCreateTable('SELECT 1'), 'CREATE TABLE new_table AS\nSELECT 1');
});

test('selectToCreateView uses the _v suffix convention', () => {
  assert.equal(
    selectToCreateView('SELECT id FROM users;'),
    'CREATE VIEW users_v AS\nSELECT id FROM users',
  );
});

test('selectToDelete keeps exactly the same WHERE', () => {
  assert.equal(
    selectToDelete("SELECT * FROM logs WHERE ts < '2020-01-01' ORDER BY ts;"),
    "DELETE FROM logs\nWHERE ts < '2020-01-01'",
  );
});

test('selectToDelete without a WHERE produces the bare delete (prod guards apply on run)', () => {
  assert.equal(selectToDelete('SELECT id FROM t'), 'DELETE FROM t');
});

test('selectToUpdate builds the skeleton on the first column with a placeholder', () => {
  assert.equal(
    selectToUpdate('SELECT price, qty FROM orders WHERE id = 5;'),
    'UPDATE orders\nSET price = NULL /* := value */\nWHERE id = 5',
  );
});

test('the WHERE survives semicolons and clause keywords inside strings', () => {
  assert.equal(
    selectToDelete("SELECT * FROM t WHERE note = 'a; group by' AND id > 3;"),
    "DELETE FROM t\nWHERE note = 'a; group by' AND id > 3",
  );
});

test('non-SELECT statements are refused by every transform', () => {
  for (const sql of ['UPDATE t SET a = 1', 'DELETE FROM t', 'INSERT INTO t VALUES (1)', 'SHOW TABLES']) {
    assert.equal(selectToInsert(sql), null, sql);
    assert.equal(selectToCreateTable(sql), null, sql);
    assert.equal(selectToCreateView(sql), null, sql);
    assert.equal(selectToDelete(sql), null, sql);
    assert.equal(selectToUpdate(sql), null, sql);
  }
});

test('set-operation SELECTs are refused (no single FROM/WHERE to inherit)', () => {
  assert.equal(parseSelect('SELECT a FROM t UNION SELECT a FROM u'), null);
  assert.equal(selectToDelete('SELECT a FROM t UNION ALL SELECT a FROM u'), null);
});

test('a SELECT without FROM still transforms where that makes sense', () => {
  assert.equal(selectToInsert('SELECT 1, 2'), null);           // no table to insert into
  assert.equal(selectToDelete('SELECT 1'), null);
  assert.equal(selectToCreateTable('SELECT 1'), 'CREATE TABLE new_table AS\nSELECT 1');
});

test('a WHERE in a subquery is not the statement’s WHERE', () => {
  assert.equal(
    selectToDelete('SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE flag = 1) AND x = 2;'),
    'DELETE FROM t\nWHERE id IN (SELECT id FROM u WHERE flag = 1) AND x = 2',
  );
  // and a subquery-only WHERE leaves the statement WHERE-less
  assert.equal(
    selectToDelete('SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE flag = 1);'),
    'DELETE FROM t\nWHERE id IN (SELECT id FROM u WHERE flag = 1)',
  );
});

test('transformStatement rewrites the statement at the caret when nothing is selected', () => {
  const v = fakeView('SELECT 1;\nSELECT id FROM users WHERE active = 1;\n', 45, 45);
  assert.equal(transformStatement(v, selectToDelete), true);
  assert.equal(
    v.state.doc.toString(),
    'SELECT 1;\nDELETE FROM users\nWHERE active = 1\n',
  );
});

test('transformStatement returns false and changes nothing on a non-SELECT', () => {
  const v = fakeView('DELETE FROM t;', 3, 3);
  assert.equal(transformStatement(v, selectToDelete), false);
  assert.equal(v.state.doc.toString(), 'DELETE FROM t;');
});
