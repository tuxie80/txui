/**
 * tests for src/utils/galeraCluster.ts — the multi-node merge: every cluster
 * finding firing and not firing, 2-node and 3-node clusters, unreachable and
 * non-Galera nodes, mixed MariaDB/PXC key sets, rate math against previous
 * snapshots, and the observation-clock helpers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  mergeCluster, trackStateSince, trackPairSince,
  parseIncoming, looksLikeMidSst,
  type NodeSnapshot, type MergeContext,
} from '../src/utils/galeraCluster.ts';

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

const UUID_A = '5f3c9d1a-1234-11ec-9abc-0242ac120002';
const UUID_B = 'aaaaaaa1-1234-11ec-9abc-0242ac120002';

/** A healthy Galera node's rows; per-key overrides flip one thing at a time. */
function galeraRows(over: Record<string, string> = {}): { statusRows: Row[]; variableRows: Row[] } {
  const st: Record<string, string> = {
    wsrep_on: 'ON',
    wsrep_ready: 'ON',
    wsrep_connected: 'ON',
    wsrep_cluster_status: 'Primary',
    wsrep_cluster_state_uuid: UUID_A,
    wsrep_cluster_size: '2',
    wsrep_local_state_comment: 'Synced',
    wsrep_last_committed: '1000',
    wsrep_local_recv_queue: '0',
    wsrep_local_recv_queue_avg: '0.000000',
    wsrep_local_send_queue: '0',
    wsrep_flow_control_paused: '0.000000',
    wsrep_desync_count: '0',
  };
  const va: Record<string, string> = {
    wsrep_on: 'ON',
    wsrep_cluster_name: 'prod_cluster',
    wsrep_node_name: 'node-1',
    wsrep_node_address: '10.0.0.1',
    wsrep_incoming_addresses: '10.0.0.1:3306,10.0.0.2:3306',
    wsrep_desync: 'OFF',
  };
  for (const [k, v] of Object.entries(over)) {
    if (k in va) va[k] = v; else st[k] = v;
  }
  return {
    statusRows: Object.entries(st).map(([k, v]) => [k, v]),
    variableRows: Object.entries(va).map(([k, v]) => [k, v]),
  };
}

let seq = 0;
function node(opts: Partial<NodeSnapshot> & { over?: Record<string, string> } = {}): NodeSnapshot {
  const { over, ...rest } = opts;
  const rows = galeraRows(over);
  return {
    connectionId: rest.connectionId ?? `conn-${++seq}`,
    connectionName: rest.connectionName ?? `node-${seq}`,
    ok: rest.ok ?? true,
    error: rest.error ?? null,
    statusRows: rest.statusRows ?? rows.statusRows,
    variableRows: rest.variableRows ?? rows.variableRows,
    elapsedMs: rest.elapsedMs ?? 40,
    polledAtMs: rest.polledAtMs ?? 10_000,
  };
}

const ctx = (extra: Partial<MergeContext> = {}): MergeContext => ({ nowMs: 60_000, ...extra });

const levels = (v: ReturnType<typeof mergeCluster>) => v.findings.map(f => f.level);
const titles = (v: ReturnType<typeof mergeCluster>) => v.findings.map(f => f.title);

// ── healthy clusters ─────────────────────────────────────────────────────────

