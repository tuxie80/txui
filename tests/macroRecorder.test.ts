/**
 * Macro recorder (src/utils/macroRecorder.ts) — §5.9.
 *
 * A macro is an ordered list of registry command ids. These tests pin the
 * record → stop → replay contract, the self-exclusion that stops a macro from
 * recording its own controls, the empty-macro edge, and the id-stability tie
 * back to commandRegistry (the exclusion list must match ids that really exist
 * in the registry, and every ordinary command must be recordable).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MacroRecorder, MACRO_COMMAND_IDS, isRecordable, replayOrder,
} from '../src/utils/macroRecorder.ts';
import { EDITOR_COMMANDS } from '../src/utils/commandRegistry.ts';

// ── record → stop → replay order ──────────────────────────────────────────────

test('a recording captures dispatched ids in order and replays them the same', () => {
  const rec = new MacroRecorder();
  rec.start();
  assert.equal(rec.isRecording, true);
  for (const id of ['editor.upperCase', 'editor.moveLineDown', 'editor.trimTrailing']) {
    assert.equal(rec.record(id), true);
  }
  const macro = rec.stop();
  assert.equal(rec.isRecording, false);
  assert.deepEqual(macro, ['editor.upperCase', 'editor.moveLineDown', 'editor.trimTrailing']);
  // Replay order is the recorded order, unchanged.
  assert.deepEqual(replayOrder(macro), macro);
  // And it is retained as the session's last macro for playback.
  assert.deepEqual(rec.lastMacro(), macro);
  assert.equal(rec.hasMacro(), true);
});

test('current() shows the in-progress buffer without stopping', () => {
  const rec = new MacroRecorder();
  rec.start();
  rec.record('editor.run');
  rec.record('editor.nextStatement');
  assert.deepEqual(rec.current(), ['editor.run', 'editor.nextStatement']);
  assert.equal(rec.isRecording, true); // reading did not stop it
});

test('nothing is recorded while idle (record before start is a no-op)', () => {
  const rec = new MacroRecorder();
  assert.equal(rec.record('editor.run'), false);
  assert.deepEqual(rec.current(), []);
  assert.equal(rec.isRecording, false);
});

test('toggle flips recording state and returns the new state', () => {
  const rec = new MacroRecorder();
  assert.equal(rec.toggle(), true);   // start
  assert.equal(rec.isRecording, true);
  rec.record('editor.run');
  assert.equal(rec.toggle(), false);  // stop
  assert.equal(rec.isRecording, false);
  assert.deepEqual(rec.lastMacro(), ['editor.run']);
});

test('starting a new recording discards the half-recorded buffer', () => {
  const rec = new MacroRecorder();
  rec.start();
  rec.record('editor.run');
  rec.start(); // fresh take
  assert.deepEqual(rec.current(), []);
  rec.record('editor.explain');
  assert.deepEqual(rec.stop(), ['editor.explain']);
});

// ── self-exclusion of the macro controls ──────────────────────────────────────

test('the record/play commands exclude themselves from a macro', () => {
  const rec = new MacroRecorder();
  rec.start();
  for (const id of MACRO_COMMAND_IDS) {
    assert.equal(rec.record(id), false, `${id} must not be captured`);
  }
  rec.record('editor.run'); // an ordinary command still records
  assert.deepEqual(rec.stop(), ['editor.run']);
});

test('isRecordable rejects the macro controls and accepts ordinary ids', () => {
  for (const id of MACRO_COMMAND_IDS) assert.equal(isRecordable(id), false);
  assert.equal(isRecordable('editor.run'), true);
  assert.equal(isRecordable('editor.sortLinesAsc'), true);
});

test('a custom exclusion set is honoured', () => {
  const rec = new MacroRecorder(['editor.run']);
  rec.start();
  assert.equal(rec.record('editor.run'), false);        // excluded
  assert.equal(rec.record('editor.macroPlay'), true);   // NOT excluded here
  assert.deepEqual(rec.stop(), ['editor.macroPlay']);
});

// ── empty macro ───────────────────────────────────────────────────────────────

test('stopping with nothing recorded yields an empty macro and no replay', () => {
  const rec = new MacroRecorder();
  rec.start();
  const macro = rec.stop();
  assert.deepEqual(macro, []);
  assert.deepEqual(replayOrder(macro), []);
  assert.equal(rec.hasMacro(), false);
  assert.deepEqual(rec.lastMacro(), []);
});

test('an empty recording does not wipe the previous last macro', () => {
  const rec = new MacroRecorder();
  rec.start();
  rec.record('editor.run');
  rec.stop();
  assert.deepEqual(rec.lastMacro(), ['editor.run']);
  rec.start();
  rec.stop(); // recorded nothing this time
  assert.deepEqual(rec.lastMacro(), ['editor.run'], 'last macro survives an empty take');
  assert.equal(rec.hasMacro(), true);
});

// ── returned arrays are copies (defensive) ────────────────────────────────────

test('returned macros are copies — mutating one cannot corrupt recorder state', () => {
  const rec = new MacroRecorder();
  rec.start();
  rec.record('editor.run');
  const stopped = rec.stop();
  stopped.push('editor.explain');
  assert.deepEqual(rec.lastMacro(), ['editor.run'], 'internal state untouched');
  const last = rec.lastMacro();
  last.length = 0;
  assert.deepEqual(rec.lastMacro(), ['editor.run']);
});

// ── id-stability against the registry ─────────────────────────────────────────

test('every macro-control id is registered in commandRegistry', () => {
  // If a control id is renamed in one place but not the other, the palette
  // command and the recorder's exclusion drift apart — catch it here.
  const ids = new Set(EDITOR_COMMANDS.map(c => c.id));
  for (const id of MACRO_COMMAND_IDS) {
    assert.ok(ids.has(id), `macro control missing from registry: ${id}`);
  }
});

test('the recorder refuses exactly the registry ids marked as macro controls', () => {
  // The recorder must never capture a control command, and must capture every
  // ordinary registry command — this is the id-stability contract a saved
  // macro depends on.
  const controls = new Set<string>(MACRO_COMMAND_IDS);
  const rec = new MacroRecorder();
  rec.start();
  for (const c of EDITOR_COMMANDS) {
    const captured = rec.record(c.id);
    if (controls.has(c.id)) {
      assert.equal(captured, false, `control captured: ${c.id}`);
    } else {
      assert.equal(captured, true, `ordinary command not captured: ${c.id}`);
    }
  }
  // The buffer holds every ordinary id, in registry order, and no control id.
  const expected = EDITOR_COMMANDS.map(c => c.id).filter(id => !controls.has(id));
  assert.deepEqual(rec.current(), expected);
});

test('a recorded macro references only ids that exist in the registry', () => {
  const known = new Set(EDITOR_COMMANDS.map(c => c.id));
  const rec = new MacroRecorder();
  rec.start();
  rec.record('editor.upperCase');
  rec.record('editor.sortLinesAsc');
  for (const id of rec.stop()) assert.ok(known.has(id), `unknown id in macro: ${id}`);
});
