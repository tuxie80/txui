/**
 * Parsers for `SHOW ENGINE INNODB STATUS` (src/utils/innodbStatus.ts).
 *
 * The value here is that the monitor output is a wall of free text with no
 * stable schema, yet a DBA reads the same handful of numbers off it every time:
 * how far behind purge is (history list length), whether a transaction is stuck
 * (ACTIVE age + LOCK WAIT), how the buffer pool is doing, and the DML rates.
 * These tests pin section splitting, those extracted numbers, and — since MySQL
 * and MariaDB drop fields between versions — graceful handling of a missing
 * section.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSections, getSection, parseTransactions, parseBufferPool, parseRowOps,
  parseSemaphores, parseInnodbStatus,
} from '../src/utils/innodbStatus.ts';

// A realistic (trimmed) MySQL 8 monitor dump: one blocked ACTIVE transaction,
// one idle "not started" session, plus buffer-pool/row-ops/semaphore counters.
const SAMPLE = `=====================================
2026-08-13 09:41:22 0x7f8b1c0f4700 INNODB MONITOR OUTPUT
=====================================
Per second averages calculated from the last 41 seconds
-----------------
BACKGROUND THREAD
-----------------
srv_master_thread loops: 120 srv_active, 0 srv_shutdown, 4200 srv_idle
----------
SEMAPHORES
----------
OS WAIT ARRAY INFO: reservation count 2451
OS WAIT ARRAY INFO: signal count 1980
RW-shared spins 0, rounds 890, OS waits 12
RW-excl spins 5, rounds 240, OS waits 3
Mutex spin waits 100, rounds 3000, OS waits 40
Spin rounds per wait: 74.20 RW-shared, 20.00 RW-excl
------------------------
LATEST DETECTED DEADLOCK
------------------------
2026-08-12 23:10:01 0x7f8b1c0f4700
*** (1) TRANSACTION:
TRANSACTION 84102, ACTIVE 6 sec starting index read
*** WE ROLL BACK TRANSACTION (2)
------------
TRANSACTIONS
------------
Trx id counter 84500
Purge done for trx's n:o < 84210 undo n:o < 0 state: running but idle
History list length 271
LIST OF TRANSACTIONS FOR EACH SESSION:
---TRANSACTION 421104, not started
0 lock struct(s), heap size 1136, 0 row lock(s)
---TRANSACTION 84480, ACTIVE 12 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 2 lock struct(s), heap size 1136, 1 row lock(s)
MySQL thread id 45, OS thread handle 0x7f8b, query id 9901 10.0.0.5 app updating
UPDATE orders SET status = 'paid' WHERE id = 5
--------
FILE I/O
--------
I/O thread 0 state: waiting for completed aio requests (insert buffer thread)
-------------------------------------
INSERT BUFFER AND ADAPTIVE HASH INDEX
-------------------------------------
Ibuf: size 1, free list len 0, seg size 2, 0 merges
---
LOG
---
Log sequence number 12345678
----------------------
BUFFER POOL AND MEMORY
----------------------
Total large memory allocated 137363456
Dictionary memory allocated 456789
Buffer pool size   8192
Buffer pool size, bytes 134217728
Free buffers       1024
Database pages     7168
Old database pages 2000
Modified db pages  42
Pages made young 0, not young 0
Buffer pool hit rate 998 / 1000, young-making rate 0 / 1000 not 0 / 1000
Pages read 120345, created 678, written 9012
--------------
ROW OPERATIONS
--------------
0 queries inside InnoDB, 3 queries in queue
2 read views open inside InnoDB
Number of rows inserted 100000, updated 50000, deleted 2000, read 987654321
15.30 inserts/s, 7.20 updates/s, 0.50 deletes/s, 1234.00 reads/s
----------------------------
END OF INNODB MONITOR OUTPUT
============================
`;

test('splitSections names every section and excludes the banner', () => {
  const secs = splitSections(SAMPLE);
  const names = secs.map(s => s.name);
  for (const n of ['BACKGROUND THREAD', 'SEMAPHORES', 'LATEST DETECTED DEADLOCK',
    'TRANSACTIONS', 'FILE I/O', 'INSERT BUFFER AND ADAPTIVE HASH INDEX', 'LOG',
    'BUFFER POOL AND MEMORY', 'ROW OPERATIONS']) {
    assert.ok(names.includes(n), `missing section ${n}`);
  }
  // The "INNODB MONITOR OUTPUT" banner has a timestamp/hex, so it is not a section.
  assert.ok(!names.includes('INNODB MONITOR OUTPUT'));
  // ROW OPERATIONS is bounded by the "==== END OF …" banner, not swallowing it.
  const rowOps = getSection(secs, 'ROW OPERATIONS') ?? '';
  assert.ok(rowOps.includes('reads/s'));
  assert.ok(!rowOps.includes('END OF INNODB MONITOR OUTPUT'));
});

test('TRANSACTIONS: history list length and the active (not idle) transaction', () => {
  const t = parseTransactions(getSection(splitSections(SAMPLE), 'TRANSACTIONS'));
  assert.equal(t.historyListLength, 271);
  // The "not started" session is dropped; only the real one remains.
  assert.equal(t.transactions.length, 1);
  const tx = t.transactions[0];
  assert.equal(tx.id, '84480');
  assert.equal(tx.activeSecs, 12);
  assert.equal(tx.threadId, '45');
  assert.equal(tx.lockWait, true);
  assert.equal(tx.query, "UPDATE orders SET status = 'paid' WHERE id = 5");
});

test('BUFFER POOL: page counts, dirty pages, hit rate and I/O', () => {
  const b = parseBufferPool(getSection(splitSections(SAMPLE), 'BUFFER POOL AND MEMORY'));
  assert.equal(b.totalPages, 8192);          // not the "…, bytes 134217728" line
  assert.equal(b.freePages, 1024);
  assert.equal(b.databasePages, 7168);
  assert.equal(b.modifiedPages, 42);
  assert.equal(b.hitRate, '998 / 1000');
  assert.equal(b.pagesRead, 120345);
  assert.equal(b.pagesCreated, 678);
  assert.equal(b.pagesWritten, 9012);
});

test('ROW OPERATIONS: rates, totals and queue depth', () => {
  const r = parseRowOps(getSection(splitSections(SAMPLE), 'ROW OPERATIONS'));
  assert.equal(r.queriesInside, 0);
  assert.equal(r.queriesQueued, 3);
  assert.equal(r.insertedTotal, 100000);
  assert.equal(r.updatedTotal, 50000);
  assert.equal(r.deletedTotal, 2000);
  assert.equal(r.readTotal, 987654321);
  assert.equal(r.insertsPerSec, 15.3);
  assert.equal(r.updatesPerSec, 7.2);
  assert.equal(r.deletesPerSec, 0.5);
  assert.equal(r.readsPerSec, 1234);
});

test('SEMAPHORES: OS waits and spin rounds are summed across lines', () => {
  const s = parseSemaphores(getSection(splitSections(SAMPLE), 'SEMAPHORES'));
  assert.equal(s.reservationCount, 2451);
  assert.equal(s.signalCount, 1980);
  assert.equal(s.osWaits, 12 + 3 + 40);
  assert.equal(s.spinRounds, 890 + 240 + 3000);
  assert.equal(s.mutexSpinWaits, 100);
  assert.equal(s.rwSharedWaits, 12);
  assert.equal(s.rwExclWaits, 3);
});

test('parseInnodbStatus aggregates every section', () => {
  const all = parseInnodbStatus(SAMPLE);
  assert.equal(all.transactions.historyListLength, 271);
  assert.equal(all.bufferPool.totalPages, 8192);
  assert.equal(all.rowOps.queriesQueued, 3);
  assert.equal(all.semaphores.reservationCount, 2451);
});

test('missing / truncated sections degrade to null, not throw', () => {
  // MariaDB and older MySQL omit or reword sections; empty input must be safe.
  assert.deepEqual(splitSections(''), []);
  assert.deepEqual(splitSections(null), []);
  const all = parseInnodbStatus('');
  assert.equal(all.transactions.historyListLength, null);
  assert.deepEqual(all.transactions.transactions, []);
  assert.equal(all.bufferPool.totalPages, null);
  assert.equal(all.rowOps.insertsPerSec, null);
  assert.equal(all.semaphores.osWaits, null);

  // A section present but truncated before its numbers: fields are null.
  const truncated = `----------------------
BUFFER POOL AND MEMORY
----------------------
Total large memory allocated 137363456
`;
  const b = parseBufferPool(getSection(splitSections(truncated), 'BUFFER POOL AND MEMORY'));
  assert.equal(b.totalPages, null);
  assert.equal(b.hitRate, null);
  assert.equal(getSection(splitSections(truncated), 'ROW OPERATIONS'), null);
});
