use tauri::State;
use uuid::Uuid;
use sqlx::AssertSqlSafe;
use anyhow::Result;
use sqlx::Row as SqlxRow;

use crate::db::browser::{
    self, BrowseQuery, build_select, build_value_counts,
};
use crate::db::types::{
    BrowseParams, ColumnInfo, FilterClause, LiveSession, QueryResult, TableMeta,
};
use crate::db::connection::get_session_pub;
use crate::state::AppState;

/// Get full column metadata + FK info for a table.
/// `parent` = "schema.table" or "database.table" or "table".
#[tauri::command]
pub async fn get_table_meta(
    session_id: Uuid,
    parent: String,
    state: State<'_, AppState>,
) -> Result<TableMeta, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;

    let (ns, table) = split_parent_opt(&parent);

    match session.as_ref() {
        LiveSession::Mysql(pool) =>
            browser::get_table_meta_mysql(pool, ns.unwrap_or(""), table)
                .await.map_err(Into::into),
        LiveSession::Postgres(pool) =>
            browser::get_table_meta_pg(pool, ns.unwrap_or("public"), table)
                .await.map_err(Into::into),
        LiveSession::Redis(..) =>
            Err("Data browser not available for Redis".into()),
        LiveSession::Clickhouse(ch) =>
            browser::get_table_meta_clickhouse(ch, ns.unwrap_or("default"), table)
                .await.map_err(Into::into),
        LiveSession::Sqlite(pool) =>
            browser::get_table_meta_sqlite(pool, ns.unwrap_or("main"), table)
                .await.map_err(Into::into),
        LiveSession::Parquet(f) => Ok(browser::get_table_meta_parquet(f)),
        LiveSession::MongoDb(client) => {
            // Sampled keys + estimated count. `ns` is the database; a bare
            // collection name cannot be addressed (no default db on a session).
            let db = ns.ok_or("MongoDB table metadata needs db.collection")?;
            crate::db::mongodb::get_table_meta(client, db, table)
                .await.map_err(Into::into)
        }
        LiveSession::Duckdb(s) => {
            // `table` is the tree's "schema.table" form (DuckDB is
            // three-level); the parent prefix is the database.
            crate::db::duckdb::get_table_meta(s, ns.unwrap_or("memory"), table)
                .await.map_err(Into::into)
        }
        LiveSession::SqlServer(s) => {
            // parent = "db.schema.table"; the database segment is required —
            // the driver queries that database's sys catalogs explicitly.
            let db = ns.ok_or("SQL Server table metadata needs db.schema.table")?;
            crate::db::sqlserver::get_table_meta(s, db, table)
                .await.map_err(Into::into)
        }
    }
}

/// A browsed page, plus the statement that produced it.
///
/// `#[serde(flatten)]` keeps the wire shape identical to a bare `QueryResult`
/// with one extra key, so nothing downstream had to change to gain the
/// statement text.
#[derive(serde::Serialize)]
pub struct BrowseResult {
    #[serde(flatten)]
    pub result: QueryResult,
    /// Exactly what ran, with bound values inlined for readability.
    pub executed_sql: String,
}

