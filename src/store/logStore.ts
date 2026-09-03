/**
 * Per-session activity log — the single home for everything a session does:
 * connect, queries, panel actions, browse, explain, generation, dump/restore,
 * etc. Keyed by sessionId, subscribable via useSessionLog(). The 📜 Audit log
 * (immutable SQLite, cross-session) is separate and unaffected; outputs land
 * in both where relevant.
 *
 * Every entry carries a CANONICAL one-line text (`line`, or a fallback derived
 * from action/detail/ms/rows) — DataGrip style:
 *   [2026-08-04 14:48:42] > show replica status
 *   [2026-08-04 14:48:43] 8 rows retrieved in 583 ms (execution: 185 ms, fetching: 398 ms)
 *   [2026-08-04 14:48:43] 3 rows affected in 12 ms (execution: 12 ms)
 *   [2026-08-04 14:48:44] ! <error> (after 42 ms)
 * Copy/Export (formatLog) emit exactly these lines, chronological (oldest
 * first). A per-session sink (setLogSink) receives the same line for every
 * entry — QueryTabs wires it to `append_server_log` when the connection has a
 * log_dir and the serverLog pref is on.
 */
import { useSyncExternalStore } from 'react';

export type LogLevel = 'info' | 'ok' | 'err' | 'warn';

export interface LogEntry {
  ts: string;            // HH:MM:SS.mmm (compact, for the UI list)
  stamp: string;         // [YYYY-MM-DD HH:MM:SS] (canonical line prefix)
  level: LogLevel;
  action: string;        // short verb, e.g. CONNECT, QUERY, EXPLAIN, PANEL
  detail: string;        // the meat — SQL, target, message
  ms?: number;           // wall time when applicable
  rows?: number | null;  // affected/returned when applicable
  execMs?: number;       // backend execute-only time (QueryResult.execution_ms)
  fetchMs?: number;      // backend fetch time (QueryResult.fetch_ms)
  /** Canonical one-line message (no timestamp). Absent → derived fallback. */
  line?: string;
  /** Which session wrote it — set by addLog, never by callers. */
  sessionId?: string;
  /** The connection's name at the time of writing (setSessionLabel). */
  label?: string;
  /** Restored from a previous run of the app, not written by this one. */
  previousRun?: boolean;
}

const MAX = 2000;
const logs = new Map<string, LogEntry[]>();
const listeners = new Map<string, Set<() => void>>();
// Version counters, not cloned snapshots: emit used to clone the ENTIRE
// per-session (2 000-cap) and run (20 000-cap) arrays on every single addLog.
// Subscribers now key on a version number and read the live array — the
// arrays are only ever mutated between renders (append/trim in addLog), and
// callers of the hooks must treat them as read-only.
const versions = new Map<string, number>();
const sinks = new Map<string, (line: string) => void>();

/**
 * ── The run log ───────────────────────────────────────────────────────────
 *
 * Everything every session writes, in one chronological list, for as long as
 * the app is running.
 *
 * The per-session buckets above answer "what did *this* connection do". They
 * cannot answer the question people actually ask when something went wrong —
 * "what happened, in order, across everything I had open" — and they lose the
 * answer entirely at disconnect, because `dropLog` frees the bucket. A joined
 * view assembled from live sessions would have the same hole: the connection
 * you closed two minutes ago is exactly the one you now want to read.
 *
 * So every entry is appended here as well, tagged with its session and the
 * connection's name, and this list is **not** touched by `dropLog`. It is
 * cleared only by the user, or by quitting.
 *
 * The cap is separate and larger: this is the union of up to a dozen sessions.
 * Beyond it the oldest entries are dropped, which is the same trade the
 * per-session log makes — the durable, complete record is the 📜 Audit log in
 * SQLite, and that one is never trimmed here.
 */
const MAX_RUN = 20000;
const runLog: LogEntry[] = [];

/**
 * ── Surviving a restart ───────────────────────────────────────────────────
 *
 * The joined log answered "what was happening at 14:32" across every
 * connection — until the app was quit, at which point it answered nothing.
 * That is the wrong end of the day to lose it: you close the app, sleep on the
 * incident, and come back to an empty list.
 *
 * So the tail is mirrored to `localStorage`, the same store the editor buffers
 * use (`utils/bufferStore.ts`) and for the same reason: no backend round trip,
 * no file handle, and a failed write can never break logging.
 *
 * Only the tail. The durable, complete, cross-session record is the 📜 Audit
 * log in SQLite; this is a convenience, and one that must not grow without
 * bound in a store with a hard quota.
 */
const PERSIST_KEY = 'dbgui.runlog.v1';
const PERSIST_MAX = 2000;
/** Writes are debounced: a script can emit hundreds of lines a second. */
let persistTimer = 0;

