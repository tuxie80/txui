import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isChannelSection, toChannel, channelSummary, channelError, shortenGtid,
  yn, lagHealth, isRunning, visibleDetailRows, kvHealth,
} from '../src/utils/replication.ts';

const section = (title: string, kv: [string, string][]) => ({ title, kv, table: null });

const HEALTHY_KV: [string, string][] = [
  ['Channel_Name', ''],
  ['Replica_IO_Running', 'Yes'],
  ['Replica_SQL_Running', 'Yes'],
  ['Seconds_Behind_Source', '0'],
  ['Source_Host', '10.0.0.5'],
  ['Source_Port', '3306'],
  ['Source_Log_File', 'binlog.000042'],
  ['Read_Source_Log_Pos', '1540'],
  ['Relay_Source_Log_File', 'binlog.000042'],
  ['Exec_Source_Log_Pos', '1200'],
  ['Retrieved_Gtid_Set', '3e11fa47-71ca-11e1-9e33-c80aa9429562:1-5'],
  ['Executed_Gtid_Set', '3e11fa47-71ca-11e1-9e33-c80aa9429562:1-5'],
  ['Last_IO_Errno', '0'],
  ['Last_IO_Error', ''],
  ['Last_SQL_Errno', '0'],
  ['Last_SQL_Error', ''],
];

test('isChannelSection detects thread-state keys, modern and legacy', () => {
  assert.equal(isChannelSection(section('Replica status', [['Replica_IO_Running', 'Yes']])), true);
  assert.equal(isChannelSection(section('Replica status', [['Slave_SQL_Running', 'Yes']])), true);
  assert.equal(isChannelSection(section('Connected replicas', [['Server_Id', '2']])), false);
  assert.equal(isChannelSection({ title: 'x', kv: null, table: null }), false);
});

test('toChannel defaults an unnamed channel to (default)', () => {
  const c = toChannel(section("Replica status for channel ''", HEALTHY_KV));
  assert.equal(c.name, '(default)');
});

test('toChannel picks the channel name from the field or the section title', () => {
  const named = toChannel(section("Replica status for channel 'east'", [
    ['Channel_Name', 'east'], ['Replica_IO_Running', 'Yes'],
  ]));
  assert.equal(named.name, 'east');
  const fromTitle = toChannel(section("Replica status for channel 'west'", [
    ['Replica_IO_Running', 'Yes'],
  ]));
  assert.equal(fromTitle.name, 'west');
});

test('toChannel falls back to legacy Master_/Slave_ field names', () => {
  const c = toChannel(section('Slave status', [
    ['Slave_IO_Running', 'No'],
    ['Slave_SQL_Running', 'Yes'],
    ['Seconds_Behind_Master', '12'],
    ['Master_Host', 'db1'],
    ['Master_Port', '3307'],
  ]));
  assert.equal(c.io, 'No');
  assert.equal(c.sql, 'Yes');
  assert.equal(c.behind, '12');
  assert.equal(c.sourceHost, 'db1');
  assert.equal(c.sourcePort, '3307');
});

test('channelSummary builds the vital row cells with health', () => {
  const s = channelSummary(toChannel(section('t', HEALTHY_KV)));
  assert.equal(s.running, true);
  assert.equal(s.io, 'Yes');
  assert.equal(s.ioHealth, 'good');
  assert.equal(s.sqlHealth, 'good');
  assert.equal(s.behind, '0');
  assert.equal(s.behindHealth, 'good');
  assert.equal(s.source, '10.0.0.5:3306');
});

test('channelSummary marks a stopped thread and NULL lag as bad', () => {
  const c = toChannel(section('t', [
    ['Replica_IO_Running', 'No'],
    ['Replica_SQL_Running', 'Connecting'],
    ['Seconds_Behind_Source', 'NULL'],
  ]));
  const s = channelSummary(c);
  assert.equal(s.running, false);
  assert.equal(s.ioHealth, 'bad');
  assert.equal(s.sql, 'Connecting');
  assert.equal(s.sqlHealth, 'warn');
  assert.equal(s.behind, 'NULL');
  assert.equal(s.behindHealth, 'bad');
  assert.equal(isRunning(c), false);
});

test('channelSummary handles empty seconds-behind (never connected)', () => {
  const s = channelSummary(toChannel(section('t', [])));
  assert.equal(s.behind, 'NULL');
  assert.equal(s.behindHealth, 'bad');
  assert.equal(s.io, '—');
  assert.equal(s.source, '');
});

