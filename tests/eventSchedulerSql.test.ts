/**
 * Event-scheduler management SQL builders (src/utils/eventSchedulerSql.ts).
 * These statements are emitted into the editor for review, never executed — so
 * the wording and identifier quoting must be exactly right.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedulerToggleSql, alterEventSql } from '../src/utils/eventSchedulerSql.ts';

test('scheduler toggle emits SET GLOBAL with ON / OFF', () => {
  assert.equal(schedulerToggleSql(true), 'SET GLOBAL event_scheduler = ON;');
  assert.equal(schedulerToggleSql(false), 'SET GLOBAL event_scheduler = OFF;');
});

test('per-event enable / disable uses ALTER EVENT with quoted schema.name', () => {
  assert.equal(
    alterEventSql('appdb', 'nightly_cleanup', true),
    'ALTER EVENT `appdb`.`nightly_cleanup` ENABLE;',
  );
  assert.equal(
    alterEventSql('appdb', 'nightly_cleanup', false),
    'ALTER EVENT `appdb`.`nightly_cleanup` DISABLE;',
  );
});

test('identifiers are always quoted, including reserved words and escapes', () => {
  // reserved word as a name — bare would be a syntax error
  assert.equal(
    alterEventSql('order', 'select', true),
    'ALTER EVENT `order`.`select` ENABLE;',
  );
  // a backtick inside the name is doubled
  assert.equal(
    alterEventSql('db', 'we`ird', false),
    'ALTER EVENT `db`.`we``ird` DISABLE;',
  );
});
