/**
 * The grid geometry badge (src/utils/geometryBadge.ts).
 *
 * The badge is a header sniff, not a full parse, so the contract being pinned
 * here is *agreement*: for every encoding `parseWkbHex` accepts, the badge
 * reports the same type and SRID — EWKB flags, ISO dimension bands, and both
 * byte orders — and for the everyday strings a grid is full of, it says no
 * cheaply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geometryBadge, geometryBadgeLabel } from '../src/utils/geometryBadge.ts';
import { parseWkbHex } from '../src/utils/wkb.ts';

// POINT(30 10), little-endian, no SRID.
const POINT_LE = '01010000000000000000003E400000000000002440';
// The same point, big-endian.
const POINT_BE = '0000000001403E000000000000004024000000000000';
// PostGIS: SRID=4326;POINT(30 10) — type 0x20000001, then the SRID.
const POINT_SRID = '0101000020E61000000000000000003E400000000000002440';
// SRID=4326;POINT — big-endian EWKB.
const POINT_SRID_BE = '0020000001000010E6403E000000000000004024000000000000';
// LINESTRING(30 10, 10 30, 40 40)
const LINE = ('010200000003000000'
  + '0000000000003E400000000000002440'
  + '00000000000024400000000000003E40'
  + '00000000000044400000000000004440');
// POLYGON((30 10, 40 40, 20 40, 10 20, 30 10))
const POLY = ('01030000000100000005000000'
  + '0000000000003E400000000000002440'
  + '00000000000044400000000000004440'
  + '00000000000034400000000000004440'
  + '00000000000024400000000000003440'
  + '0000000000003E400000000000002440');
// ISO PointZ: type 1001, coordinates 1 2 3.
const POINT_Z_ISO = '01E9030000000000000000F03F00000000000000400000000000000840';
// MULTIPOLYGON with one tiny polygon — deep nesting must not hide the type.
const MULTIPOLY = ('010600000001000000'
  + '01030000000100000004000000'
  + '00000000000000000000000000000000'
  + '000000000000F03F0000000000000000'
  + '000000000000F03F000000000000F03F'
  + '00000000000000000000000000000000');
// GeoPackage blob: 'GP', version 0, little-endian + no envelope (flags 0x01),
// srs_id 4326, then POINT(30 10) as the WKB body.
const GPKG_POINT = ('4750' + '00' + '01' + 'E6100000' + POINT_LE);
// SpatiaLite GaiaBinary: 0x00 start, little-endian, SRID 4326, 32-byte MBR
// (zeros — the badge and parser both skip it), 0x7C mark, class Point, then
// POINT(30 10)'s coordinates directly, 0xFE terminator.
const GAIA_POINT = ('00' + '01' + 'E6100000'
  + '00'.repeat(32) + '7C' + '01000000'
  + '0000000000003E40' + '0000000000002440' + 'FE');

test('badge agrees with the full parser on type and SRID', () => {
  const cases: [string, string, number | null][] = [
    [POINT_LE, 'Point', null],
    [POINT_BE, 'Point', null],
    [POINT_SRID, 'Point', 4326],
    [POINT_SRID_BE, 'Point', 4326],
    [LINE, 'LineString', null],
    [POLY, 'Polygon', null],
    [POINT_Z_ISO, 'Point', null],
    [MULTIPOLY, 'MultiPolygon', null],
  ];
  for (const [hex, type, srid] of cases) {
    const badge = geometryBadge(hex);
    assert.ok(badge, `no badge for ${type}`);
    assert.equal(badge.type, type);
    const full = parseWkbHex(hex);
    assert.ok(full, `full parser rejected ${type}`);
    assert.equal(badge.type, full.type);
    assert.equal(badge.srid, full.srid);
    if (srid !== null) assert.equal(badge.srid, srid);
  }
});

test('container encodings badge like the full parser accepts them', () => {
  // GeoPackage: type from the WKB body, SRID inherited from the header.
  assert.deepEqual(geometryBadge(GPKG_POINT), { type: 'Point', srid: 4326 });
  assert.deepEqual(parseWkbHex(GPKG_POINT)?.type, 'Point');
  assert.equal(parseWkbHex(GPKG_POINT)?.srid, 4326);
  // SpatiaLite GaiaBinary: type from the class word, SRID from the header.
  assert.deepEqual(geometryBadge(GAIA_POINT), { type: 'Point', srid: 4326 });
  assert.deepEqual(parseWkbHex(GAIA_POINT)?.type, 'Point');
  assert.equal(parseWkbHex(GAIA_POINT)?.srid, 4326);
});

test('malformed container headers do not badge', () => {
  // GeoPackage with a non-zero version byte.
  assert.equal(geometryBadge('4750' + '07' + '01' + 'E6100000' + POINT_LE), null);
  // GeoPackage with an undefined envelope code (5).
  assert.equal(geometryBadge('4750' + '00' + '0B' + 'E6100000' + POINT_LE), null);
  // GaiaBinary with the v5 TinyPoint endian byte (0x81) — declined, like the parser.
  assert.equal(geometryBadge('00' + '81' + GAIA_POINT.slice(4)), null);
  // GaiaBinary with the 0x7C marker missing at byte 38.
  assert.equal(geometryBadge(GAIA_POINT.slice(0, 76) + '00' + GAIA_POINT.slice(78)), null);
});

test('0x-prefixed hex badges too (SQL Server / psql style)', () => {
  assert.deepEqual(geometryBadge(`0x${POINT_SRID}`), { type: 'Point', srid: 4326 });
});

test('ordinary cell contents are not geometry', () => {
  for (const v of [
    null, undefined, 42, {}, [],
    '', 'hello world', '2026-10-14 12:00:00',
    'deadbeef',                       // hex, but far too short
    'abcdef0123456789abcdef0123456789', // 16 bytes of hex, but byte-order ≠ 0/1
    'zzzzzzzzzzzzzzzzzzzz',           // not hex at all
    '0109000000' + '00'.repeat(8),    // type 9 is not a geometry type
  ]) {
    assert.equal(geometryBadge(v), null, `badged a non-geometry: ${String(v)}`);
  }
});

test('badge label carries the SRID only when declared', () => {
  assert.equal(geometryBadgeLabel({ type: 'Polygon', srid: 4326 }), '⬡ Polygon · 4326');
  assert.equal(geometryBadgeLabel({ type: 'Point', srid: null }), '⬡ Point');
});

test('whitespace around the hex is tolerated, as in the full parser', () => {
  assert.deepEqual(geometryBadge(`  ${POINT_SRID}\n`), { type: 'Point', srid: 4326 });
});
