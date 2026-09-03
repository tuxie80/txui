/// DBA ops: live processlist, server variables/status, EXPLAIN, replication.
/// Killing lives in commands/kill.rs — the single, always-logged kill path.
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::{LiveSession, QueryResult};
use crate::db::{clickhouse, mysql, postgres, redis, sqlserver};
use crate::state::AppState;

/// pg_stat_activity shaped to match SHOW PROCESSLIST ergonomics:
/// one row per backend, longest-running first.
/// Running queries on ClickHouse, shaped like a processlist.
const CH_PROCESSES_SQL: &str = "\
SELECT query_id, user, address, elapsed, \
       formatReadableSize(memory_usage) AS memory, \
       read_rows, formatReadableSize(read_bytes) AS read_bytes, \
       substring(query, 1, 500) AS query \
FROM system.processes ORDER BY elapsed DESC";

/// Settings with their defaults — `changed` marks what differs.
const CH_SETTINGS_SQL: &str = "\
SELECT name, value, changed, default AS default_value, type, description \
FROM system.settings ORDER BY name";

/// Current server counters. metrics are gauges, events are cumulative, and
/// asynchronous_metrics are sampled — unioned so one grid shows all three.
const CH_STATUS_SQL: &str = "\
SELECT 'metric' AS kind, metric AS name, toString(value) AS value, description FROM system.metrics \
UNION ALL \
SELECT 'event', event, toString(value), description FROM system.events \
UNION ALL \
SELECT 'async', metric, toString(value), description FROM system.asynchronous_metrics \
ORDER BY kind, name";

const PG_ACTIVITY_SQL: &str = "\
SELECT pid, \
       usename AS user, \
       datname AS db, \
       state, \
       COALESCE(EXTRACT(EPOCH FROM (now() - query_start))::bigint, 0) AS time, \
       COALESCE(wait_event_type || ':' || wait_event, '') AS wait, \
       LEFT(query, 500) AS query \
FROM pg_stat_activity \
WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' \
ORDER BY time DESC LIMIT 500";
// ^ same server-side cap as the MySQL path (kill::PROCS_LIMIT): applied AFTER
// the ordering, so a PG box with thousands of backends ships the top 500 for
// this 1 Hz poll, not all of them.

/// SQL Server processlist from the DMVs: sessions left-joined to their
/// running request, so an idle-but-open connection still shows (and a blocker
/// with no request of its own is visible). `dm_exec_sql_text` needs VIEW
/// SERVER STATE; without it the server returns the rows with NULL statement
/// text rather than an error — the grid just shows an empty query column.
/// Shared with kill_candidates (commands/kill.rs) so the two panels never
/// disagree about what a session is.
pub(crate) const MSSQL_PROCESSES_SQL: &str = "\
SELECT s.session_id, \
       s.login_name, \
       s.host_name, \
       s.program_name, \
       DB_NAME(s.database_id) AS db, \
       s.status, \
       COALESCE(r.command, '') AS command, \
       COALESCE(r.wait_type, '') AS wait_type, \
       COALESCE(r.wait_time, 0) AS wait_time, \
       COALESCE(r.blocking_session_id, 0) AS blocking_session_id, \
       COALESCE(DATEDIFF(SECOND, r.start_time, GETDATE()), 0) AS elapsed, \
       LEFT(COALESCE(st.text, ''), 1024) AS query \
FROM sys.dm_exec_sessions s \
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id \
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st \
WHERE s.is_user_process = 1 \
ORDER BY elapsed DESC";

