/**
 * GeoParquet footer metadata (spec 1.x) — the frontend view of the `geo` key
 * a Parquet file carries in its key/value footer metadata.
 *
 * The Rust backend (src-tauri/src/db/parquet.rs) parses the same JSON for
 * FILEINFO and column annotation; these helpers exist for what only the
 * frontend can do with it: a plain-language CRS label, and the footer bbox as
 * a map viewport hint. The parse is tolerant — unknown fields are ignored, so
 * a newer spec version never breaks the read.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { Bbox } from './wkb';

/**
 * The spec keeps three CRS statements apart, and so do we:
 * the field ABSENT means OGC:CRS84 (lon/lat WGS 84 — the default drawable
 * case), an explicit null means the producer does not know, and an object is
 * PROJJSON.
 */
export type CrsVerdict =
  | { kind: 'default-crs84' }
  | { kind: 'unknown' }
  | { kind: 'projjson'; label: string };

export interface GeoColumnInfo {
  /** "WKB", or a 1.1 native GeoArrow encoding ("point", "linestring", …). */
  encoding: string;
  /** May be empty when the writer did not record them. */
  geometryTypes: string[];
  crs: CrsVerdict;
  /** RFC 7946 order: [west, south, east, north], plus an optional z pair. */
  bbox: number[] | null;
  /** 1.1: the column has a covering (per-row bbox struct) pointer. */
  hasCovering: boolean;
}

export interface GeoParquetMeta {
  version: string;
  primaryColumn: string;
  columns: Record<string, GeoColumnInfo>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A short name for a PROJJSON object: its authority id ("EPSG:4326"), else
 * its own name, else an honest fallback. */
function projjsonLabel(v: Record<string, unknown>): string {
  const id = asRecord(v.id);
  if (id) {
    const code = typeof id.code === 'number' || typeof id.code === 'string' ? String(id.code) : null;
    const authority = typeof id.authority === 'string' ? id.authority : null;
    if (authority && code) return `${authority}:${code}`;
    if (code) return `code ${code}`;
  }
  if (typeof v.name === 'string' && v.name) return `${v.name} (PROJJSON)`;
  return 'custom CRS (PROJJSON)';
}

function parseColumn(raw: unknown): GeoColumnInfo {
  const c = asRecord(raw) ?? {};
  const crs: CrsVerdict = !('crs' in c)
    ? { kind: 'default-crs84' }
    : c.crs === null || c.crs === undefined
      ? { kind: 'unknown' }
      : { kind: 'projjson', label: projjsonLabel(asRecord(c.crs) ?? {}) };
  const types = Array.isArray(c.geometry_types)
    ? c.geometry_types.filter((t): t is string => typeof t === 'string')
    : [];
  const bbox = Array.isArray(c.bbox) && c.bbox.every(v => typeof v === 'number')
    ? (c.bbox as number[])
    : null;
  return {
    encoding: typeof c.encoding === 'string' ? c.encoding : '',
    geometryTypes: types,
    crs,
    bbox,
    hasCovering: 'covering' in c && c.covering != null,
  };
}

/**
 * Parse the `geo` metadata value — a JSON string as stored in the footer, or
 * an already-parsed object. Returns null for anything that is not a GeoParquet
 * object (the file is then treated as plain Parquet).
 */
export function parseGeoMetadata(raw: unknown): GeoParquetMeta | null {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const obj = asRecord(v);
  if (!obj) return null;
  const columns: Record<string, GeoColumnInfo> = {};
  const cols = asRecord(obj.columns);
  if (cols) {
    for (const [name, col] of Object.entries(cols)) columns[name] = parseColumn(col);
  }
  return {
    version: typeof obj.version === 'string' ? obj.version : '',
    primaryColumn: typeof obj.primary_column === 'string' ? obj.primary_column : '',
    columns,
  };
}

/** The CRS as a plain label: "WGS 84 lon/lat" for the spec default, "unknown
 * CRS" for an explicit null. */
export function crsLabel(crs: CrsVerdict): string {
  switch (crs.kind) {
    case 'default-crs84':
      return 'WGS 84 lon/lat';
    case 'unknown':
      return 'unknown CRS';
    case 'projjson':
      return crs.label;
  }
}

/**
 * The primary column's bbox as a map viewport hint — the footer knows the
 * file's extent without scanning a single row. RFC 7946 order; a 3D bbox (six
 * numbers) contributes its first four. Null when absent or malformed.
 */
export function geoBbox(meta: GeoParquetMeta): Bbox | null {
  const b = meta.columns[meta.primaryColumn]?.bbox;
  if (!b || b.length < 4) return null;
  const [minX, minY, maxX, maxY] = b;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * The raw `geo` value out of a KEYVALUE command result (columns: key, value) —
 * how the frontend gets at the metadata without a new backend channel.
 */
export function geoFromKeyValueRows(rows: unknown[][]): string | null {
  for (const row of rows) {
    if (row[0] === 'geo' && typeof row[1] === 'string') return row[1];
  }
  return null;
}

/**
 * `QueryResult.geo_bbox` — [west, south, east, north] off the wire — as the
 * bounds object MapView's fit takes, or null when the hint is unusable.
 *
 * Rejected: non-finite numbers, south > north, and west > east. The last is
 * RFC 7946's way of saying the bbox crosses the antimeridian, which the
 * Mercator fit cannot express — dropping the hint beats fitting the viewport
 * to nearly the whole world. The decoded rows' own bbox is the fallback, as
 * before.
 */
export function wireBboxToBounds(
  b: unknown,
): { minLat: number; maxLat: number; minLon: number; maxLon: number } | null {
  if (!Array.isArray(b) || b.length < 4) return null;
  const [w, s, e, n] = b;
  if (![w, s, e, n].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  if (w > e || s > n) return null;
  return { minLon: w, minLat: s, maxLon: e, maxLat: n };
}
