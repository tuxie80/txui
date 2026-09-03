/**
 * What each tab currently has RUNNING on the server.
 *
 * Closing a tab used to be silent, which meant you could close away a running
 * query, a generating job, or a Playground full of live threads without ever
 * being told. Every tab that starts server-side work registers it here, and the
 * close path asks this registry first: if anything is running, the user gets a
 * window naming it, and decides — kill it, leave it running, or cancel.
 *
 * Keys are per tab: `sql:<tabId>` for a SQL tab, `panel:<name>` for a plugin
 * tab (a panel knows its own name, so it needs no extra prop), both scoped by
 * session id. Nothing here talks to the database; each activity carries its own
 * `kill` closure.
 */
import { useSyncExternalStore } from 'react';

export interface TabActivity {
  /** stable id within the tab (one tab may run several things) */
  id: string;
  /** one line: what it is, e.g. "Running query · 12s" */
  label: string;
  /** the meat: the statement, the job, the scenario */
  detail: string;
  /** server threads it holds, when known — shown so a kill is never blind */
  threads?: number[];
  /** true when it keeps running fine without this tab (server-side work) */
  survives: boolean;
  /** epoch ms of registration — the status bar shows elapsed-since-start */
  startedAt?: number;
  /** how to stop it; omitted when there is nothing the UI can cancel */
  kill?: () => void | Promise<void>;
}

const activities = new Map<string, TabActivity[]>();   // fullKey → activities
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach(fn => fn());
}

export const sqlTabKey = (sessionId: string, tabId: number) => `${sessionId}|sql:${tabId}`;
export const panelTabKey = (sessionId: string, panel: string) => `${sessionId}|panel:${panel}`;

/**
 * Register (or update) one activity of a tab.
 *
 * Only a change to the SET of running things notifies subscribers. Updating an
 * existing entry's payload (a progress counter, an elapsed second, a thread
 * list) is applied silently: subscribers only render "is this tab busy", and a
 * generator firing a progress event per 10k rows would otherwise re-render the
 * whole workspace — every mounted panel and grid — several times a second.
 * Payloads are read on demand (`getActivities`) when the close window opens.
 */
export function setActivity(key: string, activity: TabActivity) {
  const list = activities.get(key);
  if (list) {
    const i = list.findIndex(a => a.id === activity.id);
    // Progress updates re-register the same activity with a fresh payload;
    // keep the ORIGINAL start time so "elapsed" does not reset per update.
    if (i >= 0) { list[i] = { startedAt: list[i].startedAt, ...activity }; return; }  // update in place, no emit
    list.push({ startedAt: Date.now(), ...activity });
  } else {
    activities.set(key, [{ startedAt: Date.now(), ...activity }]);
  }
  emit();
}

/** Drop one activity — the work finished or was cancelled. */
export function clearActivity(key: string, id: string) {
  const list = activities.get(key);
  if (!list) return;
  const next = list.filter(a => a.id !== id);
  if (next.length) activities.set(key, next); else activities.delete(key);
  emit();
}

/** Forget everything a tab (or a whole session) registered. */
export function clearTabActivities(key: string) {
  if (activities.delete(key)) emit();
}

export function clearSessionActivities(sessionId: string) {
  let touched = false;
  for (const key of [...activities.keys()]) {
    if (key.startsWith(`${sessionId}|`)) { activities.delete(key); touched = true; }
  }
  if (touched) emit();
}

export function getActivities(key: string): TabActivity[] {
  return activities.get(key) ?? [];
}

/** Everything running anywhere in a session — used by the disconnect guard. */
export function getSessionActivities(sessionId: string): TabActivity[] {
  const out: TabActivity[] = [];
  for (const [key, list] of activities) {
    if (key.startsWith(`${sessionId}|`)) out.push(...list);
  }
  return out;
}

/**
 * Everything running anywhere, flattened — the status bar's "N running"
 * popover reads this on demand (payloads, like the close window's).
 */
export function getAllActivities(): { key: string; sessionId: string; activity: TabActivity }[] {
  const out: { key: string; sessionId: string; activity: TabActivity }[] = [];
  for (const [key, list] of activities) {
    const sessionId = key.slice(0, key.indexOf('|'));
    for (const activity of list) out.push({ key, sessionId, activity });
  }
  return out;
}

/** Re-render on any registry change (the tab bar shows a ⟳ per busy tab). */
export function useActivityVersion(): number {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => version,
  );
}

/**
 * Declare an activity for as long as `activity` is non-null. Panels call this
 * with their own key; unmounting does NOT clear it (server work outlives the
 * panel) — only passing null, or an explicit clear, does.
 */
export function reportActivity(key: string, activity: TabActivity | null) {
  if (activity) setActivity(key, activity);
  else clearTabActivities(key);
}
