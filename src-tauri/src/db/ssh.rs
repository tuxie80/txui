/// SSH tunnel via the system `ssh` binary.
/// Opens an SSH port-forwarding process and returns the local port to connect to.
use anyhow::Result;
use std::time::Duration;
use tokio::net::TcpListener;

pub struct SshTunnel {
    pub local_port: u16,
    /// OpenSSH's own line when `accept-new` recorded a previously unknown
    /// host key (TOFU), captured from stderr during the handshake — `None`
    /// for a known host. Surfaced by the caller (audit row + session log);
    /// the stderr drain task also `log::warn!`s it the moment it appears.
    pub host_key_note: Option<String>,
    /// Shared with the liveness watcher (W4.5 — see [`watch_child_exit`]).
    /// Behind a mutex because BOTH owners need `&mut`: the watcher polls
    /// `try_wait`, Drop sends `start_kill`. Neither ever holds it across an
    /// await — the watcher polls on a timer and Drop uses `try_lock` — so the
    /// lock is a microsecond borrow, never a deadlock surface.
    child: std::sync::Arc<tokio::sync::Mutex<tokio::process::Child>>,
    /// Set by Drop (deliberate teardown) so the watcher does not report a
    /// tunnel *we* killed as a lost one. Checked by the watcher before every
    /// exit report — including after observing the exit, because the kill and
    /// the observation race.
    disarmed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        // Disarm FIRST: a deliberate close (session teardown, app exit) is not
        // a lost tunnel, and the watcher must stay quiet about it.
        self.disarmed.store(true, std::sync::atomic::Ordering::SeqCst);
        // Best-effort async kill — cannot await in Drop. try_lock because the
        // watcher may be inside its microsecond try_wait borrow right now; in
        // that (rare) case the watcher sees `disarmed` on its way out and does
        // the kill itself, so the child dies either way.
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

/// How a dead ssh child is described in the `conn:tunnel-lost` event (W4.5).
/// Pure so the wording is unit-tested.
pub(crate) fn tunnel_exit_reason(code: Option<i32>) -> String {
    match code {
        Some(c) => format!("the ssh tunnel process exited unexpectedly (exit code {c})"),
        None    => "the ssh tunnel process was terminated by a signal".to_string(),
    }
}

/// Watch an ssh tunnel's child until it exits ON ITS OWN. Returns
/// `Some(exit_code)` — None code = killed by a signal — exactly once;
/// returns `None` (quiet) when the tunnel was deliberately torn down
/// (disarmed via Drop).
///
/// Polling (`try_wait` on a timer) rather than `child.wait().await`: `wait`
/// needs `&mut Child`, which would mean holding the mutex across an await —
/// and Drop's `start_kill` needs that same mutex. A 1 s poll notices a dead
/// tunnel orders of magnitude sooner than the next failed query did, without
/// any lock being held across an await point.
pub async fn watch_child_exit(
    child: std::sync::Arc<tokio::sync::Mutex<tokio::process::Child>>,
    disarmed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    poll: std::time::Duration,
) -> Option<Option<i32>> {
    loop {
        tokio::time::sleep(poll).await;
        if disarmed.load(std::sync::atomic::Ordering::SeqCst) {
            // Deliberate teardown. If Drop's try_lock lost the race against
            // our try_wait borrow, the kill is ours to deliver.
            if let Ok(mut c) = child.try_lock() {
                let _ = c.start_kill();
            }
            return None;
        }
        let exited: Option<Option<i32>> = match child.try_lock() {
            Ok(mut c) => match c.try_wait() {
                Ok(Some(status)) => Some(status.code()),
                // Still running, or a transient OS error — look again next poll.
                Ok(None) | Err(_) => None,
            },
            Err(_) => None,
        };
        let Some(code) = exited else { continue };
        // The exit may BE our own kill landing — disarm wins that race.
        if disarmed.load(std::sync::atomic::Ordering::SeqCst) {
            return None;
        }
        return Some(code);
    }
}

/// Loose validation of a `-J` jump spec (`user@host[:port]`, optionally a
/// comma-separated chain). The value is passed as a direct argv element and
/// never goes through a shell — this whitelist is defense-in-depth only.
fn validate_jump(jump: &str) -> Result<()> {
    if jump.is_empty() {
        anyhow::bail!("SSH jump host is empty");
    }
    if !jump.chars().all(|c| c.is_ascii_alphanumeric() || "@._:-[]%,".contains(c)) {
        anyhow::bail!("SSH jump host contains invalid characters: {jump:?}");
    }
    Ok(())
}

/// The `user@host` target becomes ONE argv element and never goes through a
/// shell — but ssh parses ANY argv element starting with '-' as another
/// option wherever it sits, and `-oProxyCommand=…` runs through a shell.
/// Reject a leading '-' and anything outside the characters a real user or
/// host carries (host extras cover IPv6 literals and zone ids); the `--`
/// separator before the target at the spawn site is the second layer.
fn validate_endpoint(user: &str, host: &str) -> Result<()> {
    for (what, v, extra) in [("user", user, "._-"), ("host", host, "._:[]%-")] {
        if v.is_empty() {
            anyhow::bail!("SSH {what} is empty");
        }
        if v.starts_with('-') {
            anyhow::bail!("SSH {what} must not start with '-': {v:?}");
        }
        if !v.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c)) {
            anyhow::bail!("SSH {what} contains invalid characters: {v:?}");
        }
    }
    Ok(())
}

