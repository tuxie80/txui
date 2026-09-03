/**
 * 🗃 Query Store — plan regressions, and putting the good plan back.
 *
 * The one SQL Server capability neither other engine has any answer to. MySQL
 * and PostgreSQL can both tell you a statement got slower; only this can tell
 * you **the plan changed**, show you both plans, and pin the one that worked.
 *
 * Two tabs, because they answer two different questions:
 *
 *   **Regressions** — what is running a worse plan than it used to, ordered by
 *   the time that is costing. Not by ratio: a query run twice that got 10×
 *   slower is noise, and one run four million times that got 20% slower is the
 *   outage.
 *
 *   **Forced** — what has already been pinned, and whether the pin is still
 *   being applied. A forcing that has silently stopped working is worse than
 *   none, because everyone believes the problem is handled.
 *
 * Reading is free. **Forcing is a write**, so it follows the same rule as every
 * other write in this app: the statement goes to the editor for a human to read
 * and run. Nothing here executes a change.
 *
 * The SQL and the row shapes live in utils/mssqlQueryStore (pure, tested).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import {
  MSSQL_QS_STATUS_SQL, MSSQL_QS_FORCED_SQL,
  mssqlRegressionsSql, mssqlPlansForQuerySql, mssqlPlanXmlSql,
  mssqlForcePlanSql, mssqlUnforcePlanSql,
  parseQsStatus, parseRegressions, parseForced, qsCaveat, fmtWasted,
  type QsRegression, type QsForced, type QsStatus,
} from '../utils/mssqlQueryStore';

interface Props {
  session: Session;
  onClose: () => void;
}

type Tab = 'regressions' | 'forced';

interface PlanRow {
  planId: number;
  isForced: boolean;
  failureReason: string;
  compiledAt: string;
  execs: number;
  avgMs: number;
  maxMs: number;
  avgReads: number;
  lastExecution: string;
}

function pq(sessionId: string, sql: string): Promise<QueryResult> {
  return invoke<QueryResult>('panel_query', { sessionId, sql, token: crypto.randomUUID() });
}

export function QueryStorePanel({ session, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('regressions');
  const [status, setStatus] = useState<QsStatus | null>(null);
  const [statusRead, setStatusRead] = useState(false);
  const [rows, setRows] = useState<QsRegression[]>([]);
  const [forced, setForced] = useState<QsForced[]>([]);
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [selected, setSelected] = useState<QsRegression | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Window and thresholds — the defaults are the ones that make the first
  // screen useful; the controls exist because "what counts as a regression" is
  // a judgement about this workload, not a constant.
  const [days, setDays] = useState(7);
  const [slowerThan, setSlowerThan] = useState(1.2);
  const [minExecutions, setMinExecutions] = useState(2);

  const insertSql = (sql: string) => {
    window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const st = await pq(session.sessionId, MSSQL_QS_STATUS_SQL)
        .then(r => parseQsStatus(r.rows[0]))
        .catch(() => null);
      setStatus(st);
      setStatusRead(true);
      // A store that is OFF has no history to read — asking anyway produces an
      // empty grid that looks like good news.
      if (st?.state === 'OFF') { setRows([]); setForced([]); return; }

      const [reg, fc] = await Promise.all([
        pq(session.sessionId, mssqlRegressionsSql({ days, minExecutions, slowerThan })),
        pq(session.sessionId, MSSQL_QS_FORCED_SQL),
      ]);
      setRows(parseRegressions(reg.rows));
      setForced(parseForced(fc.rows));
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setLoading(false);
    }
  }, [session.sessionId, days, minExecutions, slowerThan]);

  useEffect(() => { void load(); }, [load]);

  const openPlans = useCallback(async (r: QsRegression) => {
    setSelected(r);
    setPlans(null);
    try {
      const p = await pq(session.sessionId, mssqlPlansForQuerySql(r.queryId));
      setPlans(p.rows.map(row => ({
        planId: Number(row[0] ?? 0) || 0,
        isForced: String(row[1]) === '1',
        failureReason: row[2] == null ? '' : String(row[2]),
        compiledAt: row[3] == null ? '' : String(row[3]),
        execs: Number(row[4] ?? 0) || 0,
        avgMs: Number(row[5] ?? 0) || 0,
        maxMs: Number(row[6] ?? 0) || 0,
        avgReads: Number(row[7] ?? 0) || 0,
        lastExecution: row[8] == null ? '' : String(row[8]),
      })));
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [session.sessionId]);

  /** Send one plan's XML to the plan viewer, the same one EXPLAIN feeds. */
  const showPlan = useCallback(async (planId: number) => {
    try {
      const r = await pq(session.sessionId, mssqlPlanXmlSql(planId));
      const xml = String(r.rows[0]?.[0] ?? '');
      if (!xml) { setError(`Plan ${planId} has no stored XML.`); return; }
      window.dispatchEvent(new CustomEvent('dbgui:show-plan', {
        detail: { format: 'xml', engine: 'sqlserver', content: xml },
      }));
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [session.sessionId]);

  const caveat = useMemo(() => (statusRead ? qsCaveat(status) : null), [status, statusRead]);
  const totalWasted = useMemo(() => rows.reduce((s, r) => s + r.wastedMs, 0), [rows]);
  const failingForcings = useMemo(() => forced.filter(f => f.failing).length, [forced]);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🗃 Query Store</span>
        <span className="dv-desc">
          plan history and regressions — forcing generates SQL into the editor for review
        </span>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}
      {caveat && <div className="mnt-note">{caveat}</div>}

      <div className="mnt-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'regressions'}
                className={`mnt-tab${tab === 'regressions' ? ' active' : ''}`}
                onClick={() => setTab('regressions')}>
          Regressions{rows.length ? ` (${rows.length})` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'forced'}
                className={`mnt-tab${tab === 'forced' ? ' active' : ''}`}
                onClick={() => setTab('forced')}>
          Forced plans{forced.length ? ` (${forced.length})` : ''}
          {failingForcings > 0 && <span className="up-flag up-flag-warn">{failingForcings} failing</span>}
        </button>
      </div>

      {tab === 'regressions' && (
        <>
          <div className="up-templates" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="dg-field-inline" title="How far back to look">
              <span>Window</span>
              <select className="up-filter" value={days}
                      onChange={e => setDays(Number(e.target.value))}>
                <option value={1}>1 day</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
              </select>
            </label>
            <label className="dg-field-inline"
                   title="Below this, a difference is run-to-run variation rather than a finding">
              <span>Slower than</span>
              <select className="up-filter" value={slowerThan}
                      onChange={e => setSlowerThan(Number(e.target.value))}>
                <option value={1.2}>1.2×</option>
                <option value={2}>2×</option>
                <option value={5}>5×</option>
              </select>
            </label>
            <label className="dg-field-inline"
                   title="A plan with one lucky fast run would otherwise become the 'best' one">
              <span>Min executions</span>
              <input className="up-filter" type="number" min={1} style={{ width: 70 }}
                     value={minExecutions}
                     onChange={e => setMinExecutions(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            {rows.length > 0 && (
              <span className="dv-desc">
                {fmtWasted(totalWasted)} of execution time attributable to worse plans
              </span>
            )}
          </div>

          {rows.length === 0 && !loading && (
            <div className="mx-empty">
              No query is running a plan materially worse than its best one in this window.
            </div>
          )}

          <div className="up-body">
            <div className="up-list" style={{ flex: '1 1 55%' }}>
              {rows.map(r => (
                <div
                  key={r.queryId}
                  className={`up-row ${selected?.queryId === r.queryId ? 'selected' : ''}`}
                  onClick={() => void openPlans(r)}
                >
                  <span className="up-name">#{r.queryId}</span>
                  <span className="up-flag up-flag-warn">{r.slowerX.toFixed(1)}× slower</span>
                  <span className="up-flag">{fmtWasted(r.wastedMs)} wasted</span>
                  <span className="dv-desc">
                    {r.currentMs.toFixed(2)} ms now vs {r.bestMs.toFixed(2)} ms best
                    {' · '}{r.executions.toLocaleString()} runs
                  </span>
                  {r.currentIsForced && <span className="up-flag up-flag-warn">current plan is FORCED</span>}
                  <code className="up-grant" style={{ display: 'block', marginTop: 2 }}>
                    {r.sql.replace(/\s+/g, ' ').slice(0, 160)}
                  </code>
                </div>
              ))}
            </div>

            <div className="up-detail" style={{ flex: '1 1 45%' }}>
              {!selected && <div className="mx-empty">Select a query to see its plans.</div>}
              {selected && (
                <>
                  <div className="up-detail-head">
                    <b>Query #{selected.queryId}</b>
                    <span className="dv-desc">last run {selected.lastExecution}</span>
                  </div>
                  <pre className="rt-ddl" style={{ maxHeight: 140 }}>{selected.sql}</pre>
                  {!plans && <div className="mx-empty">Loading plans…</div>}
                  {plans && (
                    <table className="td-table">
                      <thead>
                        <tr>
                          <th>Plan</th><th>Avg ms</th><th>Max ms</th><th>Avg reads</th>
                          <th>Runs</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {plans.map(p => (
                          <tr key={p.planId}>
                            <td>
                              {p.planId}
                              {p.isForced && <span className="up-flag">forced</span>}
                              {p.failureReason && p.failureReason !== 'NONE' && (
                                <span className="up-flag up-flag-warn">{p.failureReason}</span>
                              )}
                            </td>
                            <td>{p.avgMs.toFixed(2)}</td>
                            <td>{p.maxMs.toFixed(2)}</td>
                            {/* Reads are the honest tiebreak: duration moves with
                                load, logical reads move with the plan. */}
                            <td>{Math.round(p.avgReads).toLocaleString()}</td>
                            <td>{p.execs.toLocaleString()}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <button className="toolbar-btn" onClick={() => void showPlan(p.planId)}>
                                Plan
                              </button>
                              {p.isForced ? (
                                <button className="toolbar-btn"
                                  onClick={() => insertSql(mssqlUnforcePlanSql(selected.queryId, p.planId))}>
                                  Un-force →
                                </button>
                              ) : (
                                <button className="toolbar-btn"
                                  onClick={() => insertSql(mssqlForcePlanSql(selected.queryId, p.planId))}>
                                  Force →
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="dv-desc" style={{ padding: '6px 0' }}>
                    Forcing is a write and sticks until it is removed. It is generated into the
                    editor, never run from here.
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {tab === 'forced' && (
        <div className="up-grants" style={{ display: 'block' }}>
          {forced.length === 0 && (
            <div className="mx-empty">No plan is forced in this database.</div>
          )}
          {forced.map(f => (
            <div key={`${f.queryId}-${f.planId}`} className="up-row">
              <span className="up-name">#{f.queryId} → plan {f.planId}</span>
              {f.failing ? (
                <span className="up-flag up-flag-warn">
                  NOT being applied — {f.failureReason || 'unknown'}
                  {f.failureCount > 0 ? ` (${f.failureCount} failures)` : ''}
                </span>
              ) : (
                <span className="up-flag">applied</span>
              )}
              <span className="dv-desc">compiled {f.compiledAt}</span>
              <code className="up-grant" style={{ display: 'block' }}>{f.sql}</code>
              <button className="toolbar-btn"
                onClick={() => insertSql(mssqlUnforcePlanSql(f.queryId, f.planId))}>
                Un-force →
              </button>
            </div>
          ))}
          {failingForcings > 0 && (
            <div className="mnt-note">
              A forcing SQL Server cannot apply is worse than none: the plan is not being used,
              and everyone looking at this list believes it is. The usual cause is that the plan
              became invalid — its index was dropped, or the schema changed.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
