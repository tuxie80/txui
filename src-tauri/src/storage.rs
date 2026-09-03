//! Connection-config persistence.
//!
//! One seam over two storage modes (see `secretstore`): plain files by default,
//! or the opt-in encrypted vault. This module stays as the seam every caller
//! already used, so nothing else has to know which mode is active — or, in
//! vault mode, that connections, folders and passwords share one file.
use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::db::types::ConnectionConfig;

/// Where the app keeps its data, resolved the same way on every platform.
///
/// The running app gets this from Tauri (`app_data_dir()`), but the CLI and the
/// live tests have no `AppHandle` and used to hardcode
/// `~/Library/Application Support/com.dbgui.app` — which quietly made every
/// `--ignored` live test macOS-only, so a Linux or Windows developer could not
/// run them at all.
///
/// Matches Tauri's own resolution: `~/Library/Application Support/<id>` on
/// macOS, `%APPDATA%\<id>` on Windows, `$XDG_DATA_HOME/<id>` (or
/// `~/.local/share/<id>`) elsewhere.
pub fn default_data_dir() -> PathBuf {
    const APP_ID: &str = "com.dbgui.app";
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join("Library/Application Support").join(APP_ID)
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        PathBuf::from(base).join(APP_ID)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(&home).join(".local/share"));
        base.join(APP_ID)
    }
}

/// Kept so the upgrade path and any diagnostics can still name the old file.
pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("connections.json")
}

pub fn load(data_dir: &Path) -> Result<HashMap<Uuid, ConnectionConfig>> {
    let mut configs = crate::secretstore::connections(data_dir)?;
    for c in configs.values_mut() {
        migrate_tags_to_labels(c);
    }
    Ok(configs)
}

/// Old free-form `tags` become visible labels.
///
/// Runs on every load rather than once: a connection can arrive from an import
/// file written by an older build at any time, long after an in-place migration
/// would have finished. Idempotent, and it never touches a connection that
/// already has labels — re-deriving them would undo a hidden flag the user set.
pub fn migrate_tags_to_labels(c: &mut ConnectionConfig) {
    if !c.labels.is_empty() || c.tags.is_empty() {
        return;
    }
    let mut seen: Vec<String> = Vec::new();
    for t in &c.tags {
        let name = t.trim();
        if name.is_empty() {
            continue;
        }
        let key = name.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        // Tags were only ever displayed, so nothing was meant to be hidden.
        c.labels.push(crate::db::types::Label { name: name.to_string(), hidden: false });
    }
}

/// Saves are immediate and atomic — the vault rewrites itself on every change,
/// so there is no separate "save" for anyone to forget.
pub async fn save(data_dir: &Path, configs: &HashMap<Uuid, ConnectionConfig>) -> Result<()> {
    crate::secretstore::save_connections(data_dir, configs)
}

pub fn load_folders(data_dir: &Path) -> serde_json::Value {
    crate::secretstore::folders(data_dir)
}

pub async fn save_folders(data_dir: &Path, folders: &serde_json::Value) -> Result<()> {
    crate::secretstore::save_folders(data_dir, folders)
}

#[cfg(test)]
mod label_migration_tests {
    use super::*;
    use crate::db::types::{Engine, Label};

    fn cfg(tags: &[&str]) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Mysql, "x");
        c.tags = tags.iter().map(|s| s.to_string()).collect();
        c
    }

    #[test]
    fn tags_become_visible_labels() {
        let mut c = cfg(&["cz-test", "prod-eu"]);
        migrate_tags_to_labels(&mut c);
        assert_eq!(c.labels, vec![
            Label { name: "cz-test".into(), hidden: false },
            Label { name: "prod-eu".into(), hidden: false },
        ]);
    }

    #[test]
    fn an_existing_label_set_is_never_rederived() {
        // Re-deriving would undo a hidden flag the user deliberately set.
        let mut c = cfg(&["old-tag"]);
        c.labels = vec![Label { name: "billing".into(), hidden: true }];
        migrate_tags_to_labels(&mut c);
        assert_eq!(c.labels.len(), 1);
        assert_eq!(c.labels[0].name, "billing");
        assert!(c.labels[0].hidden);
    }

    #[test]
    fn migration_is_idempotent() {
        // It runs on every load, so a second pass must change nothing.
        let mut c = cfg(&["a"]);
        migrate_tags_to_labels(&mut c);
        let once = c.labels.clone();
        migrate_tags_to_labels(&mut c);
        assert_eq!(c.labels, once);
    }

    #[test]
    fn blanks_and_case_duplicates_collapse() {
        let mut c = cfg(&["  a  ", "", "A", "b"]);
        migrate_tags_to_labels(&mut c);
        assert_eq!(c.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }

    #[test]
    fn a_connection_with_no_tags_gets_no_labels() {
        let mut c = cfg(&[]);
        migrate_tags_to_labels(&mut c);
        assert!(c.labels.is_empty());
    }
}