function persistRunLog(): void {
  if (typeof localStorage === 'undefined') return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        entries: runLog.slice(-PERSIST_MAX),
      }));
    } catch {
      // Quota, private mode, anything: losing the mirror is survivable and
      // must never break the log itself.
    }
  }, 1500) as unknown as number;
}

/**
 * Reload the previous run's tail, once, at startup.
 *
 * Entries are marked so nobody mistakes yesterday for now — a joined log whose
 * first thousand lines are from a different run, silently, would be worse than
 * not restoring it at all.
 */
export function restoreRunLog(): number {
  if (typeof localStorage === 'undefined' || runLog.length > 0) return 0;
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { v?: number; entries?: LogEntry[] };
    if (parsed.v !== 1 || !Array.isArray(parsed.entries)) return 0;
    for (const e of parsed.entries) {
      if (typeof e?.stamp !== 'string' || typeof e?.level !== 'string') continue;
      runLog.push({ ...e, previousRun: true });
    }
    emitRun();
    return parsed.entries.length;
  } catch {
    return 0;
  }
}
const runListeners = new Set<() => void>();
let runVersion = 0;
const labels = new Map<string, string>();

function emit(sessionId: string) {
  versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1);
  listeners.get(sessionId)?.forEach(fn => fn());
}

function emitRun() {
  runVersion++;
  runListeners.forEach(fn => fn());
}

/** Subscribe to run-log changes (exported for tests; useRunLog wraps it). */
export function subscribeRunLog(cb: () => void): () => void {
  runListeners.add(cb);
  return () => { runListeners.delete(cb); };
}

/** Monotonic change counter of the joined run log (the hook's snapshot). */
export function runLogVersion(): number {
  return runVersion;
}

/**
 * Name a session for the joined view — called once the connection config is
 * known. Entries written before it arrives keep whatever label was set then,
 * which is why the label is stored *on the entry*: renaming or reusing a
 * session id must not rewrite history.
 */
export function setSessionLabel(sessionId: string, label: string): void {
  labels.set(sessionId, label);
}

/**
 * The connection's name, for a caller that only has a session id.
 *
 * Panels take `sessionId` by contract (docs/PLUGINS.md) and mostly not the
 * connection name, so an audit entry from a panel used to have nowhere to get
 * it. Reading it here beats growing a prop on every panel.
 */
export function sessionLabel(sessionId: string): string | undefined {
  return labels.get(sessionId);
}

const p = (n: number, w = 2) => String(n).padStart(w, '0');

