use tauri::{Emitter, State};
use uuid::Uuid;

use crate::db::connection;
use crate::db::types::QueryResult;
use crate::history;
use crate::state::AppState;

/// Default row cap on the editor's execute path when the frontend sends none:
/// large enough that no realistic hand-written query notices, small enough
/// that a stray `SELECT * FROM big_table` cannot OOM the app. Reference
/// in-repo precedents: multi_exec's MAX_ROWS_PER_SERVER, MongoDB's
/// MAX_FIND_LIMIT.
const DEFAULT_MAX_ROWS: usize = 100_000;

/// Execute a SQL/Redis command and return rows + metadata.
/// `tab_id` is used as a cancellation handle; call `cancel_query` with the same
/// session_id + tab_id to abort.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_query(
    session_id:    Uuid,
    connection_id: String,
    engine:        String,
    sql:           String,
    tab_id:        u64,
    include_warnings: Option<bool>,
    // Row cap for the result set. None → DEFAULT_MAX_ROWS; Some(0) → uncapped
    // (an explicit frontend choice). Past the cap the driver stops fetching
    // and the result carries `truncated: true`.
    max_rows:      Option<u32>,
    // Auto-injected by Tauri (the JS `invoke` does not pass it), used only to
    // emit ClickHouse live-progress events. Additive and CH-scoped: no other
    // engine touches it, and the frontend call site is unchanged.
    app:           tauri::AppHandle,
    state:         State<'_, AppState>,
) -> Result<QueryResult, crate::apperror::AppError> {
    let cancel_key = format!("{}-{}", session_id, tab_id);

    let row_cap = match max_rows {
        Some(0) => None,
        Some(n) => Some(n as usize),
        None    => Some(DEFAULT_MAX_ROWS),
    };

    // Backend write guard (defence in depth behind the UI): a read-only
    // connection rejects writes even if the client guard was bypassed.
    // Engine-aware: SQL goes through sqlguard, Redis through redisguard.
    // Choosing a guard per call site is how every Redis write slipped past.
    state.guard_statement(&session_id, &sql).await?;

    // MySQL server warnings are opt-in (extra SHOW WARNINGS roundtrip) and
    // skipped for read-family statements — reads rarely warn, and SHOW/EXPLAIN
    // output must never be disturbed.
    let fetch_warnings = include_warnings.unwrap_or(false)
        && engine == "mysql"
        && !crate::sqlguard::is_read_family(&sql);

    // Register a cancellation channel for this query
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    state.cancels.write().await.insert(cancel_key.clone(), tx);

    // Editor's chosen database: prefixed onto the SQL — raw_sql executes
    // multi-statement text on ONE connection, so USE applies to the query.
    let default_db = state.session_dbs.read().await.get(&session_id).cloned();
    let effective_sql = match default_db.as_deref() {
        Some(db) if engine == "mysql" =>
            format!("USE `{}`;\n{}", db.replace('`', "``"), sql),
        Some(db) if engine == "postgres" =>
            format!("SET search_path TO \"{}\";\n{}", db.replace('"', "\"\""), sql),
        // ClickHouse has no `USE` over HTTP — the database rides along as a
        // request parameter instead, applied down in execute_query.
        _ => sql.clone(),
    };
    let ch_db = if engine == "clickhouse" { default_db.as_deref() } else { None };

    // ClickHouse live progress: while the query runs, poll `system.processes`
    // for its read counters and emit them to the tab that started it. CH-only;
    // every other engine leaves `progress_stop` as `None` and this is inert.
    // Stopped via a oneshot once the query returns (below) — the poller also
    // self-terminates when the query id leaves `ch_kills`.
    let progress_stop = if engine == "clickhouse" {
        Some(spawn_ch_progress(
            app.clone(), state.sessions.clone(), state.ch_kills.clone(),
            session_id, tab_id, cancel_key.clone(),
        ))
    } else {
        None
    };

    // Manual-transaction mode: a held connection exists for this session —
    // run there (same backend as BEGIN). No cancel race: abandoning a shared
    // tx connection mid-statement would poison the whole transaction.
    let tx_conn = state.tx_conns.read().await.get(&session_id).cloned();
    let result = if let Some(txc) = tx_conn {
        drop(rx);
        let mut guard = txc.lock().await;
        match &mut *guard {
            crate::state::TxConn::My(conn) => {
                let mut r: Result<QueryResult, crate::apperror::AppError> =
                    crate::db::mysql::execute_capped(&mut **conn, &effective_sql, row_cap).await.map_err(Into::into);
                if fetch_warnings {
                    if let Ok(res) = r.as_mut() {
                        res.warnings = crate::db::mysql::fetch_warnings(&mut **conn).await;
                    }
                }
                r
            }
            crate::state::TxConn::Pg(conn) =>
                crate::db::postgres::execute_capped(&mut **conn, &effective_sql, row_cap).await.map_err(Into::into),
        }
    } else {
        let deadline = state.query_deadline(&session_id).await;
        race_query(session_id, &effective_sql, &state.sessions, &state.kills, &state.ch_kills,
                   &cancel_key, fetch_warnings, ch_db, rx, deadline, row_cap).await
    };

    // Signal the CH progress poller to finish (it emits one last exact figure
    // from the response headers, then exits).
    if let Some(stop) = progress_stop {
        let _ = stop.send(());
    }

    // Clean up cancel token + kill handle (may already be gone if cancelled)
    state.cancels.write().await.remove(&cancel_key);
    state.kills.write().await.remove(&cancel_key);

    // Record in history regardless of success/failure (skip cancelled)
    // Cancelled statements are not history: the user stopped them on purpose.
    // Decided by the code now — this used to compare against the same sentence
    // the frontend matched, so rewording it would have silently started
    // recording cancellations as failures.
    if !matches!(result, Err(ref e) if e.code.is_user_intent()) {
        let (exec_ms, rows, err_str) = match &result {
            // history keeps its historical meaning of TOTAL time
            Ok(r)  => ((r.execution_ms + r.fetch_ms) as i64, r.rows.len() as i64, None),
            Err(e) => (0, 0, Some(e.message.as_str())),
        };
        // Off the critical path: the result is ready, and bookkeeping the run
        // must not add a commit's latency to handing it back.
        let store = state.history.clone();
        let err_owned = err_str.map(str::to_string);
        tokio::spawn(async move {
            let _ = history::insert(
                &store,
                &connection_id,
                &engine,
                &sql,
                exec_ms,
                rows,
                err_owned.as_deref(),
            ).await;
        });
    }

    result
}

