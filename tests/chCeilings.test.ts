/**
 * ClickHouse memory / row ceilings (src/utils/connUrl.ts).
 *
 * These bound RAM and rows-read on a query; `max_execution_time` bounds only
 * time, which won't stop an OOM. The form stores them in `extra_params` under
 * their ClickHouse names, and the rule must match the backend: blank / zero /
 * negative / non-integer means "no limit" and omits the key entirely, so a
 * connection that never set a ceiling behaves exactly as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickhouseCeilingParams, CH_CEILING_KEYS } from '../src/utils/connUrl.ts';

test('valid positive integers become extra_params entries', () => {
  assert.deepEqual(
    clickhouseCeilingParams('1000000000', '500000'),
    { max_memory_usage: '1000000000', max_rows_to_read: '500000' },
  );
});

test('blank / zero / negative / non-integer means no limit and omits the key', () => {
  assert.deepEqual(clickhouseCeilingParams('', ''), {});
  assert.deepEqual(clickhouseCeilingParams('0', '0'), {});
  assert.deepEqual(clickhouseCeilingParams('-5', '-1'), {});
  assert.deepEqual(clickhouseCeilingParams('1.5', 'abc'), {});
});

test('the two ceilings are independent', () => {
  assert.deepEqual(clickhouseCeilingParams('2000000', ''), { max_memory_usage: '2000000' });
  assert.deepEqual(clickhouseCeilingParams('', '10000'), { max_rows_to_read: '10000' });
});

test('surrounding whitespace is tolerated', () => {
  assert.deepEqual(clickhouseCeilingParams('  4096 ', ' 42 '),
    { max_memory_usage: '4096', max_rows_to_read: '42' });
});

test('the managed keys are exactly the two the form owns', () => {
  assert.deepEqual([...CH_CEILING_KEYS], ['max_memory_usage', 'max_rows_to_read']);
});
