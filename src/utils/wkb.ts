/**
 * Reading geometry off the wire.
 *
 * A PostGIS `geometry` column arrives as hex-encoded EWKB —
 * `0101000020E6100000…` — and MySQL's spatial types arrive as a 4-byte SRID
 * followed by ordinary WKB. Today the grid shows the hex, which is not wrong
 * so much as useless: a user who sees it concludes TxUI does not support
 * PostGIS.
 *
 * This decodes it in the client, deliberately, rather than asking the server
 * for `ST_AsGeoJSON`:
 *
 *  - it works on a result set that has already arrived, including one from a
 *    join, a CTE or a function, where there is no query to rewrite;
 *  - it costs no round trip, so hovering a cell is instant;
 *  - it is pure, so it is unit-tested here instead of against a server;
 *  - and it works on **MySQL** too, which has no `ST_AsGeoJSON` before 5.7 and
 *    no PostGIS ever.
 *
 * `ST_Transform`, `ST_SimplifyPreserveTopology` and `ST_IsValidReason` still
 * belong to the server — those need PostGIS itself, not a byte reader.
 *
 * ## The four wire shapes, and the ONE axis swap
 *
 * `parseWkbHex` sniffs, in order (details on its docstring):
 *
 *  1. plain WKB/EWKB (PostGIS, DuckDB, Parquet, SQLite blobs);
 *  2. GeoPackage (`GP` magic — header + optional envelope, then standard WKB);
 *  3. MySQL framing (4-byte little-endian SRID prefix, then plain WKB);
 *  4. SpatiaLite GaiaBinary (`0x00 … 0x7C … 0xFE` — see gaiaBinary.ts).
 *
 * **Axis order — read this before touching branch 3.** MySQL/MariaDB store
 * WKB coordinates in EPSG axis order, which for *geographic* SRSs is
 * (latitude, longitude) — LAT FIRST. Everything else TxUI decodes (PostGIS
 * EWKB, GeoPackage, SpatiaLite, GeoParquet, DuckDB) stores (x, y) =
 * (longitude, latitude). So a MySQL `POINT` in SRID 4326 arrives lat-first
 * and would plot transposed (Prague in the Gulf of Guinea). Branch 3 — and
 * ONLY branch 3 — swaps every position to (lon, lat) when the prefix SRID is
 * a known geographic one (`MYSQL_GEOGRAPHIC_SRIDS`), so every Geometry this
 * module returns is x=lon, y=lat regardless of source, and downstream (map,
 * bbox, GeoJSON export) never has to care where the bytes came from.
 * SRID 0 never swaps (undefined/projected — the axes are just x, y);
 * projected SRIDs never swap (metres are x, y in both camps). The known set
 * is deliberately small: adding a geographic SRID only ever *fixes* a
 * transposed map, while swapping a projected one would *corrupt* it — so the
 * asymmetry fails in the safe direction. PostGIS EWKB 4326 does NOT swap:
 * PostGIS already sends lon/lat.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

import { parseGaiaBytes } from './gaiaBinary.ts';

export type GeometryType =
  | 'Point' | 'LineString' | 'Polygon'
  | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon' | 'GeometryCollection';

/** A position. `z`/`m` are kept when present — dropping them silently loses data. */
export interface Position {
  x: number;
  y: number;
  z?: number;
  m?: number;
}

export type Geometry =
  | { type: 'Point'; srid: number | null; coordinates: Position }
  | { type: 'LineString'; srid: number | null; coordinates: Position[] }
  | { type: 'Polygon'; srid: number | null; coordinates: Position[][] }
  | { type: 'MultiPoint'; srid: number | null; coordinates: Position[] }
  | { type: 'MultiLineString'; srid: number | null; coordinates: Position[][] }
  | { type: 'MultiPolygon'; srid: number | null; coordinates: Position[][][] }
  | { type: 'GeometryCollection'; srid: number | null; geometries: Geometry[] };

