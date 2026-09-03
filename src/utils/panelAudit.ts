/**
 * One way for a panel to record what it did.
 *
 * The 📜 Audit log and the 📓 Log were populated by whichever call sites
 * happened to remember, and the panels mostly did not: a CSV import that
 * appended two million rows, a `mysqldump` of production, a fleet execution
 * across nine servers — none of them left a trace anywhere. The audit log's
 * whole value is that it is complete; one silent surface makes every answer it
 * gives conditional.
 *
 * So an action that touches a server goes through here, and the entry is
 * assembled in **one** place rather than at a dozen call sites that each get
 * some of the fields right:
 *
 *  - `started_at` / `ended_at` / `duration_ms` measured around the call, not
 *    estimated afterwards;
 *  - failures recorded with the same weight as successes — an audit log that
 *    only holds what worked cannot answer "what was tried";
 *  - the connection name resolved from the session, so a panel that only has
 *    a `sessionId` does not have to grow a prop to be auditable;
 *  - **the text redacted before it leaves** — see below.
 *
 * ## The security rule
 *
 * Everything recorded here is written to an immutable SQLite row, mirrored
 * into the session log, and often mirrored again into a file on disk
 * (`log_dir`). Those are the artefacts people paste into tickets. TxUI never
 * puts a password in argv — the dump tools receive theirs through `MYSQL_PWD`
 * / `PGPASSWORD` — but a user can type one into a free-text field, and a
 * `CREATE USER … IDENTIFIED BY` is ordinary SQL. Both redactors run on every
 * string that passes through here, unconditionally. There is no opt-out,
 * because the one call site that opted out would be the one that leaked.
 */
import { isoNow, logAudit } from './audit.ts';
import type { AuditSource } from './audit.ts';
import { errorDisplay } from './appError.ts';
import { redactCommandLine, redactSecrets } from './redactSecrets.ts';
import { sessionLabel } from '../store/logStore.ts';

export interface AuditedAction<T> {
  /**
   * The session this belongs to, or `''` for work that belongs to no single
   * one — a fleet run, or a dump tool that talks to the server itself. An
   * empty session id also means the entry cannot be mirrored into a session's
   * 📓 Log, so it lands in the 📜 Audit log alone.
   */
  sessionId: string;
  /**
   * The connection to name in the record.
   *
   * Normally resolved from the session. It has to be passable because the
   * actions with no session are exactly the ones that touch several servers —
   * so `connection_name` was blank on the only rows where it carried real
   * information.
   */
  connectionName?: string;
  engine: string;
  /** The panel's own name, as the tab shows it — `📥 CSV import`. */
  tab: string;
  source: AuditSource;
  /** Schema in effect, when the action has one. */
  database?: string;
  /**
   * What was done, as text: a statement, or a command line. Redacted here —
   * callers must not pre-redact, and must not skip it.
   */
  statement: string;
  /** Rows the action returned, when that is a meaningful number. */
  rowsOut?: (result: T) => number;
  /** Rows the action changed. `null` when the action does not change rows. */
  rowsAffected?: (result: T) => number | null;
  run: () => Promise<T>;
}

/**
 * Run it, record it, and re-throw anything it threw.
 *
 * Re-throwing matters: this is an observer, not a handler. A panel's own error
 * path stays exactly as it was, and wrapping a call can never change what the
 * user sees happen.
 */
export async function audited<T>(a: AuditedAction<T>): Promise<T> {
  const started = isoNow();
  const t0 = performance.now();
  const base = {
    session_id: a.sessionId,
    tab_title: a.tab,
    database: a.database ?? '',
    source: a.source,
    started_at: started,
    connection_name: a.connectionName ?? sessionLabel(a.sessionId) ?? '',
    db_user: '',
    engine: a.engine,
    sql: redactCommandLine(redactSecrets(a.statement)),
  };
  try {
    const result = await a.run();
    logAudit({
      ...base,
      ended_at: isoNow(),
      duration_ms: Math.round(performance.now() - t0),
      ok: true,
      rows_out: a.rowsOut?.(result) ?? 0,
      rows_affected: a.rowsAffected ? a.rowsAffected(result) : null,
      error: null,
    });
    return result;
  } catch (e) {
    logAudit({
      ...base,
      ended_at: isoNow(),
      duration_ms: Math.round(performance.now() - t0),
      ok: false,
      rows_out: 0,
      rows_affected: null,
      error: errorDisplay(e),
      raw_error: e,
    });
    throw e;
  }
}
