/**
 * Hit-testing geometries on the map canvas.
 *
 * The track's hit test (`geoTrack.hitTest`) answers "which ping is under the
 * cursor"; the geometry-first map needs the same answer for shapes — which
 * district, route or service area — so a click can select its row and a hover
 * can name it. Screen-space, pixel-radius, and cheap: this runs on mousemove
 * over up to GEOMETRY_CAP shapes, so it early-outs on the bounding box before
 * touching a single segment.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { Geometry, Position } from './wkb';
import { bbox } from './wkb.ts';
import { toScreen } from './geoTrack.ts';
import type { Viewport } from './geoTrack';

/** Squared distance from p to the segment ab. */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** Even–odd ray cast: is (px, py) inside the screen-space ring? */
function inRing(ring: { x: number; y: number }[], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > py) !== (b.y > py)
      && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function ringNear(ring: { x: number; y: number }[], px: number, py: number, r2: number): boolean {
  for (let i = 1; i < ring.length; i++) {
    if (segDist2(px, py, ring[i - 1].x, ring[i - 1].y, ring[i].x, ring[i].y) <= r2) return true;
  }
  return false;
}

function lineHit(pts: Position[], v: Viewport, px: number, py: number, r2: number): boolean {
  let prev = toScreen(v, pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cur = toScreen(v, pts[i].x, pts[i].y);
    if (segDist2(px, py, prev.x, prev.y, cur.x, cur.y) <= r2) return true;
    prev = cur;
  }
  return false;
}

function polygonHit(rings: Position[][], v: Viewport, px: number, py: number, r2: number): boolean {
  const screenRings = rings.map(r => r.map(p => toScreen(v, p.x, p.y)));
  // On the boundary counts as a hit even when the ring is too small to fill
  // a pixel — a country at world zoom is its outline.
  for (const r of screenRings) if (ringNear(r, px, py, r2)) return true;
  if (screenRings.length === 0) return false;
  if (!inRing(screenRings[0], px, py)) return false;
  // Even–odd over the holes: inside an island inside a lake is land again.
  for (let i = 1; i < screenRings.length; i++) {
    if (inRing(screenRings[i], px, py)) return false;
  }
  return true;
}

/**
 * Is the point (px, py) — canvas pixels — on the geometry? `radius` is the
 * click tolerance in pixels.
 *
 * "On" means: within `radius` of a point or a line, or inside a polygon (or
 * within `radius` of its boundary, so hairline shapes stay clickable at any
 * zoom).
 */
export function hitTestGeometry(
  g: Geometry, v: Viewport, px: number, py: number, radius = 6,
): boolean {
  // Cheap reject: the geometry's bbox, inflated by the radius, in screen space.
  const box = bbox([g]);
  if (!box) return false;
  const a = toScreen(v, box.minX, box.maxY);
  const b = toScreen(v, box.maxX, box.minY);
  if (px < a.x - radius || px > b.x + radius || py < a.y - radius || py > b.y + radius) return false;

  const r2 = radius * radius;
  switch (g.type) {
    case 'Point': {
      const s = toScreen(v, g.coordinates.x, g.coordinates.y);
      return (s.x - px) ** 2 + (s.y - py) ** 2 <= r2;
    }
    case 'MultiPoint':
      return g.coordinates.some(p => {
        const s = toScreen(v, p.x, p.y);
        return (s.x - px) ** 2 + (s.y - py) ** 2 <= r2;
      });
    case 'LineString': return lineHit(g.coordinates, v, px, py, r2);
    case 'MultiLineString': return g.coordinates.some(l => lineHit(l, v, px, py, r2));
    case 'Polygon': return polygonHit(g.coordinates, v, px, py, r2);
    case 'MultiPolygon': return g.coordinates.some(p => polygonHit(p, v, px, py, r2));
    case 'GeometryCollection':
      return g.geometries.some(sub => hitTestGeometry(sub, v, px, py, radius));
  }
}
