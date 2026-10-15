/**
 * geoDetect — the shared cell probe: WKB hex, GeoJSON, and ClickHouse arrays
 * behind one function, with the type-name gate on the ClickHouse branch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellGeometry, detectGeoColumns, mappableResult } from '../src/utils/geoDetect.ts';

// A little-endian WKB POINT(14.4378 50.0755) hex string, as PostGIS sends it.
const POINT_HEX = (() => {
  const b = new Uint8Array(21);
  const v = new DataView(b.buffer);
  b[0] = 1; v.setUint32(1, 1, true);
  v.setFloat64(5, 14.4378, true); v.setFloat64(13, 50.0755, true);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
})();

test('WKB hex strings decode through parseWkbHex', () => {
  const g = cellGeometry(POINT_HEX);
  assert.equal(g?.type, 'Point');
  assert.ok(Math.abs((g as { coordinates: { x: number } }).coordinates.x - 14.4378) < 1e-9);
});

test('GeoJSON objects and JSON strings decode', () => {
  assert.equal(cellGeometry({ type: 'Point', coordinates: [1, 2] })?.type, 'Point');
  assert.equal(cellGeometry('{"type":"Point","coordinates":[1,2]}')?.type, 'Point');
});

test('ClickHouse arrays decode only with the type_name gate', () => {
  assert.equal(cellGeometry([14.4, 50.1], 'Point')?.type, 'Point');
  assert.equal(cellGeometry([14.4, 50.1]), null);              // no gate, no guess
  assert.equal(cellGeometry([14.4, 50.1], 'Array(Float64)'), null);
});

test('a typed ClickHouse column wins over other probes', () => {
  // The cell is not valid anything else; the declared type decides.
  assert.equal(cellGeometry([[0, 0], [1, 1]], 'Ring')?.type, 'Polygon');
});

test('ordinary cells stay ordinary', () => {
  assert.equal(cellGeometry('hello'), null);
  assert.equal(cellGeometry(42), null);
  assert.equal(cellGeometry(null), null);
  assert.equal(cellGeometry({ type: 'user', coordinates: [1, 2] }), null);
});

test('detectGeoColumns finds WKB, GeoJSON and typed ClickHouse columns', () => {
  const columns = [
    { name: 'id', typeName: 'Int32' },
    { name: 'geom', typeName: 'BYTE_ARRAY' },
    { name: 'doc', typeName: 'JSON' },
    { name: 'pt', typeName: 'Point' },
    { name: 'scores', typeName: 'Array(Float64)' },
  ];
  const rows = [
    [1, POINT_HEX, '{"type":"Point","coordinates":[1,2]}', [14.4, 50.1], [0.5, 0.5]],
    [2, null, null, [14.5, 50.2], [0.1, 0.2]],
  ];
  assert.deepEqual(detectGeoColumns(columns, rows), [
    { name: 'geom', index: 1 },
    { name: 'doc', index: 2 },
    { name: 'pt', index: 3 },
  ]);
});

test('detectGeoColumns tolerates missing type names and sparse columns', () => {
  const columns = [{ name: 'a' }, { name: 'g' }];
  const rows = [[null, null], [null, null], ['x', POINT_HEX]];
  assert.deepEqual(detectGeoColumns(columns, rows), [{ name: 'g', index: 1 }]);
  assert.deepEqual(detectGeoColumns(columns, []), []);
});

test('mappableResult: two numeric columns suffice (lat/lon track)', () => {
  const columns = [{ name: 'lat' }, { name: 'lon' }, { name: 'name' }];
  const rows = [[50.1, 14.4, 'a'], [50.2, 14.5, 'b']];
  assert.equal(mappableResult(columns, rows), true);
});

test('mappableResult: one geometry column suffices on its own', () => {
  // SELECT id, name, geom — one numeric column, so the old gate said "chart".
  const columns = [{ name: 'id' }, { name: 'name' }, { name: 'geom' }];
  const rows = [[1, 'Midtown', POINT_HEX], [2, 'FiDi', POINT_HEX]];
  assert.equal(mappableResult(columns, rows), true);
});

test('mappableResult: typed ClickHouse geometry counts via the type gate', () => {
  const columns = [{ name: 'pt', typeName: 'Point' }];
  assert.equal(mappableResult(columns, [[[14.4, 50.1]]]), true);
  // …but an ungated bare array proves nothing.
  assert.equal(mappableResult([{ name: 'pair' }], [[[14.4, 50.1]]]), false);
});

test('mappableResult: empty and ordinary results are not mappable', () => {
  assert.equal(mappableResult([{ name: 'a' }], []), false);
  assert.equal(mappableResult([{ name: 'name' }, { name: 'city' }], [['x', 'y']]), false);
});
