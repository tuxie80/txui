/**
 * Redis "view as geo" pure logic (src/utils/redisGeo.ts).
 * The honesty contract: GEOPOS decodes any zset score (verified live against
 * redis-server 8.10 — a leaderboard's scores come back as corner garbage), so
 * the summary reports counts, never a geo/non-geo guess from the scores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEO_POINT_CAP, GEO_DERIVATION_NOTE,
  geoSummary, geoExtent, projectPoints, niceStep, graticuleLines, geoResultSet,
  type RedisGeoResult, type RedisGeoPoint,
} from '../src/utils/redisGeo.ts';

const pt = (member: string, lon: number, lat: number): RedisGeoPoint => ({ member, lon, lat });

function result(over: Partial<RedisGeoResult>): RedisGeoResult {
  return { key: 'k', total: 0, scanned: 0, missing: 0, truncated: false, points: [], ...over };
}

test('summary: not a geo key only when GEOPOS answered nil for everyone', () => {
  const s = geoSummary(result({ scanned: 200, missing: 200 }));
  assert.match(s, /Not a geo key/);
  assert.match(s, /200 members/);
});

test('summary: partial misses are counted against the scanned page', () => {
  const s = geoSummary(result({
    scanned: 200, missing: 3, points: Array.from({ length: 197 }, (_, i) => pt(`m${i}`, i, i)),
  }));
  assert.match(s, /197 members located/);
  assert.match(s, /3 of 200 members have no coordinates/);
});

test('summary: truncation says the cap and the total', () => {
  const s = geoSummary(result({
    total: 12000, scanned: 5000, truncated: true,
    points: [pt('a', 1, 1)],
  }));
  assert.match(s, /capped at 5,000 of 12,000 members/);
});

test('summary: clean full resolve and empty key', () => {
  assert.equal(
    geoSummary(result({ scanned: 2, points: [pt('a', 1, 1), pt('b', 2, 2)] })),
    '2 members located');
  assert.equal(geoSummary(result({})), 'Empty key — no members to resolve.');
  assert.match(geoSummary(result({ scanned: 1, points: [pt('a', 1, 1)] })), /1 member located/);
});

test('cap mirrors the backend and the derivation note exists', () => {
  assert.equal(GEO_POINT_CAP, 5000);
  assert.match(GEO_DERIVATION_NOTE, /GEOPOS/);
});

test('geoExtent: bounds, singleton, empty', () => {
  assert.equal(geoExtent([]), null);
  assert.deepEqual(geoExtent([pt('a', 13.3, 38.1)]), { minLon: 13.3, minLat: 38.1, maxLon: 13.3, maxLat: 38.1 });
  const e = geoExtent([pt('a', -10, 5), pt('b', 20, -3), pt('c', 0, 42)])!;
  assert.deepEqual(e, { minLon: -10, minLat: -3, maxLon: 20, maxLat: 42 });
});

test('projectPoints: extent corners land at the padding, north is up', () => {
  const pts = [pt('sw', -10, -5), pt('ne', 30, 45)];
  const [sw, ne] = projectPoints(pts, 400, 200, 20);
  assert.deepEqual([sw.x, sw.y], [20, 180]);     // min lon left, min lat BOTTOM
  assert.deepEqual([ne.x, ne.y], [380, 20]);     // max lon right, max lat TOP
});

test('projectPoints: a single point (degenerate extent) is centred, not NaN', () => {
  const [p] = projectPoints([pt('only', 13.36, 38.11)], 400, 200, 20);
  assert.equal(p.x, 200);
  assert.equal(p.y, 100);
  // All-on-one-meridian: latitude still spreads vertically, x centred.
  const [a, b] = projectPoints([pt('s', 5, 0), pt('n', 5, 10)], 400, 200, 20);
  assert.equal(a.x, 200); assert.equal(b.x, 200);
  assert.equal(a.y, 180); assert.equal(b.y, 20);
});

test('niceStep: 1/2/5×10ⁿ targeting a handful of divisions', () => {
  assert.equal(niceStep(360), 100);   // worldwide lon
  assert.equal(niceStep(170), 50);    // worldwide lat
  assert.equal(niceStep(1.4), 0.5);   // region
  assert.equal(niceStep(0.02), 0.005);// city block
  assert.equal(niceStep(0), 1);       // degenerate → sane default
});

test('graticuleLines: nice values inside the range, zero is exact', () => {
  assert.deepEqual(graticuleLines(-10, 30), [-10, 0, 10, 20, 30]);
  const city = graticuleLines(13.32, 13.40);
  assert.ok(city.every(v => v >= 13.32 && v <= 13.40), city.join(','));
  assert.ok(city.length >= 2 && city.length <= 9, city.join(','));
  // A worldwide range does not explode into thousands of lines.
  assert.ok(graticuleLines(-180, 180).length <= 10);
  assert.deepEqual(graticuleLines(5, 5).length > 0, true);
});

test('geoResultSet: the member/lon/lat synthetic result-set seam', () => {
  const rs = geoResultSet([pt('Palermo', 13.36, 38.12), pt('Paris', 2.35, 48.86)]);
  assert.deepEqual(rs.columns.map(c => c.name), ['member', 'lon', 'lat']);
  assert.deepEqual(rs.columns.map(c => c.typeName), ['string', 'float', 'float']);
  assert.deepEqual(rs.rows, [['Palermo', 13.36, 38.12], ['Paris', 2.35, 48.86]]);
});
