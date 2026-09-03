/**
 * DBA Views — curated sys schema / performance_schema / pg_stat_* lookups.
 * Categorized catalog on the left, FastGrid + export on the right.
 * Demanding views carry a ⚠ badge; known server errors and empty
 * consumer-dependent results get a guidance block with copy-able fix SQL;
 * an optional auto-refresh reruns the current view while the tab is visible.
 */
import { errorDisplay } from '../utils/appError';
import { sqlLiteral } from '../utils/sqlIdent';
import { schedulerToggleSql, alterEventSql } from '../utils/eventSchedulerSql';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import type { SortClause } from '../types/browser';
import { replaceRowCap, limitDialect } from '../utils/limitGuard';
import { DBA_VIEWS } from '../utils/dbaViews';
import type { DbaView } from '../utils/dbaViews';
import { consumerHint, guidanceForError, performanceSchemaOffGuidance } from '../utils/dbaGuidance';
import type { Guidance } from '../utils/dbaGuidance';
import { FastGrid } from './FastGrid';
import { Spinner } from './Spinner';
import { cellSortKey, compareCellKeys } from '../utils/sortValue';
import { CopyExportMenu } from './CopyExportMenu';
import { usePoll } from '../hooks/usePoll';
import { useSessionPrivileges } from '../store/sessionPrivileges';
import { privilegeTip } from '../utils/privileges';
import { useServerFlavor } from '../store/serverFlavors';

interface Props {
  sessionId: string;
  engine: string;
  onClose: () => void;
}

const NO_VIEWS: DbaView[] = [];
const REFRESH_INTERVALS = [0, 5, 10, 30]; // seconds; 0 = Off

/**
 * A ClickHouse DBA view that reads system.query_log. When query logging is
 * off the log table is either absent (Unknown table) or empty — both read as
 * "no slow queries" rather than "no data", so the panel diagnoses it.
 */
const isChQueryLogView = (engine: string, view: DbaView | null): boolean =>
  engine === 'clickhouse' && !!view && view.sql.includes('system.query_log');

/** Shown when a query_log view is empty *because* logging is disabled. */
const QUERY_LOG_OFF_GUIDANCE: Guidance = {
  title: 'ClickHouse query_log is disabled',
  detail: 'This view reads system.query_log, but query logging is turned off on '
    + 'this server (log_queries = 0), so it will always be empty — this is "no data", '
    + 'not "no slow queries". Turn logging on and the log fills as new queries run.',
  sql: [
    'SET log_queries = 1;  -- current session only',
    '<!-- users.xml / a profile: -->\n<log_queries>1</log_queries>',
  ],
};

/** Explanation + fix SQL for a known failure / suspicious empty result. */
/** Copy button that confirms it worked, then goes back to offering. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className={`toolbar-btn${copied ? ' toolbar-btn-ok' : ''}`}
      title={copied ? 'Copied to the clipboard' : 'Copy to clipboard'}
      onClick={() => {
        // Only claim success once the clipboard actually took it — a silent
        // failure that still says "Copied" is worse than no feedback.
        navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => {});
      }}
    >{copied ? '✓ Copied' : 'Copy'}</button>
  );
}

function GuidanceBlock({ g }: { g: Guidance }) {
  return (
    <div className="dv-guidance">
      <div className="dv-guidance-title">{g.title}</div>
      <div className="dv-guidance-detail">{g.detail}</div>
      {g.sql.map((s, i) => (
        <div key={i} className="dv-guidance-sql">
          <code>{s}</code>
          <CopyButton text={s} />
        </div>
      ))}
    </div>
  );
}

/** Hand generated SQL to the active session's editor for review (never run). */
function insertIntoEditor(sql: string) {
  window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));
}

/**
 * Management actions for the MySQL/MariaDB "Scheduled events" view — the one
 * read-only view whose whole point is to show state you'd then want to change:
 * the global scheduler being on/off, and each event being enabled/disabled.
 *
 * REVIEW-ONLY: every button emits SQL into the editor via `dbgui:insert-sql`
 * and nothing here executes. The scheduler state comes from the view's first
 * column; the per-event actions target whichever row is selected in the grid.
 */
