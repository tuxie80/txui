//! Two storage modes, one façade. See `docs/SECRETS.md`.
//!
//! **Plain** is the default: `connections.json` and `folders.json` as readable
//! JSON, `secrets.json` machine-obfuscated (`plain.rs`). No password, no
//! prompt — the app opens straight into its connections, the way most database
//! clients behave. It stops a casual look at the file or a synced backup; it is
//! not protection against someone who can run this code on this machine, and
//! the Security panel says so rather than letting the user assume otherwise.
//!
//! **Safe Vault** is opt-in (Settings → Security): one encrypted `vault.txui`
//! holding everything — connections, the folder tree, and every stored password
//! — under a master password entered once per run. The connection list is
//! encrypted with the same key as the passwords, because a map of hostnames,
//! ports, users and prod tags is the reconnaissance step for anyone holding the
//! disk, and it was the part nobody encrypted because "it isn't secrets".
//!
//! `create` moves plain → vault (and deletes the plain files, so no plaintext
//! copy lingers); `disable` moves vault → plain, and requires the password —
//! a deliberate downgrade must not be possible by deleting a file the caller
//! cannot read. `VaultState` names the three positions: `Plain`, `Locked`,
//! `Unlocked`.
//!
//! What the vault protects: the file is useless without the password. Copied to
//! a USB stick, swept into a cloud-sync folder, restored from a backup, read off
//! a decommissioned disk — none of that reveals anything.
//!
//! What neither mode does: malware running as you, while the app is open, can
//! read what the app can read. `lock()` puts the vault back out of reach without
//! quitting.

pub mod legacy;
pub mod plain;
pub mod vaultfile;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::types::ConnectionConfig;
use vaultfile::Contents;

/// The open vault for this process. In memory only — a password that survived
/// a restart would not be a password.
static OPEN: Mutex<Option<Open>> = Mutex::new(None);

struct Open {
    dir: PathBuf,
    /// Derived once, when the password was entered. Saving must not pay for
    /// Argon2id again — that is what made saving a connection take seconds.
    ///
    /// Deliberately NO `password` field (WP-12 12.1): the plaintext used to
    /// be retained for the whole session (never zeroized) only so
    /// change_password could `==`-compare it — a non-constant-time compare of
    /// a secret. Verification now re-reads the vault file with the offered
    /// password (AEAD tag check — constant-time by construction), so the
    /// plaintext is simply never kept.
    key: vaultfile::VaultKey,
    contents: Contents,
}

/// Serialises tests that touch the process-global open state.
#[cfg(test)]
pub(crate) static TEST_SERIAL: Mutex<()> = Mutex::new(());
#[cfg(test)]
pub(crate) fn test_serial() -> std::sync::MutexGuard<'static, ()> {
    TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn open_guard() -> Option<std::sync::MutexGuard<'static, Option<Open>>> {
    OPEN.lock().ok()
}

// ── State the UI asks about ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultState {
    /// No encrypted vault — the default. Connections/secrets live in the plain
    /// backend and the app opens with no password prompt.
    Plain,
    /// An encrypted vault exists and is waiting for its password.
    Locked,
    /// The vault is open for this run.
    Unlocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: VaultState,
    pub path: String,
    pub connections: usize,
    pub secrets: usize,
    /// How many connections an upgrade carried in, when there was one.
    pub carried_in: Option<usize>,
}

pub fn status(dir: &Path) -> Status {
    let g = open_guard();
    let open = g.as_ref().and_then(|g| g.as_ref()).filter(|o| o.dir == dir);
    let state = match (&open, vaultfile::exists(dir)) {
        (Some(_), _) => VaultState::Unlocked,
        (None, true) => VaultState::Locked,
        (None, false) => VaultState::Plain,
    };
    // Counts: from the open vault when unlocked, otherwise from the plain files
    // (0 in Locked, since we can't read an encrypted vault without the password).
    let (connections, secrets) = match state {
        VaultState::Unlocked => open
            .map(|o| (o.contents.connections.len(), o.contents.secrets.len()))
            .unwrap_or((0, 0)),
        VaultState::Plain => (plain::read_connections(dir).len(), plain::read_secrets(dir).len()),
        VaultState::Locked => (0, 0),
    };
    Status {
        state,
        path: vaultfile::path(dir).display().to_string(),
        connections,
        secrets,
        carried_in: None,
    }
}

