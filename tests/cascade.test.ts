/**
 * Cascade blast radius (src/utils/cascade.ts).
 *
 * The bug this exists to prevent is not a crash. It is a `DELETE` that does
 * exactly what it was told, two levels down, in a table the person running it
 * has never opened. So the properties that matter are about *honesty*:
 *
 *  - a cycle must stop the walk, not the report;
 *  - two foreign keys between the same pair of tables are one route, or the
 *    radius looks bigger than it is;
 *  - `SET NULL` does not propagate — the child row survives, so nothing below
 *    it is touched, and walking past it would invent a blast radius;
 *  - every count is an upper bound and must be worded as one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCascade, parseAction, routeText, summarize, isNotable,
  destructiveTarget, unquote, fkGraphSql, rowCountSql, edgesFromRows,
} from '../src/utils/cascade.ts';
import type { FkEdge } from '../src/utils/cascade.ts';

const fk = (child: string, parent: string, onDelete: FkEdge['onDelete'], constraint = `fk_${child}`): FkEdge =>
  ({ constraint, child, parent, onDelete });

const counts = (o: Record<string, number | null>) => new Map(Object.entries(o));

// ── actions ─────────────────────────────────────────────────────────────────

test('every catalog spelling of an action is understood', () => {
  assert.equal(parseAction('CASCADE'), 'CASCADE');
  assert.equal(parseAction('cascade'), 'CASCADE');
  assert.equal(parseAction('SET_NULL'), 'SET NULL');     // pg_constraint style
  assert.equal(parseAction('SET NULL'), 'SET NULL');     // information_schema style
  assert.equal(parseAction('RESTRICT'), 'RESTRICT');
});

test('an unknown action reads as NO ACTION — the conservative side', () => {
  // NO ACTION blocks rather than destroys, so guessing it is the safe error.
  assert.equal(parseAction('WHAT'), 'NO ACTION');
  assert.equal(parseAction(null), 'NO ACTION');
});

// ── walking ─────────────────────────────────────────────────────────────────

test('a two-level cascade is found, with the chain and the count', () => {
  const edges = [
    fk('order_lines', 'orders', 'CASCADE'),
    fk('line_taxes', 'order_lines', 'CASCADE'),
  ];
  const a = analyzeCascade('orders', edges, counts({ order_lines: 5000, line_taxes: 12000 }), 'delete');
  assert.equal(a.cascades.length, 2);
  assert.equal(a.maxDepth, 2);
  assert.equal(a.totalRows, 17000);
  assert.equal(routeText(a.cascades[1]), 'orders --[CASCADE]--> order_lines --[CASCADE]--> line_taxes');
});

test('SET NULL does not propagate', () => {
  // The child row survives, so nothing below it is deleted. Walking past it
  // would report a blast radius that cannot happen.
  const edges = [
    fk('invoices', 'orders', 'SET NULL'),
    fk('invoice_lines', 'invoices', 'CASCADE'),
  ];
  const a = analyzeCascade('orders', edges, counts({ invoices: 100, invoice_lines: 900 }), 'delete');
  assert.equal(a.cascades.length, 0);
  assert.equal(a.setNulls.length, 1);
  assert.equal(a.totalRows, null, 'nothing is deleted, so there is no row total');
});

test('a cycle stops the walk instead of hanging it', () => {
  const edges = [
    fk('b', 'a', 'CASCADE'),
    fk('c', 'b', 'CASCADE'),
    fk('a', 'c', 'CASCADE'),      // back to the start
  ];
  const a = analyzeCascade('a', edges, counts({}), 'delete');
  assert.equal(a.maxDepth, 2);
  assert.deepEqual(a.cascades.map(r => r.chain.join('>')), ['a>b', 'a>b>c']);
});

test('two foreign keys between the same pair are one route', () => {
  // Two constraints, one cascade route — reporting it twice doubles the
  // apparent radius.
  const edges = [
    fk('shipments', 'orders', 'CASCADE', 'fk_ship_order'),
    fk('shipments', 'orders', 'CASCADE', 'fk_ship_order_alt'),
  ];
  const a = analyzeCascade('orders', edges, counts({ shipments: 40 }), 'delete');
  assert.equal(a.cascades.length, 1);
  assert.equal(a.totalRows, 40);
});

test('a table reachable by two different routes is reported twice, on purpose', () => {
  // Unlike the duplicate-constraint case, these are genuinely different paths
  // and hiding one would misrepresent the graph.
  const edges = [
    fk('mid1', 'root', 'CASCADE'),
    fk('mid2', 'root', 'CASCADE'),
    fk('leaf', 'mid1', 'CASCADE'),
    fk('leaf', 'mid2', 'CASCADE'),
  ];
  const a = analyzeCascade('root', edges, counts({}), 'delete');
  const chains = a.cascades.map(r => r.chain.join('>')).sort();
  assert.deepEqual(chains, ['root>mid1', 'root>mid1>leaf', 'root>mid2', 'root>mid2>leaf']);
});

test('table names are matched case-insensitively', () => {
  const a = analyzeCascade('Orders', [fk('lines', 'ORDERS', 'CASCADE')], counts({ LINES: 7 }), 'delete');
  assert.equal(a.cascades.length, 1);
  assert.equal(a.cascades[0].rows, 7);
});

// ── blockers ────────────────────────────────────────────────────────────────

test('RESTRICT and NO ACTION are blockers, and only at the first level', () => {
  const edges = [
    fk('audit', 'orders', 'RESTRICT'),
    fk('legacy', 'orders', 'NO ACTION'),
    fk('deep', 'audit', 'RESTRICT'),      // never reached — the statement fails first
  ];
  const a = analyzeCascade('orders', edges, counts({}), 'drop');
  assert.deepEqual(a.blockers.map(b => b.child).sort(), ['audit', 'legacy']);
  assert.match(summarize(a)!, /the statement will fail/);
});

// ── wording ─────────────────────────────────────────────────────────────────

test('the summary hedges the count, because it is an upper bound', () => {
  // The real number needs the join this exists to avoid running.
  const a = analyzeCascade('orders', [fk('lines', 'orders', 'CASCADE')], counts({ lines: 2060057 }), 'delete');
  assert.match(summarize(a)!, /up to 2,060,057 rows/);
});

test('depth is called out, because that is the part nobody has in their head', () => {
  const edges = [fk('b', 'a', 'CASCADE'), fk('c', 'b', 'CASCADE')];
  assert.match(summarize(analyzeCascade('a', edges, counts({}), 'delete'))!, /2 levels deep/);
});

test('SET NULL is described as erasure, not deletion', () => {
  const a = analyzeCascade('orders', [fk('invoices', 'orders', 'SET NULL')], counts({ invoices: 3 }), 'delete');
  assert.match(summarize(a)!, /the rows survive, their meaning does not/);
});

test('nothing to say produces nothing', () => {
  const a = analyzeCascade('lonely', [], counts({}), 'drop');
  assert.equal(summarize(a), null);
  assert.equal(isNotable(a), false);
});

test('a chain two deep is notable even with no counts at all', () => {
  const edges = [fk('b', 'a', 'CASCADE'), fk('c', 'b', 'CASCADE')];
  assert.equal(isNotable(analyzeCascade('a', edges, counts({}), 'delete')), true);
});

// ── which statements ────────────────────────────────────────────────────────

test('the destructive statements are recognised, quoted or qualified', () => {
  assert.deepEqual(destructiveTarget('DROP TABLE IF EXISTS `shop`.`orders`'), { kind: 'drop', table: 'orders' });
  assert.deepEqual(destructiveTarget('truncate table orders'), { kind: 'truncate', table: 'orders' });
  assert.deepEqual(destructiveTarget('DELETE FROM "public"."orders" WHERE id = 1'), { kind: 'delete', table: 'orders' });
  assert.deepEqual(destructiveTarget('TRUNCATE orders'), { kind: 'truncate', table: 'orders' });
});

test('anything else is not a destructive statement', () => {
  for (const sql of ['SELECT 1', 'UPDATE orders SET x = 1', 'DROP INDEX ix ON orders', 'INSERT INTO orders VALUES (1)']) {
    assert.equal(destructiveTarget(sql), null, sql);
  }
});

test('unquoting keeps the table and drops the schema', () => {
  assert.equal(unquote('`shop`.`orders`'), 'orders');
  assert.equal(unquote('"orders"'), 'orders');
  assert.equal(unquote('orders'), 'orders');
});

// ── reading it out of a server ──────────────────────────────────────────────

test('the graph query asks for the delete rule — that is the whole point', () => {
  assert.match(fkGraphSql('mysql', 'shop'), /delete_rule/i);
  assert.match(fkGraphSql('postgres', 'public'), /confdeltype/);
  assert.match(fkGraphSql('mysql', "sh'op"), /'sh''op'/);
});

test('row counts come from statistics, never a COUNT(*)', () => {
  // The dialog must not pay for a scan to tell you a scan is coming.
  for (const engine of ['mysql', 'postgres']) {
    const sql = rowCountSql(engine, 'shop');
    assert.doesNotMatch(sql, /COUNT\s*\(/i, engine);
  }
  assert.match(rowCountSql('postgres', 'public'), /reltuples/);
  assert.match(rowCountSql('mysql', 'shop'), /table_rows/);
});

test('rows without a parent are dropped rather than becoming half an edge', () => {
  const edges = edgesFromRows([
    ['fk_a', 'lines', 'orders', 'CASCADE', 'order_id'],
    ['fk_b', 'orphan', null, 'CASCADE', 'x'],
  ]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].onDelete, 'CASCADE');
  assert.equal(edges[0].columns, 'order_id');
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('the MySQL FK query cannot run on SQL Server, so it gets its own', () => {
  // `information_schema.referential_constraints` EXISTS on SQL Server but has
  // no `table_name` or `referenced_table_name` — the MySQL shape fails with
  // "Invalid column name 'table_name'". A failed query here shows the delete
  // confirmation NO cascade consequences, which is the most dangerous way for
  // this to break: the dialog looks like it checked and found nothing.
  const sql = fkGraphSql('sqlserver', 'sales');
  assert.match(sql, /FROM sys\.foreign_keys fk/);
  assert.match(sql, /delete_referential_action_desc/);
  assert.ok(!sql.includes('referential_constraints'), sql);
  assert.ok(!sql.includes('GROUP_CONCAT'), sql);
});

test('row counts come from partition stats, not from a column that is absent', () => {
  // `information_schema.tables.table_rows` is MySQL's; SQL Server has no such
  // column, and COUNT(*) on every table is not an option in a dialog.
  const sql = rowCountSql('sqlserver', 'sales');
  assert.match(sql, /sys\.dm_db_partition_stats/);
  assert.match(sql, /index_id IN \(0, 1\)/);
  assert.ok(!sql.includes('table_rows'), sql);
});

test('the schema name is escaped in both SQL Server queries', () => {
  assert.match(fkGraphSql('sqlserver', "it's"), /s\.name = 'it''s'/);
  assert.match(rowCountSql('sqlserver', "it's"), /s\.name = 'it''s'/);
});

test('MySQL and PostgreSQL keep their own queries', () => {
  assert.match(fkGraphSql('postgres', 's'), /pg_constraint/);
  assert.match(fkGraphSql('mysql', 's'), /referential_constraints/);
});