/// Write a temporary SSH_ASKPASS helper that prints the password carried in
/// the TXUI_SSH_PASS env var.
///
/// **The password is never in the script body, never in argv, and never on
/// disk.** It reaches the helper through the child's environment only; the
/// file on disk is three lines of shell that read a variable. That is the
/// whole design, and it is why the file's permissions matter less than they
/// look like they should.
///
/// The two platforms need genuinely different files — a `#!/bin/sh` script is
/// inert on Windows, where there is no `sh` and a shebang means nothing, and
/// execution is decided by the file *extension*.
///
/// Caller must delete the file once ssh has settled.
fn write_askpass_script() -> Result<std::path::PathBuf> {
    use std::io::Write;
    let stem = format!("txui-askpass-{}-{}", std::process::id(), uuid::Uuid::new_v4());

    #[cfg(windows)]
    {
        // `.cmd`, because Windows decides what is executable by extension.
        let path = std::env::temp_dir().join(format!("{stem}.cmd"));
        let mut f = std::fs::File::create(&path)?;
        // Delayed expansion (`!VAR!` rather than `%VAR%`) is the security-
        // relevant part, not a style choice: `echo %VAR%` substitutes the
        // value *before* the line is parsed, so a password containing `&`,
        // `|` or `>` would be executed as a command. `!VAR!` substitutes
        // after parsing, and the substituted text is not re-scanned.
        //
        // The residual limit, stated because it cannot be fixed here: a
        // password containing a literal `!` may lose it under delayed
        // expansion. That is a mangled password — a failed login — not an
        // execution risk, and it is the safe direction to err in.
        //
        // CRLF line endings: cmd.exe is tolerant of LF, but not universally,
        // and this file exists to work rather than to be elegant.
        f.write_all(b"@echo off\r\nsetlocal enabledelayedexpansion\r\necho !TXUI_SSH_PASS!\r\n")?;
        // No explicit ACL. The file carries no secret, and it lives in the
        // per-user `%TEMP%`, whose ACL already excludes other users — the same
        // reasoning as `restrict_to_owner()` in the vault, written down for the
        // same reason: a difference that is documented is not a difference that
        // is hiding.
        Ok(path)
    }

    #[cfg(not(windows))]
    {
        let path = std::env::temp_dir().join(stem);
        {
            let mut f = std::fs::File::create(&path)?;
            {
                use std::os::unix::fs::PermissionsExt;
                f.set_permissions(std::fs::Permissions::from_mode(0o700))?;
            }
            // `printf '%s'` rather than `echo`: no trailing newline to strip.
            f.write_all(b"#!/bin/sh\nprintf '%s' \"$TXUI_SSH_PASS\"\n")?;
        }
        Ok(path)
    }
}

