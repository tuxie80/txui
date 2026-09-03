/// SQL Quality primitives that must share ONE connection:
/// - EXPLAIN + SHOW WARNINGS (warnings are per-connection state)
/// - EXPLAIN ANALYZE under a session timeout guard (executes the query!)
use sqlx::{AssertSqlSafe, SqlSafeStr};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::{LiveSession, QueryResult};
use crate::db::{mysql, postgres};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct ExplainWarnings {
    pub explain: QueryResult,
    /// SHOW WARNINGS rows (MySQL: includes the optimizer's normalized query,
    /// which exposes implicit casts). Empty for PostgreSQL.
    pub warnings: Option<QueryResult>,
}

#[tauri::command]
pub async fn explain_with_warnings(
    session_id: Uuid,
    sql: String,
    db: Option<String>,
    state: State<'_, AppState>,
) -> Result<ExplainWarnings, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            // detach() → the connection is dropped (closed) rather than
            // returned to the pool, so a `USE` never bleeds onto the next query.
            let mut conn = pool.acquire().await?.detach();
            if let Some(d) = db.as_deref() {
                mysql::execute(&mut conn, &format!("USE `{}`", d.replace('`', "``")))
                    .await.map_err(|e| format!("cannot use `{}`: {}", d, e))?;
            }
            let stmt = format!("EXPLAIN {}", sql);
            let explain = mysql::execute(&mut conn, &stmt)
                .await?;
            let warnings = mysql::execute(&mut conn, "SHOW WARNINGS")
                .await.ok();
            Ok(ExplainWarnings { explain, warnings })
        }
        LiveSession::Postgres(pool) => {
            let mut conn = pool.acquire().await?.detach();
            if let Some(d) = db.as_deref() {
                postgres::execute(&mut conn, &format!("SET search_path TO \"{}\"", d.replace('"', "\"\"")))
                    .await.map_err(|e| format!("cannot set search_path to \"{}\": {}", d, e))?;
            }
            let stmt = format!("EXPLAIN {}", sql);
            let explain = postgres::execute(&mut conn, &stmt)
                .await?;
            Ok(ExplainWarnings { explain, warnings: None })
        }
        _ => Err("EXPLAIN with warnings is only available for MySQL and PostgreSQL".into()),
    }
}

