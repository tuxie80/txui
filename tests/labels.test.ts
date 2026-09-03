/**
 * Labels (src/utils/labels.ts).
 *
 * Labels are what fleet checks run against, so a label that resolves to the
 * wrong set of servers is not a display bug — it is a check that silently
 * covers two servers when you believed it covered three, and reports "in sync"
 * about a server it never looked at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLabels, formatLabels, visibleLabels, labelsFromTags, labelsOf, hasLabel,
  groupByLabel, fleetLabels, matchesLabelSearch, labelKey,
} from '../src/utils/labels.ts';
import type { Labelled } from '../src/utils/labels.ts';

const conn = (id: string, text: string): Labelled =>
  ({ id, name: id, labels: parseLabels(text) });

// ── parsing ─────────────────────────────────────────────────────────────────

test('a comma-separated list becomes visible labels', () => {
  assert.deepEqual(parseLabels('cz-test, prod-eu'), [
    { name: 'cz-test', hidden: false },
    { name: 'prod-eu', hidden: false },
  ]);
});

test('a leading dot marks a label hidden', () => {
  assert.deepEqual(parseLabels('cz-test, .billing'), [
    { name: 'cz-test', hidden: false },
    { name: 'billing', hidden: true },
  ]);
});

test('whitespace and empty entries are ignored', () => {
  assert.deepEqual(parseLabels('  a ,, b  ,  '), [
    { name: 'a', hidden: false },
    { name: 'b', hidden: false },
  ]);
  assert.deepEqual(parseLabels(''), []);
  assert.deepEqual(parseLabels('.'), []);   // a bare marker names nothing
  assert.deepEqual(parseLabels(' . '), []);
});

test('duplicates collapse, and hidden wins', () => {
  // Someone who marked it hidden anywhere meant it; showing it because the
  // other spelling came first would ignore a deliberate act.
  assert.deepEqual(parseLabels('x, .x'), [{ name: 'x', hidden: true }]);
  assert.deepEqual(parseLabels('.x, x'), [{ name: 'x', hidden: true }]);
});

test('duplicates differing only in case collapse too', () => {
  // Two spellings naming different server sets is the trap this prevents.
  assert.deepEqual(parseLabels('CZ-test, cz-test'), [{ name: 'CZ-test', hidden: false }]);
  assert.equal(labelKey(' CZ-Test '), 'cz-test');
});

test('the text form round-trips exactly', () => {
  for (const text of ['cz-test, prod-eu', 'a, .b, c', '.only-hidden']) {
    assert.equal(formatLabels(parseLabels(text)), text);
  }
});

test('visible labels exclude the hidden ones', () => {
  assert.deepEqual(visibleLabels(parseLabels('a, .b, c')).map(l => l.name), ['a', 'c']);
});

// ── migration from tags ─────────────────────────────────────────────────────

test('old tags become visible labels', () => {
  // Tags were only ever displayed, so nothing was meant to be hidden.
  assert.deepEqual(labelsFromTags(['reporting', 'eu']), [
    { name: 'reporting', hidden: false },
    { name: 'eu', hidden: false },
  ]);
  assert.deepEqual(labelsFromTags(undefined), []);
  assert.deepEqual(labelsFromTags([]), []);
});

test('a connection still on tags reads as labelled', () => {
  const legacy: Labelled = { id: '1', name: 'old', tags: ['cz-test'] };
  assert.deepEqual(labelsOf(legacy), [{ name: 'cz-test', hidden: false }]);
  assert.ok(hasLabel(legacy, 'CZ-TEST'));
});

test('labels win over tags once a connection has been migrated', () => {
  const both: Labelled = { id: '1', name: 'x', labels: parseLabels('new'), tags: ['old'] };
  assert.deepEqual(labelsOf(both).map(l => l.name), ['new']);
});

// ── grouping — the part the fleet checks depend on ──────────────────────────

test('a label collects every server carrying it', () => {
  const cz = groupByLabel([
    conn('m', 'cz-test'), conn('r1', 'cz-test'), conn('r2', 'cz-test, other'),
  ]).find(g => g.name === 'cz-test');
  assert.equal(cz?.members.length, 3);
});

test('a server belongs to every one of its labels at once', () => {
  // The whole reason folders cannot be the mechanism: one server, many sets.
  const groups = groupByLabel([conn('a', 'cz-test, prod-eu, .billing')]);
  assert.deepEqual(groups.map(g => g.name).sort(), ['billing', 'cz-test', 'prod-eu']);
  for (const g of groups) assert.equal(g.members.length, 1);
});

test('groups are ordered by size, then name', () => {
  // A label naming eight servers is likelier to be the one you want than one
  // naming a single server; alphabetical order buries it.
  const groups = groupByLabel([
    conn('a', 'big, small'), conn('b', 'big'), conn('c', 'big'),
  ]);
  assert.deepEqual(groups.map(g => g.name), ['big', 'small']);
});

test('case-different spellings land in ONE group', () => {
  const groups = groupByLabel([conn('a', 'CZ-test'), conn('b', 'cz-test')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 2);
});

test('a label is hidden only when every server hides it', () => {
  // One server showing it is a deliberate act; suppressing it globally would
  // leave that person no way to see what they asked for.
  const mixed = groupByLabel([conn('a', '.billing'), conn('b', 'billing')]);
  assert.equal(mixed[0].hidden, false);
  const all = groupByLabel([conn('a', '.billing'), conn('b', '.billing')]);
  assert.equal(all[0].hidden, true);
});

test('fleet labels are the ones naming more than one server', () => {
  // A "fleet" check across a single server compares it with nothing.
  const labels = fleetLabels([
    conn('a', 'pair, alone'), conn('b', 'pair'),
  ]);
  assert.deepEqual(labels.map(l => l.name), ['pair']);
});

test('grouping an empty list yields no labels', () => {
  assert.deepEqual(groupByLabel([]), []);
});

// ── search ──────────────────────────────────────────────────────────────────

test('hidden labels are still searchable', () => {
  // Hidden means "not shown", never "not findable".
  const c = conn('a', 'cz-test, .billing');
  assert.ok(matchesLabelSearch(c, 'billing'));
  assert.ok(matchesLabelSearch(c, 'BILL'));
  assert.ok(!matchesLabelSearch(c, 'nope'));
});

test('an empty query matches everything', () => {
  assert.ok(matchesLabelSearch(conn('a', 'x'), '   '));
});
