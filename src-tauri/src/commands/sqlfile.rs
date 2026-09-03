//! File-level commands for the SQL editor: open with an encoding, save back to
//! the same path, notice a change on disk, and search a folder of scripts.
//!
//! The logic is in `crate::sqlfile`; these carry it across the IPC boundary.

use serde::Serialize;
use std::path::PathBuf;

use crate::apperror::AppError;
use crate::sqlfile::{self, Eol};

fn bad(e: anyhow::Error) -> AppError {
    AppError::bad_request(format!("{e:#}"))
}

/// Open a file, decoding with `encoding` when given and detecting otherwise.
#[tauri::command]
pub async fn sqlfile_open(
    path: PathBuf,
    encoding: Option<String>,
) -> Result<sqlfile::OpenedFile, AppError> {
    sqlfile::open(&path, encoding.as_deref()).await.map_err(bad)
}

/// `expected_mtime_ms` is the mtime the frontend loaded/last saved the file
/// at — a newer on-disk mtime refuses (external edit) so the UI can prompt.
/// Omit (or 0) to force.
#[tauri::command]
pub async fn sqlfile_save(
    path: PathBuf,
    text: String,
    encoding: String,
    eol: Eol,
    expected_mtime_ms: Option<i64>,
) -> Result<sqlfile::FileStat, AppError> {
    sqlfile::save(&path, &text, &encoding, eol, expected_mtime_ms).await.map_err(bad)
}

/// Size and mtime, or `None` when the file is gone. Used to spot an edit made
/// outside the app before a save overwrites it.
#[tauri::command]
pub async fn sqlfile_stat(path: PathBuf) -> Result<Option<sqlfile::FileStat>, AppError> {
    sqlfile::stat(&path).await.map_err(bad)
}

/// The encodings the UI offers.
#[tauri::command]
pub fn sqlfile_encodings() -> Vec<String> {
    sqlfile::ENCODINGS.iter().map(|s| s.to_string()).collect()
}

#[derive(Debug, Serialize)]
pub struct FileMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct FindResult {
    pub matches: Vec<FileMatch>,
    pub files_searched: usize,
    /// True when the cap was reached, so the UI can say the list is partial
    /// rather than presenting it as everything.
    pub truncated: bool,
}

/// Search a folder of scripts.
///
/// Bounded on purpose, in three ways: a file-count ceiling, a match ceiling and
/// a per-file size limit. A search rooted at a home directory would otherwise
/// walk a machine, and the honest failure is "here are the first 500, there
/// were more" rather than a spinner that never ends.
#[tauri::command]
pub async fn find_in_files(
    dir: PathBuf,
    query: String,
    extensions: Vec<String>,
    case_sensitive: bool,
    max_matches: Option<usize>,
) -> Result<FindResult, AppError> {
    if query.is_empty() {
        return Err(AppError::bad_request("nothing to search for"));
    }
    let cap = max_matches.unwrap_or(500).clamp(1, 5000);
    const MAX_FILES: usize = 20_000;
    const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

    tokio::task::spawn_blocking(move || {
        let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };
        let exts: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();
        let mut matches = Vec::new();
        let mut files_searched = 0usize;
        let mut truncated = false;

        for entry in walkdir::WalkDir::new(&dir).follow_links(false).into_iter().filter_map(Result::ok) {
            if files_searched >= MAX_FILES || matches.len() >= cap { truncated = true; break; }
            if !entry.file_type().is_file() { continue; }
            let path = entry.path();
            if !exts.is_empty() {
                let ok = path.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| exts.iter().any(|w| w == &e.to_lowercase()))
                    .unwrap_or(false);
                if !ok { continue; }
            }
            if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) { continue; }
            // Same decoding path the editor uses, so a CP1250 dump is
            // searchable rather than skipped as invalid UTF-8.
            let Ok(bytes) = std::fs::read(path) else { continue };
            let Ok((text, _, _, _)) = sqlfile::decode(&bytes, None) else { continue };
            files_searched += 1;
            for (i, line) in text.lines().enumerate() {
                let hay = if case_sensitive { line.to_string() } else { line.to_lowercase() };
                if hay.contains(&needle) {
                    matches.push(FileMatch {
                        path: path.display().to_string(),
                        line: i + 1,
                        // A minified dump can be one enormous line; the result
                        // list is a preview, not the file.
                        text: line.chars().take(300).collect(),
                    });
                    if matches.len() >= cap { truncated = true; break; }
                }
            }
        }
        Ok(FindResult { matches, files_searched, truncated })
    })
    .await
    .map_err(|e| AppError::bad_request(format!("search failed: {e}")))?
}
