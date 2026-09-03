//! Live ClickHouse tests against a real server, gated by environment so a
//! machine without one (CI, a fresh checkout) stays green: every test is
//! `#[ignore]`d AND returns early when `TXUI_CH_PASSWORD` is unset.
//!
//!     TXUI_CH_PASSWORD=root cargo test --lib clickhouse_live -- --ignored --nocapture
//!
//! Environment:
//!   TXUI_CH_URL       endpoint (default http://localhost:8123)
//!   TXUI_CH_USER      user (default "default")
//!   TXUI_CH_PASSWORD  password — REQUIRED; unset means skip
//!
//! Unlike the `TXUI_TEST_CONN` fleet these build the `ConnectionConfig`
//! in-test and talk to the driver directly, so no saved connection or secret
//! store is involved. The password never leaves the process: the driver sends
//! it as the `X-ClickHouse-Key` header, not in the logged query string.
//!
//! What this pins, beyond "the driver works":
//!   * row decoding against the house rules in AGENTS.md — enforced by the
//!     driver's `output_format_json_quote_*` request settings plus
//!     normalize_cell(): exact u64/i64, DECIMAL as an exact string, NaN/±Inf
//!     as string sentinels, never confused with NULL;
//!   * the frontend's schema-sweep and DBA-view SQL, extracted verbatim from
//!     src/hooks/useSchemaCompletions.ts and src/utils/dbaViews.ts (a query
//!     that is merely plausible fails when a user clicks it — the worst place
//!     to find out);
//!   * the EXPLAIN result shapes src/utils/planClickhouse.ts parses.

use anyhow::Result;

use super::clickhouse::{self, ChSession};
use super::types::{ConnectionConfig, Engine, QueryResult, SslMode};

/// `(config, password)` from the environment, or `None` when the gate is
/// closed. `None` means "skip", not "fail".
fn live_config() -> Option<(ConnectionConfig, String)> {
    let password = std::env::var("TXUI_CH_PASSWORD").ok()?;
    let raw = std::env::var("TXUI_CH_URL")
        .unwrap_or_else(|_| "http://localhost:8123".into());
    let url = reqwest::Url::parse(&raw).expect("TXUI_CH_URL must be a valid URL");

    let mut c = ConnectionConfig::new(Engine::Clickhouse, "ch-live-env");
    c.host = Some(url.host_str().unwrap_or("127.0.0.1").to_string());
    c.port = Some(url.port().unwrap_or(if url.scheme() == "https" { 8443 } else { 8123 }));
    c.user = Some(std::env::var("TXUI_CH_USER").unwrap_or_else(|_| "default".into()));
    // The scheme decides TLS, matching ch_scheme()'s port convention.
    c.ssl_mode = if url.scheme() == "https" { SslMode::Require } else { SslMode::Disable };
    Some((c, password))
}

fn session() -> Option<ChSession> {
    let (c, password) = live_config()?;
    Some(clickhouse::open(&c, Some(password), None).expect("open session"))
}

macro_rules! skip_unless {
    ($s:ident) => {
        let Some($s) = session() else {
            println!("TXUI_CH_PASSWORD unset — skipping (set it plus TXUI_CH_URL to run live)");
            return;
        };
    };
}

// ── 1. connect + version ────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "needs TXUI_CH_PASSWORD and a live ClickHouse"]
async fn clickhouse_live_connect_and_version() {
    skip_unless!(s);
    let r = clickhouse::execute(&s, "SELECT version()").await.expect("SELECT version()");
    assert_eq!(r.rows.len(), 1);
    let v = r.rows[0][0].as_str().expect("version is a string").to_string();
    // This fleet runs against a 26.8.x server; a different major/minor is not
    // a driver failure, but the sweep/DBA assertions below were validated on
    // 26.8 and a drift here is the first thing to know about.
    assert!(v.starts_with("26.8"), "expected a 26.8.x server, got {v}");
    println!("  connected · clickhouse {v}");
}

// ── 2. row decoding ─────────────────────────────────────────────────────────
//
// AGENTS.md's house rules (NULL checked first, unsigned as u64, DECIMAL exact
// as a string never through f64, NaN/±Infinity as string sentinels) were
// written for the sqlx drivers, which decode the wire format themselves. The
// ClickHouse driver passes the server's JSONCompact body through — so the
// rules are enforced by attaching `output_format_json_quote_64bit_integers`,
// `output_format_json_quote_decimals` and `output_format_json_quote_denormals`
// to every request (settings()), and normalize_cell() then applies them:
//
//   * UInt64 / Int64 arrive as quoted strings and are parsed back into exact
//     serde_json u64/i64 — full range, 2^53+1 included.
//   * Decimal arrives as a string and stays one — exact at any precision.
//   * NaN / ±Infinity arrive as "nan"/"inf"/"-inf" and become the house
//     sentinels "NaN"/"Infinity"/"-Infinity" — never confused with NULL.
//
// These assertions pin the FIXED behavior (the pre-fix divergences lived here
// as assert_ne!/is_null pins); a driver or server change that regresses them
// fails loudly.

