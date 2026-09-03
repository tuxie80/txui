/**
 * Flavour-aware completion (src/utils/sqlKeywords.ts).
 *
 * MySQL and MariaDB share an engine here but not a grammar. Completing a
 * statement the connected server rejects is worse than completing nothing: the
 * suggestion is an implicit claim that it will work, and the user finds out it
 * does not by running it.
 *
 * Everything asserted here was checked against MariaDB 11.8 and MySQL 8.0.46
 * on the local fleet.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { keywordCatalog } from '../src/utils/sqlKeywords.ts';

const labels = (engine: 'mysql' | 'postgres', flavor?: 'mysql' | 'mariadb' | 'percona') =>
  new Set(keywordCatalog(engine, flavor).map(k => k.label));

describe('the measured plan is spelled per flavour', () => {
  /// MariaDB has no EXPLAIN ANALYZE at all — offering it is offering a syntax
  /// error. Its equivalent is ANALYZE, and only the JSON form is useful to us.
  test('MariaDB is offered ANALYZE FORMAT=JSON and not EXPLAIN ANALYZE', () => {
    const m = labels('mysql', 'mariadb');
    assert.ok(m.has('ANALYZE FORMAT=JSON'));
    assert.ok(!m.has('EXPLAIN ANALYZE'), 'MariaDB was offered a MySQL-only statement');
  });

  test('MySQL keeps EXPLAIN ANALYZE and is not offered the MariaDB form', () => {
    const m = labels('mysql', 'mysql');
    assert.ok(m.has('EXPLAIN ANALYZE'));
    assert.ok(!m.has('ANALYZE FORMAT=JSON'));
  });

  /// Percona is MySQL with extra instrumentation, not a different grammar.
  test('Percona is offered the MySQL set', () => {
    assert.deepEqual(labels('mysql', 'percona'), labels('mysql', 'mysql'));
  });

  /**
   * The flavour arrives from an async probe, so the first render has none.
   * Defaulting to MySQL is the cheaper mistake: it withholds MariaDB-only
   * syntax for a moment, rather than suggesting it to a MySQL server where it
   * is guaranteed to fail.
   */
  test('an unknown flavour is treated as MySQL', () => {
    assert.deepEqual(labels('mysql'), labels('mysql', 'mysql'));
  });
});

describe('MariaDB-only syntax', () => {
  const maria = labels('mysql', 'mariadb');
  const mysql = labels('mysql', 'mysql');

  test('sequences are offered on MariaDB and nowhere else', () => {
    for (const kw of ['CREATE SEQUENCE', 'ALTER SEQUENCE', 'NEXT VALUE FOR']) {
      assert.ok(maria.has(kw), `MariaDB is missing ${kw}`);
      assert.ok(!mysql.has(kw), `MySQL was offered ${kw}, which it does not have`);
    }
    assert.ok(maria.has('NEXTVAL'), 'the sequence functions are missing');
  });

  test('RETURNING is MariaDB-only among the MySQL family', () => {
    assert.ok(maria.has('RETURNING'));
    assert.ok(!mysql.has('RETURNING'));
    // …and PostgreSQL has had it all along.
    assert.ok(labels('postgres').has('RETURNING'));
  });

  test('CREATE OR REPLACE is offered on MariaDB only', () => {
    assert.ok(maria.has('CREATE OR REPLACE TABLE'));
    assert.ok(!mysql.has('CREATE OR REPLACE TABLE'));
  });

  test('system-versioned table syntax is offered', () => {
    assert.ok(maria.has('WITH SYSTEM VERSIONING'));
    assert.ok(maria.has('FOR SYSTEM_TIME AS OF'));
  });
});

describe('the shared set is still shared', () => {
  /// The split must not have moved ordinary MySQL syntax out from under
  /// MariaDB, which accepts nearly all of it.
  test('MariaDB keeps the common MySQL vocabulary', () => {
    const m = labels('mysql', 'mariadb');
    for (const kw of ['SHOW', 'USE', 'ON DUPLICATE KEY UPDATE', 'AUTO_INCREMENT',
                      'EXPLAIN FORMAT=JSON', 'SELECT']) {
      assert.ok(m.has(kw), `MariaDB lost ${kw}`);
    }
  });

  test('PostgreSQL is untouched by the flavour argument', () => {
    assert.deepEqual(labels('postgres', 'mariadb'), labels('postgres', 'mysql'));
  });

  test('no label is duplicated in any catalogue', () => {
    for (const f of ['mysql', 'mariadb', 'percona'] as const) {
      const all = keywordCatalog('mysql', f).map(k => k.label);
      assert.equal(all.length, new Set(all).size, `${f} has a duplicate completion`);
    }
  });
});
