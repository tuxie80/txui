//! PostgreSQL COPY — native bulk import/export over the wire protocol.
//!
//! `COPY … FROM STDIN` streams a file straight into a table (orders of magnitude
//! faster than row INSERTs), and `COPY … TO STDOUT` streams a table or query out
//! to a file. Both stream chunk-by-chunk, so a file far larger than memory is
//! fine. PostgreSQL only.

use futures_util::StreamExt;
use sqlx::postgres::PgPoolCopyExt;
use tauri::State;
use uuid::Uuid;

use crate::apperror::AppError;
use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;

/// Quote a possibly-qualified relation ("schema.table" → "schema"."table").
fn q_rel(rel: &str) -> String {
    rel.split('.')
        .map(|p| format!("\"{}\"", p.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(".")
}

fn copy_opts(format: &str, header: bool) -> String {
    let fmt = if format == "tsv" { "text" } else { "csv" };
    // HEADER is only valid for CSV.
    let hdr = if header && fmt == "csv" { ", HEADER true" } else { "" };
    format!("FORMAT {fmt}{hdr}")
}

/// Stream a file into `table` via `COPY FROM STDIN`. Returns rows loaded.
#[tauri::command]
pub async fn pg_copy_import(
    session_id: Uuid,
    path: String,
    table: String,
    format: String,
    header: bool,
    state: State<'_, AppState>,
) -> Result<u64, AppError> {
    let session = get_session_pub(session_id, &state.sessions).await?;
    match session.as_ref() {
        LiveSession::Postgres(pool) => {
            if state.is_read_only(&session_id).await {
                return Err("Connection is read-only — COPY import is blocked.".into());
            }
            state.check_prod_bulk(&session_id, "COPY import").await?;
            let stmt = format!("COPY {} FROM STDIN WITH ({})", q_rel(&table), copy_opts(&format, header));
            let file = tokio::fs::File::open(&path).await
                .map_err(|e| AppError::from(format!("could not open {path}: {e}")))?;
            let mut copy = pool.copy_in_raw(&stmt).await?;
            if let Err(e) = copy.read_from(file).await {
                let _ = copy.abort("import failed").await;
                return Err(e.into());
            }
            Ok(copy.finish().await?)
        }
        _ => Err("COPY is a PostgreSQL feature.".into()),
    }
}

/// Stream a table or query to `out_path` via `COPY TO STDOUT`. `source` is a
/// table name or a SELECT statement. Returns bytes written.
#[tauri::command]
pub async fn pg_copy_export(
    session_id: Uuid,
    source: String,
    out_path: String,
    format: String,
    header: bool,
    state: State<'_, AppState>,
) -> Result<u64, AppError> {
    use tokio::io::AsyncWriteExt;
    let session = get_session_pub(session_id, &state.sessions).await?;
    match session.as_ref() {
        LiveSession::Postgres(pool) => {
            let s = source.trim();
            let up = s.to_uppercase();
            let src = if up.starts_with("SELECT") || up.starts_with("WITH") || s.starts_with('(') {
                format!("({})", s.trim_end_matches(';'))
            } else {
                q_rel(s)
            };
            let stmt = format!("COPY {} TO STDOUT WITH ({})", src, copy_opts(&format, header));
            let mut stream = pool.copy_out_raw(&stmt).await?;
            let mut file = tokio::fs::File::create(&out_path).await
                .map_err(|e| AppError::from(format!("could not create {out_path}: {e}")))?;
            let mut bytes: u64 = 0;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                file.write_all(&chunk).await
                    .map_err(|e| AppError::from(format!("could not write {out_path}: {e}")))?;
                bytes += chunk.len() as u64;
            }
            let _ = file.flush().await;
            Ok(bytes)
        }
        _ => Err("COPY is a PostgreSQL feature.".into()),
    }
}
