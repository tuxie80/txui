/**
 * What each engine can do — one table, consulted everywhere.
 *
 * TxUI speaks to seven very different things: two client/server SQL engines,
 * a column store over HTTP, a key/value store, two embedded SQL engines (one
 * OLTP, one OLAP), and a file format with no query engine at all. Which panels
 * apply to which was spread across ~30 inline conditionals of the shape
 * `engine !== 'redis' && !isClickhouse && !isParquet`, and they drifted:
 *
 *   - the **button** for the ER diagram, data generator, CSV import and SQL
 *     quality panels tested `!redis && !clickhouse && !parquet`;
 *   - the **keyboard shortcut** for the same four panels tested only
 *     `!redis && !clickhouse`.
 *
 * So on a Parquet session those panels were deliberately hidden and still
 * openable by shortcut. Nobody wrote that; it is what a list of engine names
 * repeated in two places turns into. Both now read this table.
 *
 * Adding an engine is a compile error until every capability is answered,
 * which is the point: the failure mode of the old shape was a new engine
 * silently inheriting whichever behaviour the `!==` chains happened to give
 * it.
 *
 * **This is for capability, not dialect.** `engine === 'postgres' ? pgSql :
 * mysqlSql` is a legitimate branch and stays where it is — a capability table
 * cannot spell a query. The distinction: a capability answers "does this
 * engine have the feature at all", a dialect branch answers "how do I say it
 * here".
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type Engine = 'mysql' | 'postgres' | 'redis' | 'clickhouse' | 'sqlite' | 'parquet' | 'duckdb' | 'mongodb' | 'sqlserver';

export const ENGINES: readonly Engine[] = ['mysql', 'postgres', 'redis', 'clickhouse', 'sqlite', 'parquet', 'duckdb', 'mongodb', 'sqlserver'];

/**
 * Short display names, for anywhere an engine is *named* rather than configured:
 * badges, table headers, filter dropdowns, the generated help site.
 *
 * `Record<Engine, string>` is the guard — adding an engine to `Engine` fails to
 * compile until it has a name here. That matters because the alternative is
 * what shipped: `dev/gen_docs_html.mjs` kept its own hand-written copy covering
 * six of the nine engines, so DuckDB, MongoDB and SQL Server rendered as the
 * literal text **"undefined"** in every badge, every engine filter and the
 * capability matrix header of the published help site.
 *
 * `ConnectionForm`'s labels are deliberately separate and more verbose
 * ("SQLite (file)", "DuckDB (file or :memory:)") — that map tells the user what
 * to type, this one names the thing.
 */
export const ENGINE_LABELS: Record<Engine, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  clickhouse: 'ClickHouse',
  sqlite: 'SQLite',
  parquet: 'Parquet',
  duckdb: 'DuckDB',
  mongodb: 'MongoDB',
  sqlserver: 'SQL Server',
};

