//! Tauri commands for the Dolphie **Replay** feature — opening a `daemon.db`
//! recording as a time-scrubbed observability dashboard.
//!
//! All commands are **path-based and read-only**: they do not go through the
//! normal connection/session machinery (a recording is a file, not a server).
//! The ingested columnar cache lives in `AppState.replay_cache`, keyed by a
//! path+size+mtime fingerprint, so re-opening the same file is instant and a
//! recording still being appended to by a live daemon is re-ingested when it
//! grows.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use tauri::{AppHandle, Emitter, State};

use crate::apperror::AppError;
use crate::db::replay::{self, ReplayCache, ReplayManifest, ReplayProbe, SeriesSlice};
use crate::state::AppState;

/// Fingerprint a `.db` path: is it a decodable Dolphie recording, and its
/// headline metadata + time range. Cheap — decodes no snapshot. This is what
/// the frontend calls on every SQLite file it opens to decide whether to offer
/// the Replay workspace.
#[tauri::command]
pub async fn replay_probe(path: String) -> Result<ReplayProbe, AppError> {
    Ok(replay::probe(&PathBuf::from(path)).await?)
}

/// Progress payload for the `replay-ingest-progress` event.
#[derive(Serialize, Clone)]
struct IngestProgress {
    path: String,
    done: usize,
    total: usize,
}

/// Fetch a cached recording, or **open it lightly** (metadata + timestamp axis
/// + a small sample — no full decode) and cache it. Cheap and fast: the heavy
///   columnar series are built later, lazily, by `replay_series`. The cache key
///   includes size+mtime, so a grown recording is transparently re-opened.
async fn get_or_open(path: &str, state: &AppState) -> Result<Arc<ReplayCache>, AppError> {
    let p = PathBuf::from(path);
    let key = replay::cache_key(&p)?;

    if let Some(hit) = state.replay_cache.read().await.get(&key).cloned() {
        return Ok(hit);
    }
    let cache = Arc::new(replay::open_light(&p).await?);
    state.replay_cache.write().await.insert(key, cache.clone());
    Ok(cache)
}

/// Open a recording and return its manifest: the full timestamp axis for the
/// scrubber, available metric names, and which panels were actually recorded.
/// FAST — decodes no snapshot beyond a small sample, so the UI appears at once.
#[tauri::command]
pub async fn replay_open(
    path: String,
    state: State<'_, AppState>,
) -> Result<ReplayManifest, AppError> {
    let cache = get_or_open(&path, &state).await?;
    Ok(cache.manifest())
}

/// A downsampled slice of metric series between two timestamps (as handed back
/// from the manifest). The first call builds the full columnar series in
/// parallel (emitting `replay-ingest-progress`); later calls are instant.
/// `max_points` caps the returned resolution.
#[tauri::command]
pub async fn replay_series(
    app: AppHandle,
    path: String,
    metrics: Vec<String>,
    from_ts: String,
    to_ts: String,
    max_points: usize,
    state: State<'_, AppState>,
) -> Result<SeriesSlice, AppError> {
    let cache = get_or_open(&path, &state).await?;

    // Whether THIS call triggers the one-time build — so we report its duration
    // (for the audit log) only once, not on every later slice.
    let already_built = cache.built.read().await.is_some();
    let path_owned = path.clone();
    let built = cache
        .ensure_series(|done, total| {
            let _ = app.emit(
                "replay-ingest-progress",
                IngestProgress { path: path_owned.clone(), done, total },
            );
        })
        .await?;

    let from = replay::epoch_of(&from_ts);
    let to = replay::epoch_of(&to_ts);
    let (lo, hi) = cache.epoch_bounds();
    // Clamp to the recording, and default to full range if the caller sent
    // an inverted or empty window.
    let (from, to) = if from <= to { (from.max(lo), to.min(hi)) } else { (lo, hi) };
    let mut slice = cache.slice(&built, from, to, &metrics, max_points);
    if !already_built {
        slice.build_secs = *cache.build_secs.lock().unwrap();
    }
    Ok(slice)
}

/// The full decoded snapshot at (or nearest at-or-before) a timestamp — the
/// detail panels (processlist, locks, replication, binlog, innodb, variables,
/// table/file I/O) read straight off this. One blob decoded on demand.
#[tauri::command]
pub async fn replay_snapshot(
    path: String,
    ts: String,
    state: State<'_, AppState>,
) -> Result<Value, AppError> {
    let cache = get_or_open(&path, &state).await?;
    Ok(replay::snapshot_at(&cache.pool, &cache.decoder, &ts).await?)
}

/// One `variable_changes` row.
#[derive(Serialize)]
pub struct VarChange {
    pub timestamp: String,
    pub variable_name: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
}

/// The MySQL variable change-log within a time window (may be empty — not every
/// recording captures changes).
#[tauri::command]
pub async fn replay_variable_changes(
    path: String,
    from_ts: String,
    to_ts: String,
    state: State<'_, AppState>,
) -> Result<Vec<VarChange>, AppError> {
    let cache = get_or_open(&path, &state).await?;
    let rows = sqlx::query(
        "SELECT timestamp, variable_name, old_value, new_value FROM variable_changes \
         WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp",
    )
    .bind(&from_ts)
    .bind(&to_ts)
    .fetch_all(&cache.pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| VarChange {
            timestamp: r.try_get("timestamp").unwrap_or_default(),
            variable_name: r.try_get("variable_name").unwrap_or_default(),
            old_value: r.try_get("old_value").ok(),
            new_value: r.try_get("new_value").ok(),
        })
        .collect())
}

/// Called when a Replay view unmounts. Intentionally a **no-op that keeps the
/// cache warm**: the whole point of the columnar cache is that re-opening the
/// same recording — toggling Replay↔Raw, switching tabs and back — is instant.
/// Dropping it here (as the view unmounts on every such toggle) is exactly the
/// bug that made re-opens take seconds again. The cache is keyed by
/// path+size+mtime and freed when the app exits (or explicitly evicted below).
#[tauri::command]
pub async fn replay_close(_path: String, _state: State<'_, AppState>) -> Result<(), AppError> {
    Ok(())
}

/// What `replay_evict` released — for the audit log.
#[derive(Serialize, Default)]
pub struct EvictInfo {
    pub freed: bool,
    pub snapshots: usize,
    pub metrics: usize,
    pub had_series: bool,
}

/// Explicitly evict a recording's cache (frees the columns + closes the pool).
/// Use when the underlying DB session is truly closed, not on view unmount.
/// Returns what was freed so the caller can record it in the audit log.
#[tauri::command]
pub async fn replay_evict(path: String, state: State<'_, AppState>) -> Result<EvictInfo, AppError> {
    let p = PathBuf::from(&path);
    let removed = {
        let mut map = state.replay_cache.write().await;
        match replay::cache_key(&p) {
            Ok(key) => map.remove(&key),
            Err(_) => {
                // File gone: sweep any entry whose key starts with the path.
                let prefix = format!("{}|", p.display());
                let ks: Vec<String> = map.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
                ks.into_iter().find_map(|k| map.remove(&k))
            }
        }
    };
    match removed {
        Some(cache) => {
            // Dropping this Arc (once the map's ref is gone and no command still
            // holds one) frees the columnar series and closes the SQLite pool.
            let had_series = cache.built.read().await.is_some();
            Ok(EvictInfo {
                freed: true,
                snapshots: cache.timestamps.len(),
                metrics: cache.metric_names.len(),
                had_series,
            })
        }
        None => Ok(EvictInfo::default()),
    }
}
