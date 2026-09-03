/**
 * Reading CHANGELOG.md for the What's New window (src/utils/changelog.ts).
 *
 * The property that matters is that **nothing unreleased is shown**. A user
 * reading What's New is holding a specific binary; listing work that is not in
 * it sends them looking for a feature that does not exist.
 *
 * Run against the real file as well as against fixtures, because the real
 * file is the only input this ever has and its exact punctuation (em dash,
 * bracketed version) is what the parser keys on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChangelog } from '../src/utils/changelog.ts';

const REAL = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

test('the Unreleased section never appears', () => {
  const releases = parseChangelog(REAL);
  assert.ok(releases.length > 0, 'the real changelog parsed to nothing');
  for (const r of releases) {
    assert.doesNotMatch(r.version, /unreleased/i);
  }
});

test('lines under Unreleased are dropped, not attached to the release above it', () => {
  // The bug this pins: consume the heading but keep appending to the previous
  // release, and unshipped work is shown under the last version that shipped —
  // the worst possible outcome, because it looks released.
  const md = [
    '# Changelog', '',
    '## [Unreleased]', '',
    '- a thing that has not shipped', '',
    '## [1.0.0] — 2026-01-01', '',
    '- a thing that shipped', '',
  ].join('\n');
  const releases = parseChangelog(md);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].version, '1.0.0');
  assert.ok(releases[0].body.some(l => l.includes('that shipped')));
  assert.ok(!releases[0].body.some(l => l.includes('not shipped')));
});

test('order is the file order — newest first, never sorted by version string', () => {
  // '0.9.0' > '0.10.0' as strings, so any sort would put them backwards.
  const md = '## [0.10.0] — b\n\nx\n\n## [0.9.0] — a\n\ny\n';
  assert.deepEqual(parseChangelog(md).map(r => r.version), ['0.10.0', '0.9.0']);
});

test('the real file yields the current version first, with its date', () => {
  const [newest] = parseChangelog(REAL);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(newest.version, pkg.version,
    'the top changelog entry and package.json disagree — one of them was not bumped');
  assert.match(newest.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(newest.body.length > 0, 'the newest release has no body');
});

test('a heading with no date still parses', () => {
  const [r] = parseChangelog('## [2.0.0]\n\nbody\n');
  assert.equal(r.version, '2.0.0');
  assert.equal(r.date, '');
});

test('empty input is not an error', () => {
  assert.deepEqual(parseChangelog(''), []);
});
