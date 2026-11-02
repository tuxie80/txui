//! SSH agent status — informational, for the connection form.
//!
//! When an SSH tunnel is configured with neither a key file nor a password,
//! `ssh` falls back to the keys loaded in the running ssh-agent (and the default
//! `~/.ssh/id_*`). The form can't know whether that will work, so this reports
//! whether an agent is reachable and how many identities it holds — enough for a
//! pill that tells the user "you can leave the key blank" or "load a key first".

use anyhow::{Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SshHostKey {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub key_base64: String,
    pub fingerprint: String,
    pub known_hosts_line: String,
}

fn unbracketed_host(host: &str) -> &str {
    host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host)
}

fn known_host_name(host: &str, port: u16) -> String {
    let host = unbracketed_host(host);
    if port == 22 { host.to_string() } else { format!("[{host}]:{port}") }
}

fn validate_scan_host(host: &str) -> Result<()> {
    if host.is_empty() || host.starts_with('-')
        || !host.chars().all(|c| c.is_ascii_alphanumeric() || "._:[]%-".contains(c))
    {
        anyhow::bail!("SSH host contains invalid characters: {host:?}");
    }
    Ok(())
}

fn fingerprint(key_base64: &str) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(key_base64)
        .context("SSH host key is not valid base64")?;
    if bytes.is_empty() || bytes.len() > 16 * 1024 {
        anyhow::bail!("SSH host key has an invalid size");
    }
    Ok(format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD
        .encode(Sha256::digest(bytes))))
}

fn parse_scanned_key(line: &str, host: &str, port: u16) -> Result<SshHostKey> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() != 3 {
        anyhow::bail!("Unexpected ssh-keyscan output");
    }
    let expected_host = known_host_name(host, port);
    if fields[0] != expected_host {
        anyhow::bail!("ssh-keyscan returned a key for a different host");
    }
    if fields[1].is_empty() || fields[1].len() > 128
        || !fields[1].chars().all(|c| c.is_ascii_alphanumeric() || "-@.".contains(c))
    {
        anyhow::bail!("SSH host key algorithm is invalid");
    }
    let key_base64 = fields[2].to_string();
    let fingerprint = fingerprint(&key_base64)?;
    Ok(SshHostKey {
        host: host.to_string(), port,
        algorithm: fields[1].to_string(), key_base64,
        fingerprint,
        known_hosts_line: format!("{expected_host} {} {}", fields[1], fields[2]),
    })
}

fn append_known_host(path: &Path, key: &SshHostKey) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true).read(true).append(true).open(path)
        .with_context(|| format!("Cannot open {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        // The file inherits the per-user profile ACL on Windows.
        let _ = &file;
    }
    for line in std::io::BufReader::new(file.try_clone()?).lines() {
        if line? == key.known_hosts_line { return Ok(()); }
    }
    let needs_newline = file.metadata()?.len() > 0 && {
        file.seek(std::io::SeekFrom::End(-1))?;
        let mut last = [0_u8; 1];
        file.read_exact(&mut last)?;
        last[0] != b'\n'
    };
    file.seek(std::io::SeekFrom::End(0))?;
    if needs_newline { file.write_all(b"\n")?; }
    writeln!(file, "{}", key.known_hosts_line)?;
    file.sync_all()?;
    Ok(())
}