#[tokio::test]
#[ignore = "needs TXUI_CH_PASSWORD and a live ClickHouse"]
async fn clickhouse_live_row_decoding() {
    skip_unless!(s);
    let r = clickhouse::execute(&s,
        "SELECT toUInt64(18446744073709551615) AS u64_max, \
                toUInt64(9007199254740993) AS u64_beyond_f53, \
                toInt64(-9223372036854775808) AS i64_min, \
                toDecimal64(1234.5678, 4) AS dec, \
                toDateTime64('2024-03-01 12:34:56.789', 3) AS dt64, \
                CAST(NULL AS Nullable(String)) AS nul, \
                toFloat64(nan) AS f_nan, \
                toFloat64(inf) AS f_inf, \
                toFloat64(-inf) AS f_ninf, \
                'hello' AS s",
    ).await.expect("decode probe");
    assert_eq!(r.rows.len(), 1);
    let row = &r.rows[0];
    assert_eq!(row.len(), 10);

    // Column metadata: server type names, and Nullable() detection.
    let types: Vec<&str> = r.columns.iter().map(|c| c.type_name.as_str()).collect();
    assert_eq!(types, [
        "UInt64", "UInt64", "Int64", "Decimal(18, 4)", "DateTime64(3)",
        "Nullable(String)", "Float64", "Float64", "Float64", "String",
    ]);
    assert!(r.columns[5].nullable, "Nullable(String) must be flagged nullable");
    assert!(r.columns.iter().enumerate().all(|(i, c)| i == 5 || !c.nullable),
            "ClickHouse columns are NOT NULL unless wrapped: {types:?}");

    // Unsigned stays unsigned, at full u64 range — and beyond f53 precision:
    // quoted on the wire, parsed back to exact serde_json numbers.
    assert_eq!(row[0].as_u64(), Some(u64::MAX));
    assert_eq!(row[1].as_u64(), Some(9_007_199_254_740_993)); // 2^53 + 1
    // The value must round-trip to the frontend byte-identical.
    assert_eq!(serde_json::to_string(&row[0]).unwrap(), "18446744073709551615");
    assert_eq!(serde_json::to_string(&row[1]).unwrap(), "9007199254740993");
    // Signed minimum, likewise exact.
    assert_eq!(row[2].as_i64(), Some(i64::MIN));

    // Decimal: the house rule — an exact string, never through f64.
    assert_eq!(row[3].as_str(), Some("1234.5678"));

    // DateTime64(3) is a formatted string, milliseconds included.
    assert_eq!(row[4].as_str(), Some("2024-03-01 12:34:56.789"));

    // NULL is null.
    assert!(row[5].is_null());

    // NaN / ±Infinity: the house string sentinels, distinct from NULL.
    assert_eq!(row[6].as_str(), Some("NaN"));
    assert_eq!(row[7].as_str(), Some("Infinity"));
    assert_eq!(row[8].as_str(), Some("-Infinity"));

    assert_eq!(row[9].as_str(), Some("hello"));

    // The big-Decimal regression pin, inverted: Decimal(38,4) must now
    // round-trip exactly as a string.
    let big = clickhouse::execute(&s,
        "SELECT toDecimal128('123456789012345678.1234', 4) AS d",
    ).await.expect("big decimal");
    assert_eq!(big.rows[0][0].as_str(), Some("123456789012345678.1234"),
        "Decimal exactness regressed — the quoting settings stopped reaching the server");
    println!("  u64/i64 exact · Decimal exact string · NaN/±Inf sentinels");
}

// ── 3. schema-sweep SQL ─────────────────────────────────────────────────────
//
// The exact statements the editor's completion cache and hint providers run,
// copied verbatim (whitespace included) from src/hooks/useSchemaCompletions.ts:
// the bulk sweep (sweepSchemas/sweepObjects), the server-variables list, the
// per-table index-hint query, the routine signature lookup and the
// objects-in-schema list. `sqlLiteral(_, 'clickhouse')` renders single-quoted
// literals, as used below.

