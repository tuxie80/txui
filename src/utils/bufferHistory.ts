/**
 * Versions of an editor buffer, so an overwrite is recoverable.
 *
 * `utils/bufferStore` already keeps the *current* text across restarts. That
 * covers the crash. It does not cover the thing that actually loses work: you
 * select all, paste something else, and the query you spent an hour on is gone
 * — with undo history that dies when the tab does, and no git, because this was
 * never a file.
 *
 * DataGrip calls it Local History and it is one of the quiet reasons people
 * trust it. The rules that make it useful rather than noise:
 *
 *   - **Snapshot on meaningful change, not on keystroke.** A version per
 *     character is a list nobody can read.
 *   - **Always snapshot before a large deletion.** That is the moment the work
 *     disappears, and it is exactly when a debounce would not have fired yet.
 *   - **Never store an empty buffer as a version.** Recovering to nothing is
 *     not recovery.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export interface BufferVersion {
  /** ms epoch, supplied by the caller so this module stays pure. */
  at: number;
  text: string;
  /** Why it was kept — shown in the timeline. */
  reason: 'edit' | 'shrink' | 'run' | 'manual';
  /** Characters added (+) or removed (−) relative to the previous version. */
  delta: number;
}

/** Versions kept per buffer. Enough to walk back through a session's work. */
export const MAX_VERSIONS = 50;

/** Below this many characters changed, an edit is not worth its own version. */
export const MIN_EDIT_DELTA = 40;

/** Minimum gap between routine edit snapshots. */
export const MIN_INTERVAL_MS = 30_000;

/**
 * A deletion this large is treated as the event worth capturing, whatever the
 * timing rules say. Losing a paragraph is the case this whole module exists for.
 */
export const SHRINK_CHARS = 120;

/** Proportion of the buffer whose removal counts as a shrink regardless of size. */
export const SHRINK_RATIO = 0.4;

export interface SnapshotDecision {
  keep: boolean;
  reason: BufferVersion['reason'];
}

/**
 * Should `next` be kept as a version, given what came before?
 *
 * Split out from the mutation so the policy can be tested on its own — the
 * policy is the whole design, and it is the part that is easy to get subtly
 * wrong in a way nobody notices until they need a version that was never taken.
 */
export function shouldSnapshot(
  previous: BufferVersion | undefined, next: string, now: number,
  trigger: 'edit' | 'run' | 'manual' = 'edit',
): SnapshotDecision {
  // Recovering to an empty buffer is not recovery.
  if (!next.trim()) return { keep: false, reason: 'edit' };

  if (trigger === 'manual') return { keep: true, reason: 'manual' };
  if (!previous) return { keep: true, reason: trigger === 'run' ? 'run' : 'edit' };
  if (previous.text === next) return { keep: false, reason: 'edit' };

  const delta = next.length - previous.text.length;
  const shrank = -delta >= SHRINK_CHARS
    || (previous.text.length > 0 && -delta >= previous.text.length * SHRINK_RATIO);

  // A large deletion is captured immediately: it is the moment the work
  // disappears, and it is precisely when a time-based rule has not fired yet.
  if (shrank) return { keep: true, reason: 'shrink' };

  // Running a statement is a natural bookmark — "this is the version that ran".
  if (trigger === 'run') return { keep: true, reason: 'run' };

  const enoughTime = now - previous.at >= MIN_INTERVAL_MS;
  const enoughChange = Math.abs(delta) >= MIN_EDIT_DELTA;
  return { keep: enoughTime && enoughChange, reason: 'edit' };
}

/**
 * Add a version if the policy says so; otherwise return the list unchanged.
 *
 * Returns the same array reference when nothing was kept, so a caller can skip
 * a re-render cheaply.
 */
export function snapshot(
  versions: BufferVersion[], text: string, now: number,
  trigger: 'edit' | 'run' | 'manual' = 'edit',
): BufferVersion[] {
  const previous = versions[versions.length - 1];
  const { keep, reason } = shouldSnapshot(previous, text, now, trigger);
  if (!keep) return versions;

  const delta = previous ? text.length - previous.text.length : text.length;
  const next = [...versions, { at: now, text, reason, delta }];
  return next.length > MAX_VERSIONS ? next.slice(next.length - MAX_VERSIONS) : next;
}

/** A short human label for a version, for the timeline list. */
export function describeVersion(v: BufferVersion, now: number): string {
  const secs = Math.max(0, Math.round((now - v.at) / 1000));
  const when = secs < 60 ? `${secs}s ago`
    : secs < 3600 ? `${Math.round(secs / 60)}m ago`
    : `${Math.round(secs / 3600)}h ago`;
  const size = v.delta === 0 ? ''
    : ` ${v.delta > 0 ? '+' : '−'}${Math.abs(v.delta)}`;
  const label: Record<BufferVersion['reason'], string> = {
    edit: 'edited', shrink: 'deleted', run: 'ran', manual: 'saved',
  };
  return `${when} · ${label[v.reason]}${size}`;
}

/**
 * A line-level diff between two versions, for the preview.
 *
 * Longest-common-subsequence over lines. A word diff would be prettier and is
 * the wrong tool: what a reader is checking is "is the block I lost in there",
 * which is a line question.
 */
export type DiffLine = { kind: ' ' | '+' | '-'; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Classic LCS table. Buffers here are editor-sized, so O(n·m) is fine; the
  // cap below keeps a pathological paste from freezing the UI.
  const CAP = 2000;
  if (a.length > CAP || b.length > CAP) {
    return [
      { kind: '-', text: `… ${a.length} lines` },
      { kind: '+', text: `… ${b.length} lines` },
    ];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 },
    () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: ' ', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: '-', text: a[i] }); i++; }
    else { out.push({ kind: '+', text: b[j] }); j++; }
  }
  while (i < a.length) out.push({ kind: '-', text: a[i++] });
  while (j < b.length) out.push({ kind: '+', text: b[j++] });
  return out;
}

/** Counts for a one-line summary of a diff. */
export function diffSummary(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter(l => l.kind === '+').length,
    removed: lines.filter(l => l.kind === '-').length,
  };
}

// ── storage ──────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'dbgui.history.';

/** Storage key for one buffer, keyed the same way bufferStore keys its text. */
export function historyKey(connectionId: string, tabId: number): string {
  return `${KEY_PREFIX}${connectionId}:${tabId}`;
}

/**
 * Read a buffer's versions.
 *
 * Returns an empty list for anything unparseable rather than throwing —
 * corrupt history must never stop the editor from opening.
 */
export function loadHistory(key: string, storage: Storage): BufferVersion[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v: unknown): v is BufferVersion =>
      !!v && typeof v === 'object'
      && typeof (v as BufferVersion).text === 'string'
      && typeof (v as BufferVersion).at === 'number');
  } catch {
    return [];
  }
}

/**
 * Write a buffer's versions, shedding the oldest until it fits.
 *
 * localStorage quota is shared with everything else in the app, so history
 * losing its oldest entries is correct; history taking the app's storage down
 * with it is not.
 */
export function saveHistory(key: string, versions: BufferVersion[], storage: Storage): void {
  let list = versions;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      storage.setItem(key, JSON.stringify(list));
      return;
    } catch {
      if (list.length <= 1) {
        try { storage.removeItem(key); } catch { /* nothing more to do */ }
        return;
      }
      list = list.slice(Math.ceil(list.length / 2));
    }
  }
}
