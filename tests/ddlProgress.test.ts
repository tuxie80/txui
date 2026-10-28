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
  appendMysqlWorkerStages, ddlKind, finishMysqlThreadSnapshot, mergeMysqlThreadSnapshots,
  mysqlCompletionLine, mysqlCurrentAlterStagesSql, mysqlPhaseTiming, mysqlProgressStats,
  mysqlStageSetup, mysqlThreadSnapshot, parseThreadId, progressProbe, reportsPhases,
  withMysqlAlterLifecycle, MYSQL_STAGE_SETUP, MYSQL_ALTER_PHASES,
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
    assert.match(p.sql!, /events_stages_history/, kind);
    assert.match(p.sql!, /s\.NESTING_EVENT_ID = stmt\.EVENT_ID/, kind);
    assert.match(p.sql!, /WHERE p\.ID = 99/, kind);
  }
});

test('the fix enables every required instrument and stage consumer', () => {
  assert.equal(MYSQL_STAGE_SETUP.length, 2);
  assert.match(MYSQL_STAGE_SETUP[0], /setup_instruments/);
  assert.match(MYSQL_STAGE_SETUP[0], /stage\/innodb\/alter%/);
  assert.match(MYSQL_STAGE_SETUP[0], /stage\/sql\/copy to tmp table/);
  assert.match(MYSQL_STAGE_SETUP[1], /setup_consumers/);
  assert.match(MYSQL_STAGE_SETUP[1], /events_stages_%/);
});

const ALTER_SQL = `CREATE INDEX ix ON finance_at.out_document_item (${'updated_at,'.repeat(30)} updated_at)`;
const phaseRow = (
  eventId: number, phase: string, status: 'running' | 'done', pct: number | null, secs: number,
) => [
  5432258, ALTER_SQL, 255, 'executing', phase, 1000, 2000, pct, secs, status,
  eventId, 900, 'jiri.sula', 'proxy:3307', 'finance_at', 'Query', 3.2,
  120, 2000, 0, 1, 0, 77,
];

test('MySQL snapshots retain overlapping running/done phases and ALTER metadata', () => {
  const snap = mysqlThreadSnapshot([
    phaseRow(11, 'stage/innodb/alter table (read PK and internal sort)', 'done', 100, 90),
    phaseRow(12, 'stage/innodb/alter table (merge sort)', 'running', 65.2, 191.2),
    phaseRow(13, 'stage/innodb/alter table (insert)', 'running', 87.5, 90),
  ])!;
  assert.equal(snap.query, ALTER_SQL);
  assert.equal(snap.querySecs, 255);
  assert.equal(snap.stages.length, 3);
  assert.deepEqual(snap.stages.map(s => s.status), ['done', 'running', 'running']);
  assert.equal(snap.statementEventId, 900);
  assert.equal(snap.statementThreadId, 77);
  assert.equal(snap.user, 'jiri.sula');
  assert.equal(snap.database, 'finance_at');
  assert.equal(snap.stats.lockSecs, 3.2);
  assert.equal(snap.stats.rowsExamined, 2000);
  assert.equal(snap.stats.warnings, 1);
});

test('snapshot merging preserves a phase that leaves bounded history', () => {
  const previous = mysqlThreadSnapshot([
    phaseRow(11, 'stage/innodb/alter table (read PK)', 'running', 40, 90),
    phaseRow(12, 'stage/innodb/alter table (insert)', 'running', 20, 20),
  ]);
  const next = mysqlThreadSnapshot([
    phaseRow(12, 'stage/innodb/alter table (insert)', 'running', 80, 80),
  ]);
  const merged = mergeMysqlThreadSnapshots(previous, next)!;
  assert.equal(merged.stages.length, 2);
  assert.equal(merged.stages[0].status, 'done');
  assert.equal(merged.stages[0].phaseSecs, 90);
  assert.equal(merged.stages[1].phaseSecs, 80);
});

test('a new statement never inherits phases from the previous statement', () => {
  const previous = mysqlThreadSnapshot([phaseRow(11, 'stage/innodb/alter table (insert)', 'running', 50, 10)]);
  const next = mysqlThreadSnapshot([phaseRow(12, 'stage/innodb/alter table (merge sort)', 'running', 10, 2)]);
  next!.statementEventId = 901;
  assert.equal(mergeMysqlThreadSnapshots(previous, next).stages.length, 1);
  assert.equal(mergeMysqlThreadSnapshots(previous, next).stages[0].eventId, 12);
});

