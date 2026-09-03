/**
 * Checking a script before running any of it (src/utils/preflight.ts).
 *
 * The failure this replaces: a twenty-statement script on a read-only
 * connection fails at whichever statement first tries to write. Six have
 * already run, thirteen never will, and the user learns the connection is
 * read-only from statement seven — with state applied and no clean way back.
 *
 * So the property under test is *all or nothing*: every statement is judged
 * before any of them runs, and a single refusal stops the whole script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightScript, shouldPreflight } from '../src/utils/preflight.ts';

const SCRIPT = `SELECT * FROM orders;
UPDATE orders SET total = 0 WHERE id = 1;
SELECT count(*) FROM customers;
DELETE FROM audit_log;
DROP TABLE scratch;`;

// ── read-only ───────────────────────────────────────────────────────────────

test('on a read-only connection every write is refused, before anything runs', () => {
  const r = preflightScript(SCRIPT, { readOnly: true });
  assert.equal(r.total, 5);
  assert.equal(r.blocked, 3, 'the UPDATE, the DELETE and the DROP');
  assert.equal(r.canRun, false);
  for (const row of r.rows.filter(x => x.verdict === 'blocked')) {
    assert.match(row.reason!, /read-only/);
  }
});

test('the reads on a read-only connection are fine, and say nothing', () => {
  const r = preflightScript(SCRIPT, { readOnly: true });
  const reads = r.rows.filter(x => !x.writes);
  assert.equal(reads.length, 2);
  for (const row of reads) {
    assert.equal(row.verdict, 'ok');
    assert.equal(row.reason, undefined);
  }
});

test('the summary leads with the refusal and says nothing has run', () => {
  const r = preflightScript(SCRIPT, { readOnly: true });
  assert.match(r.summary, /3 of 5 statements would be refused/);
  assert.match(r.summary, /nothing has run/);
});

// ── pointing at the statement ───────────────────────────────────────────────

test('every row carries its position and its line', () => {
  // A list of reasons with nothing to point at is not actionable in a
  // hundred-line script.
  const r = preflightScript(SCRIPT, { readOnly: true });
  assert.deepEqual(r.rows.map(x => x.index), [1, 2, 3, 4, 5]);
  assert.deepEqual(r.rows.map(x => x.line), [1, 2, 3, 4, 5]);
});

test('line numbers survive blank lines and comments', () => {
  const doc = `-- setup\n\nSELECT 1;\n\n\nDELETE FROM t;`;
  const r = preflightScript(doc, { readOnly: true });
  const del = r.rows.find(x => x.verdict === 'blocked')!;
  assert.equal(del.line, 6);
});

test('a long statement is previewed, not pasted whole', () => {
  const doc = `UPDATE t SET a = 1 WHERE id IN (${Array.from({ length: 200 }, (_, i) => i).join(',')});`;
  const r = preflightScript(doc, { readOnly: true });
  assert.ok(r.rows[0].preview.length < 130);
  assert.match(r.rows[0].preview, /…$/);
});

// ── production ──────────────────────────────────────────────────────────────

test('on production the hard limits are applied here, not discovered at the server', () => {
  const r = preflightScript(SCRIPT, { environment: 'prod' });
  const drop = r.rows.find(x => x.preview.startsWith('DROP TABLE'))!;
  assert.equal(drop.verdict, 'blocked');
  assert.match(drop.reason!, /destructive DDL is refused on a production connection/);

  const del = r.rows.find(x => x.preview.startsWith('DELETE FROM audit_log'))!;
  assert.equal(del.verdict, 'blocked');
  assert.match(del.reason!, /WHERE-less/);
});

test('the per-connection opt-outs are honoured, or the pre-flight refuses work the server would take', () => {
  const r = preflightScript(SCRIPT, {
    environment: 'prod', allowProdDdl: true, allowUnfilteredWrite: true,
  });
  assert.equal(r.blocked, 0);
  assert.equal(r.canRun, true);
  // Still worth confirming — allowed is not the same as unremarkable.
  assert.ok(r.needConfirm >= 3);
});

test('an ordinary prod write is a confirmation, not a refusal', () => {
  const r = preflightScript('UPDATE orders SET total = 0 WHERE id = 1;', { environment: 'prod' });
  assert.equal(r.rows[0].verdict, 'confirm');
  assert.equal(r.canRun, true);
});

// ── outside production ──────────────────────────────────────────────────────

test('a WHERE-less write off production is flagged but not blocked', () => {
  const r = preflightScript('DELETE FROM t;', {});
  assert.equal(r.rows[0].verdict, 'confirm');
  assert.match(r.rows[0].reason!, /every row is affected/);
  assert.equal(r.canRun, true);
});

test('an ordinary script on an ordinary connection has nothing to say', () => {
  const r = preflightScript('SELECT 1;\nUPDATE t SET a = 1 WHERE id = 2;', {});
  assert.equal(r.blocked, 0);
  assert.equal(r.needConfirm, 0);
  assert.equal(r.canRun, true);
  assert.equal(shouldPreflight(r), false, 'nothing to refuse, nothing to confirm — do not interrupt');
});

// ── when to show it ─────────────────────────────────────────────────────────

test('a single statement is not a script', () => {
  // It already has the write confirmation, which says more about it than a
  // one-row table would.
  const r = preflightScript('DELETE FROM t;', { readOnly: true });
  assert.equal(shouldPreflight(r), false);
});

test('a script with a refusal always interrupts', () => {
  assert.equal(shouldPreflight(preflightScript(SCRIPT, { readOnly: true })), true);
});

// ── splitting ───────────────────────────────────────────────────────────────

test('a custom delimiter keeps a routine body in one piece', () => {
  // Splitting a procedure on `;` would chop it into fragments and report
  // nonsense about each one.
  const doc = `DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;`;
  const r = preflightScript(doc, { readOnly: true, delimiter: ';' });
  const bodies = r.rows.filter(x => x.preview.includes('CREATE PROCEDURE'));
  assert.equal(bodies.length, 1, 'the routine is one statement, not three');
});

test('empty input is not an error', () => {
  const r = preflightScript('   \n\n', { readOnly: true });
  assert.equal(r.total, 0);
  assert.equal(r.canRun, true);
  assert.equal(r.summary, 'Nothing to run.');
});
