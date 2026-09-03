/// Dump / restore via external CLI tools (mysqldump, mydumper/myloader,
/// pg_dump/pg_restore, mysql, psql) with a visible generated command,
/// streamed output, and cancellation.
///
/// Security posture:
/// - Only allowlisted binaries can be spawned.
/// - The password never appears in argv — it is passed via MYSQL_PWD /
///   PGPASSWORD, so it is invisible in `ps` and in the command preview.
/// - Write-side tools (restore) are refused for read-only connections.
use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::db::types::Engine;
use crate::state::AppState;

/// Binaries this module is allowed to spawn, with their DB-write side.
const TOOLS: &[(&str, bool)] = &[
    ("mysqldump",  false),
    ("mydumper",   false),
    ("pg_dump",    false),
    ("mysql",      true),
    ("myloader",   true),
    ("pg_restore", true),
    ("psql",       true),
];

fn is_write_tool(tool: &str) -> bool {
    TOOLS.iter().any(|(t, w)| *t == tool && *w)
}

/// GUI apps on macOS inherit launchd's minimal PATH — Homebrew/MacPorts dirs
/// must be added or none of these tools resolve. Those dirs are unix-only;
/// elsewhere PATH (split portably via `split_paths`) is all we search.
fn search_dirs() -> Vec<PathBuf> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    #[cfg(unix)]
    {
        for extra in [
            "/opt/homebrew/bin",
            "/opt/homebrew/opt/mysql-client/bin",
            "/opt/homebrew/opt/libpq/bin",
            "/usr/local/bin",
            "/usr/local/opt/mysql-client/bin",
            "/usr/local/opt/libpq/bin",
            "/opt/local/bin",
        ] {
            let p = PathBuf::from(extra);
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
        // Keg-only versioned formulas (postgresql@16, mysql-client@8.4, …) are
        // never linked into <prefix>/bin — scan <prefix>/opt for their bin dirs.
        // Sort numerically on the @version so postgresql@16 beats postgresql@9.6
        // (plain lexicographic order would rank 9.6 above 16).
        fn keg_version(name: &str) -> Vec<u32> {
            name.split('@').nth(1).unwrap_or("")
                .split('.')
                .filter_map(|p| p.parse().ok())
                .collect()
        }
        for prefix in ["/opt/homebrew/opt", "/usr/local/opt"] {
            if let Ok(entries) = std::fs::read_dir(prefix) {
                let mut kegs: Vec<(String, PathBuf)> = entries
                    .flatten()
                    .filter(|e| {
                        let n = e.file_name();
                        let n = n.to_string_lossy();
                        n.starts_with("postgresql@") || n.starts_with("mysql-client@")
                            || n.starts_with("mysql@") || n.starts_with("mydumper@")
                    })
                    .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path().join("bin")))
                    .collect();
                kegs.sort_by(|a, b| keg_version(&b.0).cmp(&keg_version(&a.0)).then(a.0.cmp(&b.0)));
                for (_, p) in kegs {
                    if !dirs.contains(&p) {
                        dirs.push(p);
                    }
                }
            }
        }
    }
    dirs
}

/// Filenames a tool may resolve to — Windows needs the executable extension.
fn candidate_names(tool: &str) -> Vec<String> {
    #[cfg(windows)]
    { vec![format!("{tool}.exe"), format!("{tool}.bat"), tool.to_string()] }
    #[cfg(not(windows))]
    { vec![tool.to_string()] }
}

fn is_executable_file(p: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false; };
    if !meta.is_file() { return false; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        // No executable bit to check — existence of the (correctly suffixed)
        // file is the best cheap signal.
        true
    }
}

