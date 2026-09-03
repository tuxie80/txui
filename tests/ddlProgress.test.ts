/**
 * Where a long DDL reports its progress (src/utils/ddlProgress.ts).
 *
 * "Is it stuck?" is the only question anyone asks about a nine-minute ALTER,
 * and the two engines answer it in different places — neither of which is the
 * process list the panel was already polling. PostgreSQL got no phase at all;
 * MySQL got one only when instruments nobody enables happen to be on.
 *
 * The distinction these tests protect: an empty phase has two very different
 * causes, and telling them apart is the difference between "it is working and
 * slow" and "you are looking at an unconfigured server".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ddlKind, progressProbe, reportsPhases, MYSQL_STAGE_SETUP,
} from '../src/utils/ddlProgress.ts';

// ── recognising the statement ───────────────────────────────────────────────

test('index builds are recognised in all their spellings', () => {
  for (const sql of [
    'CREATE INDEX ix ON t (a)',
    'create unique index ix on t (a)',
    'CREATE INDEX CONCURRENTLY ix ON t (a)',
    'REINDEX TABLE t',
  ]) {
    assert.equal(ddlKind(sql), 'create-index', sql);
  }
});

test('an ALTER that only adds an index is an index build', () => {
  // PostgreSQL reports it through the same progress view, so calling it
  // anything else would send the panel to the wrong catalog.
  assert.equal(ddlKind('ALTER TABLE t ADD INDEX ix (a)'), 'create-index');
  assert.equal(ddlKind('ALTER TABLE t ADD UNIQUE KEY uk (a)'), 'create-index');
});

test('a real table change is an alter, and a rewrite is a rewrite', () => {
  assert.equal(ddlKind('ALTER TABLE t MODIFY COLUMN a BIGINT'), 'alter-table');
  assert.equal(ddlKind('VACUUM FULL t'), 'vacuum-cluster');
  assert.equal(ddlKind('CLUSTER t USING ix'), 'vacuum-cluster');
});

test('comments and whitespace do not hide the statement', () => {
  assert.equal(ddlKind('/* migration 42 */\n  CREATE  INDEX ix ON t (a)'), 'create-index');
  assert.equal(ddlKind('-- note\nALTER TABLE t DROP COLUMN a'), 'alter-table');
});

test('an ordinary query is not DDL', () => {
  assert.equal(ddlKind('SELECT * FROM t'), 'other');
  assert.equal(ddlKind('UPDATE t SET a = 1'), 'other');
});

// ── PostgreSQL: the views it never read ─────────────────────────────────────

test('an index build is polled from pg_stat_progress_create_index', () => {
  const p = progressProbe('postgres', 'create-index', 4242);
  assert.match(p.sql!, /pg_stat_progress_create_index/);
  assert.match(p.sql!, /pid = 4242/);
  assert.match(p.sql!, /phase/);
  // The field that answers "why is CONCURRENTLY taking twenty minutes".
  assert.match(p.sql!, /current_locker_pid/);
  assert.match(p.note!, /waiting on/);
});

test('a table rewrite is polled from pg_stat_progress_cluster', () => {
  const p = progressProbe('postgres', 'alter-table', 7);
  assert.match(p.sql!, /pg_stat_progress_cluster/);
  assert.match(p.sql!, /heap_blks_scanned/);
  // And the note says why an ALTER may never show up there at all.
  assert.match(p.note!, /catalog finishes without ever appearing/);
});

test('PostgreSQL says plainly when a statement has no progress view', () => {
  const p = progressProbe('postgres', 'other', 7);
  assert.equal(p.sql, null);
  assert.match(p.note!, /index builds and table rewrites only/);
});

test('the percentage falls back from blocks to tuples', () => {
  // An index build reports blocks in some phases and tuples in others;
  // reading only one of them shows 0% through half the build.
  const p = progressProbe('postgres', 'create-index', 1);
  assert.match(p.sql!, /blocks_total/);
  assert.match(p.sql!, /tuples_total/);
});

// ── MySQL: one source, and it is switched off ───────────────────────────────

