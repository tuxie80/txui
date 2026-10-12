/**
 * tests for src/utils/galeraWatch.ts — the background cluster watch: config
 * shaping (parse/serialize/clamp/stable ids), the round processor (baseline
 * silence, per-node transitions → timeline rows + notices, unreachable
 * streaks with the >2-round hysteresis, split-brain CRIT findings, SST
 * begin/end pairing, notification rate-limiting) and the auto-stop rule.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  allConnectionsGone, clampWatchInterval, emptyWatchRoundState,
  parseWatchConfigs, processWatchRound, serializeWatchConfigs,
  transitionNoticeLevel, watchIdFor, watchNameFor,
  UNREACHABLE_NOTIFY_STREAK, WATCH_INTERVAL_DEFAULT_SECS,
  WATCH_INTERVAL_MAX_SECS, WATCH_INTERVAL_MIN_SECS,
  type GaleraWatchConfig, type WatchRoundState,
} from '../src/utils/galeraWatch.ts';
import type { NodeSnapshot } from '../src/utils/galeraCluster.ts';

type Row = [string, string];

const UUID_A = '5f3c9d1a-1234-11ec-9abc-0242ac120002';
const UUID_B = 'aaaaaaa1-1234-11ec-9abc-0242ac120002';

/** A healthy 3-node cluster member's rows; per-key overrides flip one thing. */
function galeraRows(over: Record<string, string> = {}): { statusRows: Row[]; variableRows: Row[] } {
  const st: Record<string, string> = {
    wsrep_on: 'ON',
    wsrep_ready: 'ON',
    wsrep_connected: 'ON',
    wsrep_cluster_status: 'Primary',
    wsrep_cluster_state_uuid: UUID_A,
    wsrep_cluster_size: '3',
    wsrep_local_state_comment: 'Synced',
    wsrep_last_committed: '1000',
    wsrep_local_recv_queue: '0',
    wsrep_local_recv_queue_avg: '0.000000',
    wsrep_local_send_queue: '0',
    wsrep_flow_control_paused: '0.000000',
    wsrep_desync_count: '0',
    ...over,
  };
  const va: Record<string, string> = {
    wsrep_on: 'ON',
    wsrep_cluster_name: 'prod_cluster',
    wsrep_node_name: 'node',
    wsrep_desync: 'OFF',
  };
  return {
    statusRows: Object.entries(st),
    variableRows: Object.entries(va),
  };
}

function snap(id: string, over: Record<string, string> = {}, name?: string): NodeSnapshot {
  const rows = galeraRows({ wsrep_node_name: id, ...over });
  return {
    connectionId: id,
    connectionName: name ?? id,
    ok: true,
    error: null,
    statusRows: rows.statusRows,
    variableRows: rows.variableRows,
    elapsedMs: 10,
    polledAtMs: 1_000,
  };
}

function dead(id: string, error = 'connect refused'): NodeSnapshot {
  return {
    connectionId: id, connectionName: id, ok: false, error,
    statusRows: [], variableRows: [], elapsedMs: 5, polledAtMs: 1_000,
  };
}

const T0 = 1_000_000;

