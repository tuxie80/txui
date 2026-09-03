/**
 * HypoPG what-if advisor (src/utils/hypopg.ts).
 *
 * Two things carry the whole feature and so are tested here: the SQL builders
 * that must be valid PostgreSQL and, above all, must never execute the target
 * query (plain EXPLAIN, never ANALYZE); and the cost-delta computation that
 * turns two plan documents into the single number and the yes/no the user
 * reads. The latter's subtlety is "used" — a cheaper plan that never touched
 * the candidate index is a coincidence, not a recommendation, and the code
 * must not conflate them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hypopgDetectSql, hypopgEnableSql, hypopgCreateSql, hypopgResetSql,
  explainJsonSql, looksLikeCreateIndex, isHypotheticalIndexName,
  readHypopgStatus, computeCostDelta, verdictOf,
} from '../src/utils/hypopg.ts';

// ── plan fixtures (trimmed EXPLAIN (FORMAT JSON) output) ─────────────────────

/** A seq scan — no usable index. */
const seqScanPlan = JSON.stringify([{
  Plan: {
    'Node Type': 'Seq Scan',
    'Relation Name': 'orders',
    'Total Cost': 1834.00,
    'Plan Rows': 50,
    Filter: '(customer_id = 42)',
  },
}]);

/** The same query once a hypothetical index on customer_id exists. */
const hypoIndexPlan = JSON.stringify([{
  Plan: {
    'Node Type': 'Index Scan',
    'Relation Name': 'orders',
    'Index Name': '<13342>btree_orders_customer_id',
    'Total Cost': 8.44,
    'Plan Rows': 50,
    'Index Cond': '(customer_id = 42)',
  },
}]);

/** A plan that got cheaper but still on a seq scan — the index was ignored. */
const cheaperButNoIndexPlan = JSON.stringify([{
  Plan: {
    'Node Type': 'Seq Scan',
    'Relation Name': 'orders',
    'Total Cost': 1000.00,
    'Plan Rows': 50,
  },
}]);

// ── SQL builders ─────────────────────────────────────────────────────────────

