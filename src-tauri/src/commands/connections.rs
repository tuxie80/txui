use tauri::State;
use uuid::Uuid;

use crate::db::connection;
use crate::db::types::{ConnectionConfig, Engine, PingResult};
use crate::state::AppState;

/// Fill in the app-wide connect timeout when a connection does not set one.
///
/// Resolved here rather than in each driver because this is where the app
/// settings are reachable — the drivers only ever see a ConnectionConfig.
fn with_default_timeout(config: &ConnectionConfig, state: &AppState) -> ConnectionConfig {
    if config.connect_timeout_secs.is_some() {
        return config.clone();
    }
    let secs = state.connect_timeout_secs.load(std::sync::atomic::Ordering::Relaxed);
    let mut c = config.clone();
    c.connect_timeout_secs = Some(secs.max(1));
    c
}

/// Set the app-wide connect timeout (Settings → Connections).
#[tauri::command]
pub async fn set_connect_timeout(secs: u32, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    // Clamped: 0 would mean "give up before trying", and an hour is not a
    // timeout. Both ends are far outside anything useful.
    let clamped = secs.clamp(1, 300);
    state.connect_timeout_secs.store(clamped, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Set the app-wide client-side query deadline (Settings → Connections).
#[tauri::command]
pub async fn set_query_timeout(secs: u32, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    // 0 is meaningful here, unlike the connect timeout: it is how the user
    // says "no deadline", and it is the default. The upper end is a day —
    // beyond that the ceiling is not doing anything a human would notice.
    let clamped = secs.min(86_400);
    state.query_timeout_secs.store(clamped, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Read a connection password from the encrypted secret store.
fn get_password(config: &ConnectionConfig, data_dir: &std::path::Path) -> Option<String> {
    crate::secretstore::get(data_dir, &config.keychain_key())
}

/// Diagnostic for the connect-failure log — reports store state without
/// leaking plaintext in release builds.
fn password_diag(config: &ConnectionConfig, data_dir: &std::path::Path) -> String {
    let key = config.keychain_key();
    match crate::secretstore::get(data_dir, &key) {
        None => format!("[no stored password for '{}' → EMPTY sent. Edit the connection, type the password, Save.]", key),
        Some(pw) => {
            let ws = if pw.trim().len() != pw.len() { " ⚠ leading/trailing whitespace" } else { "" };
            #[cfg(debug_assertions)]
            { let hex: String = pw.bytes().map(|b| format!("{b:02x}")).collect();
              format!("[stored password: {} bytes, hex {}{} — server rejected it]", pw.len(), hex, ws)}
            #[cfg(not(debug_assertions))]
            format!("[stored password is {} bytes{} — server rejected it: wrong for this account]", pw.len(), ws)
        }
    }
}

/// Verbose target descriptor for diagnostics — exactly what we tried to reach.
fn describe(config: &ConnectionConfig) -> String {
    let host = config.host.as_deref().unwrap_or("localhost");
    let port = config.port.unwrap_or(config.engine.default_port());
    let user = config.user.as_deref().unwrap_or("");
    let mut s = format!("{:?} {}@{}:{}", config.engine, user, host, port);
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        s.push_str(&format!(" db='{}'", db));
    }
    s.push_str(&format!(" ssl={:?}", config.ssl_mode));
    if config.use_ssh {
        s.push_str(&format!(" · via SSH {}@{}:{}",
            config.ssh_user.as_deref().unwrap_or(""),
            config.ssh_host.as_deref().unwrap_or(""),
            config.ssh_port.unwrap_or(22)));
    }
    s
}

/// Save or update a connection config. Passwords go to the encrypted secret
/// store (secrets.enc), never to connections.json.
/// `password` / `ssh_password`: None = leave unchanged, Some("") = clear,
/// Some(v) = set/replace.
#[tauri::command]
pub async fn save_connection(
    mut config: ConnectionConfig,
    password: Option<String>,
    ssh_password: Option<String>,
    state: State<'_, AppState>,
) -> Result<Uuid, crate::apperror::AppError> {
    // Ensure ID is set
    if config.id.is_nil() {
        config.id = Uuid::new_v4();
    }

    // Persist passwords to the encrypted secret store (secrets.enc).
    if let Some(pw) = password {
        if pw.is_empty() {
            crate::secretstore::delete(&state.data_dir, &config.keychain_key());
        } else {
            crate::secretstore::set(&state.data_dir, &config.keychain_key(), &pw)
                .map_err(|e| format!("could not store password: {e}"))?;
        }
    }
    if let Some(pw) = ssh_password {
        if pw.is_empty() {
            crate::secretstore::delete(&state.data_dir, &config.ssh_keychain_key());
        } else {
            crate::secretstore::set(&state.data_dir, &config.ssh_keychain_key(), &pw)
                .map_err(|e| format!("could not store SSH password: {e}"))?;
        }
    }

    let id = config.id;
    state.configs.write().await.insert(id, config);
    persist_configs(&state).await?;
    Ok(id)
}

/// Flush the in-memory config map to connections.json.
async fn persist_configs(state: &State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    let configs = state.configs.read().await;
    crate::storage::save(&state.data_dir, &configs)
        .await
        .map_err(|e| format!("could not persist connections: {e}"))
        .map_err(crate::apperror::AppError::from)
}

/// List all saved connection configs (no passwords)
#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> Result<Vec<ConnectionConfig>, crate::apperror::AppError> {
    Ok(state.configs.read().await.values().cloned().collect())
}

/// Duplicate a connection: new id, "name (copy)", keychain password copied too.
#[tauri::command]
pub async fn duplicate_connection(id: Uuid, state: State<'_, AppState>) -> Result<ConnectionConfig, crate::apperror::AppError> {
    let mut config = state.configs.read().await.get(&id).cloned()
        .ok_or_else(|| format!("connection {} not found", id))?;
    let old_key = config.keychain_key();
    config.id = Uuid::new_v4();
    config.name = format!("{} (copy)", config.name);
    if let Some(pw) = crate::secretstore::get(&state.data_dir, &old_key) {
        let _ = crate::secretstore::set(&state.data_dir, &config.keychain_key(), &pw);
    }
    state.configs.write().await.insert(config.id, config.clone());
    persist_configs(&state).await?;
    Ok(config)
}

/// Delete a connection config, its secret-store entries, and its data directory
#[tauri::command]
pub async fn delete_connection(id: Uuid, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    if let Some(config) = state.configs.write().await.remove(&id) {
        crate::secretstore::delete(&state.data_dir, &config.keychain_key());
        crate::secretstore::delete(&state.data_dir, &config.ssh_keychain_key());
    }
    // Saved diagrams and anything else the connection accumulated. Ids are
    // freshly generated on import, so a stale directory would never be reused
    // — but it would sit there forever, and it is the user's data in a place
    // they cannot see. Best-effort: a failure here must not block the delete.
    crate::instancedata::remove_instance(&state.data_dir, &id);
    persist_configs(&state).await?;
    Ok(())
}

/// Test connectivity — does NOT open a persistent session
#[tauri::command]
pub async fn test_connection(id: Uuid, state: State<'_, AppState>) -> Result<PingResult, crate::apperror::AppError> {
    let config = state.configs.read().await.get(&id).cloned()
        .ok_or_else(|| format!("connection {} not found", id))?;
    let password = get_password(&config, &state.data_dir);
    let config = with_default_timeout(&config, &state);
    let mut ping = connection::ping(&config, password).await;
    // Prefix the failure with the full target so the error is self-explanatory.
    if !ping.ok {
        let target = describe(&config);
        ping.error = Some(match ping.error.take() {
            Some(e) => format!("Connect to {} failed:\n{}", target, e),
            None => format!("Connect to {} failed (no detail)", target),
        });
    }
    Ok(ping)
}

/// Open a live session, optionally through an SSH tunnel. Returns the session UUID.
#[tauri::command]
pub async fn open_connection(id: Uuid, state: State<'_, AppState>) -> Result<Uuid, crate::apperror::AppError> {
    let config = state.configs.read().await.get(&id).cloned()
        .ok_or_else(|| format!("connection {} not found", id))?;
    open_session_for_config(&config, &state).await
}

/// Shared connect path (keychain password + optional SSH tunnel) used by both
/// `open_connection` and the multi-server executor's ephemeral sessions.
pub(crate) async fn open_session_for_config(
    config: &crate::db::types::ConnectionConfig,
    state: &AppState,
) -> Result<Uuid, crate::apperror::AppError> {
    let password = get_password(config, &state.data_dir);
    // Apply the app-wide connect timeout to anything that has not set its own.
    let owned = with_default_timeout(config, state);
    let config = &owned;

    // Start the attempt clock up front: a FAILED connect is audited too
    // (insert_connect_failed below), and its duration_ms is how long the
    // attempt took. The successful path builds its own SessionStart after the
    // session exists, so a session's lifetime is not charged for connect time.
    let attempt = crate::commands::audit::session_start(config);

    // Open SSH tunnel if configured
    let tunnel = if config.use_ssh {
        let ssh_host = config.ssh_host.as_deref()
            .ok_or("SSH host is required when tunnel is enabled")?;
        let ssh_user = config.ssh_user.as_deref()
            .ok_or("SSH user is required when tunnel is enabled")?;
        let ssh_port = config.ssh_port.unwrap_or(22);
        let db_host  = config.host.as_deref().unwrap_or("localhost");
        let db_port  = config.port.unwrap_or(config.engine.default_port());
        let ssh_password = if config.use_ssh_password {
            crate::secretstore::get(&state.data_dir, &config.ssh_keychain_key())
        } else {
            None
        };

        let t = match crate::db::ssh::SshTunnel::open(
            ssh_host, ssh_port, ssh_user,
            config.ssh_key_path.as_deref(),
            db_host, db_port,
            config.ssh_jump.as_deref(),
            ssh_password.as_deref(),
        ).await {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("SSH tunnel to {}@{}:{} failed:\n{:#}", ssh_user, ssh_host, ssh_port, e);
                crate::commands::audit::insert_connect_failed(&state.history, &attempt, &msg).await;
                return Err(msg.into());
            }
        };

        Some(t)
    } else {
        None
    };

    // If tunnel is active, connect to localhost:local_port
    let host_override: Option<(&str, u16)> = tunnel.as_ref()
        .map(|t| ("127.0.0.1", t.local_port));

    let session_id = match connection::open_session(config, password, &state.sessions, host_override).await {
        Ok(id) => id,
        Err(e) => {
            let msg = format!("Connect to {} failed:\n{:#}\n{}", describe(config), e, password_diag(config, &state.data_dir));
            crate::commands::audit::insert_connect_failed(&state.history, &attempt, &msg).await;
            return Err(msg.into());
        }
    };

    // Store tunnel (Drop impl will kill ssh when removed)
    if let Some(t) = tunnel {
        state.tunnels.write().await.insert(session_id, t);
    }

    // Capture the write guard + prod hard limits from the config so the
    // backend can enforce them regardless of the frontend.
    state.session_meta.write().await
        .insert(session_id, crate::state::SessionGuard::from_config(config));

    // Lifecycle audit: the 'connect' row, plus the start record the matching
    // 'disconnect' (close_connection / close_all) reads its duration from.
    let start = crate::commands::audit::session_start(config);
    state.session_starts.write().await.insert(session_id, start.clone());
    crate::commands::audit::insert_lifecycle(&state.history, session_id, &start, "connect").await;

    // Redis: capture the server's own write catalog once per session
    // (`ACL CAT write` tracks the exact version and loaded modules), so the
    // guard classifies commands nobody would hardcode. Best-effort — a server
    // without ACL (pre-6) or a user without the privilege keeps the baseline.
    if config.engine == Engine::Redis {
        if let Ok(session) = connection::get_session_pub(session_id, &state.sessions).await {
            if let crate::db::types::LiveSession::Redis(mgr, _) = session.as_ref() {
                let mut mgr = mgr.clone();
                let writes: Vec<String> = redis::cmd("ACL").arg("CAT").arg("write")
                    .query_async(&mut mgr).await.unwrap_or_default();
                if !writes.is_empty() {
                    let cat = crate::redisguard::CommandCatalog::baseline().with_server_writes(writes);
                    state.redis_catalogs.write().await.insert(session_id, std::sync::Arc::new(cat));
                }
            }
        }
    }

    Ok(session_id)
}

/// The config a scratch session is built from: in-memory DuckDB, writable,
/// environment-less, no SSH, no password, never saved. Defined once here so
/// the command and its tests share the shape — a scratch session must behave
/// exactly like a `duckdb` connection with `file_path: ":memory:"`, minus the
/// persistence.
pub(crate) fn scratch_config() -> ConnectionConfig {
    let mut c = ConnectionConfig::new(Engine::Duckdb, "Scratch");
    c.file_path = Some(":memory:".into());
    c
}

/// Open an ephemeral in-memory DuckDB session without a saved connection —
/// the scratch buffer. It is a fully ordinary session in every registry that
/// matters (`sessions`, `session_meta`), so cancel/close/guards treat it like
/// any other; what it skips is the vault, connections.json and the SSH/tunnel
/// machinery, none of which an in-process engine can use. NOT read-only: the
/// scratch is a sandbox, and its read_only=false is what lets CREATE TABLE
/// past `guard_statement`.
#[tauri::command]
pub async fn open_scratch_session(state: State<'_, AppState>) -> Result<Uuid, crate::apperror::AppError> {
    let config = scratch_config();
    // No password, no tunnel, no timeout plumbing — DuckDB is in-process, so
    // there is nothing to dial and nothing to time out on.
    let session_id = connection::open_session(&config, None, &state.sessions, None)
        .await
        .map_err(|e| format!("could not open the scratch database: {e:#}"))?;
    state.session_meta.write().await
        .insert(session_id, crate::state::SessionGuard::from_config(&config));
    let start = crate::commands::audit::session_start(&config);
    state.session_starts.write().await.insert(session_id, start.clone());
    crate::commands::audit::insert_lifecycle(&state.history, session_id, &start, "connect").await;
    Ok(session_id)
}

/// Close a live session and release its SSH tunnel if any.
///
/// Never hangs: everything the session has running (watches, data generation,
/// listeners, in-flight queries) is cancelled FIRST, because each holds pooled
/// connections that `pool.close()` would otherwise wait on forever; the
/// graceful close itself is then bounded by a 5 s timeout.
#[tauri::command]
pub async fn close_connection(session_id: Uuid, state: State<'_, AppState>) -> Result<Vec<u64>, crate::apperror::AppError> {
    state.cancel_session_work(session_id).await;
    // An open manual transaction dies with the session — dropping the held
    // connection makes the server roll it back.
    state.tx_conns.write().await.remove(&session_id);
    let thread_ids = match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        connection::close_session(session_id, &state.sessions),
    ).await {
        Ok(ids) => ids,
        Err(_) => {
            // close_session removes the session from the map before awaiting
            // anything, so the entry is gone; dropping the timed-out future
            // drops the pool handle with it (abrupt teardown). The remove here
            // is the belt to that brace.
            state.sessions.write().await.remove(&session_id);
            Vec::new()
        }
    };
    state.tunnels.write().await.remove(&session_id); // Drop kills ssh process
    state.session_meta.write().await.remove(&session_id);
    state.redis_catalogs.write().await.remove(&session_id);
    crate::commands::kill::forget_session(session_id);   // drop its cached probe result
    // Lifecycle audit: the session is gone either way (a timed-out close is
    // still a disconnect), so the row is written after teardown, not gated on
    // it. Sessions with no start record (opened before this existed) get none.
    if let Some(start) = state.session_starts.write().await.remove(&session_id) {
        crate::commands::audit::insert_lifecycle(&state.history, session_id, &start, "disconnect").await;
    }
    Ok(thread_ids)
}

