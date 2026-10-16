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
    // HEADER under FORMAT text needs PostgreSQL ≥ 15 (before that it was
    // CSV-only). Older servers reject it loudly — still better than the
    // previous behaviour, which silently imported the header row as data.
    let hdr = if header { ", HEADER true" } else { "" };
    format!("FORMAT {fmt}{hdr}")
}

/// A SELECT-ish COPY export source is interpolated raw into
/// `COPY ({source}) TO STDOUT`, and `copy_out_raw` rides the simple query
/// protocol — a stacked statement (`SELECT 1) TO STDOUT; DELETE FROM users;
/// --`) would EXECUTE. The source must therefore be exactly ONE read
/// statement. Judged on the blanked text (sqlguard's own scanner, so a `;`
/// or `)` inside a string, quoted identifier or comment cannot trip it):
/// no `;` beyond the trailing ones the caller already trims, balanced parens
/// (an early `)` closes the COPY's own parenthesis), and a read-family first
/// keyword — a parenthesised `(DELETE … RETURNING *)` is a write the
/// statement guard cannot see through the parens. Data-modifying CTEs and
/// `SELECT … INTO` pass this shape check and are the statement guard's job.
fn check_copy_source(source: &str) -> Result<(), AppError> {
    let blanked = crate::sqlguard::blank(source);
    let body = blanked.trim_end().trim_end_matches(';');
    if body.contains(';') {
        return Err(AppError::guard(
            "COPY export source must be a single statement"));
    }
    let mut depth = 0i32;
    for c in body.chars() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return Err(AppError::guard(
                        "COPY export source must be a single statement"));
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(AppError::guard(
            "COPY export source has unbalanced parentheses"));
    }
    let inner = body.trim_start().trim_start_matches('(').trim_start();
    let kw: String = inner.chars().take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>().to_lowercase();
    if !matches!(kw.as_str(), "select" | "with" | "values" | "table") {
        return Err(AppError::guard(
            "COPY export source must be a SELECT"));
    }
    Ok(())
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
                // Interpolated raw over the simple query protocol — validate
                // the shape, then run the same guard as any other statement
                // (a data-modifying CTE or SELECT … INTO is a write).
                check_copy_source(s)?;
                state.guard_statement(&session_id, s).await?;
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

#[cfg(test)]
mod tests {
    use super::{check_copy_source, copy_opts};

    #[test]
    fn copy_opts_pass_header_through_for_both_formats() {
        // HEADER used to be dropped under FORMAT text, so a .tsv with a
        // header imported the header as data. PG ≥ 15 supports it there.
        assert_eq!(copy_opts("csv", true), "FORMAT csv, HEADER true");
        assert_eq!(copy_opts("csv", false), "FORMAT csv");
        assert_eq!(copy_opts("tsv", true), "FORMAT text, HEADER true");
        assert_eq!(copy_opts("tsv", false), "FORMAT text");
    }

    #[test]
    fn legit_single_statements_pass() {
        for s in [
            "SELECT a, b FROM t WHERE x = 1",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "(SELECT 1)",
            "((SELECT 1) UNION (SELECT 2))",
            "VALUES (1, 2)",
            // trailing semicolons were always trimmed — still tolerated
            "SELECT 1;",
            "SELECT 1;;",
            "SELECT 1 ; ",
            // a `;` or `)` inside a string/identifier/comment is not stacking
            "SELECT ';' FROM t",
            "SELECT 'a)b' FROM t",
            "SELECT \"a;b\" FROM t",
            "SELECT 1 -- ; DROP TABLE t\n",
            "SELECT $$ ; $$",
        ] {
            assert!(check_copy_source(s).is_ok(), "{s}");
        }
    }

    #[test]
    fn stacked_statements_are_rejected() {
        for s in [
            // the audit's payload: closes the COPY paren, then stacks
            "SELECT 1) TO STDOUT; DELETE FROM users; --",
            "SELECT 1; DELETE FROM users",
            "SELECT 1; SELECT 2",
            "SELECT 1; ;",
            // an early `)` alone already breaks the one-statement shape
            "SELECT 1) FROM t",
            "SELECT (1",
            // a parenthesised write is invisible to the statement guard
            "(DELETE FROM users RETURNING *)",
            "DROP TABLE t",
        ] {
            assert!(check_copy_source(s).is_err(), "{s}");
        }
    }

    #[test]
    fn shape_clean_writes_are_the_statement_guards_job() {
        // check_copy_source judges shape only; these pass it and must be
        // refused by guard_statement (is_write) before the COPY is built.
        for s in [
            "WITH x AS (DELETE FROM t RETURNING *) SELECT 1",
            "SELECT * INTO new_table FROM t",
        ] {
            assert!(check_copy_source(s).is_ok(), "{s}");
            assert!(crate::sqlguard::is_write(s), "{s}");
        }
    }
}