test('ALTER and CREATE INDEX show all seven known phases with pending/not-run states', () => {
  const snap = mysqlThreadSnapshot([
    phaseRow(364, MYSQL_ALTER_PHASES[0], 'running', 44.7, 2956.7),
  ])!;
  const lifecycle = withMysqlAlterLifecycle(snap);
  assert.equal(lifecycle.stages.length, 7);
  assert.deepEqual(lifecycle.stages.map(stage => stage.phase), MYSQL_ALTER_PHASES);
  assert.equal(lifecycle.stages[0].status, 'running');
  assert.ok(lifecycle.stages.slice(1).every(stage => stage.status === 'pending'));
  assert.ok(lifecycle.stages.slice(1).every(stage => stage.pct === null));
  const finished = finishMysqlThreadSnapshot(lifecycle);
  assert.equal(finished.stages[0].status, 'done');
  assert.ok(finished.stages.slice(1).every(stage => stage.status === 'skipped'));
});

test('a duplicate statement row takes identity from the actual stage event', () => {
  const nullStage = phaseRow(11, '', 'running', null, 0);
  nullStage[4] = null;
  nullStage[11] = 357;
  const actual = phaseRow(364, MYSQL_ALTER_PHASES[0], 'running', 44.7, 2956.7);
  actual[11] = 362;
  const snap = mysqlThreadSnapshot([nullStage, actual])!;
  assert.equal(snap.statementEventId, 362);
});

test('the correlated current-stage feed retains NULL-conn_id background workers', () => {
  const watched = mysqlThreadSnapshot([
    phaseRow(364, MYSQL_ALTER_PHASES[0], 'running', 44.8, 393.9),
  ])!;
  const worker = phaseRow(365, MYSQL_ALTER_PHASES[1], 'running', 51.6, 130.3);
  worker[0] = null;
  worker[1] = '';
  worker[22] = 5439999;
  const merged = appendMysqlWorkerStages(watched, [worker]);
  assert.equal(merged.stages.length, 2);
  assert.equal(merged.query, ALTER_SQL, 'worker NULL query never replaces watched metadata');
  const background = merged.stages.find(stage => stage.eventId === 365)!;
  assert.equal(background.connId, null);
  assert.equal(background.phaseThreadId, 5439999);
  assert.equal(background.workCompleted, 1000);

  const sql = mysqlCurrentAlterStagesSql(watched)!;
  assert.match(sql, /stmt\.THREAD_ID = 77 AND stmt\.EVENT_ID = 900/);
  assert.match(sql, /t\.PROCESSLIST_ID IS NULL AND s\.NESTING_EVENT_ID = stmt\.EVENT_ID/);
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /other_stmt\.THREAD_ID <> stmt\.THREAD_ID/);
});

test('the worker feed cannot add another connection or statement to the watch', () => {
  const watched = mysqlThreadSnapshot([
    phaseRow(364, MYSQL_ALTER_PHASES[0], 'running', 44.8, 393.9),
  ])!;
  const otherConnection = phaseRow(365, MYSQL_ALTER_PHASES[1], 'running', 51.6, 130.3);
  otherConnection[0] = 999;
  const otherStatement = phaseRow(366, MYSQL_ALTER_PHASES[2], 'running', 20, 30);
  otherStatement[0] = null;
  otherStatement[11] = 901;
  const merged = appendMysqlWorkerStages(watched, [otherConnection, otherStatement]);
  assert.equal(merged.stages.length, 1);
  assert.equal(merged.stages[0].eventId, 364);
});

test('stage identity is THREAD_ID plus EVENT_ID, not EVENT_ID alone', () => {
  const watched = mysqlThreadSnapshot([
    phaseRow(364, MYSQL_ALTER_PHASES[0], 'running', 44.8, 393.9),
  ])!;
  const worker = phaseRow(364, MYSQL_ALTER_PHASES[1], 'running', 51.6, 130.3);
  worker[0] = null;
  worker[1] = '';
  worker[22] = 5439999;
  const merged = appendMysqlWorkerStages(watched, [worker]);
  assert.equal(merged.stages.length, 2);
  assert.deepEqual(merged.stages.map(stage => stage.phaseThreadId), [77, 5439999]);
  assert.equal(merged.stages[0].phase, MYSQL_ALTER_PHASES[0]);
  assert.equal(merged.stages[1].phase, MYSQL_ALTER_PHASES[1]);
});

