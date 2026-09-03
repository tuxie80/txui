import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mysqlCreateRoleSql, mysqlDropRoleSql, mysqlGrantRoleSql, mysqlRevokeRoleSql, mysqlSetDefaultRoleSql,
} from '../src/utils/privileges.ts';

test('create role, quoted, with IF NOT EXISTS', () => {
  assert.equal(mysqlCreateRoleSql([{ name: 'app_ro' }, { name: 'app_rw' }], { ifNotExists: true }),
    "CREATE ROLE IF NOT EXISTS 'app_ro'@'%', 'app_rw'@'%';");
});

test('grant / revoke role to an account', () => {
  assert.equal(mysqlGrantRoleSql([{ name: 'app_ro' }], { user: 'alice', host: '10.%' }),
    "GRANT 'app_ro'@'%' TO 'alice'@'10.%';");
  assert.equal(mysqlRevokeRoleSql([{ name: 'app_ro' }], { user: 'alice' }),
    "REVOKE 'app_ro'@'%' FROM 'alice'@'%';");
});

test('set default role ALL / NONE / explicit', () => {
  const acct = { user: 'alice' };
  assert.equal(mysqlSetDefaultRoleSql(acct, 'ALL'), "SET DEFAULT ROLE ALL TO 'alice'@'%';");
  assert.equal(mysqlSetDefaultRoleSql(acct, 'NONE'), "SET DEFAULT ROLE NONE TO 'alice'@'%';");
  assert.equal(mysqlSetDefaultRoleSql(acct, [{ name: 'app_ro' }]), "SET DEFAULT ROLE 'app_ro'@'%' TO 'alice'@'%';");
});

test('empty inputs produce nothing', () => {
  assert.equal(mysqlCreateRoleSql([]), '');
  assert.equal(mysqlDropRoleSql([]), '');
  assert.equal(mysqlGrantRoleSql([{ name: 'r' }], { user: '' }), '');
});
