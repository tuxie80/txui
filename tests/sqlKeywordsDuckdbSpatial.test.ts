/**
 * DuckDB spatial ST_* completion gating (src/utils/sqlKeywords.ts, plan
 * wave 3). The `spatial` extension is loaded on demand per session
 * (INSTALL/LOAD via the duckdb_enable_spatial affordance), so its ST_* set
 * completes only when the session reports the extension loaded — offering
 * ST_AsText before LOAD spatial is offering a catalog error. GEOMETRY itself
 * is a core type since DuckDB 1.5 and needs nothing here.
 *
 * Function names checked against the extension's function index
 * (duckdb.org/docs/stable/core_extensions/spatial/functions).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { keywordCatalog, applyKeywordCase } from '../src/utils/sqlKeywords.ts';

const EXPECTED_ST = [
  // file readers — the payoff: shapefiles/GeoJSON in
  'ST_Read', 'ST_Read_Meta', 'ST_ReadSHP', 'ST_ReadOSM', 'ST_Drivers',
  // construct / serialize
  'ST_GeomFromText', 'ST_GeomFromWKB', 'ST_GeomFromHEXWKB', 'ST_GeomFromGeoJSON',
  'ST_Point', 'ST_MakeEnvelope',
  'ST_AsText', 'ST_AsWKB', 'ST_AsHEXWKB', 'ST_AsGeoJSON',
  // measure / relate
  'ST_Area', 'ST_Length', 'ST_Distance', 'ST_Distance_Sphere', 'ST_DWithin',
  'ST_Intersects', 'ST_Contains', 'ST_Within', 'ST_Covers', 'ST_CoveredBy',
  'ST_Crosses', 'ST_Touches', 'ST_Overlaps', 'ST_Equals', 'ST_Disjoint',
  // process / reproject
  'ST_Buffer', 'ST_Centroid', 'ST_PointOnSurface', 'ST_Envelope', 'ST_ConvexHull',
  'ST_Intersection', 'ST_Union', 'ST_Union_Agg', 'ST_Difference',
  'ST_Simplify', 'ST_SimplifyPreserveTopology', 'ST_IsValid', 'ST_MakeValid',
  'ST_Collect', 'ST_Dump', 'ST_Transform', 'ST_FlipCoordinates',
];

describe('DuckDB ST_* completions are gated on the loaded spatial extension', () => {
  test('without the gate, no ST_* function is offered on duckdb', () => {
    const items = keywordCatalog('duckdb');
    const st = items.filter(i => i.label.startsWith('ST_'));
    assert.equal(st.length, 0, `duckdb offered ST_* before LOAD spatial: ${st.map(i => i.label)}`);
    // …and the explicit false is the same answer.
    assert.equal(keywordCatalog('duckdb', undefined, { duckdbSpatial: false })
      .filter(i => i.label.startsWith('ST_')).length, 0);
  });

  test('with the gate on, the curated set is offered with signatures', () => {
    const items = keywordCatalog('duckdb', undefined, { duckdbSpatial: true });
    const byLabel = (label: string) => items.find(i => i.label === label);
    for (const name of EXPECTED_ST) {
      const item = byLabel(name);
      assert.ok(item, `${name} is offered once spatial is loaded`);
      assert.equal(item.type, 'function');
      assert.ok(item.detail?.includes(name), `${name} carries its signature`);
      assert.equal(typeof item.snippet, 'string', `${name} carries an insert snippet`);
    }
  });

  test('ST_Transform advertises CRS names, not PostGIS\'s bare srid', () => {
    const items = keywordCatalog('duckdb', undefined, { duckdbSpatial: true });
    const t = items.find(i => i.label === 'ST_Transform');
    assert.ok(t?.detail.includes('EPSG:'), `DuckDB ST_Transform takes (geom, source_crs, target_crs): ${t?.detail}`);
  });

  test('the gate does not leak into other engines or the core duckdb set', () => {
    for (const engine of ['mysql', 'sqlite', 'clickhouse', 'sqlserver'] as const) {
      const st = keywordCatalog(engine, undefined, { duckdbSpatial: true })
        .filter(i => i.label.startsWith('ST_'));
      assert.equal(st.length, 0, `${engine} must never offer the DuckDB ST_* set`);
    }
    // Core DuckDB functions survive both ways.
    for (const flag of [false, true]) {
      const labels = new Set(keywordCatalog('duckdb', undefined, { duckdbSpatial: flag }).map(k => k.label));
      assert.ok(labels.has('READ_PARQUET'));
      assert.ok(labels.has('UNNEST'));
    }
  });

  test('the PostGIS catalog is untouched — PG still carries its own ST_* unconditionally', () => {
    const pg = keywordCatalog('postgres');
    assert.ok(pg.some(i => i.label === 'ST_AsText'));
    assert.ok(pg.some(i => i.label === 'ST_SetSRID'), 'PostGIS-only helpers stay PG-only');
  });

  test('the lower-case preference maps the ST_* set too', () => {
    const items = keywordCatalog('duckdb', undefined, { duckdbSpatial: true });
    const lowered = applyKeywordCase(items, false);
    const item = lowered.find(i => i.detail?.startsWith('ST_AsText'));
    assert.ok(item);
    assert.equal(item.label, 'st_astext');
    assert.match(item.snippet ?? '', /^st_astext\(/);
  });
});
