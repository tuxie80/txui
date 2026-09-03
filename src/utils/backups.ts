/**
 * Timed snapshots of an editor buffer, and the list you recover from.
 *
 * Buffers already survive a restart through `bufferStore`, which keeps the
 * *current* text. That answers "the app closed" and not "I deleted three
 * hundred lines twenty minutes ago and saved" — for which the only thing that
 * helps is an older copy. Notepad++'s periodic backup has saved a lot of
 * people; this is that.
 *
 * Snapshots live in the connection's own instance directory (see the Rust
 * `instancedata` module), so they belong to the server they were written
 * against and go away with it.
 *
 * Pure: the retention policy and the record shape. The I/O is in
 * `store/backupStore.ts`.
 */

export interface Snapshot {
  /** Tab label at the time, so the list is readable without opening each one. */
  label: string;
  /** Bound file path, when the buffer had one. */
  path?: string;
  /** Epoch ms. */
  at: number;
  text: string;
}

export interface BackupFile {
  version: 1;
  snapshots: Snapshot[];
}

export const BACKUP_KEY = 'backups';

/** How often a snapshot is taken, when the text has changed. */
export const BACKUP_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Retention.
 *
 * Two limits rather than one, because they fail differently. `MAX_SNAPSHOTS`
 * bounds the *list* so the recovery UI stays readable; `MAX_TOTAL_CHARS`
 * bounds the *file*, because thirty snapshots of a 2 MB script is 60 MB of
 * JSON that has to be parsed on every open.
 */
export const MAX_SNAPSHOTS = 40;
export const MAX_TOTAL_CHARS = 4_000_000;
/** A single buffer larger than this is not snapshotted at all. */
export const MAX_SNAPSHOT_CHARS = 1_000_000;

/**
 * Add a snapshot and apply retention, newest first.
 *
 * Skips a no-op: if the newest snapshot for this tab has identical text there
 * is nothing new to keep, and a timer firing every two minutes would otherwise
 * fill the list with copies of a file nobody is editing.
 */
export function addSnapshot(list: Snapshot[], snap: Snapshot): Snapshot[] {
  if (snap.text.length > MAX_SNAPSHOT_CHARS) return list;
  if (!snap.text.trim()) return list;
  const newestForTab = list.find(s => s.label === snap.label && s.path === snap.path);
  if (newestForTab?.text === snap.text) return list;
  return prune([snap, ...list]);
}

/**
 * Trim to the retention limits.
 *
 * Oldest go first on both counts. The character budget is applied after the
 * count so a handful of enormous snapshots cannot crowd out everything else.
 */
export function prune(list: Snapshot[]): Snapshot[] {
  const byCount = [...list]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SNAPSHOTS);
  const out: Snapshot[] = [];
  let total = 0;
  for (const s of byCount) {
    total += s.text.length;
    if (total > MAX_TOTAL_CHARS && out.length > 0) break;
    out.push(s);
  }
  return out;
}

export function parseBackups(text: string | null | undefined): Snapshot[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text) as { snapshots?: unknown };
    if (!Array.isArray(raw?.snapshots)) return [];
    return raw.snapshots.flatMap(v => {
      if (!v || typeof v !== 'object') return [];
      const o = v as Record<string, unknown>;
      if (typeof o.text !== 'string' || typeof o.at !== 'number') return [];
      return [{
        label: typeof o.label === 'string' ? o.label : 'untitled',
        // Spread, so a snapshot of an unbound buffer comes back without the
        // key rather than with an explicit `undefined` — round-trip equality
        // is what makes "has this changed?" answerable by comparison.
        ...(typeof o.path === 'string' ? { path: o.path } : {}),
        at: o.at,
        text: o.text,
      }];
    });
  } catch {
    return [];
  }
}

export function serializeBackups(snapshots: Snapshot[]): string {
  const file: BackupFile = { version: 1, snapshots };
  return JSON.stringify(file);
}

/** `14:32 · 3 min ago` — a snapshot list is read by *when*, not by name. */
export function describeAge(at: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - at) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
