/**
 * 🧹 Vacuum & Bloat — the PostgreSQL maintenance panel (docs/POSTGRES_PLAN.md W3).
 *
 * Five sections in the order the question is asked: is anything vacuuming NOW,
 * what is the BACKLOG against each table's own threshold, how much space is
 * wasted (BLOAT — estimates, exact when pgstattuple is installed), how close is
 * the WRAPAROUND emergency, and what to DO about it.
 *
 * This panel subsumes the old Vacuum advisor section of 🩹 Maintenance: same
 * ranked worklist idea, but database-wide (not schema-scoped), ranked against
 * each table's OWN reloptions-honoured threshold, and the actions here EXECUTE
 * through the same audited `monitor_query` path MaintenancePanel uses — with
 * lock level and cost stated before anything runs, typed confirmation for the
 * ACCESS EXCLUSIVE rewrites, and pg_repack as generated advice only.
 *
 * All reading SQL is the curated dbaViews SQL verbatim (utils/vacuumBloat.ts
 * pulls it by id); all ranking/parsing/action logic is pure in that module.
 *
 * The first PG DBA panel that writes: read-only sessions get greyed actions
 * naming the reason (the server-side guard rejects them anyway), and on prod
 * the exclusive rewrites warn that the server-side prod limit refuses them
 * unless the connection opted in.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { StatusIcon } from './StatusIcon';
import { isoNow, logAudit, newRunId } from '../utils/audit';
import { fmtDuration } from '../utils/fmtDuration';
import { usePoll } from '../hooks/usePoll';
import { useSessionPrivileges } from '../store/sessionPrivileges';
import { denied, privilegeTip } from '../utils/privileges';
import {
  vacuumBloatSupported,
  NOW_SQL, BLOCKERS_SQL, BACKLOG_SQL, HISTORY_SQL, TABLE_BLOAT_SQL,
  INDEX_BLOAT_SQL, WRAPAROUND_SQL, FREEZE_AGE_SQL, FREEZE_BLOCKERS_SQL,
  PGSTATTUPLE_STATE_SQL, PGSTATTUPLE_INSTALL_SQL,
  relationSizeSql, pgStatTableSql, pgStatIndexSql, EXACT_SCAN_MAX_BYTES,
  parseProgressRow, parseBacklogRow, rankBacklog, backlogReason,
  parseTableBloatRow, parseIndexBloatRow,
  parseWraparoundRow, wraparoundSummary, parseFreezeAgeRow, parseFreezeBlockerRow,
  parseHistoryRow,
  VB_ACTIONS, findVbAction, vbActionSql, actionCost,
} from '../utils/vacuumBloat';
import type {
  ProgressRow, BacklogRow, TableBloatRow, IndexBloatRow,
  WraparoundRow, FreezeAgeRow, FreezeBlockerRow, HistoryRow,
  VbActionId,
} from '../utils/vacuumBloat';

interface Props {
  session: Session;
  onClose: () => void;
}

/** A table (or one index of it) picked out of a section for the action bar. */
interface ActionTarget {
  schema: string;
  name: string;
  index?: string;
  sizePretty?: string;
  sizeBytes?: number;
  deadTup?: number;
}

interface RunResult {
  sql: string;
  ok: boolean;
  message: string;
  ms: number;
}

interface PgstattupleState {
  installed: boolean;
  available: boolean;
}

/** Hand generated SQL to the active session's editor for review — never run. */
function insertIntoEditor(sql: string) {
  window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));
}

function truthy(v: unknown): boolean {
  return v === true || v === 't' || v === 'true' || v === 1 || v === '1';
}

