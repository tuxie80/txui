/**
 * Server flavour detection (src/utils/serverFlavor.ts).
 *
 * Every version string here was read off a real server on the local fleet —
 * `SELECT VERSION()` and, where they differ, the handshake greeting packet.
 * The failure this guards is quiet: get the flavour or the version wrong and
 * every capability gate takes the other branch, which shows up as a panel
 * running MySQL's SQL against MariaDB and reporting the server's error as
 * though the user had done something wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFlavor, atLeast, capabilities, flavorLabel, isMariaDb,
} from '../src/utils/serverFlavor.ts';

describe('detection', () => {
  test('MySQL is recognised from its plain version', () => {
    const v = detectFlavor('8.0.46');
    assert.equal(v.flavor, 'mysql');
    assert.deepEqual([v.major, v.minor, v.patch], [8, 0, 46]);
  });

  test('MariaDB is recognised from the suffix', () => {
    const v = detectFlavor('11.8.8-MariaDB-log');
    assert.equal(v.flavor, 'mariadb');
    assert.deepEqual([v.major, v.minor, v.patch], [11, 8, 8]);
  });

  /**
   * The trap. MariaDB 10.x prefixes `5.5.5-` in its **handshake**, which is
   * where a driver reads the version from — so the string a client actually
   * sees for MariaDB 10.6 begins with a 5. Parsing the first number would make
   * every `atLeast` check below take the MySQL-5.5 branch.
   *
   * Verified by reading the greeting packet: 10.6 and 10.11 send the prefix,
   * 11.4 and 11.8 do not.
   */
  test('the 5.5.5 handshake prefix does not become the version', () => {
    const v = detectFlavor('5.5.5-10.6.27-MariaDB-log');
    assert.equal(v.flavor, 'mariadb');
    assert.deepEqual([v.major, v.minor, v.patch], [10, 6, 27],
      'the compatibility prefix was read as the server version');
    assert.equal(atLeast(v, 10, 3), true, 'a 10.3+ feature was gated off');
  });

  test('11.x sends no prefix and parses the same way', () => {
    const v = detectFlavor('11.4.12-MariaDB-log');
    assert.deepEqual([v.major, v.minor, v.patch], [11, 4, 12]);
  });

  /// Percona's version string is MySQL's; only the comment gives it away.
  test('Percona is recognised from version_comment alone', () => {
    const v = detectFlavor('8.0.36-28', 'Percona Server (GPL), Release 28');
    assert.equal(v.flavor, 'percona');
    assert.equal(v.major, 8);
  });

  test('a MariaDB comment is enough when the version does not say so', () => {
    assert.equal(detectFlavor('10.11.18', 'mariadb.org binary distribution').flavor, 'mariadb');
  });

  test('an unparseable version does not throw and does not claim a version', () => {
    const v = detectFlavor('');
    assert.equal(v.flavor, 'mysql');
    assert.deepEqual([v.major, v.minor, v.patch], [0, 0, 0]);
    // Everything version-gated must be off, not accidentally on.
    assert.equal(capabilities(v).dataLocks, false);
  });

  test('the raw string is kept — it is what a user recognises', () => {
    assert.equal(detectFlavor(' 11.8.8-MariaDB-log ').raw, '11.8.8-MariaDB-log');
  });
});

describe('atLeast', () => {
  const v = detectFlavor('10.6.27-MariaDB');
  test('compares major before minor before patch', () => {
    assert.equal(atLeast(v, 10, 6, 27), true);
    assert.equal(atLeast(v, 10, 6, 28), false);
    assert.equal(atLeast(v, 10, 5), true);
    assert.equal(atLeast(v, 10, 11), false, '10.6 is older than 10.11, not newer');
    assert.equal(atLeast(v, 9), true);
    assert.equal(atLeast(v, 11), false);
  });

  /// String comparison would put 10.6 after 10.11. Numeric is the point.
  test('double-digit minors sort numerically', () => {
    assert.equal(atLeast(detectFlavor('10.11.18-MariaDB'), 10, 6), true);
  });
});

/**
 * Each of these was confirmed by running the statement against the fleet —
 * MySQL 8.0.46 and 8.4.10, MariaDB 10.6.27, 10.11.18, 11.4.12 and 11.8.8.
 */
