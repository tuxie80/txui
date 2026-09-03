/**
 * Per-column grid filter model, shared by the query-result grid (client-side
 * matching) and the data browser (server-side WHERE). Text is matched against
 * the cell's display text (cellText), so NULL and JSON cells filter the way
 * they read.
 */
import { cellText } from './exporters.ts';

export interface ColumnFilter {
  column: string;
  text: string;
  /** true when picked from the value list (equality), false when typed (contains) */
  exact: boolean;
  /** the picked value was SQL NULL — matches null cells, not the string "NULL" */
  isNull?: boolean;
}

/** One entry of the top-5 list: display text + count() of occurrences. */
export interface TopValue {
  text: string;
  count: number;
  isNull?: boolean;
}

export function matchesFilter(v: unknown, f: ColumnFilter): boolean {
  if (f.isNull) return v === null || v === undefined;
  const t = cellText(v);
  return f.exact ? t === f.text : t.toLowerCase().includes(f.text.toLowerCase());
}

/** Top-N most frequent values (by display text) of an in-memory column. */
export function topValueCounts(values: unknown[], n: number): TopValue[] {
  const counts = new Map<string, { count: number; isNull: boolean }>();
  for (const v of values) {
    const isNull = v === null || v === undefined;
    const t = cellText(v);
    const e = counts.get(t);
    if (e) e.count++;
    else counts.set(t, { count: 1, isNull });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([text, e]) => ({ text, count: e.count, isNull: e.isNull }));
}
