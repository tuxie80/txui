/**
 * Reading geometry off the wire (src/utils/wkb.ts).
 *
 * The fixtures are real encodings, byte for byte, because that is the only
 * thing this module is ever fed. These wire shapes are in the wild and a
 * parser that handles one of them looks like a parser that works:
 *
 *   - **PostGIS EWKB** — flag bits in the high nibble carry Z/M and the SRID;
 *   - **ISO/OGC WKB** — dimensionality is in the type number (1001 = PointZ);
 *   - **MySQL** — a 4-byte SRID prefix followed by plain WKB, with the
 *     geographic axis-order swap (MySQL stores geographic SRSs lat-first);
 *   - **GeoPackage** — `GP` magic, header + optional envelope, then WKB;
 *   - **SpatiaLite GaiaBinary** — covered in gaiaBinary.test.ts, exercised
 *     here only through the speculative chain.
 *
 * And both byte orders, per geometry, including inside one collection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MYSQL_GEOGRAPHIC_SRIDS,
  parseWkbHex, parseMysqlGeometry, parseGeoPackageBytes,
  bbox, vertexCount, toWkt, toGeoJson, isLonLat, positions,
} from '../src/utils/wkb.ts';

/** Test fixture helpers: programmatic, so every byte is deliberate. */
const toHex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

function doublesLE(...vals: number[]): string {
  const b = new Uint8Array(vals.length * 8);
  const v = new DataView(b.buffer);
  vals.forEach((x, i) => v.setFloat64(i * 8, x, true));
  return toHex(b);
}

/** MySQL framing: 4-byte LE SRID prefix + a little-endian WKB point (a, b). */
function mysqlPoint(srid: number, a: number, b: number): string {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, srid, true);
  return toHex(head) + '0101000000' + doublesLE(a, b);
}

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

// ── MySQL framing through the speculative entry point ───────────────────────
//
// The backend emits MySQL geometry as one hex string (SRID prefix + WKB), and
// CellViewer/MapView probe every string cell with parseWkbHex — so the MySQL
// framing has to be recognised THERE, with no component changes.

// ST_PointFromText('POINT(30 10)', 4326) as the server sends it:
// SRID 4326 little-endian, then plain little-endian WKB. Note MySQL 8 parses
// 'POINT(30 10)' in EPSG axis order for geographic SRSs — 30 is the
// LATITUDE, 10 the longitude — and stores the doubles in that order; the
// decoder swaps them back to (lon, lat).
const MYSQL_POINT_4326 = 'E6100000' + POINT_LE;
// SRID 0 (the MySQL default): the prefix is 00 00 00 00, which a naive
// plain-WKB reading would mistake for a big-endian header.
const MYSQL_POINT_SRID0 = '00000000' + POINT_LE;

test('parseWkbHex accepts MySQL-framed hex and adopts the prefixed SRID', () => {
  const g = parseWkbHex(MYSQL_POINT_4326)!;
  assert.equal(g.type, 'Point');
  assert.equal(g.srid, 4326, 'the SRID comes from the MySQL prefix');
  // 4326 is geographic: MySQL stored (lat 30, lon 10) and the decoder swaps
  // to the (lon, lat) everything downstream expects.
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 10, y: 30 });
});

test('a MySQL SRID-0 buffer does not masquerade as a big-endian point', () => {
  // 00 00 00 00 … reads as byte-order 0, type 1 under the plain framing — a
  // structurally valid Point with garbage coordinates. The full-consumption
  // check rejects that reading (it leaves a 4-byte tail) and the MySQL
  // framing wins. This is the case "try MySQL only when the plain parse
  // throws" would have got silently wrong.
  const g = parseWkbHex(MYSQL_POINT_SRID0)!;
  assert.equal(g.type, 'Point');
  assert.equal(g.srid, null, 'SRID 0 means no SRID');
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
});

