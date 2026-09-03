/**
 * Three ordinary columns into a map (src/utils/geoTrack.ts).
 *
 * Most spatial data is not PostGIS — it is `recorded_at`, `lat`, `lon` in an
 * ordinary MySQL table. The failure modes this file pins are the ones that
 * make such a map quietly wrong rather than visibly broken:
 *
 *  - latitude and longitude swapped (the values know; the names often lie);
 *  - epoch seconds read as milliseconds, putting the track in the year 56,000
 *    and collapsing it to one pixel;
 *  - rows silently dropped, so the map is a subset nobody was told about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnFacts, factsLabel, parseTime, buildTrack, project, fitViewport, toScreen,
  indexAtTime, step, hitTest, trackLength, tilesInView, zoomViewport,
} from '../src/utils/geoTrack.ts';

// ── time parsing ────────────────────────────────────────────────────────────

test('the usual time spellings all parse', () => {
  const expected = Date.parse('2026-08-10T17:04:05');
  assert.equal(parseTime('2026-08-10 17:04:05'), expected);
  assert.equal(parseTime('2026-08-10T17:04:05'), expected);
  assert.equal(parseTime(new Date(expected)), expected);
});

test('an epoch is read at the right magnitude', () => {
  // Seconds read as milliseconds put the point in 1970; milliseconds read as
  // seconds put it in the year 56,000. Either collapses the whole track.
  const ms = Date.parse('2026-08-10T17:04:05');
  const sec = Math.floor(ms / 1000);
  assert.equal(parseTime(sec), sec * 1000);
  assert.equal(parseTime(ms), ms);
  assert.equal(parseTime(ms * 1000), ms, 'microseconds');
  assert.equal(parseTime(ms * 1_000_000), ms, 'nanoseconds');
});

test('nothing, empty and nonsense are not times', () => {
  for (const v of [null, undefined, '', '  ', 'not a date', 0, -5]) {
    assert.equal(parseTime(v), null, JSON.stringify(v));
  }
});

// ── what the picker shows ───────────────────────────────────────────────────

const COLUMNS = ['id', 'recorded_at', 'lat', 'lon', 'speed'];
const ROWS: unknown[][] = [
  [1, '2026-08-10 10:00:00', 50.08, 14.43, 12],
  [2, '2026-08-10 10:01:00', 50.09, 14.44, 15],
  [3, '2026-08-10 10:02:00', 50.10, 14.45, 9],
];

test('every column is described, and none is chosen', () => {
  // The user names the three columns. A guess is right often enough to be
  // trusted and wrong often enough to mislead — `lat`/`lon` are swapped
  // constantly and an `id` parses as an epoch — so this reports and never
  // decides.
  const facts = columnFacts(COLUMNS, ROWS);
  assert.equal(facts.length, COLUMNS.length, 'every column is offered, including the unlikely ones');
  assert.deepEqual(facts.map(f => f.name), COLUMNS);
  assert.deepEqual(facts.map(f => f.index), [0, 1, 2, 3, 4]);
});

test('the facts are facts: counts and ranges, no verdict', () => {
  const [id, at, lat] = columnFacts(COLUMNS, ROWS);
  assert.equal(lat.numeric, 3);
  assert.equal(lat.min, 50.08);
  assert.equal(lat.max, 50.10);
  assert.equal(at.timeLike, 3);
  assert.equal(at.numeric, 0);
  // An id is numeric and parses as an epoch. Both are stated; neither is a
  // recommendation, and nothing excludes it from the picker.
  assert.equal(id.numeric, 3);
  assert.equal(id.timeLike, 3);
});

test('the label reads at a glance', () => {
  const facts = columnFacts(COLUMNS, ROWS);
  assert.match(factsLabel(facts[2]), /3\/3 numeric/);
  assert.match(factsLabel(facts[2]), /50\.08 … 50\.1/);
  assert.match(factsLabel(facts[1]), /3\/3 parse as a time/);
});

test('a column with nothing usable says so rather than looking empty', () => {
  const facts = columnFacts(['note'], [['hello'], ['world']]);
  assert.equal(factsLabel(facts[0]), 'no numeric or time values');
});

test('a huge result is sampled, not walked', () => {
  const rows = Array.from({ length: 100_000 }, (_, i) => [i, 50 + i / 1e6]);
  const facts = columnFacts(['id', 'lat'], rows);
  assert.ok(facts[0].sampled <= 200);
  assert.ok(facts[0].sampled > 0);
});

// ── building the track ──────────────────────────────────────────────────────

test('a track keeps the row index so the grid can follow the map', () => {
  const t = buildTrack(ROWS, { timeIndex: 1, latIndex: 2, lonIndex: 3 });
  assert.deepEqual(t.points.map(p => p.row), [0, 1, 2]);
  assert.equal(t.points[0].lat, 50.08);
});

test('out-of-order rows are sorted by time, and it says so', () => {
  const rows = [ROWS[2], ROWS[0], ROWS[1]];
  const t = buildTrack(rows, { timeIndex: 1, latIndex: 2, lonIndex: 3 });
  assert.equal(t.reordered, true);
  assert.deepEqual(t.points.map(p => p.lat), [50.08, 50.09, 50.10]);
});

test('with no time column the rows keep the order the query returned', () => {
  // An ORDER BY the user wrote is already the order they meant.
  const rows = [ROWS[2], ROWS[0], ROWS[1]];
  const t = buildTrack(rows, { timeIndex: null, latIndex: 2, lonIndex: 3 });
  assert.equal(t.reordered, false);
  assert.deepEqual(t.points.map(p => p.lat), [50.10, 50.08, 50.09]);
});

test('unusable rows are counted, never quietly dropped', () => {
  const rows: unknown[][] = [
    [1, '2026-08-10 10:00:00', 50.08, 14.43],
    [2, 'not a time', 50.09, 14.44],
    [3, '2026-08-10 10:02:00', null, 14.45],
    [4, '2026-08-10 10:03:00', 950, 14.46],
  ];
  const t = buildTrack(rows, { timeIndex: 1, latIndex: 2, lonIndex: 3 });
  assert.equal(t.points.length, 1);
  assert.deepEqual(t.skipped, { noTime: 1, noCoords: 1, outOfRange: 1 });
});

test('an empty track has no bounds rather than a zero-size one', () => {
  assert.equal(buildTrack([], { timeIndex: null, latIndex: 0, lonIndex: 1 }).bounds, null);
});

// ── grouping by a column (car_id) ────────────────────────────────────────────

// cols: [car_id, time, lat, lon] — two cars, interleaved in time.
const FLEET: unknown[][] = [
  [2, '2026-08-10 10:00:00', 50.20, 14.60],
  [1, '2026-08-10 10:00:01', 50.10, 14.50],
  [2, '2026-08-10 10:00:02', 50.21, 14.61],
  [1, '2026-08-10 10:00:03', 50.11, 14.51],
];

test('without a group column the whole result is one track', () => {
  const t = buildTrack(FLEET, { timeIndex: 1, latIndex: 2, lonIndex: 3 });
  assert.equal(t.groups.length, 1);
  assert.equal(t.groups[0].points.length, 4);
});

test('grouping splits into one time-sorted track per value, ordered by key', () => {
  const t = buildTrack(FLEET, { timeIndex: 1, latIndex: 2, lonIndex: 3, groupIndex: 0 });
  assert.deepEqual(t.groups.map(g => g.key), ['1', '2']);   // numeric key order
  // Each car's points, on their own, in time order — no cross-car stitching.
  assert.deepEqual(t.groups[0].points.map(p => p.row), [1, 3]);
  assert.deepEqual(t.groups[1].points.map(p => p.row), [0, 2]);
  // Points carry their series tag.
  assert.equal(t.groups[0].points[0].series, '1');
});

test('numeric car ids sort as numbers, not as text', () => {
  const rows: unknown[][] = [
    [10, '2026-08-10 10:00:00', 50.1, 14.5],
    [2, '2026-08-10 10:00:00', 50.2, 14.6],
  ];
  const t = buildTrack(rows, { timeIndex: 1, latIndex: 2, lonIndex: 3, groupIndex: 0 });
  assert.deepEqual(t.groups.map(g => g.key), ['2', '10']);  // not ['10','2']
});

// ── projection ──────────────────────────────────────────────────────────────

test('Web Mercator puts the origin in the middle and the north at the top', () => {
  const eq = project(0, 0);
  assert.ok(Math.abs(eq.x - 0.5) < 1e-9);
  assert.ok(Math.abs(eq.y - 0.5) < 1e-9);
  assert.ok(project(0, 60).y < eq.y, 'north is up');
  assert.ok(project(90, 0).x > eq.x, 'east is right');
});

test('the poles are clamped instead of becoming infinite', () => {
  // Mercator sends ±90° to infinity. Clamping at ±85.05112878° is what makes
  // the projection a unit square — so the pole lands on the very edge of it,
  // and floating point may put it a hair either side of the boundary.
  const north = project(0, 90);
  const south = project(0, -90);
  assert.ok(Number.isFinite(north.y) && Number.isFinite(south.y));
  assert.ok(Math.abs(north.y) < 1e-9, `north ${north.y}`);
  assert.ok(Math.abs(south.y - 1) < 1e-9, `south ${south.y}`);
});

test('a single point gets a viewport instead of an infinite zoom', () => {
  const v = fitViewport({ minLat: 50, maxLat: 50, minLon: 14, maxLon: 14 }, 400, 300);
  assert.ok(Number.isFinite(v.scale) && v.scale > 0);
  const s = toScreen(v, 14, 50);
  assert.ok(s.x > 0 && s.x < 400 && s.y > 0 && s.y < 300);
});

test('a fitted box lands inside the rectangle, padded', () => {
  const bounds = { minLat: 50.0, maxLat: 50.2, minLon: 14.4, maxLon: 14.6 };
  const v = fitViewport(bounds, 400, 300, 20);
  for (const [lon, lat] of [[14.4, 50.0], [14.6, 50.2], [14.5, 50.1]]) {
    const s = toScreen(v, lon, lat);
    assert.ok(s.x >= 19 && s.x <= 381, `x ${s.x}`);
    assert.ok(s.y >= 19 && s.y <= 281, `y ${s.y}`);
  }
});

// ── moving through it ───────────────────────────────────────────────────────

const TRACK = buildTrack(ROWS, { timeIndex: 1, latIndex: 2, lonIndex: 3 }).points;

test('scrubbing lands on the nearest point in time', () => {
  assert.equal(indexAtTime(TRACK, TRACK[0].t - 10_000), 0, 'before the start clamps to the start');
  assert.equal(indexAtTime(TRACK, TRACK[2].t + 10_000), 2, 'after the end clamps to the end');
  assert.equal(indexAtTime(TRACK, TRACK[1].t), 1);
  // 20 s past the second point of a 60 s interval is still nearest to it.
  assert.equal(indexAtTime(TRACK, TRACK[1].t + 20_000), 1);
  assert.equal(indexAtTime(TRACK, TRACK[1].t + 40_000), 2);
});

test('stepping clamps at both ends rather than wrapping', () => {
  // A scrubber that wraps loses your place at exactly the moment you are
  // reading carefully.
  assert.equal(step(TRACK, 0, -1), 0);
  assert.equal(step(TRACK, 2, 1), 2);
  assert.equal(step(TRACK, 0, 1), 1);
  assert.equal(step(TRACK, 0, 10), 2);
});

test('clicking near a point selects it, and clicking away selects nothing', () => {
  const v = fitViewport(
    { minLat: 50.08, maxLat: 50.10, minLon: 14.43, maxLon: 14.45 }, 400, 300);
  const s = toScreen(v, TRACK[1].lon, TRACK[1].lat);
  assert.equal(hitTest(TRACK, v, s.x + 2, s.y + 2), 1);
  assert.equal(hitTest(TRACK, v, s.x + 200, s.y + 200), null);
});

test('the track length is a real distance', () => {
  // Prague to Brno is about 185 km in a straight line.
  const prague = { row: 0, t: 0, lat: 50.08, lon: 14.44 };
  const brno = { row: 1, t: 1, lat: 49.20, lon: 16.61 };
  const km = trackLength([prague, brno]) / 1000;
  assert.ok(km > 175 && km < 195, `${km} km`);
  assert.equal(trackLength([prague]), 0);
});

// ── OSM tiles + zoom ─────────────────────────────────────────────────────────

test('tilesInView returns the single world tile at zoom 0', () => {
  const tiles = tilesInView({ scale: 256, offsetX: 0, offsetY: 0 }, 256, 256);
  assert.equal(tiles.length, 1);
  assert.deepEqual(
    { z: tiles[0].z, x: tiles[0].x, y: tiles[0].y, sx: tiles[0].sx, sy: tiles[0].sy, size: tiles[0].size },
    { z: 0, x: 0, y: 0, sx: 0, sy: 0, size: 256 });
});

test('tilesInView picks the zoom whose 256px tiles match the scale', () => {
  // scale 512 = the world is 512px wide → zoom 1 → 2×2 tiles of 256px each.
  const tiles = tilesInView({ scale: 512, offsetX: 0, offsetY: 0 }, 512, 512);
  assert.equal(tiles.every(t => t.z === 1), true);
  assert.equal(tiles.length, 4);           // the whole 2×2 grid is visible
  assert.equal(tiles.every(t => t.size === 256), true);
});

test('tiles wrap in longitude but never in latitude', () => {
  // Pan so the left edge is west of the antimeridian; x wraps, y stays in range.
  const tiles = tilesInView({ scale: 256, offsetX: 100, offsetY: 0 }, 256, 256);
  assert.ok(tiles.every(t => t.x >= 0 && t.x < 1));   // n=1 → always 0
  assert.ok(tiles.every(t => t.y >= 0 && t.y < 1));
});

test('zoomViewport keeps the point under the cursor fixed', () => {
  const v = { scale: 100, offsetX: 0, offsetY: 0 };
  const z = zoomViewport(v, 2, 50, 30);
  assert.equal(z.scale, 200);
  // The world point at screen (50,30) must map back to (50,30) after zoom.
  assert.equal(50 * (200 / 100) + z.offsetX, 50);  // wx=0.5 → 0.5*200+offset
  const wx = (50 - v.offsetX) / v.scale, wy = (30 - v.offsetY) / v.scale;
  assert.ok(Math.abs(wx * z.scale + z.offsetX - 50) < 1e-9);
  assert.ok(Math.abs(wy * z.scale + z.offsetY - 30) < 1e-9);
});
