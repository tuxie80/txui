/**
 * SpatiaLite's GaiaBinary BLOB format — what a SQLite database actually
 * stores in a geometry column when SpatiaLite (not GeoPackage) owns the
 * table.
 *
 * Layout (multi-byte numbers in the blob's own byte order):
 *
 *   [0]      0x00        GAIA_START
 *   [1]      endian flag  0 = big-endian, 1 = little-endian. (SpatiaLite v5's
 *                         compressed TinyPoint encoding announces itself as
 *                         0x80/0x81 — out of scope here, honestly rejected.)
 *   [2..5]   SRID         signed int32; -1 and 0 both mean "no SRS"
 *   [6..37]  MBR          4 doubles: min x, min y, max x, max y. Read over and
 *                         skipped — the bbox the UI wants is computed from the
 *                         coordinates themselves (wkb.ts `bbox`).
 *   [38]     0x7C         GAIA_MARK
 *   [39..42] class code   1..7 base (Point … GeometryCollection);
 *                         1001..1007 = Z, 2001..2007 = M, 3001..3007 = ZM.
 *   [43..]   body         WKB-like but headerless: coordinate doubles follow
 *                         directly. Multi/collection members are each
 *                         prefixed with a 0x69 entity marker, their own endian
 *                         byte and their own class code.
 *   [last]   0xFE         GAIA_END
 *
 * Coordinates are always (x, y) — SpatiaLite stores lon/lat for geographic
 * SRIDs like everyone except MySQL, so there is NO axis swap here. (wkb.ts
 * owns the one swap, in its MySQL framing branch.)
 *
 * Scope, deliberately: the standard uncompressed classes only. The
 * compressed classes (1000002/1000003 and up — gaia-lib's run-length
 * encoding of linestrings and polygons) are NOT decoded: a wrong decode is
 * worse than an honest `null`, which leaves the cell showing hex as before.
 *
 * False-positive safety: a blob must have the 0x00 start, a strict 0/1
 * endian flag, the 0x7C marker at byte 38, a whitelisted class code, a body
 * that consumes every byte up to the 0xFE terminator, and valid member
 * markers — a random blob fails at least one of these long before any
 * coordinate is trusted.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

import type { Geometry, Position } from './wkb.ts';

const GAIA_START = 0x00;
const GAIA_MARK = 0x7c;
const GAIA_ENTITY = 0x69;
const GAIA_END = 0xfe;

/** 43-byte header + the shortest possible body (one u32 count) + terminator. */
const MIN_LENGTH = 43 + 4 + 1;

interface ClassInfo {
  code: number;
  hasZ: boolean;
  hasM: boolean;
}

/**
 * 1–7 are the base classes; the thousands band carries dimensionality
 * (1000 = Z, 2000 = M, 3000 = ZM), exactly like ISO WKB type numbers.
 * Everything else — including the 1000002+ compressed classes — is rejected.
 */
function classInfo(raw: number): ClassInfo | null {
  if (raw >= 1 && raw <= 7) return { code: raw, hasZ: false, hasM: false };
  const band = Math.floor(raw / 1000);
  const code = raw % 1000;
  if (band >= 1 && band <= 3 && code >= 1 && code <= 7) {
    return { code, hasZ: band === 1 || band === 3, hasM: band === 2 || band === 3 };
  }
  return null;
}

class Reader {
  private pos: number;
  private little: boolean;
  private readonly view: DataView;

  // Written out rather than as constructor parameter properties: the test
  // runner strips types without transforming, and that shorthand is a
  // transform.
  constructor(view: DataView, pos: number, little: boolean) {
    this.view = view;
    this.pos = pos;
    this.little = little;
  }

  get offset(): number { return this.pos; }

  byte(): number { return this.view.getUint8(this.pos++); }

  /** Entity members carry their own endian byte; only strict 0/1 is read. */
  setEndian(flag: number): void {
    if (flag !== 0 && flag !== 1) throw new Error(`bad endian flag 0x${flag.toString(16)}`);
    this.little = flag === 1;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, this.little);
    this.pos += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.pos, this.little);
    this.pos += 8;
    return v;
  }
}

function readPosition(r: Reader, info: ClassInfo): Position {
  const p: Position = { x: r.f64(), y: r.f64() };
  if (info.hasZ) p.z = r.f64();
  if (info.hasM) p.m = r.f64();
  return p;
}

