/**
 * User / role lifecycle builders (src/utils/privileges.ts, lifecycle section).
 *
 * These generate the CREATE / ALTER / DROP that the 👤 Users & grants panel
 * inserts into the editor — review-only, never executed. The things that have
 * to hold: the engine split (MySQL names an account `'u'@'host'` as string
 * literals and carries auth-plugin / REQUIRE / PASSWORD EXPIRE / ACCOUNT; PG
 * names a role as a quoted identifier and toggles LOGIN/SUPERUSER/… plus VALID
 * UNTIL / CONNECTION LIMIT), correct identifier-vs-literal quoting, ALTER
 * emitting only the fields it is given (an untouched box is not a reset), and
 * IF EXISTS reaching the DROP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mysqlAccountSql, mysqlCreateUserSql, mysqlAlterUserSql, mysqlDropUserSql,
  pgCreateRoleSql, pgAlterRoleSql, pgDropRoleSql,
} from '../src/utils/privileges.ts';

// ── MySQL: account naming ────────────────────────────────────────────────────

test('a MySQL account is two string literals, host defaults to %', () => {
  assert.equal(mysqlAccountSql('app'), "'app'@'%'");
  assert.equal(mysqlAccountSql('app', '10.0.0.1'), "'app'@'10.0.0.1'");
});

test('a MySQL user / host with a quote is escaped as a literal, not an identifier', () => {
  assert.equal(mysqlAccountSql("o'brien", 'a%'), "'o''brien'@'a%'");
});

// ── MySQL: CREATE USER ───────────────────────────────────────────────────────

test('a bare CREATE USER is just the account', () => {
  assert.equal(mysqlCreateUserSql({ user: 'app' }), "CREATE USER 'app'@'%';");
});

test('CREATE USER carries password, plugin, SSL, expiry and lock in parse order', () => {
  const sql = mysqlCreateUserSql({
    user: 'app', host: 'localhost', password: 'p@ss',
    authPlugin: 'caching_sha2_password', requireSsl: true,
    maxUserConnections: 20, passwordExpire: { intervalDays: 90 }, accountLock: true,
  });
  assert.equal(
    sql,
    "CREATE USER 'app'@'localhost' IDENTIFIED WITH caching_sha2_password BY 'p@ss' " +
    "REQUIRE SSL WITH MAX_USER_CONNECTIONS 20 PASSWORD EXPIRE INTERVAL 90 DAY ACCOUNT LOCK;",
  );
});

test('CREATE USER without a plugin uses plain IDENTIFIED BY, IF NOT EXISTS is opt-in', () => {
  assert.equal(
    mysqlCreateUserSql({ user: 'app', password: 'x' }, { ifNotExists: true }),
    "CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY 'x';",
  );
});

test('CREATE USER password expire variants', () => {
  assert.match(mysqlCreateUserSql({ user: 'a', passwordExpire: 'now' }), /PASSWORD EXPIRE;/);
  assert.match(mysqlCreateUserSql({ user: 'a', passwordExpire: 'default' }), /PASSWORD EXPIRE DEFAULT;/);
  assert.match(mysqlCreateUserSql({ user: 'a', passwordExpire: 'never' }), /PASSWORD EXPIRE NEVER;/);
});

test('a MySQL password with a backslash and quote is escaped for the literal', () => {
  // sqlIdent escapes the backslash first on MySQL — see sqlIdent.ts.
  assert.equal(
    mysqlCreateUserSql({ user: 'a', password: "x\\' OR 1=1" }),
    "CREATE USER 'a'@'%' IDENTIFIED BY 'x\\\\'' OR 1=1';",
  );
});

// ── MySQL: ALTER USER ────────────────────────────────────────────────────────

test('ALTER USER changing only the password touches only that', () => {
  assert.equal(
    mysqlAlterUserSql({ user: 'app', host: 'localhost' }, { password: 'new' }),
    "ALTER USER 'app'@'localhost' IDENTIFIED BY 'new';",
  );
});

test('ALTER USER lock / unlock and expire', () => {
  assert.equal(
    mysqlAlterUserSql({ user: 'app' }, { accountLock: true }),
    "ALTER USER 'app'@'%' ACCOUNT LOCK;",
  );
  assert.equal(
    mysqlAlterUserSql({ user: 'app' }, { accountLock: false }),
    "ALTER USER 'app'@'%' ACCOUNT UNLOCK;",
  );
  assert.equal(
    mysqlAlterUserSql({ user: 'app' }, { passwordExpire: 'now' }),
    "ALTER USER 'app'@'%' PASSWORD EXPIRE;",
  );
});

test('ALTER USER REQUIRE NONE turns SSL back off', () => {
  assert.equal(
    mysqlAlterUserSql({ user: 'app' }, { requireSsl: false }),
    "ALTER USER 'app'@'%' REQUIRE NONE;",
  );
});

test('ALTER USER rename is a separate RENAME USER statement before the ALTER', () => {
  assert.equal(
    mysqlAlterUserSql(
      { user: 'old', host: '%' },
      { password: 'pw' },
      { rename: { user: 'new', host: 'localhost' } },
    ),
    "RENAME USER 'old'@'%' TO 'new'@'localhost';\n" +
    "ALTER USER 'old'@'%' IDENTIFIED BY 'pw';",
  );
});

test('an ALTER USER with nothing to change is empty', () => {
  assert.equal(mysqlAlterUserSql({ user: 'app' }, {}), '');
});

test('an empty-string password is a real (empty) password, not "leave alone"', () => {
  assert.equal(
    mysqlAlterUserSql({ user: 'app' }, { password: '' }),
    "ALTER USER 'app'@'%' IDENTIFIED BY '';",
  );
});

// ── MySQL: DROP USER ─────────────────────────────────────────────────────────

test('DROP USER, one and many, with IF EXISTS', () => {
  assert.equal(
    mysqlDropUserSql([{ user: 'app', host: 'localhost' }]),
    "DROP USER 'app'@'localhost';",
  );
  assert.equal(
    mysqlDropUserSql([{ user: 'a' }, { user: 'b', host: '10.%' }], { ifExists: true }),
    "DROP USER IF EXISTS 'a'@'%', 'b'@'10.%';",
  );
  assert.equal(mysqlDropUserSql([]), '');
});

// ── PostgreSQL: CREATE ROLE ──────────────────────────────────────────────────

test('a bare CREATE ROLE is just the quoted name', () => {
  assert.equal(pgCreateRoleSql({ name: 'app' }), 'CREATE ROLE "app";');
});

test('a mixed-case / reserved role name is quoted as an identifier', () => {
  assert.equal(pgCreateRoleSql({ name: 'Reporting' }), 'CREATE ROLE "Reporting";');
  assert.equal(pgCreateRoleSql({ name: 'user' }), 'CREATE ROLE "user";');
});

test('CREATE ROLE with login, attributes, password, validity and connection limit', () => {
  const sql = pgCreateRoleSql({
    name: 'app', login: true, superuser: false, createdb: true, createrole: false,
    inherit: true, replication: false,
    password: 's3cret', validUntil: '2027-01-01', connectionLimit: 10,
  });
  assert.equal(
    sql,
    'CREATE ROLE "app" LOGIN NOSUPERUSER CREATEDB NOCREATEROLE INHERIT NOREPLICATION ' +
    "PASSWORD 's3cret' VALID UNTIL '2027-01-01' CONNECTION LIMIT 10;",
  );
});

test('a PG password is a string literal (backslash kept literal), the name an identifier', () => {
  // standard_conforming_strings: the backslash is data, only the quote doubles.
  assert.equal(
    pgCreateRoleSql({ name: 'app', password: "a'b\\c" }),
    "CREATE ROLE \"app\" PASSWORD 'a''b\\c';",
  );
});

// ── PostgreSQL: ALTER ROLE ───────────────────────────────────────────────────

test('ALTER ROLE toggling one attribute', () => {
  assert.equal(pgAlterRoleSql({ name: 'app', login: false }), 'ALTER ROLE "app" NOLOGIN;');
  assert.equal(pgAlterRoleSql({ name: 'app', superuser: true }), 'ALTER ROLE "app" SUPERUSER;');
});

test('ALTER ROLE PASSWORD NULL removes the password, a string sets it', () => {
  assert.equal(pgAlterRoleSql({ name: 'app', password: null }), 'ALTER ROLE "app" PASSWORD NULL;');
  assert.equal(pgAlterRoleSql({ name: 'app', password: 'x' }), "ALTER ROLE \"app\" PASSWORD 'x';");
});

test('ALTER ROLE VALID UNTIL infinity clears expiry; CONNECTION LIMIT -1 is unlimited', () => {
  assert.equal(
    pgAlterRoleSql({ name: 'app', validUntil: 'infinity', connectionLimit: -1 }),
    "ALTER ROLE \"app\" VALID UNTIL 'infinity' CONNECTION LIMIT -1;",
  );
});

test('ALTER ROLE rename is its own statement before the options', () => {
  assert.equal(
    pgAlterRoleSql({ name: 'old', login: true }, { rename: 'new' }),
    'ALTER ROLE "old" RENAME TO "new";\nALTER ROLE "old" LOGIN;',
  );
});

test('an ALTER ROLE with nothing to change is empty', () => {
  assert.equal(pgAlterRoleSql({ name: 'app' }, {}), '');
});

// ── PostgreSQL: DROP ROLE ────────────────────────────────────────────────────

test('DROP ROLE, one and many, with IF EXISTS', () => {
  assert.equal(pgDropRoleSql(['app']), 'DROP ROLE "app";');
  assert.equal(
    pgDropRoleSql(['app', 'Reporting'], { ifExists: true }),
    'DROP ROLE IF EXISTS "app", "Reporting";',
  );
  assert.equal(pgDropRoleSql([]), '');
});
