//! Stored routine CRUD — list, fetch, save.
//!
//! The dangerous operation here is saving a MySQL routine. PostgreSQL has
//! `CREATE OR REPLACE FUNCTION`, which is atomic and transactional: if the new
//! body does not compile, nothing changed. MySQL has no equivalent for
//! routines — the only way to change one is `DROP` then `CREATE`, and DDL on
//! MySQL causes an implicit commit, so it cannot be wrapped in a transaction
//! and rolled back.
//!
//! That means a naive save has a window where a syntax error costs the user
//! their routine: the DROP succeeds, the CREATE fails, and the procedure that
//! existed a second ago is simply gone. `save_routine` therefore keeps the
//! original DDL in hand and restores it when the CREATE fails, reporting both
//! errors rather than only the second one.

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::{LiveSession, Row};
use crate::db::{mysql, postgres, sqlserver};
use crate::state::AppState;

/// One routine as it appears in the picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutineInfo {
    /// "procedure" | "function" | "trigger" | "event"
    pub kind: String,
    pub schema: String,
    pub name: String,
    /// Return type for functions, empty otherwise.
    pub returns: String,
    /// plpgsql / SQL — whatever the server reports.
    pub language: String,
    /// Comment / description, when the server keeps one.
    pub comment: String,
}

/// Everything the editor needs to open a routine.
#[derive(Debug, Clone, Serialize)]
pub struct RoutineSource {
    pub kind: String,
    pub schema: String,
    pub name: String,
    /// The full `CREATE …` text, exactly as the server rendered it.
    pub ddl: String,
}

/// What a save actually did, so the UI can report it honestly.
#[derive(Debug, Clone, Serialize)]
pub struct SaveOutcome {
    pub ok: bool,
    /// The statements that were executed, in order.
    pub executed: Vec<String>,
    /// Set when the create failed AND the original was put back.
    pub restored: bool,
    pub error: Option<String>,
}

fn q_my(s: &str) -> String {
    s.replace('`', "``")
}
/// A single-quoted SQL literal.
///
/// The db layer has no parameter binding, so catalog lookups have to embed the
/// schema and routine name. These come from the object explorer (the server
/// told us the names in the first place), but they are still escaped rather
/// than trusted: a name is user-creatable, and `information_schema` is exactly
/// the place where a crafted one would be worth someone's while.
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

/// Text of a cell, whatever JSON shape it arrived as.
fn cell(row: &Row, i: usize) -> String {
    match row.get(i) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// The catalog query behind `list_routines` on SQL Server.
///
/// Extracted so its shape is unit-testable and its execution is covered by a
/// live test: the column ORDER is load-bearing (the caller reads positionally),
/// and a query that only ever ran inside a Tauri command could not be pinned.
fn mssql_list_routines_sql(schema: &str) -> String {
    format!(
            "SELECT CASE o.type WHEN 'P' THEN 'procedure' \
                    WHEN 'TR' THEN 'trigger' ELSE 'function' END, \
             sch.name, o.name, \
             CASE WHEN o.type IN ('IF','TF') THEN 'TABLE' \
                  ELSE COALESCE((SELECT TYPE_NAME(p.user_type_id) FROM sys.parameters p \
                                 WHERE p.object_id = o.object_id AND p.parameter_id = 0), '') END, \
             'SQL', \
             CASE WHEN o.type = 'TR' THEN \
                    CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF ' ELSE 'AFTER ' END \
                    + STUFF((SELECT ', ' + te.type_desc FROM sys.trigger_events te \
                             WHERE te.object_id = o.object_id ORDER BY te.type \
                             FOR XML PATH(''), TYPE).value('.', 'nvarchar(200)'), 1, 2, '') \
                    + ' ON ' + OBJECT_NAME(tr.parent_id) \
                  ELSE COALESCE(CAST(ep.value AS nvarchar(400)), '') END \
             FROM sys.objects o \
             JOIN sys.schemas sch ON sch.schema_id = o.schema_id \
             LEFT JOIN sys.triggers tr ON tr.object_id = o.object_id \
             LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id \
                  AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description' \
             WHERE sch.name = {} AND o.type IN ('P','FN','IF','TF','TR') \
               AND o.is_ms_shipped = 0 \
             ORDER BY o.name",
        lit(schema))
}

/// The definition lookup behind `get_routine` on SQL Server.
///
/// `OBJECT_ID` takes a *string*, so the bracketed name is built first and then
/// escaped as a literal — two different quoting rules stacked, which is exactly
/// the shape that goes wrong silently. A `]` inside an identifier doubles; a
/// `'` inside the resulting string doubles too.
fn mssql_routine_def_sql(schema: &str, name: &str) -> String {
    let ident = format!("[{}].[{}]", schema.replace(']', "]]"), name.replace(']', "]]"));
    format!(
        "SELECT m.definition FROM sys.sql_modules m WHERE m.object_id = OBJECT_ID(N{})",
        lit(&ident))
}

/// List the routines of a schema.
///
/// Triggers and events are included for MySQL because the editor treats all
/// four as routines; PostgreSQL triggers are a different shape (a trigger
/// there *calls* a function) and are handled by editing the function.
#[tauri::command]
pub async fn list_routines(
    session_id: Uuid,
    schema: String,
    state: State<'_, AppState>,
) -> Result<Vec<RoutineInfo>, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;

    match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let mut out = Vec::new();

            let sql = format!(
                "SELECT ROUTINE_TYPE, ROUTINE_SCHEMA, ROUTINE_NAME, \
                 COALESCE(DTD_IDENTIFIER,''), COALESCE(ROUTINE_BODY,''), \
                 COALESCE(ROUTINE_COMMENT,'') \
                 FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = {} ORDER BY ROUTINE_NAME",
                lit(&schema));
            let mut conn = pool.acquire().await?;
            let res = mysql::execute(&mut *conn, &sql).await?;
            for r in &res.rows {
                let kind = cell(r, 0).to_lowercase();
                out.push(RoutineInfo {
                    kind: if kind == "procedure" { "procedure".into() } else { "function".into() },
                    schema: cell(r, 1),
                    name: cell(r, 2),
                    returns: cell(r, 3),
                    language: cell(r, 4),
                    comment: cell(r, 5),
                });
            }

            let trig = format!(
                "SELECT TRIGGER_SCHEMA, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, \
                 EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS \
                 WHERE TRIGGER_SCHEMA = {} ORDER BY TRIGGER_NAME",
                lit(&schema));
            if let Ok(res) = mysql::execute(&mut *conn, &trig).await {
                for r in &res.rows {
                    out.push(RoutineInfo {
                        kind: "trigger".into(),
                        schema: cell(r, 0),
                        name: cell(r, 1),
                        returns: String::new(),
                        language: "SQL".into(),
                        comment: format!("{} {} ON {}", cell(r, 2), cell(r, 3), cell(r, 4)),
                    });
                }
            }

            let ev = format!(
                "SELECT EVENT_SCHEMA, EVENT_NAME, COALESCE(STATUS,''), \
                 COALESCE(EVENT_COMMENT,'') FROM information_schema.EVENTS \
                 WHERE EVENT_SCHEMA = {} ORDER BY EVENT_NAME",
                lit(&schema));
            if let Ok(res) = mysql::execute(&mut *conn, &ev).await {
                for r in &res.rows {
                    out.push(RoutineInfo {
                        kind: "event".into(),
                        schema: cell(r, 0),
                        name: cell(r, 1),
                        returns: String::new(),
                        language: "SQL".into(),
                        comment: cell(r, 3),
                    });
                }
            }
            Ok(out)
        }

        LiveSession::Postgres(pool) => {
            // prokind: f = function, p = procedure, a/w = aggregate/window,
            // which are not editable as source and are excluded.
            let sql = "SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, \
                       n.nspname, p.proname, \
                       COALESCE(pg_get_function_result(p.oid), ''), \
                       COALESCE(l.lanname, ''), \
                       COALESCE(obj_description(p.oid, 'pg_proc'), '') \
                       FROM pg_proc p \
                       JOIN pg_namespace n ON n.oid = p.pronamespace \
                       LEFT JOIN pg_language l ON l.oid = p.prolang \
                       WHERE n.nspname = {} AND p.prokind IN ('f','p') \
                       ORDER BY p.proname";
            let sql = sql.replace("{}", &lit(&schema));
            let mut conn = pool.acquire().await?;
            let res = postgres::execute(&mut *conn, &sql).await?;
            Ok(res
                .rows
                .iter()
                .map(|r| RoutineInfo {
                    kind: cell(r, 0),
                    schema: cell(r, 1),
                    name: cell(r, 2),
                    returns: cell(r, 3),
                    language: cell(r, 4),
                    comment: cell(r, 5),
                })
                .collect())
        }

        LiveSession::SqlServer(s) => {
            // One query for all four editable module kinds. SQL Server has no
            // scheduled events (SQL Agent jobs are a server object, not a
            // schema one), so the kind list stops at three.
            //
            // `IF`/`TF` are inline and multi-statement table-valued functions:
            // their return "type" is a table, and sys.parameters has no row 0
            // for them, so the CASE says TABLE rather than leaving the column
            // blank and letting the editor render a function with no result.
            let sql = mssql_list_routines_sql(&schema);
            let res = sqlserver::execute(s, &sql).await?;
            Ok(res
                .rows
                .iter()
                .map(|r| RoutineInfo {
                    kind: cell(r, 0),
                    schema: cell(r, 1),
                    name: cell(r, 2),
                    returns: cell(r, 3),
                    language: cell(r, 4),
                    comment: cell(r, 5),
                })
                .collect())
        }

        _ => Err("stored routines are only available on MySQL, PostgreSQL and SQL Server".into()),
    }
}