export interface EngineCaps {
  /** Speaks SQL at all. Redis does not. */
  sql: boolean;
  /** BEGIN / COMMIT / ROLLBACK against a pinned connection. */
  transactions: boolean;
  /** A default database can be chosen for the editor (USE / search_path / a request parameter). */
  databaseSelect: boolean;
  /** A server-side list of running work that can be inspected and killed. */
  processList: boolean;
  /** Server settings and status are readable. */
  serverInfo: boolean;
  /**
   * The catalog-driven DBA panels: tuner rule sets, replication topology,
   * ANALYZE, locks, GRANTs, saved SQL, the playground, schema compare, the
   * documenter, whole-schema value search.
   */
  sqlDba: boolean;
  /**
   * Blocking chains can be read: who waits on whom, for how long, on what.
   *
   * Split out of `sqlDba` because that flag gates fifteen panels at once, and
   * those panels are not one feature — they are fifteen, each needing its own
   * catalog queries per engine. SQL Server can do blocking chains today
   * (`sys.dm_os_waiting_tasks`) while it still cannot do, say, the documenter,
   * so a single flag could only be wrong in one direction or the other:
   * fifteen hidden panels, or fifteen broken ones.
   *
   * This also gates the Locks & Deadlocks panel's deadlock tab (wait-for
   * graph + incident history): the three engines that publish anything about
   * deadlocks — SQL Server's system_health graph history, MySQL's latest
   * detected deadlock, PostgreSQL's per-database counters — are exactly the
   * three with blocking chains, so the old separate `deadlocks` flag could
   * only ever echo this one and was folded into it.
   *
   * Expect more of these as SQL Server gains the rest — see plan-sqlserver.md
   * Phase 2. Each one is added when the panel behind it actually works.
   */
  lockWaits: boolean;
  /**
   * Sequences exist as objects that can be listed, created and altered.
   *
   * Not `sqlDba`, for the same reason as `lockWaits`. Note this is *not* the
   * same set as the SQL engines: MySQL proper has no sequences at all
   * (AUTO_INCREMENT is a column property), while MariaDB, PostgreSQL and SQL
   * Server do — so the panel is gated on the object existing, not on the engine
   * family. MySQL-vs-MariaDB is decided at runtime from the server flavour,
   * which a static table cannot express; this flag says "ask", and the menu
   * surfaces (the session plugin menu and the Tools-menu opener in QueryTabs)
   * consult the runtime flavour probe (`store/serverFlavors` +
   * `capabilities()` in `utils/serverFlavor`) before offering Sequences for
   * the mysql engine, while `SequencePanel` says "MySQL has none" when the
   * flavour comes back plain.
   */
  sequences: boolean;
  /**
   * A watchdog can list running statements server-wide, with age, and kill one.
   *
   * Distinct from `processList`, which is the raw list: this is the watcher
   * that ages entries against a threshold and alerts. Needs a per-statement
   * elapsed time and the statement text, which ClickHouse and the file engines
   * do not offer in that shape.
   */
  longQueryWatch: boolean;
  /**
   * A primary/replica topology this panel can draw: replicas that report a log
   * position and a lag.
   *
   * Split from `sqlDba` because SQL Server replicates but does **not** fit that
   * shape — Always On availability groups are per-database, with a
   * synchronisation state and a redo queue rather than a byte offset. That gap
   * is registered in `utils/engineGaps.ts` and shown greyed with the reason
   * instead of being silently absent.
   */
  replication: boolean;
  /**
   * A column can be profiled: nulls, distinct counts, extremes, value lengths.
   *
   * Needs only ordinary aggregates and a row-count estimate, so it is set for
   * every engine with a real catalog and cheap row counts.
   */
  columnProfile: boolean;
  /**
   * Every table in a schema can be searched for a value.
   *
   * Needs a catalog to enumerate columns and a LIKE with an escape clause —
   * which all three SQL engines have, in three different spellings.
   */
  dbSearch: boolean;
  /**
   * Where a table or column is referenced by the server's own SQL — views,
   * routines, triggers, constraints, defaults, and whatever else the engine
   * stores a definition for.
   *
   * Needs a catalog that hands back the *text* of those definitions, which the
   * three SQL engines do in three different ways (`SHOW CREATE`, `pg_get_*def`,
   * `OBJECT_DEFINITION`).
   */
  findUsages: boolean;
  /**
   * Two tables can be compared row by row, across sessions, and a
   * reconciliation script generated.
   *
   * Both sides must be the SAME engine — the panel filters the session list on
   * it — because the generated INSERT/UPDATE/DELETE is written in one dialect,
   * and the value representations have to agree before a diff means anything.
   */
  dataCompare: boolean;
  /**
   * A schema can be documented: columns, types, keys, indexes, foreign keys,
   * routines and whatever comments the engine stores.
   */
  documenter: boolean;
  /**
   * Stored routines can be listed, read, edited and saved.
   *
   * The write is the reason this is its own flag: the panel replaces a live
   * procedure. MySQL has to DROP then CREATE and keeps the original in hand to
   * restore; PostgreSQL and SQL Server replace in one statement
   * (`CREATE OR REPLACE`, `CREATE OR ALTER`) and cannot leave a hole. An engine
   * that cannot do one of those safely does not belong here.
   */
  routines: boolean;
  /**
   * Accounts and their permissions can be listed and edited.
   *
   * Editing means *generating* SQL for review — this panel never executes a
   * write — but the engine still has to have a security model TxUI can read
   * back and diff against, which is why it is not simply `sqlDba`.
   */
  userAdmin: boolean;
  /**
   * A label's servers can be compared with each other.
   *
   * Needs three things the engine must actually have: a name/value settings
   * catalogue, a listable index set, and a per-table statistics timestamp.
   * Without the last one the panel's third tab is permanently empty, which is
   * why this is not simply `sqlDba`.
   */
  fleet: boolean;
  /**
   * A contention scenario can be manufactured on this server.
   *
   * Needs N real, concurrent server sessions and a way to make them queue on a
   * row — so an in-process engine cannot do it however much SQL it speaks, and
   * an engine without row locks has nothing to demonstrate.
   */
  playground: boolean;
  /**
   * Namespaces (schemas / databases) can be created and dropped from the tree.
   *
   * Its own flag rather than `sqlDba` because the three engines that have them
   * spell every part differently — `IF NOT EXISTS` does not exist on SQL
   * Server, `CASCADE` is PostgreSQL's alone, and `CREATE SCHEMA` must lead its
   * own batch in T-SQL. An engine here needs a real builder in
   * `utils/schemaObjSql.ts`, not a generic one.
   */
  namespaceDdl: boolean;
  /**
   * Cumulative per-statement statistics can be snapshotted and diffed over
   * time — "which statements got slower between these two moments".
   *
   * Needs a server-side, cumulative statement digest keyed by a stable id.
   * MySQL has `performance_schema.events_statements_summary_by_digest`
   * (requires performance_schema, on by default), PostgreSQL has
   * `pg_stat_statements` (an extension — the panel detects it and offers to
   * enable it). SQL Server's Query Store is richer than a diff (plan history
   * and forcing — see `queryStore`) and keeps its own panel, so it is
   * deliberately not here.
   */
  stmtStats: boolean;
  /**
   * The engine keeps a HISTORY of query plans, and can be told to use one.
   *
   * Not "has query statistics" — MySQL's digests and PostgreSQL's
   * `pg_stat_statements` both have those, and neither keeps a plan or can pin
   * it. This flag means the two things that make a regression actionable:
   * every plan a query has had, and `sp_query_store_force_plan`.
   */
  queryStore: boolean;
  /**
   * The Maintenance panel: table upkeep — CHECK / ANALYZE / OPTIMIZE / REPAIR,
   * plus the invalid-objects scan — and, on SQLite, file upkeep (VACUUM,
   * integrity checks, ANALYZE). ANALYZE is the one WRITE in the read-only DBA
   * set: the panel pre-flights the server's read-only state before running it
   * (`super_read_only`, `pg_is_in_recovery()`,
   * `DATABASEPROPERTYEX(…, 'Updateability')`). Broader than `sqlDba`, which
   * SQLite lacks.
   */
  maintenance: boolean;
  /** Configuration advice (the tuner). */
  tuner: boolean;
  /** Foreign keys and a schema graph exist to draw. */
  erDiagram: boolean;
  /** Rows can be generated and inserted. */
  dataGen: boolean;
  /** CSV can be loaded into a table. */
  csvImport: boolean;
  /** The SQL quality audit (EXPLAIN + statistics + index advice). */
  sqlQuality: boolean;
  /** Statements can be parameterised with `:name` variables before running. */
  sqlVariables: boolean;
  /** Anything can be written at all. */
  writes: boolean;
  /**
   * The table designer can serve this engine — it has CREATE/ALTER TABLE DDL
   * the designer models. True for the four SQL engines that own real tables;
   * Redis has no tables and Parquet has nothing to write to.
   */
  tableDesigner: boolean;
  /**
   * A server-side ceiling on a single statement can be set.
   *
   * True does not mean it covers writes — on MySQL it does not. See
   * `DEFAULT_STATEMENT_TIMEOUT_SECS` in the backend.
   */
  statementTimeout: boolean;
}

