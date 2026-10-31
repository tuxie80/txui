/**
 * Update policy — the pure half of the self-updater (store/updater.ts holds
 * the state; this decides what a version delta MEANS).
 *
 * Two functions, no I/O:
 *
 *   classifyUpdate('1.1.0', '1.2.0') → 'minor'
 *   updateAction('minor', { minor: true, major: false }) → 'auto'
 *
 * The Settings → Updates checkboxes gate auto-download per class; 'notify'
 * means the passive status-bar chip, 'ignore' means render nothing. A failed
 * check never reaches here — the store logs it and stays idle.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type UpdateClass = 'patch' | 'minor' | 'major' | 'none';
export type UpdateAction = 'auto' | 'notify' | 'ignore';

export interface UpdatePrefs {
  /** Auto-download patch + minor updates (Settings → Updates, default on). */
  minor: boolean;
  /** Auto-download major updates (default off — a major can change behaviour). */
  major: boolean;
}

/**
 * Parse a semver-ish version into [major, minor, patch], ignoring prerelease
 * and build tags (`1.2.0-rc.1` counts as 1.2.0 — we ship only finals, and a
 * prerelease must not fool the classifier into a wrong class). A leading `v`
 * is tolerated. Anything unparsable is null.
 */
function parse(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * What kind of step is current → latest? 'none' for equal, a downgrade, or an
 * unparsable version on either side (never auto-download on a guess).
 */
export function classifyUpdate(current: string, latest: string): UpdateClass {
  const c = parse(current);
  const l = parse(latest);
  if (!c || !l) return 'none';
  if (l[0] !== c[0]) return l[0] > c[0] ? 'major' : 'none';
  if (l[1] !== c[1]) return l[1] > c[1] ? 'minor' : 'none';
  if (l[2] !== c[2]) return l[2] > c[2] ? 'patch' : 'none';
  return 'none';
}

/** Given the class and the two prefs, what should the app do about it? */
export function updateAction(cls: UpdateClass, prefs: UpdatePrefs): UpdateAction {
  switch (cls) {
    case 'none':
      return 'ignore';
    case 'major':
      return prefs.major ? 'auto' : 'notify';
    case 'minor':
    case 'patch':
      return prefs.minor ? 'auto' : 'notify';
  }
}

export interface UpdateCandidateSelection<T> {
  update: T | null;
  major: T | null;
}

/** Choose the branch update to act on while retaining a separate major offer. */
export function selectUpdateCandidates<T extends { version: string }>(
  current: string,
  latest: T | null,
  branch: T | null,
): UpdateCandidateSelection<T> {
  const major = latest && classifyUpdate(current, latest.version) === 'major' ? latest : null;
  const branchCandidate = branch
    ?? (latest && classifyUpdate(current, latest.version) !== 'major' ? latest : null);
  const update = branchCandidate && classifyUpdate(current, branchCandidate.version) !== 'none'
    ? branchCandidate
    : major;
  return { update, major };
}