/// `setsid` detaches ssh from the controlling tty so it honours SSH_ASKPASS
/// instead of prompting on the terminal. macOS ships no `setsid`, but modern
/// OpenSSH there accepts `SSH_ASKPASS_REQUIRE=force`, which needs no detach —
/// so setsid is used when present and skipped otherwise.
fn setsid_available() -> bool {
    // Windows has no `setsid` and never has. Probing for it would spawn a
    // process that cannot exist — and on Windows a spawned console process
    // flashes a window, so the probe would be visible as well as pointless.
    #[cfg(windows)]
    {
        false
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("setsid")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// A GUI app spawning a console program on Windows pops a console window —
/// here, one per ssh child (tunnel or exec), for as long as the child lives.
/// CREATE_NO_WINDOW suppresses it. There is no Unix equivalent because there
/// is no Unix problem.
///
/// `creation_flags` is tokio's own Windows-only method (it forwards to
/// `std::os::windows::process::CommandExt`), so importing that trait here
/// would not help and does not compile: tokio's `Command` is not std's.
///
/// This calls a Windows-only API: `dev/xplat_check.sh` forces Windows gates
/// on while compiling against the local toolchain, where this method does
/// not exist, so checking it there would fail for a reason that has nothing
/// to do with this branch. The marker below opts this one gate out, and must
/// stay on the line directly above it. Both spawn sites share this helper so
/// the marker — the project's count of manually-read Windows branches —
/// stays at one.
fn suppress_console_window(cmd: &mut tokio::process::Command) {
    // xplat-skip
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// OpenSSH's stderr line when `StrictHostKeyChecking=accept-new` records a
/// previously unknown host key:
/// "Warning: Permanently added 'host' (ED25519) to the list of known hosts."
/// Returns the line trimmed, or None for anything else. Pure so it is
/// testable; the matching is deliberately loose about host/algorithm.
fn host_key_note(line: &str) -> Option<String> {
    let l = line.trim();
    if !l.starts_with("Warning:") || !l.contains("Permanently added") {
        return None;
    }
    Some(l.to_string())
}

/// Bounded stderr state for a spawned ssh: a short tail for the quick-exit
/// diagnosis (previously read straight off the pipe, which only worked
/// because nothing else drained it) and the first host-key note seen.
struct StderrScan {
    tail:     std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    host_key: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

/// Drain a spawned ssh's stderr for its whole life. Two jobs beyond keeping
/// the pipe from filling (a piped-but-unread stderr can stall ssh): the
/// quick-exit tail above, and TOFU surfacing — the first-contact host-key
/// warning is `log::warn!`ed the moment it appears and stashed for the
/// caller's audit row, so `accept-new` silently recording a key stops being
/// silent.
fn spawn_stderr_scan(stderr: tokio::process::ChildStderr) -> (StderrScan, tauri::async_runtime::JoinHandle<()>) {
    let scan = StderrScan {
        tail:     std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new())),
        host_key: std::sync::Arc::new(std::sync::Mutex::new(None)),
    };
    let tail = scan.tail.clone();
    let host_key = scan.host_key.clone();
    let task = tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(note) = host_key_note(&line) {
                log::warn!("ssh accept-new recorded a first-contact host key: {note}");
                let mut slot = host_key.lock().unwrap();
                if slot.is_none() { *slot = Some(note); }
            }
            let mut t = tail.lock().unwrap();
            if t.len() >= 20 { t.pop_front(); }
            t.push_back(line);
        }
    });
    (scan, task)
}

/// The last few non-empty stderr lines of a dead (or stalled) ssh, phrased
/// for an error message — empty when there is nothing worth quoting.
fn stderr_tail(scan: Option<&StderrScan>) -> String {
    let Some(scan) = scan else { return String::new() };
    let tail = scan.tail.lock().unwrap();
    let lines: Vec<&String> = tail.iter().filter(|l| !l.trim().is_empty()).collect();
    let tail_text = lines.iter().rev().take(3).rev()
        .map(|s| s.as_str()).collect::<Vec<_>>().join(" | ");
    if tail_text.is_empty() {
        String::new()
    } else {
        format!(" ssh said: {tail_text}")
    }
}

/// Can 127.0.0.1:`port` accept a TCP connection right now? Loopback refusal
/// is immediate, so this is a cheap poll; the accepted probe connection is
/// dropped at once (ssh forwards it to the DB, which sees a connect and an
/// immediate close — the same thing a refused dial costs).
async fn port_accepts(port: u16) -> bool {
    tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok()
}

