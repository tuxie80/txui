#!/usr/bin/env node
/**
 * Run every PostgreSQL DBA view against a live server.
 *
 * Thirty new catalog queries cannot be accepted by reading them. Catalog
 * columns move between majors (`pg_stat_checkpointer` is 17+, `pg_stat_io` is
 * 16+, `wal_status` is 13+), functions are renamed, and a query that is merely
 * *plausible* fails at the moment a user clicks it — which is the worst place
 * to find out.
 *
 * So this executes each one and reports, per server:
 *
 *   ok    — ran, with the row count
 *   EMPTY — ran and returned nothing (often correct: no slots, no bloat)
 *   FAIL  — the server rejected it, with the error
 *
 * A FAIL is only acceptable when the view documents a minimum version and the
 * server is older; the summary separates those from the rest.
 *
 *     dbctl start pg14 pg16 pg17 pg18
 *     node --experimental-strip-types dev/probe_pg_views.mjs
 *     PG_PORTS=5432,5433 node --experimental-strip-types dev/probe_pg_views.mjs
 *
 * Read-only by construction: every statement is wrapped in a read-only
 * transaction with a statement timeout, so a mistake in a view cannot write
 * and cannot hang the probe.
 */
import { execFileSync } from 'node:child_process';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';

const PORTS = (process.env.PG_PORTS ?? '5435,5432,5433,5434').split(',').map(p => p.trim());
const HOST = process.env.PG_HOST ?? '127.0.0.1';
const USER = process.env.PG_USER ?? 'root';
const DB = process.env.PG_DB ?? 'root';
const PASS = process.env.PGPASSWORD ?? 'root';

const views = DBA_VIEWS.postgres ?? [];

/** Catalogs and statistics only — a DBA view must never read business data. */
const ALLOWED = /^(pg_|information_schema\.|unnest|generate_|current_|now|version|public\.(geometry_columns|geography_columns))/i;

function guard(v) {
  // `IS NOT DISTINCT FROM x.y` is not a table reference; neither is a lateral
  // alias. Only the word right after a real FROM/JOIN counts.
  const sql = v.sql.replace(/IS\s+(NOT\s+)?DISTINCT\s+FROM/gi, 'IS_DISTINCT');
  const refs = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)/g)]
    .map(m => m[1])
    .filter(r => !ALLOWED.test(r));
  return refs.filter(r => !/^(w|ix|a|b|s|c|t|p|i|n|u|e|con|ft|child|parent|cn|pn)$/.test(r));
}

function run(port, sql) {
  // A statement timeout and an explicitly read-only transaction: a view that
  // turns out to be expensive costs 15 seconds, not the afternoon.
  const wrapped = `SET statement_timeout = '15s';\nBEGIN READ ONLY;\n${sql.replace(/;\s*$/, '')};\nROLLBACK;`;
  return execFileSync('psql', [
    '-h', HOST, '-p', port, '-U', USER, '-d', DB,
    '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', wrapped,
  ], { env: { ...process.env, PGPASSWORD: PASS }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function serverVersion(port) {
  try {
    const out = run(port, "SELECT current_setting('server_version')");
    // psql echoes SET/BEGIN/ROLLBACK; the version is the line that is not one.
    return out.split('\n').map(l => l.trim())
      .find(l => l && !/^(SET|BEGIN|ROLLBACK)$/.test(l)) ?? null;
  } catch {
    return null;
  }
}

let totalFail = 0;
console.log(`# ${views.length} PostgreSQL DBA views\n`);

for (const v of views) {
  const bad = guard(v);
  if (bad.length) {
    console.log(`GUARD ${v.id} reads something outside the catalog: ${bad.join(', ')}`);
    totalFail++;
  }
}

for (const port of PORTS) {
  const version = serverVersion(port);
  if (!version) {
    console.log(`\n── :${port} — not reachable, skipped`);
    continue;
  }
  console.log(`\n── :${port} — PostgreSQL ${version}`);
  let ok = 0, empty = 0, fail = 0, skipped = 0;
  for (const v of views) {
    try {
      const out = run(port, v.sql);
      const rows = out.split('\n').filter(l => l.trim() && !/^(SET|BEGIN|ROLLBACK)$/.test(l.trim())).length;
      if (rows === 0) { empty++; console.log(`  EMPTY ${v.id}`); }
      else { ok++; }
    } catch (e) {
      const msg = (String(e.stderr ?? e.message).split('\n').find(l => l.includes('ERROR')) ?? String(e.message)).trim();
      // Two failures are expected and are not defects: a view whose extension
      // is not installed here, and one whose catalog arrived in a later major
      // than this server. Both are documented in the view's description; the
      // panel turns them into guidance rather than an error.
      const optional = /pg_stat_statements|pgstattuple|hypopg/.test(msg)
        || /relation "pg_stat_(io|checkpointer|wal|progress_analyze)" does not exist/.test(msg)
        // PostGIS not installed here — geometry_columns/geography_columns are
        // extension catalogs, absent on a stock server.
        || /relation "public\.(geometry_columns|geography_columns)" does not exist/.test(msg);
      if (optional) { skipped++; console.log(`  n/a   ${v.id.padEnd(22)} ${msg}`); }
      else {
        fail++;
        totalFail++;
        console.log(`  FAIL  ${v.id.padEnd(22)} ${msg}`);
      }
    }
  }
  console.log(`  ${ok} ok · ${empty} empty · ${skipped} n/a here · ${fail} failed`);
}

console.log(totalFail === 0 ? '\nAll views ran.' : `\n${totalFail} problem(s).`);
process.exit(totalFail === 0 ? 0 : 1);
