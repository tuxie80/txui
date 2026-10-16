/**
 * The ER diagram's SQLite arm (src/components/ErDiagram.tsx).
 *
 * `engineCaps.sqlite.erDiagram` was true while the panel had only
 * MSSQL/MySQL/PG arms: on a SQLite session the schema list fell through to
 * `SELECT … FROM pg_catalog.pg_namespace` and the panel errored the moment it
 * opened — an offered, broken feature on a shipping engine. The fix gives
 * SQLite pragma-based arms (the schema axis is the attached-database alias
 * from PRAGMA database_list; columns come from pragma_table_xinfo, foreign
 * keys from pragma_foreign_key_list).
 *
 * The arms are inline in the component (the file's existing structure), so
 * these are source pins in the style of tests/menuBar.test.ts: they fail if
 * the SQLite arm is removed or the dispatch order reverts to letting the
 * PostgreSQL catalog SQL catch every non-MySQL/MSSQL engine. The SQL itself
 * was verified against a real SQLite (attached database, generated columns,
 * FTS5 shadow tables, composite FKs, columnless REFERENCES).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const src = readFileSync(join(ROOT, 'src/components/ErDiagram.tsx'), 'utf8');

/** The substring range of one ternary arm, from marker to the next `: is`/fallback. */
function arm(from: string): string {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `arm not found: ${from}`);
  const rest = src.slice(i);
  const end = rest.search(/\n\s{6}: /);
  return end >= 0 ? rest.slice(0, end) : rest;
}

test('the schema list has a SQLite arm before the pg_catalog fallback', () => {
  // Dispatch order is the fix: pg_catalog.pg_namespace must be the FINAL
  // fallback, unreachable for sqlite, not the catch-all it was.
  const a = arm(': isSqlite\n');
  assert.match(a, /pragma_database_list/, 'SQLite schemas are attached-database aliases');
  assert.ok(src.indexOf('pragma_database_list') < src.indexOf('pg_catalog.pg_namespace'),
    'the SQLite arm must be dispatched before the PostgreSQL fallback');
});

test('the column query reads pragma_table_xinfo, not an information_schema it lacks', () => {
  const a = arm(': isSqlite\n      // table_xinfo');
  assert.match(a, /pragma_table_xinfo\(m\.name, '\$\{q\(schema\)\}'\)/,
    'the attached-database alias is the pragma function\'s second argument');
  assert.match(a, /\$\{sqMaster\} m JOIN/);
  // sqMaster is the per-database catalog, qualified by the quoted alias.
  assert.match(src, /const sqMaster = `\$\{quoteIdent\(schema, 'sqlite'\)\}\.sqlite_master`/);
  // table_xinfo, not table_info: table_info omits generated columns; hidden=1
  // (virtual-table internals) stays out, 0/2/3 (ordinary/generated) in.
  assert.match(a, /p\.hidden IN \(0,2,3\)/);
  assert.match(a, /m\.name NOT LIKE 'sqlite_%'/);
  // The PK rides the fourth column as 'PRI', the MySQL shape.
  assert.match(a, /CASE WHEN p\.pk > 0 THEN 'PRI' ELSE '' END/);
});

test('the foreign-key query reads pragma_foreign_key_list', () => {
  const a = arm(': isSqlite\n      // foreign_key_list');
  assert.match(a, /pragma_foreign_key_list\(m\.name, '\$\{q\(schema\)\}'\)/);
  // One row per column pair; composite FKs share an id — order keeps them together.
  assert.match(a, /ORDER BY m\.name, f\.id, f\.seq/);
  // A REFERENCES without a column list means the parent's PK; f."to" is NULL
  // then and is resolved rather than pointing the edge at nothing.
  assert.match(a, /COALESCE\(f\."to", \(SELECT pk\.name FROM pragma_table_xinfo/);
});

test('FTS5 shadow tables are excluded from the diagram', () => {
  // <name>_data/_idx/_content/… are storage details of their parent virtual
  // table — five extra boxes per FTS5 table, none of them schema objects.
  assert.match(src, /v\.sql LIKE 'CREATE VIRTUAL TABLE%'/);
  assert.match(src, /m\.name LIKE v\.name \|\| '\\\\_%' ESCAPE '\\\\'/);
});

test('SQLite shares the PK-in-columns path with MySQL (no pk query)', () => {
  assert.match(src, /isMysql \|\| isSqlite \? Promise\.resolve/);
  assert.match(src, /isMysql \|\| isSqlite \? String\(r\[3\]\) === 'PRI'/);
});

test('string literals are escaped the SQLite way (quote doubling, no backslash)', () => {
  assert.match(src, /escapeLiteral\(v, isMssql \? 'sqlserver' : isMysql \? 'mysql' : isSqlite \? 'sqlite' : 'postgres'\)/);
});

test('pg_catalog appears only in the PostgreSQL fallback, after the SQLite arm', () => {
  // Twice inside the one fallback query: pg_catalog.pg_namespace and the
  // sort key ('pg_catalog','information_schema'). Both must come after the
  // SQLite arm — the arm's position in the ternary is what keeps sqlite
  // sessions off this SQL.
  const idx = [...src.matchAll(/pg_catalog/g)].map(m => m.index);
  assert.equal(idx.length, 2);
  for (const i of idx) {
    assert.ok(i > src.indexOf('pragma_database_list'),
      'pg_catalog SQL reachable before the SQLite arm is dispatched');
  }
});

test('the comment-scan hint stays off SQLite (SQLite stores no column comments)', () => {
  // commentedColumnsSql has no SQLite arm; without this gate the hint bar
  // offered a scan that runs information_schema SQL and errors.
  assert.match(src, /const fkPoor = !isSqlite && /);
});