/** WKB type codes. The high bits carry Z/M in the PostGIS (EWKB) encoding. */
const TYPE_NAMES: Record<number, GeometryType> = {
  1: 'Point', 2: 'LineString', 3: 'Polygon',
  4: 'MultiPoint', 5: 'MultiLineString', 6: 'MultiPolygon', 7: 'GeometryCollection',
};

const EWKB_Z = 0x8000_0000;
const EWKB_M = 0x4000_0000;
const EWKB_SRID = 0x2000_0000;

class Reader {
  private pos = 0;
  private little = true;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  // Written out rather than as constructor parameter properties: the test
  // runner strips types without transforming, and that shorthand is a
  // transform.
  constructor(bytes: Uint8Array, view: DataView) {
    this.bytes = bytes;
    this.view = view;
  }

  get offset(): number { return this.pos; }
  get done(): boolean { return this.pos >= this.bytes.length; }

  byteOrder(): void {
    const b = this.bytes[this.pos++];
    // 0 = big-endian (XDR), 1 = little-endian (NDR). Every geometry in a
    // collection carries its own, and they are allowed to differ.
    if (b !== 0 && b !== 1) throw new Error(`bad byte order marker 0x${b?.toString(16) ?? '??'}`);
    this.little = b === 1;
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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error('not hex');
    out[i] = b;
  }
  return out;
}

function readPosition(r: Reader, hasZ: boolean, hasM: boolean): Position {
  const p: Position = { x: r.f64(), y: r.f64() };
  if (hasZ) p.z = r.f64();
  if (hasM) p.m = r.f64();
  return p;
}

function readGeometry(r: Reader, inheritedSrid: number | null): Geometry {
  r.byteOrder();
  const raw = r.u32();

  // Two dialects of the same idea. PostGIS sets flag bits in the high nibble;
  // the ISO/OGC form encodes dimensionality in the number itself (1001 = PointZ,
  // 2001 = PointM, 3001 = PointZM). Both are in the wild, sometimes from the
  // same server, so both are read.
  let hasZ = (raw & EWKB_Z) !== 0;
  let hasM = (raw & EWKB_M) !== 0;
  const hasSrid = (raw & EWKB_SRID) !== 0;
  let code = raw & 0x0000_00ff;

  if (!hasZ && !hasM && raw >= 1000) {
    const iso = raw % 1000;
    const band = Math.floor(raw / 1000);
    if (band >= 1 && band <= 3 && TYPE_NAMES[iso]) {
      code = iso;
      hasZ = band === 1 || band === 3;
      hasM = band === 2 || band === 3;
    }
  }

  const srid = hasSrid ? r.u32() : inheritedSrid;
  const type = TYPE_NAMES[code];
  if (!type) throw new Error(`unknown geometry type ${code}`);

  switch (type) {
    case 'Point':
      return { type, srid, coordinates: readPosition(r, hasZ, hasM) };
    case 'LineString':
    case 'MultiPoint': {
      const n = r.u32();
      if (type === 'MultiPoint') {
        // A MultiPoint is a list of *geometries*, each with its own header.
        const pts: Position[] = [];
        for (let i = 0; i < n; i++) {
          const g = readGeometry(r, srid);
          if (g.type !== 'Point') throw new Error('MultiPoint contains a non-Point');
          pts.push(g.coordinates);
        }
        return { type, srid, coordinates: pts };
      }
      const pts: Position[] = [];
      for (let i = 0; i < n; i++) pts.push(readPosition(r, hasZ, hasM));
      return { type, srid, coordinates: pts };
    }
    case 'Polygon': {
      const rings = r.u32();
      const out: Position[][] = [];
      for (let i = 0; i < rings; i++) {
        const n = r.u32();
        const ring: Position[] = [];
        for (let j = 0; j < n; j++) ring.push(readPosition(r, hasZ, hasM));
        out.push(ring);
      }
      return { type, srid, coordinates: out };
    }
    case 'MultiLineString': {
      const n = r.u32();
      const out: Position[][] = [];
      for (let i = 0; i < n; i++) {
        const g = readGeometry(r, srid);
        if (g.type !== 'LineString') throw new Error('MultiLineString contains a non-LineString');
        out.push(g.coordinates);
      }
      return { type, srid, coordinates: out };
    }
    case 'MultiPolygon': {
      const n = r.u32();
      const out: Position[][][] = [];
      for (let i = 0; i < n; i++) {
        const g = readGeometry(r, srid);
        if (g.type !== 'Polygon') throw new Error('MultiPolygon contains a non-Polygon');
        out.push(g.coordinates);
      }
      return { type, srid, coordinates: out };
    }
    case 'GeometryCollection': {
      const n = r.u32();
      const geometries: Geometry[] = [];
      for (let i = 0; i < n; i++) geometries.push(readGeometry(r, srid));
      return { type, srid, geometries };
    }
  }
}