/// Emit `dbgui:ch-progress` for one ClickHouse run until it finishes.
///
/// ClickHouse is the only engine that reports a running query's read counters
/// mid-flight. The query id is chosen deep in `connection::execute_query` (this
/// command never sees it), so the poller waits for it to appear in `ch_kills`
/// under the same `cancel_key` the frontend cancels by, then samples
/// `system.processes` on a short interval. The event is keyed by
/// `sessionId` + `tabId` — the pair the frontend already uses to identify the
/// tab — so no shared correlation id has to be threaded through the engines.
///
/// It stops when signalled (the query returned) or when the id leaves
/// `ch_kills` after having appeared. On stop it drains the exact final figure
/// captured from the response headers, since the `system.processes` row is gone
/// by then.
fn spawn_ch_progress(
    app:        tauri::AppHandle,
    sessions:   crate::state::SessionMap,
    ch_kills:   crate::state::ChKillMap,
    session_id: Uuid,
    tab_id:     u64,
    cancel_key: String,
) -> tokio::sync::oneshot::Sender<()> {
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(200));
        let mut started = false;
        let mut last_qid: Option<String> = None;
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = ticker.tick() => {}
            }
            let qid = ch_kills.read().await.get(&cancel_key).cloned();
            match qid {
                Some(qid) => {
                    started = true;
                    last_qid = Some(qid.clone());
                    if let Ok(session) = connection::get_session_pub(session_id, &sessions).await {
                        if let crate::db::types::LiveSession::Clickhouse(s) = session.as_ref() {
                            if let Ok(Some(p)) = crate::db::clickhouse::query_progress(s, &qid).await {
                                emit_ch_progress(&app, session_id, tab_id, &p);
                            }
                        }
                    }
                }
                // Seen and now gone → the query ended between ticks.
                None if started => break,
                // Not started yet (id not registered) — keep waiting.
                None => {}
            }
        }
        // The authoritative final counters live in the response headers; the
        // process row has already vanished, so this is the only place they land.
        if let Some(qid) = last_qid {
            if let Some(p) = crate::db::clickhouse::take_progress(&qid) {
                emit_ch_progress(&app, session_id, tab_id, &p);
            }
        }
    });
    stop_tx
}

/// One progress event, tagged with the tab that owns the run.
fn emit_ch_progress(
    app: &tauri::AppHandle, session_id: Uuid, tab_id: u64,
    p: &crate::db::clickhouse::ChProgress,
) {
    let _ = app.emit("dbgui:ch-progress", serde_json::json!({
        "sessionId": session_id.to_string(),
        "tabId":     tab_id,
        "readRows":  p.read_rows,
        "readBytes": p.read_bytes,
        "totalRows": p.total_rows,
        "elapsedNs": p.elapsed_ns,
    }));
}

