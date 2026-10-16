use std::collections::HashMap;
use std::sync::Arc;
use sqlx::AssertSqlSafe;
use tokio::sync::RwLock;
use uuid::Uuid;
use anyhow::Result;

use super::types::{ConnectionConfig, Engine, LiveSession, PingResult, QueryResult, SchemaNode};
use super::{duckdb, parquet, sqlite};
use super::{clickhouse, mongodb, mysql, postgres, redis, sqlserver};

/// Global session registry shared across Tauri commands
pub type SessionMap = Arc<RwLock<HashMap<Uuid, Arc<LiveSession>>>>;

/// The password to authenticate with: for Cloud SQL IAM connections a freshly
/// minted OAuth2 token (never the stored secret), for everything else the
/// stored password unchanged. Only MySQL/PostgreSQL authenticate this way.
///
/// Used by BOTH `open_session` and `ping` — the IAM mint lived only in
/// `open_session` at first, so Test/ping of a saved IAM connection sent the
/// (usually empty) stored password and reported "Access denied" on a
/// connection that opens fine.
/// Which credential file an IAM connection should mint from: the configured
/// key path, else this machine's gcloud ADC (`adc` is resolved by the caller
/// so tests can pin it). A service account has a key file; a human has
/// `gcloud auth application-default login` — both mint the same kind of token.
fn resolve_iam_key(
    config: &ConnectionConfig,
    adc: Option<std::path::PathBuf>,
) -> Result<String> {
    config.iam_key_path.as_deref().filter(|p| !p.is_empty())
        .map(str::to_string)
        .or_else(|| adc.map(|p| p.to_string_lossy().into_owned()))
        .ok_or_else(|| anyhow::anyhow!(
            "IAM authentication is enabled but no credential file was found — set the \
             service-account key path, point GOOGLE_APPLICATION_CREDENTIALS at one, or run \
             `gcloud auth application-default login`"))
}

async fn iam_password(
    config: &ConnectionConfig,
    stored: Option<String>,
) -> Result<Option<String>> {
    if config.use_iam_auth && matches!(config.engine, Engine::Mysql | Engine::Postgres) {
        let key = resolve_iam_key(config, super::gcp_iam::default_credentials_path())?;
        Ok(Some(super::gcp_iam::iam_access_token(&key).await?))
    } else {
        Ok(stored)
    }
}

/// `host_override` = Some(("127.0.0.1", local_port)) when an SSH tunnel is active.
pub async fn open_session(
    config: &ConnectionConfig,
    password: Option<String>,
    sessions: &SessionMap,
    host_override: Option<(&str, u16)>,
) -> Result<Uuid> {
    // Cloud SQL IAM: the password is a freshly minted OAuth2 token, not the
    // stored secret.
    let password = iam_password(config, password).await?;
    let session = match config.engine {
        Engine::Mysql    => mysql::open(config, password, host_override).await?,
        Engine::Postgres => postgres::open(config, password, host_override).await?,
        Engine::Redis    => redis::open(config, password, host_override).await?,
        // HTTP is stateless — "opening" builds a configured client. The first
        // real round-trip is the caller's, so a bad endpoint surfaces there
        // rather than here.
        Engine::Clickhouse =>
            LiveSession::Clickhouse(clickhouse::open(config, password, host_override)?),
        // File-backed: `file_path` is the address. No dial, no tunnel, no auth.
        Engine::Sqlite   => LiveSession::Sqlite(sqlite::open(config).await?),
        Engine::Parquet  => LiveSession::Parquet(Arc::new(parquet::open_async(config).await?)),
        Engine::Duckdb   => LiveSession::Duckdb(Arc::new(duckdb::open(config).await?)),
        Engine::MongoDb  => mongodb::open(config, password, host_override).await?,
        Engine::SqlServer => {
            // The driver takes host/port from the config, so an active SSH
            // tunnel is applied by rewriting them to the local forward —
            // the same swap the other drivers do inside their open().
            let cfg = match host_override {
                Some((host, port)) => {
                    let mut c = config.clone();
                    c.host = Some(host.to_string());
                    c.port = Some(port);
                    c
                }
                None => config.clone(),
            };
            LiveSession::SqlServer(sqlserver::open(&cfg, password).await?)
        }
    };
    let id = Uuid::new_v4();
    sessions.write().await.insert(id, Arc::new(session));
    Ok(id)
}

/// Bound on the thread-id enumeration at close: the ids are only for the
/// close log line, so a slow server must not hold the close hostage for them.
const ENUMERATE_IDS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// CONNECTION_ID() of every idle pooled connection. Busy connections can't be
/// enumerated (they close too, id unreported).
async fn mysql_thread_ids(pool: &sqlx::MySqlPool) -> Vec<u64> {
    let mut ids = Vec::new();
    let mut held = Vec::new();
    for _ in 0..pool.size() {
        if let Some(mut c) = pool.try_acquire() {
            if let Ok(id) = sqlx::query_scalar::<_, u64>("SELECT CONNECTION_ID()")
                .fetch_one(&mut *c).await { ids.push(id); }
            held.push(c);
        }
    }
    ids
}

