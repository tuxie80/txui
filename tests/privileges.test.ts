/**
 * Role capabilities (src/utils/privileges.ts).
 *
 * The invariant every test here defends: **a denial must be earned**. Greying
 * a feature the user actually has is worse than the error it replaces —
 * the error is recoverable, a wrong grey is believed. So anything the probe
 * cannot establish comes back `unknown`, and `unknown` behaves like granted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES, parseMysqlGrants, mysqlPrivileges, pgPrivileges, pgProbeFromRow,
  privilegeTip, denied, unknownPrivileges, PG_PROBE, MYSQL_PROBE,
  MSSQL_PROBE, mssqlPrivileges, mssqlProbeFromRow,
} from '../src/utils/privileges.ts';

// ── MySQL grant parsing ─────────────────────────────────────────────────────

const ROOT = ["GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION"];
const REPORTING = [
  "GRANT USAGE ON *.* TO `report`@`%`",
  "GRANT SELECT ON `shop`.* TO `report`@`%`",
];
const DBA = [
  "GRANT SELECT, PROCESS, REPLICATION CLIENT, SUPER ON *.* TO `dba`@`%`",
];

test('a global grant list is read as global privileges', () => {
  const g = parseMysqlGrants(DBA);
  assert.ok(g.global.has('PROCESS'));
  assert.ok(g.global.has('REPLICATION CLIENT'));
  assert.equal(g.opaqueRoles, false);
});

test('a schema grant is not mistaken for a global one', () => {
  const g = parseMysqlGrants(REPORTING);
  assert.ok(!g.global.has('SELECT'));
  assert.ok(g.selectSchemas.has('shop'));
});

test('backticks and WITH GRANT OPTION do not confuse it', () => {
  const g = parseMysqlGrants(ROOT);
  assert.ok(g.global.has('ALL PRIVILEGES'));
});

// ── MySQL capabilities ──────────────────────────────────────────────────────

test('root can do everything', () => {
  const p = mysqlPrivileges(ROOT);
  for (const c of CAPABILITIES) assert.equal(p[c].state, 'granted', c);
});

test('a reporting account is denied the DBA surfaces, each naming its grant', () => {
  const p = mysqlPrivileges(REPORTING);
  assert.equal(p['processlist-all'].state, 'denied');
  assert.match(p['processlist-all'].needs!, /PROCESS/);
  assert.equal(p['kill-others'].state, 'denied');
  assert.match(p['kill-others'].needs!, /SUPER|CONNECTION_ADMIN/);
  assert.equal(p['replication'].state, 'denied');
  assert.equal(p['stats-views'].state, 'denied');
  assert.equal(p['user-admin'].state, 'denied');
});

test('a DBA account with PROCESS + REPLICATION CLIENT gets the operational panels', () => {
  const p = mysqlPrivileges(DBA);
  assert.equal(p['processlist-all'].state, 'granted');
  assert.equal(p['kill-others'].state, 'granted');       // SUPER
  assert.equal(p['replication'].state, 'granted');
  assert.equal(p['stats-views'].state, 'granted');       // global SELECT
});

test('an explicit performance_schema grant is enough for the stats views', () => {
  const p = mysqlPrivileges([
    "GRANT USAGE ON *.* TO `obs`@`%`",
    "GRANT SELECT ON `performance_schema`.* TO `obs`@`%`",
  ]);
  assert.equal(p['stats-views'].state, 'granted');
  assert.equal(p['statement-stats'].state, 'granted');
});

test('privileges arriving through a role leave everything unknown, not denied', () => {
  // MySQL 8 prints role membership as its own line and does not expand what
  // is behind it. Reading that as "no privileges" would grey out every DBA
  // panel for exactly the accounts a well-run shop uses.
  const p = mysqlPrivileges([
    "GRANT USAGE ON *.* TO `app`@`%`",
    "GRANT `dba_role`@`%` TO `app`@`%`",
  ]);
  for (const c of CAPABILITIES) assert.equal(p[c].state, 'unknown', c);
});

test('an unparseable line is ignored rather than treated as evidence', () => {
  const p = mysqlPrivileges([
    "GRANT PROCESS ON *.* TO `x`@`%`",
    'something the server said that we do not model',
  ]);
  assert.equal(p['processlist-all'].state, 'granted');
});

// ── PostgreSQL ──────────────────────────────────────────────────────────────

test('the PG probe survives a server without the predefined roles', () => {
  // pg_has_role() raises on a role that does not exist, which would fail the
  // whole probe and lose the answers we could have had.
  assert.match(PG_PROBE, /to_regrole\('pg_monitor'\)/);
  assert.match(PG_PROBE, /to_regrole\('pg_signal_backend'\)/);
  assert.equal(MYSQL_PROBE, 'SHOW GRANTS');
});

test('the probe row is read by column name, in any order and any boolean spelling', () => {
  const cols = ['has_pgss', 'is_super', 'signal_backend', 'read_all_stats', 'is_monitor'];
  const probe = pgProbeFromRow(cols, ['t', false, 'true', 1, 'f']);
  assert.deepEqual(probe, {
    is_super: false, is_monitor: false, read_all_stats: true,
    signal_backend: true, has_pgss: true,
  });
});

test('a superuser gets everything', () => {
  const p = pgPrivileges({ is_super: true, is_monitor: false, read_all_stats: false, signal_backend: false, has_pgss: true });
  for (const c of CAPABILITIES) assert.equal(p[c].state, 'granted', c);
});

test('pg_monitor answers for pg_read_all_stats', () => {
  const p = pgPrivileges({ is_super: false, is_monitor: true, read_all_stats: false, signal_backend: false, has_pgss: true });
  assert.equal(p['processlist-all'].state, 'granted');
  assert.equal(p['stats-views'].state, 'granted');
  // Reading is not signalling: a monitor role still cannot kill.
  assert.equal(p['kill-others'].state, 'denied');
  assert.match(p['kill-others'].needs!, /pg_signal_backend/);
});

test('a plain login role is told which role to ask for', () => {
  const p = pgPrivileges({ is_super: false, is_monitor: false, read_all_stats: false, signal_backend: false, has_pgss: false });
  assert.equal(p['processlist-all'].state, 'denied');
  assert.match(p['processlist-all'].needs!, /pg_monitor|pg_read_all_stats/);
  // The commoner wall for statement stats is the missing extension, and it is
  // the one named.
  assert.match(p['statement-stats'].needs!, /pg_stat_statements extension/);
});

test('reading roles needs nothing on PostgreSQL', () => {
  const p = pgPrivileges({ is_super: false, is_monitor: false, read_all_stats: false, signal_backend: false, has_pgss: false });
  assert.equal(p['user-admin'].state, 'granted');
});

// ── what the UI sees ────────────────────────────────────────────────────────

test('unknown is silent and behaves as allowed', () => {
  const p = unknownPrivileges();
  assert.equal(privilegeTip(p, 'processlist-all', 'Processes'), null);
  assert.equal(denied(p, 'processlist-all'), false);
});

test('a denial names the surface, the fact, and the grant that fixes it', () => {
  const p = mysqlPrivileges(REPORTING);
  const tip = privilegeTip(p, 'processlist-all', 'Processes')!;
  assert.match(tip, /^Processes/);
  assert.match(tip, /your account cannot use this/);
  assert.match(tip, /PROCESS/);
  assert.match(tip, /ask for the grant/);
  assert.ok(denied(p, 'processlist-all'));
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// The probe row below is the real answer from SQL Server 2022 for `sa` and for
// a freshly created login with nothing but SELECT on one schema.

const MS_COLS = [
  'view_server_state', 'alter_any_connection', 'view_any_definition',
  'alter_any_login', 'view_database_state', 'sysadmin', 'processadmin',
  'securityadmin',
];
const SA_ROW = [1, 1, 1, 1, 1, 1, 1, 1];
const LOW_ROW = [0, 0, 0, 0, 0, 0, 0, 0];

test('sa can do everything, and every capability says so', () => {
  const p = mssqlPrivileges(mssqlProbeFromRow(MS_COLS, SA_ROW));
  for (const cap of CAPABILITIES) {
    assert.equal(p[cap].state, 'granted', cap);
  }
});

test('a login with nothing is denied everything, with a grant to ask for', () => {
  const p = mssqlPrivileges(mssqlProbeFromRow(MS_COLS, LOW_ROW));
  for (const cap of CAPABILITIES) {
    assert.equal(p[cap].state, 'denied', cap);
    assert.ok((p[cap].needs ?? '').length > 0, `${cap} says no without saying what to ask for`);
  }
});

test('VIEW SERVER STATE is the one permission behind the DBA views', () => {
  // sys.dm_* returns YOUR session's rows without it rather than raising — a
  // silent, believable, wrong answer, which is why it gates four capabilities.
  const p = mssqlPrivileges(mssqlProbeFromRow(MS_COLS, [1, 0, 0, 0, 1, 0, 0, 0]));
  assert.equal(p['processlist-all'].state, 'granted');
  assert.equal(p['stats-views'].state, 'granted');
  assert.equal(p['statement-stats'].state, 'granted');
  // Seeing is not killing.
  assert.equal(p['kill-others'].state, 'denied');
  assert.match(p['kill-others'].needs!, /ALTER ANY CONNECTION/);
});

test('sysadmin bypasses every check, so one flag answers everything', () => {
  const p = mssqlPrivileges(mssqlProbeFromRow(MS_COLS, [0, 0, 0, 0, 0, 1, 0, 0]));
  for (const cap of CAPABILITIES) assert.equal(p[cap].state, 'granted', cap);
});

test('processadmin can kill without being able to read anything else', () => {
  const p = mssqlPrivileges(mssqlProbeFromRow(MS_COLS, [0, 0, 0, 0, 0, 0, 1, 0]));
  assert.equal(p['kill-others'].state, 'granted');
  assert.equal(p['processlist-all'].state, 'denied');
});

test('Query Store needs the DATABASE permission, not just the server one', () => {
  const p = mssqlPrivileges(mssqlProbeFromRow(MS_COLS, [1, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(p['statement-stats'].state, 'denied');
  // And it asks for the one that is actually missing.
  assert.match(p['statement-stats'].needs!, /VIEW DATABASE STATE/);
});

test('reading users needs VIEW ANY DEFINITION, or securityadmin', () => {
  const viaPerm = mssqlPrivileges(mssqlProbeFromRow(MS_COLS, [0, 0, 1, 0, 0, 0, 0, 0]));
  assert.equal(viaPerm['user-admin'].state, 'granted');
  const viaRole = mssqlPrivileges(mssqlProbeFromRow(MS_COLS, [0, 0, 0, 0, 0, 0, 0, 1]));
  assert.equal(viaRole['user-admin'].state, 'granted');
});

test('the row is read by column NAME — order is not the contract', () => {
  const shuffled = [...MS_COLS].reverse();
  const row = [...SA_ROW].map((_, i) => (shuffled[i] === 'view_server_state' ? 1 : 0));
  const p = mssqlPrivileges(mssqlProbeFromRow(shuffled, row));
  assert.equal(p['processlist-all'].state, 'granted');
  assert.equal(p['kill-others'].state, 'denied');
});

test('a NULL answer is unknown, not denied — it means the question did not apply', () => {
  // HAS_PERMS_BY_NAME returns NULL for a permission name an older version does
  // not recognise. Reading that as "no" greys a panel that works.
  const probe = mssqlProbeFromRow(MS_COLS, [null, null, null, null, null, null, null, null]);
  assert.equal(probe.viewServerState, false);
  // A missing COLUMN is likewise not evidence of denial.
  const partial = mssqlProbeFromRow(['sysadmin'], [1]);
  assert.equal(partial.sysadmin, true);
  assert.equal(partial.viewServerState, false);
});

test('the probe asks the server, rather than reassembling its rules', () => {
  // DENY overrides every GRANT and has no analogue in MySQL or PostgreSQL;
  // HAS_PERMS_BY_NAME has already applied it.
  assert.match(MSSQL_PROBE, /HAS_PERMS_BY_NAME/);
  assert.match(MSSQL_PROBE, /IS_SRVROLEMEMBER\('sysadmin'\)/);
  assert.ok(!/sys\.server_permissions/.test(MSSQL_PROBE));
  // Every column the reader looks for is actually selected.
  for (const c of MS_COLS) assert.ok(MSSQL_PROBE.includes(c), c);
});
