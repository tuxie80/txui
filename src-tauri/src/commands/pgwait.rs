//! Wait-event sampling profiler — where PostgreSQL backends spend their wait
//! time.
//!
//! Postgres exposes, in `pg_stat_activity`, what each backend is *waiting on*
//! right now (`wait_event_type` / `wait_event`) — but only as an instantaneous
//! snapshot. There is no cumulative per-event counter to query. The way tools
//! like pganalyze and pg_activity turn that instant into a profile is the same
//! trick a sampling CPU profiler uses: poll fast, count occurrences, and let
//! the law of large numbers approximate the time distribution. A backend seen
//! on `LWLock:WALWrite` in 40 of 200 samples spent roughly 20% of the window
//! waiting there.
//!
//! That is a poll loop, not a held socket — the opposite of `pglisten`, which
//! forwards events the server pushes. Here the server pushes nothing; we ask,
//! on a fixed cadence, and stream each snapshot to the frontend to aggregate.
//! We reuse the session's pool (a short `SELECT` every ~150 ms is cheap and
//! wants a fresh connection each time, not a pinned one) rather than holding a
//! dedicated connection.
//!
//! Every sampler is registered in a module-local map so it can be stopped. A
//! loop that outlives the panel that opened it is a poll nobody reads — cheap,
//! but pointless load on a production server, so it must end when the panel
//! does. The registry lives here, not on `AppState`: a sampler is fully
//! self-contained and needs nothing from the shared state beyond the read-only
//! session lookup.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::OnceLock;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::apperror::AppError;
use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;

/// One backend as seen in a single snapshot. A backend that is running rather
/// than waiting has `wait_event_type` = NULL — that is not missing data, it is
/// the "on CPU / not waiting" bucket, and the frontend counts it as such.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitBackend {
    pub pid: i32,
    pub wait_event_type: Option<String>,
    pub wait_event: Option<String>,
    pub state: Option<String>,
    pub query: Option<String>,
}

/// What the sampler streams. Tagged so the frontend can switch on it exactly
/// like `pglisten`'s `ListenEvent`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WaitSample {
    /// Sent once, so the UI can stop saying "starting". A sampler that has
    /// begun but caught every backend idle looks identical to one that never
    /// started otherwise.
    Sampling { interval_ms: u64 },
    /// One poll tick. `backends` excludes our own polling backend.
    Snapshot { at_ms: i64, backends: Vec<WaitBackend> },
    /// The loop stopped on an error (not on a normal stop). Terminal.
    Closed { reason: String },
}

/// Running samplers, keyed by the token the frontend generated. Module-local
/// rather than on `AppState`: nothing outside this file needs to reach a
/// sampler, and keeping it here is what lets the module stay self-contained.
/// The session id rides along so a connection close can stop the samplers
/// it owns.
struct SamplerEntry {
    session_id: Uuid,
    handle: tokio::task::JoinHandle<()>,
}
type SamplerMap = HashMap<String, SamplerEntry>;

fn samplers() -> &'static Mutex<SamplerMap> {
    static SAMPLERS: OnceLock<Mutex<SamplerMap>> = OnceLock::new();
    SAMPLERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Abort every sampler belonging to a session (connection close).
pub async fn stop_session_samplers(session_id: Uuid) {
    let entries: Vec<SamplerEntry> = {
        let mut m = samplers().lock().await;
        let tokens: Vec<String> = m.iter()
            .filter(|(_, e)| e.session_id == session_id)
            .map(|(t, _)| t.clone())
            .collect();
        tokens.into_iter().filter_map(|t| m.remove(&t)).collect()
    };
    for e in entries { e.handle.abort(); }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A poll faster than this is more load than signal — the snapshot cost starts
/// to dominate the interval — and slower than the ceiling is no longer a
/// profiler. Both bounds also protect the server from a frontend bug that
/// sends 0.
const MIN_INTERVAL_MS: u64 = 50;
const MAX_INTERVAL_MS: u64 = 2000;
const DEFAULT_INTERVAL_MS: u64 = 150;

fn clamp_interval(requested: u64) -> u64 {
    if requested == 0 {
        DEFAULT_INTERVAL_MS
    } else {
        requested.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS)
    }
}

/// Read-only. `pg_backend_pid()` excludes the connection running *this* query,
/// so the sampler never profiles itself. All columns are read by name.
const SAMPLE_SQL: &str = "SELECT pid, wait_event_type, wait_event, state, query \
     FROM pg_stat_activity \
     WHERE pid <> pg_backend_pid()";

