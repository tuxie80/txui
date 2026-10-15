/**
 * The bundled basemap's read side (src/utils/basemap.ts).
 *
 * `normalizeBasemap` is the only thing standing between a committed JSON
 * asset and the canvas, so its contract is: valid Natural Earth shapes pass
 * through verbatim, garbage is dropped piece by piece (a broken polygon does
 * not kill its neighbours), and a wholly unrecognised file is an empty map —
 * the callers fall back to the graticule, which is what the map drew before
 * a basemap existed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBasemap } from '../src/utils/basemap.ts';

const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

test('polygons and multipolygons flatten to one polygon list', () => {
  const data = {
    source: 'test',
    geometries: [
      { type: 'Polygon', coordinates: [SQUARE] },
      { type: 'MultiPolygon', coordinates: [[SQUARE], [SQUARE]] },
      { type: 'Point', coordinates: [1, 2] },      // not land — dropped
    ],
  };
  const polys = normalizeBasemap(data);
  assert.equal(polys.length, 3);
  for (const p of polys) assert.deepEqual(p.rings, [SQUARE]);
});

test('broken pieces are dropped, valid neighbours kept', () => {
  const data = {
    geometries: [
      { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] },          // <4 pts
      { type: 'Polygon', coordinates: [[...SQUARE, ['x', 1]]] },     // non-numeric
      { type: 'Polygon', coordinates: [SQUARE] },
      null,
      42,
    ],
  };
  const polys = normalizeBasemap(data);
  assert.equal(polys.length, 1);
});

test('unrecognised shapes are an empty map, never a throw', () => {
  for (const junk of [null, undefined, 42, 'map', [], {}, { geometries: 'yes' }]) {
    assert.deepEqual(normalizeBasemap(junk), []);
  }
});

// The committed asset itself: the file every map draws from. If a regenerate
// breaks it (the closed-ring RDP collapse produced a valid-JSON world of
// zero-area dots), this test is what says so.
test('the committed basemap.json is real geography', () => {
  const data = JSON.parse(readFileSync(new URL('../src/assets/basemap.json', import.meta.url), 'utf8'));
  assert.match(data.source, /Natural Earth/);
  const polys = normalizeBasemap(data);
  assert.ok(polys.length > 100, `only ${polys.length} polygons — the world has more land than that`);
  let verts = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of polys) {
    for (const r of p.rings) {
      assert.ok(r.length >= 4, 'a ring with fewer than 4 points is not a ring');
      for (const [x, y] of r) {
        verts++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  assert.ok(verts > 1000, `only ${verts} vertices — over-simplified`);
  assert.ok(minX <= -179 && maxX >= 179, 'the world does not span the oceans');
  assert.ok(minY <= -60 && maxY >= 70, 'continents missing');
});