/**
 * The table.
 *
 * Written out per engine rather than derived from predicates like
 * `!isFile`, because a derived rule is a guess about engines that do not
 * exist yet, and the guess is invisible at the point it is wrong.
 */
export const ENGINE_CAPS: Record<Engine, EngineCaps> = {
  mysql: {
    sql: true, transactions: true, databaseSelect: true, processList: true,
    serverInfo: true, sqlDba: true, lockWaits: true, sequences: true, longQueryWatch: true, replication: true,columnProfile: true, dbSearch: true, findUsages: true, dataCompare: true, documenter: true, routines: true, userAdmin: true, fleet: true, playground: true, namespaceDdl: true, stmtStats: true, queryStore: false, maintenance: true, tuner: true, erDiagram: true, dataGen: true,
    csvImport: true, sqlQuality: true, sqlVariables: true, writes: true, tableDesigner: true,
    statementTimeout: true,
  },
  postgres: {
    sql: true, transactions: true, databaseSelect: true, processList: true,
    serverInfo: true, sqlDba: true, lockWaits: true, sequences: true, longQueryWatch: true, replication: true,columnProfile: true, dbSearch: true, findUsages: true, dataCompare: true, documenter: true, routines: true, userAdmin: true, fleet: true, playground: true, namespaceDdl: true, stmtStats: true, queryStore: false, maintenance: true, tuner: true, erDiagram: true, dataGen: true,
    csvImport: true, sqlQuality: true, sqlVariables: true, writes: true, tableDesigner: true,
    statementTimeout: true,
  },
  clickhouse: {
    // A SQL engine, but the DBA surface assumes MySQL/PG catalogs, and it has
    // no interactive transactions. The tuner is the exception: it has its own
    // rule set over the `system.*` operational tables.
    sql: true, transactions: false, databaseSelect: true, processList: true,
    serverInfo: true, sqlDba: false, lockWaits: false, sequences: false, longQueryWatch: false, replication: false,columnProfile: false, dbSearch: false, findUsages: false, dataCompare: false, documenter: false, routines: false, userAdmin: false, fleet: false, playground: false, namespaceDdl: false, stmtStats: false, queryStore: false, maintenance: false, tuner: true, erDiagram: false,
    dataGen: false, csvImport: false, sqlQuality: false, sqlVariables: true,
    // The designer's ClickHouse dialect: CREATE with engine + MergeTree
    // clauses, and the narrow ALTER (columns, TTL) it genuinely has.
    writes: true, tableDesigner: true, statementTimeout: true,
  },
  redis: {
    // Not SQL at all: no catalog, no databases to select in this sense, no
    // statement to bound. CLIENT LIST / CLIENT KILL do give a process list.
    sql: false, transactions: false, databaseSelect: false, processList: true,
    serverInfo: true, sqlDba: false, lockWaits: false, sequences: false, longQueryWatch: false, replication: false,columnProfile: false, dbSearch: false, findUsages: false, dataCompare: false, documenter: false, routines: false, userAdmin: false, fleet: false, playground: false, namespaceDdl: false, stmtStats: false, queryStore: false, maintenance: false, tuner: true, erDiagram: false,
    dataGen: false, csvImport: false, sqlQuality: false, sqlVariables: false,
    writes: true, tableDesigner: false, statementTimeout: false,
  },
  sqlite: {
    // A real SQL engine, but in-process — so there is no server-side anything:
    // no other connections to list, no server settings, no statement ceiling.
    // dataGen stays false: that writer only speaks MySQL/PG wire protocols and
    // refuses SQLite at run time, and a button that fails when clicked is worse
    // than no button (see platformCaps for the doctrine). csvImport IS supported
    // — the importer runs standard multi-row INSERTs over the SQLite pool.
    // sqlQuality stays true: the panel degrades to static lint without EXPLAIN.
    sql: true, transactions: true, databaseSelect: true, processList: false,
    serverInfo: false, sqlDba: false, lockWaits: false, sequences: false, longQueryWatch: false, replication: false,columnProfile: false, dbSearch: false, findUsages: false, dataCompare: false, documenter: false, routines: false, userAdmin: false, fleet: false, playground: false, namespaceDdl: false, stmtStats: false, queryStore: false, maintenance: true, tuner: true, erDiagram: true,
    dataGen: false, csvImport: true, sqlQuality: true, sqlVariables: true,
    writes: true, tableDesigner: true, statementTimeout: false,
  },
  parquet: {
    // A file format. It is read through a query engine, but there is nothing
    // to write to, nothing to tune, and no session.
    sql: true, transactions: false, databaseSelect: true, processList: false,
    serverInfo: false, sqlDba: false, lockWaits: false, sequences: false, longQueryWatch: false, replication: false,columnProfile: false, dbSearch: false, findUsages: false, dataCompare: false, documenter: false, routines: false, userAdmin: false, fleet: false, playground: false, namespaceDdl: false, stmtStats: false, queryStore: false, maintenance: false, tuner: false, erDiagram: false,
    dataGen: false, csvImport: false, sqlQuality: false, sqlVariables: true,
    writes: false, tableDesigner: false, statementTimeout: false,
  },
  duckdb: {
    // A real SQL engine in-process (like SQLite), but OLAP and three-level:
    // catalog → schema → object. No server-side surface: there is no other
    // connection to list and no statement ceiling to set. serverInfo is true —
    // duckdb_settings() backs the variables view. databaseSelect stays false:
    // the default-DB plumbing (set_session_db / USE prefixing) has no DuckDB
    // arm, and a picker that errors when touched is worse than none. dataGen
    // and csvImport stay false — the generator writes MySQL/PG/SQLite INSERTs,
    // and DuckDB imports CSV in SQL (read_csv / COPY), not through the wizard.
    // erDiagram false: the diagram's introspection speaks MySQL/PG catalogs
    // and is not wired to duckdb_constraints(). sqlQuality stays true: EXPLAIN
    // passes through as text and the panel degrades to static lint, as on
    // SQLite. The table designer has no DuckDB dialect; it refuses gracefully.
    sql: true, transactions: true, databaseSelect: false, processList: false,
    serverInfo: true, sqlDba: false, lockWaits: false, sequences: false, longQueryWatch: false, replication: false,columnProfile: false, dbSearch: false, findUsages: false, dataCompare: false, documenter: false, routines: false, userAdmin: false, fleet: false, playground: false, namespaceDdl: false, stmtStats: false, queryStore: false, maintenance: false, tuner: false, erDiagram: false,
    dataGen: false, csvImport: false, sqlQuality: true, sqlVariables: true,
    writes: true, tableDesigner: false, statementTimeout: false,
  },
  mongodb: {
    // Not SQL: the find editor (filter/projection/sort documents) is the query
    // surface, so nothing SQL-shaped applies — no variables, no transactions,
    // no default-DB plumbing, no statement ceiling. processList and serverInfo
    // are real: db.currentOp()/killOp and buildInfo/serverStatus back them.
    // writes stays FALSE on purpose: the v1 driver exposes no write path at
    // all (db/mongodb.rs), so nothing may claim one.
    sql: false, transactions: false, databaseSelect: false, processList: true,
    serverInfo: true, sqlDba: false, lockWaits: false, sequences: false, longQueryWatch: false, replication: false,columnProfile: false, dbSearch: false, findUsages: false, dataCompare: false, documenter: false, routines: false, userAdmin: false, fleet: false, playground: false, namespaceDdl: false, stmtStats: false, queryStore: false, maintenance: false, tuner: false, erDiagram: false,
    dataGen: false, csvImport: false, sqlQuality: false, sqlVariables: false,
    writes: false, tableDesigner: false, statementTimeout: false,
  },
  sqlserver: {
    // A full networked SQL engine (T-SQL dialect exists: keywords, bracket
    // quoting, write guard), so the editor, browser, processlist, kill and
    // server info are real. The rest is honest v1: no EXPLAIN (SHOWPLAN_XML
    // needs session-state handling), no tuner/replication/maintenance rules,
    // no datagen/CSV import, and no default-DB plumbing — the driver uses
    // three-part names and never USE (shared-connection race, db/sqlserver.rs).
    // erDiagram is TRUE: sys.foreign_key_columns gives the column PAIRS a
    // composite FK needs (information_schema splits them across three views and
    // joins by constraint name, which mis-pairs them), and sys.columns carries
    // the length/precision that makes a diagram column readable.
    // Transactions are TRUE and need no pinning: a TDS session is one
    // connection, so every statement already lands on the backend the
    // transaction lives on. `tx_conns` exists to stop a POOL scattering a
    // transaction; there is no pool here, so BEGIN/COMMIT/ROLLBACK run on the
    // session's own client and @@TRANCOUNT is the source of truth. sqlDba
    // false — those panels speak MySQL/PG catalogs; the DMV-backed DBA views
    // (processlist, blocking, waits, …) come through dbaViews instead.
    //
    // statementTimeout is false because SQL Server HAS no such setting, not
    // because it is unimplemented: this flag means "a server-side ceiling on a
    // single statement can be set", and T-SQL offers no per-statement time
    // limit. SET LOCK_TIMEOUT bounds lock waits only, and the query governor is
    // a cost estimate checked before execution, not a clock. The client-side
    // deadline still applies and, since 0.62.0, actually bites: the timer
    // issues the same KILL the Stop button does, and `kill_backend` finally has
    // a SqlServer arm (before, the timer fired and nothing happened).
    sql: true, transactions: true, databaseSelect: false, processList: true,
    serverInfo: true, sqlDba: false, lockWaits: true, sequences: true, longQueryWatch: true, replication: false,columnProfile: true, dbSearch: true, findUsages: true, dataCompare: true, documenter: true, routines: true, userAdmin: true, fleet: true, playground: true, namespaceDdl: true, stmtStats: false, queryStore: true, maintenance: true, tuner: true, erDiagram: true,
    dataGen: true, csvImport: true, sqlQuality: true, sqlVariables: true,
    writes: true, tableDesigner: true, statementTimeout: false,
  },
};

/**
 * Can this engine do this?
 *
 * An engine TxUI does not know is answered `false` for everything rather than
 * defaulting to the permissive SQL row — offering a panel that cannot work is
 * worse than withholding one that could.
 */
export function can(engine: string, cap: keyof EngineCaps): boolean {
  const caps = ENGINE_CAPS[engine as Engine];
  return caps ? caps[cap] : false;
}

/** The engines that can do something — for connection pickers and fleet scopes. */
export function enginesWith(cap: keyof EngineCaps): Engine[] {
  return ENGINES.filter(e => ENGINE_CAPS[e][cap]);
}
