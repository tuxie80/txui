/**
 * Timed buffer snapshots (src/utils/backups.ts). `bufferStore` keeps the
 * *current* text, which answers "the app closed" — this answers "I deleted
 * three hundred lines twenty minutes ago and saved".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSnapshot, describeAge, MAX_SNAPSHOTS, MAX_SNAPSHOT_CHARS, MAX_TOTAL_CHARS,
  parseBackups, prune, serializeBackups, type Snapshot,
} from '../src/utils/backups.ts';

const snap = (over: Partial<Snapshot> = {}): Snapshot =>
  ({ label: '01', at: 1000, text: 'SELECT 1;', ...over });

describe('addSnapshot', () => {
  test('the newest goes first', () => {
    const out = addSnapshot([snap({ at: 1 })], snap({ at: 2, text: 'SELECT 2;' }));
    assert.equal(out[0].at, 2);
    assert.equal(out.length, 2);
  });

  /// The timer fires every two minutes whether or not anything changed; without
  /// this the list fills with copies of a file nobody is editing.
  test('an unchanged buffer does not add a second copy', () => {
    const list = [snap()];
    assert.deepEqual(addSnapshot(list, snap({ at: 9999 })), list);
  });

  test('the same text under a different tab is still kept', () => {
    const out = addSnapshot([snap({ label: '01' })], snap({ label: '02' }));
    assert.equal(out.length, 2);
  });

  test('a changed buffer is kept even seconds later', () => {
    const out = addSnapshot([snap()], snap({ at: 1001, text: 'SELECT 2;' }));
    assert.equal(out.length, 2);
  });

  /// An empty buffer is not work worth recovering.
  test('a blank buffer is not snapshotted', () => {
    assert.deepEqual(addSnapshot([], snap({ text: '   \n\n' })), []);
    assert.deepEqual(addSnapshot([], snap({ text: '' })), []);
  });

  /// One enormous buffer would blow the whole budget on its own.
  test('an oversized buffer is skipped rather than truncated', () => {
    const huge = 'x'.repeat(MAX_SNAPSHOT_CHARS + 1);
    assert.deepEqual(addSnapshot([], snap({ text: huge })), []);
  });
});

describe('prune', () => {
  test('keeps the newest up to the count limit', () => {
    const many = Array.from({ length: MAX_SNAPSHOTS + 10 }, (_, i) => snap({ at: i, text: `q${i}` }));
    const out = prune(many);
    assert.equal(out.length, MAX_SNAPSHOTS);
    assert.equal(out[0].at, MAX_SNAPSHOTS + 9, 'the newest must survive');
  });

  test('sorts newest first even from a shuffled list', () => {
    const out = prune([snap({ at: 5 }), snap({ at: 50, text: 'b' }), snap({ at: 1, text: 'c' })]);
    assert.deepEqual(out.map(s => s.at), [50, 5, 1]);
  });

  /// The count limit alone would still allow forty copies of a 2 MB script,
  /// which is 80 MB of JSON to parse on every open.
  test('the character budget drops the oldest even under the count limit', () => {
    const big = 'x'.repeat(MAX_TOTAL_CHARS / 2);
    const out = prune([
      snap({ at: 3, text: big }),
      snap({ at: 2, text: big }),
      snap({ at: 1, text: big }),
    ]);
    assert.ok(out.length < 3, `expected trimming, kept ${out.length}`);
    assert.equal(out[0].at, 3, 'the newest must survive the budget');
  });

  /// Even a single snapshot over the whole budget is kept — dropping it would
  /// mean the feature silently does nothing for large files.
  test('one oversized snapshot is still kept rather than leaving nothing', () => {
    const out = prune([snap({ text: 'x'.repeat(MAX_TOTAL_CHARS * 2) })]);
    assert.equal(out.length, 1);
  });

  test('an empty list prunes to empty', () => {
    assert.deepEqual(prune([]), []);
  });
});

describe('serialization', () => {
  test('round-trips', () => {
    const list = [snap(), snap({ at: 2, text: 'b', path: '/w/x.sql' })];
    assert.deepEqual(parseBackups(serializeBackups(list)), list);
  });

  test('garbage yields no snapshots rather than throwing', () => {
    for (const bad of ['', null, undefined, 'nope', '{}', '[]', '{"snapshots":3}']) {
      assert.deepEqual(parseBackups(bad as string), []);
    }
  });

  test('a malformed entry is dropped without taking the good ones', () => {
    const text = JSON.stringify({
      version: 1,
      snapshots: [{ at: 1, text: 'ok' }, { text: 'no timestamp' }, null, { at: 2 }],
    });
    assert.deepEqual(parseBackups(text).map(s => s.text), ['ok']);
  });

  test('a snapshot with no label still loads, named untitled', () => {
    const text = JSON.stringify({ version: 1, snapshots: [{ at: 1, text: 'x' }] });
    assert.equal(parseBackups(text)[0].label, 'untitled');
  });
});

describe('describeAge', () => {
  const M = 60000;
  test('reads in the unit that fits', () => {
    assert.equal(describeAge(1000, 1000), 'just now');
    assert.equal(describeAge(0, 5 * M), '5 min ago');
    assert.equal(describeAge(0, 3 * 60 * M), '3 h ago');
    assert.equal(describeAge(0, 50 * 60 * M), '2 d ago');
  });

  /// A clock that moved backwards must not produce "-3 min ago".
  test('a timestamp in the future reads as just now', () => {
    assert.equal(describeAge(10 * M, 0), 'just now');
  });
});