describe('healthy clusters', () => {
  test('2-node healthy cluster yields the all-good OK finding', () => {
    const v = mergeCluster([
      node({ connectionId: 'a', connectionName: 'A' }),
      node({ connectionId: 'b', connectionName: 'B', over: { wsrep_node_name: 'node-2', wsrep_node_address: '10.0.0.2' } }),
    ], ctx());
    assert.deepEqual(levels(v), ['ok']);
    assert.match(v.findings[0].title, /2 nodes, all Synced, size 2, cluster prod_cluster/);
  });

  test('3-node healthy cluster, size 3', () => {
    const mk = (id: string, n: number) => node({
      connectionId: id, connectionName: id,
      over: {
        wsrep_cluster_size: '3',
        wsrep_node_name: `n${n}`, wsrep_node_address: `10.0.0.${n}`,
        wsrep_incoming_addresses: '10.0.0.1:3306,10.0.0.2:3306,10.0.0.3:3306',
      },
    });
    const v = mergeCluster([mk('a', 1), mk('b', 2), mk('c', 3)], ctx());
    assert.deepEqual(levels(v), ['ok']);
    assert.match(v.findings[0].title, /3 nodes, all Synced, size 3/);
    assert.equal(v.nodes.length, 3);
    assert.ok(v.nodes.every(n => n.synced === true));
  });

  test('node summary carries the parsed fields', () => {
    const v = mergeCluster([node({ connectionId: 'a' })], ctx());
    const n = v.nodes[0];
    assert.equal(n.reachable, true);
    assert.equal(n.detected, true);
    assert.equal(n.nodeName, 'node-1');
    assert.equal(n.localState, 'Synced');
    assert.equal(n.clusterSize, 2);
    assert.deepEqual(n.incomingAddresses, ['10.0.0.1:3306', '10.0.0.2:3306']);
  });
});

// ── split-brain ───────────────────────────────────────────────────────────────

describe('split-brain', () => {
  test('same cluster name, different state UUIDs → CRIT', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', over: { wsrep_cluster_state_uuid: UUID_B, wsrep_node_name: 'n2' } }),
    ], ctx());
    assert.equal(v.findings[0].level, 'crit');
    assert.match(v.findings[0].title, /Split-brain: nodes of "prod_cluster" report 2 different cluster state UUIDs/);
  });

  test('two Primary nodes with disjoint memberships → CRIT', () => {
    const v = mergeCluster([
      node({ connectionId: 'a', over: { wsrep_incoming_addresses: '10.0.0.1:3306,10.0.0.2:3306' } }),
      node({ connectionId: 'b', over: {
        wsrep_node_name: 'n3', wsrep_incoming_addresses: '10.0.0.3:3306,10.0.0.4:3306',
      } }),
    ], ctx());
    assert.equal(v.findings[0].level, 'crit');
    assert.match(v.findings[0].title, /both Primary over disjoint memberships/);
  });

  test('shared membership overlap is NOT split-brain', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', over: { wsrep_node_name: 'n2' } }),
    ], ctx());
    assert.ok(!titles(v).some(t => t.includes('Split-brain')));
  });

  test('differing UUIDs under DIFFERENT cluster names → no split-brain (mixed-cluster warn instead)', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', over: { wsrep_cluster_state_uuid: UUID_B, wsrep_cluster_name: 'staging', wsrep_node_name: 'n2' } }),
    ], ctx());
    assert.ok(!v.findings.some(f => f.level === 'crit'));
    assert.ok(titles(v).some(t => t.includes('different clusters')));
  });
});

// ── size / membership disagreement ───────────────────────────────────────────

describe('size and membership disagreement', () => {
  test('cluster_size differs → WARN', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', over: { wsrep_cluster_size: '3', wsrep_node_name: 'n2' } }),
    ], ctx());
    const f = v.findings.find(f => f.title.includes('disagree on the cluster size'));
    assert.ok(f);
    assert.equal(f.level, 'warn');
    assert.match(f.title, /2 vs 3/);
  });

  test('cluster_size agrees → no size finding', () => {
    const v = mergeCluster([node({ connectionId: 'a' }), node({ connectionId: 'b' })], ctx());
    assert.ok(!titles(v).some(t => t.includes('disagree on the cluster size')));
  });

  test('a node missing from another\'s view → WARN naming the missing address', () => {
    const v = mergeCluster([
      node({ connectionId: 'a', over: { wsrep_incoming_addresses: '10.0.0.1:3306,10.0.0.2:3306,10.0.0.3:3306', wsrep_cluster_size: '3' } }),
      node({ connectionId: 'b', over: { wsrep_node_name: 'n2' } }),
    ], ctx());
    const f = v.findings.find(f => f.title.includes('does not see'));
    assert.ok(f);
    assert.equal(f.level, 'warn');
    assert.match(f.title, /10\.0\.0\.3:3306/);
  });

  test('identical memberships → no membership finding', () => {
    const v = mergeCluster([node({ connectionId: 'a' }), node({ connectionId: 'b' })], ctx());
    assert.ok(!titles(v).some(t => t.includes('does not see')));
  });
});

