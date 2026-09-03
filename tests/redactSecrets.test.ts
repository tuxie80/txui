import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactCommandLine } from '../src/utils/redactSecrets.ts';

test('IDENTIFIED BY is redacted', () => {
  assert.equal(
    redactSecrets("CREATE USER 'u'@'%' IDENTIFIED BY 's3cret'"),
    "CREATE USER 'u'@'%' IDENTIFIED BY ****",
  );
  assert.equal(
    redactSecrets("ALTER USER 'u'@'localhost' IDENTIFIED BY \"s3cret\""),
    "ALTER USER 'u'@'localhost' IDENTIFIED BY ****",
  );
});

test('IDENTIFIED WITH plugin BY / AS is redacted', () => {
  assert.equal(
    redactSecrets("CREATE USER 'u'@'%' IDENTIFIED WITH mysql_native_password BY 's3cret'"),
    "CREATE USER 'u'@'%' IDENTIFIED WITH mysql_native_password BY ****",
  );
  assert.equal(
    redactSecrets("CREATE USER 'u'@'%' IDENTIFIED WITH caching_sha2_password AS '*HASH'"),
    "CREATE USER 'u'@'%' IDENTIFIED WITH caching_sha2_password AS ****",
  );
});

test('*PASSWORD = value is redacted (PASSWORD, SOURCE_PASSWORD, MASTER_PASSWORD)', () => {
  assert.equal(redactSecrets("SET PASSWORD = 's3cret'"), 'SET PASSWORD = ****');
  assert.equal(
    redactSecrets("CHANGE REPLICATION SOURCE TO SOURCE_PASSWORD = 's3cret', SOURCE_HOST = 'h'"),
    "CHANGE REPLICATION SOURCE TO SOURCE_PASSWORD = ****, SOURCE_HOST = 'h'",
  );
  assert.equal(
    redactSecrets("CHANGE MASTER TO MASTER_PASSWORD='s3cret'"),
    'CHANGE MASTER TO MASTER_PASSWORD= ****',
  );
});

test('PASSWORD() function argument is redacted', () => {
  assert.equal(redactSecrets("SELECT PASSWORD('s3cret')"), 'SELECT PASSWORD(****)');
  assert.equal(redactSecrets(`SELECT PASSWORD("s3cret")`), 'SELECT PASSWORD(****)');
});

test('escaped and doubled quotes inside secrets are consumed whole', () => {
  assert.equal(
    redactSecrets(String.raw`SET PASSWORD = 'it\'s'`), 'SET PASSWORD = ****',
  );
  assert.equal(
    redactSecrets("SET PASSWORD = 'it''s'"), 'SET PASSWORD = ****',
  );
});

test('case-insensitive', () => {
  assert.equal(redactSecrets("set password = 'x'"), 'set password = ****');
  assert.equal(redactSecrets("create user u identified by 'x'"), 'create user u identified by ****');
});

// ── negatives: ordinary SQL and string literals stay untouched ──

test('string literals that merely mention the keywords are untouched', () => {
  assert.equal(redactSecrets("SELECT 'password = x'"), "SELECT 'password = x'");
  assert.equal(redactSecrets("WHERE name = 'IDENTIFIED BY'"), "WHERE name = 'IDENTIFIED BY'");
  assert.equal(
    redactSecrets("SELECT * FROM t WHERE note = 'set password = abc'"),
    "SELECT * FROM t WHERE note = 'set password = abc'",
  );
});

test('ordinary SQL is untouched', () => {
  const sql = 'SELECT id, name FROM users WHERE id = 42 ORDER BY name';
  assert.equal(redactSecrets(sql), sql);
  assert.equal(
    redactSecrets('UPDATE t SET a = 1 WHERE id IN (SELECT id FROM s)'),
    'UPDATE t SET a = 1 WHERE id IN (SELECT id FROM s)',
  );
});

test('lookalikes are not redacted', () => {
  // not `*password = <quoted>` — no quoted value directly after `=`
  assert.equal(redactSecrets('SELECT password FROM t'), 'SELECT password FROM t');
  assert.equal(redactSecrets('UPDATE t SET passwords = 3'), 'UPDATE t SET passwords = 3');
  // IDENTIFIED without BY/AS + quoted value
  assert.equal(redactSecrets("SELECT 'x' AS identified_by"), "SELECT 'x' AS identified_by");
});

// ── command lines ───────────────────────────────────────────────────────────

test('a password typed into the dump panel’s extra-args field never reaches a log', () => {
  // TxUI passes credentials via MYSQL_PWD/PGPASSWORD and never in argv — but
  // the extra-args box is free text, and the audit log is what people paste
  // into tickets.
  assert.match(redactCommandLine('mysqldump --host db --password=hunter2 shop'), /--password=\*\*\*\*/);
  assert.doesNotMatch(redactCommandLine('mysqldump --password=hunter2'), /hunter2/);
  assert.doesNotMatch(redactCommandLine('mysqldump --password hunter2'), /hunter2/);
  assert.doesNotMatch(redactCommandLine('mysql -phunter2 shop'), /hunter2/);
  assert.doesNotMatch(redactCommandLine('PGPASSWORD=hunter2 pg_dump shop'), /hunter2/);
  assert.doesNotMatch(redactCommandLine('psql postgres://app:hunter2@db:5432/shop'), /hunter2/);
});

test('redaction does not eat the rest of the command', () => {
  const out = redactCommandLine('mysqldump --host db --password=x --single-transaction shop');
  assert.match(out, /--host db/);
  assert.match(out, /--single-transaction shop/);
});

test('a bare -p (which prompts) is left alone', () => {
  assert.equal(redactCommandLine('mysql -p shop'), 'mysql -p shop');
});
