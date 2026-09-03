/**
 * Wait-for graph from the InnoDB LATEST DETECTED DEADLOCK section
 * (src/utils/deadlockGraph.ts).
 *
 * The fixtures are realistic captured sections: the classic two-transaction
 * mutual row-lock wait (the case that is ~all deadlocks in the wild), a
 * three-transaction ring, and a MariaDB-flavoured variant. What is pinned:
 * per-transaction fields (trx id, thread, user, statement), lock lines
 * (table/index/mode, "waiting" stripped), holder resolution (table+index
 * first, "the other one" only when exactly two transactions are involved),
 * the victim, and cycle detection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDeadlockGraph, resolveEdges, findCycle, layoutDeadlockGraph,
  lockLabel, edgeInCycle, DL_NODE_W, DL_NODE_H,
  type DeadlockTxn,
} from '../src/utils/deadlockGraph.ts';

// A full-status wrapper so the section splitter sees real header rules.
const wrap = (deadlockBody: string) => `=====================================
2026-08-20 14:03:12 0x7f9c3c0a9700 INNODB MONITOR OUTPUT
=====================================
------------------------
LATEST DETECTED DEADLOCK
------------------------
${deadlockBody}
------------
TRANSACTIONS
------------
Trx id counter 1056900
History list length 12
`;

// MySQL 8.0: two updates taking rows in opposite order — the textbook cycle.
const MYSQL8 = `2026-08-20 14:03:11 0x7f9c3c0a9700
*** (1) TRANSACTION:
TRANSACTION 1056807, ACTIVE 4 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1136, 2 row lock(s)
MySQL thread id 812, OS thread handle 140371234567, query id 4401 10.0.0.21 app updating
UPDATE accounts SET balance = balance - 100 WHERE id = 7
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 412 page no 4 n bits 72 index \`PRIMARY\` of table \`shop\`.\`accounts\` trx id 1056807 lock_mode X locks rec but not gap
Record lock, heap no 3 PHYSICAL RECORD: n_fields 5; compact format; info bits 0
 0: len 4; hex 80000008; asc     ;;

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 412 page no 4 n bits 72 index \`PRIMARY\` of table \`shop\`.\`accounts\` trx id 1056807 lock_mode X locks rec but not gap waiting
Record lock, heap no 2 PHYSICAL RECORD: n_fields 5; compact format; info bits 0
 0: len 4; hex 80000007; asc     ;;

*** (2) TRANSACTION:
TRANSACTION 1056808, ACTIVE 3 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1136, 2 row lock(s)
MySQL thread id 813, OS thread handle 140371234568, query id 4402 10.0.0.22 app updating
UPDATE accounts SET balance = balance + 100 WHERE id = 8
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 412 page no 4 n bits 72 index \`PRIMARY\` of table \`shop\`.\`accounts\` trx id 1056808 lock_mode X locks rec but not gap
Record lock, heap no 4 PHYSICAL RECORD: n_fields 5; compact format; info bits 0
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 412 page no 4 n bits 72 index \`PRIMARY\` of table \`shop\`.\`accounts\` trx id 1056808 lock_mode X locks rec but not gap waiting
*** WE ROLL BACK TRANSACTION (2)`;

// Three transactions: 1 waits on 2, 2 waits on 3, 3 waits on 1.
const RING3 = `2026-08-20 15:44:02 0x7f1a2b3c4700
*** (1) TRANSACTION:
TRANSACTION 8801, ACTIVE 9 sec updating
mysql tables in use 1, locked 1
LOCK WAIT 2 lock struct(s), heap size 1136, 1 row lock(s)
MySQL thread id 51, OS thread handle 140000000001, query id 8801 10.0.0.1 batch updating
UPDATE t1 SET v = 1 WHERE id = 1
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 10 page no 3 n bits 72 index \`PRIMARY\` of table \`d\`.\`t1\` trx id 8801 lock_mode X locks rec but not gap
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 11 page no 3 n bits 72 index \`PRIMARY\` of table \`d\`.\`t2\` trx id 8801 lock_mode X locks rec but not gap waiting

*** (2) TRANSACTION:
TRANSACTION 8802, ACTIVE 8 sec updating
mysql tables in use 1, locked 1
LOCK WAIT 2 lock struct(s), heap size 1136, 1 row lock(s)
MySQL thread id 52, OS thread handle 140000000002, query id 8802 10.0.0.1 batch updating
UPDATE t2 SET v = 1 WHERE id = 1
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 11 page no 3 n bits 72 index \`PRIMARY\` of table \`d\`.\`t2\` trx id 8802 lock_mode X locks rec but not gap
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 12 page no 3 n bits 72 index \`PRIMARY\` of table \`d\`.\`t3\` trx id 8802 lock_mode X locks rec but not gap waiting

*** (3) TRANSACTION:
TRANSACTION 8803, ACTIVE 7 sec updating
mysql tables in use 1, locked 1
LOCK WAIT 2 lock struct(s), heap size 1136, 1 row lock(s)
MySQL thread id 53, OS thread handle 140000000003, query id 8803 10.0.0.1 batch updating
UPDATE t3 SET v = 1 WHERE id = 1
*** (3) HOLDS THE LOCK(S):
RECORD LOCKS space id 12 page no 3 n bits 72 index \`PRIMARY\` of table \`d\`.\`t3\` trx id 8803 lock_mode X locks rec but not gap
*** (3) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 10 page no 3 n bits 72 index \`PRIMARY\` of table \`d\`.\`t1\` trx id 8803 lock_mode X locks rec but not gap waiting
*** WE ROLL BACK TRANSACTION (3)`;

// MariaDB 10.11: slightly different spacing, no host/user on the thread line.
const MARIADB = `2026-08-21 08:12:40 0x7f0a1b2c3700
*** (1) TRANSACTION:
TRANSACTION 2210, ACTIVE 2 sec inserting
mysql tables in use 1, locked 1
LOCK WAIT 2 lock struct(s), heap size 1128, 1 row lock(s)
MySQL thread id 34, OS thread handle 123145302683648, query id 1004 localhost root update
INSERT INTO orders (id, total) VALUES (9, 42)
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 60 page no 3 n bits 72 index \`PRIMARY\` of table \`shop\`.\`orders\` trx id 2210 lock_mode X insert intention waiting
*** (2) TRANSACTION:
TRANSACTION 2209, ACTIVE 5 sec
mysql tables in use 1, locked 1
3 lock struct(s), heap size 1128, 2 row lock(s)
MySQL thread id 33, OS thread handle 123145302130688, query id 1001 localhost root update
INSERT INTO orders (id, total) VALUES (9, 99)
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 60 page no 3 n bits 72 index \`PRIMARY\` of table \`shop\`.\`orders\` trx id 2209 lock_mode X
*** WE ROLL BACK TRANSACTION (1)`;

test('MySQL 8 two-transaction deadlock parses into a full graph', () => {
  const g = parseDeadlockGraph(wrap(MYSQL8));
  assert.ok(g, 'section found');
  assert.equal(g.when, '2026-08-20 14:03:11 0x7f9c3c0a9700');
  assert.equal(g.transactions.length, 2);
  assert.equal(g.victim, 2);

  const [t1, t2] = g.transactions;
  assert.equal(t1.ordinal, 1);
  assert.equal(t1.trxId, '1056807');
  assert.equal(t1.threadId, '812');
  assert.equal(t1.host, '10.0.0.21');
  assert.equal(t1.user, 'app');
  assert.equal(t1.query, 'UPDATE accounts SET balance = balance - 100 WHERE id = 7');
  assert.equal(t2.trxId, '1056808');

  // Locks: table, index and mode; the trailing "waiting" is stripped.
  const w = t1.waitingFor!;
  assert.equal(w.kind, 'record');
  assert.equal(w.table, '`shop`.`accounts`');
  assert.equal(w.index, 'PRIMARY');
  assert.equal(w.mode, 'X locks rec but not gap');
  assert.equal(w.modeShort, 'X');
  assert.equal(t1.holds.length, 1);

  // Each waits on what the other holds → the cycle closes.
  assert.deepEqual(g.edges.map(e => [e.from, e.to]), [[1, 2], [2, 1]]);
  assert.deepEqual(g.cycle, [1, 2]);
  assert.ok(g.edges.every(e => edgeInCycle(e, g.cycle)));
});

test('a three-transaction ring resolves through table matching', () => {
  const g = parseDeadlockGraph(wrap(RING3))!;
  assert.equal(g.transactions.length, 3);
  assert.equal(g.victim, 3);
  // 1 waits on t2 (held by 2), 2 waits on t3 (held by 3), 3 waits on t1 (held by 1).
  assert.deepEqual(g.edges.map(e => [e.from, e.to]), [[1, 2], [2, 3], [3, 1]]);
  assert.deepEqual(g.cycle, [1, 2, 3]);
});

test('MariaDB wording parses; a one-sided HOLDS still resolves the 2-cycle', () => {
  const g = parseDeadlockGraph(wrap(MARIADB))!;
  assert.equal(g.transactions.length, 2);
  const [t1, t2] = g.transactions;
  // (1) has no HOLDS section at all.
  assert.equal(t1.holds.length, 0);
  assert.equal(t1.waitingFor!.mode, 'X insert intention');
  // Only (2) waits? No — (2) has no WAITING section here; (1)'s wait resolves
  // to the other transaction because a two-node deadlock is mutual.
  assert.equal(t2.waitingFor, null);
  assert.deepEqual(g.edges.map(e => [e.from, e.to]), [[1, 2]]);
  // One resolved edge cannot close the loop — no cycle is claimed.
  assert.equal(g.cycle, null);
  assert.equal(g.victim, 1);
});

test('no deadlock section → null, missing pieces → null fields, never throws', () => {
  assert.equal(parseDeadlockGraph('nothing here'), null);
  assert.equal(parseDeadlockGraph(null), null);
  assert.equal(parseDeadlockGraph(wrap('2026-08-20 00:00:00 0x0\nno transaction blocks')), null);

  const bare = wrap(`2026-08-20 01:00:00 0x0
*** (1) TRANSACTION:
TRANSACTION 42, ACTIVE 1 sec
*** WE ROLL BACK TRANSACTION (1)`);
  const g = parseDeadlockGraph(bare)!;
  assert.equal(g.transactions.length, 1);
  const t = g.transactions[0];
  assert.equal(t.trxId, '42');
  assert.equal(t.threadId, null);
  assert.equal(t.user, null);
  assert.equal(t.query, null);
  assert.equal(t.waitingFor, null);
  assert.deepEqual(g.edges, []);
  assert.equal(g.victim, 1);
});

test('the holder is left unresolved rather than guessed with 3+ transactions', () => {
  // The waiter names a table nobody's HOLDS list mentions: InnoDB shows the
  // held locks that matter, not necessarily the one blocking us.
  const txt = wrap(`2026-08-20 02:00:00 0x0
*** (1) TRANSACTION:
TRANSACTION 1, ACTIVE 1 sec
MySQL thread id 1, OS thread handle 0, query id 1 h u updating
UPDATE a SET x = 1
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 1 page no 1 n bits 72 index \`PRIMARY\` of table \`d\`.\`ghost\` trx id 1 lock_mode X locks rec but not gap waiting
*** (2) TRANSACTION:
TRANSACTION 2, ACTIVE 1 sec
MySQL thread id 2, OS thread handle 0, query id 2 h u updating
UPDATE b SET x = 1
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 2 page no 1 n bits 72 index \`PRIMARY\` of table \`d\`.\`b\` trx id 2 lock_mode X locks rec but not gap
*** (3) TRANSACTION:
TRANSACTION 3, ACTIVE 1 sec
MySQL thread id 3, OS thread handle 0, query id 3 h u updating
UPDATE c SET x = 1
*** (3) HOLDS THE LOCK(S):
RECORD LOCKS space id 3 page no 1 n bits 72 index \`PRIMARY\` of table \`d\`.\`c\` trx id 3 lock_mode X locks rec but not gap
*** WE ROLL BACK TRANSACTION (3)`);
  const g = parseDeadlockGraph(txt)!;
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].to, null, 'no table match and not a 2-node case → unresolved');
});

test('table locks parse (TABLE LOCK … lock mode IX)', () => {
  const txt = wrap(`2026-08-20 03:00:00 0x0
*** (1) TRANSACTION:
TRANSACTION 7, ACTIVE 1 sec
MySQL thread id 9, OS thread handle 0, query id 9 h u updating
LOCK TABLES a WRITE
*** (1) HOLDS THE LOCK(S):
TABLE LOCK table \`d\`.\`a\` trx id 7 lock mode IX
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
TABLE LOCK table \`d\`.\`a\` trx id 7 lock mode X waiting
*** (2) TRANSACTION:
TRANSACTION 8, ACTIVE 1 sec
MySQL thread id 10, OS thread handle 0, query id 10 h u updating
LOCK TABLES a WRITE
*** (2) HOLDS THE LOCK(S):
TABLE LOCK table \`d\`.\`a\` trx id 8 lock mode X
*** WE ROLL BACK TRANSACTION (1)`);
  const g = parseDeadlockGraph(txt)!;
  const w = g.transactions[0].waitingFor!;
  assert.equal(w.kind, 'table');
  assert.equal(w.index, null);
  assert.equal(w.mode, 'X');
  assert.deepEqual(g.edges.map(e => [e.from, e.to]), [[1, 2]]);
});

test('lockLabel compresses a lock to mode · table · index', () => {
  const g = parseDeadlockGraph(wrap(MYSQL8))!;
  assert.equal(lockLabel(g.transactions[0].waitingFor!), 'X · `shop`.`accounts` · idx PRIMARY');
});

test('findCycle ignores unresolved edges and reports wait order', () => {
  assert.deepEqual(findCycle([
    { from: 1, to: 2, lock: {} as never },
    { from: 2, to: 3, lock: {} as never },
    { from: 3, to: null, lock: {} as never },
  ]), null);
  assert.deepEqual(findCycle([
    { from: 5, to: 6, lock: {} as never },
    { from: 6, to: 5, lock: {} as never },
  ]), [5, 6]);
});

test('resolveEdges prefers the table+index match over table-only', () => {
  const txn = (ordinal: number, holdsIdx: string | null, waitIdx: string | null): DeadlockTxn => ({
    ordinal, trxId: String(ordinal), status: null, threadId: null, host: null, user: null,
    query: null,
    holds: holdsIdx === null ? [] : [
      { kind: 'record', table: '`d`.`t`', index: holdsIdx, mode: 'X', modeShort: 'X' },
    ],
    waitingFor: waitIdx === null ? null : {
      kind: 'record', table: '`d`.`t`', index: waitIdx, mode: 'S', modeShort: 'S',
    },
  });
  // (3) waits on idx_a; (1) holds idx_a, (2) holds idx_b on the same table.
  const edges = resolveEdges([txn(1, 'idx_a', null), txn(2, 'idx_b', null), txn(3, 'idx_b', 'idx_a')]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, 1);
});

test('layout: one node centers, two sit left/right, a ring stays inside', () => {
  const one = layoutDeadlockGraph([1], 800, 600);
  assert.deepEqual(one.get(1), { x: 400 - DL_NODE_W / 2, y: 300 - DL_NODE_H / 2 });

  const two = layoutDeadlockGraph([1, 2], 800, 600);
  const [a, b] = [two.get(1)!, two.get(2)!];
  assert.ok(a.x < 400 && b.x > 400, 'left/right split');
  assert.equal(a.y, b.y);

  const ring = layoutDeadlockGraph([1, 2, 3, 4, 5, 6], 800, 600);
  assert.equal(ring.size, 6);
  for (const p of ring.values()) {
    assert.ok(p.x >= 0 && p.y >= 0);
    assert.ok(p.x + DL_NODE_W <= 800 && p.y + DL_NODE_H <= 600);
  }
  // Distinct positions.
  assert.equal(new Set([...ring.values()].map(p => `${p.x},${p.y}`)).size, 6);
});