/// Fetch a page of rows with optional filters + sort.
#[tauri::command]
pub async fn browse_table(
    params: BrowseParams,
    state: State<'_, AppState>,
) -> Result<BrowseResult, crate::apperror::AppError> {
    let session = get_session_pub(params.session_id, &state.sessions)
        .await
        ?;

    // The statement text is captured from the builder that actually ran, never
    // rebuilt for display. A log that reconstructs the SQL is a log that can be
    // wrong — and PostgreSQL's parameter casts (`$1::bigint`, `col::text`) make
    // the executed form genuinely different from the obvious guess.
    let mut executed = String::new();

    // A pinned connection wins. Browsing during an open transaction must show
    // the session's own uncommitted rows — otherwise someone inserts a row,
    // opens the browser, does not see it, and concludes the insert failed.
    let tx_conn = state.tx_conns.read().await.get(&params.session_id).cloned();
    if let Some(txc) = tx_conn {
        let mut guard = txc.lock().await;
        let r = match &mut *guard {
            crate::state::TxConn::My(conn) => {
                let q = build_select(&params.table, &params.filters, &params.sort,
                                     params.limit, params.offset, false, &Default::default());
                executed = inline_params(&q.sql, &q.values, LitStyle::Mysql);
                run_mysql(&mut **conn, q).await.map_err(crate::apperror::AppError::from)
            }
            crate::state::TxConn::Pg(conn) => {
                let types = if params.filters.is_empty() {
                    Default::default()
                } else {
                    browser::pg_column_types(&mut **conn, &params.table).await
                };
                let q = build_select(&params.table, &params.filters, &params.sort,
                                     params.limit, params.offset, true, &types);
                executed = inline_params(&q.sql, &q.values, LitStyle::Standard);
                run_pg(&mut **conn, q).await.map_err(crate::apperror::AppError::from)
            }
        }?;
        return Ok(BrowseResult { result: r, executed_sql: executed });
    }

    let result = match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let q = build_select(&params.table, &params.filters, &params.sort,
                                 params.limit, params.offset, false, &Default::default());
            executed = inline_params(&q.sql, &q.values, LitStyle::Mysql);
            run_mysql(pool, q).await.map_err(crate::apperror::AppError::from)
        }
        LiveSession::Postgres(pool) => {
            // Only needed to type the filter parameters — plain paging (the
            // common case) skips the catalog lookup entirely.
            let types = if params.filters.is_empty() {
                Default::default()
            } else {
                browser::pg_column_types(pool, &params.table).await
            };
            let q = build_select(&params.table, &params.filters, &params.sort,
                                 params.limit, params.offset, true, &types);
            executed = inline_params(&q.sql, &q.values, LitStyle::Standard);
            run_pg(pool, q).await.map_err(crate::apperror::AppError::from)
        }
        LiveSession::Redis(..) =>
            Err("Data browser not available for Redis".into()),
        LiveSession::Clickhouse(ch) => {
            let types = if params.filters.is_empty() {
                Default::default()
            } else {
                browser::ch_column_types(ch, &params.table).await
            };
            let q = browser::build_select_clickhouse(&params.table, &params.filters,
                                                     &params.sort, params.limit,
                                                     params.offset, &types);
            executed = inline_ch_params(&q.sql, &q.params);
            crate::db::clickhouse::execute_with_params(ch, &q.sql, &q.params)
                .await.map_err(Into::into)
        }
        LiveSession::Sqlite(pool) => {
            // The MySQL form works verbatim: SQLite accepts backtick-quoted
            // identifiers (a documented MySQL-compatibility extension) and
            // `?` positional parameters natively. Proven by a live test rather
            // than assumed — see build_select_runs_on_a_real_sqlite_file.
            let q = build_select(&params.table, &params.filters, &params.sort,
                                 params.limit, params.offset, false, &Default::default());
            executed = inline_params(&q.sql, &q.values, LitStyle::Standard);
            run_sqlite(pool, q).await.map_err(Into::into)
        }
        LiveSession::Duckdb(s) => {
            // The PG form, not the MySQL form: DuckDB accepts double-quoted
            // identifiers and `$N` parameters but NOT backticks (measured —
            // Parser Error at "`"). Pinned by the live test in db/duckdb.rs
            // (the_browse_builder_runs_verbatim_on_duckdb).
            let q = build_select(&params.table, &params.filters, &params.sort,
                                 params.limit, params.offset, true, &Default::default());
            executed = inline_params(&q.sql, &q.values, LitStyle::Standard);
            crate::db::duckdb::execute_params(s, &q.sql, &q.values)
                .await.map_err(Into::into)
        }
        // MongoDB collections browse through the find path: sort maps to a
        // BSON sort document; the filter BAR's SQL-ish filter clauses have no
        // honest mapping (types are strings, operators are MQL) and are
        // refused rather than guessed — the find editor is the filtering UI.
        LiveSession::MongoDb(client) => {
            if !params.filters.is_empty() {
                return Err("column filters are not available for MongoDB collections — \
                            use the find editor's filter document".into());
            }
            let (db, coll) = split_parent_opt(&params.table);
            let db = db.ok_or("MongoDB browse needs db.collection")?;
            let sort = if params.sort.is_empty() { None } else {
                let doc = params.sort.iter()
                    .map(|s| format!("{}: {}", serde_json::to_string(&s.column).unwrap(),
                         match s.direction { crate::db::types::SortDir::Asc => 1, crate::db::types::SortDir::Desc => -1 }))
                    .collect::<Vec<_>>().join(", ");
                Some(format!("{{{doc}}}"))
            };
            let args = crate::db::mongodb::FindArgs {
                filter: None, projection: None, sort,
                limit: params.limit, skip: params.offset.max(0) as u64,
            };
            executed = format!("db.{coll}.find({{}}){}.limit({}).skip({})",
                args.sort.as_deref().map(|s| format!(".sort({s})")).unwrap_or_default(),
                params.limit, params.offset.max(0));
            crate::db::mongodb::find(client, db, coll, &args).await.map_err(Into::into)
        }
        // T-SQL browse: bracket quoting, @Pn binds, TOP/OFFSET…FETCH paging —
        // built and parameterised in the driver (db::sqlserver), which also
        // renders the display copy with the values inlined.
        LiveSession::SqlServer(s) => {
            let (r, display) = crate::db::sqlserver::browse_table(
                s, &params.table, &params.filters, &params.sort,
                params.limit, params.offset).await
                .map_err(crate::apperror::AppError::from)?;
            executed = display;
            Ok(r)
        }
        // A Parquet file has no query engine, so filters and sort are applied
        // by an in-memory scan (db::parquet::preview_filtered). Plain paging
        // still takes the fast row-group-skipping path inside that function.
        LiveSession::Parquet(f) => {
            executed = if params.filters.is_empty() && params.sort.is_empty() {
                format!("(parquet page: rows {}..{})",
                        params.offset.max(0), params.offset.max(0) + params.limit.max(0))
            } else {
                format!("(parquet in-memory scan: {} filter(s), {} sort key(s))",
                        params.filters.len(), params.sort.len())
            };
            {
                // A filtered browse can decode up to SCAN_CAP (1M) rows of a
                // multi-GiB file — CPU-bound work that pinned an async worker
                // for seconds. Off the runtime, mirroring commands/export.rs.
                let f = f.clone();
                let (limit, offset) = (params.limit.max(0) as usize, params.offset.max(0) as usize);
                let filters = params.filters.clone();
                let sort = params.sort.clone();
                tokio::task::spawn_blocking(move ||
                    crate::db::parquet::preview_filtered(&f, limit, offset, &filters, &sort))
                    .await
                    .map_err(|e| crate::apperror::AppError::from(format!("parquet task failed: {e}")))?
                    .map_err(Into::into)
            }
        }
    }?;

    Ok(BrowseResult { result, executed_sql: executed })
}

