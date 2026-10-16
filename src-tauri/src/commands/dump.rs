/// Dump / restore via external CLI tools (mysqldump / mariadb-dump,
/// mydumper/myloader, pg_dump/pg_restore, mysql / mariadb, psql) with a
/// visible generated command, streamed output, and cancellation.
///
/// Security posture:
/// - Only allowlisted binaries can be spawned.
/// - The password never appears in argv — it is passed via MYSQL_PWD /
///   PGPASSWORD, so it is invisible in `ps` and in the command preview.
/// - Write-side tools (restore) are refused for read-only connections.
/// - The renderer-supplied argv is validated before spawn (see the "Argv
///   validation" section): the process carries the connection's password in
///   its environment, so an argv that re-points `-h`/`--host` at an attacker
///   host would ship the auth handshake there. Validation guarantees the tool
///   can only ever talk to the session's own server, as the connection's own
///   user. It does NOT try to make a restore's SQL safe — `mysql`/`psql`
///   execute whatever is in the dump file, gated by the read-only block.
use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::db::types::Engine;
use crate::state::AppState;

/// Binaries this module is allowed to spawn, with their DB-write side.
///
/// mariadb-dump / mariadb are the MariaDB-native names (the mysqldump/mysql
/// symlinks are deprecated since MariaDB 11.4). There is no mariadb-loader:
/// the mydumper project ships myloader under that name only. Flavor is not
/// knowable here (the panel works from saved configs, no live session), so
/// both namings are accepted for a MySQL-family connection.
const TOOLS: &[(&str, bool)] = &[
    ("mysqldump",    false),
    ("mariadb-dump", false),
    ("mydumper",     false),
    ("pg_dump",      false),
    ("mysql",        true),
    ("mariadb",      true),
    ("myloader",     true),
    ("pg_restore",   true),
    ("psql",         true),
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
                            || n.starts_with("mysql@") || n.starts_with("mariadb@")
                            || n.starts_with("mydumper@")
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
            "mydumper" | "myloader"     => "mydumper",
            "mysqldump" | "mysql"       => "mysql-client",
            "mariadb-dump" | "mariadb"  => "mariadb",
            _ => "libpq",
        };
        format!("install it (e.g. `brew install {pkg}`) or add it to PATH")
    }
    #[cfg(target_os = "linux")]
    {
        let pkg = match tool {
            "mydumper" | "myloader"     => "mydumper",
            "mysqldump" | "mysql"       => "mysql-client",
            "mariadb-dump" | "mariadb"  => "mariadb-client",
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

// ── Argv validation ─────────────────────────────────────────────────────────
//
// The panel builds argv from structured options plus a free-text extra-args
// field, so a fully structured command API would cost the panel that
// flexibility. Instead the boundary is enforced here, on the resolved argv:
//
// - connection-target flags (host/port/user, in each tool's spelling) are
//   allowed ONLY with the session's own resolved endpoint and user — a
//   mismatch is rejected;
// - password flags are always rejected (env only, never argv);
// - option-file flags (--defaults-file, --login-path, …) are rejected — they
//   can silently re-point the target or inject flags;
// - every other flag must be on the tool's allowlist below. Unknown flags
//   are rejected, which also keeps TLS-weakening options (--ssl-mode=…) out;
// - positional arguments (database, tables, file paths) pass unchecked, with
//   one exception: for the libpq tools a positional can BE a conninfo string
//   or postgres:// URI (pg_dump/psql treat the database argument that way),
//   so anything conninfo-shaped is rejected there.

/// What a flag does with the connection, and whether it swallows a value.
#[derive(Clone, Copy, PartialEq)]
enum FlagKind {
    /// No value (an `=value` suffix is still tolerated — `--column-statistics=0`).
    Bool,
    /// Takes a value, separate token or `=`-joined.
    Value,
    /// Host: value must equal the session's resolved host.
    Host,
    /// Port: value must equal the session's resolved port.
    Port,
    /// User: value must equal the connection's user.
    User,
    /// Database name (libpq): value must not be a conninfo string / URI.
    DbName,
}

fn mysql_conn_flags() -> &'static [(&'static str, FlagKind)] {
    &[("h", FlagKind::Host), ("host", FlagKind::Host),
      ("u", FlagKind::User), ("user", FlagKind::User),
      ("P", FlagKind::Port), ("port", FlagKind::Port)]
}

