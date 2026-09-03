/**
 * Diagnostic quick-fixes (src/utils/sqlQuickFix.ts).
 *
 * A quick-fix edits the user's SQL, so the bar is higher than for a warning: a
 * wrong fix is worse than no fix, because it gets applied without being read.
 * The two things these tests defend:
 *
 *   1. **A fix never inverts meaning.** `!= NULL` must become `IS NOT NULL`,
 *      not `IS NULL` — that one character is the whole query.
 *   2. **A fix never guesses.** Where several answers exist (which table to
 *      qualify with), each is offered by name; where none is certain (what the
 *      WHERE condition should be), the fix positions the caret and stops.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixesFor, applyEdits, ownersFromMessage, statementEnd, hasFix,
} from '../src/utils/sqlQuickFix.ts';
import { diagnose, emptyDiagContext } from '../src/utils/sqlDiagnostics.ts';
import type { Diagnostic } from '../src/utils/sqlDiagnostics.ts';

/** Run the real diagnostics, so fixes are tested against real offsets. */
function diagFor(sql: string, code: string): { diag: Diagnostic; sql: string } {
  const all = diagnose(sql, emptyDiagContext());
  const diag = all.find(d => d.code === code);
  assert.ok(diag, `no \`${code}\` diagnostic for: ${sql}\n(got ${all.map(d => d.code).join(', ')})`);
  return { diag, sql };
}

const fixed = (sql: string, code: string, pick = 0) => {
  const { diag } = diagFor(sql, code);
  const fixes = fixesFor(diag, sql);
  assert.ok(fixes.length > pick, `no fix ${pick} for ${code}`);
  return applyEdits(sql, fixes[pick].edits);
};

// ── = NULL, where inverting the meaning is one character away ───────────────

test('= NULL becomes IS NULL', () => {
  assert.equal(fixed('SELECT * FROM t WHERE a = NULL', 'eq-null'),
    'SELECT * FROM t WHERE a IS NULL');
});

test('!= NULL becomes IS NOT NULL, not IS NULL', () => {
  // Getting this backwards inverts the query and the result still looks fine.
  assert.equal(fixed('SELECT * FROM t WHERE a != NULL', 'eq-null'),
    'SELECT * FROM t WHERE a IS NOT NULL');
  assert.equal(fixed('SELECT * FROM t WHERE a <> NULL', 'eq-null'),
    'SELECT * FROM t WHERE a IS NOT NULL');
});

// ── mechanical fixes ────────────────────────────────────────────────────────

test('a trailing comma is removed without disturbing the spacing', () => {
  assert.equal(fixed('SELECT a, b, FROM t', 'comma-before-from'),
    'SELECT a, b FROM t');
});

test('an unterminated string is closed at the end of the LINE', () => {
  // Closing at the end of the document would swallow every later statement.
  const out = fixed("SELECT 'oops\nSELECT 1", 'unterminated-string');
  assert.equal(out, "SELECT 'oops'\nSELECT 1");
});

test('an unclosed paren offers both closing it and deleting it', () => {
  const { diag } = diagFor('SELECT count(a FROM t', 'unbalanced-paren');
  const fixes = fixesFor(diag, 'SELECT count(a FROM t');
  assert.equal(fixes.length, 2);
  assert.equal(applyEdits('SELECT count(a FROM t', fixes[0].edits), 'SELECT count(a FROM t)');
  assert.equal(applyEdits('SELECT count(a FROM t', fixes[1].edits), 'SELECT counta FROM t');
});

// ── fixes that must NOT guess ───────────────────────────────────────────────

test('an ambiguous column offers every candidate by name, and picks none', () => {
  const diag: Diagnostic = {
    from: 7, to: 9, severity: 'warning', code: 'ambiguous-column',
    message: '“id” exists in orders and customers — qualify it.',
  };
  const sql = 'SELECT id FROM orders JOIN customers ON 1=1';
  const fixes = fixesFor(diag, sql);
  assert.equal(fixes.length, 2, 'both tables should be offered');
  assert.deepEqual(fixes.map(f => f.title),
    ['Qualify as orders.id', 'Qualify as customers.id']);
  assert.equal(applyEdits(sql, fixes[0].edits),
    'SELECT orders.id FROM orders JOIN customers ON 1=1');
  assert.equal(applyEdits(sql, fixes[1].edits),
    'SELECT customers.id FROM orders JOIN customers ON 1=1');
});