pub fn is_unlocked(dir: &Path) -> bool {
    open_guard()
        .and_then(|g| g.as_ref().map(|o| o.dir == dir))
        .unwrap_or(false)
}

// ── Opening and closing ──────────────────────────────────────────────────────

/// Create the vault for the first time, folding in anything an earlier version
/// left behind. Returns how many connections were carried in.
pub fn create(dir: &Path, password: &str) -> Result<usize> {
    if vaultfile::exists(dir) {
        bail!("a vault already exists at {}", vaultfile::path(dir).display());
    }
    // Fold in whatever this profile already had. The live plain-mode files are
    // the primary source now; `legacy::collect` still covers the very old
    // pre-plain layouts (secrets.enc etc.) for someone upgrading across them.
    let contents = {
        let p = plain::read_contents(dir);
        if p.connections.is_empty() && p.secrets.is_empty() {
            legacy::collect(dir)
        } else {
            p
        }
    };
    let carried = contents.connections.len();
    let key = vaultfile::new_key(password)?;
    vaultfile::write_with(&vaultfile::path(dir), &contents, &key)?;
    let mut g = OPEN.lock().map_err(|_| anyhow!("vault state is poisoned"))?;
    *g = Some(Open { dir: dir.to_path_buf(), key, contents });
    // Only once the vault is written and readable: remove the plain-mode files
    // first (so no plaintext connections linger as a .bak), then retire any old
    // pre-plain layouts. The encrypted vault is now the single source.
    plain::remove_all(dir);
    legacy::retire(dir);
    Ok(carried)
}

/// Turn the vault OFF: verify the password, decrypt everything back to the
/// plain-mode files, then delete the vault. After this the app opens with no
/// prompt. Requires the correct password — this is a deliberate downgrade and
/// must not be possible by merely deleting a file the caller can't read.
pub fn disable(dir: &Path, password: &str) -> Result<()> {
    if !vaultfile::exists(dir) {
        // Already plain — nothing to do.
        return Ok(());
    }
    // Read (and verify the password) straight from the file rather than trusting
    // whatever might be unlocked in memory.
    let contents = vaultfile::read(&vaultfile::path(dir), password)?;
    plain::write_contents(dir, &contents)?;
    // Only remove the encrypted file once the plain files are written.
    std::fs::remove_file(vaultfile::path(dir))
        .map_err(|e| anyhow!("wrote plain files but could not remove the vault: {e}"))?;
    lock();
    Ok(())
}

pub fn unlock(dir: &Path, password: &str) -> Result<()> {
    // The one place the KDF runs in normal use.
    let (contents, key) = vaultfile::read_with_key(&vaultfile::path(dir), password)?;
    let mut g = OPEN.lock().map_err(|_| anyhow!("vault state is poisoned"))?;
    *g = Some(Open { dir: dir.to_path_buf(), key, contents });
    Ok(())
}

pub fn lock() {
    if let Ok(mut g) = OPEN.lock() {
        *g = None;
    }
}

pub fn change_password(dir: &Path, current: &str, next: &str) -> Result<()> {
    // Verify `current` against the FILE — re-derive its key and let the AEAD
    // tag decide. Costs one KDF run (fine for an explicit password change),
    // is constant-time by construction, and is what lets the plaintext
    // password not be retained in memory at all.
    if vaultfile::read(&vaultfile::path(dir), current).is_err() {
        bail!("wrong password");
    }
    let mut g = OPEN.lock().map_err(|_| anyhow!("vault state is poisoned"))?;
    let o = g.as_mut().filter(|o| o.dir == dir).ok_or_else(|| anyhow!("the vault is locked"))?;
    // A new password means a new salt, so this is the other place the KDF
    // runs. Write under the new key before adopting it: if the write fails,
    // the file still opens with the old password.
    let key = vaultfile::new_key(next)?;
    vaultfile::write_with(&vaultfile::path(dir), &o.contents, &key)?;
    o.key = key;
    Ok(())
}

