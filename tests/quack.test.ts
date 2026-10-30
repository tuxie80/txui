import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuackUri, parseQuackUri, quackPathError,
} from '../src/utils/quack.ts';
import {
  parseConnectionUrl, buildConnectionUrl, configToConnectionUrl,
} from '../src/utils/connUrl.ts';

test('Quack accepts official URI forms and defaults the port in DuckDB, not the parser', () => {
  for (const raw of ['quack:localhost', 'quack://localhost', ' QUACK:localhost ']) {
    const p = parseQuackUri(raw);
    assert.ok(p, raw);
    assert.equal(p.endpoint, 'quack://localhost');
    assert.equal(p.host, 'localhost');
    assert.equal(p.port, null);
    assert.equal(p.password, null);
  }
  const p = parseQuackUri('quack:[::1]:9999');
  assert.equal(p?.host, '::1');
  assert.equal(p?.port, 9999);
  assert.equal(p?.endpoint, 'quack://[::1]:9999');
  assert.ok(isQuackUri('quack:localhost'));
  assert.ok(!isQuackUri('/tmp/quack.db'));
});

test('Quack userinfo token is separated from the endpoint and secret-free URL output', () => {
  const p = parseQuackUri('quack://:s3cr%27et@localhost:9494');
  assert.ok(p);
  assert.equal(p.password, "s3cr'et");
  assert.equal(p.endpoint, 'quack://localhost:9494');
  assert.ok(!p.endpoint.includes(p.password));

  const parsed = parseConnectionUrl('quack://:s3cr%27et@localhost:9494');
  assert.ok(parsed.ok);
  assert.equal(parsed.engine, 'duckdb');
  assert.equal(parsed.password, "s3cr'et");
  assert.equal(parsed.filePath, 'quack://localhost:9494');
  assert.ok(!JSON.stringify(parsed.filePath).includes(parsed.password));

  const shared = configToConnectionUrl({
    engine: 'duckdb', file_path: parsed.filePath,
  });
  assert.equal(shared, 'quack://localhost:9494');
  assert.ok(!shared.includes("s3cr'et"));
  assert.equal(buildConnectionUrl({ engine: 'duckdb', filePath: parsed.filePath }), shared);
});

test('Quack rejects embedded credentials, queries, fragments and invalid endpoints without echoing secrets', () => {
  for (const bad of [
    'quack:',
    'quack://user:secret@localhost',
    'quack://user@localhost',
    'quack:localhost?token=secret',
    'quack:localhost#secret',
    'quack:local host',
  ]) {
    assert.equal(parseQuackUri(bad), null, bad);
    assert.ok(quackPathError(bad));
    const parsed = parseConnectionUrl(bad);
    assert.equal(parsed.ok, false, bad);
    if (!parsed.ok) assert.ok(!parsed.error.includes('secret'), parsed.error);
  }
  assert.equal(quackPathError('quack:localhost'), null);
});

test('Copy-as-URL supports Quack but still has no local DuckDB file URL', () => {
  assert.equal(configToConnectionUrl({ engine: 'duckdb', file_path: '/tmp/a.duckdb' }), null);
  assert.equal(configToConnectionUrl({ engine: 'duckdb', file_path: ':memory:' }), null);
  assert.equal(configToConnectionUrl({ engine: 'duckdb', file_path: 'quack:remote.example' }),
    'quack://remote.example');
});
