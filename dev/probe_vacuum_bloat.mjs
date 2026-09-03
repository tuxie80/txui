#!/usr/bin/env node
/**
 * Live-verify every SQL string the 🧹 Vacuum & Bloat panel emits.
 *
 * The panel's reads are the curated dbaViews entries verbatim plus three of its
 * own (index-bloat estimate, pgstattuple state, exact-measure builders), and
 * none of that can be accepted by reading it: pg_statistic shapes, reloptions
 * parsing and the pgstattuple column list all move between majors. So this
 * builds a provoked-bloat fixture on each server and runs every statement:
 *
 *   - a `churn` table with autovacuum_enabled=false, insert/delete churned, so
 *     the backlog and bloat sections have something real to rank;
 *   - a `strict` table whose OWN reloptions threshold (50 + 0.05 × reltuples)
 *     is far below the default — the own-threshold rule, checked live;
 *   - a leftover PREPARE TRANSACTION, so the freeze-blockers list has a row
 *     (rolled back before exit);
 *   - pgstattuple created where available (PG 18 has it; 12/13 do not — both
 *     section-3 modes are exercised).
 *
 *     node --experimental-strip-types dev/probe_vacuum_bloat.mjs
 *     PG_PORTS=5432,55422,55423 node dev/probe_vacuum_bloat.mjs
 *
 * The reads run inside a read-only transaction with a statement timeout; the
 * fixture is dropped afterwards unless KEEP_FIXTURE=1.
 */
import { execFileSync } from 'node:child_process';
import {
  NOW_SQL, BLOCKERS_SQL, BACKLOG_SQL, HISTORY_SQL, TABLE_BLOAT_SQL,
  INDEX_BLOAT_SQL, WRAPAROUND_SQL, FREEZE_AGE_SQL, FREEZE_BLOCKERS_SQL,
  PGSTATTUPLE_STATE_SQL, relationSizeSql, pgStatTableSql, pgStatIndexSql,
  vbActionSql,
} from '../src/utils/vacuumBloat.ts';

const PORTS = (process.env.PG_PORTS ?? '5432,55422,55423').split(',').map(p => p.trim());
const HOST = process.env.PG_HOST ?? '127.0.0.1';
const USER = process.env.PG_USER ?? 'root';
const ADMIN_DB = process.env.PG_ADMIN_DB ?? 'postgres';
const DB = 'txui_vac';
const PASS = process.env.PGPASSWORD ?? 'root';
const KEEP = !!process.env.KEEP_FIXTURE;

