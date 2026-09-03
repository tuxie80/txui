/**
 * A map from three ordinary columns: a time and two coordinates.
 *
 * PostGIS is not how most spatial data is actually stored. The overwhelming
 * majority of it — every fleet, every delivery, every sensor, every phone —
 * is three plain columns in an ordinary table: `recorded_at`, `lat`, `lon`.
 * MySQL, SQLite, ClickHouse and a Parquet file all hold that shape, and no
 * database GUI will draw it.
 *
 * So this is deliberately **engine-agnostic and geometry-free**. It takes a
 * result set that has already arrived plus the three columns the user named —
 * a timestamp and two coordinates — and builds an ordered track. The map is
 * then a lens over the rows in the grid: step through it, scrub it, click a
 * point to select its row — and the reverse.
 *
 * Rules it follows, all of them learned from data that is never as clean as
 * the schema suggests:
 *
 *  - **The user names the three columns. Nothing is auto-detected.** A guess
 *    is right often enough to be trusted and wrong often enough to mislead:
 *    `lat`/`lon` are swapped constantly, an `id` parses as an epoch, and a
 *    column of projected metres is called `lat` in half the schemas that have
 *    one. A map drawn from a guess is confidently wrong, which is worse than
 *    no map. So this module takes explicit indices and draws exactly them.
 *  - **What it can say about a column, it says as fact, not as a verdict.**
 *    `columnFacts` reports how many sampled values parse and what their range
 *    is, next to each option in the picker. The reader decides.
 *  - **Bad rows are counted, not dropped silently.** A track that quietly
 *    omits 4,000 unparseable rows is a lie in the shape of a map.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

/** Parse a cell as a time: ISO, `YYYY-MM-DD HH:MM:SS`, or an epoch number. */
export function parseTime(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return epochToMs(v);
  const s = String(v).trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return epochToMs(Number(s));
  // `2026-08-10 17:04:05` is not ISO until the space becomes a T; without
  // that, browsers disagree about whether it parses at all.
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') : s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Epoch seconds, milliseconds, microseconds or nanoseconds — decided by
 * magnitude.
 *
 * A bare number is ambiguous and the ambiguity is not academic: reading
 * milliseconds as seconds puts the point in the year 56,000 and the whole
 * track collapses to one pixel. The thresholds are picked so that any instant
 * from the 1970s to the far future resolves the same way.
 */
function epochToMs(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e17) return n / 1e6;       // nanoseconds
  if (n > 1e14) return n / 1000;      // microseconds
  if (n > 1e11) return n;             // milliseconds
  return n * 1000;                    // seconds
}

function asNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** Sample rows without walking a million of them. */
function sample<T>(rows: T[], max = 200): T[] {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
  return out;
}

/**
 * What is actually in a column, for the picker to show beside each option.
 *
 * Facts, not a verdict: "142/200 sampled values parse as a time", "range
 * -180.0 … 179.9". Enough for someone who knows their schema to choose in one
 * glance, and nothing that chooses for them.
 */
export interface ColumnFacts {
  index: number;
  name: string;
  /** Sampled rows examined. */
  sampled: number;
  /** How many parsed as a number, and their range when any did. */
  numeric: number;
  min: number | null;
  max: number | null;
  /** How many parsed as a time. */
  timeLike: number;
}

export function columnFacts(columns: string[], rows: unknown[][]): ColumnFacts[] {
  const rs = sample(rows);
  return columns.map((name, i) => {
    const values = rs.map(r => r[i]);
    const nums = values.map(asNumber).filter((n): n is number => n !== null);
    const times = values.map(parseTime).filter((t): t is number => t !== null);
    return {
      index: i,
      name,
      sampled: values.length,
      numeric: nums.length,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      timeLike: times.length,
    };
  });
}

/** One line of those facts, for the option label. */
export function factsLabel(f: ColumnFacts): string {
  if (f.sampled === 0) return 'no rows sampled';
  const bits: string[] = [];
  if (f.numeric > 0) {
    bits.push(`${f.numeric}/${f.sampled} numeric`);
    if (f.min !== null && f.max !== null) {
      const r = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(4).replace(/\.?0+$/, ''));
      bits.push(`${r(f.min)} … ${r(f.max)}`);
    }
  }
  if (f.timeLike > 0) bits.push(`${f.timeLike}/${f.sampled} parse as a time`);
  return bits.length ? bits.join(' · ') : 'no numeric or time values';
}

// ── the track ───────────────────────────────────────────────────────────────

