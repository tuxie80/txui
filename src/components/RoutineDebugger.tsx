/**
 * Step through a stored routine and watch its values change.
 *
 * This is a **recording**, not a live pause. The routine is rewritten into an
 * instrumented form that records every statement's variable state, run once,
 * and replayed here — no backend sits parked holding locks while you read.
 *
 * The two engines record differently, and the UI says so rather than
 * pretending otherwise:
 *
 * - **PostgreSQL** runs an anonymous block inside a transaction that is
 *   rolled back — nothing is created on the server and the routine's writes
 *   are undone (see utils/plpgsqlInstrument for why that shape is forced).
 * - **MySQL** has no anonymous block: the copy is a real `__txui_dbg_*`
 *   object in a nominated scratch schema, dropped in a finally, and its
 *   writes COMMIT — there is no rollback (see utils/mysqlInstrument and
 *   docs/ROUTINE_DEBUGGER.md §3 for the safety model: never on prod, never
 *   on a read-only connection, every created object audit-logged).
 *
 * The trade both make, stated in the UI rather than hidden: you cannot change
 * course mid-run. What you get in exchange is the thing a live debugger cannot
 * do — step **backwards**, replay without re-running, and see a failed run's
 * values at the moment it broke.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { StatusIcon } from './StatusIcon';
import {
  instrumentPlpgsql, parseTrace, changedVars, formatValue,
} from '../utils/plpgsqlInstrument';
import type { TraceStep } from '../utils/plpgsqlInstrument';
import {
  instrumentMysqlRoutine, parseMysqlTrace,
} from '../utils/mysqlInstrument';
import type { MysqlInstrumentResult, MysqlTraceStep } from '../utils/mysqlInstrument';
import { isoNow, logAudit, newRunId } from '../utils/audit';
import { audited } from '../utils/panelAudit';
import { redactSecrets } from '../utils/redactSecrets';
import { sessionLabel } from '../store/logStore';
import type { RoutineDef } from '../utils/routineDdl';
import type { Engine } from '../types';

interface DebugRun {
  steps: unknown[];
  error: string | null;
}

/** The MySQL sibling's response — see DebugRunMysql in commands/routines.rs. */
interface DebugRunMysql {
  steps: unknown[];
  error: string | null;
  /** The CALL itself failed — expected when the routine raised; the trace
      carries the details. */
  runError: string | null;
  /** The scratch schema did not exist and this run created it (audited). */
  schemaCreated: boolean;
  /** DROP statements the crash-sweep issued for leftover copies. */
  swept: string[];
}

/** The recorded step, whichever engine produced it. */
type Step = TraceStep & Pick<MysqlTraceStep, 'truncated' | 'entry'>;

/** Where the MySQL instrumented copy lives, remembered per connection. */
const scratchKey = (connectionId?: string) =>
  `dbgui:mysql-debug-scratch:${connectionId ?? 'default'}`;
export const DEFAULT_SCRATCH_SCHEMA = 'txui_debug';

interface Props {
  sessionId: string;
  /** Keys the per-connection scratch-schema memory; absent in tests. */
  connectionId?: string;
  engine: Engine;
  def: RoutineDef;
  /** Blocked upstream on prod; this only disables the button with a reason. */
  blocked?: string;
  onClose: () => void;
}