/// pg_backend_pid() of every idle pooled connection — same contract as
/// [`mysql_thread_ids`].
async fn pg_backend_ids(pool: &sqlx::PgPool) -> Vec<u64> {
    let mut ids = Vec::new();
    let mut held = Vec::new();
    for _ in 0..pool.size() {
        if let Some(mut c) = pool.try_acquire() {
            if let Ok(id) = sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
                .fetch_one(&mut *c).await { ids.push(id as u64); }
            held.push(c);
        }
    }
    ids
}

/// Close a session and return the DATABASE thread ids (MySQL CONNECTION_ID /
/// PG backend pid) of every idle pooled connection at close time — the UI
/// logs exactly which server threads were dropped. Connections busy mid-query
/// can't be enumerated (they close too, id unreported).
///
/// The enumeration is bounded (see [`ENUMERATE_IDS_TIMEOUT`]); the graceful
/// `pool.close()` is NOT bounded here — the caller (`close_connection`,
/// `close_all`) owns that timeout, because only it can decide to drop the
/// pool handle instead.
pub async fn close_session(session_id: Uuid, sessions: &SessionMap) -> Vec<u64> {
    let mut ids: Vec<u64> = Vec::new();
    if let Some(s) = sessions.write().await.remove(&session_id) {
        // Gracefully close the pool (clean server-side disconnect) rather than
        // relying on Drop's abrupt TCP teardown — matches close_all.
        match s.as_ref() {
            LiveSession::Mysql(pool) => {
                ids.extend(tokio::time::timeout(ENUMERATE_IDS_TIMEOUT, mysql_thread_ids(pool))
                    .await.unwrap_or_default());
                pool.close().await;
            }
            LiveSession::Postgres(pool) => {
                ids.extend(tokio::time::timeout(ENUMERATE_IDS_TIMEOUT, pg_backend_ids(pool))
                    .await.unwrap_or_default());
                pool.close().await;
            }
            // One client, not a pool: dropping the session closes the socket.
            // The spid is still worth collecting — the caller uses these ids to
            // reconcile what it just disconnected, and returning nothing made
            // SQL Server sessions invisible to that.
            LiveSession::SqlServer(s) => {
                if let Ok(spid) = sqlserver::spid(s).await { ids.push(spid); }
            }
            // A heavy query keeps running in spawn_blocking after the session
            // is removed — fire the engine's interrupt so it stops rather
            // than running to completion into the void. The worker's own Arc
            // keeps the session alive long enough for it to take effect.
            LiveSession::Duckdb(s) => s.interrupt(),
            _ => {}
        }
    }
    ids
}

