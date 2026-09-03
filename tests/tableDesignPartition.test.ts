/**
 * Partition management builders (src/utils/tableDesign.ts).
 *
 * MySQL/MariaDB only: the designer can propose ADD / DROP / REORGANIZE
 * PARTITION, and — like every other change here — a proposal is not an action.
 * The load-bearing test is that DROP PARTITION is labelled *destructive*: it
 * deletes the rows in the partition outright, and a change mislabelled safe is
 * the one that costs someone their data.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPartitionSql, dropPartitionSql, reorganizePartitionSql,
  changesToScript, summarise,
} from '../src/utils/tableDesign.ts';

// The already-qualified, already-quoted reference the designer passes in.
const table = '`s`.`orders`';

describe('ADD PARTITION', () => {
  test('is non-destructive metadata and shapes the VALUES LESS THAN clause', () => {
    const c = addPartitionSql(table, { name: 'p2025', valuesLessThan: '2025' }, 'mysql');
    assert.equal(c.kind, 'add-partition');
    assert.equal(c.subject, 'p2025');
    assert.equal(c.risk, 'safe');
    assert.equal(c.cost, 'metadata');
    assert.equal(
      c.sql,
      'ALTER TABLE `s`.`orders` ADD PARTITION (PARTITION `p2025` VALUES LESS THAN (2025))',
    );
  });

  test('the bound is raw SQL — MAXVALUE and expressions pass through verbatim', () => {
    const c = addPartitionSql(table, { name: 'pmax', valuesLessThan: 'MAXVALUE' }, 'mysql');
    assert.match(c.sql, /VALUES LESS THAN \(MAXVALUE\)\)$/);
  });

  test('the partition name is quoted (reserved words survive)', () => {
    const c = addPartitionSql(table, { name: 'order', valuesLessThan: '100' }, 'mysql');
    assert.match(c.sql, /PARTITION `order` VALUES/);
  });
});

describe('DROP PARTITION', () => {
  test('is flagged DESTRUCTIVE and warns the data is deleted', () => {
    const c = dropPartitionSql(table, 'p2020', 'mysql');
    assert.equal(c.kind, 'drop-partition');
    assert.equal(c.subject, 'p2020');
    assert.equal(c.risk, 'destructive');
    assert.ok(c.warning, 'a destructive change must carry a warning');
    assert.match(c.warning!, /deleted/);
    assert.match(c.warning!, /roll back/);
    assert.equal(c.sql, 'ALTER TABLE `s`.`orders` DROP PARTITION `p2020`');
  });

  test('summarise counts it as data-deleting so the confirm word is required', () => {
    const s = summarise([dropPartitionSql(table, 'p2020', 'mysql')]);
    assert.equal(s.destructive, 1);
    assert.match(s.headline!, /delete data/);
  });
});

describe('REORGANIZE PARTITION', () => {
  test('is lossy + rebuild and lists from-partitions into the new definitions', () => {
    const c = reorganizePartitionSql(
      table,
      ['pmax'],
      [
        { name: 'p2025', valuesLessThan: '2025' },
        { name: 'pmax', valuesLessThan: 'MAXVALUE' },
      ],
      'mysql',
    );
    assert.equal(c.kind, 'reorganize-partition');
    assert.equal(c.risk, 'lossy');
    assert.equal(c.cost, 'rebuild');
    assert.ok(c.warning);
    assert.equal(
      c.sql,
      'ALTER TABLE `s`.`orders` REORGANIZE PARTITION `pmax` INTO '
        + '(PARTITION `p2025` VALUES LESS THAN (2025), PARTITION `pmax` VALUES LESS THAN (MAXVALUE))',
    );
  });

  test('multiple source partitions are quoted and comma-joined', () => {
    const c = reorganizePartitionSql(
      table, ['pa', 'pb'], [{ name: 'pab', valuesLessThan: '500' }], 'mysql');
    assert.match(c.sql, /REORGANIZE PARTITION `pa`, `pb` INTO/);
    assert.equal(c.subject, 'pa, pb');
  });
});

test('the builders flow through changesToScript like any other change', () => {
  const script = changesToScript([
    addPartitionSql(table, { name: 'p2025', valuesLessThan: '2025' }, 'mysql'),
    dropPartitionSql(table, 'p2020', 'mysql'),
  ]);
  assert.equal(script.split('\n').length, 2);
  assert.ok(script.endsWith(';'));
  assert.match(script, /ADD PARTITION/);
  assert.match(script, /DROP PARTITION/);
});