// ── donor ↔ joiner pairing ────────────────────────────────────────────────────

describe('donor/joiner pairing', () => {
  const donor = (id: string) => node({
    connectionId: id, over: { wsrep_local_state_comment: 'Donor/Desynced' },
  });
  const joiner = (id: string, name: string) => node({
    connectionId: id, connectionName: name,
    over: { wsrep_local_state_comment: 'Joining', wsrep_ready: 'OFF', wsrep_node_name: name },
  });

  test('donor + joiner → INFO with elapsed from the pair clock', () => {
    const v = mergeCluster([donor('d'), joiner('j', 'n2')], ctx({
      nowMs: 90_000,
      pairSince: { 'd→j': 60_000 },
    }));
    const f = v.findings.find(f => f.title.includes('SST in progress'));
    assert.ok(f);
    assert.equal(f.level, 'info');
    assert.match(f.title, /elapsed 30 s/);
  });

  test('elapsed uses nowMs when the pair was just observed', () => {
    const v = mergeCluster([donor('d'), joiner('j', 'n2')], ctx({ nowMs: 75_000 }));
    const f = v.findings.find(f => f.title.includes('SST in progress'));
    assert.match(f!.title, /elapsed 0 s/);
  });

  test('a MANUALLY desynced donor is not paired with a joiner', () => {
    const manual = node({
      connectionId: 'd', over: { wsrep_local_state_comment: 'Donor/Desynced', wsrep_desync: 'ON' },
    });
    const v = mergeCluster([manual, joiner('j', 'n2')], ctx());
    assert.ok(!titles(v).some(t => t.includes('SST in progress')));
  });

  test('donor without a joiner (or joiner without a donor) → no pairing', () => {
    assert.ok(!titles(mergeCluster([donor('d')], ctx())).some(t => t.includes('SST in progress')));
    assert.ok(!titles(mergeCluster([joiner('j', 'n2')], ctx())).some(t => t.includes('SST in progress')));
  });

  test('trackPairSince keeps the stamp while the pair is observed, drops it when gone', () => {
    const withPair = mergeCluster([donor('d'), joiner('j', 'n2')], ctx());
    const t1 = trackPairSince(withPair, {}, 1_000);
    assert.deepEqual(t1, { 'd→j': 1_000 });
    const t2 = trackPairSince(withPair, t1, 5_000);
    assert.deepEqual(t2, { 'd→j': 1_000 }, 'still paired → original stamp kept');
    const healthy = mergeCluster([node({ connectionId: 'a' })], ctx());
    const t3 = trackPairSince(healthy, t2, 9_000);
    assert.deepEqual(t3, {}, 'pair gone → clock dropped, so a later SST starts fresh');
  });
});

// ── unreachable / non-Galera nodes ───────────────────────────────────────────