#[tauri::command]
pub async fn list_processes(
    session_id: Uuid,
    state: State<'_, AppState>,
) -> Result<QueryResult, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    match session.as_ref() {
        // NOT `SHOW FULL PROCESSLIST`. That form walks the thread list holding
        // the global thread-manager mutex, so on a server with thousands of
        // connections it does not merely return slowly — it stalls new
        // connections while it runs, and this panel polls on a timer.
        //
        // `performance_schema.processlist` (8.0.22+) is the same data without
        // the mutex. It can be empty when the instrument is off, and our own
        // connection is always in the list, so **zero rows means "not
        // available"** and we fall through to the portable form. Same probe
        // `kill_candidates` uses.
        LiveSession::Mysql(pool) => {
            const COLS: &str = "ID, USER, HOST, DB, COMMAND, TIME, STATE, \
                                LEFT(IFNULL(INFO,''), 1024) AS INFO";
            let pfs = mysql::execute(pool, &format!(
                "SELECT {COLS} FROM performance_schema.processlist \
                 ORDER BY TIME DESC LIMIT {}",
                crate::commands::kill::PROCS_LIMIT)).await;
            match pfs {
                Ok(r) if !r.rows.is_empty() => Ok(r),
                _ => mysql::execute(pool, &format!(
                        "SELECT {COLS} FROM information_schema.PROCESSLIST \
                         ORDER BY TIME DESC LIMIT {}",
                        crate::commands::kill::PROCS_LIMIT))
                    .await
                    .map_err(Into::into),
            }
        }
        LiveSession::Postgres(pool) => postgres::execute(pool, PG_ACTIVITY_SQL)
            .await
            .map_err(Into::into),
        // Redis: CLIENT LIST is the processlist. redis_shape turns the
        // `k=v k=v` text into columns, and the panel keys off "id"/"cmd"
        // exactly as it does for a MySQL thread id.
        LiveSession::Redis(mgr, _) => redis::execute(mgr.clone(), "CLIENT LIST")
            .await
            .map_err(Into::into),
        // ClickHouse: system.processes is the running-query list.
        LiveSession::Clickhouse(ch) => clickhouse::execute(ch, CH_PROCESSES_SQL)
            .await
            .map_err(Into::into),
        // MongoDB: db.currentOp() is the processlist — real in-progress
        // operations, longest-running first (db/mongodb.rs shapes it).
        LiveSession::MongoDb(client) => crate::db::mongodb::current_ops(client)
            .await
            .map_err(Into::into),
        // SQL Server: the DMV sessions⋈requests view, statement text included.
        LiveSession::SqlServer(s) => crate::db::sqlserver::execute(s, MSSQL_PROCESSES_SQL)
            .await
            .map_err(Into::into),
        // In-process engines: the only "session" is this app, and a Parquet
        // file has no execution at all.
        LiveSession::Sqlite(_) | LiveSession::Parquet(_) | LiveSession::Duckdb(_) =>
            Err("there is no processlist for a file-backed engine".into()),
    }
}

// ── Server variables / status ─────────────────────────────────────────────────

/// pg_settings shaped for the browser; `source` ≠ 'default' → changed value.
const PG_SETTINGS_SQL: &str = "\
SELECT name, \
       setting AS value, \
       COALESCE(unit, '') AS unit, \
       source, \
       COALESCE(boot_val, '') AS default_value, \
       short_desc AS description \
FROM pg_settings ORDER BY name";

const PG_STATUS_SQL: &str = "\
SELECT numbackends AS backends, xact_commit, xact_rollback, \
       blks_read, blks_hit, \
       tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, \
       conflicts, deadlocks, temp_files, temp_bytes, \
       blk_read_time, blk_write_time \
FROM pg_stat_database WHERE datname = current_database()";

/// sys.configurations is SQL Server's settings view. Values are sql_variant,
/// cast to text for the grid; `value_in_use` is what the server runs with,
/// `value` what is configured (they differ until RECONFIGURE).
const MSSQL_CONFIG_SQL: &str = "\
SELECT name, \
       CAST(value_in_use AS nvarchar(256)) AS value, \
       CAST(value AS nvarchar(256)) AS configured_value, \
       CAST(minimum AS nvarchar(256)) AS minimum, \
       CAST(maximum AS nvarchar(256)) AS maximum, \
       description \
FROM sys.configurations ORDER BY name";

/// The "what the server is" facts: @@VERSION plus the SERVERPROPERTY calls
/// that name the build. There is no server-wide status counter view that is
/// meaningful without a baseline, so status is this same identity view plus
/// the instance-wide counts the DMVs can answer cheaply.
const MSSQL_STATUS_SQL: &str = "\
SELECT 'version' AS name, CAST(@@VERSION AS nvarchar(4000)) AS value \
UNION ALL SELECT 'productversion', CAST(SERVERPROPERTY('productversion') AS nvarchar(256)) \
UNION ALL SELECT 'productlevel', CAST(SERVERPROPERTY('productlevel') AS nvarchar(256)) \
UNION ALL SELECT 'edition', CAST(SERVERPROPERTY('edition') AS nvarchar(256)) \
UNION ALL SELECT 'servername', CAST(SERVERPROPERTY('servername') AS nvarchar(256)) \
UNION ALL SELECT 'machinename', CAST(SERVERPROPERTY('machinename') AS nvarchar(256)) \
UNION ALL SELECT 'instance', COALESCE(CAST(SERVERPROPERTY('instancename') AS nvarchar(256)), '(default)') \
UNION ALL SELECT 'collation', CAST(SERVERPROPERTY('collation') AS nvarchar(256)) \
UNION ALL SELECT 'databases', CAST((SELECT COUNT(*) FROM sys.databases) AS nvarchar(256)) \
UNION ALL SELECT 'user_sessions', CAST((SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS nvarchar(256))";

