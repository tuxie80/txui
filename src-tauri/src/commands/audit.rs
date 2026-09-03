/// Audit log — one immutable row per executed statement, for proofs:
/// precise start/end timestamps, duration, connected DB user, outcome.
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;

use crate::state::AppState;

fn default_source() -> String {
    "editor".into()
}

#[derive(Debug, Deserialize)]
pub struct AuditInsert {
    /// Groups the statements of one Run into a single unit.
    #[serde(default)]
    pub run_id: String,
    /// 1-based position within that run, when it had more than one statement.
    #[serde(default)]
    pub stmt_index: Option<i64>,
    #[serde(default)]
    pub stmt_total: Option<i64>,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub tab_title: String,
    /// Database/schema in effect — the same statement means different things
    /// against two schemas.
    #[serde(default)]
    pub database: String,
    /// What initiated it: editor · browser · panel · shell · kill · datagen.
    #[serde(default = "default_source")]
    pub source: String,
    pub started_at: String,      // ISO 8601 with ms (frontend clock)
    pub ended_at: String,
    pub duration_ms: i64,
    pub connection_name: String,
    pub db_user: String,
    pub engine: String,
    pub ok: bool,
    pub rows_out: i64,
    pub rows_affected: Option<i64>,
    pub error: Option<String>,
    /// Stable failure class (apperror::ErrorCode). Empty on success, and on
    /// rows written before the column existed.
    #[serde(default)]
    pub error_code: String,
    /// The server's own number: `1146`, `42P01`. Empty when the failure never
    /// reached a server (a pool timeout, a TLS error) or on success.
    #[serde(default)]
    pub db_code: String,
    #[serde(default)]
    pub sqlstate: String,
    pub sql: String,
}

#[derive(Debug, Serialize)]
pub struct AuditEntry {
    pub id: i64,
    pub run_id: String,
    pub stmt_index: Option<i64>,
    pub stmt_total: Option<i64>,
    pub session_id: String,
    pub tab_title: String,
    pub database: String,
    pub source: String,
    pub started_at: String,
    pub ended_at: String,
    pub duration_ms: i64,
    pub connection_name: String,
    pub db_user: String,
    pub engine: String,
    pub ok: bool,
    pub rows_out: i64,
    pub rows_affected: Option<i64>,
    pub error: Option<String>,
    pub error_code: String,
    pub db_code: String,
    pub sqlstate: String,
    pub sql: String,
}

