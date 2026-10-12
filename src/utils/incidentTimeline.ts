/**
 * Incident timeline — pure logic for the 🕐 Incident timeline panel
 * (components/IncidentTimelinePanel.tsx). The backend (`incident_timeline`
 * command) owns the stores and the UTC/local timestamp normalization — every
 * event arrives already carrying `at_ms` (epoch ms), and NOTHING here parses a
 * timestamp string. Dependency-free so `node --test` can drive it (no React,
 * no Tauri).
 */

import { truncateSql } from './longQuery.ts';

/** The event kinds the backend can send (commands/history.rs). */
export type TimelineKind =
  | 'audit'
  | 'lifecycle'
  | 'deadlock'
  | 'digest_snapshot'
  | 'multi_run'
  | 'long_query'
  | 'galera_event';

export const TIMELINE_KINDS: readonly TimelineKind[] = [
  'audit', 'lifecycle', 'deadlock', 'digest_snapshot', 'multi_run', 'long_query', 'galera_event',
];

/** Short badge labels, one per kind. */
export const KIND_LABEL: Record<TimelineKind, string> = {
  audit: 'stmt',
  lifecycle: 'session',
  deadlock: 'deadlock',
  digest_snapshot: 'snapshot',
  multi_run: 'fleet run',
  long_query: 'long query',
  galera_event: 'galera',
};

/** One event of the timeline, as `incident_timeline` returns it (snake_case). */
export interface TimelineEvent {
  /** Stable key ("audit:1234") — the React row key, unique across kinds. */
  id: string;
  kind: TimelineKind;
  /** Epoch milliseconds — already normalized from the store's UTC/local text. */
  at_ms: number;
  title: string;
  detail: string;
  ok: boolean;
  duration_ms: number;
  /** The source row's id within its own store (audit_log.id, …). */
  ref_id: number;
}

/** Hard cap on rows the panel renders — mirrors the backend's clamp. */
export const TIMELINE_CAP = 2000;

/**
 * Merge events from every kind into one list: newest first, with a
 * deterministic tie-break on the stable id so same-millisecond events from
 * different stores do not shimmer between refreshes. `cap` keeps the newest.
 */
export function mergeTimeline(events: TimelineEvent[], cap = TIMELINE_CAP): TimelineEvent[] {
  const sorted = [...events].sort((a, b) =>
    b.at_ms - a.at_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.length > cap ? sorted.slice(0, cap) : sorted;
}

/** Keep only the enabled kinds. An empty set shows everything — a chip row
 *  with nothing ticked must not read as "nothing happened". */
export function filterKinds(
  events: TimelineEvent[], kinds: ReadonlySet<TimelineKind>,
): TimelineEvent[] {
  if (kinds.size === 0) return events;
  return events.filter(e => kinds.has(e.kind));
}

/** One bucket of the density strip: `start` is bucket-aligned epoch ms. */
export interface TimelineBucket {
  start: number;
  count: number;
  byKind: Partial<Record<TimelineKind, number>>;
}

/**
 * Fold events into fixed-width buckets for the density strip. Bucket edges
 * align to `bucketMs` multiples of the epoch (NOT to the first event), so the
 * strip does not shift when one event arrives. Only non-empty buckets are
 * returned, ascending.
 */
export function bucketize(events: TimelineEvent[], bucketMs: number): TimelineBucket[] {
  if (bucketMs <= 0) return [];
  const map = new Map<number, TimelineBucket>();
  for (const e of events) {
    const start = Math.floor(e.at_ms / bucketMs) * bucketMs;
    let b = map.get(start);
    if (!b) { b = { start, count: 0, byKind: {} }; map.set(start, b); }
    b.count += 1;
    b.byKind[e.kind] = (b.byKind[e.kind] ?? 0) + 1;
  }
  return [...map.values()].sort((a, b) => a.start - b.start);
}

/** A day section of the grouped list. */
export interface DayGroup {
  /** 'Today', 'Yesterday', or the local date 'YYYY-MM-DD'. */
  label: string;
  events: TimelineEvent[];
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * Group a (desc-sorted) list into day sections with friendly headers. The
 * input order is preserved within each section — sort with mergeTimeline
 * first. `nowMs` decides what "Today"/"Yesterday" mean (injectable for tests).
 */
export function groupByDay(events: TimelineEvent[], nowMs = Date.now()): DayGroup[] {
  const today = dayKey(nowMs);
  const yesterday = dayKey(nowMs - 86_400_000);
  const groups: DayGroup[] = [];
  let cur: DayGroup | null = null;
  for (const e of events) {
    const key = dayKey(e.at_ms);
    const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : key;
    if (!cur || cur.label !== label) {
      cur = { label, events: [] };
      groups.push(cur);
    }
    cur.events.push(e);
  }
  return groups;
}

/**
 * The one-line row title. Statement-shaped titles (SQL in any casing and
 * whitespace) collapse to one line and truncate; composed titles
 * ("Deadlock — victim …") pass through the same helper, which leaves a
 * single-line string untouched.
 */
export function summarizeTitle(ev: TimelineEvent, max = 140): string {
  return truncateSql(ev.title, max);
}

/** Local 'YYYY-MM-DD HH:MM:SS' — the from/to text the backend expects
 *  (lexicographic on the audit table's local stamps). */
export function localText(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 'HH:MM:SS' for the row's time column. */
export function timeOfDay(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
