/**
 * Reading geometry off the wire (src/utils/wkb.ts).
 *
 * The fixtures are real encodings, byte for byte, because that is the only
 * thing this module is ever fed. Three encodings are in the wild and a parser
 * that handles one of them looks like a parser that works:
 *
 *   - **PostGIS EWKB** — flag bits in the high nibble carry Z/M and the SRID;
 *   - **ISO/OGC WKB** — dimensionality is in the type number (1001 = PointZ);
 *   - **MySQL** — a 4-byte SRID prefix followed by plain WKB.
 *
 * And both byte orders, per geometry, including inside one collection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWkbHex, parseMysqlGeometry, bbox, vertexCount, toWkt, toGeoJson, isLonLat, positions,
} from '../src/utils/wkb.ts';

// POINT(30 10), little-endian, no SRID.
const POINT_LE = '01010000000000000000003E40 0000000000002440'.replace(/\s/g, '');
// The same point, big-endian.
const POINT_BE = '0000000001 403E000000000000 4024000000000000'.replace(/\s/g, '');
// PostGIS: SRID=4326;POINT(30 10) — type 0x20000001, then the SRID.
const POINT_SRID = '0101000020E61000000000000000003E400000000000002440';
// LINESTRING(30 10, 10 30, 40 40)
const LINE = ('0102000000 03000000'
  + '0000000000003E40 0000000000002440'
  + '0000000000002440 0000000000003E40'
  + '0000000000004440 0000000000004440').replace(/\s/g, '');
// POLYGON((30 10, 40 40, 20 40, 10 20, 30 10))
const POLY = ('0103000000 01000000 05000000'
  + '0000000000003E40 0000000000002440'
  + '0000000000004440 0000000000004440'
  + '0000000000003440 0000000000004440'
  + '0000000000002440 0000000000003440'
  + '0000000000003E40 0000000000002440').replace(/\s/g, '');
// ISO PointZ: type 1001, coordinates 1 2 3.
const POINT_Z_ISO = ('01 E9030000'
  + '000000000000F03F 0000000000000040 0000000000000840').replace(/\s/g, '');
// EWKB PointZ with SRID: 0xA0000001 = Z | SRID.
const POINT_Z_EWKB = ('01 010000A0 E6100000'
  + '000000000000F03F 0000000000000040 0000000000000840').replace(/\s/g, '');

// ── the three encodings ─────────────────────────────────────────────────────

test('a little-endian point decodes to its coordinates', () => {
  const g = parseWkbHex(POINT_LE)!;
  assert.equal(g.type, 'Point');
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
  assert.equal(g.srid, null);
});

test('a big-endian point decodes identically', () => {
  const le = parseWkbHex(POINT_LE)!;
  const be = parseWkbHex(POINT_BE)!;
  assert.deepEqual(be, le);
});

test('an EWKB SRID is read and kept', () => {
  const g = parseWkbHex(POINT_SRID)!;
  assert.equal(g.srid, 4326);
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
});

test('Z is read from both the ISO type number and the EWKB flag bit', () => {
  // Two encodings of the same geometry; a parser that knows only one of them
  // silently drops the third dimension of the other.
  const iso = parseWkbHex(POINT_Z_ISO)!;
  const ewkb = parseWkbHex(POINT_Z_EWKB)!;
  assert.deepEqual(iso.type === 'Point' && iso.coordinates, { x: 1, y: 2, z: 3 });
  assert.deepEqual(ewkb.type === 'Point' && ewkb.coordinates, { x: 1, y: 2, z: 3 });
  assert.equal(iso.srid, null);
  assert.equal(ewkb.srid, 4326);
});

test('MySQL geometry is a 4-byte SRID followed by plain WKB', () => {
  const bytes = new Uint8Array(4 + POINT_LE.length / 2);
  new DataView(bytes.buffer).setUint32(0, 4326, true);
  for (let i = 0; i < POINT_LE.length / 2; i++) {
    bytes[4 + i] = Number.parseInt(POINT_LE.slice(i * 2, i * 2 + 2), 16);
  }
  const g = parseMysqlGeometry(bytes)!;
  assert.equal(g.srid, 4326);
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
});

// ── shapes ──────────────────────────────────────────────────────────────────

test('a line keeps its vertices in order', () => {
  const g = parseWkbHex(LINE)!;
  assert.equal(g.type, 'LineString');
  assert.deepEqual([...positions(g)].map(p => [p.x, p.y]), [[30, 10], [10, 30], [40, 40]]);
});

test('a polygon keeps its rings', () => {
  const g = parseWkbHex(POLY)!;
  assert.equal(g.type, 'Polygon');
  assert.equal(g.type === 'Polygon' && g.coordinates.length, 1);
  assert.equal(vertexCount(g), 5);
});

// ── not geometry ────────────────────────────────────────────────────────────

test('ordinary cell values are quietly not geometry', () => {
  // This runs speculatively over every cell of a result set, so "no" has to
  // be cheap and silent rather than an exception.
  for (const v of ['', 'hello', '42', '2026-08-10', 'deadbeef', '0x', 'ZZZZ']) {
    assert.equal(parseWkbHex(v), null, JSON.stringify(v));
  }
});

test('truncated or corrupt geometry returns null instead of throwing', () => {
  assert.equal(parseWkbHex(POINT_LE.slice(0, 20)), null);
  assert.equal(parseWkbHex(`02${POINT_LE.slice(2)}`), null, 'a bad byte-order marker');
});

// ── derived values ──────────────────────────────────────────────────────────

test('the bounding box spans every geometry given', () => {
  const box = bbox([parseWkbHex(LINE)!, parseWkbHex(POINT_LE)!])!;
  assert.deepEqual(box, { minX: 10, minY: 10, maxX: 40, maxY: 40 });
});

test('an empty set has no bounding box, rather than a zero one', () => {
  assert.equal(bbox([]), null);
});

// ── conversion out ──────────────────────────────────────────────────────────

test('WKT round-trips the shape a human recognises', () => {
  assert.equal(toWkt(parseWkbHex(POINT_LE)!), 'POINT(30 10)');
  assert.equal(toWkt(parseWkbHex(LINE)!), 'LINESTRING(30 10, 10 30, 40 40)');
  assert.match(toWkt(parseWkbHex(POLY)!), /^POLYGON\(\(30 10, 40 40, 20 40, 10 20, 30 10\)\)$/);
  assert.equal(toWkt(parseWkbHex(POINT_Z_ISO)!), 'POINT(1 2 3)');
});

test('GeoJSON drops the SRID rather than claiming a projection it has not got', () => {
  const g = parseWkbHex(POINT_SRID)!;
  assert.deepEqual(toGeoJson(g), { type: 'Point', coordinates: [30, 10] });
});

// ── projection guessing ─────────────────────────────────────────────────────

test('4326 and 4269 are degrees; a projected SRID is not', () => {
  assert.ok(isLonLat(4326, null));
  assert.ok(isLonLat(4269, null));
  assert.ok(!isLonLat(3857, { minX: 0, minY: 0, maxX: 1, maxY: 1 }),
    'Web Mercator metres must not be drawn as degrees');
});

test('with no SRID, degrees are inferred only when the numbers can be degrees', () => {
  assert.ok(isLonLat(null, { minX: 14, minY: 50, maxX: 15, maxY: 51 }));
  assert.ok(!isLonLat(null, { minX: 1_400_000, minY: 6_500_000, maxX: 1_500_000, maxY: 6_600_000 }));
});
