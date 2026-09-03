/**
 * Curated DBA lookups — MySQL sys schema / performance_schema, PostgreSQL
 * statistics views, ClickHouse system tables, SQLite/DuckDB catalogs, and
 * SQL Server DMVs. Each entry is a ready-to-run query rendered in FastGrid
 * by the DBA Views panel.
 */

import type { Capability } from './privileges';

export interface DbaView {
  id: string;
  label: string;
  category: string;
  sql: string;
  description: string;
  /** Shown as a ⚠ badge in the list — why this view can be expensive. */
  demanding?: string;
  /** performance_schema consumers this view depends on. An empty result
   *  usually means one of them is OFF — the panel surfaces an inline hint
   *  (and the fix SQL) instead of a misleadingly empty grid. */
  needsConsumers?: string[];
  /**
   * A capability of the *connected role* this view needs beyond opening the
   * panel — see utils/privileges.ts. The panel greys such an entry and says
   * which grant is missing, instead of running it into a permission error
   * that names a catalog table rather than the fix.
   *
   * Only worth setting where the requirement is narrower than the panel's own:
   * "reads pg_stat_statements", "reads replication state". Tagging every view
   * with the privilege the panel already required would grey the whole list.
   */
  needsPrivilege?: Capability;
  /**
   * Which MySQL-protocol flavours this view applies to. Absent = all of them.
   *
   * MySQL and MariaDB answer the same DBA questions from different places:
   * locks live in `performance_schema.data_locks` on MySQL 8 and in
   * `information_schema.INNODB_LOCKS` on MariaDB, which never grew the former
   * and kept the latter after MySQL deleted it. Replication and GTID share no
   * vocabulary at all. Rather than one query with branches it cannot have —
   * SQL cannot conditionally reference a table that does not exist — each
   * flavour gets its own entry and the panel shows the one that fits.
   *
   * Measured, not assumed: `dev/probe_my_views.mjs` runs every view against
   * MySQL 8.0/8.4 and MariaDB 10.6/10.11/11.4/11.8.
   */
  flavors?: Array<'mysql' | 'mariadb' | 'percona'>;
}

