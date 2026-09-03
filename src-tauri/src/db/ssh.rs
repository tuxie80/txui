/// SSH tunnel via the system `ssh` binary.
/// Opens an SSH port-forwarding process and returns the local port to connect to.
use anyhow::Result;
use std::time::Duration;
use tokio::net::TcpListener;

pub struct SshTunnel {
    pub local_port: u16,
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

        cmd.arg(&ssh_target)
           .stdout(std::process::Stdio::null())
           // Captured, not nulled: when the tunnel dies at birth, ssh's own
           // words ("Permission denied", "Connection refused", a host-key
           // complaint) are the diagnosis — "exit code Some(255)" was not.
           .stderr(std::process::Stdio::piped());

        // A GUI app spawning a console program on Windows pops a console
        // window — here, one per tunnel, for as long as the tunnel lives.
        // CREATE_NO_WINDOW suppresses it. There is no Unix equivalent because
        // there is no Unix problem.
        //
        // `creation_flags` is tokio's own Windows-only method (it forwards to
        // `std::os::windows::process::CommandExt`), so importing that trait
        // here would not help and does not compile: tokio's `Command` is not
        // std's.
        //
        // This calls a Windows-only API: `dev/xplat_check.sh` forces Windows
        // gates on while compiling against the local toolchain, where this
        // method does not exist, so checking it there would fail for a reason
        // that has nothing to do with this branch. The marker below opts this
        // one gate out, and must stay on the line directly above it.
        // xplat-skip
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                cleanup_askpass(&askpass);
                return Err(anyhow::anyhow!("Failed to spawn ssh: {}. {}", e, install_hint()));
            }
        };

        // Poll for 1 s; if the process exits early that indicates a failure
        let mut result = Ok(());
        for attempt in 0..10 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Read the tail of ssh's stderr — its own words are the
                    // diagnosis. Bounded read: the process has exited, so the
                    // pipe is finite, but keep only the last few lines.
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

        Ok(SshTunnel { local_port, child })
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
}
