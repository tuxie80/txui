//! Built-in, session-scoped MySQL/MariaDB SQL-script execution.
//!
//! A complete local validation pass precedes every write. Execution then uses
//! one dedicated pooled physical connection, closed rather than returned to
//! the pool so dump-specific session state cannot leak into other tabs.

use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::AssertSqlSafe;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::apperror::{AppError, ErrorCode};
use crate::db::connection;
use crate::db::types::LiveSession;
use crate::sqlscript::{
    ensure_unchanged, inspect_source, spawn_scan, ScanSummary, ScriptCompression,
    ScriptScanEvent, ScriptSource, DEFAULT_MAX_STATEMENT_BYTES,
    MAX_STATEMENT_LIMIT_BYTES,
};
use crate::state::AppState;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SqlScriptEvent {
    Started {
        path: String,
        compression: ScriptCompressionWire,
        source_total: u64,
        database: Option<String>,
        max_statement_bytes: u64,
    },
    Phase { phase: String, statements_total: Option<u64> },
    Progress {
        phase: String,
        source_bytes: u64,
        source_total: u64,
        uncompressed_bytes: u64,
        statements_seen: u64,
        statements_total: Option<u64>,
        executed: u64,
        failed: u64,
        rows_affected: u64,
        current_line: Option<u64>,
        backend_id: Option<u64>,
    },
    StatementDone { number: u64, line: u64, bytes: u64, rows_affected: u64, ms: u64 },
    StatementError { number: u64, line: u64, message: String },
    Done {
        ok: bool,
        cancelled: bool,
        partial: bool,
        ms: u64,
        statements: u64,
        executed: u64,
        failed: u64,
        rows_affected: u64,
        uncompressed_bytes: u64,
        error: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptCompressionWire {
    Plain, Gzip, Zstd, Xz, Bzip2, Lz4, Zip, TarGzip, TarXz, TarZstd,
}

impl From<ScriptCompression> for ScriptCompressionWire {
    fn from(c: ScriptCompression) -> Self {
        match c {
            ScriptCompression::Plain => Self::Plain,
            ScriptCompression::Gzip => Self::Gzip,
            ScriptCompression::Zstd => Self::Zstd,
            ScriptCompression::Xz => Self::Xz,
            ScriptCompression::Bzip2 => Self::Bzip2,
            ScriptCompression::Lz4 => Self::Lz4,
            ScriptCompression::Zip => Self::Zip,
            ScriptCompression::TarGzip => Self::TarGzip,
            ScriptCompression::TarXz => Self::TarXz,
            ScriptCompression::TarZstd => Self::TarZstd,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SqlScriptRunSummary {
    pub statements: u64,
    pub executed: u64,
    pub rows_affected: u64,
    pub uncompressed_bytes: u64,
    pub ms: u64,
}

#[derive(Default)]
struct RunStats {
    seen: u64,
    executed: u64,
    failed: u64,
    rows_affected: u64,
    source_bytes: u64,
    uncompressed_bytes: u64,
}

impl RunStats {
    fn progress(&self, phase: &str, total: Option<u64>, line: Option<u64>, backend: Option<u64>, source_total: u64) -> SqlScriptEvent {
        SqlScriptEvent::Progress {
            phase: phase.into(),
            source_bytes: self.source_bytes,
            source_total,
            uncompressed_bytes: self.uncompressed_bytes,
            statements_seen: self.seen,
            statements_total: total,
            executed: self.executed,
            failed: self.failed,
            rows_affected: self.rows_affected,
            current_line: line,
            backend_id: backend,
        }
    }
}

/// Validate and execute a local plain/gzipped MySQL script on an OPEN session.
/// No external client, shell, temporary SQL file or second SSH tunnel is used.
#[tauri::command]
pub async fn run_sql_script(
    session_id: Uuid,
    path: String,
    compression: ScriptCompression,
    continue_on_error: bool,
    max_statement_bytes: Option<u64>,
    run_key: String,
    on_event: Channel<SqlScriptEvent>,
    state: State<'_, AppState>,
) -> Result<SqlScriptRunSummary, AppError> {
    let max = max_statement_bytes
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
        .unwrap_or(DEFAULT_MAX_STATEMENT_BYTES);
    if max == 0 || max > MAX_STATEMENT_LIMIT_BYTES {
        return Err(AppError::bad_request(format!(
            "statement limit must be 1–{} MiB", MAX_STATEMENT_LIMIT_BYTES / (1024 * 1024),
        )));
    }
    let session = connection::get_session_pub(session_id, &state.sessions).await?;
    let pool = match session.as_ref() {
        LiveSession::Mysql(pool) => pool.clone(),
        _ => return Err(AppError::unsupported(
            "the built-in SQL script runner currently supports MySQL and MariaDB sessions only",
        )),
    };
    let source = inspect_source(&path, compression).map_err(AppError::bad_request)?;
    let database = state.session_dbs.read().await.get(&session_id).cloned();

    // Register before the first full-file scan so Cancel works during startup
    // and so closing this session reaches the run through cancel_session_work.
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    state.ext_jobs.write().await.insert(job_key.clone(), cancel_tx);
    let cancel_key = format!("panel-{session_id}-sqlscript-{run_key}");
    let result = run_inner(
        session_id, pool, source, database, continue_on_error, max,
        &cancel_key, &mut cancel_rx, &on_event, &state,
    ).await;
    state.ext_jobs.write().await.remove(&job_key);
    state.kills.write().await.remove(&cancel_key);
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_inner(
    session_id: Uuid,
    pool: sqlx::MySqlPool,
    source: ScriptSource,
    database: Option<String>,
    continue_on_error: bool,
    max_statement_bytes: usize,
    cancel_key: &str,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    on_event: &Channel<SqlScriptEvent>,
    state: &AppState,
) -> Result<SqlScriptRunSummary, AppError> {
    let started = std::time::Instant::now();
    let mut stats = RunStats::default();
    let _ = on_event.send(SqlScriptEvent::Started {
        path: source.path.display().to_string(),
        compression: source.compression.into(),
        source_total: source.bytes,
        database: database.clone(),
        max_statement_bytes: max_statement_bytes as u64,
    });
    let _ = on_event.send(SqlScriptEvent::Phase { phase: "validating".into(), statements_total: None });

    // PASS 1: local gzip/UTF-8/lexer/client-command validation plus every
    // read-only/prod guard. Nothing below this pass executes on the server.
    let (mut rx, join) = spawn_scan(source.clone(), max_statement_bytes);
    let validated = loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(Ok(ScriptScanEvent::Progress { source_bytes, uncompressed_bytes, .. })) => {
                        stats.source_bytes = source_bytes;
                        stats.uncompressed_bytes = uncompressed_bytes;
                        let _ = on_event.send(stats.progress("validating", None, None, None, source.bytes));
                    }
                    Some(Ok(ScriptScanEvent::Statement(stmt))) => {
                        stats.seen += 1;
                        if let Err(e) = state.guard_statement(&session_id, &stmt.sql).await {
                            return Err(fail(on_event, started, &stats, e, false, false));
                        }
                    }
                    Some(Err(e)) => {
                        return Err(fail(on_event, started, &stats,
                            AppError::new(ErrorCode::BadRequest, e), false, false));
                    }
                    None => break join.await.map_err(|e| AppError::local(e.to_string()))?,
                }
            }
            _ = &mut *cancel_rx => {
                drop(rx);
                let _ = join.await;
                return Err(fail(on_event, started, &stats,
                    AppError::new(ErrorCode::Cancelled, "SQL script validation cancelled"), true, false));
            }
        }
    };
    let validated = match validated {
        Ok(summary) => summary,
        Err(e) => return Err(fail(on_event, started, &stats, AppError::bad_request(e), false, false)),
    };
    stats.source_bytes = validated.source_bytes;
    stats.uncompressed_bytes = validated.uncompressed_bytes;

    if let Err(e) = ensure_unchanged(&source) {
        return Err(fail(on_event, started, &stats, AppError::bad_request(e), false, false));
    }
    if cancel_rx.try_recv().is_ok() {
        return Err(fail(on_event, started, &stats,
            AppError::new(ErrorCode::Cancelled, "SQL script cancelled before execution"), true, false));
    }

    let _ = on_event.send(SqlScriptEvent::Phase {
        phase: "executing".into(), statements_total: Some(validated.statements),
    });
    let mut conn = tokio::select! {
        conn = pool.acquire() => match conn {
            Ok(c) => c,
            Err(e) => return Err(fail(on_event, started, &stats, e.into(), false, false)),
        },
        _ = &mut *cancel_rx => {
            return Err(fail(on_event, started, &stats,
                AppError::new(ErrorCode::Cancelled, "SQL script cancelled before acquiring a connection"), true, false));
        }
    };
    let execution = execute_pass(
        session_id, &mut conn, &source, &validated, database,
        continue_on_error, max_statement_bytes, cancel_key, cancel_rx,
        on_event, state, started, &mut stats,
    ).await;
    // Never return a connection mutated by USE/SET/sql_mode/transaction state
    // to the shared pool. Closing also handles a cancelled mid-result stream.
    if let Err(e) = conn.close().await {
        if execution.is_ok() {
            return Err(fail(on_event, started, &stats, e.into(), false, true));
        }
    }
    match execution {
        Ok(summary) => {
            let summary = SqlScriptRunSummary {
                ms: started.elapsed().as_millis() as u64,
                ..summary
            };
            let _ = on_event.send(SqlScriptEvent::Done {
                ok: true, cancelled: false, partial: false, ms: summary.ms,
                statements: summary.statements, executed: summary.executed,
                failed: 0, rows_affected: summary.rows_affected,
                uncompressed_bytes: summary.uncompressed_bytes, error: None,
            });
            Ok(summary)
        }
        Err(e) => Err(e),
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_pass(
    session_id: Uuid,
    conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
    source: &ScriptSource,
    validated: &ScanSummary,
    database: Option<String>,
    continue_on_error: bool,
    max_statement_bytes: usize,
    cancel_key: &str,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    on_event: &Channel<SqlScriptEvent>,
    state: &AppState,
    started: std::time::Instant,
    stats: &mut RunStats,
) -> Result<SqlScriptRunSummary, AppError> {
    let backend_id: u64 = match sqlx::query_scalar("SELECT CONNECTION_ID()").fetch_one(&mut **conn).await {
        Ok(id) => id,
        Err(e) => return Err(fail(on_event, started, stats, e.into(), false, false)),
    };
    let _ = on_event.send(stats.progress("executing", Some(validated.statements), None, Some(backend_id), source.bytes));

    if let Some(db) = database.filter(|db| !db.is_empty()) {
        let use_sql = format!("USE `{}`", db.replace('`', "``"));
        if let Err(e) = drain_statement(&mut **conn, &use_sql).await {
            return Err(fail(on_event, started, stats, e.into(), false, false));
        }
    }

    stats.seen = 0;
    stats.source_bytes = 0;
    stats.uncompressed_bytes = 0;
    let (mut rx, join) = spawn_scan(source.clone(), max_statement_bytes);
    let second_scan = loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(Ok(ScriptScanEvent::Progress { source_bytes, uncompressed_bytes, .. })) => {
                        stats.source_bytes = source_bytes;
                        stats.uncompressed_bytes = uncompressed_bytes;
                        let _ = on_event.send(stats.progress("executing", Some(validated.statements), None, Some(backend_id), source.bytes));
                    }
                    Some(Ok(ScriptScanEvent::Statement(stmt))) => {
                        stats.seen += 1;
                        if let Err(e) = state.guard_statement(&session_id, &stmt.sql).await {
                            return Err(fail(on_event, started, stats, e, false, true));
                        }
                        let number = stats.executed + stats.failed + 1;
                        let _ = on_event.send(stats.progress("executing", Some(validated.statements), Some(stmt.line), Some(backend_id), source.bytes));
                        let statement_started = std::time::Instant::now();
                        state.kills.write().await.insert(cancel_key.to_string(), crate::state::KillHandle {
                            backend_id,
                            fingerprint: connection::statement_fingerprint(&stmt.sql),
                        });
                        let result = tokio::select! {
                            result = drain_statement(&mut **conn, &stmt.sql) => result,
                            _ = &mut *cancel_rx => {
                                crate::commands::query::stop_in_flight(
                                    session_id, cancel_key, &state.sessions, &state.kills, &state.ch_kills,
                                ).await;
                                drop(rx);
                                let _ = join.await;
                                return Err(fail(on_event, started, stats,
                                    AppError::new(ErrorCode::Cancelled,
                                        format!("SQL script cancelled at statement {number}, line {}; committed work is not rolled back", stmt.line)),
                                    true, true));
                            }
                        };
                        state.kills.write().await.remove(cancel_key);
                        if cancel_rx.try_recv().is_ok() {
                            return Err(fail(on_event, started, stats,
                                AppError::new(ErrorCode::Cancelled,
                                    format!("SQL script cancelled at statement {number}, line {}; committed work is not rolled back", stmt.line)),
                                true, true));
                        }
                        match result {
                            Ok(rows) => {
                                stats.executed += 1;
                                stats.rows_affected = stats.rows_affected.saturating_add(rows);
                                let _ = on_event.send(SqlScriptEvent::StatementDone {
                                    number, line: stmt.line, bytes: stmt.sql.len() as u64,
                                    rows_affected: rows,
                                    ms: statement_started.elapsed().as_millis() as u64,
                                });
                            }
                            Err(e) => {
                                stats.failed += 1;
                                let error = AppError::from(e);
                                let _ = on_event.send(SqlScriptEvent::StatementError {
                                    number, line: stmt.line, message: error.display(),
                                });
                                if !continue_on_error {
                                    return Err(fail(on_event, started, stats, error, false, true));
                                }
                            }
                        }
                        let _ = on_event.send(stats.progress("executing", Some(validated.statements), Some(stmt.line), Some(backend_id), source.bytes));
                    }
                    Some(Err(e)) => {
                        return Err(fail(on_event, started, stats,
                            AppError::new(ErrorCode::BadRequest, e), false, true));
                    }
                    None => break join.await.map_err(|e| AppError::local(e.to_string()))?,
                }
            }
            _ = &mut *cancel_rx => {
                drop(rx);
                let _ = join.await;
                return Err(fail(on_event, started, stats,
                    AppError::new(ErrorCode::Cancelled, "SQL script cancelled between statements; committed work is not rolled back"),
                    true, stats.executed > 0));
            }
        }
    };
    let second_scan = match second_scan {
        Ok(summary) => summary,
        Err(e) => return Err(fail(on_event, started, stats, AppError::bad_request(e), false, true)),
    };
    stats.source_bytes = second_scan.source_bytes;
    stats.uncompressed_bytes = second_scan.uncompressed_bytes;

    if second_scan.sha256 != validated.sha256 || second_scan.statements != validated.statements {
        return Err(fail(on_event, started, stats, AppError::bad_request(
            "the script content changed between validation and execution; the run is marked failed and committed work is not rolled back",
        ), false, true));
    }
    if stats.failed > 0 {
        return Err(fail(on_event, started, stats, AppError::new(ErrorCode::Unknown, format!(
            "{} statement(s) failed; {} succeeded — committed work is not rolled back",
            stats.failed, stats.executed,
        )), false, true));
    }
    if stats.executed != validated.statements {
        return Err(fail(on_event, started, stats, AppError::new(ErrorCode::Unknown, format!(
            "only {} of {} validated statements executed", stats.executed, validated.statements,
        )), false, true));
    }

    let summary = SqlScriptRunSummary {
        statements: validated.statements,
        executed: stats.executed,
        rows_affected: stats.rows_affected,
        uncompressed_bytes: stats.uncompressed_bytes,
        ms: started.elapsed().as_millis() as u64,
    };
    Ok(summary)
}

