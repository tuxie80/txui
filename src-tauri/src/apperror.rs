//! Typed errors across the IPC boundary.
//!
//! Every Tauri command used to return `Result<_, String>` — 123 of them. A
//! formatted sentence is fine for a human and useless for code: the frontend
//! could not tell "connection lost" from "permission denied" from "syntax
//! error" without matching prose.
//!
//! That is not hypothetical. `utils/scriptRun.ts` decides whether to stop a
//! multi-statement run by checking `String(err).includes('Query cancelled')`,
//! and needs a test asserting a statement *timeout* is not mistaken for it —
//! because PostgreSQL says "canceling statement due to statement timeout",
//! which contains the word. The string is load-bearing. That is the bug this
//! module removes.
//!
//! **Adopted incrementally.** New and changed commands return `AppError`;
//! existing ones are converted as they are touched. Two styles coexist for a
//! while, which is the price of not landing a 123-file diff into a codebase
//! that has no component tests yet.
//!
//! The wire shape is deliberately flat and stable:
//!
//! ```json
//! { "code": "cancelled", "message": "Query cancelled", "detail": null }
//! ```
//!
//! The frontend matches on `code`. `message` is for people and may be reworded
//! freely; **`code` may not**, because behaviour depends on it.

use serde::{Deserialize, Serialize};

/// The stable machine-readable classification.
///
/// Adding a variant is safe. Renaming one is a breaking change to the
/// frontend, which is why they are spelled out rather than derived from the
/// variant name — a refactor that renames the Rust enum must not silently
/// change the wire code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
// Without this the derive emits the variant name — `"Cancelled"` — and
// `utils/appError.ts` only recognises the snake_case spellings, so EVERY typed
// error fell back to `unknown` and the typed path was dead while every test
// still passed. The comment above described this rule; nothing enforced it.
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The user or the app stopped it. Not a failure.
    Cancelled,
    /// Ran longer than the server's ceiling. **A failure**, and deliberately
    /// distinct from `Cancelled` — conflating them is exactly the bug that
    /// prose-matching caused.
    Timeout,
    /// No session, or the connection dropped.
    ConnectionLost,
    /// Could not reach the server at all.
    ConnectFailed,
    /// The server refused on privileges.
    PermissionDenied,
    /// Refused by TxUI's own guards: read-only connection, prod hard limits.
    GuardRefused,
    /// The statement is malformed.
    SqlSyntax,
    /// A constraint, duplicate key, or similar data-level rejection.
    Constraint,
    /// The object does not exist.
    NotFound,
    /// The request was malformed before any server was involved.
    BadRequest,
    /// The engine cannot do this — Redis has no transactions, Parquet no DDL.
    Unsupported,
    /// Local filesystem, vault, or config failure.
    Local,
    /// Anything not yet classified. A wide net on purpose: better an honest
    /// `Unknown` than a confident wrong code.
    Unknown,
}

impl ErrorCode {
    /// The wire value. Stable — see the type comment.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Timeout => "timeout",
            ErrorCode::ConnectionLost => "connection_lost",
            ErrorCode::ConnectFailed => "connect_failed",
            ErrorCode::PermissionDenied => "permission_denied",
            ErrorCode::GuardRefused => "guard_refused",
            ErrorCode::SqlSyntax => "sql_syntax",
            ErrorCode::Constraint => "constraint",
            ErrorCode::NotFound => "not_found",
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::Local => "local",
            ErrorCode::Unknown => "unknown",
        }
    }

    /// Is retrying this plausibly useful?
    ///
    /// Encoded here rather than at each call site so a retry policy is one
    /// decision instead of a dozen guesses.
    pub fn retryable(self) -> bool {
        matches!(self, ErrorCode::ConnectionLost | ErrorCode::ConnectFailed | ErrorCode::Timeout)
    }

    /// Did the user ask for this? A cancelled operation is not a fault and
    /// should not be reported as one.
    pub fn is_user_intent(self) -> bool {
        matches!(self, ErrorCode::Cancelled)
    }
}

