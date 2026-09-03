/**
 * The query/script run engine (WP-16 16.1 step 4) — executeOne, executeSql,
 * runQuery and their private helpers, extracted verbatim from QueryTabs.
 *
 * The BOUNDARY: modal state stays in QueryTabs. The engine defers to the
 * write-confirm window, the mid-script error dialog, the :variable prompt and
 * the script pre-flight through the setters in {@link QueryRunnerDeps}; the
 * modal handlers in QueryTabs call the returned `executeSql` to continue a
 * deferred run. Everything else the engine touches — tab state, tx state,
 * activity marks, logs, notifications — also arrives through deps, so this
 * hook has no state of its own and the move is behavior-neutral.
 */
import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

import type { QueryResult, Session, ConnectionConfig } from '../types';
import type { QueryTab } from '../components/QueryTabs';
import { errorDisplay } from '../utils/appError';
import { getPref, PREFS } from '../store/preferences';
import { addLog } from '../store/logStore';
import { setActivity, clearActivity, sqlTabKey } from '../store/tabActivity';
import { beep } from '../utils/beep';
import { notifyLongQuery } from '../store/notify';
import { fmtDuration } from '../utils/fmtDuration';
import { redactSecrets } from '../utils/redactSecrets';
import { splitStatements } from '../utils/sqlSplit';
import { statementIndexAt, foldScriptInto } from '../utils/runMarkers';
import {
  guardWrite, isWriteStatement, isDangerousDdl, isUnfilteredWrite,
  isDmlStatement, isReadFamilyStatement,
} from '../utils/sqlGuard';
import { can } from '../utils/engineCaps';
import { explainVerdict } from '../utils/explainable';
import { fingerprint } from '../utils/slowLogParse';
import { applyDefaultLimit, limitDialect } from '../utils/limitGuard';
import { preflightScript, shouldPreflight } from '../utils/preflight';
import type { PreflightReport } from '../utils/preflight';
import { findVariables } from '../utils/sqlVars';
import {
  isCancellation, isAbortedTransaction, txEffect, needsSavepoint, summarise,
  needsDecision, defaultChoice, applyChoice, tally, scriptResultTabs, scriptResultFor,
  SAVEPOINT_SQL, SAVEPOINT_RELEASE, SAVEPOINT_ROLLBACK,
} from '../utils/scriptRun';
import type { ScriptErrorChoice, ScriptErrorMode } from '../utils/scriptRun';
import { isoNow, logAudit, newRunId } from '../utils/audit';
import { expandAlias } from '../utils/aliasExpand';
import type { AliasDef } from '../utils/aliasExpand';
import { toAppError } from '../utils/appError';
import type { ScriptLine, ScriptErrorRequest } from '../components/QueryTabs';
import type { WriteConfirmRequest } from '../components/WriteConfirm';

/** Per-statement row cap for script results — single results rely on the
 *  default-LIMIT guard; a script of N uncapped SELECTs would hold N full
 *  result sets, so each is trimmed to the first SCRIPT_KEEP_ROWS rows. */
const SCRIPT_KEEP_ROWS = 5000;

export interface QueryRunnerDeps {
  session: Session;
  /** session.sessionId, pre-extracted (the log call sites use it). */
  sid: string;
  /** The tab a bare runQuery targets — bound at call time by the host. */
  activeTabId: number;
  currentDb: string;
  connCfg: ConnectionConfig | null;
  supportsDbSelect: boolean;
  txOpen: boolean;

  tabsRef: React.MutableRefObject<QueryTab[]>;
  txOpenRef: React.MutableRefObject<boolean>;
  currentDbRef: React.MutableRefObject<string>;
  dbUserRef: React.MutableRefObject<string>;
  /** The status bar's default-LIMIT choice + whether the user touched it. */
  defaultLimitRef: React.MutableRefObject<number>;
  limitTouchedRef: React.MutableRefObject<boolean>;
  /** #define-style aliases the editor collected (utils/aliasExpand). */
  aliasesRef: React.MutableRefObject<Map<string, AliasDef>>;

  patchTab: (id: number, patch: Partial<QueryTab>) => void;
  liveSql: (t: QueryTab) => string;
  beginTx: () => Promise<void>;
  endTx: (cmd: 'commit_transaction' | 'rollback_transaction') => Promise<void>;
  recordVersion: (tabId: number, sql: string, reason: 'edit' | 'run' | 'manual') => void;

