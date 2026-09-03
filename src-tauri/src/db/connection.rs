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
        Engine::Parquet  => LiveSession::Parquet(Arc::new(parquet::open(config)?)),
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
            _ => {}
        }
    }
    ids
}

/// Gracefully close every live session (pool .close()) and drop all SSH
/// tunnels — used on app exit so the server sees clean disconnects.
/// Each session gets 5 s: a pool with connections still checked out (a query
/// mid-flight at exit) must not hold shutdown hostage for the rest.
pub async fn close_all(state: &crate::state::AppState) {
    let sessions: Vec<(Uuid, Arc<LiveSession>)> = {
        let mut map = state.sessions.write().await;
        map.drain().collect()
    };
    for (session_id, s) in sessions {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            match s.as_ref() {
                LiveSession::Mysql(pool)    => pool.close().await,
                LiveSession::Postgres(pool) => pool.close().await,
                // Only the sqlx pools need an awaited close. Every other engine
                // holds either a single socket (SQL Server, ClickHouse), a file
                // handle (SQLite, DuckDB, Parquet) or a manager (Redis, MongoDB),
                // all of which close on Drop when this vector goes out of scope —
                // so the wildcard here is deliberate, not an unhandled case.
                _ => {}
            }
        }).await;
        // The window may already be gone at exit — the 'disconnect' audit row
        // is written from here precisely because the frontend cannot be asked.
        if let Some(start) = state.session_starts.write().await.remove(&session_id) {
            crate::commands::audit::insert_lifecycle(
                &state.history, session_id, &start, "disconnect").await;
        }
    }
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
        Engine::Parquet => match parquet::open(config) {
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
            kills.write().await.insert(cancel_key.to_string(), backend_id);
            let mut r = mysql::execute_capped(&mut *conn, sql, max_rows).await;
            // Server warnings: the diagnostics area is per-connection, so the
            // SHOW WARNINGS must run here — before `conn` returns to the pool.
            if fetch_warnings {
                if let Ok(res) = r.as_mut() {
                    res.warnings = mysql::fetch_warnings(&mut *conn).await;
                }
            }
            // Remove the kill handle *before* `conn` returns to the pool, so a
            // recycled backend id can never be KILLed for the wrong query.
            kills.write().await.remove(cancel_key);
            r
        }
        LiveSession::Postgres(pool) => {
            let mut conn = pool.acquire().await?;
            let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&mut *conn).await?;
            kills.write().await.insert(cancel_key.to_string(), backend_pid as u64);
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
                kills.write().await.insert(cancel_key.to_string(), spid);
            }
            let r = sqlserver::execute_capped(s, sql, max_rows).await;
            kills.write().await.remove(cancel_key);
            r
        }
    }
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

pub async fn kill_backend(
    session_id: Uuid,
    backend_id: u64,
    sessions: &SessionMap,
    force: KillForce,
) {
    let Ok(session) = get_session(session_id, sessions).await else { return };
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let sql = match force {
                KillForce::Cancel => format!("KILL QUERY {}", backend_id),
                KillForce::Hard   => format!("KILL CONNECTION {}", backend_id),
            };
            let _ = sqlx::query(AssertSqlSafe(sql)).execute(pool).await;
        }
        LiveSession::Postgres(pool) => {
            let sql = match force {
                KillForce::Cancel => "SELECT pg_cancel_backend($1)",
                KillForce::Hard   => "SELECT pg_terminate_backend($1)",
            };
            let _ = sqlx::query(sql)
                .bind(backend_id as i32)
                .execute(pool).await;
        }
        // T-SQL has exactly one KILL and it ends the session — there is no
        // kill-the-query-only form, so Cancel and Hard do the same thing here.
        // It goes out on a second connection because this session's client is
        // locked by the very query being killed.
        LiveSession::SqlServer(s) => {
            let _ = sqlserver::kill_spid(s, backend_id).await;
        }
        _ => {}
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