/**
 * Parse hex geometry in any of the four wire shapes, or `null` when the text
 * is not geometry.
 *
 * Returning `null` rather than throwing is the point: this is called
 * speculatively on every cell of a result set to decide whether a Map tab
 * should exist at all, so "not geometry" has to be cheap and quiet.
 *
 * The framings are tried in a fixed order:
 *
 *  1. plain WKB/EWKB (PostGIS hex, DuckDB/Parquet blobs, SQLite blobs);
 *  2. GeoPackage — `GP` magic, header + optional envelope, then standard WKB;
 *  3. MySQL framing — a 4-byte little-endian SRID prefix, then plain WKB;
 *  4. SpatiaLite GaiaBinary (gaiaBinary.ts).
 *
 * Disambiguation is by full consumption: a real encoding consumes every byte,
 * so a reading that leaves a tail loses to one that does not. That is what
 * keeps the overlap case honest — a MySQL SRID-0 buffer starts `00 00 00 00`
 * and reads as a big-endian Point with garbage coordinates under the plain
 * framing, but that reading stops 4 bytes short, so the MySQL framing wins.
 * A plain reading that merely leaves a tail (bytes the old parser already
 * tolerated) is still accepted when no other framing applies — speculative
 * probing must not reject encodings it accepted before.
 *
 * The MySQL branch — and only it — applies the geographic axis swap; see the
 * module header for why MySQL is the odd one out.
 */
export function parseWkbHex(hex: string): Geometry | null {
  if (!/^(0x)?[0-9a-fA-F]+$/.test(hex.trim()) || hex.trim().length < 18) return null;
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch {
    return null;
  }
  // 1. plain WKB/EWKB.
  const plain = readGeometryPref(bytes, null);
  if (plain?.done) return plain.g;
  // 2. GeoPackage: `GP` magic, header + envelope, then standard WKB.
  const gpkg = parseGeoPackageBytes(bytes);
  if (gpkg) return gpkg;
  // 3. MySQL framing: skip the SRID prefix, adopt it, parse the rest as WKB.
  if (bytes.length >= 4 + 9) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const srid = view.getUint32(0, true);
    const mysql = readGeometryPref(bytes.subarray(4), srid || null);
    if (mysql?.done) return normalizeMysqlAxes(mysql.g, srid);
  }
  // 4. SpatiaLite GaiaBinary (self-validating: markers + exact consumption).
  const gaia = parseGaiaBytes(bytes);
  if (gaia) return gaia;
  // No framing consumed everything: accept a plain parse with a tail
  // (the pre-MySQL behaviour), else it is not geometry.
  return plain ? plain.g : null;
}

/**
 * The SRIDs MySQL/MariaDB treat as lat-lon ordered — i.e. the geographic
 * SRSs where MySQL stores (lat, lon) per the EPSG axis order while everyone
 * else stores (lon, lat). MySQL 8 ships the whole EPSG catalogue of
 * geographic SRSs and orders *all* of them lat-first, but the pragmatic
 * decoder rule is "SRID ≠ 0 and known-geographic": the set stays small
 * (4326 = WGS 84 is the overwhelming case; 4269 = NAD 83 and 4258 = ETRS89
 * are the other two that dominate in the wild and match what `isLonLat`
 * treats as degrees), because wrongly swapping a projected SRID corrupts
 * data while wrongly not swapping an exotic geographic one only misplots it.
 */