#[tauri::command]
pub async fn audit_insert(entry: AuditInsert, state: State<'_, AppState>) -> Result<(), crate::apperror::AppError> {
    let pool = &state.history;
    sqlx::query(
        "INSERT INTO audit_log \
         (run_id, stmt_index, stmt_total, session_id, tab_title, database, source, \
          started_at, ended_at, duration_ms, connection_name, db_user, engine, ok, rows_out, rows_affected, error, error_code, db_code, sqlstate, sql) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&entry.run_id)
    .bind(entry.stmt_index)
    .bind(entry.stmt_total)
    .bind(&entry.session_id)
    .bind(&entry.tab_title)
    .bind(&entry.database)
    .bind(&entry.source)
    .bind(&entry.started_at)
    .bind(&entry.ended_at)
    .bind(entry.duration_ms)
    .bind(&entry.connection_name)
    .bind(&entry.db_user)
    .bind(&entry.engine)
    .bind(entry.ok as i64)
    .bind(entry.rows_out)
    .bind(entry.rows_affected)
    .bind(&entry.error)
    .bind(&entry.error_code)
    .bind(&entry.db_code)
    .bind(&entry.sqlstate)
    .bind(&entry.sql)
    .execute(&*pool).await
    ?;
    Ok(())
}

// ── Session lifecycle events (connect / disconnect) ─────────────────────────
//
// The only audit rows written by the backend rather than the frontend: a
// disconnect must be recorded even when the window is already gone (app exit
// runs close_all), so the write lives next to the session teardown. The row
// reuses the statement schema instead of growing a parallel table for two
// event kinds: `source = 'lifecycle'`, the action keyword ('connect' /
// 'disconnect') in `sql`, and on a disconnect `duration_ms` carries how long
// the session lasted, with `started_at`/`ended_at` bracketing it.

/// The audit log's timestamp text — same shape the frontend's isoNow writes
/// (local time, milliseconds), so backend rows sort and read identically.
pub(crate) fn lifecycle_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

/// Build the session-start record at connect time.
pub(crate) fn session_start(config: &crate::db::types::ConnectionConfig) -> crate::state::SessionStart {
    crate::state::SessionStart {
        connection_name: config.name.clone(),
        engine:          config.engine.wire_name().to_string(),
        db_user:         config.user.clone().unwrap_or_default(),
        database:        config.database.clone().unwrap_or_default(),
        at:              std::time::Instant::now(),
        at_text:         lifecycle_now(),
    }
}

/// Append one lifecycle row. Never propagated: an audit failure must not
/// break a connect, and especially not a close.
pub(crate) async fn insert_lifecycle(
    pool: &crate::history::HistoryStore,
    session_id: uuid::Uuid,
    start: &crate::state::SessionStart,
    action: &str, // 'connect' | 'disconnect'
) {
    let now = lifecycle_now();
    // A disconnect brackets the whole session; a connect is a point event.
    let (started_at, duration_ms) = if action == "disconnect" {
        (start.at_text.clone(), start.at.elapsed().as_millis() as i64)
    } else {
        (now.clone(), 0)
    };
    let r = sqlx::query(
        "INSERT INTO audit_log \
         (run_id, session_id, tab_title, database, source, \
          started_at, ended_at, duration_ms, connection_name, db_user, engine, ok, rows_out, sql) \
         VALUES ('', ?, '', ?, 'lifecycle', ?, ?, ?, ?, ?, ?, 1, 0, ?)"
    )
    .bind(session_id.to_string())
    .bind(&start.database)
    .bind(&started_at)
    .bind(&now)
    .bind(duration_ms)
    .bind(&start.connection_name)
    .bind(&start.db_user)
    .bind(&start.engine)
    .bind(action)
    .execute(pool).await;
    if let Err(e) = r {
        eprintln!("[audit] lifecycle insert failed: {e:#}");
    }
}

/// The error column gets the classified connect message, not a server dump:
/// 500 chars is several full lines, and a longer one is noise either way.
const CONNECT_FAILED_ERROR_MAX: usize = 500;

/// Append a failed-connect lifecycle row: `ok = 0`, keyword 'connect failed'
/// (NOT 'connect' — the welcome feed renders that keyword as "Connected"
/// unconditionally), the already-sanitized error text, and the attempt's wall
/// time in `duration_ms`. There is no session, so `session_id` is the nil
/// UUID (the column is plain TEXT). Best-effort, same as `insert_lifecycle`:
/// an audit failure must never change the error the caller returns.
pub(crate) async fn insert_connect_failed(
    pool: &crate::history::HistoryStore,
    start: &crate::state::SessionStart,
    error: &str,
) {
    let now = lifecycle_now();
    let error: String = error.chars().take(CONNECT_FAILED_ERROR_MAX).collect();
    let r = sqlx::query(
        "INSERT INTO audit_log \
         (run_id, session_id, tab_title, database, source, \
          started_at, ended_at, duration_ms, connection_name, db_user, engine, ok, rows_out, sql, error) \
         VALUES ('', ?, '', ?, 'lifecycle', ?, ?, ?, ?, ?, ?, 0, 0, 'connect failed', ?)"
    )
    .bind(uuid::Uuid::nil().to_string())
    .bind(&start.database)
    .bind(&now)
    .bind(&now)
    .bind(start.at.elapsed().as_millis() as i64)
    .bind(&start.connection_name)
    .bind(&start.db_user)
    .bind(&start.engine)
    .bind(&error)
    .execute(pool).await;
    if let Err(e) = r {
        eprintln!("[audit] connect-failed insert failed: {e:#}");
    }
}

#[tauri::command]
pub async fn audit_list(
    search: Option<String>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<AuditEntry>, crate::apperror::AppError> {
    let pool = &state.history;
    let limit = limit.unwrap_or(500).min(5000);
    let rows = match search.filter(|s| !s.trim().is_empty()) {
        Some(q) => {
            let like = format!("%{}%", q.trim());
            sqlx::query(
                "SELECT id, run_id, stmt_index, stmt_total, session_id, tab_title, database, source, started_at, ended_at, duration_ms, connection_name, db_user, engine, ok, rows_out, rows_affected, error, error_code, db_code, sqlstate, sql \
                 FROM audit_log \
                 WHERE sql LIKE ?1 OR connection_name LIKE ?1 OR db_user LIKE ?1 \
                    OR COALESCE(error,'') LIKE ?1 OR tab_title LIKE ?1 OR database LIKE ?1 \
                    OR source LIKE ?1 OR error_code LIKE ?1 OR db_code LIKE ?1 \
                 ORDER BY id DESC LIMIT ?2"
            )
            .bind(like).bind(limit)
            .fetch_all(&*pool).await
        }
        None => {
            sqlx::query(
                "SELECT id, run_id, stmt_index, stmt_total, session_id, tab_title, database, source, started_at, ended_at, duration_ms, connection_name, db_user, engine, ok, rows_out, rows_affected, error, error_code, db_code, sqlstate, sql \
                 FROM audit_log ORDER BY id DESC LIMIT ?"
            )
            .bind(limit)
            .fetch_all(&*pool).await
        }
    }?;

    // By name, not by index. Adding `error_code` to the projection shifted
    // every column after `error` by one, and positional reads accepted that
    // silently until the types happened to disagree — `sql` would have been
    // read from the error column. Names cost nothing here and cannot slip.
    Ok(rows.iter().map(|r| AuditEntry {
        id:              r.get("id"),
        run_id:          r.get("run_id"),
        stmt_index:      r.get("stmt_index"),
        stmt_total:      r.get("stmt_total"),
        session_id:      r.get("session_id"),
        tab_title:       r.get("tab_title"),
        database:        r.get("database"),
        source:          r.get("source"),
        started_at:      r.get("started_at"),
        ended_at:        r.get("ended_at"),
        duration_ms:     r.get("duration_ms"),
        connection_name: r.get("connection_name"),
        db_user:         r.get("db_user"),
        engine:          r.get("engine"),
        ok:              r.get::<i64, _>("ok") != 0,
        rows_out:        r.get("rows_out"),
        rows_affected:   r.get("rows_affected"),
        error:           r.get("error"),
        error_code:      r.get("error_code"),
        db_code:         r.get("db_code"),
        sqlstate:        r.get("sqlstate"),
        sql:             r.get("sql"),
    }).collect())
}


#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    fn start(config_name: &str, engine: crate::db::types::Engine) -> crate::state::SessionStart {
        let mut c = crate::db::types::ConnectionConfig::new(engine, config_name);
        c.user = Some("root".into());
        c.database = Some("app".into());
        session_start(&c)
    }

    /// The timestamp text must round-trip in the same shape the frontend
    /// writes (isoNow): local time, milliseconds, space separator.
    #[test]
    fn lifecycle_now_matches_the_frontend_shape() {
        let t = lifecycle_now();
        assert_eq!(t.len(), 23, "{t}");
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[10..11], " ");
        assert_eq!(&t[19..20], ".");
    }

    /// A connect is a point event; a disconnect carries the session's whole
    /// lifetime, bracketed by started_at/ended_at.
    #[tokio::test]
    async fn lifecycle_rows_round_trip_with_duration() {
        let pool = crate::history::open_in_memory().await.unwrap();
        let sid = uuid::Uuid::new_v4();
        let mut s = start("prod", crate::db::types::Engine::Mysql);
        s.at = std::time::Instant::now() - std::time::Duration::from_millis(1500);

        insert_lifecycle(&pool, sid, &s, "connect").await;
        insert_lifecycle(&pool, sid, &s, "disconnect").await;

        let rows = sqlx::query(
            "SELECT sql, source, started_at, ended_at, duration_ms, connection_name, db_user, engine, ok \
             FROM audit_log ORDER BY id"
        ).fetch_all(&pool).await.unwrap();
        assert_eq!(rows.len(), 2);

        let connect = &rows[0];
        assert_eq!(connect.get::<String, _>("sql"), "connect");
        assert_eq!(connect.get::<String, _>("source"), "lifecycle");
        assert_eq!(connect.get::<i64, _>("duration_ms"), 0);
        assert_eq!(connect.get::<String, _>("connection_name"), "prod");
        assert_eq!(connect.get::<String, _>("db_user"), "root");
        assert_eq!(connect.get::<String, _>("engine"), "mysql");
        assert_eq!(connect.get::<i64, _>("ok"), 1);

        let disconnect = &rows[1];
        assert_eq!(disconnect.get::<String, _>("sql"), "disconnect");
        // The session lasted ≥ 1.5 s — the number the welcome feed renders
        // as "lasted …".
        assert!(disconnect.get::<i64, _>("duration_ms") >= 1500);
        assert_eq!(disconnect.get::<String, _>("started_at"), s.at_text);
        assert!(disconnect.get::<String, _>("ended_at") >= s.at_text);
    }

    /// An audit failure must never break the path it rides on — here, a pool
    /// that has been closed makes the insert a logged no-op, not an error.
    #[tokio::test]
    async fn lifecycle_insert_is_best_effort() {
        let pool = crate::history::open_in_memory().await.unwrap();
        pool.close().await;
        let s = start("prod", crate::db::types::Engine::Postgres);
        insert_lifecycle(&pool, uuid::Uuid::new_v4(), &s, "connect").await;
    }

    /// A failed connect writes ok=0 with the 'connect failed' keyword (the
    /// feed renders 'connect' as "Connected" no matter what), the error text,
    /// the attempt's wall time, and the nil UUID for the session that never
    /// existed.
    #[tokio::test]
    async fn connect_failed_row_carries_the_error_and_elapsed() {
        let pool = crate::history::open_in_memory().await.unwrap();
        let mut s = start("prod", crate::db::types::Engine::Mysql);
        s.at = std::time::Instant::now() - std::time::Duration::from_millis(1200);

        insert_connect_failed(&pool, &s, "Connect to prod failed:\ndead").await;

        let row = sqlx::query(
            "SELECT sql, source, duration_ms, connection_name, db_user, engine, ok, error, session_id \
             FROM audit_log"
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<String, _>("sql"), "connect failed");
        assert_eq!(row.get::<String, _>("source"), "lifecycle");
        assert_eq!(row.get::<i64, _>("ok"), 0);
        assert_eq!(row.get::<Option<String>, _>("error"), Some("Connect to prod failed:\ndead".into()));
        assert!(row.get::<i64, _>("duration_ms") >= 1200);
        assert_eq!(row.get::<String, _>("connection_name"), "prod");
        assert_eq!(row.get::<String, _>("session_id"), uuid::Uuid::nil().to_string());
    }

    /// A pathological error (a driver dumping a whole response) is truncated,
    /// not stored whole — on a char boundary, not mid-codepoint.
    #[tokio::test]
    async fn connect_failed_error_is_truncated() {
        let pool = crate::history::open_in_memory().await.unwrap();
        let s = start("prod", crate::db::types::Engine::Mysql);
        let long = "x".repeat(5000);
        insert_connect_failed(&pool, &s, &long).await;
        let row = sqlx::query("SELECT error FROM audit_log").fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<String, _>("error").chars().count(), CONNECT_FAILED_ERROR_MAX);
    }

    /// Best-effort like the lifecycle insert: a closed pool is a logged no-op.
    #[tokio::test]
    async fn connect_failed_insert_is_best_effort() {
        let pool = crate::history::open_in_memory().await.unwrap();
        pool.close().await;
        let s = start("prod", crate::db::types::Engine::Postgres);
        insert_connect_failed(&pool, &s, "boom").await;
    }
}
