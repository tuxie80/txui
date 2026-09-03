/**
 * Labels — the functional grouping of servers.
 *
 * Folders are for orientation: they make a hundred connections navigable and
 * mean nothing else. **Labels are what functions operate on.** A label like
 * `cz-test` names a real set of servers — one primary and two replicas — and
 * every fleet check runs across that set: are the variables in sync, do the
 * indexes match, are the statistics fresh.
 *
 * Two consequences shape this module:
 *
 * **A connection has many labels.** The same server is `cz-test` *and*
 * `prod-eu` *and* whatever else it belongs to, and a check scoped to any of
 * them must find it. A single "group" field cannot express that, which is why
 * folders can never be the mechanism.
 *
 * **Some labels are plumbing.** A label that exists to drive a check, or to
 * mark a billing owner, should not spend a chip in the sidebar next to the ones
 * a person actually reads. Those are written with a leading dot — `.billing` —
 * exactly like a dotfile, and they group and filter identically while staying
 * out of the way.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export interface Label {
  /** Display name, without the hidden marker. Case is preserved. */
  name: string;
  /** Groups and filters, but is not shown as a chip. */
  hidden: boolean;
}

/** The character that marks a label hidden, in the text form. */
export const HIDDEN_PREFIX = '.';

/**
 * Labels are compared case-insensitively but stored as typed.
 *
 * `CZ-test` and `cz-test` naming different server sets would be a trap that
 * only shows up as a check silently covering two servers instead of three.
 */
export function labelKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Parse the comma-separated text form: `cz-test, prod-eu, .billing`.
 *
 * Duplicates collapse — and a label written both ways (`x` and `.x`) resolves
 * to **hidden**, because someone who marked it hidden anywhere meant it.
 */
export function parseLabels(text: string): Label[] {
  const out: Label[] = [];
  const seen = new Map<string, number>();
  for (const raw of text.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const hidden = token.startsWith(HIDDEN_PREFIX);
    const name = (hidden ? token.slice(HIDDEN_PREFIX.length) : token).trim();
    if (!name) continue;
    const key = labelKey(name);
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push({ name, hidden });
    } else if (hidden) {
      out[at].hidden = true;
    }
  }
  return out;
}

/** Back to the text form, so the editor round-trips exactly. */
export function formatLabels(labels: Label[]): string {
  return labels.map(l => (l.hidden ? HIDDEN_PREFIX + l.name : l.name)).join(', ');
}

/** The ones that earn a chip in the sidebar. */
export function visibleLabels(labels: Label[]): Label[] {
  return labels.filter(l => !l.hidden);
}

/**
 * Upgrade the old free-form `tags` to labels.
 *
 * Everything that was a tag becomes a visible label — tags were only ever
 * displayed, so nothing was ever meant to be hidden. Kept as a function rather
 * than a one-off script because a connection can arrive from an import file at
 * any time, long after the in-place migration ran.
 */
export function labelsFromTags(tags: string[] | undefined): Label[] {
  return parseLabels((tags ?? []).join(','));
}

// ── the index: label → the servers it names ─────────────────────────────────

export interface Labelled {
  id: string;
  name: string;
  labels?: Label[];
  /** Kept for connections not yet migrated. */
  tags?: string[];
}

/** A connection's labels, wherever they currently live. */
export function labelsOf(c: Labelled): Label[] {
  return c.labels && c.labels.length > 0 ? c.labels : labelsFromTags(c.tags);
}

export function hasLabel(c: Labelled, name: string): boolean {
  const want = labelKey(name);
  return labelsOf(c).some(l => labelKey(l.name) === want);
}

export interface LabelGroup {
  /** As first seen, so the sidebar shows the casing the user typed. */
  name: string;
  hidden: boolean;
  members: Labelled[];
}

/**
 * Every label across a set of connections, with its members.
 *
 * Sorted by member count then name: a label naming eight servers is more likely
 * to be the one you want than one naming a single server, and an alphabetical
 * list buries it.
 *
 * A label counts as hidden only when **every** connection carrying it marks it
 * hidden — one server showing it is a deliberate act, and silently suppressing
 * it would leave that person with no way to see what they asked for.
 */
export function groupByLabel(connections: Labelled[]): LabelGroup[] {
  const groups = new Map<string, LabelGroup>();
  for (const c of connections) {
    for (const l of labelsOf(c)) {
      const key = labelKey(l.name);
      const g = groups.get(key);
      if (g) {
        g.members.push(c);
        g.hidden = g.hidden && l.hidden;
      } else {
        groups.set(key, { name: l.name, hidden: l.hidden, members: [c] });
      }
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
}

/** The labels worth running a fleet check against — more than one server. */
export function fleetLabels(connections: Labelled[]): LabelGroup[] {
  return groupByLabel(connections).filter(g => g.members.length > 1);
}

/**
 * Does this text match the connection, including its hidden labels?
 *
 * Hidden means "not shown", never "not findable" — a label you cannot search
 * for is a label you cannot use.
 */
export function matchesLabelSearch(c: Labelled, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return labelsOf(c).some(l => l.name.toLowerCase().includes(q));
}