export const MYSQL_GEOGRAPHIC_SRIDS: ReadonlySet<number> = new Set([4326, 4269, 4258]);

/**
 * Swap every position of a MySQL-framed geometry from (lat, lon) to
 * (lon, lat) when — and only when — the prefix SRID is a known geographic
 * one. Mutates the freshly-parsed geometry; z/m are untouched. See the
 * module header for the full reasoning.
 */
function normalizeMysqlAxes(g: Geometry, srid: number): Geometry {
  if (!MYSQL_GEOGRAPHIC_SRIDS.has(srid)) return g;
  for (const p of positions(g)) {
    const lat = p.x;
    p.x = p.y;
    p.y = lat;
  }
  return g;
}

/** Envelope sizes by GeoPackage envelope-contents code (flags bits 1–3). */
const GPKG_ENVELOPE_BYTES = [0, 32, 48, 48, 64];

/**
 * GeoPackage geometry BLOB: magic `GP`, version 0, a flags byte (bit 0 =
 * little-endian header, bits 1–3 = envelope kind), a signed srs_id, an
 * optional envelope, then STANDARD WKB. Returns null unless the blob is a
 * complete, fully-consumed GeoPackage geometry — this runs speculatively on
 * every hex cell, so "not a GeoPackage blob" must be cheap and quiet.
 *
 * srs_id 4326 is lon/lat like everywhere except MySQL — NO axis swap here.
 * srs_id 0 and -1 are GeoPackage's "undefined" SRSs; both map to a null SRID
 * so `isLonLat` falls back to range inference.
 */
export function parseGeoPackageBytes(bytes: Uint8Array): Geometry | null {
  try {
    // 8-byte header, then at least byte-order + type + one coordinate pair.
    if (bytes.length < 8 + 9) return null;
    if (bytes[0] !== 0x47 || bytes[1] !== 0x50) return null; // 'GP'
    if (bytes[2] !== 0x00) return null; // version
    const flags = bytes[3];
    if ((flags & 0xc0) !== 0) return null; // reserved bits must be zero
    const envelope = (flags >> 1) & 0x07;
    if (envelope > 4) return null; // codes 5–7 are not defined
    const offset = 8 + GPKG_ENVELOPE_BYTES[envelope];
    if (bytes.length < offset + 9) return null;
    const little = (flags & 0x01) === 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rawSrid = view.getInt32(4, little);
    const srid = rawSrid > 0 ? rawSrid : null;
    // The body is standard WKB; the header srs_id is inherited by every
    // geometry in it (plain WKB carries no SRID of its own).
    const body = readGeometryPref(bytes.subarray(offset), srid);
    return body?.done ? body.g : null;
  } catch {
    return null;
  }
}

interface ReadAttempt { g: Geometry; done: boolean }

/** Read one geometry, reporting whether it consumed every byte. */
function readGeometryPref(bytes: Uint8Array, srid: number | null): ReadAttempt | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const r = new Reader(bytes, view);
    const g = readGeometry(r, srid);
    return { g, done: r.done };
  } catch {
    return null;
  }
}

/**
 * MySQL's spatial columns are a 4-byte little-endian SRID followed by plain
 * WKB — *not* EWKB. Given the bytes, this reads either.
 *
 * This is a raw wire reader: it returns coordinates in WIRE order and does
 * NOT apply the geographic axis swap. Display normalization
 * (`normalizeMysqlAxes`, lat-first → lon/lat for `MYSQL_GEOGRAPHIC_SRIDS`)
 * lives in `parseWkbHex`, the speculative entry point every display path
 * (grid badge, CellViewer, MapView) actually uses.
 */
export function parseMysqlGeometry(bytes: Uint8Array): Geometry | null {
  try {
    if (bytes.length < 9) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const srid = view.getUint32(0, true);
    const rest = bytes.subarray(4);
    const restView = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
    return readGeometry(new Reader(rest, restView), srid || null);
  } catch {
    return null;
  }
}