/// Test an unsaved (ad-hoc) connection: opens a real connection — including
/// the SSH tunnel when configured, using the passed `ssh_password` instead of
/// the secret store — pings it, and tears everything down. Nothing is left in
/// AppState and NOTHING is persisted to the secret store or connections.json.
/// Returns a short success summary (server version when cheap to get).
#[tauri::command]
pub async fn test_connection_adhoc(
    config: ConnectionConfig,
    password: Option<String>,
    ssh_password: Option<String>,
) -> Result<String, crate::apperror::AppError> {
    // Ephemeral session registry — never touches AppState.
    let sessions: connection::SessionMap = Default::default();

    // Open SSH tunnel if configured (ad-hoc SSH password, never the store)
    let tunnel = if config.use_ssh {
        let ssh_host = config.ssh_host.as_deref()
            .ok_or("SSH host is required when tunnel is enabled")?;
        let ssh_user = config.ssh_user.as_deref()
            .ok_or("SSH user is required when tunnel is enabled")?;
        let ssh_port = config.ssh_port.unwrap_or(22);
        let db_host  = config.host.as_deref().unwrap_or("localhost");
        let db_port  = config.port.unwrap_or(config.engine.default_port());

        let t = crate::db::ssh::SshTunnel::open(
            ssh_host, ssh_port, ssh_user,
            config.ssh_key_path.as_deref(),
            db_host, db_port,
            config.ssh_jump.as_deref(),
            ssh_password.as_deref(),
        ).await.map_err(|e| format!("SSH tunnel to {}@{}:{} failed:\n{:#}", ssh_user, ssh_host, ssh_port, e))?;

        Some(t)
    } else {
        None
    };

    let host_override: Option<(&str, u16)> = tunnel.as_ref()
        .map(|t| ("127.0.0.1", t.local_port));

    let start = std::time::Instant::now();
    let result: Result<Option<String>, crate::apperror::AppError> = async {
        let session_id = connection::open_session(&config, password, &sessions, host_override)
            .await
            .map_err(|e| format!("Connect to {} failed:\n{}", describe(&config), friendly_error(&config.engine, &e)))?;
        let session = connection::get_session_pub(session_id, &sessions)
            .await
            ?;
        let version = connection::probe_session(&session)
            .await
            .map_err(|e| format!("Connected, but the probe query failed: {e:#}"))?;
        connection::close_session(session_id, &sessions).await;
        Ok(version)
    }.await;

    drop(tunnel); // Drop kills the ssh child

    let version = result?;
    let ms = start.elapsed().as_millis();
    Ok(match version {
        Some(v) => format!("Connected to {} ({} ms)", v, ms),
        None    => format!("OK ({} ms)", ms),
    })
}

