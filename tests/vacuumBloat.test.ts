/**
 * PostgreSQL Vacuum & Bloat panel logic (src/utils/vacuumBloat.ts).
 *
 * Three things must not go wrong here. The section SQL has to BE the curated
 * dbaViews SQL — a fork would drift, so `dbaViewSql` must resolve every id the
 * panel uses. The backlog ranking has to rank against each table's OWN
 * threshold, not a global one — a table with a per-table reloptions override
 * is due when IT says so. And the actions must carry their lock level and cost
 * before anything runs: VACUUM FULL and CLUSTER are total-downtime rewrites
 * and read nothing like VACUUM (VERBOSE, ANALYZE).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  vacuumBloatSupported, dbaViewSql,
  NOW_SQL, BLOCKERS_SQL, BACKLOG_SQL, HISTORY_SQL, TABLE_BLOAT_SQL,
  INDEX_BLOAT_SQL, WRAPAROUND_SQL, FREEZE_AGE_SQL, FREEZE_BLOCKERS_SQL,
  PGSTATTUPLE_STATE_SQL, PGSTATTUPLE_INSTALL_SQL,
  relationSizeSql, pgStatTableSql, pgStatIndexSql, EXACT_SCAN_MAX_BYTES,
  parseProgressRow, parseBacklogRow, rankBacklog, backlogReason,
  parseTableBloatRow, parseIndexBloatRow,
  parseWraparoundRow, wraparoundSummary, parseFreezeAgeRow, parseFreezeBlockerRow,
  parseHistoryRow,
  VB_ACTIONS, findVbAction, vbActionSql, actionCost,
} from '../src/utils/vacuumBloat.ts';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';

// ── gating and the dbaViews reuse ────────────────────────────────────────────

test('the panel is gated to PostgreSQL', () => {
  assert.equal(vacuumBloatSupported('postgres'), true);
  for (const e of ['mysql', 'sqlite', 'clickhouse', 'redis', 'parquet']) {
    assert.equal(vacuumBloatSupported(e), false, e);
  }
});

test('every section query IS the curated dbaViews entry, verbatim', () => {
  const byId = new Map(DBA_VIEWS.postgres.map(v => [v.id, v.sql]));
  assert.equal(NOW_SQL, byId.get('pg-progress-vacuum'));
  assert.equal(BLOCKERS_SQL, byId.get('pg-block-tree'));
  assert.equal(BACKLOG_SQL, byId.get('pg-autovac-due'));
  assert.equal(HISTORY_SQL, byId.get('pg-vacuum'));
  assert.equal(TABLE_BLOAT_SQL, byId.get('pg-bloat-tables'));
  assert.equal(WRAPAROUND_SQL, byId.get('pg-wraparound'));
  assert.equal(FREEZE_AGE_SQL, byId.get('pg-freeze-age'));
  assert.equal(FREEZE_BLOCKERS_SQL, byId.get('pg-freeze-blockers'));
});

test('dbaViewSql throws on an unknown id rather than rendering empty', () => {
  assert.throws(() => dbaViewSql('pg-nope'), /no such postgres dbaView/);
});

test('the backlog SQL honours per-table reloptions (the own-threshold rule)', () => {
  assert.match(BACKLOG_SQL, /pg_options_to_table/);
  assert.match(BACKLOG_SQL, /autovacuum_vacuum_threshold/);
  assert.match(BACKLOG_SQL, /autovacuum_vacuum_scale_factor/);
});

// ── index bloat estimate ─────────────────────────────────────────────────────

test('the index estimate reads only catalogs and labels itself an estimate', () => {
  assert.match(INDEX_BLOAT_SQL, /FROM pg_stat_user_indexes/);
  assert.match(INDEX_BLOAT_SQL, /pg_relation_size\(i\.indexrelid\)/);
  // The 8 MB floor — noise from a fresh schema stays off the list.
  assert.match(INDEX_BLOAT_SQL, /8388608/);
});

// ── pgstattuple flow ─────────────────────────────────────────────────────────

test('the pgstattuple probe answers installed AND available in one row', () => {
  assert.match(PGSTATTUPLE_STATE_SQL, /pg_extension/);
  assert.match(PGSTATTUPLE_STATE_SQL, /pg_available_extensions/);
  assert.match(PGSTATTUPLE_INSTALL_SQL, /CREATE EXTENSION IF NOT EXISTS pgstattuple/);
});

test('exact-measure SQL quotes identifiers and literals safely', () => {
  assert.match(pgStatTableSql('shop', 'orders'), /pgstattuple\('"shop"\."orders"'\)/);
  assert.match(pgStatTableSql('my schema', "o'brien"), /"my schema"\."o''brien"/);
  assert.match(pgStatIndexSql('shop', 'orders_pkey'), /pgstatindex\('"shop"\."orders_pkey"'\)/);
  // The tuner's float8 cast — the column is float4 and decodes badly as-is.
  assert.match(pgStatIndexSql('s', 'i'), /avg_leaf_density::float8/);
  assert.match(relationSizeSql('shop', 'orders'), /pg_relation_size\('"shop"\."orders"'\)/);
});

test('exact scans are capped at the tuner ceiling', () => {
  assert.equal(EXACT_SCAN_MAX_BYTES, 4 * 1024 * 1024 * 1024);
});

// ── parsers ──────────────────────────────────────────────────────────────────

test('parseProgressRow reads the pg-progress-vacuum shape', () => {
  const r = parseProgressRow(['4711', 'shop', 'orders', 'vacuuming indexes', '120 MB', '81.5', '40.2', '2']);
  assert.equal(r.pid, 4711);
  assert.equal(r.table, 'orders');
  assert.equal(r.phase, 'vacuuming indexes');
  assert.equal(r.scannedPct, 81.5);
  assert.equal(r.indexPasses, 2);
  // NULLs (a vacuum whose relid no longer resolves) are tolerated.
  const n = parseProgressRow(['1', 'db', null, 'initializing', null, null, null, '0']);
  assert.equal(n.table, '');
  assert.equal(n.scannedPct, null);
});

test('parseBacklogRow ranks against the table\'s OWN threshold', () => {
  const due = parseBacklogRow(['public', 'orders', '25000', '10500', '12.5', null, '3']);
  assert.equal(due.state, 'due');
  assert.ok(due.dueRatio > 2);
  const rising = parseBacklogRow(['public', 'items', '5000', '10000', '5.0', null, '0']);
  assert.equal(rising.state, 'rising');
  const ok = parseBacklogRow(['public', 'tiny', '10', '1000', '1.0', null, '9']);
  assert.equal(ok.state, 'ok');
  // A zero threshold with dead tuples is infinitely due, not a crash.
  const zero = parseBacklogRow(['public', 'weird', '50', '0', null, null, '0']);
  assert.equal(zero.dueRatio, Infinity);
  assert.equal(zero.state, 'due');
});

test('rankBacklog sorts by due ratio, worst first, tie on absolute dead tuples', () => {
  const rows = rankBacklog([
    parseBacklogRow(['p', 'fine', '10', '1000', null, null, '0']),
    parseBacklogRow(['p', 'due-small', '2000', '1000', null, null, '0']),
    parseBacklogRow(['p', 'due-big', '9000', '1000', null, null, '0']),
    parseBacklogRow(['p', 'rising', '600', '1000', null, null, '0']),
  ]);
  assert.deepEqual(rows.map(r => r.table), ['due-big', 'due-small', 'rising', 'fine']);
});

test('backlogReason says the ratio and threshold in words', () => {
  const r = parseBacklogRow(['public', 'orders', '25000', '10500', null, null, '3']);
  assert.match(backlogReason(r), /2\.4× its own threshold/);
  const z = parseBacklogRow(['public', 'weird', '50', '0', null, null, '0']);
  assert.match(backlogReason(z), /no threshold/);
});

test('parseTableBloatRow reads the pg-bloat-tables estimate shape', () => {
  const r = parseTableBloatRow(['public', 'orders', '150 MB', '19200', '9500', '50.5', '75 MB']);
  assert.equal(r.estBloatPct, 50.5);
  assert.equal(r.estWasted, '75 MB');
});

test('parseIndexBloatRow flags an index larger than its heap (tuner heuristic)', () => {
  const suspect = parseIndexBloatRow(['public', 't', 't_idx', '200000000', '191 MB', '100000000', '96 MB', '12']);
  assert.equal(suspect.suspect, true);
  const fine = parseIndexBloatRow(['public', 't', 't_idx', '10000000', '10 MB', '100000000', '96 MB', '12']);
  assert.equal(fine.suspect, false);
});

test('parseWraparoundRow severity ladder matches the view description', () => {
  assert.equal(parseWraparoundRow(['db', '1000000', '200000000', '2146000000', '10.0']).state, 'ok');
  assert.equal(parseWraparoundRow(['db', '1100000000', '200000000', '1047000000', '51.2']).state, 'watch');
  assert.equal(parseWraparoundRow(['db', '1700000000', '200000000', '447483647', '79.1']).state, 'urgent');
});

test('wraparoundSummary names the worst database and the headroom', () => {
  const rows = [
    parseWraparoundRow(['a', '1000000', '200000000', '2146000000', '10.0']),
    parseWraparoundRow(['b', '1700000000', '200000000', '447483647', '79.1']),
  ];
  const s = wraparoundSummary(rows);
  assert.match(s, /\bb\b/);
  assert.match(s, /79\.1%/);
  assert.match(s, /447,483,647/);
  assert.equal(wraparoundSummary([]), 'No databases report a freeze age.');
});

test('freeze age and freeze blocker parsers read their shapes', () => {
  const f = parseFreezeAgeRow(['public', 'orders', '190000000', '95.0', '1.2 GB', 'r']);
  assert.equal(f.pctToForced, 95.0);
  const b = parseFreezeBlockerRow(['prepared transaction', 'tx-9', 'root', '3600', 'PREPARE TRANSACTION never committed']);
  assert.equal(b.kind, 'prepared transaction');
  assert.equal(b.ageS, 3600);
});

test('parseHistoryRow flags never-vacuumed and never-analyzed tables', () => {
  const r = parseHistoryRow(['public', 'orders', null, null, null, null, '0', '0']);
  assert.equal(r.neverVacuumed, true);
  assert.equal(r.neverAnalyzed, true);
  const done = parseHistoryRow(['public', 'orders', '2026-08-01 10:00', null, '2026-08-01 10:01', null, '4', '2']);
  assert.equal(done.neverVacuumed, false);
  assert.equal(done.neverAnalyzed, false);
});

// ── the actions ──────────────────────────────────────────────────────────────

test('every action carries its lock level, and exclusive ones a confirm word', () => {
  for (const a of VB_ACTIONS) {
    assert.ok(a.lock.length > 0, `${a.id} lock text`);
    assert.ok(a.summary.length > 0, `${a.id} summary`);
    if (a.lockLevel === 'exclusive') {
      assert.ok(a.confirmWord, `${a.id} needs a typed confirmation`);
      assert.ok(a.warning, `${a.id} needs its consequence stated`);
    }
  }
});

test('the actions generate the SQL the spec asks for', () => {
  const ref = { schema: 'shop', name: 'orders' };
  assert.equal(vbActionSql('vacuum-verbose-analyze', ref),
    'VACUUM (VERBOSE, ANALYZE) "shop"."orders";');
  assert.equal(vbActionSql('analyze', ref), 'ANALYZE "shop"."orders";');
  assert.equal(vbActionSql('reindex-index', ref, { index: 'orders_pkey' }),
    'REINDEX INDEX CONCURRENTLY "shop"."orders_pkey";');
  assert.equal(vbActionSql('reindex-table', ref),
    'REINDEX TABLE CONCURRENTLY "shop"."orders";');
  assert.equal(vbActionSql('vacuum-full', ref), 'VACUUM FULL "shop"."orders";');
  assert.equal(vbActionSql('cluster', ref), 'CLUSTER "shop"."orders";');
});

test('REINDEX CONCURRENTLY is gated PG 12+, and pg_repack is advice-only', () => {
  assert.equal(findVbAction('reindex-index').minMajor, 12);
  assert.equal(findVbAction('reindex-table').minMajor, 12);
  const repack = findVbAction('pg-repack');
  assert.equal(repack.executes, false);
  const advice = vbActionSql('pg-repack', { schema: 'shop', name: 'orders' }, { database: 'shopdb' });
  assert.match(advice, /^-- /);
  assert.match(advice, /pg_repack -d shopdb -t "shop"\."orders"/);
  // Advice is comments only — nothing in it can execute if pasted and run.
  assert.ok(advice.split('\n').every(l => l.startsWith('--')));
});

test('identifiers that need quoting cannot break out of the action SQL', () => {
  assert.equal(vbActionSql('vacuum-full', { schema: 'my schema', name: 'order' }),
    'VACUUM FULL "my schema"."order";');
});

test('actionCost states disk and lock consequences before anything runs', () => {
  assert.match(actionCost('vacuum-verbose-analyze', { sizePretty: '120 MB', deadTup: 40000 }),
    /120 MB.*40,000 dead tuples/);
  assert.match(actionCost('vacuum-full', { sizePretty: '120 MB' }), /~120 MB of free disk/);
  assert.match(actionCost('reindex-index', { sizePretty: '45 MB' }), /~45 MB of free disk/);
  // No size known: the text says what it can and does not invent a number.
  assert.match(actionCost('analyze', {}), /seconds/);
  assert.match(actionCost('cluster', {}), /ACCESS EXCLUSIVE/);
});
