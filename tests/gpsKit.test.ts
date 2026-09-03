/**
 * The NYC taxi GPS kit, end to end through the real generator pipeline.
 *
 * Two risky claims get checked: the server-computed `geom` column is emitted in
 * DDL but never inserted, and the `ride*` columns stay correlated when run
 * through `generateRows` (the shared-RNG path the real insert uses), so one
 * row's lat/lon/speed/time describe one instant of one car.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_KITS, buildKitTableDdl, kitTableSpecs } from '../src/utils/schemaKits.ts';
import { generateRows } from '../src/utils/datagen.ts';
import { ridePing } from '../src/utils/rideTracks.ts';

const kit = SCHEMA_KITS.find(k => k.id === 'nyc_taxi')!;
const table = kit.tables[0];

test('the NYC taxi kit is a single gps_pings table', () => {
  assert.ok(kit);
  assert.equal(table.name, 'gps_pings');
});

test('MySQL DDL emits a generated spatial POINT from lat/lon, portable to MySQL 5.7', () => {
  const ddl = buildKitTableDdl('nyc_taxi', table, 'mysql').join('\n');
  // No two-arg ST_SRID — the setter form only exists on MySQL 8.0+ / MariaDB
  // 10.2+, and older servers fail the CREATE TABLE with error 1582.
  assert.match(ddl, /`geom` POINT GENERATED ALWAYS AS \(POINT\(lon, lat\)\) STORED/);
  assert.doesNotMatch(ddl, /ST_SRID/);
  assert.match(ddl, /`lat` DOUBLE/);
  assert.match(ddl, /`speed_kmh` DECIMAL\(5,1\)/);
});

test('PostgreSQL DDL uses the built-in point type and DOUBLE PRECISION', () => {
  const ddl = buildKitTableDdl('nyc_taxi', table, 'postgres').join('\n');
  assert.match(ddl, /"geom" point GENERATED ALWAYS AS \(point\(lon, lat\)\) STORED/);
  assert.match(ddl, /"lat" DOUBLE PRECISION/);
});

test('the generated geom column is never inserted', () => {
  const specs = kitTableSpecs('nyc_taxi', table, 'mysql');
  assert.ok(!specs.some(s => s.name === 'geom'), 'geom must not be inserted');
  assert.deepEqual(specs.map(s => s.name),
    ['id', 'car_id', 'captured_at', 'lat', 'lon', 'speed_kmh', 'heading_deg']);
});

test('through generateRows, a car_id is one continuous ride with a forward clock', () => {
  const specs = kitTableSpecs('nyc_taxi', table, 'mysql');
  const rows = generateRows(specs, 420, 12345);
  const carIdx = specs.findIndex(s => s.name === 'car_id');
  const tsIdx = specs.findIndex(s => s.name === 'captured_at');
  const latIdx = specs.findIndex(s => s.name === 'lat');

  assert.equal(rows[0][carIdx], 1);
  assert.equal(rows[199][carIdx], 1);
  assert.equal(rows[200][carIdx], 2);

  for (let i = 1; i < 200; i++) {
    assert.ok(String(rows[i][tsIdx]) > String(rows[i - 1][tsIdx]),
      `captured_at went backwards at row ${i}`);
  }
  for (let i = 0; i < 400; i++) {
    const lat = rows[i][latIdx] as number;
    assert.ok(lat > 40.5 && lat < 40.95, `lat ${lat} not in NYC at row ${i}`);
  }
});

test('the pipeline agrees with the pure model — columns stay correlated', () => {
  const specs = kitTableSpecs('nyc_taxi', table, 'mysql');
  const rows = generateRows(specs, 300, 999);
  const idx = (n: string) => specs.findIndex(s => s.name === n);
  const rp = { ridePings: 200, pingSec: 2,
    baseEpochSec: Math.floor(new Date('2026-06-01T08:00:00Z').getTime() / 1000) };
  for (const i of [0, 37, 199, 200, 275]) {
    const p = ridePing(i, rp);
    assert.equal(rows[i][idx('car_id')], p.carId, `car_id row ${i}`);
    assert.equal(rows[i][idx('lat')], p.lat, `lat row ${i}`);
    assert.equal(rows[i][idx('lon')], p.lon, `lon row ${i}`);
    assert.equal(rows[i][idx('speed_kmh')], p.speedKmh, `speed row ${i}`);
    assert.equal(rows[i][idx('heading_deg')], p.headingDeg, `heading row ${i}`);
  }
});
