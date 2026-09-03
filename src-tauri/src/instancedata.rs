//! Per-instance data: one directory per connection, holding everything that
//! belongs to that connection and nothing else.
//!
//! ```text
//! <data_dir>/instances/<connection-uuid>/
//!     diagrams.json
//!     …
//! ```
//!
//! Why a directory and not one file per concern at the top level: the things
//! that accumulate around a connection — saved ER diagrams today, whatever
//! comes next — are *its* data, and they should be findable, backup-able and
//! removable as a unit. Deleting a connection deletes its directory, so
//! nothing is left orphaned in a shared file that no longer has an owner.
//!
//! Deliberately **not** the encrypted vault. That file holds secrets and is
//! rewritten wholesale on every change; diagram layouts are neither secret nor
//! small, and putting them there would mean re-encrypting the vault every time
//! somebody drags a table.
//!
//! Everything here is plain UTF-8 JSON written by the frontend, which owns the
//! schema of each blob. This module only guarantees *where* it goes, that a
//! crash cannot leave a half-written file, and that a key from the frontend can
//! never escape the instance directory.

use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// The directory holding everything for one connection.
pub fn instance_dir(data_dir: &Path, id: &Uuid) -> PathBuf {
    // Hyphenated UUID, lowercase — a fixed shape, so no user-supplied text
    // reaches the path at this level.
    data_dir.join("instances").join(id.to_string())
}

/// Names Windows treats as devices rather than files. `CON.json` is still the
/// console — the extension does not save it — so these have to be excluded by
/// name even though every character in them is otherwise legal.
const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Validate a blob key.
///
/// The key arrives from the frontend and becomes a **file name**, so this is
/// the boundary that stops `../../../secrets.enc` from being a valid request.
/// Restricting to lowercase alphanumerics, `-` and `_` makes traversal,
/// absolute paths and NTFS alternate data streams unrepresentable rather than
/// individually defended against. Reserved device names survive that filter —
/// they are ordinary letters — so they are excluded separately.
///
/// The check runs on every platform, not just Windows: a key that works on one
/// developer's machine and fails on another's is worse than one that never
/// works anywhere.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && !RESERVED.contains(&key)
}

fn blob_path(data_dir: &Path, id: &Uuid, key: &str) -> Result<PathBuf> {
    if !valid_key(key) {
        bail!("invalid instance-data key `{key}` (expected [a-z0-9_-], 1-64 chars)");
    }
    Ok(instance_dir(data_dir, id).join(format!("{key}.json")))
}

/// Read a blob. A missing file is `Ok(None)`, not an error — every caller's
/// first read is of something that does not exist yet.
pub fn read(data_dir: &Path, id: &Uuid, key: &str) -> Result<Option<String>> {
    let path = blob_path(data_dir, id, key)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Write a blob atomically. Same reasoning as the vault: a crash mid-write
/// must not leave a truncated file, because the previous good version is the
/// only other copy of the user's work.
pub fn write(data_dir: &Path, id: &Uuid, key: &str, json: &str) -> Result<()> {
    use std::io::Write;
    let path = blob_path(data_dir, id, key)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("txui.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Remove one blob. Absent is success — the caller wanted it gone.
pub fn remove(data_dir: &Path, id: &Uuid, key: &str) -> Result<()> {
    let path = blob_path(data_dir, id, key)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Drop the whole directory when a connection is deleted, so its data does not
/// outlive it. Best-effort: a failure here must not stop the deletion the user
/// asked for, and is logged rather than surfaced.
pub fn remove_instance(data_dir: &Path, id: &Uuid) {
    let dir = instance_dir(data_dir, id);
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("could not remove instance data at {}: {e}", dir.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("txui-instdata-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn a_blob_round_trips() {
        let (d, id) = (tmp(), Uuid::new_v4());
        write(&d, &id, "diagrams", r#"{"v":1}"#).unwrap();
        assert_eq!(read(&d, &id, "diagrams").unwrap().as_deref(), Some(r#"{"v":1}"#));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The first read of anything is of a file that does not exist. That is
    /// the normal case, not a failure.
    #[test]
    fn a_missing_blob_reads_as_none() {
        let (d, id) = (tmp(), Uuid::new_v4());
        assert_eq!(read(&d, &id, "diagrams").unwrap(), None);
    }

    #[test]
    fn writing_twice_replaces_and_leaves_no_temp_file() {
        let (d, id) = (tmp(), Uuid::new_v4());
        write(&d, &id, "diagrams", "one").unwrap();
        write(&d, &id, "diagrams", "two").unwrap();
        assert_eq!(read(&d, &id, "diagrams").unwrap().as_deref(), Some("two"));
        let leftovers: Vec<_> = std::fs::read_dir(instance_dir(&d, &id)).unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The key becomes a file name, so this is the test that matters.
    #[test]
    fn a_key_cannot_escape_the_instance_directory() {
        let (d, id) = (tmp(), Uuid::new_v4());
        for bad in ["../secrets", "..", "a/b", "/etc/passwd", "a\\b", "x:stream", "", "A", "diagrams.json"] {
            assert!(write(&d, &id, bad, "{}").is_err(), "key `{bad}` was accepted");
            assert!(read(&d, &id, bad).is_err(), "key `{bad}` was accepted for read");
        }
    }

    /// `CON.json` is still the console device on Windows — the extension does
    /// not make it a file. Refused everywhere, so a key cannot work on macOS
    /// and then fail on a colleague's machine.
    #[test]
    fn windows_device_names_are_refused_on_every_platform() {
        let (d, id) = (tmp(), Uuid::new_v4());
        for bad in ["con", "prn", "aux", "nul", "com1", "lpt9"] {
            assert!(write(&d, &id, bad, "{}").is_err(), "reserved name `{bad}` was accepted");
        }
        // Only the exact names are reserved; these are ordinary keys.
        for ok in ["console", "com10", "connections", "nullable"] {
            assert!(write(&d, &id, ok, "{}").is_ok(), "`{ok}` should be a legal key");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_over_long_key_is_refused() {
        let (d, id) = (tmp(), Uuid::new_v4());
        assert!(write(&d, &id, &"a".repeat(65), "{}").is_err());
        assert!(write(&d, &id, &"a".repeat(64), "{}").is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Two connections must not see each other's data even for the same key.
    #[test]
    fn instances_are_isolated_from_each_other() {
        let d = tmp();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        write(&d, &a, "diagrams", "mine").unwrap();
        write(&d, &b, "diagrams", "theirs").unwrap();
        assert_eq!(read(&d, &a, "diagrams").unwrap().as_deref(), Some("mine"));
        assert_eq!(read(&d, &b, "diagrams").unwrap().as_deref(), Some("theirs"));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Deleting a connection must not leave its diagrams behind for the next
    /// connection that happens to be given the same id.
    #[test]
    fn removing_an_instance_takes_its_whole_directory() {
        let d = tmp();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        write(&d, &a, "diagrams", "mine").unwrap();
        write(&d, &b, "diagrams", "theirs").unwrap();
        remove_instance(&d, &a);
        assert_eq!(read(&d, &a, "diagrams").unwrap(), None);
        assert_eq!(read(&d, &b, "diagrams").unwrap().as_deref(), Some("theirs"),
                   "removing one instance took another's data");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn removing_an_absent_instance_is_not_an_error() {
        remove_instance(&tmp(), &Uuid::new_v4()); // must not panic or log-fail
    }
}