export function nowTs(): string {
  const d = new Date();
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** `[YYYY-MM-DD HH:MM:SS]` — the canonical line prefix (local time). */
export function fullStamp(): string {
  const d = new Date();
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

/** Fallback canonical text for entries written without an explicit `line`. */
function derivedLine(e: LogEntry): string {
  const meta = [
    e.rows != null ? `${e.rows} rows` : '',
    e.ms != null ? `${e.ms} ms` : '',
  ].filter(Boolean).join(' · ');
  return `${e.action} ${e.detail}${meta ? ` (${meta})` : ''}`;
}

/** The canonical message body without the timestamp prefix (UI list). */
export function messageOf(e: LogEntry): string {
  return e.line ?? derivedLine(e);
}

/** The full canonical line: `[YYYY-MM-DD HH:MM:SS] <message>`. */
export function canonicalLine(e: LogEntry): string {
  return `${e.stamp} ${messageOf(e)}`;
}

/**
 * Register the per-session sink that receives every canonical line as it is
 * emitted (server-log-to-directory). Pass null to clear. Fire-and-forget by
 * contract: the sink must swallow its own errors.
 */
export function setLogSink(sessionId: string, fn: ((line: string) => void) | null) {
  if (fn) sinks.set(sessionId, fn);
  else sinks.delete(sessionId);
}

export function addLog(sessionId: string, entry: Omit<LogEntry, 'ts' | 'stamp'> & { ts?: string; stamp?: string }) {
  const full: LogEntry = {
    ts: entry.ts ?? nowTs(), stamp: entry.stamp ?? fullStamp(),
    level: entry.level, action: entry.action, detail: entry.detail,
    ms: entry.ms, rows: entry.rows, execMs: entry.execMs, fetchMs: entry.fetchMs,
    line: entry.line,
    sessionId, label: labels.get(sessionId),
  };
  const arr = logs.get(sessionId) ?? [];
  arr.push(full);
  if (arr.length > MAX) arr.splice(0, arr.length - MAX);
  logs.set(sessionId, arr);
  emit(sessionId);
  // The joined view gets the same entry — including the ones written by a
  // session that is about to be dropped (DISCONNECT is the obvious one).
  runLog.push(full);
  if (runLog.length > MAX_RUN) runLog.splice(0, runLog.length - MAX_RUN);
  emitRun();
  persistRunLog();
  try { sinks.get(sessionId)?.(canonicalLine(full)); } catch { /* sink is best-effort */ }
}

export function clearLog(sessionId: string) {
  logs.set(sessionId, []);
  emit(sessionId);
}

/** Clear the joined run log. Deliberately separate: clearing one connection's
 *  log must not erase the record of everything else that was happening. */
export function clearRunLog(): void {
  runLog.length = 0;
  emitRun();
  // Clearing means clearing: leaving the mirror behind would resurrect it all
  // on the next start.
  try { localStorage?.removeItem(PERSIST_KEY); } catch { /* nothing to undo */ }
}

/**
 * Forget a session's own bucket — on disconnect.
 *
 * The run log is untouched **on purpose**: the connection you just closed is
 * the one you are about to want to read. Its label is kept too, so an export
 * still names it.
 */
export function dropLog(sessionId: string) {
  logs.delete(sessionId);
  versions.delete(sessionId);
  listeners.delete(sessionId);
  subscribeFns.delete(sessionId);
  sinks.delete(sessionId);
}

/** Canonical plain-text rendering (chronological, oldest first) for copy/export. */
export function formatLog(sessionId: string, header?: string): string {
  const arr = logs.get(sessionId) ?? [];
  const lines = arr.map(canonicalLine);
  return `${header ? header + '\n' + '─'.repeat(header.length) + '\n' : ''}${lines.join('\n')}\n`;
}

/**
 * The joined line: `[stamp] [connection] message`.
 *
 * The connection name is not decoration here — in a merged list, two
 * identical "3 rows affected in 12 ms" lines from two servers are otherwise
 * indistinguishable, which is precisely the confusion the joined view exists
 * to remove. Sessions whose label never arrived print their short id instead
 * of nothing, so every line can still be traced.
 */
export function runLine(e: LogEntry): string {
  const who = e.label ?? (e.sessionId ? e.sessionId.slice(0, 8) : '?');
  // The marker is on the line, not only in the UI, so an exported log cannot
  // present a previous run as part of this one.
  return `${e.stamp}${e.previousRun ? ' (previous run)' : ''} [${who}] ${messageOf(e)}`;
}

/** Every session's activity this run, chronological, for copy/export. */
export function formatRunLog(header?: string): string {
  const lines = runLog.map(runLine);
  return `${header ? header + '\n' + '─'.repeat(header.length) + '\n' : ''}${lines.join('\n')}\n`;
}

/** How many connections have written to the run log. */
export function runSessionCount(): number {
  return new Set(runLog.map(e => e.sessionId)).size;
}

const EMPTY: LogEntry[] = [];

/** Read-only view of the joined run log — for tests and non-React callers. */
export function runLogEntries(): readonly LogEntry[] {
  return runLog;
}

/**
 * The joined log of every session this run. The returned array is the live
 * internal buffer — treat it as read-only; a new version number (not a new
 * array identity) is what signals the change.
 */
export function useRunLog(): readonly LogEntry[] {
  useSyncExternalStore(subscribeRunLog, () => runVersion);
  return runLog;
}

// Stable per-session subscribe functions: a fresh identity per render would
// make useSyncExternalStore tear down and re-add the listener every render.
const subscribeFns = new Map<string, (cb: () => void) => () => void>();
function subscribeSession(sessionId: string) {
  let fn = subscribeFns.get(sessionId);
  if (!fn) {
    fn = (cb: () => void) => {
      let set = listeners.get(sessionId);
      if (!set) { set = new Set(); listeners.set(sessionId, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    };
    subscribeFns.set(sessionId, fn);
  }
  return fn;
}

/** Live read-only view of one session's log — same contract as useRunLog. */
export function useSessionLog(sessionId: string): readonly LogEntry[] {
  useSyncExternalStore(subscribeSession(sessionId), () => versions.get(sessionId) ?? 0);
  return logs.get(sessionId) ?? EMPTY;
}

/** Entry count of one session's log — re-renders only when the count moves. */
export function useSessionLogCount(sessionId: string): number {
  return useSyncExternalStore(
    subscribeSession(sessionId),
    () => logs.get(sessionId)?.length ?? 0,
  );
}

/** Has this session logged anything? Re-renders only on the 0↔1 transition. */
export function useSessionLogNonEmpty(sessionId: string): boolean {
  return useSyncExternalStore(
    subscribeSession(sessionId),
    () => (logs.get(sessionId)?.length ?? 0) > 0,
  );
}
