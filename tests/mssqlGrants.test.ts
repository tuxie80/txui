/**
 * SQL Server users, roles and permissions.
 *
 * Every statement asserted below was executed against SQL Server 2022 and
 * accepted, and every catalog row is one the live server actually returned for
 * `dev/mssql_fixture.sql` plus a test principal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MSSQL_PERMISSIONS, MSSQL_PERMISSIONS_BY_SCOPE, MSSQL_PRINCIPALS_SQL,
  mssqlScopeKey, mssqlScopeSql, mssqlScopeLabel,
  mssqlPrincipalFromRow, mssqlPermissionsSql, parseMssqlPermissions, stateFromDesc,
  mssqlStatesForScope, mssqlGrantDiffSql,
  mssqlCreateUserSql, mssqlCreateRoleSql, mssqlDropSql, mssqlRoleMemberSql,
  mssqlFixOrphanSql,
} from '../src/utils/mssqlGrants.ts';
import type { MssqlPermission, MssqlGrantState } from '../src/utils/mssqlGrants.ts';

// The exact rows the live server returned for `txui_low`.
const PERM_ROWS: (readonly unknown[])[] = [
  [0, 'GRANT', 'CONNECT', '', 0],
  [0, 'GRANT', 'EXECUTE', '', 0],
  [1, 'GRANT', 'DELETE', 'sales.orders', 0],
  [1, 'GRANT', 'INSERT', 'sales.orders', 0],
  [1, 'GRANT', 'SELECT', 'sales.orders', 0],
  [1, 'GRANT', 'VIEW DEFINITION', 'sales.usp_close_orders', 0],
  [3, 'DENY', 'DELETE', 'sales', 0],
  [3, 'GRANT_WITH_GRANT_OPTION', 'EXECUTE', 'sales', 0],
  [3, 'GRANT', 'SELECT', 'sales', 0],
];

const m = (pairs: [MssqlPermission, MssqlGrantState][]) => new Map(pairs);

test('DENY is a state of its own, not the absence of a grant', () => {
  // It beats every GRANT, including ones inherited from a role, so a two-state
  // checkbox would show access the principal demonstrably does not have.
  const { grants } = parseMssqlPermissions(PERM_ROWS);
  const schema = mssqlStatesForScope(grants, { kind: 'schema', schema: 'sales' });
  assert.equal(schema.get('DELETE'), 'deny');
  assert.equal(schema.get('SELECT'), 'grant');
  assert.equal(schema.get('EXECUTE'), 'grant-with-option');
});

test('the three scope classes land in three different buckets', () => {
  const { grants } = parseMssqlPermissions(PERM_ROWS);
  assert.deepEqual([...grants.keys()].sort(), [
    'DATABASE', 'OBJECT::sales.orders', 'OBJECT::sales.usp_close_orders', 'SCHEMA::sales',
  ]);
  // A schema grant is not an object grant — the same permission name at two
  // scopes is two different rows and must not overwrite each other.
  assert.equal(mssqlStatesForScope(grants, { kind: 'schema', schema: 'sales' }).get('DELETE'), 'deny');
  assert.equal(
    mssqlStatesForScope(grants, { kind: 'object', schema: 'sales', name: 'orders' }).get('DELETE'),
    'grant');
});

test('a permission the matrix has no column for is ignored, not bucketed', () => {
  // CONNECT is real and is not one of the columns, so the grid must not claim
  // to manage it — the diff would otherwise revoke it on the first save.
  const { grants } = parseMssqlPermissions(PERM_ROWS);
  const db = mssqlStatesForScope(grants, { kind: 'database' });
  assert.ok(!db.has('CONNECT' as MssqlPermission));
  assert.equal(db.get('EXECUTE'), 'grant');
});

test('column-level grants are counted, never shown as table grants', () => {
  // Showing `SELECT (name)` as SELECT would claim access to every other column.
  const { grants, columnGrants } = parseMssqlPermissions([
    ...PERM_ROWS,
    [1, 'GRANT', 'SELECT', 'sales.customers', 1],
    [1, 'GRANT', 'UPDATE', 'sales.customers', 1],
  ]);
  assert.equal(columnGrants, 2);
  assert.ok(!grants.has('OBJECT::sales.customers'));
});

test('every state_desc the catalog can return maps somewhere', () => {
  assert.equal(stateFromDesc('GRANT'), 'grant');
  assert.equal(stateFromDesc('GRANT_WITH_GRANT_OPTION'), 'grant-with-option');
  assert.equal(stateFromDesc('DENY'), 'deny');
  assert.equal(stateFromDesc('REVOKE'), 'none');
  assert.equal(stateFromDesc('anything else'), 'none');
});

test('the ON clause differs by class — only an object goes unprefixed', () => {
  assert.equal(mssqlScopeSql({ kind: 'database' }, 'txui_demo'), 'DATABASE::[txui_demo]');
  assert.equal(mssqlScopeSql({ kind: 'schema', schema: 'sales' }, 'db'), 'SCHEMA::[sales]');
  assert.equal(
    mssqlScopeSql({ kind: 'object', schema: 'sales', name: 'orders' }, 'db'),
    '[sales].[orders]');
});

test('a bracket inside a name doubles, or it closes the identifier early', () => {
  assert.equal(mssqlScopeSql({ kind: 'schema', schema: 'a]b' }, 'db'), 'SCHEMA::[a]]b]');
  assert.match(mssqlCreateRoleSql('r]x'), /\[r\]\]x\]/);
});

test('a DENY being lifted is REVOKEd before the GRANT, never after', () => {
  // A DENY still in place wins over a GRANT just issued: run the other way
  // round, both statements succeed and access does not change — which is the
  // worst outcome, because it looks like it worked.
  const sql = mssqlGrantDiffSql({
    principal: 'txui_low', database: 'txui_demo',
    scope: { kind: 'object', schema: 'sales', name: 'orders' },
    desired: m([['DELETE', 'grant']]),
    current: m([['DELETE', 'deny']]),
  });
  const lines = sql.split('\n');
  assert.match(lines[0], /^REVOKE DELETE ON \[sales\]\.\[orders\] FROM \[txui_low\];$/);
  assert.match(lines[1], /^GRANT DELETE ON \[sales\]\.\[orders\] TO \[txui_low\];$/);
});

test('the three kinds of change become three statements, grouped', () => {
  const sql = mssqlGrantDiffSql({
    principal: 'txui_low', database: 'txui_demo',
    scope: { kind: 'schema', schema: 'sales' },
    desired: m([['SELECT', 'grant'], ['DELETE', 'deny'], ['EXECUTE', 'grant-with-option']]),
    current: new Map(),
  });
  assert.deepEqual(sql.split('\n'), [
    'GRANT SELECT ON SCHEMA::[sales] TO [txui_low];',
    'GRANT EXECUTE ON SCHEMA::[sales] TO [txui_low] WITH GRANT OPTION;',
    'DENY DELETE ON SCHEMA::[sales] TO [txui_low];',
  ]);
});

test('removing a permission is a REVOKE, and no change is no SQL', () => {
  assert.equal(
    mssqlGrantDiffSql({
      principal: 'u', database: 'd', scope: { kind: 'database' },
      desired: new Map(), current: m([['SELECT', 'grant']]),
    }),
    'REVOKE SELECT ON DATABASE::[d] FROM [u];');
  assert.equal(
    mssqlGrantDiffSql({
      principal: 'u', database: 'd', scope: { kind: 'database' },
      desired: m([['SELECT', 'grant']]), current: m([['SELECT', 'grant']]),
    }),
    '');
});

test('revoking a grantable permission carries CASCADE, because it must', () => {
  // `REVOKE SELECT …` on a permission the principal may pass on is Msg 4611,
  // "To revoke or deny grantable privileges, specify the CASCADE option" —
  // measured against SQL Server 2022, not read. There is no form that avoids it.
  const sql = mssqlGrantDiffSql({
    principal: 'u', database: 'd', scope: { kind: 'schema', schema: 's' },
    desired: new Map(), current: m([['SELECT', 'grant-with-option']]),
  });
  assert.match(sql, /REVOKE SELECT ON SCHEMA::\[s\] FROM \[u\] CASCADE;/);
  // And it says what CASCADE additionally does, since that reaches principals
  // the person clicking never named.
  assert.match(sql, /-- CASCADE is required here \(Msg 4611\)/);
  assert.match(sql, /revokes these permissions/);
});

test('CASCADE is confined to the permissions that need it', () => {
  // Applying it to everything would revoke onward grants that were never
  // involved, so a mixed change becomes two REVOKEs, not one.
  const sql = mssqlGrantDiffSql({
    principal: 'u', database: 'd', scope: { kind: 'schema', schema: 's' },
    desired: new Map(),
    current: m([['SELECT', 'grant'], ['EXECUTE', 'grant-with-option']]),
  });
  const plain = sql.split('\n').find(l => l.startsWith('REVOKE') && !l.includes('CASCADE'));
  const cascade = sql.split('\n').find(l => l.includes('CASCADE;'));
  assert.equal(plain, 'REVOKE SELECT ON SCHEMA::[s] FROM [u];');
  assert.equal(cascade, 'REVOKE EXECUTE ON SCHEMA::[s] FROM [u] CASCADE;');
});

test('a plain GRANT does not take the grant option away, so a REVOKE precedes it', () => {
  // Verified live: after `GRANT EXECUTE …` the catalog still reported
  // GRANT_WITH_GRANT_OPTION. The downgrade needs the revoke.
  const sql = mssqlGrantDiffSql({
    principal: 'u', database: 'd', scope: { kind: 'schema', schema: 's' },
    desired: m([['EXECUTE', 'grant']]), current: m([['EXECUTE', 'grant-with-option']]),
  });
  const lines = sql.split('\n').filter(l => !l.startsWith('--'));
  assert.match(lines[0], /^REVOKE EXECUTE .* CASCADE;$/);
  assert.equal(lines[1], 'GRANT EXECUTE ON SCHEMA::[s] TO [u];');
});

test('permissions are emitted in a stable order, not in Set order', () => {
  const sql = mssqlGrantDiffSql({
    principal: 'u', database: 'd', scope: { kind: 'database' },
    desired: m([['DELETE', 'grant'], ['SELECT', 'grant'], ['INSERT', 'grant']]),
    current: new Map(),
  });
  assert.match(sql, /GRANT SELECT, INSERT, DELETE ON/);
});

test('EXECUTE is offered where it means something', () => {
  // A table takes the data permissions; a routine takes EXECUTE. Both are
  // OBJECT scope, so the union is offered there.
  assert.ok(MSSQL_PERMISSIONS_BY_SCOPE.schema.includes('EXECUTE'));
  assert.ok(MSSQL_PERMISSIONS_BY_SCOPE.object.includes('EXECUTE'));
  // VIEW CHANGE TRACKING is not a database-level permission.
  assert.ok(!MSSQL_PERMISSIONS_BY_SCOPE.database.includes('VIEW CHANGE TRACKING'));
  // Every listed permission is a real column.
  for (const scope of Object.values(MSSQL_PERMISSIONS_BY_SCOPE)) {
    for (const p of scope) assert.ok(MSSQL_PERMISSIONS.includes(p), p);
  }
});

// ── principals ───────────────────────────────────────────────────────────────

test('a user with no login is reported as orphaned, and a role never is', () => {
  // The live server's rows, after DROP LOGIN left the user behind.
  const orphan = mssqlPrincipalFromRow(
    ['txui_orph', 'SQL_USER', '', 'dbo', 0, '2026-08-28 20:47:00', '']);
  assert.equal(orphan.orphaned, true);
  assert.equal(orphan.isRole, false);

  const role = mssqlPrincipalFromRow(
    ['txui_readers', 'DATABASE_ROLE', '', '', 0, '2026-08-28 20:45:51', '']);
  // A role has no login by definition — flagging it would warn about every one.
  assert.equal(role.orphaned, false);
  assert.equal(role.isRole, true);

  const ok = mssqlPrincipalFromRow(
    ['txui_app', 'SQL_USER', 'txui_app', 'sales', 0, '2026-08-28 20:45:51', 'db_datareader']);
  assert.equal(ok.orphaned, false);
  assert.deepEqual(ok.roles, ['db_datareader']);
});

test('a Windows user without a readable login is not called orphaned', () => {
  // A domain principal can legitimately have no row this query can see; saying
  // "orphaned" there sends someone fixing something that is not broken.
  const win = mssqlPrincipalFromRow(
    ['DOMAIN\\alice', 'WINDOWS_USER', '', 'dbo', 0, '', '']);
  assert.equal(win.orphaned, false);
});

test('role memberships come back as a list, not a string', () => {
  const p = mssqlPrincipalFromRow(['u', 'SQL_USER', 'u', 'dbo', 0, '', 'db_datareader, db_ddladmin']);
  assert.deepEqual(p.roles, ['db_datareader', 'db_ddladmin']);
  assert.deepEqual(mssqlPrincipalFromRow(['u', 'SQL_USER', 'u', 'dbo', 0, '', '']).roles, []);
});

test('the principal query skips the four built-ins and the fixed roles', () => {
  // dbo, guest, INFORMATION_SCHEMA and sys exist in every database and are not
  // accounts anyone administers; db_owner is not something you edit.
  assert.match(MSSQL_PRINCIPALS_SQL, /principal_id > 4/);
  assert.match(MSSQL_PRINCIPALS_SQL, /is_fixed_role = 0/);
  // The join that finds orphans is on SID, not on name.
  assert.match(MSSQL_PRINCIPALS_SQL, /LEFT JOIN sys\.server_principals sp ON sp\.sid = dp\.sid/);
});

test('the permission query escapes the principal name', () => {
  assert.match(mssqlPermissionsSql("it's"), /DATABASE_PRINCIPAL_ID\('it''s'\)/);
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test('a login and a user are two statements, in the order that works', () => {
  assert.equal(
    mssqlCreateUserSql({
      name: 'txui_app', login: 'txui_app', password: 'App_Passw0rd!',
      defaultSchema: 'sales', roles: ['db_datareader'],
    }),
    'CREATE LOGIN [txui_app] WITH PASSWORD = \'App_Passw0rd!\';\n'
    + 'CREATE USER [txui_app] FOR LOGIN [txui_app] WITH DEFAULT_SCHEMA = [sales];\n'
    + 'ALTER ROLE [db_datareader] ADD MEMBER [txui_app];');
});

test('a user for an EXISTING login creates no login', () => {
  assert.equal(
    mssqlCreateUserSql({ name: 'u', login: 'existing_login' }),
    'CREATE USER [u] FOR LOGIN [existing_login];');
});

test('a contained user carries the password itself, with no login', () => {
  assert.equal(
    mssqlCreateUserSql({ name: 'c', password: 'Cont_Passw0rd!' }),
    "CREATE USER [c] WITH PASSWORD = 'Cont_Passw0rd!';");
});

test('CHECK_POLICY is left at its default, not turned off to make a password fit', () => {
  const sql = mssqlCreateUserSql({ name: 'u', login: 'u', password: 'weak' });
  assert.ok(!sql.includes('CHECK_POLICY'), sql);
});

test('a password is escaped as a literal, never concatenated', () => {
  assert.match(
    mssqlCreateUserSql({ name: 'u', login: 'u', password: "it's; DROP DATABASE x--" }),
    /PASSWORD = 'it''s; DROP DATABASE x--'/);
});

test('dropping a user leaves the login alone, and says why', () => {
  const sql = mssqlDropSql({ name: 'txui_app', isRole: false, login: 'txui_app' });
  assert.match(sql, /^DROP USER IF EXISTS \[txui_app\];/);
  // The login may map users in other databases — dropping it would cut access
  // nobody asked to touch, so it is offered as a comment, not a statement.
  assert.match(sql, /-- DROP LOGIN \[txui_app\];/);
  assert.equal(sql.split('\n').filter(l => !l.startsWith('--')).length, 1);
});

test('dropping a role has no login to mention', () => {
  assert.equal(
    mssqlDropSql({ name: 'r', isRole: true, login: '' }),
    'DROP ROLE IF EXISTS [r];');
});

test('role membership uses ALTER ROLE, not the deprecated procedure', () => {
  assert.equal(mssqlRoleMemberSql('r', 'u', true), 'ALTER ROLE [r] ADD MEMBER [u];');
  assert.equal(mssqlRoleMemberSql('r', 'u', false), 'ALTER ROLE [r] DROP MEMBER [u];');
  assert.ok(!mssqlRoleMemberSql('r', 'u', true).includes('sp_addrolemember'));
});

test('an orphan is reconnected with ALTER USER, which works on contained DBs too', () => {
  assert.equal(mssqlFixOrphanSql('u', 'l'), 'ALTER USER [u] WITH LOGIN = [l];');
  assert.ok(!mssqlFixOrphanSql('u', 'l').includes('sp_change_users_login'));
});

test('the scope key and the label agree about what a scope is', () => {
  const scopes = [
    { kind: 'database' as const },
    { kind: 'schema' as const, schema: 'sales' },
    { kind: 'object' as const, schema: 'sales', name: 'orders' },
  ];
  const keys = scopes.map(mssqlScopeKey);
  assert.deepEqual(keys, ['DATABASE', 'SCHEMA::sales', 'OBJECT::sales.orders']);
  assert.equal(new Set(keys).size, 3);
  assert.match(mssqlScopeLabel(scopes[0], 'txui_demo'), /txui_demo/);
  assert.equal(mssqlScopeLabel(scopes[2], 'db'), 'sales.orders');
});
