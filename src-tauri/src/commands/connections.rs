use tauri::{Emitter, State};
use uuid::Uuid;

use crate::db::connection;
use crate::db::types::{ConnectionConfig, Engine, PingResult};
use crate::state::AppState;

/// Fill in the app-wide connect timeout when a connection does not set one.
///
/// Resolved here rather than in each driver because this is where the app
/// settings are reachable — the drivers only ever see a ConnectionConfig.
/// Pub(crate): the staged-connect diagnostics (conndiag) apply the same default.
pub(crate) fn with_default_timeout(config: &ConnectionConfig, state: &AppState) -> ConnectionConfig {
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
/// Pub(crate): the staged-connect diagnostics resolve secrets the same way.
pub(crate) fn get_password(config: &ConnectionConfig, data_dir: &std::path::Path) -> Option<String> {
    crate::secretstore::get(data_dir, &config.keychain_key())
}

/// The database password for a REAL connect: `password_exec` when the config
/// has one (W5.1 — minted, cached per TTL), else the stored secret. A set-but-
/// failing password command is an error, never a silent fall-back to the
/// stored secret (see password_exec::resolve).
async fn resolve_db_password(
    config: &ConnectionConfig,
    data_dir: &std::path::Path,
) -> Result<Option<String>, String> {
    match crate::password_exec::resolve(config).await? {
        Some(pw) => Ok(Some(pw)),
        None => Ok(get_password(config, data_dir)),
    }
}

/// Credential resolution for a Test / staged diagnostic / database listing:
/// an explicitly typed password wins; then `password_exec` when the config
/// carries one (the form can set it before the connection is ever saved, so
/// this is not gated on `saved`); then, for a connection that EXISTS in
/// storage, the stored secret — test-while-editing (W2.3, resolve_test_secret).
/// Pub(crate): the staged-connect diagnostics resolve secrets the same way.
pub(crate) async fn resolve_test_password(
    config: &ConnectionConfig,
    arg: Option<String>,
    data_dir: &std::path::Path,
) -> Result<Option<String>, String> {
    if let Some(p) = arg.filter(|p| !p.trim().is_empty()) {
        return Ok(Some(p));
    }
    if let Some(p) = crate::password_exec::resolve(config).await? {
        return Ok(Some(p));
    }
    Ok(if !config.id.is_nil() { get_password(config, data_dir) } else { None })
}

/// Diagnostic for the connect-failure log — reports store state without
/// leaking plaintext in release builds.
fn password_diag(config: &ConnectionConfig, data_dir: &std::path::Path) -> String {
    if config.password_exec.as_deref().is_some_and(|c| !c.trim().is_empty()) {
        // The password came from the connection's password command (W5.1), not
        // the store — the stored-secret report below would be a red herring.
        // The command line itself is never quoted (it stays out of logs).
        return "[password minted by the connection's password command — run it yourself and check what it prints]".into();
    }
    let key = config.keychain_key();
    match crate::secretstore::get(data_dir, &key) {
        None => format!("[no stored password for '{}' → EMPTY sent. Edit the connection, type the password, Save.]", key),
        Some(pw) => {
            let ws = if pw.trim().len() != pw.len() { " ⚠ leading/trailing whitespace" } else { "" };
            #[cfg(debug_assertions)]
            { // A fingerprint, not the password: the first/last bytes catch
              // stray whitespace and encoding surprises (the diagnostic's
              // whole purpose) without spilling the secret into the session
              // log and audit trail, where it would persist and get pasted
              // into tickets.
              let b = pw.as_bytes();
              let fp = format!("{:02x}…{:02x}", b.first().unwrap_or(&0), b.last().unwrap_or(&0));
              format!("[stored password: {} bytes, ends {}{} — server rejected it]", pw.len(), fp, ws)}
            #[cfg(not(debug_assertions))]
            format!("[stored password is {} bytes{} — server rejected it: wrong for this account]", pw.len(), ws)
        }
    }
}

/// Verbose target descriptor for diagnostics — exactly what we tried to reach.
/// Pub(crate): the staged diagnostics put it on the auth stage's failure detail.
pub(crate) fn describe(config: &ConnectionConfig) -> String {
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
    persist_configs_state(state).await
}

/// The same flush on a bare `&AppState`, for commands whose work is factored
/// into a State-free helper (galera's `adopt_members`) and for tests.
pub(crate) async fn persist_configs_state(state: &AppState) -> Result<(), crate::apperror::AppError> {
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

/// Bring up the SSH tunnel a connection config asks for, or `Ok(None)` when
/// `use_ssh` is off. `ssh_password` is resolved by the caller — the secret
/// store for a saved connection, the form's field for an ad-hoc test. The
/// error is phrased for display; callers decide what else to do with a
/// failure (audit rows, PingResult shaping).
/// Pub(crate): the staged diagnostics run the tunnel bring-up as its own stage.
pub(crate) async fn open_tunnel(
    config: &ConnectionConfig,
    ssh_password: Option<&str>,
) -> Result<Option<crate::db::ssh::SshTunnel>, String> {
    if !config.use_ssh {
        return Ok(None);
    }
    let ssh_host = config.ssh_host.as_deref()
        .ok_or("SSH host is required when tunnel is enabled")?;
    let ssh_user = config.ssh_user.as_deref()
        .ok_or("SSH user is required when tunnel is enabled")?;
    let ssh_port = config.ssh_port.unwrap_or(22);
    let db_host  = config.host.as_deref().unwrap_or("localhost");
    let db_port  = config.port.unwrap_or(config.engine.default_port());

    crate::db::ssh::SshTunnel::open(
        ssh_host, ssh_port, ssh_user,
        config.ssh_key_path.as_deref(),
        db_host, db_port,
        config.ssh_jump.as_deref(),
        ssh_password,
        config.connect_timeout_secs,
    ).await
    .map_err(|e| format!("SSH tunnel to {ssh_user}@{ssh_host}:{ssh_port} failed:\n{e:#}"))
    .map(Some)
}

/// The SSH password of a SAVED connection, when it uses one. Ad-hoc tests and
/// dump jobs pass theirs in explicitly instead.
/// Pub(crate): the staged-connect diagnostics resolve secrets the same way.
pub(crate) fn stored_ssh_password(config: &ConnectionConfig, data_dir: &std::path::Path) -> Option<String> {
    if config.use_ssh && config.use_ssh_password {
        crate::secretstore::get(data_dir, &config.ssh_keychain_key())
    } else {
        None
    }
}

/// Test connectivity — does NOT open a persistent session.
///
/// Goes through the exact path `test_connection_adhoc` (and a real connect)
/// use: SSH tunnel included, then a throwaway session on a scratch registry
/// and a probe query. The previous version called `connection::ping` with no
/// tunnel, so every tunnelled saved connection failed the sidebar's Test.
#[tauri::command]
pub async fn test_connection(id: Uuid, state: State<'_, AppState>) -> Result<PingResult, crate::apperror::AppError> {
    let config = state.configs.read().await.get(&id).cloned()
        .ok_or_else(|| format!("connection {} not found", id))?;
    let password = resolve_db_password(&config, &state.data_dir).await
        .map_err(crate::apperror::AppError::from)?;
    let config = with_default_timeout(&config, &state);
    let ssh_password = stored_ssh_password(&config, &state.data_dir);
    let start = std::time::Instant::now();
    let ping = match test_connect_core(&config, password, ssh_password).await {
        Ok(version) => PingResult {
            ok: true,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: version,
            error: None,
        },
        // The core's errors are already self-explanatory (they name the target
        // or the tunnel); a failed Test is data, not a command failure.
        Err(e) => PingResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: None,
            error: Some(e),
        },
    };
    Ok(ping)
}

/// Open a live session, optionally through an SSH tunnel. Returns the session UUID.
#[tauri::command]
pub async fn open_connection(id: Uuid, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Uuid, crate::apperror::AppError> {
    let config = state.configs.read().await.get(&id).cloned()
        .ok_or_else(|| format!("connection {} not found", id))?;
    let session_id = open_session_for_config(&config, &state).await?;
    // TOFU surfacing: ssh's accept-new recorded a previously unknown host key
    // during this connect's handshake. One quiet audit row + one session-log
    // line (via the frontend's dbgui:ssh-host-key listener) — not a dialog.
    // Ephemeral connects (galera polls, multi-exec) skip this like they skip
    // every lifecycle row; the drain task's log::warn! fires regardless.
    let host_key_note = state.tunnels.read().await.get(&session_id)
        .and_then(|t| t.host_key_note.clone());
    if let Some(note) = host_key_note {
        let start = crate::commands::audit::session_start(&config);
        crate::commands::audit::insert_ssh_host_key(&state.history, session_id, &start, &note).await;
        let _ = app.emit("dbgui:ssh-host-key", serde_json::json!({
            "sessionId": session_id,
            "note": note,
        }));
    }
    Ok(session_id)
}

/// Cancel an in-flight `open_connection` for a connection (W3.2 — the ✕ on
/// the sidebar's connecting badge). Returns true when a connect was actually
/// in flight and got the signal; a finished (or never started) connect is a
/// quiet false. The open itself tears down its partial state — tunnel, and a
/// late-arriving pool via the spawned reaper — and returns `cancelled`.
#[tauri::command]
pub async fn cancel_connect(
    connection_id: Uuid,
    state: State<'_, AppState>,
) -> Result<bool, crate::apperror::AppError> {
    Ok(cancel_connect_inner(connection_id, &state).await)
}

/// The State-free body of [`cancel_connect`], so tests can drive it.
pub(crate) async fn cancel_connect_inner(connection_id: Uuid, state: &AppState) -> bool {
    match state.connect_cancels.write().await.remove(&connection_id.to_string()) {
        Some(tx) => { let _ = tx.send(()); true }
        None => false,
    }
}

/// Shared connect path (keychain password + optional SSH tunnel) used by both
/// `open_connection` and the ephemeral session consumers.
pub(crate) async fn open_session_for_config(
    config: &crate::db::types::ConnectionConfig,
    state: &AppState,
) -> Result<Uuid, crate::apperror::AppError> {
    open_session_inner(config, state, false).await
}

/// The quiet variant for sessions that live for seconds (multi-exec fan-out,
/// galera polls/kills/consistency checks, SST tails): identical machinery, but
/// no lifecycle audit rows and no `session_starts` record. A galera poll opens
/// one session per node per poll — audited like a user connect, that is an
/// unmatched 'connect' row per poll per node in a table with no retention
/// interest in them, and a `session_starts` entry nothing ever removed.
/// Guards (`session_meta`) are NOT skipped: a read-only or prod config must
/// bite exactly the same on an ephemeral session. Pair with
/// `teardown_ephemeral_session`.
pub(crate) async fn open_ephemeral_session(
    config: &crate::db::types::ConnectionConfig,
    state: &AppState,
) -> Result<Uuid, crate::apperror::AppError> {
    open_session_inner(config, state, true).await
}

async fn open_session_inner(
    config: &crate::db::types::ConnectionConfig,
    state: &AppState,
    quiet: bool,
) -> Result<Uuid, crate::apperror::AppError> {
    let password = match resolve_db_password(config, &state.data_dir).await {
        Ok(p) => p,
        Err(msg) => {
            // A password-exec failure is a connect failure: audited like one
            // on the loud path (the quiet path writes no lifecycle rows).
            if !quiet {
                let attempt = crate::commands::audit::session_start(config);
                crate::commands::audit::insert_connect_failed(&state.history, &attempt, &msg).await;
            }
            return Err(msg.into());
        }
    };
    // Apply the app-wide connect timeout to anything that has not set its own.
    let owned = with_default_timeout(config, state);
    let config = &owned;

    // Start the attempt clock up front: a FAILED connect is audited too
    // (insert_connect_failed below), and its duration_ms is how long the
    // attempt took. The successful path builds its own SessionStart after the
    // session exists, so a session's lifetime is not charged for connect time.
    let attempt = crate::commands::audit::session_start(config);

    // W3.2 cancellable connect: a user-facing open registers a oneshot under
    // the connection id, so `cancel_connect` (the ✕ on the sidebar's
    // connecting badge) can fire it. Quiet ephemeral opens never register —
    // several can run for the same connection at once (multi-exec fan-out)
    // and no UI badge is waiting on them. The entry is removed when the open
    // ends, so a PRESENT entry is always an in-flight connect.
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    // A quiet open's sender is never registered, but it must still be HELD for
    // the whole open: dropping it would resolve the receiver, and a select!
    // arm reads that as a cancel.
    let mut held_tx = Some(cancel_tx);
    if !quiet {
        if let Some(tx) = held_tx.take() {
            state.connect_cancels.write().await.insert(config.id.to_string(), tx);
        }
    }

    let result = open_session_stages(config, password, state, quiet, &attempt, &mut cancel_rx).await;

    if !quiet {
        state.connect_cancels.write().await.remove(&config.id.to_string());
    }
    drop(held_tx); // explicit: the quiet path's sender lives exactly this long
    result
}

/// The clean user-intent error a cancelled connect returns (W3.2) — Cancelled,
/// not ConnectFailed: nothing is wrong with the server, the user pressed ✕.
fn connect_cancelled() -> crate::apperror::AppError {
    crate::apperror::AppError::new(crate::apperror::ErrorCode::Cancelled, "Connect cancelled")
}

/// The staged body of `open_session_inner`, racing each cancellable stage
/// against `cancel_rx`. A connect is sequential awaits (tunnel → IAM mint →
/// driver open); the flag is checked BETWEEN stages by wrapping each stage in
/// a select!, and a driver open that cannot be interrupted mid-dial is
/// detached and its late arrival reaped (closed) instead of orphaned — the
/// in-process twin of `close_orphaned_connection` (W1.5).
async fn open_session_stages(
    config: &crate::db::types::ConnectionConfig,
    password: Option<String>,
    state: &AppState,
    quiet: bool,
    attempt: &crate::state::SessionStart,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<Uuid, crate::apperror::AppError> {
    let audit_fail = |msg: &str| {
        let msg = msg.to_string();
        let attempt = attempt.clone();
        let history = state.history.clone();
        async move {
            crate::commands::audit::insert_connect_failed(&history, &attempt, &msg).await;
        }
    };

    // Stage 1: the SSH tunnel. Spawned rather than awaited inline so a cancel
    // does not abandon a half-brought-up ssh child mid-poll: the reaper awaits
    // the bring-up to completion and drops the SshTunnel, whose Drop kills the
    // child — the same teardown the success path relies on.
    let tunnel = if config.use_ssh {
        let ssh_password = stored_ssh_password(config, &state.data_dir);
        let cfg = config.clone();
        let mut bring_up = tokio::spawn(async move {
            open_tunnel(&cfg, ssh_password.as_deref()).await
        });
        tokio::select! {
            _ = &mut *cancel_rx => {
                tokio::spawn(async move {
                    if let Ok(Ok(Some(t))) = bring_up.await {
                        drop(t); // Drop kills the ssh child
                    }
                });
                if !quiet { audit_fail("Connect cancelled by user").await; }
                return Err(connect_cancelled());
            }
            r = &mut bring_up => match r {
                Ok(Ok(t)) => t,
                Ok(Err(msg)) => {
                    if !quiet { audit_fail(&msg).await; }
                    return Err(msg.into());
                }
                Err(e) => {
                    let msg = format!("SSH tunnel task failed: {e}");
                    if !quiet { audit_fail(&msg).await; }
                    return Err(msg.into());
                }
            },
        }
    } else {
        None
    };

    // If tunnel is active, connect to localhost:local_port. Both halves are
    // Copy/'static, so this does not borrow the tunnel.
    let host_override: Option<(&str, u16)> = tunnel.as_ref()
        .map(|t| ("127.0.0.1", t.local_port));

    // Stage 2: the driver open (IAM token mint → dial → auth, inside
    // connection::open_session). Spawned for the same reason as the tunnel:
    // sqlx's dial cannot be interrupted mid-flight, so on cancel the task is
    // detached and a reaper closes whatever session eventually lands — a late
    // arrival must never become a live pool nobody holds (W1.5's orphan, just
    // triggered by an explicit cancel instead of a frontend deadline).
    let cfg = config.clone();
    let pw = password.clone();
    let sessions = state.sessions.clone();
    let mut opening = tokio::spawn(async move {
        connection::open_session(&cfg, pw, &sessions, host_override).await
    });
    let session_id = tokio::select! {
        _ = &mut *cancel_rx => {
            let sessions = state.sessions.clone();
            tokio::spawn(async move {
                if let Ok(Ok(sid)) = opening.await {
                    // No session_starts/session_meta entry was ever written for
                    // it (those happen below, on the success path), so a plain
                    // pool close IS the whole teardown.
                    connection::close_session(sid, &sessions).await;
                }
            });
            drop(tunnel); // Drop kills the ssh child
            if !quiet { audit_fail("Connect cancelled by user").await; }
            return Err(connect_cancelled());
        }
        r = &mut opening => match r {
            Ok(Ok(id)) => id,
            Ok(Err(e)) => {
                let msg = format!("Connect to {} failed:\n{:#}\n{}", describe(config), e, password_diag(config, &state.data_dir));
                if !quiet { audit_fail(&msg).await; }
                return Err(msg.into());
            }
            Err(e) => {
                let msg = format!("Connect to {} failed: the open task died: {e}", describe(config));
                if !quiet { audit_fail(&msg).await; }
                return Err(msg.into());
            }
        }
    };

    // Store tunnel (Drop impl will kill ssh when removed) and start its
    // liveness watch (W4.5) — from here on, the ssh child dying under a live
    // session is an event, not the next query's surprise error.
    if let Some(t) = tunnel {
        spawn_tunnel_watch(state, session_id, config.id, &t);
        state.tunnels.write().await.insert(session_id, t);
    }

    // Capture the write guard + prod hard limits from the config so the
    // backend can enforce them regardless of the frontend.
    state.session_meta.write().await
        .insert(session_id, crate::state::SessionGuard::from_config(config));

    // Lifecycle audit: the 'connect' row, plus the start record the matching
    // 'disconnect' (close_connection / close_all) reads its duration from.
    // Quiet (ephemeral) sessions write neither — see open_ephemeral_session.
    if !quiet {
        let start = crate::commands::audit::session_start(config);
        state.session_starts.write().await.insert(session_id, start.clone());
        crate::commands::audit::insert_lifecycle(&state.history, session_id, &start, "connect").await;
    }

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

/// How often the tunnel liveness watch polls the ssh child (W4.5). 1 s is far
/// sooner than the next failed query ever noticed, and each poll is a
/// microsecond `try_wait` borrow — no lock is ever held across an await.
const TUNNEL_WATCH_POLL: std::time::Duration = std::time::Duration::from_secs(1);

/// W4.5 — SSH tunnel liveness watch. A tunnel's death used to surface only as
/// the next query's error: the ssh child sat in the registry with nothing
/// watching it. This spawns a per-tunnel task that polls the child and, on an
/// UNEXPECTED exit while the session is still alive, marks the session
/// degraded (session_meta) and emits `conn:tunnel-lost` with
/// `{ session_id, connection_id, reason }` for the frontend's health surface.
///
/// Deliberate teardown is NOT reported: every close path (close_connection,
/// teardown_ephemeral_session, close_all) removes the tunnel from the map,
/// whose Drop disarms the watcher before killing the child. Quiet ephemeral
/// sessions are watched too — the emit is harmless for a session id no
/// sidebar row holds, and the alternative (a quiet flag threading through) is
/// a second kind of tunnel lifecycle.
fn spawn_tunnel_watch(
    state: &AppState,
    session_id: Uuid,
    connection_id: Uuid,
    tunnel: &crate::db::ssh::SshTunnel,
) {
    // Tests build AppState without a running app: nowhere to emit, no watcher.
    let Some(app) = state.app_handle.get().cloned() else { return };
    let (child, disarmed) = tunnel.watch_handles();
    let sessions = state.sessions.clone();
    let meta = state.session_meta.clone();
    tauri::async_runtime::spawn(async move {
        let Some(code) = crate::db::ssh::watch_child_exit(child, disarmed, TUNNEL_WATCH_POLL).await else {
            return; // deliberate teardown — Drop disarmed us
        };
        // The session is gone but the tunnel somehow was not disarmed: nothing
        // to mark and nobody to notify. (All close paths drop the tunnel, so
        // this is belt and braces, not an expected path.)
        if !sessions.read().await.contains_key(&session_id) {
            return;
        }
        let reason = crate::db::ssh::tunnel_exit_reason(code);
        log::warn!("session {session_id}: {reason}");
        if let Some(g) = meta.write().await.get_mut(&session_id) {
            g.degraded = Some(reason.clone());
        }
        let _ = app.emit("conn:tunnel-lost", serde_json::json!({
            "session_id":    session_id,
            "connection_id": connection_id,
            "reason":        reason,
        }));
    });
}

/// Tear down a session opened by `open_ephemeral_session`: every registry the
/// open (or the work done on the session) could have touched.
///
/// Exists because there are six ephemeral consumers and each used to clean a
/// different four-item subset — `session_starts`, `session_dbs`,
/// `redis_catalogs` and the kill-probe cache leaked on all of them. Mirrors
/// `close_connection`'s registry list, minus the audit row (a quiet session
/// wrote none) and minus `cancel_session_work` (the session's only in-flight
/// work is the caller's own statement, handled by the kill sweep below).
///
/// `cancel_key` is the key the caller's statement registered its server-side
/// kill handle under. A handle STILL PRESENT at teardown means the statement
/// is still running on the server (the caller's timeout dropped the execute
/// future — `execute_query` removes the handle itself on completion), so it
/// is fired, not just removed: a plain remove is how a "timed out" statement
/// keeps burning server-side. `stop_in_flight` is not reused here because it
/// still spawns the (fingerprint-verified) kill for MySQL/PG, and the spawned
/// task's session lookup would race the pool close below and usually lose;
/// this kill is awaited, bounded, before close.
pub(crate) async fn teardown_ephemeral_session(state: &AppState, session_id: Uuid, cancel_key: &str) {
    /// Grace for delivering the server-side kill before the pool closes.
    const KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

    let backend = state.kills.write().await.remove(cancel_key);
    let ch_query_id = state.ch_kills.write().await.remove(cancel_key);
    if let Some(handle) = backend {
        let _ = tokio::time::timeout(KILL_GRACE, connection::kill_backend(
            session_id, handle.backend_id, &state.sessions, connection::KillForce::Cancel,
            Some(&handle.fingerprint),
        )).await;
    }
    if let Some(query_id) = ch_query_id {
        let kill = async {
            if let Ok(session) = connection::get_session_pub(session_id, &state.sessions).await {
                if let crate::db::types::LiveSession::Clickhouse(s) = session.as_ref() {
                    let _ = crate::db::clickhouse::kill_query(s, &query_id).await;
                }
            }
        };
        let _ = tokio::time::timeout(KILL_GRACE, kill).await;
    }

    connection::close_session(session_id, &state.sessions).await;
    state.tunnels.write().await.remove(&session_id); // Drop kills ssh process
    state.session_meta.write().await.remove(&session_id);
    state.session_dbs.write().await.remove(&session_id);
    state.redis_catalogs.write().await.remove(&session_id);
    // Quiet sessions never wrote a start record; removed defensively so the
    // map provably never outlives the session.
    state.session_starts.write().await.remove(&session_id);
    crate::commands::kill::forget_session(session_id);   // drop its cached probe result
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
    Ok(close_one_session(session_id, &state).await)
}

/// The body of `close_connection` on a bare `&AppState`, so
/// `close_orphaned_connection` can run the same teardown for a session it
/// found by connection id.
async fn close_one_session(session_id: Uuid, state: &AppState) -> Vec<u64> {
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
    state.session_dbs.write().await.remove(&session_id);
    state.redis_catalogs.write().await.remove(&session_id);
    crate::commands::kill::forget_session(session_id);   // drop its cached probe result
    // Lifecycle audit: the session is gone either way (a timed-out close is
    // still a disconnect), so the row is written after teardown, not gated on
    // it. Sessions with no start record (opened before this existed) get none.
    if let Some(start) = state.session_starts.write().await.remove(&session_id) {
        crate::commands::audit::insert_lifecycle(&state.history, session_id, &start, "disconnect").await;
    }
    thread_ids
}

/// Best-effort cleanup for a connect the frontend ABANDONED at its deadline.
///
/// The frontend wraps `open_connection` in a client-side deadline
/// (withDeadline.ts): when it fires, the promise is dropped but the backend
/// keeps opening, and a slow connect then lands a live pool (+ SSH tunnel) in
/// the registry with nobody holding its session id — a failed-looking connect
/// that is actually connected. The frontend calls this on that path: close
/// every session of `connection_id` that appeared since the attempt started.
///
/// `attempt_age_ms` is how long ago the frontend STARTED the attempt, so a
/// session that predates it (the user was already connected) is never
/// touched. The abandoned open may still be mid-dial when this arrives, so a
/// late arrival is polled for, up to `grace_ms` — default: the connection's
/// own connect timeout + 10 s slack (capped at 60 s total). Returns how many
/// sessions were closed.
#[tauri::command]
pub async fn close_orphaned_connection(
    connection_id: Uuid,
    attempt_age_ms: u64,
    grace_ms: Option<u64>,
    state: State<'_, AppState>,
) -> Result<u32, crate::apperror::AppError> {
    Ok(close_orphaned(connection_id, attempt_age_ms, grace_ms, &state).await)
}

/// The State-free body of [`close_orphaned_connection`], so tests can drive it.
pub(crate) async fn close_orphaned(
    connection_id: Uuid,
    attempt_age_ms: u64,
    grace_ms: Option<u64>,
    state: &AppState,
) -> u32 {
    /// Clock-skew allowance between the frontend's deadline clock and the
    /// backend's open-completion Instant. A session older than the attempt by
    /// more than this is pre-existing and must survive.
    const SLACK: std::time::Duration = std::time::Duration::from_secs(2);

    // A bogus huge age would make EVERY session of the connection qualify;
    // clamp it to something a connect attempt can legitimately take.
    let age = std::time::Duration::from_millis(attempt_age_ms.min(600_000));
    let Some(cutoff) = std::time::Instant::now().checked_sub(age) else {
        return 0;
    };
    let grace = match grace_ms {
        Some(ms) => std::time::Duration::from_millis(ms.min(60_000)),
        // Long enough for the abandoned open to actually land: the
        // connection's own connect timeout (else the app default) + slack.
        None => {
            let secs = state.configs.read().await.get(&connection_id)
                .and_then(|c| c.connect_timeout_secs)
                .map(u64::from)
                .unwrap_or(crate::db::types::DEFAULT_CONNECT_TIMEOUT_SECS);
            (std::time::Duration::from_secs(secs) + std::time::Duration::from_secs(10))
                .min(std::time::Duration::from_secs(60))
        }
    };
    let deadline = std::time::Instant::now() + grace;

    let mut closed = 0u32;
    loop {
        let victims: Vec<Uuid> = state.session_starts.read().await.iter()
            .filter(|(_, s)| s.connection_id == connection_id && s.at + SLACK >= cutoff)
            .map(|(sid, _)| *sid)
            .collect();
        for sid in victims {
            close_one_session(sid, state).await;
            closed += 1;
        }
        if closed > 0 || std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    closed
}

/// Credential resolution for a Test: an explicitly passed secret wins; a
/// blank one on a connection that EXISTS in storage (test-while-editing)
/// falls back to the stored secret, or the form's Test would report an auth
/// failure about a password the user never retyped. A brand-new (unsaved, nil
/// id) connection has nothing to fall back to.
/// Pub(crate): the staged-connect diagnostics resolve secrets the same way.
pub(crate) fn resolve_test_secret(arg: Option<String>, stored: Option<String>, saved: bool) -> Option<String> {
    match arg.filter(|p| !p.trim().is_empty()) {
        Some(p) => Some(p),
        None if saved => stored,
        None => None,
    }
}

/// Shared core of the two Test buttons: bring up the SSH tunnel when the
/// config asks for one, open a throwaway session on a scratch registry (never
/// AppState — nothing persists), run the probe query, and tear everything
/// down, tunnel included. Returns the probe's version string when the engine
/// has a cheap one. Errors are phrased for display.
async fn test_connect_core(
    config: &ConnectionConfig,
    password: Option<String>,
    ssh_password: Option<String>,
) -> Result<Option<String>, String> {
    // Ephemeral session registry — never touches AppState.
    let sessions: connection::SessionMap = Default::default();

    let tunnel = open_tunnel(config, ssh_password.as_deref()).await?;
    let host_override: Option<(&str, u16)> = tunnel.as_ref()
        .map(|t| ("127.0.0.1", t.local_port));

    let result: Result<Option<String>, String> = async {
        let session_id = connection::open_session(config, password, &sessions, host_override)
            .await
            .map_err(|e| format!("Connect to {} failed:\n{}", describe(config), friendly_error(&config.engine, &e)))?;
        let session = connection::get_session_pub(session_id, &sessions)
            .await
            .map_err(|e| e.to_string())?;
        let version = connection::probe_session(&session)
            .await
            .map_err(|e| format!("Connected, but the probe query failed: {e:#}"))?;
        connection::close_session(session_id, &sessions).await;
        Ok(version)
    }.await;

    drop(tunnel); // Drop kills the ssh child
    result
}

/// Test an unsaved (ad-hoc) connection: opens a real connection — including
/// the SSH tunnel when configured — pings it, and tears everything down.
/// Nothing is left in AppState and NOTHING is persisted to the secret store
/// or connections.json. A blank password on a config whose id exists in
/// storage falls back to the STORED secret (test-while-editing; see
/// resolve_test_secret). Returns a short success summary (server version when
/// cheap to get).
#[tauri::command]
pub async fn test_connection_adhoc(
    config: ConnectionConfig,
    password: Option<String>,
    ssh_password: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, crate::apperror::AppError> {
    // The app-wide connect timeout, as on every other connect path.
    let config = with_default_timeout(&config, &state);
    let password = resolve_test_password(&config, password, &state.data_dir).await
        .map_err(crate::apperror::AppError::from)?;
    let saved = !config.id.is_nil();
    let ssh_password = resolve_test_secret(
        ssh_password,
        if saved { stored_ssh_password(&config, &state.data_dir) } else { None },
        saved,
    );

    let start = std::time::Instant::now();
    let version = test_connect_core(&config, password, ssh_password)
        .await
        .map_err(crate::apperror::AppError::from)?;
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

/// Live pool occupancy of a session (W4.4) — `{ size, idle, in_use }` for the
/// sqlx-pool engines (MySQL, PostgreSQL, SQLite), `null` where a pool count
/// has no meaning (Redis, ClickHouse, MongoDB, SQL Server, Parquet, DuckDB).
/// Read-only and cheap: sqlx keeps these counters, no round trip is made.
#[tauri::command]
pub async fn session_pool_stats(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Option<connection::PoolStats>, crate::apperror::AppError> {
    let id = Uuid::parse_str(&session_id)
        .map_err(|_| format!("invalid session id: {session_id}"))?;
    let session = connection::get_session_pub(id, &state.sessions).await?;
    Ok(connection::pool_stats(&session))
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

// ── Encrypted import / export (W5.2) ────────────────────────────────────────

/// The opt-in passphrase-protected export (TablePlus/Compass model), alongside
/// the secrets-free `export_connections`. Collects the selected connections
/// AND their stored secrets (database + SSH passwords) and seals them under
/// the passphrase (`connexport`: Argon2id at the vault's cost + AES-256-GCM,
/// portable JSON envelope). Returns the sealed JSON text.
#[tauri::command]
pub async fn export_connections_encrypted(
    ids: Option<Vec<Uuid>>,
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<String, crate::apperror::AppError> {
    export_connections_encrypted_body(ids, passphrase, &state).await
}

/// The State-free body of [`export_connections_encrypted`], so tests can drive it.
pub(crate) async fn export_connections_encrypted_body(
    ids: Option<Vec<Uuid>>,
    passphrase: String,
    state: &AppState,
) -> Result<String, crate::apperror::AppError> {
    let configs = state.configs.read().await;
    let mut list: Vec<ConnectionConfig> = match &ids {
        Some(ids) => ids.iter().filter_map(|id| configs.get(id).cloned()).collect(),
        None      => configs.values().cloned().collect(),
    };
    list.sort_by(|a, b| a.name.cmp(&b.name));

    let mut secrets = std::collections::BTreeMap::new();
    for c in &list {
        if let Some(pw) = crate::secretstore::get(&state.data_dir, &c.keychain_key()) {
            secrets.insert(c.keychain_key(), pw);
        }
        if let Some(pw) = crate::secretstore::get(&state.data_dir, &c.ssh_keychain_key()) {
            secrets.insert(c.ssh_keychain_key(), pw);
        }
    }
    drop(configs);

    let payload = crate::connexport::Payload::new(list, secrets);
    // Argon2id at 64 MiB blocks — keep the runtime responsive.
    let out = tokio::task::spawn_blocking(move || crate::connexport::seal(&payload, &passphrase))
        .await
        .map_err(|e| format!("export task failed: {e}"))?
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Import a passphrase-protected export (`export_connections_encrypted`).
/// Every connection gets a FRESH id and its secrets are re-keyed to it and
/// written into the ACTIVE secretstore — plain mode or vault, whichever is
/// live. Returns the number of connections imported. A wrong passphrase is a
/// clean error, nothing is imported.
#[tauri::command]
pub async fn import_connections_encrypted(
    payload: String,
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<u32, crate::apperror::AppError> {
    import_connections_encrypted_body(payload, passphrase, &state).await
}

/// The State-free body of [`import_connections_encrypted`], so tests can drive it.
pub(crate) async fn import_connections_encrypted_body(
    payload: String,
    passphrase: String,
    state: &AppState,
) -> Result<u32, crate::apperror::AppError> {
    let opened = tokio::task::spawn_blocking(move || crate::connexport::open(&payload, &passphrase))
        .await
        .map_err(|e| format!("import task failed: {e}"))?
        .map_err(|e| e.to_string())?;

    let mut configs = state.configs.write().await;
    let mut imported = 0u32;
    for mut config in opened.connections {
        let old_id = config.id;
        config.id = Uuid::new_v4();
        // Re-key the secrets to the fresh id before anything persists them.
        for (old_key, new_key) in [
            (format!("dbgui:{old_id}"), config.keychain_key()),
            (format!("dbgui-ssh:{old_id}"), config.ssh_keychain_key()),
        ] {
            if let Some(secret) = opened.secrets.get(&old_key) {
                crate::secretstore::set(&state.data_dir, &new_key, secret)
                    .map_err(|e| format!("could not store an imported password: {e}"))?;
            }
        }
        configs.insert(config.id, config);
        imported += 1;
    }
    drop(configs);
    persist_configs_state(state).await?;
    Ok(imported)
}

// ── Database list for the form's picker (W5.4) ──────────────────────────────

/// The SQL that lists databases/schemas on each engine, or `None` where the
/// driver API answers instead (MongoDB `list_database_names`) or the question
/// is meaningless (Redis, file engines). Pure — unit-tested per engine.
///
/// Exactly the engine's canonical catalog query; the row cap is applied to
/// the RESULT (Rust-side), because MySQL's `SHOW DATABASES` takes no LIMIT.
pub(crate) fn list_databases_sql(engine: Engine) -> Option<&'static str> {
    match engine {
        Engine::Mysql      => Some("SHOW DATABASES"),
        Engine::Postgres   => Some("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname"),
        Engine::SqlServer  => Some("SELECT name FROM sys.databases ORDER BY name"),
        Engine::Clickhouse => Some("SHOW DATABASES"),
        Engine::MongoDb    => None, // driver API, not SQL
        Engine::Redis | Engine::Sqlite | Engine::Parquet | Engine::Duckdb => None,
    }
}

/// Hard cap on the returned list — a hosting server can expose tens of
/// thousands of databases, and the picker's dropdown is not the place for
/// them. "A few thousand", per the wave contract.
const LIST_DATABASES_CAP: usize = 5_000;

/// Engines where "list databases" has no meaning — the frontend greys the
/// picker button on exactly this predicate's mirror.
fn databases_not_applicable(engine: Engine) -> bool {
    engine.is_file_backed() || engine == Engine::Redis
}

/// List database/schema names for the connection form's picker, without
/// opening a real session: the throwaway-session machinery (`test_connect_core`
/// pattern — SSH tunnel included, scratch registry, torn down afterwards).
/// Credential resolution follows the Test-button rules (`resolve_test_password`):
/// a typed password wins, then the connection's password command (W5.1), then
/// the stored secret of a saved config.
#[tauri::command]
pub async fn connect_list_databases(
    config: ConnectionConfig,
    password: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, crate::apperror::AppError> {
    connect_list_databases_body(config, password, &state).await
}

/// The State-free body of [`connect_list_databases`], so tests can drive it.
pub(crate) async fn connect_list_databases_body(
    config: ConnectionConfig,
    password: Option<String>,
    state: &AppState,
) -> Result<Vec<String>, crate::apperror::AppError> {
    if databases_not_applicable(config.engine) {
        return Err(format!(
            "database listing is not applicable for {} connections",
            config.engine.wire_name()
        ).into());
    }
    let config = with_default_timeout(&config, &state);
    let password = resolve_test_password(&config, password, &state.data_dir).await
        .map_err(crate::apperror::AppError::from)?;
    let ssh_password = if !config.id.is_nil() {
        stored_ssh_password(&config, &state.data_dir)
    } else {
        None
    };

    let sessions: connection::SessionMap = Default::default();
    let tunnel = open_tunnel(&config, ssh_password.as_deref()).await?;
    let host_override: Option<(&str, u16)> = tunnel.as_ref()
        .map(|t| ("127.0.0.1", t.local_port));

    let result: Result<Vec<String>, String> = async {
        let session_id = connection::open_session(&config, password, &sessions, host_override)
            .await
            .map_err(|e| format!("Connect to {} failed:\n{}", describe(&config), friendly_error(&config.engine, &e)))?;
        let session = connection::get_session_pub(session_id, &sessions)
            .await
            .map_err(|e| e.to_string())?;
        let dbs = list_databases_on(&session).await
            .map_err(|e| format!("Connected, but listing databases failed: {e:#}"))?;
        connection::close_session(session_id, &sessions).await;
        Ok(dbs)
    }.await;

    drop(tunnel); // Drop kills the ssh child
    result.map_err(crate::apperror::AppError::from)
}

/// Run the engine's database listing on a live (throwaway) session.
async fn list_databases_on(
    session: &crate::db::types::LiveSession,
) -> anyhow::Result<Vec<String>> {
    use crate::db::types::LiveSession;
    let mut names: Vec<String> = match session {
        LiveSession::Mysql(pool) => sqlx::query_scalar(list_databases_sql(Engine::Mysql).unwrap())
            .fetch_all(pool).await?,
        LiveSession::Postgres(pool) => sqlx::query_scalar(list_databases_sql(Engine::Postgres).unwrap())
            .fetch_all(pool).await?,
        LiveSession::Clickhouse(s) => {
            let r = crate::db::clickhouse::execute(s, list_databases_sql(Engine::Clickhouse).unwrap()).await?;
            r.rows.iter()
                .filter_map(|row| row.first().and_then(|v| v.as_str()).map(String::from))
                .collect()
        }
        LiveSession::SqlServer(s) => {
            let r = crate::db::sqlserver::execute(s, list_databases_sql(Engine::SqlServer).unwrap()).await?;
            r.rows.iter()
                .filter_map(|row| row.first().and_then(|v| v.as_str()).map(String::from))
                .collect()
        }
        LiveSession::MongoDb(client) => client.list_database_names().await?,
        // Guarded by the command's `databases_not_applicable` check — a direct
        // call still gets an error, never a panic.
        _ => anyhow::bail!("database listing is not applicable for {}", session.engine_name()),
    };
    names.truncate(LIST_DATABASES_CAP);
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::Engine;

    async fn test_state() -> AppState {
        let history = crate::history::open_in_memory().await.expect("in-memory history");
        AppState::new(history, std::env::temp_dir(), Default::default())
    }

    // ── Cancellable connect (W3.2) ──────────────────────────────────────────

    /// No connect in flight → a quiet false, and nothing to fire.
    #[tokio::test]
    async fn cancel_connect_without_an_in_flight_open_is_a_quiet_false() {
        let state = test_state().await;
        assert!(!cancel_connect_inner(Uuid::new_v4(), &state).await);
    }

    /// A registered connect's oneshot fires and the entry is consumed — a
    /// second cancel finds nothing.
    #[tokio::test]
    async fn cancel_connect_fires_the_registered_oneshot_once() {
        let state = test_state().await;
        let id = Uuid::new_v4();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        state.connect_cancels.write().await.insert(id.to_string(), tx);

        assert!(cancel_connect_inner(id, &state).await);
        assert_eq!(rx.await, Ok(()), "the open's receiver must resolve");
        assert!(!cancel_connect_inner(id, &state).await, "the entry is consumed");
    }

    /// The registration lives exactly as long as the open: after a successful
    /// (fast, in-process DuckDB) connect the map is clean, so a late cancel
    /// against a connected session is a false, not a misfire.
    #[tokio::test]
    async fn a_finished_open_leaves_no_cancel_registration() {
        let state = test_state().await;
        let cfg = scratch_config();
        let sid = open_session_for_config(&cfg, &state).await.unwrap();
        assert!(!state.connect_cancels.read().await.contains_key(&cfg.id.to_string()));
        assert!(!cancel_connect_inner(cfg.id, &state).await);
        close_one_session(sid, &state).await;
    }

    /// A quiet (ephemeral) open never registers — several can run for the same
    /// connection at once, and no sidebar badge is waiting on them.
    #[tokio::test]
    async fn ephemeral_opens_never_register_a_cancel() {
        let state = test_state().await;
        let cfg = scratch_config();
        let sid = open_ephemeral_session(&cfg, &state).await.unwrap();
        assert!(!state.connect_cancels.read().await.contains_key(&cfg.id.to_string()));
        teardown_ephemeral_session(&state, sid, "k").await;
    }

    /// The real race: a dial that cannot be interrupted (sqlx waiting on a
    /// server that accepts TCP but never speaks) is cancelled mid-flight. The
    /// open returns a clean `cancelled` error, no session or registration is
    /// left behind, and a reaper — not the test — owns the late arrival.
    #[tokio::test]
    async fn cancel_during_the_driver_dial_returns_cancelled_and_cleans_up() {
        let state = test_state().await;
        // A listener that accepts (TCP connect succeeds) but never sends the
        // MySQL handshake: the dial hangs until the connect timeout.
        let blackhole = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = blackhole.local_addr().unwrap().port();

        let mut cfg = ConnectionConfig::new(Engine::Mysql, "cancel-me");
        cfg.host = Some("127.0.0.1".into());
        cfg.port = Some(port);
        cfg.connect_timeout_secs = Some(30); // long: without cancel this hangs

        let st = state.clone();
        let cfg2 = cfg.clone();
        let opening = tokio::spawn(async move { open_session_for_config(&cfg2, &st).await });

        // Wait until the open has actually registered its cancel handle.
        for _ in 0..50 {
            if state.connect_cancels.read().await.contains_key(&cfg.id.to_string()) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(cancel_connect_inner(cfg.id, &state).await, "a connect is in flight");

        let err = tokio::time::timeout(std::time::Duration::from_secs(5), opening)
            .await.expect("the open must end promptly after cancel")
            .expect("task joined")
            .expect_err("a cancelled connect is not a success");
        assert_eq!(err.code.as_str(), "cancelled", "got: {}", err.message);

        assert!(state.sessions.read().await.is_empty(), "no session may land");
        assert!(state.connect_cancels.read().await.is_empty(), "registration removed");
        // A cancelled connect is audited as such (loud opens only).
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT error FROM audit_log WHERE sql = 'connect failed'")
            .fetch_all(&state.history).await.unwrap();
        assert_eq!(rows, ["Connect cancelled by user"], "the cancel itself is audited");

        drop(blackhole);
    }

    /// Live: cancel a real connect (e.g. a slow SSH-tunneled one) mid-flight.
    ///   TXUI_TEST_CONN=Lo80 cargo test --lib connections -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn cancel_connect_live() {
        let Ok(name) = std::env::var("TXUI_TEST_CONN") else { return };
        let dir = crate::storage::default_data_dir();
        let configs = crate::storage::load(&dir).expect("read connections.json");
        let config = configs.values().find(|c| c.name == name).expect("connection not found").clone();
        let history = crate::history::open_in_memory().await.expect("in-memory history");
        let state = AppState::new(history, dir.clone(), configs.clone());

        let st = state.clone();
        let cfg = config.clone();
        let opening = tokio::spawn(async move { open_session_for_config(&cfg, &st).await });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let was_in_flight = cancel_connect_inner(config.id, &state).await;
        let outcome = opening.await.expect("task joined");
        eprintln!("cancel fired: {was_in_flight}; outcome: {outcome:?}");
        if was_in_flight {
            let err = outcome.expect_err("a signalled connect must not succeed");
            assert_eq!(err.code.as_str(), "cancelled");
            assert!(state.sessions.read().await.is_empty());
        }
    }


    /// Quiet open: no session_starts record, no audit rows — but the guard
    /// registration (session_meta) is NOT skipped, or an ephemeral session
    /// would slip past the read-only/prod border. The loud open keeps both.    #[tokio::test]
    async fn ephemeral_open_is_quiet_regular_open_is_audited() {
        let state = test_state().await;
        let cfg = scratch_config();

        let quiet = open_ephemeral_session(&cfg, &state).await.unwrap();
        assert!(!state.session_starts.read().await.contains_key(&quiet),
            "a seconds-long session must not leave a start record");
        assert!(state.session_meta.read().await.contains_key(&quiet),
            "the guard must still apply to an ephemeral session");

        let loud = open_session_for_config(&cfg, &state).await.unwrap();
        assert!(state.session_starts.read().await.contains_key(&loud));

        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT sql FROM audit_log ORDER BY id")
            .fetch_all(&state.history).await.unwrap();
        assert_eq!(rows, ["connect"], "only the loud open is audited");

        teardown_ephemeral_session(&state, quiet, "k-quiet").await;
        teardown_ephemeral_session(&state, loud, "k-loud").await;
    }

    /// The factored teardown must clean EVERY registry a session can touch —
    /// the six consumers used to drop a four-item subset and leaked
    /// session_starts / session_dbs / redis_catalogs. Driven against a real
    /// (in-memory DuckDB) session so the pool close is exercised too.
    #[tokio::test]
    async fn teardown_ephemeral_session_cleans_every_registry() {
        let state = test_state().await;
        let cfg = scratch_config();
        let session_id = open_ephemeral_session(&cfg, &state).await.unwrap();

        // Seed every registry the session could have accumulated. (Tunnels
        // can't be seeded without spawning a real ssh child; that removal is
        // one `remove` on a HashMap, covered by close_connection's path.)
        state.session_dbs.write().await.insert(session_id, "db".into());
        state.session_starts.write().await
            .insert(session_id, crate::commands::audit::session_start(&cfg));
        state.redis_catalogs.write().await
            .insert(session_id, std::sync::Arc::new(crate::redisguard::CommandCatalog::baseline()));

        teardown_ephemeral_session(&state, session_id, "multi-x").await;

        assert!(connection::get_session_pub(session_id, &state.sessions).await.is_err());
        assert!(!state.session_meta.read().await.contains_key(&session_id));
        assert!(!state.session_dbs.read().await.contains_key(&session_id));
        assert!(!state.session_starts.read().await.contains_key(&session_id));
        assert!(!state.redis_catalogs.read().await.contains_key(&session_id));
        // Teardown wrote no audit row (a quiet session wrote none at open).
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
            .fetch_one(&state.history).await.unwrap();
        assert_eq!(n, 0);
    }

    /// Test-while-editing: the form's blank password field means "the stored
    /// one" for a connection that exists in storage, and "nothing" for a new
    /// one. An explicitly typed password always wins.
    #[test]
    fn test_secret_falls_back_to_the_store_only_for_saved_connections() {
        let stored = Some("stored".to_string());
        // Blank/None arg on a saved connection → stored secret.
        assert_eq!(resolve_test_secret(None, stored.clone(), true).as_deref(), Some("stored"));
        assert_eq!(resolve_test_secret(Some("  ".into()), stored.clone(), true).as_deref(), Some("stored"));
        // Typed value wins, even blank-looking whitespace is filtered first.
        assert_eq!(resolve_test_secret(Some("typed".into()), stored.clone(), true).as_deref(), Some("typed"));
        // Unsaved connection: no fallback, whatever the store holds.
        assert_eq!(resolve_test_secret(None, stored.clone(), false), None);
        // Saved but the store is empty: honestly nothing.
        assert_eq!(resolve_test_secret(None, None, true), None);
    }

    /// The deadline-abandoned connect, replayed on a scratch session: a
    /// session that arrived during the attempt is closed (with its
    /// 'disconnect' audit row), an older session of the same connection and
    /// any session of another connection survive, and a no-op call is Ok(0).
    #[tokio::test]
    async fn close_orphaned_connection_closes_only_the_late_arrival() {
        let state = test_state().await;
        let cfg = scratch_config();

        // An "old" session: opened (well) before the attempt started. Its
        // start record is backdated so the age filter must spare it.
        let old = open_session_for_config(&cfg, &state).await.unwrap();
        state.session_starts.write().await.get_mut(&old).unwrap().at =
            std::time::Instant::now() - std::time::Duration::from_secs(3600);

        // The attempt "started 3 s ago"; the abandoned open lands now.
        let orphan = open_session_for_config(&cfg, &state).await.unwrap();

        let closed = close_orphaned(cfg.id, 3_000, Some(0), &state).await;
        assert_eq!(closed, 1, "only the late arrival is an orphan");
        assert!(connection::get_session_pub(orphan, &state.sessions).await.is_err());
        assert!(connection::get_session_pub(old, &state.sessions).await.is_ok(),
            "the pre-existing session must survive");

        // The orphan's open wrote a 'connect' row; its cleanup wrote the
        // matching 'disconnect'.
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT sql FROM audit_log ORDER BY id")
            .fetch_all(&state.history).await.unwrap();
        assert_eq!(rows.iter().filter(|s| s.as_str() == "disconnect").count(), 1);

        // No matching session → a no-op, and another connection's sessions
        // are never in scope.
        assert_eq!(close_orphaned(cfg.id, 3_000, Some(0), &state).await, 0);
        assert_eq!(close_orphaned(Uuid::new_v4(), 600_000, Some(0), &state).await, 0);

        close_one_session(old, &state).await;
    }

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

    // ── W5.1 password-exec resolution ───────────────────────────────────────

    /// A data dir unique to this test — secretstore writes real files, and the
    /// shared temp_dir would leak state between tests.
    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir()
            .join(format!("txui-conn-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Resolution order: typed > password-exec > stored (saved only).
    #[tokio::test]
    async fn test_password_resolution_order() {
        let dir = unique_dir("pworder");

        // No exec, saved config with a stored secret → stored (W2.3).
        let mut c = ConnectionConfig::new(Engine::Postgres, "t");
        crate::secretstore::set(&dir, &c.keychain_key(), "stored-pw").unwrap();
        assert_eq!(resolve_test_password(&c, None, &dir).await.unwrap().as_deref(), Some("stored-pw"));
        // Blank/whitespace arg behaves like None.
        assert_eq!(resolve_test_password(&c, Some("  ".into()), &dir).await.unwrap().as_deref(), Some("stored-pw"));
        // Typed wins over the store.
        assert_eq!(resolve_test_password(&c, Some("typed".into()), &dir).await.unwrap().as_deref(), Some("typed"));

        // password-exec wins over the store (and works for an UNSAVED config).
        c.password_exec = Some("echo minted".into());
        assert_eq!(resolve_test_password(&c, None, &dir).await.unwrap().as_deref(), Some("minted"));
        c.id = Uuid::nil(); // adhoc, never saved — the command still runs
        assert_eq!(resolve_test_password(&c, None, &dir).await.unwrap().as_deref(), Some("minted"));

        // A failing exec is an ERROR, never a silent fall-back to the store.
        let mut c = ConnectionConfig::new(Engine::Postgres, "t");
        crate::secretstore::set(&dir, &c.keychain_key(), "stored-pw").unwrap();
        c.password_exec = Some("exit 7".into());
        let err = resolve_test_password(&c, None, &dir).await.unwrap_err();
        assert!(err.contains("exit 7"), "{err}");

        // Unsaved, no exec, no arg → honestly nothing.
        let mut c = ConnectionConfig::new(Engine::Postgres, "t");
        c.id = Uuid::nil();
        assert_eq!(resolve_test_password(&c, None, &dir).await.unwrap(), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// resolve_db_password: exec when set, else the stored secret.
    #[tokio::test]
    async fn db_password_prefers_the_exec_command_then_the_store() {
        let dir = unique_dir("dbpw");
        let c = ConnectionConfig::new(Engine::Mysql, "t");
        crate::secretstore::set(&dir, &c.keychain_key(), "stored-pw").unwrap();
        assert_eq!(resolve_db_password(&c, &dir).await.unwrap().as_deref(), Some("stored-pw"));
        let mut c2 = c.clone();
        c2.password_exec = Some("echo minted2".into());
        assert_eq!(resolve_db_password(&c2, &dir).await.unwrap().as_deref(), Some("minted2"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── W5.4 database listing ───────────────────────────────────────────────

    #[test]
    fn list_databases_sql_is_the_canonical_query_per_engine() {
        assert_eq!(list_databases_sql(Engine::Mysql), Some("SHOW DATABASES"));
        assert_eq!(list_databases_sql(Engine::Postgres),
            Some("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname"));
        assert_eq!(list_databases_sql(Engine::SqlServer),
            Some("SELECT name FROM sys.databases ORDER BY name"));
        assert_eq!(list_databases_sql(Engine::Clickhouse), Some("SHOW DATABASES"));
        // Driver API, not SQL — and the engines where the question is
        // meaningless.
        for e in [Engine::MongoDb, Engine::Redis, Engine::Sqlite, Engine::Parquet, Engine::Duckdb] {
            assert_eq!(list_databases_sql(e), None, "{e:?}");
        }
    }

    #[test]
    fn databases_not_applicable_marks_exactly_the_picker_greyed_engines() {
        for e in [Engine::Redis, Engine::Sqlite, Engine::Parquet, Engine::Duckdb] {
            assert!(databases_not_applicable(e), "{e:?}");
        }
        for e in [Engine::Mysql, Engine::Postgres, Engine::Clickhouse, Engine::MongoDb, Engine::SqlServer] {
            assert!(!databases_not_applicable(e), "{e:?}");
        }
    }

    /// The command refuses the not-applicable engines with the error text the
    /// frontend keys on, before any dial is attempted.
    #[tokio::test]
    async fn connect_list_databases_refuses_file_engines_and_redis() {
        let state = test_state().await;
        for engine in [Engine::Redis, Engine::Sqlite, Engine::Parquet, Engine::Duckdb] {
            let mut c = ConnectionConfig::new(engine, "x");
            if engine.is_file_backed() { c.file_path = Some(":memory:".into()); }
            let err = connect_list_databases_body(c, None, &state).await.unwrap_err();
            assert!(err.message.contains("not applicable"), "{engine:?}: {}", err.message);
        }
    }

    // ── W5.2 encrypted export/import ────────────────────────────────────────

    /// Full command-level round trip: export seals configs + secrets, import
    /// mints fresh ids, re-keys the secrets into the (plain-mode) secretstore,
    /// and persists the configs. Wrong passphrase imports nothing.
    #[tokio::test]
    async fn encrypted_export_import_round_trip_with_fresh_ids() {
        let dir = unique_dir("encxp");
        let history = crate::history::open_in_memory().await.unwrap();
        let mut seed = std::collections::HashMap::new();
        let mut c = ConnectionConfig::new(Engine::Postgres, "prod-eu");
        c.user = Some("app".into());
        seed.insert(c.id, c.clone());
        let state = AppState::new(history, dir.clone(), seed);
        crate::secretstore::set(&dir, &c.keychain_key(), "the-password").unwrap();
        crate::secretstore::set(&dir, &c.ssh_keychain_key(), "the-ssh-password").unwrap();

        // Export (all).
        let sealed = export_connections_encrypted_body(None, "a-good-passphrase".into(), &state)
            .await.unwrap();
        assert!(sealed.contains("\"v\": 1"), "{sealed}");
        assert!(!sealed.contains("the-password"), "no plaintext secret in the export");

        // Import into the SAME state: fresh ids, so both generations coexist.
        let n = import_connections_encrypted_body(sealed.clone(), "a-good-passphrase".into(), &state)
            .await.unwrap();
        assert_eq!(n, 1);
        let all = state.configs.read().await;
        assert_eq!(all.len(), 2);
        let imported = all.values().find(|x| x.id != c.id).expect("the fresh-id import");
        assert_eq!(imported.name, "prod-eu");
        // Secrets re-keyed to the fresh id and readable from the active store.
        assert_eq!(crate::secretstore::get(&dir, &imported.keychain_key()).as_deref(), Some("the-password"));
        assert_eq!(crate::secretstore::get(&dir, &imported.ssh_keychain_key()).as_deref(), Some("the-ssh-password"));
        drop(all);

        // Wrong passphrase: clean error, nothing imported.
        let err = import_connections_encrypted_body(sealed, "wrong-passphrase".into(), &state)
            .await.unwrap_err();
        assert!(err.message.contains("wrong passphrase"), "{}", err.message);
        assert_eq!(state.configs.read().await.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
