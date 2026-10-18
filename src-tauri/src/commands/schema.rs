use tauri::State;
use uuid::Uuid;

use crate::db::connection;
use crate::db::types::SchemaNode;
use crate::state::AppState;

/// List top-level schema nodes.
/// `context` = database name (MySQL) | schema name (PG) | None = top level.
///
/// The top-level listing is narrowed by the connection's `db_filter` (W5.6)
/// when the session has one — every frontend consumer of the tree (sidebar,
/// database switcher, data browser) goes through this one command, so
/// filtering here filters all of them, and a hidden database's children are
/// never introspected because the node is never expanded.
#[tauri::command]
pub async fn list_schema(
    session_id: Uuid,
    context: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SchemaNode>, crate::apperror::AppError> {
    let nodes = connection::list_schema(session_id, context.as_deref(), &state.sessions).await?;
    if context.is_some() {
        return Ok(nodes);
    }
    let guard = state.session_meta.read().await.get(&session_id).cloned();
    match guard {
        Some(g) if g.engine.has_database_listing() && !g.db_filter.is_empty() => {
            Ok(crate::db::types::filter_database_listing(nodes, &g.db_filter))
        }
        _ => Ok(nodes),
    }
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