describe('unreachable and non-Galera nodes', () => {
  test('unreachable node → WARN with the error; cluster findings use the rest', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', connectionName: 'B', ok: false, error: 'connect timed out', statusRows: [], variableRows: [] }),
    ], ctx());
    const f = v.findings.find(f => f.title.includes('unreachable'));
    assert.ok(f);
    assert.equal(f.level, 'warn');
    assert.match(f.detail, /connect timed out/);
    const dead = v.nodes.find(n => n.connectionId === 'b')!;
    assert.equal(dead.reachable, false);
    assert.equal(dead.synced, null);
  });

  test('the 1047 "not yet prepared" signature → INFO likely mid-SST', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({
        connectionId: 'b', connectionName: 'B', ok: false,
        error: 'ERROR 1047 (08S01): WSREP has not yet prepared node for application use',
        statusRows: [], variableRows: [],
      }),
    ], ctx());
    const f = v.findings.find(f => f.title.includes('likely mid-SST'));
    assert.ok(f);
    assert.equal(f.level, 'info');
    assert.ok(!titles(v).some(t => t.includes('is unreachable')));
  });

  test('reachable but wsrep OFF → WARN "not a Galera node", excluded from comparisons', () => {
    const plain = node({
      connectionId: 'b', connectionName: 'plain',
      statusRows: [], variableRows: [['wsrep_on', 'OFF']],
    });
    const v = mergeCluster([node({ connectionId: 'a' }), plain], ctx());
    const f = v.findings.find(f => f.title.includes('is not a Galera node'));
    assert.ok(f);
    assert.equal(f.level, 'warn');
    // Excluded: no size disagreement despite the size-1 vs size-2 readings.
    assert.ok(!titles(v).some(t => t.includes('disagree on the cluster size')));
  });

  test('looksLikeMidSst matches both spellings, rejects other errors', () => {
    assert.ok(looksLikeMidSst('ERROR 1047 (08S01): whatever'));
    assert.ok(looksLikeMidSst('wsrep has not yet prepared node for application use'));
    assert.ok(!looksLikeMidSst('access denied for user'));
    assert.ok(!looksLikeMidSst(null));
  });
});

// ── slowest node ──────────────────────────────────────────────────────────────

describe('slowest node', () => {
  test('unique persistent backlog (EWMA) → INFO naming it', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', connectionName: 'slow', over: { wsrep_local_recv_queue_avg: '2.500000', wsrep_local_recv_queue: '3', wsrep_node_name: 'n2' } }),
    ], ctx());
    const f = v.findings.find(f => f.title.includes('Slowest node'));
    assert.ok(f);
    assert.equal(f.level, 'info');
    assert.match(f.title, /slow \(n2\).*avg 2\.50/);
  });

  test('a stale-high EWMA with empty current queues is post-catch-up residue, named neither', () => {
    // Verified live 2026-10-02: recv_queue_avg stayed >3 for ~30 min after an
    // IST rejoin while the node sat idle and Synced — not a slowest node.
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', connectionName: 'rejoined', over: { wsrep_local_recv_queue_avg: '3.140000', wsrep_node_name: 'n2' } }),
    ], ctx());
    assert.ok(!titles(v).some(t => t.includes('Slowest node')));
  });

  test('two nodes with equal persistent backlog name NEITHER', () => {
    const v = mergeCluster([
      node({ connectionId: 'a', over: { wsrep_local_recv_queue_avg: '2.000000', wsrep_local_recv_queue: '3' } }),
      node({ connectionId: 'b', over: { wsrep_local_recv_queue_avg: '2.000000', wsrep_local_recv_queue: '3', wsrep_node_name: 'n2' } }),
    ], ctx());
    assert.ok(!titles(v).some(t => t.includes('Slowest node')));
  });

  test('unique instantaneous queue (no EWMA signal) → INFO "Largest apply queue"', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', connectionName: 'burst', over: { wsrep_local_recv_queue: '42', wsrep_node_name: 'n2' } }),
    ], ctx());
    const f = v.findings.find(f => f.title.includes('Largest apply queue'));
    assert.ok(f);
    assert.match(f!.title, /burst.*42/);
  });

  test('unique flow-control outlier → INFO "Most flow-control throttled"', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', connectionName: 'throttled', over: { wsrep_flow_control_paused: '0.250000', wsrep_node_name: 'n2' } }),
    ], ctx());
    const f = v.findings.find(f => f.title.includes('Most flow-control throttled'));
    assert.ok(f);
    assert.match(f!.title, /throttled.*25%/);
  });

  test('healthy cluster → none of the slow-node infos', () => {
    const v = mergeCluster([node({ connectionId: 'a' }), node({ connectionId: 'b' })], ctx());
    assert.ok(!titles(v).some(t => /Slowest node|Largest apply queue|flow-control throttled/.test(t)));
  });
});

