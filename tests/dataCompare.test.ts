/**
 * Data compare and reconciliation (src/utils/dataCompare.ts).
 *
 * This module's output is INSERT/UPDATE/DELETE against a live table, so the
 * tests are weighted towards the things that would make it dangerous: an
 * unkeyed statement, a delete nobody asked for, or a false difference that
 * rewrites every row.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareRows, fetchSql, normalise, reconcileSql, summariseReconcile,
  type CompareResult, type ReconcileOptions,
} from '../src/utils/dataCompare.ts';

const columns = ['id', 'name', 'amount'];
const keyColumns = ['id'];

const cmp = (sourceRows: unknown[][], targetRows: unknown[][]) =>
  compareRows({ columns, keyColumns, sourceRows, targetRows });

const opts = (over: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
  schema: 'shop', table: 'lookup', columns, keyColumns, engine: 'mysql',
  insert: true, update: true, delete: false, ...over,
});

describe('normalise', () => {
  /// The engines disagree about representation in ways that are not real
  /// differences. Comparing raw would report every row as changed — a
  /// reconciliation script that rewrites the whole table.
  test('numeric strings compare as numbers', () => {
    assert.equal(normalise('10.50'), normalise('10.5'));
    assert.equal(normalise(10.5), normalise('10.50'));
    assert.equal(normalise('1.000'), normalise(1));
  });

  test('booleans and their integer spellings agree', () => {
    assert.equal(normalise(true), normalise(1));
    assert.equal(normalise(false), normalise('0'));
  });

  /// NULL must not collide with the string "NULL", or a row containing the
  /// literal text would compare equal to a missing value.
  test('NULL is distinct from the text NULL and from empty', () => {
    assert.notEqual(normalise(null), normalise('NULL'));
    assert.notEqual(normalise(null), normalise(''));
  });

  test('ordinary text is left alone', () => {
    assert.equal(normalise('Ada'), 'Ada');
    assert.notEqual(normalise('Ada'), normalise('ada'));
  });

  test('minus zero is zero', () => {
    assert.equal(normalise('-0.0'), normalise(0));
  });
});

describe('compareRows', () => {
  test('identical sides produce no work', () => {
    const r = cmp([[1, 'a', 10]], [[1, 'a', 10]]);
    assert.equal(r.same, 1);
    assert.equal(r.different.length + r.onlyInSource.length + r.onlyInTarget.length, 0);
  });

  test('a row the target lacks is an insert candidate', () => {
    const r = cmp([[1, 'a', 10], [2, 'b', 20]], [[1, 'a', 10]]);
    assert.deepEqual(r.onlyInSource.map(d => d.key), [['2']]);
  });

  test('a row the source lacks is a delete candidate', () => {
    const r = cmp([[1, 'a', 10]], [[1, 'a', 10], [9, 'z', 90]]);
    assert.deepEqual(r.onlyInTarget.map(d => d.key), [['9']]);
  });

  test('a differing row names only the columns that differ', () => {
    const r = cmp([[1, 'a', 99]], [[1, 'a', 10]]);
    assert.equal(r.different.length, 1);
    assert.deepEqual(r.different[0].changed, ['amount']);
  });

  /// The representation difference again, at the level that matters.
  test('a formatting-only difference is not a difference', () => {
    const r = cmp([[1, 'a', '10.50']], [[1, 'a', 10.5]]);
    assert.equal(r.different.length, 0);
    assert.equal(r.same, 1);
  });

  test('a composite key is compared as a whole', () => {
    const r = compareRows({
      columns: ['a', 'b', 'v'], keyColumns: ['a', 'b'],
      sourceRows: [[1, 1, 'x'], [1, 2, 'y']],
      targetRows: [[1, 1, 'x']],
    });
    assert.deepEqual(r.onlyInSource.map(d => d.key), [['1', '2']]);
  });

  /// With a repeated key there is no single "the row with this key", so any
  /// generated UPDATE would change an arbitrary one.
  test('duplicate keys are reported rather than resolved', () => {
    const r = cmp([[1, 'a', 1], [1, 'b', 2]], [[1, 'a', 1]]);
    assert.deepEqual(r.duplicateKeys.length, 1);
  });

  /// A composite key whose parts concatenate ambiguously would make ('a','bc')
  /// and ('ab','c') the same row.
  test('key parts cannot bleed into each other', () => {
    const r = compareRows({
      columns: ['a', 'b'], keyColumns: ['a', 'b'],
      sourceRows: [['a', 'bc']],
      targetRows: [['ab', 'c']],
    });
    assert.equal(r.same, 0, 'two different keys were treated as one');
    assert.equal(r.onlyInSource.length, 1);
    assert.equal(r.onlyInTarget.length, 1);
  });

  test('an unknown key column is refused', () => {
    assert.throws(() => compareRows({
      columns, keyColumns: ['nope'], sourceRows: [], targetRows: [],
    }), /not in the result/);
  });

  test('no key column at all is refused', () => {
    assert.throws(() => compareRows({
      columns, keyColumns: [], sourceRows: [], targetRows: [],
    }), /at least one key column/);
  });
});

describe('reconcileSql', () => {
  const diff = cmp([[1, 'a', 10], [2, 'new', 20]], [[1, 'a', 99], [9, 'gone', 90]]);

  test('inserts carry every column', () => {
    const sql = reconcileSql(diff, opts({ update: false }));
    assert.equal(sql.length, 1);
    assert.match(sql[0], /INSERT INTO `shop`\.`lookup` \(`id`, `name`, `amount`\) VALUES \(2, 'new', 20\);/);
  });

  test('updates set only the columns that differ', () => {
    const sql = reconcileSql(diff, opts({ insert: false }));
    assert.equal(sql.length, 1);
    assert.match(sql[0], /SET `amount` = 10 WHERE `id` = 1;/);
    assert.ok(!sql[0].includes('`name`'), 'an unchanged column was written');
  });

  /// The single most important property in the module: nothing generated can
  /// touch a row it does not name.
  test('every update and delete is keyed', () => {
    const sql = reconcileSql(diff, opts({ delete: true }));
    for (const s of sql) {
      if (/^(UPDATE|DELETE)/.test(s)) {
        assert.match(s, /WHERE `id` = /, `unkeyed statement: ${s}`);
      }
    }
  });

  /// A row missing from the source is far more often an incomplete extract
  /// than a row that should cease to exist.
  test('deletes are not generated unless asked for', () => {
    assert.ok(!reconcileSql(diff, opts()).some(s => s.startsWith('DELETE')));
    assert.ok(reconcileSql(diff, opts({ delete: true })).some(s => s.startsWith('DELETE')));
  });

  /// A delete running before an insert leaves a window where the row exists on
  /// neither side, and an interrupted script leaves it that way.
  test('inserts come before updates, and deletes last', () => {
    const sql = reconcileSql(diff, opts({ delete: true }));
    const kinds = sql.map(s => s.split(' ')[0]);
    assert.deepEqual(kinds, ['INSERT', 'UPDATE', 'DELETE']);
  });

  test('nulls are written as NULL, not as the string', () => {
    const d = cmp([[3, null, 1]], []);
    const sql = reconcileSql(d, opts());
    assert.match(sql[0], /VALUES \(3, NULL, 1\)/);
  });

  test('quotes in values are escaped', () => {
    const d = cmp([[4, "O'Hara", 1]], []);
    assert.match(reconcileSql(d, opts())[0], /'O''Hara'/);
  });

  test('postgres quoting is used when asked for', () => {
    const d = cmp([[5, 'x', 1]], []);
    assert.match(reconcileSql(d, opts({ engine: 'postgres' }))[0], /"shop"\."lookup"/);
  });

  test('nothing enabled generates nothing', () => {
    assert.deepEqual(reconcileSql(diff, opts({ insert: false, update: false })), []);
  });
});

describe('summariseReconcile', () => {
  const diff = cmp([[1, 'a', 10], [2, 'new', 20]], [[1, 'a', 99], [9, 'gone', 90]]);

  test('counts only what is enabled', () => {
    const s = summariseReconcile(diff, opts());
    assert.deepEqual([s.inserts, s.updates, s.deletes], [1, 1, 0]);
    assert.equal(s.total, 2);
    assert.match(s.headline!, /1 insert, 1 update against shop\.lookup/);
  });

  test('deletes appear once enabled', () => {
    assert.equal(summariseReconcile(diff, opts({ delete: true })).deletes, 1);
  });

  test('nothing to do has no headline', () => {
    const none = cmp([[1, 'a', 1]], [[1, 'a', 1]]);
    assert.equal(summariseReconcile(none, opts()).headline, null);
  });

  /// A duplicate key makes the whole comparison untrustworthy, so it is a
  /// blocker rather than a warning.
  test('duplicate keys block the reconciliation and explain why', () => {
    const dupes: CompareResult = cmp([[1, 'a', 1], [1, 'b', 2]], [[1, 'a', 1]]);
    const s = summariseReconcile(dupes, opts());
    assert.equal(s.blockers.length, 1);
    assert.match(s.blockers[0], /duplicate key/);
    assert.match(s.blockers[0], /actually unique/);
  });
});

describe('fetchSql', () => {
  test('orders by the key so both sides line up', () => {
    const sql = fetchSql('shop', 'lookup', columns, keyColumns, 100, 'mysql');
    assert.match(sql, /ORDER BY `id`/);
  });

  /// One past the cap, so "exactly at the cap" and "more than the cap" are
  /// distinguishable rather than silently comparing a truncated set.
  test('reads one row past the cap', () => {
    assert.match(fetchSql('s', 't', columns, keyColumns, 100, 'mysql'), /LIMIT 101$/);
  });

  test('postgres quoting', () => {
    assert.match(fetchSql('public', 't', columns, keyColumns, 10, 'postgres'), /"public"\."t"/);
  });
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// The reconcile script below was executed against SQL Server 2022: a target of
// (1,'Anna',1),(3,'Cid',1) became (1,'Ann',1),(2,'Bob',0) — insert, update and
// delete all applied.

test('T-SQL has no boolean literals, and a reconcile script must not emit them', () => {
  // `SET flag = TRUE` is a syntax error in T-SQL. In a reconciliation script
  // that means the batch fails partway — after the rows before it were already
  // written, leaving the target in a state neither side asked for.
  const res = compareRows({
    columns: ['id', 'active'], keyColumns: ['id'],
    sourceRows: [[1, true], [2, false]],
    targetRows: [[1, false]],
  });
  const sql = reconcileSql(res, {
    schema: 'dbo', table: 't', columns: ['id', 'active'], keyColumns: ['id'],
    engine: 'sqlserver', insert: true, update: true, delete: true,
  }).join('\n');
  assert.ok(!/\b(TRUE|FALSE)\b/.test(sql), `boolean literal leaked: ${sql}`);
  assert.match(sql, /VALUES \(2, 0\)/);
  assert.match(sql, /SET \[active\] = 1/);
});

test('the other engines keep TRUE/FALSE', () => {
  const res = compareRows({
    columns: ['id', 'active'], keyColumns: ['id'],
    sourceRows: [[1, true]], targetRows: [],
  });
  for (const engine of ['postgres', 'mysql'] as const) {
    const sql = reconcileSql(res, {
      schema: 's', table: 't', columns: ['id', 'active'], keyColumns: ['id'],
      engine, insert: true, update: false, delete: false,
    }).join('\n');
    assert.match(sql, /TRUE/, engine);
  }
});

test('the fetch caps with TOP, and keeps its ORDER BY', () => {
  const sql = fetchSql('sales', 'customers', ['id', 'name'], ['id'], 100, 'sqlserver');
  assert.match(sql, /^SELECT TOP \(101\) /);
  assert.ok(!/LIMIT/i.test(sql));
  // TOP without ORDER BY is nondeterministic; comparing two nondeterministic
  // samples reports differences that are only row order.
  assert.match(sql, /ORDER BY \[id\]$/);
});

test('the cap fetches one extra row, so "at the cap" is distinguishable', () => {
  assert.match(fetchSql('s', 't', ['a'], ['a'], 50, 'sqlserver'), /TOP \(51\)/);
});
