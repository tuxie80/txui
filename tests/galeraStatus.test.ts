/**
 * tests for src/utils/galeraStatus.ts — parsing the wsrep SHOW rows, the
 * detection signal, every health rule firing and not firing, and tolerance
 * for the key sets of different Galera builds (MariaDB vs PXC carry
 * different subsets; missing keys must degrade rules, never crash them).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectGalera, parseGaleraStatus, galeraFindings, transferState, istProgress,
  gcacheWindow, gcacheSizeText, parseEvsLatency, isDonorState,
  fmtBytes, fmtPct, fmtElapsed, statusOn, QUEUE_WARN,
  galeraEventsFromTransition, orderMembershipColumns,
} from '../src/utils/galeraStatus.ts';

type Row = [string, string];

const here = dirname(fileURLToPath(import.meta.url));
/** Parse a captured `# comment` + tab-separated SHOW STATUS/SHOW VARIABLES dump. */
function fixtureRows(name: string): { statusRows: Row[]; variableRows: Row[] } {
  const text = readFileSync(join(here, 'fixtures', name), 'utf8');
  const statusRows: Row[] = [], variableRows: Row[] = [];
  let section: 'status' | 'vars' = 'status';
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      if (line.includes('VARIABLES')) section = 'vars';
      continue;
    }
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    (section === 'status' ? statusRows : variableRows).push([line.slice(0, tab), line.slice(tab + 1)]);
  }
  return { statusRows, variableRows };
}

/** A healthy MariaDB Galera node — the full key set the dashboard reads. */
function healthyStatus(): Row[] {
  return [
    ['wsrep_on', 'ON'],
    ['wsrep_ready', 'ON'],
    ['wsrep_connected', 'ON'],
    ['wsrep_cluster_status', 'Primary'],
    ['wsrep_cluster_state_uuid', '5f3c9d1a-1234-11ec-9abc-0242ac120002'],
    ['wsrep_cluster_conf_id', '42'],
    ['wsrep_cluster_size', '3'],
    ['wsrep_local_state_comment', 'Synced'],
    ['wsrep_last_committed', '987654'],
    ['wsrep_local_cert_failures', '0'],
    ['wsrep_local_recv_queue', '0'],
    ['wsrep_local_send_queue', '0'],
    ['wsrep_replicated_bytes', '123456789'],
    ['wsrep_received_bytes', '987654321'],
    ['wsrep_flow_control_paused', '0.000000'],
    ['wsrep_flow_control_sent', '0'],
    ['wsrep_flow_control_recv', '0'],
    ['wsrep_flow_control_paused_ns', '0'],
    ['wsrep_local_recv_queue_avg', '0.000000'],
    ['wsrep_desync_count', '0'],
    ['wsrep_evs_evict_list', ''],
    ['wsrep_evs_repl_latency', '0.000216/0.000539/0.00212'],
    ['wsrep_local_bf_aborts', '0'],
    ['wsrep_local_cached_downto', '986500'],
    ['wsrep_provider_options', 'base_port = 3306; gcache.size = 128M; gcache.page_size = 128M'],
    ['wsrep_provider_version', '4.12(rXXXX)'],
  ];
}
function healthyVars(): Row[] {
  return [
    ['wsrep_on', 'ON'],
    ['wsrep_provider', '/usr/lib64/galera-4/libgalera_smm.so'],
    ['wsrep_cluster_name', 'prod_galera'],
    ['wsrep_node_name', 'node1'],
    ['wsrep_node_address', '10.0.0.11'],
    ['wsrep_desync', 'OFF'],
    ['wsrep_reject_queries', 'NONE'],
    ['wsrep_slave_threads', '1'],
    ['wsrep_incoming_addresses', '10.0.0.11:3306,10.0.0.12:3306,10.0.0.13:3306'],
  ];
}

describe('detectGalera', () => {
  test('empty result (non-Galera server) is a plain false, not an error', () => {
    assert.equal(detectGalera([]), false);
  });
  test('wsrep_on ON detects', () => {
    assert.equal(detectGalera([['wsrep_on', 'ON']]), true);
  });
  test('wsrep_on OFF does not', () => {
    assert.equal(detectGalera([['wsrep_on', 'OFF']]), false);
  });
  test('case and whitespace tolerated', () => {
    assert.equal(detectGalera([['Wsrep_On', ' on ']]), true);
  });
});

describe('statusOn', () => {
  test('ON variants true; OFF/empty/null false', () => {
    assert.equal(statusOn('ON'), true);
    assert.equal(statusOn('on'), true);
    assert.equal(statusOn('OFF'), false);
    assert.equal(statusOn(''), false);
    assert.equal(statusOn(null), false);
    assert.equal(statusOn(undefined), false);
  });
});

