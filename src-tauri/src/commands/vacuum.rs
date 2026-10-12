//! Cancellable VACUUM — the Vacuum & Bloat panel's tracked runner.
//!
//! The panel's maintenance verbs (VACUUM / ANALYZE / REINDEX … CONCURRENTLY /
//! VACUUM FULL / CLUSTER) can run for minutes to hours, and for its first
//! incarnation they went through `monitor_query`: a one-way door with no way
//! to stop a long VACUUM short of finding its pid in the Processes panel.
//!
//! This is the watch.rs pattern applied to that gap. The statement runs on a
//! connection acquired for the run alone — never the session's pinned
//! transaction connection, which is where `monitor_query` would route it (and
//! where VACUUM dies with "cannot run inside a transaction block"). The
//! backend's pid is reported immediately so the panel can point at the Now
//! section, and cancel — `cancel_watched`, shared with the query watcher via
//! `AppState.ext_jobs` — issues `pg_cancel_backend` from a SECOND connection:
//! the one running the statement cannot carry its own cancel.
//!
//! PostgreSQL-only, like the panel itself. The read-only guard and the prod
//! hard limits (VACUUM FULL / CLUSTER are `is_dangerous_ddl`) are applied by
//! `guard_statement` before anything is dialed, so a tracked run can never
//! bypass what `monitor_query` enforced.
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::apperror::AppError;
use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VacuumEvent {
    /// The run has its own backend; `pid` matches pg_stat_progress_vacuum,
    /// so the panel's Now section IS this run's progress view.
    Started { pid: i64 },
    /// Terminal. `cancelled` distinguishes "stopped by the user" from a
    /// failure — the UI shows cancelled, not failed.
    Done { ms: u64, ok: bool, error: Option<String>, cancelled: bool },
}

/// Run one maintenance statement as a tracked, cancellable job.
/// Cancel through `cancel_watched` with the same `run_key`.
#[tauri::command]
pub async fn run_vacuum(
    session_id: Uuid,
    sql: String,
    run_key: String,
    on_event: Channel<VacuumEvent>,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.guard_statement(&session_id, &sql).await?;
    let session = get_session_pub(session_id, &state.sessions).await?;
    let LiveSession::Postgres(pool) = session.as_ref() else {
        return Err(AppError::unsupported(
            "tracked maintenance runs are a PostgreSQL feature — the Vacuum & Bloat panel is PostgreSQL-only"));
    };
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    // Session-prefixed so `cancel_session_work` stops a running VACUUM when
    // the connection closes; `cancel_watched` resolves the bare frontend key.
    let job_key = crate::state::ext_job_key(session_id, &run_key);
    state.ext_jobs.write().await.insert(job_key.clone(), cancel_tx);
    let result = run_pg(pool.clone(), sql, on_event, cancel_rx).await;
    state.ext_jobs.write().await.remove(&job_key);
    result
}

async fn run_pg(
    pool: sqlx::PgPool,
    sql: String,
    on_event: Channel<VacuumEvent>,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), AppError> {
    let mut conn = pool.acquire().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *conn).await?;
    let _ = on_event.send(VacuumEvent::Started { pid: i64::from(pid) });
    let started = std::time::Instant::now();
    let killer = pool.clone();
    tokio::select! {
        r = crate::db::postgres::execute(&mut *conn, &sql) => {
            let ms = started.elapsed().as_millis() as u64;
            match r {
                Ok(_) => { let _ = on_event.send(VacuumEvent::Done {
                    ms, ok: true, error: None, cancelled: false }); }
                Err(e) => { let _ = on_event.send(VacuumEvent::Done {
                    ms, ok: false, error: Some(e.to_string()), cancelled: false }); }
            }
        }
        _ = &mut cancel_rx => {
            // pg_cancel_backend on a separate connection, then let the
            // statement unwind — the server turns it into ERROR 57014, which
            // the select! has already lost the race to report, and that is
            // the point: the user asked for this, so it is not a failure.
            if let Ok(mut k) = killer.acquire().await {
                let _ = crate::db::postgres::execute(
                    &mut *k, &format!("SELECT pg_cancel_backend({pid})")).await;
            }
            let ms = started.elapsed().as_millis() as u64;
            let _ = on_event.send(VacuumEvent::Done { ms, ok: false, error: None, cancelled: true });
        }
    }
    Ok(())
}

