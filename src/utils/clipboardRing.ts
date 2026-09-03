/**
 * Clipboard history / paste ring.
 *
 * The system clipboard keeps only the last copy, so hand-assembling a query
 * from several column names or values copied in turn loses all but the newest.
 * This module keeps a small, session-scoped ring of recent copies/cuts so a
 * paste-from-history command (⌘⇧V) can drop an earlier one back at the caret —
 * the paste ring Sublime and IntelliJ/DataGrip offer.
 *
 * State is module-level and in-memory only. It is scratch, not a preference:
 * it never touches the preferences store and is gone when the app restarts.
 */

/** How many clips to remember. Enough to cover a burst of copies, not a log. */
const MAX_CLIPS = 20;

// Newest first. Module-level so every editor instance shares one ring.
let ring: string[] = [];

/**
 * Record a copied/cut string. An identical entry already in the ring moves to
 * the front rather than duplicating; empty / whitespace-only text is ignored.
 * The ring is capped at MAX_CLIPS, dropping the oldest.
 */
export function pushClip(text: string): void {
  if (!text || !text.trim()) return;
  const existing = ring.indexOf(text);
  if (existing !== -1) ring.splice(existing, 1);
  ring.unshift(text);
  if (ring.length > MAX_CLIPS) ring.length = MAX_CLIPS;
}

/** Recent clips, newest first. A copy, so callers cannot mutate the ring. */
export function clips(): string[] {
  return ring.slice();
}

/** The clip at index `i` (0 = newest), or undefined when out of range. */
export function clipAt(i: number): string | undefined {
  return ring[i];
}

/** Drop every clip — for tests and a possible "clear history" action. */
export function clearClips(): void {
  ring = [];
}
