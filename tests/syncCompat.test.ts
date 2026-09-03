/**
 * Version-gated statements (src/utils/syncCompat.ts).
 *
 * The expectations here are not read from documentation — they are what a live
 * MySQL 8.0.46 and MySQL 8.4.10 pair actually accepted when the statement was
 * issued. 8.4 removed the master/slave vocabulary outright: the old spellings
 * are syntax errors there, not deprecations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, atLeast, isMariaDb, binlogStatusStatement, resetBinlogStatement,
  gtidAvailability, canSeedByGtid, seedCapability, changeSourceStatement,
  REPLICA_STATUS_STATEMENT, RESET_REPLICA_STATEMENT,
} from '../src/utils/syncCompat.ts';

const v = (s: string) => parseVersion(s);

// ── version parsing ─────────────────────────────────────────────────────────

test('a plain version parses', () => {
  assert.deepEqual(v('8.4.10'), { major: 8, minor: 4, patch: 10, raw: '8.4.10' });
});

test('real-world suffixes do not break it', () => {
  // Distro builds and MariaDB both carry suffixes.
  assert.equal(v('8.0.46-0ubuntu0.22.04.1').minor, 0);
  assert.equal(v('8.0.46-0ubuntu0.22.04.1').patch, 46);
  assert.equal(v('10.11.6-MariaDB').major, 10);
});

test('a missing patch component is zero, not NaN', () => {
  assert.equal(v('8.4').patch, 0);
});

test('an unparseable version does not throw', () => {
  // A server that reports something unexpected must degrade, not crash.
  assert.equal(v('unknown').major, 0);
});

test('comparison is numeric, not lexicographic', () => {
  // "8.10" > "8.4" numerically but not as strings — the classic bug.
  assert.ok(atLeast(v('8.10.0'), 8, 4));
  assert.ok(!atLeast(v('8.0.46'), 8, 4));
  assert.ok(atLeast(v('9.0.0'), 8, 4));
});

// ── the statements, as the servers actually answered ────────────────────────

test('8.0 gets SHOW MASTER STATUS, 8.4 gets SHOW BINARY LOG STATUS', () => {
  // Verified live: each spelling worked on exactly one of the two servers.
  assert.equal(binlogStatusStatement(v('8.0.46')), 'SHOW MASTER STATUS');
  assert.equal(binlogStatusStatement(v('8.4.10')), 'SHOW BINARY LOG STATUS');
});

test('8.0 gets RESET MASTER, 8.4 gets RESET BINARY LOGS AND GTIDS', () => {
  assert.equal(resetBinlogStatement(v('8.0.46')), 'RESET MASTER');
  assert.equal(resetBinlogStatement(v('8.4.10')), 'RESET BINARY LOGS AND GTIDS');
});

test('a future major keeps the modern spelling', () => {
  assert.equal(binlogStatusStatement(v('9.5.0')), 'SHOW BINARY LOG STATUS');
  assert.equal(resetBinlogStatement(v('9.5.0')), 'RESET BINARY LOGS AND GTIDS');
});

test('MariaDB keeps the legacy spelling whatever its version number', () => {
  // MariaDB 10.x/11.x version numbers sail past 8.4 while the vocabulary stays.
  assert.ok(isMariaDb(v('10.11.6-MariaDB')));
  assert.equal(binlogStatusStatement(v('11.4.2-MariaDB')), 'SHOW MASTER STATUS');
  assert.equal(resetBinlogStatement(v('11.4.2-MariaDB')), 'RESET MASTER');
});

test('statements that work on BOTH servers are not version-gated', () => {
  // Verified live on 8.0 and 8.4 alike. A branch that can only ever be wrong
  // is worse than no branch.
  assert.equal(REPLICA_STATUS_STATEMENT, 'SHOW REPLICA STATUS');
  assert.equal(RESET_REPLICA_STATEMENT, 'RESET REPLICA');
});

test('no legacy vocabulary is emitted where a modern spelling exists', () => {
  for (const s of [REPLICA_STATUS_STATEMENT, RESET_REPLICA_STATEMENT]) {
    assert.ok(!/\b(MASTER|SLAVE)\b/.test(s), s);
  }
});

// ── gtid_mode has four values ───────────────────────────────────────────────

test('only ON means every transaction has a GTID', () => {
  assert.equal(gtidAvailability('ON'), 'complete');
  assert.ok(canSeedByGtid('ON'));
});

test('the PERMISSIVE modes are partial, and must not read as usable', () => {
  // Mid-migration states where the GTID set is INCOMPLETE. Treating them as
  // "on" seeds a replica that silently skips or replays transactions.
  assert.equal(gtidAvailability('ON_PERMISSIVE'), 'partial');
  assert.equal(gtidAvailability('OFF_PERMISSIVE'), 'partial');
  assert.ok(!canSeedByGtid('ON_PERMISSIVE'));
  assert.ok(!canSeedByGtid('OFF_PERMISSIVE'));
});

test('OFF and unknown are distinguished', () => {
  // "we know it is off" and "we could not read it" are different facts and the
  // manifest records which one it was.
  assert.equal(gtidAvailability('OFF'), 'off');
  assert.equal(gtidAvailability(null), 'unknown');
  assert.equal(gtidAvailability(undefined), 'unknown');
  assert.equal(gtidAvailability(''), 'unknown');
});

test('case and whitespace do not change the verdict', () => {
  assert.equal(gtidAvailability('  on  '), 'complete');
  assert.equal(gtidAvailability('Off_Permissive'), 'partial');
});

test('the manifest sentence names the actual mode when it is partial', () => {
  // "GTID unavailable" would not tell anyone why, and this is the case people
  // most need explained.
  const s = seedCapability('ON_PERMISSIVE');
  assert.match(s, /ON_PERMISSIVE/);
  assert.match(s, /INCOMPLETE/);
  assert.match(s, /coordinates/);
});

test('every gtid_mode produces a usable sentence', () => {
  for (const m of ['ON', 'OFF', 'ON_PERMISSIVE', 'OFF_PERMISSIVE', null]) {
    assert.ok(seedCapability(m).length > 40, String(m));
  }
});

// ── the generated statement ─────────────────────────────────────────────────

const conn = { host: 'db-source', port: 3306, user: 'repl' };

test('a GTID position produces SOURCE_AUTO_POSITION = 1', () => {
  const s = changeSourceStatement(
    { gtidExecuted: 'uuid:1-500', logFile: null, logPos: null }, conn);
  assert.match(s, /CHANGE REPLICATION SOURCE TO/);
  assert.match(s, /SOURCE_AUTO_POSITION = 1/);
  assert.ok(!/SOURCE_LOG_FILE/.test(s));
});

test('coordinates produce SOURCE_LOG_FILE and SOURCE_LOG_POS', () => {
  const s = changeSourceStatement(
    { gtidExecuted: null, logFile: 'binlog.000043', logPos: 67337257 }, conn);
  assert.match(s, /SOURCE_LOG_FILE = 'binlog\.000043'/);
  assert.match(s, /SOURCE_LOG_POS = 67337257/);
  assert.ok(!/AUTO_POSITION/.test(s));
});

test('GTID wins when both were captured', () => {
  const s = changeSourceStatement(
    { gtidExecuted: 'uuid:1-9', logFile: 'binlog.1', logPos: 4 }, conn);
  assert.match(s, /SOURCE_AUTO_POSITION = 1/);
});

test('no position at all yields a comment, not a runnable statement', () => {
  // Emitting a half-formed CHANGE REPLICATION SOURCE would be an invitation to
  // run it and find out.
  const s = changeSourceStatement(
    { gtidExecuted: null, logFile: null, logPos: null }, conn);
  assert.ok(s.startsWith('--'), s);
  assert.ok(!/CHANGE REPLICATION/.test(s));
});

test('the generated statement never uses legacy vocabulary', () => {
  const s = changeSourceStatement(
    { gtidExecuted: null, logFile: 'b.1', logPos: 4 }, conn);
  assert.ok(!/\bMASTER\b/.test(s), s);
});

test('a quote in the host or user cannot break out of the literal', () => {
  const s = changeSourceStatement(
    { gtidExecuted: 'g:1', logFile: null, logPos: null },
    { host: "it's", port: 3306, user: "o'brien" });
  assert.match(s, /SOURCE_HOST = 'it''s'/);
  assert.match(s, /SOURCE_USER = 'o''brien'/);
});

test('a missing port defaults rather than emitting null', () => {
  const s = changeSourceStatement(
    { gtidExecuted: 'g:1', logFile: null, logPos: null },
    { host: 'h', user: 'u' });
  assert.match(s, /SOURCE_PORT = 3306/);
});
