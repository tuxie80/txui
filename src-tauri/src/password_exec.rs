//! W5.1 — password-exec: pgAdmin's one generic credential hook.
//!
//! A connection may name a shell command (`ConnectionConfig::password_exec`)
//! whose stdout IS the database password. At connect/test time, when the
//! command is set and there is no live cached password (or the TTL expired),
//! the command runs: `%HOST%` / `%PORT%` / `%USER%` / `%DATABASE%`
//! placeholders are substituted from the config, and the line is executed by
//! the platform shell — `$SHELL -c` on Unix, `%ComSpec% /C` on Windows, the
//! same shell `run_os_command` (commands/shell.rs) uses. A shell is the whole
//! point (pgAdmin's semantic): the command is user-authored — `op read
//! "op://vault/db/password"`, `aws rds generate-db-auth-token …`, `vault
//! kv get -field=password …` — and needs pipes/expansion to be useful.
//!
//! The values are the part that is NOT user-authored, so they are substituted
//! shell-quoted: a hostname containing `"; rm -rf ~; echo "` must arrive as
//! one inert argument, not as more shell. The command string itself is stored
//! in PLAINTEXT in connections.json — a command is not a secret — and is
//! never logged, and neither is anything the command prints.
//!
//! The minted password is cached in-process (never written anywhere) and
//! re-run once `password_exec_ttl_secs` has passed; a `None` TTL caches for
//! the whole app run. Cache key is the substituted command line, so editing
//! the host (or the command) misses the cache instead of reusing another
//! server's password.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::db::types::ConnectionConfig;

/// Longest the command may run. A credential CLI that needs longer than this
/// is interactive, and interactive means it will hang every connect — better
/// a clear error than a stuck sidebar badge.
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

/// Cap on the stdout we accept as a password. A real password is bytes to
/// maybe a kilobyte (JWTs); a command that dumps a file is a mistake, and the
/// mistake should surface as an error rather than as a silently truncated
/// credential that almost works.
const MAX_STDOUT: usize = 64 * 1024;

/// How much of stderr a failure may quote. The user's own command wrote it,
/// to the user's own machine — but a whole script's worth of stderr is not an
/// error message.
const MAX_ERR_SNIPPET: usize = 300;

/// Quote one substituted value for the platform shell, so it survives as a
/// single inert argument whatever it contains.
///
/// Unix: single quotes — nothing expands inside them — with the classic
/// `'\''` dance for an embedded quote. Windows cmd: caret-escape every active
/// metacharacter, space included, rather than quoting — inside double quotes
/// a caret is LITERAL and `%VAR%` still expands, so quoting would neither
/// protect nor preserve the value. (Delayed expansion (cmd /V) still sees
/// `!` — off by default for `/C`, and the module docs say so.)
pub fn quote_value(v: &str, windows: bool) -> String {
    if windows {
        let mut out = String::with_capacity(v.len());
        for c in v.chars() {
            match c {
                ' ' | '^' | '&' | '|' | '<' | '>' | '(' | ')' | '"' | '%' | '!' => {
                    out.push('^');
                    out.push(c);
                }
                _ => out.push(c),
            }
        }
        out
    } else {
        let mut out = String::with_capacity(v.len() + 2);
        out.push('\'');
        for c in v.chars() {
            if c == '\'' {
                out.push_str("'\\''");
            } else {
                out.push(c);
            }
        }
        out.push('\'');
        out
    }
}

/// Substitute the `%HOST%` / `%PORT%` / `%USER%` / `%DATABASE%` placeholders
/// with the config's values, each shell-quoted. Placeholders are matched
/// case-sensitively and whole — `%HOSTNAME%` is not `%HOST%`.
///
/// Pure and `windows`-parameterized so both shells' quoting is tested on any
/// host; the caller passes `cfg!(windows)`.
pub fn substitute_placeholders(command: &str, config: &ConnectionConfig, windows: bool) -> String {
    let host = config.host.as_deref().unwrap_or("localhost");
    let port = config.port.unwrap_or_else(|| config.engine.default_port());
    let user = config.user.as_deref().unwrap_or("");
    let db = config.database.as_deref().unwrap_or("");
    command
        .replace("%HOST%", &quote_value(host, windows))
        .replace("%PORT%", &port.to_string())
        .replace("%USER%", &quote_value(user, windows))
        .replace("%DATABASE%", &quote_value(db, windows))
}

/// The cache key: the substituted command line. Editing the host, the user,
/// or the command itself changes the key, so a stale password can never be
/// reused for what is now a different target.
fn cache_key(substituted: &str) -> String {
    substituted.to_string()
}

struct Cached {
    password: String,
    minted: Instant,
}

/// One entry per substituted command. The cache is deliberately NOT persisted
/// and NOT shared with the secret store: a password-exec password is minted,
/// held, and dies with the process.
struct Cache(Mutex<HashMap<String, Cached>>);