/// What a command returns when it fails.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub code: ErrorCode,
    /// For a person. May be reworded at any time.
    pub message: String,
    /// The underlying server text, when there was one, so nothing is lost by
    /// classifying it.
    pub detail: Option<String>,
    /// **The server's own error number**, as the user would look it up:
    /// `1146` on MySQL, `42P01` on PostgreSQL, `60` on ClickHouse.
    ///
    /// `code` above is TxUI's coarse class — useful for deciding what to do.
    /// This is the identity of the error, which is what someone actually
    /// searches for, quotes in a ticket, or matches against a runbook.
    /// "Deadlock found when trying to get lock" is the sentence; `1213` is the
    /// thing you look up. Both were being thrown away: the error formatters
    /// called `db.message()` and dropped `db.code()` and the native number.
    pub db_code: Option<String>,
    /// The SQL standard's five-character class, e.g. `42S02`, `40001`.
    /// Portable across engines where the native number is not.
    pub sqlstate: Option<String>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        AppError { code, message: message.into(), detail: None, db_code: None, sqlstate: None }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// How the error reads to a person — the same rule as
    /// `utils/appError.ts::errorDisplay`, so the two never diverge.
    ///
    /// `ERROR 1146 (42S02): Table 'shop.orders' doesn't exist`
    ///
    /// PostgreSQL's SQLSTATE *is* its code, so it is not printed twice.
    pub fn display(&self) -> String {
        match &self.db_code {
            None => self.message.clone(),
            Some(dc) => {
                let state = match &self.sqlstate {
                    Some(st) if st != dc => format!(" ({st})"),
                    _ => String::new(),
                };
                format!("ERROR {dc}{state}: {}", self.message)
            }
        }
    }

    pub fn cancelled() -> Self {
        AppError::new(ErrorCode::Cancelled, "Query cancelled")
    }

    /// The client-side query deadline elapsed. Deliberately `Timeout` and not
    /// `Cancelled`: nobody pressed Stop, so this belongs in history as a
    /// failure rather than being filtered out as user intent. The message
    /// names the setting, because a ceiling the user forgot they set is
    /// otherwise indistinguishable from the server being slow.
    pub fn query_deadline_exceeded(secs: u64) -> Self {
        AppError::new(
            ErrorCode::Timeout,
            format!("Query exceeded the {secs}s client-side deadline and was killed \
                     (Settings → Connections, or Query timeout on the connection)"),
        )
    }

    pub fn guard(message: impl Into<String>) -> Self {
        AppError::new(ErrorCode::GuardRefused, message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        AppError::new(ErrorCode::BadRequest, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        AppError::new(ErrorCode::Unsupported, message)
    }

    pub fn local(message: impl Into<String>) -> Self {
        AppError::new(ErrorCode::Local, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

/// Classify a driver or server error.
///
/// The order matters and is not arbitrary. **Timeout is tested before
/// cancellation**, because PostgreSQL's timeout message is
/// `canceling statement due to statement timeout` — it contains "canceling",
/// and classifying it as user intent would make a run that blew its ceiling
/// look like one somebody stopped on purpose.
pub fn classify(raw: &str) -> ErrorCode {
    let s = raw.to_lowercase();

    // Timeouts first — see above.
    if s.contains("statement timeout")
        || s.contains("lock wait timeout")
        || s.contains("max_execution_time")
        || s.contains("query execution was interrupted")
        || s.contains("timed out")
    {
        return ErrorCode::Timeout;
    }
    // Our own cancel signal, and the servers' response to one.
    if s.contains("query cancelled")
        || s.contains("canceling statement due to user request")
        || s.contains("interrupted")
    {
        return ErrorCode::Cancelled;
    }
    if s.contains("access denied")
        || s.contains("permission denied")
        || s.contains("insufficient privilege")
        || s.contains("command denied")
    {
        return ErrorCode::PermissionDenied;
    }
    if s.contains("connection refused")
        || s.contains("could not connect")
        || s.contains("no route to host")
        || s.contains("connect to")
        || s.contains("dns")
    {
        return ErrorCode::ConnectFailed;
    }
    if s.contains("connection")
        && (s.contains("lost") || s.contains("closed") || s.contains("reset")
            || s.contains("broken pipe") || s.contains("gone away"))
    {
        return ErrorCode::ConnectionLost;
    }
    if s.contains("syntax error") || s.contains("parse error") || s.contains("you have an error in your sql")
    {
        return ErrorCode::SqlSyntax;
    }
    if s.contains("duplicate")
        || s.contains("foreign key")
        || s.contains("constraint")
        || s.contains("violates")
        || s.contains("cannot be null")
    {
        return ErrorCode::Constraint;
    }
    if s.contains("doesn't exist")
        || s.contains("does not exist")
        || s.contains("unknown table")
        || s.contains("unknown database")
        || s.contains("not found")
    {
        return ErrorCode::NotFound;
    }
    // TxUI's OWN guard phrasings, matched exactly — and only after the engine
    // errors above. The old arm matched any message containing "prod",
    // "blocked" or "refused", so "Unknown database 'production'" or a server's
    // "connection refused" was reported as a TxUI guard refusal: wrong UI
    // treatment, non-retryable, blamed on the guard (WP-13 13.2). Every guard
    // message in the codebase carries one of these substrings (sqlguard /
    // redisguard / state.rs / the command-level gates).
    if s.contains("blocked on prod")
        || s.contains("connection is read-only")
        || s.contains("is read-only —")
        || s.contains("disabled on prod")
        // …plus the SERVERS' enforcement of our own read-only session setup
        // (PG default_transaction_read_only, MySQL tx_read_only) — same
        // meaning, same treatment.
        || s.contains("in a read-only transaction")
        || s.contains("read_only") && s.contains("cannot")
    {
        return ErrorCode::GuardRefused;
    }
    ErrorCode::Unknown
}

impl From<String> for AppError {
    /// The bridge that makes adoption incremental: an existing `String` error
    /// becomes a typed one with its class inferred, so a command can be
    /// converted without touching everything it calls.
    fn from(raw: String) -> Self {
        AppError {
            code: classify(&raw),
            message: raw.clone(),
            detail: Some(raw),
            db_code: None,
            sqlstate: None,
        }
    }
}

impl From<&str> for AppError {
    fn from(raw: &str) -> Self {
        AppError::from(raw.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    /// The database layer returns `anyhow::Result`, so by the time an error
    /// reaches a command it looks like prose. It is not: `anyhow` keeps the
    /// source, so the original `sqlx::Error` — and with it the server's error
    /// number and SQLSTATE — is still in there. Recovering it here is what
    /// makes `1146` reach the user instead of only the sentence.
    fn from(e: anyhow::Error) -> Self {
        match e.downcast_ref::<sqlx::Error>() {
            Some(sq) => AppError::from_sqlx(sq),
            None => AppError::from(format!("{e:#}")),
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::from_sqlx(&e)
    }
}

impl AppError {
    /// Build from a `sqlx::Error`, keeping what the server actually said.
    ///
    /// The class is taken from the **error number** where there is one, rather
    /// than by pattern-matching the message. `1213` is a deadlock in every
    /// locale and every MySQL version; "Deadlock found when trying to get
    /// lock" is one wording of it in one language.
    pub fn from_sqlx(e: &sqlx::Error) -> Self {
        let Some(db) = e.as_database_error() else {
            // Not a server rejection at all — a pool timeout, a TLS failure,
            // a closed socket. No number exists to report.
            return AppError::from(e.to_string());
        };
        let message = db.message().to_string();
        let sqlstate = db.code().map(|c| c.to_string());
        let number = db
            .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
            .map(|m| m.number().to_string());
        // PostgreSQL has no separate integer: SQLSTATE *is* its code, and
        // `42P01` is what its documentation and its users call it.
        let db_code = number.clone().or_else(|| sqlstate.clone());

        let code = number
            .as_deref()
            .and_then(|n| n.parse::<u16>().ok())
            .map(classify_mysql_number)
            .or_else(|| sqlstate.as_deref().map(classify_sqlstate))
            .unwrap_or_else(|| classify(&message));

        AppError { code, message: message.clone(), detail: Some(message), db_code, sqlstate }
    }
}

/// MySQL error numbers whose meaning TxUI acts on.
///
/// Only the ones that change behaviour are listed; everything else falls back
/// to the SQLSTATE class, which is coarser but never wrong.
fn classify_mysql_number(n: u16) -> ErrorCode {
    match n {
        // 3552 = access to a system schema rejected — a refusal, not a mystery.
        1044 | 1045 | 1142 | 1143 | 1227 | 1370 | 3552 => ErrorCode::PermissionDenied,
        1049 | 1051 | 1146 | 1054 | 1305 => ErrorCode::NotFound,
        // 1364 = no default value for a NOT NULL column; 1048 = NULL into one.
        1062 | 1451 | 1452 | 1216 | 1217 | 1048 | 1364 | 1406 => ErrorCode::Constraint,
        1064 | 1149 => ErrorCode::SqlSyntax,
        // A deadlock and a lock-wait timeout are both worth retrying; a
        // deadlock especially, since the server has already rolled one side
        // back and the retry usually succeeds.
        1205 | 1213 => ErrorCode::Timeout,
        // 3024 = "Query execution was interrupted, max_execution_time
        // exceeded" — the statement timeout, not a user cancel.
        3024 => ErrorCode::Timeout,
        // 1317 = interrupted by the client (KILL QUERY / ^C).
        1317 => ErrorCode::Cancelled,
        2006 | 2013 | 1053 => ErrorCode::ConnectionLost,
        2002 | 2003 | 2005 => ErrorCode::ConnectFailed,
        _ => ErrorCode::Unknown,
    }
}

/// SQLSTATE classes — portable, and what PostgreSQL is identified by.
fn classify_sqlstate(s: &str) -> ErrorCode {
    match s {
        "40001" => ErrorCode::Timeout,          // serialization failure / deadlock
        "57014" => ErrorCode::Cancelled,        // query canceled (PG)
        "53300" | "08006" | "08003" => ErrorCode::ConnectionLost,
        "08001" | "08004" => ErrorCode::ConnectFailed,
        "28000" | "28P01" | "42501" => ErrorCode::PermissionDenied,
        "3D000" | "42P01" | "42703" | "42883" => ErrorCode::NotFound,
        // Match on the 2-char SQLSTATE class, but only when there are 2 bytes:
        // sqlx hands SQLite errors a short numeric result code (e.g. "1"), and
        // `&s[..2]` on that panics. `get` yields None instead.
        _ => match s.get(..2) {
            Some("23") => ErrorCode::Constraint,   // integrity constraint violation
            Some("42") => ErrorCode::SqlSyntax,     // syntax error or access rule
            Some("08") => ErrorCode::ConnectFailed,
            _ => ErrorCode::Unknown,
        },
    }
}

impl From<redis::RedisError> for AppError {
    /// Redis names its errors too — `WRONGTYPE`, `NOAUTH`, `LOADING`,
    /// `READONLY`, `NOSCRIPT`. They are the same kind of thing as a MySQL
    /// number: the identity of the failure, stable across versions and
    /// wordings, and what the documentation is indexed by.
    fn from(e: redis::RedisError) -> Self {
        let db_code = e.code().map(|c| c.to_string());
        let code = match db_code.as_deref() {
            Some("NOAUTH") | Some("WRONGPASS") | Some("NOPERM") => ErrorCode::PermissionDenied,
            // READONLY: writing to a replica. Not TxUI's read-only guard —
            // the server refused, and saying "connection is read-only" here
            // would point at the wrong thing entirely.
            Some("READONLY") => ErrorCode::PermissionDenied,
            Some("WRONGTYPE") | Some("NOSCRIPT") => ErrorCode::BadRequest,
            // LOADING: the dataset is still being read from disk. Transient,
            // and retrying is exactly right.
            Some("LOADING") | Some("BUSY") | Some("MASTERDOWN") => ErrorCode::ConnectionLost,
            Some("CLUSTERDOWN") | Some("TRYAGAIN") => ErrorCode::ConnectionLost,
            _ if e.is_timeout() => ErrorCode::Timeout,
            _ if e.is_connection_dropped() => ErrorCode::ConnectionLost,
            _ if e.is_connection_refusal() => ErrorCode::ConnectFailed,
            _ => ErrorCode::Unknown,
        };
        let message = e.detail().map(str::to_string).unwrap_or_else(|| e.to_string());
        AppError { code, message: message.clone(), detail: Some(message), db_code, sqlstate: None }
    }
}

impl From<std::io::Error> for AppError {
    /// Local, not remote — a file that is missing or unreadable. `local` keeps
    /// it distinguishable from a server rejection, which matters when someone
    /// is deciding whether the database is at fault.
    fn from(e: std::io::Error) -> Self {
        AppError {
            code: ErrorCode::Local,
            message: e.to_string(),
            detail: None,
            db_code: Some(format!("io/{:?}", e.kind())),
            sqlstate: None,
        }
    }
}

impl From<tokio::task::JoinError> for AppError {
    /// A background task panicked or was aborted. Nothing to do with the
    /// database, and labelling it `local` keeps it out of the failure counts
    /// people read as "the server is having a bad day".
    fn from(e: tokio::task::JoinError) -> Self {
        AppError::new(ErrorCode::Local, e.to_string())
    }
}

impl From<csv::Error> for AppError {
    fn from(e: csv::Error) -> Self {
        AppError::new(ErrorCode::BadRequest, e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new(ErrorCode::BadRequest, e.to_string())
    }
}

#[cfg(test)]
mod live_codes {
/// The whole point: a real server error must reach the frontend carrying the
/// number the user would look up, not just a sentence.
#[tokio::test]
#[ignore = "needs local MySQL 3306 / PostgreSQL"]
async fn real_mysql_errors_carry_their_number() {
    let pool = sqlx::MySqlPool::connect("mysql://root:root@127.0.0.1:3306/mysql").await.unwrap();
    let cases: &[(&str, &str, super::ErrorCode)] = &[
        ("SELECT * FROM no_such_table",        "1146", super::ErrorCode::NotFound),
        ("SELECT 1 FROM DUAL WHERE",           "1064", super::ErrorCode::SqlSyntax),
        ("SELECT no_such_col FROM user",       "1054", super::ErrorCode::NotFound),
        ("CREATE DATABASE mysql",              "3552", super::ErrorCode::PermissionDenied),
    ];
    // A real duplicate-key needs a table of our own.
    let _ = crate::db::mysql::execute(&pool, "DROP DATABASE IF EXISTS txui_ec").await;
    crate::db::mysql::execute(&pool, "CREATE DATABASE txui_ec").await.unwrap();
    crate::db::mysql::execute(&pool, "CREATE TABLE txui_ec.t (id INT PRIMARY KEY)").await.unwrap();
    crate::db::mysql::execute(&pool, "INSERT INTO txui_ec.t VALUES (1)").await.unwrap();
    let dup = super::AppError::from(
        crate::db::mysql::execute(&pool, "INSERT INTO txui_ec.t VALUES (1)").await.unwrap_err());
    println!("duplicate key -> db_code={:?} sqlstate={:?} class={}",
             dup.db_code, dup.sqlstate, dup.code.as_str());
    assert_eq!(dup.db_code.as_deref(), Some("1062"));
    assert_eq!(dup.code, super::ErrorCode::Constraint);
    assert_eq!(dup.sqlstate.as_deref(), Some("23000"));
    let _ = crate::db::mysql::execute(&pool, "DROP DATABASE txui_ec").await;

    for (sql, want_num, want_code) in cases {
        let e: anyhow::Error = crate::db::mysql::execute(&pool, sql).await.unwrap_err();
        let app = super::AppError::from(e);
        println!("{:<50} db_code={:?} sqlstate={:?} class={}",
                 sql, app.db_code, app.sqlstate, app.code.as_str());
        assert_eq!(app.db_code.as_deref(), Some(*want_num), "{sql}");
        assert_eq!(app.code, *want_code, "{sql}");
        assert!(app.sqlstate.is_some(), "no SQLSTATE for {sql}");
    }
}

#[tokio::test]
#[ignore = "needs local PostgreSQL"]
async fn real_postgres_errors_carry_their_sqlstate() {
    let Ok(pool) = sqlx::PgPool::connect("postgres://localhost/postgres").await else { return };
    let e: anyhow::Error = crate::db::postgres::execute(&pool, "SELECT * FROM no_such_table")
        .await.unwrap_err();
    let app = super::AppError::from(e);
    println!("PG db_code={:?} sqlstate={:?} class={}", app.db_code, app.sqlstate, app.code.as_str());
    // PostgreSQL has no separate integer — 42P01 IS its code.
    assert_eq!(app.db_code.as_deref(), Some("42P01"));
    assert_eq!(app.code, super::ErrorCode::NotFound);
}

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_sqlstate_codes_do_not_panic() {
        // sqlx hands SQLite errors a 1-char result code (e.g. "1"); slicing the
        // 2-char SQLSTATE class out of that used to panic. Must classify, not crash.
        assert_eq!(classify_sqlstate("1"), ErrorCode::Unknown);
        assert_eq!(classify_sqlstate(""), ErrorCode::Unknown);
        assert_eq!(classify_sqlstate("5"), ErrorCode::Unknown);
        // Real 2-char classes still work.
        assert_eq!(classify_sqlstate("23505"), ErrorCode::Constraint);
        assert_eq!(classify_sqlstate("42601"), ErrorCode::SqlSyntax);
    }

    // The whole reason this module exists: `utils/scriptRun.ts` had to
    // string-match "Query cancelled" to decide whether to stop a script, and
    // needed a test proving a timeout was not mistaken for it. These assert the
    // classification does that job so the frontend does not have to.

    #[test]
    fn a_postgres_timeout_is_not_a_cancellation() {
        // "canceling statement due to statement timeout" contains "canceling".
        // Classifying it as user intent would make a run that blew its ceiling
        // look like one somebody stopped deliberately.
        assert_eq!(
            classify("ERROR: canceling statement due to statement timeout"),
            ErrorCode::Timeout
        );
    }

    #[test]
    fn a_real_user_cancellation_is_one() {
        assert_eq!(classify("Query cancelled"), ErrorCode::Cancelled);
        assert_eq!(
            classify("ERROR: canceling statement due to user request"),
            ErrorCode::Cancelled
        );
    }

    #[test]
    fn a_cancellation_is_user_intent_and_a_timeout_is_not() {
        assert!(ErrorCode::Cancelled.is_user_intent());
        assert!(!ErrorCode::Timeout.is_user_intent());
    }

    #[test]
    fn only_transient_failures_are_retryable() {
        // Retrying a syntax error or a permission denial just burns time.
        for c in [ErrorCode::ConnectionLost, ErrorCode::ConnectFailed, ErrorCode::Timeout] {
            assert!(c.retryable(), "{c:?}");
        }
        for c in [
            ErrorCode::SqlSyntax, ErrorCode::PermissionDenied, ErrorCode::GuardRefused,
            ErrorCode::Constraint, ErrorCode::Cancelled, ErrorCode::NotFound,
        ] {
            assert!(!c.retryable(), "{c:?}");
        }
    }

    #[test]
    fn real_server_messages_classify() {
        let cases = [
            ("Access denied for user 'root'@'localhost'", ErrorCode::PermissionDenied),
            ("You have an error in your SQL syntax; check the manual", ErrorCode::SqlSyntax),
            ("Duplicate entry '1' for key 'PRIMARY'", ErrorCode::Constraint),
            ("Table 'db.nope' doesn't exist", ErrorCode::NotFound),
            ("Lock wait timeout exceeded; try restarting transaction", ErrorCode::Timeout),
            ("MySQL server has gone away", ErrorCode::Unknown),
            ("connection to server was lost", ErrorCode::ConnectionLost),
            ("connection is read-only — write statements are blocked", ErrorCode::GuardRefused),
            // WP-13 13.2: engine errors that merely CONTAIN "prod"/"blocked"/
            // "refused" must not be blamed on the guard.
            ("Unknown database 'production'", ErrorCode::NotFound),
            ("Table 'shop.products' doesn't exist", ErrorCode::NotFound),
            ("connection refused (os error 61)", ErrorCode::ConnectFailed),
            // …while a real guard message and the servers' read-only
            // enforcement still classify as the guard.
            ("blocked on prod: destructive DDL — enable 'Allow destructive DDL' to permit", ErrorCode::GuardRefused),
            ("cannot execute INSERT in a read-only transaction", ErrorCode::GuardRefused),
        ];
        for (msg, want) in cases {
            assert_eq!(classify(msg), want, "{msg:?}");
        }
    }

    #[test]
    fn an_unrecognised_message_is_unknown_not_a_confident_guess() {
        // A wide net beats a wrong code — the frontend can fall back to showing
        // the text, which is what it does today anyway.
        assert_eq!(classify("something nobody has seen before"), ErrorCode::Unknown);
    }

    #[test]
    fn the_wire_codes_are_stable_and_distinct() {
        // Renaming a variant must not silently change the wire value, and two
        // variants must never collide.
        let all = [
            ErrorCode::Cancelled, ErrorCode::Timeout, ErrorCode::ConnectionLost,
            ErrorCode::ConnectFailed, ErrorCode::PermissionDenied, ErrorCode::GuardRefused,
            ErrorCode::SqlSyntax, ErrorCode::Constraint, ErrorCode::NotFound,
            ErrorCode::BadRequest, ErrorCode::Unsupported, ErrorCode::Local, ErrorCode::Unknown,
        ];
        let mut seen = std::collections::HashSet::new();
        for c in all {
            assert!(seen.insert(c.as_str()), "duplicate wire code {}", c.as_str());
            assert!(!c.as_str().is_empty());
        }
        assert_eq!(ErrorCode::Cancelled.as_str(), "cancelled");
        assert_eq!(ErrorCode::Timeout.as_str(), "timeout");
    }

    #[test]
    fn a_string_error_converts_and_keeps_its_text() {
        // The bridge that makes adoption incremental.
        let e: AppError = "Duplicate entry '1' for key 'PRIMARY'".to_string().into();
        assert_eq!(e.code, ErrorCode::Constraint);
        assert!(e.detail.is_some());
        assert_eq!(e.to_string(), "Duplicate entry '1' for key 'PRIMARY'");
    }
}

#[cfg(test)]
mod wire_shape_tests {
    use super::*;

    /// The frontend reads `code` to decide policy and `db_code` to show the
    /// user, so the serialized shape is a contract. `utils/appError.ts`
    /// accepts exactly these five fields with a snake_case code string;
    /// anything else falls back to `unknown` and the typed path silently
    /// stops working while every test still passes.
    #[test]
    fn a_cancellation_serializes_to_the_shape_the_frontend_expects() {
        let json = serde_json::to_value(AppError::cancelled()).unwrap();
        assert_eq!(json["code"], "cancelled");
        assert_eq!(json["message"], "Query cancelled");
        assert!(json["detail"].is_null());
        // A cancel is TxUI's own, not a server rejection — there is no number.
        assert!(json["db_code"].is_null());
        assert!(json["sqlstate"].is_null());
        // The set, not the order — serde_json sorts keys and a JSON consumer
        // does not care, but a field appearing or vanishing matters.
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["code", "db_code", "detail", "message", "sqlstate"],
                   "the wire shape changed; utils/appError.ts must change with it");
    }

    /// A server rejection carries the number the user would look up.
    #[test]
    fn a_server_rejection_serializes_with_its_number() {
        let e = AppError {
            code: ErrorCode::NotFound,
            message: "Table 'shop.orders' doesn't exist".into(),
            detail: None,
            db_code: Some("1146".into()),
            sqlstate: Some("42S02".into()),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["db_code"], "1146");
        assert_eq!(json["sqlstate"], "42S02");
        assert_eq!(json["code"], "not_found");
    }

    /// Every code must round-trip as the exact string `utils/appError.ts`
    /// lists. A rename on either side turns the typed check back into a
    /// string match that always fails.
    #[test]
    fn every_code_serializes_to_its_documented_spelling() {
        for (code, expected) in [
            (ErrorCode::Cancelled, "cancelled"),
            (ErrorCode::Timeout, "timeout"),
            (ErrorCode::ConnectionLost, "connection_lost"),
            (ErrorCode::ConnectFailed, "connect_failed"),
            (ErrorCode::PermissionDenied, "permission_denied"),
            (ErrorCode::GuardRefused, "guard_refused"),
            (ErrorCode::SqlSyntax, "sql_syntax"),
            (ErrorCode::Constraint, "constraint"),
            (ErrorCode::NotFound, "not_found"),
            (ErrorCode::BadRequest, "bad_request"),
            (ErrorCode::Unsupported, "unsupported"),
            (ErrorCode::Local, "local"),
            (ErrorCode::Unknown, "unknown"),
        ] {
            assert_eq!(serde_json::to_value(code).unwrap(), expected);
            assert_eq!(code.as_str(), expected, "as_str disagrees with the wire form");
        }
    }

    /// A cancel is user intent; a timeout is not. `execute_query` uses this to
    /// decide whether to write the statement to history, and it used to decide
    /// by comparing against the sentence "Query cancelled".
    #[test]
    fn only_a_cancellation_counts_as_user_intent() {
        assert!(ErrorCode::Cancelled.is_user_intent());
        assert!(!ErrorCode::Timeout.is_user_intent());
        assert!(!ErrorCode::ConnectionLost.is_user_intent());
    }
}

#[cfg(test)]
mod chain_tests {
    use super::*;

    /// The number has to survive every hop between the server and the screen:
    /// sqlx::Error → anyhow::Error (the db layer's type) → `?` → AppError →
    /// JSON → the frontend. Each hop used to flatten it to prose.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn the_number_survives_the_whole_chain_to_json() {
        let pool = sqlx::MySqlPool::connect("mysql://root:root@127.0.0.1:3306/mysql").await.unwrap();

        // The hop that used to lose it: the db layer returns anyhow::Result.
        let anyhow_err: anyhow::Error =
            crate::db::mysql::execute(&pool, "SELECT * FROM no_such_table").await.unwrap_err();

        // The hop a command performs with `?`.
        let app: AppError = anyhow_err.into();

        // The hop to the frontend.
        let json = serde_json::to_value(&app).unwrap();
        assert_eq!(json["db_code"], "1146");
        assert_eq!(json["sqlstate"], "42S02");
        assert_eq!(json["code"], "not_found");

        // And what a person ends up reading.
        assert!(app.display().starts_with("ERROR 1146 (42S02): Table"),
                "unexpected rendering: {}", app.display());
    }

    /// A guard refusal is TxUI's, not the server's. It must not be dressed up
    /// with a number that would send someone looking through MySQL's manual.
    #[test]
    fn a_guard_refusal_carries_no_server_number() {
        let e = AppError::guard("connection is read-only — write statement rejected");
        assert_eq!(e.code, ErrorCode::GuardRefused);
        assert!(e.db_code.is_none());
        assert_eq!(e.display(), "connection is read-only — write statement rejected");
    }
}
