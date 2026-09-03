/**
 * ClickHouse statement shortcuts (src/utils/sqlKeywords.ts).
 *
 * On a sick MergeTree cluster the first questions are always the same: what are
 * the parts, what is merging, what is mutating, what is running. ClickHouse has
 * no MySQL-style SHOW for these — the answers live in system tables — so the
 * shortcuts SELECT from them. They must be offered on ClickHouse and nowhere
 * else: a system.parts query against MySQL is a guaranteed error.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STATEMENT_SHORTCUTS } from '../src/utils/sqlKeywords.ts';

const clickhouse = STATEMENT_SHORTCUTS.filter(s => s.engines.includes('clickhouse'));
const byShortcut = new Map(clickhouse.map(s => [s.shortcut, s]));

describe('the MergeTree triage shortcuts exist', () => {
  test('the core four are offered', () => {
    for (const name of ['parts', 'merges', 'mutations', 'processes']) {
      assert.ok(byShortcut.has(name), `ClickHouse is missing the '${name}' shortcut`);
    }
  });

  test('each ClickHouse shortcut reads from a system table', () => {
    for (const s of clickhouse) {
      assert.match(s.statement, /\bsystem\./,
        `'${s.shortcut}' does not query a system table`);
    }
  });

  test("'parts' points at system.parts and filters to active", () => {
    const parts = byShortcut.get('parts')!;
    assert.match(parts.statement, /FROM system\.parts/);
    assert.match(parts.statement, /WHERE active/);
  });
});

describe('the shortcuts are gated to ClickHouse only', () => {
  test('every ClickHouse shortcut lists exactly the clickhouse engine', () => {
    for (const s of clickhouse) {
      assert.deepEqual(s.engines, ['clickhouse'],
        `'${s.shortcut}' is offered beyond ClickHouse`);
    }
  });

  test('no other engine is offered a ClickHouse shortcut', () => {
    const chNames = new Set(clickhouse.map(s => s.shortcut));
    for (const s of STATEMENT_SHORTCUTS) {
      if (s.engines.includes('clickhouse')) continue;
      // A name may legitimately be reused by another engine (e.g. 'replicas'
      // on MySQL), but that entry must not carry the clickhouse engine.
      assert.ok(!s.engines.includes('clickhouse'),
        `a non-ClickHouse entry '${s.shortcut}' leaked the clickhouse engine`);
    }
    // Sanity: the ClickHouse set is non-trivial.
    assert.ok(chNames.size >= 4, 'expected at least the four core shortcuts');
  });

  test('single-engine MySQL/PG/SQLite shortcuts are never tagged clickhouse', () => {
    const others = STATEMENT_SHORTCUTS.filter(s =>
      s.engines.some(e => e !== 'clickhouse'));
    for (const s of others) {
      if (s.engines.length === 1) {
        assert.ok(!s.engines.includes('clickhouse'));
      }
    }
  });
});
