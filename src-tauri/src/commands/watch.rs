/// Long-running query watcher. Runs a statement on a dedicated pooled
/// connection, reports its server thread id immediately, then the frontend
/// polls the processlist / performance_schema for that thread's phase and
/// progress. Cancel issues KILL QUERY on a separate connection.
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::db::types::LiveSession;
use crate::db::connection::get_session_pub;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WatchEvent {
    Started { thread_id: u64 },
    Done { rows: u64, ms: u64, ok: bool, error: Option<String>, cancelled: bool },
}

#[tauri::command]
pub async fn run_watched(
    session_id: Uuid,
    sql: String,
    run_key: String,
    on_event: Channel<WatchEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    // Engine-aware: SQL goes through sqlguard, Redis through redisguard.
    // Choosing a guard per call site is how every Redis write slipped past.
    state.guard_statement(&session_id, &sql).await?;
    let session = get_session_pub(session_id, &state.sessions).await?;
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    // Session-prefixed so `cancel_session_work` finds it on close; the cancel
    // command resolves the bare key via `take_ext_job`.
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    state.ext_jobs.write().await.insert(job_key.clone(), cancel_tx);
    let result = match session.as_ref() {
        LiveSession::Mysql(pool) => watch_my(pool.clone(), sql, on_event, cancel_rx).await,
        LiveSession::Postgres(pool) => watch_pg(pool.clone(), sql, on_event, cancel_rx).await,
        LiveSession::SqlServer(_) => watch_ms(session.clone(), sql, on_event, cancel_rx).await,
        _ => Err("query watcher is only available for MySQL, PostgreSQL and SQL Server".into()),
    };
    state.ext_jobs.write().await.remove(&job_key);
    result
}

#[tauri::command]
pub async fn cancel_watched(run_key: String, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    if let Some(tx) = crate::state::take_ext_job(&state.ext_jobs, &run_key).await {
        let _ = tx.send(());
    }
    Ok(())
}

/// The SQL Server watcher.
///
/// Structurally the same as the other two, with one difference the user has to
/// be told about rather than surprised by: **T-SQL has no "cancel the query but
/// keep the session".** MySQL has `KILL QUERY` and PostgreSQL has
/// `pg_cancel_backend`; SQL Server's `KILL` ends the whole session. So Stop here
/// takes the connection with it, and the session layer reopens it on the next
/// statement — which `execute_capped` already does, and which is why a cancel
/// does not leave the tab unusable.
async fn watch_ms(
    session: std::sync::Arc<crate::db::types::LiveSession>,
    sql: String,
    on_event: Channel<WatchEvent>,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), crate::apperror::AppError> {
    let crate::db::types::LiveSession::SqlServer(s) = session.as_ref() else {
        return Err("not a SQL Server session".into());
    };
    // Best effort: a session with no VIEW SERVER STATE can still run the query,
    // it just cannot be cancelled — reporting 0 beats refusing to start.
    let spid = crate::db::sqlserver::spid(s).await.unwrap_or(0);
    let _ = on_event.send(WatchEvent::Started { thread_id: spid });
    let started = std::time::Instant::now();
    tokio::select! {
        r = crate::db::sqlserver::execute(s, &sql) => {
            let ms = started.elapsed().as_millis() as u64;
            match r {
                Ok(res) => { let _ = on_event.send(WatchEvent::Done {
                    rows: res.rows.len() as u64, ms, ok: true, error: None, cancelled: false }); }
                Err(e) => { let _ = on_event.send(WatchEvent::Done {
                    rows: 0, ms, ok: false, error: Some(e.to_string()), cancelled: false }); }
            }
        }
        _ = &mut cancel_rx => {
            // From an auxiliary connection: the watched statement is occupying
            // this session's only one, so a KILL sent down it would queue behind
            // the statement it is meant to stop.
            if spid != 0 {
                let _ = crate::db::sqlserver::kill_spid(s, spid).await;
            }
            let ms = started.elapsed().as_millis() as u64;
            let _ = on_event.send(WatchEvent::Done {
                rows: 0, ms, ok: false, error: None, cancelled: true });
        }
    }
    Ok(())
}