/// Fetch one routine's full source.
#[tauri::command]
pub async fn get_routine(
    session_id: Uuid,
    schema: String,
    name: String,
    kind: String,
    table: Option<String>,
    state: State<'_, AppState>,
) -> Result<RoutineSource, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;

    let ddl = match session.as_ref() {
        LiveSession::Mysql(pool) => {
            let k = match kind.as_str() {
                "procedure" => "PROCEDURE",
                "function" => "FUNCTION",
                "trigger" => "TRIGGER",
                "event" => "EVENT",
                other => return Err(format!("unknown routine kind `{other}`").into()),
            };
            let stmt = format!("SHOW CREATE {k} `{}`.`{}`", q_my(&schema), q_my(&name));
            let mut conn = pool.acquire().await?;
            let res = mysql::execute(&mut *conn, &stmt).await?;
            // SHOW CREATE puts the definition in a differently-named column per
            // object kind ("Create Procedure", "SQL Original Statement", …), so
            // pick the longest cell rather than guessing the header.
            res.rows
                .first()
                .map(|r| {
                    (0..r.len())
                        .map(|i| cell(r, i))
                        .max_by_key(|c| c.len())
                        .unwrap_or_default()
                })
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("{kind} `{schema}`.`{name}` not found"))?
        }
        LiveSession::Postgres(pool) => {
            // A PostgreSQL trigger is not a routine (it lives in pg_trigger, not
            // pg_proc), so reconstruct it with pg_get_triggerdef — disambiguated
            // by its table when the caller knows it, since a trigger name is only
            // unique per table. Everything else is a function/procedure.
            let sql = if kind == "trigger" {
                format!(
                    "SELECT pg_get_triggerdef(t.oid, true) || ';' \
                     FROM pg_catalog.pg_trigger t \
                     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = {} AND t.tgname = {} AND NOT t.tgisinternal{}",
                    lit(&schema), lit(&name),
                    table.as_deref()
                        .map(|tb| format!(" AND c.relname = {}", lit(tb)))
                        .unwrap_or_default())
            } else {
                // Qualify by name only: an overloaded function needs its
                // signature, which the caller does not have yet. Ambiguity is
                // reported rather than silently resolved to whichever came first.
                format!(
                    "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
                     JOIN pg_namespace n ON n.oid = p.pronamespace \
                     WHERE n.nspname = {} AND p.proname = {} AND p.prokind IN ('f','p')",
                    lit(&schema), lit(&name))
            };
            let mut conn = pool.acquire().await?;
            let res = postgres::execute(&mut *conn, &sql).await?;
            let rows = &res.rows;
            if rows.len() > 1 {
                return Err(format!(
                    "`{schema}`.`{name}` is ambiguous ({} matches) — \
                     open it from the object explorer to pick one",
                    rows.len()
                ).into());
            }
            rows.first()
                .map(|r| cell(r, 0))
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("{kind} `{schema}`.`{name}` not found"))?
        }
        LiveSession::SqlServer(s) => {
            // sys.sql_modules keeps the ORIGINAL source text, byte for byte —
            // including the comments and the formatting the author wrote. That
            // is better than a reconstruction (MySQL's SHOW CREATE and PG's
            // pg_get_functiondef both re-render), and it is why the parser has
            // to skip leading comments to find the CREATE: a definition
            // legitimately starts with a banner comment.
            //
            // A trigger name is unique per schema in SQL Server, not per table,
            // so `table` is not needed to disambiguate it the way it is on
            // PostgreSQL. There is no overloading either, so one name is one
            // object and OBJECT_ID resolves it.
            let sql = mssql_routine_def_sql(&schema, &name);
            let res = sqlserver::execute(s, &sql).await?;
            res.rows
                .first()
                .map(|r| cell(r, 0))
                .filter(|d| !d.is_empty())
                // An encrypted module (WITH ENCRYPTION) has a NULL definition.
                // Reporting "not found" would send someone looking for an
                // object that is right there; say what actually happened.
                .ok_or_else(|| format!(
                    "{kind} `{schema}`.`{name}` has no readable definition — it does not \
                     exist, or it was created WITH ENCRYPTION, which withholds the source"))?
        }

        _ => return Err("stored routines are only available on MySQL, PostgreSQL and SQL Server".into()),
    };

    Ok(RoutineSource { kind, schema, name, ddl })
}