test('plain-WKB parsing is unchanged by the MySQL fallback', () => {
  // Every encoding the parser already accepted still parses, identically —
  // including big-endian, whose 00 00 00 .. header overlaps the MySQL SRID-0
  // prefix shape. Plain framing is tried first and consumes every byte, so
  // the fallback never fires on genuine WKB.
  assert.deepEqual(parseWkbHex(POINT_BE), parseWkbHex(POINT_LE));
  assert.equal(parseWkbHex(POINT_BE)!.type, 'Point');
  assert.deepEqual(parseWkbHex(POINT_BE)!.type === 'Point' && (parseWkbHex(POINT_BE)! as { coordinates: unknown }).coordinates,
    { x: 30, y: 10 });
  assert.equal(parseWkbHex(POINT_SRID)!.srid, 4326);
  assert.equal(parseWkbHex(POINT_Z_ISO)!.type, 'Point');
  assert.equal(parseWkbHex(LINE)!.type, 'LineString');
  assert.equal(parseWkbHex(POLY)!.type, 'Polygon');
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

// ── MySQL axis order: geographic SRIDs are stored (lat, lon) ────────────────
//
// MySQL/MariaDB follow the EPSG axis order for geographic SRSs, so a 4326
// column's WKB holds the latitude FIRST. Everything else on the wire stores
// (lon, lat). The MySQL-framing branch of parseWkbHex — and only it — swaps
// known-geographic SRIDs (MYSQL_GEOGRAPHIC_SRIDS) so every Geometry the
// module returns is x=lon, y=lat. Fixtures are built with doublesLE so the
// stored order is explicit: mysqlPoint(4326, 50, 14) stores 50 then 14,
// i.e. lat 50, lon 14.

test('a MySQL 4326 point is swapped from (lat, lon) to (lon, lat)', () => {
  const g = parseWkbHex(mysqlPoint(4326, 50, 14))!;
  assert.equal(g.srid, 4326);
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 14, y: 50 },
    'stored (lat 50, lon 14) must decode to x=lon, y=lat');
});

test('the other known-geographic SRIDs swap too', () => {
  for (const srid of [4269, 4258]) {
    const g = parseWkbHex(mysqlPoint(srid, 50, 14))!;
    assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 14, y: 50 }, `SRID ${srid}`);
  }
  assert.deepEqual([...MYSQL_GEOGRAPHIC_SRIDS].sort(), [4258, 4269, 4326],
    'the swap set stays the small documented known-geographic set');
});

test('a MySQL SRID-0 geometry does NOT swap — the axes are just x, y', () => {
  // SRID 0 is undefined/projected; there is no EPSG axis order to honour.
  const g = parseWkbHex(mysqlPoint(0, 50, 14))!;
  assert.equal(g.srid, null);
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 50, y: 14 });
});

test('a projected MySQL SRID does NOT swap — metres are x, y in both camps', () => {
  const g = parseWkbHex(mysqlPoint(3857, 1_668_000, 6_620_000))!;
  assert.equal(g.srid, 3857);
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 1_668_000, y: 6_620_000 });
});

test('PostGIS EWKB 4326 does NOT swap — PostGIS already sends lon/lat', () => {
  // POINT_SRID stores 30 then 10 meaning lon 30, lat 10; it must survive
  // unchanged. (This is the asymmetry the whole rule hangs on.)
  const g = parseWkbHex(POINT_SRID)!;
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
});

test('the swap reaches every vertex of a multi-vertex MySQL geometry', () => {
  // SRID 4326 + LINESTRING stored lat-first: (50, 14), (51, 15).
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, 4326, true);
  const hex = toHex(head) + '0102000000' + '02000000' + doublesLE(50, 14, 51, 15);
  const g = parseWkbHex(hex)!;
  assert.equal(g.type, 'LineString');
  assert.deepEqual([...positions(g)].map(p => [p.x, p.y]), [[14, 50], [15, 51]]);
});

// ── GeoPackage ──────────────────────────────────────────────────────────────
//
// GeoPackage binary header (spec §2.1.3): magic 'GP', version 0, a flags
// byte (bit 0 = little-endian header, bits 1–3 = envelope kind), a signed
// srs_id, an optional envelope (0/32/48/64 bytes), then standard WKB.
// Fixtures are hand-built per that layout.

function gpkg(srid: number, envelopeCode: number, envelopeVals: number[], body: string, little = true): string {
  const head = new Uint8Array(8 + envelopeVals.length * 8);
  const v = new DataView(head.buffer);
  v.setUint8(0, 0x47); // 'G'
  v.setUint8(1, 0x50); // 'P'
  v.setUint8(2, 0); // version
  v.setUint8(3, (envelopeCode << 1) | (little ? 1 : 0));
  v.setInt32(4, srid, little);
  envelopeVals.forEach((x, i) => v.setFloat64(8 + i * 8, x, little));
  return toHex(head) + body;
}

// POINT(30 10) WKB bodies for the two byte orders.
const GPKG_BODY_LE = POINT_LE;
const GPKG_BODY_BE = POINT_BE;