function EventActions({ engine, columns, rows, selRow }: {
  engine: string;
  columns: { name: string }[];
  rows: unknown[][];
  selRow: number | null;
}) {
  const idx = (n: string) => columns.findIndex(c => c.name === n);
  const schedState = String(rows[0]?.[idx('scheduler_state')] ?? '').toUpperCase();
  const schedOn = schedState === 'ON';
  const row = selRow != null ? rows[selRow] : null;
  const db = row ? row[idx('db')] : null;
  const name = row ? row[idx('event')] : null;
  // The scheduler-state row (LEFT JOIN, no events) carries null db/name — there
  // is nothing to enable there, so the per-event buttons only appear on a real
  // event row.
  const hasEvent = db != null && db !== '' && name != null && name !== '';

  return (
    <>
      <button
        className="toolbar-btn"
        data-tip={`Emit SET GLOBAL event_scheduler = ${schedOn ? 'OFF' : 'ON'} into the editor to review — never run here. Turns the whole scheduler on/off; no event fires while it is OFF.`}
        onClick={() => insertIntoEditor(schedulerToggleSql(!schedOn))}
      >Scheduler: {schedState || '—'} → {schedOn ? 'OFF' : 'ON'}</button>
      {hasEvent && (
        <>
          <button
            className="toolbar-btn"
            data-tip={`Emit ALTER EVENT … ENABLE for ${db}.${name} to review — never run here.`}
            onClick={() => insertIntoEditor(alterEventSql(String(db), String(name), true, engine))}
          >Enable event</button>
          <button
            className="toolbar-btn"
            data-tip={`Emit ALTER EVENT … DISABLE for ${db}.${name} to review — never run here.`}
            onClick={() => insertIntoEditor(alterEventSql(String(db), String(name), false, engine))}
          >Disable event</button>
        </>
      )}
    </>
  );
}

