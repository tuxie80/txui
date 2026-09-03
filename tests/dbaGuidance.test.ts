/**
 * DBA view guidance (src/utils/dbaGuidance.ts): raw server errors map to an
 * explanation + fix SQL, and empty results on consumer-dependent views get a
 * setup_consumers hint. Also sanity-checks the dbaViews catalog itself.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  guidanceForError, consumerHint, performanceSchemaOffGuidance,
} from '../src/utils/dbaGuidance.ts';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';

test('performance_schema table missing → enable + restart guidance', () => {
  const g = guidanceForError("Table 'performance_schema.events_statements_current' doesn't exist", 'mysql');
  assert.ok(g);
  assert.match(g.title, /performance_schema is OFF/);
  assert.match(g.sql.join('\n'), /performance_schema = ON/);
});

test('sys table missing → sys schema guidance', () => {
  const g = guidanceForError("Table 'sys.statement_analysis' doesn't exist", 'mysql');
  assert.ok(g);
  assert.match(g.title, /sys schema missing/);
});

test('unknown table elsewhere is not hijacked', () => {
  assert.equal(guidanceForError("Table 'app.orders' doesn't exist", 'mysql'), null);
});

test('pg_stat_statements missing → both preload and CREATE EXTENSION steps', () => {
  const g = guidanceForError('relation "pg_stat_statements" does not exist', 'postgres');
  assert.ok(g);
  const sql = g.sql.join('\n');
  assert.match(sql, /CREATE EXTENSION/);
  // CREATE EXTENSION alone fails with the identical error unless the library
  // was preloaded, so the restart step must be surfaced too — and first.
  assert.match(sql, /shared_preload_libraries/);
  assert.ok(
    g.sql.findIndex(s => /shared_preload_libraries/.test(s))
      < g.sql.findIndex(s => /CREATE EXTENSION/.test(s)),
    'preload step must come before CREATE EXTENSION',
  );
});

test('pg_stat_wal missing on postgres → version note', () => {
  const g = guidanceForError('relation "pg_stat_wal" does not exist', 'postgres');
  assert.ok(g);
  assert.match(g.title, /PostgreSQL 14/);
});

test('unrelated errors return null', () => {
  assert.equal(guidanceForError('connection refused', 'mysql'), null);
  assert.equal(guidanceForError('syntax error at or near "FROM"', 'postgres'), null);
});

test('consumerHint reflects the server state, not the view definition', () => {
  // The bug: after running the suggested UPDATE, refreshing showed the very
  // same "collection is OFF — run this UPDATE" block, because the hint was
  // derived from the view alone and never looked at the server.
  const view = { id: 'v', label: 'v', category: 'c', sql: '', description: '',
                 needsConsumers: ['statements_digest'] } as never;

  // Server says it is enabled → no SQL, and wording that explains the emptiness.
  const on = consumerHint(view, [])!;
  assert.equal(on.sql.length, 0);
  assert.match(on.title, /collection is on/i);
  assert.match(on.detail, /after it is enabled/);

  // Server says it is still off → the fix, for exactly that consumer.
  const off = consumerHint(view, ['statements_digest'])!;
  assert.equal(off.sql.length, 1);
  assert.match(off.title, /OFF/);
  assert.match(off.sql[0], /statements_digest/);

  // State unknown (no privileges / performance_schema off) → fall back to
  // advising all of them, because we genuinely do not know.
  const unknown = consumerHint(view, null)!;
  assert.equal(unknown.sql.length, 1);
});

test('consumerHint advises only the consumers that are actually off', () => {
  const view = { id: 'v', label: 'v', category: 'c', sql: '', description: '',
                 needsConsumers: ['a', 'b', 'c'] } as never;
  const g = consumerHint(view, ['b'])!;
  assert.equal(g.sql.length, 1);
  assert.match(g.sql[0], /'b'/);
  assert.ok(!g.sql.some(s => s.includes("'a'")));
});

test('consumerHint emits one UPDATE per needed consumer', () => {
  const view = DBA_VIEWS.mysql.find(v => v.id === 'stmt-latency')!;
  const g = consumerHint(view, null)!;
  assert.ok(g);
  assert.deepEqual(g.sql, ["UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME='statements_digest';"]);
  const current = DBA_VIEWS.mysql.find(v => v.id === 'rt-current')!;
  assert.match(consumerHint(current, null)!.sql[0], /events_statements_current/);
});

test('consumerHint is null for views without consumer dependencies', () => {
  const view = DBA_VIEWS.mysql.find(v => v.id === 'tbl-sizes')!;
  assert.equal(consumerHint(view, null), null);
});

// ── catalog sanity ──

test('view ids are unique per engine', () => {
  for (const [engine, views] of Object.entries(DBA_VIEWS)) {
    const ids = views.map(v => v.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${engine}`);
  }
});

test('setup check is the first MySQL view and mirrors the lock-check pattern', () => {
  const first = DBA_VIEWS.mysql[0];
  assert.equal(first.id, 'setup-check');
  assert.match(first.sql, /setup_consumers/);
  assert.match(first.sql, /statements_digest/);
  assert.match(first.sql, /SCHEMA_NAME = 'sys'/);
  const lockCheck = DBA_VIEWS.mysql.find(v => v.id === 'lock-check')!;
  assert.equal(DBA_VIEWS.mysql.filter(v => v.category === 'Locks')[0], lockCheck);
});

test('digest views carry the demanding flag and consumer dependency', () => {
  for (const id of ['stmt-latency', 'stmt-fullscan', 'stmt-temp', 'stmt-errors', 'stmt-sorting', 'rt-analysis', 'rt-95th']) {
    const v = DBA_VIEWS.mysql.find(x => x.id === id)!;
    assert.ok(v.demanding, `${id} missing demanding`);
    assert.deepEqual(v.needsConsumers, ['statements_digest'], `${id} missing needsConsumers`);
  }
});

test('information_schema size scans are flagged demanding', () => {
  for (const id of ['tbl-sizes', 'auto-inc']) {
    assert.ok(DBA_VIEWS.mysql.find(x => x.id === id)!.demanding, `${id} missing demanding`);
  }
});

// Connections without a selected database record digests with SCHEMA_NAME
// NULL — filtering those out empties the view even when collection is ON,
// which reads exactly like "consumer off" and sends the user down the wrong
// path (the setup_consumers UPDATE then changes nothing).
test('digest views must not filter out NULL-schema digests', () => {
  for (const v of DBA_VIEWS.mysql) {
    assert.doesNotMatch(v.sql, /SCHEMA_NAME IS NOT NULL/i, `${v.id} hides NULL-schema digests`);
  }
});

test('every Parquet view names a command the driver actually implements', async () => {
  // Parquet views carry driver commands, not SQL. A typo would produce
  // "unknown Parquet command" at click time instead of failing here.
  const { DBA_VIEWS } = await import('../src/utils/dbaViews.ts');
  // Mirrors db/parquet.rs COMMANDS.
  const COMMANDS = new Set([
    'FILEINFO', 'SCHEMA', 'ROWGROUPS', 'COLUMNCHUNKS', 'STATS', 'KEYVALUE', 'PREVIEW',
    'PAGES', 'ENCODINGS', 'CODECS', 'NULLS', 'CARDINALITY', 'SKEW', 'SORTING',
    'BLOOM', 'HEALTH',
  ]);
  for (const v of DBA_VIEWS.parquet) {
    const verb = v.sql.trim().split(/\s+/)[0].toUpperCase();
    assert.ok(COMMANDS.has(verb), `${v.id} uses unknown command "${verb}"`);
  }
});

test('SQLite views only read the catalog, never user tables', async () => {
  // A DBA view must never touch business data. Every SQLite view reads
  // sqlite_master, a pragma function, dbstat or a scalar function.
  const { DBA_VIEWS } = await import('../src/utils/dbaViews.ts');
  const ALLOWED = /sqlite_master|sqlite_schema|sqlite_stat1|pragma_[a-z_]+|dbstat|sqlite_version|sqlite_source_id/;
  for (const v of DBA_VIEWS.sqlite) {
    assert.ok(ALLOWED.test(v.sql), `${v.id} reads something that is not the catalog`);
  }
});

// ── PostgreSQL view catalogue ───────────────────────────────────────────────

test('every PostgreSQL view reads only catalogs and statistics', async () => {
  // A DBA view must never touch business data. The live probe
  // (dev/probe_pg_views.mjs) enforces this against a server; this enforces it
  // without one, so a new view cannot be merged on a machine with no database.
  const { DBA_VIEWS } = await import('../src/utils/dbaViews.ts');
  // PostGIS ships read-only metadata *views* (geometry_columns, geography_columns)
  // and spatial_ref_sys in the public schema — they are catalogs in every sense
  // that matters here (no business data), so the spatial DBA views may read them.
  const ALLOWED = /^(pg_|information_schema\.|(public\.)?(geometry_columns|geography_columns|spatial_ref_sys)\b|unnest|generate_|current_|now|version)/i;
  const ALIASES = /^(w|ix|a|b|s|c|t|p|i|n|u|e|con|ft|child|parent|cn|pn)$/;
  for (const v of DBA_VIEWS.postgres) {
    const sql = v.sql.replace(/IS\s+(NOT\s+)?DISTINCT\s+FROM/gi, 'IS_DISTINCT');
    const refs = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)/g)]
      .map(m => m[1])
      .filter(r => !ALLOWED.test(r) && !ALIASES.test(r));
    assert.deepEqual(refs, [], `${v.id} reads outside the catalog`);
  }
});

test('no PostgreSQL view counts rows', async () => {
  // Row counts come from reltuples and pg_stat_*, which the planner maintains
  // anyway. A COUNT(*) to tell someone their table is bloated is not a trade
  // anybody agreed to.
  const { DBA_VIEWS } = await import('../src/utils/dbaViews.ts');
  for (const v of DBA_VIEWS.postgres) {
    // count(*) over a catalog is fine; it is user tables that must not be scanned.
    const bad = /\bCOUNT\s*\(\s*\*\s*\)\s*FROM\s+(?!pg_)/i.test(v.sql);
    assert.equal(bad, false, `${v.id} counts rows of something that is not a catalog`);
  }
});

test('a view reading a version-gated catalog says which version', async () => {
  // pg_stat_io arrived in 16, pg_stat_checkpointer in 17, the wal_* columns of
  // pg_stat_statements in 13. A view that needs one and does not say so reads
  // as broken on every older server.
  const { DBA_VIEWS } = await import('../src/utils/dbaViews.ts');
  const GATED: Array<[RegExp, RegExp]> = [
    [/pg_stat_io\b/, /\b16\+/],
    [/pg_stat_checkpointer\b/, /\b17\+/],
    [/pg_stat_progress_(analyze|cluster|create_index)\b/, /\b1[2-9]\+/],
    [/\bwal_bytes\b/, /\b13\+/],
    [/relpartbound/, /\b10\+/],
    // pg_stat_statements renamed total_time → total_exec_time (and mean_,
    // stddev_) in the version that shipped with PostgreSQL 13, when it split
    // planning from execution. On 12 the data is there under the old names and
    // the view as written cannot read it — a rename is easy to miss precisely
    // because the *view* still exists.
    [/\b(total|mean|stddev|min|max)_exec_time\b/, /\b13\+/],
  ];
  for (const v of DBA_VIEWS.postgres) {
    for (const [needle, mention] of GATED) {
      if (needle.test(v.sql)) {
        assert.match(v.description, mention, `${v.id} uses ${needle} without naming the minimum version`);
      }
    }
  }
});

test('every needsPrivilege names a capability the privilege layer knows', async () => {
  const { DBA_VIEWS } = await import('../src/utils/dbaViews.ts');
  const { CAPABILITIES } = await import('../src/utils/privileges.ts');
  const known = new Set<string>(CAPABILITIES);
  for (const views of Object.values(DBA_VIEWS)) {
    for (const v of views) {
      if (v.needsPrivilege) {
        assert.ok(known.has(v.needsPrivilege), `${v.id} needs unknown capability ${v.needsPrivilege}`);
      }
    }
  }
});

test('the PostgreSQL catalogue is wide enough to be worth categorising', async () => {
  const { DBA_VIEWS } = await import('../src/utils/dbaViews.ts');
  assert.ok(DBA_VIEWS.postgres.length >= 45,
    `PostgreSQL has ${DBA_VIEWS.postgres.length} views — wave 1 added 30 to the original 17`);
  const cats = new Set(DBA_VIEWS.postgres.map(v => v.category));
  for (const c of ['Maintenance', 'Indexes & schema', 'Queries', 'Replication', 'Security', 'Server & config']) {
    assert.ok(cats.has(c), `no PostgreSQL views in ${c}`);
  }
});

test('a catalog that arrived in a later major explains itself, with the alternative', async () => {
  // On an older server these are facts about the server, not broken views —
  // and the user needs to know what to read instead.
  const io = guidanceForError('ERROR: relation "pg_stat_io" does not exist', 'postgres')!;
  assert.match(io.title, /16\+/);
  assert.match(io.detail, /pg_statio_user_tables|pg_stat_bgwriter/);

  const cp = guidanceForError('ERROR: relation "pg_stat_checkpointer" does not exist', 'postgres')!;
  assert.match(cp.title, /17\+/);
  assert.match(cp.detail, /pg_stat_bgwriter/);

  const wal = guidanceForError('ERROR: column "wal_bytes" does not exist', 'postgres')!;
  assert.match(wal.title, /13\+/);
});

test('a disabled ClickHouse system table names its config block', async () => {
  // Code 60, two phrasings across server builds — both must land on guidance.
  const g = guidanceForError(
    "Code: 60. DB::Exception: Unknown table expression identifier 'system.query_log' in scope (UNKNOWN_TABLE)",
    'clickhouse')!;
  assert.match(g.title, /system\.query_log/);
  assert.match(g.detail, /<query_log>/);
  assert.ok(g.sql[0].includes('<query_log>'), 'the fix block is copy-able');

  const keeper = guidanceForError(
    "Code: 60. DB::Exception: Table system.zookeeper_connection doesn't exist (UNKNOWN_TABLE)",
    'clickhouse')!;
  assert.match(keeper.detail, /Keeper/);

  // An unknown system table still gets the generic config-block wording…
  const generic = guidanceForError(
    "Code: 60. DB::Exception: Unknown table expression identifier 'system.asynchronous_metric_log' (UNKNOWN_TABLE)",
    'clickhouse')!;
  assert.match(generic.title, /system\.asynchronous_metric_log/);
  // …but a missing USER table is a genuine error, not guidance.
  assert.equal(guidanceForError(
    "Code: 60. DB::Exception: Unknown table expression identifier 'analytics.orders' (UNKNOWN_TABLE)",
    'clickhouse'), null);
  // And the branch is engine-scoped.
  assert.equal(guidanceForError(
    "Unknown table expression identifier 'system.query_log'", 'mysql'), null);
});

/**
 * performance_schema off entirely, as opposed to one consumer disabled.
 *
 * Worth its own test because the advice it replaces was actively wrong: with
 * the subsystem off, `UPDATE performance_schema.setup_consumers` matches no
 * rows and `SET GLOBAL performance_schema = ON` fails with "read only
 * variable". Measured on MariaDB 10.6, which ships it off — so on that server
 * this is the common case, not the exotic one.
 */
describe('performance_schema off', () => {
  const g = performanceSchemaOffGuidance();

  test('it says the subsystem is off, not that a consumer is', () => {
    assert.match(g.title, /performance_schema is OFF/);
  });

  /// The whole point: the runtime fix does not exist, and offering one sends
  /// the reader to a statement the server refuses.
  test('it does not offer a runtime UPDATE that cannot work', () => {
    const sql = g.sql.join('\n');
    assert.doesNotMatch(sql, /UPDATE/i);
    assert.doesNotMatch(sql, /SET GLOBAL/i);
  });

  test('it gives the config change and says a restart is needed', () => {
    assert.match(g.sql.join('\n'), /performance_schema\s*=\s*ON/);
    assert.match(g.detail, /restart/i);
  });

  /// Someone reading this on MariaDB should learn why MySQL colleagues do not
  /// see the same empty grid.
  test('it explains why the two engines differ here', () => {
    assert.match(g.detail, /MariaDB/);
    assert.match(g.detail, /MySQL/);
  });

  /// It is off by default for a reason; advising it on without saying so is
  /// advice for a laptop given to someone holding a production server.
  test('it mentions the cost of turning it on', () => {
    assert.match(g.detail, /memory|throughput|cost/i);
  });
});
