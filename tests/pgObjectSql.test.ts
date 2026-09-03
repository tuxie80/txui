import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionCreateSql, extensionDropSql, AVAILABLE_EXTENSIONS_SQL } from '../src/utils/pgObjectSql.ts';

test('extensionCreateSql: idempotent CREATE, name double-quoted (canonical form)', () => {
  assert.equal(extensionCreateSql('postgis'), 'CREATE EXTENSION IF NOT EXISTS "postgis";');
  assert.equal(extensionCreateSql('pg_trgm'), 'CREATE EXTENSION IF NOT EXISTS "pg_trgm";');
});

test('extensionCreateSql: a name with a dash is safely quoted', () => {
  assert.equal(extensionCreateSql('uuid-ossp'), 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
});

test('extensionDropSql: plain DROP so the server enforces dependencies', () => {
  assert.equal(extensionDropSql('postgis'), 'DROP EXTENSION "postgis";');
  assert.equal(extensionDropSql('uuid-ossp'), 'DROP EXTENSION "uuid-ossp";');
});

test('extension SQL: an embedded quote cannot break out of the identifier', () => {
  // Defensive — real extension names never contain a quote, but the quoting
  // must still double it rather than concatenate it raw.
  assert.equal(extensionCreateSql('a"b'), 'CREATE EXTENSION IF NOT EXISTS "a""b";');
});

test('AVAILABLE_EXTENSIONS_SQL: only not-yet-installed rows, ordered', () => {
  assert.match(AVAILABLE_EXTENSIONS_SQL, /pg_available_extensions/);
  assert.match(AVAILABLE_EXTENSIONS_SQL, /installed_version IS NULL/);
  assert.match(AVAILABLE_EXTENSIONS_SQL, /ORDER BY name/);
});