export function RoutineDebugger({ sessionId, connectionId, engine, def, blocked, onClose }: Props) {
  const isMysql = engine === 'mysql';
  const [values, setValues] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [scratch, setScratch] = useState(() =>
    (localStorage.getItem(scratchKey(connectionId)) ?? '').trim() || DEFAULT_SCRATCH_SCHEMA);
  /** A fresh id per run keeps concurrent traces apart; bumped in `run`. */
  const [runId, setRunId] = useState(() => newRunId());

  const built = useMemo(() => {
    const bound = def.params
      .filter(p => p.name)
      .map(p => ({ name: p.name, value: values[p.name] ?? '' }));
    if (isMysql) {
      const r: MysqlInstrumentResult = instrumentMysqlRoutine(def, {
        scratchSchema: scratch, runId, values: bound,
      });
      return { unsupported: r.unsupported, sql: r.sql, lines: r.lines, watched: r.watched, mysql: r, pg: null };
    }
    const r = instrumentPlpgsql(def, { values: bound });
    return { unsupported: r.unsupported, sql: r.sql, lines: r.lines, watched: r.watched, mysql: null, pg: r };
  }, [def, values, isMysql, scratch, runId]);

  const runMysql = useCallback(async (m: MysqlInstrumentResult) => {
    const res = await audited({
      sessionId,
      engine: 'mysql',
      tab: '🐞 Debugger',
      source: 'panel',
      database: scratch,
      // The object this run creates — the instrumented copy. The audit row
      // carries the full rewritten DDL, redacted by `audited`.
      statement: m.parts.create,
      rowsOut: (r: DebugRunMysql) => r.steps.length,
      run: () => invoke<DebugRunMysql>('debug_routine_mysql', {
        sessionId,
        parts: {
          scratchSchema: scratch,
          setupSql: m.parts.setup,
          createSql: m.parts.create,
          runSql: m.parts.run,
          selectSql: m.parts.select,
          cleanupSql: m.parts.cleanup,
          sweepSql: m.parts.sweep,
        },
      }),
    });
    // The scratch schema create happened inside the command; it is a created
    // object too, so it gets its own audit row when this run caused it.
    if (res.schemaCreated) {
      logAudit({
        session_id: sessionId,
        tab_title: '🐞 Debugger',
        database: scratch,
        source: 'panel',
        started_at: isoNow(),
        ended_at: isoNow(),
        duration_ms: 0,
        connection_name: sessionLabel(sessionId) ?? '',
        db_user: '',
        engine: 'mysql',
        ok: true,
        rows_out: 0,
        rows_affected: null,
        error: null,
        sql: redactSecrets(`CREATE DATABASE IF NOT EXISTS \`${scratch}\``),
      });
    }
    return res;
  }, [sessionId, scratch]);

  const run = useCallback(async () => {
    if (built.unsupported) return;
    setRunning(true);
    setError(null);
    setSteps(null);
    try {
      if (built.mysql) {
        const res = await runMysql(built.mysql);
        if (res.error) setError(res.error);
        const parsed = parseMysqlTrace(res.steps);
        setSteps(parsed);
        setCursor(0);
        // A raising routine fails its CALL by design; the trace carries the
        // cause. Only when the trace does NOT is the transport error news.
        if (res.runError && !parsed.some(s => s.error)) setError(e => e ?? res.runError);
        setRunId(newRunId());
      } else if (built.pg) {
        const res = await invoke<DebugRun>('debug_routine', {
          sessionId,
          setupSql: built.pg.parts.setup,
          blockSql: built.pg.parts.block,
          selectSql: built.pg.parts.select,
        });
        if (res.error) setError(res.error);
        const parsed = parseTrace(res.steps);
        setSteps(parsed);
        setCursor(0);
      }
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setRunning(false);
    }
  }, [built, sessionId, runMysql]);

  const total = steps?.length ?? 0;
  const cur = steps?.[cursor];
  const prev = cursor > 0 ? steps?.[cursor - 1] : undefined;
  const changed = useMemo(() => (cur ? changedVars(prev, cur) : new Set<string>()),
    [prev, cur]);

  // ← / → step, Home / End jump. Only while a recording is loaded.
  useEffect(() => {
    if (!steps || steps.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); setCursor(c => Math.min(total - 1, c + 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
      else if (e.key === 'Home') { e.preventDefault(); setCursor(0); }
      else if (e.key === 'End') { e.preventDefault(); setCursor(total - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [steps, total]);

  const bodyLines = useMemo(() => def.body.split('\n'), [def.body]);
  /** Lines that reported at least once — the "you can stop here" gutter. */
  const traced = useMemo(() => new Set(built.lines), [built.lines]);
  const failure = steps?.find(s => s.error);
  const returned = steps?.find(s => s.ret !== undefined);
  const truncated = steps?.find(s => s.truncated);

  return (
    <div className="rdbg">
      <div className="rdbg-bar">
        <span className="rdbg-title">🐞 Debug — {def.name}</span>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={() => setShowSql(v => !v)}>
          {showSql ? 'Hide generated SQL' : 'Generated SQL'}
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {isMysql ? (
        <div className="rdbg-note">
          Runs a rewritten copy as <code>{scratch}.{built.mysql?.copyName || `__txui_dbg_${def.name}`}</code> and
          drops it afterwards — the original routine is never altered. Unlike PostgreSQL
          there is <b>no rollback: the copy&rsquo;s writes commit</b>. You are stepping a
          recording, so you can go <b>backwards</b>; you cannot change course mid-run.
        </div>
      ) : (
        <div className="rdbg-note">
          Runs a rewritten copy inside a transaction and rolls it back — <b>nothing is
          created on the server</b> and the routine&rsquo;s writes are undone. You are
          stepping a recording, so you can go <b>backwards</b>; you cannot change course
          mid-run.
        </div>
      )}

      {built.unsupported && (
        <div className="rdbg-blocked"><StatusIcon kind="error" /> {built.unsupported}</div>
      )}
      {blocked && <div className="rdbg-blocked"><StatusIcon kind="error" /> {blocked}</div>}

      {isMysql && !built.unsupported && (
        <div className="rdbg-params">
          <span className="rdbg-params-head">Scratch schema</span>
          <label className="rdbg-param">
            <span>schema <em>for the instrumented copy</em></span>
            <input
              value={scratch}
              placeholder={DEFAULT_SCRATCH_SCHEMA}
              spellCheck={false}
              onChange={e => {
                setScratch(e.target.value);
                localStorage.setItem(scratchKey(connectionId), e.target.value);
              }}
            />
          </label>
          <span className="rdbg-params-hint">
            The copy and the trace table live here, not next to the routine —
            remembered per connection.
          </span>
        </div>
      )}

      {built.mysql?.notes.map((n, i) => (
        <div key={i} className="rdbg-blocked"><StatusIcon kind="pending" /> {n}</div>
      ))}

      {def.params.filter(p => p.name).length > 0 && (
        <div className="rdbg-params">
          <span className="rdbg-params-head">Arguments</span>
          {def.params.filter(p => p.name).map(p => (
            <label key={p.name} className="rdbg-param">
              <span>{p.name} <em>{p.type}</em></span>
              <input
                value={values[p.name] ?? ''}
                placeholder="NULL"
                spellCheck={false}
                onChange={e => setValues(v => ({ ...v, [p.name]: e.target.value }))}
              />
            </label>
          ))}
          <span className="rdbg-params-hint">SQL literals — <code>42</code>, <code>&apos;abc&apos;</code>, <code>now()</code></span>
        </div>
      )}

      <div className="rdbg-actions">
        <button
          className="primary"
          onClick={run}
          disabled={running || !!built.unsupported || !!blocked}
        >{running ? 'Running…' : steps ? 'Re-run' : '▶ Run'}</button>

        {total > 0 && (<>
          <span className="rdbg-steps">
            <button className="toolbar-btn" onClick={() => setCursor(0)}
                    disabled={cursor === 0} title="First (Home)">⇤</button>
            <button className="toolbar-btn" onClick={() => setCursor(c => Math.max(0, c - 1))}
                    disabled={cursor === 0} title="Back (←)">◀</button>
            <span className="rdbg-counter">{cursor + 1} / {total}</span>
            <button className="toolbar-btn" onClick={() => setCursor(c => Math.min(total - 1, c + 1))}
                    disabled={cursor >= total - 1} title="Forward (→)">▶</button>
            <button className="toolbar-btn" onClick={() => setCursor(total - 1)}
                    disabled={cursor >= total - 1} title="Last (End)">⇥</button>
          </span>
          <input
            className="rdbg-scrub"
            type="range"
            min={0}
            max={total - 1}
            value={cursor}
            onChange={e => setCursor(Number(e.target.value))}
            aria-label="Step through the recording"
          />
        </>)}
      </div>

      {error && <div className="rdbg-error"><StatusIcon kind="error" /> {error}</div>}

      {steps && total > 0 && (
        <div className="rdbg-summary">
          {failure
            ? <><StatusIcon kind="error" /> Raised at step {failure.n}: <b>{failure.error}</b>
                {failure.sqlstate && <span className="rdbg-sqlstate">{failure.sqlstate}</span>}</>
            : <><StatusIcon kind="ok" /> Completed in {total} steps
                {returned && <> · returned <b>{formatValue(returned.ret)}</b></>}</>}
          {truncated && <> · <b>trace truncated at the step cap</b> — later statements did not record</>}
        </div>
      )}

      {showSql && <pre className="rdbg-sql">{built.sql}</pre>}

      <div className="rdbg-body">
        <div className="rdbg-code">
          {bodyLines.map((text, i) => {
            const ln = i + 1;
            const here = cur?.line === ln;
            return (
              <div key={ln} className={`rdbg-line${here ? ' here' : ''}${traced.has(ln) ? ' traced' : ''}`}>
                <span className="rdbg-ln">{ln}</span>
                <span className="rdbg-mark">{here ? '▶' : traced.has(ln) ? '·' : ''}</span>
                <code>{text || ' '}</code>
              </div>
            );
          })}
        </div>

        <aside className="rdbg-vars">
          <div className="rdbg-vars-head">
            Variables
            {cur && cur.line > 0 && <em>after line {cur.line}</em>}
            {cur?.entry && <em>on entry</em>}
          </div>
          {!steps && <div className="rdbg-hint">Run to record a timeline.</div>}
          {steps && !cur && <div className="rdbg-hint">No steps recorded.</div>}
          {cur?.error && (
            <div className="rdbg-var-error">
              {cur.error}
              {cur.sqlstate && <span className="rdbg-sqlstate">{cur.sqlstate}</span>}
            </div>
          )}
          {cur && Object.entries(cur.vars).map(([k, v]) => (
            <div key={k} className={`rdbg-var${changed.has(k) ? ' changed' : ''}`}>
              <span className="rdbg-var-name">{k}</span>
              <span className="rdbg-var-val" title={formatValue(v)}>{formatValue(v)}</span>
              {changed.has(k) && prev && (
                <span className="rdbg-var-was">was {formatValue(prev.vars[k])}</span>
              )}
            </div>
          ))}
          {cur?.ret !== undefined && (
            <div className="rdbg-var rdbg-var-ret">
              <span className="rdbg-var-name">RETURN</span>
              <span className="rdbg-var-val">{formatValue(cur.ret)}</span>
            </div>
          )}
          {built.watched.length === 0 && steps && (
            <div className="rdbg-hint">
              This routine declares no variables to watch — only the line it reached
              is recorded.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