describe('config shaping', () => {
  test('watchIdFor is order-independent and stable', () => {
    assert.equal(watchIdFor(['b', 'a', 'c']), watchIdFor(['c', 'a', 'b']));
    assert.notEqual(watchIdFor(['a', 'b']), watchIdFor(['a', 'b', 'c']));
    assert.equal(watchIdFor(['a', 'a', 'b']), watchIdFor(['a', 'b']));
  });

  test('watchNameFor prefers the shared folder', () => {
    const conns = [
      { id: 'a', group: 'galera-prod' },
      { id: 'b', group: 'galera-prod' },
      { id: 'c', group: 'other' },
    ];
    assert.equal(watchNameFor(conns, ['a', 'b']), 'galera-prod');
    assert.equal(watchNameFor(conns, ['a', 'c']), '2-node cluster');
    assert.equal(watchNameFor([], ['x', 'y', 'z']), '3-node cluster');
  });

  test('clampWatchInterval clamps and defaults', () => {
    assert.equal(clampWatchInterval(30), 30);
    assert.equal(clampWatchInterval(1), WATCH_INTERVAL_MIN_SECS);
    assert.equal(clampWatchInterval(9999), WATCH_INTERVAL_MAX_SECS);
    assert.equal(clampWatchInterval(NaN), WATCH_INTERVAL_DEFAULT_SECS);
    assert.equal(clampWatchInterval(Infinity), WATCH_INTERVAL_DEFAULT_SECS);
  });

  test('parse round-trips a serialized list', () => {
    const cfgs: GaleraWatchConfig[] = [{
      id: watchIdFor(['b', 'a']), name: 'galera-prod',
      connectionIds: ['a', 'b'], intervalSecs: 60, enabled: true,
    }];
    const parsed = parseWatchConfigs(serializeWatchConfigs(cfgs));
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], cfgs[0]);
  });

  test('parse drops garbage and re-derives ids', () => {
    assert.deepEqual(parseWatchConfigs(null), []);
    assert.deepEqual(parseWatchConfigs(''), []);
    assert.deepEqual(parseWatchConfigs('{not json'), []);
    assert.deepEqual(parseWatchConfigs('{"a":1}'), []);
    assert.deepEqual(parseWatchConfigs('[1, "x", null]'), []);
    // no connection ids → dropped; bogus interval → default; stale id → re-derived
    const parsed = parseWatchConfigs(JSON.stringify([
      { name: 'empty', connectionIds: [], intervalSecs: 30, enabled: true },
      { name: 'ok', connectionIds: ['b', 'a'], intervalSecs: 9999, enabled: true, id: 'bogus' },
    ]));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, watchIdFor(['a', 'b']));
    assert.equal(parsed[0].intervalSecs, WATCH_INTERVAL_MAX_SECS);
    assert.deepEqual(parsed[0].connectionIds, ['a', 'b']);
  });

  test('parse drops duplicate watches for the same node set', () => {
    const parsed = parseWatchConfigs(JSON.stringify([
      { name: 'one', connectionIds: ['a'], intervalSecs: 30, enabled: true },
      { name: 'two', connectionIds: ['a'], intervalSecs: 60, enabled: true },
    ]));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, 'one');
  });

  test('allConnectionsGone fires only when EVERY node is deleted', () => {
    assert.equal(allConnectionsGone(['a', 'b'], ['a']), false);
    assert.equal(allConnectionsGone(['a', 'b'], []), true);
    assert.equal(allConnectionsGone(['a', 'b'], ['c', 'd']), true);
  });
});

describe('transitionNoticeLevel', () => {
  const ev = (eventType: string, ok: boolean, summary = 'x') =>
    ({ eventType, ok, summary, detail: '' });

  test('notifies member loss, uuid change and crit FC only', () => {
    assert.equal(transitionNoticeLevel(ev('cluster_size', false)), 'warn');
    assert.equal(transitionNoticeLevel(ev('cluster_size', true)), null);
    assert.equal(transitionNoticeLevel(ev('cluster_view', false)), 'crit');
    assert.equal(transitionNoticeLevel(ev('cluster_view', true)), null);
    assert.equal(
      transitionNoticeLevel(ev('flow_control', false, 'Flow control rose above the critical threshold (1% → 60% paused)')),
      'crit');
    assert.equal(
      transitionNoticeLevel(ev('flow_control', false, 'Flow control rose above the warning threshold (1% → 20% paused)')),
      null);
    assert.equal(transitionNoticeLevel(ev('local_state', false, 'Local state Synced → Joining')), null);
    assert.equal(transitionNoticeLevel(ev('reachability', false)), null); // streak rule owns it
  });
});

