import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRefreshPlan, refreshPlanSignature, refreshTimePredicate, resolveRefreshWindow,
} from '../src/utils/refreshPlan.ts';
import { createDefaultRefreshSpec } from '../src/utils/refreshSpec.ts';

function spec() {
  const value = createDefaultRefreshSpec({
    source: { connectionId: 'source', sessionId: 'source-session' },
    schema: 'shop', cutoffUtc: '2026-11-06T12:00:00.000Z',
  });
  value.target = { connectionId: 'target', sessionId: 'target-session' };
  value.tables = [
    { table: 'countries', policy: 'full' },
    { table: 'orders', policy: 'time_window', column: 'created_at', mode: 'rolling', amount: 7, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
    { table: 'events', policy: 'time_window', column: 'created_at', mode: 'rolling', amount: 24, unit: 'hours', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
    { table: 'recent', policy: 'row_limit', rows: 20, orderBy: ['created_at'], direction: 'desc', tieBreaker: ['id'] },
    { table: 'sample_items', policy: 'sample', rows: 10, sampleSeed: 42, tieBreaker: ['id'] },
    { table: 'tenant_items', policy: 'predicate', where: 'tenant_id = 7' },
    { table: 'generated_items', policy: 'generate', rows: 100, seedOffset: 3 },
    { table: 'ignored_items', policy: 'exclude' },
  ];
  return value;
}

test('independent policies compile into deterministic read, generate and exclude actions', () => {
  const plan = buildRefreshPlan(spec());
  assert.equal(plan.readOnly, true);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.tables.map(table => table.action), ['read', 'read', 'read', 'read', 'read', 'read', 'generate', 'exclude']);
  assert.equal(plan.tables[0].sourceSql, 'SELECT * FROM `shop`.`countries`');
  assert.equal(plan.tables[1].sourceSql, "SELECT * FROM `shop`.`orders` WHERE `created_at` BETWEEN CONVERT_TZ('2026-10-30T12:00:00.000Z', '+00:00', '+00:00') AND CONVERT_TZ('2026-11-06T12:00:00.000Z', '+00:00', '+00:00') AND `created_at` IS NOT NULL");
  assert.equal(plan.tables[2].sourceSql, "SELECT * FROM `shop`.`events` WHERE `created_at` BETWEEN CONVERT_TZ('2026-11-05T12:00:00.000Z', '+00:00', '+00:00') AND CONVERT_TZ('2026-11-06T12:00:00.000Z', '+00:00', '+00:00') AND `created_at` IS NOT NULL");
  assert.equal(plan.tables[3].sourceSql, 'SELECT * FROM `shop`.`recent` ORDER BY `created_at` DESC, `id` DESC LIMIT 20');
  assert.equal(plan.tables[4].sourceSql, "SELECT * FROM `shop`.`sample_items` ORDER BY MD5(CONCAT('refresh-v1', ':', '42', ':', `id`)), `id` LIMIT 10");
  assert.equal(plan.tables[5].sourceSql, 'SELECT * FROM `shop`.`tenant_items` WHERE tenant_id = 7');
  assert.equal(plan.tables[6].sourceSql, null);
  assert.equal(plan.tables[7].sourceSql, null);
  assert.ok(plan.tables.every(table => table.estimatedRows === null));
  assert.equal(refreshPlanSignature(plan), refreshPlanSignature(buildRefreshPlan(spec())));
  assert.equal(plan.specSha256, buildRefreshPlan(spec()).specSha256);
});

test('calendar days resolve at local midnight across DST without calling the current clock', () => {
  const beforeDst = resolveRefreshWindow({
    table: 'events', policy: 'time_window', column: 'created_at', mode: 'calendar_days',
    amount: 1, unit: 'days', timeZone: 'America/New_York', nullPolicy: 'exclude', cutoffUtc: '2026-03-08T12:00:00.000Z',
  });
  assert.equal(beforeDst.startUtc, '2026-03-07T05:00:00.000Z');
  const afterDst = resolveRefreshWindow({
    table: 'events', policy: 'time_window', column: 'created_at', mode: 'calendar_days',
    amount: 1, unit: 'days', timeZone: 'America/New_York', nullPolicy: 'exclude', cutoffUtc: '2026-03-10T12:00:00.000Z',
  });
  assert.equal(afterDst.startUtc, '2026-03-09T04:00:00.000Z');
  assert.equal(afterDst.cutoffUtc, '2026-03-10T12:00:00.000Z');
  assert.throws(() => resolveRefreshWindow({
    table: 'events', policy: 'time_window', column: 'created_at', mode: 'calendar_days',
    amount: 1, unit: 'days', timeZone: 'Not/A_Zone', nullPolicy: 'exclude', cutoffUtc: '2026-03-10T12:00:00.000Z',
  }));
});

test('multiple schema mappings reject ambiguity and duplicate targets instead of guessing', () => {
  const value = spec();
  value.schemaMappings = [{ source: 'shop', target: 'archive' }, { source: 'other', target: 'other_archive' }];
  value.tables = [{ table: 'orders', policy: 'full' }];
  const ambiguous = buildRefreshPlan(value);
  assert.equal(ambiguous.tables[0].action, 'blocked');
  assert.ok(ambiguous.blockers[0].includes('ambiguous'));

  value.tables = [{ table: 'shop.orders', policy: 'full' }, { table: 'other.orders', policy: 'full' }];
  const mapped = buildRefreshPlan(value);
  assert.equal(mapped.tables[0].sourceSql, 'SELECT * FROM `shop`.`orders`');
  assert.equal(mapped.tables[0].targetSchema, 'archive');
  assert.equal(mapped.tables[1].sourceSql, 'SELECT * FROM `other`.`orders`');
  assert.equal(mapped.tables[1].targetSchema, 'other_archive');
});

test('identifier and literal escaping is stable and no estimate is fabricated', () => {
  const value = spec();
  value.schemaMappings = [{ source: 'odd schema', target: 'archive' }];
  value.tables = [{ table: 'odd schema.order`items', policy: 'predicate', where: "note = 'x\\'y'" }];
  const plan = buildRefreshPlan(value);
  assert.equal(plan.tables[0].sourceSql, "SELECT * FROM `odd schema`.`order``items` WHERE note = 'x\\'y'");
  assert.equal(plan.tables[0].targetSchema, 'archive');
  assert.equal(plan.tables[0].estimatedRows, null);
});

test('DATETIME predicates freeze independent offsets on each side of a DST transition', () => {
  const predicate = refreshTimePredicate({
    table: 'events', policy: 'time_window', column: 'created_at', mode: 'rolling',
    amount: 72, unit: 'hours', timeZone: 'America/New_York', nullPolicy: 'exclude', cutoffUtc: '2026-03-10T12:00:00.123Z',
  });
  assert.equal(predicate.startUtc, '2026-03-07T12:00:00.123Z');
  assert.ok(predicate.sql.includes("'2026-03-07T12:00:00.123Z', '+00:00', '-05:00'"));
  assert.ok(predicate.sql.includes("'2026-03-10T12:00:00.123Z', '+00:00', '-04:00'"));
  assert.ok(predicate.note.includes('-05:00/-04:00'));
});

test('DATE predicates use policy-zone calendar dates and never CONVERT_TZ', () => {
  const predicate = refreshTimePredicate({
    table: 'events', policy: 'time_window', column: 'created_on', mode: 'calendar_days',
    amount: 1, unit: 'days', timeZone: 'America/New_York', nullPolicy: 'include', cutoffUtc: '2026-03-10T12:00:00.000Z',
  }, 'date');
  assert.equal(predicate.sql, "BETWEEN '2026-03-09' AND '2026-03-10'");
  assert.ok(!predicate.sql.includes('CONVERT_TZ'));
  assert.ok(predicate.note.includes('session/server timezone does not change'));
});

test('NULL policy is explicit and equal timestamps always have unique ordering', () => {
  const value = spec();
  value.tables = [
    { table: 'events', policy: 'time_window', column: 'created_at', mode: 'rolling', amount: 1, unit: 'days', timeZone: 'UTC', nullPolicy: 'include', cutoffUtc: '2026-11-06T12:00:00.000Z' },
    { table: 'recent', policy: 'row_limit', rows: 2, orderBy: ['created_at'], direction: 'desc', tieBreaker: ['id'] },
  ];
  const plan = buildRefreshPlan(value);
  assert.ok(!plan.tables[0].sourceSql!.includes('IS NOT NULL'));
  assert.equal(plan.tables[1].sourceSql, 'SELECT * FROM `shop`.`recent` ORDER BY `created_at` DESC, `id` DESC LIMIT 2');
});

test('session and server timezone changes cannot alter the compiled plan', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const first = refreshPlanSignature(buildRefreshPlan(spec()));
    process.env.TZ = 'Pacific/Honolulu';
    const second = refreshPlanSignature(buildRefreshPlan(spec()));
    assert.equal(second, first);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('fractional milliseconds are preserved and unsupported excess precision is rejected', () => {
  const predicate = refreshTimePredicate({
    table: 'events', policy: 'time_window', column: 'created_at', mode: 'rolling',
    amount: 1, unit: 'hours', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.123Z',
  });
  assert.equal(predicate.cutoffUtc, '2026-11-06T12:00:00.123Z');
  const value = spec();
  value.tables = [{
    table: 'events', policy: 'time_window', column: 'created_at', mode: 'rolling',
    amount: 1, unit: 'hours', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.123456Z',
  }];
  assert.throws(() => buildRefreshPlan(value), /exact UTC ISO instant with milliseconds/);
});
