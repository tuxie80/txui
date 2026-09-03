/**
 * PostGIS spatial DBA views (src/utils/dbaViews.ts, §7.1). txui can draw
 * geometry but is otherwise blind to the spatial schema. These views expose
 * the PostGIS version, geometry/geography columns with their SRIDs, mixed-SRID
 * tables, invalid geometries, and — the crucial one — geometry columns that
 * have NO GiST index (the reason every ST_Intersects becomes a seq scan).
 *
 * They must live only in the Postgres view set (PG-gated), sit under a single
 * "Spatial" category, and reference the PostGIS catalog so they degrade to an
 * empty grid — not an error — when PostGIS is not installed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';

const pg = DBA_VIEWS.postgres;
const SPATIAL_IDS = [
  'pg-postgis-version',
  'pg-geometry-columns',
  'pg-geography-columns',
  'pg-spatial-index',
  'pg-mixed-srid',
  'pg-invalid-geom',
];

describe('PostGIS spatial DBA views — registration & gating', () => {
  test('all spatial views exist in the Postgres set under the Spatial category', () => {
    for (const id of SPATIAL_IDS) {
      const view = pg.find(v => v.id === id);
      assert.ok(view, `${id} is registered in DBA_VIEWS.postgres`);
      assert.equal(view.category, 'Spatial', `${id} is under Spatial`);
      assert.equal(typeof view.label, 'string');
      assert.ok(view.label.length > 0, `${id} has a label`);
      assert.equal(typeof view.sql, 'string');
      assert.ok(view.sql.length > 0, `${id} has sql`);
      assert.equal(typeof view.description, 'string');
      assert.ok(view.description.length > 0, `${id} has a description`);
    }
  });

  test('spatial views are PG-gated — absent from every other engine set', () => {
    for (const [engine, views] of Object.entries(DBA_VIEWS)) {
      if (engine === 'postgres') continue;
      for (const id of SPATIAL_IDS) {
        assert.ok(
          !views.some(v => v.id === id),
          `${id} must not appear in DBA_VIEWS.${engine}`,
        );
      }
    }
  });

  test('view ids are unique within the Postgres set', () => {
    const ids = pg.map(v => v.id);
    assert.equal(ids.length, new Set(ids).size, 'no duplicate ids');
  });
});

describe('PostGIS spatial DBA views — SQL content', () => {
  const byId = (id: string) => {
    const v = pg.find(x => x.id === id);
    assert.ok(v, `${id} exists`);
    return v.sql;
  };

  test('the version view reads pg_extension for postgis (safe on any Postgres)', () => {
    const sql = byId('pg-postgis-version');
    assert.match(sql, /pg_extension/);
    assert.match(sql, /'postgis'/);
  });

  test('geometry/geography column views read the PostGIS catalog and expose SRID', () => {
    const geom = byId('pg-geometry-columns');
    assert.match(geom, /geometry_columns/);
    assert.match(geom, /srid/i);
    assert.match(geom, /f_geometry_column/);

    const geog = byId('pg-geography-columns');
    assert.match(geog, /geography_columns/);
    assert.match(geog, /srid/i);
    assert.match(geog, /f_geography_column/);
  });

  test('the spatial-index view joins geometry columns to pg_index/pg_am (gist) and flags missing indexes', () => {
    const sql = byId('pg-spatial-index');
    assert.match(sql, /geometry_columns/);
    assert.match(sql, /pg_index/);
    assert.match(sql, /pg_am/);
    assert.match(sql, /'gist'/);
    assert.match(sql, /has_gist_index/);
    assert.match(sql, /srid/i);
    // Missing-index rows must surface first.
    assert.match(sql, /ORDER BY\s+has_gist_index/i);
  });

  test('the mixed-SRID view groups geometry columns and keeps only tables with >1 distinct SRID', () => {
    const sql = byId('pg-mixed-srid');
    assert.match(sql, /geometry_columns/);
    assert.match(sql, /count\(DISTINCT srid\)/i);
    assert.match(sql, /HAVING\s+count\(DISTINCT srid\)\s*>\s*1/i);
  });

  test('the invalid-geometry view emits an ST_IsValid count per column from the catalog', () => {
    const sql = byId('pg-invalid-geom');
    assert.match(sql, /geometry_columns/);
    assert.match(sql, /ST_IsValid/i);
    assert.match(sql, /count\(\*\)/i);
  });
});
