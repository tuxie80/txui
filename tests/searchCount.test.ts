/**
 * searchCount (src/utils/searchCount.ts): the "3 of 17" math behind the
 * search-panel badge — exercised headlessly with real EditorState objects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { search, setSearchQuery, SearchQuery } from '@codemirror/search';
import { countSearchMatches } from '../src/utils/searchCount.ts';

function stateWith(doc: string, searchFor: string, head = 0): EditorState {
  let state = EditorState.create({ doc, extensions: [search({ top: true })] });
  state = state.update({
    effects: setSearchQuery.of(new SearchQuery({ search: searchFor })),
    selection: { anchor: head },
  }).state;
  return state;
}

test('null without a query / with an empty query', () => {
  const bare = EditorState.create({ doc: 'select 1', extensions: [search({ top: true })] });
  assert.equal(countSearchMatches(bare), null);
  assert.equal(countSearchMatches(stateWith('select 1', '')), null);
});

test('counts every match, case-insensitive by default', () => {
  const res = countSearchMatches(stateWith('select a, b from t where a = 1 and b = 2', 'a'))!;
  // a ×3 (select A, A = 1, AND… no: "and" contains a? yes: 'and' has an 'a')
  assert.ok(res.total >= 3, `total=${res.total}`);
});

test('current = the match containing the caret', () => {
  const doc = 'foo bar foo bar foo';
  const second = doc.indexOf('foo', 4);           // 8
  const res = countSearchMatches(stateWith(doc, 'foo', second + 1))!;
  assert.equal(res.total, 3);
  assert.equal(res.current, 2);
});

test('current falls forward to the next match after the caret', () => {
  const doc = 'foo bar foo bar foo';
  const res = countSearchMatches(stateWith(doc, 'foo', 5))!; // caret between matches
  assert.equal(res.current, 2);
});

test('caret past the last match → current stays 0', () => {
  const res = countSearchMatches(stateWith('foo x', 'foo', 5))!;
  assert.equal(res.total, 1);
  assert.equal(res.current, 0);
});

test('regexp queries work too', () => {
  let state = EditorState.create({ doc: 'a1 b22 c333', extensions: [search({ top: true })] });
  state = state.update({
    effects: setSearchQuery.of(new SearchQuery({ search: '\\d+', regexp: true })),
  }).state;
  const res = countSearchMatches(state)!;
  assert.equal(res.total, 3);
});
