/**
 * Persistent editor undo history (Editor §5.2).
 *
 * Closing a tab throws away CodeMirror's undo stack, and so does quitting the
 * app. `bufferStore` already brings the *text* back; this brings back the
 * ability to walk it backwards — the twenty presses of ⌘Z you would otherwise
 * have lost with the tab.
 *
 * CodeMirror owns the actual serialization: `state.toJSON({ history:
 * historyField })` hands back an opaque JSON value, and `EditorState.fromJSON`
 * puts it back. This module only owns the *envelope* — the per-connection blob
 * that maps a stable buffer id to that opaque value — and the rules that keep
 * it from growing without bound or taking the app's storage down with it.
 *
 * The value under each buffer id is deliberately treated as opaque: we never
 * look inside it, so a change to CodeMirror's history format cannot break the
 * store, and a blob we cannot understand degrades to "no history" rather than a
 * crash (a missing undo stack is a small loss; a thrown error on tab open is
 * not). Pure and dependency-free — driven by `node --test`.
 */

/** Instance-storage key (see src-tauri `instdata`), one blob per connection. */
export const EDITOR_HISTORY_KEY = 'editor-undo-history';

/** Never keep undo stacks for more buffers than a connection can hold. */
export const MAX_HISTORY_BUFFERS = 40;

/**
 * Hard cap on the serialized blob. Undo stacks are unbounded in principle — a
 * session of heavy editing can produce a large one — and this store shares its
 * space with everything else the connection persists. When the blob would
 * exceed this, the largest stacks are shed first: losing the deepest history is
 * the least-bad outcome, and it is bounded here rather than at write time.
 */
export const MAX_HISTORY_BLOB_CHARS = 1_500_000;

/** The opaque CodeMirror `historyField` serialization. We never inspect it. */
export type SerializedHistory = unknown;

/** Buffer id → its serialized undo stack. */
export type HistoryBlob = Record<string, SerializedHistory>;

interface HistoryFile {
  v: 1;
  savedAt: number;
  hist: HistoryBlob;
}

/**
 * Parse a stored blob, tolerating anything (corrupt, older, hand-edited).
 *
 * Returns an empty map for anything unparseable rather than throwing — a
 * broken history blob must never stop a tab from opening.
 */
export function parseHistoryBlob(raw: string | null | undefined): HistoryBlob {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as Partial<HistoryFile>;
    if (!p || p.v !== 1 || !p.hist || typeof p.hist !== 'object') return {};
    const out: HistoryBlob = {};
    for (const [bid, val] of Object.entries(p.hist)) {
      // A null/absent value is "no stack" — skip it rather than store a hole.
      if (bid && val != null) out[bid] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/** The stored history for one buffer, or undefined when none is kept. */
export function getStoredHistory(blob: HistoryBlob, bid: string | undefined): SerializedHistory | undefined {
  if (!bid) return undefined;
  const v = blob[bid];
  return v == null ? undefined : v;
}

/**
 * Immutably set (or clear, when `value` is null/undefined) one buffer's stack.
 * Returns a new object so a caller can compare by reference.
 */
export function withHistory(blob: HistoryBlob, bid: string, value: SerializedHistory): HistoryBlob {
  const next = { ...blob };
  if (value == null) delete next[bid];
  else next[bid] = value;
  return next;
}

/** Keep only the buffer ids still open, so closed buffers do not linger forever. */
export function pruneHistory(blob: HistoryBlob, keepBids: Iterable<string>): HistoryBlob {
  const keep = new Set(keepBids);
  const out: HistoryBlob = {};
  for (const [bid, val] of Object.entries(blob)) {
    if (keep.has(bid)) out[bid] = val;
  }
  return out;
}

/**
 * Serialize a blob for storage, pruned to the buffers still open and capped in
 * both count and total size. When the cap bites, the *largest* stacks are shed
 * first — the deepest history is the most expensive and the least missed.
 */
export function serializeHistoryBlob(blob: HistoryBlob, keepBids?: Iterable<string>): string {
  let entries = Object.entries(blob).filter(([bid, v]) => bid && v != null);
  if (keepBids) {
    const keep = new Set(keepBids);
    entries = entries.filter(([bid]) => keep.has(bid));
  }

  // Measure each entry once; shed the biggest until the count and size fit.
  const sized = entries.map(([bid, v]) => {
    let cost: number;
    try { cost = JSON.stringify(v).length; } catch { cost = Infinity; }
    return { bid, v, cost };
  });
  // Anything that would not serialize at all cannot be kept.
  let kept = sized.filter(e => Number.isFinite(e.cost));

  if (kept.length > MAX_HISTORY_BUFFERS) {
    // Drop the largest first, then restore the original order for stability.
    kept = [...kept].sort((a, b) => b.cost - a.cost).slice(kept.length - MAX_HISTORY_BUFFERS);
  }

  const build = (list: typeof kept): string => {
    const hist: HistoryBlob = {};
    for (const e of list) hist[e.bid] = e.v;
    return JSON.stringify({ v: 1, savedAt: Date.now(), hist } satisfies HistoryFile);
  };

  // Shed the largest remaining stack until the whole blob fits the size cap.
  let ordered = [...kept].sort((a, b) => b.cost - a.cost);
  let out = build(kept);
  while (out.length > MAX_HISTORY_BLOB_CHARS && ordered.length > 0) {
    const drop = ordered[0];
    ordered = ordered.slice(1);
    kept = kept.filter(e => e !== drop);
    out = build(kept);
  }
  return out;
}
