//! Frontend access to a connection's own data directory.
//!
//! Thin by design: `crate::instancedata` owns the path rules and the atomic
//! write, and the frontend owns the shape of each JSON blob. These three
//! commands exist only to carry bytes across the boundary.

use tauri::State;
use uuid::Uuid;

use crate::apperror::AppError;
use crate::state::AppState;

/// Read one blob for a connection. `None` when it has never been written —
/// the normal case on first use, not an error.
#[tauri::command]
pub async fn instance_data_get(
    connection_id: Uuid,
    key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, AppError> {
    crate::instancedata::read(&state.data_dir, &connection_id, &key)
        .map_err(|e| AppError::bad_request(e.to_string()))
}

#[tauri::command]
pub async fn instance_data_set(
    connection_id: Uuid,
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    crate::instancedata::write(&state.data_dir, &connection_id, &key, &value)
        .map_err(|e| AppError::bad_request(e.to_string()))
}

#[tauri::command]
pub async fn instance_data_remove(
    connection_id: Uuid,
    key: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    crate::instancedata::remove(&state.data_dir, &connection_id, &key)
        .map_err(|e| AppError::bad_request(e.to_string()))
}