/// Stop at the next statement boundary, or cancel the registered server query.
#[tauri::command]
pub async fn cancel_sql_script(
    run_key: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    if let Some(tx) = crate::state::take_ext_job(&state.ext_jobs, &run_key).await {
        let _ = tx.send(());
    }
    Ok(())
}

/// Execute one statement and drain every result set without retaining rows.
async fn drain_statement(conn: &mut sqlx::MySqlConnection, sql: &str) -> Result<u64, sqlx::Error> {
    let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(conn);
    let mut affected = 0u64;
    while let Some(item) = stream.try_next().await? {
        if let sqlx::Either::Left(done) = item {
            affected = affected.saturating_add(done.rows_affected());
        }
    }
    Ok(affected)
}

fn fail(
    on_event: &Channel<SqlScriptEvent>,
    started: std::time::Instant,
    stats: &RunStats,
    error: AppError,
    cancelled: bool,
    partial: bool,
) -> AppError {
    let _ = on_event.send(SqlScriptEvent::Done {
        ok: false,
        cancelled,
        partial,
        ms: started.elapsed().as_millis() as u64,
        statements: stats.seen,
        executed: stats.executed,
        failed: stats.failed,
        rows_affected: stats.rows_affected,
        uncompressed_bytes: stats.uncompressed_bytes,
        error: Some(error.display()),
    });
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use sqlx::mysql::MySqlPoolOptions;
    use std::sync::{Arc, Mutex};

    fn gzip(name: &str, sql: &str) -> std::path::PathBuf {
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, sql.as_bytes()).unwrap();
        let path = std::env::temp_dir().join(format!("txui-sqlscript-live-{}-{name}.sql.gz", Uuid::new_v4()));
        std::fs::write(&path, encoder.finish().unwrap()).unwrap();
        path
    }

    fn encoded(name: &str, sql: &str, format: ScriptCompression) -> std::path::PathBuf {
        use std::io::Write;
        let bytes = match format {
            ScriptCompression::Gzip => {
                let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(sql.as_bytes()).unwrap();
                encoder.finish().unwrap()
            }
            ScriptCompression::Zstd => zstd::stream::encode_all(sql.as_bytes(), 3).unwrap(),
            ScriptCompression::Xz => {
                let mut encoder = xz2::write::XzEncoder::new(Vec::new(), 6);
                encoder.write_all(sql.as_bytes()).unwrap();
                encoder.finish().unwrap()
            }
            ScriptCompression::Bzip2 => {
                let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
                encoder.write_all(sql.as_bytes()).unwrap();
                encoder.finish().unwrap()
            }
            ScriptCompression::Lz4 => {
                let mut encoder = lz4_flex::frame::FrameEncoder::new(Vec::new());
                encoder.write_all(sql.as_bytes()).unwrap();
                encoder.finish().unwrap()
            }
            ScriptCompression::Zip => {
                let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
                writer.start_file("flashback.sql", zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated)).unwrap();
                writer.write_all(sql.as_bytes()).unwrap();
                writer.finish().unwrap().into_inner()
            }
            ScriptCompression::TarGzip | ScriptCompression::TarXz | ScriptCompression::TarZstd => {
                let mut builder = tar::Builder::new(Vec::new());
                let mut header = tar::Header::new_gnu();
                header.set_size(sql.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, "flashback.sql", sql.as_bytes()).unwrap();
                let plain = builder.into_inner().unwrap();
                match format {
                    ScriptCompression::TarGzip => {
                        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
                        encoder.write_all(&plain).unwrap();
                        encoder.finish().unwrap()
                    }
                    ScriptCompression::TarXz => {
                        let mut encoder = xz2::write::XzEncoder::new(Vec::new(), 6);
                        encoder.write_all(&plain).unwrap();
                        encoder.finish().unwrap()
                    }
                    ScriptCompression::TarZstd => zstd::stream::encode_all(&plain[..], 3).unwrap(),
                    _ => unreachable!(),
                }
            }
            ScriptCompression::Plain => sql.as_bytes().to_vec(),
        };
        let path = std::env::temp_dir().join(format!("txui-sqlscript-live-{}-{name}", Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    async fn state_for(pool: sqlx::MySqlPool) -> (AppState, Uuid) {
        let history = crate::history::open_in_memory().await.unwrap();
        let state = AppState::new(history, std::env::temp_dir(), Default::default());
        let id = Uuid::new_v4();
        state.sessions.write().await.insert(id, Arc::new(LiveSession::Mysql(pool)));
        let config = crate::db::types::ConnectionConfig::new(crate::db::types::Engine::Mysql, "sqlscript-live");
        state.session_meta.write().await.insert(id, crate::state::SessionGuard::from_config(&config));
        (state, id)
    }

    fn recorder() -> (Channel<SqlScriptEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    sink.lock().unwrap().push(v);
                }
            }
            Ok(())
        });
        (channel, events)
    }

    async fn run_fixture(
        state: &AppState,
        session_id: Uuid,
        pool: &sqlx::MySqlPool,
        source: ScriptSource,
        continue_on_error: bool,
    ) -> (Result<SqlScriptRunSummary, AppError>, Vec<serde_json::Value>) {
        let (channel, events) = recorder();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let result = run_inner(
            session_id, pool.clone(), source, Some("txui_sqlscript".into()),
            continue_on_error, DEFAULT_MAX_STATEMENT_BYTES,
            &format!("panel-{session_id}-sqlscript-live"), &mut cancel_rx, &channel, state,
        ).await;
        let events = events.lock().unwrap().clone();
        (result, events)
    }

    fn event<'a>(events: &'a [serde_json::Value], kind: &str) -> Option<&'a serde_json::Value> {
        events.iter().rev().find(|e| e["type"] == kind)
    }

    /// Run through dbctl tmp mysql@8.4 or mariadb@11.8; the instance and all
    /// fixture objects are destroyed by dbctl afterward.
    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8"]
    async fn dbctl_mysql_sql_script_end_to_end() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let root = MySqlPoolOptions::new().max_connections(1).connect(&url).await.unwrap();
        sqlx::query("CREATE DATABASE txui_sqlscript").execute(&root).await.unwrap();
        let pool = MySqlPoolOptions::new().max_connections(4)
            .connect(&format!("{url}txui_sqlscript")).await.unwrap();
        let (state, session_id) = state_for(pool.clone()).await;

        let success = gzip("success", concat!(
            "CREATE TABLE items(id INT PRIMARY KEY, note VARCHAR(40));\n",
            "INSERT INTO items VALUES (1, 'first');\n",
            "DELIMITER //\nCREATE PROCEDURE add_item(IN n INT) BEGIN INSERT INTO items VALUES (n, 'routine'); END//\n",
            "DELIMITER ;\nCALL add_item(2);\n",
        ));
        let source = inspect_source(success.to_str().unwrap(), ScriptCompression::Gzip).unwrap();
        let (result, events) = run_fixture(&state, session_id, &pool, source, false).await;
        let summary = result.unwrap();
        assert_eq!(summary.statements, 4);
        assert_eq!(summary.executed, 4);
        assert_eq!(summary.rows_affected, 2);
        assert_eq!(event(&events, "done").unwrap()["ok"], true);
        assert_eq!(pool.num_idle(), 0, "the script-mutated physical connection must not return to the pool");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 2);
        std::fs::remove_file(success).unwrap();

        let plain = std::env::temp_dir().join(format!("txui-sqlscript-live-{}.sql", Uuid::new_v4()));
        std::fs::write(&plain, "CREATE TABLE plain_items(id INT PRIMARY KEY);\nINSERT INTO plain_items VALUES (1);\n").unwrap();
        let source = inspect_source(plain.to_str().unwrap(), ScriptCompression::Plain).unwrap();
        let (result, _) = run_fixture(&state, session_id, &pool, source, false).await;
        assert_eq!(result.unwrap().executed, 2);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plain_items").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1);
        std::fs::remove_file(plain).unwrap();

        for (name, format) in [
            ("zstd", ScriptCompression::Zstd), ("xz", ScriptCompression::Xz),
            ("bzip2", ScriptCompression::Bzip2), ("lz4", ScriptCompression::Lz4),
            ("zip", ScriptCompression::Zip), ("tar_gzip", ScriptCompression::TarGzip),
            ("tar_xz", ScriptCompression::TarXz), ("tar_zstd", ScriptCompression::TarZstd),
        ] {
            let table = format!("format_{name}");
            let sql = format!("CREATE TABLE {table}(id INT PRIMARY KEY);\nINSERT INTO {table} VALUES (1);\n");
            let path = encoded(name, &sql, format);
            let source = inspect_source(path.to_str().unwrap(), format).unwrap();
            let (result, _) = run_fixture(&state, session_id, &pool, source, false).await;
            assert_eq!(result.unwrap().executed, 2, "{name}");
            let count: i64 = sqlx::query_scalar(AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                .fetch_one(&pool).await.unwrap();
            assert_eq!(count, 1, "{name}");
            sqlx::query(AssertSqlSafe(format!("DROP TABLE {table}"))).execute(&pool).await.unwrap();
            std::fs::remove_file(path).unwrap();
        }

        sqlx::query("DROP TABLE items").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE plain_items").execute(&pool).await.unwrap();
        let stop = gzip("stop", concat!(
            "CREATE TABLE items(id INT PRIMARY KEY);\n",
            "INSERT INTO items VALUES (1);\n",
            "INSERT INTO missing_table VALUES (2);\n",
            "INSERT INTO items VALUES (3);\n",
        ));
        let source = inspect_source(stop.to_str().unwrap(), ScriptCompression::Gzip).unwrap();
        let (result, events) = run_fixture(&state, session_id, &pool, source, false).await;
        assert!(result.is_err());
        assert_eq!(event(&events, "done").unwrap()["partial"], true);
        assert_eq!(event(&events, "done").unwrap()["failed"], 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1, "stop-on-error must not execute the final INSERT");
        std::fs::remove_file(stop).unwrap();

        let continuing = gzip("continue", concat!(
            "INSERT INTO items VALUES (2);\n",
            "INSERT INTO missing_table VALUES (3);\n",
            "INSERT INTO items VALUES (3);\n",
        ));
        let source = inspect_source(continuing.to_str().unwrap(), ScriptCompression::Gzip).unwrap();
        let (result, events) = run_fixture(&state, session_id, &pool, source, true).await;
        assert!(result.is_err(), "continue-on-error still reports a failed run");
        assert_eq!(event(&events, "done").unwrap()["executed"], 2);
        assert_eq!(event(&events, "done").unwrap()["failed"], 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 3);
        std::fs::remove_file(continuing).unwrap();

        let corrupt = gzip("corrupt", "CREATE TABLE must_not_exist(id INT);");
        let mut bytes = std::fs::read(&corrupt).unwrap();
        let n = bytes.len();
        bytes[n - 5] ^= 0xff;
        std::fs::write(&corrupt, bytes).unwrap();
        let source = inspect_source(corrupt.to_str().unwrap(), ScriptCompression::Gzip).unwrap();
        let (result, events) = run_fixture(&state, session_id, &pool, source, false).await;
        assert!(result.is_err());
        assert_eq!(event(&events, "done").unwrap()["partial"], false);
        let found: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='txui_sqlscript' AND table_name='must_not_exist'",
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(found, 0, "gzip validation fails before any write");
        std::fs::remove_file(corrupt).unwrap();

        state.session_meta.write().await.get_mut(&session_id).unwrap().read_only = true;
        let guarded = gzip("guarded", "CREATE TABLE also_must_not_exist(id INT);");
        let source = inspect_source(guarded.to_str().unwrap(), ScriptCompression::Gzip).unwrap();
        let (result, events) = run_fixture(&state, session_id, &pool, source, false).await;
        assert_eq!(result.unwrap_err().code, ErrorCode::GuardRefused);
        assert_eq!(event(&events, "done").unwrap()["partial"], false);
        let found: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='txui_sqlscript' AND table_name='also_must_not_exist'",
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(found, 0);
        state.session_meta.write().await.get_mut(&session_id).unwrap().read_only = false;
        std::fs::remove_file(guarded).unwrap();

        let sleeping = gzip("sleep", concat!(
            "INSERT INTO items VALUES (4);\n",
            "SELECT SLEEP(30);\n",
            "INSERT INTO items VALUES (5);\n",
        ));
        let source = inspect_source(sleeping.to_str().unwrap(), ScriptCompression::Gzip).unwrap();
        let (channel, events) = recorder();
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let run_state = state.clone();
        let run_pool = pool.clone();
        let run = tokio::spawn(async move {
            run_inner(
                session_id, run_pool, source, Some("txui_sqlscript".into()),
                false, DEFAULT_MAX_STATEMENT_BYTES,
                &format!("panel-{session_id}-sqlscript-cancel"), &mut cancel_rx, &channel, &run_state,
            ).await
        });
        for _ in 0..100 {
            let seen = events.lock().unwrap().iter().any(|e| e["type"] == "statement_done");
            if seen { break; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        cancel_tx.send(()).unwrap();
        let outcome = run.await.unwrap();
        assert_eq!(outcome.unwrap_err().code, ErrorCode::Cancelled);
        for _ in 0..40 {
            let active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM information_schema.processlist WHERE INFO='SELECT SLEEP(30)'",
            ).fetch_one(&pool).await.unwrap();
            if active == 0 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let active: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.processlist WHERE INFO='SELECT SLEEP(30)'",
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(active, 0, "cancel reaches the sleeping server statement");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 4, "the statement after SLEEP never executes");
        std::fs::remove_file(sleeping).unwrap();

        pool.close().await;
        sqlx::query("DROP DATABASE txui_sqlscript").execute(&root).await.unwrap();
        root.close().await;
    }
}