/// Gracefully close every live session (pool .close()) and drop all SSH
/// tunnels — used on app exit so the server sees clean disconnects.
/// Sessions close CONCURRENTLY, each under its own 5 s timeout: a sequential
/// loop charges app quit N×5 s when several pools have connections still
/// checked out (a query mid-flight at exit), and one stuck close must not
/// hold the others hostage.
pub async fn close_all(state: &crate::state::AppState) {
    let sessions: Vec<(Uuid, Arc<LiveSession>)> = {
        let mut map = state.sessions.write().await;
        map.drain().collect()
    };
    let mut tasks = tokio::task::JoinSet::new();
    for (session_id, s) in sessions {
        // The window may already be gone at exit — the 'disconnect' audit row
        // is written from here precisely because the frontend cannot be asked.
        // Taken BEFORE the task spawns so the join loop below is the only
        // writer left.
        let start = state.session_starts.write().await.remove(&session_id);
        let history = state.history.clone();
        tasks.spawn(async move {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                match s.as_ref() {
                    LiveSession::Mysql(pool)    => pool.close().await,
                    LiveSession::Postgres(pool) => pool.close().await,
                    // Stop an in-flight spawn_blocking query instead of letting it
                    // run on past the exit; the connection itself closes on Drop
                    // like the other non-pool engines.
                    LiveSession::Duckdb(s)      => s.interrupt(),
                    // Only the sqlx pools need an awaited close. Every other engine
                    // holds either a single socket (SQL Server, ClickHouse), a file
                    // handle (SQLite, DuckDB, Parquet) or a manager (Redis, MongoDB),
                    // all of which close on Drop when the task ends and `s` goes out
                    // of scope — so the wildcard here is deliberate, not an
                    // unhandled case.
                    _ => {}
                }
            }).await;
            if let Some(start) = start {
                crate::commands::audit::insert_lifecycle(
                    &history, session_id, &start, "disconnect").await;
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    // Dropping the tunnels fires SshTunnel::Drop → kills the ssh child.
    state.tunnels.write().await.clear();
    state.session_meta.write().await.clear();
}

pub async fn ping(config: &ConnectionConfig, password: Option<String>) -> PingResult {
    // IAM connections authenticate with a minted token here too — a ping that
    // skips the mint answers "Access denied" about a password that is never
    // used, and the sidebar's Test was exactly that.
    let password = match iam_password(config, password).await {
        Ok(p) => p,
        Err(e) => return PingResult { ok: false, latency_ms: 0, server_version: None,
                                       error: Some(format!("{e:#}")) },
    };
    match &config.engine {
        Engine::Mysql    => mysql::ping(config, password).await,
        Engine::Postgres => postgres::ping(config, password).await,
        Engine::Redis    => redis::ping(config, password).await,
        Engine::Clickhouse => clickhouse::ping(config, password).await,
        Engine::Sqlite => match sqlite::open(config).await {
            Ok(pool) => { let r = sqlite::ping(&pool).await; pool.close().await; r }
            Err(e) => PingResult { ok: false, latency_ms: 0, server_version: None,
                                   error: Some(e.to_string()) },
        },
        Engine::Parquet => match parquet::open_async(config).await {
            Ok(f) => parquet::ping(&f),
            Err(e) => PingResult { ok: false, latency_ms: 0, server_version: None,
                                   error: Some(e.to_string()) },
        },
        Engine::Duckdb => match duckdb::open(config).await {
            Ok(s) => duckdb::ping(&s).await,
            Err(e) => PingResult { ok: false, latency_ms: 0, server_version: None,
                                   error: Some(e.to_string()) },
        },
        Engine::MongoDb => mongodb::ping(config, password).await,
        Engine::SqlServer => sqlserver::ping(config, password).await,
    }
}

/// SELECT 1-style liveness probe on a live session. Returns a short server
/// version string where the engine makes one cheap to get (Redis: None).
/// Used by `session_ping` (latency) and `test_connection_adhoc` (summary).
pub async fn probe_session(session: &LiveSession) -> Result<Option<String>> {
    match session {
        LiveSession::Mysql(pool) => {
            let v: String = sqlx::query_scalar("SELECT VERSION()").fetch_one(pool).await?;
            Ok(Some(v))
        }
        LiveSession::Postgres(pool) => {
            let v: String = sqlx::query_scalar("SHOW server_version").fetch_one(pool).await?;
            Ok(Some(v))
        }
        LiveSession::Clickhouse(ch) => {
            let r = clickhouse::execute(ch, "SELECT version()").await?;
            Ok(r.rows.first().and_then(|row| row.first())
                .and_then(|v| v.as_str()).map(String::from))
        }
        LiveSession::Redis(mgr, _) => {
            let mut c = mgr.clone();
            let _: String = ::redis::cmd("PING").query_async(&mut c).await?;
            Ok(None)
        }
        LiveSession::Sqlite(pool) => {
            let v: String = sqlx::query_scalar("SELECT sqlite_version()").fetch_one(pool).await?;
            Ok(Some(format!("SQLite {v}")))
        }
        // Immutable file already read — nothing to probe.
        LiveSession::Parquet(f) => Ok(parquet::ping(f).server_version),
        LiveSession::Duckdb(s) => {
            let v = duckdb::execute(s, "SELECT version()").await?;
            Ok(v.rows.first().and_then(|row| row.first())
                .and_then(|v| v.as_str()).map(|v| format!("DuckDB {v}")))
        }
        LiveSession::MongoDb(client) => Ok(Some(mongodb::server_version(client).await?)),
        LiveSession::SqlServer(s) => {
            let r = sqlserver::execute(s, "SELECT @@VERSION").await?;
            Ok(r.rows.first().and_then(|row| row.first())
                .and_then(|v| v.as_str())
                .map(|v| v.lines().next().unwrap_or(v).to_string()))
        }
    }
}

/// Execute on a dedicated connection whose server-side id is registered in
/// `kills` under `cancel_key`, so `cancel_query` can KILL QUERY /
/// pg_cancel_backend it. Redis has no server-side kill — plain path.
#[allow(clippy::too_many_arguments)]
pub async fn execute_query(
    session_id: Uuid,
    sql: &str,
    sessions: &SessionMap,
    kills: &crate::state::KillMap,
    ch_kills: &crate::state::ChKillMap,
    cancel_key: &str,
    // Editor's chosen database. MySQL/PostgreSQL get it prefixed onto the SQL
    // by the caller; ClickHouse has no `USE`, so it is applied here.
    fetch_warnings: bool,
    default_db: Option<&str>,
    // Row cap for the result set (None = unbounded): past it the driver stops
    // fetching and sets `truncated` — the editor pipeline's OOM guard.
    max_rows: Option<usize>,
) -> Result<QueryResult> {
    let session = get_session(session_id, sessions).await?;
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let mut conn = pool.acquire().await?;
            let backend_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
                .fetch_one(&mut *conn).await?;
            kills.write().await.insert(cancel_key.to_string(), crate::state::KillHandle {
                backend_id,
                fingerprint: statement_fingerprint(sql),
            });
            let mut r = mysql::execute_capped(&mut *conn, sql, max_rows).await;
            // Server warnings: the diagnostics area is per-connection, so the
            // SHOW WARNINGS must run here — before `conn` returns to the pool.
            if fetch_warnings {
                if let Ok(res) = r.as_mut() {
                    res.warnings = mysql::fetch_warnings(&mut *conn).await;
                }
            }
            // Remove the kill handle *before* `conn` returns to the pool, so a
            // recycled backend id can never be KILLed for the wrong query —
            // and the stored fingerprint lets a kill that still races through
            // verify the victim before firing (kill_backend).
            kills.write().await.remove(cancel_key);
            r
        }
        LiveSession::Postgres(pool) => {
            let mut conn = pool.acquire().await?;
            let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&mut *conn).await?;
            kills.write().await.insert(cancel_key.to_string(), crate::state::KillHandle {
                backend_id: backend_pid as u64,
                fingerprint: statement_fingerprint(sql),
            });
            let r = postgres::execute_capped(&mut *conn, sql, max_rows).await;
            kills.write().await.remove(cancel_key);
            r
        }
        LiveSession::Redis(mgr, _) => redis::execute(mgr.clone(), sql).await,
        LiveSession::Clickhouse(s) => {
            // A `query_id` chosen here is the only handle a cancel will have:
            // the HTTP request carries no connection to signal, so without it
            // a runaway query is simply un-stoppable from the UI.
            let query_id = Uuid::new_v4().to_string();
            ch_kills.write().await.insert(cancel_key.to_string(), query_id.clone());
            let owned;
            let s = match default_db {
                Some(db) => { owned = s.with_database(db); &owned }
                None => s,
            };
            let r = clickhouse::execute_capped_with_id(s, sql, &query_id, max_rows).await;
            ch_kills.write().await.remove(cancel_key);
            r
        }
        // SQLite has no server-side kill: there is no backend to signal, and a
        // statement runs to completion inside the process.
        LiveSession::Sqlite(pool) => sqlite::execute_capped(pool, sql, max_rows).await,
        LiveSession::Parquet(f) => {
            // Full-file Arrow decodes are CPU-bound and can pin an async
            // worker for seconds — off the runtime, like commands/export.rs.
            let f = f.clone();
            let sql = sql.to_string();
            tokio::task::spawn_blocking(move || parquet::execute(&f, &sql))
                .await
                .map_err(|e| anyhow::anyhow!("parquet task failed: {e}"))?
        }
        // DuckDB is in-process too, but it has a real interrupt: cancel_query
        // fires it via the session's InterruptHandle (stop_in_flight).
        LiveSession::Duckdb(s) => duckdb::execute_capped(s, sql, max_rows).await,
        // MongoDB is not SQL — the find editor runs through `mongo_find`.
        // An SQL string reaching here went wrong upstream; say so.
        LiveSession::MongoDb(_) =>
            anyhow::bail!("MongoDB does not speak SQL — use the find editor"),
        // `@@SPID` is the kill handle, registered exactly as MySQL registers
        // CONNECTION_ID(). tiberius has no TDS *attention* signal — the
        // protocol-level graceful cancel — so stopping a query means `KILL`,
        // which ends the session's connection; `execute_capped` reconnects on
        // the next statement. Registering it anyway is what makes Cancel do
        // anything at all: without it the button was silently inert.
        //
        // `default_db` is intentionally unused: cross-database access is via
        // three-part names, never USE (shared-connection race, sqlserver.rs).
        LiveSession::SqlServer(s) => {
            // Best-effort: a failed @@SPID must not fail the user's query, it
            // just means this one cannot be cancelled.
            if let Ok(spid) = sqlserver::spid(s).await {
                kills.write().await.insert(cancel_key.to_string(), crate::state::KillHandle {
                    backend_id: spid,
                    fingerprint: statement_fingerprint(sql),
                });
            }
            let r = sqlserver::execute_capped(s, sql, max_rows).await;
            kills.write().await.remove(cancel_key);
            r
        }
    }
}

