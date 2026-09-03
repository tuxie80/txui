use tauri::State;

use crate::history::{self, DeadlockEvent, DeadlockEventMeta, DigestDelta, DigestRowIn, DigestSnapshotMeta, DigestSnapshotStored, HistoryEntry};
use crate::state::AppState;

#[tauri::command]
pub async fn search_history(
    connection_id: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryEntry>, crate::apperror::AppError> {
    history::search(
        &state.history,
        connection_id.as_deref(),
        query.as_deref(),
        limit.unwrap_or(200),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_history_entry(id: i64, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    history::delete_entry(&state.history, id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn clear_connection_history(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    history::clear_connection(&state.history, &connection_id)
        .await
        .map_err(Into::into)
}

/// Digest stats for one statement shape — the gutter tooltip's "ran N× in
/// history · p95 …" line. The frontend fingerprints the statement it just ran
/// (utils/slowLogParse.fingerprint); the history rows are fingerprinted by the
/// Rust mirror (history::fingerprint_sql). No match → null, never an error:
/// a first-time statement is the common case.
#[tauri::command]
pub async fn history_digest_stats(
    connection_id: String,
    fingerprint: String,
    state: State<'_, AppState>,
) -> Result<Option<history::DigestStats>, crate::apperror::AppError> {
    history::digest_stats(&state.history, &connection_id, &fingerprint)
        .await
        .map_err(Into::into)
}

// ── Digest snapshots (QAN-style persistent store) ───────────────────────────
//
// The persistence half of the digest-history panels: the panel sends the
// capture it just took (cumulative counters), and stored snapshots can later
// be listed, fetched and diffed against each other across restarts.

#[tauri::command]
pub async fn save_digest_snapshot(
    connection_id: String,
    engine: String,
    label: String,
    rows: Vec<DigestRowIn>,
    state: State<'_, AppState>,
) -> Result<i64, crate::apperror::AppError> {
    history::save_digest_snapshot(&state.history, &connection_id, &engine, &label, &rows)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_digest_snapshots(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<DigestSnapshotMeta>, crate::apperror::AppError> {
    history::list_digest_snapshots(&state.history, &connection_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_digest_snapshot(
    id: i64,
    state: State<'_, AppState>,
) -> Result<DigestSnapshotStored, crate::apperror::AppError> {
    history::get_digest_snapshot(&state.history, id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn diff_digest_snapshots(
    before_id: i64,
    after_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<DigestDelta>, crate::apperror::AppError> {
    let before = history::get_digest_snapshot(&state.history, before_id).await?;
    let after = history::get_digest_snapshot(&state.history, after_id).await?;
    Ok(history::diff_digest_rows(&before.rows, &after.rows))
}

#[tauri::command]
pub async fn delete_digest_snapshot(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    history::delete_digest_snapshot(&state.history, id)
        .await
        .map_err(Into::into)
}

// ── Deadlock events (analyzer history) ───────────────────────────────────────
//
// The persistence half of the Deadlocks panel: it records a parsed deadlock
// (or a PG counter snapshot) on detection, and past events can be listed,
// re-viewed and deleted across restarts. Dedupe and retention live in
// history.rs.

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn record_deadlock_event(
    connection_id: String,
    engine: String,
    detected_at: String,
    victim: String,
    txn_count: i64,
    raw: String,
    parsed: String,
    state: State<'_, AppState>,
) -> Result<Option<i64>, crate::apperror::AppError> {
    history::record_deadlock_event(
        &state.history, &connection_id, &engine, &detected_at, &victim, txn_count, &raw, &parsed,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn list_deadlock_events(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<DeadlockEventMeta>, crate::apperror::AppError> {
    history::list_deadlock_events(&state.history, &connection_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_deadlock_event(
    id: i64,
    state: State<'_, AppState>,
) -> Result<DeadlockEvent, crate::apperror::AppError> {
    history::get_deadlock_event(&state.history, id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_deadlock_event(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    history::delete_deadlock_event(&state.history, id)
        .await
        .map_err(Into::into)
}