/// Create or replace a routine.
///
/// `drop_sql` is empty for PostgreSQL (`CREATE OR REPLACE` handles it) and
/// carries the `DROP …` for MySQL. `original_ddl` is the routine as it was
/// before the edit — the safety net described in the module docs.
#[tauri::command]
pub async fn save_routine(
    session_id: Uuid,
    drop_sql: String,
    create_sql: String,
    original_ddl: String,
    state: State<'_, AppState>,
) -> Result<SaveOutcome, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    let mut executed = Vec::new();

    match session.as_ref() {
        // SQL Server sits with PostgreSQL, not MySQL: `CREATE OR ALTER` (2016
        // SP1+) replaces the module in one statement, so a rejected definition
        // leaves the old one in place and there is nothing to restore.
        //
        // One caveat the restore-based path does not have, and the panel says
        // out loud: SQL Server defers *name* resolution. A body referencing a
        // table that does not exist is accepted by CREATE OR ALTER and fails at
        // execution time (Msg 208) — verified against 2022. Syntax is checked;
        // the objects it names are not. A successful save is therefore not the
        // same promise it is on PostgreSQL, and pretending otherwise would be
        // the more expensive kind of wrong.
        LiveSession::Postgres(_) | LiveSession::SqlServer(_) => {
            // Atomic: a failed CREATE OR REPLACE / OR ALTER leaves the old
            // definition.
            match state.run_guarded(&session_id, &create_sql).await {
                Ok(_) => {
                    executed.push(create_sql);
                    Ok(SaveOutcome { ok: true, executed, restored: false, error: None })
                }
                Err(e) => Ok(SaveOutcome {
                    ok: false,
                    executed,
                    restored: false,
                    error: Some(e.display()),
                }),
            }
        }

        LiveSession::Mysql(_) => {
            // A DDL statement on MySQL implicitly commits, so there is no
            // transaction to roll back — the restore below IS the safety net.
            // Each statement goes through the guarded path: DDL is not session
            // state, so it does not need one shared connection to be correct.
            if !drop_sql.trim().is_empty() {
                if let Err(e) = state.run_guarded(&session_id, &drop_sql).await {
                    return Ok(SaveOutcome {
                        ok: false,
                        executed,
                        restored: false,
                        error: Some(format!("drop failed, nothing changed: {e}")),
                    });
                }
                executed.push(drop_sql);
            }

            match state.run_guarded(&session_id, &create_sql).await {
                Ok(_) => {
                    executed.push(create_sql);
                    Ok(SaveOutcome { ok: true, executed, restored: false, error: None })
                }
                Err(create_err) => {
                    // The routine is gone and the replacement did not compile.
                    // Put the original back before reporting anything.
                    let mut restored = false;
                    let mut detail = create_err.display();
                    if !original_ddl.trim().is_empty() {
                        // Deliberately NOT guarded: this is TxUI putting back
                        // what it just removed. A prod border that blocks the
                        // restore after allowing the drop leaves the user
                        // strictly worse off than if nothing had run.
                        match state.run_unguarded_restore(&session_id, &original_ddl).await {
                            Ok(_) => {
                                restored = true;
                                executed.push("-- restored the original".into());
                            }
                            Err(restore_err) => {
                                detail = format!(
                                    "{detail}\n\nTHE ORIGINAL COULD NOT BE RESTORED: {restore_err}\n\
                                     The routine no longer exists on the server. Its previous \
                                     definition is below — re-create it manually:\n\n{original_ddl}"
                                );
                            }
                        }
                    }
                    Ok(SaveOutcome { ok: false, executed, restored, error: Some(detail) })
                }
            }
        }

        _ => Err("stored routines are only available on MySQL, PostgreSQL and SQL Server".into()),
    }
}

/// Drop a routine outright.
#[tauri::command]
pub async fn drop_routine(
    session_id: Uuid,
    drop_sql: String,
    state: State<'_, AppState>,
) -> Result<(), crate::apperror::AppError> {
    // `drop_sql` arrives from the frontend, so this is "run arbitrary SQL"
    // with a narrower name. It used to acquire a pooled connection directly,
    // which meant the read-only check and the prod border — the thing between
    // a user and DROP PROCEDURE on production — never ran for it.
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    if !matches!(
        session.as_ref(),
        LiveSession::Mysql(_) | LiveSession::Postgres(_) | LiveSession::SqlServer(_)
    ) {
        return Err("stored routines are only available on MySQL, PostgreSQL and SQL Server".into());
    }
    state.run_guarded(&session_id, &drop_sql).await?;
    Ok(())
}

