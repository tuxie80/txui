/**
 * The cost of an ALTER, before it runs (src/utils/ddlCost.ts).
 *
 * The distinction the whole model exists for: `ADD COLUMN x INT` and
 * `ADD COLUMN x INT AFTER y` differ by three words and by a full table
 * rebuild. If the matcher gets that pair wrong, the dialog will confidently
 * tell someone a ten-minute rebuild is instant — which is worse than saying
 * nothing, and is why the narrower rule has to be tested to come first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ddlCost, isDdl, ddlTarget, describeCost, fmtSeconds, assumptionsText, ASSUMPTIONS,
} from '../src/utils/ddlCost.ts';

const GIB = 1024 ** 3;

// ── which statements ────────────────────────────────────────────────────────

test('only the statements with a cost model are claimed', () => {
  assert.ok(isDdl('ALTER TABLE orders ADD COLUMN x INT'));
  assert.ok(isDdl('CREATE INDEX ix ON orders (a)'));
  assert.ok(isDdl('VACUUM FULL orders'));
  assert.ok(!isDdl('SELECT 1'));
  assert.ok(!isDdl('UPDATE orders SET x = 1'));
  assert.ok(!isDdl('DROP TABLE orders'));
});

test('the target table is found, quoted or qualified', () => {
  assert.equal(ddlTarget('ALTER TABLE `shop`.`orders` ADD COLUMN x INT'), 'orders');
  assert.equal(ddlTarget('alter table only public.orders alter column x type text'), 'orders');
  assert.equal(ddlTarget('CREATE INDEX CONCURRENTLY ix ON public.orders (a)'), 'orders');
  assert.equal(ddlTarget('VACUUM FULL orders'), 'orders');
  assert.equal(ddlTarget('SELECT 1'), null);
});

// ── MySQL: the pair that differs by three words ─────────────────────────────

test('a trailing ADD COLUMN is instant; the same statement with AFTER rebuilds', () => {
  const trailing = ddlCost('ALTER TABLE orders ADD COLUMN note VARCHAR(50)', 'mysql', 10 * GIB)!;
  assert.equal(trailing.algorithm, 'INSTANT');
  assert.equal(trailing.rebuild, false);
  assert.equal(trailing.blockedSeconds, 0);

  const placed = ddlCost('ALTER TABLE orders ADD COLUMN note VARCHAR(50) AFTER id', 'mysql', 10 * GIB)!;
  assert.equal(placed.rebuild, true);
  assert.ok(placed.seconds! > 60, 'ten gigabytes at 40 MB/s is minutes, not milliseconds');
  assert.match(placed.why, /rewrites every row/);
});

test('a type change is a copy: reads continue, writes wait', () => {
  const c = ddlCost('ALTER TABLE orders MODIFY COLUMN total DECIMAL(14,2)', 'mysql', 1 * GIB)!;
  assert.equal(c.algorithm, 'COPY');
  assert.equal(c.lock, 'SHARED');
  assert.equal(c.rebuild, true);
  assert.equal(c.blockedSeconds, c.seconds, 'a SHARED lock blocks writes for the whole operation');
});

test('adding an index is online; changing the primary key is not', () => {
  assert.equal(ddlCost('ALTER TABLE orders ADD INDEX ix_total (total)', 'mysql', GIB)!.lock, 'NONE');
  const pk = ddlCost('ALTER TABLE orders DROP PRIMARY KEY, ADD PRIMARY KEY (id)', 'mysql', GIB)!;
  assert.equal(pk.rebuild, true);
  assert.match(pk.why, /clustered index is the table/);
});

test('a charset conversion rebuilds, and says so', () => {
  const c = ddlCost('ALTER TABLE orders CONVERT TO CHARACTER SET utf8mb4', 'mysql', 44 * GIB)!;
  assert.equal(c.rebuild, true);
  assert.equal(c.diskBytes, 44 * GIB, 'a rebuild needs room for a second copy');
});

// ── PostgreSQL: the lock is the story ───────────────────────────────────────

test('PostgreSQL ADD COLUMN is catalog-only but still takes an exclusive lock', () => {
  // The lock is the part people are surprised by: catalog-only does not mean
  // free, because ACCESS EXCLUSIVE queues every query on the table.
  const c = ddlCost('ALTER TABLE orders ADD COLUMN note text', 'postgres', 10 * GIB)!;
  assert.equal(c.rebuild, false);
  assert.equal(c.lock, 'EXCLUSIVE');
  assert.match(c.why, /queues every query/);
});

test('ALTER COLUMN TYPE rewrites the table and its indexes', () => {
  const c = ddlCost('ALTER TABLE orders ALTER COLUMN total TYPE numeric(14,2)', 'postgres', 2 * GIB)!;
  assert.equal(c.algorithm, 'REWRITE');
  assert.equal(c.rebuild, true);
  assert.ok(c.seconds! > 40);
});

test('CONCURRENTLY is recognised as the one that does not block', () => {
  const conc = ddlCost('CREATE INDEX CONCURRENTLY ix ON orders (total)', 'postgres', GIB)!;
  assert.equal(conc.lock, 'NONE');
  assert.equal(conc.blockedSeconds, 0);

  const plain = ddlCost('CREATE INDEX ix ON orders (total)', 'postgres', GIB)!;
  assert.equal(plain.lock, 'SHARED');
  assert.match(plain.why, /use CONCURRENTLY/);
});

test('NOT VALID is distinguished from the constraint that scans', () => {
  const lazy = ddlCost('ALTER TABLE orders ADD CONSTRAINT c CHECK (total > 0) NOT VALID', 'postgres', GIB)!;
  assert.match(lazy.why, /not checked until VALIDATE/);
  const eager = ddlCost('ALTER TABLE orders ADD CONSTRAINT c CHECK (total > 0)', 'postgres', GIB)!;
  assert.match(eager.why, /scanned to verify/);
});

// ── honesty ─────────────────────────────────────────────────────────────────

test('an unmodelled shape says so instead of inventing a number', () => {
  const c = ddlCost('ALTER TABLE orders DISCARD TABLESPACE', 'mysql', GIB)!;
  assert.equal(c.algorithm, 'UNKNOWN');
  assert.equal(c.seconds, null);
  assert.match(c.why, /not in the model/);
});

test('an unknown table size produces no time, not a zero', () => {
  const c = ddlCost('ALTER TABLE orders MODIFY COLUMN a INT', 'mysql', null)!;
  assert.equal(c.seconds, null);
  assert.equal(c.blockedSeconds, null);
  assert.equal(c.diskBytes, null);
});

test('replica lag equals the run time, because DDL applies serially there', () => {
  // The part that turns a maintenance window into an incident.
  const c = ddlCost('ALTER TABLE orders MODIFY COLUMN a INT', 'mysql', 4 * GIB)!;
  assert.equal(c.replicaLagSeconds, c.seconds);
});

test('a metadata-only change gets a floor, not a fabricated zero', () => {
  const c = ddlCost('ALTER TABLE orders DROP INDEX ix', 'mysql', 100 * GIB)!;
  assert.equal(c.seconds, ASSUMPTIONS.metadataFloorSeconds);
});

test('the assumptions are printable, and name the constant', () => {
  assert.match(assumptionsText(), /40 MB\/s/);
  assert.match(assumptionsText(), /Estimates, not measurements/);
});

// ── wording ─────────────────────────────────────────────────────────────────

test('the one-line description carries the four facts that decide the window', () => {
  const line = describeCost(ddlCost('ALTER TABLE orders MODIFY COLUMN a INT', 'mysql', 4 * GIB)!);
  assert.match(line, /MODIFY COLUMN/);
  assert.match(line, /algorithm COPY/);
  assert.match(line, /lock SHARED/);
  assert.match(line, /rebuilds the table/);
  assert.match(line, /writes blocked/);
});

test('an online operation says writes continue rather than blocking for zero', () => {
  assert.match(describeCost(ddlCost('ALTER TABLE orders ADD INDEX ix (a)', 'mysql', GIB)!), /writes continue/);
});

test('durations read the way a person would say them', () => {
  assert.equal(fmtSeconds(0.1), '100 ms');
  assert.equal(fmtSeconds(12.34), '12.3 s');
  assert.equal(fmtSeconds(734), '12 min 14 s');
  assert.equal(fmtSeconds(7200), '2.0 h');
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// The costs below are MEASURED on a 33,334-row table on SQL Server 2022, not
// inferred: nullable add / NOT NULL-with-default / drop column all ~4 ms,
// varchar widening 0 ms, int→bigint 212 ms.

const MB6 = 6 * 1024 * 1024;
const ms = (sql: string) => ddlCost(sql, 'sqlserver', MB6);

test('T-SQL no longer gets MySQL\'s answer for a T-SQL statement', () => {
  // `ALTER TABLE t ADD qty int` matched MySQL's ADD COLUMN rule and was
  // reported as "MySQL 8.0.12+ adds a trailing column as metadata only", with
  // lock NONE. The conclusion was roughly right; the reason and the lock were
  // not, and this is the dialog where being confidently wrong costs most.
  const r = ms('ALTER TABLE dbo.t ADD qty int NULL')!;
  assert.ok(!r.why.includes('MySQL'), r.why);
  assert.ok(!r.why.includes('8.0.12'), r.why);
  assert.equal(r.rebuild, false);
});

test('a cheap SQL Server change still blocks readers — there is no LOCK=NONE', () => {
  // On MySQL LOCK=NONE means reads AND writes continue. Every SQL Server ALTER
  // TABLE takes a schema-modification lock, which blocks readers too; the
  // difference between cheap and expensive is how LONG it is held.
  for (const sql of [
    'ALTER TABLE dbo.t ADD c int NULL',
    'ALTER TABLE dbo.t DROP COLUMN c',
    'ALTER TABLE dbo.t ADD c int NOT NULL CONSTRAINT DF DEFAULT 0',
  ]) {
    const r = ms(sql)!;
    assert.equal(r.lock, 'EXCLUSIVE', sql);
    assert.equal(r.rebuild, false, sql);
  }
});

test('a NOT NULL column with no default is refused, not estimated', () => {
  // Msg 4901 — it is not a cost, it is a statement that will not run.
  const r = ms('ALTER TABLE dbo.t ADD c3 int NOT NULL')!;
  assert.match(r.why, /REFUSES/);
  assert.match(r.why, /4901/);
  assert.equal(r.algorithm, 'UNKNOWN');
});

test('widening a varchar is metadata, changing a type is a rewrite', () => {
  const wide = ms('ALTER TABLE dbo.t ALTER COLUMN status varchar(64) NOT NULL')!;
  assert.equal(wide.rebuild, false);
  assert.match(wide.why, /metadata only/);
  // …and it says what makes it NOT metadata, since the same statement shape
  // covers both.
  assert.match(wide.why, /Narrowing/);

  const retype = ms('ALTER TABLE dbo.t ALTER COLUMN customer_id bigint NOT NULL')!;
  assert.equal(retype.rebuild, true);
  assert.equal(retype.lock, 'EXCLUSIVE');
  assert.match(retype.why, /212 ms/);
});

test('ONLINE = ON is the only thing that keeps an index build non-blocking', () => {
  assert.equal(ms('CREATE INDEX ix ON dbo.t(a)')!.lock, 'EXCLUSIVE');
  assert.equal(ms('CREATE INDEX ix ON dbo.t(a) WITH (ONLINE = ON)')!.lock, 'NONE');
  assert.equal(ms('ALTER INDEX ALL ON dbo.t REBUILD')!.lock, 'EXCLUSIVE');
  assert.equal(ms('ALTER INDEX ix ON dbo.t REBUILD WITH (ONLINE = ON)')!.lock, 'NONE');
  // REORGANIZE is always online — that is the whole reason to choose it.
  assert.equal(ms('ALTER INDEX ALL ON dbo.t REORGANIZE')!.lock, 'NONE');
});

test('ALTER INDEX and T-SQL index spellings count as DDL at all', () => {
  // An offline rebuild is one of the most expensive things SQL Server can be
  // asked to do, and it was falling through as "not DDL" with no estimate.
  assert.equal(isDdl('ALTER INDEX ALL ON dbo.t REBUILD'), true);
  assert.equal(isDdl('CREATE CLUSTERED INDEX ix ON dbo.t(a)'), true);
  assert.equal(isDdl('CREATE UNIQUE NONCLUSTERED INDEX ix ON dbo.t(a)'), true);
  assert.equal(isDdl('CREATE COLUMNSTORE INDEX ix ON dbo.t'), true);
  assert.equal(isDdl('SELECT 1'), false);
});

test('a foreign key says what WITH NOCHECK really costs', () => {
  const r = ms('ALTER TABLE dbo.t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES p(id)')!;
  assert.match(r.why, /WITH NOCHECK/);
  assert.match(r.why, /untrusted/);
});

test('the MySQL and PostgreSQL models are untouched', () => {
  assert.equal(ddlCost('ALTER TABLE t ADD COLUMN x int', 'mysql', MB6)!.algorithm, 'INSTANT');
  assert.equal(ddlCost('ALTER TABLE t ADD COLUMN x int', 'mysql', MB6)!.lock, 'NONE');
  assert.equal(ddlCost('ALTER TABLE t ADD COLUMN x int', 'postgres', MB6)!.algorithm, 'CATALOG');
});