impl Cache {
    fn new() -> Self {
        Cache(Mutex::new(HashMap::new()))
    }

    /// The cached password when present and younger than `ttl` (`None` ttl =
    /// never expires within this process). Expired entries are dropped, so a
    /// growing TTL collection cannot accumulate dead entries forever.
    fn get(&self, key: &str, ttl: Option<Duration>, now: Instant) -> Option<String> {
        let mut map = self.0.lock().ok()?;
        match map.get(key) {
            Some(c) if ttl.is_none_or(|t| now.duration_since(c.minted) < t) => {
                Some(c.password.clone())
            }
            Some(_) => {
                map.remove(key);
                None
            }
            None => None,
        }
    }

    fn put(&self, key: String, password: String, now: Instant) {
        if let Ok(mut map) = self.0.lock() {
            // Bounded by the connection count in practice; clamp anyway so a
            // pathological edit loop cannot grow it without limit.
            if map.len() >= 256 {
                map.clear();
            }
            map.insert(key, Cached { password, minted: now });
        }
    }
}

static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();

fn cache() -> &'static Cache {
    CACHE.get_or_init(Cache::new)
}

/// The password from the connection's `password_exec` command, or `Ok(None)`
/// when the connection does not use one. A set-but-failing command is an
/// ERROR, not a fall-through to the stored secret: silently using a different
/// credential than the one the config points at is how "why is this account
/// locked" tickets are born.
///
/// Errors name the failure (spawn, timeout, exit code, empty stdout) and may
/// quote a snippet of the command's stderr; they never contain the command
/// line or any stdout byte.
pub async fn resolve(config: &ConnectionConfig) -> Result<Option<String>, String> {
    let Some(command) = config.password_exec.as_deref() else {
        return Ok(None);
    };
    let command = command.trim();
    if command.is_empty() {
        return Ok(None);
    }

    let substituted = substitute_placeholders(command, config, cfg!(windows));
    let key = cache_key(&substituted);
    let ttl = config.password_exec_ttl_secs.map(Duration::from_secs);
    let now = Instant::now();
    if let Some(hit) = cache().get(&key, ttl, now) {
        return Ok(Some(hit));
    }

    let password = run(&substituted).await?;
    cache().put(key, password.clone(), now);
    Ok(Some(password))
}

