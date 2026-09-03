/**
 * psql meta-command mapping (src/utils/psqlMeta.ts).
 *
 * The value of this module is muscle memory: a PostgreSQL DBA types `\dt` and
 * expects a table listing, not "unknown command". So the tests pin each command
 * to the catalog it must query, check that a relation name is embedded *safely*
 * (a stray quote must not break out of the literal), and confirm the two client
 * toggles and the non-PostgreSQL gate behave as the shell's dispatch relies on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psqlMeta } from '../src/utils/psqlMeta.ts';

const PG = 'postgres';

// ── each listing command hits the catalog it stands for ─────────────────────

test('\\l and \\list list databases', () => {
  assert.match(psqlMeta('\\l', PG)!.sql!, /pg_database/);
  assert.match(psqlMeta('\\list', PG)!.sql!, /pg_database/);
});

test('\\dt lists tables', () => {
  assert.match(psqlMeta('\\dt', PG)!.sql!, /pg_tables/);
});

test('\\dv lists views', () => {
  assert.match(psqlMeta('\\dv', PG)!.sql!, /pg_views/);
});

test('\\di lists indexes', () => {
  assert.match(psqlMeta('\\di', PG)!.sql!, /pg_indexes/);
});

test('\\dn lists schemas', () => {
  assert.match(psqlMeta('\\dn', PG)!.sql!, /pg_namespace/);
});

test('\\df lists functions', () => {
  assert.match(psqlMeta('\\df', PG)!.sql!, /pg_proc/);
});

test('\\dp and \\z list table privileges', () => {
  assert.match(psqlMeta('\\dp', PG)!.sql!, /role_table_grants/);
  assert.match(psqlMeta('\\z', PG)!.sql!, /role_table_grants/);
});

test('\\du and \\dg list roles', () => {
  assert.match(psqlMeta('\\du', PG)!.sql!, /pg_roles/);
  assert.match(psqlMeta('\\dg', PG)!.sql!, /pg_roles/);
});

// ── describe ────────────────────────────────────────────────────────────────

test('\\d with no name lists relations', () => {
  const r = psqlMeta('\\d', PG)!;
  assert.match(r.sql!, /pg_class/);
  assert.doesNotMatch(r.sql!, /information_schema\.columns/);
});

test('\\d name describes the columns of that relation', () => {
  const r = psqlMeta('\\d orders', PG)!;
  assert.match(r.sql!, /information_schema\.columns/);
  assert.match(r.sql!, /'orders'/);
});

test('\\d+ name is treated like \\d name', () => {
  const r = psqlMeta('\\d+ orders', PG)!;
  assert.match(r.sql!, /information_schema\.columns/);
  assert.match(r.sql!, /'orders'/);
});

test('a schema-qualified name filters on both schema and table', () => {
  const r = psqlMeta('\\d public.orders', PG)!;
  assert.match(r.sql!, /table_name = 'orders'/);
  assert.match(r.sql!, /table_schema = 'public'/);
});

test('a relation name with a quote cannot break out of the literal', () => {
  const r = psqlMeta("\\d o'rders", PG)!;
  // The quote is doubled, so the value stays one literal — no injection.
  assert.match(r.sql!, /'o''rders'/);
});

// ── patterns ────────────────────────────────────────────────────────────────

test('a glob pattern becomes a LIKE clause', () => {
  const r = psqlMeta('\\dt user*', PG)!;
  assert.match(r.sql!, /LIKE 'user%'/);
});

test('a literal % in a pattern is escaped, not treated as a wildcard', () => {
  const r = psqlMeta('\\dt 50%*', PG)!;
  assert.match(r.sql!, /LIKE '50\\%%'/);
});

// ── client toggles, on any engine ───────────────────────────────────────────

test('\\timing is a client toggle with no SQL', () => {
  assert.deepEqual(psqlMeta('\\timing', PG), { toggle: 'timing' });
  assert.deepEqual(psqlMeta('\\timing on', 'mysql'), { toggle: 'timing' });
});

test('\\x is a client toggle on any engine', () => {
  assert.deepEqual(psqlMeta('\\x', PG), { toggle: 'expanded' });
  assert.deepEqual(psqlMeta('\\x', 'mysql'), { toggle: 'expanded' });
});

// ── the gate and the unknowns ───────────────────────────────────────────────

test('an unknown backslash command is null, so the shell can report it', () => {
  assert.equal(psqlMeta('\\nope', PG), null);
  assert.equal(psqlMeta('\\help', PG), null);
  assert.equal(psqlMeta('\\?', PG), null);
});

test('a line that is not a backslash command is null', () => {
  assert.equal(psqlMeta('SELECT 1', PG), null);
  assert.equal(psqlMeta('', PG), null);
});

test('catalog commands are gated to PostgreSQL', () => {
  // On another engine the catalog shape differs; return null and let the shell
  // fall back to its own MySQL handling rather than emit wrong SQL.
  assert.equal(psqlMeta('\\dt', 'mysql'), null);
  assert.equal(psqlMeta('\\d orders', 'mysql'), null);
  assert.equal(psqlMeta('\\l', 'clickhouse'), null);
});

test('postgresql and pg are accepted as PostgreSQL', () => {
  assert.match(psqlMeta('\\dt', 'postgresql')!.sql!, /pg_tables/);
  assert.match(psqlMeta('\\dt', 'PG')!.sql!, /pg_tables/);
});
