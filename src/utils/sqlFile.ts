/**
 * A tab's link to a file on disk.
 *
 * Before this, opening a `.sql` file handed the editor `{ name, text }` and
 * threw the path away — so a tab knew what it was *called* but not where it
 * came from, `⌘S` could only ever be *Save As*, and nothing could tell whether
 * the buffer still matched the file. Every one of those follows from the
 * missing path.
 *
 * Pure: the model, the dirty test and the recent-files list. The I/O is in
 * `store/sqlFileStore.ts` and the Rust `sqlfile` module.
 */

/** Line endings, mirroring the Rust `sqlfile::Eol`. */
export type Eol = 'lf' | 'crlf' | 'cr' | 'mixed';

export interface FileBinding {
  path: string;
  /** Encoding label the file was read with, and will be written back as. */
  encoding: string;
  eol: Eol;
  /** mtime as of the last read or write, for change detection. */
  mtimeMs: number;
  /**
   * The text as it stands on disk.
   *
   * Kept so "dirty" can mean *differs from the file* rather than *has been
   * typed in*, which is the distinction that makes a dirty marker worth
   * showing. Costs one extra copy of the document per open file — acceptable
   * at the 32 MB ceiling the reader enforces.
   */
  savedText: string;
}

/** Does the buffer differ from what is on disk? */
export function isDirty(file: FileBinding | undefined, current: string): boolean {
  if (!file) return false;
  return file.savedText !== current;
}

/** `orders.sql` from a full path, on either platform's separator. */
export function baseName(path: string): string {
  const seg = path.split(/[/\\]/).pop() ?? path;
  return seg || path;
}

/** The label a tab shows for a file: its name, without the `.sql`. */
export function tabLabelFor(path: string): string {
  return baseName(path).replace(/\.(sql|txt)$/i, '') || 'query';
}

/**
 * The directory part, for "search in this file's folder" and for the Save As
 * dialog's starting point.
 */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : '';
}

/**
 * Has the file changed underneath us?
 *
 * Deliberately mtime-only. A content hash would be exact but means reading the
 * whole file on every window focus; mtime is what every editor in this class
 * uses, and the failure mode (a change with an unchanged mtime) needs a tool
 * actively preserving timestamps.
 *
 * `null` for the stat means the file is gone — a different situation, and the
 * caller must not treat it as unchanged.
 */
export type DiskState = 'same' | 'changed' | 'deleted';

export function diskState(file: FileBinding, stat: { mtimeMs: number } | null): DiskState {
  if (stat === null) return 'deleted';
  return stat.mtimeMs === file.mtimeMs ? 'same' : 'changed';
}

// ── Recent files ────────────────────────────────────────────────────────────

export const RECENT_KEY = 'dbgui.recentSqlFiles';
export const RECENT_MAX = 15;

/**
 * Push a path to the front of the recent list, de-duplicated.
 *
 * Case-sensitively, on purpose: on Linux `Orders.sql` and `orders.sql` are two
 * files, and folding them would hide one behind the other.
 */
export function pushRecent(list: string[], path: string, max = RECENT_MAX): string[] {
  const without = list.filter(p => p !== path);
  return [path, ...without].slice(0, max);
}

export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * How the recent list is shown: the file name, plus enough of the path to tell
 * two files with the same name apart.
 *
 * Four `migrations/up.sql` entries are useless; the disambiguator is the parent
 * directory, added only where a name repeats.
 */
export function recentLabels(paths: string[]): Array<{ path: string; label: string }> {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const n = baseName(p);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return paths.map(p => {
    const n = baseName(p);
    if ((counts.get(n) ?? 0) < 2) return { path: p, label: n };
    const parent = baseName(dirName(p));
    return { path: p, label: parent ? `${parent}/${n}` : n };
  });
}
