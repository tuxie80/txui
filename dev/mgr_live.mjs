#!/usr/bin/env node
/**
 * Live driver for the Group Replication logic (utils/groupReplication.ts)
 * against the real single-node MGR fixture on my84 (dbctl start my84 —
 * dbctl re-bootstraps the group; setup/teardown in dev/mgr_fixture_setup.sql).
 *
 * The app's reads are Tauri invokes away (monitor_query), which a node script
 * cannot call — but everything the view DECIDES is the pure parser/health
 * layer, and that is what this harness exercises end-to-end: it runs exactly
 * the same SQL the view runs (plugin probe, members, stats, identity, plus
 * the opportunistic clone probe), feeds the rows through grPluginState /
 * parseGrSnapshot / grFindings / parseCloneProgress, and prints what the tab
 * would render.
 *
 *     node dev/mgr_live.mjs [port]
 *
 * Default port 3307 (my84). Read-only by construction: SELECTs only.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  grPluginState, parseGrSnapshot, grFindings, parseCloneProgress,
  GR_IDENTITY_SQL,
} from '../src/utils/groupReplication.ts';

const run = promisify(execFile);

const CLIENT = '/opt/homebrew/opt/mysql@8.4/bin/mysql';
const PORT = Number(process.argv[2] ?? 3307);

const MEMBERS_SQL = 'SELECT * FROM performance_schema.replication_group_members';
const STATS_SQL = 'SELECT * FROM performance_schema.replication_group_member_stats';
const CLONE_STATUS_SQL = 'SELECT * FROM performance_schema.clone_status';
const CLONE_PROGRESS_SQL = 'SELECT * FROM performance_schema.clone_progress';
const PLUGIN_PROBE_SQL =
  "SELECT PLUGIN_NAME, PLUGIN_STATUS FROM information_schema.PLUGINS WHERE PLUGIN_NAME = 'group_replication'";

/** One SELECT as { cols, rows } from tab-separated batch output ('' → null-safe). */
async function query(sql) {
  const { stdout } = await run(CLIENT, [
    '-h', '127.0.0.1', '-P', String(PORT), '-u', 'root', '-proot',
    '--batch', '--connect-timeout=5', '-e', sql,
  ], { timeout: 15_000 });
  const lines = stdout.split('\n').filter(l => l.length > 0);
  // An empty result set prints no header at all (observed: MariaDB 11.8).
  if (lines.length === 0) return { cols: [], rows: [] };
  const [head, ...rows] = lines;
  return { cols: head.split('\t'), rows: rows.map(l => l.split('\t').map(v => v === 'NULL' ? null : v)) };
}

const probe = await query(PLUGIN_PROBE_SQL);
const state = grPluginState(probe.rows.map(r => [r[0] ?? '', r[1] ?? '']));
console.log(`plugin probe (port ${PORT}): ${state}`);
if (state !== 'active') {
  console.log('nothing further to poll — the tab would render the empty state for this probe outcome.');
  process.exit(0);
}

const [members, stats, identity] = await Promise.all([
  query(MEMBERS_SQL), query(STATS_SQL), query(GR_IDENTITY_SQL),
]);
const snap = parseGrSnapshot(
  members.cols, members.rows, stats.cols, stats.rows, identity.rows[0],
);
console.log('\nsnapshot:');
for (const m of snap.members) {
  console.log(`  member ${m.host}:${m.port}  role=${m.role}  state=${m.state}  version=${m.version}${m.id === snap.serverUuid ? '  (this node)' : ''}`);
}
console.log(`  group=${snap.groupName}  singlePrimary=${snap.singlePrimary}  local=${snap.localAddress}  seeds=${snap.seeds}`);
for (const s of snap.stats) {
  console.log(`  stats ${s.memberId}: checked=${s.txChecked} conflicts=${s.conflicts} certQ=${s.certQueue} applierQ=${s.applierQueue} applied=${s.remoteApplied} proposed=${s.localProposed} committed=${s.committedAllMembers}`);
}

const findings = grFindings(snap);
console.log(`\nfindings: ${findings.length}`);
for (const f of findings) console.log(`  [${f.level}] ${f.title} — ${f.detail}`);

if (snap.members.some(m => m.state === 'RECOVERING')) {
  const [cs, cp] = await Promise.all([query(CLONE_STATUS_SQL), query(CLONE_PROGRESS_SQL)]);
  const clone = parseCloneProgress(cs.cols, cs.rows, cp.cols, cp.rows);
  console.log(`\nclone progress: ${clone ? `${clone.state} ${clone.overallPct ?? '—'}` : 'none (idle)'}`);
} else {
  console.log('\nno RECOVERING member — clone probe skipped (as the view does)');
}
