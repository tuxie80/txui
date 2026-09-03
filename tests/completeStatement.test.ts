/**
 * Complete Current Statement (src/utils/completeStatement.ts).
 *
 * One chord finishes the statement under the caret: close open quotes/parens,
 * ensure the delimiter, land on a fresh line below. The `|` marker is the
 * caret; assertions run on the applied result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeStatement, applyCompletion } from '../src/utils/completeStatement.ts';

function run(marked: string, delimiter?: string) {
  const offset = marked.indexOf('|');
  assert.ok(offset >= 0, 'missing caret marker |');
  const sql = marked.replace('|', '');
  const res = completeStatement(sql, offset, delimiter);
  return applyCompletion(sql, res);
}

test('unclosed single quote is closed, then terminated', () => {
  const r = run("SELECT * FROM t WHERE n = 'abc|");
  assert.equal(r.text, "SELECT * FROM t WHERE n = 'abc';\n");
  assert.equal(r.caret, r.text.length);
});

test('unclosed double parens are closed', () => {
  const r = run('SELECT concat(upper(name|');
  assert.equal(r.text, 'SELECT concat(upper(name));\n');
});

test('an already-terminated statement only gets the fresh line', () => {
  const r = run('SELECT 1;|');
  assert.equal(r.text, 'SELECT 1;\n');
  assert.equal(r.caret, 'SELECT 1;\n'.length);
});

test('a balanced string the caret merely follows is NOT closed', () => {
  const r = run("SELECT 'done' FROM t|");
  assert.equal(r.text, "SELECT 'done' FROM t;\n");
});

test('a string with a doubled quote is balanced — nothing to close', () => {
  const r = run("SELECT 'it''s fine'|");
  assert.equal(r.text, "SELECT 'it''s fine';\n");
});

test('custom delimiter is appended, not a semicolon', () => {
  const r = run('SELECT 1|', '//');
  assert.equal(r.text, 'SELECT 1//\n');
});

test('custom delimiter already present → only the fresh line', () => {
  const r = run('SELECT 1//|', '//');
  assert.equal(r.text, 'SELECT 1//\n');
});

test('a trailing line comment pushes the delimiter to the next line', () => {
  // Appending `;` right after the comment would comment the terminator out.
  const r = run('SELECT 1 -- note|');
  assert.equal(r.text, 'SELECT 1 -- note\n;\n');
});

test('a comment-only region is a no-op', () => {
  const r = run('-- just a note|');
  assert.equal(r.text, '-- just a note');
  assert.equal(r.caret, '-- just a note'.length);
});

test('caret mid-statement completes at the statement end and steps below', () => {
  const r = run('SELECT 1|; SELECT 2;');
  assert.equal(r.text, 'SELECT 1;\n SELECT 2;');
  assert.equal(r.caret, 'SELECT 1;\n'.length);
});

test('an existing blank line below is reused, not duplicated', () => {
  const r = run('SELECT 1;|\n\nSELECT 2;');
  assert.equal(r.text, 'SELECT 1;\n\nSELECT 2;');
  assert.equal(r.caret, 'SELECT 1;\n'.length);
});

test('an unclosed block comment is closed before the delimiter', () => {
  const r = run('SELECT 1 /* work in progress|');
  assert.equal(r.text, 'SELECT 1 /* work in progress*/;\n');
});

test('empty buffer is a no-op', () => {
  const r = run('|');
  assert.equal(r.text, '');
  assert.equal(r.caret, 0);
});
