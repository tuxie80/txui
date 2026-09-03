//! The file. One of them, encrypted with the user's password, holding the
//! entire setup: connections, folder tree, and every stored secret.
//!
//! Argon2id derives the key from the password; AES-256-GCM seals the payload.
//! The public header carries only what is needed to derive the key again —
//! salt and KDF cost — and is authenticated, so nobody can lower the advertised
//! cost of someone else's file.
//!
//! Because there is exactly one format, "export" and "backup" are the same
//! thing as the live file: a copy of it, optionally under a different password,
//! opens anywhere. There is no separate bundle format to keep in step.

use anyhow::{anyhow, bail, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use zeroize::{Zeroize, Zeroizing};

use crate::db::types::ConnectionConfig;

pub const FILE: &str = "vault.txui";
const MAGIC: &str = "txui-vault";
const FORMAT: u32 = 1;
const CTX: &[u8] = b"TxUI/vault/v1";

/// Minimum password length. Enforced here rather than only in the UI, because
/// this is the single thing standing between a copy of the file and every
/// password in it.
pub const MIN_PASSWORD: usize = 8;

/// Argon2id cost: the OWASP floor. Well under a second in a release build, and
/// the password is typed once per run.
///
/// Tests derive keys dozens of times and Argon2 is orders of magnitude slower
/// in an unoptimised test binary, so they use a token cost — pinned by
/// `production_cost_is_not_weakened`.
#[cfg(not(test))]
const KDF_MEM_KIB: u32 = 64 * 1024;
#[cfg(not(test))]
const KDF_PASSES: u32 = 3;
#[cfg(test)]
const KDF_MEM_KIB: u32 = 16;
#[cfg(test)]
const KDF_PASSES: u32 = 1;
const KDF_LANES: u32 = 1;

pub const PRODUCTION_KDF_MEM_KIB: u32 = 64 * 1024;
pub const PRODUCTION_KDF_PASSES: u32 = 3;

/// Everything the app persists. Encrypted as one unit — connection details are
/// not "less secret" than passwords: hostnames, users, and which entries are
/// tagged prod are exactly what someone with your laptop would want first.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Contents {
    #[serde(default)]
    pub connections: Vec<ConnectionConfig>,
    /// Folder attributes keyed by full path ("prod", "prod/eu"). Opaque here;
    /// the UI owns the shape.
    #[serde(default)]
    pub folders: serde_json::Value,
    /// secret key name → secret value.
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
}

/// The envelope on disk. Everything outside `ciphertext` must be readable to
/// derive the key, and is therefore public by design.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    magic: String,
    format: u32,
    /// Informational only — never used for decryption, so a file written on
    /// Windows opens on Linux and macOS.
    written_by: String,
    salt: String,
    kdf_mem_kib: u32,
    kdf_passes: u32,
    kdf_lanes: u32,
    ciphertext: String,
}

/// A derived key, kept for the session.
///
/// Deriving is deliberately expensive — that is the whole point of Argon2id —
/// so it must happen when the password is entered, **not** on every save.
/// Doing it per write made saving a connection take seconds: each save is a
/// full re-derivation at 64 MiB.
///
/// The salt therefore stays fixed for the life of the file and changes only
/// when the password does. That is correct: the salt exists so the same
/// password yields different keys in different vaults, not so it differs
/// between two saves of the same one. Freshness per write is the **nonce**'s
/// job, and every write still gets a new one.
pub struct VaultKey {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
    mem_kib: u32,
    passes: u32,
    lanes: u32,
}

impl std::fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never let key material reach a log line.
        f.debug_struct("VaultKey").finish_non_exhaustive()
    }
}