/// Stop whatever this key has running on the server, whichever engine it is.
///
/// Three callers needed this — the Stop button, the panel Stop button and the
/// client-side deadline — and each had its own copy that knew only about
/// `kills`. When ClickHouse gained a cancel, a copy that had not been updated
/// would have silently gone on doing nothing, which is the failure mode a Stop
/// button can least afford: it reports success by definition.
///
/// The handle is *removed* before the kill is sent, and read up front, because
/// the query's own completion path races to remove it too.
pub(crate) async fn stop_in_flight(
    session_id: Uuid,
    cancel_key: &str,
    sessions: &crate::state::SessionMap,
    kills: &crate::state::KillMap,
    ch_kills: &crate::state::ChKillMap,
) {
    let backend = kills.write().await.remove(cancel_key);
    let ch_query_id = ch_kills.write().await.remove(cancel_key);

    if let Some(backend_id) = backend {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            connection::kill_backend(session_id, backend_id, &sessions,
                connection::KillForce::Cancel).await;
        });
    }
    if let Some(query_id) = ch_query_id {
        let sessions = sessions.clone();
        // Spawned, like the others: KILL QUERY is a second HTTP round trip and
        // the Stop button must not wait on the server it is trying to stop.
        tokio::spawn(async move {
            let Ok(session) = connection::get_session_pub(session_id, &sessions).await else { return };
            if let crate::db::types::LiveSession::Clickhouse(s) = session.as_ref() {
                let _ = crate::db::clickhouse::kill_query(s, &query_id).await;
            }
        });
    }

    // DuckDB: in-process, so there is no backend id — the engine's own
    // interrupt handle is the KILL QUERY equivalent. Fired directly rather
    // than through a kill map: the handle belongs to the session's one
    // connection, and a stale key can only interrupt a query this tab's own
    // session is running, which is what the button means anyway.
    if let Ok(session) = connection::get_session_pub(session_id, sessions).await {
        if let crate::db::types::LiveSession::Duckdb(s) = session.as_ref() {
            s.interrupt();
        }
    }
}

/// Run a query, racing it against the Stop button and — when one is set — the
/// client-side deadline.
///
/// Split out of `execute_query` so the deadline is reachable from a test: the
/// command itself needs a Tauri `State`, but the behaviour worth pinning is
/// that a deadline *kills the query on the server* rather than just walking
/// away from it. See `deadline_tests`.
#[allow(clippy::too_many_arguments)]
async fn race_query(
    session_id:     Uuid,
    sql:            &str,
    sessions:       &crate::state::SessionMap,
    kills:          &crate::state::KillMap,
    ch_kills:       &crate::state::ChKillMap,
    cancel_key:     &str,
    fetch_warnings: bool,
    ch_db:          Option<&str>,
    rx:             tokio::sync::oneshot::Receiver<()>,
    deadline:       Option<std::time::Duration>,
    max_rows:       Option<usize>,
) -> Result<QueryResult, crate::apperror::AppError> {
    // `Either::Right(pending())` rather than branching the whole select: an arm
    // that never completes is exactly "no deadline".
    let timer: futures_util::future::Either<_, _> = match deadline {
        Some(d) => futures_util::future::Either::Left(tokio::time::sleep(d)),
        None => futures_util::future::Either::Right(std::future::pending::<()>()),
    };
    tokio::select! {
        r = connection::execute_query(session_id, sql, sessions, kills, ch_kills, cancel_key, fetch_warnings, ch_db, max_rows) => {
            r.map_err(crate::apperror::AppError::from)
        }
        // A typed code, not a sentence. The frontend used to decide whether to
        // stop a multi-statement run by matching this text, and so did the
        // history check in the caller — two string comparisons on a string
        // nothing stopped anyone from rewording.
        _ = rx => Err(crate::apperror::AppError::cancelled()),
        // Dropping our side of the query does NOT stop the server working on
        // it, so the deadline issues the same KILL the Stop button does.
        // Without this the ceiling would only make the UI *look* bounded while
        // the server kept burning through the statement — the half-measure
        // `withDeadline` is limited to on the frontend, and not worth
        // repeating down here where the connection is in reach.
        _ = timer => {
            stop_in_flight(session_id, cancel_key, sessions, kills, ch_kills).await;
            Err(crate::apperror::AppError::query_deadline_exceeded(
                deadline.map(|d| d.as_secs()).unwrap_or(0)))
        }
    }
}

// ── Manual transaction control ────────────────────────────────────────────────
//
// begin acquires a dedicated connection, runs BEGIN on it and holds it in
// state.tx_conns; while held, execute_query routes editor SQL through it so
// the whole transaction happens on ONE backend. commit/rollback release it
// (the connection returns to the pool). Disconnect drops it — the server
// rolls back automatically.

