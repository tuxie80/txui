/**
 * What the `kill …` / `killall` popup remembers between openings.
 *
 * The popup is mounted and unmounted constantly — it appears the moment you
 * type `kill `, and disappears as soon as the text stops matching. Two things
 * must outlive that, and exactly two:
 *
 *   1. **the last poll**, so reopening paints rows instantly instead of an empty
 *      table. It is PROVISIONAL: the first real poll of a viewing session
 *      rebuilds the list (see `mergeRows`), so a snapshot can never carry a
 *      previous run's threads — least of all ones you just killed — into a
 *      fresh popup. It is ignored once older than `SEED_FRESH_MS`.
 *   2. **growth history**, because "this thread aged +7s" is a fact about the
 *      server, not about one popup. Discarding it on every retype made
 *      `killall` fall back to "not yet watched across two polls" each time.
 *
 * Everything else (marks, kill outcomes, the cursor) is per-viewing-session and
 * deliberately starts clean.
 */
import type { History, ProcInfo } from '../utils/killAnalyze';

/** A snapshot older than this is not worth painting. */
export const SEED_FRESH_MS = 4000;

/** One cached poll per session is plenty; drop the oldest beyond that. */
const LAST_POLL_MAX = 8;

const lastPoll = new Map<string, { at: number; procs: ProcInfo[] }>();
const histories = new Map<string, History>();

/** Remember this poll for an instant repaint on the next open. */
export function rememberPoll(sessionId: string, procs: ProcInfo[]) {
  if (!lastPoll.has(sessionId) && lastPoll.size >= LAST_POLL_MAX) {
    const oldest = lastPoll.keys().next().value;
    if (oldest !== undefined) lastPoll.delete(oldest);
  }
  lastPoll.set(sessionId, { at: Date.now(), procs });
}

/** Rows to paint before the first poll answers — empty when stale or unknown. */
export function seedProcs(sessionId: string): ProcInfo[] {
  const cached = lastPoll.get(sessionId);
  return cached && Date.now() - cached.at < SEED_FRESH_MS ? cached.procs : [];
}

/** The session's growth history, created on first use. */
export function historyFor(sessionId: string): History {
  let h = histories.get(sessionId);
  if (!h) { h = new Map(); histories.set(sessionId, h); }
  return h;
}

/**
 * Drop everything remembered about a session — called when the connection
 * closes, so neither map grows for the app's lifetime and a reconnect never
 * inherits a dead server's threads.
 */
export function forgetKillPickerState(sessionId: string) {
  histories.delete(sessionId);
  lastPoll.delete(sessionId);
}
