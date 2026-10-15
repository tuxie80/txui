/**
 * chGeoDetect — ClickHouse Point/Ring/Polygon/MultiPolygon array geometries,
 * detected ONLY on the column's declared type_name, never guessed from a
 * bare array.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chGeoKind, parseChGeometry } from '../src/utils/chGeoDetect.ts';

test('the four geo type names are recognized, Nullable unwraps', () => {
  assert.equal(chGeoKind('Point'), 'Point');
  assert.equal(chGeoKind('Ring'), 'Ring');
  assert.equal(chGeoKind('Polygon'), 'Polygon');
  assert.equal(chGeoKind('MultiPolygon'), 'MultiPolygon');
  assert.equal(chGeoKind('Nullable(Point)'), 'Point');
  assert.equal(chGeoKind('Nullable(MultiPolygon)'), 'MultiPolygon');
});

test('everything else is not a geo type — including lookalikes', () => {
  assert.equal(chGeoKind('Array(Float64)'), null);
  assert.equal(chGeoKind('Tuple(Float64, Float64)'), null);
  assert.equal(chGeoKind('String'), null);
  assert.equal(chGeoKind('point'), null);          // case matters, as on the server
  assert.equal(chGeoKind('Array(Point)'), null);   // an array OF points is not a geo column
  assert.equal(chGeoKind(undefined), null);
  assert.equal(chGeoKind(null), null);
  assert.equal(chGeoKind(''), null);
});

test('Point [x, y] decodes in (lon, lat) order — ClickHouse convention', () => {
  assert.deepEqual(parseChGeometry('Point', [14.4378, 50.0755]), {
    type: 'Point', srid: null, coordinates: { x: 14.4378, y: 50.0755 },
  });
});

test('Ring becomes a single-ring Polygon — it is a closed loop by definition', () => {
  const g = parseChGeometry('Ring', [[0, 0], [4, 0], [4, 4], [0, 4]]);
  assert.deepEqual(g, {
    type: 'Polygon', srid: null,
    coordinates: [[{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]],
  });
});

test('Polygon and MultiPolygon decode at their nesting depths', () => {
  const poly = parseChGeometry('Polygon', [[[0, 0], [1, 0], [1, 1]], [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4]]]);
  assert.equal(poly?.type, 'Polygon');
  assert.equal(poly?.coordinates.length, 2);   // outer ring + hole

  const mp = parseChGeometry('MultiPolygon', [
    [[[0, 0], [1, 0], [1, 1]]],
    [[[5, 5], [6, 5], [6, 6]]],
  ]);
  assert.equal(mp?.type, 'MultiPolygon');
  assert.equal(mp?.coordinates.length, 2);
});

test('no type_name, no detection — a bare array is never geometry', () => {
  assert.equal(parseChGeometry(undefined, [14.4, 50.1]), null);
  assert.equal(parseChGeometry(null, [[0, 0], [1, 1]]), null);
  assert.equal(parseChGeometry('Array(Float64)', [14.4, 50.1]), null);
  assert.equal(parseChGeometry('Tuple(Float64, Float64)', [14.4, 50.1]), null);
});

test('a malformed cell for the declared type decodes to null, not to garbage', () => {
  assert.equal(parseChGeometry('Point', [1]), null);
  assert.equal(parseChGeometry('Point', ['x', 'y']), null);
  assert.equal(parseChGeometry('Point', [1, NaN]), null);
  assert.equal(parseChGeometry('Point', null), null);
  assert.equal(parseChGeometry('Ring', [[0, 0], 'x']), null);
  assert.equal(parseChGeometry('Polygon', []), null);
  assert.equal(parseChGeometry('Polygon', [[[0, 0], [1, 'x']]]), null);
  assert.equal(parseChGeometry('MultiPolygon', [[[0, 0]]]), null);  // one level short
});
