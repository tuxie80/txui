/**
 * Fleet checks (src/utils/fleetChecks.ts).
 *
 * Diffing three servers is easy. Knowing which differences are findings and
 * which are how it is supposed to be is the entire feature — a check that
 * reports `server_id` as drift on every replica set in the estate is a check
 * people learn to close without reading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedToDiffer, variableDrift, indexDivergence, indexKey, statsFreshness,
  worstSeverity, STALE_DAYS, VERY_STALE_DAYS,
} from '../src/utils/fleetChecks.ts';
import type { FleetMember, IndexRef, StatRow } from '../src/utils/fleetChecks.ts';

const M: FleetMember[] = [
  { id: 'm', name: 'primary', role: 'primary' },
  { id: 'r1', name: 'replica-1', role: 'replica' },
  { id: 'r2', name: 'replica-2', role: 'replica' },
];

const vmap = (o: Record<string, Record<string, string>>) =>
  new Map(Object.entries(o).map(([k, v]) => [k, new Map(Object.entries(v))]));

// ── variables ───────────────────────────────────────────────────────────────

test('identity and role variables are expected to differ', () => {
  // A replica set where server_id matched would be broken, not healthy.
  for (const n of ['server_id', 'server_uuid', 'hostname', 'read_only',
                   'super_read_only', 'report_host', 'datadir', 'socket']) {
    assert.ok(expectedToDiffer(n), `${n} should be excluded`);
  }
});

test('a whole family is excluded by prefix', () => {
  assert.ok(expectedToDiffer('ssl_ca'));
  assert.ok(expectedToDiffer('SSL_CERT'));
  assert.ok(expectedToDiffer('performance_schema_max_mutex_classes'));
});

test('real tuning variables are NOT excluded', () => {
  // These differing between a primary and its replicas is the finding.
  for (const n of ['innodb_buffer_pool_size', 'max_connections', 'sql_mode',
                   'innodb_flush_log_at_trx_commit', 'character_set_server']) {
    assert.ok(!expectedToDiffer(n), `${n} must be checked`);
  }
});

test('agreement produces no findings', () => {
  const d = variableDrift(M, vmap({
    m: { max_connections: '500' }, r1: { max_connections: '500' }, r2: { max_connections: '500' },
  }));
  assert.deepEqual(d, []);
});

test('one server out of step is an error, and names the outlier', () => {
  const d = variableDrift(M, vmap({
    m: { max_connections: '500' }, r1: { max_connections: '500' }, r2: { max_connections: '100' },
  }));
  assert.equal(d.length, 1);
  assert.equal(d[0].name, 'max_connections');
  assert.equal(d[0].majority, '500');
  assert.deepEqual(d[0].outliers, ['r2']);
  assert.equal(d[0].severity, 'error');
});

test('an even split is a warning, not an error', () => {
  // Nobody is obviously wrong; it is a decision someone made and forgot.
  const two: FleetMember[] = [M[0], M[1]];
  const d = variableDrift(two, vmap({ m: { sql_mode: 'A' }, r1: { sql_mode: 'B' } }));
  assert.equal(d[0].severity, 'warn');
});

test('a variable ABSENT on one server is a finding', () => {
  // On a mixed-version fleet this is usually the interesting one; treating
  // "not set" as "agrees" hides exactly that case.
  const d = variableDrift(M, vmap({
    m: { innodb_dedicated_server: 'ON' }, r1: { innodb_dedicated_server: 'ON' }, r2: {},
  }));
  assert.equal(d.length, 1);
  assert.equal(d[0].values.get('r2'), undefined);
  assert.deepEqual(d[0].outliers, ['r2']);
});

test('excluded variables can be opted back in', () => {
  const plain = variableDrift(M, vmap({ m: { server_id: '1' }, r1: { server_id: '2' }, r2: { server_id: '3' } }));
  assert.deepEqual(plain, []);
  const all = variableDrift(
    M, vmap({ m: { server_id: '1' }, r1: { server_id: '2' }, r2: { server_id: '3' } }),
    { includeExpected: true });
  assert.equal(all.length, 1);
});

test('findings are sorted by name', () => {
  const d = variableDrift(M, vmap({
    m: { zeta: '1', alpha: '1' }, r1: { zeta: '2', alpha: '2' }, r2: { zeta: '1', alpha: '1' },
  }));
  assert.deepEqual(d.map(x => x.name), ['alpha', 'zeta']);
});

// ── indexes ─────────────────────────────────────────────────────────────────

const ref = (s: string, t: string, i: string): IndexRef => ({ schema: s, table: t, index: i });
const idx = (o: Record<string, string[]>) =>
  new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

const REFS = new Map([
  ['db.orders.ix_a', ref('db', 'orders', 'ix_a')],
  ['db.orders.ix_b', ref('db', 'orders', 'ix_b')],
]);

test('an index on every server is not a finding', () => {
  const d = indexDivergence(M, idx({
    m: ['db.orders.ix_a'], r1: ['db.orders.ix_a'], r2: ['db.orders.ix_a'],
  }), REFS);
  assert.deepEqual(d, []);
});

test('replica-only is INFO — Cloud SQL creates secondary indexes only on replicas', () => {
  const d = indexDivergence(M, idx({
    m: [], r1: ['db.orders.ix_a'], r2: ['db.orders.ix_a'],
  }), REFS);
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'replica-only');
  assert.equal(d[0].severity, 'info');
  assert.match(d[0].note, /Cloud SQL/);
});

test('missing on a replica is an ERROR — failover would change the plans', () => {
  const d = indexDivergence(M, idx({
    m: ['db.orders.ix_a'], r1: ['db.orders.ix_a'], r2: [],
  }), REFS);
  assert.equal(d[0].kind, 'missing-on-replica');
  assert.equal(d[0].severity, 'error');
  assert.deepEqual(d[0].absent, ['r2']);
  assert.match(d[0].note, /failover/i);
});

test('the dangerous direction sorts first', () => {
  // The two directions mean opposite things; listing them together
  // alphabetically buries the one that matters.
  const d = indexDivergence(M, idx({
    m: ['db.orders.ix_b'], r1: ['db.orders.ix_a', 'db.orders.ix_b'], r2: ['db.orders.ix_a'],
  }), REFS);
  assert.equal(d[0].kind, 'missing-on-replica');
  assert.equal(d[0].index.index, 'ix_b');
});

test('a difference among replicas with no primary pattern is partial', () => {
  const noPrimary: FleetMember[] = [
    { id: 'r1', name: 'a', role: 'replica' },
    { id: 'r2', name: 'b', role: 'replica' },
  ];
  const d = indexDivergence(noPrimary, idx({ r1: ['db.orders.ix_a'], r2: [] }), REFS);
  assert.equal(d[0].kind, 'partial');
  assert.equal(d[0].severity, 'warn');
});

test('a server that did not answer cannot make every index look missing', () => {
  // The failure mode: one unreachable replica reporting the whole schema as
  // divergent.
  const d = indexDivergence(M, idx({ m: ['db.orders.ix_a'], r1: ['db.orders.ix_a'] }), REFS);
  assert.deepEqual(d, []);
});

test('fewer than two answering servers compares nothing', () => {
  assert.deepEqual(indexDivergence(M, idx({ m: ['db.orders.ix_a'] }), REFS), []);
});

test('the index key is stable and readable', () => {
  assert.equal(indexKey(ref('db', 'orders', 'ix_a')), 'db.orders.ix_a');
});

// ── statistics ──────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const daysAgo = (d: number) => NOW - d * 86_400_000;
const srow = (schema: string, table: string, last: number | null): StatRow =>
  ({ schema, table, lastUpdate: last, rows: 100 });

test('fresh statistics produce no findings', () => {
  const f = statsFreshness(M, new Map([
    ['m', [srow('db', 'orders', daysAgo(1))]],
    ['r1', [srow('db', 'orders', daysAgo(2))]],
  ]), NOW);
  assert.deepEqual(f, []);
});

test('last_update DIFFERING between servers is not itself a finding', () => {
  // Statistics are gathered per server and will never line up. Age is the
  // finding; disagreement is normal.
  const f = statsFreshness(M, new Map([
    ['m', [srow('db', 'orders', daysAgo(0))]],
    ['r1', [srow('db', 'orders', daysAgo(3))]],
  ]), NOW);
  assert.deepEqual(f, []);
});

test('stale on any one server is reported, using the WORST age', () => {
  const f = statsFreshness(M, new Map([
    ['m', [srow('db', 'orders', daysAgo(1))]],
    ['r1', [srow('db', 'orders', daysAgo(STALE_DAYS + 2))]],
  ]), NOW);
  assert.equal(f.length, 1);
  assert.equal(Math.round(f[0].worstAgeDays!), STALE_DAYS + 2);
  assert.equal(f[0].severity, 'warn');
});

test('very stale escalates to error', () => {
  const f = statsFreshness(M, new Map([
    ['m', [srow('db', 'orders', daysAgo(VERY_STALE_DAYS + 1))]],
  ]), NOW);
  assert.equal(f[0].severity, 'error');
});

test('never measured on one server is an error, and says so', () => {
  const f = statsFreshness(M, new Map([
    ['m', [srow('db', 'orders', daysAgo(1))]],
    ['r1', [srow('db', 'orders', null)]],
  ]), NOW);
  assert.equal(f[0].severity, 'error');
  assert.match(f[0].note, /No statistics recorded/);
  assert.equal(f[0].ageDays.get('r1'), null);
});

test('a future timestamp is clamped rather than reported as negative age', () => {
  // Clock skew between servers is common and must not produce "-3 days ago".
  const f = statsFreshness(M, new Map([['m', [srow('db', 'orders', NOW + 86_400_000)]]]), NOW);
  assert.deepEqual(f, []);
});

test('errors sort above warnings, then oldest first', () => {
  const f = statsFreshness(M, new Map([
    ['m', [srow('db', 'warn_tbl', daysAgo(STALE_DAYS + 1)),
           srow('db', 'err_tbl', daysAgo(VERY_STALE_DAYS + 5)),
           srow('db', 'older_err', daysAgo(VERY_STALE_DAYS + 90))]],
  ]), NOW);
  assert.deepEqual(f.map(x => x.table), ['older_err', 'err_tbl', 'warn_tbl']);
});

// ── badges ──────────────────────────────────────────────────────────────────

test('the worst severity wins for a tab badge', () => {
  assert.equal(worstSeverity([]), null);
  assert.equal(worstSeverity([{ severity: 'info' }]), 'info');
  assert.equal(worstSeverity([{ severity: 'info' }, { severity: 'warn' }]), 'warn');
  assert.equal(worstSeverity([{ severity: 'warn' }, { severity: 'error' }]), 'error');
});