/// Live coverage for the two SQL Server catalog queries.
///
/// The `#[cfg(test)]` unit tests above pin their *shape*; only a real server
/// proves they parse and return what the caller reads. Skipped, not failed,
/// when no endpoint is configured — see docs/MSSQL_DEV.md.
#[cfg(test)]
mod mssql_live_tests {
    use super::*;
    use crate::db::sqlserver;

    // The same endpoint resolution the db-layer live tests use, so there is
    // one set of environment variables to know about, not two.
    use crate::db::sqlserver::live_tests::live_session;

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn list_and_read_the_fixture_routines() {
        let Some(s) = live_session().await else {
            println!("no endpoint configured — see docs/MSSQL_DEV.md");
            return;
        };

        let res = sqlserver::execute(&s, &mssql_list_routines_sql("sales"))
            .await.expect("list routines");
        let names: Vec<(String, String, String)> = res.rows.iter()
            .map(|r| (cell(r, 0), cell(r, 2), cell(r, 3)))
            .collect();

        // The fixture has one of each editable kind.
        assert!(names.iter().any(|(k, n, _)| k == "procedure" && n == "usp_close_orders"),
                "{names:?}");
        assert!(names.iter().any(|(k, n, _)| k == "trigger" && n == "trg_orders_audit"),
                "{names:?}");
        // A scalar function reports its real return type…
        assert!(names.iter().any(|(_, n, r)| n == "fn_order_total_with_vat" && r == "decimal"),
                "{names:?}");
        // …and a table-valued one reports TABLE rather than nothing, which is
        // the case sys.parameters has no row for.
        assert!(names.iter().any(|(_, n, r)| n == "tvf_orders_for_customer" && r == "TABLE"),
                "{names:?}");
        // The trigger's comment carries timing, events and table.
        let trig = res.rows.iter().find(|r| cell(r, 2) == "trg_orders_audit").unwrap();
        assert_eq!(cell(trig, 5), "AFTER INSERT ON orders");

        // sys.sql_modules returns the ORIGINAL text — banner comment included,
        // which is why the TS parser has to skip leading trivia.
        let def = sqlserver::execute(&s, &mssql_routine_def_sql("sales", "usp_close_orders"))
            .await.expect("read definition");
        let ddl = cell(&def.rows[0], 0);
        assert!(ddl.contains("CREATE PROCEDURE sales.usp_close_orders"), "{ddl}");
        assert!(ddl.contains("@closed          int OUTPUT"), "{ddl}");
        assert!(ddl.trim_start().starts_with("--"),
                "the fixture's banner comment should survive verbatim: {ddl}");

        // A name that does not exist comes back empty, not as an error — the
        // caller turns that into the "no readable definition" message.
        let none = sqlserver::execute(&s, &mssql_routine_def_sql("sales", "no_such_thing"))
            .await.expect("missing routine query still runs");
        assert!(none.rows.is_empty() || cell(&none.rows[0], 0).is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mssql_list_query_returns_the_six_columns_the_caller_reads() {
        let sql = mssql_list_routines_sql("sales");
        // The caller maps cells 0..5 positionally, so this order IS the API.
        assert!(sql.contains("'procedure'"), "{sql}");
        assert!(sql.contains("'trigger'"), "{sql}");
        assert!(sql.contains("sys.trigger_events"), "{sql}");
        // Four editable module kinds, no scheduled events — SQL Server has none
        // at schema level.
        assert!(sql.contains("o.type IN ('P','FN','IF','TF','TR')"), "{sql}");
        assert!(!sql.contains("EVENT"), "{sql}");
        // A table-valued function has no sys.parameters row 0.
        assert!(sql.contains("o.type IN ('IF','TF') THEN 'TABLE'"), "{sql}");
        assert!(sql.contains("WHERE sch.name = 'sales'"), "{sql}");
    }

    #[test]
    fn mssql_list_query_escapes_the_schema_name() {
        let sql = mssql_list_routines_sql("it's");
        assert!(sql.contains("sch.name = 'it''s'"), "{sql}");
    }

    #[test]
    fn mssql_definition_lookup_stacks_both_quoting_rules() {
        // OBJECT_ID takes a string, so an identifier is bracketed and then the
        // whole thing is escaped as a literal. Getting one of the two right is
        // not enough.
        assert_eq!(
            mssql_routine_def_sql("sales", "usp_close_orders"),
            "SELECT m.definition FROM sys.sql_modules m \
             WHERE m.object_id = OBJECT_ID(N'[sales].[usp_close_orders]')"
                .replace("             ", " ")
                .replace(" \\\n", "")
        );
        let odd = mssql_routine_def_sql("dbo", "we]ird");
        // `]` doubles inside the brackets, or the identifier ends early.
        assert!(odd.contains("[we]]ird]"), "{odd}");
        let quoted = mssql_routine_def_sql("dbo", "it's");
        assert!(quoted.contains("[it''s]"), "{quoted}");
    }

    #[test]
    fn backtick_identifiers_are_escaped() {
        // PostgreSQL identifiers never reach here: the frontend builds that DDL
        // via routineDdl.quoteIdent, so only MySQL's SHOW CREATE needs quoting.
        assert_eq!(q_my("a`b"), "a``b");
        assert_eq!(q_my("plain"), "plain");
    }

    #[test]
    fn literals_close_the_quote_they_open() {
        assert_eq!(lit("plain"), "'plain'");
        assert_eq!(lit("it's"), "'it''s'");
        // A backslash must not escape the closing quote on MySQL.
        assert_eq!(lit("a\\"), "'a\\\\'");
    }

    #[test]
    fn cells_survive_every_json_shape() {
        let row: Row = vec![
            serde_json::Value::String("text".into()),
            serde_json::Value::Null,
            serde_json::json!(42),
        ];
        assert_eq!(cell(&row, 0), "text");
        assert_eq!(cell(&row, 1), "");
        assert_eq!(cell(&row, 2), "42");
        assert_eq!(cell(&row, 9), "", "out of range must not panic");
    }
}

/// One recorded debug run.
#[derive(Debug, Clone, Serialize)]
pub struct DebugRun {
    /// Raw trace rows, each a JSON object — parsed by utils/plpgsqlInstrument.
    pub steps: Vec<serde_json::Value>,
    /// Set when the run could not be executed at all (as opposed to the
    /// routine itself raising, which is recorded as a step).
    pub error: Option<String>,
}

/// Run an instrumented routine and return its recorded timeline.
///
/// The three statements come from `utils/plpgsqlInstrument`. They run inside a
/// transaction that is **always** rolled back, so the routine's writes are
/// undone while the timeline — read before the rollback — survives. Nothing is
/// created on the server: the block is anonymous and the trace sink is a temp
/// table that dies with the transaction.
///
/// The rollback is issued in every path, including when the block fails to
/// compile. Leaving a transaction open on a pooled connection would strand it
/// holding locks for the rest of the session.
#[tauri::command]
pub async fn debug_routine(
    session_id: Uuid,
    setup_sql: String,
    block_sql: String,
    select_sql: String,
    state: State<'_, AppState>,
) -> Result<DebugRun, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;

    let LiveSession::Postgres(pool) = session.as_ref() else {
        return Err("stepping through a routine is PostgreSQL-only for now".into());
    };
    let mut conn = pool.acquire().await?;

    // Everything from here on must reach the ROLLBACK.
    postgres::execute(&mut *conn, "BEGIN")
        .await
        ?;

    let outcome = async {
        postgres::execute(&mut *conn, &setup_sql).await?;
        // A failure here is the routine failing to COMPILE. The routine
        // raising at run time is caught inside the block and comes back as a
        // trace step instead, which is the whole point of the exercise.
        postgres::execute(&mut *conn, &block_sql).await?;
        postgres::execute(&mut *conn, &select_sql).await
    }
    .await;

    let rollback = postgres::execute(&mut *conn, "ROLLBACK").await;

    match outcome {
        Ok(res) => {
            let steps = res
                .rows
                .iter()
                .filter_map(|r| r.first().cloned())
                .collect::<Vec<_>>();
            // A rollback that fails leaves the connection in an unknown state,
            // which matters more than the result we just collected.
            if let Err(e) = rollback {
                return Ok(DebugRun {
                    steps,
                    error: Some(format!(
                        "the debug run completed but its transaction could not be \
                         rolled back: {e}"
                    )),
                });
            }
            Ok(DebugRun { steps, error: None })
        }
        Err(e) => Ok(DebugRun { steps: Vec::new(), error: Some(e.to_string()) }),
    }
}

/// The statements of one MySQL debug run, generated by the frontend with
/// `utils/mysqlInstrument.instrumentMysqlRoutine` — Rust cannot call the
/// TypeScript, so the instrumenter's `parts` cross the IPC boundary as-is.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlDebugParts {
    /// The nominated scratch schema — created if missing, and that creation
    /// is reported back so the frontend can audit-log it.
    pub scratch_schema: String,
    /// Trace table + stale-copy drop, before the CREATE.
    pub setup_sql: Vec<String>,
    /// The instrumented copy (CREATE PROCEDURE/FUNCTION).
    pub create_sql: String,
    /// Counter init, OUT/INOUT binding, the CALL, truncation + OUT capture.
    pub run_sql: Vec<String>,
    /// Reads the timeline — the statement whose rows are kept.
    pub select_sql: String,
    /// Drop the copy, delete this run's trace rows — run on every path.
    pub cleanup_sql: Vec<String>,
    /// Crash-sweep: find leftover copies, purge old trace rows.
    pub sweep_sql: Vec<String>,
}