// ── working with what came back ─────────────────────────────────────────────

export interface Bbox { minX: number; minY: number; maxX: number; maxY: number }

/** Every position in a geometry, in order. */
export function* positions(g: Geometry): Generator<Position> {
  switch (g.type) {
    case 'Point': yield g.coordinates; return;
    case 'LineString': case 'MultiPoint': yield* g.coordinates; return;
    case 'Polygon': case 'MultiLineString':
      for (const part of g.coordinates) yield* part;
      return;
    case 'MultiPolygon':
      for (const poly of g.coordinates) for (const ring of poly) yield* ring;
      return;
    case 'GeometryCollection':
      for (const sub of g.geometries) yield* positions(sub);
  }
}

export function bbox(geometries: Geometry[]): Bbox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of geometries) {
    for (const p of positions(g)) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function vertexCount(g: Geometry): number {
  let n = 0;
  for (const p of positions(g)) { void p; n += 1; }
  return n;
}

/** WKT, for copying out — the form every other tool accepts. */
export function toWkt(g: Geometry): string {
  const pos = (p: Position) =>
    [p.x, p.y, p.z, p.m].filter(v => v !== undefined).join(' ');
  const list = (ps: Position[]) => ps.map(pos).join(', ');
  switch (g.type) {
    case 'Point': return `POINT(${pos(g.coordinates)})`;
    case 'LineString': return `LINESTRING(${list(g.coordinates)})`;
    case 'MultiPoint': return `MULTIPOINT(${g.coordinates.map(p => `(${pos(p)})`).join(', ')})`;
    case 'Polygon': return `POLYGON(${g.coordinates.map(r => `(${list(r)})`).join(', ')})`;
    case 'MultiLineString': return `MULTILINESTRING(${g.coordinates.map(r => `(${list(r)})`).join(', ')})`;
    case 'MultiPolygon':
      return `MULTIPOLYGON(${g.coordinates.map(poly => `(${poly.map(r => `(${list(r)})`).join(', ')})`).join(', ')})`;
    case 'GeometryCollection':
      return `GEOMETRYCOLLECTION(${g.geometries.map(toWkt).join(', ')})`;
  }
}

/** GeoJSON, for copying into anything that speaks it. SRID is dropped — the
 *  format assumes WGS 84, and pretending otherwise would be a lie. */
export function toGeoJson(g: Geometry): unknown {
  const pos = (p: Position) => (p.z === undefined ? [p.x, p.y] : [p.x, p.y, p.z]);
  switch (g.type) {
    case 'Point': return { type: g.type, coordinates: pos(g.coordinates) };
    case 'LineString': case 'MultiPoint':
      return { type: g.type, coordinates: g.coordinates.map(pos) };
    case 'Polygon': case 'MultiLineString':
      return { type: g.type, coordinates: g.coordinates.map(r => r.map(pos)) };
    case 'MultiPolygon':
      return { type: g.type, coordinates: g.coordinates.map(p => p.map(r => r.map(pos))) };
    case 'GeometryCollection':
      return { type: g.type, geometries: g.geometries.map(toGeoJson) };
  }
}

/**
 * Does this SRID mean longitude/latitude degrees?
 *
 * Only 4326 (WGS 84) and 4269 (NAD 83) are treated as such by default, plus
 * "no SRID at all" when the numbers are inside the degree ranges. Guessing
 * wrong in the other direction — treating metres as degrees — draws a map of
 * a country the size of a postage stamp somewhere off Africa, which is at
 * least obvious; guessing degrees as metres silently draws nothing.
 */
export function isLonLat(srid: number | null, box: Bbox | null): boolean {
  if (srid === 4326 || srid === 4269) return true;
  if (srid !== null && srid !== 0) return false;
  if (!box) return false;
  return box.minX >= -180 && box.maxX <= 180 && box.minY >= -90 && box.maxY <= 90;
}