// ── Auto-save ────────────────────────────────────────────────────────────────

/// Mutate the open vault and save. There is no "save" action in the UI because
/// there is nothing to remember to press.
fn with_open<T>(dir: &Path, f: impl FnOnce(&mut Contents) -> T) -> std::io::Result<T> {
    let mut g = OPEN.lock().map_err(|_| std::io::Error::other("vault state is poisoned"))?;
    let o = g
        .as_mut()
        .filter(|o| o.dir == dir)
        .ok_or_else(|| std::io::Error::other("the vault is locked"))?;
    let out = f(&mut o.contents);
    // Cheap: AES-GCM over a few kilobytes with the key already in hand.
    vaultfile::write_with(&vaultfile::path(&o.dir), &o.contents, &o.key)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(out)
}

fn read_open<T>(dir: &Path, f: impl FnOnce(&Contents) -> T) -> Option<T> {
    let g = open_guard()?;
    let o = g.as_ref().filter(|o| o.dir == dir)?;
    Some(f(&o.contents))
}

// ── Secrets: the API every caller already used ───────────────────────────────

pub fn get(dir: &Path, key: &str) -> Option<String> {
    if vaultfile::exists(dir) {
        read_open(dir, |c| c.secrets.get(key).cloned())?
    } else {
        plain::get_secret(dir, key)
    }
}

pub fn set(dir: &Path, key: &str, secret: &str) -> std::io::Result<()> {
    if vaultfile::exists(dir) {
        with_open(dir, |c| {
            c.secrets.insert(key.to_string(), secret.to_string());
        })
    } else {
        plain::set_secret(dir, key, secret)
    }
}

pub fn delete(dir: &Path, key: &str) {
    if vaultfile::exists(dir) {
        let _ = with_open(dir, |c| {
            c.secrets.remove(key);
        });
    } else {
        plain::delete_secret(dir, key);
    }
}

// ── Connections and folders ──────────────────────────────────────────────────

pub fn connections(dir: &Path) -> Result<std::collections::HashMap<Uuid, ConnectionConfig>> {
    if vaultfile::exists(dir) {
        read_open(dir, |c| c.connections.iter().map(|x| (x.id, x.clone())).collect())
            .ok_or_else(|| anyhow!("the vault is locked"))
    } else {
        Ok(plain::read_connections(dir).into_iter().map(|x| (x.id, x)).collect())
    }
}

pub fn save_connections(
    dir: &Path,
    configs: &std::collections::HashMap<Uuid, ConnectionConfig>,
) -> Result<()> {
    if vaultfile::exists(dir) {
        with_open(dir, |c| {
            let mut list: Vec<ConnectionConfig> = configs.values().cloned().collect();
            list.sort_by(|a, b| a.name.cmp(&b.name));
            c.connections = list;
        })
        .map_err(|e| anyhow!("{e}"))
    } else {
        let list: Vec<ConnectionConfig> = configs.values().cloned().collect();
        plain::write_connections(dir, &list).map_err(|e| anyhow!("{e}"))
    }
}

pub fn folders(dir: &Path) -> serde_json::Value {
    if vaultfile::exists(dir) {
        read_open(dir, |c| c.folders.clone()).unwrap_or(serde_json::Value::Null)
    } else {
        plain::read_folders(dir)
    }
}

pub fn save_folders(dir: &Path, folders: &serde_json::Value) -> Result<()> {
    if vaultfile::exists(dir) {
        with_open(dir, |c| c.folders = folders.clone()).map_err(|e| anyhow!("{e}"))
    } else {
        plain::write_folders(dir, folders).map_err(|e| anyhow!("{e}"))
    }
}

// ── Moving between machines ──────────────────────────────────────────────────

/// Write a copy of the vault, optionally under a different password.
///
/// Same format as the live file, so a copy IS the backup and IS the export —
/// there is no second format to keep in step.
pub fn export_copy(dir: &Path, target: &Path, password: Option<&str>) -> Result<usize> {
    let g = open_guard().ok_or_else(|| anyhow!("vault state is poisoned"))?;
    let o = g.as_ref().filter(|o| o.dir == dir).ok_or_else(|| anyhow!("the vault is locked"))?;
    match password {
        // A different password for a file that will travel: new salt, new key.
        Some(pw) => vaultfile::write(target, &o.contents, pw)?,
        // Same password — reuse the session key rather than re-deriving.
        None => vaultfile::write_with(target, &o.contents, &o.key)?,
    }
    Ok(o.contents.connections.len())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub connections: usize,
    pub secrets: usize,
    pub folders: usize,
}

