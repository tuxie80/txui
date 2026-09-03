/**
 * Temporal history queries (src/utils/temporalSql.ts).
 *
 * A system-versioned table's whole point is the history, and every ordinary
 * query hides it: `SELECT *` returns only current rows and omits the
 * versioning columns entirely. So the failure mode is not a wrong number on
 * screen, it is a table that looks like it has no history at all.
 *
 * Checked against MariaDB 10.6.27 and 11.8.8.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { historySql, versionDiff, endedBy, isValidTimestamp } from '../src/utils/temporalSql.ts';

describe('the history query', () => {
  test('it asks for every version and names the hidden columns', () => {
    const sql = historySql({ table: 'app.acct', mode: { kind: 'all' } });
    assert.match(sql, /FOR SYSTEM_TIME ALL/);
    // Without naming them explicitly they do not appear — SELECT * omits them.
    assert.match(sql, /`row_start`/);
    assert.match(sql, /`row_end`/);
    assert.match(sql, /FROM `app`\.`acct`/);
  });

  /**
   * The sentinel that marks a row current is **version-dependent** — measured
   * as `2038-01-19 04:14:07.999999` on 10.6 and `2106-02-07 07:28:15.999999`
   * on 11.8. Matching either literal marks every row historical on the other
   * server, so the comparison has to be against the clock.
   */
  test('current-ness is decided against NOW(), not a hardcoded sentinel', () => {
    const sql = historySql({ table: 't', mode: { kind: 'all' } });
    assert.match(sql, /`row_end` > NOW\(6\) AS is_current/);
    assert.doesNotMatch(sql, /2038|2106/, 'a version-specific sentinel was baked in');
  });

  /// It leads because it is what makes the rest legible; a current row and a
  /// superseded one otherwise differ only by a timestamp.
  test('is_current is the first column', () => {
    assert.match(historySql({ table: 't', mode: { kind: 'all' } }), /^SELECT `row_end` > NOW\(6\) AS is_current,/);
  });

  test('newest first — storage order is not the order anything happened in', () => {
    assert.match(historySql({ table: 't', mode: { kind: 'all' } }), /ORDER BY `row_start` DESC/);
  });

  /**
   * The star must be **qualified**. `SELECT a, b, *` is a syntax error — a bare
   * star cannot follow other select items, and the versioning columns are
   * always selected first. Both servers rejected the unqualified form.
   */
  test('named columns are quoted; none means the qualified star', () => {
    assert.match(historySql({ table: 't', columns: ['id', 'bal'], mode: { kind: 'all' } }),
      /, `id`, `bal` FROM/);
    assert.match(historySql({ table: 'app.acct', mode: { kind: 'all' } }), /, `acct`\.\* FROM/);
    assert.doesNotMatch(historySql({ table: 'app.acct', mode: { kind: 'all' } }), /, \* FROM/);
  });

  test('a limit is applied when given and omitted when not', () => {
    assert.match(historySql({ table: 't', mode: { kind: 'all' }, limit: 500 }), /LIMIT 500$/);
    assert.doesNotMatch(historySql({ table: 't', mode: { kind: 'all' } }), /LIMIT/);
    assert.doesNotMatch(historySql({ table: 't', mode: { kind: 'all' }, limit: 0 }), /LIMIT/);
  });
});

describe('the temporal modes', () => {
  test('AS OF reads the table as it stood at an instant', () => {
    assert.match(historySql({ table: 't', mode: { kind: 'asOf', at: '2026-01-01 12:00:00' } }),
      /FOR SYSTEM_TIME AS OF '2026-01-01 12:00:00'/);
  });

  test('BETWEEN takes both bounds', () => {
    assert.match(
      historySql({ table: 't', mode: { kind: 'between', from: '2026-01-01', to: '2026-02-01' } }),
      /FOR SYSTEM_TIME BETWEEN '2026-01-01' AND '2026-02-01'/);
  });

  /**
   * `FOR SYSTEM_TIME` takes a literal, not a placeholder, so the timestamp is
   * concatenated and there is no bind parameter to hide behind. It comes from
   * a typed field.
   */
  test('a hostile timestamp cannot escape the literal', () => {
    const sql = historySql({ table: 't', mode: { kind: 'asOf', at: "2026-01-01'; DROP TABLE x; --" } });
    assert.doesNotMatch(sql, /DROP TABLE/);
    assert.doesNotMatch(sql, /;/);
    assert.match(sql, /AS OF '2026-01-01'/);
  });

  test('a backtick in a table name cannot break out either', () => {
    const sql = historySql({ table: 'a`b.c', mode: { kind: 'all' } });
    assert.match(sql, /`a``b`\.`c`/);
  });
});

describe('versionDiff', () => {
  const older = { id: 1, bal: '10.00', note: 'x', row_start: 'a', row_end: 'b', is_current: 0 };

  test('it names only the columns that changed', () => {
    assert.deepEqual(versionDiff(older, { ...older, bal: '20.00' }), ['bal']);
    assert.deepEqual(versionDiff(older, { ...older }), []);
  });

  /// Those move on every version by definition, so reporting them would mark
  /// every row as fully changed.
  test('the versioning columns are never reported as a change', () => {
    const d = versionDiff(older, { ...older, row_start: 'zzz', row_end: 'yyy', is_current: 1 });
    assert.deepEqual(d, []);
  });

  /// Values arrive already rendered; re-parsing to compare numerically would
  /// make the answer depend on the driver's formatting.
  test('comparison is textual, so 10.50 and 10.5 are different as written', () => {
    assert.deepEqual(versionDiff(older, { ...older, bal: '10.5' }), ['bal']);
    assert.deepEqual(versionDiff({ ...older, bal: 10 }, { ...older, bal: '10' }), []);
  });

  test('null and undefined are the same absence', () => {
    assert.deepEqual(versionDiff({ ...older, note: null }, { ...older, note: undefined }), []);
    assert.deepEqual(versionDiff({ ...older, note: null }, { ...older, note: 'x' }), ['note']);
  });
});

describe('endedBy', () => {
  /// The distinction a history view exists to show, and it cannot be read off
  /// one row: a deleted row's last version simply stops.
  test('a version with nothing after it was a delete', () => {
    assert.equal(endedBy(false, false), 'deleted');
  });

  test('a version followed by another was an update', () => {
    assert.equal(endedBy(false, true), 'updated');
  });

  test('the live version is neither', () => {
    assert.equal(endedBy(true, false), 'current');
  });
});

describe('isValidTimestamp', () => {
  /// The panel should refuse before the server does, so a typo does not read
  /// as a server error.
  test('the shapes MariaDB accepts', () => {
    for (const ok of ['2026-01-01', '2026-01-01 12:00', '2026-01-01 12:00:00',
                      '2026-01-01T12:00:00', '2026-01-01 12:00:00.123456']) {
      assert.equal(isValidTimestamp(ok), true, ok);
    }
  });

  test('and the ones it does not', () => {
    for (const bad of ['', 'yesterday', '01/01/2026', "2026-01-01'; DROP TABLE x"]) {
      assert.equal(isValidTimestamp(bad), false, bad);
    }
  });
});
