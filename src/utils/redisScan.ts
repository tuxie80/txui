/**
 * SCAN page merging for the Redis key browser (src/components/RedisBrowser.tsx).
 *
 * Redis SCAN is explicitly allowed to return the same key on two pages, so
 * concatenating pages can list a key twice — and two rows with the same React
 * key. Pages merge through a Set, first-seen order kept.
 *
 * Pure and dependency-free — driven by `node --test` (tests/redisScan.test.ts).
 */

/** Merge one SCAN page into the accumulated list, dropping duplicates. */
export function mergeScannedKeys(prev: string[], next: string[]): string[] {
  const seen = new Set(prev);
  const out = [...prev];
  for (const k of next) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}