/// A whitespace-collapsed rendering of a statement, stored in the kill
/// registry next to the backend id. A KILL is issued asynchronously and can
/// land AFTER the query it meant to stop has finished and its pooled
/// connection — same CONNECTION_ID / backend pid — has been handed to another
/// tab, so the kill path compares what the backend is running NOW against
/// this fingerprint and refuses to fire on a mismatch.
pub fn statement_fingerprint(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut pending_space = false;
    for c in sql.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    out
}

/// Does the statement a backend is OBSERVED running (`observed`, from
/// INFORMATION_SCHEMA.PROCESSLIST.INFO / pg_stat_activity.query) match the
/// one this fingerprint was taken from?
///
/// Containment, not equality, because the two sides legitimately differ in
/// length from each other: MySQL reports only the ONE statement of a
/// multi-statement batch currently executing (a substring of what was sent,
/// e.g. past the `USE …;` the editor prepends), and both servers truncate
/// long query text (a prefix of it). The asymmetry worth remembering: a
/// false NEGATIVE merely leaves our own query running — Stop can be pressed
/// again — while a false POSITIVE kills an innocent query on a recycled
/// connection. So an empty observation (idle backend, or nothing to compare)
/// never matches.
pub fn fingerprint_matches(fingerprint: &str, observed: &str) -> bool {
    let obs = statement_fingerprint(observed);
    !obs.is_empty() && !fingerprint.is_empty() && fingerprint.contains(&obs)
}

