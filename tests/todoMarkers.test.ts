/**
 * TODO / FIXME markers (src/utils/todoMarkers.ts).
 *
 * Comments carrying TODO/FIXME/XXX/HACK get painted; the same words in
 * strings and identifiers must not. The detection rides sqlAlias.blank's
 * comment/string blanking, so these tests are the guard that the two are
 * never confused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todoMarkers, jumpTarget } from '../src/utils/todoMarkers.ts';

test('line and block comments are markers', () => {
  const sql = '-- TODO: check this\nSELECT 1; /* FIXME: fragile */';
  const m = todoMarkers(sql);
  assert.equal(m.length, 2);
  assert.equal(m[0].kind, 'todo');
  assert.equal(sql.slice(m[0].from, m[0].to), '-- TODO: check this');
  assert.equal(m[1].kind, 'fixme');
  assert.equal(sql.slice(m[1].from, m[1].to), '/* FIXME: fragile */');
});

test('the word inside a string literal is NOT a marker', () => {
  assert.equal(todoMarkers("SELECT 'TODO: ask legal'").length, 0);
  assert.equal(todoMarkers("SELECT 'TODO: ask legal' -- fixme now").length, 1);
});

test('a string whose content starts with -- is not mistaken for a comment', () => {
  // The blanked interior of a string follows its kept opening quote; without
  // that check, '-- TODO' here would paint as a comment.
  assert.equal(todoMarkers("SELECT '-- TODO: not this'").length, 0);
});

test('case variants all match; kind is lowercased', () => {
  const m = todoMarkers('-- todo\n-- ToDo\n-- FIXME\n-- xxx\n-- HaCk');
  assert.deepEqual(m.map(x => x.kind), ['todo', 'todo', 'fixme', 'xxx', 'hack']);
});

test('word boundaries: TODOIST and HACKATHON are not markers', () => {
  assert.equal(todoMarkers('-- TODOIST this\n-- HACKATHON project\n-- preTODO').length, 0);
  assert.equal(todoMarkers('-- TODO: x').length, 1);
});

test('MySQL hash comments count', () => {
  const m = todoMarkers('# XXX fix before release');
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'xxx');
});

test('kind is the FIRST keyword in the comment', () => {
  const m = todoMarkers('-- HACK: workaround, TODO remove after 5.7');
  assert.equal(m[0].kind, 'hack');
});

test('code and identifiers never match', () => {
  assert.equal(todoMarkers('SELECT todo_count FROM t WHERE x = 1').length, 0);
});

test('jumpTarget: next/prev wrap around the ends', () => {
  const sql = 'SELECT 0;\n-- TODO one\nSELECT 1;\n-- FIXME two\nSELECT 2;\n-- XXX three';
  const m = todoMarkers(sql);
  assert.equal(m.length, 3);
  // next from code before the first marker → first
  assert.equal(jumpTarget(m, 2, 1), m[0]);
  // next from inside (or exactly at the start of) a marker → the FOLLOWING
  // one — strict inequality is what stops "next" from sticking in place
  assert.equal(jumpTarget(m, m[0].from, 1), m[1]);
  assert.equal(jumpTarget(m, m[0].from + 2, 1), m[1]);
  // next past the last wraps to the first
  assert.equal(jumpTarget(m, m[2].from + 2, 1), m[0]);
  // prev from inside the second marker → first
  assert.equal(jumpTarget(m, m[1].from + 2, -1), m[0]);
  // prev from before the first wraps to the last
  assert.equal(jumpTarget(m, 2, -1), m[2]);
  assert.equal(jumpTarget([], 0, 1), null);
});
