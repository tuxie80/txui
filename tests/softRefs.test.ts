/**
 * Relationships that exist only in a comment (src/utils/softRefs.ts).
 *
 * The 17 cases below are the regression set the `../review` tool carries, and
 * they exist because of one specific bug: a pattern written
 * `\bref(erence|erences)?\b` matches `Ref` *inside* `References` and captures
 * `erences` as the table name. Every negative case here is as load-bearing as
 * the positive ones — this feeds virtual foreign keys, which change how the
 * app navigates a schema, so a wrong pair is worse than a missed one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSoftRef, findSoftRefs, resolveSoftRefs, nearestName, commentedColumnsSql,
} from '../src/utils/softRefs.ts';

const parse = (comment: string) => parseSoftRef('bag_findings', 'order_id', comment);

// ── the forms that are references ───────────────────────────────────────────

test('the English forms are read, with table and column', () => {
  for (const c of [
    'References wapi_orders.order_id',
    'references wapi_orders.order_id',
    'Reference: wapi_orders.order_id',
    'Referencing wapi_orders.order_id',
    'Refers to wapi_orders.order_id',
    'FK to wapi_orders(order_id)',
    'foreign key to wapi_orders.order_id',
    'belongs to wapi_orders.order_id',
    'ref wapi_orders.order_id',
  ]) {
    const r = parse(c);
    assert.ok(r, c);
    assert.equal(r.toTable, 'wapi_orders', c);
    assert.equal(r.toColumn, 'order_id', c);
  }
});

test('the arrow forms are read', () => {
  for (const c of ['-> wapi_orders.order_id', '→ wapi_orders.order_id', '=> wapi_orders(order_id)']) {
    const r = parse(c);
    assert.ok(r, c);
    assert.equal(r.toTable, 'wapi_orders', c);
  }
});

test('a comment in the language the team actually writes in is read too', () => {
  // Dropping this would silently halve the yield on the schemas this exists for.
  const r = parse('odkaz na wapi_orders.order_id')!;
  assert.equal(r.toTable, 'wapi_orders');
  assert.equal(r.toColumn, 'order_id');
});

test('parenthesised and dotted spellings agree', () => {
  assert.deepEqual(
    [parse('FK to orders(id)')!.toTable, parse('FK to orders(id)')!.toColumn],
    [parse('FK to orders.id')!.toTable, parse('FK to orders.id')!.toColumn]);
});

test('a table with no column is accepted, and the column left open', () => {
  const r = parse('References wapi_orders')!;
  assert.equal(r.toTable, 'wapi_orders');
  assert.equal(r.toColumn, null);
});

test('the comment that produced the pair is kept as the evidence', () => {
  assert.equal(parse('References wapi_orders.order_id')!.evidence, 'References wapi_orders.order_id');
});

// ── the forms that are NOT references ───────────────────────────────────────

test('the word inside another word is not a match', () => {
  // The bug this whole regex ordering exists for: `Ref` inside `References`
  // capturing `erences` as a table.
  const r = parse('References wapi_orders.order_id')!;
  assert.notEqual(r.toTable, 'erences');
  assert.equal(r.toTable, 'wapi_orders');
});

test('a comment that merely mentions a table is not a reference', () => {
  for (const c of [
    'the id used by wapi_orders',
    'copied from the orders export',
    'set when the order is created',
    'unique per warehouse',
    '',
    '   ',
  ]) {
    assert.equal(parse(c), null, JSON.stringify(c));
  }
});

test('a comment describing this very column is not a reference to another table', () => {
  assert.equal(parseSoftRef('orders', 'id', 'references orders'), null);
});

// ── across a set of columns ─────────────────────────────────────────────────

test('a whole schema of comments yields only the ones that are references', () => {
  const refs = findSoftRefs([
    { table: 'a', column: 'order_id', comment: 'References orders.id' },
    { table: 'a', column: 'note', comment: 'free text' },
    { table: 'b', column: 'warehouse_id', comment: '-> warehouses(id)' },
    { table: 'b', column: 'x', comment: null },
  ]);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map(r => `${r.fromTable}.${r.fromColumn}→${r.toTable}`),
    ['a.order_id→orders', 'b.warehouse_id→warehouses']);
});

// ── resolving against the real catalog ──────────────────────────────────────

const TABLES = new Set(['orders', 'warehouses', 'order_lines']);
const COLS: Record<string, Set<string>> = {
  orders: new Set(['id', 'order_id', 'total']),
  warehouses: new Set(['id', 'name']),
  order_lines: new Set(['line_no', 'order_id']),
};
const columnsOf = (t: string) => COLS[t] ?? new Set<string>();

test('a reference to a table that does not exist is not turned into a virtual FK', () => {
  // Navigating to a missing table is a dead end the user cannot fix from here.
  const { resolved, unresolved } = resolveSoftRefs(
    [{ fromTable: 'a', fromColumn: 'w_id', toTable: 'warehouse', toColumn: 'id', evidence: 'FK to warehouse.id' }],
    TABLES, columnsOf);
  assert.equal(resolved.length, 0);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].why, /no table named warehouse/);
  assert.equal(unresolved[0].didYouMean, 'warehouses', 'the miss is nearly always a plural');
});

test('case is normalised to what the catalog actually calls it', () => {
  const { resolved } = resolveSoftRefs(
    [{ fromTable: 'a', fromColumn: 'o', toTable: 'ORDERS', toColumn: 'ID', evidence: '' }],
    TABLES, columnsOf);
  assert.equal(resolved[0].toTable, 'orders');
  assert.equal(resolved[0].toColumn, 'id');
});

test('a table-only reference has its key guessed, and only from the catalog', () => {
  const { resolved } = resolveSoftRefs(
    [{ fromTable: 'a', fromColumn: 'o', toTable: 'orders', toColumn: null, evidence: '' }],
    TABLES, columnsOf);
  assert.equal(resolved[0].toColumn, 'id');
});

test('a table-only reference with no obvious key is left unresolved rather than guessed wildly', () => {
  const { resolved, unresolved } = resolveSoftRefs(
    [{ fromTable: 'a', fromColumn: 'l', toTable: 'order_lines', toColumn: null, evidence: '' }],
    TABLES, columnsOf);
  assert.equal(resolved.length, 0);
  assert.match(unresolved[0].why, /no obvious key column/);
});

test('a named column that does not exist is unresolved, not silently replaced', () => {
  const { resolved, unresolved } = resolveSoftRefs(
    [{ fromTable: 'a', fromColumn: 'o', toTable: 'orders', toColumn: 'nope', evidence: '' }],
    TABLES, columnsOf);
  assert.equal(resolved.length, 0);
  assert.match(unresolved[0].why, /has no column nope/);
});

test('the plural guess works in both directions', () => {
  assert.equal(nearestName('warehouse', ['warehouses']), 'warehouses');
  assert.equal(nearestName('trolleys', ['trolley']), 'trolley');
  assert.equal(nearestName('nothing_like_it', ['orders']), undefined);
});

// ── reading the comments ────────────────────────────────────────────────────

test('comments come from the catalog, on both engines, and only non-empty ones', () => {
  const my = commentedColumnsSql('mysql', 'shop');
  assert.match(my, /information_schema\.columns/);
  assert.match(my, /column_comment <> ''/);
  assert.match(my, /'shop'/);

  const pg = commentedColumnsSql('postgres', 'public');
  assert.match(pg, /pg_description/);
  assert.match(pg, /objsubid > 0/, 'objsubid 0 is the table comment, not a column');
});

test('the schema name is escaped', () => {
  assert.match(commentedColumnsSql('mysql', "sh'op"), /'sh''op'/);
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('a SQL Server column comment is an extended property, not a column', () => {
  // `information_schema.columns.column_comment` is MySQL's. On SQL Server the
  // description lives in sys.extended_properties as MS_Description, keyed by
  // (object_id, column_id) — so the MySQL query failed and this feature simply
  // produced nothing.
  const sql = commentedColumnsSql('sqlserver', 'sales');
  assert.match(sql, /sys\.extended_properties/);
  assert.match(sql, /'MS_Description'/);
  assert.match(sql, /ep\.class = 1 AND ep\.minor_id > 0/);
  // The output is still ALIASED `column_comment` — the caller reads it by that
  // name on every engine. What must not appear is the MySQL SOURCE.
  assert.match(sql, /AS column_comment/);
  assert.ok(!sql.includes('information_schema'), sql);
});

test('the SQL Server comment query escapes its schema', () => {
  assert.match(commentedColumnsSql('sqlserver', "it's"), /s\.name = 'it''s'/);
});

test('the other engines keep their own comment source', () => {
  assert.match(commentedColumnsSql('postgres', 's'), /pg_description/);
  assert.match(commentedColumnsSql('mysql', 's'), /column_comment/);
});