/// What a kill attempt did — the honest-reporting counterpart of
/// [`backend_alive`] for the fire-and-forget kill path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KillVerdict {
    /// The KILL was sent.
    Issued,
    /// The backend is no longer running the registered statement — the query
    /// finished, or the connection was recycled to another tab — so the kill
    /// was withheld on purpose.
    SkippedStale,
    /// The victim could not be verified (the process-list check failed), so
    /// the kill was withheld rather than risk the wrong query.
    Unverified,
}

/// The statement a MySQL backend is running right now. `Ok(None)` covers both
/// "backend gone" and "idle" (INFO is NULL when idle) — either way there is
/// nothing of ours to kill on it.
async fn mysql_current_statement(pool: &sqlx::MySqlPool, backend_id: u64) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT INFO FROM information_schema.processlist WHERE id = ?")
        .bind(backend_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|(info,)| info))
}

/// The statement a PG backend is running right now — `state = 'active'`
/// matters: pg_stat_activity.query shows the LAST query on an idle backend
/// too, and an idle recycled connection is exactly the case this check
/// exists to refuse.
async fn pg_current_statement(pool: &sqlx::PgPool, backend_id: u64) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT query FROM pg_stat_activity WHERE pid = $1 AND state = 'active'")
        .bind(backend_id as i32)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(q,)| q))
}

/// Best-effort server-side kill of an in-flight query by backend id.
/// How hard to try.
///
/// The distinction is not a preference — it is the difference between asking
/// and ending:
///
/// - **Cancel** (`KILL QUERY`, `pg_cancel_backend`) is a *request*. The server
///   notices at its next interrupt point, and a statement waiting on a lock, a
///   long InnoDB operation or an uninterruptible section can ignore it for a
///   long time. The connection survives, which is why it is the polite default.
/// - **Hard** (`KILL CONNECTION`, `pg_terminate_backend`) ends the backend.
///   The statement stops because the thing running it is gone. The session's
///   connection dies with it — which is the cost, and the reason this is not
///   the default for an ordinary Cancel.
///
/// When someone asks for certainty, they are asking for `Hard`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KillForce {
    /// Abort the statement, keep the connection.
    Cancel,
    /// End the backend. The statement cannot survive it.
    Hard,
}

/// Best-effort server-side kill of an in-flight query by backend id.
///
/// `fingerprint` is the statement the backend was registered as running. The
/// kill is usually issued asynchronously, so by the time it lands the query
/// may have finished and the pooled connection been recycled under the SAME
/// backend id — firing then would kill whatever innocent query acquired it
/// (and with `Hard`, destroy a connection another tab is using). On the
/// pooled engines the victim is therefore verified against the fingerprint
/// immediately before the KILL, and a mismatch — or a failed check —
/// withholds it. SQL Server keeps no such check: its one KILL ends the whole
/// session, and the mitigation there is that the caller sends it inline.
pub async fn kill_backend(
    session_id: Uuid,
    backend_id: u64,
    sessions: &SessionMap,
    force: KillForce,
    fingerprint: Option<&str>,
) -> KillVerdict {
    let Ok(session) = get_session(session_id, sessions).await else {
        return KillVerdict::Unverified;
    };
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            if let Some(fp) = fingerprint {
                match mysql_current_statement(pool, backend_id).await {
                    Ok(Some(obs)) if fingerprint_matches(fp, &obs) => {}
                    Ok(_) => return KillVerdict::SkippedStale,
                    Err(_) => return KillVerdict::Unverified,
                }
            }
            let sql = match force {
                KillForce::Cancel => format!("KILL QUERY {}", backend_id),
                KillForce::Hard   => format!("KILL CONNECTION {}", backend_id),
            };
            let _ = sqlx::query(AssertSqlSafe(sql)).execute(pool).await;
            KillVerdict::Issued
        }
        LiveSession::Postgres(pool) => {
            if let Some(fp) = fingerprint {
                match pg_current_statement(pool, backend_id).await {
                    Ok(Some(obs)) if fingerprint_matches(fp, &obs) => {}
                    Ok(_) => return KillVerdict::SkippedStale,
                    Err(_) => return KillVerdict::Unverified,
                }
            }
            let sql = match force {
                KillForce::Cancel => "SELECT pg_cancel_backend($1)",
                KillForce::Hard   => "SELECT pg_terminate_backend($1)",
            };
            let _ = sqlx::query(sql)
                .bind(backend_id as i32)
                .execute(pool).await;
            KillVerdict::Issued
        }
        // T-SQL has exactly one KILL and it ends the session — there is no
        // kill-the-query-only form, so Cancel and Hard do the same thing here.
        // It goes out on a second connection because this session's client is
        // locked by the very query being killed.
        LiveSession::SqlServer(s) => {
            let _ = sqlserver::kill_spid(s, backend_id).await;
            KillVerdict::Issued
        }
        _ => KillVerdict::SkippedStale,
    }
}

