import assert from 'node:assert/strict';
import test from 'node:test';
import { sentinelMasterConfig } from '../src/utils/redisTopology.ts';

test('Redis Sentinel master names are trimmed and blank means unspecified', () => {
  assert.equal(sentinelMasterConfig('redis', '  mymaster  '), 'mymaster');
  assert.equal(sentinelMasterConfig('redis', '   '), null);
  assert.equal(sentinelMasterConfig('redis', ''), null);
});

test('other engines never retain a stale Sentinel service name', () => {
  for (const engine of ['mysql', 'postgres', 'clickhouse', 'sqlite', 'parquet', 'duckdb', 'mongodb', 'sqlserver'] as const) {
    assert.equal(sentinelMasterConfig(engine, 'mymaster'), null);
  }
});