/// `kind` = "variables" | "status".
#[tauri::command]
pub async fn server_info(
    session_id: Uuid,
    kind: String,
    state: State<'_, AppState>,
) -> Result<QueryResult, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    match (session.as_ref(), kind.as_str()) {
        (LiveSession::Mysql(pool), "variables") =>
            mysql::execute(pool, "SHOW GLOBAL VARIABLES").await.map_err(Into::into),
        (LiveSession::Mysql(pool), "status") =>
            mysql::execute(pool, "SHOW GLOBAL STATUS").await.map_err(Into::into),
        (LiveSession::Postgres(pool), "variables") =>
            postgres::execute(pool, PG_SETTINGS_SQL).await.map_err(Into::into),
        (LiveSession::Postgres(pool), "status") =>
            postgres::execute(pool, PG_STATUS_SQL).await.map_err(Into::into),
        // Redis has no SHOW VARIABLES / pg_settings split: CONFIG GET is the
        // settings view and INFO is the status view. Both are reads.
        (LiveSession::Redis(mgr, _), "variables") =>
            redis_config(mgr.clone()).await,
        (LiveSession::Redis(mgr, _), "status") =>
            redis_info(mgr.clone()).await,
        // ClickHouse: system.settings is the variables view; system.metrics +
        // system.events + system.asynchronous_metrics together are the status.
        (LiveSession::Clickhouse(ch), "variables") =>
            clickhouse::execute(ch, CH_SETTINGS_SQL).await.map_err(Into::into),
        (LiveSession::Clickhouse(ch), "status") =>
            clickhouse::execute(ch, CH_STATUS_SQL).await.map_err(Into::into),
        // DuckDB: duckdb_settings() is the variables view — the engine's own
        // catalog of every setting with value, description, scope and aliases.
        (LiveSession::Duckdb(s), "variables") =>
            crate::db::duckdb::execute(s,
                "SELECT name, value, description, input_type AS type, scope, \
                 aliases FROM duckdb_settings() ORDER BY name")
                .await.map_err(Into::into),
        // MongoDB: buildInfo is the "what the server IS" view, serverStatus
        // the "what it is doing" one — flattened to name/value rows.
        (LiveSession::MongoDb(client), kind @ ("variables" | "status")) =>
            crate::db::mongodb::server_info(client, kind).await.map_err(Into::into),
        // SQL Server: sys.configurations is the variables view; the status
        // view is @@VERSION + SERVERPROPERTY identity facts plus cheap counts.
        (LiveSession::SqlServer(s), "variables") =>
            crate::db::sqlserver::execute(s, MSSQL_CONFIG_SQL).await.map_err(Into::into),
        (LiveSession::SqlServer(s), "status") =>
            crate::db::sqlserver::execute(s, MSSQL_STATUS_SQL).await.map_err(Into::into),
        _ => Err(format!("server info '{}' not available for this engine", kind).into()),
    }
}

/// `CONFIG GET *` reshaped into the name/value/… grid the panel expects.
async fn redis_config(mgr: ::redis::aio::ConnectionManager) -> Result<QueryResult, crate::apperror::AppError> {
    use crate::db::types::ColumnInfo;
    let mut mgr = mgr;
    let pairs: Vec<String> = ::redis::cmd("CONFIG").arg("GET").arg("*")
        .query_async(&mut mgr).await?;

    let mut rows: Vec<Vec<serde_json::Value>> = pairs.chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| vec![
            serde_json::Value::String(c[0].clone()),
            serde_json::Value::String(c[1].clone()),
        ])
        .collect();
    rows.sort_by(|a, b| a[0].as_str().unwrap_or("").cmp(b[0].as_str().unwrap_or("")));

    Ok(QueryResult {
        columns: vec![
            ColumnInfo { name: "name".into(),  type_name: "string".into(), nullable: false },
            ColumnInfo { name: "value".into(), type_name: "string".into(), nullable: true },
        ],
        rows, rows_affected: None, execution_ms: 0, fetch_ms: 0, warnings: vec![],
        truncated: false,
    })
}

/// `INFO all` parsed into section/name/value rows — the INFO text format is
/// `# Section` headers followed by `key:value` lines.
async fn redis_info(mgr: ::redis::aio::ConnectionManager) -> Result<QueryResult, crate::apperror::AppError> {
    use crate::db::types::ColumnInfo;
    let mut mgr = mgr;
    let text: String = ::redis::cmd("INFO").arg("all")
        .query_async(&mut mgr).await?;

    let mut section = String::new();
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Some(name) = line.strip_prefix("# ") {
            section = name.trim().to_string();
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            rows.push(vec![
                serde_json::Value::String(section.clone()),
                serde_json::Value::String(k.to_string()),
                serde_json::Value::String(v.to_string()),
            ]);
        }
    }

    Ok(QueryResult {
        columns: vec![
            ColumnInfo { name: "section".into(), type_name: "string".into(), nullable: false },
            ColumnInfo { name: "name".into(),    type_name: "string".into(), nullable: false },
            ColumnInfo { name: "value".into(),   type_name: "string".into(), nullable: true },
        ],
        rows, rows_affected: None, execution_ms: 0, fetch_ms: 0, warnings: vec![],
        truncated: false,
    })
}