/// Is this backend still on the server?
///
/// The point of asking: a kill command that returns Ok has told you the
/// *request* was accepted, not that anything died. Certainty needs a second
/// look, and this is it. `None` means we could not tell — which is reported as
/// "could not confirm" rather than dressed up as success.
pub async fn backend_alive(
    session_id: Uuid,
    backend_id: u64,
    sessions: &SessionMap,
) -> Option<bool> {
    let session = get_session(session_id, sessions).await.ok()?;
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let row: Option<(i64,)> = sqlx::query_as(
                "SELECT COUNT(*) FROM information_schema.processlist WHERE id = ?")
                .bind(backend_id)
                .fetch_optional(pool).await.ok()?;
            row.map(|(n,)| n > 0)
        }
        LiveSession::Postgres(pool) => {
            let row: Option<(i64,)> = sqlx::query_as(
                "SELECT COUNT(*) FROM pg_stat_activity WHERE pid = $1")
                .bind(backend_id as i32)
                .fetch_optional(pool).await.ok()?;
            row.map(|(n,)| n > 0)
        }
        // Also on a second connection: this is asked while the session's own
        // client is mid-query, which is exactly when it cannot be borrowed.
        LiveSession::SqlServer(s) => sqlserver::session_alive(s, backend_id).await.ok(),
        _ => None,
    }
}

/// `context` = database name (MySQL) | schema name (PG) | None = top level.
pub async fn list_schema(
    session_id: Uuid,
    context: Option<&str>,
    sessions: &SessionMap,
) -> Result<Vec<SchemaNode>> {
    let session = get_session(session_id, sessions).await?;
    match session.as_ref() {
        LiveSession::Mysql(pool)    => mysql::list_schema(pool, context).await,
        LiveSession::Postgres(pool) => postgres::list_schema(pool, context).await,
        // Redis: no context = the databases; a db label = its key namespaces.
        LiveSession::Redis(mgr, client) => match context {
            Some(db) => redis::list_prefixes(client, db).await,
            None     => redis::list_schema(mgr.clone()).await,
        },
        LiveSession::Clickhouse(s) => clickhouse::list_schema(s, context).await,
        LiveSession::Sqlite(pool) => sqlite::list_schema(pool, context).await,
        LiveSession::Parquet(f) => Ok(parquet::list_schema(f, context)),
        LiveSession::Duckdb(s) => duckdb::list_schema(s, context).await,
        // None = the databases; a db name = its collections and views.
        LiveSession::MongoDb(client) => mongodb::list_schema(client, context).await,
        // None = every database on the instance; a db name = its tables and
        // views with the schema folded into the name (three-level engine,
        // two-level tree — sqlserver.rs module docs).
        LiveSession::SqlServer(s) => sqlserver::list_schema(s, context).await,
    }
}

