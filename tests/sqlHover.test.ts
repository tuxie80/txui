/**
 * Token resolution under the cursor (src/utils/sqlHover.ts) — the basis for
 * hover tooltips, ⌘-click navigation and signature help.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenAt, resolveHover, variableAt, inStringOrComment, callSiteAt, signatureArgs,
} from '../src/utils/sqlHover.ts';
import type { HoverContext } from '../src/utils/sqlHover.ts';

const ctx = (over: Partial<HoverContext> = {}): HoverContext => ({
  aliases: new Map([['o', 'shop.orders'], ['c', 'shop.customers']]),
  objects: new Map([['orders', 'shop.orders'], ['shop.orders', 'shop.orders'], ['shop', 'shop']]),
  functions: new Set(['DATE_FORMAT', 'COUNT']),
  keywords: new Set(['select', 'from', 'where', 'and']),
  ...over,
});

const at = (doc: string, needle: string) => doc.indexOf(needle) + 1;

test('the identifier under the cursor is found, with its qualifier', () => {
  const doc = 'SELECT o.state FROM shop.orders o';
  const t = tokenAt(doc, at(doc, 'state'));
  assert.equal(t?.text, 'state');
  assert.equal(t?.qualifier, 'o');
  assert.equal(doc.slice(t!.from, t!.to), 'state');
  assert.equal(tokenAt(doc, at(doc, 'orders'))?.qualifier, 'shop');
});

test('quoted identifiers resolve as one token, per engine', () => {
  // PostgreSQL: "x" is an identifier
  const pg = 'SELECT * FROM "Order Items"';
  const t = tokenAt(pg, pg.indexOf('Order') + 2, 'postgres');
  assert.equal(t?.text, 'Order Items');
  assert.equal(pg.slice(t!.from, t!.to), '"Order Items"');
  // MySQL: "x" is a STRING, so nothing resolves inside it…
  assert.equal(tokenAt(pg, pg.indexOf('Order') + 2, 'mysql'), null);
  // …and the backtick is the identifier quote instead
  const my = 'SELECT `order`.id FROM x';
  assert.equal(tokenAt(my, my.indexOf('order') + 2, 'mysql')?.text, 'order');
  assert.equal(tokenAt(my, my.indexOf('.id') + 2, 'mysql')?.qualifier, 'order');
});

test('nothing resolves inside strings or comments', () => {
  const doc = "SELECT 'orders' -- orders\n/* orders */";
  assert.equal(tokenAt(doc, doc.indexOf("'orders'") + 3), null);
  assert.equal(tokenAt(doc, doc.indexOf('-- orders') + 4), null);
  assert.equal(tokenAt(doc, doc.lastIndexOf('orders') + 2), null);
  assert.ok(inStringOrComment(doc, doc.indexOf("'orders'") + 3));
  assert.ok(!inStringOrComment('SELECT 1', 7));
});

test('numbers and empty positions are not identifiers', () => {
  assert.equal(tokenAt('SELECT 42', 8), null);
  assert.equal(tokenAt('SELECT  1', 7), null);
});

test('alias.column resolves to the aliased table', () => {
  const doc = 'SELECT o.state FROM shop.orders o';
  const h = resolveHover(doc, at(doc, 'state'), ctx());
  assert.equal(h?.kind, 'column');
  assert.equal(h?.table, 'shop.orders');
  assert.equal(h?.column, 'state');
});

test('a known object resolves to a table, a known function to a function', () => {
  const doc = 'SELECT DATE_FORMAT(created_at, "%Y") FROM orders';
  assert.equal(resolveHover(doc, at(doc, 'orders'), ctx())?.kind, 'table');
  assert.equal(resolveHover(doc, at(doc, 'DATE_FORMAT'), ctx())?.kind, 'function');
  // schema.table resolves through the qualified key
  const q = 'SELECT 1 FROM shop.orders';
  const h = resolveHover(q, at(q, 'orders'), ctx());
  assert.equal(h?.kind, 'table');
  assert.equal(h?.table, 'shop.orders');
});

test('keywords are recognised so they do not produce noisy tooltips', () => {
  const doc = 'SELECT x FROM y';
  assert.equal(resolveHover(doc, 2, ctx())?.kind, 'keyword');
  assert.equal(resolveHover(doc, at(doc, 'FROM'), ctx())?.kind, 'keyword');
});

test('an unknown bare word is treated as a column to be looked up', () => {
  const doc = 'SELECT total_amount FROM orders';
  const h = resolveHover(doc, at(doc, 'total_amount'), ctx());
  assert.equal(h?.kind, 'column');
  assert.equal(h?.column, 'total_amount');
  assert.equal(h?.table, undefined, 'the caller searches the tables in scope');
});