/// Friendly connect-error text: reuse the per-engine formatters when the
/// failure is a sqlx error, else the anyhow chain.
fn friendly_error(engine: &Engine, e: &anyhow::Error) -> String {
    if let Some(se) = e.downcast_ref::<sqlx::Error>() {
        return match engine {
            Engine::Mysql    => crate::db::mysql::fmt_conn_error(se),
            Engine::Postgres => crate::db::postgres::fmt_conn_error(se),
            // Neither speaks the sqlx wire protocol, so a sqlx::Error here
            // can only be incidental — pass the message through.
            Engine::Redis | Engine::Clickhouse => format!("{e:#}"),
            // sqlx IS SQLite's driver, so its errors are the real thing here;
            // Parquet, DuckDB and MongoDB never produce one.
            Engine::Sqlite | Engine::Parquet | Engine::Duckdb | Engine::MongoDb => format!("{e:#}"),
            // tiberius, not sqlx — a sqlx::Error cannot come from this arm.
            Engine::SqlServer => format!("{e:#}"),
        };
    }
    format!("{e:#}")
}

/// Time a SELECT 1-style round trip on an OPEN session (latency indicator).
/// Returns elapsed milliseconds.
#[tauri::command]
pub async fn session_ping(session_id: String, state: State<'_, AppState>) -> Result<u64, crate::apperror::AppError> {
    let id = Uuid::parse_str(&session_id)
        .map_err(|_| format!("invalid session id: {session_id}"))?;
    let session = connection::get_session_pub(id, &state.sessions)
        .await
        ?;
    let start = std::time::Instant::now();
    connection::probe_session(&session)
        .await
        .map_err(|e| format!("ping failed: {e:#}"))?;
    Ok(start.elapsed().as_millis() as u64)
}

