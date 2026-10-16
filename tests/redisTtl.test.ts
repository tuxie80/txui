/**
 * TTL decisions for the Redis key browser (src/utils/redisTtl.ts).
 *
 * Pin the two failure modes the editor used to have: a value edit wiping the
 * TTL (SET without EX removes it), and TTL 0 deleting the key with no
 * confirmation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTtlInput, ttlToPreserveOnEdit } from '../src/utils/redisTtl.ts';

test('a positive TTL passes through unchanged', () => {
  assert.deepEqual(validateTtlInput('300'), { ok: true, secs: 300 });
  assert.deepEqual(validateTtlInput(' 60 '), { ok: true, secs: 60 });
});

test('-1 and empty both mean persist', () => {
  assert.deepEqual(validateTtlInput('-1'), { ok: true, secs: -1 });
  assert.deepEqual(validateTtlInput(''), { ok: true, secs: -1 });
  assert.deepEqual(validateTtlInput('  '), { ok: true, secs: -1 });
});

test('TTL 0 is refused — EXPIRE key 0 deletes the key immediately', () => {
  const r = validateTtlInput('0');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /deletes the key immediately/);
});

test('negatives other than -1 are not Redis TTLs', () => {
  const r = validateTtlInput('-5');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /-1 \(persistent\)/);
});

test('non-numeric input is rejected, not truncated by parseInt', () => {
  for (const bad of ['abc', '12x', '1.5', '0x10']) {
    const r = validateTtlInput(bad);
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.match(r.error, /whole number/);
  }
});

test('an edit preserves the TTL the key already has', () => {
  assert.equal(ttlToPreserveOnEdit(300), 300);
});

test('a persistent or gone key sends no TTL — SET must not invent one', () => {
  assert.equal(ttlToPreserveOnEdit(-1), null);
  assert.equal(ttlToPreserveOnEdit(-2), null);
  assert.equal(ttlToPreserveOnEdit(0), null);
});
