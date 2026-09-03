import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteMaintenanceActions } from '../src/utils/sqliteMaintenance.ts';

test('the core actions are always present, VACUUM last', () => {
  const acts = sqliteMaintenanceActions();
  const ids = acts.map(a => a.id);
  for (const id of ['quick_check', 'integrity_check', 'foreign_key_check', 'analyze', 'optimize', 'vacuum']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.equal(ids[ids.length - 1], 'vacuum', 'VACUUM (the heaviest) should sort last');
});

test('WAL checkpoint and incremental vacuum are gated', () => {
  const bare = sqliteMaintenanceActions().map(a => a.id);
  assert.ok(!bare.includes('wal_checkpoint'));
  assert.ok(!bare.includes('incremental_vacuum'));

  const full = sqliteMaintenanceActions({ hasWal: true, autoVacuumIncremental: true }).map(a => a.id);
  assert.ok(full.includes('wal_checkpoint'));
  assert.ok(full.includes('incremental_vacuum'));
});

test('checks are read-only, VACUUM rewrites', () => {
  const acts = sqliteMaintenanceActions();
  const by = Object.fromEntries(acts.map(a => [a.id, a]));
  assert.equal(by.quick_check.impact, 'read');
  assert.equal(by.integrity_check.impact, 'read');
  assert.equal(by.foreign_key_check.impact, 'read');
  assert.equal(by.analyze.impact, 'stats');
  assert.equal(by.vacuum.impact, 'rewrite');
});

test('every action carries a runnable statement and a human impact label', () => {
  for (const a of sqliteMaintenanceActions({ hasWal: true, autoVacuumIncremental: true })) {
    assert.ok(a.sql.trim().length > 0 && a.sql.trim().endsWith(';'), `${a.id} sql`);
    assert.ok(a.impactLabel.length > 0, `${a.id} impactLabel`);
    assert.ok(a.detail.length > 0, `${a.id} detail`);
  }
});
