//! SQLite ATTACH / DETACH.
//!
//! SQLite can expose more than one file to a single connection via
//! `ATTACH DATABASE`, after which the attached file's tables appear under its
//! alias in `PRAGMA database_list` (and so in the schema tree). Because the
//! SQLite pool is opened with `max_connections(1)`, an ATTACH on the pool holds
//! for the whole session — there is no second connection that would miss it.

use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;

/// A schema alias must be a plain identifier — it is interpolated into the
/// statement, so anything else is refused rather than quoted-and-hoped.
fn valid_alias(alias: &str) -> bool {
    !alias.is_empty()
        && alias.len() <= 64
        && alias.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !alias.chars().next().unwrap().is_ascii_digit()
}

/// Attach another SQLite file to this session under `alias`.
#[tauri::command]
pub async fn sqlite_attach(
    session_id: Uuid,
    path: String,
    alias: String,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    if !valid_alias(&alias) {
        return Err("The attach name must be a plain identifier (letters, digits, underscore; not starting with a digit).".into());
    }
    if state.is_read_only(&session_id).await {
        return Err("Connection is read-only — attaching a database is blocked.".into());
    }
    let session = get_session_pub(session_id, &state.sessions).await?;
    match session.as_ref() {
        LiveSession::Sqlite(pool) => {
            // path is a string literal (single-quote escaped); alias is a
            // validated identifier quoted with double quotes.
            let esc = path.replace('\'', "''");
            let sql = format!("ATTACH DATABASE '{esc}' AS \"{alias}\"");
            crate::db::sqlite::execute(pool, &sql).await?;
            Ok(())
        }
        _ => Err("ATTACH is only available for SQLite sessions.".into()),
    }
}

/// Detach a previously attached database. `main` and `temp` cannot be detached.
#[tauri::command]
pub async fn sqlite_detach(
    session_id: Uuid,
    alias: String,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    if !valid_alias(&alias) || alias == "main" || alias == "temp" {
        return Err("Not a detachable database alias.".into());
    }
    if state.is_read_only(&session_id).await {
        return Err("Connection is read-only — detaching a database is blocked.".into());
    }
    let session = get_session_pub(session_id, &state.sessions).await?;
    match session.as_ref() {
        LiveSession::Sqlite(pool) => {
            crate::db::sqlite::execute(pool, &format!("DETACH DATABASE \"{alias}\"")).await?;
            Ok(())
        }
        _ => Err("DETACH is only available for SQLite sessions.".into()),
    }
}