export function DbaViewsPanel({ sessionId, engine, onClose }: Props) {
  /**
   * MySQL, MariaDB and Percona share one engine here but not one catalog.
   * Views tagged with `flavors` exist once per flavour; showing both would put
   * two identically-labelled entries in the list, one of which errors.
   */
  const server = useServerFlavor(sessionId, engine);
  const views = useMemo(() => (DBA_VIEWS[engine] ?? NO_VIEWS)
    .filter(v => !v.flavors || v.flavors.includes(server.flavor)),
    [engine, server.flavor]);
  /**
   * A few views need more than the panel does — the statement digest needs
   * an extension, the replication ones need a monitoring role. Those are
   * greyed with the missing grant named, rather than run into a permission
   * error that names a catalog table and not the fix.
   */
  const privs = useSessionPrivileges(sessionId, engine);
  const blockedTip = (v: DbaView): string | null =>
    v.needsPrivilege ? privilegeTip(privs, v.needsPrivilege, v.label) : null;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const [sort, setSort] = useState<SortClause[]>([]);
  // Grid row the per-event actions target (events view only). null = none.
  const [selRow, setSelRow] = useState<number | null>(null);
  const [limit, setLimit] = useState(1000);
  const [refreshSec, setRefreshSec] = useState(0);
  /**
   * Consumers the server reports as OFF right now — read after a view comes
   * back empty. `null` = not known (no privileges, or performance_schema off).
   * Without this the "collection is OFF" advice was static and kept appearing
   * after the user had already applied it.
   */
  const [disabledConsumers, setDisabledConsumers] = useState<string[] | null>(null);
  /**
   * `performance_schema` off entirely, as opposed to one consumer disabled.
   * A different diagnosis needing different advice — see
   * `performanceSchemaOffGuidance`. MariaDB ships it off, so on that server
   * this is the common case rather than the exotic one.
   */
  const [psOff, setPsOff] = useState(false);
  /**
   * ClickHouse's storage/compression views are server-wide (WHERE database NOT
   * IN ('system')). On a multi-tenant cluster that buries your tables in
   * everyone else's, so we discover the session's current database once and
   * narrow those views to it. `null` = not ClickHouse or not yet discovered;
   * 'default' is left un-narrowed on purpose (see `scopeToDb`).
   */
  const [chDatabase, setChDatabase] = useState<string | null>(null);
  /**
   * A ClickHouse query_log-backed view came back empty *because* logging is
   * disabled (log_queries = 0), or its log table does not exist. Distinct from
   * a genuinely empty log — it drives an explanatory block, not a blank grid.
   */
  const [queryLogOff, setQueryLogOff] = useState(false);
  // Mount-unique token prefix: the backend keys panel-query cancellation by
  // `panel-<session>-<token>`, and a plain counter restarts at 1 on every
  // remount — so a still-running query from a CLOSED panel instance would
  // share its cancel key with this instance's first run, letting each run's
  // cleanup cancel/kill the other (Cancel button goes dead, entries leak).
  const mountRef = useRef(crypto.randomUUID());
  const tokenRef = useRef(0);
  const lastTokenRef = useRef<string | null>(null);
  const inFlight = useRef(false);
  const lastViewRef = useRef<DbaView | null>(null);
  // A hidden tab polls nothing (store/tabVisibility).

  // client-side sort (results already in memory)
  const sortedRows = useMemo(() => {
    if (!result || sort.length === 0) return result?.rows ?? [];
    const s = sort[0];
    const ci = result.columns.findIndex(c => c.name === s.column);
    if (ci < 0) return result.rows;
    const dir = s.direction === 'asc' ? 1 : -1;
    const keyed = result.rows.map(row => ({ row, key: cellSortKey(row[ci]) }));
    keyed.sort((a, b) => {
      if (a.key === null) return b.key === null ? 0 : 1;
      if (b.key === null) return -1;
      return compareCellKeys(a.key, b.key) * dir;
    });
    return keyed.map(k => k.row);
  }, [result, sort]);

  const onSortCol = useCallback((col: string) => {
    setSort(prev => {
      const ex = prev.find(s => s.column === col);
      if (!ex) return [{ column: col, direction: 'asc' }];
      if (ex.direction === 'asc') return [{ column: col, direction: 'desc' }];
      return [];
    });
  }, []);

  const active = views.find(v => v.id === activeId) ?? null;

  const categories = useMemo(() => {
    const map = new Map<string, DbaView[]>();
    for (const v of views) {
      if (!map.has(v.category)) map.set(v.category, []);
      map.get(v.category)!.push(v);
    }
    return [...map.entries()];
  }, [views]);

  // Apply the chosen row limit in place of the cap the curated SQL ships with
  // (∞ = none). This MUST go through limitGuard rather than concatenating
  // ` LIMIT n`: the panel runs against every engine, and T-SQL has no LIMIT —
  // it spells the cap `SELECT TOP (n)`, at the front. Appending here made
  // every SQL Server view fail with "Incorrect syntax near 'LIMIT'", and did
  // the same to the Redis views, whose `sql` is a command like `INFO memory`.
  const withLimit = useCallback(
    (sql: string, lim: number) => replaceRowCap(sql, lim, limitDialect(engine)),
    [engine],
  );

  // Discover the ClickHouse session's current database once, so the
  // server-wide storage views can be narrowed to it (Feature: multi-tenant
  // scoping). Best-effort — if it fails the views stay server-wide.
  useEffect(() => {
    if (engine !== 'clickhouse') { setChDatabase(null); return; }
    let live = true;
    invoke<QueryResult>('panel_query', {
      sessionId, sql: 'SELECT currentDatabase()', token: `${mountRef.current}:db`,
    })
      .then(r => { if (live) setChDatabase(String(r.rows[0]?.[0] ?? '') || null); })
      .catch(() => {});
    return () => { live = false; };
  }, [sessionId, engine]);

  // Narrow ClickHouse's server-wide storage/compression views to the current
  // database. The views all filter `database NOT IN ('system'[, …])`; we swap
  // that for `database = '<current>'`. 'default' is left alone — it is the
  // catch-all connection database, and scoping to it would hide tables that
  // live in named databases.
  const scopeToDb = useCallback((sql: string): string => {
    if (engine !== 'clickhouse' || !chDatabase || chDatabase === 'default') return sql;
    const lit = sqlLiteral(chDatabase, 'clickhouse');
    return sql.replace(
      /database NOT IN \('system'(?:, 'INFORMATION_SCHEMA', 'information_schema')?\)/g,
      `database = ${lit}`,
    );
  }, [engine, chDatabase]);

  const run = useCallback(async (view: DbaView, keepSort = false, lim = limit) => {
    if (!keepSort) setSort([]);
    setSelRow(null);
    setActiveId(view.id);
    lastViewRef.current = view;
    setLoading(true);
    setError(null);
    setKillNote(null);
    setQueryLogOff(false);
    inFlight.current = true;
    // Cancel any still-running previous query, then guard every state update
    // with the token so a late result can't overwrite the current view.
    const prev = lastTokenRef.current;
    const token = `${mountRef.current}:${++tokenRef.current}`;
    lastTokenRef.current = token;
    if (prev) invoke('cancel_panel_query', { sessionId, token: prev }).catch(() => {});
    try {
      const r = await invoke<QueryResult>('panel_query', {
        sessionId, sql: withLimit(scopeToDb(view.sql), lim), token,
      });
      if (token !== lastTokenRef.current) return;
      setResult(r);
      setMs(r.execution_ms);

      // A ClickHouse query_log view that came back empty: confirm whether the
      // log is simply off (log_queries = 0) rather than genuinely quiet, so we
      // can say "no data" instead of showing a misleading blank grid.
      if (r.rows.length === 0 && isChQueryLogView(engine, view)) {
        const s = await invoke<QueryResult>('panel_query', {
          sessionId, sql: "SELECT value FROM system.settings WHERE name = 'log_queries'",
          token: `${token}:qlog`,
        }).catch(() => null);
        if (token !== lastTokenRef.current) return;
        if (s && String(s.rows[0]?.[0] ?? '1') === '0') setQueryLogOff(true);
      }

      // An empty consumer-backed view: ask the server which of its consumers
      // are actually off, so the advice reflects the server as it is now.
      const needs = view.needsConsumers ?? [];
      if (r.rows.length === 0 && needs.length > 0) {
        const list = needs.map(n => sqlLiteral(n, 'mysql')).join(', ');
        try {
          // Ask about the subsystem and its consumers together. With
          // performance_schema off, setup_consumers returns no rows and every
          // query against it succeeds with none — indistinguishable from
          // "collection is on and there is nothing to report" unless the
          // variable itself is read.
          const psState = await invoke<QueryResult>('panel_query', {
            sessionId, sql: 'SELECT @@performance_schema',
            token: `${token}:ps`,
          }).catch(() => null);
          if (token !== lastTokenRef.current) return;
          const subsystemOff = !!psState && String(psState.rows[0]?.[0] ?? '1') === '0';
          setPsOff(subsystemOff);
          if (subsystemOff) { setDisabledConsumers(null); return; }

          const st = await invoke<QueryResult>('panel_query', {
            sessionId,
            sql: `SELECT NAME, ENABLED FROM performance_schema.setup_consumers WHERE NAME IN (${list})`,
            token: `${token}:consumers`,
          });
          if (token !== lastTokenRef.current) return;
          const off = st.rows
            .filter(row => String(row[1]).toUpperCase() !== 'YES')
            .map(row => String(row[0]));
          // A consumer the server does not list at all cannot be enabled by
          // us either — treat it as unknown rather than claiming it is on.
          const known = new Set(st.rows.map(row => String(row[0])));
          const missing = needs.filter(n => !known.has(n));
          setDisabledConsumers(missing.length > 0 ? null : off);
        } catch {
          if (token !== lastTokenRef.current) return;
          setDisabledConsumers(null);
        }
      } else {
        setDisabledConsumers(null);
        setPsOff(false);
      }
    } catch (e) {
      if (token !== lastTokenRef.current) return;
      const msg = errorDisplay(e);
      setError(msg);
      if (!msg.includes('cancelled')) { setResult(null); setMs(null); }
      // The log table itself is absent (never created because logging was
      // never on) — same diagnosis, surfaced instead of a raw catalog error.
      if (isChQueryLogView(engine, view) && /unknown table.*query_log/i.test(msg)) {
        setQueryLogOff(true);
      }
    } finally {
      // Only the latest run may clear the flags — a superseded run finishing
      // late must not flip inFlight while its replacement is still going
      // (that would let auto-refresh overlap it).
      if (token === lastTokenRef.current) {
        setLoading(false);
        inFlight.current = false;
      }
    }
  }, [sessionId, limit, withLimit, scopeToDb, engine]);

  // Optional auto-refresh: rerun the current view on the same token/cancel
  // path, only while this tab is visible and no run is in flight. Read the
  // view from the ref at tick time — capturing it here would keep refreshing
  // (and switching back to) the view that was active when the interval was
  // created.
  usePoll(() => {
    const v = lastViewRef.current;
    if (v && !inFlight.current) return run(v, true);
  }, refreshSec, { immediate: false });

  // Closing the panel cancels the in-flight view query — otherwise it keeps
  // running server-side (holding a pooled connection) after we are gone.
  useEffect(() => () => {
    const t = lastTokenRef.current;
    if (t) invoke('cancel_panel_query', { sessionId, token: t }).catch(() => {});
  }, [sessionId]);

  const cancel = useCallback(() => {
    const t = lastTokenRef.current;
    if (t) invoke('cancel_panel_query', { sessionId, token: t }).catch(() => {});
  }, [sessionId]);

  /**
   * The kill you use when Cancel has not worked.
   *
   * Cancel sends `KILL QUERY` / `pg_cancel_backend` — a *request* the server
   * honours at its next interrupt point, which a statement stuck in a lock
   * wait can decline for minutes. This ends the backend outright
   * (`KILL CONNECTION` / `pg_terminate_backend`), and then **looks again** to
   * see whether it is actually gone, because a kill command returning Ok says
   * the request was accepted and nothing more.
   *
   * The session's connection dies with it; the pool opens another. That cost
   * is why this is a separate button rather than what Cancel does.
   */
  const [killNote, setKillNote] = useState<string | null>(null);
  const [killing, setKilling] = useState(false);
  const hardKill = useCallback(async () => {
    const t = lastTokenRef.current;
    if (!t) return;
    setKilling(true);
    setKillNote('Killing…');
    try {
      const out = await invoke<{ confirmed_gone: boolean | null; message: string }>(
        'kill_panel_query', { sessionId, token: t });
      setKillNote(out.message);
    } catch (e) {
      setKillNote(`Kill failed: ${errorDisplay(e)}`);
    } finally {
      setKilling(false);
    }
  }, [sessionId]);

  const changeLimit = useCallback((n: number) => {
    setLimit(n);
    if (lastViewRef.current && !loading) run(lastViewRef.current, true, n);
  }, [loading, run]);

  // Known server errors → actionable guidance instead of a raw error only.
  const errGuidance = error ? guidanceForError(error, engine) : null;
  // Empty grid on a consumer-dependent view → collection may be OFF.
  const emptyHint = !error && result && result.rows.length === 0 && active
    ? (psOff ? performanceSchemaOffGuidance() : consumerHint(active, disabledConsumers))
    : null;
  // ClickHouse query_log is off → explain the empty grid / absent-table error.
  const queryLogGuidance = queryLogOff ? QUERY_LOG_OFF_GUIDANCE : null;
  // MySQL/MariaDB "Scheduled events" view → offer scheduler + per-event actions
  // (review-only SQL into the editor). Percona/MariaDB share engine 'mysql'.
  const isEventsView = engine === 'mysql' && active?.id === 'my-events';

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🩺 DBA Views</span>
        {active && <span className="dv-desc">{active.description}</span>}
        {loading && <span className="dv-running"><Spinner variant="dots" size="1.1em" className="spinner-inline" />running…</span>}
        {killNote && <span className="dv-killnote">{killNote}</span>}
        <div style={{ flex: 1 }} />
        <span className="qsb-label">Limit</span>
        {[100, 1000, 10000, 0].map(n => (
          <button
            key={n}
            className={`qsb-btn ${limit === n ? 'active' : ''}`}
            data-tip={n === 0 ? 'No limit — full result' : `Cap at ${n.toLocaleString()} rows`}
            onClick={() => changeLimit(n)}
          >{n === 0 ? '∞' : n >= 1000 ? `${n / 1000}k` : n}</button>
        ))}
        <select
          value={refreshSec}
          onChange={e => setRefreshSec(Number(e.target.value))}
          title="Auto-refresh interval (pauses when this tab is hidden)"
        >
          {REFRESH_INTERVALS.map(s => (
            <option key={s} value={s}>{s === 0 ? 'Off' : `${s}s`}</option>
          ))}
        </select>
        {loading && (
          <>
            <button
              className="toolbar-btn proc-kill"
              data-tip="Ask the server to abort the statement (KILL QUERY / pg_cancel_backend). The connection survives — but a statement waiting on a lock can decline for a while."
              onClick={cancel}
            >■ Cancel</button>
            <button
              className="toolbar-btn proc-kill-hard"
              disabled={killing}
              data-tip="End the backend running it (KILL CONNECTION / pg_terminate_backend), then check that it is gone. This drops the connection — the pool opens another."
              onClick={hardKill}
            >{killing ? '…' : '⛔ Kill'}</button>
          </>
        )}
        {active && !loading && (
          <button className="toolbar-btn" onClick={() => run(active, true)}>↻ Refresh</button>
        )}
        {isEventsView && result && result.rows.length > 0 && (
          <EventActions
            engine={engine}
            columns={result.columns}
            rows={sortedRows}
            selRow={selRow}
          />
        )}
        {result && (
          <CopyExportMenu
            getData={() => ({ columns: result.columns.map(c => c.name), rows: sortedRows })}
            tableName={active?.id ?? 'dba_view'}
            engine={engine}
          />
        )}
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      <div className="dv-body">
        <aside className="dv-list">
          {categories.map(([cat, items]) => (
            <div key={cat}>
              <div className="dv-cat">{cat}</div>
              {items.map(v => {
                const blocked = blockedTip(v);
                return (
                  <div
                    key={v.id}
                    className={`dv-item ${v.id === activeId ? 'active' : ''}${blocked ? ' unavail' : ''}`}
                    data-tip={blocked ?? undefined}
                    aria-disabled={blocked ? true : undefined}
                    title={blocked ?? v.description}
                    onClick={() => { if (!blocked) run(v); }}
                  >
                    <span className="dv-item-label">{v.label}</span>
                    {v.demanding && !blocked && (
                      <span className="dv-warn" data-tip={`⚠ demanding: ${v.demanding}`} title={`demanding: ${v.demanding}`}>⚠</span>
                    )}
                    {blocked && <span className="dv-warn" title={blocked}>🔒</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {views.length === 0 && (
            <div className="mx-empty">No DBA views for this engine.</div>
          )}
        </aside>

        <div className="dv-result">
          {loading && <div className="proc-loading">Running…</div>}
          {error && <div className="proc-error-bar">{error}</div>}
          {error && (errGuidance || queryLogGuidance) && (
            <GuidanceBlock g={errGuidance ?? queryLogGuidance!} />
          )}
          {!loading && !error && !result && (
            <div className="mx-empty">Pick a view on the left.</div>
          )}
          {!loading && result && (
            <>
              {(queryLogGuidance || emptyHint) && (
                <GuidanceBlock g={queryLogGuidance ?? emptyHint!} />
              )}
              <FastGrid
                columns={result.columns}
                rows={sortedRows}
                sort={sort}
                onSortCol={onSortCol}
                onSelectionChange={isEventsView ? sel => setSelRow(sel ? sel.r1 : null) : undefined}
              />
              <div className="proc-status">
                {result.rows.length.toLocaleString()} rows{ms !== null ? ` · ${ms}ms` : ''}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
