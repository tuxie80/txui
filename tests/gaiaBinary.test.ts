/**
 * SpatiaLite GaiaBinary decoder (src/utils/gaiaBinary.ts).
 *
 * Fixtures are hand-built per the GaiaBinary layout (SpatiaLite gaia-lib's
 * gaiaFromSpatiaLiteBlobWkb):
 *
 *   [0] 0x00 · [1] endian (0=BE, 1=LE) · [2..5] SRID (int32) ·
 *   [6..37] MBR (4 doubles) · [38] 0x7C · [39..42] class code ·
 *   [43..] headerless WKB-like body · members prefixed 0x69 + endian + class ·
 *   [last] 0xFE
 *
 * Builders are used throughout so every byte of every fixture is deliberate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGaiaBinary, parseGaiaBytes } from '../src/utils/gaiaBinary.ts';
import { parseWkbHex, positions, vertexCount, toWkt } from '../src/utils/wkb.ts';

const toHex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

function doubles(vals: number[], little: boolean): string {
  const b = new Uint8Array(vals.length * 8);
  const v = new DataView(b.buffer);
  vals.forEach((x, i) => v.setFloat64(i * 8, x, little));
  return toHex(b);
}

function count(n: number, little: boolean): string {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, little);
  return toHex(b);
}

/** 43-byte header: start, endian, SRID, MBR, 0x7C mark, class code. */
function gaia(cls: number, body: string, opts: { srid?: number; little?: boolean; mbr?: number[] } = {}): string {
  const little = opts.little !== false;
  const head = new Uint8Array(43);
  const v = new DataView(head.buffer);
  v.setUint8(0, 0x00);
  v.setUint8(1, little ? 1 : 0);
  v.setInt32(2, opts.srid ?? 4326, little);
  const [minx, miny, maxx, maxy] = opts.mbr ?? [0, 0, 0, 0];
  v.setFloat64(6, minx, little);
  v.setFloat64(14, miny, little);
  v.setFloat64(22, maxx, little);
  v.setFloat64(30, maxy, little);
  v.setUint8(38, 0x7c);
  v.setUint32(39, cls, little);
  return toHex(head) + body + 'fe';
}

/** A multi/collection member: 0x69 marker, endian byte, class code, body. */
function entity(cls: number, body: string, little = true): string {
  return '69' + (little ? '01' : '00') + count(cls, little) + body;
}

// ── the standard classes ────────────────────────────────────────────────────

test('a little-endian point decodes with its SRID', () => {
  const g = parseGaiaBinary(gaia(1, doubles([30, 10], true), { mbr: [30, 10, 30, 10] }))!;
  assert.equal(g.type, 'Point');
  assert.equal(g.srid, 4326);
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
});

test('a big-endian point decodes identically', () => {
  const le = parseGaiaBinary(gaia(1, doubles([30, 10], true)))!;
  const be = parseGaiaBinary(gaia(1, doubles([30, 10], false), { little: false }))!;
  assert.deepEqual(be, le);
});

test('SRID -1 and 0 both mean no SRS', () => {
  // SpatiaLite's undefined SRID is the signed value -1 (0xFFFFFFFF).
  assert.equal(parseGaiaBinary(gaia(1, doubles([30, 10], true), { srid: -1 }))!.srid, null);
  assert.equal(parseGaiaBinary(gaia(1, doubles([30, 10], true), { srid: 0 }))!.srid, null);
});

test('the embedded MBR is skipped, not trusted', () => {
  // A garbage MBR must not affect the coordinates — the UI's bbox is computed
  // from the positions themselves.
  const g = parseGaiaBinary(gaia(1, doubles([30, 10], true), { mbr: [999, -999, -999, 999] }))!;
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
});

