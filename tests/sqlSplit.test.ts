/**
 * Statement splitting (src/utils/sqlSplit.ts).
 *
 * The splitter decides what "run this statement" means and how a script is cut
 * into pieces, so the cost of getting it wrong is executing the wrong SQL —
 * half a statement, or two statements as one. The delimiter is configurable
 * (Settings → Editor), which is what most of this covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements, statementAt, statementAtCaret, firstCodeOffset } from '../src/utils/sqlSplit.ts';

const texts = (doc: string, delim?: string) =>
  splitStatements(doc, delim).map(s => s.text);

test('semicolons split by default', () => {
  assert.deepEqual(texts('SELECT 1; SELECT 2;'), ['SELECT 1;', 'SELECT 2;']);
});

test('a trailing statement without a terminator is still returned', () => {
  assert.deepEqual(texts('SELECT 1; SELECT 2'), ['SELECT 1;', 'SELECT 2']);
});

test('offsets point at the real statement text', () => {
  const doc = '  SELECT 1;\n\nSELECT 2;';
  const [a, b] = splitStatements(doc);
  assert.equal(doc.slice(a.from, a.to), 'SELECT 1;');
  assert.equal(doc.slice(b.from, b.to), 'SELECT 2;');
});

// ── configurable delimiter ───────────────────────────────────────────────────

test('a custom punctuation delimiter splits instead of the semicolon', () => {
  // Oracle-style: `/` terminates, and a `;` inside is just part of the body.
  assert.deepEqual(
    texts('BEGIN a; b; END/ SELECT 1/', '/'),
    ['BEGIN a; b; END/', 'SELECT 1/'],
  );
});

test('with a custom delimiter, semicolons no longer split', () => {
  assert.deepEqual(texts('SELECT 1; SELECT 2', '/'), ['SELECT 1; SELECT 2']);
});

test('a word delimiter only splits when it stands alone', () => {
  // The point: GO terminates, but GOODS is one identifier and must survive.
  assert.deepEqual(
    texts('SELECT * FROM GOODS GO SELECT 2 GO', 'GO'),
    ['SELECT * FROM GOODS GO', 'SELECT 2 GO'],
  );
});

test('a word delimiter does not fire inside a longer word at either end', () => {
  assert.deepEqual(texts('SELECT ago, GOAL FROM t', 'GO'), ['SELECT ago, GOAL FROM t']);
});

test('an empty or whitespace delimiter falls back to the semicolon', () => {
  // A blank delimiter would match at every offset and split into nothing.
  for (const d of ['', '   ', '\t']) {
    assert.deepEqual(texts('SELECT 1; SELECT 2;', d), ['SELECT 1;', 'SELECT 2;'],
      `delimiter ${JSON.stringify(d)} did not fall back`);
  }
});

test('a DELIMITER directive still overrides the configured one', () => {
  const doc = 'SELECT 1/\nDELIMITER $$\nCREATE PROC p() BEGIN SELECT 1; END$$\n';
  assert.deepEqual(texts(doc, '/'), [
    'SELECT 1/',
    'CREATE PROC p() BEGIN SELECT 1; END$$',
  ]);
});

// ── quoting and comments are respected whatever the delimiter ────────────────

test('delimiters inside strings, identifiers and comments do not split', () => {
  assert.equal(splitStatements("SELECT ';' AS x;").length, 1);
  assert.equal(splitStatements('SELECT "a;b" AS x;').length, 1);
  assert.equal(splitStatements('SELECT 1 -- a; comment\n;').length, 1);
  assert.equal(splitStatements('SELECT /* a; b */ 1;').length, 1);
  assert.equal(splitStatements('SELECT $$a; b$$;').length, 1);
});

test('a "" doubling inside a quoted identifier does not end the quote', () => {
  // Without the doubling escape the second " would reopen, exposing the ; .
  const doc = 'SELECT "a"";"" b" FROM t; SELECT 2;';
  assert.deepEqual(texts(doc), ['SELECT "a"";"" b" FROM t;', 'SELECT 2;']);
});

test('a `` doubling inside a backtick identifier does not end the quote', () => {
  const doc = 'SELECT `a``;``b` FROM t; SELECT 2;';
  assert.deepEqual(texts(doc), ['SELECT `a``;``b` FROM t;', 'SELECT 2;']);
});

test('a custom delimiter inside a string does not split either', () => {
  assert.deepEqual(texts("SELECT 'a/b' AS x/ SELECT 2/", '/'),
    ["SELECT 'a/b' AS x/", 'SELECT 2/']);
});

// ── caret lookup ─────────────────────────────────────────────────────────────

test('statementAt honours the delimiter it is given', () => {
  const doc = 'SELECT 1/ SELECT 2/';
  assert.equal(statementAt(doc, 2, '/')?.text, 'SELECT 1/');
  assert.equal(statementAt(doc, 12, '/')?.text, 'SELECT 2/');
  // With the default delimiter the whole thing is one statement.
  assert.equal(statementAt(doc, 12)?.text, doc);
});

