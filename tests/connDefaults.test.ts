/**
 * Connection-form defaults (src/utils/connDefaults.ts).
 *
 * The behaviour this locks in: engine defaults are *placeholders*, never
 * prefilled text. A blank field resolves to the default at save time, so the
 * user never has to select-and-delete `default` / `root` / `3306` to type
 * their own value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_DEFAULTS, DEFAULT_HOST, resolveDefaults, clearStaleDefaults, databasePlaceholder,
} from '../src/utils/connDefaults.ts';

const blank = { host: '', port: null, user: '', database: '' };

test('a completely blank form resolves to the engine defaults', () => {
  assert.deepEqual(resolveDefaults(blank, 'clickhouse'), {
    host: 'localhost', port: 8123, user: 'default', database: 'default',
  });
  assert.deepEqual(resolveDefaults(blank, 'mysql'), {
    host: 'localhost', port: 3306, user: 'root', database: null,
  });
  assert.deepEqual(resolveDefaults(blank, 'postgres'), {
    host: 'localhost', port: 5432, user: 'postgres', database: 'postgres',
  });
  // Redis has no user and no named database — blank stays blank.
  assert.deepEqual(resolveDefaults(blank, 'redis'), {
    host: 'localhost', port: 6379, user: null, database: null,
  });
});

test('typed values always win, and whitespace does not count as typed', () => {
  const typed = { host: 'ch.internal', port: 8443, user: 'dolphie', database: 'dolphie' };
  assert.deepEqual(resolveDefaults(typed, 'clickhouse'), {
    host: 'ch.internal', port: 8443, user: 'dolphie', database: 'dolphie',
  });
  assert.deepEqual(
    resolveDefaults({ host: '  ', port: null, user: ' \t', database: '  ' }, 'mysql'),
    { host: DEFAULT_HOST, port: 3306, user: 'root', database: null },
  );
});

test('port 0 is not treated as "blank"', () => {
  // The old form did `Number(e.target.value)`, so clearing the box produced 0.
  // Null is the empty state now; an explicit 0 is a (bad) value the user typed
  // and must not be silently rewritten to 3306.
  assert.equal(resolveDefaults({ ...blank, port: 0 }, 'mysql').port, 0);
});

test('switching engine drops the old default but keeps hand-typed input', () => {
  // MySQL defaults left untouched → cleared, so ClickHouse's show through.
  const untouched = { host: '', port: 3306, user: 'root', database: '' };
  assert.deepEqual(clearStaleDefaults(untouched, 'mysql', 'clickhouse'), {
    host: '', port: null, user: '', database: '',
  });

  // Anything typed by hand survives — including a port that happens to be
  // valid for the new engine.
  const typed = { host: 'db1', port: 3307, user: 'app', database: 'shop' };
  assert.deepEqual(clearStaleDefaults(typed, 'mysql', 'postgres'), typed);

  // Host is never engine-specific, so it is never cleared.
  assert.equal(clearStaleDefaults({ ...untouched, host: 'h' }, 'mysql', 'redis').host, 'h');

  // Same engine → untouched.
  assert.deepEqual(clearStaleDefaults(typed, 'mysql', 'mysql'), typed);
});

test('a stale default is cleared even when the two engines share it', () => {
  // Nothing shares a port today, but user names could: guard the rule itself.
  const f = { host: '', port: null, user: ENGINE_DEFAULTS.postgres.user, database: '' };
  assert.equal(clearStaleDefaults(f, 'postgres', 'mysql').user, '');
});

test('database placeholder says what blank will mean', () => {
  assert.equal(databasePlaceholder('clickhouse'), 'default');
  assert.equal(databasePlaceholder('postgres'), 'postgres');
  assert.equal(databasePlaceholder('mysql'), '(optional)');
  assert.equal(databasePlaceholder('redis'), '0 (0–15)');
});

test('MongoDB dials 27017 and guesses no user or database', () => {
  // MongoDB ships unauthenticated by default, and pre-filling "root" would be
  // wrong for exactly the deployments that set one. The database doubles as
  // the default authSource, so blank means "the driver decides" (admin).
  assert.deepEqual(resolveDefaults(blank, 'mongodb'), {
    host: 'localhost', port: 27017, user: null, database: null,
  });
  assert.equal(databasePlaceholder('mongodb'), '(optional)');
});

test('the file engines have no dialable defaults — DuckDB included', () => {  // No port, no user, no preselected database: the file path is the whole
  // address, and DuckDB's catalogs come from the catalog itself.
  for (const e of ['sqlite', 'parquet', 'duckdb'] as const) {
    assert.equal(ENGINE_DEFAULTS[e].port, 0, `${e}.port`);
    assert.equal(ENGINE_DEFAULTS[e].user, '', `${e}.user`);
  }
  assert.equal(ENGINE_DEFAULTS.duckdb.db, '');
});

test('SQL Server dials 1433 and suggests sa', () => {
  // The database stays blank — the login's default database (usually master)
  // is the right answer when none is given.
  assert.deepEqual(resolveDefaults(blank, 'sqlserver'), {
    host: 'localhost', port: 1433, user: 'sa', database: null,
  });
  assert.equal(databasePlaceholder('sqlserver'), '(optional)');
});
