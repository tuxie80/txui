/**
 * ClickHouse DBA views (src/utils/dbaViews.ts): the dictionary inspection view
 * must surface the operationally important facts a DBA needs — where each
 * dictionary loads from (source), how effective its cache is (found_rate),
 * its element count and memory footprint — and rank the heaviest first. It
 * must read nothing but system.dictionaries.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';

const ch = DBA_VIEWS.clickhouse;

describe('ClickHouse dictionary inspection view', () => {
  const view = ch.find(v => v.id === 'ch-dicts');

  test('the view exists with the expected metadata shape', () => {
    assert.ok(view, 'ch-dicts view is registered');
    assert.equal(typeof view.label, 'string');
    assert.ok(view.label.length > 0);
    assert.equal(view.category, 'Schema');
    assert.equal(typeof view.sql, 'string');
    assert.equal(typeof view.description, 'string');
    assert.ok(view.description.length > 0);
  });

  test('it surfaces source and the cache hit rate', () => {
    const sql = view.sql;
    assert.match(sql, /\bsource\b/);
    assert.match(sql, /\bfound_rate\b/);
    assert.match(sql, /loading_duration/);
    assert.match(sql, /last_successful_update_time/);
  });

  test('it keeps element count and memory footprint', () => {
    const sql = view.sql;
    assert.match(sql, /\belement_count\b/);
    assert.match(sql, /formatReadableSize\(bytes_allocated\)\s+AS\s+memory/i);
  });

  test('it ranks the heaviest dictionaries first', () => {
    const sql = view.sql;
    assert.match(sql, /ORDER BY\s+bytes_allocated\s+DESC/i);
    assert.match(sql, /LIMIT\s+100/i);
  });

  test('it reads only system.dictionaries', () => {
    const sql = view.sql;
    assert.match(sql, /FROM\s+system\.dictionaries/i);
    // No other system table or catalog is joined in.
    const froms = sql.match(/\bFROM\s+([A-Za-z_][\w.]*)/gi) ?? [];
    assert.equal(froms.length, 1, 'exactly one FROM clause');
    const joins = sql.match(/\bJOIN\b/gi) ?? [];
    assert.equal(joins.length, 0, 'no joins');
    // Every system.* reference must be system.dictionaries.
    const sysRefs = sql.match(/system\.\w+/gi) ?? [];
    for (const ref of sysRefs) {
      assert.equal(ref.toLowerCase(), 'system.dictionaries');
    }
  });
});
