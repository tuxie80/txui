/**
 * GeoJSON detection — the MongoDB payoff of the geospatial rounds.
 *
 * A MongoDB `location` sub-document arrives as a real object
 * `{ type: 'Point', coordinates: [14.4, 50.1] }`; a PostGIS `ST_AsGeoJSON`
 * column or a JSON column arrives as a STRING holding the same shape. Both
 * decode here into the same `Geometry` structs wkb.ts produces, so MapView
 * and CellViewer draw them with zero new rendering code.
 *
 * Detection is strict in the direction that matters and lenient in the one
 * that does not:
 *
 *  - STRICT on shape: `type` must be one of the seven GeoJSON geometry names
 *    (case-sensitive — the spec is), and `coordinates` must be numeric arrays
 *    nested to exactly that type's depth. An arbitrary JSON object like
 *    `{ type: 'user', coordinates: 'unknown' }` must never turn into a
 *    geometry, and neither must `{ type: 'Point', coordinates: 'nope' }`.
 *  - LENIENT on extras: `bbox`, `crs`, foreign members are ignored, the way
 *    RFC 7946 permits.
 *  - NOT detected: `Feature` / `FeatureCollection` wrappers. A Feature's
 *    payload is `properties`, not a drawable shape, and unwrapping it here
 *    would hide which part of the document was drawn. (Deferred — see
 *    docs/plans/plan-geospatial.md round 2.)
 *
 * `srid` is deliberately left null rather than claimed as 4326: RFC 7946 says
 * GeoJSON is WGS 84, but non-compliant producers exist, and `null` lets
 * `isLonLat`'s range check be the arbiter — degrees within the world bounds
 * draw, anything else politely refuses, exactly like bare WKB.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { Geometry, Position } from './wkb';

const TYPES = new Set([
  'Point', 'LineString', 'Polygon',
  'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection',
]);

function asPosition(v: unknown): Position | null {
  if (!Array.isArray(v) || v.length < 2 || v.length > 4) return null;
  if (!v.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  const p: Position = { x: v[0], y: v[1] };
  if (v.length > 2) p.z = v[2];
  if (v.length > 3) p.m = v[3];
  return p;
}

/** An array of positions, optionally with a minimum count (LineString ≥ 2). */
function asPositions(v: unknown, min = 1): Position[] | null {
  if (!Array.isArray(v) || v.length < min) return null;
  const out: Position[] = [];
  for (const p of v) {
    const pos = asPosition(p);
    if (!pos) return null;
    out.push(pos);
  }
  return out;
}

function asRings(v: unknown): Position[][] | null {
  if (!Array.isArray(v) || v.length < 1) return null;
  const out: Position[][] = [];
  for (const r of v) {
    // A ring that cannot close is not a ring — four positions minimum.
    const ring = asPositions(r, 4);
    if (!ring) return null;
    out.push(ring);
  }
  return out;
}

function fromObject(v: Record<string, unknown>, depth: number): Geometry | null {
  if (depth > 8) return null;   // a hostile nesting bomb is not geometry
  if (typeof v.type !== 'string' || !TYPES.has(v.type)) return null;
  const srid = null;
  switch (v.type) {
    case 'Point': {
      const c = asPosition(v.coordinates);
      return c ? { type: 'Point', srid, coordinates: c } : null;
    }
    case 'LineString': {
      const c = asPositions(v.coordinates, 2);
      return c ? { type: 'LineString', srid, coordinates: c } : null;
    }
    case 'MultiPoint': {
      const c = asPositions(v.coordinates, 1);
      return c ? { type: 'MultiPoint', srid, coordinates: c } : null;
    }
    case 'Polygon': {
      const c = asRings(v.coordinates);
      return c ? { type: 'Polygon', srid, coordinates: c } : null;
    }
    case 'MultiLineString': {
      if (!Array.isArray(v.coordinates) || v.coordinates.length < 1) return null;
      const out: Position[][] = [];
      for (const l of v.coordinates) {
        const line = asPositions(l, 2);
        if (!line) return null;
        out.push(line);
      }
      return { type: 'MultiLineString', srid, coordinates: out };
    }
    case 'MultiPolygon': {
      if (!Array.isArray(v.coordinates) || v.coordinates.length < 1) return null;
      const out: Position[][][] = [];
      for (const p of v.coordinates) {
        const poly = asRings(p);
        if (!poly) return null;
        out.push(poly);
      }
      return { type: 'MultiPolygon', srid, coordinates: out };
    }
    case 'GeometryCollection': {
      if (!Array.isArray(v.geometries)) return null;
      const out: Geometry[] = [];
      for (const g of v.geometries) {
        if (g === null || typeof g !== 'object' || Array.isArray(g)) return null;
        const sub = fromObject(g as Record<string, unknown>, depth + 1);
        if (!sub) return null;
        out.push(sub);
      }
      return { type: 'GeometryCollection', srid, geometries: out };
    }
  }
  return null;
}

/**
 * Parse a GeoJSON-shaped cell — a real object (MongoDB path) or a JSON string
 * — into a Geometry, or null when the value is not one. Called speculatively
 * on cells the way parseWkbHex is, so "no" is cheap and quiet.
 */
export function parseGeoJson(value: unknown): Geometry | null {
  let v = value;
  if (typeof v === 'string') {
    const t = v.trim();
    // A GeoJSON geometry is an object; skip the JSON.parse cost otherwise.
    if (!t.startsWith('{') || !t.endsWith('}')) return null;
    try {
      v = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return fromObject(v as Record<string, unknown>, 0);
}
