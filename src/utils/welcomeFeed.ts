/**
 * Row shaping for the welcome screen's cross-server activity feed.
 *
 * The feed reads the same `audit_list` rows as the full 📜 Audit log and
 * turns each into one short line: session lifecycle events (connect /
 * connect failed / disconnect — written by the backend, source 'lifecycle')
 * read as "Connected" / "Connection failed" / "Disconnected — lasted 2 min 3 s",
 * and executed statements read as the
 * statement plus its duration or failure.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import { fmtDuration } from './fmtDuration.ts';

/** The subset of an `audit_list` row the feed reads. */
export interface FeedEntry {
  id: number;
  source?: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  connection_name: string;
  engine: string;
  ok: boolean;
  error: string | null;
  sql: string;
}

export interface FeedRow {
  id: number;
  /** Display timestamp — ms dropped, the log's own local-time text. A
      disconnect is stamped at the moment it HAPPENED (`ended_at`): its
      `started_at` is the session's start, by design (the row brackets the
      whole session), and showing it read as "disconnected at connect time". */
  when: string;
  connection: string;
  engine: string;
  text: string;
  ok: boolean;
}

const MAX_SQL = 80;

function shortSql(sql: string): string {
  const one = sql.trim().replace(/\s+/g, ' ');
  return one.length > MAX_SQL ? `${one.slice(0, MAX_SQL)}…` : one;
}

function describe(e: FeedEntry): string {
  if (e.source === 'lifecycle') {
    if (e.sql === 'connect') return 'Connected';
    if (e.sql === 'connect failed') return 'Connection failed';
    if (e.sql === 'disconnect') return `Disconnected — lasted ${fmtDuration(e.duration_ms)}`;
    return e.sql;
  }
  if (!e.ok) return `! ${e.error ?? 'failed'} — ${shortSql(e.sql)}`;
  return `${shortSql(e.sql)} — ${fmtDuration(e.duration_ms)}`;
}

/** Shape audit rows into feed lines, keeping the query's newest-first order. */
export function feedRows(entries: FeedEntry[]): FeedRow[] {
  return entries.map(e => ({
    id:         e.id,
    when:       (e.source === 'lifecycle' && e.sql === 'disconnect'
                  ? e.ended_at : e.started_at).slice(0, 19),
    connection: e.connection_name,
    engine:     e.engine,
    text:       describe(e),
    ok:         e.ok,
  }));
}
