/**
 * The pipeline validator (src/utils/mongoPipeline.ts) — the client-side
 * mirror of the Rust guard in src-tauri/src/db/mongodb.rs.
 *
 * The last test is the DRIFT GUARD: it reads the Rust source and asserts the
 * WRITE_STAGES literal there equals the list here. The two-sided convention
 * (like sqlGuard) only works while both sides name the same write stages —
 * the pre-flight passing what the server then rejects would be a silent
 * regression in error quality.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WRITE_STAGES, STAGE_SNIPPETS, DEFAULT_PIPELINE,
  validatePipeline, stageName, appendSnippet,
} from '../src/utils/mongoPipeline.ts';

const ROOT = new URL('..', import.meta.url).pathname;

test('a valid pipeline reports its stage count', () => {
  assert.deepEqual(validatePipeline('[{"$match": {}}, {"$group": {"_id": "$g"}}]'),
    { ok: true, stageCount: 2 });
  // An empty pipeline is valid (the server reads it as "all documents").
  assert.deepEqual(validatePipeline('[]'), { ok: true, stageCount: 0 });
  // Extended JSON inside a stage argument parses fine.
  assert.equal(validatePipeline('[{"$match": {"_id": {"$oid": "64b7f2a7c7d7a81a4c3f9e01"}}}]').ok, true);
});

test('an empty editor is an error, not a run', () => {
  const r = validatePipeline('   ');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /empty/);
});

test('bad JSON is a pipeline error', () => {
  const r = validatePipeline('[{not json');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /invalid pipeline JSON/);
});

test('a non-array is refused', () => {
  const r = validatePipeline('{"$match": {}}');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /array/);
});

test('a non-object stage is refused with its 1-based index', () => {
  const r = validatePipeline('[{"$match": {}}, 42]');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /stage 2/);
    assert.match(r.error, /object/);
    assert.equal(r.stageIndex, 1);
  }
});

test('an array stage is refused too (it is not a stage object)', () => {
  const r = validatePipeline('[[{"$match": {}}]]');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /stage 1 must be a JSON object/);
});

test('a multi-key stage is refused with its index', () => {
  const r = validatePipeline('[{"$match": {}, "$sort": {"n": 1}}]');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /stage 1/);
    assert.match(r.error, /exactly one key/);
  }
});

test('a stage key without $ is refused with its index', () => {
  const r = validatePipeline('[{"$match": {}}, {"match": {}}]');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /stage 2/);
    assert.match(r.error, /start with '\$'/);
    assert.equal(r.stageIndex, 1);
  }
});

test('$out and $merge are rejected wherever they appear', () => {
  for (const text of [
    '[{"$out": "other"}]',
    '[{"$match": {}}, {"$group": {"_id": "$g"}}, {"$merge": {"into": "t"}}]',
  ]) {
    const r = validatePipeline(text);
    assert.equal(r.ok, false, text);
    if (!r.ok) {
      assert.match(r.error, /write stage \$(out|merge) is not allowed/);
      assert.match(r.error, /read-only by design/);
    }
  }
});

test('read stages pass, including "$out" as DATA', () => {
  const r = validatePipeline(
    '[{"$match": {"a": 1}}, {"$group": {"_id": "$g"}}, {"$sort": {"n": -1}},' +
    ' {"$limit": 10}, {"$lookup": {"from": "t", "localField": "a", "foreignField": "b", "as": "j"}},' +
    ' {"$unwind": "$arr"}, {"$facet": {"x": [{"$count": "n"}]}}, {"$sample": {"size": 3}}]');
  assert.equal(r.ok, true);
  // "$out" inside a stage ARGUMENT is data, not a stage — top-level keys only.
  assert.equal(validatePipeline('[{"$match": {"op": "$out"}}]').ok, true);
});

test('stageName names only well-formed single-key $-stages', () => {
  assert.equal(stageName({ $match: {} }), '$match');
  assert.equal(stageName({}), null);
  assert.equal(stageName({ a: 1 }), null);
  assert.equal(stageName({ $a: 1, $b: 2 }), null);
  assert.equal(stageName([{ $match: {} }]), null);
  assert.equal(stageName('$match'), null);
  assert.equal(stageName(null), null);
});

test('every snippet parses as exactly one valid stage', () => {
  assert.equal(STAGE_SNIPPETS.length, 12);
  for (const { name, snippet } of STAGE_SNIPPETS) {
    const stage = JSON.parse(snippet);
    assert.equal(stageName(stage), name, name);
    assert.deepEqual(validatePipeline(`[${snippet}]`), { ok: true, stageCount: 1 }, name);
  }
});

test('the default pipeline is valid', () => {
  assert.deepEqual(validatePipeline(DEFAULT_PIPELINE), { ok: true, stageCount: 1 });
});

test('appendSnippet appends and re-serializes the whole array', () => {
  const r = appendSnippet(DEFAULT_PIPELINE, STAGE_SNIPPETS[3].snippet); // $limit
  assert.equal(r.ok, true);
  if (r.ok) {
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.length, 2);
    assert.equal(stageName(parsed[1]), '$limit');
    assert.deepEqual(validatePipeline(r.text), { ok: true, stageCount: 2 });
  }
});

test('appendSnippet treats a blank editor as an empty pipeline', () => {
  const r = appendSnippet('  ', STAGE_SNIPPETS[0].snippet);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(JSON.parse(r.text).length, 1);
});

test('appendSnippet refuses to guess at broken JSON', () => {
  const r = appendSnippet('[{"$match": {}', STAGE_SNIPPETS[0].snippet);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /fix the pipeline JSON/);
  const notArray = appendSnippet('{"$match": {}}', STAGE_SNIPPETS[0].snippet);
  assert.equal(notArray.ok, false);
});

test('WRITE_STAGES matches the Rust literal (drift guard)', () => {
  const src = readFileSync(join(ROOT, 'src-tauri/src/db/mongodb.rs'), 'utf8');
  const m = src.match(/WRITE_STAGES:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'WRITE_STAGES literal not found in db/mongodb.rs');
  const rustStages = [...m[1].matchAll(/"([^"]+)"/g)].map(g => g[1]);
  assert.deepEqual([...WRITE_STAGES], rustStages);
});
