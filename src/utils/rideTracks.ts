/**
 * Realistic New York taxi tracks for the data generator.
 *
 * A fleet of cars, each driving one real New York route, pinging its GPS every
 * few seconds. The routes are actual OSRM road geometry (see
 * `assets/nycRoutes.ts`), so consecutive rows for one `car_id` trace a path
 * **down real streets** — the car never cuts through a block. Along the way it
 * cruises, stops at the occasional red light, and parks at the destination.
 *
 * (Prague was dropped: the hand-drawn Prague polylines cut across buildings,
 * and precise city-wide road geometry for it was not available to bundle.)
 *
 * The hard constraint: the generator produces one value per (row, column) with
 * **no shared state between columns**, and the row generator runs both here
 * (preview) and in Rust (the real insert). So `ridePing` is a pure function of
 * the row index — every track column recomputes the same ping and they agree
 * by construction, at any scale, in either language. The speed model uses only
 * integer-hash randomness and plain arithmetic (no trigonometry feeds the
 * distance integral), so the Rust port in `commands/datagen.rs` stays
 * bit-identical. Keep the two in sync.
 *
 * Pure and dependency-light — `node --test` covers it.
 */
import { NYC_ROUTES } from '../assets/nycRoutes.ts';

const ROUTES = NYC_ROUTES;

export interface RideParams {
  /** Pings (rows) per car ride. */
  ridePings: number;
  /** Seconds between pings — the sampling interval. */
  pingSec: number;
  /** Fleet start, unix seconds; ride N starts a few minutes after ride N−1. */
  baseEpochSec: number;
}

export interface RidePing {
  carId: number;
  lat: number;
  lon: number;
  speedKmh: number;
  headingDeg: number;
  epochSec: number;
}

const R_EARTH_M = 6_371_000;
const D2R = Math.PI / 180;

function haversineM(a: readonly [number, number], b: readonly [number, number]): number {
  const dLat = (b[0] - a[0]) * D2R;
  const dLon = (b[1] - a[1]) * D2R;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearingDeg(a: readonly [number, number], b: readonly [number, number]): number {
  const y = Math.sin((b[1] - a[1]) * D2R) * Math.cos(b[0] * D2R);
  const x = Math.cos(a[0] * D2R) * Math.sin(b[0] * D2R)
    - Math.sin(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.cos((b[1] - a[1]) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

/**
 * A deterministic hash of two integers into [0, 1).
 *
 * Stands in for `rng()` so a ride's choices (route, cruising speed, which
 * lights are red) depend only on the ride and never on the shared row RNG.
 * Integer ops written to match Rust's `wrapping_*`/`>>` exactly.
 */
function hash01(a: number, b: number): number {
  let x = (Math.imul(a >>> 0, 0x9e3779b1) ^ (b >>> 0)) >>> 0;
  x = ((x ^ 61) ^ (x >>> 16)) >>> 0;
  x = (x + (x << 3)) >>> 0;
  x = (x ^ (x >>> 4)) >>> 0;
  x = Math.imul(x, 0x27d4eb2d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return x / 4294967296;
}
function hashU(a: number, b: number): number {
  return Math.floor(hash01(a, b) * 4294967296) >>> 0;
}

interface ResolvedRoute {
  pts: readonly (readonly [number, number])[];
  cum: number[];
  len: number;
}

function routeFor(rideIdx: number): ResolvedRoute {
  const base = ROUTES[hashU(rideIdx, 1) % ROUTES.length];
  const pts = (hashU(rideIdx, 2) & 1) ? [...base].reverse() : [...base];
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1], pts[i]));
  return { pts, cum, len: cum[cum.length - 1] };
}

/** Point and heading at distance `d` metres along a route. */
function at(route: ResolvedRoute, d: number): { lat: number; lon: number; heading: number } {
  const { pts, cum } = route;
  const dd = Math.max(0, Math.min(route.len, d));
  let seg = 0;
  while (seg < cum.length - 2 && cum[seg + 1] < dd) seg++;
  const a = pts[seg], b = pts[seg + 1] ?? pts[seg];
  const segLen = (cum[seg + 1] ?? cum[seg]) - cum[seg];
  const f = segLen > 0 ? (dd - cum[seg]) / segLen : 0;
  return {
    lat: a[0] + (b[0] - a[0]) * f,
    lon: a[1] + (b[1] - a[1]) * f,
    heading: bearingDeg(a, b),
  };
}

/**
 * Speed (km/h) at ping `j`, at distance `d` along the route.
 *
 * No trigonometry: the position already follows a real road, so speed only has
 * to be plausible — a per-ride cruise, an ease-in from a standstill, some
 * multiplicative noise, and red lights spaced along the route that some rides
 * stop at. That keeps the whole distance integral in exact f64 + integer-hash
 * arithmetic, identical in JS and Rust.
 */
function speedAt(route: ResolvedRoute, rideIdx: number, j: number, d: number, pingSec: number): number {
  if (d >= route.len) return 0;                          // arrived — parked
  // Red lights are timed by ping, not distance: a distance-gated stop would
  // freeze `d` (speed 0 → no advance → still at the light) and the car would
  // never leave. Every `cycle` pings a light may go red for `redLen` pings,
  // which always clears because the ping index keeps advancing.
  const cycle = 40 + Math.floor(30 * hash01(rideIdx, 5));   // a light every 40–70 pings
  const redLen = 3 + Math.floor(4 * hash01(rideIdx, 6));    // red for 3–6 pings
  if (j % cycle < redLen && hash01(rideIdx, 300 + Math.floor(j / cycle)) < 0.5) return 0;
  const cruise = 34 + 20 * hash01(rideIdx, 3);           // 34…54 km/h, per ride
  const rampUp = Math.min(1, (j * pingSec) / 8);
  const noise = 0.85 + 0.3 * hash01(rideIdx, 1000 + j);
  return cruise * rampUp * noise;
}

/**
 * The GPS ping for global row `rowIdx`.
 *
 * `car_id` groups the rows: `[R·ridePings, (R+1)·ridePings)` is car `R+1`
 * driving one ride, oldest first. Distance is integrated ping by ping from the
 * speed profile (O(pings) per row, bounded), so the path and the clock stay
 * consistent with the speed the row reports.
 */
export function ridePing(rowIdx: number, rp: RideParams): RidePing {
  const pings = Math.max(2, Math.floor(rp.ridePings));
  const pingSec = Math.max(1, rp.pingSec);
  const rideIdx = Math.floor(rowIdx / pings);
  const k = rowIdx % pings;
  const route = routeFor(rideIdx);

  const mps = (kmh: number) => (kmh * 1000) / 3600;
  let d = 0;
  for (let j = 0; j < k; j++) {
    d += mps(speedAt(route, rideIdx, j, d, pingSec)) * pingSec;
    if (d >= route.len) { d = route.len; break; }
  }
  const speedKmh = speedAt(route, rideIdx, k, d, pingSec);
  const p = at(route, d);
  // Cars overlap in time: each starts 3 min after the previous.
  const start = rp.baseEpochSec + rideIdx * 180;
  return {
    carId: rideIdx + 1,
    lat: Math.round(p.lat * 1e6) / 1e6,
    lon: Math.round(p.lon * 1e6) / 1e6,
    speedKmh: Math.round(speedKmh * 10) / 10,
    headingDeg: Math.round(p.heading),
    epochSec: start + k * pingSec,
  };
}
