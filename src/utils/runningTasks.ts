/**
 * Rows for the status-bar "running" popover, derived from the tab-activity
 * registry (store/tabActivity) — one row per thing still running on a server:
 * the query, the generation job, the watched statement, the Playground mess.
 *
 * Shaping only: the registry owns the data and the kill closures; this module
 * turns them into display rows so the popover component stays dumb.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */
import { fmtDurationCompact } from './fmtDuration.ts';

/** Just enough of a registered activity to build a row (store/tabActivity). */
export interface ActivitySnapshot {
  id: string;
  label: string;
  detail: string;
  threads?: number[];
  /** epoch ms when the work started, stamped by the registry on registration */
  startedAt?: number;
  /** whether the activity carries a kill closure — the fact, not the closure */
  hasKill: boolean;
}

/** One registered activity plus where in the registry it lives. */
export interface ActivityEntry {
  /** registry key, e.g. "sess1|sql:3" — unique per tab */
  key: string;
  sessionId: string;
  activity: ActivitySnapshot;
}

export interface RunningTaskRow {
  /** unique per tab + activity — safe as a React key */
  key: string;
  sessionId: string;
  /** connection name, or the raw session id when the session is already gone */
  sessionName: string;
  label: string;
  detail: string;
  threads: number[];
  /** "12.3s" since start, or null when the registration carries no start time */
  elapsed: string | null;
  canStop: boolean;
}

/**
 * Flatten the registry into popover rows, in registration order (the caller
 * relies on row order to pair a row back to its kill closure).
 * `sessionName` resolves a session id to its display name; `now` is injected
 * so elapsed times are testable.
 */
export function collectRunningTasks(
  entries: ActivityEntry[],
  sessionName: (sessionId: string) => string | undefined,
  now: number,
): RunningTaskRow[] {
  return entries.map(({ key, sessionId, activity }) => ({
    key: `${key}:${activity.id}`,
    sessionId,
    sessionName: sessionName(sessionId) ?? sessionId,
    label: activity.label,
    detail: activity.detail,
    threads: activity.threads ?? [],
    elapsed: activity.startedAt != null ? fmtDurationCompact(now - activity.startedAt) : null,
    canStop: activity.hasKill,
  }));
}
