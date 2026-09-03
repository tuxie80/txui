/**
 * DuckDB DBA views + `\` shortcuts (src/utils/dbaViews.ts, src/utils/sqlKeywords.ts):
 * the catalog table functions do NOT share one column set, and getting that
 * wrong is a hard binder error rather than an empty grid.
 *
 * Verified against the bundled engine (DuckDB v1.5.1, via duckdb-rs
 * ~1.10505.0): duckdb_tables/views/columns/functions/databases carry
 * `internal`; duckdb_indexes/constraints/sequences do NOT — they list user
 * objects only. duckdb_databases() spells the access-mode flag `readonly`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';
import { STATEMENT_SHORTCUTS } from '../src/utils/sqlKeywords.ts';

const dd = DBA_VIEWS.duckdb;

/** Catalog functions that have no `internal` column in DuckDB 1.5.x. */
const NO_INTERNAL = ['duckdb_indexes', 'duckdb_constraints', 'duckdb_sequences'];
/** …and the ones that do, so the filter is not dropped where it belongs. */
const HAS_INTERNAL = ['duckdb_tables', 'duckdb_views', 'duckdb_columns', 'duckdb_functions'];

const duckdbSql = [
  ...dd.map(v => ({ where: `view ${v.id}`, sql: v.sql })),
  ...STATEMENT_SHORTCUTS.filter(s => s.engines?.includes('duckdb'))
    .map(s => ({ where: `shortcut \\${s.shortcut}`, sql: s.statement })),
];

describe('DuckDB catalog columns', () => {
  test('no query filters `internal` on a function that has not got it', () => {
    for (const { where, sql } of duckdbSql) {
      for (const fn of NO_INTERNAL) {
        if (!sql.includes(`${fn}()`)) continue;
        assert.ok(!/\binternal\b/.test(sql),
          `${where}: ${fn}() has no \`internal\` column in DuckDB 1.5 — ` +
          'referencing it is a Binder Error, not an empty result');
      }
    }
  });

  test('the functions that DO have `internal` still hide it', () => {
    for (const fn of HAS_INTERNAL) {
      const users = duckdbSql.filter(q => q.sql.includes(`${fn}()`));
      for (const { where, sql } of users) {
        assert.match(sql, /WHERE NOT internal/,
          `${where}: ${fn}() lists system objects unless \`internal\` is filtered out`);
      }
    }
  });

  test('the attached-database flag is `readonly`, not `read_only`', () => {
    for (const { where, sql } of duckdbSql) {
      if (!sql.includes('duckdb_databases()')) continue;
      assert.ok(!/\bread_only\b/.test(sql),
        `${where}: duckdb_databases() spells the access-mode flag \`readonly\``);
    }
  });

  test('the Sequences / Constraints / Indexes views are still registered', () => {
    for (const id of ['dd-sequences', 'dd-constraints', 'dd-indexes', 'dd-dbs']) {
      assert.ok(dd.some(v => v.id === id), `${id} view is registered`);
    }
  });
});
