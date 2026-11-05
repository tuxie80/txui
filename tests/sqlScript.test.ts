import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySqlScriptEvent, compressionForSqlScript, formatSqlScriptBytes,
  initialSqlScriptState, sqlScriptPercent, validSqlScriptLimitMiB,
  SQL_SCRIPT_LOG_LIMIT, type SqlScriptEvent,
} from '../src/utils/sqlScript.ts';

const started: SqlScriptEvent = {
  type: 'started', path: '/tmp/flashback.sql.gz', compression: 'gzip',
  source_total: 1000, database: 'shop', max_statement_bytes: 64 * 1024 * 1024,
};

test('source compression and statement limits are explicit', () => {
  assert.equal(compressionForSqlScript('flashback.sql.gz'), 'gzip');
  assert.equal(compressionForSqlScript('FLASHBACK.SQL.GZ'), 'gzip');
  assert.equal(compressionForSqlScript('flashback.sql'), 'plain');
  assert.equal(compressionForSqlScript('archive.tar'), 'plain');
  for (const n of [1, 64, 1024]) assert.equal(validSqlScriptLimitMiB(n), true);
  for (const n of [0, -1, 1025, 1.5, NaN]) assert.equal(validSqlScriptLimitMiB(n), false);
});

test('byte formatting and compressed progress never invent an uncompressed percentage', () => {
  assert.equal(formatSqlScriptBytes(0), '0 B');
  assert.equal(formatSqlScriptBytes(1024), '1.00 KiB');
  assert.equal(formatSqlScriptBytes(64 * 1024 * 1024), '64.0 MiB');
  assert.equal(sqlScriptPercent(0, 1000), 0);
  assert.equal(sqlScriptPercent(250, 1000), 25);
  assert.equal(sqlScriptPercent(2000, 1000), 100);
  assert.equal(sqlScriptPercent(0, 0), 0);
});

test('started resets every counter and stale done state', () => {
  const old = applySqlScriptEvent(initialSqlScriptState(), {
    type: 'done', ok: false, cancelled: false, partial: true, ms: 10,
    statements: 3, executed: 2, failed: 1, rows_affected: 4,
    uncompressed_bytes: 500, error: 'old',
  });
  const next = applySqlScriptEvent(old, started);
  assert.equal(next.phase, 'validating');
  assert.equal(next.done, null);
  assert.equal(next.sourceTotal, 1000);
  assert.equal(next.database, 'shop');
  assert.equal(next.executed, 0);
  assert.equal(next.log.length, 1);
});

test('progress carries phase, source, statements, rows, line and backend id', () => {
  let state = applySqlScriptEvent(initialSqlScriptState(), started);
  state = applySqlScriptEvent(state, { type: 'phase', phase: 'executing', statements_total: 12 });
  state = applySqlScriptEvent(state, {
    type: 'progress', phase: 'executing', source_bytes: 500, source_total: 1000,
    uncompressed_bytes: 9000, statements_seen: 7, statements_total: 12,
    executed: 6, failed: 1, rows_affected: 120, current_line: 42, backend_id: 4711,
  });
  assert.equal(state.phase, 'executing');
  assert.equal(sqlScriptPercent(state.sourceBytes, state.sourceTotal), 50);
  assert.equal(state.uncompressedBytes, 9000);
  assert.equal(state.statementsSeen, 7);
  assert.equal(state.statementsTotal, 12);
  assert.equal(state.executed, 6);
  assert.equal(state.failed, 1);
  assert.equal(state.rowsAffected, 120);
  assert.equal(state.currentLine, 42);
  assert.equal(state.backendId, 4711);
});

test('statement events expose exact per-statement numbers without storing SQL', () => {
  let state = applySqlScriptEvent(initialSqlScriptState(), started);
  state = applySqlScriptEvent(state, {
    type: 'statement_done', number: 1, line: 10, bytes: 2048, rows_affected: 3, ms: 17,
  });
  state = applySqlScriptEvent(state, { type: 'statement_error', number: 2, line: 20, message: 'bad SQL' });
  assert.match(state.log[1].text, /#1 · line 10 · 2\.00 KiB · 3 rows affected · 17 ms/);
  assert.match(state.log[2].text, /#2 · line 20 · bad SQL/);
  assert.equal(state.log.some(l => l.text.includes('INSERT INTO')), false);
});

test('done distinguishes success, cancellation and possible partial writes', () => {
  const base = applySqlScriptEvent(initialSqlScriptState(), started);
  const cancelled = applySqlScriptEvent(base, {
    type: 'done', ok: false, cancelled: true, partial: true, ms: 50,
    statements: 4, executed: 2, failed: 0, rows_affected: 2,
    uncompressed_bytes: 100, error: 'cancelled',
  });
  assert.equal(cancelled.phase, 'done');
  assert.deepEqual(cancelled.done, { ok: false, cancelled: true, partial: true, ms: 50, error: 'cancelled' });
  assert.match(cancelled.log.at(-1)!.text, /^Cancelled: 2 executed, 0 failed/);
  assert.match(cancelled.log.at(-1)!.text, /not rolled back/);

  const ok = applySqlScriptEvent(base, {
    type: 'done', ok: true, cancelled: false, partial: false, ms: 50,
    statements: 4, executed: 4, failed: 0, rows_affected: 2,
    uncompressed_bytes: 100, error: null,
  });
  assert.equal(ok.done?.ok, true);
  assert.match(ok.log.at(-1)!.text, /^Completed: 4 executed/);
});

test('log retention is bounded', () => {
  let state = initialSqlScriptState();
  for (let i = 0; i < SQL_SCRIPT_LOG_LIMIT + 10; i++) {
    state = applySqlScriptEvent(state, {
      type: 'statement_done', number: i, line: i, bytes: 1, rows_affected: 1, ms: 1,
    });
  }
  assert.equal(state.log.length, SQL_SCRIPT_LOG_LIMIT);
  assert.match(state.log[0].text, /#10 ·/);
  assert.match(state.log.at(-1)!.text, new RegExp(`#${SQL_SCRIPT_LOG_LIMIT + 9} ·`));
});
