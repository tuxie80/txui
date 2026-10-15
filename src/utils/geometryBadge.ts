/**
 * The grid badge for a geometry cell: `⬡ Polygon · 4326`.
 *
 * A PostGIS/MySQL geometry cell arrives as a wall of hex EWKB, and a wall of
 * hex in a grid cell is useless twice over — it says nothing, and it says it
 * across 400 pixels. The badge says the two things that matter at a glance
 * (what kind of shape, in which SRID) and the full hex stays one double-click
 * away in the cell viewer.
 *
 * This is a **header sniff**, deliberately not a full parse. `parseWkbHex`
 * walks every vertex — the right cost for a viewer that is about to draw the
 * shape, the wrong cost for a grid rendering thousands of cells. The badge
 * reads the byte-order mark, the type word (EWKB high-bit flags and the ISO
 * dimension bands, same as the full parser) and the optional SRID, and stops.
 * The two container encodings `parseWkbHex` accepts — GeoPackage (`GP` magic,
 * header srs_id + WKB body) and SpatiaLite GaiaBinary (0x00 start byte, SRID
 * at byte 2, 0x7C mark at byte 38, class word at byte 39) — get the same
 * header-only treatment.
 * A false positive here is harmless: the badge is a label, and the cell
 * viewer's full parse stays the authority on the actual bytes.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { GeometryType } from './wkb';

/** What a geometry cell announces itself as. */
export interface GeometryBadgeInfo {
  type: GeometryType;
  /** Declared SRID when the EWKB header carries one, else null. */
  srid: number | null;
}

const TYPE_NAMES: Record<number, GeometryType> = {
  1: 'Point', 2: 'LineString', 3: 'Polygon',
  4: 'MultiPoint', 5: 'MultiLineString', 6: 'MultiPolygon', 7: 'GeometryCollection',
};

const EWKB_Z = 0x8000_0000;
const EWKB_M = 0x4000_0000;
const EWKB_SRID = 0x2000_0000;

/**
 * Read one byte of the hex string, or -1 when it is not hex.
 * Working on the string directly avoids allocating the whole byte array just
 * to look at its header.
 */
function hexByte(hex: string, i: number): number {
  const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return Number.isNaN(b) ? -1 : b;
}

function hexU32(hex: string, i: number, little: boolean): number {
  const b0 = hexByte(hex, i), b1 = hexByte(hex, i + 1);
  const b2 = hexByte(hex, i + 2), b3 = hexByte(hex, i + 3);
  if ((b0 | b1 | b2 | b3) < 0) return -1;
  return little
    ? (b0 + b1 * 0x100 + b2 * 0x10000 + b3 * 0x1000000)
    : (b3 + b2 * 0x100 + b1 * 0x10000 + b0 * 0x1000000);
}

/** Signed 32-bit read — GeoPackage srs_id and SpatiaLite's SRID are signed. */
function hexI32(hex: string, i: number, little: boolean): number | null {
  const u = hexU32(hex, i, little);
  if (u < 0) return null;
  return u >= 0x8000_0000 ? u - 0x1_0000_0000 : u;
}

/**
 * Sniff the WKB/EWKB header that starts at byte `off` of the hex string.
 * Shared by the plain path and the GeoPackage body.
 */
function sniffWkbAt(hex: string, off: number): GeometryBadgeInfo | null {
  const order = hexByte(hex, off);
  if (order !== 0 && order !== 1) return null;
  const little = order === 1;

  const raw = hexU32(hex, off + 1, little);
  if (raw < 0) return null;
  const hasZ = (raw & EWKB_Z) !== 0;
  const hasM = (raw & EWKB_M) !== 0;
  const hasSrid = (raw & EWKB_SRID) !== 0;
  let code = raw & 0x0000_00ff;

  // ISO/OGC dimension bands (1001 = PointZ, 2001 = PointM, 3001 = PointZM) —
  // the same decoding the full parser applies.
  if (!hasZ && !hasM && raw >= 1000) {
    const iso = raw % 1000;
    const band = Math.floor(raw / 1000);
    if (band >= 1 && band <= 3 && TYPE_NAMES[iso]) code = iso;
  }

  const type = TYPE_NAMES[code];
  if (!type) return null;

  if (!hasSrid) return { type, srid: null };
  const srid = hexU32(hex, off + 5, little);
  return srid >= 0 ? { type, srid } : null;
}