test('yn / lagHealth classify health', () => {
  assert.equal(yn('Yes'), 'good');
  assert.equal(yn('No'), 'bad');
  assert.equal(yn('Connecting'), 'warn');
  assert.equal(yn(''), null);
  assert.equal(lagHealth('0'), 'good');
  assert.equal(lagHealth('59'), 'warn');
  assert.equal(lagHealth('60'), 'bad');
  assert.equal(lagHealth('NULL'), 'bad');
  assert.equal(lagHealth(''), 'bad');
  assert.equal(lagHealth('abc'), null);
});

test('channelError prefers SQL then IO error with errnos', () => {
  const c = toChannel(section('t', [
    ['Last_SQL_Errno', '1062'],
    ['Last_SQL_Error', "Duplicate entry '7' for key 'PRIMARY'"],
    ['Last_IO_Errno', '0'],
    ['Last_IO_Error', ''],
  ]));
  assert.equal(channelError(c), "SQL [1062]: Duplicate entry '7' for key 'PRIMARY'");
});

test('channelError combines SQL and IO errors, falls back to Last_Error', () => {
  const both = toChannel(section('t', [
    ['Last_SQL_Errno', '0'], ['Last_SQL_Error', 'sql broke'],
    ['Last_IO_Errno', '2003'], ['Last_IO_Error', 'conn refused'],
  ]));
  assert.equal(channelError(both), 'SQL: sql broke   ·   IO [2003]: conn refused');
  const legacy = toChannel(section('t', [['Last_Errno', '1236'], ['Last_Error', 'bad position']]));
  assert.equal(channelError(legacy), '[1236] bad position');
  assert.equal(channelError(toChannel(section('t', []))), '');
});

test('shortenGtid leaves short sets alone, truncates long ones with counts', () => {
  const short = 'uuid:1-5';
  assert.equal(shortenGtid(short), short);
  assert.equal(shortenGtid(''), '');
  const long = Array.from({ length: 10 }, (_, i) => `uuid${i}:1-999999`).join(',');
  const out = shortenGtid(long);
  assert.match(out, /^uuid0:1-999999,uuid1:1-999999,uuid2:… \(10 sets, 149 chars\)$/);
});

test('visibleDetailRows drops empty whenPresent/error rows but keeps core rows', () => {
  const sparse = toChannel(section('t', [['Replica_IO_Running', 'Yes']]));
  const labels = visibleDetailRows(sparse).map(r => r.label);
  assert.ok(labels.includes('IO thread'));
  assert.ok(labels.includes('Seconds behind'));
  assert.ok(!labels.includes('GTID retrieved'));
  assert.ok(!labels.includes('Last IO error'));

  const full = toChannel(section('t', [
    ...HEALTHY_KV,
    ['Last_SQL_Error', 'boom'],
    ['Replicate_Do_DB', 'shop'],
  ]));
  const fullLabels = visibleDetailRows(full).map(r => r.label);
  assert.ok(fullLabels.includes('GTID retrieved'));
  assert.ok(fullLabels.includes('Last SQL error'));
  assert.ok(fullLabels.includes('Filters'));
});

test('detail rows render positions, heartbeat and filters', () => {
  const c = toChannel(section('t', [
    ...HEALTHY_KV,
    ['Replica_heartbeat_period', '30.123'],
    ['Replicate_Ignore_DB', 'tmp'],
    ['SQL_Delay', '5'],
    ['SQL_Remaining_Delay', '2'],
  ]));
  const byLabel = new Map(visibleDetailRows(c).map(r => [r.label, r.get(c)]));
  assert.equal(byLabel.get('Read position'), 'binlog.000042:1540');
  assert.equal(byLabel.get('Exec position'), 'binlog.000042:1200');
  assert.equal(byLabel.get('Heartbeat'), '30.123s');
  assert.equal(byLabel.get('Filters'), 'Ignore_DB: tmp');
  assert.equal(byLabel.get('SQL delay'), '5s, rem 2s');
});

test('kvHealth classifies PG-style key/value rows', () => {
  assert.equal(kvHealth('status', 'streaming'), 'good');
  assert.equal(kvHealth('status', 'catching up'), 'warn');
  assert.equal(kvHealth('replay_paused', 'true'), 'warn');
  assert.equal(kvHealth('lag_seconds', '0'), 'good');
  assert.equal(kvHealth('Error', 'something failed'), 'bad');
  assert.equal(kvHealth('Error', ''), null);
  assert.equal(kvHealth('slot_name', 'sub1'), null);
});