fn pg_conn_flags() -> &'static [(&'static str, FlagKind)] {
    &[("h", FlagKind::Host), ("host", FlagKind::Host),
      ("U", FlagKind::User), ("username", FlagKind::User),
      ("p", FlagKind::Port), ("port", FlagKind::Port),
      ("d", FlagKind::DbName), ("dbname", FlagKind::DbName),
      // The panel emits this so a script never blocks on a password prompt;
      // the password is already in PGPASSWORD.
      ("w", FlagKind::Bool), ("no-password", FlagKind::Bool)]
}

/// The per-tool allowlist: connection flags plus the flags the panel emits
/// and the common extras worth typing into the free-text field. Anything not
/// listed is rejected.
fn allow_table(tool: &str) -> Vec<(&'static str, FlagKind)> {
    use FlagKind::{Bool as B, Value as V, DbName as D};
    let mut t: Vec<(&'static str, FlagKind)> = Vec::new();
    match tool {
        "mysqldump" | "mariadb-dump" | "mysql" | "mariadb" | "mydumper" | "myloader" =>
            t.extend_from_slice(mysql_conn_flags()),
        _ => t.extend_from_slice(pg_conn_flags()),
    }
    t.extend_from_slice(match tool {
        "mysqldump" | "mariadb-dump" => &[
            ("single-transaction", B), ("routines", B), ("R", B), ("triggers", B),
            ("events", B), ("E", B), ("no-data", B), ("d", B), ("quick", B), ("q", B),
            ("result-file", V), ("r", V), ("lock-tables", B), ("no-create-info", B), ("t", B),
            ("complete-insert", B), ("c", B), ("extended-insert", B), ("e", B),
            ("skip-extended-insert", B), ("hex-blob", B), ("comments", B), ("skip-comments", B),
            ("dump-date", B), ("skip-dump-date", B), ("compact", B),
            ("databases", B), ("B", B), ("all-databases", B), ("A", B),
            ("order-by-primary", B), ("quote-names", B), ("Q", B), ("skip-quote-names", B),
            ("replace", B), ("no-tablespaces", B), ("y", B), ("flush-logs", B),
            ("force", B), ("f", B), ("verbose", B), ("v", B),
            ("where", V), ("w", V), ("max-allowed-packet", V), ("net-buffer-length", V),
            ("set-gtid-purged", V), ("ignore-table", V), ("default-character-set", V),
            ("compatible", V), ("master-data", B), ("column-statistics", B),
        ][..],
        "mysql" | "mariadb" => &[
            ("force", B), ("f", B), ("verbose", B), ("v", B), ("show-warnings", B),
            ("binary-mode", B), ("compress", B), ("C", B), ("quick", B), ("q", B),
            ("batch", B), ("B", B), ("database", D), ("D", D),
            ("default-character-set", V), ("max-allowed-packet", V),
        ][..],
        "mydumper" => &[
            ("outputdir", V), ("o", V), ("threads", V), ("t", V),
            ("verbose", V), ("v", V), ("database", D), ("B", D),
            ("rows", V), ("regex", V),
            ("compress", B), ("trx-consistency-only", B), ("less-locking", B),
            ("no-locks", B), ("no-backup-locks", B), ("skip-tz-utc", B),
        ][..],
        "myloader" => &[
            ("directory", V), ("d", V), ("threads", V), ("t", V),
            ("verbose", V), ("v", V), ("database", D), ("B", D),
            ("overwrite-tables", B),
        ][..],
        "pg_dump" => &[
            ("format", V), ("F", V), ("file", V), ("f", V), ("jobs", V), ("j", V),
            ("table", V), ("t", V), ("exclude-table", V), ("T", V),
            ("schema", V), ("n", V), ("exclude-schema", V), ("N", V),
            ("schema-only", B), ("s", B), ("no-owner", B), ("O", B),
            ("no-privileges", B), ("x", B), ("clean", B), ("c", B), ("if-exists", B),
            ("create", B), ("C", B), ("data-only", B), ("a", B), ("inserts", B),
            ("verbose", B), ("v", B), ("quote-all-identifiers", B),
            ("serializable-deferrable", B), ("no-comments", B),
        ][..],
        "pg_restore" => &[
            ("jobs", V), ("j", V),
            ("clean", B), ("if-exists", B), ("no-owner", B), ("O", B),
            ("verbose", B), ("v", B), ("data-only", B), ("a", B),
            ("schema-only", B), ("s", B), ("exit-on-error", B),
            ("single-transaction", B), ("1", B), ("no-comments", B),
        ][..],
        "psql" => &[
            ("file", V), ("f", V), ("set", V), ("variable", V), ("v", V),
            ("single-transaction", B), ("1", B), ("echo-errors", B),
            ("quiet", B), ("q", B),
        ][..],
        _ => &[][..],
    });
    t
}

/// Flags rejected even before the allowlist, with the reason the user sees.
fn reject_table(tool: &str) -> &'static [(&'static str, &'static str)] {
    const PW: &str = "the password is passed via env (MYSQL_PWD / PGPASSWORD) — never on the command line";
    const REPOINT: &str = "it can re-point the tool away from this connection's server";
    match tool {
        "mysqldump" | "mariadb-dump" | "mysql" | "mariadb" | "mydumper" | "myloader" => &[
            ("p", PW), ("password", PW),
            ("S", REPOINT), ("socket", REPOINT),
            ("defaults-file", REPOINT), ("defaults-extra-file", REPOINT),
            ("defaults-group-suffix", REPOINT), ("login-path", REPOINT),
            ("print-defaults", REPOINT),
        ][..],
        _ => &[
            ("W", PW), ("password", PW),
        ][..],
    }
}

