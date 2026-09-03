/**
 * Query Store — plan regressions and plan forcing.
 *
 * The row shapes below are what SQL Server 2022 actually returned for a
 * manufactured regression on `dev/mssql_fixture.sql`: the same query run with
 * an index (plan 19, 1.17 ms, 27 logical reads) and then without it (plan 20,
 * 2.73 ms, 432 reads).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MSSQL_QS_STATUS_SQL, MSSQL_QS_FORCED_SQL,
  mssqlRegressionsSql, mssqlPlansForQuerySql, mssqlPlanXmlSql,
  mssqlForcePlanSql, mssqlUnforcePlanSql,
  parseQsStatus, parseRegressions, parseForced, qsCaveat, fmtWasted,
} from '../src/utils/mssqlQueryStore.ts';

// The live row, verbatim.
const REG_ROW = [179, 20, 19, 2.73, 1.17, 2.34, 10, 15.6, 0,
  '2026-08-29 14:25:32', "SELECT status, SUM(total) FROM sales.orders GROUP BY status"];

test('a regression carries both plans, so the good one can be named', () => {
  const [r] = parseRegressions([REG_ROW]);
  assert.equal(r.queryId, 179);
  assert.equal(r.currentPlanId, 20);
  assert.equal(r.bestPlanId, 19);
  assert.equal(r.slowerX, 2.34);
  assert.equal(r.currentIsForced, false);
});

test('the worklist is ordered by TIME WASTED, not by ratio', () => {
  // A query run twice that got 10× slower is noise; one run four million times
  // that got 20% slower is the outage. The SQL must order by the second.
  const sql = mssqlRegressionsSql();
  assert.match(sql, /ORDER BY wasted_ms DESC/);
  assert.match(sql, /\(cur\.avg_us - best\.avg_us\) \* cur\.execs/);
});

test('a lucky single run cannot become the "best" plan', () => {
  // Without a floor, one fast execution makes every other plan a regression.
  assert.match(mssqlRegressionsSql({ minExecutions: 25 }), /WHERE execs >= 25/);
  assert.match(mssqlRegressionsSql(), /WHERE execs >= 2/);
});

test('the thresholds are clamped — these go into SQL unparameterised', () => {
  const hostile = mssqlRegressionsSql({
    days: 1e9, minExecutions: -5, limit: 99999, slowerThan: 0.0001,
  });
  assert.match(hostile, /DATEADD\(day, -400,/);
  assert.match(hostile, /WHERE execs >= 1/);
  assert.match(hostile, /SELECT TOP \(500\)/);
  // Below 1.05 every plan is a "regression" against itself.
  assert.match(hostile, /best\.avg_us \* 1\.05/);
  assert.ok(!/NaN|undefined|Infinity/.test(hostile), hostile);
});

test('a plan id cannot smuggle anything into the force statement', () => {
  const sql = mssqlForcePlanSql(179 as number, Number('19; DROP TABLE x--'));
  // Number() of that is NaN, which clamps to the low bound rather than
  // interpolating text.
  assert.match(sql, /@plan_id = 0;$/);
  assert.ok(!sql.includes('DROP TABLE'), sql);
});

test('forcing says that it sticks, and that it can silently stop working', () => {
  const sql = mssqlForcePlanSql(179, 19);
  assert.match(sql, /EXEC sys\.sp_query_store_force_plan @query_id = 179, @plan_id = 19;$/);
  // The two things a DBA discovers the hard way otherwise.
  assert.match(sql, /survives restarts/);
  assert.match(sql, /last_force_failure_reason_desc/);
  assert.equal(mssqlUnforcePlanSql(179, 19),
    'EXEC sys.sp_query_store_unforce_plan @query_id = 179, @plan_id = 19;');
});

// ── the caveats: why an empty list means three different things ──────────────

test('OFF is not "nothing regressed"', () => {
  const st = parseQsStatus(['OFF', 0, 'AUTO', 0, 100, 30])!;
  assert.match(qsCaveat(st)!, /OFF for this database/);
  assert.match(qsCaveat(st)!, /cannot tell you about the past/);
});

test('READ_ONLY is the dangerous one — it looks like a healthy quiet server', () => {
  const full = parseQsStatus(['READ_ONLY', 1, 'ALL', 100, 100, 30])!;
  const c = qsCaveat(full)!;
  assert.match(c, /STOPPED capturing/);
  assert.match(c, /filled its 100 MB quota/);
});

test('AUTO capture skips cheap queries, so an empty list is not an all-clear', () => {
  const st = parseQsStatus(['READ_WRITE', 0, 'AUTO', 1, 1000, 30])!;
  assert.match(qsCaveat(st)!, /deliberately skips cheap and infrequent/);
});

test('a healthy store in ALL mode needs no qualifying', () => {
  assert.equal(qsCaveat(parseQsStatus(['READ_WRITE', 0, 'ALL', 1, 1000, 30])), null);
});

test('an unreadable options row is stated, not treated as healthy', () => {
  assert.match(qsCaveat(null)!, /VIEW DATABASE STATE/);
});

// ── forced plans ─────────────────────────────────────────────────────────────

test('a forcing that is not being applied is flagged, however confident the row looks', () => {
  const [ok] = parseForced([[179, 19, 'NONE', 0, '2026-08-29 14:25:29', 'SELECT 1']]);
  assert.equal(ok.failing, false);

  const [broken] = parseForced([
    [179, 19, 'NO_PLAN', 12, '2026-08-29 14:25:29', 'SELECT 1']]);
  assert.equal(broken.failing, true);
  assert.equal(broken.failureReason, 'NO_PLAN');

  // A failure COUNT with a NONE reason still means it has failed.
  const [counted] = parseForced([[1, 2, 'NONE', 3, '', '']]);
  assert.equal(counted.failing, true);
});

test('the plans query surfaces the force-failure reason, not just the flag', () => {
  const sql = mssqlPlansForQuerySql(179);
  assert.match(sql, /last_force_failure_reason_desc/);
  // Logical reads are the honest tiebreak between plans: duration moves with
  // load, reads move with the plan.
  assert.match(sql, /avg_logical_io_reads/);
  assert.match(sql, /WHERE p\.query_id = 179/);
});

test('every generated statement takes integers only', () => {
  assert.match(mssqlPlansForQuerySql(Number('7 OR 1=1')), /query_id = 0/);
  assert.match(mssqlPlanXmlSql(-9), /plan_id = 0/);
  assert.match(mssqlPlanXmlSql(2 ** 40), /plan_id = 2147483647/);
});

test('the status and forced queries name their real sources', () => {
  assert.match(MSSQL_QS_STATUS_SQL, /sys\.database_query_store_options/);
  assert.match(MSSQL_QS_FORCED_SQL, /WHERE p\.is_forced_plan = 1/);
  assert.match(MSSQL_QS_FORCED_SQL, /force_failure_count/);
});

test('wasted time is readable at a glance at every scale', () => {
  assert.equal(fmtWasted(0), '—');
  assert.equal(fmtWasted(-5), '—');
  assert.equal(fmtWasted(420), '420 ms');
  assert.equal(fmtWasted(15_600), '15.6 s');
  assert.equal(fmtWasted(90_000), '1.5 min');
  assert.equal(fmtWasted(7_200_000), '2.0 h');
});
