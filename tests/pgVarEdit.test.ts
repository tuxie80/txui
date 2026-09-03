import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPgVarSql, buildPgVarResetSql } from '../src/utils/pgVarEdit.ts';

test('numbers bare, strings quoted, booleans normalized; reload appended', () => {
  assert.equal(buildPgVarSql('max_connections', '200'),
    'ALTER SYSTEM SET "max_connections" = 200;\nSELECT pg_reload_conf();');
  assert.equal(buildPgVarSql('work_mem', '16MB'),
    "ALTER SYSTEM SET \"work_mem\" = '16MB';\nSELECT pg_reload_conf();");
  assert.equal(buildPgVarSql('fsync', 'ON'),
    'ALTER SYSTEM SET "fsync" = on;\nSELECT pg_reload_conf();');
});

test('string values escape single quotes; identifiers escape double quotes', () => {
  assert.match(buildPgVarSql('search_path', "a'b"), /= 'a''b';/);
  assert.match(buildPgVarSql('we"ird', 'x'), /SET "we""ird" =/);
});

test('reset produces ALTER SYSTEM RESET + reload', () => {
  assert.equal(buildPgVarResetSql('work_mem'),
    'ALTER SYSTEM RESET "work_mem";\nSELECT pg_reload_conf();');
});