test('variables are recognised in all three flavours', () => {
  const doc = "SET @@session.sql_mode = '', @x = 1, :name = 2";
  assert.equal(variableAt(doc, at(doc, '@@session'))?.text, '@@session.sql_mode');
  assert.equal(variableAt(doc, at(doc, '@x'))?.text, '@x');
  assert.equal(variableAt(doc, at(doc, ':name'))?.text, ':name');
  assert.equal(resolveHover(doc, at(doc, '@@session'), ctx())?.kind, 'variable');
  assert.equal(variableAt('SELECT 1', 3), null);
});

// ── signature help ────────────────────────────────────────────────────────────

test('the call under the caret is found, with the right argument index', () => {
  const doc = "SELECT DATE_FORMAT(created_at, '%Y-%m') FROM t";
  const a = callSiteAt(doc, doc.indexOf('created_at') + 3);
  assert.equal(a?.name, 'DATE_FORMAT');
  assert.equal(a?.argIndex, 0);
  const b = callSiteAt(doc, doc.indexOf("'%Y") + 2);
  assert.equal(b?.argIndex, 1, 'the caret is in the second argument');
});

test('commas inside nested calls and literals do not shift the argument index', () => {
  const doc = "SELECT CONCAT(COALESCE(a, b), 'x,y', |) FROM t".replace('|', '');
  const at = doc.lastIndexOf(')');
  const c = callSiteAt(doc, at);
  assert.equal(c?.name, 'CONCAT');
  assert.equal(c?.argIndex, 2, 'COALESCE(a, b) is one argument, so is the string');
});

test('outside a call there is no signature, and statements are not crossed', () => {
  assert.equal(callSiteAt('SELECT 1 FROM t', 9), null);
  assert.equal(callSiteAt('SELECT COUNT(*) FROM t;\nSELECT 1', 30), null);
});

test('signatures split into their arguments', () => {
  assert.deepEqual(signatureArgs('SUBSTRING(str, pos, len)'), ['str', 'pos', 'len']);
  assert.deepEqual(signatureArgs('COUNT(*)'), ['*']);
  assert.deepEqual(signatureArgs('NOW()'), []);
  assert.deepEqual(signatureArgs('IF(cond, then, else)'), ['cond', 'then', 'else']);
  assert.deepEqual(signatureArgs('no parens here'), []);
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('a bracketed identifier is one token, without its brackets', () => {
  // `[order]` is how T-SQL writes a reserved word as a name. Read with the
  // MySQL rules the brackets are ordinary text and become part of the name.
  const doc = 'SELECT [total] FROM [sales].[orders]';
  const t = tokenAt(doc, doc.indexOf('[total]') + 1, 'sqlserver');
  assert.equal(t?.text, 'total');
  assert.equal(doc.slice(t!.from, t!.to), '[total]');
});

test('a double-quoted name is an identifier on SQL Server, a string on MySQL', () => {
  // The driver runs with QUOTED_IDENTIFIER ON, so `"qty"` is a column there —
  // and treating it as a string made every one of them un-hoverable.
  const doc = 'SELECT "qty" FROM t';
  const at = doc.indexOf('"qty"') + 1;
  assert.equal(tokenAt(doc, at, 'sqlserver')?.text, 'qty');
  assert.equal(tokenAt(doc, at, 'mysql'), null);
  assert.equal(inStringOrComment(doc, at, 'sqlserver'), false);
  assert.equal(inStringOrComment(doc, at, 'mysql'), true);
});

test('a single-quoted literal is still a literal on SQL Server', () => {
  const doc = "SELECT * FROM t WHERE note = 'total'";
  assert.equal(inStringOrComment(doc, doc.indexOf("'total'") + 1, 'sqlserver'), true);
  assert.equal(tokenAt(doc, doc.indexOf("'total'") + 2, 'sqlserver'), null);
});

test('a quoted qualifier resolves — on every engine, not just SQL Server', () => {
  // Walking back over bare identifier characters stops at the closing quote, so
  // a fully-quoted reference lost its qualifier everywhere. `[` and `]` are not
  // the same character, which is what made the bug visible here first.
  for (const [doc, needle, engine, want] of [
    ['[sales].[orders].[total]', '[total]', 'sqlserver', 'orders'],
    ['`shop`.`orders`.`total`', '`total`', 'mysql', 'orders'],
    ['"shop"."orders"."total"', '"total"', 'postgres', 'orders'],
    ['o.[total]', '[total]', 'sqlserver', 'o'],
    ['o.total', 'total', 'sqlserver', 'o'],
  ] as const) {
    const t = tokenAt(doc, doc.indexOf(needle) + 1, engine);
    assert.equal(t?.qualifier, want, `${engine}: ${doc}`);
  }
});

test('an unterminated bracket does not swallow the rest of the line', () => {
  const doc = 'SELECT [oops FROM t';
  // No closing bracket on the line: the scanner must give up rather than
  // return a token running to the end of the document.
  const t = tokenAt(doc, doc.indexOf('oops'), 'sqlserver');
  assert.ok(t === null || t.text === 'oops', JSON.stringify(t));
});
