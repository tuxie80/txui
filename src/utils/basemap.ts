/**
 * The bundled offline world map.
 *
 * `src/assets/basemap.json` is Natural Earth 1:110m land (public domain),
 * fetched once at development time by `dev/fetch_basemap.mjs` and committed —
 * the map view never talks to the network, so the coastline travels inside
 * the app. This module is the read side: `normalizeBasemap` validates the
 * JSON into drawable polygons, and `loadBasemap` imports the asset lazily,
 * resolving to `null` when the asset is absent or malformed — the callers
 * (MapView, CellViewer) then draw their plain graticule, exactly as they did
 * before a basemap existed.
 *
 * The import is lazy for two reasons: a map tab that is never opened never
 * pays for the parse, and the dynamic form is what lets a missing asset
 * degrade instead of breaking the bundle.
 *
 * `normalizeBasemap` is pure and driven by `node --test`; `loadBasemap` is
 * never called from tests (the asset path only resolves under the bundler).
 */

/** One land polygon: rings of [lon, lat], first ring outer. */
export interface BasemapPolygon {
  rings: [number, number][][];
}

/**
 * Validate the asset's JSON into drawable polygons. Anything that is not a
 * Polygon/MultiPolygon of finite [lon, lat] pairs is dropped — a partially
 * broken asset draws as a partial world, not as an exception.
 */
export function normalizeBasemap(data: unknown): BasemapPolygon[] {
  if (typeof data !== 'object' || data === null) return [];
  const geometries = (data as { geometries?: unknown }).geometries;
  if (!Array.isArray(geometries)) return [];

  const ring = (r: unknown): [number, number][] | null => {
    if (!Array.isArray(r) || r.length < 4) return null;
    const pts: [number, number][] = [];
    for (const p of r) {
      if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number'
        || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      pts.push([p[0], p[1]]);
    }
    return pts;
  };
  const polygon = (rings: unknown): BasemapPolygon | null => {
    if (!Array.isArray(rings)) return null;
    const rs = rings.map(ring).filter((x): x is [number, number][] => x !== null);
    return rs.length ? { rings: rs } : null;
  };

  const out: BasemapPolygon[] = [];
  for (const g of geometries) {
    if (typeof g !== 'object' || g === null) continue;
    const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
    if (type === 'Polygon') {
      const p = polygon(coordinates);
      if (p) out.push(p);
    } else if (type === 'MultiPolygon') {
      if (!Array.isArray(coordinates)) continue;
      for (const c of coordinates) {
        const p = polygon(c);
        if (p) out.push(p);
      }
    }
  }
  return out;
}

let cached: Promise<BasemapPolygon[] | null> | null = null;

/**
 * Import the bundled asset, once. `null` when it is missing or unreadable —
 * absence is a supported configuration (the map predates the basemap), not
 * an error worth surfacing.
 */
export function loadBasemap(): Promise<BasemapPolygon[] | null> {
  cached ??= import('../assets/basemap.json')
    .then(m => normalizeBasemap(m.default ?? m))
    .catch(() => null);
  return cached;
}