/**
 * Read `count` entities — each a 0x69 marker, an endian byte, a class code
 * and a body. `expectedCode` pins the member class for Multi* (a MultiPoint
 * holds only Points); a GeometryCollection passes `null` and takes anything.
 */
function readMembers(r: Reader, expectedCode: number | null, srid: number | null, depth: number): Geometry[] {
  const out: Geometry[] = [];
  for (let i = 0, count = r.u32(); i < count; i++) {
    if (r.byte() !== GAIA_ENTITY) throw new Error('missing entity marker');
    r.setEndian(r.byte());
    const info = classInfo(r.u32());
    if (!info) throw new Error('bad member class');
    if (expectedCode !== null && info.code !== expectedCode) throw new Error('wrong member class');
    out.push(readEntity(r, info, srid, depth + 1));
  }
  return out;
}

function readEntity(r: Reader, info: ClassInfo, srid: number | null, depth: number): Geometry {
  if (depth > 16) throw new Error('collection nesting too deep');
  switch (info.code) {
    case 1:
      return { type: 'Point', srid, coordinates: readPosition(r, info) };
    case 2: {
      const pts: Position[] = [];
      for (let i = 0, n = r.u32(); i < n; i++) pts.push(readPosition(r, info));
      return { type: 'LineString', srid, coordinates: pts };
    }
    case 3: {
      const rings: Position[][] = [];
      for (let i = 0, ringCount = r.u32(); i < ringCount; i++) {
        const ring: Position[] = [];
        for (let j = 0, n = r.u32(); j < n; j++) ring.push(readPosition(r, info));
        rings.push(ring);
      }
      return { type: 'Polygon', srid, coordinates: rings };
    }
    case 4: {
      const coordinates: Position[] = [];
      for (const m of readMembers(r, 1, srid, depth)) {
        if (m.type !== 'Point') throw new Error('MultiPoint contains a non-Point');
        coordinates.push(m.coordinates);
      }
      return { type: 'MultiPoint', srid, coordinates };
    }
    case 5: {
      const coordinates: Position[][] = [];
      for (const m of readMembers(r, 2, srid, depth)) {
        if (m.type !== 'LineString') throw new Error('MultiLineString contains a non-LineString');
        coordinates.push(m.coordinates);
      }
      return { type: 'MultiLineString', srid, coordinates };
    }
    case 6: {
      const coordinates: Position[][][] = [];
      for (const m of readMembers(r, 3, srid, depth)) {
        if (m.type !== 'Polygon') throw new Error('MultiPolygon contains a non-Polygon');
        coordinates.push(m.coordinates);
      }
      return { type: 'MultiPolygon', srid, coordinates };
    }
    case 7:
      return { type: 'GeometryCollection', srid, geometries: readMembers(r, null, srid, depth) };
    default:
      throw new Error(`unknown class ${info.code}`);
  }
}

/**
 * Decode a GaiaBinary BLOB, or `null` when the bytes are not one — including
 * the compressed classes and v5 TinyPoint, which are out of scope on purpose
 * (see the module header).
 */
export function parseGaiaBytes(bytes: Uint8Array): Geometry | null {
  try {
    if (bytes.length < MIN_LENGTH) return null;
    if (bytes[0] !== GAIA_START) return null;
    // The endian flag doubles as the TinyPoint gate: 0x80/0x81 is the v5
    // compressed encoding, declined here.
    if (bytes[1] !== 0 && bytes[1] !== 1) return null;
    if (bytes[38] !== GAIA_MARK) return null;
    if (bytes[bytes.length - 1] !== GAIA_END) return null;
    const little = bytes[1] === 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Signed: SpatiaLite's "no SRS" is -1, and 0 shows up in the wild too.
    const rawSrid = view.getInt32(2, little);
    const srid = rawSrid > 0 ? rawSrid : null;
    const info = classInfo(view.getUint32(39, little));
    if (!info) return null;
    const r = new Reader(view, 43, little);
    const g = readEntity(r, info, srid, 0);
    // Structural validation: the body must end exactly on the terminator.
    if (r.offset !== bytes.length - 1) return null;
    return g;
  } catch {
    return null;
  }
}

/** Hex-string front end, mirroring `parseWkbHex`'s contract. */
export function parseGaiaBinary(hex: string): Geometry | null {
  if (!/^(0x)?[0-9a-fA-F]+$/.test(hex.trim())) return null;
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || clean.length < MIN_LENGTH * 2) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return null;
    bytes[i] = b;
  }
  return parseGaiaBytes(bytes);
}
