/**
 * tests for src/utils/incidentTimeline.ts — run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketize, filterKinds, groupByDay, mergeTimeline, summarizeTitle, timeOfDay,
  localText, TIMELINE_CAP, TIMELINE_KINDS, KIND_LABEL,
} from '../src/utils/incidentTimeline.ts';
import type { TimelineEvent, TimelineKind } from '../src/utils/incidentTimeline.ts';

let seq = 0;
function ev(kind: TimelineKind, atMs: number, title = kind, over: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    id: `${kind}:${seq}`, kind, at_ms: atMs, title, detail: '', ok: true,
    duration_ms: 0, ref_id: seq, ...over,
  };
}

test('mergeTimeline sorts newest first', () => {
  const a = ev('audit', 1000);
  const b = ev('deadlock', 3000);
  const c = ev('long_query', 2000);
  const out = mergeTimeline([a, b, c]);
  assert.deepEqual(out.map(e => e.kind), ['deadlock', 'long_query', 'audit']);
});

test('mergeTimeline breaks equal timestamps deterministically by id', () => {
  // Same at_ms from two stores: the order must be stable across calls and
  // input permutations, or the list shimmers on every refresh.
  const a = ev('audit', 5000, 'a', { id: 'audit:7' });
  const b = ev('deadlock', 5000, 'b', { id: 'deadlock:3' });
  const c = ev('long_query', 5000, 'c', { id: 'long_query:1' });
  const want = ['audit:7', 'deadlock:3', 'long_query:1'];
  assert.deepEqual(mergeTimeline([c, b, a]).map(e => e.id), want);
  assert.deepEqual(mergeTimeline([a, b, c]).map(e => e.id), want);
  assert.deepEqual(mergeTimeline([b, c, a]).map(e => e.id), want);
});

test('mergeTimeline caps to the newest events', () => {
  const events = Array.from({ length: 10 }, (_, i) => ev('audit', i * 1000));
  const out = mergeTimeline(events, 3);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(e => e.at_ms), [9000, 8000, 7000],
    'the cap sheds the OLDEST, not the newest');
});

test('mergeTimeline default cap is the panel cap', () => {
  const events = Array.from({ length: TIMELINE_CAP + 5 }, (_, i) => ev('audit', i));
  assert.equal(mergeTimeline(events).length, TIMELINE_CAP);
});

test('filterKinds keeps only the enabled kinds', () => {
  const events = [ev('audit', 1), ev('deadlock', 2), ev('long_query', 3)];
  const out = filterKinds(events, new Set(['deadlock', 'long_query']));
  assert.deepEqual(out.map(e => e.kind), ['deadlock', 'long_query']);
});

test('filterKinds with an empty set shows everything', () => {
  // A chip row with nothing ticked must not read as "nothing happened".
  const events = [ev('audit', 1), ev('deadlock', 2)];
  assert.equal(filterKinds(events, new Set()).length, 2);
});

test('bucketize folds events into epoch-aligned buckets', () => {
  const events = [
    ev('audit', 100), ev('deadlock', 200),           // bucket 0
    ev('audit', 1100),                                // bucket 1000
    ev('long_query', 2300), ev('audit', 2999),        // bucket 2000
  ];
  const out = bucketize(events, 1000);
  assert.deepEqual(out.map(b => [b.start, b.count]), [[0, 2], [1000, 1], [2000, 2]]);
  assert.equal(out[0].byKind.audit, 1);
  assert.equal(out[0].byKind.deadlock, 1);
  assert.equal(out[2].byKind.long_query, 1);
});

test('bucketize range edges: an event exactly on a boundary opens that bucket', () => {
  const events = [ev('audit', 1000), ev('audit', 1999), ev('audit', 2000)];
  const out = bucketize(events, 1000);
  assert.deepEqual(out.map(b => [b.start, b.count]), [[1000, 2], [2000, 1]]);
});

test('bucketize handles empty input and a non-positive width', () => {
  assert.deepEqual(bucketize([], 1000), []);
  assert.deepEqual(bucketize([ev('audit', 5)], 0), []);
});

test('groupByDay labels Today and Yesterday, dates the rest', () => {
  const now = new Date(2026, 8, 30, 14, 0, 0).getTime();       // 2026-09-30 14:00 local
  const today9 = new Date(2026, 8, 30, 9, 0, 0).getTime();
  const yesterday23 = new Date(2026, 8, 29, 23, 0, 0).getTime();
  const older = new Date(2026, 8, 20, 12, 0, 0).getTime();
  const events = mergeTimeline([
    ev('audit', today9), ev('deadlock', yesterday23), ev('audit', older),
  ]);
  const groups = groupByDay(events, now);
  assert.deepEqual(groups.map(g => g.label), ['Today', 'Yesterday', '2026-09-20']);
  assert.equal(groups[0].events.length, 1);
  assert.equal(groups[2].events[0].kind, 'audit');
});

test('groupByDay on empty input is no groups, not a crash', () => {
  assert.deepEqual(groupByDay([], Date.now()), []);
});

test('summarizeTitle collapses SQL whitespace and truncates', () => {
  const sql = 'SELECT *\nFROM   orders\nWHERE id = 1';
  const out = summarizeTitle(ev('audit', 0, sql));
  assert.equal(out, 'SELECT * FROM orders WHERE id = 1');
  const long = 'x'.repeat(500);
  const cut = summarizeTitle(ev('audit', 0, long), 100);
  assert.equal(cut.length, 100);
  assert.ok(cut.endsWith('…'));
});

test('localText renders the backend’s expected shape', () => {
  const d = new Date(2026, 0, 5, 9, 7, 3);
  assert.equal(localText(d), '2026-01-05 09:07:03');
});

test('timeOfDay renders HH:MM:SS', () => {
  const ms = new Date(2026, 8, 30, 14, 3, 11).getTime();
  assert.equal(timeOfDay(ms), '14:03:11');
});

test('mergeTimeline interleaves galera events with the other kinds', () => {
  const events = mergeTimeline([
    ev('audit', 1000), ev('galera_event', 3000), ev('deadlock', 2000),
  ]);
  assert.deepEqual(events.map(e => e.kind), ['galera_event', 'deadlock', 'audit']);
});

test('filterKinds selects galera events like any other kind', () => {
  const events = [ev('audit', 1), ev('galera_event', 2), ev('long_query', 3)];
  const out = filterKinds(events, new Set(['galera_event']));
  assert.deepEqual(out.map(e => e.kind), ['galera_event']);
});

test('every kind has a chip label', () => {
  for (const k of TIMELINE_KINDS) assert.ok(KIND_LABEL[k], `no label for ${k}`);
});
