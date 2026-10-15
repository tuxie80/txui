/**
 * ClickHouse array geometries — Point, Ring, Polygon, MultiPolygon.
 *
 * ClickHouse has no binary geometry wire format: its geo types are plain
 * arrays over the wire (JSONEachRow/JSONCompact), `Point` arriving as
 * `[x, y]`, `Ring` as `[[x, y], …]`, `Polygon` as `[ring, …]` and
 * `MultiPolygon` as `[polygon, …]`. Bare arrays like that are EVERYWHERE in
 * analytical data — a `Point` cell is indistinguishable from a two-element
 * coordinate pair, a scores vector, or a RGB-ish tuple — so detection is
 * gated on the column's declared `type_name` from the server, never on the
 * cell's shape. No `type_name`, no detection.
 *
 * Mapping to the internal Geometry structs:
 *
 *  - Point        [x,y]            → Point
 *  - Ring         [[x,y],…]        → Polygon with that single ring — a Ring
 *                                    is a closed loop by definition in
 *                                    ClickHouse's geo functions, and drawing
 *                                    it as a closed polygon is the honest
 *                                    reading (a LineString would leave it
 *                                    visually open when the writer did not
 *                                    repeat the first point).
 *  - Polygon      [ring,…]         → Polygon
 *  - MultiPolygon [polygon,…]      → MultiPolygon
 *
 * ClickHouse's geo convention is (x, y) = (longitude, latitude), which is
 * already the internal Position order — no axis swap. `srid` stays null (CH
 * declares none) so `isLonLat`'s range check stays the arbiter of drawability.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { Geometry, Position } from './wkb';

/** The geo type names ClickHouse reports, after Nullable(…) unwrapping. */
type ChGeoKind = 'Point' | 'Ring' | 'Polygon' | 'MultiPolygon';

/** The geo kind a column type_name declares, or null. `Nullable(Point)`
 *  unwraps to Point — the wire value follows the inner type. */
export function chGeoKind(typeName: string | undefined | null): ChGeoKind | null {
  if (!typeName) return null;
  let t = typeName.trim();
  const nullable = /^Nullable\((.*)\)$/.exec(t);
  if (nullable) t = nullable[1].trim();
  return t === 'Point' || t === 'Ring' || t === 'Polygon' || t === 'MultiPolygon' ? t : null;
}

function asPosition(v: unknown): Position | null {
  if (!Array.isArray(v) || v.length < 2 || v.length > 4) return null;
  if (!v.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  const p: Position = { x: v[0], y: v[1] };
  if (v.length > 2) p.z = v[2];
  if (v.length > 3) p.m = v[3];
  return p;
}

function asPositions(v: unknown): Position[] | null {
  if (!Array.isArray(v)) return null;
  const out: Position[] = [];
  for (const p of v) {
    const pos = asPosition(p);
    if (!pos) return null;
    out.push(pos);
  }
  return out;
}

function asPolygon(v: unknown): Position[][] | null {
  if (!Array.isArray(v) || v.length < 1) return null;
  const out: Position[][] = [];
  for (const r of v) {
    const ring = asPositions(r);
    if (!ring || ring.length < 1) return null;
    out.push(ring);
  }
  return out;
}

/**
 * Decode one cell of a ClickHouse geo column into a Geometry, or null when
 * the type_name does not declare a geo type (the whole point of the gate) or
 * the value does not match the declared shape.
 */
export function parseChGeometry(typeName: string | undefined | null, value: unknown): Geometry | null {
  const kind = chGeoKind(typeName);
  if (!kind) return null;
  const srid = null;
  switch (kind) {
    case 'Point': {
      const p = asPosition(value);
      return p ? { type: 'Point', srid, coordinates: p } : null;
    }
    case 'Ring': {
      const ring = asPositions(value);
      return ring && ring.length >= 1 ? { type: 'Polygon', srid, coordinates: [ring] } : null;
    }
    case 'Polygon': {
      const poly = asPolygon(value);
      return poly ? { type: 'Polygon', srid, coordinates: poly } : null;
    }
    case 'MultiPolygon': {
      if (!Array.isArray(value) || value.length < 1) return null;
      const out: Position[][][] = [];
      for (const p of value) {
        const poly = asPolygon(p);
        if (!poly) return null;
        out.push(poly);
      }
      return { type: 'MultiPolygon', srid, coordinates: out };
    }
  }
}
