/// Stored SQL templates — SQLite-backed, engine-tagged, snippet-bodied.
/// Powers the editor's `?name` expansion. `builtin` rows are the curated seeds;
/// they can be edited or deleted like any other (seeding only runs on an empty
/// table, so deletions stick).
use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct SqlTemplate {
    pub id: i64,
    pub name: String,
    /// 'mysql' | 'postgres' | 'redis', NULL = any engine
    pub engine: Option<String>,
    pub description: String,
    pub body: String,
    pub builtin: bool,
    pub updated_at: String,
}

fn validate(name: &str, body: &str) -> Result<(), crate::apperror::AppError> {
    let name = name.trim();
    if name.is_empty() { return Err("name is required".into()); }
    if body.trim().is_empty() { return Err("body is required".into()); }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphabetic()
        || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("name must match [a-z][a-z0-9_-]* (letters first, then letters/digits/_/-)".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn list_sql_templates(state: State<'_, AppState>) -> Result<Vec<SqlTemplate>, crate::apperror::AppError> {
    let pool = &state.history;
    let rows = sqlx::query(
        "SELECT id, name, engine, description, body, builtin, updated_at \
         FROM sql_templates ORDER BY name"
    )
    .fetch_all(&*pool).await
    ?;
    Ok(rows.iter().map(|r| SqlTemplate {
        id: r.get(0),
        name: r.get(1),
        engine: r.get(2),
        description: r.get(3),
        body: r.get(4),
        builtin: r.get::<i64, _>(5) != 0,
        updated_at: r.get(6),
    }).collect())
}

/// Insert when `id` is None, update otherwise. Returns the row id.
#[tauri::command]
pub async fn save_sql_template(
    id: Option<i64>,
    name: String,
    engine: Option<String>,
    description: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<i64, crate::apperror::AppError> {
    validate(&name, &body)?;
    let engine = engine.filter(|e| !e.trim().is_empty() && e != "any");
    let pool = &state.history;
    match id {
        Some(id) => {
            sqlx::query(
                "UPDATE sql_templates SET name=?, engine=?, description=?, body=?, \
                 updated_at=datetime('now') WHERE id=?"
            )
            .bind(name.trim()).bind(&engine).bind(&description).bind(&body).bind(id)
            .execute(&*pool).await
            ?;
            Ok(id)
        }
        None => {
            let res = sqlx::query(
                "INSERT INTO sql_templates (name, engine, description, body) VALUES (?, ?, ?, ?)"
            )
            .bind(name.trim()).bind(&engine).bind(&description).bind(&body)
            .execute(&*pool).await
            ?;
            Ok(res.last_insert_rowid())
        }
    }
}

#[tauri::command]
pub async fn delete_sql_template(id: i64, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    let pool = &state.history;
    sqlx::query("DELETE FROM sql_templates WHERE id=?")
        .bind(id)
        .execute(&*pool).await
        ?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn template_name_rules() {
        assert!(validate("processlist", "SELECT 1").is_ok());
        assert!(validate("my-locks_2", "SELECT 1").is_ok());
        assert!(validate("", "SELECT 1").is_err(), "empty name");
        assert!(validate("2locks", "SELECT 1").is_err(), "digit first");
        assert!(validate("my locks", "SELECT 1").is_err(), "space");
        assert!(validate("locks", "").is_err(), "empty body");
        assert!(validate("locks", "   ").is_err(), "blank body");
    }
}
