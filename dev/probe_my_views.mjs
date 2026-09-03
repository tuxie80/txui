#!/usr/bin/env node
/**
 * Run every MySQL DBA view against live MySQL **and MariaDB** servers.
 *
 * The MySQL views were written against MySQL and have only ever been run there.
 * MariaDB is not a slightly different MySQL for these purposes: it kept the
 * `information_schema.INNODB_*` tables MySQL 8 deleted, never grew
 * `performance_schema.data_locks`, ships with `performance_schema` **off**, and
 * carries its own replication vocabulary. A view that is merely plausible fails
 * at the moment a user clicks it, which is the worst place to find out.
 *
 * Per server, per view:
 *
 *   ok    — ran, with the row count
 *   EMPTY — ran and returned nothing (often correct: no locks, no replicas)
 *   FAIL  — the server rejected it, with the error
 *
 *     node --experimental-strip-types dev/probe_my_views.mjs
 *     MY_PORTS=3306,3309 node --experimental-strip-types dev/probe_my_views.mjs
 *
 * Read-only by construction: every statement runs in a read-only transaction
 * under a statement timeout, so a mistake in a view cannot write or hang.
 */
import { execFileSync } from 'node:child_process';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';
import { detectFlavor } from '../src/utils/serverFlavor.ts';

const PORTS = (process.env.MY_PORTS ?? '3306,3307,3309,3310,3311,3312').split(',').map(s => s.trim());
const USER = process.env.MY_USER ?? 'root';
const PASS = process.env.MY_PASS ?? 'root';

function run(port, sql) {
  // MAX_EXECUTION_TIME is a MySQL hint MariaDB ignores, so the read-only
  // transaction is the guard that works on both.
  const wrapped = `SET SESSION TRANSACTION READ ONLY;\nSTART TRANSACTION;\n${sql}\nROLLBACK;`;
  return execFileSync('mysql', [
    '-h', '127.0.0.1', '-P', String(port), '-u', USER, `-p${PASS}`,
    '--connect-timeout=5', '-N', '-B',
  ], { input: wrapped, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
}

function version(port) {
  try {
    return run(port, 'SELECT CONCAT(VERSION());').trim().split('\n').pop();
  } catch { return null; }
}

const allViews = DBA_VIEWS.mysql ?? [];
console.log(`${allViews.length} MySQL DBA views\n`);

const summary = [];
for (const port of PORTS) {
  const v = version(port);
  if (!v) { console.log(`── port ${port}: unreachable, skipped\n`); continue; }
  const flavor = detectFlavor(v).flavor;
  const isMaria = flavor === 'mariadb';
  // Only the views that claim to apply to this flavour — the same filter the
  // panel uses, so the probe measures what a user would actually be offered.
  const views = allViews.filter(x => !x.flavors || x.flavors.includes(flavor));
  console.log(`── port ${port} — ${v}  [${flavor}]  ${views.length} applicable views`);

  let ok = 0, empty = 0;
  const failures = [];
  for (const view of views) {
    try {
      const out = run(port, view.sql.trim().replace(/;\s*$/, '') + ';');
      const rows = out.split('\n').filter(l => l.length).length;
      if (rows) ok++; else empty++;
    } catch (e) {
      const msg = String(e.stderr || e.message).split('\n')
        .find(l => /ERROR/.test(l)) ?? String(e.message).split('\n')[0];
      failures.push({ id: view.id, label: view.label, msg: msg.trim().slice(0, 130) });
    }
  }
  console.log(`   ok ${ok}  ·  empty ${empty}  ·  FAIL ${failures.length}`);
  for (const f of failures) console.log(`     ✗ ${f.id.padEnd(22)} ${f.msg}`);
  console.log();
  summary.push({ port, v, isMaria, ok, empty, fail: failures.length, failures });
}

console.log('── summary');
for (const s of summary) {
  console.log(`   ${String(s.port).padEnd(6)} ${s.v.padEnd(26)} ok ${String(s.ok).padStart(3)}  empty ${String(s.empty).padStart(3)}  FAIL ${String(s.fail).padStart(3)}`);
}

// Only the MariaDB failures are news; a MySQL failure is a plain bug.
const mariaOnly = new Map();
for (const s of summary.filter(x => x.isMaria)) {
  for (const f of s.failures) {
    if (!summary.filter(x => !x.isMaria).some(m => m.failures.some(g => g.id === f.id))) {
      mariaOnly.set(f.id, f);
    }
  }
}
if (mariaOnly.size) {
  console.log(`\n── fails on MariaDB but not on MySQL (${mariaOnly.size})`);
  for (const f of mariaOnly.values()) console.log(`   ${f.id.padEnd(22)} ${f.msg}`);
}
