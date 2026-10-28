import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { confirmDialog } from '../utils/appDialog';
import { audited } from '../utils/panelAudit';
import {
  appendMysqlWorkerStages, ddlKind, finishMysqlThreadSnapshot, mergeMysqlThreadSnapshots,
  mysqlCompletionLine, mysqlCurrentAlterStagesSql, mysqlPhaseTiming, mysqlProgressStats,
  mysqlStageSetup, mysqlThreadSnapshot, parseThreadId, progressProbe, threadActivityProbe,
  withMysqlAlterLifecycle, MYSQL_STAGE_SETUP, MYSQL_STAGE_STATUS_SQL,
} from '../utils/ddlProgress';
import type { MysqlStageSetup, MysqlThreadSnapshot } from '../utils/ddlProgress';
import { usePoll } from '../hooks/usePoll';
import { useSessionPrivileges } from '../store/sessionPrivileges';
import { denied, privilegeTip } from '../utils/privileges';
import { addLog } from '../store/logStore';

interface Props {
  session: Session;
  initialThreadId?: number | null;
  onClose: () => void;
}

interface OtherSnapshot {
  query: string;
  querySecs: number;
  state: string;
  phase: string;
  pct: number | null;
  detail: string;
}

interface EnableResult {
  instruments_affected: number;
  consumers_affected: number;
}

const number = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const seconds = (value: number): string => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
const work = (value: number | null): string => value === null ? '—' : value.toLocaleString();

