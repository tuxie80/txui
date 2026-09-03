/// Multi-server execution: run one statement across many saved connections.
/// - Ephemeral sessions (keychain + SSH tunnel identical to normal connect),
///   opened and closed per run — never touches the user's open sessions.
/// - Parallel with a concurrency cap, per-server timeout.
/// - Live progress streamed to the frontend via a Tauri channel.
/// - Every run persisted to the multi_runs / multi_run_results log.
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use sqlx::Row;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::db::connection;
use crate::db::types::QueryResult;
use crate::state::AppState;

const CONCURRENCY: usize = 6;
const PER_SERVER_TIMEOUT_SECS: u64 = 300;
/// Rows over this cap are dropped from the frontend payload (flagged truncated)
const MAX_ROWS_PER_SERVER: usize = 10_000;

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MultiExecEvent {
    Started {
        connection_id: Uuid,
        name: String,
    },
    Finished {
        connection_id: Uuid,
        name: String,
        ok: bool,
        result: Option<QueryResult>,
        truncated: bool,
        error: Option<String>,
        error_code: Option<String>,
        db_code: Option<String>,
        execution_ms: u64,
    },
    Done {
        run_id: i64,
        ok_count: i64,
        err_count: i64,
        total_ms: u64,
    },
}

struct ServerOutcome {
    connection_id: Uuid,
    name: String,
    ok: bool,
    rows_returned: i64,
    rows_affected: Option<i64>,
    execution_ms: u64,
    /// Ready-to-read text, with the server's number folded in
    /// (`ERROR 1146 (42S02): …`) — running one statement across a fleet is
    /// exactly where "which servers failed, and identically?" is the question.
    error: Option<String>,
    /// TxUI's class, so identical failures group across servers.
    error_code: Option<String>,
    /// The server's own number — and it can legitimately differ per server,
    /// which is itself the finding.
    db_code: Option<String>,
}

