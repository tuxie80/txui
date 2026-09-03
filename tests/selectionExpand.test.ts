/**
 * Semantic expand selection (utils/selectionExpand.ts).
 *
 * The ladder is exercised the way the editor drives it: expandRange from a
 * bare caret, then repeatedly from the range it returned — each step must
 * strictly contain the previous one until the whole document is reached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRange, expandSteps } from '../src/utils/selectionExpand.ts';

/** Walk the ladder from a caret until it stops; returns every range's text. */
function climb(doc: string, pos: number, delimiter = ';'): string[] {
  const out: string[] = [];
  let from = pos, to = pos;
  for (;;) {
    const next = expandRange(doc, from, to, delimiter);
    if (!next) return out;
    out.push(doc.slice(next.from, next.to));
    from = next.from;
    to = next.to;
  }
}

test('caret on a word: word → dotted chain → statement → document', () => {
  const doc = 'SELECT id FROM shop.orders;';
  const pos = doc.indexOf('orders') + 2;
  // The statement IS the whole document here, so the document step adds
  // nothing and the ladder ends at the statement.
  assert.deepEqual(climb(doc, pos), ['orders', 'shop.orders', doc]);
});

test('caret just past the last letter still expands the word', () => {
  const doc = 'SELECT name FROM t;';
  const pos = doc.indexOf('name') + 4; // caret right after "name"
  assert.deepEqual(climb(doc, pos)[0], 'name');
});

test('inside a string: content first, then the quotes, then the statement', () => {
  const doc = "SELECT * FROM t WHERE note = 'hello world';";
  const pos = doc.indexOf('world');
  assert.deepEqual(climb(doc, pos), [
    'hello world', "'hello world'", doc,
  ]);
  // no bare "world" step — a word inside a literal is not an identifier
  assert.ok(!climb(doc, pos).includes('world'));
});

test('escaped quotes do not end the string early', () => {
  const doc = "SELECT * FROM t WHERE a = 'it''s fine' AND b = 1;";
  const pos = doc.indexOf('fine');
  const steps = climb(doc, pos);
  assert.equal(steps[0], "it''s fine");
  assert.equal(steps[1], "'it''s fine'");
});

test('backslash-escaped quote inside a string is not the closer', () => {
  const doc = "SELECT * FROM t WHERE a = 'it\\'s';";
  const pos = doc.indexOf('t\\');
  assert.equal(climb(doc, pos)[0], "it\\'s");
});

test('paren group: content, then the parens, then the statement', () => {
  const doc = 'SELECT * FROM t WHERE id IN (1, 2, 3);';
  const pos = doc.indexOf('2');
  assert.deepEqual(climb(doc, pos), [
    '2', '1, 2, 3', '(1, 2, 3)', doc,
  ]);
});

test('nested parens climb one level at a time', () => {
  const doc = 'SELECT * FROM t WHERE f(g(1 + 2)) > 0;';
  const pos = doc.indexOf('2');
  const steps = climb(doc, pos);
  // word → inner content → inner parens → outer content → outer parens → stmt
  assert.deepEqual(steps.slice(0, 5), ['2', '1 + 2', '(1 + 2)', 'g(1 + 2)', '(g(1 + 2))']);
  assert.equal(steps[steps.length - 1], doc);
});

test('parens inside strings and comments never count as a group', () => {
  // The '(' in the string and the ')' in the comment must not pair up or
  // swallow the real (1, 2) group around the caret.
  const doc = "SELECT * FROM t WHERE b IN (1, 2) AND a = '(x' -- ) nor this\n  AND c = 3;";
  const pos = doc.indexOf('1, 2') + 1;
  const steps = climb(doc, pos);
  const i = steps.indexOf('1, 2');
  assert.ok(i >= 0, `ladder: ${JSON.stringify(steps)}`);
  assert.equal(steps[i + 1], '(1, 2)');
});

test('statement step respects semicolons and picks the caret’s statement', () => {
  const doc = 'SELECT 1;\nSELECT 2;\nSELECT 3;\n';
  const pos = doc.indexOf('2');
  const steps = climb(doc, pos);
  assert.ok(steps.includes('SELECT 2;'), `ladder: ${JSON.stringify(steps)}`);
  assert.equal(steps[steps.length - 1], doc);
});

test('a semicolon inside a string is not a statement boundary', () => {
  const doc = "SELECT 'a;b' FROM t;\nSELECT 2;";
  const pos = doc.indexOf('a;b');
  const steps = climb(doc, pos);
  assert.ok(steps.includes("SELECT 'a;b' FROM t;"), `ladder: ${JSON.stringify(steps)}`);
  assert.ok(!steps.includes("SELECT 'a"), 'must not cut at the in-string semicolon');
});

test('statement step honors a custom DELIMITER', () => {
  const doc = 'DELIMITER //\nCREATE PROCEDURE p() BEGIN\n  SELECT 1;\nEND//\nSELECT 2;';
  const pos = doc.indexOf('SELECT 1') + 3;
  const steps = climb(doc, pos, '//');
  assert.ok(steps.some(s => s.startsWith('CREATE PROCEDURE') && s.includes('SELECT 1;')),
    `ladder: ${JSON.stringify(steps)}`);
});

test('blank-line-separated blocks: the statement step is the block, not the run-on', () => {
  // statementAtCaret narrows to the block under the caret when every block
  // reads as its own statement start — the same rule ⌘↵ runs by.
  const doc = 'SELECT 1\n\nSELECT 2';
  const pos = doc.indexOf('2');
  const steps = climb(doc, pos);
  // word → the caret's BLOCK (not the unsplit two-block run-on) → document.
  assert.deepEqual(steps, ['2', 'SELECT 2', doc]);
});

test('expand after expand keeps climbing (no step repeats itself)', () => {
  const doc = 'SELECT name FROM t;';
  const pos = doc.indexOf('name');
  const first = expandRange(doc, pos, pos)!;
  const second = expandRange(doc, first.from, first.to)!;
  assert.ok(second.from < first.from || second.to > first.to);
  assert.ok(second.from <= first.from && second.to >= first.to, 'must contain the current range');
});

test('empty document and whitespace-only document offer nothing', () => {
  assert.equal(expandRange('', 0, 0), null);
  assert.deepEqual(expandSteps('', 0), []);
  assert.equal(expandRange('   \n ', 1, 1), null);
});

test('expandSteps is monotone: every step strictly grows', () => {
  const doc = "INSERT INTO shop.orders (id, note) VALUES (1, 'x;y');";
  for (let pos = 0; pos < doc.length; pos++) {
    const steps = expandSteps(doc, pos);
    for (let i = 1; i < steps.length; i++) {
      const [a, b] = [steps[i - 1], steps[i]];
      assert.ok(b.from <= a.from && b.to >= a.to && (b.from < a.from || b.to > a.to),
        `step ${i} at pos ${pos}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
  }
});