/// One recorded MySQL debug run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRunMysql {
    /// Trace rows as JSON objects keyed by column name (`seq`, `line`, `var`,
    /// `val`) — parsed by utils/mysqlInstrument.parseMysqlTrace.
    pub steps: Vec<serde_json::Value>,
    /// Set when the run could not be executed at all (setup/create/select
    /// failed, or cleanup failed). The routine RAISING is not this — see
    /// `run_error`.
    pub error: Option<String>,
    /// The CALL (or function SELECT) itself failed. That is the expected shape
    /// of a routine that raises: the instrumented copy's EXIT HANDLER records
    /// the error as trace rows and then RESIGNALs, so the timeline carries the
    /// details and this field is the transport-level echo of it.
    pub run_error: Option<String>,
    /// True when the scratch schema did not exist and this run created it —
    /// the frontend audit-logs that creation.
    pub schema_created: bool,
    /// The DROP statements the crash-sweep issued for leftover copies.
    pub swept: Vec<String>,
}

/// The debug gate: who may run an instrumented copy at all.
///
/// Unlike `run_guarded`'s per-statement judgement this is decided up front,
/// because the flow is a dozen statements that must all pass or none should
/// start. Two refusals, both by session rather than by statement:
///
/// - **prod is disabled outright** (docs/ROUTINE_DEBUGGER.md §3 — the
///   destructive-DDL opt-out is explicitly NOT a sufficient signal here);
/// - **read-only refuses** — instrumentation CREATEs and DROPs a copy and
///   writes trace rows; "read-only" means the session cannot change server
///   state, and the driver-level enforcement only covers pooled connections
///   the app sets up, not a user with out-of-band grants.
///
/// An unknown session guard is allowed, matching the privileges doctrine
/// (unknown means allowed): the session lookup in the command is the real
/// existence check.
pub fn mysql_debug_gate(guard: Option<&crate::state::SessionGuard>) -> Result<(), crate::apperror::AppError> {
    let Some(g) = guard else { return Ok(()) };
    if g.environment.as_deref() == Some("prod") {
        return Err(crate::apperror::AppError::guard(
            "debugging is disabled on production connections — it creates an \
             instrumented copy of the routine on the server and executes it"));
    }
    if g.read_only {
        return Err(crate::apperror::AppError::guard(
            "connection is read-only — debugging creates and runs an \
             instrumented copy, which is a write"));
    }
    Ok(())
}