/// The parameterised statement rendered as one runnable line, for the log.
///
/// The browser binds every value, which is what keeps it injection-proof — but
/// a log line of `WHERE "id" = $1::bigint` cannot be pasted into an editor or
/// compared against a slow-query log. This substitutes the bound values back in
/// **for display only**; the executed statement keeps its placeholders.
fn inline_params(sql: &str, values: &[String], style: LitStyle) -> String {
    let mut out = String::with_capacity(sql.len() + values.len() * 8);
    let mut vals = values.iter();
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '?' => {
                out.push_str(&quote_literal_for(vals.next(), style));
                i += 1;
            }
            // `$12` — consume every digit, so $1 and $12 are told apart.
            '$' if chars.get(i + 1).is_some_and(|c| c.is_ascii_digit()) => {
                let mut j = i + 1;
                let mut n = 0usize;
                while j < chars.len() && chars[j].is_ascii_digit() {
                    n = n * 10 + chars[j].to_digit(10).unwrap() as usize;
                    j += 1;
                }
                out.push_str(&quote_literal_for(values.get(n.saturating_sub(1)), style));
                i = j;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// The ClickHouse form: `{name:Type}` placeholders, bound server-side.
fn inline_ch_params(sql: &str, params: &[(String, String, String)]) -> String {
    let mut out = sql.to_string();
    for (name, ty, value) in params {
        out = out.replace(&format!("{{{name}:{ty}}}"), &quote_literal_for(Some(value), LitStyle::Clickhouse));
    }
    out
}

/// How each engine spells an escaped quote inside a string literal.
#[derive(Clone, Copy, PartialEq)]
enum LitStyle {
    /// Backslash is an escape and the quote is doubled.
    Mysql,
    /// `standard_conforming_strings` / SQLite: the backslash is data.
    Standard,
    /// Backslash is an escape and the quote is written `\'`.
    Clickhouse,
}

/// Render a bound value as the literal the server would have seen.
///
/// The log line has to be **re-runnable** — that is the whole point of
/// substituting the values back in. Quote-doubling alone is not enough on
/// MySQL or ClickHouse, where a backslash escapes the next character: a
/// filter value of `C:\` logged that way ends its own literal and the pasted
/// statement is a syntax error rather than the query that ran. Nothing is
/// injected (the executed statement keeps its placeholders), but a log you
/// cannot replay is not an audit trail.
fn quote_literal_for(v: Option<&String>, style: LitStyle) -> String {
    match v {
        Some(s) => {
            let body = match style {
                LitStyle::Standard => s.replace('\'', "''"),
                LitStyle::Mysql => s.replace('\\', "\\\\").replace('\'', "''"),
                LitStyle::Clickhouse => s.replace('\\', "\\\\").replace('\'', "\\'"),
            };
            format!("'{}'", body)
        }
        // A placeholder with no value means the builder and this renderer
        // disagree; saying so beats printing a plausible lie.
        None => "?".into(),
    }
}

/// Top-N most frequent values of one column (for the header filter popover):
/// SELECT col, COUNT(*) GROUP BY col ORDER BY count DESC LIMIT n, faceted by
/// the other columns' active filters. Read-only, fully parameterised.
#[tauri::command]
pub async fn column_value_counts(
    session_id: Uuid,
    table: String,
    column: String,
    filters: Vec<FilterClause>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<QueryResult, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;

    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let q = build_value_counts(&table, &column, &filters, limit, false, &Default::default());
            run_mysql(pool, q).await.map_err(crate::apperror::AppError::from)
        }
        LiveSession::Postgres(pool) => {
            let types = if filters.is_empty() {
                Default::default()
            } else {
                browser::pg_column_types(pool, &table).await
            };
            let q = build_value_counts(&table, &column, &filters, limit, true, &types);
            run_pg(pool, q).await.map_err(crate::apperror::AppError::from)
        }
        LiveSession::Redis(..) =>
            Err("Data browser not available for Redis".into()),
        LiveSession::Clickhouse(ch) => {
            let types = browser::ch_column_types(ch, &table).await;
            let mut q = browser::build_select_clickhouse(&table, &filters, &[], limit, 0, &types);
            // Reshape the SELECT * into the value-count aggregate the popover
            // wants. ClickHouse has no LIMIT-in-subquery restriction, so the
            // grouped form is built directly.
            let col = format!("`{}`", column.replace('`', "``"));
            let from = q.sql.split(" FROM ").nth(1).unwrap_or("").to_string();
            let from = from.split(" LIMIT ").next().unwrap_or(&from).to_string();
            q.sql = format!("SELECT {col} AS value, count() AS cnt FROM {from} \
                             GROUP BY {col} ORDER BY cnt DESC LIMIT {}", limit.max(0));
            crate::db::clickhouse::execute_with_params(ch, &q.sql, &q.params)
                .await.map_err(Into::into)
        }
        LiveSession::Sqlite(pool) => {
            let q = build_value_counts(&table, &column, &filters, limit, false, &Default::default());
            run_sqlite(pool, q).await.map_err(Into::into)
        }
        // Would require a GROUP BY, which is exactly what Parquet cannot do.
        // The header filter popover is hidden for this engine.
        LiveSession::Parquet(_) =>
            Err("value counts need a query engine — Parquet is a file".into()),
        // One $group pipeline would answer this, but v1 keeps the popover
        // honest: no aggregation surface, no counts.
        LiveSession::MongoDb(_) =>
            Err("value counts are not available for MongoDB collections".into()),
        LiveSession::Duckdb(s) => {
            let q = build_value_counts(&table, &column, &filters, limit, true, &Default::default());
            crate::db::duckdb::execute_params(s, &q.sql, &q.values)
                .await.map_err(Into::into)
        }
        LiveSession::SqlServer(s) =>
            crate::db::sqlserver::value_counts(s, &table, &column, &filters, limit)
                .await.map_err(Into::into),
    }
}

