/**
 * 🗃 Query Store — finding the plan regression, and pinning the plan back.
 *
 * This is the one thing SQL Server does that neither other engine can do at
 * all, and it answers the question a DBA is asked most often and can usually
 * least support: **"it was fast last week."**
 *
 * MySQL's performance-schema digests keep timings and no plans. PostgreSQL's
 * `pg_stat_statements` keeps timings and no plans. Both can tell you a
 * statement got slower; neither can tell you *the plan changed*, and neither
 * can put the old one back. Query Store keeps every plan a query has ever had,
 * with its runtime history — and `sp_query_store_force_plan` pins one.
 *
 * ## What "regressed" means here, and why it is ranked by waste
 *
 * A query has regressed when the plan it is running **now** is materially
 * slower than the best plan it has had in the window. That is a ratio, and a
 * ratio alone makes a terrible worklist: a query run twice that got 10× slower
 * is noise, and a query run four million times that got 20% slower is the
 * outage. So the list is ordered by **time wasted** — `(current − best) ×
 * executions` — which is the number that decides what to fix first.
 *
 * ## Two things that make an empty list mean different things
 *
 * `QUERY_CAPTURE_MODE = AUTO` (the default) **deliberately ignores cheap and
 * infrequent queries.** An empty regression list on an AUTO database does not
 * mean nothing regressed; it means the small things were never recorded. And a
 * Query Store that has filled its quota flips to READ_ONLY and silently stops
 * capturing, which looks identical to a healthy quiet server. Both are read by
 * [`MSSQL_QS_STATUS_SQL`] and stated in the panel, because "no findings" and
 * "not looking" must not render the same.
 *
 * ## Forcing is a write, so it is generated, not run
 *
 * `sp_query_store_force_plan` changes how the server executes a query until
 * someone un-forces it. It follows the same rule as every other write in this
 * app: the statement is put in the editor for a human to read and run.
 *
 * Pure: builds SQL and shapes rows. `node --test` covers it.
 */

/** Query Store's own state — read before anything else is believed. */
export const MSSQL_QS_STATUS_SQL = `SELECT
  actual_state_desc,
  readonly_reason,
  query_capture_mode_desc,
  CONVERT(decimal(12,1), current_storage_size_mb) AS current_mb,
  CONVERT(decimal(12,1), max_storage_size_mb)     AS max_mb,
  stale_query_threshold_days
FROM sys.database_query_store_options`;

export interface QsStatus {
  /** OFF / READ_ONLY / READ_WRITE */
  state: string;
  captureMode: string;
  currentMb: number;
  maxMb: number;
  staleDays: number;
  /** Non-zero when the store went read-only on its own. */
  readonlyReason: number;
}

export function parseQsStatus(row: readonly unknown[] | undefined): QsStatus | null {
  if (!row) return null;
  const s = (i: number) => (row[i] == null ? '' : String(row[i]));
  const n = (i: number) => Number(row[i] ?? 0) || 0;
  return {
    state: s(0),
    readonlyReason: n(1),
    captureMode: s(2),
    currentMb: n(3),
    maxMb: n(4),
    staleDays: n(5),
  };
}

/**
 * What the panel must say before showing a list, or `null` when the store is
 * healthy and nothing needs qualifying.
 *
 * Each of these makes an empty result mean something different, which is the
 * whole reason they are surfaced rather than left in a DMV.
 */
export function qsCaveat(st: QsStatus | null): string | null {
  if (!st) return 'Query Store options could not be read — VIEW DATABASE STATE is needed.';
  if (st.state === 'OFF') {
    return 'Query Store is OFF for this database, so there is no plan history at all. '
      + 'ALTER DATABASE … SET QUERY_STORE = ON starts recording; it cannot tell you about '
      + 'the past.';
  }
  if (st.state === 'READ_ONLY') {
    // The dangerous state: it looks like a healthy quiet server.
    const why = st.currentMb >= st.maxMb && st.maxMb > 0
      ? `it has filled its ${st.maxMb} MB quota`
      : `reason code ${st.readonlyReason}`;
    return `Query Store is READ_ONLY — ${why}, so it has STOPPED capturing. Anything below is `
      + 'history, and nothing new is being recorded. Raise MAX_STORAGE_SIZE_MB or clear it.';
  }
  if (st.captureMode === 'AUTO') {
    return 'Capture mode is AUTO, which deliberately skips cheap and infrequent queries — '
      + 'an empty list here means "none of the queries it recorded regressed", not '
      + '"nothing regressed". ALL captures everything, at a cost.';
  }
  return null;
}

