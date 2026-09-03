/**
 * Merging a freshly fetched object-explorer level onto the tree that is
 * already on screen.
 *
 * Refresh used to rebuild the subtree from scratch, and every rebuilt node is
 * born collapsed — so right-clicking a database and choosing *Refresh* threw
 * away every expansion below it. Refreshing a list of tables should replace
 * the list, not close the tree you were reading.
 *
 * The rule: match old and new nodes by id (ids are deterministic —
 * `parentId::kind::name`), carry the **expansion state** across, and keep the
 * **new** children wherever the refresh actually fetched them. A node whose
 * children were lazily loaded and not re-fetched keeps the ones it had, so
 * nothing visible blinks out; the caller is responsible for re-loading those
 * if it wants them fresh.
 *
 * Objects that appeared since the last load arrive collapsed; objects that
 * are gone from the server are gone from the tree.
 *
 * Pure module: no React imports, unit-tested with `node --test`.
 */

/** The shape this merge needs — the real TreeNode has more fields. */
export interface Mergeable {
  id: string;
  expanded: boolean;
  children: Mergeable[] | null;
}

export function preserveExpansion<T extends Mergeable>(prev: T[] | null, next: T[]): T[] {
  if (!prev || prev.length === 0) return next;
  const byId = new Map(prev.map(n => [n.id, n]));

  return next.map(n => {
    const old = byId.get(n.id);
    if (!old) return n;   // new object since the last load — collapsed, as usual

    // Children the refresh actually produced win; recurse so their own
    // expansion survives too. Children it did not produce (a lazily loaded
    // level that was not re-fetched) are carried over as they were.
    const children = n.children === null
      ? (old.children as T[] | null)
      : preserveExpansion(old.children as T[] | null, n.children as T[]);

    return {
      ...n,
      // Expanded only makes sense with something to show.
      expanded: old.expanded && children !== null,
      children,
    };
  });
}

/**
 * Ids of the nodes under `rootId` that are open and hold lazily loaded
 * children — i.e. what `preserveExpansion` will keep on screen but stale.
 * The caller re-fetches these so that everything *visible* after a refresh is
 * actually fresh, not just the level that was right-clicked.
 *
 * `flat` is the flattened visible tree; each entry names its parent, which is
 * how descendancy is decided (ids are paths, but string-prefix matching would
 * break on a table whose name is a prefix of another).
 */
export function openDescendantIds(
  flat: Array<{ id: string; parent: string | null; expanded: boolean; children: unknown[] | null }>,
  rootId: string,
): string[] {
  const parentOf = new Map(flat.map(n => [n.id, n.parent]));
  const isUnder = (id: string): boolean => {
    // Walk up, bounded by the map size so a malformed cycle cannot hang.
    let cur = parentOf.get(id) ?? null;
    for (let i = 0; i <= parentOf.size && cur !== null; i++) {
      if (cur === rootId) return true;
      cur = parentOf.get(cur) ?? null;
    }
    return false;
  };
  return flat
    .filter(n => n.id !== rootId && n.expanded && n.children !== null && isUnder(n.id))
    .map(n => n.id);
}
