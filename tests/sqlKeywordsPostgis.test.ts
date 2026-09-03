/**
 * PostGIS ST_* completion & hover (src/utils/sqlKeywords.ts, §7.10). The
 * function catalog shipped zero PostGIS functions, so none of the common ST_*
 * calls completed or showed a signature. A curated set is now added to the
 * Postgres function list — which means they are offered on PostgreSQL and NOT
 * on MySQL/SQLite/etc, and each carries a signature (detail) for hover.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { keywordCatalog, applyKeywordCase } from '../src/utils/sqlKeywords.ts';

const EXPECTED_ST = [
  'ST_AsText', 'ST_GeomFromText', 'ST_SetSRID', 'ST_SRID', 'ST_Transform',
  'ST_X', 'ST_Y', 'ST_Distance', 'ST_DWithin', 'ST_Intersects',
  'ST_Contains', 'ST_Within', 'ST_Buffer', 'ST_Area', 'ST_Length',
  'ST_Centroid', 'ST_MakePoint', 'ST_Point', 'ST_AsGeoJSON', 'ST_GeomFromGeoJSON',
  'ST_Union', 'ST_Simplify', 'ST_Envelope', 'ST_IsValid', 'ST_MakeValid',
];

describe('PostGIS ST_* function completions', () => {
  const pg = keywordCatalog('postgres');
  const byLabel = (label: string) => pg.find(i => i.label === label);

  test('every curated ST_* function is offered on PostgreSQL', () => {
    for (const name of EXPECTED_ST) {
      const item = byLabel(name);
      assert.ok(item, `${name} is offered on postgres`);
      assert.equal(item.type, 'function', `${name} is a function completion`);
    }
  });

  test('at least ~25 ST_* functions are present', () => {
    const count = pg.filter(i => i.label.startsWith('ST_')).length;
    assert.ok(count >= 25, `expected >= 25 ST_* functions, got ${count}`);
  });

  test('each ST_* carries a signature (detail) and an insert snippet', () => {
    for (const name of EXPECTED_ST) {
      const item = byLabel(name);
      assert.equal(typeof item.detail, 'string');
      assert.ok(item.detail.includes(name), `${name} signature mentions the name`);
      assert.equal(typeof item.snippet, 'string');
    }
  });

  test('key signatures read as expected (hover text)', () => {
    assert.equal(byLabel('ST_DWithin').detail, 'ST_DWithin(a, b, distance)');
    assert.equal(byLabel('ST_SetSRID').detail, 'ST_SetSRID(geom, srid)');
    assert.equal(byLabel('ST_Transform').detail, 'ST_Transform(geom, srid)');
  });
});

describe('PostGIS ST_* functions are PostgreSQL-gated', () => {
  for (const engine of ['mysql', 'sqlite', 'clickhouse'] as const) {
    test(`no ST_* functions leak into the ${engine} catalog`, () => {
      const items = keywordCatalog(engine);
      const st = items.filter(i => i.label.startsWith('ST_'));
      assert.equal(st.length, 0, `${engine} must not offer ST_* functions`);
    });
  }
});

describe('PostGIS ST_* respect the lower-case preference', () => {
  test('applyKeywordCase lowercases the label and snippet but keeps the signature readable', () => {
    const pg = keywordCatalog('postgres');
    const lowered = applyKeywordCase(pg, false);
    const item = lowered.find(i => i.detail === 'ST_DWithin(a, b, distance)');
    assert.ok(item, 'ST_DWithin survives case mapping (matched by its detail)');
    assert.equal(item.label, 'st_dwithin');
    assert.match(item.snippet ?? '', /^st_dwithin\(/);
  });
});
