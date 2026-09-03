/**
 * Recency/frequency ranking for completions.
 *
 * The schema completion list is structural — it can't know that on THIS session
 * you keep joining `orders` to `customers`. This keeps a small in-memory tally
 * of the identifiers you actually run, and turns it into a modest completion
 * boost so your working set floats to the top. Deliberately bounded and modest
 * (0–8) so it refines ordering within a category without overriding the
 * structural boosts (PK columns, in-scope tables, …).
 *
 * In-memory and per-app-run on purpose: it's a "what am I working on right now"
 * signal, not durable history. Pure and dependency-free — driven by node --test.
 */

const scores = new Map<string, number>();
const CAP = 64;

/** Record use of these identifiers (case-insensitive). */
export function bumpUsage(idents: Iterable<string>): void {
  for (const raw of idents) {
    const k = raw.toLowerCase();
    if (!k) continue;
    scores.set(k, Math.min(CAP, (scores.get(k) ?? 0) + 1));
  }
}

/** Tokenize a statement and bump every word that is a known schema identifier. */
export function bumpUsageFromSql(sql: string, known: Set<string>): void {
  const words = sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g);
  if (!words) return;
  bumpUsage(words.filter(w => known.has(w)));
}

/** A modest completion boost (0–8) reflecting how often `label` has been used. */
export function usageBoost(label: string): number {
  const s = scores.get(label.toLowerCase()) ?? 0;
  if (s <= 0) return 0;
  return Math.min(8, 1 + Math.floor(Math.log2(s + 1) * 2));
}

/** Test hook — reset the tally. */
export function _resetUsage(): void { scores.clear(); }