/** GeoPackage binary header ('GP' magic, version 0, envelope code 0–4). */
const GPKG_ENVELOPE_BYTES = [0, 32, 48, 48, 64];

/**
 * GeoPackage geometry blob: 8-byte header + envelope + standard WKB body.
 * The header srs_id is inherited by the body (plain WKB carries none).
 */
function sniffGeoPackage(hex: string): GeometryBadgeInfo | null {
  if (hex.length < (8 + 9) * 2) return null;
  if (hexByte(hex, 0) !== 0x47 || hexByte(hex, 1) !== 0x50) return null; // 'GP'
  if (hexByte(hex, 2) !== 0x00) return null; // version
  const flags = hexByte(hex, 3);
  if ((flags & 0xc0) !== 0) return null; // reserved bits
  const envelope = (flags >> 1) & 0x07;
  if (envelope > 4) return null;
  const little = (flags & 0x01) === 1;
  const body = sniffWkbAt(hex, 8 + GPKG_ENVELOPE_BYTES[envelope]);
  if (!body) return null;
  if (body.srid !== null) return body;
  const srs = hexI32(hex, 4, little);
  return { type: body.type, srid: srs !== null && srs > 0 ? srs : null };
}

/**
 * SpatiaLite GaiaBinary: fixed 0x00 start byte (it is NOT the endian mark —
 * that is byte 1), signed SRID at byte 2, 32-byte MBR, 0x7C marker at byte
 * 38, class word at byte 39. Compressed classes and the v5 TinyPoint
 * encodings (endian 0x80/0x81) are declined, like the parser.
 */
function sniffGaiaBinary(hex: string): GeometryBadgeInfo | null {
  if (hex.length < 43 * 2) return null;
  if (hexByte(hex, 0) !== 0x00) return null;
  const endian = hexByte(hex, 1);
  if (endian !== 0 && endian !== 1) return null;
  const little = endian === 1;
  if (hexByte(hex, 38) !== 0x7c) return null;
  const raw = hexU32(hex, 39, little);
  if (raw < 0) return null;
  let code = raw;
  if (raw >= 1000) {
    const band = Math.floor(raw / 1000);
    const iso = raw % 1000;
    if (band >= 1 && band <= 3 && iso >= 1 && iso <= 7) code = iso;
  }
  const type = TYPE_NAMES[code];
  if (!type) return null;
  const srs = hexI32(hex, 2, little);
  return { type, srid: srs !== null && srs > 0 ? srs : null };
}

/**
 * The geometry type and SRID of a hex EWKB/WKB cell, from its header alone —
 * or null when the value is not geometry.
 *
 * The gates mirror `parseWkbHex` (hex only, ≥9 bytes) so a value that badges
 * is a value the full parser accepts the shape of; anything shorter or
 * non-hex is rejected before a single byte is read.
 */
export function geometryBadge(value: unknown): GeometryBadgeInfo | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^0x/i, '');
  // Same shape gate as parseWkbHex: pure hex, at least byte-order + type + one
  // coordinate word. The regex doubles as the "not geometry" fast path — an
  // ordinary string fails it in the first few characters.
  if (hex.length < 18 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;

  const order = hexByte(hex, 0);
  // GeoPackage announces itself with the 'GP' magic, never an endian mark.
  if (order === 0x47) return sniffGeoPackage(hex);
  // Plain WKB/EWKB first; a GaiaBinary blob also starts with 0x00, so the
  // container is tried only when the plain header does not decode — the same
  // disambiguation order as parseWkbHex's chain.
  return sniffWkbAt(hex, 0) ?? (order === 0x00 ? sniffGaiaBinary(hex) : null);
}

/** The badge text: `⬡ Polygon · 4326`, or `⬡ Point` when no SRID is declared. */
export function geometryBadgeLabel(info: GeometryBadgeInfo): string {
  return info.srid !== null ? `⬡ ${info.type} · ${info.srid}` : `⬡ ${info.type}`;
}
