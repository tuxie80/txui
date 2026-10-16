/**
 * TTL decisions for the Redis key browser (src/components/RedisBrowser.tsx).
 *
 * Pure and dependency-free — driven by `node --test` (tests/redisTtl.test.ts).
 */

export type TtlInputResult =
  | { ok: true; secs: number }
  | { ok: false; error: string };

/**
 * Validate the TTL editor's input.
 *
 * `-1` (or an empty field) is PERSIST; a positive number of seconds is
 * EXPIRE. `0` is refused: `EXPIRE key 0` deletes the key immediately, and a
 * TTL editor that silently deletes is a Delete button with the wrong label.
 * Any other negative is not a Redis TTL at all.
 */
export function validateTtlInput(input: string): TtlInputResult {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === '-1') return { ok: true, secs: -1 };
  if (!/^-?\d+$/.test(trimmed)) {
    return { ok: false, error: 'TTL must be a whole number of seconds (-1 = persistent).' };
  }
  const secs = Number.parseInt(trimmed, 10);
  if (secs === 0) {
    return { ok: false, error: 'A TTL of 0 deletes the key immediately — use Delete if that is the intent.' };
  }
  if (secs < -1) {
    return { ok: false, error: 'TTL must be -1 (persistent) or a positive number of seconds.' };
  }
  return { ok: true, secs };
}

/**
 * The TTL a value edit must send back so the SET does not wipe it.
 *
 * `SET key value` without an EX clause removes any existing TTL (Redis
 * semantics), so saving an edited value used to flip a volatile key to
 * persistent. Sending the TTL the key already has preserves it and works on
 * any Redis version — `SET … KEEPTTL` would need Redis ≥ 6.
 */
export function ttlToPreserveOnEdit(ttl: number): number | null {
  return ttl > 0 ? ttl : null;
}
