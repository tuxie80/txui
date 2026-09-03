/**
 * Unqualified-name resolution for the editor's hints.
 *
 * MySQL has one current database: a bare name resolves there or nowhere.
 * PostgreSQL has `search_path`, an ORDERED LIST — several schemas are
 * reachable without qualification at once and the FIRST match wins. That has
 * two consequences the hint layer must respect to be correct:
 *
 *   1. Hinting only from `current_schema()` (the first entry) hides every
 *      object in the rest of the path, even though typing its bare name works.
 *   2. When two schemas on the path hold an object of the same name, only the
 *      earlier one is reachable bare. Completing the later one unqualified
 *      would silently point at the WRONG object — so it must be qualified.
 *
 * Pure module — no React/Tauri imports, unit-tested with node --test.
 */

export interface ResolvableObject {
  schema: string;
  name: string;
}

export interface Resolution {
  /** schema (lowercased) → position in the resolution order; absent = off-path. */
  rank: Map<string, number>;
  /** object name (lowercased) → rank of the schema that wins for the bare name. */
  winner: Map<string, number>;
}

/** Build the resolution table for one search_path + object set. */
export function buildResolution(objects: readonly ResolvableObject[], searchPath: readonly string[]): Resolution {
  const rank = new Map<string, number>();
  searchPath.forEach((schema, i) => {
    const k = schema.toLowerCase();
    // A schema listed twice keeps its earliest position.
    if (!rank.has(k)) rank.set(k, i);
  });

  const winner = new Map<string, number>();
  for (const o of objects) {
    const r = rank.get(o.schema.toLowerCase());
    if (r === undefined) continue;
    const key = o.name.toLowerCase();
    const cur = winner.get(key);
    if (cur === undefined || r < cur) winner.set(key, r);
  }
  return { rank, winner };
}

/**
 * True when this object is reachable by its bare name — on the path AND not
 * shadowed by an object of the same name in an earlier schema.
 */
export function resolvesBare(o: ResolvableObject, res: Resolution): boolean {
  const r = res.rank.get(o.schema.toLowerCase());
  return r !== undefined && res.winner.get(o.name.toLowerCase()) === r;
}

/**
 * True when the object sits on the path but loses to an earlier schema — the
 * case worth telling the user about, since the bare name silently resolves
 * elsewhere.
 */
export function isShadowed(o: ResolvableObject, res: Resolution): boolean {
  return res.rank.has(o.schema.toLowerCase()) && !resolvesBare(o, res);
}

/**
 * Pick which of several same-named candidates a bare reference means.
 * Earliest search_path entry wins; then the explicitly chosen schema; then
 * whatever exists, so a lookup still yields something usable.
 */
export function pickCandidate<T extends ResolvableObject>(
  candidates: readonly T[], searchPath: readonly string[], currentDb: string,
): T | undefined {
  if (candidates.length === 0) return undefined;
  const path = searchPath.map(x => x.toLowerCase());
  const onPath = candidates
    .map(o => ({ o, rank: path.indexOf(o.schema.toLowerCase()) }))
    .filter(x => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank)[0]?.o;
  return onPath
    ?? candidates.find(o => o.schema.toLowerCase() === currentDb.toLowerCase())
    ?? candidates[0];
}
