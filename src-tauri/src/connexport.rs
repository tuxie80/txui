//! W5.2 — passphrase-encrypted connection export.
//!
//! The plain export (`export_connections`) carries configs and no secrets —
//! imported connections need their passwords re-entered. This is the opt-in
//! TablePlus/Compass-style variant: the same configs PLUS their stored
//! secrets (database and SSH passwords), sealed under a passphrase the user
//! types at export and again at import.
//!
//! The crypto is deliberately the vault's (secretstore/vaultfile.rs):
//! Argon2id at the same OWASP-floor cost derives a key from the passphrase,
//! AES-256-GCM seals the payload, and the header (version + KDF parameters +
//! salt) is authenticated as AAD so nobody can lower the advertised cost of
//! someone else's file. A separate context string (`CTX`) keeps a key derived
//! for an export from ever being interchangeable with a vault key.
//!
//! The envelope is JSON text with base64 fields, portable across platforms:
//! `{ "v": 1, "kdf": { …argon2id params + salt… }, "nonce": …, "ct": … }`.
//! A wrong passphrase and a tampered byte are the same clean error —
//! AES-GCM cannot tell them apart, and the wrong passphrase is overwhelmingly
//! the likelier of the two.

use anyhow::{anyhow, bail, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zeroize::{Zeroize, Zeroizing};

use crate::db::types::ConnectionConfig;

const FORMAT: u32 = 1;
/// Domain separation from the vault's key derivation.
const CTX: &[u8] = b"TxUI/conn-export/v1";
/// Marker inside the PLAINTEXT payload, so a successful decrypt of something
/// that is not an export is rejected with a real message instead of a serde
/// error.
const PAYLOAD_FORMAT: &str = "txui-connections-encrypted";

/// The vault's Argon2id cost (64 MiB / 3 passes / 1 lane) — reused verbatim,
/// per the wave contract. Tests use the same token cost as the vault's tests
/// (`production_cost_matches_the_vault` pins the production values).
#[cfg(not(test))]
const KDF_MEM_KIB: u32 = crate::secretstore::vaultfile::PRODUCTION_KDF_MEM_KIB;
#[cfg(not(test))]
const KDF_PASSES: u32 = crate::secretstore::vaultfile::PRODUCTION_KDF_PASSES;
#[cfg(test)]
const KDF_MEM_KIB: u32 = 16;
#[cfg(test)]
const KDF_PASSES: u32 = 1;
const KDF_LANES: u32 = 1;

/// Decode-time caps on the KDF cost read from an envelope — the header is
/// attacker-controlled until the AEAD tag is checked (after derivation), so
/// an uncapped cost would let a tampered file force a multi-GiB allocation.
/// Same reasoning and values as the vault.
const MAX_DECODE_KDF_MEM_KIB: u32 = 1024 * 1024;
const MAX_DECODE_KDF_PASSES: u32 = 10;

/// Minimum passphrase length, as the vault's: the passphrase is the single
/// thing standing between a copy of the export and every password in it.
pub const MIN_PASSPHRASE: usize = crate::secretstore::vaultfile::MIN_PASSWORD;

/// What gets sealed: the selected connections plus the secrets they own,
/// keyed by the EXPORT-time secret keys (`dbgui:<old id>` / `dbgui-ssh:<old
/// id>`). Import mints fresh connection ids and re-keys the secrets to them.
#[derive(Debug, Serialize, Deserialize)]
pub struct Payload {
    pub format: String,
    pub version: u32,
    pub connections: Vec<ConnectionConfig>,
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
}

impl Payload {
    pub fn new(connections: Vec<ConnectionConfig>, secrets: BTreeMap<String, String>) -> Self {
        Payload {
            format: PAYLOAD_FORMAT.into(),
            version: FORMAT,
            connections,
            secrets,
        }
    }
}

/// The portable envelope. Everything but `ct` is public by design — it is
/// what decryption needs to derive the key — and authenticated via the AAD.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    v: u32,
    kdf: KdfSection,
    /// 12-byte AES-GCM nonce, base64. Fresh on every export.
    nonce: String,
    /// Sealed payload, base64.
    ct: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct KdfSection {
    algo: String,
    mem_kib: u32,
    passes: u32,
    lanes: u32,
    /// 16-byte salt, base64. Fresh on every export.
    salt: String,
}

fn derive(passphrase: &str, salt: &[u8], mem: u32, passes: u32, lanes: u32) -> Result<Zeroizing<[u8; 32]>> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(mem, passes, lanes, Some(32))
        .map_err(|e| anyhow!("bad KDF parameters: {e}"))?;
    let a2 = Argon2::new_with_secret(CTX, Algorithm::Argon2id, Version::V0x13, params)
        .map_err(|e| anyhow!("KDF init failed: {e}"))?;
    let mut out = Zeroizing::new([0u8; 32]);
    a2.hash_password_into(passphrase.as_bytes(), salt, out.as_mut())
        .map_err(|e| anyhow!("key derivation failed: {e}"))?;
    Ok(out)
}