test('a GeoPackage blob parses through its header to the standard WKB body', () => {
  // XY envelope [minx, maxx, miny, maxy], srs_id 4326, little-endian header.
  const g = parseWkbHex(gpkg(4326, 1, [30, 30, 10, 10], GPKG_BODY_LE))!;
  assert.equal(g.type, 'Point');
  assert.equal(g.srid, 4326, 'the header srs_id is mapped onto the Geometry');
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 },
    'GeoPackage stores lon/lat like everyone but MySQL — no axis swap');
});

test('every envelope kind puts the WKB body at the right offset', () => {
  // Kinds 0 (none), 2/3 (XYZ/XYM, 48 B) and 4 (XYZM, 64 B) beside the
  // kind-1 fixture above — the envelope contents are skipped, not read.
  assert.deepEqual(parseWkbHex(gpkg(4326, 0, [], GPKG_BODY_LE))!.srid, 4326);
  assert.deepEqual(parseWkbHex(gpkg(4326, 2, [30, 30, 10, 10, 0, 0], GPKG_BODY_LE))!.type, 'Point');
  assert.deepEqual(parseWkbHex(gpkg(4326, 4, [30, 30, 10, 10, 0, 0, 0, 0], GPKG_BODY_LE))!.type, 'Point');
});

test('a big-endian GeoPackage header and body parse identically', () => {
  const le = parseWkbHex(gpkg(4326, 1, [30, 30, 10, 10], GPKG_BODY_LE, true))!;
  const be = parseWkbHex(gpkg(4326, 1, [30, 30, 10, 10], GPKG_BODY_BE, false))!;
  assert.deepEqual(be, le);
});

test('GeoPackage srs_id 0 and -1 are undefined — null SRID, no axis swap', () => {
  for (const srid of [0, -1]) {
    const g = parseWkbHex(gpkg(srid, 0, [], GPKG_BODY_LE))!;
    assert.equal(g.srid, null, `srs_id ${srid} means undefined, so isLonLat can infer`);
    assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
  }
});

test('malformed GeoPackage headers are not geometry', () => {
  const good = gpkg(4326, 1, [30, 30, 10, 10], GPKG_BODY_LE);
  const at = (i: number, hexByte: string) => good.slice(0, i * 2) + hexByte + good.slice(i * 2 + 2);
  assert.equal(parseWkbHex(at(0, 0x51.toString(16).padStart(2, '0'))), null, 'bad magic');
  assert.equal(parseWkbHex(at(2, '01')), null, 'version other than 0');
  assert.equal(parseWkbHex(at(3, 'c3')), null, 'reserved flag bits set');
  assert.equal(parseWkbHex(at(3, '0f')), null, 'envelope code 7 is undefined');
  assert.equal(parseWkbHex(good.slice(0, 20)), null, 'truncated header');
  // A body that stops mid-envelope must not be salvaged as WKB.
  assert.equal(parseWkbHex(good.slice(0, (8 + 16) * 2)), null, 'truncated envelope');
});

function gpkgBytes(srid: number): Uint8Array {
  const hex = gpkg(srid, 0, [], GPKG_BODY_LE);
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

test('parseGeoPackageBytes requires the WKB body to consume the whole blob', () => {
  // A trailing byte after the WKB body is a malformed blob, not a tail to
  // tolerate — the envelope offset arithmetic makes tails meaningless.
  const whole = gpkgBytes(4326);
  const bytes = new Uint8Array(whole.length + 1);
  bytes.set(whole);
  bytes[bytes.length - 1] = 0xaa;
  assert.equal(parseGeoPackageBytes(bytes), null);
});

// ── the speculative chain: order and disambiguation ─────────────────────────

test('a SpatiaLite GaiaBinary blob is picked up by the chain', () => {
  // gaiaBinary.test.ts owns the format; here only the integration matters:
  // plain WKB and GeoPackage and MySQL framing must all pass on it, and the
  // GaiaBinary attempt must win. Minimal LE 4326 point, hand-built.
  const gaia = '00' + '01' + 'e6100000'
    + doublesLE(30, 10, 30, 10) // embedded MBR
    + '7c' + '01000000' // GAIA_MARK, class 1 = Point
    + doublesLE(30, 10) + 'fe';
  const g = parseWkbHex(gaia)!;
  assert.equal(g.type, 'Point');
  assert.equal(g.srid, 4326);
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 },
    'GaiaBinary stores lon/lat — no axis swap');
});

test('a plain parse with a tail is still accepted when no framing applies', () => {
  // Pre-MySQL behaviour the chain must preserve: a real WKB geometry
  // followed by junk still parses, because speculative probing must not
  // reject what it accepted before.
  const g = parseWkbHex(POINT_LE + 'ff')!;
  assert.equal(g.type, 'Point');
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
});
