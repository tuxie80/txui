#!/usr/bin/env node
/**
 * Fetch the offline basemap, once, at development time.
 *
 * The 🗺 Map view never talks to the network. A tile basemap would be an HTTP
 * request per tile to a third party, carrying — tile by tile — exactly where
 * your data is; for a DBA looking at customer addresses that is a data-egress
 * event, and TxUI's promise is that nothing leaves the machine.
 *
 * So the coastline is *bundled*: a simplified, public-domain vector world map,
 * downloaded once by whoever builds the app and committed as a plain JSON
 * asset. No API, no key, no fee, no attribution requirement, and nothing at
 * runtime.
 *
 * **Source:** Natural Earth 1:110m land polygons. Natural Earth is explicitly
 * public domain ("no permission needed"), which is why it is chosen over the
 * alternatives — OSM extracts carry ODbL share-alike obligations that a
 * bundled asset in a closed-source app cannot satisfy cleanly.
 *
 *     node dev/fetch_basemap.mjs
 *
 * Writes `src/assets/basemap.json`. Re-run only to update it.
 *
 * If this ever 404s, the fix is to point `SOURCES` at any other host serving
 * the same public-domain dataset — the file format is ordinary GeoJSON and
 * nothing else in the app cares where it came from.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/assets/basemap.json');

/** Tried in order. Both serve the same public-domain Natural Earth data. */
const SOURCES = [
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson',
  'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json',
];

/**
 * Drop vertices that do not change the shape at map scale.
 *
 * Ramer–Douglas–Peucker with a tolerance in degrees. At 1:110m the source is
 * already coarse; this halves it again, and the difference is invisible at any
 * zoom this view offers.
 */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  let maxD = 0;
  let index = 0;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
    if (d > maxD) { maxD = d; index = i; }
  }
  if (maxD <= tolerance) return [points[0], points[points.length - 1]];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

/**
 * Simplify a CLOSED ring. Plain RDP cannot run on one directly: a ring's first
 * and last points are identical, so the baseline has zero length and every
 * vertex measures as "on the line" — the whole ring collapses to a point.
 * Split the ring at the vertex farthest from the anchor and simplify the two
 * halves as open polylines.
 */
function simplifyRing(r, tolerance) {
  if (r.length <= 4) return r;
  const [ax, ay] = r[0];
  let far = 0, farD = -1;
  for (let i = 1; i < r.length; i++) {
    const d = (r[i][0] - ax) ** 2 + (r[i][1] - ay) ** 2;
    if (d > farD) { farD = d; far = i; }
  }
  const a = simplify(r.slice(0, far + 1), tolerance);
  const b = simplify(r.slice(far), tolerance);
  return [...a, ...b.slice(1)];   // a ends at `far`, b restarts there
}

/** Round to ~1 km — far finer than the simplify tolerance, pure byte savings. */
const round = r => r.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);

function simplifyPolygon(rings, tolerance) {
  // Fewer than 4 points is not a ring; a polygon that loses its outer ring is
  // gone (a pinhead island at 1:110m, honestly absent rather than a dot).
  const out = rings.map(r => simplifyRing(r, tolerance)).filter(r => r.length >= 4).map(round);
  return out.length ? out : null;
}

function simplifyGeometry(geom, tolerance) {
  if (geom.type === 'Polygon') {
    const rings = simplifyPolygon(geom.coordinates, tolerance);
    return rings ? { ...geom, coordinates: rings } : null;
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates.map(p => simplifyPolygon(p, tolerance)).filter(Boolean);
    return polys.length ? { ...geom, coordinates: polys } : null;
  }
  return geom;
}

const TOLERANCE = 0.15;   // degrees

async function main() {
  let raw = null;
  for (const url of SOURCES) {
    try {
      process.stdout.write(`fetching ${url}\n`);
      const res = await fetch(url);
      if (!res.ok) { process.stdout.write(`  ${res.status} ${res.statusText}\n`); continue; }
      raw = await res.json();
      break;
    } catch (e) {
      process.stdout.write(`  failed: ${e.message}\n`);
    }
  }
  if (!raw) {
    process.stderr.write('No source reachable. The Map view works without a basemap —\n'
      + 'it draws a graticule and a scale bar — so this is optional.\n');
    process.exit(1);
  }

  // Only the geometry is kept: names, ids and every other property are dead
  // weight in an asset that exists to be drawn as an outline.
  const features = (raw.features ?? [])
    .map(f => simplifyGeometry(f.geometry, TOLERANCE))
    .filter(Boolean);   // geometries that simplified away entirely are dropped

  mkdirSync(dirname(OUT), { recursive: true });
  const out = JSON.stringify({
    source: 'Natural Earth 1:110m land (public domain)',
    simplifiedToleranceDegrees: TOLERANCE,
    geometries: features,
  });
  writeFileSync(OUT, out);
  process.stdout.write(`wrote ${OUT} — ${(out.length / 1024).toFixed(0)} KiB, `
    + `${features.length} geometries\n`);
}

main();