#[cfg(test)]
mod live_tests {
    //! Against a local PostgreSQL — same fixture as `commands::pglisten`
    //! (user/password `root`, ports 5432–5435).
    //!
    //! The command layer needs a Tauri `State`, so these exercise the part
    //! that carries the risk: `run_pg` itself — that a run reports its
    //! backend pid and completion, and that cancel actually interrupts the
    //! statement instead of waiting it out.

    use super::*;

    /// `None` when no local fixture is listening — the tests skip quietly,
    /// like the watch.rs live tests, rather than failing on a machine that
    /// simply has no server up.
    async fn pool(port: u16) -> Option<sqlx::PgPool> {
        let mut c = crate::db::types::ConnectionConfig::new(
            crate::db::types::Engine::Postgres, "t");
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.database = Some("postgres".into());
        c.ssl_mode = crate::db::types::SslMode::Disable;
        c.connect_timeout_secs = Some(2);
        match crate::db::postgres::open_pool(&c, Some("root".into()), None, 2).await {
            Ok(p) => Some(p),
            Err(_) => { println!("no local PostgreSQL on {port} — skipping"); None }
        }
    }

    /// Capture every event the run emits, in order.
    fn recorder() -> (Channel<VacuumEvent>,
                       std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let ch = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    sink.lock().unwrap().push(v);
                }
            }
            Ok(())
        });
        (ch, seen)
    }

    #[tokio::test]
    #[ignore = "needs local PostgreSQL"]
    async fn a_run_reports_its_pid_and_completion() {
        let Some(p) = pool(5433).await else { return };
        let (ch, seen) = recorder();
        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();
        run_pg(p, "VACUUM pg_catalog.pg_class".into(), ch, rx).await.expect("run");

        let evs = seen.lock().unwrap().clone();
        assert_eq!(evs.len(), 2, "started + done, nothing else: {evs:?}");
        assert_eq!(evs[0]["type"], "started");
        assert!(evs[0]["pid"].as_i64().unwrap() > 0);
        assert_eq!(evs[1]["type"], "done");
        assert_eq!(evs[1]["ok"], true, "{evs:?}");
        assert_eq!(evs[1]["cancelled"], false);
    }

    /// The whole point of the feature: a cancel interrupts the statement
    /// promptly, and the event says `cancelled`, not `failed`. pg_sleep
    /// stands in for the long VACUUM — the cancel machinery does not care
    /// which statement it interrupts.
    #[tokio::test]
    #[ignore = "needs local PostgreSQL"]
    async fn cancel_interrupts_the_run_and_says_so() {
        let Some(p) = pool(5433).await else { return };
        let (ch, seen) = recorder();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let running = tokio::spawn(run_pg(p, "SELECT pg_sleep(30)".into(), ch, rx));
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        tx.send(()).ok();

        let started = std::time::Instant::now();
        running.await.expect("join").expect("run_pg");
        assert!(started.elapsed() < std::time::Duration::from_secs(10),
                "cancel did not interrupt the statement");

        let evs = seen.lock().unwrap().clone();
        let done = evs.iter().find(|e| e["type"] == "done").expect("a done event");
        assert_eq!(done["cancelled"], true, "{evs:?}");
        assert_eq!(done["ok"], false, "cancelled is not ok, and not failed: {evs:?}");
        assert!(done["error"].is_null(), "a cancel carries no error text: {evs:?}");
    }

    /// A server-side failure (not a cancel) arrives as ok:false with the
    /// server's message — a missing table must not masquerade as a cancel.
    #[tokio::test]
    #[ignore = "needs local PostgreSQL"]
    async fn a_failing_run_reports_the_error_not_a_cancel() {
        let Some(p) = pool(5433).await else { return };
        let (ch, seen) = recorder();
        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();
        run_pg(p, "VACUUM no_such_schema.no_such_table".into(), ch, rx).await.expect("run");

        let evs = seen.lock().unwrap().clone();
        let done = evs.iter().find(|e| e["type"] == "done").expect("a done event");
        assert_eq!(done["ok"], false);
        assert_eq!(done["cancelled"], false);
        assert!(done["error"].as_str().unwrap_or("").contains("no_such_table"), "{evs:?}");
    }
}
