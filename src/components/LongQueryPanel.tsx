/**
 * Long-running query watcher (⏱). A narrow full-feature editor on the left;
 * on Run, the statement executes on a dedicated server connection whose thread
 * id we capture, while the right pane polls the processlist / performance_schema
 * for that thread's live PHASE (State / current stage) and a progress % —
 * exact when the stage reports work_completed/estimated, heuristic otherwise.
 *
 * Pinned mode: opened from Processes' "watch this thread" with a thread id
 * that was started ELSEWHERE (`pinnedThread`). The same poll follows that
 * foreign thread read-only — no editor, no Run, no KILL (kill stays in
 * Processes, where it is audited) — until the thread vanishes from the
 * processlist, which for a pinned thread is the finished signal. The
 * statement kind (which decides WHERE PostgreSQL progress lives) is read off
 * the processlist row's own text, since there is no editor SQL to parse.
 */
import { errorDisplay } from '../utils/appError';
import { ddlKind, progressProbe, MYSQL_STAGE_SETUP } from '../utils/ddlProgress';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { clearTabActivities, panelTabKey, setActivity } from '../store/tabActivity';
import { usePoll } from '../hooks/usePoll';
import { addLog as addSessionLog } from '../store/logStore';
import { executeKill, partialProc } from '../utils/killExec';
import { truncateSql, updateWatchList } from '../utils/longQuery';
import type { WatchEntry, WatchRow } from '../utils/longQuery';
import { shortcuts } from '../utils/platform';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

const SqlEditor = lazy(() => import('./SqlEditor').then(m => ({ default: m.SqlEditor })));

type WatchEvent =
  | { type: 'started'; thread_id: number }
  | { type: 'done'; rows: number; ms: number; ok: boolean; error: string | null; cancelled: boolean };

interface LogLine { t: string; msg: string; level: 'info' | 'ok' | 'err' | 'phase' | 'warn' }
interface ProcRow { id: number; time: number; state: string; info: string }
interface Watched { threadId: number; startedMs: number; state: string; stage: string; pct: number | null; done: boolean; }
interface ExplainOut { id: number; text: string; error: string | null }

interface Props {
  session: Session;
  /** Pin the watcher to a thread started elsewhere (Processes' "watch this
      thread") — read-only; null/undefined is the normal editor + Run flow. */
  pinnedThread?: number | null;
  onUnpin?: () => void;
  onClose: () => void;
}

const now = () => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

