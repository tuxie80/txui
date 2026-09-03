/**
 * The window you get before a write runs — the one that tells you the
 * consequence instead of asking you to trust your own WHERE clause.
 *
 * It shows the statement, and for a single-table UPDATE/DELETE it **counts the
 * matching rows first** (`utils/writePreview` turns the statement into its
 * COUNT equivalent) so "affects 3 rows" and "affects 412,908 rows" look
 * different before you commit to them. It also surfaces the two other things
 * that decide whether a write is safe: the environment tag, and whether a
 * default database is even selected.
 *
 * Cancel is the default (focused, and Esc picks it).
 */
import { errorDisplay } from '../utils/appError';
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { countPlanFor, describeBlastRadius, hasRowLimit } from '../utils/writePreview';
import {
  analyzeCascade, destructiveTarget, edgesFromRows, fkGraphSql, isNotable,
  routeText, rowCountSql, summarize,
} from '../utils/cascade';
import type { CascadeAnalysis } from '../utils/cascade';
import { assumptionsText, ddlCost, ddlTarget, describeCost, fmtSeconds, isDdl, tableSizeSql } from '../utils/ddlCost';
import type { DdlCost } from '../utils/ddlCost';

export interface WriteConfirmRequest {
  sql: string;
  sessionId: string;
  connectionName: string;
  environment?: string | null;
  /** a default database/schema is selected in the toolbar */
  hasDefaultDb: boolean;
  /** why the confirmation was raised, for the heading */
  reason: 'prod' | 'no-where' | 'requested';
  /** a manual transaction is open on this session */
  inTransaction?: boolean;
  /** engine + schema, for the cascade graph (see utils/cascade) */
  engine?: string;
  schema?: string | null;
}

interface Props {
  request: WriteConfirmRequest;
  onRun: () => void;
  onCancel: () => void;
}

