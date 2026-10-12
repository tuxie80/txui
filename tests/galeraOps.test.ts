/**
 * tests for src/utils/galeraOps.ts — op SQL strings, state reflection,
 * eligibility gating (read-only / SUPER / variant), the session toggles and
 * the bootstrap advisor. The ops were verified live against a 3-node
 * MariaDB 11.8 cluster (2026-10-02); these tests pin the shapes that
 * verification established (ERROR 1238 read-only provider options, ERROR
 * 1047 maintenance rejection, desync ON → Donor/Desynced).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  desyncSql, rejectQueriesSql, slaveThreadsSql, clampSlaveThreads,
  gcacheFreezeSql, evictSql, validEvictUuid, syncWaitSql, dirtyReadsSql,
  SESSION_TOGGLES_SQL, parseSessionToggles,
  PROVIDER_OPTIONS_READONLY_SQL, parseReadOnlyFlag,
  opsFor, opUnavailable, bootstrapAdvice, BOOTSTRAP_SQL,
  SLAVE_THREADS_MIN, SLAVE_THREADS_MAX,
  type OpGate,
} from '../src/utils/galeraOps.ts';
import { parseGaleraStatus } from '../src/utils/galeraStatus.ts';

type Row = [string, string];

/** Minimal variable set for a synced, healthy MariaDB Galera node. */
function healthyVars(over: Partial<Record<string, string>> = {}): Row[] {
  return [
    ['wsrep_on', 'ON'],
    ['wsrep_desync', 'OFF'],
    ['wsrep_reject_queries', 'NONE'],
    ['wsrep_slave_threads', '1'],
    ...Object.entries(over).map(([k, v]) => [k, v] as Row),
  ];
}

function snap(vars: Row[], status: Row[] = [['wsrep_cluster_status', 'Primary'], ['wsrep_on', 'ON']]) {
  return parseGaleraStatus(status, vars);
}

const ALLOWED: OpGate = { readOnly: false, superDenied: false, providerOptionsReadOnly: false };

describe('SQL builders', () => {
  test('desync toggles the GLOBAL variable', () => {
    assert.equal(desyncSql(true), 'SET GLOBAL wsrep_desync = ON');
    assert.equal(desyncSql(false), 'SET GLOBAL wsrep_desync = OFF');
  });

  test('maintenance mode only ever builds NONE or ALL — ALL_KILL is not offered', () => {
    assert.equal(rejectQueriesSql('ALL'), "SET GLOBAL wsrep_reject_queries = 'ALL'");
    assert.equal(rejectQueriesSql('NONE'), "SET GLOBAL wsrep_reject_queries = 'NONE'");
    // The union type is the whole contract: there is no way to ask for ALL_KILL.
  });

  test('slave threads clamp into the documented 1..512', () => {
    assert.equal(clampSlaveThreads(0), SLAVE_THREADS_MIN);
    assert.equal(clampSlaveThreads(-5), 1);
    assert.equal(clampSlaveThreads(4), 4);
    assert.equal(clampSlaveThreads(9999), SLAVE_THREADS_MAX);
    assert.equal(clampSlaveThreads(NaN), 1);
    assert.equal(clampSlaveThreads(3.7), 4);
    assert.equal(slaveThreadsSql(4), 'SET GLOBAL wsrep_slave_threads = 4');
    assert.equal(slaveThreadsSql(0), 'SET GLOBAL wsrep_slave_threads = 1');
  });

  test('gcache freeze is the PXC provider-option statement', () => {
    assert.equal(gcacheFreezeSql(),
      "SET GLOBAL wsrep_provider_options = 'gcache.freeze_purge_at_seqno=now'");
  });

  test('evict UUID validation is 8-4-4-4-12 hex, trimmed, case-insensitive', () => {
    assert.ok(validEvictUuid('b110b4c2-be33-11f1-bc82-9e6500f05053'));
    assert.ok(validEvictUuid('  B110B4C2-BE33-11F1-BC82-9E6500F05053 '));
    assert.ok(!validEvictUuid(''));
    assert.ok(!validEvictUuid('galera2'));
    assert.ok(!validEvictUuid('b110b4c2-be33-11f1-bc82'));
    assert.ok(!validEvictUuid("b110b4c2-be33-11f1-bc82-9e6500f05053'; DROP TABLE t; --"));
  });

  test('evict SQL embeds the normalized uuid', () => {
    assert.equal(evictSql('  B110B4C2-BE33-11F1-BC82-9E6500F05053 '),
      "SET GLOBAL wsrep_provider_options = 'evs.evict=b110b4c2-be33-11f1-bc82-9e6500f05053'");
  });

  test('session toggles are SESSION scope — never GLOBAL', () => {
    assert.equal(syncWaitSql(true), 'SET SESSION wsrep_sync_wait = 1');
    assert.equal(syncWaitSql(false), 'SET SESSION wsrep_sync_wait = 0');
    assert.equal(dirtyReadsSql(true), 'SET SESSION wsrep_dirty_reads = ON');
    assert.equal(dirtyReadsSql(false), 'SET SESSION wsrep_dirty_reads = OFF');
    for (const sql of [syncWaitSql(true), dirtyReadsSql(true)]) {
      assert.ok(!sql.includes('GLOBAL'), sql);
    }
  });
});

