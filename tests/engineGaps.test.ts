/**
 * Registered engine gaps: shown, greyed, explained — never silently absent.
 *
 * The plugin menu's default is to FILTER OUT what an engine cannot do, which is
 * right for most of it (an ER diagram greyed on Redis is noise). It is wrong
 * where a user has reason to expect the feature and would otherwise conclude
 * the panel is missing or broken. This table is the exceptions, and it is meant
 * to stay small.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { engineGapReason, registeredGaps } from '../src/utils/engineGaps.ts';
import { can } from '../src/utils/engineCaps.ts';

describe('registered engine gaps', () => {
  test('SQL Server replication is a registered gap, not a hidden one', () => {
    const reason = engineGapReason('sqlserver', 'replication');
    assert.ok(reason, 'no reason registered — the panel would vanish instead of greying');
    // The capability is false: the two must agree, or the panel would be
    // offered and then fail on the first query.
    assert.equal(can('sqlserver', 'replication'), false);
  });

  test('the reason names the real difference, not just "unsupported"', () => {
    // A reason a DBA cannot act on is decoration. This one has to say WHY the
    // shapes differ and where to look instead.
    const reason = engineGapReason('sqlserver', 'replication') ?? '';
    assert.match(reason, /availability group/i);
    assert.match(reason, /per database/i);
    assert.match(reason, /sys\.dm_hadr|SSMS/);
    assert.ok(reason.length > 120, 'too short to explain anything');
  });

  test('engines that DO fit the panel have no gap registered', () => {
    for (const e of ['mysql', 'postgres']) {
      assert.equal(engineGapReason(e, 'replication'), null, e);
      assert.equal(can(e, 'replication'), true, e);
    }
  });

  test('an unregistered pair returns null and keeps the default behaviour', () => {
    assert.equal(engineGapReason('sqlserver', 'erdiagram'), null);
    assert.equal(engineGapReason('redis', 'replication'), null);
    assert.equal(engineGapReason('nosuchengine', 'nosuchpanel'), null);
  });

  test('every registered gap contradicts its capability, never agrees with it', () => {
    // A gap whose capability is TRUE would grey a panel that works. The two
    // encode the same fact from different directions and must not drift.
    for (const { engine, panel, reason } of registeredGaps()) {
      assert.ok(reason.trim().length > 0, `${engine}::${panel} has an empty reason`);
      assert.equal(can(engine, panel as never), false,
        `${engine}::${panel} is registered as a gap but its capability is true`);
    }
  });

  test('the table stays small — it is exceptions, not a catalogue', () => {
    assert.ok(registeredGaps().length <= 10,
      'if this grows, the menu is being used to list everything an engine cannot do');
  });
});
