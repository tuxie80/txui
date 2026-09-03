/**
 * Line-level tally for the SQL compare panel's toolbar badge.
 *
 * The MergeView draws the diff; this just counts it so the toolbar can say
 * "identical" or "+3  −2" at a glance. Built on the existing LCS `lineDiff`
 * so the badge and the on-screen pairing can never disagree.
 */
import { lineDiff } from './lineDiff.ts';

export interface DiffStats {
  /** Lines present only on the right (added, B-side). */
  added: number;
  /** Lines present only on the left (removed, A-side). */
  removed: number;
  /** Lines shared by both sides. */
  same: number;
  /** No additions and no removals — the two texts match line-for-line. */
  identical: boolean;
}

export function diffStats(left: string, right: string): DiffStats {
  const rows = lineDiff(left, right);
  let added = 0, removed = 0, same = 0;
  for (const r of rows) {
    if (r.type === 'add') added++;
    else if (r.type === 'del') removed++;
    else same++;
  }
  return { added, removed, same, identical: added === 0 && removed === 0 };
}

/**
 * Toolbar label for a tally: "Identical" when the sides match, otherwise the
 * non-zero counts as "+N" (added) and "−N" (removed, real minus sign).
 */
export function summarizeDiff(stats: DiffStats): string {
  if (stats.identical) return 'Identical';
  const parts: string[] = [];
  if (stats.added) parts.push(`+${stats.added}`);
  if (stats.removed) parts.push(`−${stats.removed}`);
  return parts.join('  ');
}