function psql(port, db, sql, { wrap = true } = {}) {
  const body = wrap
    ? `SET statement_timeout = '20s';\nBEGIN READ ONLY;\n${sql.replace(/;\s*$/, '')};\nROLLBACK;`
    : sql;
  return execFileSync('psql', [
    '-h', HOST, '-p', port, '-U', USER, '-d', db,
    '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', body,
  ], { env: { ...process.env, PGPASSWORD: PASS }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** psql echoes SET/BEGIN/ROLLBACK in wrapped mode — keep the payload lines. */
function rows(out) {
  return out.split('\n').map(l => l.trimEnd())
    .filter(l => l !== '' && !/^(SET|BEGIN|ROLLBACK|CREATE|DROP|INSERT|UPDATE|DELETE|VACUUM|ANALYZE|PREPARE|COMMIT|ALTER)/.test(l));
}

const FIXTURE = `
CREATE TABLE churn (id int primary key, payload text, pad int);
ALTER TABLE churn SET (autovacuum_enabled = false);
CREATE INDEX churn_pad_idx ON churn (pad);
CREATE INDEX churn_payload_idx ON churn (payload);
-- 800 hex chars of md5 per row: uncompressible, so the payload index grows
-- past the 8 MB estimate floor and past the heap itself (the suspect shape).
INSERT INTO churn SELECT g, (SELECT string_agg(md5((g*100+k)::text), '') FROM generate_series(1,25) k), g
FROM generate_series(1, 20000) g;
DELETE FROM churn WHERE id % 2 = 0;
UPDATE churn SET pad = pad + 1 WHERE id % 3 = 0;
CREATE TABLE strict (id int primary key, v text);
ALTER TABLE strict SET (autovacuum_enabled = false,
                        autovacuum_vacuum_threshold = 50,
                        autovacuum_vacuum_scale_factor = 0.05);
INSERT INTO strict SELECT g, 'v' || g FROM generate_series(1, 2000) g;
DELETE FROM strict WHERE id > 1800;
ANALYZE churn; ANALYZE strict;
-- CLUSTER needs a previously chosen clustered index; set one so the emitted
-- plain CLUSTER statement can be executed for real on the disposable fixture.
ALTER TABLE churn CLUSTER ON churn_pad_idx;
`;

let failures = 0;

for (const port of PORTS) {
  console.log(`\n══ port ${port} ══`);
  let version = '?';
  try {
    // admin connection: build the fixture database
    psql(port, ADMIN_DB, `DROP DATABASE IF EXISTS ${DB}`, { wrap: false });
    psql(port, ADMIN_DB, `CREATE DATABASE ${DB}`, { wrap: false });
    version = psql(port, DB, "SELECT current_setting('server_version')", { wrap: false }).trim();
    console.log(`server ${version}`);
    psql(port, DB, FIXTURE, { wrap: false });
    // pgstattuple where it is available — PG 18 has the package, 12/13 do not.
    try {
      psql(port, DB, 'CREATE EXTENSION IF NOT EXISTS pgstattuple', { wrap: false });
      console.log('pgstattuple: installed into fixture');
    } catch {
      console.log('pgstattuple: NOT available (expected on 12/13)');
    }
    // A leftover prepared transaction: the freeze-blockers section gets a row.
    // Best-effort — most servers ship max_prepared_transactions = 0.
    try {
      psql(port, DB, `BEGIN; UPDATE churn SET pad = pad WHERE id = 1; PREPARE TRANSACTION 'txui_probe_hold';`, { wrap: false });
      console.log('freeze blocker: prepared transaction left holding');
    } catch {
      console.log('freeze blocker: prepared transactions disabled — blockers list may be empty');
    }
  } catch (e) {
    console.log(`FIXTURE FAIL: ${String(e.stderr ?? e).split('\n')[0]}`);
    failures++;
    continue;
  }

  const queries = [
    ['1 Now (progress vacuum)', NOW_SQL],
    ['1 Now (blockers)', BLOCKERS_SQL],
    ['2 Backlog (own threshold)', BACKLOG_SQL],
    ['2 Backlog (vacuum history)', HISTORY_SQL],
    ['3 Bloat (tables, estimate)', TABLE_BLOAT_SQL],
    ['3 Bloat (indexes, estimate)', INDEX_BLOAT_SQL],
    ['3 pgstattuple state', PGSTATTUPLE_STATE_SQL],
    ['4 Wraparound', WRAPAROUND_SQL],
    ['4 Freeze age', FREEZE_AGE_SQL],
    ['4 Freeze blockers', FREEZE_BLOCKERS_SQL],
    ['5 version+db probe', "SELECT current_setting('server_version_num')::int / 10000, current_database()"],
    ['3/5 relation size probe', relationSizeSql('public', 'churn')],
  ];

  for (const [label, sql] of queries) {
    try {
      const out = rows(psql(port, DB, sql));
      console.log(`ok   ${label} — ${out.length} row(s)`);
      for (const l of out.slice(0, 3)) console.log(`       ${l}`);
    } catch (e) {
      console.log(`FAIL ${label}: ${String(e.stderr ?? e).split('\n').filter(Boolean).pop()}`);
      failures++;
    }
  }

  // Exact measures — only meaningful where the extension exists.
  try {
    const out = rows(psql(port, DB, pgStatTableSql('public', 'churn')));
    console.log(`ok   3 pgstattuple(churn) exact — ${out[0]}`);
  } catch (e) {
    console.log(`skip 3 pgstattuple(churn): ${String(e.stderr ?? e).split('\n').filter(Boolean).pop()}`);
  }
  try {
    const out = rows(psql(port, DB, pgStatIndexSql('public', 'churn_payload_idx')));
    console.log(`ok   3 pgstatindex(churn_payload_idx) exact — ${out[0]}`);
  } catch (e) {
    console.log(`skip 3 pgstatindex(churn_payload_idx): ${String(e.stderr ?? e).split('\n').filter(Boolean).pop()}`);
  }

  // The section-5 statements parse and run for real on the fixture (the safe
  // ones) — the exclusive rewrites are validated as syntax only.
  for (const id of ['vacuum-verbose-analyze', 'analyze', 'reindex-index', 'reindex-table']) {
    const sql = id.startsWith('reindex-index')
      ? vbActionSql(id, { schema: 'public', name: 'churn' }, { index: 'churn_pad_idx' })
      : vbActionSql(id, { schema: 'public', name: 'churn' });
    try {
      psql(port, DB, sql, { wrap: false });
      console.log(`ok   5 ${id} — executed on fixture`);
    } catch (e) {
      console.log(`FAIL 5 ${id}: ${String(e.stderr ?? e).split('\n').filter(Boolean).pop()}`);
      failures++;
    }
  }
  // The exclusive rewrites run for real — the fixture is disposable, and these
  // are the statements where "parses" and "runs" must not be confused.
  for (const id of ['vacuum-full', 'cluster']) {
    const sql = vbActionSql(id, { schema: 'public', name: 'churn' });
    try {
      psql(port, DB, sql, { wrap: false });
      console.log(`ok   5 ${id} — executed on fixture (real rewrite)`);
    } catch (e) {
      console.log(`FAIL 5 ${id}: ${String(e.stderr ?? e).split('\n').filter(Boolean).pop()}`);
      failures++;
    }
  }

  // Cleanup: the prepared transaction first (it pins locks), then the db.
  try { psql(port, DB, `ROLLBACK PREPARED 'txui_probe_hold'`, { wrap: false }); } catch { /* already gone */ }
  if (!KEEP) {
    try { psql(port, ADMIN_DB, `DROP DATABASE IF EXISTS ${DB}`, { wrap: false }); } catch (e) {
      console.log(`cleanup FAIL: ${String(e.stderr ?? e).split('\n')[0]}`);
    }
  }
}

console.log(failures === 0 ? '\nall statements verified' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