/// Merge another vault file into this one.
///
/// Connections are re-identified, so importing onto a machine that already has
/// connections adds to them rather than replacing them, and an entry can never
/// collide with — or steal the stored password of — one already here.
pub fn import_file(dir: &Path, source: &Path, password: &str) -> Result<ImportSummary> {
    let incoming = vaultfile::read(source, password)?;
    let mut summary = ImportSummary { connections: 0, secrets: 0, folders: 0 };

    with_open(dir, |c| {
        for mut conn in incoming.connections {
            let old = conn.id;
            conn.id = Uuid::new_v4();
            for (from, to) in [
                (format!("dbgui:{old}"), format!("dbgui:{}", conn.id)),
                (format!("dbgui-ssh:{old}"), format!("dbgui-ssh:{}", conn.id)),
            ] {
                if let Some(v) = incoming.secrets.get(&from) {
                    c.secrets.insert(to, v.clone());
                    summary.secrets += 1;
                }
            }
            c.connections.push(conn);
            summary.connections += 1;
        }
        // Folder attributes merge by path; the incoming file wins a clash,
        // because importing is the deliberate act.
        if let Some(incoming_folders) = incoming.folders.as_object() {
            summary.folders = incoming_folders.len();
            if !c.folders.is_object() {
                c.folders = serde_json::Value::Object(Default::default());
            }
            if let Some(m) = c.folders.as_object_mut() {
                for (k, v) in incoming_folders {
                    m.insert(k.clone(), v.clone());
                }
            }
        }
        c.connections.sort_by(|a, b| a.name.cmp(&b.name));
    })
    .map_err(|e| anyhow!("{e}"))?;

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::Engine;

    const PW: &str = "a-good-password";

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("txui-store-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn conn(name: &str) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Postgres, name);
        c.host = Some("db.internal".into());
        c
    }

    #[test]
    fn plain_mode_round_trips_through_enable_and_disable() {
        let _s = test_serial();
        let d = dir("roundtrip");
        lock(); // start clean

        // Plain mode (no vault): store a connection + its secret, no password.
        assert_eq!(status(&d).state, VaultState::Plain);
        let c = conn("prod-db");
        save_connections(&d, &[(c.id, c.clone())].into_iter().collect()).unwrap();
        set(&d, &format!("dbgui:{}", c.id), "hunter2").unwrap();
        assert!(!vaultfile::exists(&d));
        assert_eq!(get(&d, &format!("dbgui:{}", c.id)).as_deref(), Some("hunter2"));
        // Secret is obfuscated on disk, not clear text.
        let raw = std::fs::read_to_string(plain::secrets_path(&d)).unwrap();
        assert!(!raw.contains("hunter2"));

        // Enable the vault — the plain data is folded in, plain files removed.
        let carried = create(&d, PW).unwrap();
        assert_eq!(carried, 1);
        assert_eq!(status(&d).state, VaultState::Unlocked);
        assert!(vaultfile::exists(&d));
        assert!(!plain::connections_path(&d).exists());
        assert!(!plain::secrets_path(&d).exists());
        assert_eq!(get(&d, &format!("dbgui:{}", c.id)).as_deref(), Some("hunter2"));
        assert_eq!(connections(&d).unwrap().len(), 1);

        // Disable — everything decrypts back to the plain files, vault removed.
        disable(&d, PW).unwrap();
        assert_eq!(status(&d).state, VaultState::Plain);
        assert!(!vaultfile::exists(&d));
        assert!(plain::connections_path(&d).exists());
        assert_eq!(get(&d, &format!("dbgui:{}", c.id)).as_deref(), Some("hunter2"));
        assert_eq!(connections(&d).unwrap().len(), 1);

        // Wrong password cannot disable a vault.
        create(&d, PW).unwrap();
        assert!(disable(&d, "wrong-password").is_err());
        assert!(vaultfile::exists(&d));
        lock();
    }

    #[test]
    fn a_fresh_install_is_plain_then_opens_when_enabled() {
        let _s = test_serial();
        let d = dir("fresh");
        // No vault by default now — plain mode, no prompt.
        assert_eq!(status(&d).state, VaultState::Plain);

        create(&d, PW).unwrap();
        assert_eq!(status(&d).state, VaultState::Unlocked);
        assert!(vaultfile::exists(&d));

        lock();
        assert_eq!(status(&d).state, VaultState::Locked);
        assert!(unlock(&d, "wrong-password").is_err());
        assert_eq!(status(&d).state, VaultState::Locked);
        unlock(&d, PW).unwrap();
        assert_eq!(status(&d).state, VaultState::Unlocked);
        lock();
    }

    #[test]
    fn everything_is_saved_without_being_asked_to() {
        let _s = test_serial();
        let d = dir("autosave");
        create(&d, PW).unwrap();

        let c = conn("prod");
        let configs = [(c.id, c.clone())].into_iter().collect();
        save_connections(&d, &configs).unwrap();
        set(&d, &format!("dbgui:{}", c.id), "hunter2").unwrap();
        save_folders(&d, &serde_json::json!({ "prod": { "color": "#e05555" } })).unwrap();

        // No save step anywhere: closing and reopening finds it all.
        lock();
        unlock(&d, PW).unwrap();
        assert_eq!(connections(&d).unwrap().len(), 1);
        assert_eq!(get(&d, &format!("dbgui:{}", c.id)).as_deref(), Some("hunter2"));
        assert_eq!(folders(&d)["prod"]["color"], "#e05555");
        lock();
    }

    #[test]
    fn a_locked_vault_reveals_nothing_and_accepts_nothing() {
        let _s = test_serial();
        let d = dir("locked");
        create(&d, PW).unwrap();
        set(&d, "dbgui:k", "v").unwrap();
        lock();

        assert_eq!(get(&d, "dbgui:k"), None);
        assert!(set(&d, "dbgui:k", "x").is_err());
        assert!(connections(&d).is_err());
        assert!(folders(&d).is_null());
        // …and the refused write did not corrupt anything.
        unlock(&d, PW).unwrap();
        assert_eq!(get(&d, "dbgui:k").as_deref(), Some("v"));
        lock();
    }

    #[test]
    fn nothing_is_readable_on_disk() {
        let _s = test_serial();
        let d = dir("ondisk");
        create(&d, PW).unwrap();
        let c = conn("prod-eu-warehouse");
        save_connections(&d, &[(c.id, c.clone())].into_iter().collect()).unwrap();
        set(&d, &format!("dbgui:{}", c.id), "the-password").unwrap();

        let raw = std::fs::read_to_string(vaultfile::path(&d)).unwrap();
        // The password, and the map of the estate along with it.
        for leak in ["the-password", "prod-eu-warehouse", "db.internal"] {
            assert!(!raw.contains(leak), "`{leak}` is readable on disk");
        }
        lock();
    }

    #[test]
    fn changing_the_password_keeps_everything() {
        let _s = test_serial();
        let d = dir("changepw");
        create(&d, PW).unwrap();
        set(&d, "dbgui:k", "v").unwrap();

        assert!(change_password(&d, "not-the-current-one", "another-password").is_err());
        change_password(&d, PW, "another-password").unwrap();

        lock();
        assert!(unlock(&d, PW).is_err());
        unlock(&d, "another-password").unwrap();
        assert_eq!(get(&d, "dbgui:k").as_deref(), Some("v"));
        lock();
    }

    #[test]
    fn a_copy_is_the_backup_and_the_export() {
        let _s = test_serial();
        let d = dir("copy");
        create(&d, PW).unwrap();
        let c = conn("prod");
        save_connections(&d, &[(c.id, c.clone())].into_iter().collect()).unwrap();
        set(&d, &format!("dbgui:{}", c.id), "pw").unwrap();

        // Same password…
        let same = d.join("copy-same.txui");
        assert_eq!(export_copy(&d, &same, None).unwrap(), 1);
        assert_eq!(vaultfile::read(&same, PW).unwrap().connections.len(), 1);

        // …or a different one, for a file that is going to travel.
        let other = d.join("copy-other.txui");
        export_copy(&d, &other, Some("a-travelling-password")).unwrap();
        assert!(vaultfile::read(&other, PW).is_err());
        assert_eq!(vaultfile::read(&other, "a-travelling-password").unwrap().secrets.len(), 1);
        lock();
    }

    #[test]
    fn importing_merges_rather_than_replaces() {
        let _s = test_serial();
        // A vault to import FROM.
        let src_dir = dir("import-src");
        create(&src_dir, PW).unwrap();
        let a = conn("from-laptop");
        save_connections(&src_dir, &[(a.id, a.clone())].into_iter().collect()).unwrap();
        set(&src_dir, &format!("dbgui:{}", a.id), "laptop-pw").unwrap();
        save_folders(&src_dir, &serde_json::json!({ "laptop": { "note": "mine" } })).unwrap();
        let bundle = src_dir.join("out.txui");
        export_copy(&src_dir, &bundle, Some("travelling-password")).unwrap();
        lock();

        // …into one that already has something.
        let d = dir("import-dst");
        create(&d, PW).unwrap();
        let b = conn("already-here");
        save_connections(&d, &[(b.id, b.clone())].into_iter().collect()).unwrap();
        set(&d, &format!("dbgui:{}", b.id), "existing-pw").unwrap();

        assert!(import_file(&d, &bundle, "wrong-password").is_err());
        let s = import_file(&d, &bundle, "travelling-password").unwrap();
        assert_eq!(s.connections, 1);
        assert_eq!(s.secrets, 1);
        assert_eq!(s.folders, 1);

        let all = connections(&d).unwrap();
        assert_eq!(all.len(), 2, "the existing connection must survive");
        assert!(all.values().any(|c| c.name == "already-here"));
        assert!(all.values().any(|c| c.name == "from-laptop"));

        // Re-identified, so the imported entry carries its own password rather
        // than pointing at the existing one's.
        let imported = all.values().find(|c| c.name == "from-laptop").unwrap();
        assert_ne!(imported.id, a.id);
        assert_eq!(get(&d, &format!("dbgui:{}", imported.id)).as_deref(), Some("laptop-pw"));
        assert_eq!(get(&d, &format!("dbgui:{}", b.id)).as_deref(), Some("existing-pw"));
        assert_eq!(folders(&d)["laptop"]["note"], "mine");
        lock();
    }

    #[test]
    fn creating_the_vault_makes_an_upgraded_setup_immediately_readable() {
        let _s = test_serial();
        // The bug this pins: `create` wrote the carried-in connections to the
        // file and returned a count, but the app read an empty list — the
        // sidebar said "No connections yet" about a vault holding eleven.
        // Whatever create() reports must be readable through the same call the
        // app uses, without unlocking again.
        let d = dir("upgrade-visible");
        let old: Vec<ConnectionConfig> =
            (1..=3).map(|i| conn(&format!("old-{i}"))).collect();
        std::fs::write(d.join("connections.json"), serde_json::to_string(&old).unwrap()).unwrap();
        std::fs::write(d.join("folders.json"), r##"{"prod":{"color":"#e05555"}}"##).unwrap();

        let carried = create(&d, PW).unwrap();
        assert_eq!(carried, 3, "create must report what it folded in");
        // …and the same number must be visible right now, with no unlock step.
        assert_eq!(connections(&d).unwrap().len(), carried);
        assert_eq!(folders(&d)["prod"]["color"], "#e05555");

        // Still there after a restart.
        lock();
        unlock(&d, PW).unwrap();
        assert_eq!(connections(&d).unwrap().len(), 3);
        lock();
    }

    #[test]
    fn a_second_create_is_refused() {
        let _s = test_serial();
        let d = dir("recreate");
        create(&d, PW).unwrap();
        set(&d, "dbgui:k", "v").unwrap();
        // Overwriting an existing vault would destroy every password in it.
        assert!(create(&d, "another-password").is_err());
        assert_eq!(get(&d, "dbgui:k").as_deref(), Some("v"));
        lock();
    }
}