#[tauri::command]
pub async fn begin_transaction(
    session_id: Uuid,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    if state.tx_conns.read().await.contains_key(&session_id) {
        return Err("A transaction is already open on this session.".into());
    }
    let session = crate::db::connection::get_session_pub(session_id, &state.sessions)
        .await?;
    // Autocommit off, when the connection asks for it, belongs HERE and only
    // here — on the connection that is pinned for the session's writes. Setting
    // it on every pooled connection leaked an uncommitted read view per panel
    // query; see the note in db/mysql.rs::setup_new_connection.
    let manual_commit = state
        .session_meta
        .read()
        .await
        .get(&session_id)
        .map(|g| !g.autocommit)
        .unwrap_or(false);

    let txc = match session.as_ref() {
        crate::db::types::LiveSession::Mysql(pool) => {
            let mut conn = pool.acquire().await?;
            if manual_commit {
                let _ = crate::db::mysql::execute(&mut *conn, "SET SESSION autocommit = 0").await;
            }
            crate::db::mysql::execute(&mut *conn, "BEGIN").await?;
            crate::state::TxConn::My(conn)
        }
        crate::db::types::LiveSession::Postgres(pool) => {
            let mut conn = pool.acquire().await?;
            crate::db::postgres::execute(&mut *conn, "BEGIN").await?;
            crate::state::TxConn::Pg(conn)
        }
        // SQL Server needs no pinning: a TDS session IS one connection, so every
        // statement already lands on the same backend. `tx_conns` exists to stop
        // a POOL scattering a transaction, and there is no pool here — so the
        // transaction opens on the session's own client and nothing goes into
        // `tx_conns`. `tx_status` reads @@TRANCOUNT instead of inferring from a
        // pinned-connection entry.
        crate::db::types::LiveSession::SqlServer(s) => {
            if crate::db::sqlserver::trancount(s).await.unwrap_or(0) > 0 {
                return Err("A transaction is already open on this session.".into());
            }
            crate::db::sqlserver::begin(s).await?;
            return Ok(());
        }
        _ => return Err("transactions are only supported for MySQL, PostgreSQL and SQL Server".into()),
    };
    state.tx_conns.write().await
        .insert(session_id, std::sync::Arc::new(tokio::sync::Mutex::new(txc)));
    Ok(())
}

async fn end_transaction(
    session_id: Uuid,
    verb: &str,
    state: &AppState,
) -> Result<(), crate::apperror::AppError> {
    // SQL Server keeps no `tx_conns` entry (see begin_transaction) — its
    // transaction lives on the session's own connection, so it is ended there.
    if let Ok(session) = crate::db::connection::get_session_pub(session_id, &state.sessions).await {
        if let crate::db::types::LiveSession::SqlServer(s) = session.as_ref() {
            if crate::db::sqlserver::trancount(s).await.unwrap_or(0) == 0 {
                return Err("No open transaction on this session.".into());
            }
            return crate::db::sqlserver::end_tx(s, verb.starts_with("COMMIT"))
                .await
                .map_err(crate::apperror::AppError::from);
        }
    }
    let Some(txc) = state.tx_conns.write().await.remove(&session_id) else {
        return Err("No open transaction on this session.".into());
    };
    let mut guard = txc.lock().await;
    let r = match &mut *guard {
        crate::state::TxConn::My(conn) =>
            crate::db::mysql::execute(&mut **conn, verb).await.map(|_| ()),
        crate::state::TxConn::Pg(conn) =>
            crate::db::postgres::execute(&mut **conn, verb).await.map(|_| ()),
    };
    // The connection drops with `txc` and returns to the pool either way.
    r.map_err(crate::apperror::AppError::from)
}

#[tauri::command]
pub async fn commit_transaction(session_id: Uuid, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    end_transaction(session_id, "COMMIT", &state).await
}

#[tauri::command]
pub async fn rollback_transaction(session_id: Uuid, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    end_transaction(session_id, "ROLLBACK", &state).await
}

/// Run a statement on the session's PINNED connection, and nowhere else.
///
/// Exists for transaction bookkeeping — savepoints — where landing on a
/// different connection would be silently wrong rather than merely slow. The
/// ordinary paths acquire a connection from the pool per statement, so a
/// `SAVEPOINT` sent that way could easily be set on a connection that is not
/// the one the transaction lives on.
///
/// Deliberately refuses when nothing is pinned instead of falling back to the
/// pool: a savepoint on the wrong connection is worse than no savepoint,
/// because the caller would believe it had protection it does not have.
///
/// Records no history — bookkeeping is not something the user typed.
#[tauri::command]
pub async fn tx_exec(
    session_id: Uuid,
    sql: String,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    // SQL Server: every statement is already on the one connection the
    // transaction lives on, so a savepoint needs no pinned entry — the reason
    // this command exists at all (landing on the wrong pooled connection)
    // cannot happen here.
    if let Ok(session) = crate::db::connection::get_session_pub(session_id, &state.sessions).await {
        if let crate::db::types::LiveSession::SqlServer(s) = session.as_ref() {
            return crate::db::sqlserver::execute(s, &sql).await
                .map(|_| ())
                .map_err(Into::into);
        }
    }
    let Some(txc) = state.tx_conns.read().await.get(&session_id).cloned() else {
        return Err("No pinned connection on this session.".into());
    };
    let mut guard = txc.lock().await;
    match &mut *guard {
        crate::state::TxConn::My(conn) =>
            crate::db::mysql::execute(&mut **conn, &sql).await.map(|_| ()),
        crate::state::TxConn::Pg(conn) =>
            crate::db::postgres::execute(&mut **conn, &sql).await.map(|_| ()),
    }
    .map_err(Into::into)
}