describe('state reflection', () => {
  test('the ops flip with the polled desync / reject_queries state', () => {
    const synced = opsFor(snap(healthyVars()), { slaveThreads: 4, evictUuid: '' });
    assert.equal(synced[0].id, 'desync-on');
    assert.equal(synced[1].id, 'reject-all');

    const busy = opsFor(
      snap(healthyVars({ wsrep_desync: 'ON', wsrep_reject_queries: 'ALL' })),
      { slaveThreads: 4, evictUuid: '' });
    assert.equal(busy[0].id, 'desync-off');
    assert.equal(busy[1].id, 'reject-none');
  });

  test('slave threads current value parses out of the variables row set', () => {
    const s = snap(healthyVars({ wsrep_slave_threads: '8' }));
    assert.equal(s.slaveThreads, 8);
    const missing = snap(healthyVars({ wsrep_slave_threads: '' }));
    assert.equal(missing.slaveThreads, null);
  });

  test('reject_queries current value parses out of the variables row set', () => {
    assert.equal(snap(healthyVars()).rejectQueries, 'NONE');
    assert.equal(snap(healthyVars({ wsrep_reject_queries: 'ALL' })).rejectQueries, 'ALL');
    assert.equal(snap(healthyVars({ wsrep_reject_queries: '' })).rejectQueries, null);
  });

  test('evict is offered only with a valid uuid typed', () => {
    const base = snap(healthyVars());
    const noUuid = opsFor(base, { slaveThreads: 4, evictUuid: '' });
    assert.ok(!noUuid.some(o => o.id === 'evict'));
    const badUuid = opsFor(base, { slaveThreads: 4, evictUuid: 'not-a-uuid' });
    assert.ok(!badUuid.some(o => o.id === 'evict'));
    const good = opsFor(base, { slaveThreads: 4, evictUuid: 'b110b4c2-be33-11f1-bc82-9e6500f05053' });
    const evict = good.find(o => o.id === 'evict')!;
    assert.equal(evict.confirmWord, 'EVICT');
    assert.match(evict.risk, /cannot rejoin without a mysqld restart/i);
  });

  test('provider-option ops are marked for the variant gate', () => {
    const ops = opsFor(snap(healthyVars()), {
      slaveThreads: 4, evictUuid: 'b110b4c2-be33-11f1-bc82-9e6500f05053',
    });
    assert.equal(ops.find(o => o.id === 'gcache-freeze')!.providerOption, true);
    assert.equal(ops.find(o => o.id === 'evict')!.providerOption, true);
    assert.equal(ops.find(o => o.id === 'desync-on')!.providerOption, undefined);
  });

  test('session toggles row parses both spellings', () => {
    assert.deepEqual(parseSessionToggles(['1', 'ON']), { syncWait: 1, dirtyReads: true });
    assert.deepEqual(parseSessionToggles([0, 'OFF']), { syncWait: 0, dirtyReads: false });
    assert.deepEqual(parseSessionToggles([null, null]), { syncWait: null, dirtyReads: null });
    assert.deepEqual(parseSessionToggles(undefined), { syncWait: null, dirtyReads: null });
    assert.deepEqual(parseSessionToggles(['9', '1']), { syncWait: 9, dirtyReads: true });
  });
});