fn resolve_binary(tool: &str) -> Option<PathBuf> {
    for dir in search_dirs() {
        for name in candidate_names(tool) {
            let candidate = dir.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Short platform-aware "how to install" hint for the not-found error.
fn install_hint(tool: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        let pkg = match tool {
            "mydumper" | "myloader" => "mydumper",
            "mysqldump" | "mysql"   => "mysql-client",
            _ => "libpq",
        };
        format!("install it (e.g. `brew install {pkg}`) or add it to PATH")
    }
    #[cfg(target_os = "linux")]
    {
        let pkg = match tool {
            "mydumper" | "myloader" => "mydumper",
            "mysqldump" | "mysql"   => "mysql-client",
            _ => "postgresql-client",
        };
        format!("install it (e.g. `sudo apt install {pkg}` or `sudo dnf install {pkg}`) or add it to PATH")
    }
    #[cfg(target_os = "windows")]
    {
        format!("install the client tools providing {tool} (MySQL Installer / PostgreSQL installer or ZIP) and add their `bin` dir to PATH")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        format!("install the database client tools providing {tool} or add it to PATH")
    }
}

// ── Probing ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ToolInfo {
    pub tool:    String,
    pub path:    Option<String>,
    pub version: Option<String>,
}

/// Detect which dump/restore binaries exist and their versions.
#[tauri::command]
pub async fn probe_dump_tools() -> Result<Vec<ToolInfo>, crate::apperror::AppError> {
    let mut out = Vec::with_capacity(TOOLS.len());
    for (tool, _) in TOOLS {
        let path = resolve_binary(tool);
        let version = match &path {
            Some(p) => tokio::process::Command::new(p)
                .arg("--version")
                .output()
                .await
                .ok()
                .and_then(|o| {
                    let text = if o.stdout.is_empty() { o.stderr } else { o.stdout };
                    String::from_utf8_lossy(&text)
                        .lines()
                        .next()
                        .map(|l| l.trim().to_string())
                }),
            None => None,
        };
        out.push(ToolInfo {
            tool: tool.to_string(),
            path: path.map(|p| p.display().to_string()),
            version,
        });
    }
    Ok(out)
}

// ── Execution ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolEvent {
    /// Process spawned. `display_cmd` is the fully resolved command with the
    /// password omitted (it is never in argv anyway).
    Started { pid: Option<u32>, display_cmd: String },
    Line    { stream: String, line: String },
    Done    { ok: bool, exit_code: Option<i32>, ms: u64, cancelled: bool },
}

fn get_password(config: &crate::db::types::ConnectionConfig, data_dir: &std::path::Path) -> Option<String> {
    crate::secretstore::get(data_dir, &config.keychain_key())
}

/// Run one allowlisted external tool against a saved connection.
///
/// `args` may contain `{{host}}` / `{{port}}` placeholders — they are resolved
/// here (to the SSH tunnel endpoint when the connection uses one, which is
/// opened for the duration of the run). `stdin_file` streams a file into the
/// process (mysql/psql plain-SQL restore).
#[tauri::command]
pub async fn run_dump_tool(
    connection_id: Uuid,
    tool: String,
    args: Vec<String>,
    stdin_file: Option<String>,
    run_key: String,
    on_event: Channel<ToolEvent>,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    if !TOOLS.iter().any(|(t, _)| *t == tool) {
        return Err(format!("'{tool}' is not an allowed dump/restore tool").into());
    }
    let config = state.configs.read().await.get(&connection_id).cloned()
        .ok_or_else(|| format!("connection {connection_id} not found"))?;
    if matches!(config.engine, Engine::Redis | Engine::Clickhouse | Engine::MongoDb | Engine::SqlServer)
        || config.engine.is_file_backed()
    {
        return Err(format!(
            "dump/restore is not supported for {:?} connections", config.engine
        ).into());
    }
    if config.read_only && is_write_tool(&tool) {
        return Err(format!(
            "'{}' is read-only — restore with {} is blocked", config.name, tool
        ).into());
    }
    // Register the cancel handle BEFORE any slow work (tunnel open can take
    // seconds) — a cancel arriving during startup must not be a silent no-op,
    // especially for write-side restores. The entry is removed on every exit
    // path via the wrapper below. Keyed by connection (dump has no session —
    // it works straight from the config), which keeps run keys unique across
    // connections; `cancel_dump_tool` resolves the bare key via take_ext_job.
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let job_key = crate::state::ext_job_key(connection_id, &run_key);
    state.ext_jobs.write().await.insert(job_key.clone(), cancel_tx);

    let result = run_tool_inner(&config, &tool, args, stdin_file, &on_event, &mut cancel_rx, &state.data_dir).await;
    state.ext_jobs.write().await.remove(&job_key);
    result
}

