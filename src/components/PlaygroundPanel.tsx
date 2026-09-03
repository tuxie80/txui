/**
 * 🎪 Playground — a scenario generator for the DBA tools.
 *
 * The tools that matter most (⚡ Processes, 🔒 Locks, and the `kill …` /
 * `killall` popup) are exactly the ones you cannot practise with: a healthy
 * server has nothing to look at, and a sick one is a bad time to learn. The
 * Playground manufactures the situation on purpose.
 *
 * Scenario #1 — **spawn mess**: N real connections, each holding a real server
 * thread, running a recognizable statement; optionally piling up on one row so
 * a genuine blocking chain forms. Fully parameterized (threads, duration,
 * overlap, repeats, jitter) and stoppable.
 *
 * **The spawned threads outlive this panel.** They are real server state, so
 * closing the tab, switching tabs or un-clicking the 🎪 icon leaves them
 * running — that is the whole point, you are supposed to go and kill them
 * yourself. The run lives in `store/playgroundRuns.ts`; only **Stop** (or
 * disconnecting the session) ends it.
 *
 * Everything it runs carries a `txui-playground <tag> …` block comment, so the
 * mess is always identifiable, and the panel prints the statement shapes before
 * you press Spawn.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import type { Session } from '../types';
import { addLog } from '../store/logStore';
import {
  addRunLog, addWorker, clearRun, finishRun, startRun, stopRun, updateWorker, usePlaygroundRun,
} from '../store/playgroundRuns';
import { clearTabActivities, panelTabKey, setActivity } from '../store/tabActivity';

type MessEvent =
  | { type: 'spawned'; slot: number; thread_id: number; role: string; sql: string }
  | { type: 'ended'; slot: number; thread_id: number; ms: number; ok: boolean; error: string | null }
  | { type: 'log'; level: string; msg: string }
  | { type: 'done'; spawned: number; ms: number; cancelled: boolean };

interface Props {
  session: Session;
  onClose: () => void;
}

type ScenarioId = 'sleep' | 'lock' | 'mixed';

interface Scenario {
  id: ScenarioId;
  icon: string;
  name: string;
  what: string;
  then: string;
  writes: boolean;
}

/**
 * Smallest thread count each scenario can express — mirrors `min_threads()` in
 * commands/playground.rs. `threads` is the EXACT number of server threads the
 * run will hold: no scenario adds any behind your back.
 */
const MIN_THREADS: Record<ScenarioId, number> = { sleep: 1, lock: 2, mixed: 4 };

const SCENARIOS: Scenario[] = [
  {
    id: 'sleep', icon: '💤', name: 'Sleep mess',
    what: 'N connections all running the SAME long statement — one rogue family, ages fanned out by jitter.',
    then: 'Type `killall`: it should recognize one family, one user, all ageing, and pre-mark every member.',
    writes: false,
  },
  {
    id: 'lock', icon: '🔒', name: 'Lock storm',
    what: 'One holder takes a row lock inside a transaction and sits on it; the rest queue behind it, blocked.',
    then: 'Type `killall`: it should point at the BLOCKER (not the victims) — killing the queue would just retry.',
    writes: true,
  },
  {
    id: 'mixed', icon: '🎛', name: 'Mixed mayhem',
    what: 'A rogue family + benign short-query churn + a blocking chain, all at once — the realistic incident.',
    then: 'Type `killall`: the blocking chain outranks the family, and the churn must be left alone.',
    writes: true,
  },
];