describe('parseGaleraStatus', () => {
  test('healthy node parses every field', () => {
    const s = parseGaleraStatus(healthyStatus(), healthyVars());
    assert.equal(s.detected, true);
    assert.equal(s.clusterName, 'prod_galera');
    assert.equal(s.clusterStatus, 'Primary');
    assert.equal(s.clusterSize, 3);
    assert.equal(s.clusterConfId, 42);
    assert.equal(s.nodeName, 'node1');
    assert.equal(s.localStateComment, 'Synced');
    assert.equal(s.ready, 'ON');
    assert.equal(s.connected, 'ON');
    assert.equal(s.lastCommitted, 987654);
    assert.equal(s.localRecvQueue, 0);
    assert.equal(s.replicatedBytes, 123456789);
    assert.equal(s.receivedBytes, 987654321);
    assert.equal(s.flowControlPaused, 0);
    assert.equal(s.provider, '/usr/lib64/galera-4/libgalera_smm.so');
    assert.equal(s.providerVersion, '4.12(rXXXX)');
    assert.equal(s.incomingAddresses, '10.0.0.11:3306,10.0.0.12:3306,10.0.0.13:3306');
    assert.equal(s.rejectQueries, 'NONE');
    assert.equal(s.slaveThreads, 1);
  });

  test('reject_queries and slave_threads are variables-only and tolerate absence', () => {
    const s = parseGaleraStatus(healthyStatus(), [
      ...healthyVars(),
      ['wsrep_reject_queries', 'ALL'],
      ['wsrep_slave_threads', '8'],
    ]);
    assert.equal(s.rejectQueries, 'ALL');
    assert.equal(s.slaveThreads, 8);
    // A build that does not carry the keys leaves them null, never guessed.
    const bare = parseGaleraStatus(healthyStatus(), [['wsrep_on', 'ON']]);
    assert.equal(bare.rejectQueries, null);
    assert.equal(bare.slaveThreads, null);
  });

  test('empty rows (non-Galera) parse to detected:false with null fields', () => {
    const s = parseGaleraStatus([], []);
    assert.equal(s.detected, false);
    assert.equal(s.clusterName, null);
    assert.equal(s.clusterSize, null);
    assert.equal(s.flowControlPaused, null);
  });

  test('PXC-shaped rows (no byte counters, no provider_version) degrade to null', () => {
    const status: Row[] = healthyStatus().filter(([k]) =>
      !['wsrep_replicated_bytes', 'wsrep_received_bytes', 'wsrep_provider_version'].includes(k));
    const s = parseGaleraStatus(status, healthyVars());
    assert.equal(s.detected, true);
    assert.equal(s.replicatedBytes, null);
    assert.equal(s.receivedBytes, null);
    assert.equal(s.providerVersion, null);
    // rules still run on what remains
    assert.equal(galeraFindings(s).length, 1);
    assert.equal(galeraFindings(s)[0].level, 'ok');
  });

  test('MariaDB fallback: status wsrep_on absent, variable says ON', () => {
    const status: Row[] = healthyStatus().filter(([k]) => k !== 'wsrep_on');
    const s = parseGaleraStatus(status, healthyVars());
    assert.equal(s.detected, true);
  });

  test('garbage numerics parse as null, not NaN', () => {
    const s = parseGaleraStatus([['wsrep_on', 'ON'], ['wsrep_cluster_size', 'abc']], []);
    assert.equal(s.clusterSize, null);
  });
});