#[tauri::command]
pub async fn multi_execute(
    connection_ids: Vec<Uuid>,
    sql: String,
    on_event: Channel<MultiExecEvent>,
    state: State<'_, AppState>,
) -> Result<i64, crate::apperror::AppError> {
    if connection_ids.is_empty() {
        return Err("no servers selected".into());
    }
    if sql.trim().is_empty() {
        return Err("empty statement".into());
    }

    let run_started = Instant::now();
    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let app_state: AppState = (*state).clone();
    let mut handles = Vec::with_capacity(connection_ids.len());

    for conn_id in connection_ids {
        let sem = sem.clone();
        let sql = sql.clone();
        let chan = on_event.clone();
        let st = app_state.clone();

        handles.push(tokio::spawn(async move {
            let _permit = match sem.acquire().await {
                Ok(p) => p,
                Err(_) => return ServerOutcome {
                    connection_id: conn_id, name: conn_id.to_string(), ok: false,
                    rows_returned: 0, rows_affected: None, execution_ms: 0,
                    error: Some("executor shutting down".into()),
                    // Local — nothing was asked of any server.
                    error_code: Some("local".into()), db_code: None,
                },
            };

            let name = st.configs.read().await.get(&conn_id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| conn_id.to_string());
            let _ = chan.send(MultiExecEvent::Started { connection_id: conn_id, name: name.clone() });

            let started = Instant::now();
            let outcome = run_one(&st, conn_id, &sql).await;
            let ms = started.elapsed().as_millis() as u64;

            let (ok, result, truncated, error, rows_returned, rows_affected) = match outcome {
                Ok(mut r) => {
                    let rows_returned = r.rows.len() as i64;
                    let rows_affected = r.rows_affected.map(|n| n as i64);
                    let truncated = r.rows.len() > MAX_ROWS_PER_SERVER;
                    if truncated { r.rows.truncate(MAX_ROWS_PER_SERVER); }
                    (true, Some(r), truncated, None, rows_returned, rows_affected)
                }
                Err(e) => (false, None, false, Some(e), 0, None),
            };
            // One rendering, used by both the live event and the final row.
            let err_text = error.as_ref().map(crate::apperror::AppError::display);
            let err_code = error.as_ref().map(|e| e.code.as_str().to_string());
            let err_db = error.as_ref().and_then(|e| e.db_code.clone());

            let _ = chan.send(MultiExecEvent::Finished {
                connection_id: conn_id,
                name: name.clone(),
                ok,
                result,
                truncated,
                error: err_text.clone(),
                error_code: err_code.clone(),
                db_code: err_db.clone(),
                execution_ms: ms,
            });

            ServerOutcome {
                connection_id: conn_id,
                name,
                ok,
                rows_returned,
                rows_affected,
                execution_ms: ms,
                error: err_text,
                error_code: err_code,
                db_code: err_db,
            }
        }));
    }

    let mut outcomes = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(o) = h.await {
            outcomes.push(o);
        }
    }

    let total_ms = run_started.elapsed().as_millis() as u64;
    let ok_count = outcomes.iter().filter(|o| o.ok).count() as i64;
    let err_count = outcomes.len() as i64 - ok_count;

    // Persist the run log. Clone the pool out from under the mutex so we don't
    // hold it across the whole insert loop (blocking every editor query's
    // history write). SqlitePool is an Arc handle — cloning is cheap.
    let run_id = {
        let pool = state.history.clone();
        let run_id = sqlx::query(
            "INSERT INTO multi_runs (sql, total, ok_count, err_count, total_ms) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(&sql)
        .bind(outcomes.len() as i64)
        .bind(ok_count)
        .bind(err_count)
        .bind(total_ms as i64)
        .execute(&pool).await
        ?
        .last_insert_rowid();

        for o in &outcomes {
            let _ = sqlx::query(
                "INSERT INTO multi_run_results \
                 (run_id, connection_id, connection_name, ok, rows_returned, rows_affected, execution_ms, error, error_code, db_code) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(run_id)
            .bind(o.connection_id.to_string())
            .bind(&o.name)
            .bind(o.ok as i64)
            .bind(o.rows_returned)
            .bind(o.rows_affected)
            .bind(o.execution_ms as i64)
            .bind(&o.error)
            .bind(o.error_code.clone().unwrap_or_default())
            .bind(o.db_code.clone().unwrap_or_default())
            .execute(&pool).await;
        }
        run_id
    };

    let _ = on_event.send(MultiExecEvent::Done { run_id, ok_count, err_count, total_ms });
    Ok(run_id)
}

/// Open an ephemeral session, execute with a timeout, always clean up.
async fn run_one(state: &AppState, conn_id: Uuid, sql: &str) -> Result<QueryResult, crate::apperror::AppError> {
    let config = state.configs.read().await.get(&conn_id).cloned()
        .ok_or_else(|| format!("connection {} not found", conn_id))?;

    // Per-server write guard: never fan a write out to a read-only server.
    // Engine-aware — a Redis target must be judged by redisguard, since
    // sqlguard reports FLUSHALL/DEL/SET as reads.
    let guard = crate::state::SessionGuard::from_config(&config);
    if config.engine == crate::db::types::Engine::Redis {
        let class = crate::redisguard::baseline_catalog().classify_line(sql);
        if config.read_only && class.mutates() {
            return Err(format!("Blocked: this connection is read-only ({} command).", class.as_str()).into());
        }
        crate::redisguard::check_prod_limits(&guard, sql)?;
    } else {
        if config.read_only && crate::sqlguard::is_write(sql) {
            return Err("Blocked: this connection is read-only.".into());
        }
        // Prod hard limits, straight from the config (no session exists yet).
        crate::sqlguard::check_prod_limits(&guard, sql)?;
    }

    let session_id = super::connections::open_session_for_config(&config, state).await?;

    let cancel_key = format!("multi-{}", session_id);
    let default_db = state.session_dbs.read().await.get(&session_id).cloned();
    // Cap at MAX_ROWS_PER_SERVER + 1: the driver stops fetching there, and the
    // caller's existing `rows.len() > MAX_ROWS_PER_SERVER` truncation logic
    // still distinguishes "truncated" from "exactly the cap".
    let exec = connection::execute_query(session_id, sql, &state.sessions, &state.kills, &state.ch_kills, &cancel_key, false,
        default_db.as_deref(), Some(MAX_ROWS_PER_SERVER + 1));
    let result = match tokio::time::timeout(
        std::time::Duration::from_secs(PER_SERVER_TIMEOUT_SECS), exec,
    ).await {
        Ok(r) => r.map_err(Into::into),
        Err(_) => Err(format!("timeout after {}s", PER_SERVER_TIMEOUT_SECS).into()),
    };

    // Tear down the ephemeral session + tunnel + kill handle + guard
    connection::close_session(session_id, &state.sessions).await;
    state.tunnels.write().await.remove(&session_id);
    state.kills.write().await.remove(&cancel_key);
    state.session_meta.write().await.remove(&session_id);

    result
}

// ── Run log queries ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MultiRunSummary {
    pub id: i64,
    pub sql: String,
    pub total: i64,
    pub ok_count: i64,
    pub err_count: i64,
    pub total_ms: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct MultiRunDetail {
    pub connection_name: String,
    pub ok: bool,
    pub rows_returned: i64,
    pub rows_affected: Option<i64>,
    pub execution_ms: i64,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn list_multi_runs(
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<MultiRunSummary>, crate::apperror::AppError> {
    let pool = &state.history;
    let rows = sqlx::query(
        "SELECT id, sql, total, ok_count, err_count, total_ms, created_at \
         FROM multi_runs ORDER BY id DESC LIMIT ?"
    )
    .bind(limit.unwrap_or(100))
    .fetch_all(&*pool).await
    ?;

    Ok(rows.iter().map(|r| MultiRunSummary {
        id:         r.get(0),
        sql:        r.get(1),
        total:      r.get(2),
        ok_count:   r.get(3),
        err_count:  r.get(4),
        total_ms:   r.get(5),
        created_at: r.get(6),
    }).collect())
}

#[tauri::command]
pub async fn get_multi_run(
    run_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<MultiRunDetail>, crate::apperror::AppError> {
    let pool = &state.history;
    let rows = sqlx::query(
        "SELECT connection_name, ok, rows_returned, rows_affected, execution_ms, error \
         FROM multi_run_results WHERE run_id = ? ORDER BY connection_name"
    )
    .bind(run_id)
    .fetch_all(&*pool).await
    ?;

    Ok(rows.iter().map(|r| MultiRunDetail {
        connection_name: r.get(0),
        ok:              r.get::<i64, _>(1) != 0,
        rows_returned:   r.get(2),
        rows_affected:   r.get(3),
        execution_ms:    r.get(4),
        error:           r.get(5),
    }).collect())
}
