//! Commands behind the vault: unlock, change password, move it elsewhere.
//!
//! One file, one password. Everything here is explicit — nothing about the
//! vault happens implicitly, and none of it can run while it is locked.

use tauri::State;

use crate::secretstore::{self, ImportSummary, Status};
use crate::state::AppState;

/// Load what the vault holds into the running app.
///
/// Every path that opens the vault must do this — the sidebar reads the
/// in-memory map, not the file, so a vault that opened without this shows
/// "No connections yet" while holding every one of them. Shared by `create`
/// and `unlock` precisely so the two cannot drift apart again.
async fn adopt_into_state(state: &AppState) -> Result<usize, crate::apperror::AppError> {
    let configs = secretstore::connections(&state.data_dir)?;
    let n = configs.len();
    *state.configs.write().await = configs;
    Ok(n)
}

/// Is there a vault, and is it open? Drives the startup gate.
#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<Status, crate::apperror::AppError> {
    Ok(secretstore::status(&state.data_dir))
}

/// First run: choose the password. Anything an earlier version left on disk is
/// folded in, and the count of what came with it is returned.
#[tauri::command]
pub async fn vault_create(password: String, state: State<'_, AppState>) -> Result<usize, crate::apperror::AppError> {
    secretstore::create(&state.data_dir, &password)?;
    // Whatever the upgrade carried in has to reach the running app, not just
    // the file — otherwise the sidebar reports "No connections yet" about a
    // vault that holds all of them.
    adopt_into_state(&state).await
}

#[tauri::command]
pub async fn vault_unlock(password: String, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    secretstore::unlock(&state.data_dir, &password)?;
    adopt_into_state(&state).await?;
    Ok(())
}

#[tauri::command]
pub async fn vault_lock() -> Result<(), crate::apperror::AppError> {
    secretstore::lock();
    Ok(())
}

#[tauri::command]
pub async fn vault_change_password(
    current: String,
    next: String,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    secretstore::change_password(&state.data_dir, &current, &next).map_err(Into::into)
}

/// Turn the vault OFF: verify the password, decrypt everything back to the
/// plain-mode files, delete the vault. Requires the correct password — this is
/// a deliberate downgrade to unencrypted storage, so the UI must confirm it and
/// the backend must not do it for someone who can't open the vault.
#[tauri::command]
pub async fn vault_disable(
    password: String,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    secretstore::disable(&state.data_dir, &password)?;
    adopt_into_state(&state).await?;
    Ok(())
}

/// Write a copy — the backup and the export are the same thing, because there
/// is only one format. A different password can be given for a file that is
/// going to travel.
#[tauri::command]
pub async fn vault_export(
    path: std::path::PathBuf,
    password: Option<String>,
    state: State<'_, AppState>,
) -> Result<usize, crate::apperror::AppError> {
    let pw = password.as_deref().filter(|p| !p.is_empty());
    secretstore::export_copy(&state.data_dir, &path, pw).map_err(Into::into)
}

/// Merge another vault file in. Connections arrive with fresh ids, so this
/// adds to what is here rather than replacing it.
#[tauri::command]
pub async fn vault_import(
    path: std::path::PathBuf,
    password: String,
    state: State<'_, AppState>,
) -> Result<ImportSummary, crate::apperror::AppError> {
    let summary =
        secretstore::import_file(&state.data_dir, &path, &password)?;
    adopt_into_state(&state).await?;
    Ok(summary)
}

/// Folder attributes (colour, note, replica-set flag, primary) by path — held
/// in the vault with the connections they describe.
#[tauri::command]
pub async fn list_folder_meta(state: State<'_, AppState>) -> Result<serde_json::Value, crate::apperror::AppError> {
    Ok(crate::storage::load_folders(&state.data_dir))
}

#[tauri::command]
pub async fn save_folder_meta(
    folders: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    crate::storage::save_folders(&state.data_dir, &folders)
        .await
        .map_err(Into::into)
}