// NOTE: inline row editing was intentionally removed — the data browser is
// strictly read-only, so there is no server-side command to mutate table data
// through the grid. (Deliberate safety decision.)

// ── Internal runners ─────────────────────────────────────────────────────────

// Both runners measure the same split as db/mysql.rs / db/postgres.rs
// `execute`: execution_ms = time until the FIRST row (server work),
// fetch_ms = the rest of the stream (row transfer). The session log's
// canonical browse line prints both.

/// One browse runner per sqlx engine (WP-16 16.3, following playground.rs's
/// run_engine! precedent): the bind/stream/timing/column scaffolding is
/// identical — only the database type and the cell decoder differ, and the
/// three hand copies had already begun to drift. Generic over the executor so
/// the same code serves a pool **or** a pinned connection: without that,
/// browsing during an open transaction reads from a different connection and
/// cannot see the session's uncommitted rows.
///
/// Both timing figures keep db/mysql.rs / db/postgres.rs `execute`'s split:
/// execution_ms = time until the FIRST row (server work), fetch_ms = the rest
/// of the stream (row transfer). The session log's canonical browse line
/// prints both.
macro_rules! browse_runner {
    ($name:ident, $db:ty, $row:ty, $decode:expr) => {
        async fn $name<'e, E>(pool: E, q: BrowseQuery) -> Result<QueryResult>
        where
            E: sqlx::Executor<'e, Database = $db>,
        {
            use sqlx::{Column, TypeInfo};
            use futures_util::TryStreamExt;
            let start = std::time::Instant::now();
            let mut query = sqlx::query(AssertSqlSafe(q.sql.as_str()));
            for v in &q.values { query = query.bind(v); }
            let mut stream = query.fetch(pool);
            let mut rows: Vec<$row> = Vec::new();
            let mut first_row_ms: Option<u64> = None;
            while let Some(row) = stream.try_next().await? {
                if first_row_ms.is_none() { first_row_ms = Some(start.elapsed().as_millis() as u64); }
                rows.push(row);
            }
            let execution_ms = first_row_ms.unwrap_or_else(|| start.elapsed().as_millis() as u64);
            let fetch_ms = start.elapsed().as_millis() as u64 - execution_ms;

            let columns: Vec<ColumnInfo> = if let Some(first) = rows.first() {
                first.columns().iter().map(|c| ColumnInfo {
                    name: c.name().to_string(), type_name: c.type_info().name().to_string(), nullable: true,
                }).collect()
            } else { vec![] };

            #[allow(clippy::redundant_closure_call)]
            let data: Vec<crate::db::types::Row> = ($decode)(&columns, &rows);
            Ok(QueryResult { columns, rows: data, rows_affected: None, truncated: false,
                             execution_ms, fetch_ms, warnings: vec![] })
        }
    };
}