// ── mixed cluster names ───────────────────────────────────────────────────────

describe('mixed clusters', () => {
  test('two cluster names in the selection → WARN', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', over: { wsrep_cluster_name: 'analytics', wsrep_node_name: 'n9' } }),
    ], ctx());
    const f = v.findings.find(f => f.title.includes('different clusters'));
    assert.ok(f);
    assert.equal(f.level, 'warn');
    assert.match(f.title, /prod_cluster.*analytics|analytics.*prod_cluster/);
  });
});

// ── rates against the previous poll ───────────────────────────────────────────

describe('write rates', () => {
  test('commits/s and bytes/s from the previous snapshot', () => {
    const prev = node({
      connectionId: 'a', polledAtMs: 5_000,
      over: { wsrep_last_committed: '1000', wsrep_replicated_bytes: '1000000', wsrep_received_bytes: '2000000' },
    });
    const cur = node({
      connectionId: 'a', polledAtMs: 10_000,
      over: { wsrep_last_committed: '1500', wsrep_replicated_bytes: '2000000', wsrep_received_bytes: '2600000' },
    });
    const v = mergeCluster([cur], ctx({ prev: [prev] }));
    const r = v.nodes[0].rates;
    assert.equal(r.commitsPerSec, 100);
    assert.equal(r.replicatedBytesPerSec, 200_000);
    assert.equal(r.receivedBytesPerSec, 120_000);
  });

  test('no previous snapshot → null rates', () => {
    const v = mergeCluster([node({ connectionId: 'a' })], ctx());
    assert.deepEqual(v.nodes[0].rates, {
      commitsPerSec: null, replicatedBytesPerSec: null, receivedBytesPerSec: null,
    });
  });

  test('a counter reset (restart / FLUSH STATUS) → null, never negative', () => {
    const prev = node({ connectionId: 'a', polledAtMs: 5_000, over: { wsrep_last_committed: '9000' } });
    const cur = node({ connectionId: 'a', polledAtMs: 10_000, over: { wsrep_last_committed: '50' } });
    const v = mergeCluster([cur], ctx({ prev: [prev] }));
    assert.equal(v.nodes[0].rates.commitsPerSec, null);
  });

  test('previous poll of a DIFFERENT node is not used', () => {
    const other = node({ connectionId: 'b', polledAtMs: 5_000, over: { wsrep_last_committed: '10' } });
    const cur = node({ connectionId: 'a', polledAtMs: 10_000, over: { wsrep_last_committed: '99999' } });
    const v = mergeCluster([cur], ctx({ prev: [other] }));
    assert.equal(v.nodes[0].rates.commitsPerSec, null);
  });
});

// ── observation clocks ────────────────────────────────────────────────────────

describe('trackStateSince', () => {
  test('same state keeps the stamp; a state change restarts it', () => {
    const n = node({ connectionId: 'a' });
    const t1 = trackStateSince([n], {}, 1_000);
    assert.deepEqual(t1, { a: { state: 'Synced', sinceMs: 1_000 } });
    const t2 = trackStateSince([n], t1, 5_000);
    assert.deepEqual(t2, t1);
    const changed = node({ connectionId: 'a', over: { wsrep_local_state_comment: 'Joining' } });
    const t3 = trackStateSince([changed], t2, 9_000);
    assert.deepEqual(t3, { a: { state: 'Joining', sinceMs: 9_000 } });
  });

  test('an unreachable poll keeps the old clock', () => {
    const t1 = trackStateSince([node({ connectionId: 'a' })], {}, 1_000);
    const dead = node({ connectionId: 'a', ok: false, error: 'timeout', statusRows: [], variableRows: [] });
    const t2 = trackStateSince([dead], t1, 5_000);
    assert.deepEqual(t2, t1);
  });

  test('the transfer card elapsed comes from the clock', () => {
    const joining = node({ connectionId: 'a', over: { wsrep_local_state_comment: 'Joining', wsrep_ready: 'OFF' } });
    const v = mergeCluster([joining], ctx({
      nowMs: 40_000,
      stateSince: { a: { state: 'Joining', sinceMs: 10_000 } },
    }));
    assert.equal(v.nodes[0].transfer?.phase, 'sst');
    assert.equal(v.nodes[0].transfer?.elapsedMs, 30_000);
  });
});