/// `parent` = "database.table" (MySQL) | "schema.table" (PG).
pub async fn list_columns(
    session_id: Uuid,
    parent: &str,
    sessions: &SessionMap,
) -> Result<Vec<SchemaNode>> {
    let session = get_session(session_id, sessions).await?;
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let (ns, table) = split_parent(parent)?;
            mysql::list_columns(pool, ns, table).await
        }
        LiveSession::Postgres(pool) => {
            let (ns, table) = split_parent(parent)?;
            postgres::list_columns(pool, ns, table).await
        }
        LiveSession::Redis(..) => Ok(vec![]),
        LiveSession::Clickhouse(s) => {
            let (db, table) = split_parent(parent)?;
            clickhouse::list_columns(s, db, table).await
        }
        LiveSession::Sqlite(pool) => {
            let (ns, table) = split_parent(parent)?;
            sqlite::list_columns(pool, ns, table).await
        }
        // One file, one column list — the parent is always the file itself.
        LiveSession::Parquet(f) => Ok(parquet::list_columns(f)),
        // `table` carries the schema: the tree names DuckDB objects
        // "schema.table" because the engine is three-level (db.schema.table).
        LiveSession::Duckdb(s) => {
            let (db, table) = split_parent(parent)?;
            duckdb::list_columns(s, db, table).await
        }
        // Sampled keys of the collection — a collection is schemaless, so this
        // is descriptive, never authoritative.
        LiveSession::MongoDb(client) => {
            let (db, coll) = split_parent(parent)?;
            mongodb::list_columns(client, db, coll).await
        }
        // parent = "db.schema.table": the first segment is the database, the
        // rest is the tree's schema-folded object name the driver expects.
        LiveSession::SqlServer(s) => {
            let (db, table) = split_parent(parent)?;
            sqlserver::list_columns(s, db, table).await
        }
    }
}

/// `parent` = "database.object" (MySQL) | "schema.object" (PG).
pub async fn get_ddl(
    session_id: Uuid,
    parent: &str,
    sessions: &SessionMap,
) -> Result<String> {
    let session = get_session(session_id, sessions).await?;
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let (ns, object) = split_parent(parent)?;
            mysql::get_ddl(pool, ns, object).await
        }
        LiveSession::Clickhouse(ch) => {
            let (ns, object) = split_parent(parent)?;
            clickhouse::get_ddl(ch, ns, object).await
        }
        LiveSession::Postgres(pool) => {
            let (ns, object) = split_parent(parent)?;
            postgres::get_ddl(pool, ns, object).await
        }
        LiveSession::Redis(..) => anyhow::bail!("DDL not available for Redis"),
        LiveSession::Sqlite(pool) => {
            let (ns, object) = split_parent(parent)?;
            sqlite::get_ddl(pool, ns, object).await
        }
        // Parquet's own schema language — the footer's actual content, not an
        // invented CREATE TABLE.
        LiveSession::Parquet(f) => Ok(parquet::get_ddl(f)),
        LiveSession::Duckdb(s) => {
            let (db, object) = split_parent(parent)?;
            duckdb::get_ddl(s, db, object).await
        }
        // Mongo has no DDL — the collection's createCollection options are the
        // closest honest answer.
        LiveSession::MongoDb(client) => {
            let (db, coll) = split_parent(parent)?;
            mongodb::get_ddl(client, db, coll).await
        }
        // sys.sql_modules for modules, synthesized CREATE TABLE for tables —
        // parent = "db.schema.object", same split as list_columns.
        LiveSession::SqlServer(s) => {
            let (db, object) = split_parent(parent)?;
            sqlserver::get_ddl(s, db, object).await
        }
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Public version for use by browser commands.
pub async fn get_session_pub(session_id: Uuid, sessions: &SessionMap) -> Result<Arc<LiveSession>> {
    get_session(session_id, sessions).await
}

async fn get_session(session_id: Uuid, sessions: &SessionMap) -> Result<Arc<LiveSession>> {
    sessions.read().await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("session not found: {}", session_id))
}

