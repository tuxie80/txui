/**
 * The engine capability table (src/utils/engineCaps.ts).
 *
 * The bug it replaces: the button for the ER diagram, data generator, CSV
 * import and SQL quality panels tested `!redis && !clickhouse && !parquet`
 * while the keyboard shortcut for the same panels tested only
 * `!redis && !clickhouse`, so on a Parquet session those panels were hidden
 * and still openable by shortcut.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, ENGINE_CAPS, can, enginesWith } from '../src/utils/engineCaps.ts';
import type { EngineCaps } from '../src/utils/engineCaps.ts';

const CAPS = Object.keys(ENGINE_CAPS.mysql) as (keyof EngineCaps)[];

// ── the table is complete ───────────────────────────────────────────────────

test('every engine answers every capability', () => {
  // The whole point of the table: a new engine cannot half-exist.
  for (const e of ENGINES) {
    for (const c of CAPS) {
      assert.equal(typeof ENGINE_CAPS[e][c], 'boolean', `${e}.${c}`);
    }
  }
});

test('ENGINES and the table agree on which engines exist', () => {
  assert.deepEqual([...ENGINES].sort(), Object.keys(ENGINE_CAPS).sort());
});

// ── the divergence that motivated it ────────────────────────────────────────

test('Parquet cannot open the four panels its buttons already hid', () => {
  // Button said no, shortcut said yes. One answer now.
  for (const c of ['erDiagram', 'dataGen', 'csvImport', 'sqlQuality'] as const) {
    assert.equal(can('parquet', c), false, c);
  }
});

test('Redis and ClickHouse agree with their buttons too', () => {
  for (const c of ['erDiagram', 'dataGen', 'csvImport', 'sqlQuality'] as const) {
    assert.equal(can('redis', c), false, `redis.${c}`);
    assert.equal(can('clickhouse', c), false, `clickhouse.${c}`);
  }
});

// ── the claims the table makes about each engine ────────────────────────────

test('the file engines have no server-side surface', () => {
  // In-process or no engine at all: nothing to list, nothing to configure.
  for (const e of ['sqlite', 'parquet'] as const) {
    assert.equal(can(e, 'processList'), false, `${e}.processList`);
    assert.equal(can(e, 'serverInfo'), false, `${e}.serverInfo`);
    assert.equal(can(e, 'statementTimeout'), false, `${e}.statementTimeout`);
  }
});

test('Parquet cannot be written to', () => {
  assert.equal(can('parquet', 'writes'), false);
  assert.equal(can('parquet', 'transactions'), false);
  // But it is still read through SQL — hiding the editor would be wrong.
  assert.equal(can('parquet', 'sql'), true);
});

test('Redis is not SQL, but still has clients to list and settings to read', () => {
  assert.equal(can('redis', 'sql'), false);
  assert.equal(can('redis', 'sqlVariables'), false);
  assert.equal(can('redis', 'processList'), true);   // CLIENT LIST / CLIENT KILL
  assert.equal(can('redis', 'serverInfo'), true);    // CONFIG GET / INFO
});

test('ClickHouse speaks SQL but has no interactive transactions', () => {
  assert.equal(can('clickhouse', 'sql'), true);
  assert.equal(can('clickhouse', 'transactions'), false);
});

test('SQLite has transactions even though it has no server', () => {
  // The two are unrelated, and conflating them is the mistake a derived
  // `!isFile` rule makes.
  assert.equal(can('sqlite', 'transactions'), true);
  assert.equal(can('sqlite', 'processList'), false);
});

test('SQLite does not offer what the backend refuses', () => {
  // The datagen writers speak only the MySQL/PG wire protocols and return "not
  // supported for this engine" at run time — so that button must not exist.
  // CSV import IS supported (the importer runs standard multi-row INSERTs over
  // the SQLite pool). SQL quality stays: it degrades to static lint.
  assert.equal(can('sqlite', 'dataGen'), false);
  assert.equal(can('sqlite', 'csvImport'), true);
  assert.equal(can('sqlite', 'sqlQuality'), true);
});

test('the DBA panels are MySQL and PostgreSQL only', () => {
  assert.deepEqual(enginesWith('sqlDba'), ['mysql', 'postgres']);
});

test('the table designer serves the five engines that own real tables', () => {
  // ClickHouse, SQLite and SQL Server got first-class dialects; Redis has no
  // tables and Parquet nothing to write to, so the designer must not open for
  // them. DuckDB owns real tables but has no designer dialect — it gets the
  // refusal, which beats being handed MySQL's SQL.
  assert.deepEqual(enginesWith('tableDesigner'),
    ['mysql', 'postgres', 'clickhouse', 'sqlite', 'sqlserver']);
});

// ── DuckDB ────────────────────────────────────────────────────────────────────

test('DuckDB is a real read-write SQL engine with no server-side surface', () => {
  // In-process, like SQLite: nothing else is running, so no processlist, and
  // there is no statement ceiling to set.
  assert.equal(can('duckdb', 'sql'), true);
  assert.equal(can('duckdb', 'transactions'), true);
  assert.equal(can('duckdb', 'writes'), true);
  assert.equal(can('duckdb', 'processList'), false);
  assert.equal(can('duckdb', 'statementTimeout'), false);
});

test('DuckDB keeps what works and greys what does not', () => {
  // duckdb_settings() backs the variables view; EXPLAIN passes through as
  // text, so SQL quality stays (degrading to static lint, as on SQLite).
  assert.equal(can('duckdb', 'serverInfo'), true);
  assert.equal(can('duckdb', 'sqlQuality'), true);
  // The DBA surface assumes MySQL/PG catalogs; the diagram's introspection is
  // not wired to duckdb_constraints(); the tuner has no DuckDB rule set.
  assert.equal(can('duckdb', 'sqlDba'), false);
  assert.equal(can('duckdb', 'erDiagram'), false);
  assert.equal(can('duckdb', 'tuner'), false);
  // The generator speaks MySQL/PG/SQLite INSERTs; DuckDB imports CSV in SQL
  // (read_csv / COPY), not through the wizard.
  assert.equal(can('duckdb', 'dataGen'), false);
  assert.equal(can('duckdb', 'csvImport'), false);
  // The default-DB plumbing (set_session_db) has no DuckDB arm — a picker
  // that errors when touched is worse than no picker.
  assert.equal(can('duckdb', 'databaseSelect'), false);
});

// ── MongoDB ───────────────────────────────────────────────────────────────────

test('MongoDB is not SQL and has no write path in v1', () => {
  // The find editor is the query surface: no SQL, no variables, no
  // transactions, no default-DB plumbing, no statement ceiling.
  assert.equal(can('mongodb', 'sql'), false);
  assert.equal(can('mongodb', 'sqlVariables'), false);
  assert.equal(can('mongodb', 'transactions'), false);
  assert.equal(can('mongodb', 'databaseSelect'), false);
  assert.equal(can('mongodb', 'statementTimeout'), false);
  // The driver exposes no write path at all (db/mongodb.rs) — nothing may
  // claim otherwise.
  assert.equal(can('mongodb', 'writes'), false);
  assert.equal(can('mongodb', 'tableDesigner'), false);
  assert.equal(can('mongodb', 'dataGen'), false);
  assert.equal(can('mongodb', 'csvImport'), false);
  assert.equal(can('mongodb', 'sqlDba'), false);
  assert.equal(can('mongodb', 'sqlQuality'), false);
  assert.equal(can('mongodb', 'erDiagram'), false);
  assert.equal(can('mongodb', 'tuner'), false);
  assert.equal(can('mongodb', 'maintenance'), false);
});

test('MongoDB does have a processlist and server info', () => {
  // db.currentOp()/killOp back the Processes panel; buildInfo/serverStatus
  // back the Server panel.
  assert.equal(can('mongodb', 'processList'), true);
  assert.equal(can('mongodb', 'serverInfo'), true);
});

// ── SQL Server ────────────────────────────────────────────────────────────────

test('SQL Server is a full networked SQL engine for editing and browsing', () => {
  // The T-SQL dialect exists (keywords, bracket quoting, write guard), and the
  // DMV queries back the DBA surface — so these are all real.
  assert.equal(can('sqlserver', 'sql'), true);
  assert.equal(can('sqlserver', 'writes'), true);
  assert.equal(can('sqlserver', 'sqlVariables'), true);
  assert.equal(can('sqlserver', 'processList'), true);  // dm_exec_sessions⋈requests + KILL
  assert.equal(can('sqlserver', 'serverInfo'), true);   // sys.configurations / SERVERPROPERTY
  assert.equal(can('sqlserver', 'maintenance'), true);  // DBCC CHECKTABLE / ALTER INDEX / UPDATE STATISTICS [WITH FULLSCAN]
  assert.equal(can('sqlserver', 'routines'), true);     // sys.sql_modules + CREATE OR ALTER
  assert.equal(can('sqlserver', 'userAdmin'), true);    // three-state permission matrix
  assert.equal(can('sqlserver', 'tuner'), true);        // mssql_collectors + mssql_checks
  assert.equal(can('sqlserver', 'csvImport'), true);    // batched INSERT, ≤1000 VALUES rows
  assert.equal(can('sqlserver', 'dataGen'), true);      // row-by-row and server-side
  assert.equal(can('sqlserver', 'fleet'), true);        // sys.configurations + sys.stats
  assert.equal(can('sqlserver', 'tableDesigner'), true); // T-SQL DDL dialect
  assert.equal(can('sqlserver', 'sqlQuality'), true);   // lint, types, ceilings, SHOWPLAN
  assert.equal(can('sqlserver', 'playground'), true);  // WAITFOR + UPDLOCK/HOLDLOCK
  assert.equal(can('sqlserver', 'namespaceDdl'), true); // schemas and databases
  assert.equal(can('sqlserver', 'queryStore'), true);   // plan history + forcing
});

test('SQL Server greys what v1 honestly does not have', () => {
  // The default-DB plumbing is deliberately absent — the driver uses
  // three-part names, never USE — and `sqlDba` stays false because the fifteen
  // panels behind it hardcode MySQL/PostgreSQL SQL. They are lit individually.
  assert.equal(can('sqlserver', 'sqlDba'), false);
  assert.equal(can('sqlserver', 'databaseSelect'), false);
  // statementTimeout is false because SQL Server HAS no such setting, not
  // because it is unbuilt: the flag means a SERVER-side per-statement ceiling,
  // and T-SQL offers none (SET LOCK_TIMEOUT bounds lock waits; the query
  // governor is a pre-execution cost estimate, not a clock). The client-side
  // deadline still applies to it.
  assert.equal(can('sqlserver', 'statementTimeout'), false);
});

test('SQL Server can read blocking chains, without claiming the rest of sqlDba', () => {
  // `lockWaits` exists precisely so this is expressible: the Locks & Deadlocks
  // panel works on SQL Server (sys.dm_os_waiting_tasks) while the other
  // fourteen sqlDba panels still speak MySQL/PG catalogs. One flag for fifteen
  // panels could only ever be wrong in one direction — fifteen hidden, or
  // fifteen broken.
  //
  // The merged panel's deadlock tab rides the same flag: the three engines
  // that publish anything about deadlocks (SQL Server's system_health graph
  // history, MySQL's latest detected deadlock, PostgreSQL's per-database
  // counters) are exactly the three with blocking chains, so the old separate
  // `deadlocks` capability could only ever echo this one and was folded in.
  assert.equal(can('sqlserver', 'lockWaits'), true);
  assert.equal(can('sqlserver', 'sqlDba'), false);
  assert.deepEqual(enginesWith('lockWaits'), ['mysql', 'postgres', 'sqlserver']);
});

test('SQL Server draws ER diagrams', () => {
  // sys.foreign_key_columns gives the column PAIRS a composite FK needs —
  // information_schema splits them over three views joined by constraint name,
  // which mis-pairs a multi-column key. sys.columns carries the length and
  // precision that make a diagram column worth reading.
  assert.equal(can('sqlserver', 'erDiagram'), true);
  assert.ok(enginesWith('erDiagram').includes('sqlserver'));
});

test('SQL Server lights panels one at a time, never via sqlDba', () => {
  // Phase 2 of plan-sqlserver.md. `sqlDba` gates fifteen panels that hardcode
  // MySQL/PG catalog SQL, so flipping it would surface fifteen panels that
  // error on connect — worse than fifteen hidden ones. Each panel gets its own
  // capability as its T-SQL lands.
  for (const capability of ['lockWaits', 'sequences', 'longQueryWatch',
                            'erDiagram', 'columnProfile'] as const) {
    assert.equal(can('sqlserver', capability), true, capability);
  }
  assert.equal(can('sqlserver', 'sqlDba'), false);
});

test('sequences is about the OBJECT existing, not the engine family', () => {
  // MySQL proper has no sequences — AUTO_INCREMENT is a column property, not
  // an object — while MariaDB does. A static table cannot tell them apart, so
  // the flag means "ask", and SequencePanel says "MySQL has none" once the
  // server flavour comes back plain.
  assert.deepEqual(enginesWith('sequences'), ['mysql', 'postgres', 'sqlserver']);
});

test('lockWaits is off for engines with no lock manager to ask', () => {
  for (const e of ['redis', 'clickhouse', 'sqlite', 'parquet', 'duckdb', 'mongodb'] as const) {
    assert.equal(can(e, 'lockWaits'), false, e);
    assert.equal(can(e, 'sequences'), false, e);
    assert.equal(can(e, 'longQueryWatch'), false, e);
  }
});

test('SQL Server has transactions, and needs no connection pinning for them', () => {
  // A TDS session is ONE connection, so every statement already lands on the
  // backend the transaction lives on. `tx_conns` exists to stop a pool
  // scattering a transaction across backends; with no pool there is nothing to
  // pin, and BEGIN/COMMIT/ROLLBACK run on the session's own client with
  // @@TRANCOUNT as the source of truth.
  assert.equal(can('sqlserver', 'transactions'), true);
  assert.ok(enginesWith('transactions').includes('sqlserver'));
});

test('SQL Server joins the processlist club', () => {
  assert.ok(enginesWith('processList').includes('sqlserver'));
  assert.ok(enginesWith('serverInfo').includes('sqlserver'));
});

// ── unknown engines ─────────────────────────────────────────────────────────

test('an engine the table does not know can do nothing', () => {
  // Not "assume it behaves like SQL": offering a panel that cannot work is
  // worse than withholding one that could.
  for (const c of CAPS) assert.equal(can('oracle', c), false, c);
  assert.equal(can('', 'sql'), false);
});

test('a capability that only some engines have is not universally true', () => {
  // Guards against a table filled in by copy-paste.
  for (const c of CAPS) {
    const yes = enginesWith(c).length;
    assert.ok(yes > 0, `${c} is true for no engine — dead capability`);
  }
  assert.ok(enginesWith('sqlDba').length < ENGINES.length);
  assert.ok(enginesWith('writes').length < ENGINES.length);
});

test('Query Store is SQL Server\'s alone — the others keep no plan history', () => {
  // MySQL's performance-schema digests and PostgreSQL's pg_stat_statements
  // both keep timings and neither keeps a plan, so neither can say "the plan
  // changed" or put the old one back. The flag means those two things, not
  // "has query statistics".
  assert.deepEqual(enginesWith('queryStore'), ['sqlserver']);
});