export interface TrackPoint {
  /** Index of the row this came from, so the grid can be selected from the map. */
  row: number;
  /** Epoch ms. */
  t: number;
  lat: number;
  lon: number;
  /** The group this point belongs to (e.g. a car_id), when grouping is on. */
  series?: string;
}

/** One track within a grouped result — the pings of a single car_id. */
export interface TrackGroup {
  key: string;
  points: TrackPoint[];
}

export interface Track {
  points: TrackPoint[];
  /**
   * One entry per distinct group value, each sorted by time — so a fleet draws
   * as one polyline per car rather than one zigzag stitching every car
   * together. Without a group column this is a single group holding everything.
   */
  groups: TrackGroup[];
  /** Rows that could not be used, and why — never silently dropped. */
  skipped: { noTime: number; noCoords: number; outOfRange: number };
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  /** True when the points are not in the order the rows were. */
  reordered: boolean;
}

export interface TrackSpec {
  timeIndex: number | null;
  latIndex: number;
  lonIndex: number;
  /** Column to split the track by (e.g. car_id). null = one track. */
  groupIndex?: number | null;
}

/** Order two group keys numerically when both are numbers, else as text. */
function compareKeys(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the track.
 *
 * Sorted by time when there is one, otherwise left in row order — which is
 * the honest default: a result with an `ORDER BY` the user chose is already
 * in the order they meant.
 */
export function buildTrack(rows: unknown[][], spec: TrackSpec): Track {
  const points: TrackPoint[] = [];
  const skipped = { noTime: 0, noCoords: 0, outOfRange: 0 };

  const grouping = spec.groupIndex != null;
  rows.forEach((r, i) => {
    const lat = asNumber(r[spec.latIndex]);
    const lon = asNumber(r[spec.lonIndex]);
    if (lat === null || lon === null) { skipped.noCoords += 1; return; }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) { skipped.outOfRange += 1; return; }
    let t = i;
    if (spec.timeIndex !== null) {
      const parsed = parseTime(r[spec.timeIndex]);
      if (parsed === null) { skipped.noTime += 1; return; }
      t = parsed;
    }
    const series = grouping ? String(r[spec.groupIndex as number] ?? '') : undefined;
    points.push({ row: i, t, lat, lon, series });
  });

  let reordered = false;
  if (spec.timeIndex !== null) {
    for (let i = 1; i < points.length; i++) {
      if (points[i].t < points[i - 1].t) { reordered = true; break; }
    }
    // A stable sort keeps rows that share a timestamp in the order the query
    // returned them, which is the only ordering information left.
    if (reordered) points.sort((a, b) => a.t - b.t);
  }

  // Split into per-group tracks. Each group is time-sorted on its own, so one
  // car's path never jumps to another's — the zigzag that makes a fleet
  // unreadable when it is drawn as a single line.
  let groups: TrackGroup[];
  if (!grouping) {
    groups = points.length ? [{ key: '', points }] : [];
  } else {
    const map = new Map<string, TrackPoint[]>();
    for (const p of points) {
      const k = p.series ?? '';
      const arr = map.get(k);
      if (arr) arr.push(p); else map.set(k, [p]);
    }
    groups = [...map.entries()]
      .map(([key, pts]) => ({
        key,
        points: spec.timeIndex !== null ? [...pts].sort((a, b) => a.t - b.t) : pts,
      }))
      .sort((a, b) => compareKeys(a.key, b.key));
  }

  const bounds = points.length === 0 ? null : points.reduce(
    (b, p) => ({
      minLat: Math.min(b.minLat, p.lat), maxLat: Math.max(b.maxLat, p.lat),
      minLon: Math.min(b.minLon, p.lon), maxLon: Math.max(b.maxLon, p.lon),
    }),
    { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 });

  return { points, groups, skipped, bounds, reordered };
}

// ── projection ──────────────────────────────────────────────────────────────

/**
 * Web Mercator, normalised to 0–1.
 *
 * Chosen because it is what every map anyone has seen looks like, so a
 * coastline drawn in it is recognisable. Latitude is clamped to ±85.05° —
 * the poles are at infinity in this projection, and one row at 90° would
 * otherwise stretch the viewport to nothing.
 */
