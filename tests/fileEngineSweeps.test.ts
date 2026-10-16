/**
 * Catalog sweeps on the file engines — source pins.
 *
 * The sweep SQL lives inline in the hook/component (there is no pure module
 * to import), so the contract is pinned by reading the source, the same way
 * menuBar.test.ts pins the native menu and locksPanelSql.test.ts pins panel
 * SQL.
 *
 * Two facts:
 *  1. `pragma_table_info` omits SQLite generated columns ENTIRELY — every
 *     catalog probe must use `pragma_table_xinfo` with `hidden IN (0,2,3)`
 *     (ordinary + VIRTUAL/STORED generated; hidden-1 virtual-table internals
 *     stay out), mirroring db/sqlite.rs list_columns.
 *  2. Parquet reads files, not a catalog — it must not reach the SQL
 *     information_schema sweeps (the driver rejects them and the
 *     `catch { return null }` turned that into a silently empty palette).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const completions = readFileSync('src/hooks/useSchemaCompletions.ts', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');

test('the completion index/PK probe uses pragma_table_xinfo', () => {
  assert.ok(!completions.includes('pragma_table_info'),
    'table_info omits generated columns — a generated PK column answered "no index"');
  assert.match(completions,
    /pragma_table_xinfo\(\$\{sqlLiteral\(name, 'sqlite'\)\}\) p\s+WHERE p\.pk > 0 AND p\.hidden IN \(0,2,3\)/);
});

test('the Open Anything column sweep uses pragma_table_xinfo with the hidden filter', () => {
  assert.ok(!app.includes('pragma_table_info'),
    'the palette column sweep must not omit generated columns');
  assert.ok(app.includes('JOIN pragma_table_xinfo(m.name) p'));
  assert.ok(app.includes('p.hidden IN (0,2,3)'));
});

test('Parquet stays out of the Open Anything catalog sweep', () => {
  // The exclusion must be the early-return guard beside redis/mongodb —
  // anything later and Parquet still falls into an information_schema branch.
  assert.match(app,
    /if \(!s \|\| s\.engine === 'redis' \|\| s\.engine === 'mongodb' \|\| s\.engine === 'parquet'\)/);
});
