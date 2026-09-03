//! SSH agent status — informational, for the connection form.
//!
//! When an SSH tunnel is configured with neither a key file nor a password,
//! `ssh` falls back to the keys loaded in the running ssh-agent (and the default
//! `~/.ssh/id_*`). The form can't know whether that will work, so this reports
//! whether an agent is reachable and how many identities it holds — enough for a
//! pill that tells the user "you can leave the key blank" or "load a key first".

use serde::Serialize;

#[derive(Serialize)]
pub struct SshAgentStatus {
    /// An agent socket is reachable (even if it holds no keys).
    pub available: bool,
    /// Identities currently loaded in the agent.
    pub key_count: u32,
}

/// Query the local ssh-agent. Never fails — an unreachable agent is a normal,
/// reportable state, not an error.
#[tauri::command]
pub async fn ssh_agent_status() -> SshAgentStatus {
    // No socket advertised → no agent, without spawning anything.
    if std::env::var_os("SSH_AUTH_SOCK").is_none() {
        return SshAgentStatus { available: false, key_count: 0 };
    }
    match tokio::process::Command::new("ssh-add").arg("-l").output().await {
        // exit 0: one identity per non-empty line.
        Ok(o) if o.status.success() => {
            let n = String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32;
            SshAgentStatus { available: true, key_count: n }
        }
        // exit 1: agent reachable but holds no identities.
        Ok(o) if o.status.code() == Some(1) => SshAgentStatus { available: true, key_count: 0 },
        // exit 2 / spawn failure: no usable agent.
        _ => SshAgentStatus { available: false, key_count: 0 },
    }
}