export const DBA_VIEWS: Record<string, DbaView[]> = {
  // ── SQLite ────────────────────────────────────────────────────────────────
  // Everything here is read-only catalog access: sqlite_master, the PRAGMA
  // table-valued functions (SQLite 3.16+) and dbstat, which reports real
  // page-level storage per object.
  sqlite: [
    { id: 'sq-space', label: 'Space usage', category: 'Storage',
      sql: `SELECT (SELECT * FROM pragma_page_size)     AS page_size,
                   (SELECT * FROM pragma_page_count)    AS pages,
                   (SELECT * FROM pragma_freelist_count) AS free_pages,
                   (SELECT * FROM pragma_page_size) * (SELECT * FROM pragma_page_count) AS total_bytes,
                   (SELECT * FROM pragma_page_size) * (SELECT * FROM pragma_freelist_count) AS free_bytes,
                   round(100.0 * (SELECT * FROM pragma_freelist_count)
                         / nullif((SELECT * FROM pragma_page_count), 0), 1) AS free_pct`,
      description: 'File size in pages and how much of it is on the freelist. SQLite never shrinks a file on its own — freelist pages are reused but not returned to the filesystem until VACUUM' },
    { id: 'sq-tables', label: 'Table sizes', category: 'Storage',
      sql: `SELECT name, sum(pgsize) AS bytes, count(*) AS pages,
                   sum(unused) AS unused_bytes,
                   round(100.0 * sum(unused) / nullif(sum(pgsize), 0), 1) AS unused_pct,
                   max(pgsize) AS largest_page
            FROM dbstat WHERE name NOT LIKE 'sqlite_%'
            GROUP BY name ORDER BY sum(pgsize) DESC`,
      description: 'Real on-disk bytes per table and index, straight from dbstat — SQLite has no size column anywhere else. A high unused percentage is internal fragmentation that only VACUUM reclaims',
      demanding: 'dbstat walks every page of the database file' },
    { id: 'sq-index-space', label: 'Index vs table space', category: 'Storage',
      sql: `SELECT m.tbl_name AS "table",
                   sum(CASE WHEN m.type = 'table' THEN d.pgsize ELSE 0 END) AS table_bytes,
                   sum(CASE WHEN m.type = 'index' THEN d.pgsize ELSE 0 END) AS index_bytes,
                   round(1.0 * sum(CASE WHEN m.type = 'index' THEN d.pgsize ELSE 0 END)
                         / nullif(sum(CASE WHEN m.type = 'table' THEN d.pgsize ELSE 0 END), 0), 2) AS index_ratio
            FROM dbstat d JOIN sqlite_master m ON m.name = d.name
            WHERE m.tbl_name NOT LIKE 'sqlite_%'
            GROUP BY m.tbl_name ORDER BY index_bytes DESC`,
      description: 'How much of each table\'s storage is its indexes. A ratio well above 1 means the indexes cost more than the data — worth knowing before adding another one',
      demanding: 'dbstat walks every page of the database file' },

    { id: 'sq-objects', label: 'Objects', category: 'Schema',
      sql: `SELECT type, name, tbl_name, rootpage,
                   length(sql) AS ddl_length
            FROM sqlite_master ORDER BY type, name`,
      description: 'Everything in the database, including the auto-created indexes that back UNIQUE and PRIMARY KEY constraints (those have a NULL sql — SQLite made them, nobody wrote them)' },
    { id: 'sq-columns', label: 'All columns', category: 'Schema',
      sql: `SELECT m.name AS "table", p.cid, p.name AS column, p.type,
                   p."notnull" AS not_null, p.dflt_value AS default_value, p.pk,
                   CASE p.hidden WHEN 2 THEN 'VIRTUAL' WHEN 3 THEN 'STORED' END AS generated
            FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p
            WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'
              AND p.hidden <> 1
            ORDER BY m.name, p.cid`,
      description: 'Every column of every table and view. It reads table_xinfo, not table_info, because table_info silently omits generated columns — a table declared with one appeared here short a column. An empty type is legal and meaningful: SQLite columns can be declared without one, and such a column has no type affinity at all. hidden=1 columns are excluded — those are a virtual table module\'s internals, not anything anyone declared' },
    { id: 'sq-index-cols', label: 'Index columns', category: 'Schema',
      sql: `SELECT m.name AS "table", i.name AS index_name, i."unique", i.origin, i.partial,
                   x.seqno, x.name AS column, x.desc, x.coll, x.key
            FROM sqlite_master m
            JOIN pragma_index_list(m.name) i
            JOIN pragma_index_xinfo(i.name) x
            WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND x.key = 1
            ORDER BY m.name, i.name, x.seqno`,
      description: 'Index columns in order, with collation and direction. `origin` says where the index came from: c = CREATE INDEX, u = UNIQUE constraint, pk = PRIMARY KEY' },
    { id: 'sq-fks', label: 'Foreign keys', category: 'Schema',
      sql: `SELECT m.name AS child_table, f."table" AS parent_table,
                   f."from" AS child_column, f."to" AS parent_column,
                   f.on_update, f.on_delete, f.match
            FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
            WHERE m.type = 'table'
            ORDER BY m.name, f.id, f.seq`,
      description: 'Declared foreign keys. SQLite records them whether or not enforcement is on — and `PRAGMA foreign_keys` defaults to OFF, per connection, so a schema full of FKs may never have enforced one. TxUI turns enforcement ON for its own connections, which is stricter than the application that wrote the file probably was: a DELETE that works elsewhere can be refused here, and that refusal is the correct answer' },
    { id: 'sq-unindexed-fks', label: 'Foreign keys without an index', category: 'Schema',
      sql: `SELECT m.name AS child_table, f."from" AS child_column, f."table" AS parent_table
            FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
            WHERE m.type = 'table'
              AND NOT EXISTS (
                SELECT 1 FROM pragma_index_list(m.name) i
                JOIN pragma_index_xinfo(i.name) x ON x.key = 1 AND x.seqno = 0
                WHERE x.name = f."from")
            ORDER BY m.name`,
      description: 'The classic SQLite performance bug: a child column with a foreign key but no index on it. Every parent DELETE or key UPDATE then scans the whole child table, and with enforcement on that happens on every such statement' },
    { id: 'sq-no-pk', label: 'Tables without a PRIMARY KEY', category: 'Schema',
      sql: `SELECT m.name AS "table",
                   (SELECT count(*) FROM pragma_table_info(m.name) p WHERE p.pk > 0) AS pk_columns
            FROM sqlite_master m
            WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
              AND (SELECT count(*) FROM pragma_table_info(m.name) p WHERE p.pk > 0) = 0
            ORDER BY m.name`,
      description: 'Tables relying on the implicit rowid. That is legal and fast, but the rowid is not stable across VACUUM, so anything storing it as a reference will silently point somewhere else afterwards' },

    { id: 'sq-integrity', label: 'Integrity check', category: 'Integrity',
      sql: `SELECT * FROM pragma_quick_check`,
      description: 'SQLite checking its own B-trees and indexes. "ok" is the answer you want; anything else names a corrupted page or index',
      demanding: 'reads every page of the database' },
    { id: 'sq-fk-check', label: 'Foreign key violations', category: 'Integrity',
      sql: `SELECT * FROM pragma_foreign_key_check`,
      description: 'Rows that break a declared foreign key. Because enforcement defaults to OFF, a database can accumulate these silently for years — an empty result is the healthy one' },
    { id: 'sq-analyze', label: 'Planner statistics (ANALYZE)', category: 'Integrity',
      sql: `SELECT tbl AS "table", idx AS index_name, stat
            FROM sqlite_stat1 ORDER BY tbl, idx`,
      description: 'What ANALYZE recorded for the query planner. If sqlite_stat1 does not exist, ANALYZE has never been run and every plan is being chosen from built-in guesses — the panel explains the fix' },

    { id: 'sq-settings', label: 'Settings', category: 'Config',
      // `scope` is the column that makes this readable. Half of these live in
      // the file and describe it; the other half describe *this connection*
      // and vanish when it closes. Without the distinction the table invites
      // the reader to change something here and expect it to stick.
      // mmap_size and wal_autocheckpoint are absent because they have no
      // table-valued form — SQLite lets you set them but not SELECT them.
      sql: `SELECT 'journal_mode' AS setting, (SELECT * FROM pragma_journal_mode) AS value, 'file' AS scope
            UNION ALL SELECT 'auto_vacuum',        (SELECT * FROM pragma_auto_vacuum),        'file'
            UNION ALL SELECT 'page_size',          (SELECT * FROM pragma_page_size),          'file'
            UNION ALL SELECT 'encoding',           (SELECT * FROM pragma_encoding),           'file'
            UNION ALL SELECT 'user_version',       (SELECT * FROM pragma_user_version),       'file'
            UNION ALL SELECT 'application_id',     (SELECT * FROM pragma_application_id),     'file'
            UNION ALL SELECT 'page_count',         (SELECT * FROM pragma_page_count),         'file'
            UNION ALL SELECT 'freelist_count',     (SELECT * FROM pragma_freelist_count),     'file'
            UNION ALL SELECT 'data_version',       (SELECT * FROM pragma_data_version),       'file'
            UNION ALL SELECT 'synchronous',        (SELECT * FROM pragma_synchronous),        'connection'
            UNION ALL SELECT 'foreign_keys',       (SELECT * FROM pragma_foreign_keys),       'connection'
            UNION ALL SELECT 'busy_timeout',       (SELECT * FROM pragma_busy_timeout),       'connection'
            UNION ALL SELECT 'cache_size',         (SELECT * FROM pragma_cache_size),         'connection'
            UNION ALL SELECT 'cache_spill',        (SELECT * FROM pragma_cache_spill),        'connection'
            UNION ALL SELECT 'temp_store',         (SELECT * FROM pragma_temp_store),         'connection'
            UNION ALL SELECT 'locking_mode',       (SELECT * FROM pragma_locking_mode),       'connection'
            UNION ALL SELECT 'journal_size_limit', (SELECT * FROM pragma_journal_size_limit), 'connection'
            UNION ALL SELECT 'secure_delete',      (SELECT * FROM pragma_secure_delete),      'connection'
            UNION ALL SELECT 'recursive_triggers', (SELECT * FROM pragma_recursive_triggers), 'connection'
            UNION ALL SELECT 'automatic_index',    (SELECT * FROM pragma_automatic_index),    'connection'
            UNION ALL SELECT 'analysis_limit',     (SELECT * FROM pragma_analysis_limit),     'connection'
            UNION ALL SELECT 'threads',            (SELECT * FROM pragma_threads),            'connection'
            UNION ALL SELECT 'trusted_schema',     (SELECT * FROM pragma_trusted_schema),     'connection'
            UNION ALL SELECT 'query_only',         (SELECT * FROM pragma_query_only),         'connection'
            UNION ALL SELECT 'ignore_check_constraints', (SELECT * FROM pragma_ignore_check_constraints), 'connection'
            UNION ALL SELECT 'legacy_alter_table', (SELECT * FROM pragma_legacy_alter_table), 'connection'
            UNION ALL SELECT 'fullfsync',          (SELECT * FROM pragma_fullfsync),          'connection'
            UNION ALL SELECT 'checkpoint_fullfsync', (SELECT * FROM pragma_checkpoint_fullfsync), 'connection'
            UNION ALL SELECT 'max_page_count',     (SELECT * FROM pragma_max_page_count),     'connection'`,
      description: 'Every setting SQLite will report, with the one thing that decides how to read it: `scope`. **file** means it is stored in the database and every program that opens it sees the same value — changing it changes the file. **connection** means it belongs to this session only and says nothing about how the file is normally used; the application that owns this database may run with entirely different values. Two consequences worth knowing: `synchronous` is per connection but its default is decided by how SQLite was compiled — TxUI bundles its own, which reports FULL even for a WAL database, where the `sqlite3` on your Mac would say NORMAL for the same file. And `foreign_keys` reads 1 because TxUI turns it on, not because the file asks for it. See docs/SQLITE_PRAGMAS.md' },
    { id: 'sq-version', label: 'Library version', category: 'Config',
      sql: `SELECT sqlite_version() AS version, sqlite_source_id() AS source_id`,
      description: 'The SQLite compiled into this app — which is what actually reads the file, regardless of what wrote it' },
    { id: 'sq-compile', label: 'Compile options', category: 'Config',
      sql: `SELECT * FROM pragma_compile_options ORDER BY 1`,
      description: 'How this SQLite was built. Determines which features exist at all — FTS, JSON1, R*Tree, dbstat and the rest' },
  ],

  // ── Parquet ───────────────────────────────────────────────────────────────
  // Not SQL: these are commands the Parquet driver interprets (see
  // db/parquet.rs), the same way the Redis views carry Redis commands.
  parquet: [
    { id: 'pq-file', label: 'File info', category: 'File',
      sql: 'FILEINFO',
      description: 'Format version, the writer that produced the file, row and row-group counts, total compressed vs uncompressed size, and whether the column/offset indexes are present' },
    { id: 'pq-schema', label: 'Schema', category: 'File',
      sql: 'SCHEMA',
      description: 'Leaf columns with physical and logical type, repetition, and definition/repetition levels. Parquet stores leaves, so a struct or list shows up as several of them' },
    { id: 'pq-keyvalue', label: 'Key/value metadata', category: 'File',
      sql: 'KEYVALUE',
      description: 'Arbitrary metadata the writer embedded — this is where pandas, Arrow and Spark record their own schema, and where a producer stamps provenance' },
    { id: 'pq-rowgroups', label: 'Row groups', category: 'Storage',
      sql: 'ROWGROUPS',
      description: 'Rows, size and compression ratio per row group. The row group is Parquet\'s unit of parallelism and of skipping — very many tiny ones, or one enormous one, are both problems' },
    { id: 'pq-columnchunks', label: 'Column chunks', category: 'Storage',
      sql: 'COLUMNCHUNKS',
      description: 'One row per (row group, column): codec, encodings, sizes, min/max, null and distinct counts, and whether a bloom filter is present. Min/max is what lets a reader skip a whole chunk, so its absence is why a query reads everything' },
    { id: 'pq-stats', label: 'Column totals', category: 'Storage',
      sql: 'STATS',
      description: 'Per-column totals across every row group, largest first — which columns actually make up the file, and which codec each is paying for' },
    { id: 'pq-codecs', label: 'Codecs', category: 'Storage',
      sql: 'CODECS',
      description: 'Bytes per compression codec across the whole file, with the ratio each achieves. Compression is set per column chunk, so one file can mix several — and an UNCOMPRESSED chunk is usually an unset writer property rather than a decision' },
    { id: 'pq-skew', label: 'Size skew across row groups', category: 'Storage',
      sql: 'SKEW',
      description: 'How unevenly each column\'s bytes are spread across row groups, worst ratio first. A column that is tiny in most groups and huge in one is where a scan actually stalls' },
    { id: 'pq-pages', label: 'Pages', category: 'Storage',
      sql: 'PAGES',
      description: 'Per-page min/max, null count, offset and size from the page index — the finest granularity Parquet exposes, and the level a reader really skips at. A chunk with useful bounds can still be unskippable page by page if the data is unsorted' },

    { id: 'pq-encodings', label: 'Encodings & dictionary', category: 'Encoding',
      sql: 'ENCODINGS',
      description: 'Which encodings each column uses, and whether dictionary encoding survived. A writer that starts with a dictionary and outgrows its page limit silently falls back to PLAIN — those chunks are far larger, and that fallback is invisible everywhere except here' },
    { id: 'pq-bloom', label: 'Bloom filters', category: 'Encoding',
      sql: 'BLOOM',
      description: 'Which columns carry a bloom filter. Bloom filters prune equality predicates that min/max cannot touch on unsorted data — without one, `WHERE col = x` reads every chunk' },
    { id: 'pq-sorting', label: 'Sort order', category: 'Encoding',
      sql: 'SORTING',
      description: 'The sort order each row group declares. Sorting is what makes min/max statistics selective: unsorted, chunk ranges overlap and prune almost nothing. It is the single biggest read-time win available to a Parquet file' },

    { id: 'pq-nulls', label: 'Null density', category: 'Data shape',
      sql: 'NULLS',
      description: 'Nulls per column against the row count, emptiest first. An all-null column is storage spent on nothing; a column declared OPTIONAL that is never null pays a definition level per value for no reason' },
    { id: 'pq-cardinality', label: 'Cardinality', category: 'Data shape',
      sql: 'CARDINALITY',
      description: 'Distinct counts where the writer recorded them, against the row count. Summed per row group, so it is an upper bound rather than the exact file-wide count — a low ratio is a dictionary/LowCardinality candidate, a high one is a good filter target' },

    { id: 'pq-health', label: 'File health', category: 'Health',
      sql: 'HEALTH',
      description: 'A findings report for the file, worst first: row-group sizing, columns with no statistics (nothing can be skipped on them), dictionary fallback, uncompressed chunks, all-null columns, missing page index and missing sort order. All derived from the footer, so it costs nothing to run' },
  ],

  // ── DuckDB ──────────────────────────────────────────────────────────────────
  // The catalog is a set of built-in table functions (duckdb_tables(),
  // duckdb_settings(), …), each spanning every attached database. All of this
  // is read-only catalog access.
  //
  // `internal` is NOT a universal column of these functions: tables, views,
  // columns, functions and databases carry it, but duckdb_indexes(),
  // duckdb_constraints() and duckdb_sequences() do not — they list user
  // objects only. A `WHERE NOT internal` there is a binder error, not an
  // empty result, so those three filter nothing rather than filtering wrong.
  // The attached-database list also spells it `readonly`, not `read_only`.
  duckdb: [
    { id: 'dd-dbs', label: 'Attached databases', category: 'Config',
      sql: `SELECT database_name, path, type, readonly, internal
            FROM duckdb_databases() ORDER BY internal, database_name`,
      description: 'Every attached catalog: the file this connection opened (or `memory` for a :memory: scratch database) plus anything ATTACHed since. `readonly` here is DuckDB\'s own access_mode — on a read-only connection it is the engine, not the app, refusing the write' },
    { id: 'dd-version', label: 'Version & context', category: 'Config',
      sql: `SELECT version() AS version, current_database() AS current_database,
                   current_schema() AS current_schema`,
      description: 'The DuckDB library compiled into this app, and the catalog/schema unqualified names resolve against right now' },
    { id: 'dd-settings', label: 'Settings', category: 'Config',
      sql: `SELECT name, value, input_type, scope, aliases
            FROM duckdb_settings() ORDER BY name`,
      description: 'Every engine setting. `scope` is the column that makes this readable: GLOBAL settings persist for the database, LOCAL ones belong to this session and vanish when it closes — changing a LOCAL value here says nothing about how the file is normally used' },
    { id: 'dd-extensions', label: 'Extensions', category: 'Config',
      sql: `SELECT extension_name, loaded, installed, extension_version, install_mode
            FROM duckdb_extensions() ORDER BY loaded DESC, installed DESC, extension_name`,
      description: 'What this DuckDB can do beyond the core — the readers (parquet, json), the database attachments (postgres, mysql, sqlite) and the rest. `installed` but not `loaded` means INSTALL worked and LOAD has not happened in this session' },

    { id: 'dd-tables', label: 'Tables', category: 'Schema',
      sql: `SELECT database_name, schema_name, table_name, estimated_size AS rows,
                   column_count, index_count, has_primary_key, temporary
            FROM duckdb_tables() WHERE NOT internal
            ORDER BY estimated_size DESC`,
      description: 'Every base table in every attached database, largest first. `estimated_size` is exact for a base table — no COUNT(*) scan is involved. `has_primary_key = false` is worth noticing: without one, nothing stops a duplicate row' },
    { id: 'dd-views', label: 'Views', category: 'Schema',
      sql: `SELECT database_name, schema_name, view_name, column_count
            FROM duckdb_views() WHERE NOT internal
            ORDER BY database_name, schema_name, view_name`,
      description: 'Every view in every attached database' },
    { id: 'dd-columns', label: 'All columns', category: 'Schema',
      sql: `SELECT database_name, schema_name, table_name, column_index, column_name,
                   data_type, is_nullable, column_default AS default_value
            FROM duckdb_columns() WHERE NOT internal
            ORDER BY database_name, schema_name, table_name, column_index`,
      description: 'Every column of every table and view, in declared order' },
    { id: 'dd-indexes', label: 'Indexes', category: 'Schema',
      sql: `SELECT database_name, schema_name, table_name, index_name,
                   is_unique, is_primary, sql
            FROM duckdb_indexes()
            ORDER BY database_name, schema_name, table_name, index_name`,
      description: 'Every index with its CREATE statement — duckdb_indexes() has no column list, so the statement is the record. DuckDB indexes are ART: they exist mostly to back constraints, since the real read-time pruning mechanism is the per-column zonemap, not the index' },
    { id: 'dd-constraints', label: 'Constraints', category: 'Schema',
      sql: `SELECT database_name, schema_name, table_name, constraint_name,
                   constraint_type, constraint_column_names, referenced_table
            FROM duckdb_constraints()
            ORDER BY database_name, schema_name, table_name, constraint_name`,
      description: 'PRIMARY KEY, FOREIGN KEY, UNIQUE and CHECK constraints across every attached database. A FOREIGN KEY here is enforced — DuckDB rejects the write, there is no "declared but off" mode as with SQLite' },
    { id: 'dd-macros', label: 'Macros', category: 'Schema',
      sql: `SELECT database_name, schema_name, function_name, function_type, parameters
            FROM duckdb_functions()
            WHERE NOT internal AND function_type IN ('macro', 'table_macro')
            ORDER BY database_name, schema_name, function_name`,
      description: 'User-defined macros — the stored SQL snippets a DuckDB file accumulates. A macro-heavy file is where analytical workflows live, and these are otherwise invisible outside duckdb_functions()' },
    { id: 'dd-sequences', label: 'Sequences', category: 'Schema',
      sql: `SELECT database_name, schema_name, sequence_name, start_value,
                   increment_by, min_value, max_value, cycle
            FROM duckdb_sequences()
            ORDER BY database_name, schema_name, sequence_name`,
      description: 'Every sequence. `cycle = false` means the sequence ERRORS when it exhausts its range rather than wrapping — the default, and the thing to check before blaming a surrogate key' },
  ],
  mysql: [
    // ── Setup ──
    { id: 'setup-check', label: 'Setup check', category: 'Setup',
      sql: "SELECT 'performance_schema' AS `check`, IF(@@global.performance_schema = 1, 'ON', 'OFF') AS status, "
        + "IF(@@global.performance_schema = 1, 'ok', 'Set performance_schema=ON in my.cnf and restart — cannot be changed at runtime') AS how_to_fix "
        + "UNION ALL "
        + "SELECT CONCAT('consumer ', NAME), ENABLED, "
        + "IF(ENABLED = 'YES', 'ok', CONCAT(\"UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME='\", NAME, \"';\")) "
        + "FROM performance_schema.setup_consumers "
        + "WHERE NAME IN ('events_statements_current','events_statements_history','events_statements_history_long',"
        + "'events_stages_current','statements_digest','global_instrumentation','thread_instrumentation') "
        + "UNION ALL "
        + "SELECT 'instruments statement/%', CONCAT(SUM(ENABLED = 'YES'), '/', COUNT(*), ' enabled'), "
        + "IF(SUM(ENABLED = 'YES') = COUNT(*), 'ok', \"UPDATE performance_schema.setup_instruments SET ENABLED='YES', TIMED='YES' WHERE NAME LIKE 'statement/%';\") "
        + "FROM performance_schema.setup_instruments WHERE NAME LIKE 'statement/%' "
        + "UNION ALL "
        + "SELECT 'sys schema', IF(COUNT(*) = 1, 'present', 'missing'), "
        + "IF(COUNT(*) = 1, 'ok', 'Install via mysql_upgrade — MySQL 5.7.7+/8.0 ships it; MariaDB includes a sys compatibility schema since 10.6') "
        + "FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'sys' "
        + "UNION ALL SELECT 'version', @@version, 'info'",
      description: 'Run FIRST — performance_schema state, key consumers, instrument coverage, sys schema presence. Explains every empty digest/stage view.' },

    // ── Realtime ──
    { id: 'rt-current', label: 'Statements in flight', category: 'Realtime',
      sql: "SELECT t.PROCESSLIST_ID AS conn_id, t.PROCESSLIST_USER AS user, t.PROCESSLIST_HOST AS host, t.PROCESSLIST_DB AS db, "
        + "s.EVENT_NAME, ROUND(s.TIMER_WAIT/1e9, 1) AS ms, s.ROWS_EXAMINED, s.ROWS_SENT, LEFT(s.SQL_TEXT, 300) AS query "
        + "FROM performance_schema.events_statements_current s "
        + "JOIN performance_schema.threads t ON t.THREAD_ID = s.THREAD_ID "
        + "WHERE s.SQL_TEXT IS NOT NULL ORDER BY s.TIMER_WAIT DESC LIMIT 200",
      needsPrivilege: 'processlist-all',
      description: 'What every thread is executing right now, with live latency (MySQL 8.0 timing units)',
      demanding: 'joins the full current-statements ring buffer; hot on busy servers',
      needsConsumers: ['events_statements_current'] },
    { id: 'rt-session', label: 'Session overview (sys.session)', category: 'Realtime',
      sql: 'SELECT * FROM sys.session LIMIT 200',
      needsPrivilege: 'processlist-all',
      description: 'Rich per-connection view: current statement, latency, memory, IO — heavier sibling of SHOW PROCESSLIST',
      demanding: 'joins memory + statement summaries per session' },
    { id: 'rt-95th', label: '95th-percentile statements', category: 'Realtime',
      sql: 'SELECT * FROM sys.statements_with_runtimes_in_95th_percentile LIMIT 200',
      needsPrivilege: 'processlist-all',
      description: 'Digests whose runtime sits in the slowest 5% — the real outliers',
      demanding: 'full group-by over the digest table',
      needsConsumers: ['statements_digest'] },
    { id: 'rt-analysis', label: 'Statement analysis (digests)', category: 'Realtime',
      sql: 'SELECT * FROM sys.statement_analysis LIMIT 200',
      needsPrivilege: 'processlist-all',
      description: 'Formatted digest table: exec count, latency (total/avg/max), rows, tmp tables, full scans',
      demanding: 'scans all digests',
      needsConsumers: ['statements_digest'] },
    { id: 'rt-io-waits', label: 'IO waits by event', category: 'Realtime',
      sql: 'SELECT * FROM sys.io_global_by_wait_by_latency LIMIT 50',
      needsPrivilege: 'processlist-all',
      description: 'Global IO latency by wait event — is the server read- or write-bound' },
    { id: 'rt-memory', label: 'Memory by event', category: 'Realtime',
      sql: 'SELECT * FROM sys.memory_global_by_current_bytes LIMIT 100',
      needsPrivilege: 'processlist-all',
      description: 'Current memory allocation by instrument — what is actually holding RAM' },

    // ── Queries ──
    { id: 'stmt-latency', label: 'Top statements by latency', category: 'Queries',
      sql: 'SELECT SCHEMA_NAME AS db, COUNT_STAR AS exec_count, ROUND(SUM_TIMER_WAIT/1e9, 1) AS total_ms, ROUND(AVG_TIMER_WAIT/1e9, 3) AS avg_ms, SUM_ROWS_EXAMINED AS rows_examined, SUM_ROWS_SENT AS rows_sent, SUM_NO_INDEX_USED AS no_index, SUM_CREATED_TMP_DISK_TABLES AS tmp_disk, SUM_SORT_MERGE_PASSES AS sort_merges, SUM_ERRORS AS errors, SUM_WARNINGS AS warnings, LAST_SEEN AS last_seen, DIGEST_TEXT AS query FROM performance_schema.events_statements_summary_by_digest ORDER BY SUM_TIMER_WAIT DESC LIMIT 200',
      needsPrivilege: 'statement-stats',
      description: 'sys.statement_analysis — normalized statements, worst total latency first. db is NULL for statements run without a selected schema (shown, not filtered out).',
      demanding: 'scans all digests', needsConsumers: ['statements_digest'] },
    { id: 'stmt-fullscan', label: 'Statements with full table scans', category: 'Queries',
      sql: 'SELECT SCHEMA_NAME AS db, COUNT_STAR AS exec_count, ROUND(SUM_TIMER_WAIT/1e9, 1) AS total_ms, ROUND(AVG_TIMER_WAIT/1e9, 3) AS avg_ms, SUM_ROWS_EXAMINED AS rows_examined, SUM_ROWS_SENT AS rows_sent, SUM_NO_INDEX_USED AS no_index, SUM_CREATED_TMP_DISK_TABLES AS tmp_disk, SUM_SORT_MERGE_PASSES AS sort_merges, SUM_ERRORS AS errors, SUM_WARNINGS AS warnings, LAST_SEEN AS last_seen, DIGEST_TEXT AS query FROM performance_schema.events_statements_summary_by_digest WHERE SUM_NO_INDEX_USED > 0 ORDER BY SUM_TIMER_WAIT DESC LIMIT 200',
      needsPrivilege: 'statement-stats',
      description: 'Statements not using an index',
      demanding: 'scans all digests', needsConsumers: ['statements_digest'] },
    { id: 'stmt-temp', label: 'Statements using temp tables', category: 'Queries',
      sql: 'SELECT SCHEMA_NAME AS db, COUNT_STAR AS exec_count, ROUND(SUM_TIMER_WAIT/1e9, 1) AS total_ms, ROUND(AVG_TIMER_WAIT/1e9, 3) AS avg_ms, SUM_ROWS_EXAMINED AS rows_examined, SUM_ROWS_SENT AS rows_sent, SUM_NO_INDEX_USED AS no_index, SUM_CREATED_TMP_DISK_TABLES AS tmp_disk, SUM_SORT_MERGE_PASSES AS sort_merges, SUM_ERRORS AS errors, SUM_WARNINGS AS warnings, LAST_SEEN AS last_seen, DIGEST_TEXT AS query FROM performance_schema.events_statements_summary_by_digest WHERE SUM_CREATED_TMP_DISK_TABLES > 0 ORDER BY SUM_CREATED_TMP_DISK_TABLES DESC LIMIT 200',
      needsPrivilege: 'statement-stats',
      description: 'Disk temp tables are the interesting column',
      demanding: 'scans all digests', needsConsumers: ['statements_digest'] },
    { id: 'stmt-errors', label: 'Statements with errors / warnings', category: 'Queries',
      sql: 'SELECT SCHEMA_NAME AS db, COUNT_STAR AS exec_count, ROUND(SUM_TIMER_WAIT/1e9, 1) AS total_ms, ROUND(AVG_TIMER_WAIT/1e9, 3) AS avg_ms, SUM_ROWS_EXAMINED AS rows_examined, SUM_ROWS_SENT AS rows_sent, SUM_NO_INDEX_USED AS no_index, SUM_CREATED_TMP_DISK_TABLES AS tmp_disk, SUM_SORT_MERGE_PASSES AS sort_merges, SUM_ERRORS AS errors, SUM_WARNINGS AS warnings, LAST_SEEN AS last_seen, DIGEST_TEXT AS query FROM performance_schema.events_statements_summary_by_digest WHERE SUM_ERRORS > 0 OR SUM_WARNINGS > 0 ORDER BY SUM_ERRORS DESC, SUM_WARNINGS DESC LIMIT 200',
      needsPrivilege: 'statement-stats',
      description: 'Normalized statements that raised errors or warnings',
      demanding: 'scans all digests', needsConsumers: ['statements_digest'] },
    { id: 'stmt-sorting', label: 'Statements with sorting', category: 'Queries',
      sql: 'SELECT SCHEMA_NAME AS db, COUNT_STAR AS exec_count, ROUND(SUM_TIMER_WAIT/1e9, 1) AS total_ms, ROUND(AVG_TIMER_WAIT/1e9, 3) AS avg_ms, SUM_ROWS_EXAMINED AS rows_examined, SUM_ROWS_SENT AS rows_sent, SUM_NO_INDEX_USED AS no_index, SUM_CREATED_TMP_DISK_TABLES AS tmp_disk, SUM_SORT_MERGE_PASSES AS sort_merges, SUM_ERRORS AS errors, SUM_WARNINGS AS warnings, LAST_SEEN AS last_seen, DIGEST_TEXT AS query FROM performance_schema.events_statements_summary_by_digest WHERE SUM_SORT_MERGE_PASSES > 0 OR SUM_SORT_ROWS > 0 ORDER BY SUM_SORT_MERGE_PASSES DESC LIMIT 200',
      needsPrivilege: 'statement-stats',
      description: 'Sort-heavy statements (filesorts, sort merge passes)',
      demanding: 'scans all digests', needsConsumers: ['statements_digest'] },

    // ── Indexes & schema ──
    { id: 'idx-unused', label: 'Unused indexes', category: 'Indexes & schema',
      sql: 'SELECT * FROM sys.schema_unused_indexes LIMIT 200',
      description: 'Indexes with no reads since server start — drop candidates' },
    { id: 'idx-redundant', label: 'Redundant indexes', category: 'Indexes & schema',
      sql: 'SELECT * FROM sys.schema_redundant_indexes LIMIT 200',
      description: 'Indexes made redundant by another index' },
    { id: 'tbl-sizes', label: 'Table sizes', category: 'Indexes & schema',
      sql: "SELECT table_schema, table_name, engine, table_rows, \
ROUND((data_length+index_length)/1024/1024, 1) AS total_mb, \
ROUND(data_length/1024/1024, 1) AS data_mb, ROUND(index_length/1024/1024, 1) AS index_mb, \
ROUND(data_free/1024/1024, 1) AS free_mb \
FROM information_schema.tables WHERE table_schema NOT IN ('mysql','sys','performance_schema','information_schema') \
ORDER BY data_length + index_length DESC LIMIT 100",
      description: 'Largest tables with index size and free (fragmented) space',
      demanding: 'heavy on many tables — full information_schema scan' },
    { id: 'auto-inc', label: 'Auto-increment usage', category: 'Indexes & schema',
      sql: 'SELECT * FROM sys.schema_auto_increment_columns ORDER BY auto_increment_ratio DESC LIMIT 50',
      description: 'Columns approaching their auto-increment limit',
      demanding: 'heavy on many tables — full information_schema scan' },
    { id: 'tbl-stats', label: 'Table IO statistics', category: 'Indexes & schema',
      sql: 'SELECT * FROM sys.schema_table_statistics LIMIT 50',
      description: 'Read/write latency per table' },
    { id: 'tbl-fullscan', label: 'Tables with full scans', category: 'Indexes & schema',
      sql: 'SELECT * FROM sys.schema_tables_with_full_table_scans LIMIT 100',
      description: 'Tables repeatedly read without an index — index candidates',
      demanding: 'joins table IO summaries for every table',
      needsConsumers: ['statements_digest'] },

    // ── Locks & transactions ──
    { id: 'lock-check', label: 'Lock instrumentation status', category: 'Locks',
      sql: "SELECT 'data_locks (always on in 8.0)' AS feature, 'yes' AS available "
        + "UNION ALL SELECT CONCAT('instrument ', NAME), ENABLED FROM performance_schema.setup_instruments "
        + "WHERE NAME IN ('wait/lock/metadata/sql/mdl') "
        + "UNION ALL SELECT CONCAT('consumer ', NAME), ENABLED FROM performance_schema.setup_consumers "
        + "WHERE NAME IN ('global_instrumentation','thread_instrumentation','events_waits_current')",
      needsPrivilege: 'processlist-all',
      description: 'Run FIRST — confirms whether lock data is actually collected (an empty lock view can mean "no contention" OR "instrumentation off")' },
    { id: 'lock-waits', label: 'InnoDB lock waits', category: 'Locks',
      sql: 'SELECT * FROM sys.innodb_lock_waits',
      needsPrivilege: 'processlist-all',
      description: '0 rows = no current row-lock contention (healthy). Needs performance_schema data_locks/data_lock_waits (on by default in 8.0).' },
    { id: 'data-locks', label: 'Current data locks', category: 'Locks',
      flavors: ['mysql', 'percona'],
      sql: 'SELECT engine_transaction_id, thread_id, object_schema, object_name, lock_type, lock_mode, lock_status, lock_data FROM performance_schema.data_locks LIMIT 200',
      needsPrivilege: 'processlist-all',
      description: 'Raw currently-held locks. 0 rows = nothing locked right now (data_locks is always available in MySQL 8.0).' },
    // MariaDB never grew performance_schema.data_locks and still has the
    // INNODB_LOCKS pair MySQL 8 removed, so the same question is asked of a
    // different catalog. Joined to INNODB_LOCK_WAITS because a lock nobody is
    // waiting on is rarely the one being looked for.
    { id: 'data-locks-maria', label: 'Current data locks', category: 'Locks',
      flavors: ['mariadb'],
      sql: 'SELECT l.lock_trx_id AS trx_id, l.lock_table AS object_name, l.lock_index AS index_name, '
        + 'l.lock_type, l.lock_mode, w.requesting_trx_id AS waiting_trx, w.blocking_trx_id AS blocking_trx '
        + 'FROM information_schema.INNODB_LOCKS l '
        + 'LEFT JOIN information_schema.INNODB_LOCK_WAITS w ON w.requested_lock_id = l.lock_id LIMIT 200',
      needsPrivilege: 'processlist-all',
      description: 'Raw currently-held locks, from INNODB_LOCKS — MariaDB has no performance_schema.data_locks. 0 rows = nothing locked right now.' },
    { id: 'mdl-waits', label: 'Metadata lock waits', category: 'Locks',
      sql: 'SELECT * FROM sys.schema_table_lock_waits',
      needsPrivilege: 'processlist-all',
      description: '0 rows = no DDL waiting on metadata locks. Needs the wait/lock/metadata/sql/mdl instrument enabled (see Lock instrumentation status).' },
    { id: 'trx-active', label: 'Active transactions', category: 'Locks',
      sql: "SELECT trx_id, trx_state, trx_started, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_s, trx_mysql_thread_id AS thread, trx_rows_locked, trx_rows_modified, LEFT(trx_query, 200) AS query FROM information_schema.innodb_trx ORDER BY trx_started",
      needsPrivilege: 'processlist-all',
      description: 'innodb_trx — long-running transactions first candidate for trouble' },

    // ── Partitions, binlogs, events ──
    // PostgreSQL and ClickHouse both had a partitions view; MySQL did not, so a
    // partitioned table showed as one table with no way to see inside it.
    { id: 'my-partitions', label: 'Partitions', category: 'Indexes & schema',
      sql: "SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl, PARTITION_NAME AS part, "
        + "SUBPARTITION_NAME AS subpart, PARTITION_METHOD AS method, "
        + "PARTITION_EXPRESSION AS expr, PARTITION_DESCRIPTION AS boundary, "
        + "TABLE_ROWS AS approx_rows, "
        + "ROUND((DATA_LENGTH + INDEX_LENGTH)/1024/1024, 1) AS total_mb, "
        + "ROUND(DATA_FREE/1024/1024, 1) AS free_mb, PARTITION_ORDINAL_POSITION AS pos "
        + "FROM information_schema.PARTITIONS "
        + "WHERE PARTITION_NAME IS NOT NULL "
        + "AND TABLE_SCHEMA NOT IN ('mysql','sys','performance_schema','information_schema') "
        + "ORDER BY DATA_LENGTH + INDEX_LENGTH DESC LIMIT 500",
      description: 'Every partition with its boundary, approximate rows and size. '
        + 'An empty result means nothing in this server is partitioned. Row counts are the '
        + 'engine\u2019s estimate, not a COUNT(*) \u2014 InnoDB samples them.',
      demanding: 'full information_schema scan on servers with many tables' },

    // A disk filling with binary logs is a routine incident and there was
    // nothing in the app to point at.
    { id: 'my-binlogs', label: 'Binary logs', category: 'Replication',
      sql: 'SHOW BINARY LOGS',
      needsPrivilege: 'replication',
      description: 'Every binlog the server still has, with its size. Total size against free '
        + 'disk is the number that matters \u2014 expiry is time-based, so a busy hour can '
        + 'outrun it. 0 rows = binary logging is off.' },
    { id: 'my-binlog-config', label: 'Binary log settings & position', category: 'Replication',
      flavors: ['mysql', 'percona'],
      sql: "SELECT @@log_bin AS log_bin_on, @@binlog_format AS format, "
        + "@@binlog_row_image AS row_image, @@binlog_expire_logs_seconds AS expire_s, "
        + "ROUND(@@binlog_expire_logs_seconds/86400, 1) AS expire_days, "
        + "@@max_binlog_size AS max_size_bytes, @@sync_binlog AS sync_binlog, "
        + "@@gtid_mode AS gtid_mode, @@enforce_gtid_consistency AS enforce_gtid, "
        + "@@log_replica_updates AS log_replica_updates",
      description: 'What the binlog is configured to do. `sync_binlog = 1` with '
        + '`innodb_flush_log_at_trx_commit = 1` is the durable pair; anything else trades '
        + 'transactions for throughput.' },
    // MariaDB's GTID is a different scheme, not a different spelling: a
    // domain-server-sequence triple (`0-3309-4`) rather than MySQL's
    // `uuid:1-N` set, with no `gtid_mode` to be in — it is always on. Asking
    // for @@gtid_mode here is an "unknown system variable" error, which is why
    // this cannot be one query with a CASE in it.
    { id: 'my-binlog-config-maria', label: 'Binary log settings & position', category: 'Replication',
      flavors: ['mariadb'],
      sql: "SELECT @@log_bin AS log_bin_on, @@binlog_format AS format, "
        + "@@binlog_row_image AS row_image, @@expire_logs_days AS expire_days, "
        + "@@max_binlog_size AS max_size_bytes, @@sync_binlog AS sync_binlog, "
        + "@@server_id AS server_id, @@gtid_domain_id AS gtid_domain_id, "
        + "@@gtid_strict_mode AS gtid_strict_mode, @@gtid_binlog_pos AS gtid_binlog_pos, "
        + "@@gtid_current_pos AS gtid_current_pos, @@log_slave_updates AS log_replica_updates",
      description: 'What the binlog is configured to do. MariaDB GTIDs are '
        + 'domain-server-sequence triples and are always enabled — there is no gtid_mode to '
        + 'turn on. `gtid_strict_mode = 1` is the setting that stops a replica silently '
        + 'diverging.' },

    // Events appear in the schema tree, so you could see one existed \u2014 not
    // whether the scheduler that runs them is even on.
    { id: 'my-events', label: 'Scheduled events', category: 'Maintenance',
      // LEFT JOIN from a one-row table, not a plain FROM EVENTS: with no events
      // defined that would return zero rows, hiding the scheduler state — which
      // is the one thing this view exists to show. Now "scheduler OFF and no
      // events" still renders a row that says so.
      sql: "SELECT @@event_scheduler AS scheduler_state, e.EVENT_SCHEMA AS db, "
        + "e.EVENT_NAME AS event, e.STATUS AS status, e.EVENT_TYPE AS type, "
        + "e.INTERVAL_VALUE AS every_n, e.INTERVAL_FIELD AS every_unit, "
        + "e.STARTS AS starts, e.ENDS AS ends, e.LAST_EXECUTED AS last_run, "
        + "TIMESTAMPDIFF(MINUTE, e.LAST_EXECUTED, NOW()) AS min_since_last_run, "
        + "e.ON_COMPLETION AS on_completion, e.CREATED AS created, e.LAST_ALTERED AS altered "
        + "FROM (SELECT 1) AS _one "
        + "LEFT JOIN information_schema.EVENTS e ON 1 = 1 "
        + "ORDER BY e.EVENT_SCHEMA, e.EVENT_NAME LIMIT 200",
      description: 'Every event and \u2014 in the first column \u2014 whether the scheduler is '
        + 'running at all. An ENABLED event on a server with `event_scheduler = OFF` never fires, '
        + 'which is the failure this view exists to make obvious.' },

    // ── Replication ──
    { id: 'repl-status', label: 'Replication channels & workers', category: 'Replication',
      flavors: ['mysql', 'percona'],
      sql: "SELECT c.CHANNEL_NAME AS channel, c.SERVICE_STATE AS io_state, c.RECEIVED_TRANSACTION_SET AS received_gtids, "
        + "w.WORKER_ID AS worker, w.SERVICE_STATE AS applier_state, w.LAST_APPLIED_TRANSACTION, w.APPLYING_TRANSACTION, "
        + "TIMESTAMPDIFF(SECOND, w.LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP, NOW()) AS s_since_last_apply, "
        + "w.LAST_ERROR_NUMBER, LEFT(w.LAST_ERROR_MESSAGE, 200) AS last_error "
        + "FROM performance_schema.replication_connection_status c "
        + "LEFT JOIN performance_schema.replication_applier_status_by_worker w ON w.CHANNEL_NAME = c.CHANNEL_NAME "
        + "ORDER BY c.CHANNEL_NAME, w.WORKER_ID LIMIT 200",
      needsPrivilege: 'replication',
      description: 'Per-channel IO thread + per-worker applier state, last applied GTID and worker errors (multi-channel aware). 0 rows = not a replica.' },
    // MariaDB has none of the performance_schema.replication_* tables, so the
    // only source is SHOW REPLICA STATUS — a statement, not a table, which
    // means it cannot be filtered or joined. It is still the answer to the
    // question, and an unfiltered answer beats an error.
    { id: 'repl-status-maria', label: 'Replica status', category: 'Replication',
      flavors: ['mariadb'],
      sql: 'SHOW REPLICA STATUS',
      needsPrivilege: 'replication',
      description: 'MariaDB keeps replica state in SHOW REPLICA STATUS rather than in '
        + 'performance_schema, so this is the whole row as the server reports it. '
        + '0 rows = not a replica. Seconds_Behind_Master and Slave_SQL_Running are the two '
        + 'columns worth reading first.' },

    // ── Resources ──
    { id: 'mem-host', label: 'Memory by host', category: 'Resources',
      sql: 'SELECT * FROM sys.memory_by_host_by_current_bytes LIMIT 50',
      description: 'Current memory attribution per client host' },
    { id: 'user-summary', label: 'User summary', category: 'Resources',
      sql: 'SELECT * FROM sys.user_summary LIMIT 50',
      description: 'Statements, latency, IO, connections per user' },
    { id: 'host-summary', label: 'Host summary', category: 'Resources',
      sql: 'SELECT * FROM sys.host_summary LIMIT 50',
      description: 'Same as user summary, per client host' },
    { id: 'io-files', label: 'IO by file', category: 'Resources',
      sql: 'SELECT * FROM sys.io_global_by_file_by_latency LIMIT 50',
      description: 'File IO latency — find the hot tablespace / binlog' },
    { id: 'bp-schema', label: 'Buffer pool by schema', category: 'Resources',
      sql: 'SELECT * FROM sys.innodb_buffer_stats_by_schema',
      description: '⚠ scans the buffer pool — expensive on large instances',
      demanding: 'scans the whole buffer pool' },
    { id: 'host-stmt', label: 'Host summary by statement type', category: 'Resources',
      sql: 'SELECT * FROM sys.host_summary_by_statement_type LIMIT 50',
      description: 'SELECT/INSERT/UPDATE/DELETE counts and latency per client host',
      needsConsumers: ['events_statements_current'] },
    { id: 'user-stmt', label: 'User summary by statement type', category: 'Resources',
      sql: 'SELECT * FROM sys.user_summary_by_statement_type LIMIT 50',
      description: 'SELECT/INSERT/UPDATE/DELETE counts and latency per user',
      needsConsumers: ['events_statements_current'] },
  ],

  postgres: [
    // ── Queries ──
    { id: 'pgss-top', label: 'Top statements (pg_stat_statements)', category: 'Queries',
      sql: 'SELECT calls, ROUND(mean_exec_time::numeric, 2) AS mean_ms, ROUND(total_exec_time::numeric, 0) AS total_ms, rows, LEFT(query, 200) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 50',
      needsPrivilege: 'statement-stats',
      description: 'Requires the pg_stat_statements extension. PG 13+ — 12 and earlier name these columns total_time / mean_time (the extension renamed them when it split planning from execution)' },
    { id: 'pg-long-tx', label: 'Long-running transactions', category: 'Queries',
      sql: "SELECT pid, usename, state, EXTRACT(EPOCH FROM (now() - xact_start))::int AS tx_age_s, EXTRACT(EPOCH FROM (now() - query_start))::int AS query_age_s, LEFT(query, 200) AS query FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 50",
      needsPrivilege: 'processlist-all',
      description: 'Open transactions by age — vacuum blockers' },
    { id: 'pg-conn-state', label: 'Connections by state', category: 'Queries',
      sql: "SELECT state, count(*), max(EXTRACT(EPOCH FROM (now() - state_change))::int) AS max_age_s FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY state ORDER BY count DESC",
      needsPrivilege: 'processlist-all',
      description: 'idle-in-transaction pileups show here' },
    { id: 'pg-functions', label: 'Function statistics', category: 'Queries',
      sql: 'SELECT schemaname, funcname, calls, ROUND(total_time::numeric, 2) AS total_ms, ROUND(self_time::numeric, 2) AS self_ms FROM pg_stat_user_functions ORDER BY total_time DESC LIMIT 50',
      description: 'Stored function calls — needs track_functions = pl (or all)' },

    // ── Indexes & schema ──
    { id: 'pg-sizes', label: 'Table sizes', category: 'Indexes & schema',
      sql: "SELECT schemaname, relname, pg_size_pretty(pg_total_relation_size(relid)) AS total, pg_size_pretty(pg_relation_size(relid)) AS table_only, pg_size_pretty(pg_indexes_size(relid)) AS indexes, n_live_tup, n_dead_tup FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 100",
      description: 'Largest relations with live/dead tuple counts' },
    { id: 'pg-idx-unused', label: 'Unused indexes', category: 'Indexes & schema',
      sql: "SELECT schemaname, relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size FROM pg_stat_user_indexes WHERE idx_scan = 0 ORDER BY pg_relation_size(indexrelid) DESC LIMIT 100",
      description: 'Never-scanned indexes — drop candidates (check replicas first!)' },
    { id: 'pg-seqscan', label: 'Sequential scan hotspots', category: 'Indexes & schema',
      sql: 'SELECT schemaname, relname, seq_scan, seq_tup_read, idx_scan, n_live_tup FROM pg_stat_user_tables WHERE seq_scan > 0 ORDER BY seq_tup_read DESC LIMIT 50',
      description: 'Tables read mostly by sequential scans' },
    { id: 'pg-cache', label: 'Cache hit ratio per table', category: 'Indexes & schema',
      sql: "SELECT schemaname, relname, heap_blks_read, heap_blks_hit, CASE WHEN heap_blks_hit + heap_blks_read = 0 THEN 0 ELSE ROUND(100.0 * heap_blks_hit / (heap_blks_hit + heap_blks_read), 1) END AS hit_pct FROM pg_statio_user_tables ORDER BY heap_blks_read DESC LIMIT 50",
      description: 'Tables falling out of shared_buffers' },

    // ── Locks ──
    { id: 'pg-locks', label: 'Lock waits', category: 'Locks',
      sql: "SELECT blocked.pid AS blocked_pid, blocked_act.usename AS blocked_user, LEFT(blocked_act.query, 100) AS blocked_query, blocking.pid AS blocking_pid, blocking_act.usename AS blocking_user, LEFT(blocking_act.query, 100) AS blocking_query FROM pg_locks blocked JOIN pg_stat_activity blocked_act ON blocked.pid = blocked_act.pid JOIN pg_locks blocking ON blocking.locktype = blocked.locktype AND blocking.database IS NOT DISTINCT FROM blocked.database AND blocking.relation IS NOT DISTINCT FROM blocked.relation AND blocking.transactionid IS NOT DISTINCT FROM blocked.transactionid AND blocking.pid <> blocked.pid AND blocking.granted JOIN pg_stat_activity blocking_act ON blocking.pid = blocking_act.pid WHERE NOT blocked.granted",
      needsPrivilege: 'processlist-all',
      description: 'Who blocks whom right now' },
    { id: 'pg-block-tree', label: 'Blocking tree (pairs)', category: 'Locks',
      sql: "SELECT blocked.pid AS blocked_pid, blocked_act.usename AS blocked_user, LEFT(blocked_act.query, 100) AS blocked_query, blocking.pid AS blocking_pid, blocking_act.usename AS blocking_user, LEFT(blocking_act.query, 100) AS blocking_query, now() - blocked_act.query_start AS blocked_for FROM pg_locks blocked JOIN pg_stat_activity blocked_act ON blocked_act.pid = blocked.pid JOIN pg_locks blocking ON blocking.pid = ANY (pg_blocking_pids(blocked.pid)) JOIN pg_stat_activity blocking_act ON blocking_act.pid = blocking.pid WHERE NOT blocked.granted ORDER BY blocked_for DESC",
      needsPrivilege: 'processlist-all',
      description: 'Exact blocked→blocking pid pairs with wait duration — follow the chain to the root blocker' },

    // ── Replication ──
    { id: 'pg-replication', label: 'Replication (pg_stat_replication)', category: 'Replication',
      sql: "SELECT pid, usename, application_name, client_addr, state, sync_state, sent_lsn, write_lsn, flush_lsn, replay_lsn, pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) AS send_lag_bytes, pg_wal_lsn_diff(pg_current_wal_lsn(), write_lsn) AS write_lag_bytes, pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn) AS flush_lag_bytes, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes, write_lag, flush_lag, replay_lag FROM pg_stat_replication",
      needsPrivilege: 'replication',
      description: 'Per-standby WAL lag in bytes and time (PG 10+). 0 rows = no standbys connected' },
    { id: 'pg-slots', label: 'Replication slots', category: 'Replication',
      sql: "SELECT slot_name, slot_type, database, active, restart_lsn, confirmed_flush_lsn, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal FROM pg_replication_slots ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST",
      needsPrivilege: 'replication',
      description: 'Inactive slots with large retained_wal will fill the disk — drop them' },

    // ── Server & config ──
    { id: 'pg-bgwriter', label: 'Bgwriter / checkpoints', category: 'Server & config',
      sql: 'SELECT * FROM pg_stat_bgwriter',
      description: 'Checkpoint frequency + buffer writes. PG ≤16 full stats; on PG 17+ checkpoint columns moved to pg_stat_checkpointer' },
    { id: 'pg-wal', label: 'WAL statistics', category: 'Server & config',
      sql: 'SELECT * FROM pg_stat_wal',
      description: 'WAL generation rate, full-page images, buffer usage — PG 14+ only' },
    { id: 'pg-settings', label: 'Non-default settings', category: 'Server & config',
      sql: "SELECT name, setting, unit, source, sourcefile, sourceline, pending_restart FROM pg_settings WHERE source <> 'default' ORDER BY sourcefile NULLS LAST, name",
      description: 'Everything someone changed — postgresql.conf, ALTER SYSTEM, sessions. pending_restart = needs a restart' },

    // ── Maintenance ──
    { id: 'pg-dead', label: 'Dead tuples (bloat candidates)', category: 'Maintenance',
      sql: 'SELECT schemaname, relname, n_live_tup, n_dead_tup, CASE WHEN n_live_tup = 0 THEN 0 ELSE ROUND(100.0 * n_dead_tup / n_live_tup, 1) END AS dead_pct, last_vacuum, last_autovacuum FROM pg_stat_user_tables WHERE n_dead_tup > 0 ORDER BY n_dead_tup DESC LIMIT 50',
      description: 'Vacuum backlog — high dead_pct = bloat' },
    // ══ Wave 1 (0.46.0) ═══════════════════════════════════════════════════
    // Catalogs and statistics only. No view here reads a user table, and none
    // issues COUNT(*): every row count comes from pg_class.reltuples or
    // pg_stat_*, which the planner maintains anyway.

    // ── Bloat, vacuum, wraparound: the defining PostgreSQL failure mode ──
    { id: 'pg-bloat-tables', label: 'Table bloat (estimate)', category: 'Maintenance',
      sql: `WITH w AS (
  SELECT starelid AS relid, sum((1 - stanullfrac) * stawidth)::numeric AS width
  FROM pg_statistic GROUP BY starelid)
SELECT n.nspname AS schema, c.relname AS "table",
       pg_size_pretty(pg_relation_size(c.oid)) AS size,
       c.relpages,
       GREATEST(ceil(c.reltuples::numeric * (COALESCE(w.width, 0) + 28) / 8160.0), 1) AS est_pages,
       ROUND(100 * (c.relpages - ceil(c.reltuples::numeric * (COALESCE(w.width, 0) + 28) / 8160.0))
             / NULLIF(c.relpages, 0)::numeric, 1) AS est_bloat_pct,
       pg_size_pretty((GREATEST(c.relpages - ceil(c.reltuples::numeric * (COALESCE(w.width, 0) + 28) / 8160.0), 0)
                      * current_setting('block_size')::bigint)::bigint) AS est_wasted
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN w ON w.relid = c.oid
WHERE c.relkind IN ('r','m') AND c.reltuples > 0 AND c.relpages > 128
  AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY (c.relpages - ceil(c.reltuples::numeric * (COALESCE(w.width, 0) + 28) / 8160.0)) DESC
LIMIT 50`,
      description: 'An ESTIMATE: pages on disk vs pages the rows should need, from pg_statistic widths. Wrong on tables with unusual column layouts or heavy TOASTing — install pgstattuple for exact numbers. A never-analyzed table has no widths and will read as 100%' },
    { id: 'pg-autovac-due', label: 'Autovacuum backlog vs threshold', category: 'Maintenance',
      sql: `SELECT s.schemaname AS schema, s.relname AS "table", s.n_dead_tup AS dead_tuples,
       (COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                  WHERE option_name = 'autovacuum_vacuum_threshold'),
                 current_setting('autovacuum_vacuum_threshold'))::numeric
        + COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                    WHERE option_name = 'autovacuum_vacuum_scale_factor'),
                   current_setting('autovacuum_vacuum_scale_factor'))::numeric
          * c.reltuples::numeric)::bigint AS threshold,
       CASE WHEN c.reltuples > 0
            THEN ROUND(100.0 * s.n_dead_tup / NULLIF(c.reltuples::numeric, 0), 1) END AS dead_pct,
       s.last_autovacuum, s.autovacuum_count
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
WHERE s.n_dead_tup > 0
ORDER BY s.n_dead_tup::numeric
         / NULLIF((COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                             WHERE option_name = 'autovacuum_vacuum_threshold'),
                            current_setting('autovacuum_vacuum_threshold'))::numeric
                   + COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                               WHERE option_name = 'autovacuum_vacuum_scale_factor'),
                              current_setting('autovacuum_vacuum_scale_factor'))::numeric
                     * c.reltuples::numeric), 0) DESC
LIMIT 50`,
      description: 'Dead tuples against each table’s OWN computed threshold, honouring per-table storage parameters. A table above 1.0 is due; one far below it with millions of dead rows is a table autovacuum will not reach for a long time' },
    { id: 'pg-freeze-age', label: 'Freeze age per table', category: 'Maintenance',
      sql: `SELECT n.nspname AS schema, c.relname AS "table",
       age(c.relfrozenxid) AS xid_age,
       ROUND(100.0 * age(c.relfrozenxid)
             / current_setting('autovacuum_freeze_max_age')::numeric, 1) AS pct_to_forced_vacuum,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size, c.relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','m','t') AND n.nspname NOT IN ('information_schema')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 50`,
      description: 'How close each table is to the anti-wraparound vacuum PostgreSQL will force on it. Past 100% autovacuum runs whether you wanted it to or not, and it cannot be cancelled without consequence' },
    { id: 'pg-wraparound', label: 'Transaction ID wraparound', category: 'Maintenance',
      sql: `SELECT datname AS database, age(datfrozenxid) AS xid_age,
       current_setting('autovacuum_freeze_max_age')::bigint AS forced_vacuum_at,
       2147483647 - age(datfrozenxid) AS xids_until_shutdown,
       ROUND(100.0 * age(datfrozenxid) / 2147483647, 2) AS pct_to_shutdown
FROM pg_database
WHERE datallowconn
ORDER BY age(datfrozenxid) DESC`,
      description: 'The countdown nobody watches until it is too late: at ~2.1 billion transactions of age the server refuses new writes and requires single-user recovery. Anything above 50% needs attention today' },
    { id: 'pg-freeze-blockers', label: 'What is holding back freezing', category: 'Maintenance',
      sql: `SELECT 'long transaction' AS kind, pid::text AS ident, usename AS who,
       EXTRACT(EPOCH FROM (now() - xact_start))::int AS age_s,
       LEFT(query, 120) AS detail
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND backend_type = 'client backend'
UNION ALL
SELECT 'prepared transaction', gid, owner,
       EXTRACT(EPOCH FROM (now() - prepared))::int, 'PREPARE TRANSACTION never committed'
FROM pg_prepared_xacts
UNION ALL
SELECT 'replication slot', slot_name, COALESCE(database, 'physical'), NULL,
       CASE WHEN active THEN 'active' ELSE 'INACTIVE — retains WAL forever' END
FROM pg_replication_slots
ORDER BY age_s DESC NULLS LAST`,
      description: 'Vacuum cannot freeze rows newer than the oldest thing still able to see them. Three causes, one list: an open transaction, an abandoned PREPARE TRANSACTION (invisible in pg_stat_activity), and a replication slot nobody is reading',
      needsPrivilege: 'processlist-all' },
    { id: 'pg-progress-vacuum', label: 'Vacuum in progress', category: 'Maintenance',
      sql: `SELECT p.pid, p.datname AS database, c.relname AS "table", p.phase,
       pg_size_pretty(p.heap_blks_total * current_setting('block_size')::bigint) AS heap_total,
       ROUND(100.0 * p.heap_blks_scanned / NULLIF(p.heap_blks_total, 0), 1) AS scanned_pct,
       ROUND(100.0 * p.heap_blks_vacuumed / NULLIF(p.heap_blks_total, 0), 1) AS vacuumed_pct,
       p.index_vacuum_count
FROM pg_stat_progress_vacuum p
LEFT JOIN pg_class c ON c.oid = p.relid`,
      description: 'PostgreSQL reports its own vacuum progress and no GUI shows it. Empty means nothing is vacuuming right now — which is itself the answer when a table is bloating. The dead-tuple columns are deliberately absent: PG 17 replaced max_dead_tuples/num_dead_tuples with byte-based ones, and no spelling works on every version',
      needsPrivilege: 'processlist-all' },
    { id: 'pg-progress-other', label: 'Index builds, cluster, copy in progress', category: 'Maintenance',
      sql: `SELECT 'create index' AS what, p.pid, c.relname AS "table", p.phase,
       ROUND(100.0 * p.blocks_done / NULLIF(p.blocks_total, 0), 1) AS pct
FROM pg_stat_progress_create_index p LEFT JOIN pg_class c ON c.oid = p.relid
UNION ALL
SELECT 'cluster/vacuum full', p.pid, c.relname, p.phase,
       ROUND(100.0 * p.heap_blks_scanned / NULLIF(p.heap_blks_total, 0), 1)
FROM pg_stat_progress_cluster p LEFT JOIN pg_class c ON c.oid = p.relid
UNION ALL
SELECT 'analyze', p.pid, c.relname, p.phase,
       ROUND(100.0 * p.sample_blks_scanned / NULLIF(p.sample_blks_total, 0), 1)
FROM pg_stat_progress_analyze p LEFT JOIN pg_class c ON c.oid = p.relid`,
      description: 'The other progress views: CREATE INDEX (incl. CONCURRENTLY), CLUSTER / VACUUM FULL, and ANALYZE. PG 13+ — pg_stat_progress_analyze arrived in 13, so on 12 this view reports not-available',
      needsPrivilege: 'processlist-all' },
    { id: 'pg-toast', label: 'TOAST pressure', category: 'Maintenance',
      sql: `SELECT n.nspname AS schema, c.relname AS "table",
       pg_size_pretty(pg_relation_size(c.oid)) AS main,
       pg_size_pretty(COALESCE(pg_total_relation_size(c.reltoastrelid), 0)) AS toast,
       ROUND(COALESCE(pg_total_relation_size(c.reltoastrelid), 0)
             / NULLIF(pg_relation_size(c.oid), 0)::numeric, 2) AS toast_ratio
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','m') AND c.reltoastrelid <> 0
  AND n.nspname NOT IN ('pg_catalog','information_schema')
  AND pg_total_relation_size(c.reltoastrelid) > 0
ORDER BY pg_total_relation_size(c.reltoastrelid) DESC
LIMIT 50`,
      description: 'Large values live out of line in a TOAST table. A ratio well above 1 means most of the table is not in the table — every read of a wide column is a second lookup, and VACUUM has two relations to keep up with' },

    // ── Indexes ──
    { id: 'pg-idx-duplicate', label: 'Duplicate / redundant indexes', category: 'Indexes & schema',
      sql: `WITH ix AS (
  SELECT i.indexrelid, i.indrelid, i.indisunique, i.indisprimary,
         n.nspname AS schema, t.relname AS "table", c.relname AS index_name,
         pg_get_indexdef(i.indexrelid) AS def,
         pg_relation_size(i.indexrelid) AS bytes,
         (SELECT string_agg(a::text, ',' ORDER BY ord)
          FROM unnest(i.indkey::int[]) WITH ORDINALITY AS u(a, ord)) AS cols
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema'))
SELECT a.schema, a."table", a.index_name AS redundant,
       pg_size_pretty(a.bytes) AS wasted, b.index_name AS covered_by, a.def
FROM ix a JOIN ix b
  ON a.indrelid = b.indrelid AND a.indexrelid <> b.indexrelid
 AND b.cols LIKE a.cols || '%' AND length(b.cols) > length(a.cols)
WHERE NOT a.indisunique AND NOT a.indisprimary
ORDER BY a.bytes DESC
LIMIT 50`,
      description: 'An index whose columns are a leading prefix of another’s. The longer one already answers everything the shorter does; the shorter is pure write cost and buffer-pool space. UNIQUE and PRIMARY are excluded — those are constraints, not merely access paths' },
    { id: 'pg-idx-invalid', label: 'Invalid and unready indexes', category: 'Indexes & schema',
      sql: `SELECT n.nspname AS schema, t.relname AS "table", c.relname AS index_name,
       i.indisvalid AS is_valid, i.indisready AS is_ready,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
       pg_get_indexdef(i.indexrelid) AS def
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE NOT i.indisvalid OR NOT i.indisready
ORDER BY pg_relation_size(i.indexrelid) DESC`,
      description: 'A failed CREATE INDEX CONCURRENTLY leaves an index behind that the planner will never use and every write still maintains. Dead weight that costs, and nothing reports it' },
    { id: 'pg-fk-unindexed', label: 'Foreign keys with no index', category: 'Indexes & schema',
      sql: `SELECT n.nspname AS schema, t.relname AS child_table, con.conname AS constraint_name,
       (SELECT string_agg(a.attname, ', ' ORDER BY u.ord)
        FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum) AS child_columns,
       ft.relname AS parent_table,
       pg_size_pretty(pg_relation_size(t.oid)) AS child_size
FROM pg_constraint con
JOIN pg_class t ON t.oid = con.conrelid
JOIN pg_class ft ON ft.oid = con.confrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE con.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = con.conrelid
      AND (i.indkey::int2[])[0:array_length(con.conkey, 1) - 1] = con.conkey)
ORDER BY pg_relation_size(t.oid) DESC
LIMIT 50`,
      description: 'PostgreSQL does NOT create an index for the child side of a foreign key. Without one, every DELETE or key UPDATE on the parent scans the whole child table while holding a lock — the commonest cause of a delete that used to be instant taking minutes' },
    { id: 'pg-idx-vs-table', label: 'Indexes larger than their table', category: 'Indexes & schema',
      sql: `SELECT schemaname AS schema, relname AS "table",
       pg_size_pretty(pg_relation_size(relid)) AS table_size,
       pg_size_pretty(pg_indexes_size(relid)) AS index_size,
       ROUND(pg_indexes_size(relid) / NULLIF(pg_relation_size(relid), 0)::numeric, 2) AS ratio,
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = relid) AS indexes
FROM pg_stat_user_tables
WHERE pg_relation_size(relid) > 8 * 1024 * 1024
  AND pg_indexes_size(relid) > pg_relation_size(relid)
ORDER BY pg_indexes_size(relid) - pg_relation_size(relid) DESC
LIMIT 50`,
      description: 'More index than data. Legitimate on a narrow lookup table; on a wide one it usually means indexes nobody audits, each paid for on every insert and update' },
    { id: 'pg-idx-write-cost', label: 'Write-heavy tables by index count', category: 'Indexes & schema',
      sql: `SELECT s.schemaname AS schema, s.relname AS "table",
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = s.relid) AS indexes,
       s.n_tup_ins + s.n_tup_upd + s.n_tup_del AS writes,
       s.n_tup_hot_upd AS hot_updates,
       ROUND(100.0 * s.n_tup_hot_upd / NULLIF(s.n_tup_upd, 0), 1) AS hot_pct,
       pg_size_pretty(pg_indexes_size(s.relid)) AS index_size
FROM pg_stat_user_tables s
WHERE s.n_tup_ins + s.n_tup_upd + s.n_tup_del > 0
ORDER BY (s.n_tup_ins + s.n_tup_upd + s.n_tup_del)
         * (SELECT count(*) FROM pg_index i WHERE i.indrelid = s.relid) DESC
LIMIT 50`,
      description: 'Every index is paid for on every write. A low HOT percentage on a heavily updated table means the updates are touching indexed columns — the fix is usually one fewer index, or a lower fillfactor' },

    // ── Workload ──
    { id: 'pgss-io', label: 'Top statements by I/O', category: 'Queries',
      sql: `SELECT calls, shared_blks_read + local_blks_read AS blocks_read,
       shared_blks_hit AS blocks_hit,
       ROUND(100.0 * shared_blks_hit
             / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       ROUND(total_exec_time::numeric, 0) AS total_ms, LEFT(query, 200) AS query
FROM pg_stat_statements
ORDER BY shared_blks_read + local_blks_read DESC
LIMIT 50`,
      description: 'The statements actually pulling pages off disk, which is a different list from the slowest ones. Needs pg_stat_statements; PG 13+ for the *_exec_time columns',
      needsPrivilege: 'statement-stats' },
    { id: 'pgss-temp', label: 'Statements spilling to disk', category: 'Queries',
      sql: `SELECT calls, temp_blks_written,
       pg_size_pretty(temp_blks_written * current_setting('block_size')::bigint) AS temp_written,
       ROUND(mean_exec_time::numeric, 2) AS mean_ms, LEFT(query, 200) AS query
FROM pg_stat_statements
WHERE temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 50`,
      description: 'Sorts and hashes that did not fit in work_mem and went to disk. Usually the cheapest large win available: raising work_mem for one query beats rewriting it. PG 13+ for the *_exec_time columns',
      needsPrivilege: 'statement-stats' },
    { id: 'pgss-variance', label: 'Statements that are sometimes fine', category: 'Queries',
      sql: `SELECT calls, ROUND(mean_exec_time::numeric, 2) AS mean_ms,
       ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
       ROUND(max_exec_time::numeric, 2) AS max_ms,
       ROUND((stddev_exec_time / NULLIF(mean_exec_time, 0))::numeric, 2) AS variability,
       LEFT(query, 200) AS query
FROM pg_stat_statements
WHERE calls > 10 AND mean_exec_time > 1
ORDER BY stddev_exec_time DESC
LIMIT 50`,
      description: 'High deviation means the same statement is fast most of the time and occasionally terrible — a plan flip, a cold cache, or lock waiting. Averages hide exactly this, which is why the mean-time list never finds it. Needs pg_stat_statements; PG 13+ for the *_exec_time columns',
      needsPrivilege: 'statement-stats' },
    { id: 'pgss-wal', label: 'Statements by WAL generated', category: 'Queries',
      sql: `SELECT calls, wal_records, wal_fpi AS full_page_images,
       pg_size_pretty(wal_bytes::bigint) AS wal, LEFT(query, 200) AS query
FROM pg_stat_statements
WHERE wal_bytes > 0
ORDER BY wal_bytes DESC
LIMIT 50`,
      description: 'Who is filling the WAL — and therefore the replication stream, the archive and the disk. PG 13+ (wal_* columns). A high full-page-image count points at checkpoints being too frequent',
      needsPrivilege: 'statement-stats' },
    { id: 'pg-stat-io', label: 'I/O by backend type (PG 16+)', category: 'Server & config',
      sql: `SELECT backend_type, object, context, reads, writes, extends, evictions, hits,
       ROUND(100.0 * hits / NULLIF(hits + reads, 0), 1) AS hit_pct
FROM pg_stat_io
WHERE reads > 0 OR writes > 0 OR extends > 0
ORDER BY reads + writes DESC`,
      description: 'Where I/O comes from, split by who did it and why — the view that finally distinguishes a backend reading data from autovacuum, the bgwriter and the checkpointer. PostgreSQL 16+' },
    { id: 'pg-checkpointer', label: 'Checkpoints (PG 17+)', category: 'Server & config',
      sql: 'SELECT * FROM pg_stat_checkpointer',
      description: 'Checkpoint counts and timing. PostgreSQL 17+ — on 16 and older these columns live in pg_stat_bgwriter' },
    { id: 'pg-temp-spill', label: 'Temp files and conflicts per database', category: 'Server & config',
      sql: `SELECT datname AS database, temp_files,
       pg_size_pretty(temp_bytes) AS temp_written, deadlocks,
       xact_commit, xact_rollback,
       ROUND(100.0 * xact_rollback / NULLIF(xact_commit + xact_rollback, 0), 1) AS rollback_pct,
       ROUND(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 1) AS cache_hit_pct,
       stats_reset
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY temp_bytes DESC`,
      description: 'Per-database totals since the last stats reset: disk spills, deadlocks, rollback ratio and cache hit rate. A rollback percentage climbing is an application problem long before it is a database one' },
    { id: 'pg-conn-headroom', label: 'Connection headroom', category: 'Server & config',
      sql: `SELECT COALESCE(usename, '(background)') AS "user", state,
       count(*) AS connections,
       max(EXTRACT(EPOCH FROM (now() - state_change))::int) AS oldest_in_state_s,
       current_setting('max_connections')::int AS max_connections,
       (SELECT count(*) FROM pg_stat_activity) AS total_now,
       current_setting('superuser_reserved_connections')::int AS reserved
FROM pg_stat_activity
GROUP BY usename, state
ORDER BY count(*) DESC`,
      description: 'How close the server is to refusing connections, and who is holding them. An idle-in-transaction pile-up shows here first — and it is also a freeze blocker (see the vacuum views)',
      needsPrivilege: 'processlist-all' },

    // ── Replication & durability ──
    { id: 'pg-slot-risk', label: 'Replication slot risk', category: 'Replication',
      sql: `SELECT slot_name, slot_type, database, active, temporary,
       pg_size_pretty(GREATEST(pg_wal_lsn_diff(
         CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END,
         restart_lsn), 0)) AS retained_wal,
       restart_lsn, confirmed_flush_lsn
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(
  CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END,
  restart_lsn) DESC NULLS LAST`,
      description: 'An inactive slot retains WAL forever and fills the disk — the classic way a replica decommissioned months ago takes the primary down. On PG 13+ the wal_status column adds reserved/extended/unreserved/lost; this works on every version' },
    { id: 'pg-subscriptions', label: 'Logical replication subscriptions', category: 'Replication',
      sql: `SELECT subname AS subscription, pid, relid::regclass AS relation,
       received_lsn, latest_end_lsn, latest_end_time,
       EXTRACT(EPOCH FROM (now() - latest_end_time))::int AS behind_s
FROM pg_stat_subscription`,
      description: 'The receiving side of logical replication: which worker is on what, and how far behind. 0 rows = this server subscribes to nothing' },
    { id: 'pg-archiver', label: 'WAL archiver health', category: 'Replication',
      sql: `SELECT archived_count, last_archived_wal, last_archived_time,
       failed_count, last_failed_wal, last_failed_time,
       EXTRACT(EPOCH FROM (now() - last_archived_time))::int AS since_last_archive_s,
       current_setting('archive_mode') AS archive_mode,
       stats_reset
FROM pg_stat_archiver`,
      description: 'An archiver that has been failing for a week is a silent, total loss of point-in-time recovery — the backup you find out about when you need it. failed_count climbing with last_archived_time stuck is the shape of that failure' },

    // ── Security & schema hygiene ──
    { id: 'pg-rls-gap', label: 'RLS enabled with no policy', category: 'Security',
      sql: `SELECT n.nspname AS schema, c.relname AS "table",
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
ORDER BY 1, 2`,
      description: 'Row-level security switched on with no policy behind it: the table silently returns NOTHING to every non-owner. Reads as an empty table, not as a permission error' },
    { id: 'pg-secdef-path', label: 'SECURITY DEFINER with a mutable search_path', category: 'Security',
      sql: `SELECT n.nspname AS schema, p.proname AS function, pg_get_userbyid(p.proowner) AS owner,
       pg_get_function_identity_arguments(p.oid) AS args,
       COALESCE(array_to_string(p.proconfig, ', '), '(none)') AS settings
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND (p.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\\_path=%'))
  AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1, 2`,
      description: 'A SECURITY DEFINER function without a pinned search_path runs as its owner while resolving names as the CALLER chooses — a caller who creates their own schema first can substitute any function it calls. Real, exploitable, and invisible in every schema browser' },
    { id: 'pg-not-valid', label: 'NOT VALID constraints', category: 'Security',
      sql: `SELECT n.nspname AS schema, t.relname AS "table", c.conname AS constraint_name,
       CASE c.contype WHEN 'c' THEN 'CHECK' WHEN 'f' THEN 'FOREIGN KEY' ELSE c.contype::text END AS kind,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE NOT c.convalidated
ORDER BY 1, 2`,
      description: 'Added NOT VALID and never validated: enforced for new rows, never checked against the ones already there. The constraint says the data is clean and nobody has ever confirmed it. Fix is ALTER TABLE … VALIDATE CONSTRAINT, which takes only a SHARE UPDATE EXCLUSIVE lock' },
    { id: 'pg-role-expiry', label: 'Roles, superusers and expiry', category: 'Security',
      sql: `SELECT rolname AS role, rolsuper AS superuser, rolcanlogin AS can_login,
       rolreplication AS replication, rolbypassrls AS bypasses_rls,
       rolconnlimit AS conn_limit, rolvaliduntil AS valid_until,
       CASE WHEN rolvaliduntil IS NOT NULL AND rolvaliduntil < now() THEN 'EXPIRED'
            WHEN rolvaliduntil IS NOT NULL THEN 'expires'
            ELSE 'never expires' END AS expiry
FROM pg_roles
ORDER BY rolsuper DESC, rolbypassrls DESC, rolname`,
      description: 'Every role that can log in, which of them are superusers, which bypass row-level security, and whose password has already expired. rolbypassrls is the one people forget: it defeats every policy on the server' },
    { id: 'pg-stats-skew', label: 'Column statistics worth doubting', category: 'Indexes & schema',
      sql: `SELECT schemaname AS schema, tablename AS "table", attname AS column,
       n_distinct, ROUND(correlation::numeric, 3) AS correlation, null_frac,
       CASE WHEN n_distinct = 0 THEN 'never analyzed or all NULL'
            WHEN n_distinct < 0 THEN 'ratio of rows — planner scales it with the table'
            ELSE 'fixed estimate — wrong once the table grows' END AS reading
FROM pg_stats
WHERE schemaname NOT IN ('pg_catalog','information_schema')
  AND (n_distinct = 0 OR abs(correlation) > 0.95 OR (n_distinct > 0 AND n_distinct < 10))
ORDER BY abs(correlation) DESC NULLS LAST
LIMIT 100`,
      description: 'Where the planner’s idea of a column is worth checking. A correlation near ±1 is a BRIN or CLUSTER candidate; a positive n_distinct is a fixed guess that stops being true as the table grows; zero means it has never been analyzed' },
    { id: 'pg-never-analyzed', label: 'Tables the planner is guessing about', category: 'Indexes & schema',
      sql: `SELECT s.schemaname AS schema, s.relname AS "table",
       c.reltuples::bigint AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(s.relid)) AS size,
       s.last_analyze, s.last_autoanalyze, s.n_mod_since_analyze AS rows_changed_since
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
WHERE s.last_analyze IS NULL AND s.last_autoanalyze IS NULL
   OR s.n_mod_since_analyze > GREATEST(c.reltuples * 0.2, 1000)
ORDER BY pg_total_relation_size(s.relid) DESC
LIMIT 50`,
      description: 'A table that has never been analyzed has reltuples = -1 and every plan touching it is chosen from built-in guesses. One that has changed by more than 20% since its last analyze is nearly as bad' },
    { id: 'pg-extensions', label: 'Extensions installed and available', category: 'Server & config',
      sql: `SELECT a.name, e.extversion AS installed, a.default_version AS available,
       CASE WHEN e.extversion IS NULL THEN 'not installed'
            WHEN e.extversion <> a.default_version THEN 'UPDATE AVAILABLE'
            ELSE 'current' END AS status,
       n.nspname AS schema, a.comment
FROM pg_available_extensions a
LEFT JOIN pg_extension e ON e.extname = a.name
LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extversion IS NOT NULL
   OR a.name IN ('pg_stat_statements','pgstattuple','hypopg','pg_buffercache',
                 'auto_explain','pg_trgm','pg_repack','postgis','vector','pg_cron')
ORDER BY (e.extversion IS NULL), a.name`,
      description: 'What is installed, what needs ALTER EXTENSION … UPDATE, and which of the extensions TxUI can use are merely available — pg_stat_statements for the workload views, pgstattuple for exact bloat, HypoPG for what-if indexes' },
    { id: 'pg-partitions', label: 'Partitions and the default partition', category: 'Indexes & schema',
      sql: `SELECT pn.nspname AS parent_schema, parent.relname AS parent,
       cn.nspname AS partition_schema, child.relname AS partition,
       pg_get_expr(child.relpartbound, child.oid) AS bounds,
       child.reltuples::bigint AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(child.oid)) AS size,
       pg_get_expr(child.relpartbound, child.oid) LIKE '%DEFAULT%' AS is_default
FROM pg_inherits i
JOIN pg_class parent ON parent.oid = i.inhparent
JOIN pg_class child ON child.oid = i.inhrelid
JOIN pg_namespace pn ON pn.oid = parent.relnamespace
JOIN pg_namespace cn ON cn.oid = child.relnamespace
WHERE parent.relkind = 'p'
ORDER BY parent.relname, child.relname
LIMIT 200`,
      description: 'Every partition with its bounds and size. Rows sitting in the DEFAULT partition are the finding: they mean the bounds did not cover the data, so pruning cannot help and the default is scanned every time. PG 10+' },
    { id: 'pg-vacuum', label: 'Vacuum / analyze history', category: 'Maintenance',
      sql: 'SELECT schemaname, relname, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze, vacuum_count, autovacuum_count FROM pg_stat_user_tables ORDER BY GREATEST(COALESCE(last_autovacuum, \'epoch\'), COALESCE(last_vacuum, \'epoch\')) NULLS FIRST LIMIT 50',
      description: 'Least-recently-vacuumed tables first' },

    // ── Spatial (PostGIS) ══════════════════════════════════════════════════
    // txui can DRAW geometry but is otherwise blind to the spatial schema.
    // The version view reads only pg_extension, so it is safe on any Postgres
    // and tells you at a glance whether PostGIS is even installed; the rest
    // read public.geometry_columns / geography_columns (PostGIS catalog views)
    // and only return rows where PostGIS is present — an empty grid, not an
    // error, when it is not.
    { id: 'pg-postgis-version', label: 'PostGIS version & extensions', category: 'Spatial',
      sql: "SELECT extname, extversion FROM pg_extension WHERE extname IN ('postgis','postgis_topology','postgis_raster','postgis_sfcgal','postgis_tiger_geocoder','address_standardizer') ORDER BY extname",
      description: 'Which PostGIS extensions are installed and at what version. An empty result means PostGIS is NOT installed on this database — the other Spatial views will then be empty too. Reads only pg_extension, so it never errors on a non-spatial database' },
    { id: 'pg-geometry-columns', label: 'Geometry columns', category: 'Spatial',
      sql: 'SELECT f_table_schema, f_table_name, f_geometry_column AS "column", coord_dimension AS dims, srid, type FROM public.geometry_columns ORDER BY f_table_schema, f_table_name, f_geometry_column',
      description: 'Every geometry column with its SRID and geometry type, from the PostGIS geometry_columns catalog. Requires PostGIS (see "PostGIS version"). srid = 0 means the column carries no declared spatial reference' },
    { id: 'pg-geography-columns', label: 'Geography columns', category: 'Spatial',
      sql: 'SELECT f_table_schema, f_table_name, f_geography_column AS "column", coord_dimension AS dims, srid, type FROM public.geography_columns ORDER BY f_table_schema, f_table_name, f_geography_column',
      description: 'Geography columns (lon/lat on a spheroid) with SRID and type, from the PostGIS geography_columns catalog. Requires PostGIS' },
    { id: 'pg-spatial-index', label: 'Spatial index coverage (missing GiST)', category: 'Spatial',
      sql: `SELECT g.f_table_schema AS schema, g.f_table_name AS "table",
       g.f_geometry_column AS "column", g.srid, g.type,
       EXISTS (
         SELECT 1
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_am am ON am.oid = ic.relam
         JOIN pg_class tc ON tc.oid = i.indrelid
         JOIN pg_namespace tn ON tn.oid = tc.relnamespace
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE am.amname = 'gist'
           AND tn.nspname = g.f_table_schema
           AND tc.relname = g.f_table_name
           AND a.attname = g.f_geometry_column
       ) AS has_gist_index
FROM public.geometry_columns g
ORDER BY has_gist_index, g.f_table_schema, g.f_table_name, g.f_geometry_column`,
      description: 'Every geometry column and whether a GiST (spatial) index covers it. Rows with has_gist_index = false sort first and are THE finding: without a GiST index every ST_Intersects / ST_DWithin / ST_Contains on that column is a sequential scan. Fix: CREATE INDEX … USING GIST (column). Requires PostGIS' },
    { id: 'pg-mixed-srid', label: 'Mixed-SRID tables', category: 'Spatial',
      sql: 'SELECT f_table_schema, f_table_name, count(DISTINCT srid) AS srid_count, array_agg(DISTINCT srid ORDER BY srid) AS srids FROM public.geometry_columns GROUP BY f_table_schema, f_table_name HAVING count(DISTINCT srid) > 1 ORDER BY srid_count DESC, f_table_schema, f_table_name',
      description: 'Tables whose geometry columns do not all share one SRID. A mixed-SRID table forces an ST_Transform on every spatial join and silently corrupts distance/area math. Requires PostGIS' },
    { id: 'pg-invalid-geom', label: 'Invalid-geometry check (per column)', category: 'Spatial',
      sql: `SELECT f_table_schema AS schema, f_table_name AS "table", f_geometry_column AS "column",
       format('SELECT count(*) AS invalid FROM %I.%I WHERE %I IS NOT NULL AND NOT ST_IsValid(%I)',
              f_table_schema, f_table_name, f_geometry_column, f_geometry_column) AS count_invalid_sql
FROM public.geometry_columns
ORDER BY f_table_schema, f_table_name, f_geometry_column`,
      description: 'One ready-to-run invalid-geometry count per geometry column. A static panel cannot iterate table names, so it emits the count(*) WHERE NOT ST_IsValid(col) query to run for each column — any non-zero result is fixed with ST_MakeValid. This view reads only the catalog (cheap); the generated queries scan the table. Requires PostGIS' },
  ],

  // ── Redis ───────────────────────────────────────────────────────────────
  // These are Redis COMMAND LINES, not SQL — the panel runs them through the
  // same monitor_query path, and db/redis_shape.rs turns each reply into a
  // grid. Every entry is a read: the panel must stay usable on a read-only
  // connection, so nothing here mutates or blocks the server.
  redis: [
    // ── Realtime ──
    { id: 'r-clients', label: 'Connected clients', category: 'Realtime',
      sql: 'CLIENT LIST',
      description: 'Every client with its address, age, idle time, current command, buffers and memory — the Redis processlist' },
    { id: 'r-slowlog', label: 'Slow commands', category: 'Realtime',
      sql: 'SLOWLOG GET 128',
      description: 'Commands slower than slowlog-log-slower-than, newest first, with the full argument list and duration in ms',
      demanding: 'reads the whole in-memory slowlog ring' },
    { id: 'r-slowlog-len', label: 'Slowlog length', category: 'Realtime',
      sql: 'SLOWLOG LEN',
      description: 'How many entries the slowlog currently holds — a full ring means older slow commands were already lost' },
    { id: 'r-commandstats', label: 'Command call stats', category: 'Realtime',
      sql: 'INFO commandstats',
      description: 'Per-command call count, total and per-call microseconds, and error count — where the server actually spends its time' },
    { id: 'r-latencystats', label: 'Latency percentiles', category: 'Realtime',
      sql: 'INFO latencystats',
      description: 'p50/p99/p99.9 latency per command (Redis 7+)' },

    // ── Memory ──
    { id: 'r-memory', label: 'Memory breakdown', category: 'Memory',
      sql: 'MEMORY STATS',
      description: 'Allocator totals, per-database overhead, replication buffers, fragmentation ratio — the first stop for an OOM' },
    { id: 'r-memory-doctor', label: 'Memory doctor', category: 'Memory',
      sql: 'MEMORY DOCTOR',
      description: "Redis' own read-only diagnosis of the current memory profile" },
    { id: 'r-info-memory', label: 'Memory info', category: 'Memory',
      sql: 'INFO memory',
      description: 'used_memory vs maxmemory, peak, RSS, fragmentation, eviction policy' },

    // ── Keyspace ──
    { id: 'r-keyspace', label: 'Keyspace summary', category: 'Keyspace',
      sql: 'INFO keyspace',
      description: 'Key and volatile-key counts per database, with average TTL' },
    { id: 'r-dbsize', label: 'Key count (current db)', category: 'Keyspace',
      sql: 'DBSIZE',
      description: 'Keys in the currently selected database' },
    { id: 'r-stats', label: 'Hit rate & evictions', category: 'Keyspace',
      sql: 'INFO stats',
      description: 'keyspace_hits vs keyspace_misses, evicted_keys, expired_keys, rejected connections — cache effectiveness in one view' },

    // ── Persistence & replication ──
    { id: 'r-persistence', label: 'Persistence', category: 'Resilience',
      sql: 'INFO persistence',
      description: 'RDB and AOF state, last save, last background-save status, rewrite progress — whether the data survives a restart' },
    { id: 'r-replication', label: 'Replication', category: 'Resilience',
      sql: 'INFO replication',
      description: 'Role, connected replicas with their offsets, link status and backlog' },
    { id: 'r-role', label: 'Role', category: 'Resilience',
      sql: 'ROLE',
      description: 'Primary or replica, and the replication offset' },

    // ── Configuration ──
    { id: 'r-config-mem', label: 'Memory config', category: 'Config',
      sql: 'CONFIG GET maxmemory*',
      description: 'maxmemory, the eviction policy and sampling — an unset maxmemory with an eviction policy of noeviction means writes fail when RAM runs out' },
    { id: 'r-config-persist', label: 'Persistence config', category: 'Config',
      sql: 'CONFIG GET save appendonly appendfsync auto-aof-rewrite-percentage',
      description: 'Snapshot and AOF settings' },
    { id: 'r-config-limits', label: 'Limits & timeouts', category: 'Config',
      sql: 'CONFIG GET maxclients timeout tcp-keepalive slowlog-log-slower-than slowlog-max-len',
      description: 'Connection ceiling, idle timeout, and how the slowlog is configured' },
    { id: 'r-config-all', label: 'All settings', category: 'Config',
      sql: 'CONFIG GET *',
      description: 'Every configuration parameter and its current value' },

    // ── Server ──
    { id: 'r-info-server', label: 'Server info', category: 'Server',
      sql: 'INFO server',
      description: 'Version, mode, uptime, executable and config file paths' },
    { id: 'r-info-clients', label: 'Client summary', category: 'Server',
      sql: 'INFO clients',
      description: 'Connected clients, blocked clients, and the largest client buffers' },
    { id: 'r-acl', label: 'ACL users', category: 'Server',
      sql: 'ACL LIST',
      description: 'Every configured user with its rules — who can run what' },
    { id: 'r-modules', label: 'Loaded modules', category: 'Server',
      sql: 'MODULE LIST',
      description: 'Modules and their versions (RedisJSON, RediSearch, TimeSeries, …)' },
  ],

  // ── ClickHouse ──────────────────────────────────────────────────────────
  // Every entry reads system.* only. ClickHouse's internals are unusually
  // legible — parts, granules, per-column compression and a full query log are
  // all queryable — and these views are where that pays off. All are reads, so
  // they work on a connection pinned to readonly=1.
  clickhouse: [
    // ── Storage: the overview a DBA opens first ──
    { id: 'ch-overview', label: 'Table overview', category: 'Storage',
      sql: `SELECT database, name AS table, engine,
                   total_rows AS rows,
                   formatReadableSize(total_bytes) AS size,
                   round(total_bytes_uncompressed / nullIf(total_bytes, 0), 1) AS ratio,
                   active_parts AS parts,
                   partition_key, sorting_key, primary_key, sampling_key,
                   if(create_table_query LIKE '%TTL %', 'yes', '') AS ttl,
                   storage_policy, comment
            FROM system.tables
            WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
              AND NOT is_temporary AND engine NOT LIKE '%View'
            ORDER BY total_bytes DESC LIMIT 300`,
      description: 'One row per table: engine, rows, size, compression ratio, part count, every key, whether a TTL exists and which storage policy it uses — the single screen that describes how a database is laid out' },
    { id: 'ch-partitions', label: 'Partitions', category: 'Storage',
      sql: `SELECT database, table, partition,
                   count() AS parts, sum(rows) AS rows,
                   formatReadableSize(sum(bytes_on_disk)) AS size,
                   max(level) AS max_level,
                   min(min_time) AS oldest, max(max_time) AS newest,
                   min(modification_time) AS first_written, max(modification_time) AS last_written
            FROM system.parts
            WHERE active AND database NOT IN ('system')
            GROUP BY database, table, partition
            ORDER BY sum(bytes_on_disk) DESC LIMIT 300`,
      description: 'Rows, size and part count per partition. Many small parts in one partition is the classic write-pattern problem; a high merge level means the data has been rewritten repeatedly' },
    { id: 'ch-ttl', label: 'TTL policies', category: 'Storage',
      // The TTL clause only exists in the CREATE statement — there is no
      // system column for it — so it is extracted, minus the SETTINGS tail
      // that follows it on the same line.
      sql: `SELECT t.database, t.name AS table,
                   replaceRegexpOne(extract(t.create_table_query, 'TTL\\\\s+([^\\\\n]+)'),
                                    '\\\\s+SETTINGS .*$', '') AS ttl_expression,
                   p.rows, p.size,
                   p.ttl_min AS ttl_deletes_from, p.ttl_max AS ttl_deletes_until,
                   p.overdue_parts
            FROM system.tables AS t
            LEFT JOIN (
              SELECT database, table, sum(rows) AS rows,
                     formatReadableSize(sum(bytes_on_disk)) AS size,
                     min(nullIf(delete_ttl_info_min, toDateTime(0))) AS ttl_min,
                     max(nullIf(delete_ttl_info_max, toDateTime(0))) AS ttl_max,
                     countIf(delete_ttl_info_max > toDateTime(0)
                             AND delete_ttl_info_max < now()) AS overdue_parts
              FROM system.parts WHERE active GROUP BY database, table
            ) AS p ON p.database = t.database AND p.table = t.name
            WHERE t.database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
              AND NOT t.is_temporary AND t.engine NOT LIKE '%View'
            ORDER BY t.create_table_query NOT LIKE '%TTL %', p.rows DESC LIMIT 300`,
      description: 'Which tables expire data and which do not — with the real horizon taken from the parts, and a count of parts whose delete-TTL has already passed. TTL only takes effect during a merge, so overdue parts are data you believe is gone but are still storing and still reading' },
    { id: 'ch-ttl-debt', label: 'TTL debt (overdue parts)', category: 'Storage',
      sql: `SELECT database, table, partition, name AS part,
                   rows, formatReadableSize(bytes_on_disk) AS size, level,
                   delete_ttl_info_max AS should_have_gone,
                   dateDiff('hour', delete_ttl_info_max, now()) AS hours_overdue,
                   modification_time AS last_touched
            FROM system.parts
            WHERE active AND delete_ttl_info_max > toDateTime(0)
              AND delete_ttl_info_max < now()
            ORDER BY delete_ttl_info_max ASC LIMIT 300`,
      description: 'Parts whose delete-TTL has passed but which are still on disk, oldest first. Empty is the healthy answer; a growing list means merges are not keeping up and the TTL is not actually being applied' },
    { id: 'ch-lowcard', label: 'LowCardinality candidates', category: 'Storage',
      sql: `SELECT c.database, c.table, c.name AS column, c.type,
                   c.compression_codec AS codec,
                   formatReadableSize(sum(pc.column_data_compressed_bytes)) AS compressed,
                   formatReadableSize(sum(pc.column_data_uncompressed_bytes)) AS raw,
                   round(sum(pc.column_data_uncompressed_bytes)
                         / nullIf(sum(pc.column_data_compressed_bytes), 0), 1) AS ratio
            FROM system.columns AS c
            INNER JOIN system.parts_columns AS pc
              ON pc.database = c.database AND pc.table = c.table AND pc.column = c.name
            WHERE pc.active AND c.database NOT IN ('system')
              AND c.type LIKE '%String%' AND c.type NOT LIKE '%LowCardinality%'
            GROUP BY c.database, c.table, c.name, c.type, c.compression_codec
            HAVING sum(pc.column_data_compressed_bytes) > 100000000
               AND ratio > 10
            ORDER BY sum(pc.column_data_uncompressed_bytes) DESC LIMIT 200`,
      description: 'Large String columns that compress extremely well — a strong signal of few distinct values, which is exactly what LowCardinality() is for. A heuristic from metadata only: confirm with uniq() before changing a type' },
    { id: 'ch-storage', label: 'Storage policies', category: 'Storage',
      sql: `SELECT policy_name, volume_name, volume_priority, disks, volume_type,
                   formatReadableSize(max_data_part_size) AS max_part_size,
                   move_factor, prefer_not_to_merge, perform_ttl_move_on_insert
            FROM system.storage_policies ORDER BY policy_name, volume_priority`,
      description: 'Policies, their volumes and the disks behind them — the target of every TTL MOVE and the reason a part lands on one disk rather than another' },

    // ── Schema ──
    { id: 'ch-keys', label: 'Key columns', category: 'Schema',
      sql: `SELECT database, table, name AS column, type, position,
                   if(is_in_partition_key, 'partition', '') AS partition,
                   if(is_in_primary_key, 'primary', '') AS primary,
                   if(is_in_sorting_key, 'sorting', '') AS sorting,
                   if(is_in_sampling_key, 'sampling', '') AS sampling,
                   compression_codec AS codec, default_kind, default_expression
            FROM system.columns
            WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
              AND (is_in_partition_key OR is_in_primary_key
                   OR is_in_sorting_key OR is_in_sampling_key)
            ORDER BY database, table, position LIMIT 500`,
      description: 'Every column that participates in a key, and which key. ClickHouse prunes on the partition key and on a PREFIX of the primary key — a predicate on a later key column does far less than it looks like it should' },
    { id: 'ch-projections', label: 'Projections', category: 'Schema',
      sql: `SELECT database, table, name, type, sorting_key, query
            FROM system.projections
            WHERE database NOT IN ('system') ORDER BY database, table, name LIMIT 200`,
      description: 'Projections defined on MergeTree tables — alternative sort orders and pre-aggregations the optimiser may pick instead of the base table' },

    // ── Replication ──
    { id: 'ch-clusters', label: 'Clusters', category: 'Replication',
      sql: `SELECT cluster, shard_num, shard_weight, replica_num, host_name, host_address,
                   port, is_local, user, errors_count, slowdowns_count, estimated_recovery_time
            FROM system.clusters ORDER BY cluster, shard_num, replica_num LIMIT 300`,
      description: 'Cluster topology as this node sees it, with per-replica error counts — the map behind every Distributed table and every ON CLUSTER statement' },
    { id: 'ch-repl-queue', label: 'Replication queue', category: 'Replication',
      sql: `SELECT database, table, position, node_name, type, create_time,
                   is_currently_executing, num_tries, num_postponed, postpone_reason,
                   last_attempt_time, last_exception
            FROM system.replication_queue
            ORDER BY num_tries DESC, create_time ASC LIMIT 300`,
      description: 'Pending replication tasks. Empty is healthy; entries with a rising num_tries and a last_exception are a replica that cannot catch up, which ends as unbounded disk growth on the leader' },
    { id: 'ch-dist-queue', label: 'Distributed queue', category: 'Replication',
      sql: `SELECT database, table, data_path, is_blocked, error_count,
                   data_files, formatReadableSize(data_compressed_bytes) AS pending,
                   broken_data_files, last_exception
            FROM system.distribution_queue ORDER BY data_compressed_bytes DESC LIMIT 200`,
      description: 'Rows written to a Distributed table but not yet forwarded to their shard. A backlog here is data that exists locally and nowhere else yet' },
    { id: 'ch-db-replicas', label: 'Replicated databases', category: 'Replication',
      sql: `SELECT database, is_readonly, zookeeper_path, shard_name, replica_name,
                   max_log_ptr, log_ptr, total_replicas, zookeeper_exception
            FROM system.database_replicas ORDER BY database LIMIT 200`,
      description: 'Replicated-database engines and how far each replica has replayed the DDL log — a log_ptr well behind max_log_ptr is schema divergence in progress' },
    { id: 'ch-zookeeper', label: 'Keeper / ZooKeeper', category: 'Replication',
      sql: `SELECT name, host, port, index, connected_time,
                   session_uptime_elapsed_seconds AS uptime_s,
                   is_expired, keeper_api_version, xid
            FROM system.zookeeper_connection LIMIT 50`,
      description: 'The Keeper (or ZooKeeper) session every replicated table depends on. An expired session means replication is stopped even though the server looks perfectly healthy' },

    // ── Activity ──
    { id: 'ch-part-log', label: 'Recent part events', category: 'Activity',
      sql: `SELECT event_time, event_type, merge_reason, database, table, part_name,
                   partition_id, rows, formatReadableSize(size_in_bytes) AS size,
                   duration_ms, peak_memory_usage, error, exception
            FROM system.part_log
            WHERE event_time > now() - INTERVAL 6 HOUR
            ORDER BY event_time DESC LIMIT 300`,
      description: 'Every part created, merged, mutated, moved or removed in the last 6 hours, with duration and any exception — the audit trail behind "why did this table suddenly grow"' },
    { id: 'ch-moves', label: 'Part moves in flight', category: 'Activity',
      sql: `SELECT database, table, elapsed, target_disk_name, target_disk_path,
                   part_name, formatReadableSize(part_size) AS size, thread_id
            FROM system.moves ORDER BY elapsed DESC LIMIT 200`,
      description: 'Parts being moved between disks or volumes right now, usually by a TTL MOVE rule' },
    { id: 'ch-async-inserts', label: 'Async insert buffer', category: 'Activity',
      sql: `SELECT database, table, format, first_update,
                   formatReadableSize(total_bytes) AS buffered,
                   length(entries.query_id) AS queries
            FROM system.asynchronous_inserts
            ORDER BY total_bytes DESC LIMIT 200`,
      description: 'Rows accepted by async INSERT and still sitting in memory, not yet flushed to a part. This buffer is not durable — what is listed here is lost if the server stops' },
    { id: 'ch-view-refreshes', label: 'Refreshable views', category: 'Activity',
      sql: `SELECT database, view, status, last_success_time, last_refresh_time,
                   next_refresh_time, exception, retry, progress
            FROM system.view_refreshes ORDER BY database, view LIMIT 200`,
      description: 'Refreshable materialized views, when each last succeeded and what it last failed with' },
    { id: 'ch-dropped', label: 'Dropped tables pending', category: 'Activity',
      sql: `SELECT database, table, uuid, engine, metadata_dropped_path, table_dropped_time
            FROM system.dropped_tables ORDER BY table_dropped_time DESC LIMIT 200`,
      description: 'Tables dropped but not yet physically deleted — their data still occupies disk until database_atomic_delay_before_drop_table_sec elapses' },

    // ── Server ──
    { id: 'ch-warnings', label: 'Server warnings', category: 'Server',
      sql: `SELECT * FROM system.warnings LIMIT 200`,
      description: "The server's own list of things it considers wrong with this installation — the cheapest health check there is, and one nothing else surfaces" },
    { id: 'ch-errors-total', label: 'Error counters', category: 'Server',
      sql: `SELECT name, code, value AS occurrences, last_error_time, last_error_message
            FROM system.errors WHERE value > 0
            ORDER BY last_error_time DESC LIMIT 300`,
      description: 'Every error code this server has raised since it started, with the most recent message. Cumulative, so it catches failures that happened while nobody was watching' },
    { id: 'ch-text-log', label: 'Server log (warn+)', category: 'Server',
      sql: `SELECT event_time, level, logger_name, message, source_file, source_line
            FROM system.text_log
            WHERE level <= 'Warning' AND event_time > now() - INTERVAL 3 HOUR
            ORDER BY event_time DESC LIMIT 300`,
      description: "Warnings, errors and fatals from the server's own log for the last 3 hours — without shell access to the pod" },
    { id: 'ch-mt-settings', label: 'Non-default MergeTree settings', category: 'Server',
      sql: `SELECT name, value, default, type, description
            FROM system.merge_tree_settings WHERE changed ORDER BY name LIMIT 300`,
      description: 'MergeTree-level settings changed from the default — parts_to_throw_insert, merge limits, TTL behaviour and the rest of the storage engine tuning' },
    { id: 'ch-user-processes', label: 'Memory by user', category: 'Server',
      sql: `SELECT user, formatReadableSize(memory_usage) AS memory,
                   formatReadableSize(peak_memory_usage) AS peak
            FROM system.user_processes ORDER BY memory_usage DESC LIMIT 200`,
      description: 'Current and peak memory per user across all their queries — who to talk to when the server is close to its memory limit' },

    // ── Security ──
    { id: 'ch-grants', label: 'Grants', category: 'Security',
      sql: `SELECT user_name, role_name, access_type, database, table, column,
                   is_partial_revoke, grant_option
            FROM system.grants ORDER BY user_name, role_name, database, table LIMIT 500`,
      description: 'Who has been granted what, and which grants carry WITH GRANT OPTION — the ones that let their holder widen everyone else\'s access' },
    { id: 'ch-row-policies', label: 'Row policies', category: 'Security',
      sql: `SELECT name, short_name, database, table, select_filter,
                   is_restrictive, apply_to_all, apply_to_list, apply_to_except
            FROM system.row_policies ORDER BY database, table, name LIMIT 300`,
      description: 'Row-level filters and who they apply to. A restrictive policy silently removes rows from every SELECT, so an unexplained "missing data" report usually ends here' },
    { id: 'ch-quotas', label: 'Quota usage', category: 'Security',
      sql: `SELECT quota_name, quota_key, start_time, duration,
                   queries, max_queries, errors, max_errors,
                   result_rows, read_rows, max_read_rows,
                   execution_time, max_execution_time
            FROM system.quota_usage LIMIT 300`,
      description: 'Consumption against each quota in the current interval — how close an account is to being cut off' },
    // ── Storage ──
    { id: 'ch-tables', label: 'Disk usage (measured)', category: 'Storage',
      sql: `SELECT database, table, any(engine) AS engine,
                   formatReadableSize(sum(bytes_on_disk)) AS disk,
                   formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed,
                   round(sum(data_uncompressed_bytes) / nullIf(sum(bytes_on_disk), 0), 1) AS ratio,
                   sum(rows) AS rows, count() AS parts, uniqExact(partition) AS partitions
            FROM system.parts
            LEFT JOIN system.tables AS t ON t.database = parts.database AND t.name = parts.table
            WHERE active AND parts.database NOT IN ('system')
            GROUP BY database, table
            ORDER BY sum(bytes_on_disk) DESC LIMIT 200`,
      description: 'On-disk size summed from the actual parts, with the compression ratio — the ratio is the number that decides whether a schema is well designed. Table overview reports what the table DECLARES; this reports what is really on disk, and the two disagreeing is itself informative' },
    { id: 'ch-columns', label: 'Column compression', category: 'Storage',
      // The codec lives in system.columns, the per-part byte counts in
      // system.parts_columns — neither has both, so they are joined.
      sql: `SELECT pc.database, pc.table, pc.column, any(pc.type) AS type,
                   any(c.compression_codec) AS codec,
                   formatReadableSize(sum(pc.column_data_compressed_bytes)) AS compressed,
                   formatReadableSize(sum(pc.column_data_uncompressed_bytes)) AS raw,
                   round(sum(pc.column_data_uncompressed_bytes)
                         / nullIf(sum(pc.column_data_compressed_bytes), 0), 1) AS ratio
            FROM system.parts_columns AS pc
            LEFT JOIN system.columns AS c
              ON c.database = pc.database AND c.table = pc.table AND c.name = pc.column
            WHERE pc.active AND pc.database NOT IN ('system')
            GROUP BY pc.database, pc.table, pc.column
            ORDER BY sum(pc.column_data_compressed_bytes) DESC LIMIT 300`,
      description: 'Per-column compressed vs raw bytes and the codec in use. A ratio near 1.0 on a large column is the clearest signal in ClickHouse that the type or codec is wrong (a Float with no DoubleDelta/Gorilla, a String that should be LowCardinality)',
      demanding: 'aggregates every active part column' },
    { id: 'ch-parts', label: 'Parts per partition', category: 'Storage',
      sql: `SELECT database, table, partition, count() AS parts,
                   formatReadableSize(sum(bytes_on_disk)) AS disk, sum(rows) AS rows,
                   max(level) AS max_merge_level, min(modification_time) AS oldest
            FROM system.parts WHERE active AND database NOT IN ('system')
            GROUP BY database, table, partition
            ORDER BY parts DESC LIMIT 200`,
      description: 'Too many parts in one partition means merges are behind — reads have to touch every part, and ClickHouse eventually refuses inserts ("too many parts")' },
    { id: 'ch-part-detail', label: 'Largest individual parts', category: 'Storage',
      sql: `SELECT database, table, name, partition, rows,
                   formatReadableSize(bytes_on_disk) AS disk, level, modification_time
            FROM system.parts WHERE active AND database NOT IN ('system')
            ORDER BY bytes_on_disk DESC LIMIT 100`,
      description: 'Individual parts, largest first — level shows how many merges a part has been through' },
    { id: 'ch-detached', label: 'Detached parts', category: 'Storage',
      sql: `SELECT database, table, partition_id, name, reason, disk
            FROM system.detached_parts ORDER BY database, table LIMIT 200`,
      description: 'Parts the server set aside rather than loaded — usually corruption or a failed mutation. Empty is the healthy answer' },

    // ── Schema ──
    { id: 'ch-skip-idx', label: 'Data-skipping indices', category: 'Schema',
      sql: `SELECT database, table, name, type_full, expr, granularity
            FROM system.data_skipping_indices ORDER BY database, table LIMIT 200`,
      description: 'minmax / set / bloom_filter indices — ClickHouse\'s equivalent of secondary indexes, used to skip whole granules' },
    { id: 'ch-dicts', label: 'Dictionaries', category: 'Schema',
      sql: `SELECT database, name, status, type, source,
                   element_count, formatReadableSize(bytes_allocated) AS memory,
                   round(found_rate, 3) AS found_rate,
                   round(loading_duration, 1) AS loading_duration,
                   last_successful_update_time, last_exception
            FROM system.dictionaries
            ORDER BY bytes_allocated DESC LIMIT 100`,
      description: 'Dictionaries by memory footprint, heaviest first — source is where each loads from, found_rate is the cache hit rate (1.0 = every lookup served from memory), loading_duration is how long the last load took' },
    { id: 'ch-dict-load', label: 'Dictionary load status', category: 'Schema',
      sql: `SELECT database, name, status, source,
                   last_successful_update_time, last_exception
            FROM system.dictionaries
            WHERE status != 'LOADED'
            ORDER BY database, name LIMIT 100`,
      description: 'Dictionaries not in a LOADED state — failed, never loaded, or mid-reload. last_exception says why a load failed; empty is the healthy answer' },
    { id: 'ch-views', label: 'Views & materialized views', category: 'Schema',
      sql: `SELECT database, name, engine, substring(as_select, 1, 300) AS definition
            FROM system.tables WHERE engine IN ('View','MaterializedView','LiveView')
            ORDER BY database, name LIMIT 200`,
      description: 'A materialized view in ClickHouse is an INSERT trigger, not a cached result — this is what each one runs' },

    // ── Activity ──
    { id: 'ch-processes', label: 'Running queries', category: 'Activity',
      sql: `SELECT query_id, user, address, round(elapsed, 2) AS elapsed_s,
                   formatReadableSize(memory_usage) AS memory, read_rows,
                   formatReadableSize(read_bytes) AS read_bytes,
                   substring(query, 1, 300) AS query
            FROM system.processes ORDER BY elapsed DESC`,
      description: 'Queries executing right now. Kill one with KILL QUERY WHERE query_id = \'…\'' },
    { id: 'ch-merges', label: 'Merges & mutations in flight', category: 'Activity',
      sql: `SELECT database, table, round(elapsed, 1) AS elapsed_s, round(progress * 100, 1) AS pct,
                   num_parts, formatReadableSize(total_size_bytes_compressed) AS size,
                   formatReadableSize(memory_usage) AS memory, is_mutation, result_part_name
            FROM system.merges ORDER BY elapsed DESC`,
      description: 'Background merges and mutations with their progress — a merge that never finishes is why parts pile up' },
    { id: 'ch-mutations', label: 'Mutations', category: 'Activity',
      sql: `SELECT database, table, mutation_id, command, create_time, is_done,
                   parts_to_do, latest_fail_reason
            FROM system.mutations ORDER BY create_time DESC LIMIT 100`,
      description: 'ALTER UPDATE/DELETE are asynchronous mutations. latest_fail_reason on a not-done mutation is a stuck ALTER' },

    // ── Query log ──
    { id: 'ch-slow', label: 'Slowest queries (24h)', category: 'Query log',
      sql: `SELECT round(query_duration_ms) AS ms, user, read_rows,
                   formatReadableSize(read_bytes) AS read_bytes,
                   formatReadableSize(memory_usage) AS memory, result_rows,
                   query_start_time, substring(query, 1, 300) AS query
            FROM system.query_log
            WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 1 DAY
            ORDER BY query_duration_ms DESC LIMIT 100`,
      description: 'The slowest completed queries of the last day',
      demanding: 'scans a day of query_log' },
    { id: 'ch-patterns', label: 'Query patterns (by shape)', category: 'Query log',
      sql: `SELECT any(normalizeQuery(query)) AS sample, count() AS runs,
                   round(sum(query_duration_ms)) AS total_ms,
                   round(avg(query_duration_ms)) AS avg_ms,
                   formatReadableSize(sum(memory_usage)) AS total_mem,
                   sum(read_rows) AS rows_read
            FROM system.query_log
            WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 24 HOUR
            GROUP BY normalized_query_hash
            ORDER BY total_ms DESC LIMIT 100`,
      description: 'Every query SHAPE ranked by the total time it has burned across all its runs (pg_stat_statements-style) — grouped by normalized_query_hash so the pattern that costs the most in aggregate surfaces even when no single execution is the slowest',
      demanding: 'scans a day of query_log' },
    { id: 'ch-heavy', label: 'Heaviest by rows read (24h)', category: 'Query log',
      sql: `SELECT normalized_query_hash, count() AS runs,
                   formatReadableSize(sum(read_bytes)) AS total_read,
                   sum(read_rows) AS total_rows, round(avg(query_duration_ms)) AS avg_ms,
                   substring(any(query), 1, 300) AS sample
            FROM system.query_log
            WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 1 DAY
            GROUP BY normalized_query_hash
            ORDER BY sum(read_bytes) DESC LIMIT 100`,
      description: 'Query shapes ranked by total bytes read — the ones actually costing I/O, grouped so one bad query pattern is not hidden by its many executions',
      demanding: 'scans a day of query_log' },
    { id: 'ch-errors', label: 'Failed queries (24h)', category: 'Query log',
      sql: `SELECT event_time, user, exception_code, substring(exception, 1, 200) AS exception,
                   substring(query, 1, 250) AS query
            FROM system.query_log
            WHERE type = 'ExceptionBeforeStart' OR type = 'ExceptionWhileProcessing'
              AND event_time > now() - INTERVAL 1 DAY
            ORDER BY event_time DESC LIMIT 100`,
      description: 'Everything that threw, newest first',
      demanding: 'scans a day of query_log' },

    // ── Server ──
    { id: 'ch-metrics', label: 'Current metrics', category: 'Server',
      sql: `SELECT metric, value, description FROM system.metrics
            WHERE value != 0 ORDER BY metric`,
      description: 'Live gauges: running queries, merges, open connections, memory tracking' },
    { id: 'ch-async', label: 'Asynchronous metrics', category: 'Server',
      sql: `SELECT metric, round(value, 3) AS value, description
            FROM system.asynchronous_metrics ORDER BY metric`,
      description: 'Sampled metrics — memory, filesystem, uptime, replica delay' },
    { id: 'ch-events', label: 'Cumulative events', category: 'Server',
      sql: `SELECT event, value, description FROM system.events ORDER BY value DESC LIMIT 200`,
      description: 'Counters since start: selected rows, merged bytes, failed queries, cache hits' },
    { id: 'ch-settings', label: 'Changed settings', category: 'Server',
      sql: `SELECT name, value, default AS default_value, type, readonly, description
            FROM system.settings WHERE changed ORDER BY name`,
      description: 'Only settings that differ from the shipped default' },
    { id: 'ch-disks', label: 'Disks', category: 'Server',
      sql: `SELECT name, path, formatReadableSize(free_space) AS free,
                   formatReadableSize(total_space) AS total,
                   round(100 - free_space / nullIf(total_space, 0) * 100, 1) AS used_pct, type
            FROM system.disks`,
      description: 'Where the data lives and how much room is left' },
    { id: 'ch-replicas', label: 'Replicated tables', category: 'Replication',
      sql: `SELECT database, table, is_leader, is_readonly, is_session_expired,
                   future_parts, parts_to_check, absolute_delay, queue_size,
                   inserts_in_queue, merges_in_queue, last_queue_update_exception
            FROM system.replicas ORDER BY absolute_delay DESC`,
      description: 'ReplicatedMergeTree state — absolute_delay is the replica lag in seconds. Empty means no replicated tables' },
    { id: 'ch-users', label: 'Users', category: 'Security',
      sql: `SELECT name, storage, auth_type, valid_until, default_database,
                   host_ip, host_names, host_names_like, host_names_regexp,
                   default_roles_all, default_roles_list, default_roles_except
            FROM system.users ORDER BY name LIMIT 300`,
      description: 'Every account, how it authenticates and which hosts it may connect from. An auth_type of no_password, or a host list of ::/0 on a privileged account, is the finding' },
  ],
  // ── SQL Server ─────────────────────────────────────────────────────────────
  // The phase-1.3 core set (plan-dba-focus WS 1): the six DMV lookups a DBA
  // reaches for first. Every one is a catalog read. None is tagged
  // needsPrivilege: privileges.ts has no SQL Server capability probe (the
  // Capability vocabulary is My/PG-shaped), and unknown-means-allowed is the
  // house rule — a login without VIEW SERVER STATE gets the server's own
  // error in the grid, which names the exact grant to ask for.
  sqlserver: [
    // ── Sessions ──
    { id: 'ms-processes', label: 'Sessions & requests', category: 'Sessions',
      sql: `SELECT s.session_id, s.login_name, s.host_name, s.program_name,
                   DB_NAME(s.database_id) AS db, s.status,
                   COALESCE(r.command, '') AS command,
                   COALESCE(r.wait_type, '') AS wait_type,
                   COALESCE(r.wait_time, 0) AS wait_time_ms,
                   COALESCE(r.blocking_session_id, 0) AS blocking_session_id,
                   COALESCE(DATEDIFF(SECOND, r.start_time, GETDATE()), 0) AS elapsed_s,
                   LEFT(COALESCE(st.text, ''), 500) AS query
            FROM sys.dm_exec_sessions s
            LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
            OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
            WHERE s.is_user_process = 1
            ORDER BY elapsed_s DESC`,
      description: 'Every user session, joined to the request it is running — the SQL Server processlist. A blocking_session_id other than 0 names the session holding what this one waits for. Statement text needs VIEW SERVER STATE; without it the rows still come back with an empty query column' },
    { id: 'ms-blocking', label: 'Blocking chains', category: 'Sessions',
      sql: `SELECT w.session_id AS waiter, w.blocking_session_id AS blocker,
                   w.wait_type, w.wait_duration_ms,
                   DB_NAME(r.database_id) AS db,
                   LEFT(COALESCE(st.text, ''), 400) AS waiting_query
            FROM sys.dm_os_waiting_tasks w
            LEFT JOIN sys.dm_exec_requests r ON r.session_id = w.session_id
            OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
            WHERE w.blocking_session_id <> 0
            ORDER BY w.wait_duration_ms DESC`,
      description: 'Who is waiting on whom, right now — every task with a non-zero blocker. Follow the blocker column to the head of the chain: that session is the one to look at (or kill), not the queue behind it' },
    // ── Workload ──
    { id: 'ms-digests', label: 'Heaviest statements (by CPU)', category: 'Workload',
      sql: `SELECT TOP 50
                   qs.total_worker_time / 1000 AS total_cpu_ms,
                   qs.execution_count,
                   qs.total_worker_time / 1000 / qs.execution_count AS avg_cpu_ms,
                   qs.total_elapsed_time / 1000 AS total_elapsed_ms,
                   qs.total_logical_reads,
                   SUBSTRING(st.text, (qs.statement_start_offset / 2) + 1,
                     ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
                       ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2) + 1) AS statement
            FROM sys.dm_exec_query_stats qs
            CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
            ORDER BY qs.total_worker_time DESC`,
      description: 'The plan cache ranked by total CPU — the SQL Server answer to pg_stat_statements. Covers only plans still in cache; total_worker_time is microseconds, rendered here as ms',
      demanding: 'needs VIEW SERVER STATE; reads the whole plan cache' },
    // ── Indexes ──
    { id: 'ms-fragmentation', label: 'Index fragmentation', category: 'Indexes',
      sql: `SELECT TOP 200 OBJECT_SCHEMA_NAME(ips.object_id, ips.database_id) AS [schema],
                   OBJECT_NAME(ips.object_id, ips.database_id) AS [table],
                   i.name AS [index],
                   ips.index_type_desc,
                   ips.page_count,
                   round(ips.avg_fragmentation_in_percent, 1) AS frag_pct
            FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
            JOIN sys.indexes i ON i.object_id = ips.object_id AND i.index_id = ips.index_id
            WHERE ips.avg_fragmentation_in_percent > 10
              AND ips.page_count > 100
              AND ips.index_id > 0
            ORDER BY ips.avg_fragmentation_in_percent DESC`,
      description: 'Indexes of the CURRENT database over 10% fragmented (LIMITED scan mode — metadata only, no data pages read). Under 100 pages fragmentation is noise; over ~30% a rebuild beats a reorganize. Run inside the database you care about',
      demanding: 'LIMITED mode still walks the index b-tree above the leaf' },
    { id: 'ms-unused-indexes', label: 'Unused indexes', category: 'Indexes',
      sql: `SELECT TOP 200 OBJECT_SCHEMA_NAME(i.object_id) AS [schema],
                   OBJECT_NAME(i.object_id) AS [table],
                   i.name AS [index],
                   i.type_desc,
                   COALESCE(s.user_seeks, 0) AS seeks,
                   COALESCE(s.user_scans, 0) AS scans,
                   COALESCE(s.user_lookups, 0) AS lookups,
                   COALESCE(s.user_updates, 0) AS updates
            FROM sys.indexes i
            LEFT JOIN sys.dm_db_index_usage_stats s
              ON s.object_id = i.object_id AND i.index_id = s.index_id
             AND s.database_id = DB_ID()
            WHERE i.is_primary_key = 0 AND i.is_unique = 0
              AND i.is_hypothetical = 0 AND i.type_desc <> 'HEAP'
              AND OBJECTPROPERTY(i.object_id, 'IsMsShipped') = 0
              AND COALESCE(s.user_seeks, 0) = 0 AND COALESCE(s.user_scans, 0) = 0
            ORDER BY COALESCE(s.user_updates, 0) DESC`,
      description: 'Non-unique, non-PK indexes never used for a seek or scan since the instance started — pure write overhead. Check the uptime before dropping: a month-end report index looks exactly like a dead one on day 3' },
    // ── Query Store ──
    // SQL Server's answer to performance_schema digests, and better than it:
    // Query Store persists plans and runtime stats per interval, so a
    // regression is visible as a *change* rather than only as a total. It is
    // per database and OFF by default before 2022 — the first view says which.
    { id: 'ms-qs-state', label: 'Query Store state', category: 'Query Store',
      sql: `SELECT DB_NAME() AS [database], actual_state_desc, desired_state_desc,
                   readonly_reason, current_storage_size_mb, max_storage_size_mb,
                   interval_length_minutes, stale_query_threshold_days,
                   query_capture_mode_desc
            FROM sys.database_query_store_options`,
      description: 'Whether Query Store is on for THIS database, and why it may have stopped. A non-zero readonly_reason means it filled up or hit a limit and is no longer capturing — the usual reason a regression has no history. Query Store is per database and was off by default before SQL Server 2022' },
    { id: 'ms-qs-regressed', label: 'Regressed queries', category: 'Query Store',
      sql: `SELECT TOP 50 q.query_id, qt.query_sql_text,
                   COUNT(DISTINCT p.plan_id) AS plans,
                   ROUND(AVG(rs.avg_duration) / 1000.0, 2) AS avg_ms,
                   ROUND(MAX(rs.max_duration) / 1000.0, 2) AS max_ms,
                   SUM(rs.count_executions) AS execs
            FROM sys.query_store_query q
            JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
            JOIN sys.query_store_plan p ON p.query_id = q.query_id
            JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
            GROUP BY q.query_id, qt.query_sql_text
            HAVING COUNT(DISTINCT p.plan_id) > 1
            ORDER BY avg_ms DESC`,
      description: 'Queries the optimiser has produced more than one plan for, slowest first. Multiple plans for one query is how a regression looks from the inside: the text did not change, the plan did. Needs Query Store on' },
    { id: 'ms-qs-top', label: 'Top queries by total time', category: 'Query Store',
      sql: `SELECT TOP 50 q.query_id, qt.query_sql_text,
                   SUM(rs.count_executions) AS execs,
                   ROUND(SUM(rs.avg_duration * rs.count_executions) / 1000000.0, 2) AS total_s,
                   ROUND(AVG(rs.avg_duration) / 1000.0, 2) AS avg_ms,
                   ROUND(AVG(rs.avg_logical_io_reads), 0) AS avg_reads
            FROM sys.query_store_query q
            JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
            JOIN sys.query_store_plan p ON p.query_id = q.query_id
            JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
            GROUP BY q.query_id, qt.query_sql_text
            ORDER BY total_s DESC`,
      description: 'Total time is the ranking that matters: a 2 ms query run a million times costs more than a 30 s report run once, and only one of them is worth tuning' },

    // ── Workload (plan cache — works without Query Store) ──
    { id: 'ms-plan-cache', label: 'Plan cache — heaviest', category: 'Workload',
      sql: `SELECT TOP 50
                   SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
                       ((CASE qs.statement_end_offset WHEN -1
                             THEN DATALENGTH(st.text) ELSE qs.statement_end_offset END
                         - qs.statement_start_offset)/2)+1) AS statement,
                   qs.execution_count,
                   ROUND(qs.total_worker_time / 1000000.0, 2) AS total_cpu_s,
                   ROUND(qs.total_elapsed_time / 1000000.0, 2) AS total_elapsed_s,
                   qs.total_logical_reads, qs.total_logical_writes,
                   qs.last_execution_time
            FROM sys.dm_exec_query_stats qs
            CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
            ORDER BY qs.total_worker_time DESC`,
      description: 'Cumulative cost per cached statement — the view that works when Query Store is off. Cleared by a restart, by DBCC FREEPROCCACHE and gradually by cache pressure, so it measures since the last of those, not since forever' },
    { id: 'ms-adhoc-bloat', label: 'Ad-hoc plan bloat', category: 'Workload',
      sql: `SELECT objtype, COUNT(*) AS plans,
                   SUM(CAST(size_in_bytes AS bigint)) / 1048576 AS mb,
                   SUM(CASE WHEN usecounts = 1 THEN 1 ELSE 0 END) AS used_once
            FROM sys.dm_exec_cached_plans
            GROUP BY objtype ORDER BY mb DESC`,
      description: 'Single-use ad-hoc plans are memory spent on statements that will never be reused — the symptom that "optimize for ad hoc workloads" exists to fix. A large used_once against objtype Adhoc is the signature' },

    // ── Waits ──
    { id: 'ms-waits', label: 'Wait statistics', category: 'Waits',
      sql: `SELECT TOP 40 wait_type, waiting_tasks_count,
                   wait_time_ms, wait_time_ms - signal_wait_time_ms AS resource_ms,
                   signal_wait_time_ms, max_wait_time_ms,
                   CAST(100.0 * wait_time_ms
                        / NULLIF(SUM(wait_time_ms) OVER (), 0) AS decimal(5,2)) AS pct
            FROM sys.dm_os_wait_stats
            WHERE waiting_tasks_count > 0
              AND wait_type NOT IN (
                'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SLEEP_TASK',
                'SLEEP_SYSTEMTASK','SQLTRACE_BUFFER_FLUSH','WAITFOR','LOGMGR_QUEUE',
                'CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','XE_TIMER_EVENT',
                'BROKER_TO_FLUSH','BROKER_TASK_STOP','CLR_MANUAL_EVENT','CLR_AUTO_EVENT',
                'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT',
                'XE_DISPATCHER_WAIT','XE_DISPATCHER_JOIN','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
                'HADR_FILESTREAM_IOMGR_IOCOMPLETION','DIRTY_PAGE_POLL','SP_SERVER_DIAGNOSTICS_SLEEP',
                'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','QDS_ASYNC_QUEUE','QDS_SHUTDOWN_QUEUE',
                'PREEMPTIVE_XE_GETTARGETSTATE','BROKER_EVENTHANDLER','SLEEP_DBSTARTUP',
                'ONDEMAND_TASK_QUEUE','SERVER_IDLE_CHECK','MEMORY_ALLOCATION_EXT',
                -- Added after reading real output: on an idle 2022 instance
                -- SOS_WORK_DISPATCHER alone was 98% of all wait time, which
                -- pushed every wait a DBA might act on off the chart.
                'SOS_WORK_DISPATCHER','PWAIT_EXTENSIBILITY_CLEANUP_TASK',
                'PARALLEL_REDO_DRAIN_WORKER','PARALLEL_REDO_LOG_CACHE',
                'PARALLEL_REDO_TRAN_LIST','PARALLEL_REDO_WORKER_SYNC',
                'PARALLEL_REDO_WORKER_WAIT_WORK','PREEMPTIVE_OS_FLUSHFILEBUFFERS',
                'VDI_CLIENT_OTHER','WAIT_XTP_CKPT_CLOSE','WAIT_XTP_OFFLINE_CKPT_NEW_LOG',
                'WAIT_XTP_HOST_WAIT','XE_LIVE_TARGET_TVF','HADR_CLUSAPI_CALL',
                'PREEMPTIVE_HADR_LEASE_MECHANISM','LOGMGR_RESERVE_APPEND')
            ORDER BY wait_time_ms DESC`,
      description: 'Where the server spends its time waiting, since startup, with the benign idle waits excluded — that exclusion list is the difference between a readable answer and forty rows of sleep. signal_wait is time already runnable but queued for CPU: high signal means CPU pressure, high resource means it was waiting on something else' },

    // ── Indexes ──
    { id: 'ms-missing-idx', label: 'Missing indexes', category: 'Indexes',
      sql: `SELECT TOP 40
                   DB_NAME(mid.database_id) AS [database],
                   OBJECT_NAME(mid.object_id, mid.database_id) AS [table],
                   ROUND(migs.avg_total_user_cost * migs.avg_user_impact
                         * (migs.user_seeks + migs.user_scans), 0) AS score,
                   migs.user_seeks, migs.user_scans,
                   ROUND(migs.avg_user_impact, 1) AS avg_impact_pct,
                   mid.equality_columns, mid.inequality_columns, mid.included_columns
            FROM sys.dm_db_missing_index_details mid
            JOIN sys.dm_db_missing_index_groups mig ON mig.index_handle = mid.index_handle
            JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle = mig.index_group_handle
            ORDER BY score DESC`,
      description: 'What the optimiser wished for, ranked by cost × impact × usage. Read these as evidence, not as instructions: each row is one query shape considered in isolation, they overlap heavily, and creating all of them is a reliable way to make writes slower. Cleared on restart' },
    { id: 'ms-idx-usage', label: 'Index usage vs write cost', category: 'Indexes',
      sql: `SELECT TOP 100 SCHEMA_NAME(o.schema_id) AS [schema], o.name AS [table],
                   i.name AS [index], i.type_desc,
                   ISNULL(us.user_seeks, 0) AS seeks, ISNULL(us.user_scans, 0) AS scans,
                   ISNULL(us.user_lookups, 0) AS lookups, ISNULL(us.user_updates, 0) AS writes,
                   us.last_user_seek, us.last_user_scan
            FROM sys.indexes i
            JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U'
            LEFT JOIN sys.dm_db_index_usage_stats us
              ON us.object_id = i.object_id AND us.index_id = i.index_id
             AND us.database_id = DB_ID()
            WHERE i.index_id > 0
            ORDER BY ISNULL(us.user_updates, 0) - (ISNULL(us.user_seeks,0)
                     + ISNULL(us.user_scans,0) + ISNULL(us.user_lookups,0)) DESC`,
      description: 'Every index by what it costs against what it earns: writes maintain it, seeks and scans use it. The worst rows are top — many updates, no reads. Counters reset on restart, so a low count on a recently restarted server is not evidence of an unused index' },
    { id: 'ms-dup-idx', label: 'Duplicate & overlapping indexes', category: 'Indexes',
      sql: `WITH cols AS (
                SELECT ic.object_id, ic.index_id,
                       STRING_AGG(CAST(c.name AS nvarchar(max)), ',')
                         WITHIN GROUP (ORDER BY ic.key_ordinal) AS keys
                FROM sys.index_columns ic
                JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                WHERE ic.is_included_column = 0
                GROUP BY ic.object_id, ic.index_id)
            SELECT SCHEMA_NAME(o.schema_id) AS [schema], o.name AS [table],
                   a.keys AS key_columns,
                   STRING_AGG(CAST(i.name AS nvarchar(max)), ', ') AS indexes,
                   COUNT(*) AS n
            FROM cols a
            JOIN sys.indexes i ON i.object_id = a.object_id AND i.index_id = a.index_id
            JOIN sys.objects o ON o.object_id = a.object_id AND o.type = 'U'
            GROUP BY o.schema_id, o.name, a.keys
            HAVING COUNT(*) > 1
            ORDER BY n DESC`,
      description: 'Indexes on the same leading key columns. Exact duplicates are pure write cost for no read benefit; near-duplicates that differ only in INCLUDE columns can usually be merged into one wider index' },
    { id: 'ms-heaps', label: 'Heaps', category: 'Indexes',
      sql: `SELECT SCHEMA_NAME(o.schema_id) AS [schema], o.name AS [table],
                   ps.row_count, ps.reserved_page_count * 8 / 1024 AS reserved_mb,
                   ISNULL(us.user_seeks + us.user_scans + us.user_lookups, 0) AS reads,
                   ISNULL(us.user_updates, 0) AS writes
            FROM sys.indexes i
            JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U'
            JOIN sys.dm_db_partition_stats ps
              ON ps.object_id = i.object_id AND ps.index_id = i.index_id
            LEFT JOIN sys.dm_db_index_usage_stats us
              ON us.object_id = i.object_id AND us.index_id = i.index_id AND us.database_id = DB_ID()
            WHERE i.index_id = 0
            ORDER BY ps.row_count DESC`,
      description: 'Tables with no clustered index. A heap is not automatically wrong — staging tables are often better as heaps — but a large, frequently updated heap accumulates forwarded records that only a rebuild clears, and every non-clustered lookup goes through a RID rather than a key' },

    // ── Storage ──
    { id: 'ms-db-files', label: 'Database files & autogrowth', category: 'Storage',
      sql: `SELECT DB_NAME(f.database_id) AS [database], f.name AS logical_name,
                   f.type_desc, f.physical_name,
                   f.size * 8 / 1024 AS size_mb,
                   CASE WHEN f.max_size = -1 THEN 'unlimited'
                        WHEN f.max_size = 268435456 THEN 'unlimited (log)'
                        ELSE CAST(f.max_size * 8 / 1024 AS varchar(20)) + ' MB' END AS max_size,
                   CASE WHEN f.is_percent_growth = 1
                        THEN CAST(f.growth AS varchar(10)) + ' %'
                        ELSE CAST(f.growth * 8 / 1024 AS varchar(20)) + ' MB' END AS growth,
                   f.is_percent_growth
            FROM sys.master_files f
            ORDER BY [database], f.type_desc, f.name`,
      description: 'Every file of every database, with how it grows. Percent growth is the one to look for: a 10% autogrowth on a 200 GB file is a 20 GB allocation that stalls writes while it happens, and it gets worse as the file gets bigger' },
    { id: 'ms-vlf', label: 'Log VLF count', category: 'Storage',
      sql: `SELECT DB_NAME() AS [database], COUNT(*) AS vlf_count,
                   SUM(CAST(vlf_size_mb AS decimal(18,2))) AS log_mb,
                   SUM(CASE WHEN vlf_active = 1 THEN 1 ELSE 0 END) AS active_vlfs
            FROM sys.dm_db_log_info(DB_ID())`,
      description: 'Virtual log files in this database log. A few hundred is normal; thousands slow recovery, log backups and replication — the classic cause is a small log grown many times in small increments rather than sized once' },
    { id: 'ms-tempdb', label: 'tempdb usage', category: 'Storage',
      sql: `SELECT SUM(user_object_reserved_page_count) * 8 / 1024 AS user_objects_mb,
                   SUM(internal_object_reserved_page_count) * 8 / 1024 AS internal_objects_mb,
                   SUM(version_store_reserved_page_count) * 8 / 1024 AS version_store_mb,
                   SUM(unallocated_extent_page_count) * 8 / 1024 AS free_mb
            FROM sys.dm_db_file_space_usage`,
      description: 'What is holding tempdb: user objects are temp tables and table variables, internal objects are sorts, hashes and spools, and the version store is row versioning (RCSI or snapshot isolation). A growing version store with no obvious cause usually means a long-running transaction is pinning old row versions' },
    { id: 'ms-table-space', label: 'Table sizes', category: 'Storage',
      sql: `SELECT TOP 100 SCHEMA_NAME(o.schema_id) AS [schema], o.name AS [table],
                   SUM(CASE WHEN ps.index_id IN (0,1) THEN ps.row_count ELSE 0 END) AS rows,
                   SUM(ps.reserved_page_count) * 8 / 1024 AS reserved_mb,
                   SUM(ps.used_page_count) * 8 / 1024 AS used_mb,
                   SUM(CASE WHEN ps.index_id IN (0,1) THEN ps.in_row_data_page_count ELSE 0 END)
                     * 8 / 1024 AS data_mb
            FROM sys.dm_db_partition_stats ps
            JOIN sys.objects o ON o.object_id = ps.object_id AND o.type = 'U'
            GROUP BY o.schema_id, o.name
            ORDER BY reserved_mb DESC`,
      description: 'Space per table, largest first. reserved minus used is allocated-but-empty space — normal in small amounts, and a sign of heavy delete activity when it is large' },

    // ── Health ──
    { id: 'ms-backups', label: 'Last backup per database', category: 'Health',
      sql: `SELECT d.name AS [database], d.recovery_model_desc,
                   MAX(CASE WHEN b.type = 'D' THEN b.backup_finish_date END) AS last_full,
                   MAX(CASE WHEN b.type = 'I' THEN b.backup_finish_date END) AS last_diff,
                   MAX(CASE WHEN b.type = 'L' THEN b.backup_finish_date END) AS last_log,
                   DATEDIFF(HOUR, MAX(CASE WHEN b.type = 'D' THEN b.backup_finish_date END),
                            GETDATE()) AS full_age_hours
            FROM sys.databases d
            LEFT JOIN msdb.dbo.backupset b ON b.database_name = d.name
            WHERE d.database_id > 4
            GROUP BY d.name, d.recovery_model_desc
            ORDER BY full_age_hours DESC`,
      description: 'The question a DBA is actually asked. FULL recovery with no recent log backup is the dangerous combination: the log grows forever and point-in-time recovery is not available anyway. A NULL last_full means no backup this server has a record of' },
    { id: 'ms-db-state', label: 'Database settings', category: 'Health',
      sql: `SELECT name, state_desc, recovery_model_desc, compatibility_level,
                   page_verify_option_desc, is_auto_close_on, is_auto_shrink_on,
                   is_read_committed_snapshot_on, snapshot_isolation_state_desc,
                   is_auto_create_stats_on, is_auto_update_stats_on, collation_name
            FROM sys.databases ORDER BY database_id`,
      description: 'The settings that quietly cost you: AUTO_CLOSE drops the database from memory when idle and pays to reopen it, AUTO_SHRINK fragments every index it touches, and page_verify other than CHECKSUM means torn pages go undetected. Both auto-stats options off is a deliberate choice almost nobody makes on purpose' },
    { id: 'ms-agent-jobs', label: 'Agent job failures', category: 'Health',
      sql: `SELECT TOP 50 j.name AS job, h.step_name,
                   msdb.dbo.agent_datetime(h.run_date, h.run_time) AS run_at,
                   h.run_duration, h.message
            FROM msdb.dbo.sysjobhistory h
            JOIN msdb.dbo.sysjobs j ON j.job_id = h.job_id
            WHERE h.run_status = 0
            ORDER BY h.run_date DESC, h.run_time DESC`,
      description: 'Failed SQL Agent job steps, newest first. Agent is absent on Linux containers and on Azure SQL Database — an error here means no Agent rather than no failures' },
    { id: 'ms-stats-stale', label: 'Stale statistics', category: 'Health',
      sql: `SELECT TOP 100 SCHEMA_NAME(o.schema_id) AS [schema], o.name AS [table],
                   s.name AS stat, sp.last_updated, sp.rows, sp.rows_sampled,
                   sp.modification_counter,
                   CASE WHEN sp.rows > 0
                        THEN CAST(100.0 * sp.modification_counter / sp.rows AS decimal(6,2))
                        END AS pct_modified
            FROM sys.stats s
            JOIN sys.objects o ON o.object_id = s.object_id AND o.type = 'U'
            CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
            WHERE sp.rows > 0
            ORDER BY pct_modified DESC`,
      description: 'Statistics against how much the table has changed since they were computed. A high pct_modified is why the optimiser is estimating one row and getting a million — the plan is built on a picture of a table that no longer exists' },
    { id: 'ms-memory', label: 'Memory', category: 'Health',
      sql: `SELECT physical_memory_kb / 1024 AS server_ram_mb,
                   committed_kb / 1024 AS sql_committed_mb,
                   committed_target_kb / 1024 AS sql_target_mb,
                   (SELECT cntr_value FROM sys.dm_os_performance_counters
                     WHERE counter_name = 'Page life expectancy'
                       AND object_name LIKE '%Buffer Manager%') AS page_life_expectancy_s,
                   (SELECT COUNT(*) FROM sys.dm_exec_query_memory_grants
                     WHERE grant_time IS NULL) AS grants_pending
            FROM sys.dm_os_sys_info`,
      description: 'Page life expectancy is how long a page survives in the buffer pool: falling steadily means the working set no longer fits. grants_pending above zero means queries are queued waiting for memory to run at all, which shows up to users as everything being slow at once' },

    // ── Security ──
    { id: 'ms-logins', label: 'Server logins', category: 'Security',
      sql: `SELECT p.name, p.type_desc, p.is_disabled, p.create_date, p.modify_date,
                   ISNULL(l.is_policy_checked, 0) AS password_policy,
                   ISNULL(l.is_expiration_checked, 0) AS password_expiry,
                   IS_SRVROLEMEMBER('sysadmin', p.name) AS is_sysadmin
            FROM sys.server_principals p
            LEFT JOIN sys.sql_logins l ON l.principal_id = p.principal_id
            WHERE p.type IN ('S','U','G') AND p.name NOT LIKE '##%'
            ORDER BY is_sysadmin DESC, p.name`,
      description: 'Every login that can reach the instance, sysadmins first. A SQL login with password_policy off can hold a weak password indefinitely; the count of sysadmins is the number of accounts that can do anything at all' },
    { id: 'ms-db-principals', label: 'Database users & roles', category: 'Security',
      sql: `SELECT dp.name AS principal, dp.type_desc, dp.authentication_type_desc,
                   ISNULL(sp.name, '') AS login,
                   STUFF((SELECT ', ' + r.name
                          FROM sys.database_role_members rm
                          JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
                          WHERE rm.member_principal_id = dp.principal_id
                          FOR XML PATH('')), 1, 2, '') AS roles
            FROM sys.database_principals dp
            LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid
            WHERE dp.type NOT IN ('R') AND dp.principal_id > 4
            ORDER BY dp.name`,
      description: 'Users in this database with the roles they hold. An orphaned user — a database user whose login column is empty — cannot connect and is usually left behind by a restore from another server' },
    { id: 'ms-permissions', label: 'Explicit permissions', category: 'Security',
      sql: `SELECT dp.name AS grantee, perm.state_desc, perm.permission_name,
                   perm.class_desc,
                   ISNULL(SCHEMA_NAME(o.schema_id) + '.' + o.name, '') AS [object]
            FROM sys.database_permissions perm
            JOIN sys.database_principals dp ON dp.principal_id = perm.grantee_principal_id
            LEFT JOIN sys.objects o ON o.object_id = perm.major_id AND perm.class = 1
            WHERE dp.principal_id > 4
            ORDER BY dp.name, perm.class_desc, [object]`,
      description: 'Permissions granted or denied explicitly, as opposed to inherited through a role. DENY beats every GRANT including sysadmin-adjacent ones, so a single DENY row is often the answer to "why can this account not read that table"' },

    // ── Config ──
    { id: 'ms-config-nondefault', label: 'Non-default configuration', category: 'Config',
      sql: `SELECT name, CAST(value AS bigint) AS configured,
                   CAST(value_in_use AS bigint) AS in_use,
                   description, is_dynamic, is_advanced
            FROM sys.configurations
            WHERE value <> value_in_use OR name IN (
              'max degree of parallelism','cost threshold for parallelism',
              'max server memory (MB)','min server memory (MB)',
              'optimize for ad hoc workloads','backup compression default',
              'remote admin connections','fill factor (%)')
            ORDER BY name`,
      description: 'Settings changed from the default, plus the handful worth checking even when untouched. A row where configured differs from in_use is a change that needs a restart and has not had one — which means the running server is not configured the way the script that set it believes' },
    { id: 'ms-server-info', label: 'Server & host', category: 'Config',
      sql: `SELECT SERVERPROPERTY('ProductVersion') AS version,
                   SERVERPROPERTY('ProductLevel') AS patch_level,
                   SERVERPROPERTY('Edition') AS edition,
                   SERVERPROPERTY('Collation') AS collation,
                   SERVERPROPERTY('IsIntegratedSecurityOnly') AS windows_auth_only,
                   si.cpu_count, si.scheduler_count,
                   si.physical_memory_kb / 1024 AS ram_mb,
                   si.sqlserver_start_time,
                   DATEDIFF(DAY, si.sqlserver_start_time, GETDATE()) AS uptime_days
            FROM sys.dm_os_sys_info si`,
      description: 'Version, edition and host shape in one row. cpu_count against MAXDOP is the first parallelism question, and a short uptime explains why the cumulative views (waits, plan cache, index usage) look empty' },

  ],
};