describe('galeraFindings', () => {
  const healthy = () => parseGaleraStatus(healthyStatus(), healthyVars());

  test('undetected yields no findings', () => {
    assert.deepEqual(galeraFindings(parseGaleraStatus([], [])), []);
  });

  test('healthy node yields exactly one ok finding', () => {
    const f = galeraFindings(healthy());
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'ok');
  });

  test('non-Primary component is a crit split-brain warning', () => {
    const s = { ...healthy(), clusterStatus: 'Non-Primary' };
    const f = galeraFindings(s);
    assert.equal(f[0].level, 'crit');
    assert.match(f[0].title, /split-brain/i);
  });

  test('missing cluster_status skips the split-brain rule entirely', () => {
    const s = { ...healthy(), clusterStatus: null };
    assert.ok(!galeraFindings(s).some(f => f.level === 'crit'));
  });

  test('wsrep_connected OFF is a crit', () => {
    const s = { ...healthy(), connected: 'OFF' };
    const f = galeraFindings(s);
    assert.equal(f[0].level, 'crit');
    assert.match(f[0].title, /not connected/i);
  });

  test('wsrep_ready OFF is a crit', () => {
    const s = { ...healthy(), ready: 'OFF' };
    const f = galeraFindings(s);
    assert.equal(f[0].level, 'crit');
    assert.match(f[0].title, /not ready/i);
  });

  test('Donor/Desynced (the documented slash spelling) is an info SST notice', () => {
    const s = { ...healthy(), localStateComment: 'Donor/Desynced' };
    const f = galeraFindings(s);
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'info');
    assert.match(f[0].detail, /SST|state transfer/i);
  });

  test('Donor-Desynced (hyphen variant) is accepted as the same state', () => {
    const s = { ...healthy(), localStateComment: 'Donor-Desynced' };
    const f = galeraFindings(s);
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'info');
    assert.match(f[0].title, /donor/i);
  });

  test('isDonorState accepts both spellings, rejects the rest', () => {
    assert.equal(isDonorState('Donor/Desynced'), true);
    assert.equal(isDonorState('Donor-Desynced'), true);
    assert.equal(isDonorState('Synced'), false);
    assert.equal(isDonorState(null), false);
  });

  test('Joined is a warn; Joining is an info', () => {
    const joined = galeraFindings({ ...healthy(), localStateComment: 'Joined' });
    assert.equal(joined[0].level, 'warn');
    const joining = galeraFindings({ ...healthy(), localStateComment: 'Joining' });
    assert.equal(joining[0].level, 'info');
  });

  test('flow control ladder: 1%/10%/50% → info/warn/crit, 0 silent', () => {
    const at = (p: number) => galeraFindings({ ...healthy(), flowControlPaused: p })[0];
    assert.equal(at(0).level, 'ok');
    assert.equal(at(0.05).level, 'info');
    assert.equal(at(0.2).level, 'warn');
    assert.equal(at(0.7).level, 'crit');
    assert.match(at(0.2).title, /~20%/);
  });

  test('recv queue above threshold warns with the count; at/below is silent', () => {
    const over = galeraFindings({ ...healthy(), localRecvQueue: QUEUE_WARN + 1 });
    assert.equal(over[0].level, 'warn');
    assert.match(over[0].title, new RegExp(`${QUEUE_WARN + 1}`));
    const atQueue = galeraFindings({ ...healthy(), localRecvQueue: QUEUE_WARN });
    assert.equal(atQueue[0].level, 'ok');
  });

  test('send queue above threshold warns', () => {
    const f = galeraFindings({ ...healthy(), localSendQueue: QUEUE_WARN + 3 });
    assert.equal(f[0].level, 'warn');
    assert.match(f[0].title, /queued for send/i);
  });

  test('certification failures above zero are an info', () => {
    const f = galeraFindings({ ...healthy(), localCertFailures: 17 });
    assert.equal(f[0].level, 'info');
    assert.match(f[0].title, /17/);
  });

  test('single-node Primary is an info', () => {
    const f = galeraFindings({ ...healthy(), clusterSize: 1 });
    assert.equal(f[0].level, 'info');
    assert.match(f[0].title, /single-node/i);
  });

  test('findings come back most-severe first', () => {
    const s = {
      ...healthy(),
      clusterStatus: 'Non-Primary',
      localStateComment: 'Donor/Desynced',
      flowControlPaused: 0.2,
    };
    const levels = galeraFindings(s).map(f => f.level);
    assert.deepEqual(levels, ['crit', 'warn', 'info']);
  });
});