export function PlaygroundPanel({ session, onClose }: Props) {
  const isPg = session.engine === 'postgres';
  const isMs = session.engine === 'sqlserver';
  const run = usePlaygroundRun(session.sessionId);
  const [scenario, setScenario] = useState<ScenarioId>(
    (run?.scenario as ScenarioId) ?? 'sleep');
  const [threads, setThreads] = useState(6);
  const [duration, setDuration] = useState(120);
  const [stagger, setStagger] = useState(400);
  const [repeats, setRepeats] = useState(1);
  const [jitter, setJitter] = useState(30);
  const [hold, setHold] = useState(120);
  const [database, setDatabase] = useState('txui_playground');
  const [tag, setTag] = useState('mess');

  const sc = SCENARIOS.find(s => s.id === scenario)!;
  const minThreads = MIN_THREADS[scenario];
  // Derived, not synced: switching scenario raises the effective count without a
  // state round-trip, and the number you SEE is the number of threads that will
  // exist — the preview, the input and the spec all use this one value.
  const threadCount = Math.max(threads, minThreads);

  // Tell the close-guard what is live here, so closing this tab asks first —
  // and so "Kill & close" knows exactly which threads it would take down.
  // Registered even while unmounted-and-remounted; only the run ending clears it.
  const key = panelTabKey(session.sessionId, 'playground');
  const liveRun = run?.running ? run : null;
  const liveThreadKey = (run?.workers ?? [])
    .filter(w => w.status === 'running' && w.threadId)
    .map(w => w.threadId).join(',');
  useEffect(() => {
    if (!liveRun) { clearTabActivities(key); return; }
    const threads = liveThreadKey ? liveThreadKey.split(',').map(Number) : [];
    setActivity(key, {
      id: 'spawn',
      label: `Spawned mess running · ${threads.length} live thread(s)`,
      detail: liveRun.summary,
      threads,
      survives: true,          // real server threads: they do not need this tab
      kill: () => stopRun(session.sessionId),
    });
  }, [key, liveRun, liveThreadKey, session.sessionId]);
  const blocked = sc.writes && session.readOnly;
  const running = run?.running ?? false;
  const workers = run?.workers ?? [];
  const log = run?.log ?? [];

  /** The statement shapes this configuration will produce (no surprises). */
  const preview = useMemo(() => {
    // T-SQL has no sleep FUNCTION — WAITFOR DELAY is a statement taking a time
    // string — so the rogue shape differs rather than just the function name.
    const hhmmss = (secs: number) => {
      const ms = Math.round(Math.max(0, secs) * 1000);
      const p2 = (n: number) => String(n).padStart(2, '0');
      return `${p2(Math.floor(ms / 3600000))}:${p2(Math.floor(ms / 60000) % 60)}`
        + `:${p2(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, '0')}`;
    };
    const sleep = isPg ? `pg_sleep(${duration.toFixed(2)})`
      : isMs ? `WAITFOR DELAY '${hhmmss(duration)}'`
      : `SLEEP(${duration.toFixed(2)})`;
    const t = isPg ? `"${database}"."txui_playground"`
      : isMs ? `[${database || 'dbo'}].[txui_playground]`
      : `\`${database}\`.\`txui_playground\``;
    const rogue = isMs
      ? `/* txui-playground ${tag} rogue slot=N */ ${sleep}`
      : `SELECT /* txui-playground ${tag} rogue slot=N */ ${sleep}`;
    const lines: string[] = [];
    if (scenario === 'sleep') {
      lines.push(`${threadCount}× ${rogue}${repeats > 1 ? `   (×${repeats} in a row)` : ''}`);
      if (jitter > 0) lines.push(`duration varies ±${jitter}% per worker, so their ages differ`);
    }
    if (scenario === 'lock') {
      lines.push(`composition: 1 holder + ${threadCount - 1} waiter(s) = ${threadCount} threads`);
    }
    if (scenario === 'mixed') {
      // same split as build_workers() in commands/playground.rs
      const chain = Math.max(2, Math.floor(threadCount / 4));
      const rest = threadCount - chain;
      const rogueN = Math.floor((rest * 2 + 2) / 3);
      lines.push(`composition: ${rogueN} rogue + ${rest - rogueN} churn + `
        + `1 holder + ${chain - 1} waiter(s) = ${threadCount} threads`);
    }
    if (scenario === 'lock' || scenario === 'mixed') {
      lines.push(isMs
        ? `holder:  BEGIN TRANSACTION → SELECT n FROM ${t} WITH (UPDLOCK, HOLDLOCK) WHERE id = 1`
          + ` → WAITFOR DELAY '${hhmmss(hold)}' → COMMIT`
        : `holder:  BEGIN → SELECT n FROM ${t} WHERE id = 1 FOR UPDATE → sleep ${hold}s → COMMIT`);
      lines.push(`waiters: UPDATE ${t} SET n = n + 1 WHERE id = 1   ← blocked until the holder commits`);
      lines.push(isPg
        ? 'waiters set lock_timeout = 0 so they keep waiting'
        : isMs
        ? 'waiters SET LOCK_TIMEOUT -1 so they queue rather than erroring out of the chain'
        : 'waiters set innodb_lock_wait_timeout = 600 so they outlive the 50s default');
    }
    if (scenario === 'mixed') {
      lines.unshift(`~50% of the workers: ${rogue}`);
      lines.push(`churn: short ${isPg ? 'pg_sleep' : isMs ? 'WAITFOR DELAY' : 'SLEEP'}`
        + `${isMs ? ` '${hhmmss(duration / 8)}'` : `(${(duration / 8).toFixed(2)})`}`
        + ' repeated — benign, must survive killall');
    }
    if (scenario !== 'sleep') {
      lines.push(`table ${t} is created if missing (2 columns, one row id=1) — the only thing written`);
    }
    return lines;
  }, [scenario, threadCount, duration, repeats, jitter, hold, database, tag, isPg, isMs]);

  const spawn = useCallback(async () => {
    if (running || blocked) return;
    const runKey = crypto.randomUUID();
    const sessionId = session.sessionId;
    // icon-slot-skip: one line of prose in the run banner, not a column of
    // labels — nothing lines up against it, so the icon can sit in the text.
    const summary = `${sc.icon} ${sc.name} · ${threadCount} worker(s) · ${duration}s · ${stagger}ms apart`
      + `${repeats > 1 ? ` · ×${repeats}` : ''}${jitter ? ` · ±${jitter}%` : ''}`
      + `${sc.writes ? ` · ${database} · hold ${hold}s` : ''} · tag=${tag}`;
    startRun(sessionId, { runKey, summary, scenario });
    addRunLog(sessionId, 'info', `▶ ${sc.name}: ${threadCount} worker(s), ${duration}s each, ${stagger}ms apart`);
    addLog(sessionId, {
      level: 'warn', action: 'PLAYGROUND',
      detail: `spawn mess · scenario=${scenario} threads=${threadCount} duration=${duration}s `
        + `stagger=${stagger}ms repeats=${repeats} jitter=${jitter}% `
        + `${sc.writes ? `db=${database} hold=${hold}s ` : ''}tag=${tag}`,
    });

    // The channel outlives this component on purpose: it writes into the store,
    // so a closed panel never loses (or kills) a running mess.
    const chan = new Channel<MessEvent>();
    chan.onmessage = ev => {
      if (ev.type === 'spawned') {
        addWorker(sessionId, {
          slot: ev.slot, role: ev.role, threadId: ev.thread_id, sql: ev.sql, status: 'running',
        });
        addRunLog(sessionId, 'ok', `slot ${ev.slot} (${ev.role}) → thread #${ev.thread_id}`);
      } else if (ev.type === 'ended') {
        updateWorker(sessionId, ev.slot, {
          status: ev.ok ? 'done' : 'failed', ms: ev.ms, error: ev.error,
        });
        if (!ev.ok) addRunLog(sessionId, 'err', `slot ${ev.slot} (#${ev.thread_id}): ${ev.error ?? 'failed'}`);
      } else if (ev.type === 'log') {
        addRunLog(sessionId, ev.level, ev.msg);
      } else {
        finishRun(sessionId);
        addRunLog(sessionId, ev.cancelled ? 'warn' : 'info',
          `${ev.cancelled ? '■ stopped' : '✓ finished'} — ${ev.spawned} thread(s) in ${(ev.ms / 1000).toFixed(1)}s`);
        addLog(sessionId, {
          level: ev.cancelled ? 'warn' : 'info', action: 'PLAYGROUND',
          detail: `${ev.cancelled ? 'stopped' : 'finished'} · ${ev.spawned} thread(s) · ${ev.ms}ms`,
          ms: ev.ms,
        });
      }
    };

    try {
      await invoke('playground_spawn', {
        sessionId,
        connectionId: session.connectionId,
        runKey,
        onEvent: chan,
        spec: {
          scenario, threads: threadCount, durationSecs: duration, staggerMs: stagger,
          repeats, jitterPct: jitter, holdSecs: hold,
          database: sc.writes ? database : null, tag,
        },
      });
    } catch (e) {
      finishRun(sessionId, errorDisplay(e));
      addRunLog(sessionId, 'err', errorDisplay(e));
      addLog(sessionId, { level: 'err', action: 'PLAYGROUND', detail: `spawn failed: ${errorDisplay(e)}` });
    }
  }, [running, blocked, sc, scenario, threadCount, duration, stagger, repeats, jitter, hold,
      database, tag, session.sessionId, session.connectionId]);

  const live = workers.filter(w => w.status === 'running').length;

  return (
    <div className="pg-root">
      <div className="pg-bar">
        <span className="proc-title">🎪 Playground — scenario generator</span>
        <span className="pg-conn">{session.connectionName} · {session.engine}</span>
        {session.environment && <span className={`env-chip env-${session.environment}`}>{session.environment.toUpperCase()}</span>}
        <div style={{ flex: 1 }} />
        {running
          ? <button className="toolbar-btn lq-cancel" onClick={() => stopRun(session.sessionId)}>
              ■ Stop &amp; kill spawned
            </button>
          : <button className="run-btn run-btn-go" disabled={blocked} onClick={spawn}>
              <span className="run-play">▶</span> Spawn mess
            </button>}
        <button className="icon-btn" title="Close this tab — spawned threads keep running" onClick={onClose}>×</button>
      </div>

      <div className="pg-body">
        <div className="pg-config">
          <div className="pg-scenarios">
            {SCENARIOS.map(s => (
              <button
                key={s.id}
                className={`pg-card ${scenario === s.id ? 'pg-card-on' : ''}`}
                onClick={() => setScenario(s.id)}
                disabled={running}
              >
                <span className="pg-card-title"><span className="icon-slot">{s.icon}</span>{s.name}</span>
                <span className="pg-card-what">{s.what}</span>
                <span className="pg-card-then">{s.then}</span>
                {s.writes && <span className="pg-card-writes">needs write access (creates one table, updates one row)</span>}
              </button>
            ))}
          </div>

          <div className="pg-params">
            <label>threads
              <input type="number" min={minThreads} max={64} value={threadCount} disabled={running}
                onChange={e => setThreads(Math.max(minThreads, Math.min(64, Number(e.target.value) || minThreads)))} />
              <i>
                exactly this many server threads (max 64)
                {minThreads > 1 && ` · ${sc.name} needs at least ${minThreads}`}
              </i>
            </label>
            <label>duration
              <input type="number" min={0.1} max={600} step={1} value={duration} disabled={running}
                onChange={e => setDuration(Math.max(0.1, Math.min(600, Number(e.target.value) || 1)))} />
              <i>seconds per statement — long enough to look at</i>
            </label>
            <label>stagger
              <input type="number" min={0} max={60000} step={100} value={stagger} disabled={running}
                onChange={e => setStagger(Math.max(0, Math.min(60000, Number(e.target.value) || 0)))} />
              <i>ms between launches — 0 = all at once, higher = a spread of ages</i>
            </label>
            <label>repeats
              <input type="number" min={1} max={200} value={repeats} disabled={running}
                onChange={e => setRepeats(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} />
              <i>statements per worker — &gt;1 makes threads come and go (churn)</i>
            </label>
            <label>jitter %
              <input type="number" min={0} max={100} value={jitter} disabled={running}
                onChange={e => setJitter(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
              <i>± variation of duration, so ages differ like real traffic</i>
            </label>
            {sc.writes && (
              <>
                <label>hold
                  <input type="number" min={0.1} max={600} value={hold} disabled={running}
                    onChange={e => setHold(Math.max(0.1, Math.min(600, Number(e.target.value) || 1)))} />
                  <i>seconds the blocker holds its row lock</i>
                </label>
                <label>{isPg || isMs ? 'schema' : 'database'}
                  <input type="text" value={database} disabled={running}
                    onChange={e => setDatabase(e.target.value)} />
                  <i>created if missing; holds the single contended row</i>
                </label>
              </>
            )}
            <label>tag
              <input type="text" value={tag} disabled={running} maxLength={32}
                onChange={e => setTag(e.target.value)} />
              <i>appears in every statement comment — how you recognize the mess</i>
            </label>
          </div>

          <div className="pg-preview">
            <div className="pg-preview-head">What will run</div>
            {preview.map((l, i) => <code key={i} className="pg-preview-line">{l}</code>)}
          </div>

          {blocked && (
            <div className="pg-warn">
              This connection is <b>read-only</b> — the lock scenarios need to create the playground
              table and update its row. Use <b>💤 Sleep mess</b> (pure <code>SELECT SLEEP</code>, no writes),
              or open a writable connection.
            </div>
          )}
          {run?.error && <div className="pg-err">{run.error}</div>}
        </div>

        <div className="pg-side">
          <div className="pg-side-head">
            Workers
            {workers.length > 0 && <span className="pg-live">{live} live / {workers.length}</span>}
            {run && !run.running && (
              <button className="pg-link" onClick={() => clearRun(session.sessionId)}
                title="Forget this finished run (does not touch the server)">clear</button>
            )}
          </div>
          {run && <div className="pg-summary">{run.summary}</div>}
          <div className="pg-workers">
            {workers.length === 0 && (
              <div className="mx-empty">
                Nothing spawned yet. Pick a scenario, press <b>▶ Spawn mess</b>, then switch to a
                SQL tab and type <code>killall</code>.
              </div>
            )}
            {workers.map(w => (
              <div key={w.slot} className={`pg-worker pg-w-${w.status}`}>
                <span className="pg-w-slot">{w.slot}</span>
                <span className={`pg-w-role pg-role-${w.role}`}>{w.role}</span>
                <span className="pg-w-tid">#{w.threadId || '—'}</span>
                <span className="pg-w-status">
                  {w.status === 'running' ? '⟳ running' : w.status === 'done' ? '✓ done' : '✗ failed'}
                  {w.ms != null ? ` ${(w.ms / 1000).toFixed(1)}s` : ''}
                </span>
                <code className="pg-w-sql" title={w.error ?? w.sql}>{w.error ?? w.sql}</code>
              </div>
            ))}
          </div>

          {workers.length > 0 && (
            <div className="pg-next">
              <b>Now:</b> switch to a SQL tab and type <code>killall</code> — the threads keep
              running whether this tab is open or not. Or{' '}
              <button className="pg-link" onClick={() => window.dispatchEvent(new CustomEvent('dbgui:toggle-processes'))}>
                open ⚡ Processes
              </button>
              {' · '}
              <button className="pg-link" onClick={() => window.dispatchEvent(new CustomEvent('dbgui:toggle-locks'))}>
                open 🔒 Locks
              </button>
            </div>
          )}

          <div className="pg-log-head">Log</div>
          <div className="pg-log">
            {log.map((l, i) => (
              <div key={i} className={`lq-log-line lq-log-${l.level === 'warn' ? 'phase' : l.level}`}>
                <span className="sl-ts">{l.t}</span> {l.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
