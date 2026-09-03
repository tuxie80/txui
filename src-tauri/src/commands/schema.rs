use tauri::State;
use uuid::Uuid;

use crate::db::connection;
use crate::db::types::SchemaNode;
use crate::state::AppState;

/// List top-level schema nodes.
/// `context` = database name (MySQL) | schema name (PG) | None = top level.
#[tauri::command]
pub async fn list_schema(
    session_id: Uuid,
    context: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SchemaNode>, crate::apperror::AppError> {
    connection::list_schema(session_id, context.as_deref(), &state.sessions)
        .await
        .map_err(Into::into)
}

/// List columns + indexes for a table.
/// `parent` = "database.table" (MySQL) | "schema.table" (PG).
#[tauri::command]
pub async fn list_columns(
    session_id: Uuid,
    parent: String,
    state: State<'_, AppState>,
) -> Result<Vec<SchemaNode>, crate::apperror::AppError> {
    connection::list_columns(session_id, &parent, &state.sessions)
        .await
        .map_err(Into::into)
}

/// Children of a nested Parquet column, identified by its dotted `path` from the
/// table root (e.g. "addr.geo"). Parquet-only; other engines return empty.
#[tauri::command]
pub async fn list_parquet_struct(
    session_id: Uuid,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<SchemaNode>, crate::apperror::AppError> {
    let session = crate::db::connection::get_session_pub(session_id, &state.sessions).await?;
    match session.as_ref() {
        crate::db::types::LiveSession::Parquet(f) => Ok(crate::db::parquet::struct_children(f, &path)),
        _ => Ok(vec![]),
    }
}

/// Get DDL string for a table or view.
/// `parent` = "database.table" (MySQL) | "schema.table" (PG).
#[tauri::command]
pub async fn get_ddl(
    session_id: Uuid,
    parent: String,
    state: State<'_, AppState>,
) -> Result<String, crate::apperror::AppError> {
    connection::get_ddl(session_id, &parent, &state.sessions)
        .await
        .map_err(Into::into)
}
