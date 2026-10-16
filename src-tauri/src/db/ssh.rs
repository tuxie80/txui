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
    child: tokio::process::Child,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        // Best-effort async kill — cannot await in Drop
        let _ = self.child.start_kill();
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

impl SshTunnel {
    /// Spawn `ssh -N -L local_port:db_host:db_port user@ssh_host` and wait
    /// up to 1 second for the process to stabilise (quick-exit = failure).
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
    ) -> Result<Self> {
        match Self::open_once(ssh_host, ssh_port, ssh_user, ssh_key_path, db_host, db_port,
                              ssh_jump, ssh_password).await {
            // The local port is chosen by bind:0 and then RELEASED before ssh
            // binds it — another process can claim it in that window, and ssh
            // exits at once under ExitOnForwardFailure. "Address already in
            // use" is that lost race: pick a fresh port and try once more.
            // The race itself cannot be closed (ssh owns the bind; there is
            // no way to hand it a ready fd), so one retry is an honest
            // mitigation, not a guarantee.
            Err(e) if e.to_string().contains("Address already in use") =>
                Self::open_once(ssh_host, ssh_port, ssh_user, ssh_key_path, db_host, db_port,
                                ssh_jump, ssh_password).await,
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
            let script = askpass.as_ref().expect("askpass script written above");
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

        // Poll for 1 s; if the process exits early that indicates a failure
        let mut result = Ok(());
        for attempt in 0..10 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            match child.try_wait() {
                Ok(Some(status)) => {
                    // The process has exited, so the drain task is at EOF or
                    // about to be — give it a moment, then read ssh's own
                    // words from the tail it kept.
                    if let Some(t) = scan_task { let _ = t.await; }
                    let mut err_tail = String::new();
                    if let Some(scan) = &scan {
                        let tail = scan.tail.lock().unwrap();
                        let lines: Vec<&String> = tail.iter().filter(|l| !l.trim().is_empty()).collect();
                        let tail_text = lines.iter().rev().take(3).rev()
                            .map(|s| s.as_str()).collect::<Vec<_>>().join(" | ");
                        if !tail_text.is_empty() {
                            err_tail = format!(" ssh said: {tail_text}");
                        }
                    }
                    result = Err(anyhow::anyhow!(
                        "SSH tunnel exited immediately (exit code {:?}).{} \
                         Check host/user/key and that the remote DB is reachable.",
                        status.code(), err_tail
                    ));
                    break;
                }
                Ok(None) if attempt >= 4 => break, // 500 ms elapsed and still running
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

        log::info!(
            "SSH tunnel ready: localhost:{} → {}:{}  (via {}@{}:{})",
            local_port, db_host, db_port, ssh_user, ssh_host, ssh_port
        );

        // Host-key acceptance happens during the handshake, before auth — a
        // first-contact note is essentially always captured within the settle
        // window above. A pathologically slow kex that lands it later still
        // gets the drain task's log::warn!, just not the audit row.
        let host_key_note = scan.and_then(|s| s.host_key.lock().unwrap().clone());

        Ok(SshTunnel { local_port, host_key_note, child })
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
        let script = askpass.as_ref().expect("askpass script written above");
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
}
