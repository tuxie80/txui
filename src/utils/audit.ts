/**
 * Audit-log helpers.
 *
 * The audit log is the durable, cross-session record — one immutable row per
 * statement, in SQLite, surviving restarts. The per-session 📓 Log is the
 * transient companion and lives in `store/logStore`.
 *
 * A row that says only *what* ran cannot answer the question people actually
 * bring to an audit log. So every row carries **where it came from**:
 *
 *   - `run_id` groups the statements of one Run, so a ten-statement script
 *     reads as one run rather than ten unrelated rows.
 *   - `tab_title` / `session_id` say which tab of which connection.
 *   - `database` says which schema was in effect — the same statement means
 *     different things against two of them.
 *   - `source` says whether a person typed it or a panel did it on its own.
 */
import { invoke } from '@tauri-apps/api/core';
import { toAppError } from './appError.ts';
import { addLog } from '../store/logStore.ts';
import { fmtDuration } from './fmtDuration.ts';

/**
 * What initiated a statement.
 *
 * Present so an audit reader can separate deliberate acts from the app's own
 * housekeeping. Background pollers are deliberately absent: a processlist that
 * refreshes every second would bury every real entry within the hour, and an
 * audit log nobody can read is not an audit log.
 */
export type AuditSource =
  | 'editor'    // typed and run by the user
  | 'browser'   // data browser paging / filtering
  | 'shell'     // TxShell
  | 'panel'     // a panel action the user asked for (maintenance, analyze, …)
  | 'kill'      // killing a server thread
  | 'datagen'   // data generation
  | 'import'    // CSV import
  | 'dump'      // mysqldump / mydumper / pg_dump / restore
  | 'fleet'     // one statement executed across several servers
  | 'replay'    // Dolphie recording lifecycle (open / index / release)
  | 'lifecycle'; // session open/close — written by the BACKEND (close can
                // outlive the window); the action keyword sits in `sql`
                // ('connect' / 'disconnect') and a disconnect's duration_ms
                // is how long the session lasted

export interface AuditEntry {
  run_id?: string;
  stmt_index?: number | null;
  stmt_total?: number | null;
  session_id?: string;
  tab_title?: string;
  database?: string;
  source?: AuditSource;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  connection_name: string;
  db_user: string;
  engine: string;
  ok: boolean;
  rows_out: number;
  rows_affected: number | null;
  error: string | null;
  /**
   * A stable class for the failure — see `utils/appError`.
   *
   * `error` holds the server's prose, which is what a person reads. Prose
   * cannot be grouped: "how often are we losing connections?" and "did raising
   * the timeout help?" were unanswerable from this log, because every wording
   * variant was a distinct string. Filled in by `logAudit`, so no call site
   * has to remember.
   */
  error_code?: string;
  /**
   * The rejection exactly as the command returned it, when the caller has
   * already turned `error` into display text. `error` is what a reader sees;
   * this is what the number is read from.
   */
  raw_error?: unknown;
  /** The server's own number — `1146`, `42P01`. Filled in by `logAudit`. */
  db_code?: string;
  sqlstate?: string;
  sql: string;
}

export function isoNow(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

let runSeq = 0;

/**
 * An id for one Run — every statement it executes shares it.
 *
 * Deliberately not a timestamp alone: two runs can start inside the same
 * millisecond, and two rows that share a run id when they were different runs
 * is a worse failure than an ugly id.
 */
export function newRunId(): string {
  runSeq += 1;
  return `r${Date.now().toString(36)}-${runSeq.toString(36)}`;
}

/** One line for the session 📓 Log, derived from an audit row. Exported for tests. */
export function auditLine(entry: AuditEntry): string {
  const sql = entry.sql.trim().replace(/\s+/g, ' ');
  const short = sql.length > 200 ? `${sql.slice(0, 200)}…` : sql;
  const ms = fmtDuration(entry.duration_ms);
  if (!entry.ok) return `! ${entry.error ?? 'failed'} — ${short} (after ${ms})`;
  const n = entry.rows_affected != null ? entry.rows_affected : entry.rows_out;
  const what = entry.rows_affected != null ? 'affected' : 'retrieved';
  return `${short} — ${n} row${n === 1 ? '' : 's'} ${what} in ${ms}`;
}

/**
 * Never blocks or throws — an audit failure must not break the query flow.
 *
 * The failure class is derived here rather than at each call site: there are
 * two dozen of them, and one that forgot would leave a hole in exactly the
 * data the column exists to provide.
 *
 * ## Why this also writes the session log
 *
 * The 📓 Log and the 📜 Audit log were populated by two disjoint sets of call
 * sites, and the panels were in only one of them: a `MaintenancePanel`
 * `OPTIMIZE TABLE`, a data generation run and a CSV import were all audited
 * and yet left **no trace whatsoever** in the log the user actually watches.
 * "What happened on this connection?" answered with silence about the most
 * consequential things the app can do.
 *
 * Mirroring here rather than at each panel is the point: an audited action is
 * by definition user-initiated and consequential (background pollers are
 * deliberately never audited — see `AuditSource`), which is exactly the
 * filter the session log wants. A new panel that audits its work is logged
 * without its author having to know this exists.
 *
 * `alsoLog: false` is for the call sites that write their own, richer pair of
 * lines already (the editor's `> statement` + result, the data browser, the
 * kill path) — without it every editor statement would appear twice.
 */
export function logAudit(entry: AuditEntry, opts: { alsoLog?: boolean } = {}): void {
  const e = entry.ok ? null : toAppError(entry.raw_error ?? entry.error);
  const error_code = entry.error_code ?? (e && entry.error != null ? e.code : '');
  invoke('audit_insert', {
    entry: {
      source: 'editor', ...entry, error_code,
      db_code:  entry.db_code  ?? e?.db_code  ?? '',
      sqlstate: entry.sqlstate ?? e?.sqlstate ?? '',
    },
    // Don't swallow silently — a failing audit insert used to leave the panel
    // mysteriously empty. Surface it to the console so it's diagnosable.
  }).catch(err => console.error('[audit] insert failed:', err));

  if (opts.alsoLog === false || !entry.session_id) return;
  addLog(entry.session_id, {
    level: entry.ok ? 'ok' : 'err',
    action: (entry.source ?? 'panel').toUpperCase(),
    detail: entry.sql,
    ms: entry.duration_ms,
    rows: entry.rows_affected ?? entry.rows_out,
    line: auditLine(entry),
  });
}

/**
 * Failures grouped by class, commonest first.
 *
 * The question the audit log could not answer before it carried a code.
 * Rows with no code (successes, and anything written before the column
 * existed) are left out rather than bucketed as `unknown` — counting old rows
 * as a failure class would invent a trend that is really just the migration.
 */
export function failureCounts(entries: Pick<AuditEntry, 'ok' | 'error_code'>[]):
  Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.ok) continue;
    const code = e.error_code;
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    // Ties broken by name so the order is stable between renders.
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}
