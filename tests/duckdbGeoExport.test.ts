/**
 * tests for src/utils/duckdbGeoExport.ts — the one predicate behind the
 * result grid's "GeoParquet (server-side)…" entry: shown for DuckDB query
 * results, greyed with the reason when blocked, runnable only when the
 * verdict is ok.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geoParquetVerdict, hasGeometryColumn, GEOMETRY_TYPE } from '../src/utils/duckdbGeoExport.ts';

const ON = { status: 'on' } as const;
const OFF = { status: 'off' } as const;
const GEO = ['INTEGER', GEOMETRY_TYPE];

test('geometry detection uses the driver label, not the arrow carrier', () => {
  assert.equal(hasGeometryColumn(['GEOMETRY']), true);
  assert.equal(hasGeometryColumn(['INTEGER', 'GEOMETRY', 'VARCHAR']), true);
  // BLOB shares GEOMETRY's arrow Binary carrier — it must not qualify.
  assert.equal(hasGeometryColumn(['BLOB']), false);
  // The Parquet engine's annotated label is a different engine's wording.
  assert.equal(hasGeometryColumn(['GEOMETRY · GeoParquet WKB']), false);
  assert.equal(hasGeometryColumn([]), false);
});

test('the happy path: duckdb + spatial on + geometry + source sql', () => {
  assert.deepEqual(
    geoParquetVerdict({ engine: 'duckdb', sourceSql: 'SELECT g FROM t', columnTypes: GEO, spatial: ON }),
    { ok: true });
});

test('non-duckdb engines are refused with the reason', () => {
  for (const engine of ['mysql', 'postgres', 'sqlite', 'parquet', undefined]) {
    const v = geoParquetVerdict({ engine, sourceSql: 'SELECT 1', columnTypes: GEO, spatial: ON });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.tip, /DuckDB/);
  }
});

test('a result without a source statement cannot be re-run server-side', () => {
  for (const sourceSql of [undefined, '', '   ']) {
    const v = geoParquetVerdict({ engine: 'duckdb', sourceSql, columnTypes: GEO, spatial: ON });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.tip, /source statement/);
  }
});

test('a result without a geometry column points at the plain export', () => {
  const v = geoParquetVerdict({ engine: 'duckdb', sourceSql: 'SELECT 1', columnTypes: ['INTEGER'], spatial: ON });
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.tip, /no GEOMETRY column/);
});

test('spatial states gate the entry and name the fix', () => {
  const base = { engine: 'duckdb', sourceSql: 'SELECT g FROM t', columnTypes: GEO };
  const off = geoParquetVerdict({ ...base, spatial: OFF });
  assert.equal(off.ok, false);
  if (!off.ok) assert.match(off.tip, /🌐/);

  const enabling = geoParquetVerdict({ ...base, spatial: { status: 'enabling' } });
  assert.equal(enabling.ok, false);
  if (!enabling.ok) assert.match(enabling.tip, /still being enabled/);

  const failed = geoParquetVerdict({ ...base, spatial: { status: 'failed', reason: 'HTTP 503', network: true } });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.match(failed.tip, /HTTP 503/, 'the engine\'s reason is quoted');
    assert.match(failed.tip, /network/, 'a network failure says so');
  }

  const failedLocal = geoParquetVerdict({ ...base, spatial: { status: 'failed', reason: 'GEOS mismatch', network: false } });
  assert.equal(failedLocal.ok, false);
  if (!failedLocal.ok) assert.doesNotMatch(failedLocal.tip, /network/);
});