test('statementAtCaret narrows to the blank-line block under the caret', () => {
  const doc = 'SELECT 1\n\nSELECT 2';
  assert.equal(statementAtCaret(doc, 1)?.text, 'SELECT 1');
  assert.equal(statementAtCaret(doc, 12)?.text, 'SELECT 2');
});

test('a blank line INSIDE one statement is not a boundary — no fragment is run', () => {
  // A blank line between the select list and FROM (left for readability) must
  // not make ⌘↵ run "SELECT id, name" or "FROM users" on its own.
  const doc = 'SELECT id, name\n\nFROM users;';
  assert.equal(statementAtCaret(doc, 3)?.text, doc);            // caret on SELECT
  assert.equal(statementAtCaret(doc, doc.indexOf('FROM') + 1)?.text, doc); // caret on FROM
});

test('a leading WITH keeps its main query — a CTE is not narrowed to itself', () => {
  const doc = 'WITH x AS (SELECT 1)\n\nSELECT * FROM x';
  assert.equal(statementAtCaret(doc, 2)?.text, doc);
  assert.equal(statementAtCaret(doc, doc.indexOf('SELECT *') + 1)?.text, doc);
});

test('a pasted dump of independent statements still narrows on blank lines', () => {
  const doc = 'SHOW CREATE TABLE t\n\nSELECT * FROM t';
  assert.equal(statementAtCaret(doc, 2)?.text, 'SHOW CREATE TABLE t');
  assert.equal(statementAtCaret(doc, doc.indexOf('SELECT') + 2)?.text, 'SELECT * FROM t');
});

test('an empty document yields nothing rather than a phantom statement', () => {
  assert.deepEqual(splitStatements(''), []);
  assert.deepEqual(splitStatements('   \n\n  '), []);
  assert.equal(statementAt('', 0), null);
});

// ── firstCodeOffset: where the run marker anchors ────────────────────────────
// The gutter chip must sit on the statement's first CODE line, not on a
// comment above it — but /*+ hints and /*! conditional comments are executed
// by the server, so they count as code and keep the anchor.

test('firstCodeOffset with no leading comment matches trimStart behaviour', () => {
  const [s] = splitStatements('  SELECT 1;');
  assert.equal(firstCodeOffset(s), s.from + (s.text.length - s.text.trimStart().length));
  assert.equal(firstCodeOffset(s), 2);
});

test('firstCodeOffset skips a leading -- comment line', () => {
  const doc = '-- count users\nSELECT count(*) FROM users;';
  const [s] = splitStatements(doc);
  assert.equal(firstCodeOffset(s), doc.indexOf('SELECT'));
});

test('firstCodeOffset skips a leading # comment line', () => {
  const doc = '# count users\nSELECT 1;';
  const [s] = splitStatements(doc);
  assert.equal(firstCodeOffset(s), doc.indexOf('SELECT'));
});

test('firstCodeOffset skips a leading block comment', () => {
  const doc = '/* report\n   run nightly */\nSELECT 1;';
  const [s] = splitStatements(doc);
  assert.equal(firstCodeOffset(s), doc.indexOf('SELECT'));
});

test('firstCodeOffset skips several mixed comment lines in any order', () => {
  const doc = '-- one\n# two\n/* three */\n\n-- four\nSELECT 1;';
  const [s] = splitStatements(doc);
  assert.equal(firstCodeOffset(s), doc.indexOf('SELECT'));
});

test('firstCodeOffset does NOT skip a /*+ optimizer hint — it is code', () => {
  const doc = '/*+ MAX_EXECUTION_TIME(1000) */ SELECT 1;';
  const [s] = splitStatements(doc);
  assert.equal(firstCodeOffset(s), doc.indexOf('/*+'));
});

test('firstCodeOffset does NOT skip a /*! conditional comment — it is code', () => {
  const doc = '/*!40101 SET @OLD=@@SQL_MODE */;';
  const [s] = splitStatements(doc);
  assert.equal(firstCodeOffset(s), doc.indexOf('/*!'));
});

test('firstCodeOffset on a comment-only statement falls back to whitespace-only', () => {
  const doc = '  -- nothing to run';
  const [s] = splitStatements(doc);
  assert.equal(firstCodeOffset(s), s.from); // first non-whitespace char: the `-`
});

test('firstCodeOffset is absolute — statements later in the doc stay correct', () => {
  const doc = 'SELECT 1;\n-- explains the next one\nSELECT 2;';
  const [, b] = splitStatements(doc);
  assert.equal(firstCodeOffset(b), doc.lastIndexOf('SELECT'));
  assert.equal(doc.slice(firstCodeOffset(b), firstCodeOffset(b) + 6), 'SELECT');
});
