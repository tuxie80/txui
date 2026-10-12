#!/usr/bin/env node
/**
 * Live driver for the Galera BACKGROUND WATCH logic (utils/galeraWatch.ts)
 * against the real 3-node MariaDB 11.8 cluster (dbctl galera1/2/3).
 *
 * The app's watch loop is a Tauri invoke away (galera_cluster_poll), which a
 * node script cannot call — but everything the loop DECIDES is the pure
 * processWatchRound, and that is what this harness exercises end-to-end: it
 * polls the real nodes with the mariadb client exactly the way the backend's
 * poll probes them (the same two SHOWs), assembles the same NodeSnapshot
 * shape the Channel stream carries, and feeds every round through
 * processWatchRound, printing the timeline events it would persist and the
 * notifications it would fire.
 *
 *     node dev/galera_watch_live.mjs [intervalSecs] [rounds]
 *
 * Defaults: 5 s (the demo cadence — the app ships 15..120 s), forever.
 * Drive an incident in another terminal: dbctl stop galera3 / dbctl start
 * galera3 — expect "a member left" + (after 3 rounds) "unreachable" notices,
 * then the rejoin rows. Read-only by construction: SHOW probes only.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  processWatchRound, emptyWatchRoundState,
} from '../src/utils/galeraWatch.ts';

const run = promisify(execFile);

const CLIENT = '/opt/homebrew/opt/mariadb@11.8/bin/mariadb';
const NODES = [
  { id: 'galera1', port: 3341 },
  { id: 'galera2', port: 3342 },
  { id: 'galera3', port: 3343 },
];
const INTERVAL_SECS = Number(process.argv[2] ?? 5);
const ROUNDS = Number(process.argv[3] ?? Infinity);

const STATUS_SQL = "SHOW GLOBAL STATUS LIKE 'wsrep%'";
const VARIABLES_SQL = "SHOW GLOBAL VARIABLES LIKE 'wsrep%'";

/** One SHOW as (name, value) pairs, tab-separated batch output. */
async function show(port, sql) {
  const { stdout } = await run(CLIENT, [
    '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-proot',
    '--batch', '--skip-column-names', '--connect-timeout=5', '-e', sql,
  ], { timeout: 15_000 });
  return stdout.split('\n').filter(l => l.includes('\t'))
    .map(l => [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)]);
}

async function pollNode(node) {
  const t0 = Date.now();
  try {
    const [statusRows, variableRows] = await Promise.all([
      show(node.port, STATUS_SQL), show(node.port, VARIABLES_SQL),
    ]);
    return {
      connectionId: node.id, connectionName: node.id, ok: true, error: null,
      statusRows, variableRows, elapsedMs: Date.now() - t0, polledAtMs: Date.now(),
    };
  } catch (e) {
    return {
      connectionId: node.id, connectionName: node.id, ok: false,
      error: String(e?.message ?? e).split('\n').slice(-1)[0] ?? 'poll failed',
      statusRows: [], variableRows: [], elapsedMs: Date.now() - t0, polledAtMs: Date.now(),
    };
  }
}

const stamp = () => new Date().toLocaleTimeString('en-GB');
let state = emptyWatchRoundState();
console.log(`watching ${NODES.map(n => n.id).join(', ')} every ${INTERVAL_SECS}s — Ctrl-C to stop`);
for (let round = 1; round <= ROUNDS; round++) {
  const snapshots = await Promise.all(NODES.map(pollNode));
  const res = processWatchRound(snapshots, state, Date.now());
  state = res.state;
  const states = snapshots.map(s => {
    if (!s.ok) return `${s.connectionName}=DOWN`;
    const row = s.statusRows.find(([k]) => k === 'wsrep_local_state_comment');
    const size = s.statusRows.find(([k]) => k === 'wsrep_cluster_size');
    return `${s.connectionName}=${row?.[1] ?? '?'}/${size?.[1] ?? '?'}`;
  });
  console.log(`${stamp()} round ${round}: ${states.join('  ')}`);
  for (const t of res.timeline) {
    for (const ev of t.events) {
      console.log(`  ${ev.ok ? '✓' : '✗'} TIMELINE [${t.connectionId}] (${ev.eventType}) ${ev.summary}`);
    }
  }
  for (const n of res.notices) {
    console.log(`  🔔 NOTIFY [${n.level}] ${n.title}`);
  }
  if (round < ROUNDS) await new Promise(r => setTimeout(r, INTERVAL_SECS * 1000));
}
