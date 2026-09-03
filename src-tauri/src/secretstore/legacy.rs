//! Reading what earlier versions left on disk, so upgrading to the single
//! encrypted vault does not lose anything.
//!
//! v1 was a flat `{ "key": base64(nonce ‖ ciphertext) }` map with no header,
//! encrypted under `SHA-256(machine-id ‖ pepper)` and no associated data. The
//! v2 reader cannot parse it — without this module an upgrade would look
//! exactly like "all my passwords vanished", which is the worst possible way
//! to ship a security improvement.
//!
//! The v1 machine-id chain is reproduced **verbatim**, including its flaws
//! (Windows used `%COMPUTERNAME%`, and there was a constant fallback), because
//! the goal is to decrypt what v1 actually wrote — not what it should have
//! written. Everything read here is immediately re-sealed under v2.
//!
//! This module can be deleted once no v1 vaults remain in the wild.

use std::collections::HashMap;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use sha2::{Digest, Sha256};

const PEPPER: &[u8] = b"TxUI/secretstore/v1/6c8fff-do-not-change";

/// Exactly the v1 identifier chain. Do not "fix" anything here: a corrected
/// value derives a different key and the old file stops opening.
fn v1_machine_id() -> String {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .map(|o| o.stdout)
            .unwrap_or_default();
        if let Some(id) = String::from_utf8_lossy(&out)
            .lines()
            .find(|l| l.contains("IOPlatformUUID"))
            .and_then(|l| l.split('=').nth(1))
            .map(|v| v.trim().trim_matches('"').to_string())
            .filter(|v| !v.is_empty())
        {
            return id;
        }
    }
    #[cfg(target_os = "linux")]
    {
        for p in [
            "/etc/machine-id",
            "/var/lib/dbus/machine-id",
            "/sys/class/dmi/id/product_uuid",
        ] {
            if let Some(v) = std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()) {
                if !v.is_empty() {
                    return v;
                }
            }
        }
        if let Ok(h) = std::env::var("HOSTNAME") {
            if !h.trim().is_empty() {
                return h.trim().to_string();
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(c) = std::env::var("COMPUTERNAME") {
            if !c.trim().is_empty() {
                return c.trim().to_string();
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        for var in ["HOSTNAME", "COMPUTERNAME"] {
            if let Ok(v) = std::env::var(var) {
                if !v.trim().is_empty() {
                    return v.trim().to_string();
                }
            }
        }
    }
    "txui-default-host".into()
}

fn v1_cipher() -> Aes256Gcm {
    let mut h = Sha256::new();
    h.update(v1_machine_id().as_bytes());
    h.update(PEPPER);
    let key = h.finalize();
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
}

/// Is the file at `path` a v1 vault? v1 has no `format` field; v2 always does.
pub fn is_v1(path: &Path) -> bool {
    let Ok(raw) = std::fs::read(path) else { return false };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) else { return false };
    let Some(map) = v.as_object() else { return false };
    !map.contains_key("format") && map.values().all(|x| x.is_string())
}

/// Decrypt every v1 entry. Entries that do not decrypt (written on another
/// machine) are skipped rather than aborting the whole migration — recovering
/// most passwords beats recovering none.
pub fn read_all(path: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else { return out };
    let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&raw) else { return out };
    let cipher = v1_cipher();
    for (k, b64) in map {
        let Ok(blob) = base64::engine::general_purpose::STANDARD.decode(&b64) else { continue };
        if blob.len() < 13 {
            continue;
        }
        let (nonce, ct) = blob.split_at(12);
        if let Ok(pt) = cipher.decrypt(Nonce::from_slice(nonce), ct) {
            if let Ok(s) = String::from_utf8(pt) {
                out.insert(k, s);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::OsRng;
    use aes_gcm::aead::rand_core::RngCore;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("txui-legacy-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("secrets.enc")
    }

    /// Write a file exactly the way v1 did.
    fn write_v1(path: &Path, entries: &[(&str, &str)]) {
        let cipher = v1_cipher();
        let mut map = HashMap::new();
        for (k, v) in entries {
            let mut nonce = [0u8; 12];
            OsRng.fill_bytes(&mut nonce);
            let ct = cipher.encrypt(Nonce::from_slice(&nonce), v.as_bytes()).unwrap();
            let mut blob = nonce.to_vec();
            blob.extend_from_slice(&ct);
            map.insert(
                k.to_string(),
                base64::engine::general_purpose::STANDARD.encode(&blob),
            );
        }
        std::fs::write(path, serde_json::to_string(&map).unwrap()).unwrap();
    }

    #[test]
    fn a_v1_file_is_recognised_and_fully_read() {
        let p = tmp("read");
        write_v1(&p, &[("dbgui:1", "old-password"), ("dbgui-ssh:1", "old-ssh")]);
        assert!(is_v1(&p));
        let got = read_all(&p);
        assert_eq!(got.get("dbgui:1").map(String::as_str), Some("old-password"));
        assert_eq!(got.get("dbgui-ssh:1").map(String::as_str), Some("old-ssh"));
    }

    #[test]
    fn a_v2_file_is_not_mistaken_for_v1() {
        // v2 has a `format` field; misreading it as v1 would produce garbage.
        let p = tmp("v2");
        std::fs::write(&p, r#"{"format":2,"key_source":"machine","salt":"x","entries":{}}"#).unwrap();
        assert!(!is_v1(&p));
        assert!(read_all(&p).is_empty());
    }

    #[test]
    fn junk_is_not_a_v1_file_and_never_panics() {
        let p = tmp("junk");
        std::fs::write(&p, "not json").unwrap();
        assert!(!is_v1(&p));
        assert!(read_all(&p).is_empty());

        std::fs::write(&p, r#"{"k": 12}"#).unwrap();  // values must be strings
        assert!(!is_v1(&p));

        std::fs::write(&p, r#"{"k": "not-base64!!"}"#).unwrap();
        assert!(is_v1(&p));            // shape matches…
        assert!(read_all(&p).is_empty()); // …but nothing decrypts
    }

    #[test]
    fn an_undecryptable_entry_does_not_lose_the_others() {
        // One entry from another machine must not abort the whole migration.
        let p = tmp("partial");
        write_v1(&p, &[("good", "keeps-working")]);
        let mut map: HashMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        map.insert(
            "foreign".into(),
            base64::engine::general_purpose::STANDARD.encode([0u8; 40]),
        );
        std::fs::write(&p, serde_json::to_string(&map).unwrap()).unwrap();

        let got = read_all(&p);
        assert_eq!(got.get("good").map(String::as_str), Some("keeps-working"));
        assert!(!got.contains_key("foreign"));
    }
}


// ── Folding an older installation into the vault ─────────────────────────────

/// Everything a pre-vault installation had, gathered for `secretstore::create`.
///
/// Three shapes have existed: `connections.json` + `folders.json` in the clear,
/// and secrets in either the v1 flat file or the v2 keyed vault. All of them
/// are read best-effort — recovering most of a setup beats recovering none —
/// and nothing is deleted until the new vault is written and readable.
pub fn collect(dir: &Path) -> super::vaultfile::Contents {
    let connections: Vec<crate::db::types::ConnectionConfig> =
        std::fs::read_to_string(dir.join("connections.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();

    let folders: serde_json::Value = std::fs::read_to_string(dir.join("folders.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(serde_json::Value::Null);

    let old = dir.join("secrets.enc");
    let secrets: std::collections::BTreeMap<String, String> = if is_v1(&old) {
        read_all(&old).into_iter().collect()
    } else {
        Default::default()
    };

    if !connections.is_empty() || !secrets.is_empty() {
        log::info!(
            "secretstore: folding {} connection(s) and {} secret(s) from the previous layout \
             into the vault",
            connections.len(),
            secrets.len()
        );
    }

    super::vaultfile::Contents { connections, folders, secrets }
}

/// Move the old files aside once the vault holds their contents.
///
/// Renamed rather than deleted: if anything about the upgrade is wrong, the
/// original setup is still sitting there.
pub fn retire(dir: &Path) {
    for name in ["connections.json", "folders.json", "secrets.enc", "secrets-config.json"] {
        let from = dir.join(name);
        if from.exists() {
            let to = dir.join(format!("{name}.pre-vault.bak"));
            if let Err(e) = std::fs::rename(&from, &to) {
                log::warn!("secretstore: could not set {name} aside: {e}");
            }
        }
    }
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use crate::db::types::{ConnectionConfig, Engine};

    #[test]
    fn an_older_installation_is_gathered_whole() {
        let d = std::env::temp_dir().join(format!("txui-collect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();

        let c = ConnectionConfig::new(Engine::Mysql, "old-prod");
        std::fs::write(d.join("connections.json"),
                       serde_json::to_string(&vec![c.clone()]).unwrap()).unwrap();
        std::fs::write(d.join("folders.json"),
                       r##"{"prod":{"color":"#e05555"}}"##).unwrap();

        let got = collect(&d);
        assert_eq!(got.connections.len(), 1);
        assert_eq!(got.connections[0].name, "old-prod");
        assert_eq!(got.folders["prod"]["color"], "#e05555");

        // Retiring keeps the originals rather than deleting them.
        retire(&d);
        assert!(!d.join("connections.json").exists());
        assert!(d.join("connections.json.pre-vault.bak").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_fresh_install_gathers_nothing_and_does_not_fail() {
        let d = std::env::temp_dir().join(format!("txui-collect-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let got = collect(&d);
        assert!(got.connections.is_empty());
        assert!(got.secrets.is_empty());
        assert!(got.folders.is_null());
        retire(&d);  // nothing to move; must not panic
        let _ = std::fs::remove_dir_all(&d);
    }
}
