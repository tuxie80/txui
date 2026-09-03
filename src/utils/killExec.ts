/**
 * The ONE path every kill in TxUI goes through — the `kill …` popup, the ⚡
 * Processes panel, the 🔒 Locks panel's *Kill blocker*.
 *
 * Killing is destructive and unrecoverable, so it is never fire-and-forget:
 * each targeted thread produces exactly one line in the session 📓 Log **and**
 * one row in the immutable 📜 Audit log, carrying everything we knew about the
 * victim at kill time (who, where, how old, what it was running, what it was
 * blocking) plus the statement actually issued and the outcome.
 */
import { errorDisplay } from './appError.ts';
import { invoke } from '@tauri-apps/api/core';
import { addLog } from '../store/logStore';
import { isoNow, logAudit } from './audit.ts';
import { aged, killLogLine } from './killAnalyze.ts';
import type { History, KillMode, ProcInfo } from './killAnalyze';

export interface KillOutcome {
  id: number;
  ok: boolean;
  error: string | null;
  /** exactly what the server was asked to run */
  statement: string;
}

export interface KillRequest {
  sessionId: string;
  ids: number[];
  mode: KillMode;
  /** Where it came from — ends up in the log line ("via killall") */
  source: string;
  /** Last poll, for victim detail. Threads not in it are logged as such. */
  procs?: ProcInfo[];
  /** Poll history, so the log can say how much the thread aged while watched */
  hist?: History;
  // audit-log attribution
  connectionName?: string;
  engine?: string;
  dbUser?: string;
}

/**
 * Kill `ids` and log every single one. Throws only if the whole command failed
 * (no session, wrong engine); per-thread failures come back in the outcomes.
 */
export async function executeKill(req: KillRequest): Promise<KillOutcome[]> {
  const started = isoNow();
  const t0 = Date.now();
  const byId = new Map((req.procs ?? []).map(p => [p.id, p]));

  let outcomes: KillOutcome[];
  try {
    outcomes = await invoke<KillOutcome[]>('kill_processes', {
      sessionId: req.sessionId, ids: req.ids, mode: req.mode,
    });
  } catch (e) {
    // The command itself failed — log the attempt, then let the caller show it.
    const detail = `${req.mode === 'query' ? 'KILL QUERY' : 'KILL'} ${req.ids.map(i => `#${i}`).join(',')} · FAILED: ${errorDisplay(e).replace(/\s+/g, ' ')} · via ${req.source}`;
    addLog(req.sessionId, { level: 'err', action: 'KILL', detail });
    logAudit({
      started_at: started, ended_at: isoNow(), duration_ms: Date.now() - t0,
      connection_name: req.connectionName ?? '', db_user: req.dbUser ?? '',
      engine: req.engine ?? '', ok: false, rows_out: 0, rows_affected: null,
      error: errorDisplay(e), raw_error: e, sql: detail,
    }, { alsoLog: false });
    throw e;
  }

  const ended = isoNow();
  const ms = Date.now() - t0;
  for (const o of outcomes) {
    const proc = byId.get(o.id);
    const line = killLogLine({
      id: o.id, mode: req.mode, statement: o.statement, ok: o.ok, error: o.error,
      proc, agedSecs: req.hist ? aged(req.hist, o.id) : null, source: req.source,
    });
    addLog(req.sessionId, { level: o.ok ? 'ok' : 'err', action: 'KILL', detail: line, ms });
    logAudit({
      started_at: started, ended_at: ended, duration_ms: ms,
      connection_name: req.connectionName ?? '', db_user: proc?.user ?? req.dbUser ?? '',
      engine: req.engine ?? '', ok: o.ok, rows_out: 0, rows_affected: null,
      error: o.error, sql: line,
    }, { alsoLog: false });
  }
  return outcomes;
}

/**
 * Build a ProcInfo from whatever a panel happens to know (a grid row, a lock
 * chain), so those kills log victim detail too instead of "no detail".
 */
export function partialProc(over: Partial<ProcInfo> & { id: number }): ProcInfo {
  return {
    user: '', host: '', db: '', command: '', time: 0, state: '', info: '',
    trxAge: -1, rowsLocked: 0, trxState: '', blocking: [], blockedBy: [],
    isSelf: false, isSystem: false, ...over,
  };
}
