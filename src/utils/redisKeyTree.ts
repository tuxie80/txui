/**
 * Namespace tree for the Redis key browser.
 *
 * The SCAN-based key list arrives flat ("user:1", "user:2", "cache:page:home").
 * This module groups it by the `:`-style namespace convention into an
 * expandable tree — the same first-separator rule the backend's keyspace sweep
 * uses (`db/redis.rs::list_prefixes`): the namespace is everything up to the
 * FIRST of `:`, `|` or `/`, and keys with no separator are "bare".
 *
 * The tree is presentational only: it organises keys the browser has already
 * scanned. It never causes a `KEYS` call — the no-KEYS doctrine lives in the
 * SCAN cursor path, and this module only reshapes its output.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

/** Separators that delimit a namespace, in the order db/redis.rs checks them. */
export const KEY_SEPARATORS = [':', '|', '/'] as const;

export interface RedisKeyNode {
  /** Display segment including its separator, e.g. "user:". */
  name: string;
  /**
   * Full prefix from the keyspace root, e.g. "cache:page:" — unique across the
   * tree, so it doubles as the expand-state key.
   */
  prefix: string;
  /** Total keys at or below this node. */
  count: number;
  /** Keys that terminate exactly at this level (no further separator). */
  keys: string[];
  children: RedisKeyNode[];
}

export interface RedisKeyTree {
  /** Top-level namespaces, largest first (what a DBA is looking for). */
  namespaces: RedisKeyNode[];
  /** Keys with no separator at all, sorted. */
  bare: string[];
}

/** First separator index at or after `from`, or -1. */
function firstSep(key: string, from: number): number {
  let best = -1;
  for (const s of KEY_SEPARATORS) {
    const i = key.indexOf(s, from);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

function splitLevel(keys: string[], prefix: string): { nodes: RedisKeyNode[]; leaves: string[] } {
  const buckets = new Map<string, string[]>();
  const leaves: string[] = [];

  for (const k of keys) {
    const i = firstSep(k, prefix.length);
    // i === prefix.length means the separator is the first character of the
    // remainder (":odd", "a::b") — an empty segment is not a namespace, so the
    // key is a leaf here. db/redis.rs has the same guard (`Some(p) if p > 0`).
    if (i < 0 || i === prefix.length) {
      leaves.push(k);
      continue;
    }
    const seg = k.slice(prefix.length, i + 1);
    const arr = buckets.get(seg);
    if (arr) arr.push(k);
    else buckets.set(seg, [k]);
  }

  const nodes: RedisKeyNode[] = [];
  for (const [seg, members] of buckets) {
    const childPrefix = prefix + seg;
    const sub = splitLevel(members, childPrefix);
    nodes.push({
      name: seg,
      prefix: childPrefix,
      count: members.length,
      keys: sub.leaves,
      children: sub.nodes,
    });
  }
  // Largest namespaces first; alphabetical tiebreak so equal counts are stable.
  nodes.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  leaves.sort();
  return { nodes, leaves };
}

/**
 * Group a flat key list into a namespace tree. Input order does not matter;
 * the output is deterministically sorted (namespaces by size, keys A→Z).
 */
export function buildRedisKeyTree(keys: string[]): RedisKeyTree {
  const { nodes, leaves } = splitLevel([...keys], '');
  return { namespaces: nodes, bare: leaves };
}

/**
 * Auto-expansion rule for a freshly built tree: a single namespace is opened
 * outright, and small namespaces (≤ this many keys) open too — expanding
 * 400 namespaces of 2 keys each would drown the list in headers, and leaving
 * the only namespace closed would hide every key behind a click.
 */
export const AUTO_EXPAND_MAX = 25;

export function autoExpandedPrefixes(tree: RedisKeyTree): Set<string> {
  const out = new Set<string>();
  for (const n of tree.namespaces) {
    if (tree.namespaces.length === 1 || n.count <= AUTO_EXPAND_MAX) out.add(n.prefix);
  }
  return out;
}
