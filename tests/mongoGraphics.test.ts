/**
 * MongoDB GeoJSON reaches the map — source pins on MongoBrowser.
 *
 * Detection and cell mini-maps always existed (utils/geoDetect.ts,
 * CellViewer), but the map itself was reachable only from QueryTabs and
 * DataBrowser, and a MongoDB session mounts MongoBrowser instead. The wiring
 * is pinned by reading the source (the same convention as menuBar.test.ts):
 * the shared GraphicsView, lazy per the panel contract, over BOTH result
 * grids (Find and Aggregate), with the initial mode following geometry
 * detection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/components/MongoBrowser.tsx', 'utf8');

test('GraphicsView is lazy-loaded, per the panel contract', () => {
  assert.match(src, /const GraphicsView = lazy\(\(\) => import\('\.\/GraphicsView'\)/);
  assert.ok(!/^import \{ GraphicsView \}/m.test(src),
    'a static import would put the map/chart chunk in the main bundle');
});

test('both result grids offer the 📈 Graphics toggle', () => {
  assert.equal((src.match(/📈 Graphics<\/button>/g) ?? []).length, 2,
    'Find and Aggregate each get the toggle');
  assert.ok(src.includes('graphicsFor(result)'));
  assert.ok(src.includes('graphicsFor(aggResult)'));
});

test('the initial mode follows geometry detection', () => {
  // mappableResult is what opens a GeoJSON result on the map rather than on
  // a chart of nothing — the same gate QueryTabs uses.
  assert.ok(src.includes("import { mappableResult } from '../utils/geoDetect'"));
  assert.match(src, /initialMode=\{mappableResult\(/);
});