#[tokio::test]
#[ignore = "needs TXUI_CH_PASSWORD and a live ClickHouse"]
async fn clickhouse_live_schema_sweep_sql() {
    skip_unless!(s);

    // sweepSchemas — the database list.
    let dbs = clickhouse::execute(&s,
        "SELECT name FROM system.databases ORDER BY name LIMIT 5000",
    ).await.expect("sweep: databases");
    assert!(!dbs.rows.is_empty(), "system.databases must not be empty");
    assert!(dbs.rows.iter().any(|r| r[0].as_str() == Some("system")),
            "the system database must be listed");

    // sweepObjects — every selectable object outside the system catalogs.
    let tables = clickhouse::execute(&s,
        "SELECT database, name, engine FROM system.tables
           WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') AND NOT is_temporary
           LIMIT 20000",
    ).await.expect("sweep: tables");
    assert_eq!(tables.columns.len(), 3, "the sweep consumes (database, name, engine)");
    println!("  sweep: {} user objects", tables.rows.len());

    // sweepObjects — global functions (~1500 of them; aliases excluded).
    let fns = clickhouse::execute(&s,
        "SELECT '' AS db, name, if(is_aggregate, 'AGGREGATE', 'FUNCTION') AS kind
           FROM system.functions WHERE alias_to = '' ORDER BY name LIMIT 20000",
    ).await.expect("sweep: functions");
    assert!(fns.rows.len() > 500, "only {} functions — the sweep looks broken", fns.rows.len());
    println!("  sweep: {} functions", fns.rows.len());

    // varsFor — the server-variable completion source.
    let vars = clickhouse::execute(&s,
        "SELECT name, value FROM system.settings ORDER BY name",
    ).await.expect("sweep: settings");
    assert!(vars.rows.len() > 100, "only {} settings", vars.rows.len());

    // indexHintsFor — partition/primary-key prefix plus skip indices. The
    // frontend aims this at USER tables; system.parts carries no key flags at
    // all, so a keyed fixture is created (and always dropped) for it. Its own
    // database name, separate from the EXPLAIN test's — cargo runs these tests
    // in parallel and a shared scratch name races.
    let _ = clickhouse::execute(&s, "DROP DATABASE IF EXISTS txui_ch_live_sweep").await;
    clickhouse::execute(&s, "CREATE DATABASE txui_ch_live_sweep").await.expect("sweep fixture");
    let fixture = async {
        clickhouse::execute(&s,
            "CREATE TABLE txui_ch_live_sweep.t (id UInt64, s String) ENGINE = MergeTree ORDER BY id",
        ).await?;
        clickhouse::execute(&s,
            "SELECT name FROM system.columns
             WHERE database = 'txui_ch_live_sweep'
               AND table = 't'
               AND (is_in_partition_key OR (is_in_primary_key AND position = 1))
             UNION DISTINCT
             SELECT expr FROM system.data_skipping_indices
             WHERE database = 'txui_ch_live_sweep'
               AND table = 't'",
        ).await
    }.await;
    let _ = clickhouse::execute(&s, "DROP DATABASE IF EXISTS txui_ch_live_sweep").await;
    let idx = fixture.expect("sweep: index hints");
    assert_eq!(idx.rows.len(), 1, "the fixture's ORDER BY id is one primary-key hint");
    assert_eq!(idx.rows[0][0].as_str(), Some("id"));

    // routineHintFor — a function's full call form.
    let hint = clickhouse::execute(&s,
        "SELECT name, syntax FROM system.functions WHERE name = 'count' LIMIT 1",
    ).await.expect("sweep: routine hint");
    assert_eq!(hint.rows.len(), 1, "the 'count' function must be describable");

    // objects-in-schema list (the per-schema expansion query).
    let objs = clickhouse::execute(&s,
        "SELECT name, if(engine LIKE '%View', 'VIEW', 'BASE TABLE') FROM system.tables
         WHERE database = 'system' ORDER BY name",
    ).await.expect("sweep: objects in schema");
    assert!(objs.rows.len() > 20, "system holds dozens of tables: {}", objs.rows.len());

    println!("  all 7 sweep statements parse and return rows on this server");
}