describe('galeraFindings — round-2 rules', () => {
  const healthy = () => parseGaleraStatus(healthyStatus(), healthyVars());

  test('recv queue average above 1.0 warns with the value; below is silent', () => {
    const over = galeraFindings({ ...healthy(), localRecvQueueAvg: 2.5, localRecvQueue: 3 });
    assert.equal(over[0].level, 'warn');
    assert.match(over[0].title, /2\.50/);
    const under = galeraFindings({ ...healthy(), localRecvQueueAvg: 0.4 });
    assert.equal(under[0].level, 'ok');
  });

  test('a stale-high EWMA with an EMPTY current queue is residue, not a backlog', () => {
    // Live truth (MariaDB 11.8, 2026-10-02): 25 min after an IST rejoin's
    // catch-up, recv_queue_avg was still 3.14 with queue 0 on an idle node.
    const residue = galeraFindings({ ...healthy(), localRecvQueueAvg: 3.14, localRecvQueue: 0 });
    assert.equal(residue.length, 1);
    assert.equal(residue[0].level, 'ok');
    // An unreadable instantaneous queue cannot corroborate — the average decides.
    const blind = galeraFindings({ ...healthy(), localRecvQueueAvg: 2.5, localRecvQueue: null });
    assert.equal(blind[0].level, 'warn');
  });

  test('flow control by rate: paused_ns growing between samples fires', () => {
    const prev = { ...healthy(), flowControlPausedNs: 1_000_000_000 };
    const cur = { ...healthy(), flowControlPausedNs: 4_000_000_000 };
    const f = galeraFindings(cur, prev);
    assert.equal(f.length, 1);
    assert.match(f[0].title, /since the last poll/i);
    assert.match(f[0].detail, /3\.00 s/);
  });

  test('flow control by rate: flat paused_ns stays silent even with a stale-high ratio', () => {
    // FLUSH STATUS resets the ratio machinery; a high ratio with no paused_ns
    // growth is old news, not throttling.
    const prev = { ...healthy(), flowControlPausedNs: 4_000_000_000, flowControlPaused: 0.3 };
    const cur = { ...healthy(), flowControlPausedNs: 4_000_000_000, flowControlPaused: 0.3 };
    const f = galeraFindings(cur, prev);
    assert.ok(!f.some(x => x.level !== 'ok' && /flow control/i.test(x.title)));
  });

  test('flow control by rate: level comes from the ratio ladder when available', () => {
    const prev = { ...healthy(), flowControlPausedNs: 0 };
    const mild = galeraFindings({ ...healthy(), flowControlPausedNs: 1, flowControlPaused: 0.05 }, prev);
    assert.equal(mild[0].level, 'info');
    const hot = galeraFindings({ ...healthy(), flowControlPausedNs: 1, flowControlPaused: 0.7 }, prev);
    assert.equal(hot[0].level, 'crit');
    const noRatio = galeraFindings({ ...healthy(), flowControlPausedNs: 1, flowControlPaused: null }, prev);
    assert.equal(noRatio[0].level, 'warn');
  });

  test('flow control: no previous sample falls back to the paused-ratio rule', () => {
    const cur = { ...healthy(), flowControlPausedNs: 5_000_000_000, flowControlPaused: 0.2 };
    const f = galeraFindings(cur);
    assert.match(f[0].title, /~20%/);
  });

  test('flow control: a paused_ns counter reset falls back to the ratio rule', () => {
    const prev = { ...healthy(), flowControlPausedNs: 9_000_000_000 };
    const cur = { ...healthy(), flowControlPausedNs: 100, flowControlPaused: 0.2 };
    const f = galeraFindings(cur, prev);
    assert.match(f[0].title, /~20%/);
  });

  test('manual desync needs wsrep_desync=ON; desync_count>0 with desync OFF is an SST donor, silent here', () => {
    // Live truth (MariaDB 11.8, 2026-10-02): an rsync-SST donor shows
    // desync=OFF + desync_count=1 — the count alone is NOT backup-mode evidence.
    const donorShape = galeraFindings({ ...healthy(), desyncCount: 1 });
    assert.ok(!donorShape.some(f => /manually desynced/i.test(f.title)));
    const manual = galeraFindings({ ...healthy(), desync: 'ON', desyncCount: 1 });
    assert.equal(manual[0].level, 'info');
    assert.match(manual[0].title, /manually desynced/i);
    // Variable unreadable (PXC subsets) + count>0 → the hedged finding survives.
    const hedged = galeraFindings({ ...healthy(), desync: null, desyncCount: 1 });
    assert.ok(hedged.some(f => /manually desynced/i.test(f.title)));
  });

  test('non-empty evict list warns with the list', () => {
    const f = galeraFindings({ ...healthy(), evsEvictList: '5f3c9d1a:10.0.0.13' });
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'warn');
    assert.match(f[0].title, /5f3c9d1a:10\.0\.0\.13/);
  });

  test('evs latency: max outlier vs a high average warns', () => {
    const f = galeraFindings({ ...healthy(), evsReplLatency: '0.05/0.20/3.00' });
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'warn');
    assert.match(f[0].title, /latency spiking/i);
  });

  test('evs latency: proportional max or a low average stays silent', () => {
    const proportional = galeraFindings({ ...healthy(), evsReplLatency: '0.05/0.20/1.50' });
    assert.equal(proportional[0].level, 'ok');
    const lowAvg = galeraFindings({ ...healthy(), evsReplLatency: '0.01/0.05/5.00' });
    assert.equal(lowAvg[0].level, 'ok');
  });

  test('bf aborts: growth warns at 5+, informs below; no prev is silent', () => {
    const prev = { ...healthy(), localBfAborts: 10 };
    const warn = galeraFindings({ ...healthy(), localBfAborts: 17 }, prev);
    assert.equal(warn[0].level, 'warn');
    assert.match(warn[0].title, /7 brute-force aborts/);
    const info = galeraFindings({ ...healthy(), localBfAborts: 12 }, prev);
    assert.equal(info[0].level, 'info');
    assert.match(info[0].title, /2 brute-force aborts/);
    const first = galeraFindings({ ...healthy(), localBfAborts: 12 });
    assert.ok(!first.some(f => /brute-force/i.test(f.title)));
  });

  test('new keys missing (older Galera build) leave the rules silent', () => {
    const s = {
      ...healthy(),
      localRecvQueueAvg: null, flowControlPausedNs: null, desyncCount: null,
      evsEvictList: null, evsReplLatency: null, localBfAborts: null,
    };
    const f = galeraFindings(s, s);
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'ok');
  });
});

