/**
 * ClickHouse DBA views (src/utils/dbaViews.ts): the query-pattern aggregation
 * view — a pg_stat_statements-style "which query SHAPE burns the most total
 * time" — must exist and group system.query_log by normalized_query_hash,
 * ordering by total time descending.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';

const ch = DBA_VIEWS.clickhouse;

describe('ClickHouse query-pattern aggregation view', () => {
  const view = ch.find(v => v.id === 'ch-patterns');

  test('the view exists with the expected metadata shape', () => {
    assert.ok(view, 'ch-patterns view is registered');
    assert.equal(typeof view.label, 'string');
    assert.ok(view.label.length > 0);
    assert.equal(view.category, 'Query log');
    assert.equal(typeof view.sql, 'string');
    assert.equal(typeof view.description, 'string');
    // Neighbouring query_log views carry the same cost badge.
    assert.match(view.demanding ?? '', /query_log/);
  });

  test('it aggregates system.query_log by normalized_query_hash', () => {
    const sql = view.sql;
    assert.match(sql, /system\.query_log/);
    assert.match(sql, /normalized_query_hash/);
    assert.match(sql, /GROUP BY\s+normalized_query_hash/i);
  });

  test('it ranks by total time descending (not per-run latency)', () => {
    const sql = view.sql;
    assert.match(sql, /sum\(query_duration_ms\)/);
    assert.match(sql, /ORDER BY\s+total_ms\s+DESC/i);
  });

  test('it reports count, total/avg time, memory and rows read', () => {
    const sql = view.sql;
    assert.match(sql, /count\(\)\s+AS\s+runs/i);
    assert.match(sql, /round\(sum\(query_duration_ms\)\)\s+AS\s+total_ms/i);
    assert.match(sql, /round\(avg\(query_duration_ms\)\)\s+AS\s+avg_ms/i);
    assert.match(sql, /formatReadableSize\(sum\(memory_usage\)\)\s+AS\s+total_mem/i);
    assert.match(sql, /sum\(read_rows\)\s+AS\s+rows_read/i);
    // Only completed statements, over the last day.
    assert.match(sql, /type\s*=\s*'QueryFinish'/);
    assert.match(sql, /event_time\s*>\s*now\(\)\s*-\s*INTERVAL\s+24\s+HOUR/i);
  });
});
