import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findVariables, substituteVariables, looksNumeric } from '../src/utils/sqlVars.ts';

test('finds unique named variables in order across common SQL positions', () => {
  assert.deepEqual(
    findVariables('SELECT * FROM orders WHERE id=:id AND tenant IN (:a, :b) AND id = :id LIMIT :n'),
    ['id', 'a', 'b', 'n'],
  );
  assert.deepEqual(findVariables('INSERT INTO t VALUES(:a,:b)'), ['a', 'b']);
  assert.deepEqual(findVariables('SELECT ARRAY[:first, :second]', 'postgres'), ['first', 'second']);
});

test('ignores PostgreSQL casts, assignments and array slices while keeping adjacent variables', () => {
  assert.deepEqual(
    findVariables('SELECT :val::int, arr[1:upper], arr[lo:hi], (fn())[1:end_idx], m[1][2]:tag FROM t WHERE x := :assigned', 'postgres'),
    ['val', 'assigned'],
  );
  assert.equal(
    substituteVariables('SELECT :val::int, arr[1:upper]', { val: { value: '42', raw: true } }, 'postgres'),
    'SELECT 42::int, arr[1:upper]',
  );
  // Triple-colon typos never leak a trailing :name
  assert.deepEqual(findVariables('SELECT x:::int', 'postgres'), []);
});

test('handles doubled quotes and dialect-specific backslash escapes', () => {
  // Doubled single quotes keep :inside within the literal
  assert.deepEqual(findVariables("SELECT ''' :inside ''', 'it''s :also_inside', :outside"), ['outside']);
  assert.deepEqual(findVariables('SELECT "col"":inside", `col``:inside`, :real'), ['real']);

  // Plain strings ending with a backslash do not swallow :id on PG / T-SQL / SQLite / DuckDB
  for (const eng of ['postgres', 'sqlserver', 'sqlite', 'duckdb'] as const) {
    assert.deepEqual(
      findVariables(String.raw`SELECT 'C:\' AS p FROM t WHERE id = :id`, eng),
      ['id'],
      eng,
    );
  }
  // PG and DuckDB E'...' strings DO escape quotes with backslash
  for (const eng of ['postgres', 'duckdb'] as const) {
    assert.deepEqual(
      findVariables(String.raw`SELECT E'it\'s :not_var', :real_var`, eng),
      ['real_var'],
      eng,
    );
  }
  // MySQL plain strings escape quotes with backslash
  assert.deepEqual(
    findVariables(String.raw`SELECT 'it\'s :not_var', :real_var`, 'mysql'),
    ['real_var'],
  );
});

test('respects dialect comment rules, dollar-quotes and T-SQL brackets', () => {
  // # is an operator on PG and a temp-table prefix on T-SQL, so :id after it is live
  assert.deepEqual(
    findVariables("SELECT payload #>> '{a}' FROM t WHERE id = :id", 'postgres'),
    ['id'],
  );
  assert.deepEqual(
    findVariables('SELECT [:not_a_var] FROM #tmp WHERE id = :id', 'sqlserver'),
    ['id'],
  );
  // # is a line comment on MySQL (and when engine is omitted)
  assert.deepEqual(findVariables('SELECT 1 # :commented\nWHERE id = :id', 'mysql'), ['id']);
  assert.deepEqual(findVariables('SELECT 1 # :commented\nWHERE id = :id'), ['id']);

  // Dollar-quoted bodies on PG / DuckDB / default are skipped
  const dollarSql = 'DO $body$ BEGIN PERFORM :inside_dollar; END $body$; SELECT :outside;';
  assert.deepEqual(findVariables(dollarSql, 'postgres'), ['outside']);
  assert.deepEqual(findVariables(dollarSql, 'duckdb'), ['outside']);
  assert.deepEqual(findVariables(dollarSql), ['outside']);

  // Nested block comments on PG / T-SQL
  assert.deepEqual(
    findVariables('SELECT /* outer /* :inner */ :still_comment */ :live', 'postgres'),
    ['live'],
  );
});

test('substituteVariables quotes literals per target engine and preserves raw values', () => {
  const sql = "SELECT payload #>> '{k}' FROM t WHERE path = :path AND n = :n";
  const values = {
    path: { value: String.raw`C:\dir's`, raw: false },
    n: { value: '7', raw: true },
  };
  assert.equal(
    substituteVariables(sql, values, 'postgres'),
    String.raw`SELECT payload #>> '{k}' FROM t WHERE path = 'C:\dir''s' AND n = 7`,
  );
  assert.equal(
    substituteVariables('SELECT :path', { path: values.path }, 'mysql'),
    String.raw`SELECT 'C:\\dir''s'`,
  );
  assert.equal(looksNumeric('-12.5'), true);
  assert.equal(looksNumeric('abc'), false);
});