/// What the toolbar's transaction controls show.
///
/// Two separate facts, deliberately not merged into one:
///   - `held` — the app pins a connection for this session, so Commit and
///     Rollback settle **your** work. This is what enables the buttons.
///   - `server_autocommit` — what the server itself reports. Shown beside the
///     buttons so a disagreement is visible rather than silent: a `SET
///     autocommit` typed into the editor changes one pooled connection and
///     nothing else, and without this readout that looks like it worked.
///
/// PostgreSQL has no server-side autocommit setting (it was removed in 7.4) —
/// a transaction exists only inside an explicit block — so the value is `None`
/// there rather than a fabricated `true`.
#[derive(Debug, serde::Serialize)]
pub struct TxStatus {
    pub held: bool,
    pub server_autocommit: Option<bool>,
}

#[tauri::command]
pub async fn tx_status(session_id: Uuid, state: State<'_, AppState>) -> Result<TxStatus, crate::apperror::AppError> {
    let tx_conn = state.tx_conns.read().await.get(&session_id).cloned();
    let held = tx_conn.is_some();

    // Read it on the PINNED connection when there is one. Asking the pool
    // instead would report some other connection's setting, which is the exact
    // confusion this readout exists to prevent.
    let server_autocommit = if let Some(txc) = tx_conn {
        let mut guard = txc.lock().await;
        match &mut *guard {
            crate::state::TxConn::My(conn) =>
                read_autocommit(crate::db::mysql::execute(&mut **conn, "SELECT @@autocommit").await.ok()),
            crate::state::TxConn::Pg(_) => None,
        }
    } else {
        let session = crate::db::connection::get_session_pub(session_id, &state.sessions)
            .await?;
        match session.as_ref() {
            crate::db::types::LiveSession::Mysql(pool) =>
                read_autocommit(crate::db::mysql::execute(pool, "SELECT @@autocommit").await.ok()),
            // SQL Server: bit 2 of @@OPTIONS is IMPLICIT_TRANSACTIONS, so
            // autocommit is that bit being clear.
            crate::db::types::LiveSession::SqlServer(s) =>
                crate::db::sqlserver::autocommit(s).await.ok(),
            _ => None,
        }
    };

    // SQL Server holds no `tx_conns` entry — its transaction lives on the
    // session's own connection — so `held` comes from @@TRANCOUNT. Asking the
    // server rather than inferring from a local map also makes this
    // self-correcting: after a dropped connection the server says 0, which is
    // the truth, where a local flag would still say "open".
    let held = if held {
        true
    } else {
        let session = crate::db::connection::get_session_pub(session_id, &state.sessions).await?;
        match session.as_ref() {
            crate::db::types::LiveSession::SqlServer(s) =>
                crate::db::sqlserver::trancount(s).await.unwrap_or(0) > 0,
            _ => false,
        }
    };

    Ok(TxStatus { held, server_autocommit })
}

fn read_autocommit(r: Option<crate::db::types::QueryResult>) -> Option<bool> {
    let v = r?.rows.into_iter().next()?.into_iter().next()?;
    match v {
        serde_json::Value::Number(n) => Some(n.as_i64()? != 0),
        serde_json::Value::Bool(b) => Some(b),
        serde_json::Value::String(s) => Some(s != "0" && !s.eq_ignore_ascii_case("off")),
        _ => None,
    }
}

/// Set (or clear with None/empty) the editor's default database for a session.
/// Validated by actually switching to it once.
#[tauri::command]
pub async fn set_session_db(
    session_id: Uuid,
    db: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    match db.filter(|d| !d.trim().is_empty()) {
        Some(db) => {
            // validate: the database/schema must exist
            let session = crate::db::connection::get_session_pub(session_id, &state.sessions)
                .await?;
            match session.as_ref() {
                crate::db::types::LiveSession::Mysql(pool) => {
                    crate::db::mysql::execute(pool, &format!("USE `{}`", db.replace('`', "``")))
                        .await.map_err(|e| format!("cannot use `{}`: {}", db, e))?;
                }
                crate::db::types::LiveSession::Postgres(pool) => {
                    let found = crate::db::postgres::execute(pool, &format!(
                        "SELECT 1 FROM information_schema.schemata WHERE schema_name = '{}'",
                        db.replace('\'', "''"),
                    )).await?;
                    if found.rows.is_empty() {
                        return Err(format!("schema `{}` does not exist", db).into());
                    }
                }
                crate::db::types::LiveSession::Clickhouse(ch) => {
                    let found = crate::db::clickhouse::execute(ch, &format!(
                        "SELECT 1 FROM system.databases WHERE name = '{}'",
                        db.replace('\'', "\\'"),
                    )).await?;
                    if found.rows.is_empty() {
                        return Err(format!("database `{}` does not exist", db).into());
                    }
                }
                _ => return Err("default database is not supported for this engine".into()),
            }
            state.session_dbs.write().await.insert(session_id, db);
        }
        None => { state.session_dbs.write().await.remove(&session_id); }
    }
    Ok(())
}