describe('transferState', () => {
  const healthy = () => parseGaleraStatus(healthyStatus(), healthyVars());

  test('Joining is the SST phase with the honest no-progress copy', () => {
    const t = transferState({ ...healthy(), localStateComment: 'Joining' }, 10_000, 4_000);
    assert.ok(t);
    assert.equal(t.phase, 'sst');
    assert.match(t.title, /SST/);
    assert.match(t.detail, /does not expose SST progress over SQL/i);
    assert.equal(t.elapsedMs, 6_000);
    assert.equal(t.queueLeft, null);
  });

  test('Joined is catch-up with the recv-queue countdown', () => {
    const t = transferState({ ...healthy(), localStateComment: 'Joined', localRecvQueue: 12_340 }, 10_000, 4_000);
    assert.ok(t);
    assert.equal(t.phase, 'catchup');
    assert.equal(t.queueLeft, 12_340);
    assert.match(t.detail, /12,340 write-sets left to apply/);
  });

  test('Joined without a recv-queue reading degrades the countdown, not the card', () => {
    const t = transferState({ ...healthy(), localStateComment: 'Joined', localRecvQueue: null }, 10_000, 4_000);
    assert.ok(t);
    assert.equal(t.phase, 'catchup');
    assert.equal(t.queueLeft, null);
  });

  test('Donor/Desynced with wsrep_desync unreadable cannot tell donor from manual', () => {
    const t = transferState({ ...healthy(), localStateComment: 'Donor/Desynced', desync: null }, 10_000, 4_000);
    assert.ok(t);
    assert.equal(t.phase, 'donor');
    assert.equal(t.donorCause, 'unknown');
    assert.match(t.title, /donor/i);
    assert.match(t.detail, /manually desynced/i);
  });

  test('Donor/Desynced with wsrep_desync=ON is a manual desync, not a transfer', () => {
    const t = transferState({ ...healthy(), localStateComment: 'Donor/Desynced', desync: 'ON' }, 10_000, 4_000);
    assert.ok(t);
    assert.equal(t.donorCause, 'manual');
    assert.match(t.detail, /NOT necessarily serving a state transfer/i);
  });

  test('Donor/Desynced with wsrep_desync=OFF is a donated SST — even with desync_count>0', () => {
    // The live MariaDB 11.8 rsync-SST donor shape: desync=OFF, desync_count=1.
    const t = transferState({ ...healthy(), localStateComment: 'Donor/Desynced', desync: 'OFF', desyncCount: 1 }, 10_000, 4_000);
    assert.ok(t);
    assert.equal(t.donorCause, 'sst');
    assert.match(t.title, /Donating state transfer/);
    assert.match(t.detail, /not a manual desync/i);
  });

  test('Synced yields no card; unrecognized and missing states too', () => {
    assert.equal(transferState(healthy(), 10_000, 4_000), null);
    assert.equal(transferState({ ...healthy(), localStateComment: 'Weird' }, 10_000, 4_000), null);
    assert.equal(transferState({ ...healthy(), localStateComment: null }, 10_000, 4_000), null);
  });

  test('elapsed clamps at zero and an unknown since stamp means zero', () => {
    const s = { ...healthy(), localStateComment: 'Joining' };
    assert.equal(transferState(s, 4_000, 10_000)?.elapsedMs, 0);
    assert.equal(transferState(s, 4_000, 0)?.elapsedMs, 0);
  });
});

describe('istProgress', () => {
  const healthy = () => parseGaleraStatus(healthyStatus(), healthyVars());
  const pxc = () => ({
    ...healthy(),
    istReceiveSeqnoStart: 1_000_000,
    istReceiveSeqnoCurrent: 1_012_345,
    istReceiveSeqnoEnd: 1_019_200,
    istReceiveStatus: 'Receiving IST: 64%',
  });

  test('seqno triple gives exact progress', () => {
    const p = istProgress(pxc());
    assert.ok(p);
    assert.equal(Math.round(p.pct * 100), 64);
    assert.equal(p.current! - p.start!, 12_345);
    assert.equal(p.end! - p.start!, 19_200);
    assert.equal(p.statusText, 'Receiving IST: 64%');
  });

  test('current past end clamps to 100%', () => {
    const p = istProgress({ ...pxc(), istReceiveSeqnoCurrent: 2_000_000 });
    assert.equal(p?.pct, 1);
  });

  test('percentage string is the fallback when seqnos are absent', () => {
    const p = istProgress({ ...healthy(), istReceiveStatus: 'Receiving IST... 37% complete' });
    assert.ok(p);
    assert.equal(Math.round(p.pct * 100), 37);
    assert.equal(p.current, null);
  });

  test('partial seqno keys without status text yield null', () => {
    assert.equal(istProgress({ ...healthy(), istReceiveSeqnoStart: 5, istReceiveSeqnoCurrent: 7 }), null);
  });

  test('garbage status text and idle (blank) both yield null', () => {
    assert.equal(istProgress({ ...healthy(), istReceiveStatus: 'total nonsense' }), null);
    assert.equal(istProgress(healthy()), null);
  });

  test('PXC-shaped rows parse the ist keys; MariaDB rows leave them null', () => {
    const rows: Row[] = [
      ...healthyStatus(),
      ['wsrep_ist_receive_status', 'Receiving IST: 64%'],
      ['wsrep_ist_receive_seqno_start', '1000000'],
      ['wsrep_ist_receive_seqno_current', '1012345'],
      ['wsrep_ist_receive_seqno_end', '1019200'],
    ];
    const s = parseGaleraStatus(rows, healthyVars());
    assert.equal(s.istReceiveSeqnoStart, 1_000_000);
    assert.equal(s.istReceiveSeqnoEnd, 1_019_200);
    const maria = parseGaleraStatus(healthyStatus(), healthyVars());
    assert.equal(maria.istReceiveStatus, null);
    assert.equal(maria.istReceiveSeqnoCurrent, null);
  });
});