/// Execute WITHOUT touching query history — used by the interval monitor,
/// which would otherwise flood the history log with one entry per tick.
#[tauri::command]
pub async fn monitor_query(
    session_id: Uuid,
    sql: String,
    state: State<'_, AppState>,
) -> Result<QueryResult, crate::apperror::AppError> {
    // Same server-side write guard as execute_query/panel_query — this path
    // is reachable from several panels, so a read-only session must refuse
    // writes here too, not only in the UI.
    // Engine-aware: SQL goes through sqlguard, Redis through redisguard.
    // Choosing a guard per call site is how every Redis write slipped past.
    state.guard_statement(&session_id, &sql).await?;
    // A pinned connection wins: a panel reading during an open transaction must
    // see the session's uncommitted work, not a pooled connection's older view.
    if let Some(r) = state.try_on_tx_conn(&session_id, &sql).await {
        return r;
    }
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    match session.as_ref() {
        LiveSession::Mysql(pool)    => mysql::execute(pool, &sql).await.map_err(Into::into),
        LiveSession::Postgres(pool) => postgres::execute(pool, &sql).await.map_err(Into::into),
        LiveSession::Redis(mgr, _)  => crate::db::redis::execute(mgr.clone(), &sql).await.map_err(Into::into),
        LiveSession::Clickhouse(ch) => clickhouse::execute(ch, &sql).await.map_err(Into::into),
        LiveSession::Sqlite(pool)   => crate::db::sqlite::execute(pool, &sql).await.map_err(Into::into),
        LiveSession::Parquet(f)     => {
            // CPU-bound decode — off the async runtime (mirrors export.rs).
            let f = f.clone();
            let sql = sql.clone();
            tokio::task::spawn_blocking(move || crate::db::parquet::execute(&f, &sql))
                .await
                .map_err(|e| crate::apperror::AppError::from(format!("parquet task failed: {e}")))?
                .map_err(Into::into)
        }
        LiveSession::Duckdb(s)      => crate::db::duckdb::execute(s, &sql).await.map_err(Into::into),
        // Not SQL: the find editor's `mongo_find` command is the query path.
        LiveSession::MongoDb(_)     => Err("MongoDB does not speak SQL — use the find editor".into()),
        // Arbitrary DMV SQL from the DBA views runs through the driver like
        // any user statement (the write guard already ran above).
        LiveSession::SqlServer(s)   => crate::db::sqlserver::execute(s, &sql).await.map_err(Into::into),
    }
}

// ── Replication ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ReplSection {
    pub title: String,
    /// Transposed key/value view (replica status rows are 60+ columns wide)
    pub kv: Option<Vec<(String, String)>>,
    /// Tabular view (connected replicas, pg_stat_replication)
    pub table: Option<QueryResult>,
}

fn display_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Transpose one result row into (column, value) pairs.
fn row_to_kv(result: &QueryResult, row_idx: usize) -> Vec<(String, String)> {
    result.columns.iter().zip(result.rows[row_idx].iter())
        .map(|(c, v)| (c.name.clone(), display_value(v)))
        .collect()
}

const PG_REPLICATION_SQL: &str = "\
SELECT client_addr::text AS client, usename AS user, application_name AS app, \
       state, sync_state, sync_priority, \
       COALESCE(sent_lsn::text, '') AS sent_lsn, \
       COALESCE(write_lsn::text, '') AS write_lsn, \
       COALESCE(flush_lsn::text, '') AS flush_lsn, \
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint AS replay_lag_bytes, \
       COALESCE(write_lag::text, '') AS write_lag, \
       COALESCE(flush_lag::text, '') AS flush_lag, \
       COALESCE(replay_lag::text, '') AS replay_lag, \
       COALESCE(reply_time::text, '') AS reply_time \
FROM pg_stat_replication ORDER BY client_addr";

const PG_SLOTS_SQL: &str = "\
SELECT slot_name, slot_type, active, \
       COALESCE(restart_lsn::text, '') AS restart_lsn, \
       COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint, 0) AS retained_bytes \
FROM pg_replication_slots ORDER BY slot_name";

