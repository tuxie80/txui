/**
 * Report detail levels (src/utils/qualityReport.ts).
 *
 * A 45-finding report is unusable at one fixed depth, so the same findings
 * render five ways. The properties that matter, and that these tests pin:
 *
 *  - **one line means one line** — anything else breaks every grep and paste;
 *  - **depth is monotonic** — a higher level never hides what a lower one
 *    showed, or the reader learns not to trust the control;
 *  - **an estimate never reads as a measurement** — the `modelled` flag is the
 *    whole reason `Evidence` carries its source;
 *  - **the floor is independent of the level** — "blockers only, one line" is
 *    a reasonable thing to ask for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderFindings, renderFinding, onelineFinding, atOrAbove, severityCounts,
  buildMarkdown, DETAIL_LEVELS, DETAIL_LABEL, DETAIL_HINT,
} from '../src/utils/qualityReport.ts';
import type { Finding } from '../src/utils/sqlLint.ts';

const RICH: Finding = {
  id: 'D3',
  severity: 'red',
  title: 'orders.customer_id does not match customers.id — signedness differs',
  detail: 'The child column is INT UNSIGNED; the parent is INT.',
  snippet: 'JOIN customers c ON c.id = o.customer_id',
  at: { line: 8, col: 12 },
  why: 'MySQL resolves the comparison by coercion, so the index on the coerced side becomes unusable — silently, with no error and no warning.',
  fix: 'ALTER TABLE orders MODIFY customer_id INT NOT NULL;',
  ruleRef: 'rulebook §1 integers',
  confidence: 'certain',
  evidence: [
    { source: 'information_schema.columns', value: 'orders.customer_id = int unsigned' },
    { source: 'mysql.innodb_table_stats', value: 'n_rows = 14,420,583', age: '3 days old' },
    { source: 'cost model', value: '~721 s', modelled: true },
  ],
  cost: { seconds: 721.03, blockedSeconds: 0.1, rows: 14420583 },
};

const PLAIN: Finding = { id: 'L1', severity: 'yellow', title: 'DISTINCT(col) is not a function', detail: 'It parenthesises an expression.' };
const INFO: Finding = { id: 'L9', severity: 'info', title: 'query uses a CTE', detail: 'Materialised in MySQL 8.' };
const PASSED: Finding = { id: 'A0', severity: 'info', title: 'no missing index detected', detail: 'Every predicate has a usable index.' };

const ALL = [RICH, PLAIN, INFO, PASSED];

// ── the level table ─────────────────────────────────────────────────────────

test('every level has a label and a hint that says what you get', () => {
  for (const l of DETAIL_LEVELS) {
    assert.ok(DETAIL_LABEL[l], l);
    assert.ok(DETAIL_HINT[l].length > 20, l);
  }
  assert.equal(DETAIL_LEVELS.length, 5);
});

// ── oneline ─────────────────────────────────────────────────────────────────

test('one line per finding, and never more than one', () => {
  const out = renderFindings(ALL, { level: 'oneline' }).trimEnd();
  const lines = out.split('\n');
  assert.equal(lines.length, 3, 'three problems, one line each (the passed check is not one)');
  for (const l of lines) assert.doesNotMatch(l, /\n/);
});

test('a one-line entry carries severity, id, position and title', () => {
  const line = onelineFinding(RICH);
  assert.match(line, /^CRITICAL/);
  assert.match(line, /D3/);
  assert.match(line, /L8:12/);
  assert.match(line, /signedness differs$/);
});

test('a title with a newline is flattened rather than allowed to break the format', () => {
  const line = onelineFinding({ ...PLAIN, title: 'two\nlines' });
  assert.equal(line.includes('\n'), false);
  assert.match(line, /two lines/);
});

// ── monotonic depth ─────────────────────────────────────────────────────────

test('each level adds to the one below and takes nothing away', () => {
  const summary = renderFindings(ALL, { level: 'summary' });
  const standard = renderFindings(ALL, { level: 'standard' });
  const deep = renderFindings(ALL, { level: 'deep' });

  // summary: the verdict and the table, no bodies
  assert.match(summary, /3 findings/);
  assert.match(summary, /signedness differs/);          // in the table
  assert.doesNotMatch(summary, /The child column is INT UNSIGNED/);

  // standard: bodies and the fix, not the reasoning
  assert.match(standard, /The child column is INT UNSIGNED/);
  assert.match(standard, /ALTER TABLE orders MODIFY/);
  assert.doesNotMatch(standard, /Why it matters/);

  // deep: reasoning, evidence, citation, confidence
  assert.match(deep, /The child column is INT UNSIGNED/);
  assert.match(deep, /ALTER TABLE orders MODIFY/);
  assert.match(deep, /Why it matters/);
  assert.match(deep, /information_schema\.columns/);
  assert.match(deep, /rulebook §1 integers/);
  assert.match(deep, /confidence: certain/);
});

test('cost is shown as soon as bodies are — it is what a change request needs', () => {
  const standard = renderFindings(ALL, { level: 'standard' });
  assert.match(standard, /~721\.03 s/);
  assert.match(standard, /writes blocked 0\.10 s/);
  assert.match(standard, /14,420,583 rows/);
});

// ── the honesty rule ────────────────────────────────────────────────────────

test('a modelled number says so, and a measured one names its source', () => {
  const deep = renderFinding(RICH, 1, 'deep');
  assert.match(deep, /cost model.*model estimate, not a measurement/);
  assert.match(deep, /mysql\.innodb_table_stats.*n_rows = 14,420,583.*3 days old/);
  // A measured value must not be labelled an estimate.
  const measured = deep.split('\n').find(l => l.includes('information_schema.columns'))!;
  assert.doesNotMatch(measured, /model estimate/);
});

// ── passed checks ───────────────────────────────────────────────────────────

test('passed checks are hidden until forensic, then listed', () => {
  assert.doesNotMatch(renderFindings(ALL, { level: 'deep' }), /Checked & OK/);
  assert.match(renderFindings(ALL, { level: 'forensic' }), /Checked & OK/);
  assert.match(renderFindings(ALL, { level: 'forensic' }), /no missing index detected/);
});

test('passed checks can be forced on at any level, independently', () => {
  const out = renderFindings(ALL, { level: 'standard', showPassed: true });
  assert.match(out, /Checked & OK/);
});

// ── severity floor ──────────────────────────────────────────────────────────

test('the floor keeps everything at least as severe, and nothing below', () => {
  assert.deepEqual(atOrAbove(ALL, 'red').map(f => f.id), ['D3']);
  assert.deepEqual(atOrAbove(ALL, 'yellow').map(f => f.id), ['D3', 'L1']);
  assert.deepEqual(atOrAbove(ALL, 'info').map(f => f.id), ['D3', 'L1', 'L9', 'A0']);
  assert.equal(atOrAbove(ALL).length, 4, 'no floor keeps everything');
});

test('the floor works at every level and says it is filtering', () => {
  const oneline = renderFindings(ALL, { level: 'oneline', floor: 'red' }).trim();
  assert.equal(oneline.split('\n').length, 1);

  const deep = renderFindings(ALL, { level: 'deep', floor: 'red' });
  assert.match(deep, /showing CRITICAL and above/);
  assert.doesNotMatch(deep, /DISTINCT/);
});

test('counts are per severity and add up', () => {
  const c = severityCounts(ALL);
  assert.deepEqual(c, { red: 1, orange: 0, yellow: 1, info: 2 });
});

// ── empty ───────────────────────────────────────────────────────────────────

test('a clean report says so at every level rather than rendering nothing', () => {
  for (const level of DETAIL_LEVELS) {
    assert.match(renderFindings([], { level }), /No problems found/i, level);
  }
});

// ── the whole document ──────────────────────────────────────────────────────

const META = {
  connectionName: 'prod', engine: 'mysql', date: '2026-08-10 17:00',
  sql: 'SELECT 1',
};

test('the terse levels do not paste eight sections under the verdict', () => {
  // Asking for a summary and getting the full document back makes the control
  // look broken.
  const sections = [{ title: 'Execution plan', md: 'PLAN BODY HERE' }];
  assert.doesNotMatch(buildMarkdown(META, ALL, sections, { level: 'summary' }), /PLAN BODY HERE/);
  assert.match(buildMarkdown(META, ALL, sections, { level: 'standard' }), /PLAN BODY HERE/);
});

test('the document defaults to standard, so existing callers are unchanged', () => {
  const sections = [{ title: 'Execution plan', md: 'PLAN BODY HERE' }];
  const def = buildMarkdown(META, ALL, sections);
  assert.match(def, /PLAN BODY HERE/);
  assert.match(def, /The child column is INT UNSIGNED/);
  assert.doesNotMatch(def, /Why it matters/);
});

// ── the assumptions behind the numbers ──────────────────────────────────────

const ASSUMPTIONS_FIXTURE = [
  { name: 'Rebuild throughput', value: '40 MB/s', affects: 'estimated ALTER time' },
  { name: 'Row counts', value: 'optimizer statistics, never COUNT(*)', affects: 'every row figure' },
];

test('forensic prints the constants that produced the numbers', () => {
  // A modelled figure that cannot be checked has to be believed instead — and
  // the estimate is always the one that ends up in a change request.
  const out = renderFindings(ALL, { level: 'forensic', assumptions: ASSUMPTIONS_FIXTURE });
  assert.match(out, /Assumptions behind the numbers/);
  assert.match(out, /Rebuild throughput/);
  assert.match(out, /40 MB\/s/);
  assert.match(out, /never COUNT\(\*\)/);
  assert.match(out, /model estimate, not a measurement/);
});

test('the shallower levels do not carry them', () => {
  for (const level of ['oneline', 'summary', 'standard', 'deep'] as const) {
    assert.doesNotMatch(
      renderFindings(ALL, { level, assumptions: ASSUMPTIONS_FIXTURE }),
      /Assumptions behind the numbers/, level);
  }
});

test('no assumptions supplied, no section — rather than an empty heading', () => {
  assert.doesNotMatch(renderFindings(ALL, { level: 'forensic' }), /Assumptions behind/);
  assert.doesNotMatch(renderFindings(ALL, { level: 'forensic', assumptions: [] }), /Assumptions behind/);
});
