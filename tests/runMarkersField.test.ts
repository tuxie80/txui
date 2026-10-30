/**
 * The run-marker StateFields (components/editorRunMarkers.ts), driven through
 * real EditorState transactions — no DOM needed. The load-bearing guarantee:
 * markers are bound to what RAN: editing a statement clears only its marker;
 * inserting or editing other statements leaves their proofs intact.
 * Token-preserving whitespace edits retain them and their measured times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import {
  statementRunsField, setStatementRuns, runElapsedField, setRunTick,
} from '../src/components/editorRunMarkers.ts';
import type { StatementRun } from '../src/components/editorRunMarkers.ts';

const EXT = [statementRunsField, runElapsedField];

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: EXT });
}
function runs(state: EditorState): readonly StatementRun[] {
  return state.field(statementRunsField);
}

test('typing a new command preserves the previous statement proof', () => {
  let s = stateWith('SHOW PROCESSLIST;\n');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 7 }]) }).state;

  s = s.update({ changes: { from: s.doc.length, insert: 'SELECT 42;' } }).state;
  assert.deepEqual(runs(s), [{ status: 'ok', ms: 7 }, { status: 'skipped' }]);

  s = s.update({ changes: { from: s.doc.length, insert: '\nSELECT 43;' } }).state;
  assert.deepEqual(runs(s), [{ status: 'ok', ms: 7 }, { status: 'skipped' }, { status: 'skipped' }]);
});

test('deleting or rewriting only the affected statements drops only their markers', () => {
  let s = stateWith('SELECT 1;\nSELECT 2;\n');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }, { status: 'ok', ms: 34 }]) }).state;

  s = s.update({ changes: { from: 10, to: 20 } }).state;
  assert.deepEqual(runs(s), [{ status: 'ok', ms: 12 }]);

  s = s.update({ changes: { from: 10, insert: 'SELECT 99;' } }).state;
  assert.deepEqual(runs(s), [{ status: 'ok', ms: 12 }, { status: 'skipped' }],
    'retyped content must NOT resurrect the old chip/time');

  s = s.update({ changes: { from: 0, insert: '-- note\n' } }).state;
  assert.deepEqual(runs(s), [{ status: 'skipped' }, { status: 'skipped' }],
    'editing the statement text itself invalidates only that statement');
});

test('editing the fifth through tenth statements preserves the first four', () => {
  const doc = Array.from({ length: 10 }, (_, i) => `SELECT ${i + 1};`).join('\n');
  const original = Array.from({ length: 10 }, (_, i) => ({ status: 'ok' as const, ms: (i + 1) * 10 }));
  let s = stateWith(doc);
  s = s.update({ effects: setStatementRuns.of(original) }).state;
  const from = doc.indexOf('SELECT 5;');
  s = s.update({ changes: { from, to: doc.length, insert: 'SELECT 99;' } }).state;

  assert.deepEqual(runs(s).slice(0, 4), original.slice(0, 4));
  assert.ok(runs(s).slice(4).every(r => r.status === 'skipped'));
});

test('inserting a statement shifts later proofs without clearing them', () => {
  let s = stateWith('SELECT 1;\nSELECT 2;\n');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }, { status: 'ok', ms: 34 }]) }).state;
  s = s.update({ changes: { from: 10, insert: 'SELECT 99;\n' } }).state;
  assert.deepEqual(runs(s), [
    { status: 'ok', ms: 12 }, { status: 'skipped' }, { status: 'ok', ms: 34 },
  ]);
});

test('blank-line and indentation-only edits preserve finished run times', () => {
  let s = stateWith('SELECT 1;\nSELECT 2;\n');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }, { status: 'ok', ms: 34 }]) }).state;
  s = s.update({ changes: { from: 10, insert: '\n\n' } }).state;
  assert.deepEqual(runs(s), [{ status: 'ok', ms: 12 }, { status: 'ok', ms: 34 }]);
  s = s.update({ changes: { from: 10, to: 12 } }).state;
  assert.deepEqual(runs(s), [{ status: 'ok', ms: 12 }, { status: 'ok', ms: 34 }]);
  s = s.update({ changes: { from: 0, insert: '  \t' } }).state;
  assert.deepEqual(runs(s), [{ status: 'ok', ms: 12 }, { status: 'ok', ms: 34 }]);
});

test('a whitespace edit cannot preserve a marker after SQL text changes', () => {
  let s = stateWith('SELECT 1;\n');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }]) }).state;
  s = s.update({ changes: { from: 7, to: 8, insert: '2' } }).state;
  assert.deepEqual(runs(s), [{ status: 'skipped' }]);
  s = s.update({ changes: { from: 9, insert: '\n' } }).state;
  assert.deepEqual(runs(s), [{ status: 'skipped' }], 'later blank lines do not resurrect the cleared run');
});

test('whitespace inside SQL tokens, literals and quoted identifiers clears markers', () => {
  for (const [doc, from] of [
    ['SELECT 1;', 3],
    ["SELECT 'a b';", 9],
    ['SELECT "a b" FROM t;', 9],
  ] as const) {
    let s = stateWith(doc);
    s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }]) }).state;
    s = s.update({ changes: { from, insert: ' ' } }).state;
    assert.deepEqual(runs(s), [{ status: 'skipped' }], `whitespace changed executable SQL: ${s.doc.toString()}`);
  }
});

test('whitespace inside a comment clears markers conservatively', () => {
  let s = stateWith('SELECT /* a b */ 1;');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }]) }).state;
  s = s.update({ changes: { from: 11, insert: ' ' } }).state;
  assert.deepEqual(runs(s), [{ status: 'skipped' }]);
});

test('a genuinely NEW run after an edit sets markers again', () => {
  let s = stateWith('SELECT 1;\n');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }]) }).state;
  s = s.update({ changes: { from: 0, insert: '-- x\n' } }).state;
  assert.deepEqual(runs(s), [{ status: 'skipped' }]);
  s = s.update({ effects: setStatementRuns.of([{ status: 'running' }]) }).state;
  assert.deepEqual(runs(s), [{ status: 'running' }]);
});

test('an effect riding the SAME transaction as a doc change wins', () => {
  // Explicit host data beats implicit invalidation — the order in the field's
  // update() (effects first, docChanged second) is deliberate.
  let s = stateWith('SELECT 1;\n');
  s = s.update({
    changes: { from: 9, insert: '\nSELECT 2;' },
    effects: setStatementRuns.of([{ status: 'ok', ms: 1 }, { status: 'running' }]),
  }).state;
  assert.equal(runs(s).length, 2);
});

test('selection-only transactions keep the markers', () => {
  let s = stateWith('SELECT 1;\n');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }]) }).state;
  s = s.update({ selection: { anchor: 3 } }).state;
  assert.equal(runs(s).length, 1, 'moving the caret must not clear markers');
});

test('the tick field carries the elapsed value the gutter renders', () => {
  let s = stateWith('SELECT 1;\n');
  assert.equal(s.field(runElapsedField), 0);
  s = s.update({ effects: setRunTick.of(375) }).state;
  assert.equal(s.field(runElapsedField), 375);
  s = s.update({ effects: setRunTick.of(500) }).state;
  assert.equal(s.field(runElapsedField), 500, 'each tick replaces the value');
});