/// The instrumented debug run, on ONE pinned connection.
///
/// The statements come from `utils/mysqlInstrument.instrumentMysqlRoutine`
/// (the frontend generates them; Rust cannot call the TypeScript), and they
/// share session state: the step counter and the OUT/INOUT bindings are user
/// variables (`@__txui_dbg_*`), which are connection-scoped — pooling across
/// statements would reset the counter mid-run and lose the OUT values. The
/// caller acquires one pooled connection and everything below runs on it.
///
/// Order: scratch schema (created if missing) → crash-sweep of leftover
/// `__txui_dbg_%` copies → setup → create → run (a failing CALL is the
/// routine raising and is recorded, not fatal) → select the trace → cleanup,
/// which runs on EVERY path, including a create that failed to compile.
///
/// MariaDB note: everything emitted by the instrumenter is portable to
/// MariaDB 10.x — `information_schema.ROUTINES` has the same shape, and
/// `RESIGNAL` / `GET DIAGNOSTICS` / user variables behave identically. The
/// one spelling difference (`BEGIN NOT ATOMIC`) is handled by the
/// instrumenter's walker, not by anything here.
async fn run_mysql_debug(
    conn: &mut sqlx::MySqlConnection,
    parts: &MysqlDebugParts,
) -> Result<DebugRunMysql, crate::apperror::AppError> {
    let mut out = DebugRunMysql {
        steps: Vec::new(), error: None, run_error: None,
        schema_created: false, swept: Vec::new(),
    };

    // The scratch schema is nominated per connection; creating it when missing
    // is part of the run (and audit-logged by the caller when it happened).
    let create_schema =
        format!("CREATE DATABASE IF NOT EXISTS `{}`", q_my(&parts.scratch_schema));
    let r = mysql::execute(&mut *conn, &create_schema).await?;
    out.schema_created = r.rows_affected.unwrap_or(0) > 0;

    // Crash-sweep: a copy left behind by a killed app run is found in
    // information_schema and dropped before this run creates its own. The
    // SELECT and the per-row DROP text come from the instrumenter's sweep
    // parts; the DROPs are built here so the identifiers are quoted by us.
    if let Some(find) = parts.sweep_sql.first() {
        if let Ok(res) = mysql::execute(&mut *conn, find).await {
            for row in &res.rows {
                let kind = cell(row, 0).to_uppercase();
                if kind != "PROCEDURE" && kind != "FUNCTION" { continue; }
                let drop = format!(
                    "DROP {kind} IF EXISTS `{}`.`{}`",
                    q_my(&cell(row, 1)), q_my(&cell(row, 2)));
                if mysql::execute(&mut *conn, &drop).await.is_ok() {
                    out.swept.push(drop);
                }
            }
        }
    }

    let outcome = async {
        for s in &parts.setup_sql {
            mysql::execute(&mut *conn, s).await?;
        }
        // Purge day-old trace rows — only now that setup guarantees the trace
        // table exists. Housekeeping, never fatal to the run itself.
        if let Some(purge) = parts.sweep_sql.get(1) {
            let _ = mysql::execute(&mut *conn, purge).await;
        }
        // A failure here is the copy failing to COMPILE — fatal to the run,
        // reported as `error`, exactly like the PG block failing to compile.
        mysql::execute(&mut *conn, &parts.create_sql).await?;
        // The routine raising is the expected case: its EXIT HANDLER writes
        // the error rows and RESIGNALs, so the CALL fails. Record it and still
        // read the trace — a failing run must stay debuggable.
        let mut run_error = None;
        for s in &parts.run_sql {
            if let Err(e) = mysql::execute(&mut *conn, s).await {
                run_error = Some(e.to_string());
                break;
            }
        }
        let res = mysql::execute(&mut *conn, &parts.select_sql).await?;
        Ok::<_, crate::apperror::AppError>((res, run_error))
    }
    .await;

    match outcome {
        Ok((res, run_error)) => {
            // parseMysqlTrace reads rows by NAME, so zip the columns in.
            out.steps = res.rows.iter().map(|r| {
                let mut m = serde_json::Map::with_capacity(res.columns.len());
                for (i, c) in res.columns.iter().enumerate() {
                    m.insert(c.name.clone(),
                        r.get(i).cloned().unwrap_or(serde_json::Value::Null));
                }
                serde_json::Value::Object(m)
            }).collect();
            out.run_error = run_error;
        }
        Err(e) => out.error = Some(e.display()),
    }

    // Cleanup on every path — the copy is a real object and must not survive
    // the run, whatever happened above. A cleanup failure is reported with
    // (not instead of) the run's own outcome.
    let mut cleanup_err: Option<String> = None;
    for s in &parts.cleanup_sql {
        if let Err(e) = mysql::execute(&mut *conn, s).await {
            let msg = e.to_string();
            cleanup_err = Some(match cleanup_err {
                Some(prev) => format!("{prev}; {msg}"),
                None => msg,
            });
        }
    }
    if let Some(ce) = cleanup_err {
        out.error = Some(match out.error.take() {
            Some(prev) => format!("{prev}\n\ncleanup also failed: {ce}"),
            None => format!(
                "the debug run completed but its cleanup failed — the \
                 instrumented copy may still exist: {ce}"),
        });
    }
    Ok(out)
}

/// Run an instrumented MySQL routine and return its recorded timeline.
///
/// The MySQL sibling of `debug_routine`: the frontend generates the
/// statements with `utils/mysqlInstrument` and passes the parts; this command
/// is deliberately a thin, gated, pinned-connection runner — all parsing and
/// rewriting stays in the unit-tested TypeScript.
///
/// Where the PG run rolls a transaction back, MySQL cannot (DDL implicitly
/// commits, and the copy is a real object): the copy's writes COMMIT, which
/// is exactly why the gate above refuses prod outright rather than leaning on
/// the per-statement prod limits.
#[tauri::command]
pub async fn debug_routine_mysql(
    session_id: Uuid,
    parts: MysqlDebugParts,
    state: State<'_, AppState>,
) -> Result<DebugRunMysql, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    let LiveSession::Mysql(pool) = session.as_ref() else {
        return Err("the instrumented MySQL debugger needs a MySQL/MariaDB session".into());
    };
    let guard = state.session_meta.read().await.get(&session_id).cloned();
    mysql_debug_gate(guard.as_ref())?;

    let mut conn = pool.acquire().await?;
    run_mysql_debug(&mut conn, &parts).await
}