describe('processWatchRound', () => {
  test('the first round is a silent baseline: no events, no notices', () => {
    const res = processWatchRound([snap('a'), snap('b'), snap('c')], emptyWatchRoundState(), T0);
    assert.deepEqual(res.timeline, []);
    assert.deepEqual(res.notices, []);
    assert.equal(Object.keys(res.state.prevParsed).length, 3);
  });

  test('member loss: timeline rows on the survivors, one deduped notice', () => {
    let st = emptyWatchRoundState();
    st = processWatchRound([snap('a'), snap('b'), snap('c')], st, T0).state;
    const res = processWatchRound(
      [snap('a', { wsrep_cluster_size: '2' }), snap('b', { wsrep_cluster_size: '2' })],
      st, T0 + 30_000);
    // Both surviving nodes recorded the size transition on their own timeline.
    assert.equal(res.timeline.length, 2);
    for (const t of res.timeline) {
      assert.equal(t.events.length, 1);
      assert.equal(t.events[0].eventType, 'cluster_size');
      assert.match(t.events[0].summary, /2 → 3|3 → 2/);
      assert.equal(t.events[0].ok, false);
    }
    // But ONE notification — the same incident reported by two nodes is one alert.
    assert.equal(res.notices.length, 1);
    assert.equal(res.notices[0].level, 'warn');
    assert.match(res.notices[0].title, /member left/);
  });

  test('member rejoin notifies nothing (recovery is timeline-only)', () => {
    let st = emptyWatchRoundState();
    st = processWatchRound([snap('a'), snap('b')], st, T0).state;
    st = processWatchRound(
      [snap('a', { wsrep_cluster_size: '1' }), snap('b', { wsrep_cluster_size: '1' })],
      st, T0 + 30_000).state;
    const res = processWatchRound([snap('a'), snap('b')], st, T0 + 60_000);
    assert.equal(res.timeline.length, 2);
    assert.ok(res.timeline.every(t => t.events[0].ok === true));
    assert.deepEqual(res.notices, []);
  });

  test('unreachable: nothing before the streak, notice + timeline at 3, recovery row after', () => {
    let st = emptyWatchRoundState();
    st = processWatchRound([snap('a'), snap('b')], st, T0).state;
    for (let i = 1; i < UNREACHABLE_NOTIFY_STREAK; i++) {
      const res = processWatchRound([snap('a'), dead('b')], st, T0 + i * 30_000);
      assert.deepEqual(res.notices, [], `round ${i} must stay quiet`);
      assert.deepEqual(res.timeline, [], `round ${i} files nothing`);
      st = res.state;
    }
    const hit = processWatchRound([snap('a'), dead('b')], st, T0 + 3 * 30_000);
    assert.equal(hit.notices.length, 1);
    assert.equal(hit.notices[0].level, 'warn');
    assert.match(hit.notices[0].title, /b unreachable/);
    assert.equal(hit.timeline.length, 1);
    assert.equal(hit.timeline[0].connectionId, 'b');
    assert.equal(hit.timeline[0].events[0].eventType, 'reachability');
    assert.equal(hit.timeline[0].events[0].ok, false);
    // Round 4 still down: the streak rule fired at exactly 3 — no repeat row.
    const again = processWatchRound([snap('a'), dead('b')], hit.state, T0 + 4 * 30_000);
    assert.deepEqual(again.notices, []);
    assert.deepEqual(again.timeline, []);
    // Recovery: one ok row on b's timeline, and the state diff continues from
    // the PRE-OUTAGE snapshot (no re-baseline).
    const back = processWatchRound([snap('a'), snap('b')], again.state, T0 + 5 * 30_000);
    assert.equal(back.timeline.length, 1);
    assert.equal(back.timeline[0].events[0].eventType, 'reachability');
    assert.equal(back.timeline[0].events[0].ok, true);
    assert.deepEqual(back.notices, []);
  });

  test('a single failed round does not reset the streak count', () => {
    let st = emptyWatchRoundState();
    st = processWatchRound([snap('a'), snap('b')], st, T0).state;
    st = processWatchRound([snap('a'), dead('b')], st, T0 + 30_000).state;
    st = processWatchRound([snap('a'), dead('b')], st, T0 + 60_000).state;
    // b answers once (streak resets), then fails twice — still below 3.
    st = processWatchRound([snap('a'), snap('b')], st, T0 + 90_000).state;
    st = processWatchRound([snap('a'), dead('b')], st, T0 + 120_000).state;
    const res = processWatchRound([snap('a'), dead('b')], st, T0 + 150_000);
    assert.deepEqual(res.notices, []);
  });

  test('split-brain suspicion: uuid change transition AND merge CRIT both fire', () => {
    let st = emptyWatchRoundState();
    st = processWatchRound([snap('a'), snap('b')], st, T0).state;
    // b reports a different state uuid — both nodes record their view event,
    // the merge sees two uuids under one cluster name.
    const res = processWatchRound(
      [snap('a'), snap('b', { wsrep_cluster_state_uuid: UUID_B })], st, T0 + 30_000);
    const keys = res.notices.map(n => n.key);
    assert.ok(keys.some(k => k.startsWith('cluster_view:')), 'transition notice');
    assert.ok(keys.some(k => k.startsWith('crit:Split-brain')), 'merge finding notice');
    assert.ok(res.notices.every(n => n.level === 'crit'));
    // Next round, same condition persists → suppressed by the rate limit.
    const next = processWatchRound(
      [snap('a'), snap('b', { wsrep_cluster_state_uuid: UUID_B })], res.state, T0 + 60_000);
    assert.deepEqual(next.notices, []);
  });

  test('SST pairing: begin and end notices around a donation', () => {
    let st = emptyWatchRoundState();
    st = processWatchRound([snap('a'), snap('b')], st, T0).state;
    // a donates to b (b is Joining, a is Donor/Desynced with desync OFF).
    const begin = processWatchRound([
      snap('a', { wsrep_local_state_comment: 'Donor/Desynced', wsrep_desync_count: '1' }),
      snap('b', { wsrep_local_state_comment: 'Joining' }),
    ], st, T0 + 30_000);
    const sstNotices = begin.notices.filter(n => n.key.startsWith('sst-begin:'));
    assert.equal(sstNotices.length, 1);
    assert.match(sstNotices[0].body, /a → b/);
    // The donor's local-state transition is timeline-only (info, not an alarm).
    assert.ok(!begin.notices.some(n => n.key.startsWith('local_state:')));
    // Transfer completes — pairing gone.
    const end = processWatchRound([snap('a'), snap('b')], begin.state, T0 + 120_000);
    assert.equal(end.notices.filter(n => n.key.startsWith('sst-end:')).length, 1);
  });

  test('a manual desync is NOT an SST pairing', () => {
    let st = emptyWatchRoundState();
    st = processWatchRound([snap('a'), snap('b')], st, T0).state;
    const rows = galeraRows({ wsrep_local_state_comment: 'Donor/Desynced' });
    const manual: NodeSnapshot = {
      ...snap('a'),
      statusRows: rows.statusRows,
      variableRows: [...rows.variableRows.filter(([k]) => k !== 'wsrep_desync'), ['wsrep_desync', 'ON']],
    };
    const res = processWatchRound([manual, snap('b')], st, T0 + 30_000);
    assert.ok(!res.notices.some(n => n.key.startsWith('sst-')), 'manual desync raises no SST notice');
  });

  test('rate limit: the same notice re-fires after the window, not before', () => {
    const window = 15 * 60_000;
    let st: WatchRoundState = emptyWatchRoundState();
    st = processWatchRound([snap('a'), snap('b')], st, T0).state;
    // Shrink to 1 node, then flap back and forth.
    let res = processWatchRound([snap('a', { wsrep_cluster_size: '1' })], st, T0 + 30_000);
    assert.equal(res.notices.length, 1);
    st = res.state;
    st = processWatchRound([snap('a')], st, T0 + 60_000).state;   // grow (quiet)
    res = processWatchRound([snap('a', { wsrep_cluster_size: '1' })], st, T0 + 90_000);
    assert.deepEqual(res.notices, [], 'same summary inside the window stays suppressed');
    st = res.state;
    st = processWatchRound([snap('a')], st, T0 + 90_000 + window).state;
    res = processWatchRound([snap('a', { wsrep_cluster_size: '1' })], st, T0 + 120_000 + window);
    assert.equal(res.notices.length, 1, 're-fires once the window has passed');
  });

  test('a custom dedupe window is honored', () => {
    let st = emptyWatchRoundState();
    st = processWatchRound([snap('a'), snap('b')], st, T0, { dedupeWindowMs: 1000 }).state;
    let res = processWatchRound([snap('a', { wsrep_cluster_size: '1' })], st, T0 + 100, { dedupeWindowMs: 1000 });
    assert.equal(res.notices.length, 1);
    st = processWatchRound([snap('a')], res.state, T0 + 200, { dedupeWindowMs: 1000 }).state;
    res = processWatchRound([snap('a', { wsrep_cluster_size: '1' })], st, T0 + 2000, { dedupeWindowMs: 1000 });
    assert.equal(res.notices.length, 1);
  });

  test('the state clock survives a round where the node is unreachable', () => {
    // prevParsed is kept across an outage so the recovery diffs against the
    // pre-outage snapshot: if the node comes back in a DIFFERENT local state,
    // that transition is seen, not baselined away.
    let st = emptyWatchRoundState();
    st = processWatchRound([snap('a')], st, T0).state;
    st = processWatchRound([dead('a')], st, T0 + 30_000).state;
    const res = processWatchRound([snap('a', { wsrep_local_state_comment: 'Joined' })], st, T0 + 60_000);
    const stateEvents = res.timeline.flatMap(t => t.events).filter(e => e.eventType === 'local_state');
    assert.equal(stateEvents.length, 1);
    assert.match(stateEvents[0].summary, /Synced → Joined/);
  });
});