test('candidates come from the message, not a second implementation', () => {
  // Re-deriving them here could disagree with the squiggle on screen.
  assert.deepEqual(
    ownersFromMessage('“id” exists in orders and customers — qualify it.'),
    ['orders', 'customers']);
  assert.deepEqual(ownersFromMessage('something else entirely'), []);
});

test('a WHERE-less write gets the keyword and a caret, not an invented predicate', () => {
  const sql = 'UPDATE orders SET paid = true';
  const { diag } = diagFor(sql, 'write-without-where');
  const [fix] = fixesFor(diag, sql);
  assert.equal(applyEdits(sql, fix.edits), 'UPDATE orders SET paid = true WHERE ');
  assert.equal(fix.complete, false, 'the problem is not solved until a condition is typed');
  assert.equal(fix.caret, 'UPDATE orders SET paid = true WHERE '.length);
});

test('WHERE lands before the semicolon, not after it', () => {
  const sql = 'UPDATE orders SET paid = true;';
  const { diag } = diagFor(sql, 'write-without-where');
  const [fix] = fixesFor(diag, sql);
  assert.equal(applyEdits(sql, fix.edits), 'UPDATE orders SET paid = true WHERE ;');
});

test('a JOIN with no ON offers the condition AND the explicit cross join', () => {
  // A cartesian product is occasionally what was meant.
  const sql = 'SELECT * FROM a JOIN b';
  const { diag } = diagFor(sql, 'join-without-on');
  const fixes = fixesFor(diag, sql);
  assert.equal(fixes.length, 2);
  assert.equal(applyEdits(sql, fixes[0].edits), 'SELECT * FROM a JOIN b ON ');
  assert.equal(fixes[0].complete, false);
  assert.equal(applyEdits(sql, fixes[1].edits), 'SELECT * FROM a CROSS JOIN b');
  assert.equal(fixes[1].complete, true);
});

// ── mechanics ───────────────────────────────────────────────────────────────

test('edits apply right-to-left so earlier offsets stay valid', () => {
  const out = applyEdits('abcdef', [
    { from: 1, to: 2, insert: 'X' },
    { from: 4, to: 5, insert: 'YY' },
  ]);
  assert.equal(out, 'aXcdYYf');
});

test('applying no edits changes nothing', () => {
  assert.equal(applyEdits('SELECT 1', []), 'SELECT 1');
});

test('statementEnd stops at a top-level semicolon and trims whitespace', () => {
  assert.equal(statementEnd('UPDATE t SET a=1 ;', 0), 16);
  assert.equal(statementEnd('UPDATE t SET a=1', 0), 16);
  // A semicolon inside a string is not the end.
  assert.equal(statementEnd("UPDATE t SET a=';'", 0), 18);
  // Nor is one inside parentheses.
  assert.equal(statementEnd('UPDATE t SET a=f(1;2)', 0), 21);
});

test('hasFix agrees with what fixesFor actually returns', () => {
  // A gutter marker that promises a fix and then offers none is worse than no
  // marker at all.
  const cases: Array<[string, string]> = [
    ['eq-null', 'SELECT * FROM t WHERE a = NULL'],
    ['comma-before-from', 'SELECT a, FROM t'],
    ['write-without-where', 'DELETE FROM t'],
    ['join-without-on', 'SELECT * FROM a JOIN b'],
  ];
  for (const [code, sql] of cases) {
    assert.ok(hasFix(code), `${code} should be marked fixable`);
    const { diag } = diagFor(sql, code);
    assert.ok(fixesFor(diag, sql).length > 0, `${code} promised a fix and gave none`);
  }
  assert.equal(hasFix('full-scan'), false, 'an advisory finding has no mechanical fix');
});

test('a diagnostic with no fix returns an empty list rather than throwing', () => {
  const diag: Diagnostic = {
    from: 0, to: 1, severity: 'info', code: 'full-scan', message: 'x',
  };
  assert.deepEqual(fixesFor(diag, 'SELECT 1'), []);
});

test('every fix has a title that reads as an action', () => {
  const sql = 'UPDATE orders SET a = NULL';
  for (const d of diagnose(sql, emptyDiagContext())) {
    for (const f of fixesFor(d, sql)) {
      assert.ok(f.title.length > 4, `${d.code}: "${f.title}"`);
      assert.match(f.title, /^[A-Z]/, `${d.code}: a title should start with a verb`);
    }
  }
});