/**
 * Queries whose CURRENT plan is slower than their best one.
 *
 * `minExecutions` guards against a single lucky run winning "best": a plan with
 * one fast execution would otherwise make every other plan look like a
 * regression. `slowerThan` is the ratio below which a difference is noise —
 * plans vary run to run, and a 5% wobble is not a finding.
 */
export function mssqlRegressionsSql(opts: {
  days?: number; minExecutions?: number; slowerThan?: number; limit?: number;
} = {}): string {
  const days = clampInt(opts.days ?? 7, 1, 400);
  const minExec = clampInt(opts.minExecutions ?? 2, 1, 1_000_000);
  const ratio = Number.isFinite(opts.slowerThan) ? Math.max(1.05, opts.slowerThan!) : 1.2;
  const limit = clampInt(opts.limit ?? 50, 1, 500);
  return `WITH per_plan AS (
  SELECT p.query_id, p.plan_id, p.is_forced_plan,
         SUM(rs.count_executions) AS execs,
         SUM(rs.avg_duration * rs.count_executions)
           / NULLIF(SUM(rs.count_executions), 0) AS avg_us,
         MAX(rs.last_execution_time) AS last_exec
  FROM sys.query_store_plan p
  JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
  JOIN sys.query_store_runtime_stats_interval i
    ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id
  WHERE i.start_time > DATEADD(day, -${days}, SYSUTCDATETIME())
  GROUP BY p.query_id, p.plan_id, p.is_forced_plan
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY query_id ORDER BY last_exec DESC) AS recency,
         ROW_NUMBER() OVER (PARTITION BY query_id ORDER BY avg_us ASC)     AS speed
  FROM per_plan
  WHERE execs >= ${minExec}
)
SELECT TOP (${limit})
       cur.query_id,
       cur.plan_id  AS current_plan_id,
       best.plan_id AS best_plan_id,
       CONVERT(decimal(14,2), cur.avg_us  / 1000.0) AS current_ms,
       CONVERT(decimal(14,2), best.avg_us / 1000.0) AS best_ms,
       CONVERT(decimal(8,2),  cur.avg_us / NULLIF(best.avg_us, 0)) AS slower_x,
       cur.execs,
       CONVERT(decimal(18,1), (cur.avg_us - best.avg_us) * cur.execs / 1000.0) AS wasted_ms,
       CONVERT(int, cur.is_forced_plan) AS current_is_forced,
       CONVERT(varchar(30), cur.last_exec, 120) AS last_execution,
       t.query_sql_text
FROM ranked cur
JOIN ranked best ON best.query_id = cur.query_id AND best.speed = 1
JOIN sys.query_store_query q ON q.query_id = cur.query_id
JOIN sys.query_store_query_text t ON t.query_text_id = q.query_text_id
WHERE cur.recency = 1
  AND cur.plan_id <> best.plan_id
  AND cur.avg_us > best.avg_us * ${ratio}
ORDER BY wasted_ms DESC`;
}

export interface QsRegression {
  queryId: number;
  currentPlanId: number;
  bestPlanId: number;
  currentMs: number;
  bestMs: number;
  slowerX: number;
  executions: number;
  wastedMs: number;
  currentIsForced: boolean;
  lastExecution: string;
  sql: string;
}

export function parseRegressions(rows: readonly (readonly unknown[])[]): QsRegression[] {
  return rows.map(r => {
    const n = (i: number) => Number(r[i] ?? 0) || 0;
    return {
      queryId: n(0),
      currentPlanId: n(1),
      bestPlanId: n(2),
      currentMs: n(3),
      bestMs: n(4),
      slowerX: n(5),
      executions: n(6),
      wastedMs: n(7),
      currentIsForced: String(r[8]) === '1' || r[8] === true,
      lastExecution: r[9] == null ? '' : String(r[9]),
      sql: r[10] == null ? '' : String(r[10]),
    };
  });
}

/**
 * Every plan one query has had, so the choice of which to force is informed.
 *
 * `last_force_failure_reason_desc` is here because a forced plan can **stop
 * being usable** — the index it needs gets dropped, the schema changes — and
 * SQL Server records why and quietly goes back to choosing. A forced plan that
 * is silently failing is worse than no forcing at all, because the DBA believes
 * the problem is handled.
 */