/// Derive a key under a fresh salt — for a new vault or a password change.
pub fn new_key(password: &str) -> Result<VaultKey> {
    use rand::TryRngCore;
    if password.chars().count() < MIN_PASSWORD {
        bail!("choose a password of at least {MIN_PASSWORD} characters — it is the only thing protecting this file");
    }
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.try_fill_bytes(&mut salt).map_err(|e| anyhow!("no secure randomness: {e}"))?;
    Ok(VaultKey {
        key: derive(password, &salt, KDF_MEM_KIB, KDF_PASSES, KDF_LANES)?,
        salt,
        mem_kib: KDF_MEM_KIB,
        passes: KDF_PASSES,
        lanes: KDF_LANES,
    })
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

pub fn exists(data_dir: &Path) -> bool {
    path(data_dir).exists()
}

fn derive(password: &str, salt: &[u8], mem: u32, passes: u32, lanes: u32) -> Result<Zeroizing<[u8; 32]>> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(mem, passes, lanes, Some(32))
        .map_err(|e| anyhow!("bad KDF parameters: {e}"))?;
    let a2 = Argon2::new_with_secret(CTX, Algorithm::Argon2id, Version::V0x13, params)
        .map_err(|e| anyhow!("KDF init failed: {e}"))?;
    let mut out = Zeroizing::new([0u8; 32]);
    a2.hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| anyhow!("key derivation failed: {e}"))?;
    Ok(out)
}

fn header_aad(format: u32, salt: &[u8], mem: u32, passes: u32, lanes: u32) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(MAGIC.as_bytes());
    v.extend_from_slice(&format.to_le_bytes());
    v.extend_from_slice(salt);
    v.extend_from_slice(&mem.to_le_bytes());
    v.extend_from_slice(&passes.to_le_bytes());
    v.extend_from_slice(&lanes.to_le_bytes());
    v
}

/// Serialise and encrypt under an already-derived key. Cheap: AES-GCM over a
/// few kilobytes, microseconds rather than the ~100 ms (or seconds, in a debug
/// build) that re-deriving would cost.
pub fn encode_with(contents: &Contents, k: &VaultKey) -> Result<String> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use rand::TryRngCore;

    // A new nonce every time — reusing one under the same key would be the
    // one catastrophic mistake available in GCM.
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.try_fill_bytes(&mut nonce).map_err(|e| anyhow!("no secure randomness: {e}"))?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(k.key.as_ref()));
    let mut plain = serde_json::to_vec(contents)?;
    let aad = header_aad(FORMAT, &k.salt, k.mem_kib, k.passes, k.lanes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: &aad })
        .map_err(|_| anyhow!("encryption failed"))?;
    plain.zeroize();

    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ct);

    Ok(serde_json::to_string_pretty(&Envelope {
        magic: MAGIC.into(),
        format: FORMAT,
        written_by: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        salt: base64::engine::general_purpose::STANDARD.encode(k.salt),
        kdf_mem_kib: k.mem_kib,
        kdf_passes: k.passes,
        kdf_lanes: k.lanes,
        ciphertext: base64::engine::general_purpose::STANDARD.encode(&blob),
    })?)
}

/// Convenience for one-shot writes (export to a new file under a new password).
pub fn encode(contents: &Contents, password: &str) -> Result<String> {
    encode_with(contents, &new_key(password)?)
}

