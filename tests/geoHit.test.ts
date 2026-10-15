/**
 * Hit-testing geometries on the map canvas (src/utils/geoHit.ts).
 *
 * The geometry-first map answers "which shape is under the cursor" on every
 * mousemove, so the pinned behaviour is the three ways a cursor meets a
 * shape: inside a polygon, near a line, on a point — plus the reject cases
 * that must NOT fire (a polygon's hole is not the polygon).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitTestGeometry } from '../src/utils/geoHit.ts';
import { fitViewport, toScreen } from '../src/utils/geoTrack.ts';
import type { Geometry } from '../src/utils/wkb.ts';

const W = 800, H = 600;

// A viewport fitting western Europe-ish, so screen positions are sane.
const VIEW = fitViewport({ minLat: 40, maxLat: 55, minLon: 0, maxLon: 20 }, W, H);

/** lon/lat of a screen point under the test viewport (inverse of toScreen). */
function unproject(px: number, py: number): { lon: number; lat: number } {
  const x = (px - VIEW.offsetX) / VIEW.scale;
  const y = (py - VIEW.offsetY) / VIEW.scale;
  const lon = x * 360 - 180;
  const n = Math.PI * (1 - 2 * y);
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lon, lat };
}

const square: Geometry = {
  type: 'Polygon', srid: 4326,
  coordinates: [[
    { x: 5, y: 45 }, { x: 15, y: 45 }, { x: 15, y: 52 }, { x: 5, y: 52 }, { x: 5, y: 45 },
  ]],
};

test('a point inside a polygon hits; outside misses', () => {
  const centre = toScreen(VIEW, 10, 48.5);
  assert.ok(hitTestGeometry(square, VIEW, centre.x, centre.y));
  const far = toScreen(VIEW, 18, 42);   // outside the square, inside the bbox? no — outside both
  assert.equal(hitTestGeometry(square, VIEW, far.x, far.y), false);
});

test('the bbox early-out does not swallow boundary clicks', () => {
  // Just outside the edge but within the click radius of it.
  const edge = toScreen(VIEW, 15, 48.5);
  assert.ok(hitTestGeometry(square, VIEW, edge.x + 3, edge.y));
  // And genuinely far away misses.
  assert.equal(hitTestGeometry(square, VIEW, edge.x + 60, edge.y), false);
});

test('a polygon hole is not the polygon', () => {
  const holed: Geometry = {
    type: 'Polygon', srid: 4326,
    coordinates: [
      [{ x: 5, y: 45 }, { x: 15, y: 45 }, { x: 15, y: 52 }, { x: 5, y: 52 }, { x: 5, y: 45 }],
      [{ x: 9, y: 47 }, { x: 11, y: 47 }, { x: 11, y: 50 }, { x: 9, y: 50 }, { x: 9, y: 47 }],
    ],
  };
  const inHole = toScreen(VIEW, 10, 48.5);
  assert.equal(hitTestGeometry(holed, VIEW, inHole.x, inHole.y), false);
  const inLand = toScreen(VIEW, 6, 46);
  assert.ok(hitTestGeometry(holed, VIEW, inLand.x, inLand.y));
});

test('points hit within the radius only', () => {
  const pt: Geometry = { type: 'Point', srid: 4326, coordinates: { x: 10, y: 48 } };
  const s = toScreen(VIEW, 10, 48);
  assert.ok(hitTestGeometry(pt, VIEW, s.x + 4, s.y));
  assert.equal(hitTestGeometry(pt, VIEW, s.x + 20, s.y), false);
});

test('lines hit near the stroke, not near the endpoints only', () => {
  const line: Geometry = {
    type: 'LineString', srid: 4326,
    coordinates: [{ x: 5, y: 45 }, { x: 15, y: 52 }],
  };
  const mid = toScreen(VIEW, 10, 48.5);
  assert.ok(hitTestGeometry(line, VIEW, mid.x + 2, mid.y + 2));
  const away = toScreen(VIEW, 10, 42);
  assert.equal(hitTestGeometry(line, VIEW, away.x, away.y), false);
});

test('multipolygons and collections hit through their parts', () => {
  const multi: Geometry = {
    type: 'MultiPolygon', srid: 4326,
    coordinates: [
      [[{ x: 2, y: 42 }, { x: 4, y: 42 }, { x: 4, y: 44 }, { x: 2, y: 44 }, { x: 2, y: 42 }]],
      [[{ x: 16, y: 50 }, { x: 19, y: 50 }, { x: 19, y: 53 }, { x: 16, y: 53 }, { x: 16, y: 50 }]],
    ],
  };
  const inSecond = toScreen(VIEW, 17.5, 51.5);
  assert.ok(hitTestGeometry(multi, VIEW, inSecond.x, inSecond.y));
  const between = toScreen(VIEW, 10, 47);
  assert.equal(hitTestGeometry(multi, VIEW, between.x, between.y), false);

  const coll: Geometry = {
    type: 'GeometryCollection', srid: 4326,
    geometries: [square, { type: 'Point', srid: 4326, coordinates: { x: 18, y: 42 } }],
  };
  const onMember = toScreen(VIEW, 18, 42);
  assert.ok(hitTestGeometry(coll, VIEW, onMember.x, onMember.y));
});

test('unproject is the honest inverse of toScreen for this viewport', () => {
  const p = unproject(123, 234);
  const q = toScreen(VIEW, p.lon, p.lat);
  assert.ok(Math.abs(q.x - 123) < 1e-6 && Math.abs(q.y - 234) < 1e-6);
});
