/**
 * `dbgui:conn-log` — the connection-lifecycle event bus (W5.0).
 *
 * Sidebar connect/test/diagnose and App's scratch/disconnect/reconnect paths
 * dispatch this window CustomEvent with `{ level, msg, sessionId? }`; ONE
 * listener (App mount) turns it into a canonical session-log entry. This
 * module is the pure half: shaping the detail into a log entry, and deciding
 * which session's log receives it.
 *
 * Targeting rule: an explicit `sessionId` wins; without one the entry goes to
 * the currently ACTIVE session (a connect failure from the sidebar belongs to
 * whatever you are looking at, not nowhere); without either it is dropped —
 * inventing a home for it would put one connection's words in another's log.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */

export type ConnLogLevel = 'info' | 'ok' | 'err' | 'warn';

/** The CustomEvent detail. Every field but the message is optional — the four
 *  dispatch sites predate the listener and some have no session in scope. */
export interface ConnLogDetail {
  level?: string;
  msg?: string;
  sessionId?: string | null;
}

/** What addLog() is called with (store/logStore.ts's entry minus stamps). */
export interface ConnLogEntry {
  level: ConnLogLevel;
  action: 'CONNECT';
  detail: string;
  /** Canonical one-line text — explicit, never the derived fallback. */
  line: string;
}

const LEVELS: readonly string[] = ['info', 'ok', 'err', 'warn'];

/** Detail → log entry, or null when there is nothing worth writing. */
export function connLogEntry(d: ConnLogDetail | null | undefined): ConnLogEntry | null {
  const msg = (d?.msg ?? '').trim();
  if (!msg) return null;
  const level = (LEVELS.includes(d?.level ?? '') ? d!.level : 'info') as ConnLogLevel;
  return { level, action: 'CONNECT', detail: msg, line: msg };
}

/** Which session's log receives the entry (see the header for the rule). */
export function connLogTarget(
  d: ConnLogDetail | null | undefined,
  activeSessionId: string | null,
): string | null {
  const explicit = typeof d?.sessionId === 'string' && d.sessionId ? d.sessionId : null;
  return explicit ?? (activeSessionId || null);
}