export function mssqlPlansForQuerySql(queryId: number): string {
  const id = clampInt(queryId, 0, 2_147_483_647);
  return `SELECT p.plan_id,
       CONVERT(int, p.is_forced_plan) AS is_forced,
       p.last_force_failure_reason_desc,
       CONVERT(varchar(30), p.last_compile_start_time, 120) AS compiled_at,
       SUM(rs.count_executions) AS execs,
       CONVERT(decimal(14,2), SUM(rs.avg_duration * rs.count_executions)
         / NULLIF(SUM(rs.count_executions), 0) / 1000.0) AS avg_ms,
       CONVERT(decimal(14,2), MAX(rs.max_duration) / 1000.0) AS max_ms,
       CONVERT(decimal(14,1), SUM(rs.avg_logical_io_reads * rs.count_executions)
         / NULLIF(SUM(rs.count_executions), 0)) AS avg_reads,
       CONVERT(varchar(30), MAX(rs.last_execution_time), 120) AS last_execution
FROM sys.query_store_plan p
LEFT JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
WHERE p.query_id = ${id}
GROUP BY p.plan_id, p.is_forced_plan, p.last_force_failure_reason_desc, p.last_compile_start_time
ORDER BY avg_ms`;
}

/** The XML of one plan, for the plan viewer. */
export function mssqlPlanXmlSql(planId: number): string {
  return `SELECT CONVERT(nvarchar(max), query_plan) AS query_plan
FROM sys.query_store_plan WHERE plan_id = ${clampInt(planId, 0, 2_147_483_647)}`;
}

/**
 * Pin a plan.
 *
 * A write, so it is generated for review like every other. The comment above it
 * is not decoration: forcing is *sticky* — it survives restarts and stays until
 * someone removes it — and a forced plan silently stops being applied if it
 * ever becomes invalid, which is why the panel shows the failure reason beside
 * it.
 */
export function mssqlForcePlanSql(queryId: number, planId: number): string {
  const q = clampInt(queryId, 0, 2_147_483_647);
  const p = clampInt(planId, 0, 2_147_483_647);
  return `-- Pins query ${q} to plan ${p}. This STICKS: it survives restarts and stays\n`
    + `-- until it is un-forced. If the plan later becomes invalid (its index is\n`
    + `-- dropped, the schema changes) SQL Server silently goes back to choosing —\n`
    + `-- check last_force_failure_reason_desc afterwards, not just once.\n`
    + `EXEC sys.sp_query_store_force_plan @query_id = ${q}, @plan_id = ${p};`;
}

export function mssqlUnforcePlanSql(queryId: number, planId: number): string {
  const q = clampInt(queryId, 0, 2_147_483_647);
  const p = clampInt(planId, 0, 2_147_483_647);
  return `EXEC sys.sp_query_store_unforce_plan @query_id = ${q}, @plan_id = ${p};`;
}

/**
 * Every plan currently forced, and whether it is actually being applied.
 *
 * The panel shows this on its own tab because it answers a question nobody
 * thinks to ask until it bites: *what have we pinned, and is it still working?*
 * A forcing left behind by someone who has since left is a plan the optimiser
 * is not allowed to improve.
 */
export const MSSQL_QS_FORCED_SQL = `SELECT
  p.query_id,
  p.plan_id,
  p.last_force_failure_reason_desc,
  p.force_failure_count,
  CONVERT(varchar(30), p.last_compile_start_time, 120) AS compiled_at,
  LEFT(REPLACE(REPLACE(t.query_sql_text, CHAR(13), ' '), CHAR(10), ' '), 200) AS query_sql_text
FROM sys.query_store_plan p
JOIN sys.query_store_query q ON q.query_id = p.query_id
JOIN sys.query_store_query_text t ON t.query_text_id = q.query_text_id
WHERE p.is_forced_plan = 1
ORDER BY p.force_failure_count DESC, p.query_id`;

export interface QsForced {
  queryId: number;
  planId: number;
  failureReason: string;
  failureCount: number;
  compiledAt: string;
  sql: string;
  /** True when SQL Server is NOT actually applying this forcing. */
  failing: boolean;
}

export function parseForced(rows: readonly (readonly unknown[])[]): QsForced[] {
  return rows.map(r => {
    const reason = r[2] == null ? '' : String(r[2]);
    const count = Number(r[3] ?? 0) || 0;
    return {
      queryId: Number(r[0] ?? 0) || 0,
      planId: Number(r[1] ?? 0) || 0,
      failureReason: reason,
      failureCount: count,
      compiledAt: r[4] == null ? '' : String(r[4]),
      sql: r[5] == null ? '' : String(r[5]),
      // NONE is the healthy value; anything else means the forcing is not
      // being applied, however confident the row looks.
      failing: count > 0 || (reason !== '' && reason !== 'NONE'),
    };
  });
}

/** Milliseconds as something a person reads at a glance. */
export function fmtWasted(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** Integers only, and inside a sane range — these go into SQL unparameterised. */
function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
