/**
 * Schema enumeration for in-panel pickers (src/utils/schemaPick.ts).
 *
 * The load-bearing details: SQL Server's list comes from sys.schemas with the
 * fixed-role schemas filtered (information_schema.schemata would list a dozen
 * empty ones), and the picker's default is `dbo`, not whatever sorts first —
 * a picker that opens on `db_owner` would list nothing and read as broken.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { schemaListSql, defaultSchema } from '../src/utils/schemaPick.ts';
import { ENGINES } from '../src/utils/engineCaps.ts';

describe('schemaListSql', () => {
  test('sqlserver reads sys.schemas, dropping the fixed-role schemas', () => {
    const sql = schemaListSql('sqlserver')!;
    assert.match(sql, /FROM sys\.schemas/);
    assert.match(sql, /schema_id < 16384/);
    assert.match(sql, /NOT IN \('sys','INFORMATION_SCHEMA','guest'\)/);
    assert.match(sql, /ORDER BY name/);
  });

  test('mysql and postgres read information_schema.schemata, system schemas out', () => {
    const my = schemaListSql('mysql')!;
    assert.match(my, /FROM information_schema\.schemata/);
    assert.match(my, /'information_schema','performance_schema','mysql','sys'/);
    const pg = schemaListSql('postgres')!;
    assert.match(pg, /FROM information_schema\.schemata/);
    assert.match(pg, /'pg_catalog','information_schema'/);
  });

  test('engines without a panel picker answer null, not a guess', () => {
    for (const e of ENGINES) {
      if (e === 'mysql' || e === 'postgres' || e === 'sqlserver') continue;
      assert.equal(schemaListSql(e), null, `${e} should have no schema-list SQL`);
    }
  });
});

describe('defaultSchema', () => {
  test('sqlserver lands on dbo when it is in the list', () => {
    assert.equal(defaultSchema('sqlserver', ['db_owner', 'dbo', 'sales']), 'dbo');
  });

  test('sqlserver without a dbo falls back to the first schema', () => {
    assert.equal(defaultSchema('sqlserver', ['app', 'sales']), 'app');
  });

  test('other engines take the first schema', () => {
    assert.equal(defaultSchema('mysql', ['analytics', 'shop']), 'analytics');
    assert.equal(defaultSchema('postgres', ['public', 'shop']), 'public');
  });

  test('an empty list yields an empty string, never undefined', () => {
    assert.equal(defaultSchema('sqlserver', []), '');
    assert.equal(defaultSchema('mysql', []), '');
  });
});
