/**
 * SQL Server deadlock XML → the shared deadlock graph.
 *
 * The fixture is a REAL report, captured from SQL Server 2022 by deliberately
 * deadlocking two transactions against each other (A: dl_a then dl_b; B: dl_b
 * then dl_a). The server named process 74 the victim, and these assertions are
 * checked against what it actually said.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMssqlDeadlock, MSSQL_DEADLOCK_SQL } from '../src/utils/mssqlDeadlock.ts';

const xml = readFileSync('tests/fixtures/mssql-deadlock.xml', 'utf8');

describe('parsing a real deadlock report', () => {
  const g = parseMssqlDeadlock(xml)!;

  test('both transactions are recovered, in report order', () => {
    assert.ok(g);
    assert.equal(g.transactions.length, 2);
    assert.deepEqual(g.transactions.map(t => t.ordinal), [1, 2]);
    assert.deepEqual(g.transactions.map(t => t.threadId), ['74', '72']);
  });

  test('the victim is the process SQL Server actually rolled back', () => {
    // The server said: "Process ID 74 ... chosen as the deadlock victim".
    assert.equal(g.victim, 1);
    assert.equal(g.transactions[g.victim! - 1].threadId, '74');
  });

  test('the wait-for cycle closes', () => {
    // Each waits on the other — the definition of the deadlock.
    assert.deepEqual(g.cycle, [1, 2]);
  });

  test('edges name both ends, with the lock between them', () => {
    assert.equal(g.edges.length, 2);
    const [a, b] = g.edges;
    assert.equal(a.from, 1); assert.equal(a.to, 2);
    assert.equal(b.from, 2); assert.equal(b.to, 1);
    // SQL Server names owners explicitly, so unlike the InnoDB text there is
    // never an unresolved holder.
    assert.ok(g.edges.every(e => e.to !== null));
    assert.deepEqual(g.edges.map(e => e.lock.modeShort), ['X', 'X']);
    assert.deepEqual(g.edges.map(e => e.lock.table),
      ['txui_demo.dbo.dl_a', 'txui_demo.dbo.dl_b']);
    assert.ok(g.edges.every(e => e.lock.index?.startsWith('PK__dl_')));
  });

  test('each transaction carries the statement it was running', () => {
    // The whole reason to keep deadlock history: what the other session was
    // doing, hours after it finished.
    for (const t of g.transactions) {
      assert.match(t.query ?? '', /BEGIN TRAN/);
      assert.match(t.query ?? '', /UPDATE dbo\.dl_[ab]/);
    }
    // The two ran the tables in opposite orders — that IS the deadlock.
    assert.notEqual(g.transactions[0].query, g.transactions[1].query);
  });

  test('holds and waits are both populated', () => {
    for (const t of g.transactions) {
      assert.equal(t.holds.length, 1, `txn ${t.ordinal} holds`);
      assert.ok(t.waitingFor, `txn ${t.ordinal} waits`);
      // It cannot be waiting on what it already holds.
      assert.notEqual(t.holds[0].table, t.waitingFor!.table);
    }
  });

  test('identity and status survive', () => {
    const t = g.transactions[0];
    assert.equal(t.user, 'sa');
    assert.match(t.host ?? '', /SQLCMD/);
    assert.match(t.status ?? '', /suspended/);
    assert.match(t.status ?? '', /read committed/);
    assert.ok(t.trxId);
  });

  test('the raw report is kept for the raw view and history', () => {
    assert.equal(g.raw, xml);
  });
});

describe('robustness', () => {
  test('non-deadlock input returns null rather than throwing', () => {
    for (const s of [null, undefined, '', 'not xml', '<event name="something_else"/>']) {
      assert.equal(parseMssqlDeadlock(s as string | null), null, String(s));
    }
  });

  test('a report with no processes is not a graph', () => {
    assert.equal(parseMssqlDeadlock('<deadlock><victim-list/></deadlock>'), null);
  });

  test('XML entities in the statement are decoded', () => {
    const doc = `<deadlock><victim-list/><process-list>
      <process id="p1" spid="1"><inputbuf>SELECT * FROM t WHERE a &lt; 1 AND b &gt; 2 &amp;&amp; c</inputbuf></process>
      </process-list></deadlock>`;
    const g = parseMssqlDeadlock(doc)!;
    assert.equal(g.transactions[0].query, 'SELECT * FROM t WHERE a < 1 AND b > 2 && c');
  });

  test('an escaped ampersand does not decode twice', () => {
    // `&amp;lt;` is a literal "&lt;", not a "<". Unescaping & first would turn
    // it into one — which is why & is unescaped last.
    const doc = `<deadlock><victim-list/><process-list>
      <process id="p1"><inputbuf>a &amp;lt; b</inputbuf></process></process-list></deadlock>`;
    assert.equal(parseMssqlDeadlock(doc)!.transactions[0].query, 'a &lt; b');
  });

  test('a parallelism deadlock is named rather than dropped', () => {
    // exchangeEvent has no objectname. A deadlock the panel cannot draw a table
    // for is still one the user needs to know happened.
    const doc = `<deadlock><victim-list><victimProcess id="p1"/></victim-list><process-list>
      <process id="p1" spid="1"/><process id="p2" spid="2"/></process-list>
      <resource-list><exchangeEvent id="Pipe1" WaitType="e_waitPipeNewRow" nodeId="2">
        <owner-list><owner id="p2"/></owner-list>
        <waiter-list><waiter id="p1"/></waiter-list></exchangeEvent></resource-list></deadlock>`;
    const g = parseMssqlDeadlock(doc)!;
    assert.equal(g.edges.length, 1);
    assert.match(g.edges[0].lock.table, /parallelism/);
  });
});

describe('the query', () => {
  test('reads the ring buffer, not only the event file', () => {
    // The file target buffers: measured returning ZERO rows seconds after a
    // real deadlock. Reading it alone makes the panel look broken exactly when
    // someone is testing it.
    assert.match(MSSQL_DEADLOCK_SQL, /ring_buffer/);
    assert.match(MSSQL_DEADLOCK_SQL, /xml_deadlock_report/);
    assert.match(MSSQL_DEADLOCK_SQL, /system_health/);
  });
  test('newest first, and bounded', () => {
    assert.match(MSSQL_DEADLOCK_SQL, /ORDER BY captured_at DESC/);
    assert.match(MSSQL_DEADLOCK_SQL, /TOP 20/);
  });
});