test('MySQL polls performance_schema stages for every kind', () => {
  for (const kind of ['create-index', 'alter-table', 'other'] as const) {
    const p = progressProbe('mysql', kind, 99);
    assert.match(p.sql!, /events_stages_current/, kind);
    assert.match(p.sql!, /WHERE p\.ID = 99/, kind);
  }
});

test('the MySQL note blames configuration, not the query', () => {
  // The failure mode this exists for: a blank phase that looks like a stall
  // when it is actually an unconfigured server.
  assert.match(progressProbe('mysql', 'alter-table', 1).note!, /OFF by default/);
  assert.match(progressProbe('mysql', 'alter-table', 1).note!, /unconfigured, not stalled/);
});

test('the fix enables the instrument AND the consumer', () => {
  // People reliably enable one of the two, and one without the other looks
  // exactly like neither.
  assert.equal(MYSQL_STAGE_SETUP.length, 2);
  assert.match(MYSQL_STAGE_SETUP[0], /setup_instruments/);
  assert.match(MYSQL_STAGE_SETUP[0], /stage\/innodb\/alter%/);
  assert.match(MYSQL_STAGE_SETUP[1], /setup_consumers/);
  assert.match(MYSQL_STAGE_SETUP[1], /events_stages_current/);
});

// ── guards ──────────────────────────────────────────────────────────────────

test('a nonsense pid produces no query rather than a broken one', () => {
  assert.equal(progressProbe('postgres', 'create-index', Number.NaN).sql, null);
});

test('the pid is coerced to an integer before it reaches the SQL', () => {
  assert.match(progressProbe('mysql', 'other', 12.9).sql!, /p\.ID = 12\b/);
});

test('what is worth watching differs by engine', () => {
  assert.equal(reportsPhases('mysql', 'SELECT * FROM t'), true);
  assert.equal(reportsPhases('postgres', 'SELECT * FROM t'), false);
  assert.equal(reportsPhases('postgres', 'CREATE INDEX ix ON t (a)'), true);
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('SQL Server gets its own probe, not performance_schema', () => {
  // The MySQL fallback reads information_schema.PROCESSLIST and
  // performance_schema.threads — neither exists on SQL Server, so the probe
  // simply failed.
  const p = progressProbe('sqlserver', 'create-index', 57);
  assert.match(p.sql!, /sys\.dm_exec_requests/);
  assert.match(p.sql!, /percent_complete/);
  assert.ok(!p.sql!.includes('performance_schema'), p.sql!);
  assert.ok(!p.sql!.includes('PROCESSLIST'), p.sql!);
});

test('background sessions are excluded by is_user_process, not by id', () => {
  // The old `session_id > 50` heuristic is wrong on a modern instance —
  // session 57 on the test server is a background TASK MANAGER. A background
  // row answering for a user's pid would report the wrong statement.
  const p = progressProbe('sqlserver', 'create-index', 57);
  assert.match(p.sql!, /s\.is_user_process = 1/);
  assert.ok(!p.sql!.includes('> 50'), p.sql!);
});

test('the note says which operations do NOT report, which is the useful half', () => {
  // CREATE INDEX and ALTER INDEX REBUILD are the two a person watching a DDL
  // is most likely to be running, and they are exactly the two with no
  // percentage — so an empty one is documented behaviour, not a stall.
  const p = progressProbe('sqlserver', 'create-index', 57);
  assert.match(p.note, /NOT for CREATE INDEX or ALTER INDEX REBUILD/);
  assert.match(p.note, /BACKUP/);
});

test('an ordinary statement has no phases to watch on SQL Server', () => {
  // MySQL's stages cover any statement; PostgreSQL and SQL Server both publish
  // progress for a named set only.
  assert.equal(reportsPhases('sqlserver', 'SELECT 1'), false);
  assert.equal(reportsPhases('postgres', 'SELECT 1'), false);
  assert.equal(reportsPhases('mysql', 'SELECT 1'), true);
  // …but a real index build is still worth watching.
  assert.equal(reportsPhases('sqlserver', 'CREATE INDEX ix ON t(a)'), true);
});

test('a non-numeric pid produces no probe at all', () => {
  assert.equal(progressProbe('sqlserver', 'create-index', Number.NaN).sql, null);
});