browse_runner!(run_mysql, sqlx::MySql, sqlx::mysql::MySqlRow,
    |columns: &Vec<ColumnInfo>, rows: &Vec<sqlx::mysql::MySqlRow>| {
        // Classify each column's type once, not once per cell.
        let classes: Vec<crate::db::mysql::MySqlTypeClass> = columns.iter()
            .map(|c| crate::db::mysql::classify_mysql_type(&c.type_name))
            .collect();
        rows.iter().map(|r| {
            classes.iter().enumerate().map(|(i, &class)| {
                crate::db::mysql::json_value_from_row_class(r, i, class)
            }).collect()
        }).collect()
    });

browse_runner!(run_pg, sqlx::Postgres, sqlx::postgres::PgRow,
    |columns: &Vec<ColumnInfo>, rows: &Vec<sqlx::postgres::PgRow>| {
        rows.iter().map(|r| {
            columns.iter().enumerate().map(|(i, col)| {
                crate::db::postgres::json_from_row_pub(r, i, &col.type_name)
            }).collect()
        }).collect()
    });

// SQLite decoding goes through the driver's value-first decoder, because a
// column's declared type is only a hint there.
browse_runner!(run_sqlite, sqlx::Sqlite, sqlx::sqlite::SqliteRow,
    |columns: &Vec<ColumnInfo>, rows: &Vec<sqlx::sqlite::SqliteRow>| {
        rows.iter().map(|r| {
            (0..columns.len()).map(|i| crate::db::sqlite::json_from_row_pub(r, i)).collect()
        }).collect()
    });