/// The cancellable body of `run_dump_tool` — factored out so the ext_jobs
/// entry is always removed regardless of which early return fires.
async fn run_tool_inner(
    config: &crate::db::types::ConnectionConfig,
    tool: &str,
    args: Vec<String>,
    stdin_file: Option<String>,
    on_event: &Channel<ToolEvent>,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    data_dir: &std::path::Path,
) -> Result<(), crate::apperror::AppError> {
    let started = std::time::Instant::now();
    // Emits a cancelled Done event; used for cancels that land before spawn.
    let cancelled_early = |ms: u64| {
        let _ = on_event.send(ToolEvent::Done { ok: false, exit_code: None, ms, cancelled: true });
        Ok(())
    };

    let bin = resolve_binary(tool)
        .ok_or_else(|| format!("{tool} not found — {}", install_hint(tool)))?;

    // SSH tunnel (kept alive until the process exits) + endpoint resolution.
    let db_host = config.host.clone().unwrap_or_else(|| "localhost".into());
    let db_port = config.port.unwrap_or(config.engine.default_port());
    let tunnel = if config.use_ssh {
        let ssh_host = config.ssh_host.as_deref()
            .ok_or("SSH host is required when tunnel is enabled")?;
        let ssh_user = config.ssh_user.as_deref()
            .ok_or("SSH user is required when tunnel is enabled")?;
        let ssh_password = if config.use_ssh_password {
            crate::secretstore::get(data_dir, &config.ssh_keychain_key())
        } else {
            None
        };
        let opened = tokio::select! {
            t = crate::db::ssh::SshTunnel::open(
                ssh_host, config.ssh_port.unwrap_or(22), ssh_user,
                config.ssh_key_path.as_deref(), &db_host, db_port,
                config.ssh_jump.as_deref(), ssh_password.as_deref(),
            ) => t.map_err(|e| format!("SSH tunnel failed:\n{e:#}"))?,
            _ = &mut *cancel_rx => {
                return cancelled_early(started.elapsed().as_millis() as u64);
            }
        };
        Some(opened)
    } else {
        None
    };
    // Last pre-spawn checkpoint: a cancel that raced the steps above must win
    // before the process starts.
    if cancel_rx.try_recv().is_ok() {
        return cancelled_early(started.elapsed().as_millis() as u64);
    }
    let (host, port) = match &tunnel {
        Some(t) => ("127.0.0.1".to_string(), t.local_port),
        None    => (db_host, db_port),
    };

    let resolved: Vec<String> = args.iter()
        .map(|a| a.replace("{{host}}", &host).replace("{{port}}", &port.to_string()))
        .collect();

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(&resolved)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(match &stdin_file {
            Some(f) => std::process::Stdio::from(
                std::fs::File::open(f).map_err(|e| format!("cannot open {f}: {e}"))?),
            None => std::process::Stdio::null(),
        });
    // Password via env only — never argv.
    if let Some(pw) = get_password(config, data_dir) {
        match config.engine {
            Engine::Mysql    => { cmd.env("MYSQL_PWD", &pw); }
            Engine::Postgres => { cmd.env("PGPASSWORD", &pw); }
            // Rejected at the top of this function. Not `unreachable!()`:
            // this is a Tauri command, callable with any engine, and a panic
            // in the backend is a far worse outcome than an error string.
            Engine::Redis | Engine::Clickhouse | Engine::Sqlite | Engine::Parquet
            | Engine::Duckdb | Engine::MongoDb | Engine::SqlServer => {
                return Err("dump/restore is not supported for this engine".into());
            }
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("failed to start {tool}: {e}"))?;

    let display_cmd = {
        let mut s = bin.display().to_string();
        for a in &resolved {
            s.push(' ');
            if a.contains(' ') { s.push_str(&format!("'{a}'")); } else { s.push_str(a); }
        }
        if let Some(f) = &stdin_file { s.push_str(&format!(" < {f}")); }
        s
    };
    let _ = on_event.send(ToolEvent::Started { pid: child.id(), display_cmd });

    // Line streamers — a task per stream, feeding the same channel.
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        let ch = on_event.clone();
        readers.push(tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch.send(ToolEvent::Line { stream: "stdout".into(), line });
            }
        }));
    }
    if let Some(err) = child.stderr.take() {
        let ch = on_event.clone();
        readers.push(tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch.send(ToolEvent::Line { stream: "stderr".into(), line });
            }
        }));
    }

    // Cancellation: kill the child when the frontend fires cancel_dump_tool.
    let (status, cancelled) = tokio::select! {
        st = child.wait() => (st, false),
        _ = &mut *cancel_rx => {
            let _ = child.kill().await;
            (child.wait().await, true)
        }
    };
    for r in readers { let _ = r.await; }
    drop(tunnel); // close the SSH tunnel only after the tool exited

    let ms = started.elapsed().as_millis() as u64;
    match status {
        Ok(st) => {
            let _ = on_event.send(ToolEvent::Done {
                ok: st.success() && !cancelled,
                exit_code: st.code(),
                ms,
                cancelled,
            });
            Ok(())
        }
        Err(e) => {
            let _ = on_event.send(ToolEvent::Done { ok: false, exit_code: None, ms, cancelled });
            Err(format!("{tool} wait failed: {e}").into())
        }
    }
}

/// Kill a running dump/restore process (best-effort).
#[tauri::command]
pub async fn cancel_dump_tool(run_key: String, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    if let Some(tx) = crate::state::take_ext_job(&state.ext_jobs, &run_key).await {
        let _ = tx.send(());
    }
    Ok(())
}
