/**
 * Generator presets (src/utils/datagenPresets.ts) — the pure half of the
 * Phase-5 preset feature: capture, apply, list editing and the tolerant read
 * of the persisted form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capturePreset, applyPreset, presetProblem, upsertPreset, removePreset,
  renamePreset, parsePresets, normalizePresetName, MAX_PRESET_NAME,
} from '../src/utils/datagenPresets.ts';
import { DEFAULT_PARAMS } from '../src/utils/datagen.ts';
import type { ColumnSpec } from '../src/utils/datagen.ts';

const spec = (over: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name: 'email', typeName: 'VARCHAR(255)', generator: 'email',
  params: { ...DEFAULT_PARAMS, nullPct: 12 }, unique: true, ...over,
});

test('capturePreset snapshots generator + params', () => {
  const p = capturePreset('work email', spec());
  assert.ok(!('error' in p));
  if ('error' in p) return;
  assert.equal(p.name, 'work email');
  assert.equal(p.generator, 'email');
  assert.equal(p.params.nullPct, 12);
});

test('capturePreset strips the FK address but keeps the FK shape', () => {
  const p = capturePreset('order link', spec({
    generator: 'fk',
    params: { ...DEFAULT_PARAMS, fkTable: '`shop`.`customers`', fkColumn: '`id`', fkGroup: 'g1', dist: 'zipf' },
  }));
  assert.ok(!('error' in p));
  if ('error' in p) return;
  assert.equal(p.params.fkTable, undefined);
  assert.equal(p.params.fkColumn, undefined);
  assert.equal(p.params.fkGroup, undefined);
  assert.equal(p.params.dist, 'zipf');
});

test('capturePreset rejects a bad name and an unknown generator', () => {
  assert.ok('error' in capturePreset('   ', spec()));
  assert.ok('error' in capturePreset('x'.repeat(MAX_PRESET_NAME + 1), spec()));
  assert.ok('error' in capturePreset('ok', spec({ generator: 'nope' })));
});

test('normalizePresetName trims and collapses whitespace', () => {
  assert.equal(normalizePresetName('  order   status '), 'order status');
  assert.equal(normalizePresetName(''), null);
});

test('applyPreset replaces generator and params wholesale, keeps the column', () => {
  const p = capturePreset('p', spec());
  assert.ok(!('error' in p));
  if ('error' in p) return;
  const target = spec({
    name: 'contact', typeName: 'TEXT', generator: 'words', unique: false,
    params: { ...DEFAULT_PARAMS, list: 'a,b', fkTable: 'leftover' },
  });
  const out = applyPreset(target, p);
  assert.equal(out.name, 'contact');
  assert.equal(out.typeName, 'TEXT');
  assert.equal(out.unique, false);
  assert.equal(out.generator, 'email');
  assert.equal(out.params.nullPct, 12);
  // no residue from the previous generator's params
  assert.equal(out.params.fkTable, undefined);
});

test('presetProblem flags a generator the catalogue no longer has', () => {
  const p = capturePreset('p', spec());
  assert.ok(!('error' in p));
  if ('error' in p) return;
  assert.equal(presetProblem(p), null);
  assert.match(presetProblem({ ...p, generator: 'gone' }) ?? '', /unknown generator/);
});

test('upsert replaces by name, remove deletes, rename moves and refuses collisions', () => {
  const a = capturePreset('a', spec());
  const b = capturePreset('b', spec({ generator: 'city' }));
  assert.ok(!('error' in a) && !('error' in b));
  if ('error' in a || 'error' in b) return;

  let list = upsertPreset([], a);
  list = upsertPreset(list, b);
  assert.deepEqual(list.map(p => p.name), ['a', 'b']);
  const a2 = { ...a, params: { ...a.params, nullPct: 99 } };
  list = upsertPreset(list, a2);
  assert.equal(list.length, 2);
  assert.equal(list[0].params.nullPct, 99);

  const renamed = renamePreset(list, 'a', 'c');
  assert.ok('list' in renamed);
  if ('list' in renamed) assert.deepEqual(renamed.list.map(p => p.name), ['c', 'b']);
  assert.ok('error' in renamePreset(list, 'a', 'b'));        // collision
  assert.ok('error' in renamePreset(list, 'nope', 'c'));     // missing
  assert.ok('error' in renamePreset(list, 'a', '  '));       // bad name

  assert.deepEqual(removePreset(list, 'b').map(p => p.name), ['a']);
});

test('parsePresets round-trips the serialized form', () => {
  const a = capturePreset('a', spec());
  const b = capturePreset('b', spec({ generator: 'city', params: { ...DEFAULT_PARAMS, min: 5 } }));
  assert.ok(!('error' in a) && !('error' in b));
  if ('error' in a || 'error' in b) return;
  const back = parsePresets(JSON.parse(JSON.stringify([a, b])));
  assert.deepEqual(back, [a, b]);
});

test('parsePresets is tolerant: junk skipped, unknown generators kept, dupes collapse', () => {
  const a = capturePreset('a', spec());
  assert.ok(!('error' in a));
  if ('error' in a) return;
  const raw: unknown[] = [
    null, 'junk', 42, { name: 7 }, { name: 'x' },
    { name: 'old', generator: 'gone', params: { min: 3 } },
    a, { ...a, params: { ...a.params, nullPct: 77 } },   // duplicate name — last wins
  ];
  const out = parsePresets(raw);
  assert.deepEqual(out.map(p => p.name), ['old', 'a']);
  assert.equal(out[0].generator, 'gone');                 // kept; presetProblem flags it
  assert.equal(out[0].params.max, DEFAULT_PARAMS.max);    // defaults fill what the save lacked
  assert.equal(out[1].params.nullPct, 77);
  assert.equal(parsePresets('not an array').length, 0);
});