// ── Helpers ───────────────────────────────────────────────────────────────────

fn split_parent_opt(parent: &str) -> (Option<&str>, &str) {
    if let Some((ns, t)) = parent.split_once('.') {
        (Some(ns), t)
    } else {
        (None, parent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::{FilterClause, FilterOp, SortClause, SortDir};

    /// The SQLite browse path reuses the MySQL query builder rather than
    /// adding a third one. That rests on two SQLite behaviours which are easy
    /// to assert and easy to get wrong:
    ///
    ///   * backtick-quoted identifiers are accepted (a documented
    ///     MySQL-compatibility extension), and
    ///   * `?` positional parameters bind natively.
    ///
    /// If either ever stops holding, this fails instead of the data browser
    /// silently breaking for every SQLite user.
    #[tokio::test]
    async fn the_mysql_query_builder_runs_verbatim_on_a_real_sqlite_file() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let dir = std::env::temp_dir().join(format!("txui-browse-sqlite-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("b.db");
        let _ = std::fs::remove_file(&path);

        let opts = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
        let pool = SqlitePoolOptions::new().connect_with(opts).await.unwrap();
        // A reserved word as a column name, so the quoting is load-bearing.
        sqlx::raw_sql(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, \"order\" TEXT, qty INTEGER);
             INSERT INTO items VALUES (1,'a',5),(2,'b',10),(3,'a',15);",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Plain page.
        let q = build_select("main.items", &[], &[], 10, 0, false, &Default::default());
        let r = run_sqlite(&pool, q).await.unwrap();
        assert_eq!(r.rows.len(), 3);

        // Filter (binds a parameter) + sort (quotes a reserved identifier).
        let filters = vec![FilterClause {
            column: "order".into(),
            op: FilterOp::Eq,
            value: Some("a".into()),
        }];
        let sort = vec![SortClause { column: "qty".into(), direction: SortDir::Desc }];
        let q = build_select("main.items", &filters, &sort, 10, 0, false, &Default::default());
        let r = run_sqlite(&pool, q).await.unwrap();
        assert_eq!(r.rows.len(), 2, "filter must be applied, not ignored");
        // DESC by qty → 15 before 5.
        let qty = r.columns.iter().position(|c| c.name == "qty").unwrap();
        assert_eq!(r.rows[0][qty], serde_json::json!(15));
        assert_eq!(r.rows[1][qty], serde_json::json!(5));

        // Offset paging.
        let q = build_select("main.items", &[], &[], 1, 2, false, &Default::default());
        let r = run_sqlite(&pool, q).await.unwrap();
        assert_eq!(r.rows.len(), 1);

        // And the value-count popover query, which uses the same builder.
        let q = build_value_counts("main.items", "order", &[], 10, false, &Default::default());
        let r = run_sqlite(&pool, q).await.unwrap();
        assert_eq!(r.rows.len(), 2); // 'a' twice, 'b' once

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod inline_tests {
    use super::*;

    // The data browser binds every value, which is what makes it
    // injection-proof — and what made its log line a reconstruction that could
    // disagree with the statement that ran. These cover the ways the rendering
    // could quietly differ from the truth.

    #[test]
    fn mysql_placeholders_are_filled_in_order() {
        assert_eq!(
            inline_params("SELECT * FROM t WHERE a = ? AND b = ?",
                          &["1".into(), "x".into()], LitStyle::Mysql),
            "SELECT * FROM t WHERE a = '1' AND b = 'x'");
    }

    #[test]
    fn pg_placeholders_are_filled_by_number_not_by_position() {
        // `$2` before `$1` is legal and the browser's builder can emit it.
        assert_eq!(
            inline_params("SELECT * FROM t WHERE b = $2 AND a = $1",
                          &["one".into(), "two".into()], LitStyle::Standard),
            "SELECT * FROM t WHERE b = 'two' AND a = 'one'");
    }

    #[test]
    fn a_two_digit_placeholder_is_not_read_as_the_first_one() {
        // `$12` must not render as `$1` followed by a literal 2 — the bug this
        // test exists for produces a plausible-looking wrong line.
        let vals: Vec<String> = (1..=12).map(|n| n.to_string()).collect();
        let out = inline_params("SELECT $12, $1", &vals, LitStyle::Standard);
        assert_eq!(out, "SELECT '12', '1'");
    }

    #[test]
    fn the_pg_type_cast_survives_into_the_log() {
        // This is the whole reason the log cannot be reconstructed: the browser
        // casts the PARAMETER so the column stays indexable, and a hand-written
        // guess would omit it.
        assert_eq!(
            inline_params("SELECT * FROM t WHERE \"id\" = $1::bigint", &["7".into()],
                          LitStyle::Standard),
            "SELECT * FROM t WHERE \"id\" = '7'::bigint");
    }

    #[test]
    fn a_quote_in_a_value_is_escaped() {
        assert_eq!(inline_params("WHERE a = ?", &["it's".into()], LitStyle::Mysql),
                   "WHERE a = 'it''s'");
    }

    #[test]
    fn a_placeholder_with_no_value_stays_a_placeholder() {
        // Printing a plausible literal would be worse than admitting the
        // renderer and the builder disagree.
        assert_eq!(inline_params("WHERE a = ? AND b = ?", &["1".into()], LitStyle::Mysql),
                   "WHERE a = '1' AND b = ?");
        assert_eq!(inline_params("WHERE a = $3", &["1".into()], LitStyle::Mysql), "WHERE a = ?");
    }

    #[test]
    fn a_bare_dollar_is_left_alone() {
        // `$$` quoting and `$tag$` bodies must not be eaten.
        assert_eq!(inline_params("SELECT $$body$$", &[], LitStyle::Mysql), "SELECT $$body$$");
    }

    /// The log line is meant to be pasted back and re-run. A value holding a
    /// backslash used to end its own literal on the engines where a backslash
    /// escapes — the executed statement was fine (it keeps its placeholders),
    /// but the recorded one would not parse.
    #[test]
    fn a_logged_value_containing_a_backslash_is_still_re_runnable() {
        assert_eq!(
            inline_params("SELECT * FROM t WHERE p = ?", &[r"C:\".into()], LitStyle::Mysql),
            r"SELECT * FROM t WHERE p = 'C:\\'");
        // PostgreSQL and SQLite read the backslash as data — doubling it there
        // would log a value that is not the one that ran.
        assert_eq!(
            inline_params("SELECT * FROM t WHERE p = ?", &[r"C:\".into()], LitStyle::Standard),
            r"SELECT * FROM t WHERE p = 'C:\'");
    }

    #[test]
    fn clickhouse_escapes_the_quote_with_a_backslash() {
        assert_eq!(
            inline_ch_params("SELECT * FROM t WHERE a = {p0:String}",
                             &[("p0".into(), "String".into(), "o'brien".into())]),
            r"SELECT * FROM t WHERE a = 'o\'brien'");
    }

    #[test]
    fn clickhouse_named_params_are_filled() {
        assert_eq!(
            inline_ch_params("SELECT * FROM t WHERE a = {p0:String}",
                             &[("p0".into(), "String".into(), "x".into())]),
            "SELECT * FROM t WHERE a = 'x'");
    }
}
