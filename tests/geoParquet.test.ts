/**
 * geoParquet — the frontend view of a Parquet file's `geo` footer metadata:
 * tolerant parsing, the three-way CRS verdict (absent = CRS84, null =
 * unknown), and the footer bbox as a map viewport hint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crsLabel, geoBbox, geoFromKeyValueRows, parseGeoMetadata, wireBboxToBounds,
} from '../src/utils/geoParquet.ts';

const FULL = JSON.stringify({
  version: '1.1.0',
  primary_column: 'geom',
  made_up_future_field: { anything: true },
  columns: {
    geom: {
      encoding: 'WKB',
      geometry_types: ['Point', 'Polygon'],
      crs: {
        $schema: 'https://proj.org/schemas/v0.7/projjson.json',
        type: 'GeographicCRS',
        name: 'WGS 84',
        id: { authority: 'EPSG', code: 4979 },
      },
      orientation: 'counterclockwise',
      edges: 'spherical',
      bbox: [-10.5, 41.0, 30.25, 71.9],
      epoch: 2015,
      covering: { bbox: { xmin: ['bbox', 'xmin'], ymin: ['bbox', 'ymin'],
                          xmax: ['bbox', 'xmax'], ymax: ['bbox', 'ymax'] } },
      future_extra: 42,
    },
  },
});

test('full 1.1 metadata parses, unknown fields ignored', () => {
  const meta = parseGeoMetadata(FULL);
  assert.ok(meta);
  assert.equal(meta.version, '1.1.0');
  assert.equal(meta.primaryColumn, 'geom');
  const geom = meta.columns.geom;
  assert.equal(geom.encoding, 'WKB');
  assert.deepEqual(geom.geometryTypes, ['Point', 'Polygon']);
  assert.deepEqual(geom.crs, { kind: 'projjson', label: 'EPSG:4979' });
  assert.equal(crsLabel(geom.crs), 'EPSG:4979');
  assert.deepEqual(geom.bbox, [-10.5, 41.0, 30.25, 71.9]);
  assert.equal(geom.hasCovering, true);
  // The bbox drives a map viewport without scanning a row.
  assert.deepEqual(geoBbox(meta), { minX: -10.5, minY: 41.0, maxX: 30.25, maxY: 71.9 });
});

test('crs absent means WGS 84 lon/lat, explicit null means unknown', () => {
  const absent = parseGeoMetadata(
    '{"version":"1.1.0","primary_column":"g","columns":{"g":{"encoding":"WKB"}}}');
  assert.equal(absent?.columns.g.crs.kind, 'default-crs84');
  assert.equal(crsLabel(absent!.columns.g.crs), 'WGS 84 lon/lat');

  const nul = parseGeoMetadata(
    '{"version":"1.1.0","primary_column":"g","columns":{"g":{"encoding":"WKB","crs":null}}}');
  assert.equal(nul?.columns.g.crs.kind, 'unknown');
  assert.equal(crsLabel(nul!.columns.g.crs), 'unknown CRS');

  // A PROJJSON object without an id falls back to its name, then to honest.
  const named = parseGeoMetadata(
    '{"columns":{"g":{"encoding":"WKB","crs":{"type":"GeographicCRS","name":"ETRS89"}}}}');
  assert.equal(crsLabel(named!.columns.g.crs), 'ETRS89 (PROJJSON)');
  const bare = parseGeoMetadata('{"columns":{"g":{"encoding":"WKB","crs":{"type":"ProjectedCRS"}}}}');
  assert.equal(crsLabel(bare!.columns.g.crs), 'custom CRS (PROJJSON)');
});

test('garbage and non-geo values parse to null, never throw', () => {
  assert.equal(parseGeoMetadata('not json {'), null);
  assert.equal(parseGeoMetadata('"just a string"'), null);
  assert.equal(parseGeoMetadata('[1,2,3]'), null);
  assert.equal(parseGeoMetadata(null), null);
  assert.equal(parseGeoMetadata(undefined), null);
  assert.equal(parseGeoMetadata(42), null);
});

test('an already-parsed object parses the same as the JSON text', () => {
  assert.deepEqual(parseGeoMetadata(JSON.parse(FULL)), parseGeoMetadata(FULL));
});

test('geoBbox takes the first four of a 3D bbox and rejects the malformed', () => {
  const six = parseGeoMetadata(
    '{"primary_column":"g","columns":{"g":{"encoding":"WKB","bbox":[0,0,1,1,2,3]}}}');
  assert.deepEqual(geoBbox(six!), { minX: 0, minY: 0, maxX: 1, maxY: 1 });

  const noBbox = parseGeoMetadata('{"primary_column":"g","columns":{"g":{"encoding":"WKB"}}}');
  assert.equal(geoBbox(noBbox!), null);
  const short = parseGeoMetadata('{"primary_column":"g","columns":{"g":{"encoding":"WKB","bbox":[0,1]}}}');
  assert.equal(geoBbox(short!), null);
  const nan = parseGeoMetadata('{"primary_column":"g","columns":{"g":{"encoding":"WKB","bbox":[0,0,null,1]}}}');
  assert.equal(geoBbox(nan!), null);
  // A primary column the columns map does not name has no viewport hint.
  const missing = parseGeoMetadata('{"primary_column":"nope","columns":{"g":{"bbox":[0,0,1,1]}}}');
  assert.equal(geoBbox(missing!), null);
});

test('geoFromKeyValueRows finds the geo row of a KEYVALUE result', () => {
  const rows = [
    ['ARROW:schema', '////…'],
    ['geo', FULL],
  ];
  assert.equal(geoFromKeyValueRows(rows), FULL);
  assert.equal(geoFromKeyValueRows([['pandas', '{}']]), null);
  assert.equal(geoFromKeyValueRows([]), null);
  // A null value (key present, value absent) is not a geo document.
  assert.equal(geoFromKeyValueRows([['geo', null]]), null);
});

test('wireBboxToBounds validates the QueryResult.geo_bbox wire form', () => {
  assert.deepEqual(wireBboxToBounds([-10.5, 41.0, 30.25, 71.9]),
    { minLon: -10.5, minLat: 41.0, maxLon: 30.25, maxLat: 71.9 });
  // Absent / malformed / non-finite → no hint, the rows' own bbox is the fallback.
  assert.equal(wireBboxToBounds(undefined), null);
  assert.equal(wireBboxToBounds(null), null);
  assert.equal(wireBboxToBounds([0, 1]), null);
  assert.equal(wireBboxToBounds([0, 0, Number.NaN, 1]), null);
  assert.equal(wireBboxToBounds([0, 0, Number.POSITIVE_INFINITY, 1]), null);
  // Inverted axes are not a viewport.
  assert.equal(wireBboxToBounds([0, 50, 10, 40]), null);
  // west > east is RFC 7946's antimeridian crossing — the Mercator fit cannot
  // express it, so the hint is dropped rather than fitting the whole world.
  assert.equal(wireBboxToBounds([170, 10, -170, 20]), null);
});
