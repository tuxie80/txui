/**
 * Value-view helpers for the Redis key browser (src/components/RedisBrowser.tsx).
 *
 * The backend caps collection reads (200 items for list/hash/set/zset, 50 for
 * a stream) while the detail header knows the real cardinality. A capped page
 * posing as the whole value is a lie by omission, so the view says
 * "showing 200 of 41,203" when the two disagree.
 *
 * Pure and dependency-free — driven by `node --test` (tests/redisValue.test.ts).
 */

/** Structural minimum of the component's RedisValue union. */
interface RedisValueShape {
  type: string;
  items?: unknown[];
  fields?: unknown[];
  members?: unknown[];
  entries?: unknown[];
}

/** How many items a fetched collection value holds; null for non-collections. */
export function valueItemCount(value: RedisValueShape): number | null {
  switch (value.type) {
    case 'list':   return value.items?.length ?? null;
    case 'hash':   return value.fields?.length ?? null;
    case 'set':    return value.members?.length ?? null;
    case 'zset':
    case 'stream': return value.entries?.length ?? null;
    default:       return null;
  }
}

/**
 * "showing 200 of 41,203" when the view holds fewer items than the key, null
 * when nothing is hidden — an uncapped value earns no banner.
 */
export function shownOfTotal(shown: number, total: number): string | null {
  return shown < total
    ? `showing ${shown.toLocaleString()} of ${total.toLocaleString()}`
    : null;
}