function fmtBytes(n: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function VacuumBloatPanel({ session, onClose }: Props) {
  const supported = vacuumBloatSupported(session.engine);
  const isProd = session.environment === 'prod';
  const readOnly = !!session.readOnly;
  const privs = useSessionPrivileges(session.sessionId, session.engine);

  const [serverMajor, setServerMajor] = useState<number | null>(null);
  const [currentDb, setCurrentDb] = useState<string | null>(null);
  const [pgstattuple, setPgstattuple] = useState<PgstattupleState | null>(null);

  const [now, setNow] = useState<ProgressRow[] | null>(null);
  const [blockers, setBlockers] = useState<string[][] | null>(null);
  const [backlog, setBacklog] = useState<BacklogRow[] | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [bloatTables, setBloatTables] = useState<TableBloatRow[] | null>(null);
  const [bloatIndexes, setBloatIndexes] = useState<IndexBloatRow[] | null>(null);
  const [wrap, setWrap] = useState<WraparoundRow[] | null>(null);
  const [freeze, setFreeze] = useState<FreezeAgeRow[] | null>(null);
  const [freezeBlockers, setFreezeBlockers] = useState<FreezeBlockerRow[] | null>(null);
  /** key → measured text; the exact figure is labelled at the point of display. */
  const [exact, setExact] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [measuring, setMeasuring] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const [target, setTarget] = useState<ActionTarget | null>(null);
  const [actionId, setActionId] = useState<VbActionId>('vacuum-verbose-analyze');
  const [confirmText, setConfirmText] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[]>([]);

  const q = useCallback(async (sql: string): Promise<QueryResult> => {
    return invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql });
  }, [session.sessionId]);

  /**
   * Every statement this panel RUNS goes through here, so it reaches the audit
   * log — the same contract MaintenancePanel's auditedRun keeps. The server-side
   * guard (read-only refusal, prod limits) sits inside monitor_query itself.
   */
  const auditedRun = useCallback(async (sql: string): Promise<QueryResult> => {
    const startedAt = isoNow();
    const t0 = performance.now();
    const base = {
      run_id: newRunId(),
      stmt_index: 1, stmt_total: 1,
      session_id: session.sessionId, tab_title: '🧹 Vacuum & Bloat',
      database: '', source: 'panel' as const,
      started_at: startedAt,
      connection_name: session.connectionName, db_user: '',
      engine: session.engine, sql,
    };
    try {
      const res = await q(sql);
      logAudit({ ...base, ended_at: isoNow(), duration_ms: Math.round(performance.now() - t0),
        ok: true, rows_out: res.rows.length,
        rows_affected: res.rows_affected === null ? null : Number(res.rows_affected),
        error: null });
      return res;
    } catch (e) {
      logAudit({ ...base, ended_at: isoNow(), duration_ms: Math.round(performance.now() - t0),
        ok: false, rows_out: 0, rows_affected: null, error: errorDisplay(e), raw_error: e });
      throw e;
    }
  }, [q, session.sessionId, session.connectionName, session.engine]);

  // ── section 1: Now — polled while the tab is on screen ─────────────────────
  const nowDenied = denied(privs, 'processlist-all');
  const nowTip = privilegeTip(privs, 'processlist-all', 'Running vacuums');

  const refreshNow = useCallback(async () => {
    if (nowDenied) return;
    try {
      const res = await q(NOW_SQL);
      setNow(res.rows.map(parseProgressRow));
      // Blockers matter only when a vacuum is actually waiting.
      if (res.rows.length > 0) {
        try {
          const b = await q(BLOCKERS_SQL);
          setBlockers(b.rows.map(r => r.map(v => String(v ?? ''))));
        } catch { setBlockers(null); }
      } else {
        setBlockers(null);
      }
    } catch { setNow(null); }
  }, [q, nowDenied]);

  // Loop + in-flight guard via hooks/usePoll (this copy shipped without the
  // guard — a slow pg_stat_progress query could stack overlapping ticks).
  usePoll(refreshNow, supported ? 3 : 0, { immediate: supported });

  // ── sections 2–4 + environment: on demand ──────────────────────────────────
  const refreshAll = useCallback(async () => {
    if (!supported) return;
    setRefreshing(true);
    const errs: string[] = [];
    const settle = async (label: string, sql: string, apply: (r: QueryResult) => void) => {
      try { apply(await q(sql)); } catch (e) { errs.push(`${label}: ${errorDisplay(e)}`); }
    };
    await Promise.all([
      settle('version', "SELECT current_setting('server_version_num')::int / 10000, current_database()",
        r => { setServerMajor(num(r.rows[0]?.[0])); setCurrentDb(str(r.rows[0]?.[1]) || null); }),
      settle('pgstattuple', PGSTATTUPLE_STATE_SQL,
        r => setPgstattuple(r.rows[0]
          ? { installed: truthy(r.rows[0][0]), available: truthy(r.rows[0][1]) }
          : null)),
      settle('backlog', BACKLOG_SQL, r => setBacklog(rankBacklog(r.rows.map(parseBacklogRow)))),
      settle('history', HISTORY_SQL, r => setHistory(r.rows.map(parseHistoryRow))),
      settle('table bloat', TABLE_BLOAT_SQL, r => setBloatTables(r.rows.map(parseTableBloatRow))),
      settle('index bloat', INDEX_BLOAT_SQL, r => setBloatIndexes(r.rows.map(parseIndexBloatRow))),
      settle('wraparound', WRAPAROUND_SQL, r => setWrap(r.rows.map(parseWraparoundRow))),
      settle('freeze age', FREEZE_AGE_SQL, r => setFreeze(r.rows.map(parseFreezeAgeRow))),
      nowDenied
        ? Promise.resolve()
        : settle('freeze blockers', FREEZE_BLOCKERS_SQL,
            r => setFreezeBlockers(r.rows.map(parseFreezeBlockerRow))),
    ]);
    setErrors(errs);
    setRefreshing(false);
    void refreshNow();
  }, [q, supported, nowDenied, refreshNow]);

  useEffect(() => { void refreshAll(); }, [refreshAll]);

  // ── section 3: exact measurement via pgstattuple, capped like the tuner ────
  const measureTable = useCallback(async (t: TableBloatRow) => {
    const key = `t:${t.schema}.${t.table}`;
    setMeasuring(key);
    try {
      const size = num((await q(relationSizeSql(t.schema, t.table))).rows[0]?.[0]);
      if (size > EXACT_SCAN_MAX_BYTES) {
        setExact(m => ({ ...m, [key]: { ok: false, text:
          `refused — ${fmtBytes(size)} is over the ${fmtBytes(EXACT_SCAN_MAX_BYTES)} exact-scan cap; `
          + 'pgstattuple reads every page. The estimate above is the answer at this size.' } }));
        return;
      }
      const r = await q(pgStatTableSql(t.schema, t.table));
      const row = r.rows[0];
      if (!row) throw new Error('no row back from pgstattuple');
      const [, , deadTuples, deadLen, freeSpace, wastePct] = row;
      setExact(m => ({ ...m, [key]: { ok: true, text:
        `${str(wastePct)}% wasted (pgstattuple-exact): ${fmtBytes(num(deadLen))} dead tuples `
        + `(${num(deadTuples).toLocaleString()} rows), ${fmtBytes(num(freeSpace))} free space` } }));
    } catch (e) {
      setExact(m => ({ ...m, [key]: { ok: false, text: errorDisplay(e) } }));
    } finally { setMeasuring(null); }
  }, [q]);

  const measureIndex = useCallback(async (i: IndexBloatRow) => {
    const key = `i:${i.schema}.${i.index}`;
    if (i.indexBytes > EXACT_SCAN_MAX_BYTES) {
      setExact(m => ({ ...m, [key]: { ok: false, text:
        `refused — ${i.indexSize} is over the ${fmtBytes(EXACT_SCAN_MAX_BYTES)} exact-scan cap.` } }));
      return;
    }
    setMeasuring(key);
    try {
      const r = await q(pgStatIndexSql(i.schema, i.index));
      const density = num(r.rows[0]?.[0]);
      setExact(m => ({ ...m, [key]: { ok: true, text:
        `${(100 - density).toFixed(1)}% wasted (pgstattuple-exact): leaf density ${density.toFixed(1)}%` } }));
    } catch (e) {
      setExact(m => ({ ...m, [key]: { ok: false, text: errorDisplay(e) } }));
    } finally { setMeasuring(null); }
  }, [q]);

  // ── section 5: the actions ─────────────────────────────────────────────────
  const applicable = useMemo(() => {
    if (!target) return [];
    return VB_ACTIONS.filter(a => a.target === (target.index ? 'index' : 'table'));
  }, [target]);

  const action = useMemo(() => {
    if (!target) return null;
    if (!applicable.some(a => a.id === actionId)) return applicable[0] ?? null;
    return findVbAction(actionId);
  }, [target, applicable, actionId]);

  const versionBlocked = action?.minMajor != null && serverMajor != null && serverMajor < action.minMajor;
  const actionSql = action && target
    ? vbActionSql(action.id, { schema: target.schema, name: target.name },
        { index: target.index, database: currentDb ?? undefined })
    : '';
  const needsConfirm = !!action?.confirmWord;
  const armed = !needsConfirm || confirmText.trim().toUpperCase() === action?.confirmWord;
  const runBlockedReason = readOnly
    ? 'This connection is read-only — the server rejects VACUUM/REINDEX here. Send the SQL to the editor instead.'
    : versionBlocked
      ? `${action?.label} needs PostgreSQL ${action?.minMajor}+ (this server is ${serverMajor}).`
      : null;

  useEffect(() => { setConfirmText(''); }, [actionId, target]);

  const run = useCallback(async () => {
    if (!action || !target || !action.executes || !armed || runBlockedReason) return;
    setRunning(true);
    const t0 = performance.now();
    try {
      await auditedRun(actionSql);
      setResults(prev => [...prev, {
        sql: actionSql, ok: true, message: 'done',
        ms: Math.round(performance.now() - t0),
      }]);
    } catch (e) {
      setResults(prev => [...prev, {
        sql: actionSql, ok: false, message: errorDisplay(e),
        ms: Math.round(performance.now() - t0),
      }]);
    }
    setRunning(false);
    setConfirmText('');
    // The numbers the panel shows are now stale — say so by refreshing.
    void refreshAll();
  }, [action, target, armed, runBlockedReason, actionSql, auditedRun, refreshAll]);

  const pick = (t: ActionTarget, preferred?: VbActionId) => {
    setTarget(t);
    setResults([]);
    if (preferred) setActionId(preferred);
  };

  if (!supported) {
    return (
      <div className="mnt">
        <div className="panel-header">
          <span className="panel-title">🧹 Vacuum &amp; Bloat</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
        <div className="mnt-note">
          Vacuum, bloat and transaction-id wraparound are PostgreSQL concepts —
          this panel reads pg_stat / pg_class catalogs that only PostgreSQL has.
        </div>
      </div>
    );
  }

  const wrapRows = wrap ?? [];

  return (
    <div className="mnt vb">
      <div className="panel-header">
        <span className="panel-title">🧹 Vacuum &amp; Bloat</span>
        <span className="mnt-schema">{session.connectionName}</span>
        {isProd && <span className="mnt-prod">prod</span>}
        {readOnly && <span className="mnt-prod" title="Write actions are greyed — the server rejects them on this session">read-only</span>}
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={() => void refreshAll()} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {errors.length > 0 && (
        <div className="mnt-scan-err">
          {errors.map((e, i) => <div key={i}><StatusIcon kind="error" /> {e}</div>)}
        </div>
      )}

      <div className="vb-body">

        {/* ── 1. Now ─────────────────────────────────────────────────── */}
        <section className={`vb-section${nowDenied ? ' unavail' : ''}`}
                 title={nowTip ?? undefined}>
          <h3>Now</h3>
          {now === null && <div className="mnt-muted">No vacuum running right now.</div>}
          {now && now.length === 0 && <div className="mnt-muted">No vacuum running right now.</div>}
          {now && now.map(p => (
            <div key={p.pid} className="vb-now-row">
              <span className="vb-now-table">{p.database}.{p.table || '?'}</span>
              <span className="vb-phase">{p.phase}</span>
              <div className="vb-bar">
                <div className="vb-bar-fill" style={{ width: `${p.scannedPct ?? 0}%` }} />
              </div>
              <span className="mnt-muted">
                {p.scannedPct ?? 0}% scanned{p.vacuumedPct != null ? ` · ${p.vacuumedPct}% vacuumed` : ''}
                {' '}· heap {p.heapTotal || '?'} · {p.indexPasses} index pass{p.indexPasses === 1 ? '' : 'es'} · pid {p.pid}
              </span>
            </div>
          ))}
          {blockers && blockers.length > 0 && (
            <div className="mnt-warn">
              <StatusIcon kind="error" />
              <span>
                Blocked: {blockers.map(b =>
                  `pid ${b[0]} waits on pid ${b[3]} (${b[4]}${b[6] ? `, for ${b[6]}` : ''})`).join(' · ')}
              </span>
            </div>
          )}
        </section>

        {/* ── 2. Backlog ─────────────────────────────────────────────── */}
        <section className="vb-section">
          <h3>Backlog <span className="vb-h">dead tuples against each table’s OWN autovacuum threshold (reloptions honoured)</span></h3>
          {backlog === null && <div className="mnt-muted">Not loaded yet.</div>}
          {backlog && backlog.length === 0 && (
            <div className="mnt-muted">No dead tuples anywhere — autovacuum is keeping up.</div>
          )}
          {backlog?.map(r => (
            <div key={`${r.schema}.${r.table}`} className="vb-row">
              <span className={`vb-state vb-state-${r.state}`}>{r.state === 'due' ? 'DUE' : r.state === 'rising' ? 'rising' : 'ok'}</span>
              <span className="vb-name">{r.schema}.{r.table}</span>
              <span className="mnt-muted vb-why">{backlogReason(r)}</span>
              <button className="dbs-link" onClick={() => pick({ schema: r.schema, name: r.table, deadTup: r.deadTup }, 'vacuum-verbose-analyze')}>act ▸</button>
            </div>
          ))}
          {history && history.some(h => h.neverAnalyzed || h.neverVacuumed) && (
            <div className="mnt-muted vb-hist">
              Never touched: {history.filter(h => h.neverAnalyzed || h.neverVacuumed).slice(0, 8)
                .map(h => `${h.schema}.${h.table} (${[h.neverVacuumed ? 'never vacuumed' : '', h.neverAnalyzed ? 'never analyzed' : ''].filter(Boolean).join(', ')})`)
                .join(' · ')}
            </div>
          )}
        </section>

        {/* ── 3. Bloat ───────────────────────────────────────────────── */}
        <section className="vb-section">
          <h3>Bloat <span className="vb-h">every number carries its source — estimate, or pgstattuple-exact</span></h3>

          {pgstattuple && !pgstattuple.installed && (
            <div className="mnt-warn">
              <StatusIcon kind="error" />
              <span>
                pgstattuple is {pgstattuple.available ? 'available but not installed' : 'not available on this server'}
                {' '}— the numbers below are ESTIMATES from pg_statistic widths.
                {pgstattuple.available && ' Install it for exact per-table and per-index figures:'}
              </span>
              {pgstattuple.available && (
                <button className="dbs-link"
                        onClick={() => insertIntoEditor(PGSTATTUPLE_INSTALL_SQL)}>
                  send CREATE EXTENSION to editor ▸
                </button>
              )}
            </div>
          )}

          {bloatTables && bloatTables.length === 0 && (
            <div className="mnt-muted">No table reads as bloated above the estimate floor.</div>
          )}
          {bloatTables?.map(t => {
            const key = `t:${t.schema}.${t.table}`;
            const ex = exact[key];
            return (
              <div key={key} className="vb-row">
                <span className="vb-name">{t.schema}.{t.table}</span>
                <span className="mnt-muted vb-why">
                  ~{t.estWasted} wasted of {t.size} ({t.estBloatPct ?? '?'}%) <em>estimate</em>
                </span>
                {ex && <span className={ex.ok ? 'vb-exact' : 'mnt-muted'}>{ex.text}</span>}
                {pgstattuple?.installed && !ex && (
                  <button className="dbs-link" disabled={measuring === key}
                          onClick={() => void measureTable(t)}>
                    {measuring === key ? 'measuring…' : 'measure exactly'}
                  </button>
                )}
                <button className="dbs-link"
                        onClick={() => pick({ schema: t.schema, name: t.table, sizePretty: t.size }, 'vacuum-verbose-analyze')}>
                  act ▸
                </button>
              </div>
            );
          })}

          {bloatIndexes && bloatIndexes.length > 0 && (
            <div className="vb-sub">Indexes ≥ 8 MB{bloatIndexes.some(i => i.suspect) ? ' — an index larger than its heap is the suspect shape' : ''}</div>
          )}
          {bloatIndexes?.map(i => {
            const key = `i:${i.schema}.${i.index}`;
            const ex = exact[key];
            return (
              <div key={key} className="vb-row">
                <span className={`vb-state ${i.suspect ? 'vb-state-due' : 'vb-state-ok'}`}>{i.suspect ? 'suspect' : 'index'}</span>
                <span className="vb-name">{i.schema}.{i.index}</span>
                <span className="mnt-muted vb-why">
                  {i.indexSize} on {i.tableSize} table{i.idxScan === 0 ? ' · never scanned' : ''} <em>estimate</em>
                </span>
                {ex && <span className={ex.ok ? 'vb-exact' : 'mnt-muted'}>{ex.text}</span>}
                {pgstattuple?.installed && !ex && (
                  <button className="dbs-link" disabled={measuring === key}
                          onClick={() => void measureIndex(i)}>
                    {measuring === key ? 'measuring…' : 'measure exactly'}
                  </button>
                )}
                <button className="dbs-link"
                        onClick={() => pick({ schema: i.schema, name: i.table, index: i.index, sizePretty: i.indexSize, sizeBytes: i.indexBytes }, 'reindex-index')}>
                  act ▸
                </button>
              </div>
            );
          })}
        </section>

        {/* ── 4. Wraparound ──────────────────────────────────────────── */}
        <section className="vb-section">
          <h3>Wraparound <span className="vb-h">the transaction-id countdown, and what is holding freezing back</span></h3>
          {wrap && <div className="mnt-muted">{wraparoundSummary(wrapRows)}</div>}
          {wrapRows.filter(w => w.state !== 'ok').map(w => (
            <div key={w.database} className="vb-row">
              <span className={`vb-state vb-state-${w.state === 'urgent' ? 'due' : 'rising'}`}>{w.state}</span>
              <span className="vb-name">{w.database}</span>
              <span className="mnt-muted vb-why">
                age {w.xidAge.toLocaleString()} — forced vacuum at {w.forcedVacuumAt.toLocaleString()},
                {' '}{w.xidsUntilShutdown.toLocaleString()} xids before shutdown
              </span>
            </div>
          ))}
          {freeze && freeze.some(f => (f.pctToForced ?? 0) >= 50) && (
            <>
              <div className="vb-sub">Oldest tables (closest to a forced anti-wraparound vacuum)</div>
              {freeze.filter(f => (f.pctToForced ?? 0) >= 50).slice(0, 8).map(f => (
                <div key={`${f.schema}.${f.table}`} className="vb-row">
                  <span className={`vb-state ${(f.pctToForced ?? 0) >= 90 ? 'vb-state-due' : 'vb-state-rising'}`}>
                    {f.pctToForced ?? '?'}%
                  </span>
                  <span className="vb-name">{f.schema}.{f.table}</span>
                  <span className="mnt-muted vb-why">age {f.xidAge.toLocaleString()} · {f.totalSize}</span>
                  <button className="dbs-link"
                          onClick={() => pick({ schema: f.schema, name: f.table, sizePretty: f.totalSize }, 'vacuum-verbose-analyze')}>
                    act ▸
                  </button>
                </div>
              ))}
            </>
          )}
          <div className={`vb-sub${nowDenied ? ' unavail' : ''}`} title={nowTip ?? undefined}>
            What is holding it
          </div>
          {!nowDenied && freezeBlockers && freezeBlockers.length === 0 && (
            <div className="mnt-muted">Nothing is holding freezing back — no old transactions, no abandoned prepared transactions, no stale slots.</div>
          )}
          {!nowDenied && freezeBlockers?.map((b, i) => (
            <div key={i} className="vb-row">
              <span className="vb-state vb-state-rising">{b.kind}</span>
              <span className="vb-name">{b.ident}{b.who ? ` (${b.who})` : ''}</span>
              <span className="mnt-muted vb-why">
                {b.ageS != null ? `${fmtDuration(b.ageS * 1000)} old · ` : ''}{b.detail}
              </span>
            </div>
          ))}
        </section>

        {/* ── 5. Do something ────────────────────────────────────────── */}
        <section className="vb-section">
          <h3>Do something <span className="vb-h">lock level and cost are stated BEFORE anything runs</span></h3>
          {!target && (
            <div className="mnt-muted">
              Pick a table or index with an <b>act ▸</b> button above — or every action can
              send its SQL to the editor instead of running it.
            </div>
          )}
          {target && (
            <>
              <div className="vb-target">
                Target: <b>{target.schema}.{target.index ?? target.name}</b>
                {target.index && <span className="mnt-muted"> (index of {target.name})</span>}
                <button className="dbs-link" onClick={() => setTarget(null)}>clear</button>
              </div>
              <div className="mnt-ops">
                {applicable.map(a => (
                  <button
                    key={a.id}
                    className={`mnt-op${action?.id === a.id ? ' active' : ''}${a.lockLevel === 'exclusive' ? ' danger' : ''}`}
                    onClick={() => setActionId(a.id)}
                  >
                    {a.label}
                    <em>{a.lock}</em>
                  </button>
                ))}
              </div>
              {action && (
                <>
                  <div className="mnt-bulk-cost c-metadata">
                    <StatusIcon kind={action.lockLevel === 'exclusive' ? 'error' : 'ok'} />
                    <span>{action.summary}</span>
                  </div>
                  <div className="mnt-muted vb-cost">
                    Cost: {actionCost(action.id, { sizePretty: target.sizePretty, deadTup: target.deadTup })}
                  </div>
                  {action.warning && (
                    <div className="mnt-warn"><StatusIcon kind="error" /> <span>{action.warning}</span></div>
                  )}
                  <pre className="mnt-bulk-sql">{actionSql}</pre>
                  <div className="mnt-run">
                    {action.executes && needsConfirm && (
                      <label className="mnt-confirm">
                        <span>Type <b>{action.confirmWord}</b> to enable</span>
                        <input value={confirmText} spellCheck={false}
                               onChange={e => setConfirmText(e.target.value)} />
                      </label>
                    )}
                    <div style={{ flex: 1 }} />
                    <button className="dbs-link" onClick={() => insertIntoEditor(actionSql)}>
                      send to editor ▸
                    </button>
                    {action.executes && (
                      <span
                        className={runBlockedReason ? 'unavail' : undefined}
                        title={runBlockedReason ?? undefined}
                      >
                        <button
                          className={action.lockLevel === 'exclusive' ? 'toolbar-btn mnt-danger' : 'primary'}
                          disabled={running || !armed}
                          onClick={() => { if (!runBlockedReason) void run(); }}
                        >
                          {running ? 'Running…' : `Run ${action.label}`}
                        </button>
                      </span>
                    )}
                  </div>
                </>
              )}
            </>
          )}
          {results.length > 0 && (
            <div className="mnt-results">
              <div className="mnt-results-head">
                {results.filter(r => r.ok).length} ok
                {results.some(r => !r.ok) && ` · ${results.filter(r => !r.ok).length} failed`}
              </div>
              {results.map((r, i) => (
                <div key={i} className={`mnt-result${r.ok ? '' : ' bad'}`}>
                  <StatusIcon kind={r.ok ? 'ok' : 'error'} />
                  <span className="mnt-result-table">{r.sql}</span>
                  <span className="mnt-result-msg">{r.message}{r.ms > 0 ? ` · ${fmtDuration(r.ms)}` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}
