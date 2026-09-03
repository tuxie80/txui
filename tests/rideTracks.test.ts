/**
 * Ride tracks — the properties that make the NYC taxi data realistic.
 *
 * Not asserting exact coordinates (the routes are real OSRM geometry that may
 * be refreshed); asserting the invariants a telematics table must hold: one car
 * per ride, time marching forward, car-adequate speed, points in New York and
 * ON the bundled road geometry, and full determinism so preview == insert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ridePing, type RideParams } from '../src/utils/rideTracks.ts';
import { NYC_ROUTES } from '../src/assets/nycRoutes.ts';

const base: RideParams = { ridePings: 200, pingSec: 2, baseEpochSec: 1_780_300_800 };

test('a car_id spans exactly one ride, oldest first', () => {
  assert.equal(ridePing(0, base).carId, 1);
  assert.equal(ridePing(199, base).carId, 1);
  assert.equal(ridePing(200, base).carId, 2);
  assert.equal(ridePing(400, base).carId, 3);
});

test('within a ride the clock marches forward by the ping interval', () => {
  assert.equal(ridePing(11, base).epochSec - ridePing(10, base).epochSec, base.pingSec);
});

test('the ping interval is user-controllable', () => {
  const p = { ...base, pingSec: 5 };
  assert.equal(ridePing(11, p).epochSec - ridePing(10, p).epochSec, 5);
});

test('speed is car-adequate: never negative, never a highway', () => {
  for (let i = 0; i < 600; i++) {
    const s = ridePing(i, base).speedKmh;
    assert.ok(s >= 0 && s <= 60, `speed ${s} at row ${i} out of range`);
  }
});

test('a ride actually moves — its points are not all identical', () => {
  const pts = new Set<string>();
  for (let k = 0; k < 200; k++) { const p = ridePing(k, base); pts.add(`${p.lat},${p.lon}`); }
  assert.ok(pts.size > 20, `only ${pts.size} distinct points`);
});

test('every point sits in the New York bounding box', () => {
  for (let i = 0; i < 1000; i++) {
    const p = ridePing(i, base);
    assert.ok(p.lat > 40.5 && p.lat < 40.95, `lat ${p.lat} not in NYC (row ${i})`);
    assert.ok(p.lon > -74.1 && p.lon < -73.7, `lon ${p.lon} not in NYC (row ${i})`);
  }
});

test('points lie ON the bundled road geometry (cars follow streets)', () => {
  // Every generated point must be within a few metres of some real route
  // segment — the whole reason for using OSRM geometry. Checks a sample.
  const R = 6371000, D2R = Math.PI / 180;
  const toXY = (lat: number, lon: number, lat0: number) =>
    [lon * D2R * Math.cos(lat0 * D2R) * R, lat * D2R * R];
  const segDistM = (p: number[], a: number[], b: number[]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  const nearestRouteM = (lat: number, lon: number) => {
    const lat0 = lat, P = toXY(lat, lon, lat0);
    let best = Infinity;
    for (const route of NYC_ROUTES) {
      for (let i = 1; i < route.length; i++) {
        const a = toXY(route[i - 1][0], route[i - 1][1], lat0);
        const b = toXY(route[i][0], route[i][1], lat0);
        best = Math.min(best, segDistM(P, a, b));
      }
    }
    return best;
  };
  for (let i = 0; i < 800; i += 7) {
    const p = ridePing(i, base);
    // The point is an interpolation along a route, so it is essentially ON a
    // segment; allow 1 m for the 6-decimal rounding.
    assert.ok(nearestRouteM(p.lat, p.lon) < 1.5, `row ${i} is ${nearestRouteM(p.lat, p.lon).toFixed(1)} m off any road`);
  }
});

test('heading is a compass bearing', () => {
  for (let i = 0; i < 200; i++) {
    const h = ridePing(i, base).headingDeg;
    assert.ok(h >= 0 && h <= 360, `heading ${h} out of range`);
  }
});

test('fully deterministic — preview equals the real insert', () => {
  for (const i of [0, 5, 199, 200, 517, 999]) {
    assert.deepEqual(ridePing(i, base), ridePing(i, base));
  }
});

test('several real routes are bundled', () => {
  assert.ok(NYC_ROUTES.length >= 6);
  assert.ok(NYC_ROUTES.every(r => r.length >= 2));
});

test('a car eventually parks — the last pings of some ride reach speed 0', () => {
  let sawStop = false;
  for (let ride = 0; ride < 8 && !sawStop; ride++) {
    for (let k = 150; k < 200; k++) {
      if (ridePing(ride * 200 + k, base).speedKmh === 0) { sawStop = true; break; }
    }
  }
  assert.ok(sawStop, 'no car reached its destination and parked');
});