/// EXPLAIN ANALYZE with a server-side timeout guard on the SAME connection.
/// This EXECUTES the statement. On timeout the server error text is returned
/// as Err — the caller reports it (a timeout is itself a finding).
#[tauri::command]
pub async fn explain_analyze_guarded(
    session_id: Uuid,
    sql: String,
    timeout_ms: u64,
    db: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, crate::apperror::AppError> {
    // EXPLAIN ANALYZE actually executes the statement — enforce read-only.
    // Engine-aware: SQL goes through sqlguard, Redis through redisguard.
    // Choosing a guard per call site is how every Redis write slipped past.
    state.guard_statement(&session_id, &sql).await?;

    // MySQL's max_execution_time bounds READ-ONLY SELECT only — EXPLAIN
    // ANALYZE of an UPDATE/DELETE on a writable connection would execute the
    // write's plan with NO timeout at all (WP-13 13.6). This is a guarded
    // feature; refusal fits its contract.
    if crate::sqlguard::is_write(&sql) {
        return Err(crate::apperror::AppError::guard(
            "EXPLAIN ANALYZE executes the statement, and a write cannot be \
             bounded by the timeout guard — run EXPLAIN (without ANALYZE) on \
             writes instead"));
    }
    // Clamp: 0 would mean unbounded (the guard's whole point), and anything
    // past 10 minutes is not a guard.
    let timeout_ms = timeout_ms.clamp(100, 600_000);

    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;

    fn plan_text(r: &QueryResult) -> String {
        r.rows.iter()
            .filter_map(|row| row.last())
            .map(|v| match v {
                serde_json::Value::String(s) => s.clone(),
                other => serde_json::to_string(other).unwrap_or_default(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            // detach() so the session timeout / USE cannot leak onto a pooled
            // connection even if the reset is skipped on an error path.
            let mut conn = pool.acquire().await?.detach();
            if let Some(d) = db.as_deref() {
                mysql::execute(&mut conn, &format!("USE `{}`", d.replace('`', "``")))
                    .await.map_err(|e| format!("cannot use `{}`: {}", d, e))?;
            }
            mysql::execute(&mut conn, &format!("SET SESSION max_execution_time={}", timeout_ms))
                .await?;
            let stmt = format!("EXPLAIN ANALYZE {}", sql);
            let res = mysql::execute(&mut conn, &stmt).await;
            res.map(|r| plan_text(&r)).map_err(Into::into)
        }
        LiveSession::Postgres(pool) => {
            let mut conn = pool.acquire().await?.detach();
            if let Some(d) = db.as_deref() {
                postgres::execute(&mut conn, &format!("SET search_path TO \"{}\"", d.replace('"', "\"\"")))
                    .await.map_err(|e| format!("cannot set search_path to \"{}\": {}", d, e))?;
            }
            postgres::execute(&mut conn, &format!("SET statement_timeout = {}", timeout_ms))
                .await?;
            let stmt = format!("EXPLAIN (ANALYZE, BUFFERS) {}", sql);
            let res = postgres::execute(&mut conn, &stmt).await;
            res.map(|r| plan_text(&r)).map_err(Into::into)
        }
        _ => Err("EXPLAIN ANALYZE is only available for MySQL and PostgreSQL".into()),
    }
}

// ── Column Map (Q1 of docs/SQL_QUALITY_DEEPDIVE.md) ───────────────────────────

#[derive(Debug, serde::Serialize)]
pub struct ColumnMapCol {
    pub name: String,
    pub type_name: String,
    pub nullable: Option<bool>,
}

#[derive(Debug, serde::Serialize)]
pub struct ColumnMap {
    /// sqlparser accepted the statement (AST available)
    pub parse_ok: bool,
    pub parse_error: Option<String>,
    pub statement_kind: Option<String>,
    /// table references found in the AST (qualified as written)
    pub tables: Vec<String>,
    /// server-described output columns — exact wire types, the 100% source
    pub columns: Vec<ColumnMapCol>,
    /// AST-extracted predicate columns (advisor input — exact, not regex)
    pub eq_cols: Vec<String>,
    pub range_cols: Vec<String>,
    /// source expression per SELECT-list item (aligned with `columns` when
    /// lengths match; wildcards prevent alignment and yield an empty list)
    pub sources: Vec<String>,
}

/// Concrete-typed helpers — fn boundaries around executor calls sidestep
/// rustc's "Executor is not general enough" false positive (rustc#102211).
async fn describe_my(conn: &mut sqlx::MySqlConnection, sql: &str)
    -> Result<sqlx::Describe<sqlx::MySql>, sqlx::Error> {
    use sqlx::Executor;
    conn.describe(AssertSqlSafe(sql).into_sql_str()).await
}
async fn describe_pg(conn: &mut sqlx::PgConnection, sql: &str)
    -> Result<sqlx::Describe<sqlx::Postgres>, sqlx::Error> {
    use sqlx::Executor;
    conn.describe(AssertSqlSafe(sql).into_sql_str()).await
}

/// Every output column with its exact datatype: the server PREPARES the
/// statement (`describe`, no execution, read-only) and reports per-column wire
/// type + nullability — ground truth for any preparable query. sqlparser adds
/// structure (statement kind, referenced tables) and honest parse status.
#[tauri::command]
pub async fn column_map(
    session_id: uuid::Uuid,
    sql: String,
    db: Option<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<ColumnMap, crate::apperror::AppError> {
    use sqlparser::ast::visit_relations;

    // AST side (never fatal — describe is the authority)
    let dialect_parse = |s: &str| {
        let session_hint = sqlparser::dialect::MySqlDialect {};
        sqlparser::parser::Parser::parse_sql(&session_hint, s)
    };
    let (parse_ok, parse_error, statement_kind, tables, eq_cols, range_cols, sources) = match dialect_parse(&sql) {
        Ok(stmts) => {
            let kind = stmts.first().map(|s| {
                let d = format!("{s:?}");
                d.split(|c: char| !c.is_alphanumeric()).next().unwrap_or("Statement").to_string()
            });
            let mut tabs: Vec<String> = Vec::new();
            let mut eqs: Vec<String> = Vec::new();
            let mut rngs: Vec<String> = Vec::new();
            let col_of = |e: &sqlparser::ast::Expr| -> Option<String> {
                match e {
                    sqlparser::ast::Expr::Identifier(id) => Some(id.value.to_lowercase()),
                    sqlparser::ast::Expr::CompoundIdentifier(parts) =>
                        parts.last().map(|p| p.value.to_lowercase()),
                    _ => None,
                }
            };
            let push = |v: &mut Vec<String>, c: Option<String>| {
                if let Some(c) = c { if !v.contains(&c) { v.push(c); } }
            };
            for s in &stmts {
                let _ = visit_relations(s, |rel| {
                    let name = rel.to_string();
                    if !tabs.contains(&name) { tabs.push(name); }
                    std::ops::ControlFlow::<()>::Continue(())
                });
                let _ = sqlparser::ast::visit_expressions(s, |e| {
                    use sqlparser::ast::{Expr, BinaryOperator as B};
                    match e {
                        Expr::BinaryOp { left, op, right } => match op {
                            B::Eq => {
                                push(&mut eqs, col_of(left));
                                push(&mut eqs, col_of(right));
                            }
                            B::Gt | B::Lt | B::GtEq | B::LtEq => {
                                push(&mut rngs, col_of(left));
                                push(&mut rngs, col_of(right));
                            }
                            _ => {}
                        },
                        Expr::InList { expr, .. } => push(&mut eqs, col_of(expr)),
                        Expr::Between { expr, .. } => push(&mut rngs, col_of(expr)),
                        _ => {}
                    }
                    std::ops::ControlFlow::<()>::Continue(())
                });
            }
            // eq wins when a column appears in both classes
            rngs.retain(|c| !eqs.contains(c));
            // SELECT-list source attribution: the exact expression text per item
            let mut srcs: Vec<String> = Vec::new();
            if let Some(sqlparser::ast::Statement::Query(q)) = stmts.first() {
                if let sqlparser::ast::SetExpr::Select(sel) = q.body.as_ref() {
                    let mut wildcard = false;
                    for item in &sel.projection {
                        use sqlparser::ast::SelectItem as SI;
                        match item {
                            SI::UnnamedExpr(e) => srcs.push(e.to_string()),
                            SI::ExprWithAlias { expr, .. } => srcs.push(expr.to_string()),
                            _ => { wildcard = true; } // wildcards + exotic items: no alignment
                        }
                    }
                    if wildcard { srcs.clear(); } // can't align without catalog expansion
                }
            }
            (true, None, kind, tabs, eqs, rngs, srcs)
        }
        Err(e) => (false, Some(e.to_string()), None, Vec::new(), Vec::new(), Vec::new(), Vec::new()),
    };

    let session = crate::db::connection::get_session_pub(session_id, &state.sessions)
        .await?;
    let columns = match session.as_ref() {
        crate::db::types::LiveSession::Mysql(pool) => {
            // A connection-level default DB may be absent — apply the resolved
            // db on a dedicated conn so unqualified table names prepare.
            let mut conn = pool.acquire().await?;
            if let Some(d) = db.as_deref().filter(|d| !d.is_empty()) {
                let _ = crate::db::mysql::execute(&mut *conn, &format!("USE `{}`", d.replace('`', "``"))).await;
            }
            let d = describe_my(&mut conn, &sql).await.map_err(|e| format!("describe failed: {e}"))?;
            d.columns().iter().enumerate().map(|(i, c)| {
                
                ColumnMapCol {
                    name: sqlx::Column::name(c).to_string(),
                    type_name: sqlx::TypeInfo::name(sqlx::Column::type_info(c)).to_string(),
                    nullable: d.nullable(i),
                }
            }).collect()
        }
        crate::db::types::LiveSession::Postgres(pool) => {
            let mut conn = pool.acquire().await?;
            if let Some(d) = db.as_deref().filter(|d| !d.is_empty()) {
                let _ = crate::db::postgres::execute(&mut *conn, &format!("SET search_path TO \"{}\"", d.replace('"', "\"\""))).await;
            }
            let d = describe_pg(&mut conn, &sql).await.map_err(|e| format!("describe failed: {e}"))?;
            d.columns().iter().enumerate().map(|(i, c)| ColumnMapCol {
                name: sqlx::Column::name(c).to_string(),
                type_name: sqlx::TypeInfo::name(sqlx::Column::type_info(c)).to_string(),
                nullable: d.nullable(i),
            }).collect()
        }
        crate::db::types::LiveSession::SqlServer(sess) => {
            // `sys.dm_exec_describe_first_result_set` is the best of the three
            // by some distance: it returns the DECLARED type with its length or
            // precision (`nvarchar(120)`, `decimal(10,2)`) where MySQL and
            // PostgreSQL's describe give a bare type name, and it does it
            // without executing the statement.
            //
            // `db` is ignored on purpose — the driver uses three-part names and
            // never issues USE, so switching the database context here would
            // desynchronise the session from every other panel sharing it.
            //
            // It does NOT raise on a statement it cannot describe: it returns a
            // row carrying `error_message` instead. Reading that as a column
            // would produce a "column map" whose one column is named NULL, so
            // the error is turned back into one.
            let lit = format!("N'{}'", sql.replace('\'', "''"));
            let probe = format!(
                "SELECT name, system_type_name, is_nullable, error_message \
                 FROM sys.dm_exec_describe_first_result_set({lit}, NULL, 0) \
                 ORDER BY column_ordinal");
            let r = crate::db::sqlserver::execute(sess, &probe).await
                .map_err(|e| format!("describe failed: {e}"))?;

            let cell = |row: &crate::db::types::Row, i: usize| -> Option<String> {
                match row.get(i) {
                    Some(serde_json::Value::String(v)) => Some(v.clone()),
                    Some(serde_json::Value::Null) | None => None,
                    Some(other) => Some(other.to_string()),
                }
            };
            if let Some(first) = r.rows.first() {
                if let Some(msg) = cell(first, 3) {
                    return Err(format!("describe failed: {msg}").into());
                }
            }
            r.rows.iter().map(|row| ColumnMapCol {
                name: cell(row, 0).unwrap_or_default(),
                type_name: cell(row, 1).unwrap_or_default(),
                // `is_nullable` is a bit; anything that is not a clear 0 stays
                // unknown rather than being guessed as NOT NULL.
                nullable: match row.get(2) {
                    Some(serde_json::Value::Bool(b)) => Some(*b),
                    Some(serde_json::Value::Number(n)) => Some(n.as_i64() != Some(0)),
                    Some(serde_json::Value::String(v)) => Some(v != "0"),
                    _ => None,
                },
            }).collect()
        }
        _ => return Err("column map is not supported for this engine".into()),
    };

    Ok(ColumnMap { parse_ok, parse_error, statement_kind, tables, columns, eq_cols, range_cols, sources })
}


/// The SQL Server column map, against a real server.
///
/// The value of this one is the *type detail* — a bare "nvarchar" would tell a
/// type audit nothing about whether a join key is 20 characters or 200 — so the
/// assertions are about lengths and precisions, not about the column names.
#[cfg(test)]
mod mssql_colmap_live_tests {
    use crate::db::sqlserver::{self, live_tests::live_session};

    async fn describe(sql: &str) -> Vec<(String, String, Option<String>)> {
        let Some(s) = live_session().await else { return Vec::new() };
        let lit = format!("N'{}'", sql.replace('\'', "''"));
        let probe = format!(
            "SELECT name, system_type_name, error_message \
             FROM sys.dm_exec_describe_first_result_set({lit}, NULL, 0) \
             ORDER BY column_ordinal");
        let r = sqlserver::execute(&s, &probe).await.expect("describe");
        r.rows.iter().map(|row| (
            row[0].as_str().unwrap_or("").to_string(),
            row[1].as_str().unwrap_or("").to_string(),
            row.get(2).and_then(|v| v.as_str()).map(|v| v.to_string()),
        )).collect()
    }

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn types_carry_their_length_and_precision() {
        let cols = describe(
            "SELECT c.id, c.name, SUM(o.total) AS spend \
             FROM sales.customers c JOIN sales.orders o ON o.customer_id = c.id \
             GROUP BY c.id, c.name").await;
        if cols.is_empty() {
            println!("no endpoint configured — see docs/MSSQL_DEV.md");
            return;
        }
        let types: Vec<&str> = cols.iter().map(|(_, t, _)| t.as_str()).collect();
        // A bare "nvarchar" would not tell a type audit whether a join key is
        // 20 characters or 200 — the length IS the finding.
        assert_eq!(types, vec!["int", "nvarchar(120)", "decimal(38,2)"], "{cols:?}");
    }

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn an_undescribable_statement_reports_an_error_rather_than_a_column() {
        let cols = describe("SELECT * FROM no_such_table_at_all").await;
        if cols.is_empty() { return }
        // The DMV does not RAISE — it returns a row whose `error_message` is
        // set and whose name is NULL. Read as a column that is a "column map"
        // with one column called nothing.
        assert!(cols.iter().any(|(_, _, e)| e.is_some()), "{cols:?}");
        assert!(cols[0].2.as_deref().unwrap_or("").contains("Invalid object name"), "{cols:?}");
    }

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn an_apostrophe_in_the_statement_survives_being_wrapped_in_one() {
        let cols = describe("SELECT 'it''s' AS x").await;
        if cols.is_empty() { return }
        assert_eq!(cols[0].0, "x");
        assert_eq!(cols[0].1, "varchar(4)");
    }
}