/// Run the substituted command line in the platform shell and return its
/// trimmed stdout. Never logs anything about the command or its output.
async fn run(substituted: &str) -> Result<String, String> {
    use tokio::io::AsyncReadExt;

    let (shell, flag) = crate::commands::shell::user_shell();
    let mut child = tokio::process::Command::new(&shell)
        .arg(flag)
        .arg(substituted)
        .stdin(std::process::Stdio::null()) // never interactive — a prompt would hang
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("password command could not be started ({shell}): {e}"))?;

    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    let status = {
        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let collect = async {
            // Drain both streams concurrently — reading one to completion
            // first deadlocks as soon as the other fills its pipe buffer
            // (same lesson as run_os_command).
            let a = async {
                if let Some(s) = stdout.as_mut() { let _ = s.read_to_end(&mut out_buf).await; }
            };
            let b = async {
                if let Some(s) = stderr.as_mut() { let _ = s.read_to_end(&mut err_buf).await; }
            };
            tokio::join!(a, b);
            child.wait().await
        };
        match tokio::time::timeout(RUN_TIMEOUT, collect).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Err(format!("password command could not be waited on: {e}")),
            Err(_) => {
                let _ = child.kill().await;
                return Err(format!(
                    "password command did not finish within {} s — it must be non-interactive",
                    RUN_TIMEOUT.as_secs()
                ));
            }
        }
    };

    if !status.success() {
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "killed".into());
        let mut snippet = String::from_utf8_lossy(&err_buf).trim().to_string();
        snippet.truncate(MAX_ERR_SNIPPET);
        return Err(if snippet.is_empty() {
            format!("password command failed (exit {code})")
        } else {
            format!("password command failed (exit {code}): {snippet}")
        });
    }
    if out_buf.len() > MAX_STDOUT {
        return Err(format!(
            "password command printed {} bytes — a password is not that long; refusing it",
            out_buf.len()
        ));
    }
    let password = String::from_utf8_lossy(&out_buf).trim().to_string();
    if password.is_empty() {
        return Err("password command printed no password (empty stdout)".into());
    }
    Ok(password)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::Engine;

    fn cfg() -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Postgres, "t");
        c.host = Some("db.internal".into());
        c.port = Some(5433);
        c.user = Some("app".into());
        c.database = Some("shop".into());
        c
    }

    #[test]
    fn placeholders_are_substituted_from_the_config() {
        let out = substitute_placeholders(
            "get-pw --host %HOST% --port %PORT% --user %USER% --db %DATABASE%",
            &cfg(), false);
        assert_eq!(out, "get-pw --host 'db.internal' --port 5433 --user 'app' --db 'shop'");
    }

    #[test]
    fn unix_values_are_single_quoted_and_inert() {
        let mut c = cfg();
        c.host = Some("x\"; rm -rf ~; echo \"".into());
        let out = substitute_placeholders("%HOST%", &c, false);
        assert_eq!(out, "'x\"; rm -rf ~; echo \"'",
            "metacharacters stay inside single quotes — inert to sh");
        // Embedded single quote: the '\'' dance.
        c.user = Some("o'brien".into());
        let out = substitute_placeholders("%USER%", &c, false);
        assert_eq!(out, "'o'\\''brien'");
    }

    #[test]
    fn windows_values_are_caret_escaped_for_cmd() {
        let out = quote_value("a&b|%PATH%!", true);
        assert_eq!(out, "a^&b^|^%PATH^%^!");
        assert_eq!(quote_value("plain", true), "plain");
        assert_eq!(quote_value("say \"hi\"", true), "say^ ^\"hi^\"");
    }

    #[test]
    fn lookalike_longer_placeholders_survive_untouched() {
        // The trailing % delimits every placeholder, so %HOSTNAME% does NOT
        // contain %HOST% as a substring — longer names are safe by shape.
        let out = substitute_placeholders("echo %HOSTNAME%", &cfg(), false);
        assert_eq!(out, "echo %HOSTNAME%");
    }

    #[test]
    fn missing_values_fall_back_to_defaults() {
        let mut c = ConnectionConfig::new(Engine::Mysql, "t");
        c.host = None;
        c.user = None;
        c.database = None;
        let out = substitute_placeholders("%HOST% %PORT% %USER% %DATABASE%", &c, false);
        assert_eq!(out, "'localhost' 3306 '' ''");
    }

    #[test]
    fn cache_respects_the_ttl() {
        let cache = Cache::new();
        let t0 = Instant::now();
        cache.put("k".into(), "pw".into(), t0);

        // No TTL → lives for the process run.
        assert_eq!(cache.get("k", None, t0 + Duration::from_secs(9999)).as_deref(), Some("pw"));
        // Within TTL → hit.
        assert_eq!(cache.get("k", Some(Duration::from_secs(60)), t0 + Duration::from_secs(30)).as_deref(), Some("pw"));
        // Past TTL → miss, and the entry is gone (not reusable by a later call).
        assert_eq!(cache.get("k", Some(Duration::from_secs(60)), t0 + Duration::from_secs(61)), None);
        assert_eq!(cache.get("k", None, t0), None, "the expired entry was dropped");
        // Unknown key → miss.
        assert_eq!(cache.get("nope", None, t0), None);
    }

    /// A command that exits 0 with empty stdout on both shells.
    fn silent_ok_cmd() -> &'static str {
        if cfg!(windows) { "rem" } else { "true" }
    }

    #[tokio::test]
    async fn a_real_command_round_trips_its_stdout() {
        let mut c = cfg();
        // `echo` exists in both sh and cmd; trailing newline/CR is trimmed.
        c.password_exec = Some("echo s3cr3t".into());
        let pw = resolve(&c).await.unwrap();
        assert_eq!(pw.as_deref(), Some("s3cr3t"));
        // Second call is the cache hit — same answer, and (covered by the
        // cache test above) without re-running.
        let pw2 = resolve(&c).await.unwrap();
        assert_eq!(pw2.as_deref(), Some("s3cr3t"));
    }

    #[tokio::test]
    async fn a_failing_command_is_an_error_not_a_fallback() {
        let mut c = cfg();
        c.password_exec = Some("exit 3".into());
        let err = resolve(&c).await.unwrap_err();
        assert!(err.contains("exit 3"), "{err}");
        // The substituted command itself must never appear in the error.
        assert!(!err.contains("db.internal"), "{err}");
    }

    /// stderr of the failed command is quoted (truncated) so the user sees
    /// WHY their credential CLI failed. sh syntax — cmd redirects differently.
    #[cfg(not(windows))]
    #[tokio::test]
    async fn a_failing_command_quotes_a_stderr_snippet() {
        let mut c = cfg();
        c.password_exec = Some("echo oops >&2; exit 3".into());
        let err = resolve(&c).await.unwrap_err();
        assert!(err.contains("exit 3"), "{err}");
        assert!(err.contains("oops"), "stderr snippet should surface: {err}");
        assert!(!err.contains("db.internal"), "{err}");
    }

    #[tokio::test]
    async fn empty_stdout_is_an_error() {
        let mut c = cfg();
        c.password_exec = Some(silent_ok_cmd().into());
        let err = resolve(&c).await.unwrap_err();
        assert!(err.contains("no password"), "{err}");
    }

    #[tokio::test]
    async fn unset_or_blank_command_is_a_quiet_none() {
        let c = cfg();
        assert_eq!(resolve(&c).await.unwrap(), None);
        let mut c = cfg();
        c.password_exec = Some("   ".into());
        assert_eq!(resolve(&c).await.unwrap(), None);
    }
}
