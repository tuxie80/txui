/**
 * The run-marker StateFields (components/editorRunMarkers.ts), driven through
 * real EditorState transactions — no DOM needed. The load-bearing guarantee:
 * markers are bound to what RAN, so any document edit clears them, and they
 * stay cleared until a genuinely new setStatementRuns effect arrives.
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

test('a doc edit CLEARS the run markers (they are bound to what ran)', () => {
  let s = stateWith('SELECT 1;\nSELECT 2;\n');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }, { status: 'ok', ms: 34 }]) }).state;
  assert.equal(runs(s).length, 2);

  // owner scenario: delete the second statement…
  s = s.update({ changes: { from: 10, to: 20 } }).state;
  assert.deepEqual(runs(s), [], 'deleting lines drops their markers');

  // …then type new text where it was: nothing may reappear
  s = s.update({ changes: { from: 10, insert: 'SELECT 99;' } }).state;
  assert.deepEqual(runs(s), [], 'retyped content must NOT resurrect the old chip/time');

  // and further ordinary edits keep it cleared
  s = s.update({ changes: { from: 0, insert: '-- note\n' } }).state;
  assert.deepEqual(runs(s), []);
});

test('a genuinely NEW run after an edit sets markers again', () => {
  let s = stateWith('SELECT 1;\n');
  s = s.update({ effects: setStatementRuns.of([{ status: 'ok', ms: 12 }]) }).state;
  s = s.update({ changes: { from: 0, insert: '-- x\n' } }).state;
  assert.deepEqual(runs(s), []);
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