// pg_is_wal_replay_paused() RAISES "recovery is not in progress" on a primary
// rather than returning NULL, and this query's error was propagated, so the
// whole Replication panel failed on every PostgreSQL primary — the common
// case. CASE short-circuits, so guarding the call keeps the row intact.
// The other pg_last_wal_* functions simply return NULL off a standby.
/// Re-exported so the standby integration tests can assert the exact
/// statement the panel runs, rather than a copy that could drift from it.
#[cfg(test)]
pub const PG_STANDBY_SQL_FOR_TEST: &str = PG_STANDBY_SQL;

const PG_STANDBY_SQL: &str = "\
SELECT pg_is_in_recovery()::text AS in_recovery, \
       COALESCE(pg_last_wal_receive_lsn()::text, '') AS receive_lsn, \
       COALESCE(pg_last_wal_replay_lsn()::text, '') AS replay_lsn, \
       COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::bigint, 0) AS lag_seconds, \
       CASE WHEN pg_is_in_recovery() THEN pg_is_wal_replay_paused()::text ELSE 'false' END AS replay_paused, \
       COALESCE(pg_last_xact_replay_timestamp()::text, '') AS last_replay_time";

/// Logical-replication subscriptions, subscriber side. pg_subscription is
/// superuser-only in older PG and pg_stat_subscription stats may be empty —
/// run error-tolerantly like the slots query.
const PG_SUBSCRIPTIONS_SQL: &str = "\
SELECT s.subname, st.pid, \
       COALESCE(st.received_lsn::text, '') AS received_lsn, \
       COALESCE(st.last_msg_receipt_time::text, '') AS last_msg_receipt_time, \
       COALESCE(st.latest_end_lsn::text, '') AS latest_end_lsn, \
       COALESCE(st.latest_end_time::text, '') AS latest_end_time \
FROM pg_subscription s \
LEFT JOIN pg_stat_subscription st ON st.subid = s.oid \
ORDER BY s.subname";

#[tauri::command]
pub async fn replication_status(
    session_id: Uuid,
    state: State<'_, AppState>,
) -> Result<Vec<ReplSection>, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    let mut sections: Vec<ReplSection> = Vec::new();

    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            // Replica side — modern syntax first, pre-8.0.22 fallback
            let replica = match mysql::execute(pool, "SHOW REPLICA STATUS").await {
                Ok(r) => Ok(r),
                Err(_) => mysql::execute(pool, "SHOW SLAVE STATUS").await,
            };
            match replica {
                Ok(r) if !r.rows.is_empty() => {
                    for i in 0..r.rows.len() {
                        let kv = row_to_kv(&r, i);
                        let channel = kv.iter()
                            .find(|(k, _)| k == "Channel_Name")
                            .map(|(_, v)| v.clone())
                            .filter(|v| !v.is_empty());
                        sections.push(ReplSection {
                            title: match channel {
                                Some(ch) => format!("Replica status — channel '{}'", ch),
                                None => "Replica status".to_string(),
                            },
                            kv: Some(kv),
                            table: None,
                        });
                    }
                }
                Ok(_) => sections.push(ReplSection {
                    title: "Replica status".into(),
                    kv: Some(vec![("Role".into(), "not a replica (no replication configured)".into())]),
                    table: None,
                }),
                Err(e) => sections.push(ReplSection {
                    title: "Replica status".into(),
                    kv: Some(vec![("Error".into(), e.to_string())]),
                    table: None,
                }),
            }

            // Connected replicas (as source)
            let replicas = match mysql::execute(pool, "SHOW REPLICAS").await {
                Ok(r) => Ok(r),
                Err(_) => mysql::execute(pool, "SHOW SLAVE HOSTS").await,
            };
            if let Ok(r) = replicas {
                if !r.rows.is_empty() {
                    sections.push(ReplSection {
                        title: format!("Connected replicas ({})", r.rows.len()),
                        kv: None,
                        table: Some(r),
                    });
                }
            }

            // Binary log position
            let binlog = match mysql::execute(pool, "SHOW BINARY LOG STATUS").await {
                Ok(r) => Ok(r),
                Err(_) => mysql::execute(pool, "SHOW MASTER STATUS").await,
            };
            if let Ok(r) = binlog {
                if !r.rows.is_empty() {
                    sections.push(ReplSection {
                        title: "Binary log".into(),
                        kv: Some(row_to_kv(&r, 0)),
                        table: None,
                    });
                }
            }
        }

        LiveSession::Postgres(pool) => {
            let standby = postgres::execute(pool, PG_STANDBY_SQL)
                .await?;
            let in_recovery = standby.rows.first()
                .and_then(|r| r.first())
                .map(|v| display_value(v) == "true")
                .unwrap_or(false);

            if in_recovery {
                sections.push(ReplSection {
                    title: "Standby (replica) status".into(),
                    kv: Some(row_to_kv(&standby, 0)),
                    table: None,
                });
                if let Ok(r) = postgres::execute(pool, "SELECT status, sender_host, sender_port, COALESCE(slot_name,'') AS slot_name FROM pg_stat_wal_receiver").await {
                    if !r.rows.is_empty() {
                        sections.push(ReplSection {
                            title: "WAL receiver".into(),
                            kv: Some(row_to_kv(&r, 0)),
                            table: None,
                        });
                    }
                }
            } else {
                sections.push(ReplSection {
                    title: "Role".into(),
                    kv: Some(vec![("Role".into(), "primary".into())]),
                    table: None,
                });
                match postgres::execute(pool, PG_REPLICATION_SQL).await {
                    Ok(r) if !r.rows.is_empty() => sections.push(ReplSection {
                        title: format!("Streaming replicas ({})", r.rows.len()),
                        kv: None,
                        table: Some(r),
                    }),
                    Ok(_) => sections.push(ReplSection {
                        title: "Streaming replicas".into(),
                        kv: Some(vec![("Info".into(), "no connected replicas".into())]),
                        table: None,
                    }),
                    Err(e) => sections.push(ReplSection {
                        title: "Streaming replicas".into(),
                        kv: Some(vec![("Error".into(), e.to_string())]),
                        table: None,
                    }),
                }
                if let Ok(r) = postgres::execute(pool, PG_SLOTS_SQL).await {
                    if !r.rows.is_empty() {
                        sections.push(ReplSection {
                            title: "Replication slots".into(),
                            kv: None,
                            table: Some(r),
                        });
                    }
                }
            }

            // Logical subscriptions — applies on the subscriber side, whether
            // that server is also a primary or a standby; tolerate failure
            // (older PG / insufficient privileges must not fail the command).
            if let Ok(r) = postgres::execute(pool, PG_SUBSCRIPTIONS_SQL).await {
                if !r.rows.is_empty() {
                    sections.push(ReplSection {
                        title: format!("Subscriptions ({})", r.rows.len()),
                        kv: None,
                        table: Some(r),
                    });
                }
            }
        }

        _ => return Err("replication status is only available for MySQL and PostgreSQL".into()),
    }

    Ok(sections)
}