fn split_parent(parent: &str) -> Result<(&str, &str)> {
    let mut parts = parent.splitn(2, '.');
    let ns    = parts.next().ok_or_else(|| anyhow::anyhow!("invalid parent: {}", parent))?;
    let table = parts.next().ok_or_else(|| anyhow::anyhow!("invalid parent: {}", parent))?;
    Ok((ns, table))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whitespace runs collapse and the ends are trimmed — the server echoes
    /// the statement with its own whitespace, not ours.
    #[test]
    fn fingerprint_collapses_whitespace() {
        assert_eq!(statement_fingerprint("SELECT  *\n\tFROM  t "), "SELECT * FROM t");
        assert_eq!(statement_fingerprint("  \n"), "");
        assert_eq!(statement_fingerprint(""), "");
    }

    /// The kill-victim decision, without a server. The asymmetry being pinned:
    /// a false negative leaves our own query running (Stop again); a false
    /// positive kills an innocent query on a recycled connection.
    #[test]
    fn fingerprint_match_decides_the_kill() {
        let fp = statement_fingerprint("SELECT * FROM t WHERE SLEEP(30) = 0");
        // The backend is running exactly what was registered.
        assert!(fingerprint_matches(&fp, "SELECT * FROM t WHERE SLEEP(30) = 0"));
        // The comparison is deliberately case-sensitive: the server echoes
        // the text as sent, and folding case would only widen the false-
        // positive side — the one that kills an innocent query.
        assert!(!fingerprint_matches(&fp, "select * from t where sleep(30) = 0"));
        // Server-side truncation of a long query text: the observed text is a
        // PREFIX of the registered one, and that still matches.
        assert!(fingerprint_matches(&fp, "SELECT * FROM t WHERE SLEEP"));
    }

    /// MySQL's PROCESSLIST.INFO shows the ONE statement of a multi-statement
    /// batch currently executing — e.g. past the `USE …;` the editor prepends
    /// — so containment, not prefix, is the match.
    #[test]
    fn mysql_batch_member_statement_matches() {
        let fp = statement_fingerprint("USE `shop`;\nSELECT SLEEP(30)");
        assert!(fingerprint_matches(&fp, "SELECT SLEEP(30)"));
        assert!(fingerprint_matches(&fp, "USE `shop`;"));
    }

    /// The bug this exists for: the query finished, the pooled connection was
    /// recycled, and the backend is now idle or running someone else's
    /// statement. The kill must be withheld in every one of these.
    #[test]
    fn a_recycled_or_idle_backend_never_matches() {
        let fp = statement_fingerprint("SELECT * FROM huge_table");
        assert!(!fingerprint_matches(&fp, ""), "idle backend: INFO is NULL/empty");
        assert!(!fingerprint_matches(&fp, "   \n "));
        assert!(!fingerprint_matches(&fp, "SELECT * FROM other_table"));
        assert!(!fingerprint_matches(&fp, "UPDATE accounts SET balance = 0"));
        // And an empty fingerprint must never match anything.
        assert!(!fingerprint_matches("", "SELECT 1"));
    }

    /// IAM off: the stored password passes through untouched.
    #[tokio::test]
    async fn iam_off_keeps_stored_password() {
        let cfg = ConnectionConfig::new(Engine::Mysql, "plain");
        let out = iam_password(&cfg, Some("secret".into())).await.unwrap();
        assert_eq!(out.as_deref(), Some("secret"));
        let out = iam_password(&cfg, None).await.unwrap();
        assert!(out.is_none());
    }

    /// IAM on but the engine cannot authenticate that way: the flag is
    /// ignored rather than minting a token the server would not understand.
    #[tokio::test]
    async fn iam_ignored_on_non_sql_engines() {
        let mut cfg = ConnectionConfig::new(Engine::Redis, "redis");
        cfg.use_iam_auth = true;
        let out = iam_password(&cfg, Some("secret".into())).await.unwrap();
        assert_eq!(out.as_deref(), Some("secret"));
    }

    /// IAM on with no key file and no ADC anywhere: a clear error naming both
    /// options, before any network happens. (ADC is passed in explicitly so
    /// the test never reads this machine's real gcloud state.)
    #[tokio::test]
    async fn iam_without_any_credentials_is_a_clear_error() {
        let mut cfg = ConnectionConfig::new(Engine::Mysql, "iam");
        cfg.use_iam_auth = true;
        let err = resolve_iam_key(&cfg, None).unwrap_err().to_string();
        assert!(err.contains("service-account key path"), "got: {err}");
        assert!(err.contains("application-default"), "got: {err}");

        // An empty path is the same as none (the form saves "" as null, but
        // older configs may carry the empty string) — the ADC fills the gap.
        cfg.iam_key_path = Some(String::new());
        let key = resolve_iam_key(&cfg, Some(std::path::PathBuf::from("/adc/here.json"))).unwrap();
        assert_eq!(key, "/adc/here.json");

        // An explicit key path always wins over the ADC.
        cfg.iam_key_path = Some("/keys/sa.json".into());
        let key = resolve_iam_key(&cfg, Some(std::path::PathBuf::from("/adc/here.json"))).unwrap();
        assert_eq!(key, "/keys/sa.json");
    }

    /// IAM on with a key path that does not exist: the error names the path,
    /// and crucially fails BEFORE any token endpoint is contacted.
    #[tokio::test]
    async fn iam_with_missing_key_file_names_the_path() {
        let mut cfg = ConnectionConfig::new(Engine::Postgres, "iam-pg");
        cfg.use_iam_auth = true;
        cfg.iam_key_path = Some("/nonexistent/no-such-key.json".into());
        let err = iam_password(&cfg, None).await.unwrap_err().to_string();
        assert!(err.contains("/nonexistent/no-such-key.json"), "got: {err}");
    }

    /// The same mint must back the ping/test path: an IAM ping whose
    /// credential file does not exist surfaces THAT as the failure — not a
    /// database "Access denied" about a password that is never used.
    #[tokio::test]
    async fn ping_reports_iam_setup_errors() {
        let mut cfg = ConnectionConfig::new(Engine::Mysql, "iam");
        cfg.use_iam_auth = true;
        cfg.iam_key_path = Some("/nonexistent/no-such-key.json".into());
        let res = ping(&cfg, None).await;
        assert!(!res.ok);
        let err = res.error.unwrap();
        assert!(err.contains("/nonexistent/no-such-key.json"), "got: {err}");
    }
}
