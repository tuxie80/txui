/**
 * Data-type audit (src/utils/typeAudit.ts) — the PostgreSQL sequence/identity
 * ceiling check. PG sequences are always int8 counters; the ceiling that
 * actually bites is the COLUMN's range, so the percentages below are against
 * int4/int2, and unknown last values (no sequence privilege) stay silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPgCeilings } from '../src/utils/typeAudit.ts';

test('under 20% of the range is not a finding', () => {
  const out = auditPgCeilings([{ table: 'public.orders', column: 'id', dataType: 'int', lastValue: 400_000_000 }]);
  assert.equal(out.length, 0);
});

test('the severity ladder follows how much of the range is gone', () => {
  const [yellow, orange, red] = auditPgCeilings([
    { table: 'a', column: 'id', dataType: 'int', lastValue: 1_000_000_000 },   // ~47%
    { table: 'b', column: 'id', dataType: 'int', lastValue: 1_500_000_000 },   // ~70%
    { table: 'c', column: 'id', dataType: 'smallint', lastValue: 31_000 },     // ~95%
  ]);
  assert.equal(yellow.severity, 'yellow');
  assert.equal(orange.severity, 'orange');
  assert.equal(red.severity, 'red');
  assert.match(red.title, /smallint/);
});

test('a bigint column has so much headroom it never fires', () => {
  const out = auditPgCeilings([{ table: 'a', column: 'id', dataType: 'bigint', lastValue: 9e17 }]);
  assert.equal(out.length, 0);
});

test('a NULL last value (no sequence privilege) is unknown, not zero', () => {
  const out = auditPgCeilings([{ table: 'a', column: 'id', dataType: 'int', lastValue: null }]);
  assert.equal(out.length, 0);
});

test('a type without a ceiling is skipped, not crashed on', () => {
  const out = auditPgCeilings([{ table: 'a', column: 'ref', dataType: 'uuid', lastValue: 42 }]);
  assert.equal(out.length, 0);
});

test('the advice names the column and the rewrite', () => {
  const [f] = auditPgCeilings([{ table: 'public.orders', column: 'id', dataType: 'int', lastValue: 2_000_000_000 }]);
  assert.match(f.title, /public\.orders\.id/);
  assert.match(f.detail, /TYPE bigint/);
});
