/**
 * Geometry detection for result cells — the one probe MapView and CellViewer
 * share, sitting BESIDE wkb.ts (which owns binary decoding and is deliberately
 * untouched) rather than inside it.
 *
 * Three wire forms decode to the same `Geometry` structs:
 *
 *  1. **WKB/EWKB hex strings** (PostGIS, MySQL, GeoPackage, SpatiaLite,
 *     GeoParquet WKB) — `parseWkbHex`, tried first on strings: a valid hex
 *     wall is never valid JSON, so the two string probes cannot collide.
 *  2. **GeoJSON** (MongoDB sub-documents arrive as real objects; JSON columns
 *     and `ST_AsGeoJSON` output as strings) — `parseGeoJson`.
 *  3. **ClickHouse array geometries** (`Point`/`Ring`/`Polygon`/`MultiPolygon`
 *     arrive as nested arrays) — `parseChGeometry`, gated on the column's
 *     declared `type_name` because a bare `[x, y]` array proves nothing.
 *
 * The gate matters: `cellGeometry(value)` without a type name never touches
 * the ClickHouse decoder, so an arbitrary array cell cannot accidentally
 * become geometry.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { parseWkbHex } from './wkb.ts';
import type { Geometry } from './wkb';
import { parseGeoJson } from './geojsonDetect.ts';
import { parseChGeometry } from './chGeoDetect.ts';

/**
 * Decode one cell into a Geometry, or null. `typeName` is the column's
 * server-reported type when the caller has it (MapView does, via ColumnInfo);
 * without it the ClickHouse array forms are not attempted.
 */
export function cellGeometry(value: unknown, typeName?: string): Geometry | null {
  // The type-gated decoder first: a column the server CALLS Point is geometry
  // even when its array shape is ambiguous to everyone else.
  const ch = parseChGeometry(typeName, value);
  if (ch) return ch;
  if (typeof value === 'string') {
    const wkb = parseWkbHex(value);
    if (wkb) return wkb;
  }
  return parseGeoJson(value);
}

/**
 * Columns of a result set that decode as geometry, probed over the first
 * `sample` rows. Detection is a fact, not a guess: a cell either decodes or
 * it does not. One decodable cell is enough to list the column — sparse
 * columns (many NULLs) are still geometry columns.
 */
export function detectGeoColumns(
  columns: { name: string; typeName?: string }[],
  rows: unknown[][],
  sample = 20,
): { name: string; index: number }[] {
  const probe = rows.slice(0, sample);
  return columns
    .map((c, index) => ({ name: c.name, index, typeName: c.typeName }))
    .filter(({ index, typeName }) =>
      probe.some(r => cellGeometry(r[index], typeName) !== null))
    .map(({ name, index }) => ({ name, index }));
}