/// The header bytes the AEAD tag authenticates — every field an attacker
/// would want to weaken (cost) or swap (salt) is covered.
fn header_aad(v: u32, kdf: &KdfSection, salt: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&v.to_le_bytes());
    out.extend_from_slice(kdf.algo.as_bytes());
    out.extend_from_slice(&kdf.mem_kib.to_le_bytes());
    out.extend_from_slice(&kdf.passes.to_le_bytes());
    out.extend_from_slice(&kdf.lanes.to_le_bytes());
    out.extend_from_slice(salt);
    out
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Seal a payload under a passphrase → portable JSON text.
pub fn seal(payload: &Payload, passphrase: &str) -> Result<String> {
    use aes_gcm::aead::{Aead, KeyInit, Payload as AeadPayload};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use rand::TryRngCore;

    if passphrase.chars().count() < MIN_PASSPHRASE {
        bail!("choose a passphrase of at least {MIN_PASSPHRASE} characters — it is the only thing protecting the passwords in this export");
    }
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.try_fill_bytes(&mut salt).map_err(|e| anyhow!("no secure randomness: {e}"))?;
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.try_fill_bytes(&mut nonce).map_err(|e| anyhow!("no secure randomness: {e}"))?;

    let kdf = KdfSection {
        algo: "argon2id".into(),
        mem_kib: KDF_MEM_KIB,
        passes: KDF_PASSES,
        lanes: KDF_LANES,
        salt: b64().encode(salt),
    };
    let key = derive(passphrase, &salt, KDF_MEM_KIB, KDF_PASSES, KDF_LANES)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()));
    let mut plain = serde_json::to_vec(payload)?;
    let aad = header_aad(FORMAT, &kdf, &salt);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), AeadPayload { msg: &plain, aad: &aad })
        .map_err(|_| anyhow!("encryption failed"))?;
    plain.zeroize();

    Ok(serde_json::to_string_pretty(&Envelope {
        v: FORMAT,
        kdf,
        nonce: b64().encode(nonce),
        ct: b64().encode(ct),
    })?)
}