export function project(lon: number, lat: number): { x: number; y: number } {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = (lon + 180) / 360;
  const s = Math.sin((clamped * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return { x, y };
}

export interface Viewport {
  /** Multiply a projected 0–1 coordinate by this, then add the offset. */
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Fit a bounding box into a pixel rectangle, preserving aspect.
 *
 * A single point has no extent, so it gets a small window around it rather
 * than an infinite zoom — the failure mode that would otherwise divide by
 * zero on every fleet with one vehicle.
 */
export function fitViewport(
  bounds: NonNullable<Track['bounds']>,
  width: number,
  height: number,
  padding = 24,
): Viewport {
  const a = project(bounds.minLon, bounds.maxLat);   // top-left
  const b = project(bounds.maxLon, bounds.minLat);   // bottom-right
  const spanX = Math.max(b.x - a.x, 1e-6);
  const spanY = Math.max(b.y - a.y, 1e-6);
  const w = Math.max(1, width - padding * 2);
  const h = Math.max(1, height - padding * 2);
  const scale = Math.min(w / spanX, h / spanY);
  return {
    scale,
    offsetX: padding + (w - spanX * scale) / 2 - a.x * scale,
    offsetY: padding + (h - spanY * scale) / 2 - a.y * scale,
  };
}

export function toScreen(v: Viewport, lon: number, lat: number): { x: number; y: number } {
  const p = project(lon, lat);
  return { x: p.x * v.scale + v.offsetX, y: p.y * v.scale + v.offsetY };
}

export interface TileRef {
  z: number; x: number; y: number;
  /** Screen position (top-left) and side length in CSS pixels. */
  sx: number; sy: number; size: number;
}

/**
 * The OSM/XYZ tiles covering the viewport.
 *
 * The `Viewport.scale` is exactly the pixel size of the whole 0–1 Web-Mercator
 * world, so it doubles as the slippy-map world size: the tile zoom is the power
 * of two whose 256-px tiles best match it, and a tile at (x, y) sits at
 * `x/2^z · scale + offset`. Fractional zoom is absorbed by scaling each 256-px
 * image to `size`, so panning and wheel-zoom stay smooth instead of snapping.
 */
export function tilesInView(v: Viewport, width: number, height: number): TileRef[] {
  const world = v.scale;
  const z = Math.max(0, Math.min(19, Math.round(Math.log2(world / 256))));
  const n = 2 ** z;
  const tileSize = world / n;                       // on-screen px per tile
  const wx0 = (0 - v.offsetX) / world, wx1 = (width - v.offsetX) / world;
  const wy0 = (0 - v.offsetY) / world, wy1 = (height - v.offsetY) / world;
  // ceil−1 on the far edge excludes a tile the view only touches at its border.
  const tx0 = Math.floor(wx0 * n), tx1 = Math.ceil(wx1 * n) - 1;
  const ty0 = Math.floor(wy0 * n), ty1 = Math.ceil(wy1 * n) - 1;
  const out: TileRef[] = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= n) continue;              // no wrap in latitude
      out.push({
        z,
        x: ((tx % n) + n) % n,                       // wrap in longitude
        y: ty,
        sx: (tx / n) * world + v.offsetX,
        sy: (ty / n) * world + v.offsetY,
        size: tileSize,
      });
    }
  }
  return out;
}

/** Zoom a viewport by `factor`, keeping the point under (px, py) fixed. */
export function zoomViewport(v: Viewport, factor: number, px: number, py: number): Viewport {
  return {
    scale: v.scale * factor,
    offsetX: px - (px - v.offsetX) * factor,
    offsetY: py - (py - v.offsetY) * factor,
  };
}

// ── moving through it ───────────────────────────────────────────────────────

/** The point nearest a moment in time — what a scrubber lands on. */
export function indexAtTime(points: TrackPoint[], t: number): number {
  if (points.length === 0) return -1;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  // Binary search lands on the first point at or after `t`; the nearer of it
  // and its predecessor is the one under the cursor.
  if (lo > 0 && Math.abs(points[lo - 1].t - t) <= Math.abs(points[lo].t - t)) return lo - 1;
  return lo;
}

/** Step, clamped at both ends — a scrubber that wraps loses your place. */
export function step(points: TrackPoint[], index: number, delta: number): number {
  if (points.length === 0) return -1;
  return Math.max(0, Math.min(points.length - 1, index + delta));
}

/** The point under the cursor, or null. `radius` is in pixels. */
export function hitTest(
  points: TrackPoint[], v: Viewport, px: number, py: number, radius = 8,
): number | null {
  let best: number | null = null;
  let bestD = radius * radius;
  for (let i = 0; i < points.length; i++) {
    const s = toScreen(v, points[i].lon, points[i].lat);
    const d = (s.x - px) ** 2 + (s.y - py) ** 2;
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Total great-circle length of the track, in metres. */
export function trackLength(points: TrackPoint[]): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    total += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return total;
}