/// Signal an in-flight query to abort. Best-effort — query may already be done.
#[tauri::command]
pub async fn cancel_query(
    session_id: Uuid,
    tab_id:     u64,
    state:      State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    let cancel_key = format!("{}-{}", session_id, tab_id);
    stop_in_flight(session_id, &cancel_key, &state.sessions, &state.kills, &state.ch_kills).await;
    if let Some(tx) = state.cancels.write().await.remove(&cancel_key) {
        let _ = tx.send(());
    }
    Ok(())
}

/// Cancellable read query for panels (DBA views, etc.) — like execute_query
/// but keyed by an arbitrary `token` and NOT written to history. Registers a
/// server-side kill handle so `cancel_panel_query` can KILL QUERY it.
#[tauri::command]
pub async fn panel_query(
    session_id: Uuid,
    sql: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<QueryResult, crate::apperror::AppError> {
    let cancel_key = format!("panel-{}-{}", session_id, token);

    // Engine-aware: SQL goes through sqlguard, Redis through redisguard.
    // Choosing a guard per call site is how every Redis write slipped past.
    state.guard_statement(&session_id, &sql).await?;

    // A pinned connection wins — a panel must see the session's uncommitted
    // work. No cancel race here: abandoning a shared transaction connection
    // mid-statement would poison the whole transaction, which is why the
    // pinned path deliberately skips the cancel token, exactly as
    // `execute_query` does.
    if let Some(r) = state.try_on_tx_conn(&session_id, &sql).await {
        return r;
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    state.cancels.write().await.insert(cancel_key.clone(), tx);

    let panel_db = state.session_dbs.read().await.get(&session_id).cloned();
    let result = tokio::select! {
        r = connection::execute_query(session_id, &sql, &state.sessions, &state.kills, &state.ch_kills, &cancel_key, false,
            panel_db.as_deref(), Some(DEFAULT_MAX_ROWS)) => {
            r.map_err(crate::apperror::AppError::from)
        }
        _ = rx => Err(crate::apperror::AppError::cancelled()),
    };

    state.cancels.write().await.remove(&cancel_key);
    state.kills.write().await.remove(&cancel_key);
    state.ch_kills.write().await.remove(&cancel_key);
    result
}

/// Cancel a panel_query started with the same token.
#[tauri::command]
pub async fn cancel_panel_query(
    session_id: Uuid,
    token: String,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    let cancel_key = format!("panel-{}-{}", session_id, token);
    stop_in_flight(session_id, &cancel_key, &state.sessions, &state.kills, &state.ch_kills).await;
    if let Some(tx) = state.cancels.write().await.remove(&cancel_key) {
        let _ = tx.send(());
    }
    Ok(())
}

/// The outcome of a hard kill, reported honestly.
#[derive(serde::Serialize)]
pub struct KillOutcome {
    /// The server-side id we killed, when we had one.
    pub backend_id: Option<u64>,
    /// `Some(true)` = confirmed gone. `Some(false)` = still there.
    /// `None` = we could not check (no privilege, engine has no processlist).
    pub confirmed_gone: Option<bool>,
    /// One sentence for the user, stating exactly what is known.
    pub message: String,
}

/// Hard-kill a panel query, then **look again**.
///
/// `cancel_panel_query` sends `KILL QUERY` / `pg_cancel_backend` — a request
/// the server honours at its next interrupt point, which a statement stuck in
/// a lock wait can decline for a long time. That is the right default for a
/// Cancel: the connection survives.
///
/// This is the other thing, for when a view has been running for two minutes
/// and the answer needs to be "it is gone": `KILL CONNECTION` /
/// `pg_terminate_backend`, which end the backend rather than asking it to
/// stop. The session's connection dies with it; the pool opens another.
///
/// Then it checks. A kill command returning Ok means the *request* was
/// accepted, not that anything died — so the backend is looked up again and
/// the answer says which of the three things is true. Claiming success without
/// looking is exactly the assurance nobody should trust.
#[tauri::command]
pub async fn kill_panel_query(
    session_id: Uuid,
    token: String,
    state: State<'_, AppState>,
) -> Result<KillOutcome, crate::apperror::AppError> {
    let cancel_key = format!("panel-{}-{}", session_id, token);
    let backend = state.kills.write().await.remove(&cancel_key);

    // Release the waiter regardless: whatever happens on the server, this
    // client is no longer waiting for that answer.
    if let Some(tx) = state.cancels.write().await.remove(&cancel_key) {
        let _ = tx.send(());
    }

    let Some(backend_id) = backend else {
        return Ok(KillOutcome {
            backend_id: None,
            confirmed_gone: None,
            message: "Nothing to kill — the query had already finished, or the server \
                      connection id was never recorded.".into(),
        });
    };

    connection::kill_backend(session_id, backend_id, &state.sessions,
        connection::KillForce::Hard).await;

    // The server needs a moment to reap it; without the pause the check races
    // the kill and reports a false "still running".
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let alive = connection::backend_alive(session_id, backend_id, &state.sessions).await;

    let message = match alive {
        Some(false) => format!("Killed — backend {backend_id} is gone from the server."),
        Some(true)  => format!(
            "Backend {backend_id} is STILL on the server after a hard kill. It is most likely \
             in a rollback that has to finish, which cannot be interrupted — watch it in \
             ⚡ Processes."),
        None => format!(
            "Kill sent to backend {backend_id}, but it could not be confirmed — reading the \
             process list needs a privilege this account does not have."),
    };

    Ok(KillOutcome { backend_id: Some(backend_id), confirmed_gone: alive.map(|a| !a), message })
}

#[cfg(test)]
mod tests {
    /// Live check for the DBA-views "stuck panel" report: an UNCOMMITTED
    /// `UPDATE performance_schema.setup_consumers` (e.g. the guidance fix SQL
    /// run inside a manual transaction in a query tab) must not permanently
    /// block the digest reads the DBA views issue from other connections —
    /// and when it does block, a client-side cancel must still unblock us.
    ///
    ///   TXUI_TEST_CONN=Lo80 cargo test --lib pfs_setup_update -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn pfs_setup_update_uncommitted_vs_digest_read() {
        let Ok(name) = std::env::var("TXUI_TEST_CONN") else { return };
        let dir = crate::storage::default_data_dir();
        let configs = crate::storage::load(&dir).expect("read connections.json");
        let config = configs.values().find(|c| c.name == name).expect("connection not found").clone();
        let password = crate::secretstore::get(&dir, &config.keychain_key());

        let pool = crate::db::mysql::open_pool(&config, password, None, 4).await.unwrap();
        let mut holder = pool.acquire().await.unwrap();

        // Holder: uncommitted consumer flip, like a query tab with autocommit off.
        crate::db::mysql::execute(&mut *holder, "BEGIN").await.unwrap();
        crate::db::mysql::execute(&mut *holder,
            "UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME='statements_digest'")
            .await.unwrap();

        // Reader: the "Top statements by latency" view from a second connection.
        let reader = tokio::spawn({
            let pool = pool.clone();
            async move {
                let mut conn = pool.acquire().await.unwrap();
                crate::db::mysql::execute(&mut *conn,
                    "SELECT DIGEST_TEXT FROM performance_schema.events_statements_summary_by_digest LIMIT 1")
                    .await.map(|_| ())
            }
        });
        let blocked = tokio::time::timeout(std::time::Duration::from_secs(3), reader).await;
        match blocked {
            Ok(r) => println!("digest read returned while holder tx open: {:?}", r.map_err(crate::apperror::AppError::from)),
            Err(_) => println!("digest read BLOCKED >3s by uncommitted setup_consumers UPDATE"),
        }

        crate::db::mysql::execute(&mut *holder, "ROLLBACK").await.unwrap();
        drop(holder);

        // After rollback, the same read must come back immediately.
        let mut conn = pool.acquire().await.unwrap();
        let t = std::time::Instant::now();
        crate::db::mysql::execute(&mut *conn,
            "SELECT DIGEST_TEXT FROM performance_schema.events_statements_summary_by_digest LIMIT 1")
            .await.unwrap();
        assert!(t.elapsed() < std::time::Duration::from_secs(3), "read still slow after rollback");
        pool.close().await;
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::*;
    use crate::db::types::{ConnectionConfig, Engine, LiveSession};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::RwLock;

    async fn session(pool_size: u32) -> (Uuid, crate::state::SessionMap) {
        let mut cfg = ConnectionConfig::new(Engine::Mysql, "t");
        cfg.host = Some("127.0.0.1".into());
        cfg.port = Some(3306);
        cfg.user = Some("root".into());
        let pool = crate::db::mysql::open_pool(&cfg, Some("root".into()), None, pool_size)
            .await.expect("connect");
        let id = Uuid::new_v4();
        let map: crate::state::SessionMap = Arc::new(RwLock::new(Default::default()));
        map.write().await.insert(id, Arc::new(LiveSession::Mysql(pool)));
        (id, map)
    }

    /// The deadline must do two things, and the second is the one that is easy
    /// to get wrong: return promptly, *and* stop the server working. A version
    /// that only abandoned the future would pass a naive timing assertion while
    /// leaving `SELECT SLEEP(30)` running on the box.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn an_expired_deadline_kills_the_query_on_the_server() {
        let (id, sessions) = session(2).await;
        let kills: crate::state::KillMap = Arc::new(RwLock::new(Default::default()));
        let ch_kills: crate::state::ChKillMap = Arc::new(RwLock::new(Default::default()));
        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();

        let started = Instant::now();
        let err = race_query(id, "SELECT SLEEP(30)", &sessions, &kills, &ch_kills, "k", false, None,
                             rx, Some(Duration::from_secs(1)), None)
            .await.expect_err("a 1s deadline must not let SLEEP(30) through");

        assert!(started.elapsed() < Duration::from_secs(5),
                "returned late: {:?}", started.elapsed());
        assert_eq!(err.code, crate::apperror::ErrorCode::Timeout,
                   "a deadline is not a cancellation — it must reach history");
        assert!(!err.code.is_user_intent(), "nobody pressed Stop");

        // The KILL is spawned, so give it a moment, then ask the server whether
        // the statement is really gone rather than trusting that we sent it.
        tokio::time::sleep(Duration::from_millis(750)).await;
        let guard = sessions.read().await;
        let LiveSession::Mysql(pool) = guard.get(&id).unwrap().as_ref() else { unreachable!() };
        let r = crate::db::mysql::execute(pool,
            "SELECT COUNT(*) FROM information_schema.PROCESSLIST \
             WHERE INFO LIKE 'SELECT SLEEP(30)%'").await.expect("processlist");
        assert_eq!(r.rows[0][0], serde_json::json!(0),
                   "the query survived the deadline and is still running on the server");
    }

    /// No deadline configured must mean no deadline applied — the shipped
    /// default, and the path every query takes until someone opts in.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn no_deadline_lets_a_slow_query_finish() {
        let (id, sessions) = session(1).await;
        let kills: crate::state::KillMap = Arc::new(RwLock::new(Default::default()));
        let ch_kills: crate::state::ChKillMap = Arc::new(RwLock::new(Default::default()));
        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();

        let r = race_query(id, "SELECT SLEEP(2)", &sessions, &kills, &ch_kills, "k2", false, None,
                           rx, None, None).await;
        assert!(r.is_ok(), "unbounded run was interrupted: {:?}", r.err());
    }
}