// ── 4. DBA views ────────────────────────────────────────────────────────────
//
// Every ClickHouse entry of DBA_VIEWS in src/utils/dbaViews.ts, extracted
// verbatim (a snapshot — re-extract if the views change). The tolerance
// philosophy mirrors dev/probe_pg_views.mjs: EMPTY is a fine answer (no
// replicas, no mutations, no dropped tables); a server REJECTION is a bug in
// the view.
//
// One class of rejection is excused, and it is config, not version: four
// system tables exist only when the server config enables them — the
// `<query_log>` / `<part_log>` / `<text_log>` server-config blocks and a
// configured Keeper (`zookeeper_connection`). A view whose ONLY problem is
// that its table is absent from this server's system catalog is noted as
// expected-skip; anything else fails.
const CONFIG_DEPENDENT_TABLES: &[&str] = &[
    "system.query_log",
    "system.part_log",
    "system.text_log",
    "system.zookeeper_connection",
];
const DBA_VIEWS: &[(&str, &str)] = &[
    (
        "ch-overview",
        r#"SELECT database, name AS table, engine,
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
            ORDER BY total_bytes DESC LIMIT 300"#,
    ),
    (
        "ch-partitions",
        r#"SELECT database, table, partition,
                   count() AS parts, sum(rows) AS rows,
                   formatReadableSize(sum(bytes_on_disk)) AS size,
                   max(level) AS max_level,
                   min(min_time) AS oldest, max(max_time) AS newest,
                   min(modification_time) AS first_written, max(modification_time) AS last_written
            FROM system.parts
            WHERE active AND database NOT IN ('system')
            GROUP BY database, table, partition
            ORDER BY sum(bytes_on_disk) DESC LIMIT 300"#,
    ),
    (
        "ch-ttl",
        r#"SELECT t.database, t.name AS table,
                   replaceRegexpOne(extract(t.create_table_query, 'TTL\\s+([^\\n]+)'),
                                    '\\s+SETTINGS .*$', '') AS ttl_expression,
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
            ORDER BY t.create_table_query NOT LIKE '%TTL %', p.rows DESC LIMIT 300"#,
    ),
    (
        "ch-ttl-debt",
        r#"SELECT database, table, partition, name AS part,
                   rows, formatReadableSize(bytes_on_disk) AS size, level,
                   delete_ttl_info_max AS should_have_gone,
                   dateDiff('hour', delete_ttl_info_max, now()) AS hours_overdue,
                   modification_time AS last_touched
            FROM system.parts
            WHERE active AND delete_ttl_info_max > toDateTime(0)
              AND delete_ttl_info_max < now()
            ORDER BY delete_ttl_info_max ASC LIMIT 300"#,
    ),
    (
        "ch-lowcard",
        r#"SELECT c.database, c.table, c.name AS column, c.type,
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
            ORDER BY sum(pc.column_data_uncompressed_bytes) DESC LIMIT 200"#,
    ),
    (
        "ch-storage",
        r#"SELECT policy_name, volume_name, volume_priority, disks, volume_type,
                   formatReadableSize(max_data_part_size) AS max_part_size,
                   move_factor, prefer_not_to_merge, perform_ttl_move_on_insert
            FROM system.storage_policies ORDER BY policy_name, volume_priority"#,
    ),
    (
        "ch-keys",
        r#"SELECT database, table, name AS column, type, position,
                   if(is_in_partition_key, 'partition', '') AS partition,
                   if(is_in_primary_key, 'primary', '') AS primary,
                   if(is_in_sorting_key, 'sorting', '') AS sorting,
                   if(is_in_sampling_key, 'sampling', '') AS sampling,
                   compression_codec AS codec, default_kind, default_expression
            FROM system.columns
            WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
              AND (is_in_partition_key OR is_in_primary_key
                   OR is_in_sorting_key OR is_in_sampling_key)
            ORDER BY database, table, position LIMIT 500"#,
    ),
    (
        "ch-projections",
        r#"SELECT database, table, name, type, sorting_key, query
            FROM system.projections
            WHERE database NOT IN ('system') ORDER BY database, table, name LIMIT 200"#,
    ),
    (
        "ch-clusters",
        r#"SELECT cluster, shard_num, shard_weight, replica_num, host_name, host_address,
                   port, is_local, user, errors_count, slowdowns_count, estimated_recovery_time
            FROM system.clusters ORDER BY cluster, shard_num, replica_num LIMIT 300"#,
    ),
    (
        "ch-repl-queue",
        r#"SELECT database, table, position, node_name, type, create_time,
                   is_currently_executing, num_tries, num_postponed, postpone_reason,
                   last_attempt_time, last_exception
            FROM system.replication_queue
            ORDER BY num_tries DESC, create_time ASC LIMIT 300"#,
    ),
    (
        "ch-dist-queue",
        r#"SELECT database, table, data_path, is_blocked, error_count,
                   data_files, formatReadableSize(data_compressed_bytes) AS pending,
                   broken_data_files, last_exception
            FROM system.distribution_queue ORDER BY data_compressed_bytes DESC LIMIT 200"#,
    ),
    (
        "ch-db-replicas",
        r#"SELECT database, is_readonly, zookeeper_path, shard_name, replica_name,
                   max_log_ptr, log_ptr, total_replicas, zookeeper_exception
            FROM system.database_replicas ORDER BY database LIMIT 200"#,
    ),
    (
        "ch-zookeeper",
        r#"SELECT name, host, port, index, connected_time,
                   session_uptime_elapsed_seconds AS uptime_s,
                   is_expired, keeper_api_version, xid
            FROM system.zookeeper_connection LIMIT 50"#,
    ),
    (
        "ch-part-log",
        r#"SELECT event_time, event_type, merge_reason, database, table, part_name,
                   partition_id, rows, formatReadableSize(size_in_bytes) AS size,
                   duration_ms, peak_memory_usage, error, exception
            FROM system.part_log
            WHERE event_time > now() - INTERVAL 6 HOUR
            ORDER BY event_time DESC LIMIT 300"#,
    ),
    (
        "ch-moves",
        r#"SELECT database, table, elapsed, target_disk_name, target_disk_path,
                   part_name, formatReadableSize(part_size) AS size, thread_id
            FROM system.moves ORDER BY elapsed DESC LIMIT 200"#,
    ),
    (
        "ch-async-inserts",
        r#"SELECT database, table, format, first_update,
                   formatReadableSize(total_bytes) AS buffered,
                   length(entries.query_id) AS queries
            FROM system.asynchronous_inserts
            ORDER BY total_bytes DESC LIMIT 200"#,
    ),
    (
        "ch-view-refreshes",
        r#"SELECT database, view, status, last_success_time, last_refresh_time,
                   next_refresh_time, exception, retry, progress
            FROM system.view_refreshes ORDER BY database, view LIMIT 200"#,
    ),
    (
        "ch-dropped",
        r#"SELECT database, table, uuid, engine, metadata_dropped_path, table_dropped_time
            FROM system.dropped_tables ORDER BY table_dropped_time DESC LIMIT 200"#,
    ),
    (
        "ch-warnings",
        r#"SELECT * FROM system.warnings LIMIT 200"#,
    ),
    (
        "ch-errors-total",
        r#"SELECT name, code, value AS occurrences, last_error_time, last_error_message
            FROM system.errors WHERE value > 0
            ORDER BY last_error_time DESC LIMIT 300"#,
    ),
    (
        "ch-text-log",
        r#"SELECT event_time, level, logger_name, message, source_file, source_line
            FROM system.text_log
            WHERE level <= 'Warning' AND event_time > now() - INTERVAL 3 HOUR
            ORDER BY event_time DESC LIMIT 300"#,
    ),
    (
        "ch-mt-settings",
        r#"SELECT name, value, default, type, description
            FROM system.merge_tree_settings WHERE changed ORDER BY name LIMIT 300"#,
    ),
    (
        "ch-user-processes",
        r#"SELECT user, formatReadableSize(memory_usage) AS memory,
                   formatReadableSize(peak_memory_usage) AS peak
            FROM system.user_processes ORDER BY memory_usage DESC LIMIT 200"#,
    ),
    (
        "ch-grants",
        r#"SELECT user_name, role_name, access_type, database, table, column,
                   is_partial_revoke, grant_option
            FROM system.grants ORDER BY user_name, role_name, database, table LIMIT 500"#,
    ),
    (
        "ch-row-policies",
        r#"SELECT name, short_name, database, table, select_filter,
                   is_restrictive, apply_to_all, apply_to_list, apply_to_except
            FROM system.row_policies ORDER BY database, table, name LIMIT 300"#,
    ),
    (
        "ch-quotas",
        r#"SELECT quota_name, quota_key, start_time, duration,
                   queries, max_queries, errors, max_errors,
                   result_rows, read_rows, max_read_rows,
                   execution_time, max_execution_time
            FROM system.quota_usage LIMIT 300"#,
    ),
    (
        "ch-tables",
        r#"SELECT database, table, any(engine) AS engine,
                   formatReadableSize(sum(bytes_on_disk)) AS disk,
                   formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed,
                   round(sum(data_uncompressed_bytes) / nullIf(sum(bytes_on_disk), 0), 1) AS ratio,
                   sum(rows) AS rows, count() AS parts, uniqExact(partition) AS partitions
            FROM system.parts
            LEFT JOIN system.tables AS t ON t.database = parts.database AND t.name = parts.table
            WHERE active AND parts.database NOT IN ('system')
            GROUP BY database, table
            ORDER BY sum(bytes_on_disk) DESC LIMIT 200"#,
    ),
    (
        "ch-columns",
        r#"SELECT pc.database, pc.table, pc.column, any(pc.type) AS type,
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
            ORDER BY sum(pc.column_data_compressed_bytes) DESC LIMIT 300"#,
    ),
    (
        "ch-parts",
        r#"SELECT database, table, partition, count() AS parts,
                   formatReadableSize(sum(bytes_on_disk)) AS disk, sum(rows) AS rows,
                   max(level) AS max_merge_level, min(modification_time) AS oldest
            FROM system.parts WHERE active AND database NOT IN ('system')
            GROUP BY database, table, partition
            ORDER BY parts DESC LIMIT 200"#,
    ),
    (
        "ch-part-detail",
        r#"SELECT database, table, name, partition, rows,
                   formatReadableSize(bytes_on_disk) AS disk, level, modification_time
            FROM system.parts WHERE active AND database NOT IN ('system')
            ORDER BY bytes_on_disk DESC LIMIT 100"#,
    ),
    (
        "ch-detached",
        r#"SELECT database, table, partition_id, name, reason, disk
            FROM system.detached_parts ORDER BY database, table LIMIT 200"#,
    ),
    (
        "ch-skip-idx",
        r#"SELECT database, table, name, type_full, expr, granularity
            FROM system.data_skipping_indices ORDER BY database, table LIMIT 200"#,
    ),
    (
        "ch-dicts",
        r#"SELECT database, name, status, type, source,
                   element_count, formatReadableSize(bytes_allocated) AS memory,
                   round(found_rate, 3) AS found_rate,
                   round(loading_duration, 1) AS loading_duration,
                   last_successful_update_time, last_exception
            FROM system.dictionaries
            ORDER BY bytes_allocated DESC LIMIT 100"#,
    ),
    (
        "ch-dict-load",
        r#"SELECT database, name, status, source,
                   last_successful_update_time, last_exception
            FROM system.dictionaries
            WHERE status != 'LOADED'
            ORDER BY database, name LIMIT 100"#,
    ),
    (
        "ch-views",
        r#"SELECT database, name, engine, substring(as_select, 1, 300) AS definition
            FROM system.tables WHERE engine IN ('View','MaterializedView','LiveView')
            ORDER BY database, name LIMIT 200"#,
    ),
    (
        "ch-processes",
        r#"SELECT query_id, user, address, round(elapsed, 2) AS elapsed_s,
                   formatReadableSize(memory_usage) AS memory, read_rows,
                   formatReadableSize(read_bytes) AS read_bytes,
                   substring(query, 1, 300) AS query
            FROM system.processes ORDER BY elapsed DESC"#,
    ),
    (
        "ch-merges",
        r#"SELECT database, table, round(elapsed, 1) AS elapsed_s, round(progress * 100, 1) AS pct,
                   num_parts, formatReadableSize(total_size_bytes_compressed) AS size,
                   formatReadableSize(memory_usage) AS memory, is_mutation, result_part_name
            FROM system.merges ORDER BY elapsed DESC"#,
    ),
    (
        "ch-mutations",
        r#"SELECT database, table, mutation_id, command, create_time, is_done,
                   parts_to_do, latest_fail_reason
            FROM system.mutations ORDER BY create_time DESC LIMIT 100"#,
    ),
    (
        "ch-slow",
        r#"SELECT round(query_duration_ms) AS ms, user, read_rows,
                   formatReadableSize(read_bytes) AS read_bytes,
                   formatReadableSize(memory_usage) AS memory, result_rows,
                   query_start_time, substring(query, 1, 300) AS query
            FROM system.query_log
            WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 1 DAY
            ORDER BY query_duration_ms DESC LIMIT 100"#,
    ),
    (
        "ch-patterns",
        r#"SELECT any(normalizeQuery(query)) AS sample, count() AS runs,
                   round(sum(query_duration_ms)) AS total_ms,
                   round(avg(query_duration_ms)) AS avg_ms,
                   formatReadableSize(sum(memory_usage)) AS total_mem,
                   sum(read_rows) AS rows_read
            FROM system.query_log
            WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 24 HOUR
            GROUP BY normalized_query_hash
            ORDER BY total_ms DESC LIMIT 100"#,
    ),
    (
        "ch-heavy",
        r#"SELECT normalized_query_hash, count() AS runs,
                   formatReadableSize(sum(read_bytes)) AS total_read,
                   sum(read_rows) AS total_rows, round(avg(query_duration_ms)) AS avg_ms,
                   substring(any(query), 1, 300) AS sample
            FROM system.query_log
            WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 1 DAY
            GROUP BY normalized_query_hash
            ORDER BY sum(read_bytes) DESC LIMIT 100"#,
    ),
    (
        "ch-errors",
        r#"SELECT event_time, user, exception_code, substring(exception, 1, 200) AS exception,
                   substring(query, 1, 250) AS query
            FROM system.query_log
            WHERE type = 'ExceptionBeforeStart' OR type = 'ExceptionWhileProcessing'
              AND event_time > now() - INTERVAL 1 DAY
            ORDER BY event_time DESC LIMIT 100"#,
    ),
    (
        "ch-metrics",
        r#"SELECT metric, value, description FROM system.metrics
            WHERE value != 0 ORDER BY metric"#,
    ),
    (
        "ch-async",
        r#"SELECT metric, round(value, 3) AS value, description
            FROM system.asynchronous_metrics ORDER BY metric"#,
    ),
    (
        "ch-events",
        r#"SELECT event, value, description FROM system.events ORDER BY value DESC LIMIT 200"#,
    ),
    (
        "ch-settings",
        r#"SELECT name, value, default AS default_value, type, readonly, description
            FROM system.settings WHERE changed ORDER BY name"#,
    ),
    (
        "ch-disks",
        r#"SELECT name, path, formatReadableSize(free_space) AS free,
                   formatReadableSize(total_space) AS total,
                   round(100 - free_space / nullIf(total_space, 0) * 100, 1) AS used_pct, type
            FROM system.disks"#,
    ),
    (
        "ch-replicas",
        r#"SELECT database, table, is_leader, is_readonly, is_session_expired,
                   future_parts, parts_to_check, absolute_delay, queue_size,
                   inserts_in_queue, merges_in_queue, last_queue_update_exception
            FROM system.replicas ORDER BY absolute_delay DESC"#,
    ),
    (
        "ch-users",
        r#"SELECT name, storage, auth_type, valid_until, default_database,
                   host_ip, host_names, host_names_like, host_names_regexp,
                   default_roles_all, default_roles_list, default_roles_except
            FROM system.users ORDER BY name LIMIT 300"#,
    ),
];

