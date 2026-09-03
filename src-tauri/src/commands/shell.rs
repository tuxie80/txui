//! TxShell's `!` passthrough — hand a line to the user's real shell.
//!
//! TxShell deliberately ships none of FluidShell's twenty filesystem and
//! network commands (`cp`, `rm`, `tar`, `zip`, `scp`, `ssh`, …). Reimplementing
//! a shell inside a database tool means a second-rate one with a large
//! destructive surface and no benefit; the user already has a real shell that
//! is better at all of it and already configured. So `!` hands the line over
//! verbatim — pipes, redirects and all — and `!ls | wc -l` means here exactly
//! what it means in a terminal.
//!
//! The line is passed to the platform's shell unaltered — `$SHELL -c` on
//! Unix, `%ComSpec% /C` (cmd.exe) on Windows. That is not an injection risk in
//! the usual sense — the user typed it, for their own machine, and it is the
//! literal purpose of the command — but it *is* arbitrary execution, so it is
//! bounded: a timeout, a capped output, and no shell is spawned for an empty
//! line.

use serde::Serialize;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// What a passthrough produced.
#[derive(Debug, Clone, Serialize)]
pub struct OsOutput {
    pub stdout: String,
    pub stderr: String,
    /// None when the process was killed by a signal or the timeout.
    pub code: Option<i32>,
    /// Set when output was cut short, so the UI can say so rather than imply
    /// the command produced exactly this much.
    pub truncated: bool,
    pub timed_out: bool,
    pub ms: u64,
}

/// Longest a passthrough may run before it is killed.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Cap per stream. A `!cat` of something enormous should not be pasted into a
/// transcript that lives in the renderer's memory.
const MAX_BYTES: usize = 256 * 1024;

fn clamp(mut s: Vec<u8>) -> (String, bool) {
    let truncated = s.len() > MAX_BYTES;
    if truncated {
        s.truncate(MAX_BYTES);
    }
    (String::from_utf8_lossy(&s).into_owned(), truncated)
}

/// The user's shell and the flag that makes it run one command line.
///
/// `SHELL` is a Unix convention and is simply absent on Windows, where the
/// equivalent is `ComSpec` and the flag is `/C` rather than `-c`. Reading
/// `SHELL` on Windows and falling back to `/bin/sh` — which is what this used
/// to do — means every `!` command fails to spawn.
///
/// PowerShell is deliberately not the default: `!dir | findstr x` should mean
/// what it means in the terminal the user already has open, and `cmd.exe` is
/// what `ComSpec` names on a default install. Someone who prefers PowerShell
/// can set `ComSpec`.
fn user_shell() -> (String, &'static str) {
    #[cfg(windows)]
    {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        (shell, "/C")
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        (shell, "-c")
    }
}

/// Run one command line in the user's shell.
///
/// `cwd` is the shell's working directory, so `\cd` can move around without a
/// persistent child process — each call is independent, which also means a
/// command that hangs cannot wedge the shell for the rest of the session.
#[tauri::command]
pub async fn run_os_command(command: String, cwd: Option<String>) -> Result<OsOutput, crate::apperror::AppError> {
    let line = command.trim().to_string();
    if line.is_empty() {
        return Err("nothing to run".into());
    }

    let started = std::time::Instant::now();
    let (shell, flag) = user_shell();

    let mut cmd = tokio::process::Command::new(&shell);
    cmd.arg(flag)
        .arg(&line)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not start {shell}: {e}"))?;
    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let collect = async {
        // Both streams are drained concurrently. Reading one to completion
        // first deadlocks as soon as the other fills its pipe buffer — which a
        // command writing a lot to stderr does immediately.
        let a = async {
            if let Some(s) = stdout.as_mut() { let _ = s.read_to_end(&mut out_buf).await; }
        };
        let b = async {
            if let Some(s) = stderr.as_mut() { let _ = s.read_to_end(&mut err_buf).await; }
        };
        tokio::join!(a, b);
        child.wait().await
    };

    let (status, timed_out) = match tokio::time::timeout(TIMEOUT, collect).await {
        Ok(res) => (res.ok().and_then(|s| s.code()), false),
        Err(_) => (None, true),
    };

    let (stdout_s, cut_out) = clamp(out_buf);
    let (stderr_s, cut_err) = clamp(err_buf);

    Ok(OsOutput {
        stdout: stdout_s,
        stderr: stderr_s,
        code: status,
        truncated: cut_out || cut_err,
        timed_out,
        ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_capped_and_says_so() {
        let (s, cut) = clamp(vec![b'x'; MAX_BYTES + 10]);
        assert_eq!(s.len(), MAX_BYTES);
        assert!(cut, "truncation must be reported, not silent");

        let (s2, cut2) = clamp(b"short".to_vec());
        assert_eq!(s2, "short");
        assert!(!cut2);
    }

    #[test]
    fn the_shell_and_its_flag_match_the_platform() {
        // Reading SHELL on Windows lands on /bin/sh, which does not exist —
        // every `!` command then fails to spawn.
        let (shell, flag) = user_shell();
        assert!(!shell.is_empty());
        #[cfg(windows)]
        {
            assert_eq!(flag, "/C");
            assert!(shell.to_lowercase().contains("cmd") || shell.to_lowercase().contains("exe"));
        }
        #[cfg(not(windows))]
        {
            assert_eq!(flag, "-c");
            assert!(shell.starts_with('/'), "expected an absolute path, got {shell}");
        }
    }

    #[test]
    fn invalid_utf8_does_not_panic() {
        // A binary file catted into the shell must not take the app down.
        let (s, _) = clamp(vec![0xff, 0xfe, b'a']);
        assert!(s.contains('a'));
    }
}
