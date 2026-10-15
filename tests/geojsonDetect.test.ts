/**
 * geojsonDetect — GeoJSON-shaped cells (MongoDB sub-documents, JSON columns,
 * ST_AsGeoJSON output) decoded into the same Geometry structs wkb.ts produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeoJson } from '../src/utils/geojsonDetect.ts';

test('a MongoDB point sub-document decodes (object, not string)', () => {
  const g = parseGeoJson({ type: 'Point', coordinates: [14.4378, 50.0755] });
  assert.deepEqual(g, { type: 'Point', srid: null, coordinates: { x: 14.4378, y: 50.0755 } });
});

test('a JSON string cell decodes the same as the object', () => {
  const s = '{"type":"LineString","coordinates":[[0,0],[1,1],[2,0]]}';
  assert.deepEqual(parseGeoJson(s), {
    type: 'LineString', srid: null,
    coordinates: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }],
  });
});

test('z and m ordinates are kept, never dropped silently', () => {
  const g = parseGeoJson({ type: 'Point', coordinates: [1, 2, 3, 4] });
  assert.deepEqual(g, { type: 'Point', srid: null, coordinates: { x: 1, y: 2, z: 3, m: 4 } });
});

test('polygon and the multi types decode at their proper nesting depth', () => {
  const poly = parseGeoJson({
    type: 'Polygon',
    coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]]],
  });
  assert.equal(poly?.type, 'Polygon');
  assert.equal(poly?.coordinates.length, 1);

  const withHole = parseGeoJson({
    type: 'Polygon',
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 0]],
      [[2, 2], [4, 2], [4, 4], [2, 2]],
    ],
  });
  assert.equal(withHole?.coordinates.length, 2);

  const mp = parseGeoJson({
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      [[[5, 5], [6, 5], [6, 6], [5, 5]]],
    ],
  });
  assert.equal(mp?.type, 'MultiPolygon');
  assert.equal(mp?.coordinates.length, 2);

  const mls = parseGeoJson({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] });
  assert.equal(mls?.type, 'MultiLineString');

  const mpt = parseGeoJson({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] });
  assert.equal(mpt?.type, 'MultiPoint');
});

test('a geometry collection decodes recursively', () => {
  const g = parseGeoJson({
    type: 'GeometryCollection',
    geometries: [
      { type: 'Point', coordinates: [1, 2] },
      { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    ],
  });
  assert.equal(g?.type, 'GeometryCollection');
  assert.equal(g?.geometries.length, 2);
  assert.equal(g?.geometries[1].type, 'LineString');
});

test('extra members (bbox, crs, foreign keys) are ignored, per RFC 7946', () => {
  const g = parseGeoJson({
    type: 'Point', coordinates: [1, 2],
    bbox: [1, 2, 1, 2], crs: { type: 'name' }, name: 'a Mongo doc field',
  });
  assert.equal(g?.type, 'Point');
});

// ── negative cases: arbitrary JSON must NOT become geometry ──

test('arbitrary objects and documents never match', () => {
  assert.equal(parseGeoJson({ type: 'user', coordinates: [1, 2] }), null);
  assert.equal(parseGeoJson({ user: 'j', tags: ['a', 'b'] }), null);
  assert.equal(parseGeoJson({ type: 'Point' }), null);                       // no coordinates
  assert.equal(parseGeoJson({ type: 'Point', coordinates: 'nope' }), null);
  assert.equal(parseGeoJson({ type: 'Point', coordinates: [1] }), null);     // too few ordinates
  assert.equal(parseGeoJson({ type: 'Point', coordinates: [1, 'x'] }), null);
  assert.equal(parseGeoJson({ type: 'Point', coordinates: [1, NaN] }), null);
  assert.equal(parseGeoJson({ type: 'point', coordinates: [1, 2] }), null);  // case-sensitive
});

// ── Feature / FeatureCollection wrappers are unwrapped ──

test('a Feature unwraps to its geometry, properties ignored', () => {
  const f = parseGeoJson({
    type: 'Feature',
    properties: { name: 'Prague', population: 1_300_000 },
    geometry: { type: 'Point', coordinates: [14.4378, 50.0755] },
  });
  assert.deepEqual(f, { type: 'Point', srid: null, coordinates: { x: 14.4378, y: 50.0755 } });

  // The same payload arrives as a string from a JSON column.
  const s = JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } });
  assert.equal(parseGeoJson(s)?.type, 'Point');
});

test('a Feature with a null or invalid geometry has no drawable shape', () => {
  assert.equal(parseGeoJson({ type: 'Feature', properties: { a: 1 }, geometry: null }), null);
  assert.equal(parseGeoJson({ type: 'Feature', properties: {} }), null);            // missing
  assert.equal(parseGeoJson({ type: 'Feature', geometry: 'nope' }), null);
  assert.equal(parseGeoJson({ type: 'Feature', geometry: { type: 'Point' } }), null);
  // A Feature wrapping a Feature is invalid GeoJSON — refused, not unwrapped twice.
  assert.equal(parseGeoJson({
    type: 'Feature',
    geometry: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } },
  }), null);
});

test('a FeatureCollection draws as a GeometryCollection of its members', () => {
  const homogeneous = parseGeoJson({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [3, 4] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [5, 6] } },
    ],
  });
  assert.equal(homogeneous?.type, 'GeometryCollection');
  assert.equal(homogeneous?.geometries.length, 3);
  assert.ok(homogeneous?.geometries.every(g => g.type === 'Point'));

  const mixed = parseGeoJson({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
    ],
  });
  assert.equal(mixed?.type, 'GeometryCollection');
  assert.equal(mixed?.geometries.length, 2);
  assert.equal(mixed?.geometries[1].type, 'LineString');
});

test('null-geometry members are skipped; an empty remainder matches nothing', () => {
  const sparse = parseGeoJson({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: null },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
    ],
  });
  assert.equal(sparse?.type, 'GeometryCollection');
  assert.equal(sparse?.geometries.length, 1);

  assert.equal(parseGeoJson({ type: 'FeatureCollection', features: [] }), null);
  assert.equal(parseGeoJson({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: null },
      { type: 'Feature', properties: {}, geometry: null },
    ],
  }), null);
  // And the strict rules still hold inside the wrapper.
  assert.equal(parseGeoJson({ type: 'FeatureCollection' }), null);                    // no features
  assert.equal(parseGeoJson({ type: 'FeatureCollection', features: [42] }), null);
  assert.equal(parseGeoJson({
    type: 'FeatureCollection',
    features: [{ type: 'Point', coordinates: [1, 2] }],                               // members must be Features
  }), null);
  assert.equal(parseGeoJson({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: 'nope' } }],
  }), null);
});

test('a deeply nested Feature bomb hits the depth guard, not the stack', () => {
  let v: unknown = { type: 'Point', coordinates: [1, 2] };
  for (let i = 0; i < 40; i++) v = { type: 'Feature', properties: {}, geometry: v };
  assert.equal(parseGeoJson(v), null);
  v = { type: 'Point', coordinates: [1, 2] };
  for (let i = 0; i < 40; i++) {
    v = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: v }] };
  }
  assert.equal(parseGeoJson(v), null);
});

test('malformed nesting is rejected at every depth', () => {
  assert.equal(parseGeoJson({ type: 'LineString', coordinates: [[0, 0]] }), null);      // < 2 positions
  assert.equal(parseGeoJson({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }), null); // ring too short
  assert.equal(parseGeoJson({ type: 'Polygon', coordinates: [[0, 0, 1, 1]] }), null);     // flat, not rings
  assert.equal(parseGeoJson({ type: 'MultiPolygon', coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] }), null); // one level short
  assert.equal(parseGeoJson({ type: 'GeometryCollection', geometries: [{ type: 'Nope', coordinates: [] }] }), null);
});

test('non-object values and non-JSON strings never match, never throw', () => {
  assert.equal(parseGeoJson(null), null);
  assert.equal(parseGeoJson(undefined), null);
  assert.equal(parseGeoJson(42), null);
  assert.equal(parseGeoJson([1, 2]), null);               // a bare array is not GeoJSON
  assert.equal(parseGeoJson('not json {'), null);
  assert.equal(parseGeoJson('[1,2,3]'), null);
  assert.equal(parseGeoJson('"just a string"'), null);
  // Hex EWKB is the OTHER decoder's job — the GeoJSON probe must say no.
  assert.equal(parseGeoJson('0101000020E6100000447B'), null);
  assert.equal(parseGeoJson(''), null);
});

test('a deeply nested hostile object is rejected, not recursed into forever', () => {
  let v: unknown = { type: 'Point', coordinates: [1, 2] };
  for (let i = 0; i < 40; i++) v = { type: 'GeometryCollection', geometries: [v] };
  assert.equal(parseGeoJson(v), null);
});
