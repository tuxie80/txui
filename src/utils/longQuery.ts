/**
 * Long-running-query helpers — pure logic shared by the ⚡ Processes panel
 * (threshold highlighting/filtering) and the ⏱ Long query panel's watchdog.
 * Dependency-free so `node --test` can drive them (no React, no Tauri).
 */

/** 'warn' at >= threshold, 'danger' at >= 2× threshold, '' below. */
export function longClass(timeSecs: number, thresholdSecs: number): '' | 'warn' | 'danger' {
  if (!Number.isFinite(timeSecs) || thresholdSecs <= 0 || timeSecs < thresholdSecs) return '';
  return timeSecs >= thresholdSecs * 2 ? 'danger' : 'warn';
}

/** One-line, whitespace-collapsed SQL capped at `max` chars (with an ellipsis). */
export function truncateSql(sql: string, max = 160): string {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

// ── Watchdog list ─────────────────────────────────────────────────────────────

/** One row of a full-processlist poll (MySQL PROCESSLIST / pg_stat_activity). */
export interface WatchRow {
  id: number;
  /** seconds the query has been running (TIME / now()-query_start) */
  time: number;
  user: string;
  host: string;
  db: string;
  state: string;
  /** full statement text (truncation is a display concern) */
  sql: string;
}

export interface WatchEntry {
  id: number;
  user: string;
  host: string;
  db: string;
  state: string;
  sql: string;
  /** ms epoch when the query first crossed the threshold */
  firstSeen: number;
  /** ms epoch of the last poll that still saw it */
  lastSeen: number;
  /** last known age, seconds */
  age: number;
  /** disappeared from the processlist (finished or killed) */
  gone: boolean;
}

/** Hard cap so a busy server can't grow the list without bound. */
export const WATCH_LIST_CAP = 200;

export interface WatchUpdate {
  /** live first (oldest age first), then finished (most recently gone first) */
  entries: WatchEntry[];
  /** entries that crossed the threshold with THIS poll (for logging/pulse) */
  newOnes: WatchEntry[];
}

/**
 * Fold one poll into the detected-long-queries list (pure — `prev` entries are
 * never mutated, updated entries are copies):
 *  - rows with time >= threshold appear as entries (firstSeen stamped once);
 *  - entries still present at/above threshold update age/state/sql + lastSeen;
 *  - a live entry missing from the poll — or back BELOW threshold (the thread
 *    moved on to a new, short statement — MySQL TIME resets per statement) —
 *    is marked gone (kept until the UI clears finished entries);
 *  - a qualifying row whose id belongs to a GONE entry is a new query on a
 *    recycled thread/connection id: the stale record is replaced.
 */
export function updateWatchList(
  prev: WatchEntry[],
  rows: WatchRow[],
  thresholdSecs: number,
  nowMs: number,
): WatchUpdate {
  const byId = new Map(prev.map(e => [e.id, e]));
  const seen = new Set<number>();   // live entry ids confirmed by this poll
  const replaced = new Set<WatchEntry>(); // gone records superseded by id reuse
  const newOnes: WatchEntry[] = [];
  const live: WatchEntry[] = [];

  for (const r of rows) {
    if (r.time < thresholdSecs) continue;
    const ex = byId.get(r.id);
    if (ex && !ex.gone) {
      const u: WatchEntry = {
        ...ex, lastSeen: nowMs, age: r.time, state: r.state, sql: r.sql || ex.sql,
      };
      byId.set(r.id, u);
      seen.add(r.id);
      live.push(u);
    } else {
      if (ex) replaced.add(ex);
      const e: WatchEntry = {
        id: r.id, user: r.user, host: r.host, db: r.db, state: r.state,
        sql: r.sql, firstSeen: nowMs, lastSeen: nowMs, age: r.time, gone: false,
      };
      byId.set(r.id, e);
      newOnes.push(e);
      live.push(e);
    }
  }

  // Live entries the poll no longer confirms have finished (or were killed).
  const gone: WatchEntry[] = [];
  for (const e of prev) {
    if (replaced.has(e)) continue;           // superseded by a recycled id
    if (e.gone) gone.push(e);
    else if (!seen.has(e.id)) gone.push({ ...e, gone: true });
  }

  live.sort((a, b) => b.age - a.age);
  gone.sort((a, b) => b.lastSeen - a.lastSeen);
  let entries = [...live, ...gone];
  if (entries.length > WATCH_LIST_CAP) {
    // shed the oldest gone entries first; never shed live ones
    const keepGone = Math.max(0, WATCH_LIST_CAP - live.length);
    entries = [...live, ...gone.slice(0, keepGone)];
  }
  return { entries, newOnes };
}
