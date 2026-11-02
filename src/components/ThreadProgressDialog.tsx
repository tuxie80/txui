import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { confirmDialog } from '../utils/appDialog';
import { audited } from '../utils/panelAudit';
import {
  activityCompletionLine, appendMysqlWorkerStages, cloudSqlReplicaIndexJobLine, cloudSqlReplicaIndexJobs,
  ddlKind, finishMysqlThreadSnapshot, mergeMysqlThreadSnapshots,
  mysqlCompletionLine, mysqlCurrentAlterStagesSql, mysqlOperationNotes, mysqlPhaseTiming, mysqlProgressStats,
  mysqlStageSetup, mysqlThreadSnapshot, parseThreadId, progressProbe, threadActivityProbe,
  sqlServerActivityDiagnostics, sqlServerOnlineIndexProgress, sqlServerOperatorProgress,
  sqlServerOperatorProgressSql, sqlServerResumableProgress, withMysqlAlterLifecycle,
  CLOUDSQL_REPLICA_IDX_STATUS_SQL, MYSQL_STAGE_SETUP, MYSQL_STAGE_STATUS_SQL, SQLSERVER_ONLINE_INDEX_EVENTS_SQL,
  SQLSERVER_RESUMABLE_PROGRESS_SQL,
} from '../utils/ddlProgress';
import type { CloudSqlReplicaIndexJob, MysqlStageSetup, MysqlThreadSnapshot } from '../utils/ddlProgress';
import { usePoll } from '../hooks/usePoll';
import { useSessionPrivileges } from '../store/sessionPrivileges';
import { denied, privilegeTip } from '../utils/privileges';
import { useServerFlavor } from '../store/serverFlavors';
import { addLog } from '../store/logStore';
import { notifyLongQuery } from '../store/notify';

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
  diagnostics: string[];
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
  const [copied, setCopied] = useState(false);
  const [cloudJobs, setCloudJobs] = useState<CloudSqlReplicaIndexJob[] | null>(null);
  const cloudChecked = useRef(false);
  const cloudSupported = useRef(false);
  const epoch = useRef(0);
  const setupChecked = useRef(false);
  const threadIdRef = useRef<number | null>(initial ? Number(initial) : null);
  const snapshotRef = useRef<MysqlThreadSnapshot | null>(null);
  const otherRef = useRef<OtherSnapshot | null>(null);
  const completionLoggedFor = useRef<string | null>(null);
  const privs = useSessionPrivileges(session.sessionId, session.engine);
  const serverFlavor = useServerFlavor(session.sessionId, session.engine);
  const isMysql = session.engine === 'mysql';
  const isMariaDb = isMysql && serverFlavor.flavor === 'mariadb';

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
    cloudChecked.current = false;
    cloudSupported.current = false;
    setCloudJobs(null);
    snapshotRef.current = null;
    otherRef.current = null;
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
    const finished = finishMysqlThreadSnapshot(withMysqlAlterLifecycle(previous));
    const key = `${finished.threadId}:${finished.statementEventId ?? 'unknown'}:${finished.query}`;
    if (completionLoggedFor.current !== key) {
      const line = mysqlCompletionLine(finished);
      completionLoggedFor.current = key;
      if (showSummary) setCompletionLine(line);
      addLog(session.sessionId, {
        level: 'ok', action: 'WATCH', detail: line, line,
      });
      void notifyLongQuery(Date.now() - finished.querySecs * 1000, true, { statements: 1 });
    }
    return finished;
  }, [session.sessionId]);

  const recordOtherCompletion = useCallback((previous: OtherSnapshot, showSummary: boolean) => {
    const id = threadIdRef.current;
    if (id === null) return;
    const key = `other:${session.engine}:${id}:${previous.query}:${previous.querySecs}`;
    if (completionLoggedFor.current === key) return;
    const line = activityCompletionLine(session.engine, id, previous);
    completionLoggedFor.current = key;
    if (showSummary) setCompletionLine(line);
    addLog(session.sessionId, { level: 'ok', action: 'WATCH', detail: line, line });
    void notifyLongQuery(Date.now() - previous.querySecs * 1000, true, { statements: 1 });
  }, [session.engine, session.sessionId]);

  const pollCloudJobs = useCallback(async (mine: number) => {
    if (!isMysql || (cloudChecked.current && !cloudSupported.current)) return;
    try {
      const result = await invoke<QueryResult>('monitor_query', {
        sessionId: session.sessionId, sql: CLOUDSQL_REPLICA_IDX_STATUS_SQL,
      });
      if (mine !== epoch.current) return;
      cloudChecked.current = true;
      cloudSupported.current = true;
      setCloudJobs(cloudSqlReplicaIndexJobs(result.rows));
    } catch {
      if (mine === epoch.current) cloudChecked.current = true;
    }
  }, [isMysql, session.sessionId]);

  const poll = useCallback(async () => {
    const watchedId = threadIdRef.current;
    if (watchedId === null) return;
    const mine = epoch.current;
    try {
      if (isMysql) {
        const probe = progressProbe('mysql', 'other', watchedId, serverFlavor.flavor).sql!;
        const result = await invoke<QueryResult>('monitor_query', {
          sessionId: session.sessionId, sql: probe,
        });
        if (mine !== epoch.current) return;
        let parsed = mysqlThreadSnapshot(result.rows);
        await pollCloudJobs(mine);
        if (mine !== epoch.current) return;
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
        let detailFailed = false;
        if (isMariaDb) {
          try {
            const detailedResult = await invoke<QueryResult>('monitor_query', {
              sessionId: session.sessionId, sql: progressProbe('mysql', 'other', watchedId).sql!,
            });
            if (mine !== epoch.current) return;
            const detailed = mysqlThreadSnapshot(detailedResult.rows);
            if (detailed && detailed.query === parsed.query) {
              parsed = { ...detailed, native: parsed.native };
            }
          } catch (e) {
            detailFailed = true;
            if (mine === epoch.current) setSetupError(errorDisplay(e));
          }
        }
        const previous = snapshotRef.current;
        if (previous && (previous.query !== parsed.query
          || (!isMariaDb && previous.statementEventId !== parsed.statementEventId))) {
          recordCompletion(previous, false);
          setCompletionLine('');
        }
        const workersSql = mysqlCurrentAlterStagesSql(parsed);
        const workers = workersSql ? await invoke<QueryResult>('monitor_query', {
          sessionId: session.sessionId, sql: workersSql,
        }) : null;
        if (mine !== epoch.current) return;
        const next = detailFailed && previous && previous.query === parsed.query
          ? { ...previous, native: parsed.native, querySecs: parsed.querySecs, state: parsed.state }
          : mergeMysqlThreadSnapshots(
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
        if (otherRef.current) recordOtherCompletion(otherRef.current, true);
        setDone(true);
        setError('');
        setLastUpdated(new Date());
        return;
      }
      let phase = session.engine === 'sqlserver' ? String(row[4] ?? '') : '';
      let pct = session.engine === 'sqlserver' ? number(row[5]) : null;
      let detail = session.engine === 'sqlserver' && number(row[6]) !== null
        ? `server ETA ${seconds((number(row[6]) ?? 0) / 1000)}`
        : '';
      const query = String(row[1] ?? '');
      const previous = otherRef.current;
      if (previous && previous.query !== query) {
        recordOtherCompletion(previous, false);
        setCompletionLine('');
      }
      if (session.engine === 'postgres') {
        const probe = progressProbe('postgres', ddlKind(query), watchedId);
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
      if (session.engine === 'sqlserver' && ddlKind(query) === 'create-index') {
        let failed = 0;
        const optional = async (sql: string) => {
          try {
            return await invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql });
          } catch {
            failed += 1;
            return null;
          }
        };
        const resumableRows = await optional(SQLSERVER_RESUMABLE_PROGRESS_SQL);
        if (mine !== epoch.current) return;
        const resumable = sqlServerResumableProgress(resumableRows?.rows ?? [], query);
        if (resumable) {
          ({ phase, pct, detail } = resumable);
        } else {
          const eventRows = await optional(SQLSERVER_ONLINE_INDEX_EVENTS_SQL);
          if (mine !== epoch.current) return;
          const online = sqlServerOnlineIndexProgress(eventRows?.rows ?? [], watchedId, row[16]);
          if (online) {
            ({ phase, pct, detail } = online);
          } else {
            const operatorSql = sqlServerOperatorProgressSql(watchedId)!;
            const operatorRows = await optional(operatorSql);
            if (mine !== epoch.current) return;
            const operator = sqlServerOperatorProgress(operatorRows?.rows ?? []);
            if (operator) ({ phase, pct, detail } = operator);
          }
        }
        if (pct === null && !detail) {
          detail = 'No completion percentage is exposed by the available SQL Server metadata.';
        }
        if (failed > 0) detail += `${detail ? ' · ' : ''}${failed} optional metadata source${failed === 1 ? '' : 's'} unavailable`;
      }
      const next = {
        query, querySecs: number(row[2]) ?? 0,
        state: String(row[3] ?? ''), phase, pct, detail,
        diagnostics: session.engine === 'sqlserver' ? sqlServerActivityDiagnostics(row) : [],
      };
      otherRef.current = next;
      setOther(next);
      setSnapshot(null);
      setDone(false);
      setError('');
      setLastUpdated(new Date());
    } catch (e) {
      if (mine === epoch.current) setError(errorDisplay(e));
    }
  }, [isMysql, isMariaDb, serverFlavor.flavor, session.sessionId, session.engine, recordCompletion, recordOtherCompletion, pollCloudJobs]);

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
  const operationNotes = snapshot ? mysqlOperationNotes(snapshot.query, serverFlavor.flavor) : [];
  const estimate = (value: number | null) => value === null ? 'indeterminate' : seconds(value);
  const copyDiagnostics = () => {
    const lines = [
      `Thread ${threadId ?? '—'} on ${session.connectionName}`,
      `State: ${done ? 'not running / no longer visible' : state || 'unknown'}`,
      `Elapsed: ${seconds(querySecs)}`,
      `Statement: ${query || '(unavailable)'}`,
      ...operationNotes.map(note => `Note: ${note}`),
    ];
    if (other) {
      lines.push(`${done ? 'Final observed' : 'Current'} phase: ${other.phase || 'not reported'}`);
      lines.push(`${done ? 'Last observed' : 'Current'} progress: ${other.pct === null ? 'no server estimate' : `${other.pct.toFixed(1)}%`}`);
      if (other.detail) lines.push(other.detail);
      lines.push(...other.diagnostics);
    }
    if (snapshot) {
      if (done) lines.push(mysqlCompletionLine(snapshot));
      if (snapshot.native && snapshot.native.maxStage > 0) {
        lines.push(`MariaDB native stage ${snapshot.native.stage}/${snapshot.native.maxStage} · `
          + `${snapshot.native.stagePct?.toFixed(1) ?? '—'}% of stage · `
          + `${snapshot.native.totalPct?.toFixed(1) ?? '—'}% overall`);
      }
      for (const stage of snapshot.stages.filter(item => item.eventId > 0)) {
        lines.push(`${stage.phase} · ${stage.status} · ${stage.pct === null ? '—' : `${stage.pct.toFixed(1)}%`}`);
      }
    }
    for (const job of cloudJobs ?? []) lines.push(cloudSqlReplicaIndexJobLine(job));
    if (completionLine) lines.push(completionLine);
    void navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

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
                <button className="toolbar-btn" onClick={copyDiagnostics}>{copied ? 'Copied!' : 'Copy diagnostics'}</button>
                <button className="toolbar-btn" disabled={!query}
                  onClick={() => void navigator.clipboard.writeText(query)}>Copy</button>
              </div>
              <pre className="tpd-query">{query || '(statement text is unavailable to this account)'}</pre>
              {operationNotes.length > 0 && (
                <div className="tpd-note">
                  {operationNotes.map(note => <div key={note}>{note}</div>)}
                </div>
              )}
              {completionLine && (
                <div className="tpd-completion" role="status">
                  <strong>Completed — final observed statistics</strong>
                  <div>{completionLine}</div>
                  <span>This line was also written to the session log.</span>
                </div>
              )}
            </>
          )}

          {snapshot?.native && snapshot.native.maxStage > 0 && (
            <div className="tpd-stage">
              <div className="tpd-stage-head">
                <strong>MariaDB native stage {snapshot.native.stage} of {snapshot.native.maxStage}</strong>
              </div>
              <div className="tpd-track">
                <div className={`tpd-fill${snapshot.native.totalPct === null ? ' tpd-indeterminate' : ''}`}
                  style={snapshot.native.totalPct === null ? undefined
                    : { width: `${Math.max(0, Math.min(100, snapshot.native.totalPct))}%` }} />
              </div>
              <div className="tpd-stage-numbers">
                <span>{snapshot.native.totalPct === null ? 'no server estimate'
                  : `${snapshot.native.totalPct.toFixed(1)}% overall`}</span>
                <span>{snapshot.native.stagePct === null ? 'no stage estimate'
                  : `${snapshot.native.stagePct.toFixed(1)}% of current stage`} · information_schema.PROCESSLIST</span>
              </div>
              {setupError && <div className="tpd-note">Optional Performance Schema detail unavailable: {setupError}</div>}
            </div>
          )}

          {snapshot && snapshot.stages.length > 0 && (
            <div className="tpd-table-wrap">
              <div className="tpd-operation">
                {ddlKind(snapshot.query) === 'create-index' ? 'CREATE INDEX'
                  : ddlKind(snapshot.query) === 'alter-table' ? 'ALTER TABLE'
                    : ddlKind(snapshot.query) === 'maintenance' ? 'Table maintenance' : 'Statement'} — Performance Schema stages
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

          {cloudJobs && (
            <div className="tpd-table-wrap">
              <div className="tpd-operation">Cloud SQL managed replica indexes</div>
              {cloudJobs.length === 0 && <div className="tpd-note">No managed replica-index jobs are recorded on this instance.</div>}
              {cloudJobs.length > 0 && (
                <table className="tpd-phase-table">
                  <thead><tr><th>Index</th><th>Action</th><th>Status</th><th>Thread</th><th>Retries</th><th>Started / ended</th><th>Error</th></tr></thead>
                  <tbody>
                    {cloudJobs.map(job => (
                      <tr key={`${job.idxId}-${job.action}-${job.startTime}`} className={`tpd-phase-${job.status === 'RUNNING' ? 'running' : job.status === 'DONE' ? 'done' : job.status === 'FAILED' ? 'skipped' : 'pending'}`}>
                        <td className="tpd-phase-name" title={job.createStmt}>#{job.idxId}</td>
                        <td>{job.action}</td>
                        <td><span className={`tpd-status tpd-status-${job.status === 'RUNNING' ? 'running' : job.status === 'DONE' ? 'done' : job.status === 'FAILED' ? 'skipped' : 'pending'}`}>{job.status}</span></td>
                        <td>{job.threadId ?? '—'}</td>
                        <td>{job.retryCount}</td>
                        <td title={job.endTime ?? job.startTime}>{job.endTime ?? job.startTime}</td>
                        <td title={job.error ?? job.commentTag}>{job.error ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {other && (
            <>
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
              {other.diagnostics.length > 0 && (
                <div className="tpd-metadata">
                  {other.diagnostics.map(item => <span key={item}>{item}</span>)}
                </div>
              )}
            </>
          )}

          {isMysql && snapshot && !snapshot.stages.some(stage => stage.eventId > 0)
            && !(snapshot.native && snapshot.native.maxStage > 0) && (
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