describe('gcacheWindow', () => {
  const healthy = () => parseGaleraStatus(healthyStatus(), healthyVars());

  test('window, burn rate and time-to-SST arithmetic', () => {
    // fixture: last_committed 987654, cached_downto 986500 → window 1154
    const s = healthy();
    const samples = [
      { tsMs: 0, lastCommitted: 987_000 },
      { tsMs: 5_000, lastCommitted: 987_654 },
    ];
    const g = gcacheWindow(s, samples);
    assert.equal(g.windowSeqnos, 1_154);
    assert.equal(g.burnPerSec, 130.8);
    assert.ok(g.timeToSstMs !== null);
    assert.equal(Math.round(g.timeToSstMs!), Math.round((1_154 / 130.8) * 1000));
    assert.equal(g.gcacheSizeText, '128 MB');
  });

  test('flatline (idle cluster) gives burn 0 and null timeToSst', () => {
    const g = gcacheWindow(healthy(), [
      { tsMs: 0, lastCommitted: 987_654 },
      { tsMs: 5_000, lastCommitted: 987_654 },
    ]);
    assert.equal(g.burnPerSec, 0);
    assert.equal(g.timeToSstMs, null);
    assert.equal(g.windowSeqnos, 1_154);
  });

  test('counter reset discards the pre-reset samples', () => {
    const g = gcacheWindow(healthy(), [
      { tsMs: 0, lastCommitted: 900_000 },
      { tsMs: 5_000, lastCommitted: 100 },     // restart
      { tsMs: 10_000, lastCommitted: 600 },
    ]);
    assert.equal(g.burnPerSec, 100); // only the post-reset pair counts
  });

  test('fewer than two samples cannot measure a rate', () => {
    const g = gcacheWindow(healthy(), [{ tsMs: 0, lastCommitted: 987_654 }]);
    assert.equal(g.burnPerSec, null);
    assert.equal(g.timeToSstMs, null);
    assert.equal(g.windowSeqnos, 1_154);
  });

  test('missing cached_downto degrades the window, keeps the gcache size', () => {
    const g = gcacheWindow({ ...healthy(), localCachedDownto: null }, [
      { tsMs: 0, lastCommitted: 987_000 },
      { tsMs: 5_000, lastCommitted: 987_654 },
    ]);
    assert.equal(g.windowSeqnos, null);
    assert.equal(g.timeToSstMs, null);
    assert.equal(g.gcacheSizeText, '128 MB');
  });

  test('gcache.size extraction: suffixes, raw fallback, absent and malformed', () => {
    assert.equal(gcacheSizeText('base_port = 3306; gcache.size = 1G; evs.version = 0'), '1.0 GB');
    assert.equal(gcacheSizeText('gcache.size=512M'), '512 MB');
    assert.equal(gcacheSizeText('gcache.size = bogus'), 'bogus');
    assert.equal(gcacheSizeText('base_port = 3306; evs.version = 0'), null);
    assert.equal(gcacheSizeText(';;;'), null);
    assert.equal(gcacheSizeText(null), null);
  });
});

describe('parseEvsLatency', () => {
  test('parses the min/avg/max string', () => {
    assert.deepEqual(parseEvsLatency('0.000216/0.000539/0.00212'), {
      min: 0.000216, avg: 0.000539, max: 0.00212,
    });
  });
  test('garbage and missing values yield null', () => {
    assert.equal(parseEvsLatency('0.1/0.2'), null);
    assert.equal(parseEvsLatency('a/b/c'), null);
    assert.equal(parseEvsLatency(''), null);
    assert.equal(parseEvsLatency(null), null);
  });
});

describe('formatting', () => {
  test('fmtBytes', () => {
    assert.equal(fmtBytes(null), '—');
    assert.equal(fmtBytes(640), '640 B');
    assert.equal(fmtBytes(1536), '1.5 KB');
    assert.equal(fmtBytes(123456789), '118 MB');
    assert.equal(fmtBytes(2 * 1024 ** 3), '2.0 GB');
  });
  test('fmtPct', () => {
    assert.equal(fmtPct(null), '—');
    assert.equal(fmtPct(0), '0%');
    assert.equal(fmtPct(0.2), '20%');
    assert.equal(fmtPct(0.123), '12.3%');
    assert.equal(fmtPct(0.001), '0.1%');
  });
  test('fmtElapsed', () => {
    assert.equal(fmtElapsed(0), '0 s');
    assert.equal(fmtElapsed(42_000), '42 s');
    assert.equal(fmtElapsed(12 * 60_000 + 5_000), '12 min 5 s');
    assert.equal(fmtElapsed(60_000), '1 min');
    assert.equal(fmtElapsed(3 * 3_600_000 + 40 * 60_000), '3 h 40 min');
    assert.equal(fmtElapsed(3_600_000), '1 h');
    assert.equal(fmtElapsed(-5), '0 s');
  });
});

// ── live MariaDB 11.8 fixtures ──────────────────────────────────────────────
// Real wsrep SHOW captures from the local 3-node MariaDB 11.8 + galera
// 26.4.27 cluster (2026-10-02); the SST experiment that produced the donor
// fixture is documented in tests/fixtures/galera-sst-timeline.log.

