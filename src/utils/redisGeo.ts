/**
 * Redis "view as geo" — pure logic for the key browser's geo view.
 *
 * A Redis geo index IS a zset whose score is the geohash52 of the member's
 * lon/lat. The backend (`redis_geo_points`) resolves members to coordinates
 * with GEOPOS — no client-side geohash math — and this module turns the
 * answer into (a) an honest summary line, (b) an equirectangular projection
 * for the browser's small canvas, and (c) a synthetic result-set shape
 * (columns member/lon/lat) so any result-set surface could take the same
 * points later.
 *
 * Honesty doctrine (verified live against redis-server 8.10): GEOPOS decodes
 * ANY zset score into coordinates — a leaderboard's `100` comes back as a
 * point near (-180, -85.05) — so detection is never automatic. The action is
 * user-initiated, and the summary reports what GEOPOS actually answered:
 * points resolved, members with no coordinates, and whether the cap cut the
 * key short.
 */

/** One resolved member. lon ∈ [-180, 180], lat ∈ [-85.05112878, 85.05112878]. */
export interface RedisGeoPoint { member: string; lon: number; lat: number }

/** Mirrors `RedisGeoResult` in src-tauri/src/commands/redis_browser.rs. */
export interface RedisGeoResult {
  key: string;
  /** ZCARD — members in the key overall. */
  total: number;
  /** Members GEOPOS was asked about (≤ total when capped). */
  scanned: number;
  /** GEOPOS answered nil for these. points.length === scanned - missing. */
  missing: number;
  /** total > scanned — the view is a capped prefix of the key. */
  truncated: boolean;
  points: RedisGeoPoint[];
}

/** Server-side ceiling, mirrored from `GEO_MAX_POINTS` in redis_browser.rs. */
export const GEO_POINT_CAP = 5000;

/**
 * The one-line verdict under the canvas. "Not a geo key" is only claimed when
 * GEOPOS returned nil for EVERY member asked — the one answer a real geo
 * index never gives.
 */
export function geoSummary(r: RedisGeoResult): string {
  if (r.scanned === 0) return 'Empty key — no members to resolve.';
  if (r.points.length === 0) {
    return `Not a geo key — no coordinates for any of the ${r.scanned.toLocaleString()} members asked.`;
  }
  const parts = [`${r.points.length.toLocaleString()} member${r.points.length === 1 ? '' : 's'} located`];
  if (r.missing > 0) {
    parts.push(`${r.missing.toLocaleString()} of ${r.scanned.toLocaleString()} members have no coordinates`);
  }
  if (r.truncated) {
    parts.push(`capped at ${r.scanned.toLocaleString()} of ${r.total.toLocaleString()} members`);
  }
  return parts.join(' · ');
}

/**
 * The caveat that belongs next to any GEOPOS-derived view: scores decode to
 * coordinates whether or not the key was built with GEOADD.
 */
export const GEO_DERIVATION_NOTE =
  'Coordinates decoded from zset scores with GEOPOS — on a plain zset these points are meaningless.';

// ── Projection ────────────────────────────────────────────────────────────────

export interface GeoExtent { minLon: number; minLat: number; maxLon: number; maxLat: number }

export function geoExtent(points: readonly RedisGeoPoint[]): GeoExtent | null {
  if (points.length === 0) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const p of points) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

export interface ProjectedPoint { member: string; x: number; y: number }

/**
 * Equirectangular lon/lat → canvas pixels within `pad`. A degenerate extent
 * (one point, or all members on a meridian/parallel) is centred rather than
 * divided by zero. The antimeridian is not special-cased: GEOPOS coordinates
 * stay in [-180, 180] and a key spanning the antimeridian simply draws wide.
 */
export function projectPoints(
  points: readonly RedisGeoPoint[],
  width: number,
  height: number,
  pad: number,
): ProjectedPoint[] {
  const ext = geoExtent(points);
  if (!ext) return [];
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const spanLon = ext.maxLon - ext.minLon;
  const spanLat = ext.maxLat - ext.minLat;
  return points.map(p => ({
    member: p.member,
    x: spanLon === 0
      ? pad + innerW / 2
      : pad + ((p.lon - ext.minLon) / spanLon) * innerW,
    // Canvas y grows downward; latitude grows upward.
    y: spanLat === 0
      ? pad + innerH / 2
      : pad + innerH - ((p.lat - ext.minLat) / spanLat) * innerH,
  }));
}

/**
 * A "nice" graticule step for a degree range — 1/2/5 × 10ⁿ targeting roughly
 * 4–8 divisions, so a city-level key does not get a 30° grid and a worldwide
 * key does not get 10 000 lines.
 */
export function niceStep(range: number): number {
  if (!(range > 0)) return 1;
  const rough = range / 5;
  const mag = 10 ** Math.floor(Math.log10(rough));
  for (const m of [1, 2, 5, 10]) {
    if (rough <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/** Graticule line values (degrees) covering [min, max] at a nice step. */
export function graticuleLines(min: number, max: number): number[] {
  if (!(max >= min)) return [];
  const step = niceStep(max - min || 1);
  const first = Math.ceil(min / step) * step;
  const lines: number[] = [];
  // Epsilon guards float residue: ceil/step products land a hair under.
  for (let v = first; v <= max + step * 1e-9; v += step) {
    lines.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return lines;
}

// ── Synthetic result set ──────────────────────────────────────────────────────

export interface GeoResultSet {
  columns: Array<{ name: string; typeName: string }>;
  rows: Array<[string, number, number]>;
}

/**
 * The points as a query-result-shaped payload (columns member/lon/lat) — the
 * seam any result-set surface (map, export) can consume without knowing the
 * data came from Redis.
 */
export function geoResultSet(points: readonly RedisGeoPoint[]): GeoResultSet {
  return {
    columns: [
      { name: 'member', typeName: 'string' },
      { name: 'lon',    typeName: 'float' },
      { name: 'lat',    typeName: 'float' },
    ],
    rows: points.map(p => [p.member, p.lon, p.lat]),
  };
}
