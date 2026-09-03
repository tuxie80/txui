/**
 * Multi-statement runs (src/utils/scriptRun.ts).
 *
 * Every rule here exists because the failure it prevents is *silent*. The
 * summary tests in particular guard a real bug this module was written to fix:
 * a PostgreSQL script that ignored one failure inside a transaction used to
 * report "finished with 1 failed statement (ignored)" while the server had in
 * fact committed nothing at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCancellation, isAbortedTransaction, txEffect, needsSavepoint, summarise, fmt,
  CANCEL_MESSAGE, needsDecision, defaultChoice, applyChoice, tally,
  scriptResultTabs, scriptResultFor } from '../src/utils/scriptRun.ts';
import type { RunLine } from '../src/utils/scriptRun.ts';
import type { RunOutcome } from '../src/utils/scriptRun.ts';
import type { QueryResult } from '../src/types/index.ts';

const out = (o: Partial<RunOutcome> = {}): RunOutcome => ({
  total: 10, ok: 10, failed: 0, skipped: 0,
  statementMs: 100, wallMs: 100,
  cancelled: false, transactionOpen: false, transactionPoisoned: false, ...o,
});

// ── a cancel is not a failure ───────────────────────────────────────────────

test('the backend cancel message is recognised', () => {
  // Otherwise pressing Cancel opens a modal asking whether to ignore the
  // statement you just cancelled.
  assert.ok(isCancellation(new Error(CANCEL_MESSAGE)));
  assert.ok(isCancellation('Query cancelled'));
});

test('a statement TIMEOUT is not treated as a cancel', () => {
  // PostgreSQL says "canceling statement due to statement timeout". A loose
  // /cancel/i match would swallow a real failure the user must be told about.
  assert.ok(!isCancellation('canceling statement due to statement timeout'));
  assert.ok(!isCancellation('ERROR: canceling statement due to user request'));
});

test('an unrelated error is not a cancel', () => {
  assert.ok(!isCancellation('syntax error at or near "slect"'));
});

// ── the poisoned-transaction detector ───────────────────────────────────────

test('PostgreSQL 25P02 is recognised by code and by wording', () => {
  assert.ok(isAbortedTransaction('ERROR 25P02: whatever'));
  assert.ok(isAbortedTransaction(
    'current transaction is aborted, commands ignored until end of transaction block'));
  assert.ok(!isAbortedTransaction('relation "t" does not exist'));
});

// ── transaction tracking ────────────────────────────────────────────────────

test('BEGIN and START TRANSACTION open one', () => {
  assert.equal(txEffect('BEGIN'), 'begin');
  assert.equal(txEffect('  begin;'), 'begin');
  assert.equal(txEffect('START TRANSACTION'), 'begin');
  assert.equal(txEffect('start   transaction read write'), 'begin');
});

test('COMMIT, ROLLBACK and END close one', () => {
  assert.equal(txEffect('COMMIT'), 'end');
  assert.equal(txEffect('rollback;'), 'end');
  assert.equal(txEffect('END'), 'end');
});

test('an ordinary statement changes nothing', () => {
  assert.equal(txEffect('SELECT 1'), null);
  assert.equal(txEffect('INSERT INTO t VALUES (1)'), null);
});

test('a word merely STARTING with begin is not a BEGIN', () => {
  // `SELECT beginning FROM t` must not be read as opening a transaction, or
  // every later statement pays for savepoints it does not need.
  assert.equal(txEffect('SELECT beginning FROM t'), null);
  assert.equal(txEffect('SELECT commits FROM t'), null);
});

// ── savepoints, only where they are needed ──────────────────────────────────

test('savepoints are taken on PostgreSQL inside a transaction, and nowhere else', () => {
  assert.equal(needsSavepoint('postgres', true), true);
  assert.equal(needsSavepoint('postgres', false), false);
  // MySQL leaves the transaction usable after an error; COMMIT still commits.
  assert.equal(needsSavepoint('mysql', true), false);
  assert.equal(needsSavepoint('sqlite', true), false);
});

// ── the summary, which is where the old bug showed ──────────────────────────

test('a poisoned transaction says NOTHING WAS COMMITTED, first', () => {
  // The old summary said "finished with 1 failed statement (ignored)", which
  // reads as success. The server had committed nothing.
  const s = summarise(out({ total: 10, ok: 2, failed: 8, skipped: 0, transactionPoisoned: true }));
  assert.equal(s.level, 'error');
  assert.match(s.text, /^NOTHING WAS COMMITTED/);
  assert.match(s.text, /roll/i);
});

test('an open transaction is called out even when everything succeeded', () => {
  // Ten green ticks and no mention that none of it is durable is how work gets
  // lost to a disconnect.
  const s = summarise(out({ transactionOpen: true }));
  assert.match(s.text, /NOT COMMITTED/);
  assert.equal(s.level, 'warn');
});

test('a clean run reads as a clean run', () => {
  const s = summarise(out());
  assert.equal(s.level, 'ok');
  assert.match(s.text, /10 statements completed/);
  assert.ok(!/NOT COMMITTED/.test(s.text));
});

test('a cancelled run says how far it got', () => {
  const s = summarise(out({ ok: 3, total: 10, skipped: 7, cancelled: true }));
  assert.equal(s.level, 'warn');
  assert.match(s.text, /Cancelled after 3 of 10/);
});

test('failures with skips rank as an error, without them as a warning', () => {
  assert.equal(summarise(out({ ok: 9, failed: 1, total: 10 })).level, 'warn');
  assert.equal(summarise(out({ ok: 2, failed: 1, skipped: 7, total: 10 })).level, 'error');
});

test('wall time is shown only when it differs meaningfully from statement time', () => {
  // The gap is time spent waiting on the error prompt. Printing two identical
  // numbers side by side is noise.
  assert.ok(!summarise(out({ statementMs: 1000, wallMs: 1050 })).text.includes('wall'));
  assert.match(summarise(out({ statementMs: 1000, wallMs: 9000 })).text, /wall/);
});

test('durations read the way a person says them', () => {
  assert.equal(fmt(643), '643 ms');
  assert.equal(fmt(14253), '14 s 253 ms');
  assert.equal(fmt(2000), '2 s');
  assert.equal(fmt(123000), '2 min 3 s');
  assert.equal(fmt(0), '0 ms');
  assert.equal(fmt(-5), '0 ms');
});

// ── the failure decision ────────────────────────────────────────────────────

test('"ignore all" from an earlier statement outranks the preference', () => {
  // Someone who answered "ignore all" at statement 3 has said what they want
  // for the rest of the run; re-reading the preference would ask them again.
  assert.equal(needsDecision('ask', true), false);
  assert.equal(defaultChoice('ask', true), 'ignore');
});

test('only the "ask" mode prompts', () => {
  assert.equal(needsDecision('ask', false), true);
  assert.equal(needsDecision('ignore', false), false);
  assert.equal(needsDecision('stop', false), false);
});

test('the standing choice matches the mode', () => {
  assert.equal(defaultChoice('ignore', false), 'ignore');
  assert.equal(defaultChoice('stop', false), 'stop');
});

test('an unanswered prompt defaults to stopping, not continuing', () => {
  // The safe direction: a script that stops early can be re-run, one that
  // ploughed on cannot be un-run.
  assert.equal(defaultChoice('stop', false), 'stop');
  assert.deepEqual(applyChoice('stop'), { keepGoing: false, ignoreRest: false });
});

test('"ignore all" both continues and latches', () => {
  assert.deepEqual(applyChoice('ignore-all'), { keepGoing: true, ignoreRest: true });
  // A plain "ignore" continues but does NOT latch — the next failure asks again.
  assert.deepEqual(applyChoice('ignore'), { keepGoing: true, ignoreRest: false });
});

// ── the tally ───────────────────────────────────────────────────────────────

const L = (status: RunLine['status'], ms?: number): RunLine => ({ status, ms });

test('the tally counts what the user is looking at', () => {
  const o = tally([L('ok', 10), L('error', 5), L('skipped'), L('ok', 20)],
    { wallMs: 100, cancelled: false, transactionOpen: false, transactionPoisoned: false });
  assert.equal(o.total, 4);
  assert.equal(o.ok, 2);
  assert.equal(o.failed, 1);
  assert.equal(o.skipped, 1);
  assert.equal(o.statementMs, 35);
});

test('a cancel that rewrote later lines is counted from the lines', () => {
  // The bug this shape avoids: a running `oks` counter never sees the lines a
  // cancel rewrote to `skipped`, so the summary and the list disagree.
  const o = tally([L('ok', 10), L('skipped'), L('skipped')],
    { wallMs: 50, cancelled: true, transactionOpen: false, transactionPoisoned: false });
  assert.equal(o.ok, 1);
  assert.equal(o.skipped, 2);
  assert.equal(summarise(o).text.startsWith('Cancelled after 1 of 3'), true);
});

test('statements with no recorded time do not make the total NaN', () => {
  const o = tally([L('ok'), L('ok', 5)],
    { wallMs: 10, cancelled: false, transactionOpen: false, transactionPoisoned: false });
  assert.equal(o.statementMs, 5);
});

test('an empty run tallies to zero rather than throwing', () => {
  const o = tally([], { wallMs: 0, cancelled: false, transactionOpen: false, transactionPoisoned: false });
  assert.equal(o.total, 0);
  assert.equal(summarise(o).level, 'ok');
});

// ── result tabs: which lines earn a "Result N" tab ─────────────────────────

const col = (name: string) => ({ name, type_name: 'INT', nullable: true });
function qr(partial: Partial<QueryResult>): QueryResult {
  return {
    columns: [], rows: [], rows_affected: null,
    execution_ms: 0, fetch_ms: 0, warnings: [],
    ...partial,
  };
}

test('row-producing statements get tabs, in run order; no-output ones do not', () => {
  // The shape the user asked for: SELECT, ANALYZE, SELECT → Result 1 and
  // Result 2, and the ANALYZE stays a feedback line. A tab per no-output
  // statement is how a maintenance script ends in a wall of empty tabs.
  const lines = [
    { text: 'show processlist', result: qr({ columns: [col('Id')], rows: [[1]] }) },
    { text: 'analyze table t', result: qr({ rows_affected: 0 }) },
    { text: 'show global status like \'%uptime%\'', result: qr({ columns: [col('Variable_name')], rows: [['Uptime', 7]] }) },
  ];
  assert.deepEqual(scriptResultTabs(lines), [0, 2]);
});

test('a SELECT with zero rows still gets a tab (its columns are the answer)', () => {
  const lines = [{ text: 'select a from t where 1=0', result: qr({ columns: [col('a')] }) }];
  assert.deepEqual(scriptResultTabs(lines), [0]);
});

test('a write with a count is a feedback line, not a tab', () => {
  const lines = [{ text: 'update t set a = 1', result: qr({ rows_affected: 3 }) }];
  assert.deepEqual(scriptResultTabs(lines), []);
});

test('a closed result drops out of the tab list', () => {
  // Closing Result 1 clears that line's result; the line index of Result 2
  // must not move, or the open tab would suddenly show a different statement.
  const lines = [
    { text: 'select 1', result: qr({ columns: [col('a')], rows: [[1]] }) },
    { text: 'select 2', result: qr({ columns: [col('b')], rows: [[2]] }) },
  ];
  assert.deepEqual(scriptResultTabs(lines), [0, 1]);
  lines[0].result = undefined;
  assert.deepEqual(scriptResultTabs(lines), [1]);
});

test('pending / failed / resultless lines earn nothing', () => {
  assert.deepEqual(scriptResultTabs([{ text: 'select 1' }]), []);
  assert.deepEqual(scriptResultTabs([]), []);
});

test('a "no result tabs" run keeps the row count but earns no tab', () => {
  // The exact shape executeSql builds under noResults (F9): rows counted,
  // result dropped, `discarded` noted so the overview can say so where the
  // Result N link would be. No line may earn a tab, however row-producing.
  const lines = [
    { text: 'select sleep(2)', rows: 1, discarded: true },
    { text: 'analyze table t', rows: 1 },
    { text: 'select 1', rows: 1, discarded: true },
  ];
  assert.deepEqual(scriptResultTabs(lines), []);
});

// ── scriptResultFor: the single keep-vs-drop decision point ─────────────────

test('noResults: a rows-kind result is dropped and noted as discarded', () => {
  const res = qr({ columns: [col('sleep(2)')], rows: [[0]] });
  const out = scriptResultFor(res, 'select sleep(2)', true, 5000);
  assert.equal(out.result, undefined, 'the row set must not survive');
  assert.equal(out.discarded, true, 'the overview notes the discarded result');
  // …and a line built from it earns no Result tab
  assert.deepEqual(scriptResultTabs([{ text: 'select sleep(2)', ...out }]), []);
});

test('noResults: a write/DDL result needs no note (nothing was withheld)', () => {
  const out = scriptResultFor(qr({ rows_affected: 0 }), 'analyze table t', true, 5000);
  assert.equal(out.result, undefined);
  assert.equal(out.discarded, undefined,
    'ANALYZE never had a Result tab to lose — a note would be noise');
});

test('a normal run keeps the result, capped at keepRows', () => {
  const big = qr({ columns: [col('a')], rows: Array.from({ length: 6000 }, (_, i) => [i]) });
  const out = scriptResultFor(big, 'select a from t', false, 5000);
  assert.equal(out.result?.rows.length, 5000, 'capped');
  assert.equal(out.discarded, undefined);
  const small = scriptResultFor(qr({ columns: [col('a')], rows: [[1]] }), 'select 1', false, 5000);
  assert.equal(small.result?.rows.length, 1, 'small results pass through whole');
});