/// Start sampling. `token` identifies the sampler for `pg_wait_sample_stop`.
#[tauri::command]
pub async fn pg_wait_sample_start(
    session_id: Uuid,
    token: String,
    interval_ms: u64,
    on_event: Channel<WaitSample>,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let session = get_session_pub(session_id, &state.sessions).await?;
    let LiveSession::Postgres(pool) = session.as_ref() else {
        return Err(AppError::unsupported(
            "wait-event sampling reads pg_stat_activity, a PostgreSQL view",
        ));
    };
    let pool = pool.clone();
    let interval = clamp_interval(interval_ms);

    // Stop any prior sampler under the same token before replacing it, so a
    // restart cannot leave an orphaned loop running.
    if let Some(prev) = samplers().lock().await.remove(&token) {
        prev.handle.abort();
    }

    let _ = on_event.send(WaitSample::Sampling { interval_ms: interval });

    let key = token.clone();
    let handle = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(interval));
        // If a poll ever runs long, skip the missed ticks rather than firing a
        // burst to catch up — a burst would be exactly the load spike the
        // interval exists to avoid.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            match sample_once(&pool).await {
                Ok(backends) => {
                    let ev = WaitSample::Snapshot { at_ms: now_ms(), backends };
                    // A closed channel means the panel is gone. Stop rather
                    // than keep polling a view nobody is reading.
                    if on_event.send(ev).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = on_event.send(WaitSample::Closed { reason: e.to_string() });
                    break;
                }
            }
        }
        samplers().lock().await.remove(&key);
    });

    samplers().lock().await.insert(token, SamplerEntry { session_id, handle });
    Ok(())
}

/// One snapshot of the currently-waiting backends. Split out so the query and
/// its column mapping can be unit-visible in one place.
async fn sample_once(pool: &sqlx::PgPool) -> Result<Vec<WaitBackend>, sqlx::Error> {
    use sqlx::Row;
    let rows = sqlx::query(SAMPLE_SQL).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .map(|r| WaitBackend {
            pid: r.get("pid"),
            wait_event_type: r.get("wait_event_type"),
            wait_event: r.get("wait_event"),
            state: r.get("state"),
            query: r.get("query"),
        })
        .collect())
}

/// Stop a sampler. Unknown token is not an error — the caller wanted it stopped
/// and it is.
#[tauri::command]
pub async fn pg_wait_sample_stop(token: String) -> Result<(), AppError> {
    if let Some(e) = samplers().lock().await.remove(&token) {
        e.handle.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_is_clamped_into_a_sane_band() {
        assert_eq!(clamp_interval(0), DEFAULT_INTERVAL_MS, "0 means 'no opinion'");
        assert_eq!(clamp_interval(10), MIN_INTERVAL_MS, "faster than the floor");
        assert_eq!(clamp_interval(999_999), MAX_INTERVAL_MS, "slower than the ceiling");
        assert_eq!(clamp_interval(150), 150, "a value in band is left alone");
    }

    /// Connection close stops the session's samplers and nobody else's.
    #[tokio::test]
    async fn stop_session_samplers_aborts_only_that_sessions() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        samplers().lock().await.insert("txui_test_a".into(), SamplerEntry {
            session_id: a, handle: tokio::spawn(std::future::pending::<()>()),
        });
        samplers().lock().await.insert("txui_test_b".into(), SamplerEntry {
            session_id: b, handle: tokio::spawn(std::future::pending::<()>()),
        });

        stop_session_samplers(a).await;

        let mut m = samplers().lock().await;
        assert!(!m.contains_key("txui_test_a"), "the session's sampler must be gone");
        assert!(m.contains_key("txui_test_b"), "another session's sampler must survive");
        if let Some(e) = m.remove("txui_test_b") { e.handle.abort(); }
    }
}

#[cfg(test)]
mod live_tests {
    //! Against a local PostgreSQL — see `db::postgres::live_tests` for the
    //! fixture (user/password `root`, ports 5432–5435).

    use super::*;

    async fn pool(port: u16) -> sqlx::PgPool {
        let mut c = crate::db::types::ConnectionConfig::new(crate::db::types::Engine::Postgres, "t");
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.database = Some("postgres".into());
        c.ssl_mode = crate::db::types::SslMode::Disable;
        crate::db::postgres::open_pool(&c, Some("root".into()), None, 2)
            .await
            .expect("connect")
    }

    /// The core query must run, exclude our own backend, and return the wait
    /// columns without a type mismatch — the failure mode a positional read
    /// would hide.
    #[tokio::test]
    #[ignore = "needs local PostgreSQL"]
    async fn a_snapshot_excludes_the_sampling_backend() {
        let p = pool(5433).await;
        let self_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&p)
            .await
            .expect("pid");
        let backends = sample_once(&p).await.expect("sample");
        assert!(
            backends.iter().all(|b| b.pid != self_pid),
            "the sampler profiled its own polling backend",
        );
    }
}