// ── Import / export ─────────────────────────────────────────────────────────

/// Envelope format for connection export files. Secrets are never part of it
/// (passwords live in the secret store, not in ConnectionConfig).
#[derive(serde::Serialize, serde::Deserialize)]
struct ConnectionsEnvelope {
    format:      String,
    version:     u32,
    connections: Vec<ConnectionConfig>,
}

const EXPORT_FORMAT: &str = "txui-connections";
const EXPORT_VERSION: u32 = 1;

/// Serialize saved connections (all, or the given ids) to a JSON envelope.
#[tauri::command]
pub async fn export_connections(
    ids: Option<Vec<Uuid>>,
    state: State<'_, AppState>,
) -> Result<String, crate::apperror::AppError> {
    let configs = state.configs.read().await;
    let mut list: Vec<ConnectionConfig> = match &ids {
        Some(ids) => ids.iter().filter_map(|id| configs.get(id).cloned()).collect(),
        None      => configs.values().cloned().collect(),
    };
    list.sort_by(|a, b| a.name.cmp(&b.name));
    let envelope = ConnectionsEnvelope {
        format:  EXPORT_FORMAT.to_string(),
        version: EXPORT_VERSION,
        connections: list,
    };
    serde_json::to_string_pretty(&envelope)
        .map_err(|e| format!("could not serialize connections: {e}"))
        .map_err(crate::apperror::AppError::from)
}

