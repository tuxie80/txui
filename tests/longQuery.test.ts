import { test } from 'node:test';
import assert from 'node:assert/strict';
import { longClass, truncateSql } from '../src/utils/longQuery.ts';

test('longClass: below threshold → none, >= threshold → warn, >= 2× → danger', () => {
  assert.equal(longClass(29, 30), '');
  assert.equal(longClass(30, 30), 'warn');
  assert.equal(longClass(59, 30), 'warn');
  assert.equal(longClass(60, 30), 'danger');
  assert.equal(longClass(600, 30), 'danger');
  assert.equal(longClass(10, 0), '', 'a zero threshold disables highlighting');
  assert.equal(longClass(NaN, 30), '', 'a missing/unparseable Time never tints');
});

test('truncateSql collapses whitespace and caps length with an ellipsis', () => {
  assert.equal(truncateSql('SELECT  *\nFROM   t', 160), 'SELECT * FROM t');
  const long = 'x'.repeat(500);
  const out = truncateSql(long, 160);
  assert.equal(out.length, 160);
  assert.ok(out.endsWith('…'));
  assert.equal(truncateSql('short', 160), 'short');
});
