//! The default, **no-password** storage backend.
//!
//! When the encrypted vault is not enabled, txui keeps:
//!   * `connections.json` — the connection list, plain JSON
//!   * `folders.json`     — folder attributes, plain JSON
//!   * `secrets.json`     — passwords, **machine-obfuscated**
//!
//! There is no master password and no unlock prompt — the app opens straight
//! into its connections, the way most tools behave by default.
//!
//! "Machine-obfuscated" is deliberately *not* the same claim as the vault. The
//! secrets file is AES-GCM-sealed under a key derived from this machine + user,
//! so a casual look at the file, or a copy swept into a cloud-sync folder or a
//! backup, does not show passwords in the clear. It is **not** real protection:
//! anyone with this code running on this machine can derive the same key. The
//! vault (Argon2id + a password you know) remains the real-security option; this
//! is the honest "common" default the user asked for. See `plan-vault-optional.md`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use super::vaultfile::Contents;
use crate::db::types::ConnectionConfig;

pub fn connections_path(dir: &Path) -> PathBuf { dir.join("connections.json") }
pub fn folders_path(dir: &Path) -> PathBuf { dir.join("folders.json") }
pub fn secrets_path(dir: &Path) -> PathBuf { dir.join("secrets.json") }

/// True if any plain-mode file is present — i.e. this profile has been used in
/// plain mode.
pub fn any_exists(dir: &Path) -> bool {
    connections_path(dir).exists() || secrets_path(dir).exists() || folders_path(dir).exists()
}

// ── connections / folders: plain JSON (not secret — hostnames/tags, by design) ─

pub fn read_connections(dir: &Path) -> Vec<ConnectionConfig> {
    std::fs::read_to_string(connections_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn read_folders(dir: &Path) -> serde_json::Value {
    std::fs::read_to_string(folders_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

pub fn write_connections(dir: &Path, list: &[ConnectionConfig]) -> std::io::Result<()> {
    let mut sorted = list.to_vec();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    let text = serde_json::to_string_pretty(&sorted).map_err(std::io::Error::other)?;
    write_atomic(&connections_path(dir), &text)
}

pub fn write_folders(dir: &Path, folders: &serde_json::Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(folders).map_err(std::io::Error::other)?;
    write_atomic(&folders_path(dir), &text)
}

// ── secrets: machine-obfuscated ───────────────────────────────────────────────

/// The on-disk envelope for `secrets.json`. `data` is base64(nonce ‖ ciphertext).
#[derive(Serialize, Deserialize)]
struct SecretsFile {
    v: u32,
    data: String,
}

/// A 32-byte key bound to this machine + user + profile dir. Not a password —
/// obfuscation only. sha2 (a direct dep) keeps it dependency-free.
fn machine_key(dir: &Path) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let host = sysinfo::System::host_name().unwrap_or_default();
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let mut h = Sha256::new();
    h.update(b"TxUI/plain-secrets/v1/machine-obfuscation/do-not-change");
    h.update(b"\x00");
    h.update(host.as_bytes());
    h.update(b"\x00");
    h.update(user.as_bytes());
    h.update(b"\x00");
    h.update(dir.to_string_lossy().as_bytes());
    let out = h.finalize();
    let mut k = [0u8; 32];
    k.copy_from_slice(&out[..32]);
    k
}

pub fn read_secrets(dir: &Path) -> BTreeMap<String, String> {
    let Ok(text) = std::fs::read_to_string(secrets_path(dir)) else {
        return BTreeMap::new();
    };
    let Ok(file) = serde_json::from_str::<SecretsFile>(&text) else {
        return BTreeMap::new();
    };
    // Machine id changed, file copied from another host, or tampered → treat as
    // empty. Connections still load (they're plain JSON); the user re-enters
    // passwords. Never crash the app over an unreadable secrets file.
    decrypt(dir, &file).unwrap_or_default()
}

fn decrypt(dir: &Path, file: &SecretsFile) -> Result<BTreeMap<String, String>> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD.decode(&file.data)?;
    if raw.len() < 13 {
        bail!("secrets file too short");
    }
    let (nonce, ct) = raw.split_at(12);
    let key = machine_key(dir);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| anyhow::anyhow!("secrets decrypt failed (different machine?)"))?;
    Ok(serde_json::from_slice(&pt)?)
}

pub fn write_secrets(dir: &Path, secrets: &BTreeMap<String, String>) -> std::io::Result<()> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use base64::Engine as _;
    use rand::TryRngCore;

    let pt = serde_json::to_vec(secrets).map_err(std::io::Error::other)?;
    let key = machine_key(dir);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(std::io::Error::other)?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), pt.as_ref())
        .map_err(|_| std::io::Error::other("obfuscation failed"))?;
    let mut raw = nonce.to_vec();
    raw.extend_from_slice(&ct);
    let file = SecretsFile {
        v: 1,
        data: base64::engine::general_purpose::STANDARD.encode(&raw),
    };
    let text = serde_json::to_string(&file).map_err(std::io::Error::other)?;
    write_atomic(&secrets_path(dir), &text)
}