#[tokio::test]
#[ignore = "needs TXUI_CH_PASSWORD and a live ClickHouse"]
async fn clickhouse_live_dba_views() {
    skip_unless!(s);

    // Which system.* tables actually exist here — decides expected-skip vs FAIL.
    let existing = clickhouse::execute(&s,
        "SELECT database || '.' || name FROM system.tables WHERE database = 'system'",
    ).await.expect("system catalog");
    let existing: std::collections::HashSet<String> = existing.rows.iter()
        .filter_map(|r| r[0].as_str().map(str::to_string))
        .collect();

    let mut failed: Vec<(&str, String)> = Vec::new();
    for (id, sql) in DBA_VIEWS {
        match clickhouse::execute(&s, sql).await {
            Ok(r) if r.rows.is_empty() => println!("  EMPTY {id}"),
            Ok(r) => println!("  ok    {id} ({} rows)", r.rows.len()),
            Err(e) => {
                let msg = e.to_string();
                // A rejection whose only cause is a config-dependent system
                // table this server never enabled is expected, and says so.
                let missing_config_table = msg.contains("UNKNOWN_TABLE")
                    && CONFIG_DEPENDENT_TABLES.iter().any(|t| msg.contains(t) && !existing.contains(*t));
                if missing_config_table {
                    println!("  SKIP  {id} (system table not enabled in this server's config)");
                } else {
                    println!("  FAIL  {id}: {msg}");
                    failed.push((id, msg));
                }
            }
        }
    }
    assert!(failed.is_empty(),
        "{} of {} ClickHouse DBA views were rejected by the server: {}",
        failed.len(), DBA_VIEWS.len(),
        failed.iter().map(|(id, _)| *id).collect::<Vec<_>>().join(", "));
    println!("  {}/{} DBA views accepted", DBA_VIEWS.len() - failed.len(), DBA_VIEWS.len());
}

