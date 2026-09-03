/**
 * Open Anything — the ranking behind the unified ⌘K palette.
 *
 * ONE fuzzy surface over everything the app can open: commands, connections,
 * sessions, schema objects (tables / views / routines), columns and saved
 * queries. Results come back SECTIONED (a fixed section order, fuzzy-ranked
 * within each section) rather than interleaved — a mediocre command match
 * must never push the exact table you typed off the screen, and "where in
 * the list is the thing" stays predictable as the catalog grows.
 *
 * `table.column` matching: an entry's `qualified` text (`schema.table` for
 * an object, `schema.table.column` for a column) is scored alongside its
 * label, and the shared subsequence matcher (utils/fuzzy) threads a dotted
 * query through it — "ord.tot" reaches `shop.orders.total` even though the
 * column's bare label is just `total`.
 *
 * Everything is capped per section and overall: a 10k-object catalog is
 * scored in a handful of milliseconds (the matcher is O(text) per entry),
 * but the palette must never render it.
 *
 * Pure module — no React/Tauri — unit-tested with `node --test`.
 */
import { fuzzyScore } from './fuzzy.ts';

/** The sections a palette entry can belong to. */
export type OpenSection =
  | 'command' | 'connection' | 'session' | 'table' | 'column' | 'saved' | 'recent';

/**
 * Canonical display order — the requirement list, with recent files last:
 * Commands / Connections / Sessions / Tables / Columns / Saved queries.
 */
export const SECTION_ORDER: readonly OpenSection[] = [
  'command', 'connection', 'session', 'table', 'column', 'saved', 'recent',
];

/** Header text per section, rendered by the palette. */
export const SECTION_TITLES: Record<OpenSection, string> = {
  command: 'Commands',
  connection: 'Connections',
  session: 'Sessions',
  table: 'Tables & objects',
  column: 'Columns',
  saved: 'Saved queries',
  recent: 'Recent files',
};

/** Entries without an explicit section land here (SqlEditor's Find Action). */
const DEFAULT_SECTION: OpenSection = 'command';

export const DEFAULT_PER_SECTION = 10;
export const DEFAULT_LIMIT = 50;

/** A category hit is weaker evidence than a name hit (mirrors commandRegistry). */
const KEYWORD_PENALTY = 5;

export interface OpenEntry {
  id: string;
  label: string;
  /** Extra searchable text (e.g. a command's category) beyond the label. */
  keywords?: string;
  /**
   * Dotted full name — `schema.table` for an object, `schema.table.column`
   * for a column. Scored alongside the label so `a.b` queries resolve.
   */
  qualified?: string;
  /** Section the entry is grouped under; defaults to 'command'. */
  section?: OpenSection;
}

export interface OpenAnythingOptions {
  /** Restrict the search to these sections — ⌘P passes ['table', 'column']. */
  onlySections?: readonly OpenSection[];
  /** Max entries kept per section. */
  perSection?: number;
  /** Max entries returned overall. */
  limit?: number;
}

export interface OpenSectionGroup<T> {
  section: OpenSection;
  title: string;
  items: T[];
}

/** Best fuzzy score of an entry against a non-empty query; null = no match. */
function scoreEntry(e: OpenEntry, q: string): number | null {
  let best = fuzzyScore(q, e.label);
  if (e.keywords) {
    const kw = fuzzyScore(q, e.keywords);
    if (kw !== null) {
      const adjusted = kw - KEYWORD_PENALTY;
      best = best === null ? adjusted : Math.max(best, adjusted);
    }
  }
  if (e.qualified) {
    const qs = fuzzyScore(q, e.qualified);
    if (qs !== null) best = best === null ? qs : Math.max(best, qs);
  }
  return best;
}

/**
 * Sectioned fuzzy search. An empty query keeps input order within each
 * section (the caller's curation — recents first, catalog alphabetical);
 * a typed query ranks by fuzzy score inside each section, stable on ties.
 * Sections always come back in SECTION_ORDER, empty ones omitted.
 */
export function searchOpenAnything<T extends OpenEntry>(
  entries: readonly T[],
  query: string,
  opts: OpenAnythingOptions = {},
): OpenSectionGroup<T>[] {
  const perSection = opts.perSection ?? DEFAULT_PER_SECTION;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const allowed = opts.onlySections ? new Set(opts.onlySections) : null;
  const q = query.trim();

  const bySection = new Map<OpenSection, T[]>();
  const offer = (e: T, s: OpenSection) => {
    const list = bySection.get(s);
    if (list) { if (list.length < perSection) list.push(e); }
    else bySection.set(s, [e]);
  };

  if (!q) {
    for (const e of entries) {
      const s = e.section ?? DEFAULT_SECTION;
      if (allowed && !allowed.has(s)) continue;
      offer(e, s);
    }
  } else {
    const scored: { e: T; s: OpenSection; score: number; idx: number }[] = [];
    entries.forEach((e, idx) => {
      const s = e.section ?? DEFAULT_SECTION;
      if (allowed && !allowed.has(s)) return;
      const score = scoreEntry(e, q);
      if (score !== null) scored.push({ e, s, score, idx });
    });
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    for (const { e, s } of scored) offer(e, s);
  }

  const groups: OpenSectionGroup<T>[] = [];
  let total = 0;
  for (const s of SECTION_ORDER) {
    if (total >= limit) break;
    const items = bySection.get(s);
    if (!items || items.length === 0) continue;
    const trimmed = items.slice(0, Math.min(items.length, limit - total));
    groups.push({ section: s, title: SECTION_TITLES[s], items: trimmed });
    total += trimmed.length;
  }
  return groups;
}