pub fn get_secret(dir: &Path, key: &str) -> Option<String> {
    read_secrets(dir).get(key).cloned()
}

pub fn set_secret(dir: &Path, key: &str, val: &str) -> std::io::Result<()> {
    let mut m = read_secrets(dir);
    m.insert(key.to_string(), val.to_string());
    write_secrets(dir, &m)
}

pub fn delete_secret(dir: &Path, key: &str) {
    let mut m = read_secrets(dir);
    if m.remove(key).is_some() {
        let _ = write_secrets(dir, &m);
    }
}

// ── whole-store read/write, for enable/disable migration ──────────────────────

pub fn read_contents(dir: &Path) -> Contents {
    Contents {
        connections: read_connections(dir),
        folders: read_folders(dir),
        secrets: read_secrets(dir),
    }
}

pub fn write_contents(dir: &Path, c: &Contents) -> Result<()> {
    write_connections(dir, &c.connections)?;
    write_folders(dir, &c.folders)?;
    write_secrets(dir, &c.secrets)?;
    Ok(())
}

/// Delete every plain-mode file (used after folding them into a new vault).
pub fn remove_all(dir: &Path) {
    for p in [connections_path(dir), folders_path(dir), secrets_path(dir)] {
        let _ = std::fs::remove_file(p);
    }
}

// ── shared atomic write (temp + rename, owner-only) ───────────────────────────

fn write_atomic(target: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(d) = target.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = target.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        restrict_to_owner(&f)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, target)
}

fn restrict_to_owner(f: &std::fs::File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let _ = f.metadata()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_round_trip_and_obfuscated_on_disk() {
        let dir = std::env::temp_dir().join(format!("txui-plain-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let mut m = BTreeMap::new();
        m.insert("dbgui:abc".to_string(), "s3cr3t-passw0rd".to_string());
        write_secrets(&dir, &m).unwrap();

        // Round-trips.
        assert_eq!(get_secret(&dir, "dbgui:abc").as_deref(), Some("s3cr3t-passw0rd"));

        // The password is not sitting in the file in clear text.
        let raw = std::fs::read_to_string(secrets_path(&dir)).unwrap();
        assert!(!raw.contains("s3cr3t-passw0rd"), "secret must be obfuscated on disk");

        delete_secret(&dir, "dbgui:abc");
        assert_eq!(get_secret(&dir, "dbgui:abc"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_secrets_degrade_to_empty() {
        let dir = std::env::temp_dir().join(format!("txui-plain-bad-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(secrets_path(&dir), r#"{"v":1,"data":"not-base64!!!"}"#).unwrap();
        assert!(read_secrets(&dir).is_empty(), "garbage file must not crash");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