describe('capabilities', () => {
  const maria = (s: string) => capabilities(detectFlavor(s));
  const my = (s: string) => capabilities(detectFlavor(s));

  test('locks come from different places on each', () => {
    assert.equal(my('8.0.46').dataLocks, true);
    assert.equal(my('8.0.46').innodbLocksTable, false, 'MySQL 8 removed INNODB_LOCKS');
    assert.equal(maria('11.8.8-MariaDB').dataLocks, false, 'MariaDB has no data_locks');
    assert.equal(maria('11.8.8-MariaDB').innodbLocksTable, true);
  });

  test('the measured plan is spelled differently', () => {
    assert.equal(my('8.0.46').explainAnalyze, true);
    assert.equal(my('8.0.46').analyzeFormatJson, false);
    assert.equal(maria('11.8.8-MariaDB').explainAnalyze, false);
    assert.equal(maria('11.8.8-MariaDB').analyzeFormatJson, true);
  });

  test('EXPLAIN ANALYZE is 8.0.18, not 8.0', () => {
    assert.equal(my('8.0.17').explainAnalyze, false);
    assert.equal(my('8.0.18').explainAnalyze, true);
  });

  test('replication vocabulary does not overlap', () => {
    assert.equal(my('8.0.46').replicationPsTables, true);
    assert.equal(my('8.0.46').mysqlGtid, true);
    assert.equal(maria('11.8.8-MariaDB').replicationPsTables, false);
    assert.equal(maria('11.8.8-MariaDB').mysqlGtid, false);
  });

  /// Sequences arrived in 10.3 but information_schema.SEQUENCES only in 11.0 —
  /// measured: 10.6 and 10.11 have sequences and no such view, 11.8 has both.
  test('sequences and their catalog view arrived at different times', () => {
    assert.equal(maria('10.6.27-MariaDB').sequences, true);
    assert.equal(maria('10.6.27-MariaDB').sequencesInInformationSchema, false);
    assert.equal(maria('11.8.8-MariaDB').sequencesInInformationSchema, true);
    assert.equal(my('8.0.46').sequences, false);
  });

  test('MariaDB JSON is not a native type', () => {
    assert.equal(my('8.0.46').nativeJsonType, true);
    assert.equal(maria('11.8.8-MariaDB').nativeJsonType, false);
  });

  test('the redo log setting differs and is version-gated on MySQL', () => {
    assert.equal(my('8.0.30').redoLogCapacity, true);
    assert.equal(my('8.0.29').redoLogCapacity, false);
    assert.equal(maria('11.8.8-MariaDB').redoLogCapacity, false);
  });

  test('MariaDB-only SQL is off for MySQL', () => {
    const m = my('8.4.10');
    assert.equal(m.createOrReplace, false);
    assert.equal(m.returningClause, false);
    assert.equal(m.systemVersioning, false);
    assert.equal(m.globalPrivTable, false);
  });

  /// Percona is MySQL plus instrumentation — none of these change.
  test('Percona answers as MySQL does', () => {
    const p = capabilities(detectFlavor('8.0.36-28', 'Percona Server (GPL)'));
    assert.deepEqual(p, capabilities(detectFlavor('8.0.36')));
  });

  test('every MariaDB on the fleet agrees on the fork-level differences', () => {
    for (const v of ['10.6.27-MariaDB', '10.11.18-MariaDB', '11.4.12-MariaDB', '11.8.8-MariaDB']) {
      const c = maria(v);
      assert.equal(c.dataLocks, false, v);
      assert.equal(c.analyzeFormatJson, true, v);
      assert.equal(c.mysqlGtid, false, v);
      assert.equal(c.nativeJsonType, false, v);
    }
  });
});

describe('label', () => {
  test('each flavour is named as its users name it', () => {
    assert.equal(flavorLabel(detectFlavor('11.8.8-MariaDB-log')), 'MariaDB 11.8.8');
    assert.equal(flavorLabel(detectFlavor('8.0.46')), 'MySQL 8.0.46');
    assert.equal(flavorLabel(detectFlavor('8.0.36-28', 'Percona Server')), 'Percona 8.0.36');
  });

  test('the 5.5.5 prefix does not reach the label either', () => {
    assert.equal(flavorLabel(detectFlavor('5.5.5-10.6.27-MariaDB-log')), 'MariaDB 10.6.27');
  });

  test('isMariaDb agrees with the flavour', () => {
    assert.equal(isMariaDb(detectFlavor('10.6.27-MariaDB')), true);
    assert.equal(isMariaDb(detectFlavor('8.0.46')), false);
  });
});