test('Z, M and ZM classes carry their extra ordinates', () => {
  const z = parseGaiaBinary(gaia(1001, doubles([1, 2, 3], true)))!;
  assert.deepEqual(z.type === 'Point' && z.coordinates, { x: 1, y: 2, z: 3 });
  const m = parseGaiaBinary(gaia(2001, doubles([1, 2, 7], true)))!;
  assert.deepEqual(m.type === 'Point' && m.coordinates, { x: 1, y: 2, m: 7 });
  const zm = parseGaiaBinary(gaia(3001, doubles([1, 2, 3, 7], true)))!;
  assert.deepEqual(zm.type === 'Point' && zm.coordinates, { x: 1, y: 2, z: 3, m: 7 });
});

test('a linestring keeps its vertices in order', () => {
  const g = parseGaiaBinary(gaia(2, count(3, true) + doubles([30, 10, 10, 30, 40, 40], true)))!;
  assert.equal(g.type, 'LineString');
  assert.deepEqual([...positions(g)].map(p => [p.x, p.y]), [[30, 10], [10, 30], [40, 40]]);
});

test('a polygon keeps its rings', () => {
  const body = count(1, true) + count(5, true) + doubles([30, 10, 40, 40, 20, 40, 10, 20, 30, 10], true);
  const g = parseGaiaBinary(gaia(3, body))!;
  assert.equal(g.type, 'Polygon');
  assert.equal(g.type === 'Polygon' && g.coordinates.length, 1);
  assert.equal(vertexCount(g), 5);
});

test('a multipoint reads its 0x69-prefixed members', () => {
  const body = count(2, true) + entity(1, doubles([30, 10], true)) + entity(1, doubles([10, 30], true));
  const g = parseGaiaBinary(gaia(4, body))!;
  assert.equal(g.type, 'MultiPoint');
  assert.deepEqual([...positions(g)].map(p => [p.x, p.y]), [[30, 10], [10, 30]]);
});

test('members may carry their own byte order', () => {
  // Second member is big-endian inside a little-endian blob — legal, and the
  // decoder has to honour the member's own endian byte.
  const body = count(2, true) + entity(1, doubles([30, 10], true)) + entity(1, doubles([10, 30], false), false);
  const g = parseGaiaBinary(gaia(4, body))!;
  assert.deepEqual([...positions(g)].map(p => [p.x, p.y]), [[30, 10], [10, 30]]);
});

test('multilinestring and multipolygon nest through members', () => {
  const mls = parseGaiaBinary(gaia(5, count(2, true)
    + entity(2, count(2, true) + doubles([30, 10, 10, 30], true))
    + entity(2, count(1, true) + doubles([40, 40], true))))!;
  assert.equal(mls.type, 'MultiLineString');
  assert.equal(mls.type === 'MultiLineString' && mls.coordinates.length, 2);
  const mp = parseGaiaBinary(gaia(6, count(1, true)
    + entity(3, count(1, true) + count(4, true) + doubles([0, 0, 1, 0, 1, 1, 0, 0], true))))!;
  assert.equal(mp.type, 'MultiPolygon');
  assert.equal(mp.type === 'MultiPolygon' && mp.coordinates[0][0].length, 4);
});

test('a geometry collection takes mixed members, and WKT reads naturally', () => {
  const body = count(2, true)
    + entity(1, doubles([30, 10], true))
    + entity(2, count(2, true) + doubles([30, 10, 10, 30], true));
  const g = parseGaiaBinary(gaia(7, body))!;
  assert.equal(g.type, 'GeometryCollection');
  assert.equal(toWkt(g), 'GEOMETRYCOLLECTION(POINT(30 10), LINESTRING(30 10, 10 30))');
});

// ── honest refusals ─────────────────────────────────────────────────────────

test('the compressed classes return null rather than a wrong decode', () => {
  // 1000002 = compressed linestring, 3000003 = compressed polygon ZM — both
  // need gaia-lib's compression tables, which are out of scope by decision.
  assert.equal(parseGaiaBinary(gaia(1000002, count(1, true) + doubles([1, 2], true))), null);
  assert.equal(parseGaiaBinary(gaia(3000003, count(1, true))), null);
});