// ── EXPLAIN ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ExplainResult {
    /// "json" → structured plan the frontend renders as a tree-table;
    /// "text" → preformatted plan text (MySQL ANALYZE)
    pub format:  String,
    pub engine:  String,
    pub content: String,
}

/// Flatten a QueryResult into plan text: last column of every row.
/// JSON-typed cells (PG `FORMAT JSON`) arrive as parsed values — re-serialize.
fn plan_text(result: &QueryResult) -> String {
    result.rows.iter()
        .filter_map(|row| row.last())
        .map(|v| match v {
            serde_json::Value::String(s) => s.clone(),
            other => serde_json::to_string(other).unwrap_or_default(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Capture MySQL's `optimizer_trace` for a statement — the authoritative "why
/// this plan" (cost estimates, considered/rejected ranges, index-merge choices)
/// when EXPLAIN alone doesn't say enough. Runs on one connection with the trace
/// enabled, plans the statement with EXPLAIN (so a SELECT is optimized but NOT
/// executed), reads the JSON trace, then disables tracing. MySQL/MariaDB only.
#[tauri::command]
pub async fn optimizer_trace(
    session_id: Uuid,
    sql: String,
    db: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions).await?;
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let mut conn = pool.acquire().await?;
            if let Some(d) = db.as_deref() {
                // Propagated, not swallowed (WP-13 13.5): a bad/dropped
                // database would otherwise produce a plausible-looking plan
                // against the connection's DEFAULT schema. Mirrors
                // quality.rs::explain_with_warnings.
                mysql::execute(&mut *conn, &format!("USE `{}`", d.replace('`', "``"))).await
                    .map_err(|e| format!("could not switch to database `{d}`: {e:#}"))?;
            }
            let _ = mysql::execute(&mut *conn, "SET SESSION optimizer_trace = 'enabled=on'").await;
            let _ = mysql::execute(&mut *conn, "SET SESSION optimizer_trace_max_mem_size = 16777216").await;
            // Plan without executing: prefix EXPLAIN unless the statement is
            // already an EXPLAIN/DESCRIBE.
            let trimmed = sql.trim_start();
            let up = trimmed.get(..7).unwrap_or("").to_uppercase();
            let planned = if up.starts_with("EXPLAIN") || up.starts_with("DESC") {
                sql.clone()
            } else {
                format!("EXPLAIN {sql}")
            };
            let run = async {
                mysql::execute(&mut *conn, &planned).await?;
                let r = mysql::execute(&mut *conn,
                    "SELECT TRACE FROM information_schema.OPTIMIZER_TRACE LIMIT 1").await?;
                Ok::<_, anyhow::Error>(plan_text(&r))
            }.await;
            // Always turn tracing back off on this connection before returning.
            let _ = mysql::execute(&mut *conn, "SET SESSION optimizer_trace = 'enabled=off'").await;
            let trace = run.map_err(crate::apperror::AppError::from)?;
            if trace.trim().is_empty() {
                return Err("The optimizer produced no trace for this statement.".into());
            }
            Ok(trace)
        }
        _ => Err("Optimizer trace is a MySQL/MariaDB feature.".into()),
    }
}

/// Run EXPLAIN for the given statement.
/// `analyze = true` actually EXECUTES the statement (EXPLAIN ANALYZE) — the
/// frontend warns before requesting it.
#[tauri::command]
pub async fn explain_query(
    session_id: Uuid,
    sql: String,
    analyze: bool,
    db: Option<String>,
    // ClickHouse only: which EXPLAIN kind — "indexes" (default), "pipeline",
    // "estimate", or "plan". Ignored by the other engines.
    mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<ExplainResult, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            // dedicated conn so USE <db> applies to the EXPLAIN
            let mut conn = pool.acquire().await?;
            if let Some(d) = db.as_deref() {
                // Propagated, not swallowed (WP-13 13.5): a bad/dropped
                // database would otherwise produce a plausible-looking plan
                // against the connection's DEFAULT schema. Mirrors
                // quality.rs::explain_with_warnings.
                mysql::execute(&mut *conn, &format!("USE `{}`", d.replace('`', "``"))).await
                    .map_err(|e| format!("could not switch to database `{d}`: {e:#}"))?;
            }
            // MariaDB has no EXPLAIN ANALYZE. Its measured plan is `ANALYZE`,
            // and `ANALYZE FORMAT=JSON` returns the same document as EXPLAIN
            // FORMAT=JSON with `r_`-prefixed measurements added — better for
            // us than MySQL's, whose measured plan is indented text that has
            // to be parsed separately. Sending MySQL's spelling here is a
            // syntax error, so the flavour has to be known before the
            // statement is built.
            //
            // One extra round trip on a user-initiated action, on the
            // connection already acquired. Cheap next to running the query.
            let is_maria = if analyze {
                sqlx::query_scalar::<_, String>("SELECT VERSION()")
                    .fetch_one(&mut *conn).await
                    .map(|v| v.to_lowercase().contains("mariadb"))
                    .unwrap_or(false)
            } else { false };

            let stmt = match (analyze, is_maria) {
                (true, true)  => format!("ANALYZE FORMAT=JSON {}", sql),
                (true, false) => format!("EXPLAIN ANALYZE {}", sql),
                (false, _)    => format!("EXPLAIN FORMAT=JSON {}", sql),
            };
            let r = mysql::execute(&mut *conn, &stmt).await?;
            Ok(ExplainResult {
                // Only MySQL's measured plan is text; MariaDB's is JSON.
                format: if analyze && !is_maria { "text".into() } else { "json".into() },
                engine: "mysql".into(), content: plan_text(&r),
            })
        }
        LiveSession::Postgres(pool) => {
            let mut conn = pool.acquire().await?;
            if let Some(d) = db.as_deref() {
                // Propagated, not swallowed — see the MySQL twin above (13.5).
                postgres::execute(&mut *conn, &format!("SET search_path TO \"{}\"", d.replace('"', "\"\""))).await
                    .map_err(|e| format!("could not set search_path to \"{d}\": {e:#}"))?;
            }
            let opts = if analyze { "FORMAT JSON, ANALYZE true, BUFFERS true" } else { "FORMAT JSON" };
            let stmt = format!("EXPLAIN ({}) {}", opts, sql);
            let r = postgres::execute(&mut *conn, &stmt).await?;
            Ok(ExplainResult { format: "json".into(), engine: "postgres".into(), content: plan_text(&r) })
        }
        // ClickHouse EXPLAIN returns a plain-text plan (PLAN / PIPELINE /
        // ESTIMATE) — there is no JSON plan for the tree view to parse, so the
        // text form is surfaced as-is. ANALYZE would EXECUTE the query, so it
        // is deliberately not offered here.
        LiveSession::Clickhouse(ch) => {
            // ClickHouse has several EXPLAIN kinds. `indexes = 1` is the one that
            // answers the performance question — which primary-key ranges and
            // partitions a MergeTree scan actually reads; PIPELINE shows the
            // processor graph; ESTIMATE shows rows/marks/parts to be read. None
            // execute the query (unlike ANALYZE), so all are safe to offer.
            let stmt = match mode.as_deref() {
                Some("pipeline") => format!("EXPLAIN PIPELINE {}", sql),
                Some("estimate") => format!("EXPLAIN ESTIMATE {}", sql),
                Some("plan")     => format!("EXPLAIN PLAN {}", sql),
                // default / "indexes"
                _ => format!("EXPLAIN indexes = 1 {}", sql),
            };
            let r = clickhouse::execute(ch, &stmt).await?;
            // EXPLAIN ESTIMATE answers a five-column table (database, table,
            // parts, rows, marks) — one row per table read. `plan_text` keeps
            // only the LAST column of each row, which would reduce the whole
            // answer to a bare column of mark counts, so join all columns.
            let content = if mode.as_deref() == Some("estimate") {
                r.rows.iter().map(|row| row.iter()
                    .map(|v| match v {
                        serde_json::Value::String(s) => s.clone(),
                        other => serde_json::to_string(other).unwrap_or_default(),
                    })
                    .collect::<Vec<_>>().join("\t")
                ).collect::<Vec<_>>().join("\n")
            } else {
                plan_text(&r)
            };
            Ok(ExplainResult { format: "text".into(), engine: "clickhouse".into(), content })
        }
        LiveSession::Redis(..) => Err("EXPLAIN is not available for Redis".into()),
        // SQL Server has no EXPLAIN keyword. `SET SHOWPLAN_XML ON` puts the
        // SESSION into a mode where statements are compiled and returned as XML
        // instead of run; `SET STATISTICS XML ON` is the measured counterpart —
        // the query really executes and the plan comes back with actual row
        // counts beside the estimates.
        //
        // Two rules make this three statements rather than one:
        //
        //  * The SET must be **alone in its batch** — anything beside it is
        //    Msg 1067, "The SET SHOWPLAN statements must be the only statements
        //    in the batch". So it cannot be prefixed onto the user's SQL the
        //    way EXPLAIN is on every other engine.
        //  * It is session state, so it MUST be turned back off. A connection
        //    left in SHOWPLAN mode silently stops executing anything — every
        //    later query returns a plan and changes nothing, which reads as the
        //    server ignoring the user. The reset therefore runs whether the
        //    statement succeeded or not.
        //
        // `sqlserver::execute` rides the session's single pinned connection, so
        // all three land on the same one, which is what makes the session state
        // apply at all.
        LiveSession::SqlServer(s) => {
            // The whole SHOWPLAN dance — set, plan, reset, and read across the
            // result sets `STATISTICS XML` splits the answer over — lives in
            // the SQL Server module, because every awkward part of it is SQL
            // Server's rather than this command's. `db` is ignored on purpose:
            // the driver uses three-part names and never issues USE, so
            // switching here would desynchronise the session from every other
            // panel sharing it.
            let content = sqlserver::explain_xml(s, &sql, analyze).await?;
            Ok(ExplainResult { format: "xml".into(), engine: "sqlserver".into(), content })
        }
        // explain() on a find is real, but it takes a filter document, not an
        // SQL string — the find editor exposes it (mongo_explain command).
        LiveSession::MongoDb(_) =>
            Err("MongoDB explains run from the find editor (the Explain button)".into()),
        // SQLite's planner output is EXPLAIN QUERY PLAN — a readable tree.
        // Plain EXPLAIN dumps VDBE bytecode, which is not what the panel wants.
        // ANALYZE is not a plan modifier here (it rebuilds statistics), so the
        // toggle is ignored rather than silently running something else.
        LiveSession::Sqlite(pool) => {
            let stmt = format!("EXPLAIN QUERY PLAN {}", sql);
            let r = crate::db::sqlite::execute(pool, &stmt).await?;
            Ok(ExplainResult { format: "text".into(), engine: "sqlite".into(), content: plan_text(&r) })
        }
        LiveSession::Parquet(_) =>
            Err("EXPLAIN needs a query planner — Parquet is a file".into()),
        // DuckDB's EXPLAIN is plain text (explain_key/explain_value rows —
        // plan_text keeps the value column). EXPLAIN ANALYZE executes the
        // statement and adds measured timings per operator; the frontend
        // warns before requesting it, same as MySQL.
        LiveSession::Duckdb(s) => {
            let stmt = if analyze {
                format!("EXPLAIN ANALYZE {}", sql)
            } else {
                format!("EXPLAIN {}", sql)
            };
            let r = crate::db::duckdb::execute(s, &stmt).await?;
            Ok(ExplainResult { format: "text".into(), engine: "duckdb".into(), content: plan_text(&r) })
        }
    }
}
