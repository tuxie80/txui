/**
 * Schema kits — the demo databases the data generator can build.
 *
 * The kits are shared data with a per-engine DDL renderer, so the risk is not
 * in the kit definitions but in the rendering: a type that means something
 * different on another engine produces a table that is created happily and
 * then rejects its own data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_KITS, buildKitPreDdl, buildKitTableDdl,
} from '../src/utils/schemaKits.ts';


// ── SQL Server ───────────────────────────────────────────────────────────────
//
// Every kit's DDL was executed against SQL Server 2022 — all five schemas and
// 19 tables created cleanly, the computed geography column included.

test('TIMESTAMP is not a date in T-SQL — it is rowversion', () => {
  // This is the worst of the four type traps because it fails LATE: the column
  // is created happily as a binary version stamp, and then every insert of a
  // date fails with Msg 273, "Cannot insert an explicit value into a timestamp
  // column".
  const ddl = buildKitTableDdl('k', {
    name: 't', columns: [{ name: 'c', type: 'TIMESTAMP', generator: 'timestamp' }],
  } as never, 'sqlserver').join('\n');
  assert.match(ddl, /\[c\] datetime2\(3\)/);
  assert.ok(!/\bTIMESTAMP\b/i.test(ddl), ddl);
});

test('the three types SQL Server simply does not have are mapped', () => {
  const ddl = buildKitTableDdl('k', {
    name: 't',
    columns: [
      { name: 'a', type: 'BOOLEAN', generator: 'bool' },
      { name: 'b', type: 'DOUBLE', generator: 'decimal' },
      { name: 'c', type: 'JSON', generator: 'constant' },
      { name: 'd', type: 'VARCHAR(60)', generator: 'firstName' },
    ],
  } as never, 'sqlserver').join('\n');
  // "Cannot find data type BOOLEAN" / "Incorrect syntax near ')'" /
  // "Cannot find data type json" — all measured.
  assert.match(ddl, /\[a\] bit/);
  assert.match(ddl, /\[b\] float/);
  assert.match(ddl, /\[c\] nvarchar\(max\)/);
  // The demo data is Unicode, and a varchar column replaces what its code page
  // cannot hold with `?`.
  assert.match(ddl, /\[d\] nvarchar\(60\)/);
});

test('a computed column carries no type, and PERSISTED is its STORED', () => {
  const kit = SCHEMA_KITS.find(k => k.tables.some(t => t.columns.some(c => c.generated)))!;
  const table = kit.tables.find(t => t.columns.some(c => c.generated))!;
  const ddl = buildKitTableDdl('k', table, 'sqlserver').join('\n');
  assert.match(ddl, /\[geom\] AS \(geography::Point\(lat, lon, 4326\)\) PERSISTED/);
  // `geography::Point` takes the SRID and latitude FIRST — the opposite
  // argument order to the other two engines' `POINT(lon, lat)`.
  assert.ok(!ddl.includes('GENERATED ALWAYS'), ddl);
});

test('the namespace DDL is the existence test, not IF NOT EXISTS', () => {
  assert.deepEqual(buildKitPreDdl('zz_kit', 'sqlserver'),
    ["IF SCHEMA_ID('zz_kit') IS NULL EXEC('CREATE SCHEMA [zz_kit]')"]);
});

test('SQL Server takes an inline INDEX, so no separate CREATE INDEX is emitted', () => {
  const kit = SCHEMA_KITS.find(k => k.tables.some(t => (t.indexes ?? []).length > 0))!;
  const table = kit.tables.find(t => (t.indexes ?? []).length > 0)!;
  const stmts = buildKitTableDdl('k', table, 'sqlserver');
  assert.equal(stmts.length, 1, 'the whole table should be one statement');
  assert.match(stmts[0], /\n {2}INDEX \[/);
});

test('the other engines keep their own types and shapes', () => {
  const cols = [{ name: 'a', type: 'BOOLEAN', generator: 'bool' }] as never;
  assert.match(buildKitTableDdl('k', { name: 't', columns: cols } as never, 'mysql').join('\n'),
    /BOOLEAN/);
  assert.deepEqual(buildKitPreDdl('k', 'postgres'), ['CREATE SCHEMA IF NOT EXISTS "k"']);
});