// ── tolerance ────────────────────────────────────────────────────────────────

describe('null / variant tolerance', () => {
  test('a node with only wsrep_on merges without findings or throws', () => {
    const bare = node({ connectionId: 'a', statusRows: [['wsrep_on', 'ON']], variableRows: [] });
    const v = mergeCluster([bare, node({ connectionId: 'b' })], ctx());
    const n = v.nodes[0];
    assert.equal(n.detected, true);
    assert.equal(n.synced, null);
    assert.equal(n.clusterSize, null);
    // The bare node is "(unknown cluster)" — it must not trigger mixed-cluster.
    assert.ok(!titles(v).some(t => t.includes('different clusters')));
  });

  test('MariaDB donor spelling "Donor/Desynced" and PXC "Donor-Desynced" both pair', () => {
    const join = node({ connectionId: 'j', connectionName: 'J', over: { wsrep_local_state_comment: 'Joining', wsrep_ready: 'OFF', wsrep_node_name: 'J' } });
    const slash = node({ connectionId: 'd1', over: { wsrep_local_state_comment: 'Donor/Desynced' } });
    const hyphen = node({ connectionId: 'd2', connectionName: 'D2', over: { wsrep_local_state_comment: 'Donor-Desynced' } });
    assert.ok(titles(mergeCluster([slash, join], ctx())).some(t => t.includes('SST in progress')));
    assert.ok(titles(mergeCluster([hyphen, join], ctx())).some(t => t.includes('SST in progress')));
  });

  test('empty node list merges to an empty view', () => {
    const v = mergeCluster([], ctx());
    assert.deepEqual(v.nodes, []);
    assert.deepEqual(v.findings, []);
  });

  test('parseIncoming trims, drops blanks and AUTO', () => {
    assert.deepEqual(parseIncoming(' 10.0.0.1:3306 , 10.0.0.2:3306 '), ['10.0.0.1:3306', '10.0.0.2:3306']);
    assert.deepEqual(parseIncoming('AUTO'), []);
    assert.deepEqual(parseIncoming(''), []);
    assert.deepEqual(parseIncoming(null), []);
  });

  test('findings are sorted most-severe first', () => {
    const v = mergeCluster([
      node({ connectionId: 'a' }),
      node({ connectionId: 'b', over: { wsrep_cluster_state_uuid: UUID_B, wsrep_node_name: 'n2' } }),
      node({ connectionId: 'c', connectionName: 'dead', ok: false, error: 'timeout', statusRows: [], variableRows: [] }),
    ], ctx());
    const lv = levels(v);
    assert.equal(lv[0], 'crit');
    assert.deepEqual([...lv].sort(), lv.filter(l => l !== 'ok').length ? lv : lv, 'crit precedes warn');
    assert.ok(lv.indexOf('crit') < lv.indexOf('warn'));
  });
});

// ── live MariaDB 11.8 fixtures ──────────────────────────────────────────────
// Real captures from the local 3-node MariaDB 11.8 Galera cluster, including
// the forced rsync-SST rejoin — tests/fixtures/galera-sst-timeline.log has
// the full experiment. Key live truths pinned here: the joiner refused TCP
// connections (ERROR 2002) for the entire SST, so "mid-SST" over SQL is the
// DONOR's Donor/Desynced (slash spelling, desync=OFF, desync_count=1) plus
// the joiner's unreachability — the 1047 shape never occurred.

