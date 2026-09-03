import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpUsage, bumpUsageFromSql, usageBoost, _resetUsage } from '../src/utils/usageRank.ts';

test('unused labels get no boost; used ones do, capped and case-insensitive', () => {
  _resetUsage();
  assert.equal(usageBoost('orders'), 0);
  bumpUsage(['orders', 'Orders', 'ORDERS']);
  assert.ok(usageBoost('orders') > 0);
  assert.equal(usageBoost('orders'), usageBoost('ORDERS'));
  assert.ok(usageBoost('orders') <= 8);
});

test('bumpUsageFromSql only counts known identifiers', () => {
  _resetUsage();
  bumpUsageFromSql('SELECT id FROM customers JOIN orders ON x', new Set(['customers', 'orders']));
  assert.ok(usageBoost('customers') > 0);
  assert.ok(usageBoost('orders') > 0);
  assert.equal(usageBoost('id'), 0);      // not in the known set
  assert.equal(usageBoost('select'), 0);  // keyword, not known
});

test('more use ranks higher', () => {
  _resetUsage();
  bumpUsage(['a']);
  for (let i = 0; i < 20; i++) bumpUsage(['b']);
  assert.ok(usageBoost('b') >= usageBoost('a'));
});