impl SshTunnel {
    /// Spawn `ssh -N -L local_port:db_host:db_port user@ssh_host` and wait
    /// until the local forward actually accepts connections (bounded by the
    /// connection's connect timeout — None means the app-wide default).
    ///
    /// `ssh_jump` adds `-J <jump>`; `ssh_password` switches to askpass-driven
    /// password/passphrase auth (BatchMode is omitted in that case — it would
    /// disable password prompts entirely).
    #[allow(clippy::too_many_arguments)]
    pub async fn open(
        ssh_host:     &str,
        ssh_port:     u16,
        ssh_user:     &str,
        ssh_key_path: Option<&str>,
        db_host:      &str,
        db_port:      u16,
        ssh_jump:     Option<&str>,
        ssh_password: Option<&str>,
        connect_timeout_secs: Option<u32>,
    ) -> Result<Self> {
        match Self::open_once(ssh_host, ssh_port, ssh_user, ssh_key_path, db_host, db_port,
                              ssh_jump, ssh_password, connect_timeout_secs).await {
            // The local port is chosen by bind:0 and then RELEASED before ssh
            // binds it — another process can claim it in that window, and ssh
            // exits at once under ExitOnForwardFailure. "Address already in
            // use" is that lost race: pick a fresh port and try once more.
            // The race itself cannot be closed (ssh owns the bind; there is
            // no way to hand it a ready fd), so one retry is an honest
            // mitigation, not a guarantee.
            Err(e) if e.to_string().contains("Address already in use") =>
                Self::open_once(ssh_host, ssh_port, ssh_user, ssh_key_path, db_host, db_port,
                                ssh_jump, ssh_password, connect_timeout_secs).await,
            r => r,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn open_once(
        ssh_host:     &str,
        ssh_port:     u16,
        ssh_user:     &str,
        ssh_key_path: Option<&str>,
        db_host:      &str,
        db_port:      u16,
        ssh_jump:     Option<&str>,
        ssh_password: Option<&str>,
        connect_timeout_secs: Option<u32>,
    ) -> Result<Self> {
        validate_endpoint(ssh_user, ssh_host)?;
        if let Some(jump) = ssh_jump {
            validate_jump(jump)?;
        }

        // Grab a free local port then release it (ssh will bind it)
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let local_port = listener.local_addr()?.port();
        drop(listener);

        let forward_spec = format!("{}:{}:{}", local_port, db_host, db_port);
        let ssh_target   = format!("{}@{}", ssh_user, ssh_host);

        // Password auth: askpass script + env, spawn through setsid when available.
        let askpass = match ssh_password {
            Some(_) => Some(write_askpass_script()?),
            None => None,
        };

        let use_setsid = ssh_password.is_some() && setsid_available();
        let mut cmd = if use_setsid {
            let mut c = tokio::process::Command::new("setsid");
            c.arg("ssh");
            c
        } else {
            tokio::process::Command::new("ssh")
        };

        cmd.args([
            "-N",
            "-L", &forward_spec,
            "-p", &ssh_port.to_string(),
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
            "-o", "ConnectTimeout=10",
        ]);

        if let Some(password) = ssh_password {
            // BatchMode intentionally omitted: it disables password prompts.
            let script = askpass.as_ref().ok_or_else(|| anyhow::anyhow!(
                "internal error: SSH password given but no askpass script was written"))?;
            cmd.env("SSH_ASKPASS", script)
               .env("SSH_ASKPASS_REQUIRE", "force")
               .env("DISPLAY", "txui:0")
               .env("TXUI_SSH_PASS", password);
        } else {
            cmd.args(["-o", "BatchMode=yes"]);   // no interactive prompts
        }

        if let Some(jump) = ssh_jump {
            cmd.args(["-J", jump]);
        }

        if let Some(key) = ssh_key_path {
            cmd.args(["-i", key]);
        }

        cmd.arg("--")
           .arg(&ssh_target)
           .stdout(std::process::Stdio::null())
           // Captured, not nulled: when the tunnel dies at birth, ssh's own
           // words ("Permission denied", "Connection refused", a host-key
           // complaint) are the diagnosis — "exit code Some(255)" was not.
           .stderr(std::process::Stdio::piped());

        suppress_console_window(&mut cmd);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                cleanup_askpass(&askpass);
                return Err(anyhow::anyhow!("Failed to spawn ssh: {}. {}", e, install_hint()));
            }
        };

        // stderr is drained from the start (host-key TOFU note + quick-exit
        // tail), not read once on failure — see spawn_stderr_scan.
        let (scan, scan_task) = match child.stderr.take() {
            Some(e) => { let (s, t) = spawn_stderr_scan(e); (Some(s), Some(t)) }
            None => (None, None),
        };

        // Wait until the local forward actually ACCEPTS a connection. OpenSSH
        // binds the -L port only after auth completes, so the old fixed 500 ms
        // settle raced slow handshakes (MFA, a bastion, a loaded sshd) and the
        // pool's first dial hit a port nothing listened on yet — a spurious
        // "connection refused" on a healthy tunnel. Poll until the port
        // accepts, ssh exits (a quick exit is a failure, and ssh's own stderr
        // words are the diagnosis), or the connect timeout is spent.
        let ready_timeout = Duration::from_secs(connect_timeout_secs
            .map(u64::from)
            .filter(|s| *s > 0)
            .unwrap_or(crate::db::types::DEFAULT_CONNECT_TIMEOUT_SECS));
        let mut result = Ok(());
        let wait_start = std::time::Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            match child.try_wait() {
                Ok(Some(status)) => {
                    // The process has exited, so the drain task is at EOF or
                    // about to be — give it a moment, then read ssh's own
                    // words from the tail it kept.
                    if let Some(t) = scan_task { let _ = t.await; }
                    result = Err(anyhow::anyhow!(
                        "SSH tunnel exited immediately (exit code {:?}).{} \
                         Check host/user/key and that the remote DB is reachable.",
                        status.code(), stderr_tail(scan.as_ref())
                    ));
                    break;
                }
                Ok(None) => {}
                Err(e) => {
                    result = Err(anyhow::anyhow!("SSH process error: {}", e));
                    break;
                }
            }
            if port_accepts(local_port).await {
                break;
            }
            if wait_start.elapsed() >= ready_timeout {
                result = Err(anyhow::anyhow!(
                    "SSH tunnel did not accept connections on 127.0.0.1:{local_port} \
                     within {}s — the ssh handshake (auth, host key, jump host) is \
                     slower than this connection's connect timeout.{}",
                    ready_timeout.as_secs(), stderr_tail(scan.as_ref())
                ));
                break;
            }
        }