describe('live MariaDB 11.8 fixtures', () => {
  const fixtureSnap = (id: string, name: string, polledAtMs = 1_000): NodeSnapshot => {
    const { statusRows, variableRows } = fixtureRows(name);
    return {
      connectionId: id, connectionName: id, ok: true, error: null,
      statusRows, variableRows, elapsedMs: 10, polledAtMs,
    };
  };
  const refused = (id: string): NodeSnapshot => ({
    connectionId: id, connectionName: id, ok: false,
    error: "ERROR 2002 (HY000): Can't connect to server on '127.0.0.1' (36)",
    statusRows: [], variableRows: [], elapsedMs: 2, polledAtMs: 1_000,
  });

  test('the healthy 3-node cluster merges to exactly the OK finding', () => {
    const v = mergeCluster([
      fixtureSnap('galera1', 'galera-status-mariadb118-synced-node1.txt'),
      fixtureSnap('galera2', 'galera-status-mariadb118-synced-node2.txt'),
      fixtureSnap('galera3', 'galera-status-mariadb118-synced-node3.txt'),
    ], ctx({ nowMs: 1_000 }));
    assert.equal(v.findings.length, 1, JSON.stringify(v.findings.map(f => f.title)));
    assert.equal(v.findings[0].level, 'ok');
    assert.equal(v.findings[0].title, '3 nodes, all Synced, size 3, cluster txui-galera');
    assert.ok(v.nodes.every(n => n.reachable && n.detected && n.synced === true));
  });

  test('mid-SST reality: donor + synced peer + connection-refused joiner', () => {
    const v = mergeCluster([
      fixtureSnap('galera1', 'galera-status-mariadb118-donor.txt'),
      fixtureSnap('galera2', 'galera-status-mariadb118-synced-node2.txt'),
      refused('galera3'),
    ], ctx({ nowMs: 1_000 }));
    // The donor parses as a live SST donation (desync=OFF + count=1 → 'sst').
    const donor = v.nodes.find(n => n.connectionId === 'galera1')!;
    assert.equal(donor.transfer?.phase, 'donor');
    assert.equal(donor.transfer?.donorCause, 'sst');
    // The refused joiner next to a live donor reads as the SST joiner — INFO,
    // not a WARN "unreachable" (verified shape: rsync SST keeps the port closed).
    const f = v.findings.find(f => f.title.includes('likely the SST joiner'));
    assert.ok(f, JSON.stringify(v.findings.map(x => x.title)));
    assert.equal(f.level, 'info');
    assert.match(f.title, /galera3 is unreachable while galera1 \(galera1\) donates/);
    assert.ok(!titles(v).some(t => t === 'galera3 is unreachable'));
  });

  test('connection-refused WITHOUT a donor stays a plain WARN unreachable', () => {
    const v = mergeCluster([
      fixtureSnap('galera1', 'galera-status-mariadb118-synced-node1.txt'),
      fixtureSnap('galera2', 'galera-status-mariadb118-synced-node2.txt'),
      refused('galera3'),
    ], ctx({ nowMs: 1_000 }));
    const f = v.findings.find(f => f.title === 'galera3 is unreachable');
    assert.ok(f);
    assert.equal(f.level, 'warn');
    assert.ok(!titles(v).some(t => t.includes('likely the SST joiner')));
  });

  test('the real MariaDB donor pairs with a Joining joiner (desync=OFF no longer excludes it)', () => {
    const joiner = node({
      connectionId: 'j', connectionName: 'n2',
      over: { wsrep_local_state_comment: 'Joining', wsrep_ready: 'OFF', wsrep_node_name: 'n2' },
    });
    const v = mergeCluster([
      fixtureSnap('galera1', 'galera-status-mariadb118-donor.txt'),
      joiner,
    ], ctx({ nowMs: 90_000, pairSince: { 'galera1→j': 60_000 } }));
    const f = v.findings.find(f => f.title.includes('SST in progress'));
    assert.ok(f);
    assert.match(f.title, /elapsed 30 s/);
  });
});
