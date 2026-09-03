/**
 * Connection URL parsing (src/utils/connUrl.ts).
 * The bug this prevents: the form's paste handler silently dropped every
 * query param, so `postgres://u@h/db?sslmode=require` connected without SSL.
 * Known params must land on structured fields, unknown ones in extraParams
 * with a warning — nothing may be lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionUrl, buildConnectionUrl } from '../src/utils/connUrl.ts';
import type { ParsedConnectionUrlOk } from '../src/utils/connUrl.ts';

function ok(url: string): ParsedConnectionUrlOk {
  const r = parseConnectionUrl(url);
  assert.equal(r.ok, true, `expected ok for ${url}: ${r.ok === false ? r.error : ''}`);
  return r as ParsedConnectionUrlOk;
}

test('every supported scheme maps to its engine', () => {
  for (const scheme of ['mysql', 'mariadb']) {
    assert.equal(ok(`${scheme}://u@h/db`).engine, 'mysql');
  }
  for (const scheme of ['postgres', 'postgresql']) {
    assert.equal(ok(`${scheme}://u@h/db`).engine, 'postgres');
  }
  for (const scheme of ['redis', 'rediss']) {
    assert.equal(ok(`${scheme}://h`).engine, 'redis');
  }
  for (const scheme of ['mongodb', 'mongodb+srv']) {
    assert.equal(ok(`${scheme}://u@h/db`).engine, 'mongodb');
  }
});

test('rediss:// implies TLS (sslMode require)', () => {
  assert.equal(ok('rediss://h:6380/0').sslMode, 'require');
  assert.equal(ok('redis://h:6379/0').sslMode, null);
});

test('host, port, user, password, database are extracted', () => {
  const r = ok('mysql://root:s3cret@db.internal:3307/shop');
  assert.equal(r.host, 'db.internal');
  assert.equal(r.port, 3307);
  assert.equal(r.user, 'root');
  assert.equal(r.password, 's3cret');
  assert.equal(r.database, 'shop');
});

test('percent-encoded user/password/database are decoded', () => {
  const r = ok('postgres://user%40corp:p%40ss%2Fword@h/my%20db');
  assert.equal(r.user, 'user@corp');
  assert.equal(r.password, 'p@ss/word');
  assert.equal(r.database, 'my db');
});

test('missing pieces come back null, not undefined', () => {
  const r = ok('mysql://h');
  assert.equal(r.user, null);
  assert.equal(r.password, null);
  assert.equal(r.port, null);
  assert.equal(r.database, null);
  assert.equal(r.socketPath, null);
  assert.equal(r.redisDb, null);
  assert.deepEqual(r.extraParams, {});
  assert.deepEqual(r.warnings, []);
});

test('IPv6 host: brackets are stripped', () => {
  const r = ok('postgres://u@[::1]:5433/db');
  assert.equal(r.host, '::1');
  assert.equal(r.port, 5433);
});

test('MySQL ssl-mode spellings map onto app SslMode values', () => {
  const cases: Array<[string, string]> = [
    ['disable', 'disable'], ['disabled', 'disable'],
    ['preferred', 'preferred'], ['prefer', 'preferred'],
    ['required', 'require'], ['require', 'require'],
    ['verify_ca', 'verify_ca'],
    ['verify_identity', 'verify_full'], ['verify_full', 'verify_full'],
  ];
  for (const [val, expected] of cases) {
    assert.equal(ok(`mysql://u@h/db?ssl-mode=${val}`).sslMode, expected, `ssl-mode=${val}`);
    // also accepted as `sslmode`, case-insensitively
    assert.equal(ok(`mysql://u@h/db?SSLMODE=${val.toUpperCase()}`).sslMode, expected);
  }
});

test('PostgreSQL libpq sslmode spellings map onto app SslMode values', () => {
  const cases: Array<[string, string]> = [
    ['disable', 'disable'], ['prefer', 'preferred'], ['require', 'require'],
    ['verify-ca', 'verify_ca'], ['verify-full', 'verify_full'],
  ];
  for (const [val, expected] of cases) {
    assert.equal(ok(`postgres://u@h/db?sslmode=${val}`).sslMode, expected, `sslmode=${val}`);
  }
});

test('unknown sslmode value → warning + kept in extraParams, sslMode stays null', () => {
  const r = ok('postgres://u@h/db?sslmode=allow');
  assert.equal(r.sslMode, null);
  assert.equal(r.extraParams['sslmode'], 'allow');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /sslmode/);
});

test('connect timeout: all MySQL spellings, libpq spelling, integer seconds', () => {
  for (const key of ['connect-timeout', 'connect_timeout', 'timeout']) {
    assert.equal(ok(`mysql://u@h/db?${key}=10`).connectTimeoutSecs, 10, key);
  }
  assert.equal(ok('postgres://u@h/db?connect_timeout=5').connectTimeoutSecs, 5);
});

test('invalid connect timeout → warning + extraParams, field stays null', () => {
  for (const bad of ['abc', '3.5', '-1', '0']) {
    const r = ok(`mysql://u@h/db?connect-timeout=${bad}`);
    assert.equal(r.connectTimeoutSecs, null, `value ${bad}`);
    assert.equal(r.extraParams['connect-timeout'], bad);
    assert.equal(r.warnings.length, 1);
  }
});

test('MySQL known params: charset/collation → extraParams, program_name → applicationName', () => {
  const r = ok('mysql://u@h/db?charset=utf8mb4&collation=utf8mb4_bin&program_name=txui');
  assert.deepEqual(r.extraParams, { charset: 'utf8mb4', collation: 'utf8mb4_bin' });
  assert.equal(r.applicationName, 'txui');
  assert.deepEqual(r.warnings, []);
});

test('MySQL socket params → socketPath', () => {
  assert.equal(ok('mysql://u@localhost/db?socket=/tmp/mysql.sock').socketPath, '/tmp/mysql.sock');
  assert.equal(ok('mariadb://u@localhost/db?unix_socket=/var/run/mysqld.sock').socketPath, '/var/run/mysqld.sock');
});

test('PostgreSQL host param starting with / is a socket directory', () => {
  const r = ok('postgres://u@/db?host=/var/run/postgresql');
  assert.equal(r.socketPath, '/var/run/postgresql');
  assert.equal(r.host, null);
});

test('libpq percent-encoded socket dir in the host slot → socketPath', () => {
  const r = ok('postgres://u@%2Fvar%2Frun%2Fpostgresql/db');
  assert.equal(r.socketPath, '/var/run/postgresql');
  assert.equal(r.host, null);
  assert.equal(r.user, 'u');
  assert.equal(r.database, 'db');
});

test('PostgreSQL known passthrough params → extraParams without warnings', () => {
  const r = ok('postgres://u@h/db?options=-c%20jit%3Doff&statement_timeout=5000&search_path=app&lock_timeout=1000&application_name=txui');
  assert.deepEqual(r.extraParams, {
    options: '-c jit=off', statement_timeout: '5000', search_path: 'app', lock_timeout: '1000',
  });
  assert.equal(r.applicationName, 'txui');
  assert.deepEqual(r.warnings, []);
});

test('unknown params land in extraParams AND produce a warning — never dropped', () => {
  const r = ok('mysql://u@h/db?fancy_flag=1&other=x%20y');
  assert.deepEqual(r.extraParams, { fancy_flag: '1', other: 'x y' });
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /fancy_flag/);
});

test('plus in query values stays a literal plus', () => {
  const r = ok('postgres://u@h/db?application_name=a+b');
  assert.equal(r.applicationName, 'a+b');
});

test('redis numeric path is the db index', () => {
  const r = ok('redis://:pw@h:6379/2');
  assert.equal(r.redisDb, 2);
  assert.equal(r.database, null);
  assert.equal(r.password, 'pw');
});

test('redis non-numeric path → database name with a warning', () => {
  const r = ok('redis://h/cache');
  assert.equal(r.redisDb, null);
  assert.equal(r.database, 'cache');
  assert.equal(r.warnings.length, 1);
});

test('bad input never throws: garbage, bad scheme, bad port all return ok:false', () => {
  for (const bad of [
    '',
    '   ',
    'not a url at all',
    'mysql://u@h:abc/db',      // non-numeric port
    'mysql://u@h:99999/db',    // port out of range
    'http://u@h/db',           // unsupported scheme
    'sqlite:///tmp/x.db',
    '://nope',
  ]) {
    const r = parseConnectionUrl(bad);
    assert.equal(r.ok, false, `expected ok:false for ${JSON.stringify(bad)}`);
    if (!r.ok) assert.equal(typeof r.error, 'string');
  }
});

test('buildConnectionUrl round-trips through parseConnectionUrl', () => {
  const src = ok('postgres://u@h:5433/db?sslmode=verify-full&connect_timeout=5&application_name=txui&search_path=app');
  const rebuilt = ok(buildConnectionUrl({
    engine: src.engine, host: src.host, port: src.port, user: src.user,
    database: src.database, sslMode: src.sslMode,
    connectTimeoutSecs: src.connectTimeoutSecs, applicationName: src.applicationName,
    extraParams: src.extraParams,
  }));
  assert.equal(rebuilt.sslMode, 'verify_full');
  assert.equal(rebuilt.connectTimeoutSecs, 5);
  assert.equal(rebuilt.applicationName, 'txui');
  assert.deepEqual(rebuilt.extraParams, { search_path: 'app' });
  assert.deepEqual(rebuilt.warnings, []);
});

test('buildConnectionUrl: password is never emitted', () => {
  const url = buildConnectionUrl({ engine: 'mysql', host: 'h', user: 'root', database: 'db' });
  assert.equal(url.includes('@'), true);  // userinfo present
  assert.ok(!url.includes(':s3cret'));
  assert.equal(url, 'mysql://root@h/db');
});

test('buildConnectionUrl: rediss for TLS redis, IPv6 brackets, socket paths', () => {
  assert.equal(
    buildConnectionUrl({ engine: 'redis', host: 'h', port: 6380, redisDb: 2, sslMode: 'require' }),
    'rediss://h:6380/2',
  );
  assert.equal(
    buildConnectionUrl({ engine: 'postgres', host: '::1', port: 5432, user: 'u' }),
    'postgres://u@[::1]:5432',
  );
  // PG socket dir → host query param, empty authority host
  const pgSock = ok(buildConnectionUrl({ engine: 'postgres', user: 'u', database: 'db', socketPath: '/var/run/postgresql' }));
  assert.equal(pgSock.socketPath, '/var/run/postgresql');
  // MySQL socket → socket param
  const mySock = ok(buildConnectionUrl({ engine: 'mysql', user: 'u', database: 'db', socketPath: '/tmp/mysql.sock' }));
  assert.equal(mySock.socketPath, '/tmp/mysql.sock');
});

// ── ClickHouse ───────────────────────────────────────────────────────────────

test('clickhouse: scheme spellings, TLS, and readonly', () => {
  const plain = ok('clickhouse://dolphie@10.57.0.30:8123/dolphie');
  assert.equal(plain.engine, 'clickhouse');
  assert.equal(plain.host, '10.57.0.30');
  assert.equal(plain.port, 8123);
  assert.equal(plain.user, 'dolphie');
  assert.equal(plain.database, 'dolphie');
  assert.equal(plain.sslMode, null);
  assert.equal(plain.readOnly, false);
  assert.deepEqual(plain.warnings, []);

  // Both TLS spellings imply require.
  assert.equal(ok('clickhouses://h:8443/db').sslMode, 'require');
  assert.equal(ok('clickhouse+https://h:8443/db').sslMode, 'require');
  // …as does clickhouse-driver's secure=1.
  assert.equal(ok('clickhouse://h:8123/db?secure=1').sslMode, 'require');

  // readonly=1 and =2 are both read-only postures server-side.
  assert.equal(ok('clickhouse://h/db?readonly=1').readOnly, true);
  assert.equal(ok('clickhouse://h/db?readonly=2').readOnly, true);
  assert.equal(ok('clickhouse://h/db?readonly=0').readOnly, false);
});

test('clickhouse: native-protocol ports are flagged, not silently accepted', () => {
  // The driver speaks HTTP only. Pasting the native port would otherwise fail
  // with an opaque protocol error at connect time.
  for (const port of [9000, 9440]) {
    const p = ok(`clickhouse://u@h:${port}/db`);
    assert.equal(p.port, port);
    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0], /native protocol/);
    assert.match(p.warnings[0], /8123/);
  }
  // 8123 and 8443 are the HTTP ports — no warning.
  assert.deepEqual(ok('clickhouse://u@h:8443/db').warnings, []);
});

test('clickhouse: unknown params are session settings, kept without a warning', () => {
  // Unlike MySQL/PG, any query param is a legitimate ClickHouse setting.
  const p = ok('clickhouse://h/db?max_threads=4&max_memory_usage=1000000');
  assert.deepEqual(p.extraParams, { max_threads: '4', max_memory_usage: '1000000' });
  assert.deepEqual(p.warnings, []);
});

test('clickhouse: build → parse round-trip keeps ssl, readonly and settings', () => {
  const url = buildConnectionUrl({
    engine: 'clickhouse', host: 'ch.example', port: 8443, user: 'ro',
    database: 'dolphie', sslMode: 'require', readOnly: true,
    extraParams: { max_threads: '2' },
  });
  assert.ok(url.startsWith('clickhouses://'), url);
  assert.ok(!url.includes('readonly=1&readonly'), url);
  const back = ok(url);
  assert.equal(back.engine, 'clickhouse');
  assert.equal(back.host, 'ch.example');
  assert.equal(back.port, 8443);
  assert.equal(back.user, 'ro');
  assert.equal(back.database, 'dolphie');
  assert.equal(back.sslMode, 'require');
  assert.equal(back.readOnly, true);
  assert.deepEqual(back.extraParams, { max_threads: '2' });
  assert.deepEqual(back.warnings, []);
});

test('mongodb+srv implies TLS and carries no port', () => {
  const p = ok('mongodb+srv://u@cluster0.example.net/appdb');
  assert.equal(p.engine, 'mongodb');
  assert.equal(p.sslMode, 'require');
  assert.equal(p.port, null);
  assert.equal(p.database, 'appdb');
});

test('mongodb: tls/ssl params, connectTimeoutMS, appName, authSource', () => {
  const p = ok('mongodb://root@db.internal:27017/admin?tls=true&connectTimeoutMS=3000&appName=etl&authSource=admin');
  assert.equal(p.sslMode, 'require');
  assert.equal(p.connectTimeoutSecs, 3); // ms → seconds
  assert.equal(p.applicationName, 'etl');
  // Kept under the canonical camelCase spelling the backend's URI builder
  // allowlist matches — the param key was lowercased for parsing only.
  assert.equal(p.extraParams['authSource'], 'admin');
  assert.equal(p.warnings.length, 0);
  const off = ok('mongodb://h/?tls=false');
  assert.equal(off.sslMode, 'disable');
});

test('mongodb: unknown params are kept with a warning — never dropped', () => {
  const p = ok('mongodb://h/?w=majority');
  assert.equal(p.extraParams['w'], 'majority');
  assert.ok(p.warnings.some(w => w.includes('w')), p.warnings.join(';'));
});

test('mongodb: build → parse round-trip keeps tls, timeout and appName', () => {
  const url = buildConnectionUrl({
    engine: 'mongodb', host: 'db.internal', port: 27017, user: 'root',
    database: 'admin', sslMode: 'require', connectTimeoutSecs: 5,
    applicationName: 'TxUI', extraParams: { authSource: 'admin' },
  });
  assert.ok(url.startsWith('mongodb://'), url);
  const back = ok(url);
  assert.equal(back.engine, 'mongodb');
  assert.equal(back.host, 'db.internal');
  assert.equal(back.port, 27017);
  assert.equal(back.sslMode, 'require');
  assert.equal(back.connectTimeoutSecs, 5);
  assert.equal(back.applicationName, 'TxUI');
  assert.equal(back.extraParams['authSource'], 'admin');
});

// ── SQL Server ───────────────────────────────────────────────────────────────

test('sqlserver + mssql schemes parse as the sqlserver engine', () => {
  assert.equal(ok('sqlserver://sa@db.internal/app').engine, 'sqlserver');
  assert.equal(ok('mssql://sa@db.internal:14330/app').engine, 'sqlserver');
  const p = ok('sqlserver://sa:s3cret@db.internal:14330/app');
  assert.equal(p.host, 'db.internal');
  assert.equal(p.port, 14330);
  assert.equal(p.user, 'sa');
  assert.equal(p.password, 's3cret');
  assert.equal(p.database, 'app');
});

test('sqlserver: encrypt spellings map onto SslMode', () => {
  assert.equal(ok('sqlserver://u@h/db?encrypt=false').sslMode, 'disable');
  assert.equal(ok('sqlserver://u@h/db?encrypt=true').sslMode, 'require');
  assert.equal(ok('sqlserver://u@h/db?encrypt=strict').sslMode, 'verify_full');
  const bad = ok('sqlserver://u@h/db?encrypt=maybe');
  assert.equal(bad.sslMode, null);
  assert.equal(bad.extraParams['encrypt'], 'maybe');
  assert.equal(bad.warnings.length, 1);
});

test('sqlserver: trustServerCertificate=true warns instead of being honoured', () => {
  // No opt-in exists in ConnectionConfig — silently accepting the flag would
  // be a security posture the user never actually got.
  const p = ok('sqlserver://u@h/db?encrypt=true&trustServerCertificate=true');
  assert.equal(p.sslMode, 'require');
  assert.ok(p.warnings.some(w => w.includes('trustServerCertificate')), p.warnings.join(';'));
  // trustServerCertificate=false is just the default — no warning.
  assert.deepEqual(ok('sqlserver://u@h/db?trustServerCertificate=false').warnings, []);
});

test('sqlserver: host\\instance and instanceName are noted, not parsed silently', () => {
  const p = ok('sqlserver://sa@db01\\SQLEXPRESS/app');
  assert.equal(p.host, 'db01');
  assert.ok(p.warnings.some(w => w.includes('SQLEXPRESS') && w.includes('not supported')),
    p.warnings.join(';'));
  const q = ok('sqlserver://sa@db01/app?instanceName=SQLEXPRESS');
  assert.ok(q.warnings.some(w => w.includes('SQLEXPRESS')), q.warnings.join(';'));
});

test('sqlserver: connection timeout in seconds', () => {
  for (const key of ['connection timeout', 'connectTimeout', 'timeout']) {
    assert.equal(ok(`sqlserver://u@h/db?${key}=15`).connectTimeoutSecs, 15, key);
  }
});

test('sqlserver: build → parse round-trip keeps encrypt and timeout', () => {
  const url = buildConnectionUrl({
    engine: 'sqlserver', host: 'db.internal', port: 1433, user: 'sa',
    database: 'app', sslMode: 'require', connectTimeoutSecs: 10,
  });
  assert.ok(url.startsWith('sqlserver://'), url);
  const back = ok(url);
  assert.equal(back.engine, 'sqlserver');
  assert.equal(back.sslMode, 'require');
  assert.equal(back.connectTimeoutSecs, 10);
  assert.deepEqual(back.warnings, []);
  // The strict form round-trips too.
  const strict = ok(buildConnectionUrl({ engine: 'sqlserver', host: 'h', sslMode: 'verify_full' }));
  assert.equal(strict.sslMode, 'verify_full');
});