/// Open a sealed export. A wrong passphrase, a tampered byte and a weakened
/// header are the same clean error — see the module docs.
pub fn open(text: &str, passphrase: &str) -> Result<Payload> {
    use aes_gcm::aead::{Aead, KeyInit, Payload as AeadPayload};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    let e: Envelope = serde_json::from_str(text)
        .map_err(|_| anyhow!("this is not an encrypted TxUI connection export"))?;
    if e.v > FORMAT {
        bail!("this export was written by a newer version of TxUI (format {})", e.v);
    }
    if e.kdf.algo != "argon2id" {
        bail!("unsupported KDF {:?} (expected argon2id)", e.kdf.algo);
    }
    let salt = b64().decode(&e.kdf.salt)
        .map_err(|_| anyhow!("the export's salt is corrupt"))?;
    if salt.len() != 16 {
        bail!("the export's salt is corrupt (expected 16 bytes, found {})", salt.len());
    }
    let nonce = b64().decode(&e.nonce)
        .map_err(|_| anyhow!("the export's nonce is corrupt"))?;
    if nonce.len() != 12 {
        bail!("the export's nonce is corrupt (expected 12 bytes, found {})", nonce.len());
    }
    let ct = b64().decode(&e.ct)
        .map_err(|_| anyhow!("the export's contents are corrupt"))?;

    // Clamp BEFORE deriving: the header is not authenticated until the AEAD
    // check below, so at this point its KDF cost is attacker-controlled.
    let mem = e.kdf.mem_kib.min(MAX_DECODE_KDF_MEM_KIB);
    let passes = e.kdf.passes.min(MAX_DECODE_KDF_PASSES);
    let lanes = e.kdf.lanes.min(KDF_LANES);
    let key = derive(passphrase, &salt, mem, passes, lanes)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()));
    let aad = header_aad(e.v, &e.kdf, &salt);
    let mut pt = cipher
        .decrypt(Nonce::from_slice(&nonce), AeadPayload { msg: &ct, aad: &aad })
        .map_err(|_| anyhow!("wrong passphrase"))?;
    let payload: Payload = serde_json::from_slice(&pt)
        .map_err(|e| anyhow!("the export decrypted but its contents are not valid: {e}"))?;
    pt.zeroize();
    if payload.format != PAYLOAD_FORMAT {
        bail!("the export decrypted but is not a {PAYLOAD_FORMAT} payload");
    }
    if payload.version > FORMAT {
        bail!("this export was written by a newer version of TxUI (format {})", payload.version);
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::Engine;

    fn sample() -> Payload {
        let c = ConnectionConfig::new(Engine::Mysql, "prod-eu");
        let mut secrets = BTreeMap::new();
        secrets.insert(format!("dbgui:{}", c.id), "the-password".to_string());
        secrets.insert(format!("dbgui-ssh:{}", c.id), "the-ssh-password".to_string());
        Payload::new(vec![c], secrets)
    }

    #[test]
    fn round_trip() {
        let text = seal(&sample(), "a-good-passphrase").unwrap();
        let back = open(&text, "a-good-passphrase").unwrap();
        assert_eq!(back.connections.len(), 1);
        assert_eq!(back.connections[0].name, "prod-eu");
        assert_eq!(back.secrets.len(), 2);
        assert!(back.secrets.values().any(|v| v == "the-password"));
        assert!(back.secrets.values().any(|v| v == "the-ssh-password"));
    }

    #[test]
    fn nothing_readable_is_left_in_the_envelope() {
        let text = seal(&sample(), "a-good-passphrase").unwrap();
        for leak in ["the-password", "the-ssh-password", "prod-eu"] {
            assert!(!text.contains(leak), "`{leak}` is readable in the export");
        }
    }

    #[test]
    fn wrong_passphrase_is_a_clean_error() {
        let text = seal(&sample(), "a-good-passphrase").unwrap();
        let err = open(&text, "not-the-passphrase").unwrap_err().to_string();
        assert!(err.contains("wrong passphrase"), "{err}");
    }

    #[test]
    fn tampering_is_detected() {
        let text = seal(&sample(), "a-good-passphrase").unwrap();
        let mut e: Envelope = serde_json::from_str(&text).unwrap();

        // Flipping a ciphertext bit.
        let mut raw = b64().decode(&e.ct).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0xff;
        e.ct = b64().encode(&raw);
        let err = open(&serde_json::to_string(&e).unwrap(), "a-good-passphrase")
            .unwrap_err().to_string();
        assert!(err.contains("wrong passphrase"), "{err}");

        // Lowering the advertised KDF cost would make an offline attack
        // cheaper; the AAD carries the original values, so it is rejected.
        let mut cheap: Envelope = serde_json::from_str(&text).unwrap();
        cheap.kdf.mem_kib += 8;
        assert!(open(&serde_json::to_string(&cheap).unwrap(), "a-good-passphrase").is_err());
    }

    /// A tampered header must not get to pick the KDF cost: the caps bound
    /// the derivation, and the AEAD tag (over the ORIGINAL header) rejects.
    #[test]
    fn a_tampered_kdf_cost_is_clamped_then_rejected() {
        let text = seal(&sample(), "a-good-passphrase").unwrap();
        let mut e: Envelope = serde_json::from_str(&text).unwrap();
        e.kdf.passes = u32::MAX;
        let err = open(&serde_json::to_string(&e).unwrap(), "a-good-passphrase")
            .unwrap_err().to_string();
        assert!(err.contains("wrong passphrase"), "{err}");
    }

    #[test]
    fn a_short_passphrase_is_refused_when_sealing() {
        let err = seal(&sample(), "short").unwrap_err().to_string();
        assert!(err.contains("at least"), "{err}");
    }

    #[test]
    fn junk_and_future_envelopes_are_refused_with_a_reason() {
        assert!(open("not json", "x").unwrap_err().to_string().contains("not an encrypted"));
        let mut e: Envelope = serde_json::from_str(&seal(&sample(), "a-good-passphrase").unwrap()).unwrap();
        e.v = FORMAT + 1;
        let err = open(&serde_json::to_string(&e).unwrap(), "a-good-passphrase")
            .unwrap_err().to_string();
        assert!(err.contains("newer version"), "{err}");
    }

    #[test]
    fn every_seal_uses_a_fresh_salt_and_nonce() {
        let a: Envelope = serde_json::from_str(&seal(&sample(), "a-good-passphrase").unwrap()).unwrap();
        let b: Envelope = serde_json::from_str(&seal(&sample(), "a-good-passphrase").unwrap()).unwrap();
        assert_ne!(a.kdf.salt, b.kdf.salt);
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ct, b.ct);
    }

    /// The whole point of reusing the vault's parameters: a test or a
    /// refactor must not quietly weaken (or fork) the production KDF cost.
    #[test]
    fn production_cost_matches_the_vault() {
        assert_eq!(crate::secretstore::vaultfile::PRODUCTION_KDF_MEM_KIB, 64 * 1024);
        assert_eq!(crate::secretstore::vaultfile::PRODUCTION_KDF_PASSES, 3);
    }
}