describe('SQL builders', () => {
  test('detection probes both installed and available catalogs', () => {
    const sql = hypopgDetectSql();
    assert.match(sql, /pg_extension/);
    assert.match(sql, /pg_available_extensions/);
    assert.match(sql, /extname = 'hypopg'/);
  });

  test('enable is idempotent DDL', () => {
    assert.equal(hypopgEnableSql(), 'CREATE EXTENSION IF NOT EXISTS hypopg');
  });

  test('create wraps the DDL as a quoted literal and returns the name', () => {
    const sql = hypopgCreateSql('CREATE INDEX ON orders (customer_id)');
    assert.match(sql, /hypopg_create_index\('CREATE INDEX ON orders \(customer_id\)'\)/);
    assert.match(sql, /indexrelid, indexname/);
  });

  test('create escapes single quotes so a WHERE literal cannot break out', () => {
    const sql = hypopgCreateSql("CREATE INDEX ON t (x) WHERE name = 'o''brien'");
    // every single quote inside the DDL is doubled inside the outer literal
    assert.match(sql, /hypopg_create_index\('CREATE INDEX ON t \(x\) WHERE name = ''o''''brien'''\)/);
  });

  test('create strips a trailing semicolon before quoting', () => {
    const sql = hypopgCreateSql('CREATE INDEX ON orders (customer_id);');
    assert.ok(!sql.includes(';)'), 'the semicolon must not survive into the literal');
    assert.match(sql, /\(customer_id\)'\)/);
  });

  test('reset drops all hypothetical indexes', () => {
    assert.equal(hypopgResetSql(), 'SELECT hypopg_reset()');
  });

  test('explain is plain EXPLAIN FORMAT JSON — never ANALYZE, never executing', () => {
    const sql = explainJsonSql('SELECT * FROM orders WHERE customer_id = 42');
    assert.match(sql, /^EXPLAIN \(FORMAT JSON\) /);
    assert.doesNotMatch(sql, /ANALYZE/i);
    assert.match(sql, /SELECT \* FROM orders WHERE customer_id = 42$/);
  });

  test('explain strips a trailing semicolon so nesting stays valid', () => {
    assert.equal(
      explainJsonSql('SELECT 1;'),
      'EXPLAIN (FORMAT JSON) SELECT 1',
    );
  });
});

// ── validators ───────────────────────────────────────────────────────────────

describe('candidate validation', () => {
  test('accepts CREATE INDEX and CREATE UNIQUE INDEX in any case', () => {
    assert.ok(looksLikeCreateIndex('CREATE INDEX ON t (a)'));
    assert.ok(looksLikeCreateIndex('  create   index ix ON t (a)'));
    assert.ok(looksLikeCreateIndex('CREATE UNIQUE INDEX ON t (a)'));
  });

  test('rejects anything that is not a CREATE INDEX', () => {
    assert.ok(!looksLikeCreateIndex('DROP INDEX ix'));
    assert.ok(!looksLikeCreateIndex('SELECT 1'));
    assert.ok(!looksLikeCreateIndex('CREATE TABLE t (a int)'));
    assert.ok(!looksLikeCreateIndex(''));
  });

  test('recognises hypopg-generated names', () => {
    assert.ok(isHypotheticalIndexName('<13342>btree_orders_customer_id'));
    assert.ok(!isHypotheticalIndexName('orders_pkey'));
  });
});

// ── detection interpretation ──────────────────────────────────────────────────

describe('readHypopgStatus', () => {
  test('installed extension reports ready', () => {
    const s = readHypopgStatus(['1.4.1', '1.4.1']);
    assert.equal(s.installed, true);
    assert.equal(s.available, true);
    assert.equal(s.installedVersion, '1.4.1');
  });

  test('available but not installed', () => {
    const s = readHypopgStatus([null, '1.4.1']);
    assert.equal(s.installed, false);
    assert.equal(s.available, true);
    assert.equal(s.availableVersion, '1.4.1');
  });

  test('absent entirely', () => {
    const s = readHypopgStatus([null, null]);
    assert.equal(s.installed, false);
    assert.equal(s.available, false);
  });

  test('a missing row is treated as absent, not a crash', () => {
    const s = readHypopgStatus(undefined);
    assert.equal(s.installed, false);
    assert.equal(s.available, false);
  });
});

// ── cost delta ────────────────────────────────────────────────────────────────

describe('computeCostDelta', () => {
  test('a used index that lowers cost is an improvement', () => {
    const d = computeCostDelta(seqScanPlan, hypoIndexPlan, ['<13342>btree_orders_customer_id']);
    assert.equal(d.baselineCost, 1834);
    assert.equal(d.hypoCost, 8.44);
    assert.ok(d.absolute < 0, 'delta is negative (cheaper)');
    assert.ok(d.improved);
    assert.ok(d.indexUsed);
    assert.deepEqual(d.usedIndexNames, ['<13342>btree_orders_customer_id']);
    // ~99.5% cheaper
    assert.ok(d.percent < -99 && d.percent > -100);
  });

  test('an ignored index is not counted as used even if the plan is cheaper', () => {
    const d = computeCostDelta(seqScanPlan, cheaperButNoIndexPlan, ['<13342>btree_orders_customer_id']);
    assert.ok(d.improved, 'cost did fall');
    assert.equal(d.indexUsed, false, 'but the candidate never appears in the plan');
    assert.deepEqual(d.usedIndexNames, []);
  });

  test('detects a used hypothetical index even without its name in hand', () => {
    // e.g. the create result was not captured — the angle-bracket form still gives it away
    const d = computeCostDelta(seqScanPlan, hypoIndexPlan, []);
    assert.ok(d.indexUsed);
    assert.deepEqual(d.usedIndexNames, ['<13342>btree_orders_customer_id']);
  });

  test('a real (non-hypothetical) index in the plan is not mistaken for the candidate', () => {
    const realIndexPlan = JSON.stringify([{
      Plan: {
        'Node Type': 'Index Scan', 'Relation Name': 'orders',
        'Index Name': 'orders_pkey', 'Total Cost': 8.3, 'Plan Rows': 1,
      },
    }]);
    const d = computeCostDelta(seqScanPlan, realIndexPlan, ['<13342>btree_orders_customer_id']);
    assert.equal(d.indexUsed, false);
  });

  test('zero baseline cost does not divide by zero', () => {
    const zero = JSON.stringify([{ Plan: { 'Node Type': 'Result', 'Total Cost': 0, 'Plan Rows': 1 } }]);
    const d = computeCostDelta(zero, zero, []);
    assert.equal(d.percent, 0);
  });
});

// ── verdict ──────────────────────────────────────────────────────────────────

describe('verdictOf', () => {
  test('used + improved recommends', () => {
    const d = computeCostDelta(seqScanPlan, hypoIndexPlan, ['<13342>btree_orders_customer_id']);
    assert.match(verdictOf(d), /chose the index/);
  });

  test('ignored index is discouraged', () => {
    const d = computeCostDelta(seqScanPlan, cheaperButNoIndexPlan, ['x']);
    assert.match(verdictOf(d), /ignored|did not use/);
  });
});
