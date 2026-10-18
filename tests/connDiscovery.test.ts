/**
 * Local service discovery shaping (src/utils/connDiscovery.ts, W5.3).
 *
 * The behaviour this locks in: a probed service prefills engine, 127.0.0.1
 * and port ONLY — user/database stay blank so the engine defaults remain
 * placeholders — and a service that already has a saved connection is not
 * offered again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryPrefill, discoveryName, alreadySaved } from '../src/utils/connDiscovery.ts';
import type { ConnectionConfig } from '../src/types/index.ts';

const pg = { engine: 'postgres', port: 5432, detail: 'PostgreSQL 16' } as const;

test('prefill carries engine, loopback host and port — nothing else', () => {
  const p = discoveryPrefill(pg);
  assert.equal(p.engine, 'postgres');
  assert.equal(p.host, '127.0.0.1');
  assert.equal(p.port, 5432);
  // Blank on purpose: the form's placeholders show the engine defaults.
  assert.equal(p.user, undefined);
  assert.equal(p.database, undefined);
});

test('the suggested name says what and where', () => {
  assert.equal(discoveryName(pg), 'postgres on localhost:5432');
  assert.equal(discoveryName({ engine: 'redis', port: 6379, detail: '' }), 'redis on localhost:6379');
});

function conn(host: string | null, port: number | null, engine = 'postgres'): ConnectionConfig {
  return { id: 'x', name: 'x', engine, host, port } as unknown as ConnectionConfig;
}

test('alreadySaved matches the local aliases and the engine+port', () => {
  const saved = [conn('localhost', 5432)];
  assert.equal(alreadySaved(pg, saved), true);
  assert.equal(alreadySaved(pg, [conn('127.0.0.1', 5432)]), true);
  // Blank host resolves to localhost at save time — same server.
  assert.equal(alreadySaved(pg, [conn(null, 5432)]), true);
  assert.equal(alreadySaved(pg, [conn('db.internal', 5432)]), false);
  assert.equal(alreadySaved(pg, [conn('localhost', 5433)]), false);
  assert.equal(alreadySaved(pg, [conn('localhost', 5432, 'mysql')]), false);
  assert.equal(alreadySaved(pg, []), false);
});