/// Import connections from a JSON envelope produced by `export_connections`.
/// Every imported connection gets a FRESH id — an import never aliases an
/// existing connection id (which would also alias its secret-store entry).
/// Returns the number of connections imported.
#[tauri::command]
pub async fn import_connections(json: String, state: State<'_, AppState>) -> Result<u32, crate::apperror::AppError> {
    let envelope: ConnectionsEnvelope = serde_json::from_str(&json)
        .map_err(|e| format!("not a valid {EXPORT_FORMAT} file: {e}"))?;
    if envelope.format != EXPORT_FORMAT {
        return Err(format!("not a {EXPORT_FORMAT} file (format = {:?})", envelope.format).into());
    }
    if envelope.version != EXPORT_VERSION {
        return Err(format!("unsupported format version {} (expected {EXPORT_VERSION})", envelope.version).into());
    }

    let mut configs = state.configs.write().await;
    let mut imported = 0u32;
    for mut config in envelope.connections {
        config.id = Uuid::new_v4();
        configs.insert(config.id, config);
        imported += 1;
    }
    drop(configs);
    persist_configs(&state).await?;
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::Engine;

    // ── Scratch sessions ────────────────────────────────────────────────────

    #[test]
    fn scratch_config_is_a_writable_memory_duckdb() {
        let c = scratch_config();
        assert_eq!(c.engine, Engine::Duckdb);
        assert_eq!(c.file_path.as_deref(), Some(":memory:"));
        assert!(!c.read_only, "a scratch is a sandbox — writes must pass the guard");
        assert_eq!(c.environment, None, "no environment: the prod border must not apply");
        assert!(!c.use_ssh && !c.auto_connect);
        // The guard captured from it must agree: writable, no prod limits.
        let g = crate::state::SessionGuard::from_config(&c);
        assert!(!g.read_only);
        assert!(g.refuse_bulk("CSV import").is_ok());
    }

    /// Open/run/close against the real engine (bundled DuckDB — no external
    /// DB needed), proving the session lands in the registry like any other
    /// and that two scratch sessions are independent in-memory databases.
    #[tokio::test]
    async fn scratch_sessions_open_run_close_and_are_independent() {
        let sessions: connection::SessionMap = Default::default();
        let kills: crate::state::KillMap = Default::default();
        let ch_kills: crate::state::ChKillMap = Default::default();

        let a = connection::open_session(&scratch_config(), None, &sessions, None).await.unwrap();
        let b = connection::open_session(&scratch_config(), None, &sessions, None).await.unwrap();
        assert_ne!(a, b);

        // A write in one scratch must not exist in the other.
        connection::execute_query(a, "CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (7)",
            &sessions, &kills, &ch_kills, "k1", false, None, None).await.unwrap();
        let r = connection::execute_query(a, "SELECT n FROM t",
            &sessions, &kills, &ch_kills, "k2", false, None, None).await.unwrap();
        assert_eq!(r.rows, vec![vec![serde_json::json!(7)]]);
        let err = connection::execute_query(b, "SELECT n FROM t",
            &sessions, &kills, &ch_kills, "k3", false, None, None).await.unwrap_err();
        assert!(format!("{err:#}").contains("t"), "unexpected error: {err:#}");

        // Close drops the session from the registry; a later use is an error.
        connection::close_session(a, &sessions).await;
        assert!(connection::get_session_pub(a, &sessions).await.is_err());
        assert!(connection::get_session_pub(b, &sessions).await.is_ok());
    }

    fn export_json(configs: &[ConnectionConfig]) -> String {
        serde_json::to_string(&ConnectionsEnvelope {
            format:  EXPORT_FORMAT.to_string(),
            version: EXPORT_VERSION,
            connections: configs.to_vec(),
        }).unwrap()
    }

    #[test]
    fn import_envelope_roundtrip_assigns_fresh_ids() {
        // A config whose id collides with an "existing" one must come back
        // with a different id after the fresh-id reassignment.
        let existing = ConnectionConfig::new(Engine::Mysql, "prod");
        let mut incoming = ConnectionConfig::new(Engine::Postgres, "prod-copy");
        incoming.id = existing.id; // simulate re-importing an exported file

        let json = export_json(&[incoming]);
        let envelope: ConnectionsEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(envelope.format, EXPORT_FORMAT);
        assert_eq!(envelope.version, EXPORT_VERSION);
        assert_eq!(envelope.connections.len(), 1);

        // Mirror the command's fresh-id policy.
        let mut map = std::collections::HashMap::new();
        map.insert(existing.id, existing.clone());
        for mut c in envelope.connections {
            c.id = Uuid::new_v4();
            map.insert(c.id, c);
        }
        assert_eq!(map.len(), 2, "colliding id must not clobber the existing config");
        assert!(map.values().any(|c| c.name == "prod"));
        assert!(map.values().any(|c| c.name == "prod-copy"));
    }

    #[test]
    fn import_envelope_rejects_bad_engine() {
        let json = r#"{
            "format": "txui-connections",
            "version": 1,
            "connections": [{
                "id": "00000000-0000-0000-0000-000000000001",
                "name": "x",
                "engine": "oracle",
                "host": null, "port": null, "user": null, "database": null,
                "ssl_mode": "preferred",
                "group": null, "color": null
            }]
        }"#;
        assert!(serde_json::from_str::<ConnectionsEnvelope>(json).is_err());
    }

    #[test]
    fn import_envelope_rejects_wrong_format_tag() {
        let json = r#"{"format": "other-app", "version": 1, "connections": []}"#;
        let envelope: ConnectionsEnvelope = serde_json::from_str(json).unwrap();
        assert_ne!(envelope.format, EXPORT_FORMAT);
    }
}