/// libpq accepts a conninfo string or postgres:// URI anywhere a database
/// name goes — which would re-point the connection. `-v NAME=VALUE` values
/// are exempt (they legitimately contain '='), so this is applied only to
/// DbName values and to positional tokens of pg_dump/psql.
fn looks_like_conninfo(v: &str) -> bool {
    v.contains('=') || v.starts_with("postgres://") || v.starts_with("postgresql://")
}

/// Validate the RESOLVED argv (placeholders already substituted) against the
/// session's own endpoint. See the section comment for the boundary.
fn validate_argv(
    tool: &str,
    args: &[String],
    host: &str,
    port: u16,
    user: &str,
) -> Result<(), crate::apperror::AppError> {
    let allow = allow_table(tool);
    let reject = reject_table(tool);
    let mut positional_only = false;
    let mut i = 0;
    while i < args.len() {
        let tok = args[i].clone();
        i += 1;
        if tok == "--" && !positional_only {
            positional_only = true;
            continue;
        }
        if positional_only || !tok.starts_with('-') || tok == "-" {
            // Positional. pg_dump/psql read the first one as the database
            // name, and a database name can be a conninfo string.
            if matches!(tool, "pg_dump" | "psql") && looks_like_conninfo(&tok) {
                return Err(format!(
                    "{tool}: '{tok}' looks like a conninfo string — the database must be a plain name on this connection's server"
                ).into());
            }
            continue;
        }
        let body = tok.trim_start_matches('-');
        let (name, inline_val) = match body.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (body, None),
        };
        if let Some((_, reason)) = reject.iter().find(|(n, _)| *n == name) {
            return Err(format!("{tool}: '{tok}' is not allowed — {reason}").into());
        }
        let Some((_, kind)) = allow.iter().find(|(n, _)| *n == name) else {
            return Err(format!(
                "{tool}: '{tok}' is not an allowed flag for this tool (unknown flags are rejected)"
            ).into());
        };
        let kind = *kind;
        let value: Option<String> = match (kind, inline_val) {
            (FlagKind::Bool, _) => None,
            (_, Some(v)) => Some(v),
            (_, None) => {
                let v = args.get(i)
                    .ok_or_else(|| format!("{tool}: '{tok}' needs a value"))?;
                i += 1;
                Some(v.clone())
            }
        };
        let mismatch = |what: &str, got: &str, want: &str| crate::apperror::AppError::from(format!(
            "{tool}: --{name} is '{got}' but this connection's {what} is '{want}' — \
             a dump/restore can only target the server the connection names"
        ));
        match (kind, value.as_deref()) {
            (FlagKind::Host, Some(v)) if v != host => return Err(mismatch("host", v, host)),
            (FlagKind::Port, Some(v)) if v != port.to_string() =>
                return Err(mismatch("port", v, &port.to_string())),
            (FlagKind::User, Some(v)) if v != user => return Err(mismatch("user", v, user)),
            (FlagKind::DbName, Some(v)) if looks_like_conninfo(v) =>
                return Err(format!(
                    "{tool}: --{name} looks like a conninfo string — the database must be a plain name on this connection's server"
                ).into()),
            _ => {}
        }
    }
    Ok(())
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
/// opened for the duration of the run), and the resolved argv is validated
/// against the session's own endpoint (`validate_argv`) before anything is
/// spawned. `stdin_file` streams a file into the process (mysql/psql plain-SQL
/// restore).
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

    // The argv is renderer-controlled and the process carries the password in
    // its environment — a re-pointed --host would ship the auth handshake to
    // an attacker host. Validated post-resolution so the SSH-tunnel endpoint
    // is what the connection flags are compared against.
    validate_argv(tool, &resolved, &host, port, config.user.as_deref().unwrap_or(""))?;

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(&resolved)
        // Quitting the app mid-dump must not orphan the tool against its
        // (dying) SSH tunnel: if the Child is dropped without a wait — process
        // teardown, a panic path — the OS child is killed rather than left
        // running. A reaped child is a no-op for this.
        .kill_on_drop(true)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sv(args: &[&str]) -> Vec<String> { args.iter().map(|s| s.to_string()).collect() }

    /// What the panel's mysqldump spec actually builds (host/port resolved).
    const HOST: &str = "db.internal";
    const PORT: u16 = 3306;
    const USER: &str = "backup";

    #[test]
    fn accepts_panel_built_argv() {
        let args = sv(&[
            "--host", HOST, "--port", "3306", "--user", USER,
            "--single-transaction", "--routines", "--triggers", "--events", "--quick",
            "--where=tenant_id > 10",
            "--result-file", "/tmp/dump.sql", "shop", "orders", "customers",
        ]);
        assert!(validate_argv("mysqldump", &args, HOST, PORT, USER).is_ok());

        let psql = sv(&[
            "--host", "pg.internal", "--port", "5432", "--username", "dba", "--no-password",
            "--dbname", "shop", "-v", "ON_ERROR_STOP=1", "--file", "/tmp/dump.sql",
        ]);
        assert!(validate_argv("psql", &psql, "pg.internal", 5432, "dba").is_ok());
    }

    #[test]
    fn rejects_repointed_host_in_every_spelling() {
        for tok in ["--host", "-h"] {
            let args = sv(&[tok, "attacker.example", "shop"]);
            assert!(validate_argv("mysqldump", &args, HOST, PORT, USER).is_err(), "{tok}");
        }
        let eq = sv(&["--host=attacker.example", "shop"]);
        assert!(validate_argv("mysqldump", &eq, HOST, PORT, USER).is_err());
        let pg = sv(&["-h", "attacker.example", "shop"]);
        assert!(validate_argv("pg_dump", &pg, "pg.internal", 5432, "dba").is_err());
        // The session's own host is of course fine.
        let ok = sv(&["--host", HOST, "shop"]);
        assert!(validate_argv("mysqldump", &ok, HOST, PORT, USER).is_ok());
    }

    #[test]
    fn rejects_repointed_port_and_user() {
        let args = sv(&["--port", "13306", "shop"]);
        assert!(validate_argv("mysqldump", &args, HOST, PORT, USER).is_err());
        let args = sv(&["-P", "1", "shop"]);
        assert!(validate_argv("mysql", &args, HOST, PORT, USER).is_err());
        let args = sv(&["--user", "root", "shop"]);
        assert!(validate_argv("mysql", &args, HOST, PORT, USER).is_err());
        let args = sv(&["--username=root", "shop"]);
        assert!(validate_argv("pg_dump", &args, "h", 5432, "dba").is_err());
    }

    #[test]
    fn rejects_password_flags_and_option_files() {
        for tok in ["-p", "--password", "--password=hunter2"] {
            let args = sv(&[tok]);
            assert!(validate_argv("mysql", &args, HOST, PORT, USER).is_err(), "{tok}");
        }
        // A bare "-p" must not swallow the next token either — it is rejected
        // before value parsing.
        let args = sv(&["-p", "secret"]);
        assert!(validate_argv("mysqldump", &args, HOST, PORT, USER).is_err());
        // PostgreSQL: prompting for a password is rejected, --no-password allowed.
        assert!(validate_argv("pg_dump", &sv(&["-W"]), "h", 5432, "dba").is_err());
        assert!(validate_argv("pg_dump", &sv(&["--no-password"]), "h", 5432, "dba").is_ok());
        // Option files can carry host/user/password of their own.
        for tok in ["--defaults-extra-file=/tmp/x.cnf", "--login-path", "--socket=/tmp/s.sock"] {
            let args = sv(&[tok]);
            assert!(validate_argv("mysqldump", &args, HOST, PORT, USER).is_err(), "{tok}");
        }
    }

    #[test]
    fn rejects_unknown_flags_but_not_positionals() {
        let args = sv(&["--this-flag-does-not-exist", "shop", "orders"]);
        assert!(validate_argv("mysqldump", &args, HOST, PORT, USER).is_err());
        // TLS weakening is an unknown-flag rejection too.
        let args = sv(&["--ssl-mode=DISABLED"]);
        assert!(validate_argv("mysql", &args, HOST, PORT, USER).is_err());
        // Positionals (database, tables, paths) are data, and `--` ends flags.
        let args = sv(&["shop", "order items", "--", "-not-a-flag"]);
        assert!(validate_argv("mysqldump", &args, HOST, PORT, USER).is_ok());
    }

    #[test]
    fn rejects_conninfo_in_libpq_database_positions() {
        // libpq treats a dbname containing '=' or a postgres:// URI as a
        // conninfo string — a re-point that never mentions --host.
        let args = sv(&["--dbname", "host=attacker.example"]);
        assert!(validate_argv("pg_restore", &args, "h", 5432, "dba").is_err());
        let args = sv(&["-d", "postgresql://attacker.example/x"]);
        assert!(validate_argv("psql", &args, "h", 5432, "dba").is_err());
        let args = sv(&["host=attacker.example"]); // positional dbname
        assert!(validate_argv("pg_dump", &args, "h", 5432, "dba").is_err());
        // …but psql's -v NAME=VALUE is not a dbname and stays legal, and a
        // pg_restore archive PATH may contain '=' (it is never a conninfo).
        assert!(validate_argv("psql", &sv(&["-v", "ON_ERROR_STOP=1"]), "h", 5432, "dba").is_ok());
        assert!(validate_argv("pg_restore", &sv(&["/tmp/a=b.dump"]), "h", 5432, "dba").is_ok());
        // MySQL database names are never conninfo — '=' is merely rejected
        // via DbName on -D, positionals stay free.
        assert!(validate_argv("mysql", &sv(&["shop"]), HOST, PORT, USER).is_ok());
    }

    #[test]
    fn flag_value_may_start_with_a_dash() {
        // --where "x > -1": the value token is swallowed as a value, not
        // parsed as another flag.
        let args = sv(&["--where", "id > -1", "shop"]);
        assert!(validate_argv("mysqldump", &args, HOST, PORT, USER).is_ok());
    }

    #[test]
    fn mariadb_named_tools_are_allowlisted_with_mysql_write_sides() {
        // MariaDB 11.4 deprecates the mysqldump/mysql names; the mariadb-*
        // binaries must be spawnable, with the same write/read split.
        assert!(!is_write_tool("mariadb-dump"));
        assert!(is_write_tool("mariadb"));
        assert!(TOOLS.iter().any(|(t, _)| *t == "mariadb-dump"));
        assert!(TOOLS.iter().any(|(t, _)| *t == "mariadb"));
        // mariadb-loader does not exist — myloader is the only parallel loader.
        assert!(!TOOLS.iter().any(|(t, _)| *t == "mariadb-loader"));
    }

    #[test]
    fn mariadb_named_tools_validate_like_the_mysql_ones() {
        let dump = sv(&[
            "--host", HOST, "--port", "3306", "--user", USER,
            "--single-transaction", "--routines", "--triggers", "--events", "--quick",
            "--result-file", "/tmp/dump.sql", "shop",
        ]);
        assert!(validate_argv("mariadb-dump", &dump, HOST, PORT, USER).is_ok());

        let restore = sv(&["--host", HOST, "--port", "3306", "--user", USER, "--force", "shop"]);
        assert!(validate_argv("mariadb", &restore, HOST, PORT, USER).is_ok());

        // Same boundaries as the mysql-named tools.
        assert!(validate_argv("mariadb-dump", &sv(&["--host", "attacker.example", "shop"]), HOST, PORT, USER).is_err());
        assert!(validate_argv("mariadb", &sv(&["--user", "root", "shop"]), HOST, PORT, USER).is_err());
        assert!(validate_argv("mariadb", &sv(&["-p", "secret"]), HOST, PORT, USER).is_err());
        assert!(validate_argv("mariadb-dump", &sv(&["--defaults-file=/tmp/x.cnf"]), HOST, PORT, USER).is_err());
        assert!(validate_argv("mariadb-dump", &sv(&["--ssl-mode=DISABLED"]), HOST, PORT, USER).is_err());
    }
}