#[cfg(test)]
mod mysql_debug_tests {
    use super::*;
    use crate::db::types::Engine;
    use crate::state::SessionGuard;

    fn guard(env: Option<&str>, read_only: bool) -> SessionGuard {
        SessionGuard {
            read_only,
            engine: Engine::Mysql,
            environment: env.map(str::to_string),
            log_dir: None,
            prod_allow_ddl: false,
            prod_allow_unfiltered_write: false,
            autocommit: true,
            query_timeout_secs: None,
        }
    }

    #[test]
    fn prod_is_refused_outright() {
        // Not gated behind the destructive-DDL opt-out — the design says
        // "disabled outright", and an opt-in here would re-admit exactly what
        // the safety model exists to keep off production.
        let mut g = guard(Some("prod"), false);
        assert!(mysql_debug_gate(Some(&g)).is_err());
        g.prod_allow_ddl = true;
        assert!(mysql_debug_gate(Some(&g)).is_err(),
            "the DDL opt-out must NOT unlock debugging on prod");
    }

    #[test]
    fn read_only_is_refused() {
        let e = mysql_debug_gate(Some(&guard(None, true))).unwrap_err();
        assert!(e.display().contains("read-only"), "{e:?}");
    }

    #[test]
    fn dev_and_unknown_sessions_pass() {
        assert!(mysql_debug_gate(Some(&guard(None, false))).is_ok());
        assert!(mysql_debug_gate(Some(&guard(Some("staging"), false))).is_ok());
        // Unknown guard → allowed (the session lookup is the existence check).
        assert!(mysql_debug_gate(None).is_ok());
    }

    // ── live runner mechanics, against a real MySQL ─────────────────────────
    //
    // Gated like the ClickHouse fleet: `#[ignore]`d AND skipped unless the
    // password env is set, so a machine without a server stays green.
    //
    //   TXUI_MY_PASSWORD=root TXUI_MY_PORT=3307 \
    //     cargo test --lib mysql_debug_live -- --ignored --nocapture
    //
    // The parts below are hand-written in the SHAPE utils/mysqlInstrument
    // emits (same trace table, same session-variable counter, same handler)
    // but deliberately minimal: what this pins is the runner — one pinned
    // connection (the counter would be NULL on any other connection), a
    // raising CALL reported as run_error with the trace still read back, and
    // cleanup that runs on every path. Whether the GENERATED SQL is correct
    // against a real server is dev/probe_mysql_debugger.mjs's job.

    async fn live_pool() -> Option<sqlx::MySqlPool> {
        let password = std::env::var("TXUI_MY_PASSWORD").ok()?;
        let mut c = crate::db::types::ConnectionConfig::new(Engine::Mysql, "my-debug-live");
        c.host = Some(std::env::var("TXUI_MY_HOST").unwrap_or_else(|_| "127.0.0.1".into()));
        c.port = Some(std::env::var("TXUI_MY_PORT").ok()?.parse().ok()?);
        c.user = Some(std::env::var("TXUI_MY_USER").unwrap_or_else(|_| "root".into()));
        Some(crate::db::mysql::open_pool(&c, Some(password), None, 2).await.expect("open pool"))
    }

    const SCRATCH: &str = "txui_debug_test";
    const TABLE: &str = "`txui_debug_test`.`__txui_trace`";
    const COPY: &str = "`txui_debug_test`.`__txui_dbg_probe`";

    fn parts(call_arg: &str) -> MysqlDebugParts {
        let setup_sql = vec![
            format!("CREATE TABLE IF NOT EXISTS {TABLE} (\n\
                     \x20 run VARCHAR(64) NOT NULL,\n\
                     \x20 seq INT UNSIGNED NOT NULL,\n\
                     \x20 line INT NOT NULL,\n\
                     \x20 var VARCHAR(128) NOT NULL,\n\
                     \x20 val LONGTEXT NULL,\n\
                     \x20 ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\
                     \x20 PRIMARY KEY (run, seq, var))"),
            format!("DROP PROCEDURE IF EXISTS {COPY}"),
        ];
        let create_sql = format!(
            "CREATE PROCEDURE {COPY}(IN p_n INT)\nBEGIN\n\
             \x20 DECLARE EXIT HANDLER FOR SQLEXCEPTION\n\
             \x20 BEGIN\n\
             \x20   GET DIAGNOSTICS CONDITION 1\n\
             \x20     @__txui_dbg_sqlstate = RETURNED_SQLSTATE,\n\
             \x20     @__txui_dbg_errno = MYSQL_ERRNO,\n\
             \x20     @__txui_dbg_errmsg = MESSAGE_TEXT;\n\
             \x20   INSERT INTO {TABLE} (run, seq, line, var, val) VALUES\n\
             \x20     ('rustlive', @__txui_dbg_seq + 1, -1, '__txui_error', @__txui_dbg_errmsg),\n\
             \x20     ('rustlive', @__txui_dbg_seq + 1, -1, '__txui_sqlstate', @__txui_dbg_sqlstate);\n\
             \x20   RESIGNAL;\n\
             \x20 END;\n\
             \x20 IF @__txui_dbg_seq < 100 THEN\n\
             \x20   SET @__txui_dbg_seq = @__txui_dbg_seq + 1;\n\
             \x20   INSERT INTO {TABLE} (run, seq, line, var, val) VALUES\n\
             \x20     ('rustlive', @__txui_dbg_seq, 0, 'p_n', CAST(p_n AS CHAR));\n\
             \x20 END IF;\n\
             \x20 SET @__txui_dbg_seq = @__txui_dbg_seq + 1;\n\
             \x20 INSERT INTO {TABLE} (run, seq, line, var, val) VALUES\n\
             \x20   ('rustlive', @__txui_dbg_seq, 2, '__txui_step', NULL);\n\
             \x20 IF p_n < 0 THEN\n\
             \x20   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'negative input';\n\
             \x20 END IF;\n\
             END");
        let run_sql = vec![
            "SET @__txui_dbg_seq = 0".to_string(),
            format!("CALL {COPY}({call_arg})"),
        ];
        let select_sql = format!(
            "SELECT seq, line, var, val FROM {TABLE} WHERE run = 'rustlive' ORDER BY seq, var");
        let cleanup_sql = vec![
            format!("DROP PROCEDURE IF EXISTS {COPY}"),
            format!("DELETE FROM {TABLE} WHERE run = 'rustlive'"),
        ];
        let sweep_sql = vec![
            "SELECT ROUTINE_TYPE, ROUTINE_SCHEMA, ROUTINE_NAME FROM information_schema.ROUTINES \
             WHERE ROUTINE_NAME LIKE '\\_\\_txui\\_dbg\\_%'".to_string(),
            format!("DELETE FROM {TABLE} WHERE ts < NOW() - INTERVAL 1 DAY"),
        ];
        MysqlDebugParts {
            scratch_schema: SCRATCH.to_string(),
            setup_sql, create_sql, run_sql, select_sql, cleanup_sql, sweep_sql,
        }
    }

