/**
 * The SQL Server blocking-chain query's column ORDER is a contract.
 *
 * `LocksPanel` reads that result positionally — `r[0]`…`r[5]` — because the
 * three engines return different column names for the same six facts. So a
 * reordered SELECT list would not fail, it would mislabel: the blocking session
 * shown as the waiting one, a wait time in the query column. Silent, and
 * exactly the kind of wrong a screenshot cannot reveal either.
 *
 * Verified against SQL Server 2022 with a real two-session block: session 70
 * waiting on 68, LCK_M_S, both statements recovered.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/components/LocksPanel.tsx', 'utf8');
const sql = /const MSSQL_WAITS_SQL = `([\s\S]*?)`\.trim\(\)/.exec(src)?.[1] ?? '';

describe('SQL Server blocking-chain query', () => {
  test('the query is present and non-trivial', () => {
    assert.ok(sql.length > 200, 'MSSQL_WAITS_SQL not found in LocksPanel.tsx');
  });

  test('the six columns are aliased in the order the panel indexes them', () => {
    const aliases = [...sql.matchAll(/AS\s+(\w+)/g)].map(m => m[1]);
    assert.deepEqual(aliases, [
      'waiting_pid', 'waiting_query', 'blocking_pid',
      'blocking_query', 'wait_secs', 'detail',
    ], 'LocksPanel reads these positionally — reordering silently mislabels rows');
  });

  test('it asks the DMV that actually knows who blocks whom', () => {
    // dm_exec_requests.blocking_session_id covers only requests; a task can
    // wait without one, so the waiting-tasks DMV is the authority.
    assert.match(sql, /sys\.dm_os_waiting_tasks/);
  });

  test('the blocker text comes from most_recent_sql_handle', () => {
    // A blocker is usually idle inside an open transaction and has no CURRENT
    // request — which is precisely the case worth showing.
    assert.match(sql, /most_recent_sql_handle/);
  });

  test('text lookups are OUTER APPLY, so a missing plan does not hide the row', () => {
    assert.ok(!/CROSS APPLY/.test(sql),
      'CROSS APPLY would drop the whole chain when a sql_handle has aged out');
    assert.equal((sql.match(/OUTER APPLY/g) ?? []).length, 2);
  });

  test('a session blocking itself is excluded', () => {
    assert.match(sql, /blocking_session_id\s*<>\s*wt\.session_id/);
  });
});