test('the v5 TinyPoint encodings (endian byte 0x80/0x81) return null', () => {
  for (const flag of ['80', '81']) {
    const blob = '00' + flag + 'e6100000' + doubles([30, 10, 30, 10], true)
      + '7c' + '01000000' + doubles([30, 10], true) + 'fe';
    assert.equal(parseGaiaBinary(blob), null, `endian flag 0x${flag}`);
  }
});

test('a random blob is not geometry', () => {
  // The speculative chain runs this on every hex cell — a false positive here
  // would draw garbage on a map. Random bytes, and random bytes that merely
  // START with 0x00, both fail structural validation.
  assert.equal(parseGaiaBinary('deadbeef'.repeat(16)), null);
  const random = new Uint8Array(96);
  for (let i = 0; i < random.length; i++) random[i] = (i * 37 + 11) % 256;
  random[0] = 0x00;
  assert.equal(parseGaiaBytes(random), null);
});

test('every structural marker is enforced', () => {
  const good = gaia(1, doubles([30, 10], true));
  const at = (byteIndex: number, hexByte: string) =>
    good.slice(0, byteIndex * 2) + hexByte + good.slice(byteIndex * 2 + 2);
  assert.equal(parseGaiaBinary(at(0, '01')), null, 'start byte must be 0x00');
  assert.equal(parseGaiaBinary(at(1, '02')), null, 'endian flag must be 0 or 1');
  assert.equal(parseGaiaBinary(at(38, '7d')), null, 'the 0x7C mark is mandatory');
  assert.equal(parseGaiaBinary(at(39, '08')), null, 'class 8 does not exist');
  assert.equal(parseGaiaBinary(good.slice(0, -2)), null, 'missing 0xFE terminator');
  assert.equal(parseGaiaBinary(good + 'aa'), null, 'trailing garbage after the terminator');
});

test('a corrupt body fails instead of misreading', () => {
  // Declares three points, carries two.
  const short = gaia(2, count(3, true) + doubles([30, 10, 10, 30], true));
  assert.equal(parseGaiaBinary(short), null);
  // A member without its 0x69 marker.
  const noMarker = gaia(4, count(1, true) + '01' + count(1, true) + doubles([30, 10], true));
  assert.equal(parseGaiaBinary(noMarker), null);
  // A multipoint holding a linestring is a type error, not a coercion.
  const wrongMember = gaia(4, count(1, true) + entity(2, count(1, true) + doubles([30, 10], true)));
  assert.equal(parseGaiaBinary(wrongMember), null);
});

test('plain WKB blobs are not misread as GaiaBinary', () => {
  // POINT(30 10) LE starts 0x01 (fails GAIA_START); BE is far too short.
  assert.equal(parseGaiaBinary('01010000000000000000003e400000000000002440'), null);
  assert.equal(parseGaiaBinary('0000000001403e0000000000004024000000000000'), null);
});

test('not-hex and too-short input is quietly null', () => {
  for (const v of ['', 'hello', '0x', 'zz', '00']) {
    assert.equal(parseGaiaBinary(v), null, JSON.stringify(v));
  }
});

// ── through the speculative entry point ─────────────────────────────────────

test('parseWkbHex picks a GaiaBinary blob out of the chain', () => {
  // Plain WKB fails on it (0x00 start misreads as big-endian with an unknown
  // type), GeoPackage has no magic, MySQL framing hits a bad byte order —
  // the GaiaBinary attempt is what consumes every byte.
  const hex = gaia(1, doubles([30, 10], true), { mbr: [30, 10, 30, 10] });
  assert.deepEqual(parseWkbHex(hex), parseGaiaBinary(hex));
  assert.equal(parseWkbHex(hex)!.srid, 4326);
});

test('GaiaBinary coordinates are lon/lat — no MySQL-style swap', () => {
  // Stored (30, 10) means x=30, y=10 and stays that way even at SRID 4326;
  // only the MySQL-framing branch of parseWkbHex ever swaps.
  const g = parseWkbHex(gaia(1, doubles([30, 10], true)))!;
  assert.deepEqual(g.type === 'Point' && g.coordinates, { x: 30, y: 10 });
});