/// Read the server's public host key without authenticating. The result is
/// explicitly unverified until the user compares its fingerprint independently.
#[tauri::command]
pub async fn ssh_host_key_probe(host: String, port: u16) -> Result<Vec<SshHostKey>, String> {
    validate_scan_host(&host).map_err(|e| e.to_string())?;
    if port == 0 { return Err("SSH port must be between 1 and 65535".into()); }
    let mut cmd = tokio::process::Command::new("ssh-keyscan");
    cmd.args(["-T", "10", "-p", &port.to_string(), unbracketed_host(&host)])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::db::ssh::suppress_console_window(&mut cmd);
    let output = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await
        .map_err(|_| "SSH host-key probe timed out".to_string())?
        .map_err(|e| format!("Cannot run ssh-keyscan: {e}. Install the OpenSSH client."))?;
    let text = String::from_utf8(output.stdout)
        .map_err(|_| "ssh-keyscan returned non-UTF-8 output".to_string())?;
    let mut keys = Vec::new();
    for line in text.lines().filter(|l| !l.is_empty() && !l.starts_with('#')).take(16) {
        match parse_scanned_key(line, &host, port) {
            Ok(key) => keys.push(key),
            Err(e) => return Err(e.to_string()),
        }
    }
    if keys.is_empty() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.lines().filter(|l| !l.starts_with('#')).take(2).collect::<Vec<_>>().join(" | ");
        return Err(if detail.is_empty() {
            "No SSH host keys returned; check the host and port".to_string()
        } else { format!("No SSH host keys returned: {detail}") });
    }
    Ok(keys)
}

/// Append the exact key the user confirmed. Host, port, algorithm, key bytes
/// and fingerprint are all checked again so a stale or altered dialog cannot
/// enroll a different endpoint or key.
#[tauri::command]
pub async fn ssh_trust_host_key(app: tauri::AppHandle, host: String, port: u16, key: SshHostKey) -> Result<(), String> {
    validate_scan_host(&host).map_err(|e| e.to_string())?;
    if port == 0 { return Err("SSH port must be between 1 and 65535".into()); }
    if key.host != host || key.port != port {
        return Err("The scanned key no longer matches the SSH host and port".into());
    }
    let reparsed = parse_scanned_key(&key.known_hosts_line, &host, port).map_err(|e| e.to_string())?;
    if reparsed != key {
        return Err("The SSH host key changed after it was scanned; probe it again".into());
    }
    let home = app.path().home_dir().map_err(|e| format!("Cannot locate the user profile: {e}"))?;
    let dir: PathBuf = home.join(".ssh");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Cannot secure {}: {e}", dir.display()))?;
    }
    append_known_host(&dir.join("known_hosts"), &key).map_err(|e| e.to_string())
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn scanned(host: &str, port: u16) -> SshHostKey {
        parse_scanned_key(&format!("{} ssh-ed25519 YWJj", known_host_name(host, port)), host, port).unwrap()
    }

    #[test]
    fn scanned_key_has_an_openssh_sha256_fingerprint() {
        let key = scanned("db.example.com", 22);
        assert_eq!(key.fingerprint, "SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0");
        assert_eq!(key.known_hosts_line, "db.example.com ssh-ed25519 YWJj");
        assert_eq!(scanned("db.example.com", 2222).known_hosts_line,
            "[db.example.com]:2222 ssh-ed25519 YWJj");
        assert_eq!(known_host_name("[2001:db8::1]", 22), "2001:db8::1");
        assert_eq!(known_host_name("[2001:db8::1]", 2222), "[2001:db8::1]:2222");
        assert!(parse_scanned_key("db.example sk-ssh-ed25519@openssh.com YWJj", "db.example", 22).is_ok());
    }

    #[tokio::test]
    async fn probe_rejects_port_zero_before_spawning() {
        assert!(ssh_host_key_probe("db.example".into(), 0).await.is_err());
    }

    #[test]
    fn scanner_rejects_endpoint_substitution_and_option_injection() {
        assert!(parse_scanned_key("other.example ssh-ed25519 YWJj", "db.example", 22).is_err());
        assert!(validate_scan_host("-oProxyCommand=evil").is_err());
        assert!(validate_scan_host("host;id").is_err());
        assert!(validate_scan_host("host\nother").is_err());
    }

    #[test]
    fn trust_appends_the_exact_key_once_and_preserves_an_unterminated_file() {
        let dir = std::env::temp_dir().join(format!("txui-ssh-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts");
        std::fs::write(&path, "existing.example ssh-ed25519 ZGVm").unwrap();
        let key = scanned("db.example", 22);
        append_known_host(&path, &key).unwrap();
        append_known_host(&path, &key).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "existing.example ssh-ed25519 ZGVm\ndb.example ssh-ed25519 YWJj\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