// ── 5. EXPLAIN shapes ───────────────────────────────────────────────────────
//
// The contract the frontend parses (src/utils/planClickhouse.ts), restated as
// assertions on the raw driver output:
//
//   * PLAN / PIPELINE / indexes=1 answer ONE String column named "explain",
//     one row per printed line. ops.rs's plan_text() joins the rows with \n
//     and the parser rebuilds a tree from the indentation — so the text must
//     have at least two non-empty lines and at least one indented line, or
//     parseClickhousePlan throws and the UI falls back to the raw view.
//   * PIPELINE prints scope headers as bare parenthesised lines ("(…)") and
//     transform lines beneath them; both shapes are recognised by chNode().
//   * indexes=1 prints an "Indexes:" section whose "Keys:" / "Condition:" /
//     "Parts:" / "Granules:" labels are exactly the prefix list chNode()
//     splits on.
//   * ESTIMATE answers a five-column typed table (database, table, parts,
//     rows, marks — the three counts UInt64), one row per table read. ops.rs
//     tab-joins the columns for the frontend, and looksLikeEstimate() accepts
//     only lines of exactly five tab-separated fields with numeric tails.
//
// The fixtures live in a scratch database the test creates and always drops.

/// The statements ops.rs's explain_query builds for each toolbar mode.
fn explain_statements(sql: &str) -> [(&'static str, String); 5] {
    [
        ("plain",    format!("EXPLAIN {sql}")),
        ("plan",     format!("EXPLAIN PLAN {sql}")),
        ("pipeline", format!("EXPLAIN PIPELINE {sql}")),
        ("estimate", format!("EXPLAIN ESTIMATE {sql}")),
        ("indexes",  format!("EXPLAIN indexes = 1 {sql}")),
    ]
}

/// Rebuild the text the frontend would parse and assert it has drawable
/// structure; returns the text for kind-specific checks.
fn check_text_plan(kind: &str, r: &QueryResult) -> String {
    assert_eq!(r.columns.len(), 1, "{kind}: a text plan is one column, got {:?}", r.columns);
    assert_eq!(r.columns[0].type_name, "String", "{kind}: plan lines are strings");
    // ops.rs plan_text(): the LAST column of each row, joined with \n.
    let text = r.rows.iter()
        .map(|row| row.last().and_then(|v| v.as_str()).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n");
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
    assert!(lines.len() >= 2,
        "{kind}: a one-line answer throws in parseClickhousePlan (falls back to raw): {text:?}");
    assert!(lines.iter().any(|l| l.starts_with(' ')),
        "{kind}: the tree is rebuilt from indentation — no indented line, no tree: {text:?}");
    text
}

async fn explain_shapes_inner(s: &ChSession) -> Result<()> {
    clickhouse::execute(s, "CREATE DATABASE txui_ch_live_test").await?;
    clickhouse::execute(s,
        "CREATE TABLE txui_ch_live_test.t (id UInt64, s String) ENGINE = MergeTree ORDER BY id",
    ).await?;
    clickhouse::execute(s, "INSERT INTO txui_ch_live_test.t VALUES (1, 'a'), (2, 'b'), (3, 'c')").await?;

    for (kind, stmt) in explain_statements("SELECT * FROM txui_ch_live_test.t WHERE id = 1") {
        let r = clickhouse::execute(s, &stmt).await
            .unwrap_or_else(|e| panic!("{kind}: server rejected {stmt:?}: {e}"));
        match kind {
            "estimate" => {
                let names: Vec<&str> = r.columns.iter().map(|c| c.name.as_str()).collect();
                assert_eq!(names, ["database", "table", "parts", "rows", "marks"],
                    "parseEstimate splits each row into exactly these five");
                let types: Vec<&str> = r.columns.iter().map(|c| c.type_name.as_str()).collect();
                assert_eq!(types, ["String", "String", "UInt64", "UInt64", "UInt64"],
                    "the three counts must be numeric or looksLikeEstimate rejects the table");
                assert!(!r.rows.is_empty(), "ESTIMATE must name the table it read");
                // Replay ops.rs's estimate branch: tab-join every column.
                for row in &r.rows {
                    let line = row.iter().map(|v| match v {
                        serde_json::Value::String(s) => s.clone(),
                        other => serde_json::to_string(other).unwrap_or_default(),
                    }).collect::<Vec<_>>().join("\t");
                    let f: Vec<&str> = line.split('\t').collect();
                    assert_eq!(f.len(), 5, "looksLikeEstimate wants five fields: {line:?}");
                    assert!(f[2].parse::<u64>().is_ok()
                            && f[3].parse::<u64>().is_ok()
                            && f[4].parse::<u64>().is_ok(),
                        "parts/rows/marks must parse as numbers: {line:?}");
                }
                assert!(r.rows.iter().any(|row| row[0].as_str() == Some("txui_ch_live_test")
                    && row[1].as_str() == Some("t")));
                println!("  estimate: {} table(s), 5 typed columns as the renderer expects", r.rows.len());
            }
            "pipeline" => {
                let text = check_text_plan(kind, &r);
                // Scope headers are bare "(…)" lines — chNode() keys on exactly that.
                assert!(text.lines().any(|l| {
                    let t = l.trim();
                    t.starts_with('(') && t.ends_with(')')
                }), "pipeline: no (Scope) header line: {text:?}");
                assert!(text.contains("Transform"), "pipeline: no transform lines: {text:?}");
                println!("  pipeline: {} lines with scope headers + transforms", text.lines().count());
            }
            "indexes" => {
                let text = check_text_plan(kind, &r);
                // The label list chNode() splits on — these are the lines the
                // UI lifts out of the tree.
                for label in ["Indexes:", "PrimaryKey", "Keys:", "Condition:", "Parts:", "Granules:"] {
                    assert!(text.contains(label), "indexes: missing {label:?} line: {text:?}");
                }
                println!("  indexes: primary-key ranges present ({} lines)", text.lines().count());
            }
            _ => {
                let text = check_text_plan(kind, &r);
                assert!(text.contains("ReadFromMergeTree"),
                    "{kind}: the scan node must be named for chKind() to classify it: {text:?}");
                println!("  {kind}: {} lines, indented tree", text.lines().count());
            }
        }
    }
    Ok(())
}

#[tokio::test]
#[ignore = "needs TXUI_CH_PASSWORD and a live ClickHouse"]
async fn clickhouse_live_explain_shapes() {
    skip_unless!(s);
    // Clean slate, then the scratch database is dropped even when an
    // assertion fails — the probe must not leave fixtures behind.
    let _ = clickhouse::execute(&s, "DROP DATABASE IF EXISTS txui_ch_live_test").await;
    let outcome = explain_shapes_inner(&s).await;
    let dropped = clickhouse::execute(&s, "DROP DATABASE IF EXISTS txui_ch_live_test").await;
    outcome.expect("EXPLAIN shape assertions");
    dropped.expect("drop scratch database");
}