    async fn leftover_copies(pool: &sqlx::MySqlPool) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = 'txui_debug_test' AND ROUTINE_NAME LIKE '\\_\\_txui\\_dbg\\_%'")
            .fetch_one(pool).await.unwrap()
    }

    #[tokio::test]
    #[ignore = "needs TXUI_MY_PASSWORD/TXUI_MY_PORT and a live MySQL"]
    async fn mysql_debug_live_happy_error_and_cleanup() {
        let Some(pool) = live_pool().await else {
            println!("TXUI_MY_PASSWORD unset — skipping live runner test");
            return;
        };
        // Clean slate, then prove the pinned-connection run works end to end.
        {
            let mut c = pool.acquire().await.unwrap();
            mysql::execute(&mut *c, &format!("DROP PROCEDURE IF EXISTS {COPY}")).await.unwrap();
        }

        // Happy path: counter crosses statements on the pinned connection —
        // p_n is traced at seq 1 and the sentinel step at seq 2, which is only
        // possible if SET and CALL shared one connection.
        {
            let mut conn = pool.acquire().await.unwrap();
            let out = run_mysql_debug(&mut conn, &parts("7")).await.unwrap();
            assert!(out.error.is_none(), "run error: {:?}", out.error);
            assert!(out.run_error.is_none(), "run_error: {:?}", out.run_error);
            let has = |var: &str, val: &str| out.steps.iter().any(|s|
                s["var"] == serde_json::json!(var) && s["val"] == serde_json::json!(val));
            assert!(has("p_n", "7"), "entry trace row missing: {:?}", out.steps);
            assert!(out.steps.iter().any(|s| s["var"] == serde_json::json!("__txui_step")
                && s["seq"] == serde_json::json!(2)), "step 2 missing: {:?}", out.steps);
        }
        assert_eq!(leftover_copies(&pool).await, 0, "cleanup left the copy behind");

        // Error path: the routine raises; the CALL fails (run_error) but the
        // handler's trace rows were still read back, and cleanup still ran.
        {
            let mut conn = pool.acquire().await.unwrap();
            let out = run_mysql_debug(&mut conn, &parts("-1")).await.unwrap();
            assert!(out.error.is_none(), "a raising routine is not a run error: {:?}", out.error);
            assert!(out.run_error.is_some(), "the RESIGNAL must fail the CALL");
            assert!(out.steps.iter().any(|s| s["var"] == serde_json::json!("__txui_error")
                && s["val"] == serde_json::json!("negative input")),
                "error row missing: {:?}", out.steps);
            assert!(out.steps.iter().any(|s| s["var"] == serde_json::json!("__txui_sqlstate")
                && s["val"] == serde_json::json!("45000")), "sqlstate row missing");
        }
        assert_eq!(leftover_copies(&pool).await, 0, "cleanup left the copy behind after a raise");

        // Compile-fail path: create is rejected, error is set, no steps — and
        // the cleanup still ran rather than stranding a half-made copy.
        {
            let mut p = parts("1");
            p.create_sql = format!("CREATE PROCEDURE {COPY}() BEGIN THIS IS NOT SQL; END");
            let mut conn = pool.acquire().await.unwrap();
            let out = run_mysql_debug(&mut conn, &p).await.unwrap();
            assert!(out.error.is_some(), "a broken create must surface as error");
            assert!(out.steps.is_empty());
        }
        assert_eq!(leftover_copies(&pool).await, 0);

        // Sweep: plant a leftover copy and an aged trace row, then a run must
        // drop the copy (reported in `swept`) and purge the old row.
        {
            let mut c = pool.acquire().await.unwrap();
            mysql::execute(&mut *c, &format!(
                "CREATE PROCEDURE `txui_debug_test`.`__txui_dbg_leftover`() BEGIN END")).await.unwrap();
            mysql::execute(&mut *c, &format!(
                "INSERT INTO {TABLE} (run, seq, line, var, val, ts) VALUES \
                 ('ancient', 1, 1, '__txui_step', NULL, NOW() - INTERVAL 2 DAY)")).await.unwrap();
        }
        {
            let mut conn = pool.acquire().await.unwrap();
            let out = run_mysql_debug(&mut conn, &parts("3")).await.unwrap();
            assert!(out.error.is_none(), "{:?}", out.error);
            assert!(out.swept.iter().any(|d| d.contains("__txui_dbg_leftover")),
                "sweep did not drop the planted leftover: {:?}", out.swept);
        }
        let aged: i64 = sqlx::query_scalar(
            sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {TABLE} WHERE run = 'ancient'")))
            .fetch_one(&pool).await.unwrap();
        assert_eq!(aged, 0, "the day-old trace row must be purged");
        assert_eq!(leftover_copies(&pool).await, 0);
        pool.close().await;
    }
}