#[cfg(test)]
mod stop_tests {
    //! `stop_in_flight` — the one place a Stop button reaches the server.
    //!
    //! Worth pinning without a database because the failure it exists to
    //! prevent is silent: three call sites (Stop, panel Stop, the deadline)
    //! each had their own copy that knew only about `kills`, so a ClickHouse
    //! query would have been "cancelled" by a button that did nothing at all
    //! and reported success. A Stop button cannot afford that — there is no
    //! error for the user to notice.
    use super::*;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn maps() -> (crate::state::SessionMap, crate::state::KillMap, crate::state::ChKillMap) {
        (Arc::new(RwLock::new(Default::default())),
         Arc::new(RwLock::new(Default::default())),
         Arc::new(RwLock::new(Default::default())))
    }

    /// Both handles go, whichever engine the key belongs to. An id left behind
    /// is worse than none: the next query on that tab inherits it, and a later
    /// Stop kills whatever has since been given that backend.
    #[tokio::test]
    async fn a_stop_clears_both_kinds_of_handle() {
        let (sessions, kills, ch_kills) = maps();
        let id = Uuid::new_v4();
        kills.write().await.insert("k".into(), 42);
        ch_kills.write().await.insert("k".into(), "some-query-id".into());

        stop_in_flight(id, "k", &sessions, &kills, &ch_kills).await;

        assert!(kills.read().await.is_empty(), "the backend id outlived the stop");
        assert!(ch_kills.read().await.is_empty(), "the ClickHouse query id outlived the stop");
    }

    /// Only this key's handles. Stopping one tab must not disarm another.
    #[tokio::test]
    async fn a_stop_leaves_other_keys_alone() {
        let (sessions, kills, ch_kills) = maps();
        kills.write().await.insert("mine".into(), 1);
        kills.write().await.insert("theirs".into(), 2);
        ch_kills.write().await.insert("theirs".into(), "q".into());

        stop_in_flight(Uuid::new_v4(), "mine", &sessions, &kills, &ch_kills).await;

        assert_eq!(kills.read().await.get("theirs"), Some(&2));
        assert_eq!(ch_kills.read().await.get("theirs").map(String::as_str), Some("q"));
    }

    /// Pressing Stop on a query that has already finished is ordinary, not an
    /// error — the completion path removes the handle first, and the two race.
    #[tokio::test]
    async fn stopping_something_already_gone_is_quiet() {
        let (sessions, kills, ch_kills) = maps();
        stop_in_flight(Uuid::new_v4(), "nothing-here", &sessions, &kills, &ch_kills).await;
        assert!(kills.read().await.is_empty());
    }
}