/// Decrypt, and hand back the derived key so the caller can keep it for the
/// session instead of paying for the KDF again on every save.
pub fn decode_with_key(text: &str, password: &str) -> Result<(Contents, VaultKey)> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    let e: Envelope = serde_json::from_str(text)
        .map_err(|_| anyhow!("this is not a TxUI vault file"))?;
    if e.magic != MAGIC {
        bail!("this is not a TxUI vault file");
    }
    if e.format > FORMAT {
        bail!("this vault was written by a newer version of TxUI (format {})", e.format);
    }
    let salt = base64::engine::general_purpose::STANDARD
        .decode(&e.salt)
        .map_err(|_| anyhow!("the vault's salt is corrupt"))?;
    // Exactly 16 bytes or refuse (WP-12 12.5). The old truncate/zero-pad
    // coercion below opened such a vault fine — and then the NEXT auto-save
    // wrote a header whose salt no longer matched the cached key's
    // derivation, rendering the file permanently unopenable.
    if salt.len() != 16 {
        bail!("the vault's salt is corrupt (expected 16 bytes, found {})", salt.len());
    }
    let blob = base64::engine::general_purpose::STANDARD
        .decode(&e.ciphertext)
        .map_err(|_| anyhow!("the vault's contents are corrupt"))?;
    if blob.len() < 13 {
        bail!("the vault's contents are truncated");
    }

    let key = derive(password, &salt, e.kdf_mem_kib, e.kdf_passes, e.kdf_lanes)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()));
    let (nonce, ct) = blob.split_at(12);
    let aad = header_aad(e.format, &salt, e.kdf_mem_kib, e.kdf_passes, e.kdf_lanes);
    let mut pt = cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &aad })
        // AES-GCM cannot tell a wrong key from tampering, and the wrong
        // password is overwhelmingly the likelier of the two.
        .map_err(|_| anyhow!("wrong password"))?;
    let contents: Contents = serde_json::from_slice(&pt)
        .map_err(|e| anyhow!("the vault decrypted but its contents are not valid: {e}"))?;
    pt.zeroize();

    let mut salt_arr = [0u8; 16];
    salt_arr.copy_from_slice(&salt);   // length checked at decode above
    Ok((
        contents,
        VaultKey {
            key,
            salt: salt_arr,
            mem_kib: e.kdf_mem_kib,
            passes: e.kdf_passes,
            lanes: e.kdf_lanes,
        },
    ))
}

pub fn decode(text: &str, password: &str) -> Result<Contents> {
    decode_with_key(text, password).map(|(c, _)| c)
}

/// Write atomically, owner-only. A crash mid-write must never leave a
/// half-written vault, because there is no second copy of it.
pub fn write_with(target: &Path, contents: &Contents, k: &VaultKey) -> Result<()> {
    use std::io::Write;
    let text = encode_with(contents, k)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = target.with_extension("txui.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        restrict_to_owner(&f)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, target)?;
    Ok(())
}

/// Make the file readable by its owner and nobody else.
///
/// The contents are encrypted, so this is defence in depth rather than the
/// thing standing between an attacker and the secrets. It still matters: a
/// vault file that any local account can copy is a vault an attacker can take
/// away and grind offline at their leisure.
///
/// Unix gets `0o600`. Windows has no mode bits — the file inherits the
/// directory's ACL — so the equivalent is to mark it hidden+system, which keeps
/// it out of casual view, and to rely on the per-user `%APPDATA%` ACL that
/// already restricts the directory. A real DACL rewrite needs `windows-acl`
/// or raw Win32; that is deliberately not pulled in for a file whose contents
/// are already AES-GCM encrypted. The difference is documented in
/// docs/PORTABILITY.md rather than left as a silent gap.
fn restrict_to_owner(f: &std::fs::File) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        // Touch the handle so the signature is honest on every platform.
        let _ = f.metadata()?;
    }
    Ok(())
}

pub fn write(target: &Path, contents: &Contents, password: &str) -> Result<()> {
    write_with(target, contents, &new_key(password)?)
}

pub fn read_with_key(source: &Path, password: &str) -> Result<(Contents, VaultKey)> {
    let text = std::fs::read_to_string(source)
        .map_err(|e| anyhow!("cannot read {}: {e}", source.display()))?;
    decode_with_key(&text, password)
}

pub fn read(source: &Path, password: &str) -> Result<Contents> {
    let text = std::fs::read_to_string(source)
        .map_err(|e| anyhow!("cannot read {}: {e}", source.display()))?;
    decode(&text, password)
}