  // ── The modals, staying in QueryTabs ──
  setScriptAsk: (ask: ScriptErrorRequest | null) => void;
  setWriteAsk: (ask: (WriteConfirmRequest & { tabId: number; from?: number; noResults?: boolean }) | null) => void;
  setVarPrompt: (p: { vars: string[]; sql: string; tabId: number; from?: number; noResults?: boolean } | null) => void;
  setPreflight: (p: { report: PreflightReport; sql: string; tabId: number; from?: number; noResults?: boolean } | null) => void;
}

export function useQueryRunner(deps: QueryRunnerDeps) {
  const {
    session, sid, activeTabId, currentDb, connCfg, supportsDbSelect, txOpen,
    tabsRef, txOpenRef, currentDbRef, dbUserRef,
    defaultLimitRef, limitTouchedRef, aliasesRef,
    patchTab, liveSql, beginTx, endTx, recordVersion,
    setScriptAsk, setWriteAsk, setVarPrompt, setPreflight,
  } = deps;

  /**
   * The attribution every audit row carries.
   *
   * Kept in one place so a new call site cannot forget half of it — an audit
   * row missing its tab or database is the row you cannot act on later.
   */
  const auditCtx = useCallback((tabId: number, ctx?: { runId: string; index?: number; total?: number }) => ({
    run_id: ctx?.runId ?? '',
    stmt_index: ctx?.index ?? null,
    stmt_total: ctx?.total ?? null,
    session_id: session.sessionId,
    tab_title: tabsRef.current.find(t => t.id === tabId)?.label ?? `Tab ${tabId}`,
    database: currentDbRef.current ?? '',
    source: 'editor' as const,
  }), [session.sessionId, currentDbRef, tabsRef]);

  /** Run one statement: prod-cap/default-LIMIT guard + audit + session log. */
  const executeOne = useCallback(async (
    rawSql: string,
    tabId: number,
    /** Audit attribution — which run, and where in it. */
    ctx?: { runId: string; index?: number; total?: number },
  ): Promise<{ result: QueryResult; limited: boolean; limit: number | null; prodCapped: boolean }> => {
    // Prod row cap (soft): on prod the pref cap replaces the default LIMIT —
    // unless the user picked a limit in this session's status bar (that wins).
    const cap = getPref(PREFS.prodRowCap);
    const prodCapped = session.environment === 'prod' && cap > 0 && !limitTouchedRef.current;
    const effLimit = prodCapped ? cap : defaultLimitRef.current;
    // The row cap rewrites a SELECT, so it only applies where there is SQL to
    // rewrite. Redis commands are passed through untouched.
    // The dialect matters as much as the limit: T-SQL has no LIMIT, so on SQL
    // Server the cap is `SELECT TOP (n)` and appending LIMIT was a syntax error
    // on every unbounded SELECT.
    const guard = can(session.engine, 'sql')
      ? applyDefaultLimit(rawSql, effLimit, limitDialect(session.engine))
      : { sql: rawSql, applied: false };
    const sql = guard.sql;
    // Redacted copy for LOG/AUDIT output only — the executed SQL and the query
    // history keep the original text (re-run needs it; the backend logs `sql`).
    const safeSql = redactSecrets(sql);
    const startedAt = isoNow();
    const t0 = performance.now();
    const oneLine = safeSql.replace(/\s+/g, ' ').trim();
    addLog(sid, { level: 'info', action: 'QUERY', detail: oneLine, line: `> ${oneLine}` });
    try {
      const result: QueryResult = await invoke('execute_query', {
        sessionId:    session.sessionId,
        connectionId: session.connectionId,
        engine:       session.engine,
        tabId,
        sql,
        includeWarnings: getPref(PREFS.queryWarnings),
      });
      const ms = Math.round(performance.now() - t0);
      const execMs = Math.round(result.execution_ms);
      const fetchMs = Math.round(result.fetch_ms ?? 0);
      const totalMs = execMs + fetchMs;
      logAudit({
        ...auditCtx(tabId, ctx),
        started_at: startedAt, ended_at: isoNow(), duration_ms: ms,
        connection_name: session.connectionName, db_user: dbUserRef.current,
        engine: session.engine, ok: true,
        rows_out: result.rows.length,
        rows_affected: result.rows_affected === null ? null : Number(result.rows_affected),
        error: null, sql: safeSql,
      }, { alsoLog: false });
      // Server warnings land between the run line and the result line.
      for (const w of result.warnings ?? []) {
        addLog(sid, { level: 'warn', action: 'QUERY', detail: w, line: w });
      }
      const rowCount = result.rows.length;
      const affected = result.rows_affected === null ? null : Number(result.rows_affected);
      if (rowCount > 0 || (rowCount === 0 && (affected === null || affected === 0) && isReadFamilyStatement(sql))) {
        const n = rowCount;
        addLog(sid, { level: 'ok', action: 'QUERY', detail: oneLine,
          rows: n, execMs, fetchMs,
          line: `${n} row${n === 1 ? '' : 's'} retrieved in ${fmtDuration(totalMs)} (execution: ${fmtDuration(execMs)}, fetching: ${fmtDuration(fetchMs)})` });
      } else if (affected !== null && (affected > 0 || isDmlStatement(sql))) {
        addLog(sid, { level: 'ok', action: 'QUERY', detail: oneLine,
          rows: affected, execMs, fetchMs,
          line: `${affected} row${affected === 1 ? '' : 's'} affected in ${fmtDuration(totalMs)} (execution: ${fmtDuration(execMs)})` });
      } else {
        // SET / DDL / admin statements return neither rows nor a meaningful
        // affected count — DataGrip's "completed in".
        addLog(sid, { level: 'ok', action: 'QUERY', detail: oneLine,
          execMs, fetchMs,
          line: `completed in ${fmtDuration(totalMs)} (execution: ${fmtDuration(execMs)})` });
      }
      return { result, limited: guard.applied, limit: guard.applied ? effLimit : null,
        prodCapped: guard.applied && prodCapped };
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      logAudit({
        ...auditCtx(tabId, ctx),
        started_at: startedAt, ended_at: isoNow(), duration_ms: ms,
        connection_name: session.connectionName, db_user: dbUserRef.current,
        engine: session.engine, ok: false,
        rows_out: 0, rows_affected: null, error: errorDisplay(err),
        // The display text has the number folded into it for a reader; the
        // raw rejection is what the stored columns are read from.
        raw_error: err, error_code: toAppError(err).code, sql: safeSql,
      }, { alsoLog: false });
      addLog(sid, { level: 'err', action: 'QUERY', detail: errorDisplay(err), ms,
        line: `! ${errorDisplay(err).replace(/\s+/g, ' ').trim()} (after ${fmtDuration(ms)})` });
      throw err;
    }
  }, [session, sid, auditCtx, dbUserRef, defaultLimitRef, limitTouchedRef]);

  /** A SQL tab is running a statement — the close-guard needs to know. */
  const markRunning = useCallback((tabId: number, sql: string) => {
    setActivity(sqlTabKey(session.sessionId, tabId), {
      id: 'query',
      label: 'Running query',
      detail: sql.replace(/\s+/g, ' ').trim().slice(0, 400),
      survives: true,   // the server keeps executing it if the tab goes away
      kill: () => { invoke('cancel_query', { sessionId: session.sessionId, tabId }).catch(() => {}); },
    });
  }, [session.sessionId]);
  const markIdle = useCallback((tabId: number) => {
    clearActivity(sqlTabKey(session.sessionId, tabId), 'query');
  }, [session.sessionId]);

  /**
   * Beep once a run was long enough that the user has probably looked away.
   * Below the threshold the sound would just be noise on every quick SELECT.
   */
  const beepIfLong = useCallback((startedMs: number, ok: boolean) => {
    if (!getPref(PREFS.beepOnLongQuery)) return;
    const threshold = getPref(PREFS.longQueryBeepSecs);
    if (!(threshold > 0)) return;
    if ((Date.now() - startedMs) / 1000 < threshold) return;
    beep(ok ? 'ok' : 'error');
  }, []);

  /**
   * The OS-notification twin of beepIfLong, for when the whole window is in
   * the background: same threshold, same call sites. The decision and the
   * payload are pure (utils/notify); store/notify owns permission + sending
   * and never throws, so a notification failure cannot hurt the finished run.
   */
  const notifyIfLong = useCallback((startedMs: number, ok: boolean,
    extra?: { statements?: number; error?: string }) => {
    void notifyLongQuery(startedMs, ok, extra);
  }, []);

  /**
   * Auto-EXPLAIN: a slow single statement gets its plan fetched in the
   * background, through the SAME guarded explain path Mod-E uses (explainVerdict
   * + the explain_query command — never a second execution route). The plan
   * waits behind a badge on the statement's gutter marker; nothing steals
   * focus, and a failed fetch is silent — a background nicety does not get an
   * error bar.
   *
   * Single-statement runs only: a script would mean N background EXPLAINs per
   * run, a surprise load the user never asked for.
   */
  const maybeAutoExplain = useCallback((sql: string, tabId: number, idx: number, ms: number) => {
    const threshold = getPref(PREFS.autoExplainSecs);
    if (!(threshold > 0) || ms < threshold * 1000) return;
    if (!can(session.engine, 'sql')) return;   // redis has no EXPLAIN at all
    if (!isReadFamilyStatement(sql)) return;   // SELECT-family only
    if (!explainVerdict(sql, session.engine).ok) return;
    void invoke<{ format: string; engine: string; content: string }>('explain_query', {
      sessionId: session.sessionId,
      sql,
      analyze: false,
      db: currentDb || null,
      mode: null,
    }).then(res => {
      const t = tabsRef.current.find(x => x.id === tabId);
      const cur = t?.stmtRuns[idx];
      // The statement re-ran (or failed) while the plan was in flight — the
      // badge belongs to the run it was fetched for, not to whatever marker
      // owns the slot now.
      if (!t || !cur || cur.status !== 'ok') return;
      patchTab(tabId, {
        autoPlans: { ...t.autoPlans, [idx]: { ...res, analyzed: false, sql, at: Date.now() } },
        stmtRuns: { ...t.stmtRuns, [idx]: { ...cur, hasPlan: true } },
      });
    }).catch(() => {});
  }, [session, currentDb, patchTab, tabsRef]);

  /**
   * Digest enrichment: after a run of at least 100 ms (below that, nobody is
   * asking), look up how THIS statement shape has done in the local query
   * history and add "ran N× · p95 …" to the marker's tooltip. The fingerprint
   * is the slow-log one (utils/slowLogParse); the backend mirrors it
   * (history::fingerprint_sql). Never blocks the run path; a failed lookup is
   * silent.
   */
  const maybeDigestStats = useCallback((sql: string, tabId: number, idx: number, startedMs: number, ms: number) => {
    if (ms < 100) return;
    if (!can(session.engine, 'sql')) return;
    void invoke<{ runs: number; avg_ms: number; p95_ms: number; last_seen: string } | null>(
      'history_digest_stats',
      { connectionId: session.connectionId, fingerprint: fingerprint(sql) },
    ).then(stats => {
      if (!stats) return;
      const t = tabsRef.current.find(x => x.id === tabId);
      const cur = t?.stmtRuns[idx];
      // Patch only if the entry still describes THIS run — a re-run that
      // started later owns the marker now.
      if (!t || !cur || cur.startedAt !== startedMs) return;
      patchTab(tabId, {
        stmtRuns: { ...t.stmtRuns, [idx]: { ...cur, stats: { runs: stats.runs, p95Ms: stats.p95_ms } } },
      });
    }).catch(() => {});
  }, [session, patchTab, tabsRef]);

  const executeSql = useCallback(async (sql: string, tabId: number, from?: number, noResults = false) => {
    const stmts = splitStatements(sql, getPref(PREFS.sqlDelimiter));
    const startedMs = Date.now();

    // ── single statement — straight to the grid ──
    if (stmts.length <= 1) {
      // The gutter marker needs the statement's buffer position, not the text
      // (variable substitution has already rewritten the text). Resolve the
      // offset to a statement INDEX once, HERE, against the buffer as it is
      // right now: stored as an index, the marker cannot drift when the buffer
      // is edited afterwards. Non-editor callers pass nothing; statement 0 is
      // the only sane read then.
      const tabNow = tabsRef.current.find(t => t.id === tabId);
      const idx = from == null || !tabNow ? 0
        : Math.max(0, statementIndexAt(liveSql(tabNow), from, getPref(PREFS.sqlDelimiter)));
      // A single run updates ONLY its statement's gutter entry — the others
      // persist (a script run's finished markers fold in first, so replacing
      // the script result view doesn't take its chips with it).
      const acc = foldScriptInto(tabNow?.scriptResults, tabNow?.stmtRuns ?? {});
      patchTab(tabId, { running: true, error: null, result: null, resultSql: null, scriptResults: null,
        scriptResultView: null, autoLimited: null, prodCap: null, runningSql: sql, runStartedAt: startedMs,
        stmtRuns: { ...acc, [idx]: { status: 'running', startedAt: startedMs } } });
      markRunning(tabId, sql);
      try {
        const { result, limit, prodCapped } = await executeOne(sql, tabId);
        const ms = Date.now() - startedMs;
        patchTab(tabId, {
          result, resultSql: sql, running: false, view: 'grid',
          autoLimited: limit, prodCap: prodCapped ? limit : null,
          stmtRuns: { ...acc, [idx]: { status: 'ok', ms, startedAt: startedMs } },
        });
        beepIfLong(startedMs, true);
        notifyIfLong(startedMs, true, { statements: 1 });
        // Background enrichments of the marker that just landed — both async,
        // both silent on failure, neither blocks the next keystroke.
        maybeAutoExplain(sql, tabId, idx, ms);
        maybeDigestStats(sql, tabId, idx, startedMs, ms);
      } catch (err) {
        patchTab(tabId, { error: errorDisplay(err), running: false,
          stmtRuns: { ...acc, [idx]: { status: 'error', ms: Date.now() - startedMs, startedAt: startedMs } } });
        beepIfLong(startedMs, false);
        notifyIfLong(startedMs, false, { statements: 1, error: errorDisplay(err) });
      } finally {
        markIdle(tabId);
      }
      return;
    }

    // ── script mode: run every statement sequentially, timing each ──
    const lines: ScriptLine[] = stmts.map(s => ({ text: s.text, status: 'pending' }));
    // Coalesced commits (WP-14 14.3): the loop calls setLines 2–3× per
    // statement and each commit re-renders every tab — buffered in a local
    // and flushed to state at most once per ~100 ms during the run. The
    // final flush (after the loop) is immediate so the finished state lands.
    let linesFlushTimer: number | null = null;
    let pendingLines: ScriptLine[] | null = null;
    const flushLines = () => {
      if (linesFlushTimer != null) { clearTimeout(linesFlushTimer); linesFlushTimer = null; }
      if (pendingLines) {
        patchTab(tabId, { scriptResults: [...pendingLines] });
        pendingLines = null;
      }
    };
    const setLines = (next: ScriptLine[]) => {
      pendingLines = next;
      if (linesFlushTimer == null) {
        linesFlushTimer = window.setTimeout(flushLines, 100);
      }
    };
    // A selection run's statement 0 is buffer statement K — resolve the base
    // ONCE, at run start, with the same split/filter rule the gutter uses, so
    // the markers land on the lines that actually ran. Whole-buffer runs pass
    // no `from` → base 0. statementIndexAt clamps, so a stale offset is safe.
    const tabNow = tabsRef.current.find(t => t.id === tabId);
    const scriptBase = from == null || !tabNow ? 0
      : Math.max(0, statementIndexAt(liveSql(tabNow), from, getPref(PREFS.sqlDelimiter)));
    patchTab(tabId, {
      running: true, error: null, result: null, resultSql: null, scriptResults: [...lines],
      scriptBase,
      scriptResultView: null,
      // The Script overview tab is gone — the Log is where a running script's
      // per-statement lines live now, so put it in front for the run. A run
      // that produced row sets lands on Result 1 when it finishes (below).
      view: 'log',
      autoLimited: null, prodCap: null,
      // A script run replaces every accumulated single-run marker: its own
      // per-statement lines drive the gutter from here on.
      stmtRuns: {},
      // Say the mode in the UI — a stale webview or an eaten shortcut must be
      // visible as "no results" NOT appearing here, not discovered after the run.
      runningSql: `${stmts.length} statements${noResults ? ' · no results' : ''}`,
      runStartedAt: startedMs,
    });
    markRunning(tabId, `script · ${stmts.length} statements${noResults ? ' · no results' : ''}`);

    const startedPerf = performance.now();
    let anyLimit: number | null = null;
    let anyProdCap = false;
    // Set by "Ignore all" — every later failure is then swallowed silently.
    let ignoreAll = false;
    let cancelled = false;
    let poisoned = false;
    // One id for the whole run, so the audit log shows ten statements as ONE
    // run rather than ten unrelated rows.
    const runId = newRunId();
    // Tracked from the script itself as well as from the toolbar: a user who
    // types `BEGIN;` at the top is just as much inside a transaction as one who
    // clicked the button, and the engine poisons on error either way.
    let inTx = txOpenRef.current;
    // Savepoint bookkeeping goes to the PINNED connection explicitly. Sending
    // it the ordinary way would acquire whatever connection the pool offered,
    // and a savepoint set on a different connection from the transaction is
    // worse than none — the caller believes it has protection it does not.
    const txExec = (sql: string) =>
      invoke('tx_exec', { sessionId: session.sessionId, sql });

    for (let i = 0; i < stmts.length; i++) {
      lines[i] = { ...lines[i], status: 'running', startedAt: Date.now() };
      setLines(lines);
      const t0 = performance.now();

      // A `BEGIN` typed into a script cannot just be executed: every statement
      // acquires its own connection from the pool, so the transaction would be
      // opened on one connection and the statements that follow would run —
      // and autocommit — on others, with the final COMMIT settling nothing.
      // Routing it through the same pinning the toolbar uses is what makes an
      // explicit transaction in a script actually hold.
      const eff0 = txEffect(stmts[i].text);
      if (eff0 === 'begin' && !txOpenRef.current) {
        await beginTx();
        inTx = txOpenRef.current;
        lines[i] = { ...lines[i], status: inTx ? 'ok' : 'error',
          ms: Math.round(performance.now() - t0),
          error: inTx ? undefined : 'could not open a transaction' };
        setLines(lines);
        continue;
      }
      if (eff0 === 'end' && txOpenRef.current) {
        const verb = /^\s*(commit|end)\b/i.test(stmts[i].text)
          ? 'commit_transaction' as const : 'rollback_transaction' as const;
        await endTx(verb);
        inTx = txOpenRef.current;
        lines[i] = { ...lines[i], status: 'ok', ms: Math.round(performance.now() - t0) };
        setLines(lines);
        continue;
      }
      // On PostgreSQL inside a transaction, a bare failure poisons everything
      // after it and silently turns the final COMMIT into a ROLLBACK. The
      // savepoint is what makes "ignore" mean what it says.
      // Savepoints need a pinned connection to be meaningful at all.
      const guarded = needsSavepoint(session.engine, inTx) && txOpenRef.current;
      if (guarded) { try { await txExec(SAVEPOINT_SQL); } catch { /* not fatal */ } }
      try {
        const { result, limit, prodCapped } = await executeOne(
          stmts[i].text, tabId, { runId, index: i + 1, total: stmts.length });
        if (guarded) { try { await txExec(SAVEPOINT_RELEASE); } catch { /* not fatal */ } }
        const eff = txEffect(stmts[i].text);
        if (eff === 'begin') inTx = true;
        else if (eff === 'end') inTx = false;
        anyLimit = anyLimit ?? limit;
        anyProdCap = anyProdCap || prodCapped;
        lines[i] = {
          ...lines[i],
          status: 'ok',
          ms: Math.round(performance.now() - t0),
          rows: result.rows_affected !== null ? Number(result.rows_affected) : result.rows.length,
          // every statement keeps its own result set — each row-producing one
          // becomes its own Result tab instead of collapsing into the last one.
          // …unless this is a "no result tabs" run (F9): side effects and
          // timings only. The row COUNT above still shows; the rows themselves
          // are dropped (no Result tab, and not held in memory either). The
          // keep-vs-drop decision lives in utils/scriptRun.scriptResultFor.
          ...scriptResultFor(result, stmts[i].text, noResults, SCRIPT_KEEP_ROWS),
        };
      } catch (err) {
        // ■ Cancel makes the running statement reject. Treating that as a
        // failure would stop and ask whether to ignore the statement the user
        // just deliberately stopped.
        if (isCancellation(err)) {
          cancelled = true;
          lines[i] = { ...lines[i], status: 'skipped', ms: Math.round(performance.now() - t0) };
          for (let j = i + 1; j < stmts.length; j++) lines[j] = { ...lines[j], status: 'skipped' };
          setLines(lines);
          break;
        }
        // PostgreSQL refusing every statement because an earlier one poisoned
        // the transaction is not N separate failures — it is one, already
        // reported, and the run cannot recover. Saying so once beats eight
        // identical errors that hide the real cause.
        if (isAbortedTransaction(err)) {
          poisoned = true;
          lines[i] = { ...lines[i], status: 'skipped', ms: Math.round(performance.now() - t0),
            error: 'skipped — the transaction was already aborted' };
          for (let j = i + 1; j < stmts.length; j++) lines[j] = { ...lines[j], status: 'skipped' };
          setLines(lines);
          break;
        }
        if (guarded) {
          // Back to just before this statement, so the transaction survives it.
          try { await txExec(SAVEPOINT_ROLLBACK); } catch { /* nothing left to save */ }
        }
        lines[i] = {
          ...lines[i],
          status: 'error',
          ms: Math.round(performance.now() - t0),
          error: errorDisplay(err),
        };
        setLines(lines);

        // A failure halfway through a script is a decision, not a verdict:
        // some scripts are a batch of independent statements where one bad
        // one should not bin the rest, and some are a sequence where step 4
        // is meaningless without step 3. Only the person running it knows.
        const mode = getPref(PREFS.scriptErrorMode) as ScriptErrorMode;
        let choice = defaultChoice(mode, ignoreAll);
        if (needsDecision(mode, ignoreAll)) {
          choice = await new Promise<ScriptErrorChoice>(resolve => {
            setScriptAsk({
              stmtNo: i + 1, total: stmts.length,
              sql: stmts[i].text, error: errorDisplay(err),
              // Whether ignoring is actually safe here depends on the engine
              // and on being inside a transaction; the prompt says which.
              inTransaction: inTx,
              savepointed: guarded,
              resolve,
            });
          });
          setScriptAsk(null);
        }
        const { keepGoing, ignoreRest } = applyChoice(choice);
        if (ignoreRest) ignoreAll = true;

        if (!keepGoing) {
          for (let j = i + 1; j < stmts.length; j++) lines[j] = { ...lines[j], status: 'skipped' };
          setLines(lines);
          break;
        }
        // ignored — fall through and keep running the rest
      }
      setLines(lines);
    }
    flushLines();

    // Counted from the lines rather than from counters kept alongside them: a
    // cancel rewrites every later line to `skipped` without touching a counter,
    // so the two could disagree and the summary contradict the list above it.
    const outcome = tally(lines, {
      wallMs: Math.round(performance.now() - startedPerf),
      cancelled,
      transactionOpen: inTx,
      transactionPoisoned: poisoned,
    });
    const summary = summarise(outcome);
    // The mode is part of the record: a no-results run says so in the log, so
    // a misdelivered shortcut is obvious immediately.
    if (noResults) summary.text += ' · results discarded';
    // Land on Result 1 when anything produced rows; a no-results run (F9) or
    // a run of pure writes/DDL (ANALYZE & friends) has no result sets and
    // stays on the Log, whose per-statement lines are the whole story.
    const resultTabs = scriptResultTabs(lines);
    patchTab(tabId, {
      running: false,
      autoLimited: anyLimit, prodCap: anyProdCap ? anyLimit : null,
      scriptResultView: resultTabs.length > 0 ? resultTabs[0] : null,
      view: resultTabs.length > 0 ? 'grid' : 'log',
      // Only a non-clean run puts a message in the error bar; a clean one is
      // reported by the summary line in the Log.
      error: summary.level === 'ok' ? null : summary.text,
    });
    addLog(sid, {
      level: summary.level === 'ok' ? 'ok' : summary.level === 'warn' ? 'warn' : 'err',
      action: 'SCRIPT', detail: summary.text, line: summary.text,
    });
    markIdle(tabId);
    beepIfLong(startedMs, outcome.failed === 0 && !poisoned && !cancelled);
    notifyIfLong(startedMs, outcome.failed === 0 && !poisoned && !cancelled, {
      statements: outcome.total,
      error: outcome.failed > 0 ? summary.text : undefined,
    });
  }, [executeOne, markRunning, markIdle, beepIfLong, notifyIfLong, maybeAutoExplain, maybeDigestStats, session, sid, beginTx, endTx, liveSql, patchTab, setScriptAsk, tabsRef, txOpenRef]);

  const runQuery = useCallback(async (input: string, from?: number, opts?: { noResults?: boolean }) => {
    const noResults = opts?.noResults ?? false;
    if (!input.trim()) return;
    // Bind to the tab that launched this run, up front. Everything below —
    // including the deferred paths through the pre-flight / write-confirm /
    // variable modals — must target THIS tab, not whatever is active when the
    // user later clicks the modal's Run (they can switch tabs via ⌘T meanwhile).
    const tabId = activeTabId;
    // "The version that ran" is the most useful bookmark in the timeline.
    recordVersion(tabId, input, 'run');
    // Alias expansion: `myalias 8793 'x'` → saved query with :1 :2 filled in.
    // Per statement, so aliases mix freely with plain SQL in a script.
    let sql = input;
    const delim = getPref(PREFS.sqlDelimiter);
    {
      const parts = splitStatements(input, delim);
      let any = false;
      const rebuilt = parts.map(p => {
        const e = expandAlias(p.text, aliasesRef.current);
        any = any || e.expanded;
        return e.sql;
      });
      // Rejoin with the SAME terminator we split on — hardcoding `;` here
      // turned a custom-delimiter script into one unsplittable statement.
      if (any) sql = rebuilt.join(`${delim}\n`);
    }
    const stmts = splitStatements(sql, delim);

    // ── Pre-flight: judge the WHOLE script before running any of it ─────────
    // A twenty-statement script used to fail at whichever statement first
    // tried to write, with everything before it already applied. Every
    // statement is checked first now, and one refusal stops all of them.
    //
    // Single statements are deliberately excluded: they already get the write
    // confirmation, which says more about one statement (including its live
    // row count) than a one-row table would.
    if (stmts.length > 1) {
      const report = preflightScript(sql, {
        readOnly: session.readOnly,
        environment: session.environment,
        allowProdDdl: connCfg?.prod_allow_ddl ?? false,
        allowUnfilteredWrite: connCfg?.prod_allow_unfiltered_write ?? false,
        delimiter: delim,
      });
      if (shouldPreflight(report)) {
        setPreflight({ report, sql, tabId, from, noResults });
        return;
      }
    }

    // ── Prod hard limits — the server enforces these; check here first so the
    // user gets a clean message instead of a backend error. The predicates are
    // exact mirrors of src-tauri/src/sqlguard.rs (never block what it wouldn't).
    if (session.environment === 'prod') {
      const allowDdl = connCfg?.prod_allow_ddl ?? false;
      const allowUnfiltered = connCfg?.prod_allow_unfiltered_write ?? false;
      const where = (bad: number[]) =>
        stmts.length > 1 ? ` in statement${bad.length === 1 ? '' : 's'} ${bad.join(', ')}` : '';
      if (!allowDdl) {
        const bad = stmts.map((s, i) => isDangerousDdl(s.text) ? i + 1 : 0).filter(n => n > 0);
        if (bad.length > 0) {
          patchTab(tabId, { error:
            `Blocked on prod: destructive DDL (DROP/TRUNCATE/ALTER/RENAME/GRANT/REVOKE)${where(bad)}`
            + ` — enable 'Allow destructive DDL' on the connection.` });
          return;
        }
      }
      if (!allowUnfiltered) {
        const bad = stmts.map((s, i) => isUnfilteredWrite(s.text) ? i + 1 : 0).filter(n => n > 0);
        if (bad.length > 0) {
          patchTab(tabId, { error:
            `Blocked on prod: UPDATE/DELETE without a WHERE clause${where(bad)}`
            + ` — enable 'Allow unfiltered UPDATE/DELETE' on the connection.` });
          return;
        }
      }
    }
    if (stmts.length > 1) {
      // script: guard every statement, one combined decision
      const writes = stmts.filter(s =>
        guardWrite(s.text, { readOnly: session.readOnly, environment: session.environment }) !== 'allow'
        || isWriteStatement(s.text));
      // The read-only refusal and the production confirmation both moved into
      // the pre-flight above, which reaches this point only when it found
      // nothing to refuse or confirm. A count in an alert ("3 write statements
      // of 20") could not say *which* three, which is the only part that helps.
      void writes;
    } else {
      const verdict = guardWrite(sql, {
        readOnly: session.readOnly, environment: session.environment,
      });
      if (verdict === 'deny') {
        patchTab(tabId, { error: 'Blocked: this connection is read-only.' });
        return;
      }
      // Anything that writes gets the real confirmation window: the statement,
      // its BLAST RADIUS (a live COUNT of the matching rows), the environment
      // and whether a default database is even selected. window.confirm could
      // show none of that (utils/writePreview + components/WriteConfirm).
      const unfiltered = isUnfilteredWrite(sql);
      // UPDATE and DELETE, plus the three that are irreversible or expensive:
      // DROP and TRUNCATE cannot be undone, and an ALTER can block writes for
      // ten minutes. All four now get the window that states the consequence
      // (cascade routes, and the DDL cost model) instead of running silently.
      const destructive = /^\s*(update|delete|drop\s+table|truncate|alter\s+table)\b/i.test(sql);
      const mode = getPref(PREFS.writeConfirm);
      const ask = verdict === 'confirm' || unfiltered
        || (mode === 'always' && isWriteStatement(sql))
        || (mode === 'destructive' && destructive);
      if (ask) {
        setWriteAsk({
          sql,
          sessionId: session.sessionId,
          connectionName: session.connectionName,
          environment: session.environment,
          hasDefaultDb: !supportsDbSelect || currentDb !== '',
          engine: session.engine,
          schema: currentDb || null,
          reason: verdict === 'confirm' ? 'prod' : unfiltered ? 'no-where' : 'requested',
          inTransaction: txOpen,
          tabId,
          from,
          noResults,
        });
        return;
      }
    }
    // :name variables → prompt, then execute the substituted statement
    const vars = can(session.engine, 'sqlVariables') ? findVariables(sql) : [];
    if (vars.length > 0) {
      setVarPrompt({ vars, sql, tabId, from, noResults });
      return;
    }
    executeSql(sql, tabId, from, noResults);
  }, [activeTabId, session, executeSql, currentDb, supportsDbSelect, txOpen, connCfg,
      recordVersion, patchTab, aliasesRef, setPreflight, setVarPrompt, setWriteAsk]);

  return { runQuery, executeSql, executeOne };
}