export function ThreadProgressDialog({ session, initialThreadId, onClose }: Props) {
  const initial = initialThreadId && initialThreadId > 0 ? String(initialThreadId) : '';
  const [input, setInput] = useState(initial);
  const [threadId, setThreadId] = useState<number | null>(() => initial ? Number(initial) : null);
  const [inputError, setInputError] = useState('');
  const [snapshot, setSnapshot] = useState<MysqlThreadSnapshot | null>(null);
  const [other, setOther] = useState<OtherSnapshot | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [intervalSec, setIntervalSec] = useState(10);
  const [setup, setSetup] = useState<MysqlStageSetup | null>(null);
  const [setupError, setSetupError] = useState('');
  const [enabling, setEnabling] = useState(false);
  const [completionLine, setCompletionLine] = useState('');
  const epoch = useRef(0);
  const setupChecked = useRef(false);
  const threadIdRef = useRef<number | null>(initial ? Number(initial) : null);
  const snapshotRef = useRef<MysqlThreadSnapshot | null>(null);
  const completionLoggedFor = useRef<string | null>(null);
  const privs = useSessionPrivileges(session.sessionId, session.engine);
  const isMysql = session.engine === 'mysql';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      epoch.current += 1;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const start = () => {
    const id = parseThreadId(input);
    if (id === null) {
      setInputError('Enter a positive whole process/thread ID.');
      return;
    }
    epoch.current += 1;
    setupChecked.current = false;
    snapshotRef.current = null;
    completionLoggedFor.current = null;
    threadIdRef.current = id;
    setThreadId(id);
    setInput(String(id));
    setInputError('');
    setSnapshot(null);
    setOther(null);
    setSetup(null);
    setSetupError('');
    setError('');
    setDone(false);
    setLastUpdated(null);
    setCompletionLine('');
    void poll();
  };

  const recordCompletion = useCallback((previous: MysqlThreadSnapshot, showSummary: boolean) => {
    const finished = finishMysqlThreadSnapshot(previous);
    const key = `${finished.threadId}:${finished.statementEventId ?? 'unknown'}:${finished.query}`;
    if (completionLoggedFor.current !== key) {
      const line = mysqlCompletionLine(finished);
      completionLoggedFor.current = key;
      if (showSummary) setCompletionLine(line);
      addLog(session.sessionId, {
        level: 'ok', action: 'WATCH', detail: line, line,
      });
    }
    return finished;
  }, [session.sessionId]);

  const poll = useCallback(async () => {
    const watchedId = threadIdRef.current;
    if (watchedId === null) return;
    const mine = epoch.current;
    try {
      if (isMysql) {
        const probe = progressProbe('mysql', 'other', watchedId).sql!;
        const result = await invoke<QueryResult>('monitor_query', {
          sessionId: session.sessionId, sql: probe,
        });
        if (mine !== epoch.current) return;
        const parsed = mysqlThreadSnapshot(result.rows);
        if (!parsed) {
          const previous = snapshotRef.current;
          if (previous) {
            const finished = recordCompletion(previous, true);
            snapshotRef.current = finished;
            setSnapshot(withMysqlAlterLifecycle(finished));
          }
          setDone(true);
          setError('');
          setLastUpdated(new Date());
          return;
        }
        const previous = snapshotRef.current;
        if (previous && (previous.statementEventId !== parsed.statementEventId || previous.query !== parsed.query)) {
          recordCompletion(previous, false);
          setCompletionLine('');
        }
        const workersSql = mysqlCurrentAlterStagesSql(parsed);
        const workers = workersSql ? await invoke<QueryResult>('monitor_query', {
          sessionId: session.sessionId, sql: workersSql,
        }) : null;
        if (mine !== epoch.current) return;
        const next = mergeMysqlThreadSnapshots(
          previous, appendMysqlWorkerStages(parsed, workers?.rows ?? []),
        );
        snapshotRef.current = next;
        setSnapshot(withMysqlAlterLifecycle(next));
        setOther(null);
        setDone(false);
        setError('');
        setLastUpdated(new Date());
        if (next.stages.length === 0 && !setupChecked.current) {
          setupChecked.current = true;
          try {
            const status = await invoke<QueryResult>('monitor_query', {
              sessionId: session.sessionId, sql: MYSQL_STAGE_STATUS_SQL,
            });
            if (mine !== epoch.current) return;
            setSetup(mysqlStageSetup(status.rows[0]));
            setSetupError('');
          } catch (e) {
            if (mine === epoch.current) setSetupError(errorDisplay(e));
          }
        }
        return;
      }

      const activitySql = threadActivityProbe(session.engine, watchedId);
      if (!activitySql) {
        setError(`Thread progress is not available for ${session.engine}.`);
        setDone(true);
        return;
      }
      const activity = await invoke<QueryResult>('monitor_query', {
        sessionId: session.sessionId, sql: activitySql,
      });
      if (mine !== epoch.current) return;
      const row = activity.rows[0];
      if (!row) {
        setDone(true);
        setError('');
        return;
      }
      let phase = session.engine === 'sqlserver' ? String(row[4] ?? '') : '';
      let pct = session.engine === 'sqlserver' ? number(row[5]) : null;
      let detail = session.engine === 'sqlserver' && number(row[6]) !== null
        ? `server ETA ${seconds((number(row[6]) ?? 0) / 1000)}`
        : '';
      if (session.engine === 'postgres') {
        const probe = progressProbe('postgres', ddlKind(String(row[1] ?? '')), watchedId);
        if (probe.sql) {
          const progress = await invoke<QueryResult>('monitor_query', {
            sessionId: session.sessionId, sql: probe.sql,
          });
          if (mine !== epoch.current) return;
          const pr = progress.rows[0];
          if (pr) {
            phase = String(pr[0] ?? '');
            pct = number(pr[1]);
            detail = pr[2] ? `waiting on pid ${String(pr[2])}` : '';
          }
        } else {
          detail = probe.note ?? '';
        }
      }
      setOther({
        query: String(row[1] ?? ''), querySecs: number(row[2]) ?? 0,
        state: String(row[3] ?? ''), phase, pct, detail,
      });
      setSnapshot(null);
      setDone(false);
      setError('');
      setLastUpdated(new Date());
    } catch (e) {
      if (mine === epoch.current) setError(errorDisplay(e));
    }
  }, [isMysql, session.sessionId, session.engine, recordCompletion]);

  const refresh = usePoll(poll, intervalSec, {
    immediate: false,
    paused: threadId === null || done,
  });

  useEffect(() => {
    if (threadId !== null && !done) void refresh();
  }, [threadId, done, refresh]);

  const setupBlocked = session.readOnly
    ? 'Enable progress tracking — this connection is read-only'
    : privilegeTip(privs, 'stage-progress-admin', 'Enable progress tracking');

  const enableSetup = async () => {
    if (setupBlocked || enabling) return;
    const accepted = await confirmDialog(
      'Enable MySQL stage instruments and events_stages_% consumers on this server? '
      + 'This changes runtime performance_schema configuration, affects the whole server, '
      + 'and does not require a restart. It does not change application data.',
      { title: 'Enable progress tracking', okLabel: 'Enable' },
    );
    if (!accepted) return;
    setEnabling(true);
    setSetupError('');
    try {
      await audited({
        sessionId: session.sessionId,
        connectionName: session.connectionName,
        engine: session.engine,
        tab: 'Thread progress',
        source: 'panel',
        statement: MYSQL_STAGE_SETUP.join('\n'),
        run: () => invoke<EnableResult>('enable_mysql_stage_progress', {
          sessionId: session.sessionId,
        }),
      });
      setupChecked.current = false;
      setSetup(null);
      await refresh();
    } catch (e) {
      setSetupError(errorDisplay(e));
    } finally {
      setEnabling(false);
    }
  };

  const query = isMysql ? snapshot?.query ?? '' : other?.query ?? '';
  const querySecs = isMysql ? snapshot?.querySecs ?? 0 : other?.querySecs ?? 0;
  const state = isMysql ? snapshot?.state ?? '' : other?.state ?? '';
  const phaseCount = isMysql ? snapshot?.stages.filter(stage => stage.eventId > 0).length ?? 0 : other?.phase ? 1 : 0;
  const stalledCount = snapshot?.stages.filter(stage => stage.status === 'running' && stage.stalledForSecs >= 30).length ?? 0;
  const progressStats = snapshot ? mysqlProgressStats(snapshot) : null;
  const estimate = (value: number | null) => value === null ? 'indeterminate' : seconds(value);

  return (
    <div className="modal-overlay tpd-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal tpd-modal" role="dialog" aria-modal="true" aria-label="Thread progress">
        <div className="modal-header">
          <span className="modal-title">Thread progress — {session.connectionName}</span>
          <button className="modal-close" title="Close (the server thread keeps running)" onClick={onClose}>×</button>
        </div>

        <form className="tpd-picker" onSubmit={e => { e.preventDefault(); start(); }}>
          <label>Process / thread ID
            <input autoFocus value={input} inputMode="numeric" placeholder="e.g. 5432258"
              onChange={e => setInput(e.target.value)} />
          </label>
          <button className="primary" type="submit">Watch</button>
          <span className="form-hint">Read-only; closing never kills the thread.</span>
        </form>
        {inputError && <div className="db-error tpd-error">{inputError}</div>}
        {denied(privs, 'processlist-all') && (
          <div className="tpd-note">Your account can see only its own threads. Watching another user's thread requires PROCESS.</div>
        )}

        {threadId !== null && (
          <div className="tpd-toolbar">
            <strong>Thread {threadId}</strong>
            {done && <span className="tpd-done">not running / no longer visible</span>}
            {stalledCount > 0 && !done && (
              <span className="tpd-stall">possible stall — no completed work in {stalledCount} active phase{stalledCount === 1 ? '' : 's'} for ≥30 s</span>
            )}
            <span className="tpd-spacer" />
            <label>refresh
              <select value={intervalSec} onChange={e => setIntervalSec(Number(e.target.value))}>
                {[0.5, 1, 2, 5, 10].map(n => <option key={n} value={n}>{n} s</option>)}
              </select>
            </label>
            <button className="toolbar-btn" onClick={() => void refresh()}>Refresh</button>
            <span className="tpd-updated">
              {lastUpdated ? `updated ${lastUpdated.toLocaleTimeString()}` : 'waiting for first snapshot'}
            </span>
          </div>
        )}

        {error && <div className="db-error tpd-error">{error}{lastUpdated ? ' — showing the last successful snapshot.' : ''}</div>}

        <div className="tpd-body">
          {threadId === null && <div className="mx-empty">Enter the process ID you want to watch.</div>}
          {threadId !== null && !snapshot && !other && !error && !done && <div className="mx-empty">Loading thread {threadId}…</div>}
          {done && !snapshot && !other && !error && (
            <div className="mx-empty">Thread {threadId} was not found. It may have finished, been killed, or be invisible to your account.</div>
          )}

          {(snapshot || other) && (
            <>
              <div className="tpd-summary">
                <span>server process age <strong>{seconds(querySecs)}</strong></span>
                <span>state <strong>{state || '—'}</strong></span>
                <span>reported phases <strong>{phaseCount}</strong>
                  {progressStats && ` (${progressStats.active} active / ${progressStats.done} done)`}
                </span>
                {progressStats && (
                  <>
                    <span>estimated remaining <strong>{done ? '0 s' : estimate(progressStats.remainingSecs)}</strong></span>
                    <span>estimated total <strong>{estimate(progressStats.totalSecs)}</strong></span>
                  </>
                )}
              </div>
              {snapshot && (
                <div className="tpd-metadata">
                  <span>user <strong>{snapshot.user || '—'}@{snapshot.host || '—'}</strong></span>
                  <span>database <strong>{snapshot.database || '—'}</strong></span>
                  <span>command <strong>{snapshot.command || '—'}</strong></span>
                  <span>performance_schema thread <strong>{snapshot.statementThreadId ?? '—'}</strong></span>
                  <span>lock time <strong>{snapshot.stats.lockSecs === null ? '—' : seconds(snapshot.stats.lockSecs)}</strong></span>
                  <span>rows affected / examined / sent <strong>
                    {work(snapshot.stats.rowsAffected)} / {work(snapshot.stats.rowsExamined)} / {work(snapshot.stats.rowsSent)}
                  </strong></span>
                  <span>warnings / errors <strong>{work(snapshot.stats.warnings)} / {work(snapshot.stats.errors)}</strong></span>
                </div>
              )}
              <div className="tpd-query-head">
                <span>Full statement</span>
                <button className="toolbar-btn" disabled={!query}
                  onClick={() => void navigator.clipboard.writeText(query)}>Copy</button>
              </div>
              <pre className="tpd-query">{query || '(statement text is unavailable to this account)'}</pre>
              {completionLine && (
                <div className="tpd-completion" role="status">
                  <strong>Completed — final observed statistics</strong>
                  <div>{completionLine}</div>
                  <span>This line was also written to the session log.</span>
                </div>
              )}
            </>
          )}

          {snapshot && snapshot.stages.length > 0 && (
            <div className="tpd-table-wrap">
              <div className="tpd-operation">
                {ddlKind(snapshot.query) === 'create-index' ? 'CREATE INDEX'
                  : ddlKind(snapshot.query) === 'alter-table' ? 'ALTER TABLE' : 'Statement'} — InnoDB stages
              </div>
              <table className="tpd-phase-table">
                <thead>
                  <tr>
                    <th>Phase</th><th>Origin</th><th>Status</th><th>Work completed / estimated</th><th>Progress</th>
                    <th>Elapsed</th><th>Est. remaining</th><th>Est. total</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.stages.map(stage => {
                    const timing = mysqlPhaseTiming(stage);
                    return (
                      <tr key={`${snapshot.statementEventId}-${stage.phaseThreadId}-${stage.eventId}`}
                          className={`tpd-phase-${stage.status}${stage.stalledForSecs >= 30 && stage.status === 'running' ? ' tpd-phase-paused' : ''}`}>
                        <td className="tpd-phase-name" title={stage.sourceQuery || stage.phase}>{stage.phase}
                          {stage.status === 'running' && stage.stalledForSecs >= 30 && (
                            <span className="tpd-stall-detail">no completed work for {seconds(stage.stalledForSecs)}</span>
                          )}
                        </td>
                        <td className="tpd-origin">
                          {stage.connId === null ? 'background' : stage.connId}
                          {stage.phaseThreadId !== null && <span>THREAD_ID {stage.phaseThreadId}</span>}
                        </td>
                        <td><span className={`tpd-status tpd-status-${stage.status}`}>
                          {stage.status === 'running' && stage.stalledForSecs >= 30 ? 'paused?' : stage.status}
                        </span></td>
                        <td className="tpd-number">{work(stage.workCompleted)} / {work(stage.workEstimated)}</td>
                        <td className="tpd-progress-cell">
                          {stage.status === 'running' && stage.stalledForSecs < 30 && <span className="tpd-spinner" aria-label="running" />}
                          {stage.status === 'running' && stage.stalledForSecs >= 30 && <span className="tpd-pause-symbol" aria-label="paused">Ⅱ</span>}
                          <span>{stage.pct === null ? '—' : `${stage.pct.toFixed(1)}%`}</span>
                        </td>
                        <td className="tpd-number">{stage.phaseSecs === null ? '—' : seconds(stage.phaseSecs)}</td>
                        <td className="tpd-number">{stage.status === 'done' ? '0 s'
                          : stage.status === 'running' ? estimate(timing.remainingSecs) : '—'}</td>
                        <td className="tpd-number">{stage.status === 'pending' || stage.status === 'skipped'
                          ? '—' : estimate(timing.totalSecs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="tpd-estimate-note">
                Overall ETA is the longest active phase ETA, not a sum of overlapping phases.
                Future phases and phases without a server percentage are not predictable.
              </div>
            </div>
          )}

          {other && (
            <div className="tpd-stage">
              <div className="tpd-stage-head"><strong>{other.phase || 'running'}</strong></div>
              <div className="tpd-track">
                <div className={`tpd-fill${other.pct === null ? ' tpd-indeterminate' : ''}`}
                  style={other.pct === null ? undefined : { width: `${Math.max(0, Math.min(100, other.pct))}%` }} />
              </div>
              <div className="tpd-stage-numbers">
                <span>{other.pct === null ? 'no server estimate' : `${other.pct.toFixed(1)}%`}</span>
                <span>{other.detail}</span>
              </div>
            </div>
          )}

          {isMysql && snapshot && snapshot.stages.length === 0 && (
            <div className="tpd-setup">
              <strong>No ALTER/copy stage is currently reported.</strong>
              {setup?.ready && <p>Progress tracking is enabled. This statement may be between supported phases, or it may not publish work estimates.</p>}
              {setup && !setup.ready && (
                <>
                  <p>
                    Instruments: {setup.instrumentsReady}/{setup.instrumentsTotal} enabled and timed;
                    consumers: {setup.consumersReady}/{setup.consumersTotal} enabled.
                    Enable both to receive phase rows for statements started after setup.
                  </p>
                  <span className={setupBlocked ? 'unavail' : undefined} data-tip={setupBlocked ?? undefined}>
                    <button className={`toolbar-btn${setupBlocked ? ' unavail' : ''}`}
                      aria-disabled={setupBlocked ? true : undefined}
                      onClick={() => void enableSetup()}>
                      {enabling ? 'Enabling…' : 'Enable progress tracking'}
                    </button>
                  </span>
                </>
              )}
              {setupError && <div className="db-error">{setupError}</div>}
              {setupError && <p>performance_schema may be disabled at server startup, unavailable on this version, or inaccessible to your account. A startup-disabled performance_schema cannot be enabled by these UPDATE statements.</p>}
              {(setupError || setup) && (
                <button className="toolbar-btn" onClick={() => {
                  setupChecked.current = false;
                  setSetup(null);
                  setSetupError('');
                  void refresh();
                }}>Recheck setup</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