export function LongQueryPanel({ session, pinnedThread, onUnpin, onClose }: Props) {
  const isMysql = session.engine === 'mysql';
  const isMssql = session.engine === 'sqlserver';
  const [sql, setSql] = useState('');
  /** The "instruments are off" hint is worth saying once, not every poll. */
  const stageHintRef = useRef(false);
  const sqlRef = useRef('');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);           // seconds, live
  const [log, setLog] = useState<LogLine[]>([]);
  const [procs, setProcs] = useState<ProcRow[]>([]);
  const [watched, setWatched] = useState<Watched | null>(null);
  const [interval, setIntervalSec] = useState(1);
  // ── Watchdog ("Watch server"): full-processlist long-query detection ──────
  const [watchMode, setWatchMode] = useState(false);
  const [watchThreshold, setWatchThreshold] = useState(60);
  const [watchEntries, setWatchEntries] = useState<WatchEntry[]>([]);
  const [flash, setFlash] = useState(false);           // new detection pulse
  const [explain, setExplain] = useState<ExplainOut | null>(null);
  const watchRef = useRef<WatchEntry[]>([]);           // poll-loop source of truth
  const runKeyRef = useRef<string | null>(null);
  const startRef = useRef(0);
  const watchedIdRef = useRef<number | null>(null);
  // A hidden tab polls nothing (store/tabVisibility).

  // ── Pinned thread ("watch this thread" from Processes) ───────────────────
  // A statement started ELSEWHERE: no editor, no Run, no KILL — the same
  // phase/progress poll follows the foreign thread read-only. The prop is
  // adopted React's sanctioned way (adjust-state-during-render), so a pin
  // arriving at an already-mounted panel takes effect on that render.
  const [pin, setPin] = useState<number | null>(pinnedThread ?? null);
  const [seenPin, setSeenPin] = useState<number | null | undefined>(pinnedThread);
  if (pinnedThread !== seenPin) {
    setSeenPin(pinnedThread);
    setPin(pinnedThread ?? null);
  }
  /** "thread finished" is logged once per pin, not on every poll tick. */
  const pinDoneLoggedRef = useRef(false);
  useEffect(() => {
    if (pin == null) return;
    watchedIdRef.current = pin;
    startRef.current = Date.now();
    pinDoneLoggedRef.current = false;
    setWatched({ threadId: pin, startedMs: Date.now(), state: '', stage: '', pct: null, done: false });
    addLog('info', `watching thread ${pin} — started elsewhere, read-only`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const unpin = useCallback(() => {
    watchedIdRef.current = null;
    setWatched(null);
    setPin(null);
    setSeenPin(null);
    onUnpin?.();
  }, [onUnpin]);

  const addLog = useCallback((level: LogLine['level'], msg: string) =>
    setLog(prev => [...prev.slice(-499), { t: now(), msg, level }]), []);

  // A watched statement keeps executing on the server without this panel, so
  // the close-guard needs to know — and needs a way to KILL it.
  const activityKey = panelTabKey(session.sessionId, 'watch');
  useEffect(() => {
    if (!running) { clearTabActivities(activityKey); return; }
    setActivity(activityKey, {
      id: 'watched',
      label: `Watched statement running · ${elapsed.toFixed(0)}s`,
      detail: sqlRef.current.replace(/\s+/g, ' ').trim().slice(0, 400) || '(statement)',
      threads: watchedIdRef.current ? [watchedIdRef.current] : undefined,
      survives: true,
      kill: () => {
        if (runKeyRef.current) invoke('cancel_watched', { runKey: runKeyRef.current }).catch(() => {});
      },
    });
    // `elapsed` ticks 5×/s — the label only needs whole seconds, so round it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityKey, running, Math.floor(elapsed)]);

  // Live elapsed timer while running (or while a pinned thread is followed —
  // it stops when the thread is done, since nothing moves after that).
  useEffect(() => {
    if ((!running && pin == null) || watched?.done) return;
    const t = setInterval(() => setElapsed((Date.now() - startRef.current) / 1000), 200);
    return () => clearInterval(t);
  }, [running, pin, watched?.done]);

  // Poll the processlist (current user) + the watched thread's phase/progress.
  const watchedActive = watched != null;
  const pollMain = useCallback(async () => {
      try {
        if (isMysql) {
          const list = await invoke<QueryResult>('monitor_query', {
            sessionId: session.sessionId,
            sql: `SELECT ID, TIME, IFNULL(STATE,''), LEFT(IFNULL(INFO,''),160)
                  FROM information_schema.PROCESSLIST
                  WHERE USER = SUBSTRING_INDEX(CURRENT_USER(),'@',1)
                  ORDER BY TIME DESC LIMIT 50`,
          });
          setProcs(list.rows.map(r => ({ id: Number(r[0]), time: Number(r[1]), state: String(r[2]), info: String(r[3]) })));
          const tid = watchedIdRef.current;
          if (tid != null) {
            // phase + progress for our thread from performance_schema stages
            const ph = await invoke<QueryResult>('monitor_query', {
              sessionId: session.sessionId,
              sql: `SELECT IFNULL(p.STATE,''), IFNULL(s.EVENT_NAME,''),
                           IFNULL(s.WORK_COMPLETED,-1), IFNULL(s.WORK_ESTIMATED,-1)
                    FROM information_schema.PROCESSLIST p
                    LEFT JOIN performance_schema.threads t ON t.PROCESSLIST_ID = p.ID
                    LEFT JOIN performance_schema.events_stages_current s ON s.THREAD_ID = t.THREAD_ID
                    WHERE p.ID = ${tid}`,
            }).catch(() => null);
            if (ph && ph.rows[0]) {
              const [st, stage, wc, we] = ph.rows[0];
              const wcN = Number(wc), weN = Number(we);
              const pct = weN > 0 ? Math.min(100, Math.round((wcN / weN) * 100)) : null;
              const stageName = String(stage).replace(/^stage\//, '');
              setWatched(w => w && { ...w, state: String(st), stage: stageName, pct });
              if (String(st)) addLog('phase', `phase: ${String(st)}${stageName ? ` · ${stageName}` : ''}${pct != null ? ` · ${pct}%` : ''}`);
              // A DDL statement with no stage is almost never a stall: the
              // instruments are OFF by default, so the panel would otherwise
              // show a blank phase and look like the server had gone quiet.
              // Said once per watch, with the runtime fix. A pinned thread has
              // no editor SQL — its kind is read off its own processlist text.
              const stmtText = pin != null
                ? String(list.rows.find(r => Number(r[0]) === tid)?.[3] ?? '')
                : sqlRef.current;
              if (!stageName && ddlKind(stmtText) !== 'other' && !stageHintRef.current) {
                stageHintRef.current = true;
                addLog('warn', 'No DDL stage reported. MySQL keeps those instruments OFF by '
                  + 'default — enable them (no restart needed) and re-run:');
                for (const fix of MYSQL_STAGE_SETUP) addLog('info', fix.replace(/\n/g, ' '));
              }
            } else if (pin != null && ph) {
              // A pinned thread has no Done event — vanishing from the
              // processlist IS the finished signal.
              setWatched(w => (w && !w.done ? { ...w, done: true } : w));
              if (!pinDoneLoggedRef.current) {
                pinDoneLoggedRef.current = true;
                addLog('ok', `thread ${tid} finished`);
              }
            }
          }
        } else if (isMssql) {
          // This engine's own requests, for the "what am I running" list.
          // `percent_complete` is populated only for the operations SQL Server
          // tracks (backup/restore, index rebuilds, DBCC) — 0 everywhere else,
          // which is reported as "no percentage" rather than as 0%: a progress
          // bar stuck at zero reads as a stall, which is the opposite of true.
          const list = await invoke<QueryResult>('monitor_query', {
            sessionId: session.sessionId,
            sql: `SELECT TOP 50 r.session_id, r.total_elapsed_time / 1000,
                         ISNULL(r.status, ''),
                         LEFT(ISNULL(t.text, ''), 160),
                         r.percent_complete
                  FROM sys.dm_exec_requests r
                  JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
                  OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
                  WHERE s.is_user_process = 1 AND s.login_name = SUSER_SNAME()
                  ORDER BY r.total_elapsed_time DESC`,
          });
          setProcs(list.rows.map(r => ({
            id: Number(r[0]), time: Number(r[1]), state: String(r[2]), info: String(r[3]),
          })));
          const tid = watchedIdRef.current;
          if (tid != null) {
            const mine = list.rows.find(r => Number(r[0]) === tid);
            if (mine) {
              const pctN = Number(mine[4]);
              setWatched(w => w && {
                ...w,
                state: String(mine[2]),
                stage: '',
                pct: Number.isFinite(pctN) && pctN > 0 ? Math.round(pctN) : null,
              });
            } else if (pin != null) {
              // A pinned thread has no Done event — vanishing from the request
              // list IS the finished signal.
              setWatched(w => (w && !w.done ? { ...w, done: true } : w));
              if (!pinDoneLoggedRef.current) {
                pinDoneLoggedRef.current = true;
                addLog('ok', `thread ${tid} finished`);
              }
            }
          }
        } else {
          const list = await invoke<QueryResult>('monitor_query', {
            sessionId: session.sessionId,
            sql: `SELECT pid, EXTRACT(EPOCH FROM (now()-query_start))::int, state, LEFT(query,160)
                  FROM pg_stat_activity WHERE usename = current_user AND state IS DISTINCT FROM 'idle'
                  ORDER BY query_start LIMIT 50`,
          });
          setProcs(list.rows.map(r => ({ id: Number(r[0]), time: Number(r[1]), state: String(r[2]), info: String(r[3]) })));
          const tid = watchedIdRef.current;
          if (tid != null) {
            const mine = list.rows.find(r => Number(r[0]) === tid);
            if (mine) setWatched(w => w && { ...w, state: String(mine[2]), stage: '', pct: null });
            if (!mine && pin != null) {
              // A pinned thread has no Done event — vanishing from
              // pg_stat_activity IS the finished signal.
              setWatched(w => (w && !w.done ? { ...w, done: true } : w));
              if (!pinDoneLoggedRef.current) {
                pinDoneLoggedRef.current = true;
                addLog('ok', `thread ${tid} finished`);
              }
            }

            // PostgreSQL publishes real phases for the two operations that
            // take long enough to need them — index builds and table
            // rewrites — in dedicated views this panel never read. Without
            // this, a twenty-minute CREATE INDEX CONCURRENTLY showed
            // "active" and nothing else. A pinned thread has no editor SQL —
            // its kind is read off its own pg_stat_activity query text.
            const probe = progressProbe('postgres',
              ddlKind(pin != null ? String(mine?.[3] ?? '') : sqlRef.current), tid);
            if (probe.sql) {
              const pr = await invoke<QueryResult>('monitor_query', {
                sessionId: session.sessionId, sql: probe.sql,
              }).catch(() => null);
              if (pr?.rows[0]) {
                const [phase, pct, locker] = pr.rows[0];
                const pctN = pct == null ? null : Number(pct);
                setWatched(w => w && {
                  ...w,
                  stage: String(phase ?? ''),
                  pct: Number.isFinite(pctN as number) ? (pctN as number) : null,
                });
                if (phase) {
                  addLog('phase', `phase: ${String(phase)}`
                    + (pctN != null ? ` · ${pctN}%` : '')
                    // The answer to "why is CONCURRENTLY not moving": it is
                    // waiting for one specific older transaction to end.
                    + (locker != null && String(locker) !== '' ? ` · waiting on pid ${locker}` : ''));
                }
              }
            }
          }
        }
      } catch { /* best-effort polling */ }
  }, [session.sessionId, isMysql, isMssql, pin, addLog]);
  // Loop + in-flight guard via hooks/usePoll: each tick awaits 2–3 sequential
  // monitor_query calls, and on a slow/locked server — exactly when this
  // watchdog matters — the unguarded copy stacked unbounded concurrent
  // processlist queries. Hidden tab: the statement runs on, we stop watching.
  usePoll(pollMain, Math.max(0.5, interval), {
    immediate: running || watchedActive,
    paused: !(running || watchedActive),
  });

  // ── Watchdog poll: FULL processlist (all users), fold into the detected list.
  // Same visibility gate + interval selector as the per-query poll above;
  // closing/hiding the panel stops the traffic (watchRef keeps the history).
  const pollWatch = useCallback(async () => {
      try {
        // Seven columns, same order on every engine, because the mapping
        // below reads them positionally:
        //   id · user · host · db · seconds · state · sql
        const sql = isMysql
          ? `SELECT ID, IFNULL(USER,''), IFNULL(HOST,''), IFNULL(DB,''),
                    TIME, IFNULL(STATE,''), IFNULL(INFO,'')
             FROM information_schema.PROCESSLIST
             WHERE INFO IS NOT NULL
             ORDER BY TIME DESC LIMIT 200`
          : isMssql
          // `total_elapsed_time` is milliseconds, hence the /1000 — the other
          // two engines report seconds, and a watcher that thinks 3 seconds is
          // 3000 would fire its threshold on everything.
          //
          // `is_user_process = 1` drops the ~15 background tasks SQL Server
          // always has running (CHECKPOINT, ghost cleanup, the broker); without
          // it the watch list is permanent noise nobody can act on. The
          // statement is sliced out of the batch by offset, as in the Locks
          // panel, so a long script shows the statement rather than the script.
          ? `SELECT TOP 200
                    r.session_id,
                    ISNULL(s.login_name, ''),
                    ISNULL(c.client_net_address, ''),
                    ISNULL(DB_NAME(r.database_id), ''),
                    r.total_elapsed_time / 1000,
                    ISNULL(r.status, ''),
                    ISNULL(SUBSTRING(t.text, (r.statement_start_offset/2)+1,
                        ((CASE r.statement_end_offset WHEN -1
                              THEN DATALENGTH(t.text) ELSE r.statement_end_offset END
                          - r.statement_start_offset)/2)+1), '')
             FROM sys.dm_exec_requests r
             JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
             LEFT JOIN sys.dm_exec_connections c ON c.session_id = r.session_id
             OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
             WHERE r.session_id <> @@SPID AND s.is_user_process = 1
             ORDER BY r.total_elapsed_time DESC`
          : `SELECT pid, COALESCE(usename,''), COALESCE(client_addr::text,''),
                    COALESCE(datname,''),
                    COALESCE(EXTRACT(EPOCH FROM (now()-query_start))::int, 0),
                    state, query
             FROM pg_stat_activity
             WHERE state = 'active' AND pid <> pg_backend_pid()
             ORDER BY query_start LIMIT 200`;
        const list = await invoke<QueryResult>('monitor_query', {
          sessionId: session.sessionId, sql,
        });
        const rows: WatchRow[] = list.rows.map(r => ({
          id: Number(r[0]), user: String(r[1]), host: String(r[2]), db: String(r[3]),
          time: Number(r[4]), state: String(r[5]), sql: String(r[6] ?? ''),
        }));
        const { entries, newOnes } = updateWatchList(watchRef.current, rows, watchThreshold, Date.now());
        watchRef.current = entries;
        setWatchEntries(entries);
        for (const n of newOnes) {
          const who = `${n.user}@${n.host}${n.db ? `/${n.db}` : ''}`;
          const one = truncateSql(n.sql, 120);
          addLog('warn', `⚠ long query: ${n.age}s — ${who} — ${one}`);
          addSessionLog(session.sessionId, {
            level: 'warn', action: 'WATCH',
            detail: `long query detected: ${n.age}s — ${who} — ${one}`,
            line: `long query detected: ${n.age}s — ${who} — ${one}`,
          });
        }
        if (newOnes.length > 0) {
          setFlash(true);
          setTimeout(() => setFlash(false), 1800);
        }
      } catch { /* best-effort polling */ }
  }, [watchThreshold, session.sessionId, isMysql, isMssql, addLog]);
  usePoll(pollWatch, Math.max(0.5, interval), { immediate: watchMode, paused: !watchMode });

  /** KILL QUERY / pg_cancel_backend via the one audited kill path. */
  const killEntry = useCallback(async (e: WatchEntry) => {
    try {
      const [outcome] = await executeKill({
        sessionId: session.sessionId, ids: [e.id], mode: 'query',
        source: 'Watchdog',
        procs: [partialProc({
          id: e.id, user: e.user, host: e.host, db: e.db,
          time: e.age, state: e.state, info: e.sql,
        })],
        connectionName: session.connectionName, engine: session.engine,
      });
      if (outcome && !outcome.ok) addLog('err', `kill #${e.id} failed — ${outcome.error ?? ''}`);
      else addLog('ok', `killed #${e.id} (${e.age}s)`);
    } catch (err) {
      addLog('err', `kill #${e.id} — ${errorDisplay(err)}`);
    }
  }, [session.sessionId, session.connectionName, session.engine, addLog]);

  /**
   * EXPLAIN the captured statement via the write-guarded monitor path.
   * Plain EXPLAIN only — never EXPLAIN ANALYZE (that would EXECUTE it).
   */
  const explainEntry = useCallback(async (e: WatchEntry) => {
    // SQL Server has no EXPLAIN. Its plan comes from SET SHOWPLAN_XML, which
    // needs session state and returns XML — plan-sqlserver.md Phase 5. Falling
    // through to the PostgreSQL prefix would send `EXPLAIN (COSTS ON) …` to a
    // T-SQL parser and surface a syntax error that says nothing useful.
    if (isMssql) {
      addLog('warn', 'EXPLAIN is not available on SQL Server yet — its plan needs '
        + 'SET SHOWPLAN_XML, which is not wired.');
      return;
    }
    const prefix = isMysql ? 'EXPLAIN ' : 'EXPLAIN (COSTS ON) ';
    addLog('info', `explain #${e.id}…`);
    try {
      const r = await invoke<QueryResult>('monitor_query', {
        sessionId: session.sessionId, sql: prefix + e.sql,
      });
      const head = r.columns.map(c => c.name).join(' | ');
      const body = r.rows
        .map(row => row.map(v => (v === null || v === undefined ? 'NULL' : String(v))).join(' | '))
        .join('\n');
      setExplain({ id: e.id, text: `${head}\n${body}`, error: null });
      addLog('ok', `explain #${e.id} — ${r.rows.length} plan rows`);
    } catch (err) {
      setExplain({ id: e.id, text: '', error: errorDisplay(err) });
      addLog('err', `explain #${e.id} — ${errorDisplay(err)}`);
    }
  }, [isMysql, isMssql, session.sessionId, addLog]);

  const clearFinished = useCallback(() => {
    watchRef.current = watchRef.current.filter(e => !e.gone);
    setWatchEntries(watchRef.current);
  }, []);

  const run = useCallback(async () => {
    const q = sqlRef.current.trim();
    if (!q || running) return;
    const runKey = crypto.randomUUID();
    runKeyRef.current = runKey;
    startRef.current = Date.now();
    setElapsed(0);
    setRunning(true);
    setWatched(null);
    watchedIdRef.current = null;
    addLog('info', `▶ started`);
    const chan = new Channel<WatchEvent>();
    chan.onmessage = ev => {
      if (ev.type === 'started') {
        watchedIdRef.current = ev.thread_id;
        setWatched({ threadId: ev.thread_id, startedMs: Date.now(), state: '', stage: '', pct: null, done: false });
        addLog('info', `thread id ${ev.thread_id}`);
      } else {
        setRunning(false);
        watchedIdRef.current = null;
        const secs = (ev.ms / 1000).toFixed(1);
        if (ev.cancelled) addLog('err', `■ cancelled after ${secs}s`);
        else if (ev.ok) addLog('ok', `✓ finished in ${secs}s · ${ev.rows.toLocaleString()} rows`);
        else addLog('err', `✗ failed after ${secs}s — ${ev.error ?? ''}`);
        setWatched(w => w && { ...w, done: true });
      }
    };
    try {
      await invoke('run_watched', { sessionId: session.sessionId, sql: q, runKey, onEvent: chan });
    } catch (e) {
      setRunning(false);
      addLog('err', `✗ ${errorDisplay(e)}`);
    }
  }, [running, session.sessionId, addLog]);

  const cancel = useCallback(() => {
    if (runKeyRef.current) invoke('cancel_watched', { runKey: runKeyRef.current }).catch(() => {});
  }, []);

  return (
    <div className="lq-root">
      <div className="lq-bar">
        <span className="proc-title">
          {pin != null
            ? `⏱ Watch — thread ${pin} · started elsewhere, read-only`
            : `⏱ Long-running query — ${session.connectionName}`}
        </span>
        <div style={{ flex: 1 }} />
        <label className="lq-int">refresh
          <select value={interval} onChange={e => setIntervalSec(Number(e.target.value))}>
            {[0.5, 1, 2, 5].map(n => <option key={n} value={n}>{n}s</option>)}
          </select>
        </label>
        {pin == null && (
          <button
            className={`toolbar-btn lq-watch-toggle${watchMode ? ' lq-watch-on' : ''}${flash ? ' lq-watch-new' : ''}`}
            title="Watch the FULL processlist (all users) for queries older than the threshold — detect, KILL, EXPLAIN"
            onClick={() => setWatchMode(v => !v)}
          >👁 Watch{watchMode && watchEntries.some(e => !e.gone) ? ` (${watchEntries.filter(e => !e.gone).length})` : ''}</button>
        )}
        {pin == null && watchMode && (
          <label className="lq-int" title="Detection threshold (seconds)">≥
            <input
              type="number" min={1} max={86400} value={watchThreshold}
              onChange={e => setWatchThreshold(Math.max(1, Number(e.target.value) || 1))}
            />s
          </label>
        )}
        {pin != null ? (
          <button className="toolbar-btn" onClick={unpin}
            title="Stop watching — the thread itself keeps running; kill stays in Processes, where it is audited"
          >✕ Unpin</button>
        ) : running
          ? <button className="toolbar-btn lq-cancel" onClick={cancel}>■ Cancel (KILL)</button>
          : <button className="run-btn run-btn-go" disabled={!sql.trim()} onClick={run}><span className="run-play">▶</span> Run</button>}
        <button className="icon-btn" title="Close" onClick={onClose}>×</button>
      </div>

      <div className="lq-body">
        {pin == null && (
        <div className="lq-editor">
          <Suspense fallback={null}>
            <SqlEditor
              engine={session.engine}
              initialValue=""
              // No minimap: this is a field for one statement in a pane a few
              // lines tall, not a document. The strip maps nothing and costs
              // width the progress readout needs.
              minimap={false}
              schemaCompletions={[]}
              onRun={() => run()}
              onChange={v => { setSql(v); sqlRef.current = v; }}
              placeholder={`A long-running SELECT / ALTER / UPDATE …\n${SC.run} to run`}
            />
          </Suspense>
        </div>
        )}

        <div className="lq-side">
          {pin != null && (
            <div className="lq-pin-banner">
              thread {pin} — started elsewhere; watching read-only.
              No KILL here: kill stays in Processes, where it is audited.
            </div>
          )}
          <div className="lq-progress">
            <div className="lq-elapsed">{elapsed.toFixed(1)}s</div>
            {watched && (
              <>
                <div className="lq-phase">{watched.done ? 'done' : (watched.state || 'running…')}{watched.stage ? ` · ${watched.stage}` : ''}</div>
                <div className="lq-pct-track">
                  <div className={`lq-pct-fill ${watched.pct == null ? 'lq-pct-indet' : ''}`}
                    style={watched.pct != null ? { width: `${watched.pct}%` } : undefined} />
                </div>
                <div className="lq-pct-label">{watched.pct != null ? `${watched.pct}% (server estimate)` : 'no server estimate — indeterminate'}</div>
              </>
            )}
          </div>

          {watchMode && (
            <>
              <div className="lq-watch-head">
                <span>Watchdog · ≥{watchThreshold}s ({watchEntries.filter(e => !e.gone).length} live)</span>
                <div style={{ flex: 1 }} />
                <button
                  className="toolbar-btn lq-watch-clear"
                  disabled={!watchEntries.some(e => e.gone)}
                  title="Remove finished entries"
                  onClick={clearFinished}
                >Clear finished</button>
              </div>
              <div className="lq-watch-list">
                {watchEntries.length === 0 && <div className="mx-empty">No long queries detected.</div>}
                {watchEntries.map(e => (
                  <div key={e.id} className={`lq-watch${e.gone ? ' lq-watch-gone' : ''}`}>
                    <div className="lq-watch-row">
                      <span className="lq-watch-age">{e.age}s</span>
                      <span className="lq-watch-who" title={`${e.user}@${e.host}${e.db ? ` · ${e.db}` : ''}`}>
                        {e.user}@{e.host}{e.db ? ` · ${e.db}` : ''}
                      </span>
                      <span className="lq-watch-state">{e.gone ? 'finished' : (e.state || '—')}</span>
                      <div style={{ flex: 1 }} />
                      <button
                        className="toolbar-btn lq-watch-kill"
                        disabled={e.gone}
                        title="KILL QUERY / pg_cancel_backend (audited)"
                        onClick={() => killEntry(e)}
                      >Kill</button>
                      <button
                        className="toolbar-btn"
                        disabled={e.gone || !e.sql.trim()}
                        title={isMysql ? 'EXPLAIN (plain — never ANALYZE)' : 'EXPLAIN (COSTS ON) — never ANALYZE'}
                        onClick={() => explainEntry(e)}
                      >Explain</button>
                      <button
                        className="toolbar-btn"
                        title="Copy full statement"
                        onClick={() => navigator.clipboard.writeText(e.sql).catch(() => {})}
                      >Copy</button>
                    </div>
                    <code className="lq-watch-sql" title={e.sql}>{truncateSql(e.sql)}</code>
                  </div>
                ))}
              </div>
              {explain && (
                <div className="lq-explain-wrap">
                  <div className="lq-watch-head">
                    <span>EXPLAIN #{explain.id}</span>
                    <div style={{ flex: 1 }} />
                    <button className="icon-btn" title="Close" onClick={() => setExplain(null)}>×</button>
                  </div>
                  {explain.error
                    ? <div className="lq-explain-err">{explain.error}</div>
                    : <pre className="lq-explain">{explain.text}</pre>}
                </div>
              )}
            </>
          )}

          <div className="lq-proc-head">Processlist · you ({procs.length})</div>
          <div className="lq-proc-list">
            {procs.length === 0 && <div className="mx-empty">No active queries.</div>}
            {procs.map(p => (
              <div key={p.id} className={`lq-proc ${p.id === watched?.threadId ? 'lq-proc-mine' : ''}`}>
                <span className="lq-proc-id">#{p.id}</span>
                <span className="lq-proc-time">{p.time}s</span>
                <span className="lq-proc-state">{p.state || '—'}</span>
                <code className="lq-proc-info" title={p.info}>{p.info}</code>
              </div>
            ))}
          </div>

          <div className="lq-log-head">Log</div>
          <div className="lq-log">
            {log.map((l, i) => (
              <div key={i} className={`lq-log-line lq-log-${l.level}`}>
                <span className="sl-ts">{l.t}</span> {l.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