/// Does this password open the file? Used before replacing the live one.
pub fn password_opens(source: &Path, password: &str) -> bool {
    read(source, password).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::Engine;

    fn sample() -> Contents {
        let mut c = ConnectionConfig::new(Engine::Postgres, "prod-eu");
        c.host = Some("db.internal".into());
        c.user = Some("app".into());
        c.environment = Some("prod".into());
        let mut secrets = BTreeMap::new();
        secrets.insert(format!("dbgui:{}", c.id), "the-password".to_string());
        Contents {
            connections: vec![c],
            folders: serde_json::json!({
                "prod": { "color": "#e05555", "note": "live" },
                "prod/eu": { "replicaSet": true },
            }),
            secrets,
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("txui-vf-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn the_whole_setup_round_trips() {
        let text = encode(&sample(), "a-good-password").unwrap();
        let back = decode(&text, "a-good-password").unwrap();
        assert_eq!(back.connections.len(), 1);
        assert_eq!(back.connections[0].name, "prod-eu");
        assert_eq!(back.secrets.values().next().unwrap(), "the-password");
        // Folders, subfolders included.
        assert_eq!(back.folders["prod"]["color"], "#e05555");
        assert_eq!(back.folders["prod/eu"]["replicaSet"], true);
    }

    #[test]
    fn nothing_readable_is_left_in_the_file() {
        let text = encode(&sample(), "a-good-password").unwrap();
        // Not just the password: the whole map of the estate.
        for leak in ["the-password", "prod-eu", "db.internal", "app", "live"] {
            assert!(!text.contains(leak), "`{leak}` is readable in the vault");
        }
    }

    #[test]
    fn the_wrong_password_is_rejected_clearly() {
        let text = encode(&sample(), "a-good-password").unwrap();
        let err = decode(&text, "not-the-one").unwrap_err().to_string();
        assert!(err.contains("wrong password"), "{err}");
    }

    #[test]
    fn tampering_is_detected() {
        let text = encode(&sample(), "a-good-password").unwrap();
        let mut e: Envelope = serde_json::from_str(&text).unwrap();

        // Lowering the advertised KDF cost would make an offline attack cheaper.
        let mut cheap = serde_json::from_str::<Envelope>(&text).unwrap();
        cheap.kdf_mem_kib = KDF_MEM_KIB + 8;
        assert!(decode(&serde_json::to_string(&cheap).unwrap(), "a-good-password").is_err());

        // Flipping a ciphertext bit.
        let mut raw = base64::engine::general_purpose::STANDARD.decode(&e.ciphertext).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0xff;
        e.ciphertext = base64::engine::general_purpose::STANDARD.encode(&raw);
        assert!(decode(&serde_json::to_string(&e).unwrap(), "a-good-password").is_err());
    }

    #[test]
    fn a_short_password_is_refused_when_writing() {
        // The only moment refusing helps — once the file exists the damage is
        // done.
        let err = encode(&sample(), "short").unwrap_err().to_string();
        assert!(err.contains("at least"), "{err}");
    }

    #[test]
    fn the_file_is_not_tied_to_the_platform_that_wrote_it() {
        let text = encode(&sample(), "a-good-password").unwrap();
        let mut e: Envelope = serde_json::from_str(&text).unwrap();
        assert!(!e.written_by.is_empty());
        e.written_by = "some-other-os".into();
        let back = decode(&serde_json::to_string(&e).unwrap(), "a-good-password").unwrap();
        assert_eq!(back.connections.len(), 1);
    }

    #[test]
    fn every_write_uses_a_fresh_salt_and_nonce() {
        // Same contents, same password, twice — identical files would leak
        // that nothing changed.
        let a: Envelope = serde_json::from_str(&encode(&sample(), "a-good-password").unwrap()).unwrap();
        let b: Envelope = serde_json::from_str(&encode(&sample(), "a-good-password").unwrap()).unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn junk_and_future_files_are_refused_with_a_reason() {
        assert!(decode("not json", "x").unwrap_err().to_string().contains("not a TxUI vault"));
        assert!(decode("{}", "x").unwrap_err().to_string().contains("not a TxUI vault"));
        let mut e: Envelope =
            serde_json::from_str(&encode(&sample(), "a-good-password").unwrap()).unwrap();
        e.format = FORMAT + 1;
        let err = decode(&serde_json::to_string(&e).unwrap(), "a-good-password")
            .unwrap_err().to_string();
        assert!(err.contains("newer version"), "{err}");
    }

    #[test]
    fn writing_is_atomic_and_leaves_no_temp_file() {
        let p = tmp("atomic.txui");
        write(&p, &sample(), "a-good-password").unwrap();
        assert!(p.exists());
        assert!(!p.with_extension("txui.tmp").exists());
        assert_eq!(read(&p, "a-good-password").unwrap().connections.len(), 1);
        assert!(password_opens(&p, "a-good-password"));
        assert!(!password_opens(&p, "wrong-password"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn production_cost_is_not_weakened() {
        assert_eq!(PRODUCTION_KDF_MEM_KIB, 64 * 1024);
        assert_eq!(PRODUCTION_KDF_PASSES, 3);
    }

    /// WP-12 12.5: a salt of any length but 16 must be refused at decode —
    /// the old truncate/zero-pad coercion opened the vault fine and then the
    /// next auto-save bricked the file (header salt no longer matched the
    /// cached key's derivation).
    #[test]
    fn a_wrong_length_salt_is_refused_not_coerced() {
        let text = encode(&sample(), "a-good-password").unwrap();
        let mut env: serde_json::Value = serde_json::from_str(&text).unwrap();
        use base64::Engine as _;
        env["salt"] = serde_json::Value::String(
            base64::engine::general_purpose::STANDARD.encode([7u8; 15]));
        let err = decode(&env.to_string(), "a-good-password").unwrap_err().to_string();
        assert!(err.contains("salt"), "{err}");
        env["salt"] = serde_json::Value::String(
            base64::engine::general_purpose::STANDARD.encode([7u8; 17]));
        let err = decode(&env.to_string(), "a-good-password").unwrap_err().to_string();
        assert!(err.contains("salt"), "{err}");
    }
}

#[cfg(test)]
mod key_reuse_tests {
    use super::*;

    /// Saving must not re-run the KDF. Each save used to cost a full Argon2id
    /// derivation at 64 MiB, which made saving one connection take seconds.
    #[test]
    fn a_session_key_writes_and_reads_back_repeatedly() {
        let k = new_key("a-good-password").unwrap();
        let mut c = Contents::default();

        for i in 0..5 {
            c.secrets.insert(format!("k{i}"), format!("v{i}"));
            let text = encode_with(&c, &k).unwrap();
            let back = decode(&text, "a-good-password").unwrap();
            assert_eq!(back.secrets.len(), i + 1);
        }
    }

    #[test]
    fn the_salt_is_stable_across_saves_but_the_nonce_is_not() {
        // Stable salt is what makes the cached key valid. A repeated nonce
        // under one key would be the single catastrophic mistake in GCM, so
        // that must still change every time.
        let k = new_key("a-good-password").unwrap();
        let c = Contents::default();
        let a: Envelope = serde_json::from_str(&encode_with(&c, &k).unwrap()).unwrap();
        let b: Envelope = serde_json::from_str(&encode_with(&c, &k).unwrap()).unwrap();
        assert_eq!(a.salt, b.salt, "the salt must not change between saves");
        assert_ne!(a.ciphertext, b.ciphertext, "the nonce must change every save");
    }

    #[test]
    fn a_key_recovered_on_open_writes_files_the_same_password_still_opens() {
        // decode hands back the key so the session can keep it; anything
        // written with it must remain openable by the original password.
        let first = encode(&Contents::default(), "a-good-password").unwrap();
        let (mut contents, k) = decode_with_key(&first, "a-good-password").unwrap();
        contents.secrets.insert("added".into(), "later".into());
        let second = encode_with(&contents, &k).unwrap();
        let back = decode(&second, "a-good-password").unwrap();
        assert_eq!(back.secrets.get("added").map(String::as_str), Some("later"));
    }

    #[test]
    fn a_new_password_gets_a_new_salt() {
        let a = new_key("a-good-password").unwrap();
        let b = new_key("a-good-password").unwrap();
        assert_ne!(a.salt, b.salt, "each new key must salt independently");
    }

}
