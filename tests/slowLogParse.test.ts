import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlowLog, groupSlowLog, fingerprint } from '../src/utils/slowLogParse.ts';

const LOG = `# Time: 2026-01-01T12:00:00.000000Z
# User@Host: app[app] @ localhost []  Id: 10
# Query_time: 1.500000  Lock_time: 0.000100 Rows_sent: 1  Rows_examined: 5000
SET timestamp=1735732800;
SELECT * FROM orders WHERE id = 42;
# Time: 2026-01-01T12:00:05.000000Z
# User@Host: app[app] @ localhost []  Id: 11
# Query_time: 0.500000  Lock_time: 0.000000 Rows_sent: 1  Rows_examined: 5000
SELECT * FROM orders WHERE id = 99;
# Time: 2026-01-01T12:00:10.000000Z
# User@Host: app[app] @ localhost []  Id: 12
# Query_time: 3.000000  Lock_time: 0.000000 Rows_sent: 100 Rows_examined: 200000
SELECT name FROM customers WHERE country IN (1, 2, 3);
`;

test('parseSlowLog extracts entries with timings and SQL, skipping SET timestamp', () => {
  const e = parseSlowLog(LOG);
  assert.equal(e.length, 3);
  assert.equal(e[0].queryTimeMs, 1500);
  assert.equal(e[0].rowsExamined, 5000);
  assert.ok(!e[0].sql.includes('SET timestamp'));
  assert.match(e[0].sql, /SELECT \* FROM orders WHERE id = 42/);
});

test('fingerprint collapses literals and IN-lists', () => {
  assert.equal(fingerprint('SELECT * FROM orders WHERE id = 42'), 'select * from orders where id = ?');
  assert.equal(fingerprint("SELECT x WHERE c IN (1, 2, 3)"), 'select x where c in (?)');
});

test('groupSlowLog groups by shape and ranks by total time', () => {
  const g = groupSlowLog(parseSlowLog(LOG));
  // The two id= queries share a fingerprint → one group of 2; customers → another.
  const orders = g.find(x => x.fingerprint.includes('orders'))!;
  assert.equal(orders.count, 2);
  assert.equal(orders.totalMs, 2000);
  assert.equal(orders.maxMs, 1500);
  // Ranked by total time: customers (3000ms) first.
  assert.ok(g[0].fingerprint.includes('customers'));
});