describe('live MariaDB 11.8 fixtures — Synced nodes', () => {
  for (const n of [1, 2, 3] as const) {
    test(`galera${n} Synced: parses clean, zero false positives`, () => {
      const { statusRows, variableRows } = fixtureRows(`galera-status-mariadb118-synced-node${n}.txt`);
      // MariaDB 11.8 has NO wsrep_on STATUS row — detection keys off the
      // VARIABLE (the probe bug this regression-pins).
      assert.ok(!statusRows.some(([k]) => k.toLowerCase() === 'wsrep_on'));
      assert.equal(detectGalera(statusRows), false);
      assert.equal(detectGalera(variableRows), true);
      const s = parseGaleraStatus(statusRows, variableRows);
      assert.equal(s.detected, true);
      assert.equal(s.localStateComment, 'Synced');
      assert.equal(s.clusterStatus, 'Primary');
      assert.equal(s.clusterSize, 3);
      assert.equal(s.nodeName, `galera${n}`);
      assert.equal(s.ready, 'ON');
      assert.equal(s.connected, 'ON');
      // wsrep_incoming_addresses is a STATUS variable on MariaDB with the
      // literal value 'AUTO,AUTO,AUTO' (wsrep_node_incoming_address=AUTO).
      assert.equal(s.incomingAddresses, 'AUTO,AUTO,AUTO');
      assert.equal(istProgress(s), null);
      assert.equal(transferState(s, 10_000, 4_000), null);
      const w = gcacheWindow(s, []);
      assert.equal(w.gcacheSizeText, '64.0 MB');
      assert.ok(w.windowSeqnos !== null && w.windowSeqnos >= 0);
      // The healthy-cluster contract: exactly one OK finding, nothing else.
      for (const f of galeraFindings(s)) assert.equal(f.level, 'ok', f.title);
      assert.equal(galeraFindings(s).length, 1);
      for (const f of galeraFindings(s, s)) assert.equal(f.level, 'ok', f.title);
      assert.equal(galeraFindings(s, s).length, 1);
    });
  }
});

describe('live MariaDB 11.8 fixtures — the rsync-SST donor', () => {
  test('galera1 Donor/Desynced mid-SST: donor card with cause sst, no backup-mode misread', () => {
    const { statusRows, variableRows } = fixtureRows('galera-status-mariadb118-donor.txt');
    const s = parseGaleraStatus(statusRows, variableRows);
    // The real capture: slash spelling, desync variable OFF, desync_count 1,
    // ready ON, cluster_size 3 — the donor keeps serving while streaming.
    assert.equal(s.localStateComment, 'Donor/Desynced');
    assert.ok(isDonorState(s.localStateComment));
    assert.equal(s.desync, 'OFF');
    assert.equal(s.desyncCount, 1);
    assert.equal(s.ready, 'ON');
    assert.equal(s.clusterSize, 3);
    const t = transferState(s, 10_000, 4_000);
    assert.ok(t);
    assert.equal(t.phase, 'donor');
    assert.equal(t.donorCause, 'sst');
    assert.equal(t.elapsedMs, 6_000);
    const titles = galeraFindings(s).map(f => f.title);
    assert.ok(titles.some(x => /donor/i.test(x)));
    // desync_count=1 with desync=OFF must NOT read as backup mode.
    assert.ok(!titles.some(x => /manually desynced/i.test(x)));
    assert.equal(istProgress(s), null);
  });
});