test('overlapping same-name events pause and resume independently by EVENT_ID', () => {
  const previous = mysqlThreadSnapshot([
    phaseRow(12, MYSQL_ALTER_PHASES[1], 'running', 50, 100),
    phaseRow(13, MYSQL_ALTER_PHASES[1], 'running', 40, 50),
  ]);
  const nextRows = [
    phaseRow(12, MYSQL_ALTER_PHASES[1], 'running', 50, 130),
    phaseRow(13, MYSQL_ALTER_PHASES[1], 'running', 41, 60),
  ];
  nextRows[1][5] = 1001;
  const paused = mergeMysqlThreadSnapshots(previous, mysqlThreadSnapshot(nextRows));
  assert.equal(paused.stages[0].stalledForSecs, 30);
  assert.equal(paused.stages[1].stalledForSecs, 0);
  assert.equal(mysqlPhaseTiming(paused.stages[0]).remainingSecs, null);
  assert.notEqual(mysqlPhaseTiming(paused.stages[1]).remainingSecs, null);
  const resumedRows = [phaseRow(12, MYSQL_ALTER_PHASES[1], 'running', 51, 140)];
  resumedRows[0][5] = 1002;
  const resumed = mergeMysqlThreadSnapshots(paused, mysqlThreadSnapshot(resumedRows));
  assert.equal(resumed.stages[0].stalledForSecs, 0);
});

test('a live thread without a stage still has a process snapshot', () => {
  const row = phaseRow(11, '', 'running', null, 0);
  row[4] = null;
  const snap = mysqlThreadSnapshot([row])!;
  assert.equal(snap.threadId, 5432258);
  assert.equal(snap.stages.length, 0);
  assert.equal(mysqlThreadSnapshot([]), null);
});

test('phase ETA and overall ETA handle overlap without summing phases', () => {
  const snap = mysqlThreadSnapshot([
    phaseRow(11, 'stage/innodb/alter table (read PK)', 'done', 100, 90),
    phaseRow(12, 'stage/innodb/alter table (merge sort)', 'running', 50, 100),
    phaseRow(13, 'stage/innodb/alter table (insert)', 'running', 25, 100),
  ])!;
  assert.deepEqual(mysqlPhaseTiming(snap.stages[1]), { remainingSecs: 100, totalSecs: 200 });
  assert.deepEqual(mysqlPhaseTiming(snap.stages[0]), { remainingSecs: 0, totalSecs: 90 });
  const stats = mysqlProgressStats(snap);
  assert.equal(stats.active, 2);
  assert.equal(stats.done, 1);
  assert.equal(stats.remainingSecs, 300);
  assert.equal(stats.totalSecs, 555);
  assert.equal(stats.longestPhaseSecs, 100);
});

test('an unknown active percentage makes the overall ETA indeterminate', () => {
  const snap = mysqlThreadSnapshot([phaseRow(11, 'stage/innodb/alter table (insert)', 'running', null, 100)])!;
  assert.equal(mysqlPhaseTiming(snap.stages[0]).remainingSecs, null);
  assert.equal(mysqlProgressStats(snap).remainingSecs, null);
  assert.equal(mysqlProgressStats(snap).totalSecs, null);
});

test('completion finalizes states and logs final statistics once the thread is gone', () => {
  const snap = mysqlThreadSnapshot([
    phaseRow(11, 'stage/innodb/alter table (merge sort)', 'running', 65.2, 191.2),
    phaseRow(12, 'stage/innodb/alter table (insert)', 'done', 100, 90),
  ])!;
  const finished = finishMysqlThreadSnapshot(snap);
  assert.ok(finished.stages.every(stage => stage.status === 'done'));
  assert.equal(finished.stages[0].pct, 65.2, 'last known work is not invented as 100%');
  const line = mysqlCompletionLine(finished);
  assert.match(line, /thread 5432258 finished after 255\.0 s/);
  assert.match(line, /2 phases observed \(2 done\)/);
  assert.match(line, /longest stage\/innodb\/alter table \(merge sort\) 191\.2 s/);
  assert.match(line, /rows affected\/examined\/sent 120\/2000\/0/);
});

test('thread ID input is a positive safe integer, never SQL text', () => {
  assert.equal(parseThreadId(' 5432258 '), 5432258);
  for (const bad of ['', '0', '-1', '1.2', '1 OR 1=1', '9007199254740992']) {
    assert.equal(parseThreadId(bad), null, bad);
  }
});

test('setup status requires all instruments and consumers', () => {
  assert.equal(mysqlStageSetup([4, 4, 3, 3])?.ready, true);
  assert.equal(mysqlStageSetup([3, 4, 3, 3])?.ready, false);
  assert.equal(mysqlStageSetup([4, 4, 2, 3])?.ready, false);
  assert.equal(mysqlStageSetup([0, 0, 0, 0])?.ready, false);
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