export function WriteConfirm({ request, onRun, onCancel }: Props) {
  const { sql, environment, hasDefaultDb, reason, inTransaction } = request;
  const isProd = environment === 'prod';
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The plan is derived from the statement (pure), so only the COUNT RESULT is
  // state — that keeps the effect a pure subscription to the server's answer.
  const plan = useMemo(() => countPlanFor(sql), [sql]);
  const [count, setCount] = useState<{ rows: number } | { error: string } | null>(null);
  /**
   * What this statement destroys beyond the table it names.
   *
   * Referential actions compose and nothing at the call site shows it — this
   * is the only moment before they happen. Loaded only for the three
   * statements that can trigger them, and only when the schema is known.
   */
  const target = useMemo(() => destructiveTarget(sql), [sql]);
  const [cascade, setCascade] = useState<CascadeAnalysis | null>(null);
  /**
   * What an ALTER will cost — algorithm, lock, rebuild, seconds.
   *
   * The same figures in a report are interesting; here, half a second before
   * the statement runs, they change what happens.
   *
   * Two layers: the algorithm and the lock are derived from the statement
   * alone and are available immediately (they are also the two facts that
   * matter most); the seconds need the table size, which is a round trip, so
   * they arrive after and replace it.
   */
  const baseCost = useMemo(
    () => ddlCost(sql, request.engine ?? 'mysql', null), [sql, request.engine]);
  const [sizedCost, setSizedCost] = useState<DdlCost | null>(null);
  const cost = sizedCost ?? baseCost;
  const [armed, setArmed] = useState(!isProd);   // prod needs a deliberate second step

  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  // Count the blast radius. Read-only, and on the monitor path so it never
  // lands in the query history.
  useEffect(() => {
    if (!plan) return;
    let alive = true;
    invoke<{ rows: unknown[][] }>('monitor_query', { sessionId: request.sessionId, sql: plan.sql })
      .then(r => {
        if (!alive) return;
        const n = Number(r.rows?.[0]?.[0] ?? NaN);
        setCount(Number.isFinite(n) ? { rows: n } : { error: 'the count returned no number' });
      })
      .catch(e => { if (alive) setCount({ error: errorDisplay(e) }); });
    return () => { alive = false; };
  }, [plan, request.sessionId]);

  useEffect(() => {
    const engine = request.engine;
    const schema = request.schema;
    if (!target || !schema || (engine !== 'mysql' && engine !== 'postgres')) return;
    let alive = true;
    const q = (sqlText: string) =>
      invoke<{ rows: unknown[][] }>('monitor_query', { sessionId: request.sessionId, sql: sqlText });
    // Both are catalog reads on the monitor path: no history entry, no scan,
    // and a failure costs the cascade section rather than the dialog.
    Promise.all([q(fkGraphSql(engine, schema)), q(rowCountSql(engine, schema)).catch(() => ({ rows: [] }))])
      .then(([fks, rowsRes]) => {
        if (!alive) return;
        const counts = new Map<string, number | null>(
          rowsRes.rows.map(r => [String(r[0]), r[1] == null ? null : Number(r[1])]));
        setCascade(analyzeCascade(target.table, edgesFromRows(fks.rows), counts, target.kind));
      })
      .catch(() => { /* no graph: the dialog is still correct, just quieter */ });
    return () => { alive = false; };
  }, [target, request.engine, request.schema, request.sessionId]);

  useEffect(() => {
    const engine = request.engine;
    const schema = request.schema;
    if (!isDdl(sql)) return;
    const table = ddlTarget(sql);
    if (!table || !schema || (engine !== 'mysql' && engine !== 'postgres')) return;
    let alive = true;
    invoke<{ rows: unknown[][] }>('monitor_query',
      { sessionId: request.sessionId, sql: tableSizeSql(engine, schema, table) })
      .then(r => {
        if (!alive) return;
        const bytes = Number(r.rows?.[0]?.[0] ?? NaN);
        setSizedCost(ddlCost(sql, engine, Number.isFinite(bytes) ? bytes : null));
      })
      .catch(() => { /* keep the size-free verdict */ });
    return () => { alive = false; };
  }, [sql, request.engine, request.schema, request.sessionId]);

  const heading = reason === 'prod'
    ? `⚠ PRODUCTION — ${request.connectionName}`
    : reason === 'no-where'
      ? '⚠ No WHERE clause'
      : 'Confirm write';

  const rows = count && 'rows' in count ? count.rows : null;
  const bigChange = rows !== null && rows >= 1000;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal wc-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{heading}</span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>

        <div className="wc-body">
          <pre className="wc-sql">{sql.length > 4000 ? `${sql.slice(0, 4000)}\n…` : sql}</pre>

          {/* Blast radius */}
          {!plan && (
            <div className="wc-radius wc-loading">
              Row count not available for this statement shape — read it carefully.
            </div>
          )}
          {plan && count === null && <div className="wc-radius wc-loading">counting matching rows…</div>}
          {plan && rows !== null && (
            <div className={`wc-radius ${rows === 0 ? 'wc-none' : bigChange ? 'wc-big' : 'wc-some'}`}>
              {describeBlastRadius(plan, rows)}
              {hasRowLimit(sql) && ' (the statement’s own LIMIT applies, so this is an upper bound)'}
            </div>
          )}
          {count && 'error' in count && (
            <div className="wc-radius wc-failed">Could not count the affected rows: {count.error}</div>
          )}

          {/* What it costs everyone else. Shown even without a size, because
              the algorithm and the lock are the two facts that decide whether
              this can run now at all. */}
          {cost && (
            <div className={`wc-radius ${cost.lock === 'NONE' ? 'wc-some' : 'wc-big'}`}>
              {describeCost(cost)}
              <div className="wc-note">{cost.why}.</div>
              {(cost.replicaLagSeconds ?? 0) > 5 && (
                <div className="wc-note">
                  Replicas apply DDL serially, so this adds about
                  {' '}{fmtSeconds(cost.replicaLagSeconds!)} of lag to each of them.
                </div>
              )}
              {cost.diskBytes != null && (
                <div className="wc-note">
                  A rebuild writes a second copy first — about
                  {' '}{(cost.diskBytes / 1024 ** 3).toFixed(1)} GiB of free space is needed.
                </div>
              )}
              {cost.seconds != null && <div className="wc-note">{assumptionsText()}</div>}
            </div>
          )}

          {/* The consequences the statement does not mention. A blocker is the
              statement failing; a cascade is rows in tables you did not name. */}
          {cascade && isNotable(cascade) && (
            <div className={`wc-radius ${cascade.blockers.length ? 'wc-failed' : 'wc-big'}`}>
              <b>{cascade.table}</b> — {summarize(cascade)}
              {cascade.blockers.length > 0 && (
                <ul className="wc-routes">
                  {cascade.blockers.slice(0, 8).map(b => (
                    <li key={b.constraint}>
                      {b.child}{b.columns ? ` (${b.columns})` : ''} → {b.parent} · {b.onDelete}
                    </li>
                  ))}
                </ul>
              )}
              {cascade.cascades.length > 0 && (
                <ul className="wc-routes">
                  {cascade.cascades.slice(0, 8).map(r => (
                    <li key={r.chain.join('>')}>
                      {routeText(r)}
                      {r.rows != null && r.rows > 0 && ` · up to ${r.rows.toLocaleString()} rows`}
                    </li>
                  ))}
                  {cascade.cascades.length > 8 && <li>…and {cascade.cascades.length - 8} more routes</li>}
                </ul>
              )}
              {cascade.setNulls.length > 0 && (
                <ul className="wc-routes">
                  {cascade.setNulls.slice(0, 6).map(r => (
                    <li key={r.chain.join('>')}>{routeText(r)}</li>
                  ))}
                </ul>
              )}
              {/* Said once, plainly: these are whole-table counts, not the rows
                  your WHERE matches. Getting that wrong in the other direction
                  would be a number nobody could trust. */}
              {cascade.cascades.length > 0 && (
                <div className="wc-note">
                  Counts are whole-table estimates from statistics — an upper bound on what the
                  cascade reaches, not the rows this statement matches.
                </div>
              )}
            </div>
          )}

          <ul className="wc-facts">
            <li>Connection: <b>{request.connectionName}</b>
              {environment && <span className={`env-chip env-${environment}`}>{environment.toUpperCase()}</span>}
            </li>
            {!hasDefaultDb && (
              <li className="wc-warn">
                No default database is selected — unqualified names resolve on the server’s
                own default, which may not be the one you mean.
              </li>
            )}
            {plan?.wholeTable && (
              <li className="wc-warn">This statement has no WHERE: every row is affected.</li>
            )}
            {inTransaction && (
              <li className="wc-warn">
                A manual transaction (⛁ TX) is open. The count above was taken on a different
                connection, so it does <b>not</b> see rows your uncommitted statements changed.
              </li>
            )}
          </ul>
        </div>

        <div className="wc-actions">
          <button ref={cancelRef} className="toolbar-btn wc-cancel" onClick={onCancel}>
            Cancel (Esc)
          </button>
          <div style={{ flex: 1 }} />
          {isProd && !armed && (
            <button className="toolbar-btn wc-arm" onClick={() => setArmed(true)}>
              This is production — let me run it
            </button>
          )}
          <button
            className="toolbar-btn wc-run"
            disabled={!armed || (!!plan && count === null)}
            onClick={onRun}
            title={armed ? 'Execute the statement' : 'Confirm the production step first'}
          >
            {rows !== null && rows > 0
              ? `Run — change ${rows.toLocaleString()} row${rows === 1 ? '' : 's'}`
              : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