describe('galeraEventsFromTransition', () => {
  const healthy = () => parseGaleraStatus(healthyStatus(), healthyVars());

  test('the first poll only establishes the baseline — no events', () => {
    assert.deepEqual(galeraEventsFromTransition(null, healthy()), []);
  });

  test('a steady state emits nothing, poll after poll', () => {
    const a = healthy();
    assert.deepEqual(galeraEventsFromTransition(a, healthy()), []);
    assert.deepEqual(galeraEventsFromTransition(a, a), []);
  });

  test('an undetected current snapshot emits nothing', () => {
    assert.deepEqual(
      galeraEventsFromTransition(healthy(), { ...healthy(), detected: false }), []);
  });

  test('Synced → Donor/Desynced is one incident event, cause-disambiguated', () => {
    const donor = { ...healthy(), localStateComment: 'Donor/Desynced' };
    // wsrep_desync OFF in healthyVars ⇒ a donated SST, not backup mode.
    const evs = galeraEventsFromTransition(healthy(), donor);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].eventType, 'local_state');
    assert.equal(evs[0].summary, 'Node left Synced → Donor/Desynced (donating SST)');
    assert.equal(evs[0].ok, false);
    assert.ok(evs[0].detail.includes('node node1'));
  });

  test('Synced → Donor/Desynced with wsrep_desync=ON reads as a manual desync', () => {
    const donor = { ...healthy(), localStateComment: 'Donor/Desynced', desync: 'ON' };
    const evs = galeraEventsFromTransition(healthy(), donor);
    assert.equal(evs[0].summary, 'Node left Synced → Donor/Desynced (manual desync)');
  });

  test('Donor/Desynced → Synced is the recovery event (green)', () => {
    const donor = { ...healthy(), localStateComment: 'Donor/Desynced' };
    const evs = galeraEventsFromTransition(donor, healthy());
    assert.equal(evs.length, 1);
    assert.equal(evs[0].summary, 'Donation/desync finished — node back to Synced');
    assert.equal(evs[0].ok, true);
  });

  test('Joined → Synced names the catch-up finish', () => {
    const joined = { ...healthy(), localStateComment: 'Joined' };
    const evs = galeraEventsFromTransition(joined, healthy());
    assert.equal(evs[0].summary, 'Node caught up — Joined → Synced');
    assert.equal(evs[0].ok, true);
  });

  test('other state changes get a generic line; non-Synced landings are incidents', () => {
    const joining = { ...healthy(), localStateComment: 'Joining' };
    const evs = galeraEventsFromTransition(healthy(), joining);
    assert.equal(evs[0].summary, 'Local state Synced → Joining');
    assert.equal(evs[0].ok, false);
  });

  test('unreadable state keys (null) never fabricate a transition', () => {
    assert.deepEqual(
      galeraEventsFromTransition({ ...healthy(), localStateComment: null }, healthy()), []);
    assert.deepEqual(
      galeraEventsFromTransition(healthy(), { ...healthy(), localStateComment: null }), []);
  });

  test('cluster shrink is an incident, growth is the rejoin', () => {
    const two = { ...healthy(), clusterSize: 2, clusterConfId: 43 };
    const down = galeraEventsFromTransition(healthy(), two);
    // conf_id bumped WITH the size change — reported once, as the size event.
    assert.equal(down.length, 1);
    assert.equal(down[0].eventType, 'cluster_size');
    assert.equal(down[0].summary, 'Cluster size 3 → 2 — a member left');
    assert.equal(down[0].ok, false);

    const back = galeraEventsFromTransition(two, { ...healthy(), clusterConfId: 44 });
    assert.equal(back.length, 1);
    assert.equal(back[0].summary, 'Cluster size 2 → 3 — a member (re)joined');
    assert.equal(back[0].ok, true);
  });

  test('flow control: one event per crossing, both directions', () => {
    const hot = { ...healthy(), flowControlPaused: 0.6 };
    const rising = galeraEventsFromTransition(healthy(), hot);
    // Jumping past both thresholds yields ONE event — the highest crossing.
    assert.equal(rising.length, 1);
    assert.equal(rising[0].eventType, 'flow_control');
    assert.ok(rising[0].summary.includes('critical'));
    assert.equal(rising[0].ok, false);

    const warn = { ...healthy(), flowControlPaused: 0.2 };
    const toWarn = galeraEventsFromTransition(healthy(), warn);
    assert.equal(toWarn.length, 1);
    assert.ok(toWarn[0].summary.includes('warning'));

    const falling = galeraEventsFromTransition(hot, { ...healthy(), flowControlPaused: 0.05 });
    assert.equal(falling.length, 1);
    // Highest threshold crossed, whichever direction — symmetric with rising.
    assert.ok(falling[0].summary.includes('fell back below the critical'));
    assert.equal(falling[0].ok, true);

    // Below every threshold, and unreadable ratios, stay silent.
    assert.deepEqual(
      galeraEventsFromTransition(healthy(), { ...healthy(), flowControlPaused: 0.05 }), []);
    assert.deepEqual(
      galeraEventsFromTransition({ ...healthy(), flowControlPaused: null }, hot), []);
  });

  test('a state-UUID change is the split-brain signal, always reported', () => {
    const rebased = { ...healthy(), clusterStateUuid: 'aaaaaaaa-0000-1111-2222-333344445555' };
    const evs = galeraEventsFromTransition(healthy(), rebased);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].eventType, 'cluster_view');
    assert.ok(/split-brain/i.test(evs[0].summary));
    assert.equal(evs[0].ok, false);
    // A uuid change rides along even when the size changed with it.
    const shrunk = { ...rebased, clusterSize: 2, clusterConfId: 43 };
    const both = galeraEventsFromTransition(healthy(), shrunk);
    assert.deepEqual(both.map(e => e.eventType), ['cluster_size', 'cluster_view']);
  });

  test('a conf_id bump without a membership change is informational', () => {
    const bumped = { ...healthy(), clusterConfId: 43 };
    const evs = galeraEventsFromTransition(healthy(), bumped);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].eventType, 'cluster_view');
    assert.ok(evs[0].summary.includes('conf_id 42 → 43'));
    assert.equal(evs[0].ok, true);
  });

  test('several transitions in one poll produce several events', () => {
    // Stop a node while this one becomes the donor: size + state at once.
    const cur = { ...healthy(), localStateComment: 'Donor/Desynced', clusterSize: 2, clusterConfId: 43 };
    const evs = galeraEventsFromTransition(healthy(), cur);
    assert.deepEqual(evs.map(e => e.eventType), ['local_state', 'cluster_size']);
  });
});

describe('orderMembershipColumns', () => {
  test('identity first, then segment and address, the rest untouched', () => {
    assert.deepEqual(
      orderMembershipColumns(['cluster_conf_id', 'address', 'node_uuid', 'node_name', 'segment']),
      ['node_name', 'node_uuid', 'segment', 'address', 'cluster_conf_id']);
  });
  test('case-insensitive and prefix-tolerant on addresses', () => {
    assert.deepEqual(
      orderMembershipColumns(['Extra', 'NODE_NAME', 'node_incoming_addr']),
      ['NODE_NAME', 'node_incoming_addr', 'Extra']);
  });
  test('an unknown column set comes back in its original order', () => {
    assert.deepEqual(orderMembershipColumns(['b', 'a', 'c']), ['b', 'a', 'c']);
    assert.deepEqual(orderMembershipColumns([]), []);
  });
});