        // ssh has settled (or failed) — the askpass helper is no longer needed.
        cleanup_askpass(&askpass);
        result?;

        log::info!(
            "SSH tunnel ready: localhost:{} → {}:{}  (via {}@{}:{})",
            local_port, db_host, db_port, ssh_user, ssh_host, ssh_port
        );

        // Host-key acceptance happens during the handshake, before auth — and
        // the readiness wait above only ends once auth has completed (the port
        // binds after it), so a first-contact note is captured by now on any
        // tunnel that came up. A pathologically late one still gets the drain
        // task's log::warn!, just not the audit row.
        let host_key_note = scan.and_then(|s| s.host_key.lock().unwrap().clone());

        Ok(SshTunnel {
            local_port,
            host_key_note,
            child: std::sync::Arc::new(tokio::sync::Mutex::new(child)),
            disarmed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// The handles a liveness watcher needs (W4.5): the shared child handle
    /// and the disarm flag. The watcher (db::ssh::watch_child_exit, spawned by
    /// the session-open path) reports an UNEXPECTED exit; Drop disarms it for
    /// deliberate teardown.
    pub fn watch_handles(
        &self,
    ) -> (
        std::sync::Arc<tokio::sync::Mutex<tokio::process::Child>>,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        (self.child.clone(), self.disarmed.clone())
    }
}

/// Where to get `ssh`, in the words of the platform the user is on.
///
/// "Is OpenSSH installed?" is a question, not an answer. On Windows the client
/// is an optional feature that is off on older installs, and nobody guesses
/// that from a spawn error.
///
/// Gated on `target_os` with an explicit fallback arm, mirroring
/// `commands/dump.rs` — `dev/xplat_check.sh` rewrites exactly those spellings,
/// and a cleverer combination (`all(unix, not(target_os = "macos"))`) is one
/// the checker cannot see through, which is how a branch nobody has ever
/// compiled gets shipped. It caught this function in that state.
fn install_hint() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "The OpenSSH client is a Windows optional feature — Settings → System → \
         Optional features → Add → OpenSSH Client — or install Git for Windows, \
         which ships one."
    }
    #[cfg(target_os = "macos")]
    {
        "macOS ships one at /usr/bin/ssh; if it is missing, install the Xcode command line tools."
    }
    #[cfg(target_os = "linux")]
    {
        "Install the OpenSSH client (e.g. `apt install openssh-client` or `dnf install openssh-clients`)."
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "Install the OpenSSH client and make sure `ssh` is on PATH."
    }
}

fn cleanup_askpass(askpass: &Option<std::path::PathBuf>) {
    if let Some(p) = askpass {
        let _ = std::fs::remove_file(p);
    }
}

/// A remote path we are willing to interpolate into a single-quoted remote
/// command. Allowlist, not blocklist: alphanumerics plus the punctuation a
/// real log path carries (`/var/log/mysql/mariadb.err`,
/// `/opt/homebrew/var/log/mariadb-galera-1.err`). Crucially the single quote
/// itself is NOT allowed, so the `'…'` wrapping in [`tail_command`] cannot be
/// broken out of — the quote is the whole escape.
pub fn validate_remote_path(path: &str) -> Result<()> {
    if path.is_empty() {
        anyhow::bail!("remote log path is empty");
    }
    if !path.starts_with('/') {
        anyhow::bail!("remote log path must be absolute: {path:?}");
    }
    if !path.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+@: ~".contains(c)) {
        anyhow::bail!("remote log path contains characters outside the safe set: {path:?}");
    }
    Ok(())
}

