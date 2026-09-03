/**
 * A tab's link to a file (src/utils/sqlFile.ts). The gap this closes: the
 * open handler used to receive `{ name, text }` and discard the path, so
 * nothing could Save in place or notice a change on disk.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseName, dirName, diskState, isDirty, parseRecent, pushRecent,
  recentLabels, tabLabelFor, type FileBinding,
} from '../src/utils/sqlFile.ts';

const bind = (over: Partial<FileBinding> = {}): FileBinding => ({
  path: '/w/orders.sql', encoding: 'UTF-8', eol: 'lf', mtimeMs: 1000,
  savedText: 'SELECT 1;', ...over,
});

describe('isDirty', () => {
  /// The distinction that makes a dirty marker worth showing: differs from
  /// the file, not merely "has text in it".
  test('matching the file is not dirty', () => {
    assert.equal(isDirty(bind(), 'SELECT 1;'), false);
  });

  test('differing from the file is dirty', () => {
    assert.equal(isDirty(bind(), 'SELECT 2;'), true);
  });

  test('editing and undoing back to the original is not dirty', () => {
    const f = bind();
    assert.equal(isDirty(f, 'SELECT 9;'), true);
    assert.equal(isDirty(f, 'SELECT 1;'), false);
  });

  /// A scratch buffer has no file, so it can never differ from one.
  test('an unbound tab is never dirty', () => {
    assert.equal(isDirty(undefined, 'anything at all'), false);
  });

  test('whitespace counts — it is a real difference on disk', () => {
    assert.equal(isDirty(bind(), 'SELECT 1; '), true);
  });
});

describe('paths', () => {
  test('base name on both separators', () => {
    assert.equal(baseName('/home/j/orders.sql'), 'orders.sql');
    assert.equal(baseName('C:\\sql\\orders.sql'), 'orders.sql');
    assert.equal(baseName('orders.sql'), 'orders.sql');
  });

  test('tab label drops the extension', () => {
    assert.equal(tabLabelFor('/w/orders.sql'), 'orders');
    assert.equal(tabLabelFor('/w/notes.txt'), 'notes');
    assert.equal(tabLabelFor('/w/dump.sql.gz'), 'dump.sql.gz');
  });

  test('a file called only .sql still yields a usable label', () => {
    assert.equal(tabLabelFor('/w/.sql'), 'query');
  });

  test('directory part', () => {
    assert.equal(dirName('/home/j/orders.sql'), '/home/j');
    assert.equal(dirName('C:\\sql\\orders.sql'), 'C:\\sql');
    assert.equal(dirName('orders.sql'), '');
  });
});

describe('diskState', () => {
  test('the same mtime is unchanged', () => {
    assert.equal(diskState(bind(), { mtimeMs: 1000 }), 'same');
  });

  test('a newer mtime is a change', () => {
    assert.equal(diskState(bind(), { mtimeMs: 2000 }), 'changed');
  });

  /// An older mtime is still a change — a restore from backup counts.
  test('an older mtime is also a change, not a no-op', () => {
    assert.equal(diskState(bind(), { mtimeMs: 5 }), 'changed');
  });

  /// Gone is not the same as unchanged, and saving over it is a different
  /// decision from reloading it.
  test('a missing file is reported as deleted', () => {
    assert.equal(diskState(bind(), null), 'deleted');
  });
});

describe('recent files', () => {
  test('a new path goes to the front', () => {
    assert.deepEqual(pushRecent(['a', 'b'], 'c'), ['c', 'a', 'b']);
  });

  test('reopening moves it to the front rather than duplicating', () => {
    assert.deepEqual(pushRecent(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
  });

  test('the list is capped', () => {
    const many = Array.from({ length: 30 }, (_, i) => `f${i}`);
    assert.equal(pushRecent(many, 'new', 15).length, 15);
    assert.equal(pushRecent(many, 'new', 15)[0], 'new');
  });

  /// On Linux these are two files; folding them would hide one.
  test('paths differing only in case are kept apart', () => {
    assert.deepEqual(pushRecent(['/w/Orders.sql'], '/w/orders.sql'),
                     ['/w/orders.sql', '/w/Orders.sql']);
  });

  test('a corrupt or absent stored list reads as empty', () => {
    for (const raw of [null, '', 'not json', '{}', '[1,2]']) {
      assert.deepEqual(parseRecent(raw), raw === '[1,2]' ? [] : []);
    }
  });

  test('a stored list of strings survives', () => {
    assert.deepEqual(parseRecent('["a","b"]'), ['a', 'b']);
  });
});

describe('recentLabels', () => {
  test('unique names show as just the name', () => {
    assert.deepEqual(
      recentLabels(['/w/orders.sql', '/w/billing.sql']).map(r => r.label),
      ['orders.sql', 'billing.sql']);
  });

  /// Four entries all reading `up.sql` would be useless.
  test('repeated names gain their parent directory', () => {
    assert.deepEqual(
      recentLabels(['/a/migrations/up.sql', '/b/migrations/up.sql']).map(r => r.label),
      ['migrations/up.sql', 'migrations/up.sql']);
  });

  test('only the repeated names are disambiguated', () => {
    const out = recentLabels(['/a/up.sql', '/b/up.sql', '/c/only.sql']);
    assert.equal(out[2].label, 'only.sql');
    assert.equal(out[0].label, 'a/up.sql');
  });

  test('the path is always carried alongside the label', () => {
    assert.deepEqual(recentLabels(['/w/x.sql']), [{ path: '/w/x.sql', label: 'x.sql' }]);
  });
});
