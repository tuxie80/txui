/// Saved queries / snippets — SQLite-backed, folder-organized.
use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct SavedQuery {
    pub id: i64,
    pub name: String,
    pub folder: String,
    pub sql: String,
    pub updated_at: String,
}

#[tauri::command]
pub async fn list_saved_queries(state: State<'_, AppState>) -> Result<Vec<SavedQuery>, crate::apperror::AppError> {
    let pool = &state.history;
    let rows = sqlx::query(
        "SELECT id, name, folder, sql, updated_at FROM saved_queries ORDER BY folder, name"
    )
    .fetch_all(&*pool).await
    ?;
    Ok(rows.iter().map(|r| SavedQuery {
        id: r.get(0), name: r.get(1), folder: r.get(2), sql: r.get(3), updated_at: r.get(4),
    }).collect())
}

/// Insert when `id` is None, update otherwise. Returns the row id.
#[tauri::command]
pub async fn save_query(
    id: Option<i64>,
    name: String,
    folder: String,
    sql: String,
    state: State<'_, AppState>,
) -> Result<i64, crate::apperror::AppError> {
    if name.trim().is_empty() { return Err("name is required".into()); }
    let pool = &state.history;
    match id {
        Some(id) => {
            sqlx::query(
                "UPDATE saved_queries SET name=?, folder=?, sql=?, updated_at=datetime('now') WHERE id=?"
            )
            .bind(&name).bind(&folder).bind(&sql).bind(id)
            .execute(&*pool).await
            ?;
            Ok(id)
        }
        None => {
            let res = sqlx::query(
                "INSERT INTO saved_queries (name, folder, sql) VALUES (?, ?, ?)"
            )
            .bind(&name).bind(&folder).bind(&sql)
            .execute(&*pool).await
            ?;
            Ok(res.last_insert_rowid())
        }
    }
}

#[tauri::command]
pub async fn delete_saved_query(id: i64, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    let pool = &state.history;
    sqlx::query("DELETE FROM saved_queries WHERE id=?")
        .bind(id)
        .execute(&*pool).await
        ?;
    Ok(())
}