/// The remote command for the SST/IST log tail: bounded initial backlog,
/// then follow. `-F` (capital) rather than `-f` so a log that does not exist
/// yet — or is rotated away mid-transfer — is retried instead of fatal.
/// Both GNU and BSD tail spell it the same, which matters because the remote
/// side is whatever the DB host runs, not the desktop we ship on.
pub fn tail_command(path: &str, backlog_lines: u32) -> Result<String> {
    validate_remote_path(path)?;
    Ok(format!("tail -n {backlog_lines} -F '{path}'"))
}

/// Spawn `ssh -T user@host '<remote_command>'` for a long-running remote
/// EXEC — the sibling of [`SshTunnel::open`], sharing its auth machinery
/// (askpass script, jump validation, key path) but running a command instead
/// of forwarding a port. `-T` disables pty allocation: the command is a
/// machine-read stream, and a pty would make ssh buffer and mangle it.
///
/// The remote command arrives as ONE argv element — no local shell ever sees
/// it; the remote shell is sshd's business, which is exactly why
/// [`validate_remote_path`] exists for anything interpolated into it.
///
/// Like the tunnel, this waits ~500 ms for the process to settle: an ssh
/// that exits in that window failed (auth, host key, unreachable), and its
/// own stderr words are the diagnosis. The caller owns the child's stdout —
/// lines read until EOF or cancel, then the child is killed.
#[allow(clippy::too_many_arguments)]
pub async fn spawn_ssh_exec(
    ssh_host:       &str,
    ssh_port:       u16,
    ssh_user:       &str,
    ssh_key_path:   Option<&str>,
    ssh_jump:       Option<&str>,
    ssh_password:   Option<&str>,
    remote_command: &str,
) -> Result<tokio::process::Child> {
    validate_endpoint(ssh_user, ssh_host)?;
    if let Some(jump) = ssh_jump {
        validate_jump(jump)?;
    }

    let askpass = match ssh_password {
        Some(_) => Some(write_askpass_script()?),
        None => None,
    };
    let use_setsid = ssh_password.is_some() && setsid_available();
    let mut cmd = if use_setsid {
        let mut c = tokio::process::Command::new("setsid");
        c.arg("ssh");
        c
    } else {
        tokio::process::Command::new("ssh")
    };

    let ssh_target = format!("{ssh_user}@{ssh_host}");
    cmd.args([
        "-T",
        "-p", &ssh_port.to_string(),
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-o", "ConnectTimeout=10",
    ]);

    if let Some(password) = ssh_password {
        // BatchMode intentionally omitted: it disables password prompts.
        let script = askpass.as_ref().ok_or_else(|| anyhow::anyhow!(
            "internal error: SSH password given but no askpass script was written"))?;
        cmd.env("SSH_ASKPASS", script)
           .env("SSH_ASKPASS_REQUIRE", "force")
           .env("DISPLAY", "txui:0")
           .env("TXUI_SSH_PASS", password);
    } else {
        cmd.args(["-o", "BatchMode=yes"]);
    }

    if let Some(jump) = ssh_jump {
        cmd.args(["-J", jump]);
    }
    if let Some(key) = ssh_key_path {
        cmd.args(["-i", key]);
    }

    cmd.arg("--")
       .arg(&ssh_target)
       .arg(remote_command)
       .stdout(std::process::Stdio::piped())
       // Piped for the caller: the galera SST tail drains it into Note events,
       // which is also where a first-contact host-key warning (accept-new
       // TOFU) surfaces on this path — the tunnel path scans it in-band
       // instead (spawn_stderr_scan).
       .stderr(std::process::Stdio::piped());

    suppress_console_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cleanup_askpass(&askpass);
            return Err(anyhow::anyhow!("Failed to spawn ssh: {}. {}", e, install_hint()));
        }
    };

    // Quick-exit = failure; read ssh's own words from stderr for the message.
    let mut result = Ok(());
    for attempt in 0..5 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut err_tail = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    use tokio::io::AsyncReadExt;
                    let mut buf = String::new();
                    let _ = stderr.read_to_string(&mut buf).await;
                    let lines: Vec<&str> = buf.lines().filter(|l| !l.trim().is_empty()).collect();
                    let tail = lines.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" | ");
                    if !tail.is_empty() {
                        err_tail = format!(" ssh said: {tail}");
                    }
                }
                result = Err(anyhow::anyhow!(
                    "SSH exec exited immediately (exit code {:?}).{} \
                     Check host/user/key and that the remote command is valid.",
                    status.code(), err_tail
                ));
                break;
            }
            Ok(None) if attempt >= 4 => break,
            Ok(None) => continue,
            Err(e) => {
                result = Err(anyhow::anyhow!("SSH process error: {}", e));
                break;
            }
        }
    }

    // ssh has settled (or failed) — the askpass helper is no longer needed.
    cleanup_askpass(&askpass);
    result?;
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jump_validation_accepts_normal_specs() {
        assert!(validate_jump("deploy@bastion.example.com").is_ok());
        assert!(validate_jump("deploy@bastion.example.com:2222").is_ok());
        assert!(validate_jump("deploy@10.0.0.1").is_ok());
        assert!(validate_jump("deploy@[2001:db8::1]:22").is_ok());
        assert!(validate_jump("a@h1,b@h2:2222").is_ok()); // chained jumps
    }

    #[test]
    fn jump_validation_rejects_shell_metachars_and_space() {
        assert!(validate_jump("").is_err());
        assert!(validate_jump("user@host; rm -rf /").is_err());
        assert!(validate_jump("user@host|cat").is_err());
        assert!(validate_jump("user@ho st").is_err());
        assert!(validate_jump("$(whoami)@host").is_err());
        assert!(validate_jump("user@host`id`").is_err());
        assert!(validate_jump("user@host\n").is_err());
    }

    #[test]
    fn endpoint_validation_accepts_real_users_and_hosts() {
        assert!(validate_endpoint("deploy", "bastion.example.com").is_ok());
        assert!(validate_endpoint("ubuntu", "10.0.0.1").is_ok());
        assert!(validate_endpoint("dba_ro", "db-host-01.internal").is_ok());
        // IPv6 literals, bracketed or bare, and a zone id.
        assert!(validate_endpoint("root", "[2001:db8::1]").is_ok());
        assert!(validate_endpoint("root", "fe80::1%eth0").is_ok());
    }

    #[test]
    fn endpoint_validation_rejects_option_injection() {
        // A leading '-' parses as another ssh OPTION wherever the element
        // sits in argv — `-oProxyCommand=…` runs through a shell.
        assert!(validate_endpoint("-oProxyCommand=evil", "host").is_err());
        assert!(validate_endpoint("user", "-oProxyCommand=evil").is_err());
        assert!(validate_endpoint("", "host").is_err());
        assert!(validate_endpoint("user", "").is_err());
        // And shell metachars/whitespace stay out, same as validate_jump.
        assert!(validate_endpoint("us er", "host").is_err());
        assert!(validate_endpoint("user", "ho`id`st").is_err());
        assert!(validate_endpoint("user", "host;rm").is_err());
    }

    #[test]
    fn remote_path_validation_accepts_real_log_paths() {
        // The live MariaDB 11.8 Galera testbed and the usual Linux layouts.
        assert!(validate_remote_path("/opt/homebrew/var/log/mariadb-galera-1.err").is_ok());
        assert!(validate_remote_path("/var/log/mysql/error.log").is_ok());
        assert!(validate_remote_path("/var/lib/mysql/db-host-01.err").is_ok());
        assert!(validate_remote_path("/home/dba/mysql logs/node.err").is_ok(), "space is legal inside single quotes");
    }

    #[test]
    fn remote_path_validation_rejects_breakout_and_relative() {
        assert!(validate_remote_path("").is_err());
        assert!(validate_remote_path("relative/path.err").is_err(), "must be absolute");
        // The single quote is the breakout character for the `'…'` wrapping.
        assert!(validate_remote_path("/x/err'; rm -rf /; echo '.log").is_err());
        assert!(validate_remote_path("/x/$(whoami).err").is_err());
        assert!(validate_remote_path("/x/`id`.err").is_err());
        assert!(validate_remote_path("/x/a;id.err").is_err());
        assert!(validate_remote_path("/x/a|cat.err").is_err());
        assert!(validate_remote_path("/x/a\nid.err").is_err());
        assert!(validate_remote_path("/x/*.err").is_err());
    }

    #[test]
    fn host_key_note_recognizes_only_the_accept_new_line() {
        assert_eq!(
            host_key_note("Warning: Permanently added 'db-01.internal' (ED25519) to the list of known hosts."),
            Some("Warning: Permanently added 'db-01.internal' (ED25519) to the list of known hosts.".to_string()),
        );
        // IPv6 / jump-host spellings carry extra punctuation.
        assert!(host_key_note("Warning: Permanently added '[2001:db8::1]:22' (RSA) to the list of known hosts.").is_some());
        // Not every ssh warning is a host-key acceptance.
        assert!(host_key_note("Warning: remote port forwarding failed for listen port 53306").is_none());
        assert!(host_key_note("Permission denied (publickey).").is_none());
        assert!(host_key_note("").is_none());
    }

    #[test]
    fn tail_command_wraps_single_quoted_with_backlog() {
        let c = tail_command("/var/log/mysql/error.log", 200).unwrap();
        assert_eq!(c, "tail -n 200 -F '/var/log/mysql/error.log'");
        // A rejected path must fail BEFORE a command string exists.
        assert!(tail_command("/x/err';id;'.log", 200).is_err());
    }

    // ── tunnel readiness polling ─────────────────────────────────────────────

    /// The readiness probe is a plain loopback connect: true on a listener,
    /// false on a closed port (refusal is immediate, so this is cheap).
    #[tokio::test]
    async fn port_accepts_only_when_something_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_accepts(port).await, "a bound listener must accept");
        drop(listener);
        assert!(!port_accepts(port).await, "nothing listening must not accept");
    }

    /// The race this fixes, replayed: ssh binds the -L port only AFTER auth,
    /// so a fixed settle saw "still running" and reported success against a
    /// port nothing listened on. Polling must wait for the bind to appear.
    #[tokio::test]
    async fn polling_waits_for_a_late_listener() {
        // Reserve a free port, release it, then bind it 300 ms "late" — the
        // stand-in for ssh binding the forward only once auth has completed.
        let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let delayed = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            TcpListener::bind(("127.0.0.1", port)).await.unwrap()
        });

        let start = std::time::Instant::now();
        let mut ready = false;
        while start.elapsed() < Duration::from_secs(5) {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if port_accepts(port).await { ready = true; break; }
        }
        assert!(ready, "the poll must notice the late bind");
        assert!(start.elapsed() >= Duration::from_millis(250),
                "it must have WAITED for the bind, not won a race: {:?}", start.elapsed());
        drop(delayed);
    }

    // ── tunnel liveness watch (W4.5) ─────────────────────────────────────────

    /// A portable quick-exit child: the test binary itself in `--list` mode —
    /// spawns and exits 0 on every desktop, no ssh or shell needed.
    fn spawn_quick_exit_child() -> tokio::process::Child {
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn current exe --list")
    }

    #[test]
    fn exit_reason_names_the_code_or_the_signal() {
        assert_eq!(tunnel_exit_reason(Some(255)),
            "the ssh tunnel process exited unexpectedly (exit code 255)");
        assert_eq!(tunnel_exit_reason(None),
            "the ssh tunnel process was terminated by a signal");
    }

    /// An ssh that dies under a live session: the watcher notices and reports
    /// the exit code.
    #[tokio::test]
    async fn watcher_reports_an_unexpected_exit() {
        let child = std::sync::Arc::new(tokio::sync::Mutex::new(spawn_quick_exit_child()));
        let disarmed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let code = watch_child_exit(child, disarmed, Duration::from_millis(20)).await;
        assert_eq!(code, Some(Some(0)), "--list exits 0, and the watch must report it");
    }

    /// A deliberate teardown must NOT be reported — the disarm flag (set by
    /// Drop) wins even when the child exits during the watch.
    #[tokio::test]
    async fn a_disarmed_watch_never_reports() {
        let child = std::sync::Arc::new(tokio::sync::Mutex::new(spawn_quick_exit_child()));
        let disarmed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let code = watch_child_exit(child, disarmed, Duration::from_millis(20)).await;
        assert_eq!(code, None, "a deliberate close is not a lost tunnel");
    }

    /// Drop is the deliberate-close path: it disarms (so the watcher stays
    /// quiet) and still kills the child.
    #[tokio::test]
    async fn drop_disarms_the_watcher() {
        let tunnel = SshTunnel {
            local_port: 1,
            host_key_note: None,
            child: std::sync::Arc::new(tokio::sync::Mutex::new(spawn_quick_exit_child())),
            disarmed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        let (child, disarmed) = tunnel.watch_handles();
        drop(tunnel);
        assert!(disarmed.load(std::sync::atomic::Ordering::SeqCst),
            "Drop must disarm before anything else");

        // The child exits (killed by Drop, or already done on its own) — the
        // watcher must return quiet either way.
        let code = watch_child_exit(child, disarmed, Duration::from_millis(20)).await;
        assert_eq!(code, None);
    }
}