async fn watch_my(
    pool: sqlx::MySqlPool,
    sql: String,
    on_event: Channel<WatchEvent>,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), crate::apperror::AppError> {
    let mut conn = pool.acquire().await?;
    let tid: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
        .fetch_one(&mut *conn).await?;
    let _ = on_event.send(WatchEvent::Started { thread_id: tid });
    let started = std::time::Instant::now();
    let killer = pool.clone();
    tokio::select! {
        r = crate::db::mysql::execute(&mut *conn, &sql) => {
            let ms = started.elapsed().as_millis() as u64;
            match r {
                Ok(res) => { let _ = on_event.send(WatchEvent::Done {
                    rows: res.rows.len() as u64, ms, ok: true, error: None, cancelled: false }); }
                Err(e) => { let _ = on_event.send(WatchEvent::Done {
                    rows: 0, ms, ok: false, error: Some(e.to_string()), cancelled: false }); }
            }
        }
        _ = &mut cancel_rx => {
            // KILL QUERY on a separate connection, then let the statement unwind.
            if let Ok(mut k) = killer.acquire().await {
                let _ = crate::db::mysql::execute(&mut *k, &format!("KILL QUERY {tid}")).await;
            }
            let ms = started.elapsed().as_millis() as u64;
            let _ = on_event.send(WatchEvent::Done { rows: 0, ms, ok: false, error: None, cancelled: true });
        }
    }
    Ok(())
}

async fn watch_pg(
    pool: sqlx::PgPool,
    sql: String,
    on_event: Channel<WatchEvent>,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), crate::apperror::AppError> {
    let mut conn = pool.acquire().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *conn).await?;
    let _ = on_event.send(WatchEvent::Started { thread_id: pid as u64 });
    let started = std::time::Instant::now();
    let killer = pool.clone();
    tokio::select! {
        r = crate::db::postgres::execute(&mut *conn, &sql) => {
            let ms = started.elapsed().as_millis() as u64;
            match r {
                Ok(res) => { let _ = on_event.send(WatchEvent::Done {
                    rows: res.rows.len() as u64, ms, ok: true, error: None, cancelled: false }); }
                Err(e) => { let _ = on_event.send(WatchEvent::Done {
                    rows: 0, ms, ok: false, error: Some(e.to_string()), cancelled: false }); }
            }
        }
        _ = &mut cancel_rx => {
            if let Ok(mut k) = killer.acquire().await {
                let _ = crate::db::postgres::execute(&mut *k, &format!("SELECT pg_cancel_backend({pid})")).await;
            }
            let ms = started.elapsed().as_millis() as u64;
            let _ = on_event.send(WatchEvent::Done { rows: 0, ms, ok: false, error: None, cancelled: true });
        }
    }
    Ok(())
}

/// The SQL Server watcher, against a real server.
///
/// The interesting half is the cancel: T-SQL has no "cancel the query but keep
/// the session", so Stop takes the connection with it and the session layer has
/// to survive that. A watcher that could not be stopped, or that left the tab
/// dead afterwards, would be worse than not having one.
#[cfg(test)]
mod mssql_watch_live_tests {
    use super::*;
    use crate::db::sqlserver::{self, live_tests::live_session};

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn a_watched_query_runs_and_reports_its_rows() {
        let Some(s) = live_session().await else {
            println!("no endpoint configured — see docs/MSSQL_DEV.md");
            return;
        };
        let session = std::sync::Arc::new(crate::db::types::LiveSession::SqlServer(s));
        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();
        let ch: Channel<WatchEvent> = Channel::new(|_| Ok(()));
        watch_ms(session.clone(), "SELECT TOP (7) name FROM sys.objects".into(), ch, rx)
            .await.expect("watch");

        // The session must still be usable afterwards — a watcher that leaves
        // the tab dead is not a feature.
        let crate::db::types::LiveSession::SqlServer(s2) = session.as_ref() else { unreachable!() };
        let after = sqlserver::execute(s2, "SELECT 1 AS n").await.expect("still usable");
        assert_eq!(after.rows[0][0].as_i64(), Some(1));
    }

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn cancel_stops_a_long_watch_and_the_session_recovers() {
        let Some(s) = live_session().await else { return };
        let session = std::sync::Arc::new(crate::db::types::LiveSession::SqlServer(s));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let ch: Channel<WatchEvent> = Channel::new(|_| Ok(()));

        let watching = tokio::spawn({
            let session = session.clone();
            async move {
                watch_ms(session, "WAITFOR DELAY '00:00:30'".into(), ch, rx).await
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        tx.send(()).ok();

        // It must come back promptly rather than sitting out the 30 seconds.
        let started = std::time::Instant::now();
        watching.await.expect("join").expect("watch_ms");
        assert!(started.elapsed() < std::time::Duration::from_secs(10),
                "cancel did not stop the statement");

        // KILL ends the whole SESSION on SQL Server, so the recovery is the
        // point of the test: `execute_capped` reconnects once on a dead
        // connection, and the tab keeps working.
        let crate::db::types::LiveSession::SqlServer(s2) = session.as_ref() else { unreachable!() };
        let after = sqlserver::execute(s2, "SELECT 42 AS n").await
            .expect("the session must be usable after a cancel");
        assert_eq!(after.rows[0][0].as_i64(), Some(42));
    }
}