describe('eligibility gating', () => {
  const desync = opsFor(snap(healthyVars()), { slaveThreads: 4, evictUuid: '' })[0];

  test('read-only names the session flag first', () => {
    const why = opUnavailable(desync, { ...ALLOWED, readOnly: true });
    assert.match(why!, /read-only/);
  });

  test('denied SUPER names the grant to ask for', () => {
    const why = opUnavailable(desync,
      { ...ALLOWED, superDenied: true, superNeeds: 'SUPER (or SYSTEM_VARIABLES_ADMIN on MySQL 8)' });
    assert.match(why!, /SUPER/);
    assert.match(why!, /ask for the grant/);
  });

  test('unknown privilege never greys (unknown-means-allowed)', () => {
    assert.equal(opUnavailable(desync, ALLOWED), null);
  });

  test('provider-option ops grey when the probe says READ_ONLY=YES (MariaDB 11.8, verified live)', () => {
    const freeze = opsFor(snap(healthyVars()), { slaveThreads: 4, evictUuid: '' })
      .find(o => o.id === 'gcache-freeze')!;
    const why = opUnavailable(freeze, { ...ALLOWED, providerOptionsReadOnly: true });
    assert.match(why!, /read-only over SQL/);
    assert.match(why!, /MariaDB/);
  });

  test('an unknown probe result keeps provider-option ops offered', () => {
    const freeze = opsFor(snap(healthyVars()), { slaveThreads: 4, evictUuid: '' })
      .find(o => o.id === 'gcache-freeze')!;
    assert.equal(opUnavailable(freeze, { ...ALLOWED, providerOptionsReadOnly: null }), null);
    assert.equal(opUnavailable(freeze, { ...ALLOWED, providerOptionsReadOnly: false }), null);
  });

  test('read-only beats the variant reason when both apply', () => {
    const freeze = opsFor(snap(healthyVars()), { slaveThreads: 4, evictUuid: '' })
      .find(o => o.id === 'gcache-freeze')!;
    const why = opUnavailable(freeze,
      { readOnly: true, superDenied: true, providerOptionsReadOnly: true });
    assert.match(why!, /read-only/);
  });
});

describe('READ_ONLY probe', () => {
  test('the probe asks information_schema.SYSTEM_VARIABLES (MariaDB)', () => {
    assert.match(PROVIDER_OPTIONS_READONLY_SQL, /information_schema\.SYSTEM_VARIABLES/);
    assert.match(PROVIDER_OPTIONS_READONLY_SQL, /WSREP_PROVIDER_OPTIONS/);
  });

  test('flag parsing: YES/NO in any case; empty or garbage is unknown', () => {
    assert.equal(parseReadOnlyFlag('YES'), true);
    assert.equal(parseReadOnlyFlag('no'), false);
    assert.equal(parseReadOnlyFlag(' NO '), false);
    assert.equal(parseReadOnlyFlag(''), null);
    assert.equal(parseReadOnlyFlag(null), null);
    assert.equal(parseReadOnlyFlag('sometimes'), null);
  });

  test('the probe SQL is read-family (SELECT), so it needs no grant and no write path', () => {
    assert.match(PROVIDER_OPTIONS_READONLY_SQL, /^SELECT /);
  });
});

describe('bootstrap advisor', () => {
  test('renders only when the node is positively non-Primary', () => {
    const primary = snap(healthyVars());
    assert.equal(bootstrapAdvice(primary, null), null);

    const unknown = snap(healthyVars(), [['wsrep_on', 'ON']]); // no cluster_status key
    assert.equal(bootstrapAdvice(unknown, null), null);

    const partitioned = snap(healthyVars(), [['wsrep_on', 'ON'], ['wsrep_cluster_status', 'Non-Primary']]);
    const advice = bootstrapAdvice(partitioned, null)!;
    assert.ok(advice);
    assert.match(advice.headline, /non-Primary/);
    assert.match(advice.detail, /split-brain/);
    assert.match(advice.detail, /wsrep_last_committed/);
    assert.match(advice.detail, /highest wins/);
    assert.equal(advice.sql, BOOTSTRAP_SQL);
    assert.match(advice.sql, /pc\.bootstrap=1/);
    assert.match(advice.wrongNodeWarning, /LOST/);
    assert.match(advice.recoverNote, /--wsrep-recover/);
    // No MariaDB addendum when the probe is unknown.
    assert.equal(advice.mariadbNote, null);
  });

  test('a read-only provider-options probe adds the MariaDB recovery path', () => {
    const partitioned = snap(healthyVars(), [['wsrep_on', 'ON'], ['wsrep_cluster_status', 'Non-Primary']]);
    const advice = bootstrapAdvice(partitioned, true)!;
    assert.match(advice.mariadbNote!, /galera_new_cluster/);
    assert.match(advice.mariadbNote!, /ERROR 1238/);
  });

  test('Disconnected also renders the advisor', () => {
    const s = snap(healthyVars(), [['wsrep_on', 'ON'], ['wsrep_cluster_status', 'Disconnected']]);
    assert.ok(bootstrapAdvice(s, null));
  });
});

describe('probe SQL strings', () => {
  test('session toggles probe reads @@session', () => {
    assert.match(SESSION_TOGGLES_SQL, /@@session\.wsrep_sync_wait/);
    assert.match(SESSION_TOGGLES_SQL, /@@session\.wsrep_dirty_reads/);
  });
});
