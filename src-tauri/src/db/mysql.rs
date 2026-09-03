use anyhow::Result;
use sqlx::AssertSqlSafe;
use sqlx::{MySqlPool, Row as SqlxRow, Column, TypeInfo};
use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
use std::time::Instant;

use super::types::{ColumnInfo, ConnectionConfig, LiveSession, PingResult, QueryResult, Row, SchemaNode, SslMode};

fn build_options(
    config:   &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,  // (host, port) when SSH tunnel active
) -> Result<MySqlConnectOptions> {
    let (host, port) = host_override.unwrap_or((
        config.host.as_deref().unwrap_or("localhost"),
        config.port.unwrap_or(3306),
    ));

    // "localhost" → "127.0.0.1" (plain TCP only — sockets and SSH overrides
    // are untouched). The pool RE-DIALS over the session's lifetime (growth,
    // idle-timeout reaping), and every dial re-resolves the hostname through
    // getaddrinfo. On macOS a network change (VPN up/down, IPv6 route dropped)
    // can make that re-resolution return only ::1 — the dial then fails with
    // ENETUNREACH ("Network is unreachable", os error 51) on a session that
    // connected fine. Pinning the IPv4 loopback removes DNS from every
    // re-dial. Server-side this is identical: a TCP peer at 127.0.0.1 maps to
    // the same account whether the client dialed "localhost" or "127.0.0.1".
    let socket_in_use = host_override.is_none()
        && config.socket_path.as_deref().is_some_and(|s| !s.is_empty());
    let host: String = if host_override.is_none() && !socket_in_use {
        super::util::pin_localhost(host).to_string()
    } else {
        host.to_string()
    };

    let mut opts = MySqlConnectOptions::new()
        .host(&host)
        .port(port)
        .username(config.user.as_deref().unwrap_or("root"))
        .password(password.as_deref().unwrap_or(""))
        // Full Unicode: force the 4-byte utf8mb4 connection charset so emoji
        // and all multibyte text round-trip correctly (not latin1/utf8mb3).
        // Collation is left to the server unless explicitly configured —
        // utf8mb4_0900_ai_ci does not exist on MySQL 5.7 / MariaDB < 10.10.
        .charset(config.charset.as_deref().filter(|c| !c.is_empty()).unwrap_or("utf8mb4"));

    if let Some(collation) = config.collation.as_deref().filter(|c| !c.is_empty()) {
        opts = opts.collation(collation);
    }
    // Left alone when unset, which keeps sqlx's `+00:00` and so keeps every
    // existing connection rendering exactly as it did. `SYSTEM` is the
    // spelling that adopts the server's zone and makes TxUI agree with the
    // mysql CLI; see `time_zone` in db/types.rs for why this is safe to move.
    if let Some(tz) = config.time_zone.as_deref().filter(|t| !t.is_empty()) {
        opts = opts.timezone(Some(tz.to_string()));
    }
    if config.enable_cleartext_plugin {
        opts = opts.enable_cleartext_plugin(true);
    }
    // Unix socket overrides host/port (ignored when an SSH tunnel supplies
    // host_override — the tunnel endpoint is always TCP).
    if host_override.is_none() {
        if let Some(socket) = config.socket_path.as_deref().filter(|s| !s.is_empty()) {
            opts = opts.socket(socket);
        }
    }

    if let Some(db) = &config.database {
        if !db.is_empty() { opts = opts.database(db); }
    }

    opts = match config.ssl_mode {
        SslMode::Disable    => opts.ssl_mode(MySqlSslMode::Disabled),
        SslMode::Preferred  => opts.ssl_mode(MySqlSslMode::Preferred),
        SslMode::Require    => opts.ssl_mode(MySqlSslMode::Required),
        SslMode::VerifyCa   => opts.ssl_mode(MySqlSslMode::VerifyCa),
        SslMode::VerifyFull => opts.ssl_mode(MySqlSslMode::VerifyIdentity),
    };

    if let Some(ca) = &config.ssl_ca_path {
        if !ca.is_empty() { opts = opts.ssl_ca(ca); }
    }
    // Cert and key are applied independently; sqlx's TLS layer rejects a lone
    // cert or key with a clear config error ("user auth key and certs must be
    // given together") instead of silently dropping the cert.
    if let Some(cert) = &config.ssl_cert_path {
        if !cert.is_empty() { opts = opts.ssl_client_cert(cert); }
    }
    if let Some(key) = &config.ssl_key_path {
        if !key.is_empty() { opts = opts.ssl_client_key(key); }
    }

    Ok(opts)
}

/// Validate one `extra_params` entry for use in `SET SESSION <key> = <value>`.
/// Keys must be bare identifiers (optionally dotted for sysvar scopes);
/// values must not be able to break out of the single statement.
pub fn valid_session_param(key: &str, value: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
        return false;
    }
    !value.chars().any(|c| {
        c.is_control()
            || matches!(c, ';' | '\'' | '"' | '`')
    }) && !value.contains("--") && !value.contains("/*") && !value.contains("*/")
}

/// Runs once per new pooled connection: enforce read-only, apply validated
/// extra_params, then init_sql. Nothing here is fatal — failures are logged.
async fn setup_new_connection(conn: &mut sqlx::mysql::MySqlConnection, config: &ConnectionConfig) {
    use sqlx::Executor;

    // NOTE: `autocommit` is deliberately NOT set here.
    //
    // It used to be, so the toolbar's `@@autocommit` readout would agree
    // whichever connection a panel query landed on. That was a leak: with
    // autocommit off, **a plain SELECT opens a transaction** — measured, one
    // `RUNNING` entry in `information_schema.innodb_trx` per read — and a
    // pooled connection then returns to the pool holding a read view nobody
    // will ever commit. The processlist polls at 1 Hz, so within a minute
    // every pooled connection held a stale snapshot, retaining undo and
    // serving panels increasingly out-of-date data.
    //
    // Autocommit off is a property of the **pinned** connection, which is
    // where the user's writes go (`commands::query::begin_transaction` sets it
    // there). Pooled connections serve reads for panels and the browser and
    // must stay in autocommit so they release cleanly.

    // A ceiling on reads. `max_execution_time` is in milliseconds and, on
    // MySQL, applies to read-only SELECT only — an UPDATE carrying a slow
    // predicate runs to completion regardless (measured; see
    // DEFAULT_STATEMENT_TIMEOUT_SECS). Set on every pooled connection *and*
    // therefore on pinned transaction connections too, since those are
    // acquired from the same pool.
    if let Some(secs) = config.statement_timeout_secs.filter(|s| *s > 0) {
        let ms = u64::from(secs).saturating_mul(1000);
        if let Err(e) = conn.execute(AssertSqlSafe(format!("SET SESSION max_execution_time = {ms}"))).await {
            // MariaDB spells it differently and measures in seconds.
            match conn.execute(AssertSqlSafe(format!("SET SESSION max_statement_time = {secs}"))).await {
                Ok(_) => {}
                Err(e2) => log::warn!(
                    "statement timeout not applied ({e}; MariaDB fallback: {e2}) — statements are UNBOUNDED"),
            }
        }
    }

    if config.read_only {
        if let Err(e) = conn.execute("SET SESSION transaction_read_only = 1").await {
            // MariaDB < 10.x only knows the older variable name
            match conn.execute("SET SESSION tx_read_only = 1").await {
                Ok(_) => {}
                Err(e2) => log::warn!(
                    "read-only enforcement failed ({}; fallback: {}) — connection is NOT read-only", e, e2
                ),
            }
        }
    }

    for (key, value) in &config.extra_params {
        if !valid_session_param(key, value) {
            log::warn!("skipping invalid extra_params entry `{key}`");
            continue;
        }
        if let Err(e) = conn.execute(AssertSqlSafe(format!("SET SESSION {key} = {value}"))).await {
            log::warn!("SET SESSION {key} failed: {e}");
        }
    }

    if let Some(sql) = config.init_sql.as_deref().filter(|s| !s.trim().is_empty()) {
        if let Err(e) = conn.execute(AssertSqlSafe(sql)).await {
            log::warn!("init_sql failed: {e}");
        }
    }
}

pub async fn open(config: &ConnectionConfig, password: Option<String>, host_override: Option<(&str, u16)>) -> Result<LiveSession> {
    // Small pool: a GUI needs only a few concurrent statements. Idle-timeout
    // keeps the instance's thread count low when the user is reading results.
    Ok(LiveSession::Mysql(open_pool(config, password, host_override, config.pool_max.unwrap_or(4)).await?))
}

/// A standalone pool with an explicit size — the session pool stays at 4, but
/// the Playground needs one server thread per spawned worker (and holds them
/// all at once), so it builds its own pool and drops it when the run ends.
pub async fn open_pool(
    config: &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
    max_connections: u32,
) -> Result<sqlx::MySqlPool> {
    let opts = build_options(config, password, host_override)?;
    let setup_cfg = config.clone();
    let connect = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(max_connections.max(1))
        .min_connections(0)
        .acquire_timeout(std::time::Duration::from_secs(config.pool_acquire_timeout_secs.unwrap_or(30).into()))
        .idle_timeout(std::time::Duration::from_secs(config.pool_idle_timeout_secs.unwrap_or(60).into()))
        .after_connect(move |conn, _meta| {
            let cfg = setup_cfg.clone();
            Box::pin(async move {
                setup_new_connection(conn, &cfg).await;
                Ok(())
            })
        })
        .connect_with(opts);
    // Bounded + one-line errors — the shared helper (db/util.rs).
    let pool = super::util::connect_bounded(connect, config.connect_timeout_secs, fmt_conn_error).await?;
    Ok(pool)
}

/// Clean, single-line rendering of a connect error + an actionable hint for
/// the most common auth trap. sqlx's Display repeats the DB message (context +
/// source); we take the database message once.
pub fn fmt_conn_error(e: &sqlx::Error) -> String {
    let msg = e.as_database_error()
        .map(|db| db.message().to_string())
        .unwrap_or_else(|| e.to_string());
    let mut out = msg.clone();
    // 1045 Access denied — the classic localhost-vs-127.0.0.1 account split
    if msg.contains("Access denied") {
        if msg.contains("@'localhost'") {
            out.push_str("\n\nHint: MySQL resolved this TCP connection to the `@'localhost'` account (127.0.0.1 reverse-resolves to localhost when skip_name_resolve is off). `root@'localhost'` and `root@'127.0.0.1'`/`root@'%'` are SEPARATE accounts with their own passwords/auth plugins. Verify with:  mysql --protocol=TCP -h127.0.0.1 -uroot -p  — if that also fails, the stored password is wrong for THIS account: re-enter it via Edit, or grant a matching `@'%'` user.");
        } else if msg.contains("using password: NO") {
            out.push_str("\n\nHint: no password was sent — re-enter it via Edit (editing keeps the old password only if you leave the field blank AND one was stored before).");
        } else {
            out.push_str("\n\nHint: the stored password was rejected — re-enter it via Edit.");
        }
    }
    out
}

pub async fn ping(config: &ConnectionConfig, password: Option<String>) -> PingResult {
    let start = Instant::now();
    let opts = match build_options(config, password, None) {
        Ok(o) => o,
        Err(e) => return PingResult { ok: false, latency_ms: 0, server_version: None, error: Some(e.to_string()) },
    };
    match MySqlPool::connect_with(opts).await {
        Ok(pool) => {
            let version: Result<String, _> = sqlx::query_scalar("SELECT VERSION()")
                .fetch_one(&pool).await;
            PingResult {
                ok: true,
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: version.ok(),
                error: None,
            }
        }
        Err(e) => PingResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: None,
            error: Some(fmt_conn_error(&e)),
        },
    }
}

/// Generic over the executor so callers can pass either the pool or a
/// dedicated acquired connection (whose CONNECTION_ID enables KILL QUERY).
pub async fn execute<'e, E>(executor: E, sql: &'e str) -> Result<QueryResult>
where
    E: sqlx::Executor<'e, Database = sqlx::MySql>,
{
    execute_capped(executor, sql, None).await
}

/// As `execute`, fetching at most `max_rows` data rows: past the cap the
/// stream is abandoned and `truncated` is set on the result, so a stray
/// `SELECT * FROM big_table` cannot hold the table in RAM. Each row is
/// decoded to its JSON form as it streams and the raw driver row dropped
/// immediately — the result set is held once, never twice.
pub async fn execute_capped<'e, E>(
    executor: E,
    sql: &'e str,
    max_rows: Option<usize>,
) -> Result<QueryResult>
where
    E: sqlx::Executor<'e, Database = sqlx::MySql>,
{
    use futures_util::TryStreamExt;
    let start = Instant::now();

    // Single-pass execution: the stream yields rows for result sets and a
    // summary (rows_affected) for DML — never runs the statement twice.
    let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(executor);
    let mut affected: Option<u64> = None;
    // execution_ms = time until the FIRST row (or stream completion for
    // non-SELECT); fetch_ms = the rest of the stream + decode.
    let mut first_row_ms: Option<u64> = None;
    let mut columns: Vec<ColumnInfo> = vec![];
    // Classify each column's type once, not once per cell.
    let mut classes: Vec<MySqlTypeClass> = vec![];
    let mut data: Vec<Row> = Vec::new();
    let mut truncated = false;
    while let Some(item) = stream.try_next().await? {
        match item {
            sqlx::Either::Left(done) => {
                affected = Some(affected.unwrap_or(0) + done.rows_affected());
            }
            sqlx::Either::Right(row) => {
                if first_row_ms.is_none() {
                    first_row_ms = Some(start.elapsed().as_millis() as u64);
                }
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| ColumnInfo {
                        name:      c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                        nullable:  true,
                    }).collect();
                    classes = columns.iter()
                        .map(|c| classify_mysql_type(&c.type_name))
                        .collect();
                }
                if max_rows.is_some_and(|cap| data.len() >= cap) {
                    truncated = true;
                    break;
                }
                data.push(classes.iter().enumerate().map(|(i, &class)| {
                    json_value_from_mysql_row(&row, i, class)
                }).collect());
            }
        }
    }
    let execution_ms = first_row_ms.unwrap_or_else(|| start.elapsed().as_millis() as u64);

    if columns.is_empty() {
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: affected,
            execution_ms,
            fetch_ms: 0,
            warnings: vec![],
            truncated: false,
        });
    }

    Ok(QueryResult {
        columns,
        rows: data,
        rows_affected: None,
        execution_ms,
        fetch_ms: start.elapsed().as_millis() as u64 - execution_ms,
        warnings: vec![],
        truncated,
    })
}

/// `SHOW WARNINGS` on the same connection right after a statement — one
/// formatted line per row (`Warning [1760] message`). The diagnostics area is
/// per-connection, so this MUST run on the connection that executed the
/// statement. Best-effort by contract: any failure yields an empty vec (a
/// warnings fetch must never fail the query it follows).
pub async fn fetch_warnings<'e, E>(executor: E) -> Vec<String>
where
    E: sqlx::Executor<'e, Database = sqlx::MySql>,
{
    use sqlx::Row;
    let rows = match sqlx::query("SHOW WARNINGS").fetch_all(executor).await {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    rows.iter().filter_map(|r| {
        let level: String = r.try_get(0).ok()?;
        // the Code column is small but its signedness isn't guaranteed — take either
        let code: u64 = r.try_get::<i64, _>(1).map(|v| v as u64)
            .or_else(|_| r.try_get::<u64, _>(1)).ok()?;
        let message: String = r.try_get(2).ok()?;
        Some(format!("{level} [{code}] {message}"))
    }).collect()
}

pub fn json_value_from_row_pub(row: &sqlx::mysql::MySqlRow, i: usize, type_name: &str) -> serde_json::Value {
    json_value_from_mysql_row(row, i, classify_mysql_type(type_name))
}

/// For hot loops: classify each column's type once up front, then decode
/// every cell against the class instead of re-scanning the type name.
pub fn json_value_from_row_class(row: &sqlx::mysql::MySqlRow, i: usize, class: MySqlTypeClass) -> serde_json::Value {
    json_value_from_mysql_row(row, i, class)
}

/// A column's declared type, classified once per column rather than once per
/// cell: the type name is identical across every row, and uppercasing plus
/// substring-scanning it for each of rows×cols cells was the decoder's hottest
/// allocation. Check order mirrors the old per-cell chain exactly.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MySqlTypeClass {
    Bool,
    Int,
    Decimal,
    Float,
    DateTime,
    Date,
    Time,
    Json,
    Binary,
    Other,
}

pub fn classify_mysql_type(type_name: &str) -> MySqlTypeClass {
    use MySqlTypeClass::*;
    let tn = type_name.to_ascii_uppercase();
    if tn == "BOOLEAN" || tn == "BOOL" { return Bool; }
    if tn.contains("INT") || tn == "YEAR" || tn == "BIT" { return Int; }
    if tn.contains("DECIMAL") || tn.contains("NUMERIC") { return Decimal; }
    if tn.contains("FLOAT") || tn.contains("DOUBLE") { return Float; }
    if tn.contains("DATETIME") || tn.contains("TIMESTAMP") { return DateTime; }
    if tn == "DATE" { return Date; }
    if tn == "TIME" { return Time; }
    if tn == "JSON" { return Json; }
    if tn.contains("BLOB") || tn.contains("BINARY") { return Binary; }
    Other
}

/// Date or datetime family — the types MySQL can hand us an unrepresentable
/// value in ('0000-00-00' and friends).
fn is_date_class(class: MySqlTypeClass) -> bool {
    matches!(class, MySqlTypeClass::Date | MySqlTypeClass::DateTime)
}

/// Recover a date literal that no Rust date type can hold.
///
/// MySQL before `NO_ZERO_DATE` stored `'0000-00-00'`, and `'2020-00-15'` was
/// legal too. `chrono` can represent neither, so every typed decode fails —
/// and the value would otherwise be rendered as NULL, which for a legacy table
/// is a lie a database GUI cannot afford. A zero date and a NULL are different
/// values, they mean different things to whoever has to clean the data up, and
/// as identical empty cells there is no way to tell which row is which.
///
/// This is the ground Connector/J covers with `zeroDateTimeBehavior`. It has
/// three modes and lets you pick; we have one and it is the honest one — show
/// what the server holds.
///
/// The rescue is `try_get_unchecked`, which skips sqlx's type-compatibility
/// refusal. In the **text** protocol (`raw_sql`, which `execute` uses, so this
/// is the path the grid actually takes) the payload *is* the ASCII literal, so
/// this returns exactly what any other client would print — including the
/// partially-zero case. A genuine NULL still fails the decode and stays NULL.
///
/// The shape guard matters: under the **binary** protocol the same call would
/// reinterpret packed date bytes as text and produce mojibake, so anything not
/// looking like `NNNN-NN-NN` is rejected and the caller falls through.
/// Verified against MySQL 8.0.46 in `zero_date_tests`.
fn unrepresentable_date_text(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
    let s: String = row.try_get_unchecked(i).ok()?;
    let b = s.as_bytes();
    let shaped = b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit);
    shaped.then_some(s)
}

/// Render MySQL's **binary**-protocol date payload as the literal the server
/// holds, including values chrono cannot represent.
///
/// The text rescue above covers the editor, which runs through `raw_sql`. The
/// **data browser** does not: it binds filter values, so it goes through
/// `sqlx::query` and the binary protocol, where the payload is packed bytes
/// rather than ASCII and `try_get_unchecked::<String>` produces mojibake.
///
/// `try_get_unchecked::<Vec<u8>>` is what gets through. sqlx refuses a plain
/// `try_get::<Vec<u8>>` on a DATE column as a type mismatch — that refusal is
/// the *compatibility check*, not the decoder, and `_unchecked` skips it while
/// `Vec<u8>`'s decode just copies the bytes out. So no fork and no scraping of
/// sqlx's error text is needed to read a value it will not parse.
///
/// Layout is MySQL's documented binary date encoding: a length byte, then
/// `year:u16le, month, day`, then optionally `hour, minute, second`, then
/// optionally `micros:u32le`. Trailing zero components are omitted by the
/// server, which is why a DATETIME of midnight arrives with length 4.
///
/// The length check is also what keeps this from firing on a text-protocol
/// value: ASCII digits are `0x30`–`0x39`, so `b"2020-00-15"` reads as a
/// declared length of 50 and is rejected rather than mis-decoded.
fn binary_date_literal(bytes: &[u8], want_time: bool) -> Option<String> {
    let (&len, rest) = bytes.split_first()?;
    if rest.len() != usize::from(len) || !matches!(len, 0 | 4 | 7 | 11) {
        return None;
    }
    let (year, month, day) = if len == 0 {
        (0u16, 0u8, 0u8)
    } else {
        (u16::from_le_bytes([rest[0], rest[1]]), rest[2], rest[3])
    };
    let date = format!("{year:04}-{month:02}-{day:02}");
    if !want_time {
        return Some(date);
    }
    let (h, mi, sec) = if len >= 7 { (rest[4], rest[5], rest[6]) } else { (0, 0, 0) };
    let micros = if len == 11 {
        u32::from_le_bytes([rest[7], rest[8], rest[9], rest[10]])
    } else {
        0
    };
    // `%.f` in the chrono path prints nothing at zero, so match that rather
    // than tacking ".000000" onto every timestamp.
    let frac = if micros > 0 { format!(".{micros:06}") } else { String::new() };
    Some(format!("{date} {h:02}:{mi:02}:{sec:02}{frac}"))
}

/// Pull the binary payload for a date column and render it. Separate from
/// `binary_date_literal` so the byte decoding stays a pure function with
/// tests that need no database.
fn unrepresentable_date_binary(
    row: &sqlx::mysql::MySqlRow, i: usize, want_time: bool,
) -> Option<String> {
    let bytes: Vec<u8> = row.try_get_unchecked(i).ok()?;
    binary_date_literal(&bytes, want_time)
}

/// Tell a binary-protocol zero date apart from a real NULL.
///
/// Under the binary protocol sqlx does not merely fail to decode a zero date,
/// it reports it as SQL NULL outright. From its `value.rs`:
///
/// ```text
/// // zero dates and date times should be treated the same as NULL
/// if matches!(ty.r#type, Date | Timestamp | Datetime) && value.starts_with(b"\0")
/// ```
///
/// That is Connector/J's `zeroDateTimeBehavior=CONVERT_TO_NULL` hardcoded with
/// no opt-out, so the early NULL return in `json_value_from_mysql_row` cannot
/// be trusted for date columns. One level down the two separate again: a zero
/// date has a payload — empty, but present — so the bytes decode as `Ok`,
/// while a genuine NULL fails with `UnexpectedNullError`.
///
/// Only date-family columns pay for the extra probe; every other type reaches
/// here on a real NULL and returns immediately.
fn zero_date_literal(row: &sqlx::mysql::MySqlRow, i: usize, class: MySqlTypeClass) -> serde_json::Value {
    use serde_json::Value;

    if !is_date_class(class) {
        return Value::Null;
    }
    // Renders "0000-00-00" from the empty payload; a genuine NULL fails the
    // fetch and falls through to Null.
    match unrepresentable_date_binary(row, i, class != MySqlTypeClass::Date) {
        Some(s) => Value::String(s),
        None => Value::Null,
    }
}

fn json_value_from_mysql_row(row: &sqlx::mysql::MySqlRow, i: usize, class: MySqlTypeClass) -> serde_json::Value {
    use serde_json::Value;
    use sqlx::ValueRef;

    // NULL first — a failed typed decode must mean "wrong type", never NULL.
    // `is_null()` is not quite the same question as "is SQL NULL" on MySQL,
    // hence the zero-date rescue; see `zero_date_literal`.
    match row.try_get_raw(i) {
        Ok(raw) if raw.is_null() => return zero_date_literal(row, i, class),
        Err(_) => return Value::Null,
        _ => {}
    }

    match class {
        MySqlTypeClass::Bool => {
            if let Ok(v) = row.try_get::<bool, _>(i) { return Value::Bool(v); }
        }
        MySqlTypeClass::Int => {
            // signed first, then UNSIGNED (id columns!) — sqlx refuses i64←unsigned
            if let Ok(v) = row.try_get::<i64, _>(i) { return Value::from(v); }
            if let Ok(v) = row.try_get::<u64, _>(i) { return Value::from(v); }
            if let Ok(v) = row.try_get::<bool, _>(i) { return Value::Bool(v); } // BIT(1)
        }
        MySqlTypeClass::Decimal => {
            // Keep the exact scale from the DB (0 → "0.00" for DECIMAL(x,2)) —
            // f64 would drop trailing zeros. Rendered as string, right-aligned by the grid.
            if let Ok(v) = row.try_get::<rust_decimal::Decimal, _>(i) {
                return Value::String(v.to_string());
            }
        }
        MySqlTypeClass::Float => {
            if let Ok(v) = row.try_get::<f64, _>(i) {
                return super::types::json_f64(v);
            }
            if let Ok(v) = row.try_get::<f32, _>(i) {
                return super::types::json_f64(v as f64);
            }
        }
        MySqlTypeClass::DateTime => {
            if let Ok(v) = row.try_get::<chrono::NaiveDateTime, _>(i) {
                return Value::String(v.format("%Y-%m-%d %H:%M:%S%.f").to_string());
            }
            if let Ok(v) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(i) {
                return Value::String(v.format("%Y-%m-%d %H:%M:%S%.f").to_string());
            }
        }
        MySqlTypeClass::Date => {
            if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(i) {
                return Value::String(v.format("%Y-%m-%d").to_string());
            }
        }
        MySqlTypeClass::Time => {
            if let Ok(v) = row.try_get::<chrono::NaiveTime, _>(i) {
                return Value::String(v.format("%H:%M:%S%.f").to_string());
            }
            if let Ok(v) = row.try_get::<chrono::TimeDelta, _>(i) {
                return Value::String(format!("{}s", v.num_seconds()));
            }
        }
        MySqlTypeClass::Json => {
            if let Ok(v) = row.try_get::<serde_json::Value, _>(i) { return v; }
        }
        MySqlTypeClass::Binary => {
            // Cloud SQL serves SHOW / information_schema text as VARBINARY —
            // show valid UTF-8 as text, hex only for true binary payloads.
            if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(i) {
                return match String::from_utf8(v) {
                    Ok(s) => Value::String(s),
                    Err(e) => Value::String(hex::encode(e.into_bytes())),
                };
            }
        }
        MySqlTypeClass::Other => {}
    }

    // Both date branches above can fail on a value MySQL will happily store but
    // chrono cannot hold ('0000-00-00', '2020-00-15'). Show the server's own
    // literal rather than letting it fall through to NULL. Text first — that
    // is the editor's protocol and it carries the literal directly; the binary
    // form is the data browser, which binds filter values and so prepares.
    if is_date_class(class) {
        if let Some(s) = unrepresentable_date_text(row, i) {
            return Value::String(s);
        }
        if let Some(s) = unrepresentable_date_binary(row, i, class != MySqlTypeClass::Date) {
            return Value::String(s);
        }
    }
    if let Ok(s) = row.try_get::<String, _>(i) {
        return Value::String(s);
    }
    // last resort: raw bytes, lossy
    row.try_get::<Option<Vec<u8>>, _>(i)
        .ok()
        .flatten()
        .map(|b| Value::String(String::from_utf8_lossy(&b).into_owned()))
        .unwrap_or(Value::Null)
}

/// Top level: list databases.
/// Cloud SQL / some MySQL 8 configs return SHOW and information_schema
/// columns as VARBINARY — a typed String decode then fails. Always fall
/// back to lossy UTF-8 from raw bytes.
pub(crate) fn lossy_str(row: &sqlx::mysql::MySqlRow, i: usize) -> String {
    if let Ok(s) = row.try_get::<String, _>(i) { return s; }
    if let Ok(Some(b)) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return String::from_utf8_lossy(&b).into_owned();
    }
    String::new()
}

pub async fn list_databases(pool: &MySqlPool) -> Result<Vec<SchemaNode>> {
    let rows = sqlx::query("SHOW DATABASES").fetch_all(pool).await?;
    Ok(rows.iter()
        .map(|r| SchemaNode::Database { name: lossy_str(r, 0) })
        .collect())
}

/// Tables + views inside a database.
pub async fn list_schema(pool: &MySqlPool, database: Option<&str>) -> Result<Vec<SchemaNode>> {
    if let Some(db) = database {
        list_tables(pool, db).await
    } else {
        list_databases(pool).await
    }
}

pub async fn list_tables(pool: &MySqlPool, database: &str) -> Result<Vec<SchemaNode>> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME, TABLE_TYPE \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_TYPE, TABLE_NAME"
    )
    .bind(database)
    .fetch_all(pool).await?;

    let mut nodes: Vec<SchemaNode> = rows.iter().map(|r| {
        let name = lossy_str(r, 0);
        match lossy_str(r, 1).as_str() {
            "VIEW" => SchemaNode::View { name, schema: Some(database.to_string()) },
            // MariaDB 10.3+ has real sequences, and lists them here as
            // TABLE_TYPE = 'SEQUENCE'. Anything-not-a-view-is-a-table put them
            // in the table list, where they looked like ordinary tables and
            // were offered a designer and a row count that mean nothing for a
            // sequence. `information_schema.SEQUENCES` would be the richer
            // source but only exists from 11.0 — TABLE_TYPE works on every
            // version that has sequences at all.
            "SEQUENCE" => SchemaNode::Sequence { name, schema: Some(database.to_string()) },
            // MariaDB reports a system-versioned table as its own TABLE_TYPE.
            // It is still a table — browsable, alterable — so it stays a Table
            // node; the flag is what makes the versioning visible at all.
            other => SchemaNode::Table {
                name, schema: Some(database.to_string()), row_count: None,
                partition_of: None,
                temporal: other == "SYSTEM VERSIONED",
            },
        }
    }).collect();

    // Routines / triggers / events — best-effort (a restricted account may
    // lack access to these information_schema views; tables still list).
    let routines = sqlx::query(
        "SELECT ROUTINE_NAME, ROUTINE_TYPE \
         FROM information_schema.ROUTINES \
         WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME"
    )
    .bind(database)
    .fetch_all(pool).await.unwrap_or_default();
    for r in &routines {
        nodes.push(SchemaNode::Routine {
            name: lossy_str(r, 0),
            schema: Some(database.to_string()),
            routine_type: lossy_str(r, 1),
        });
    }

    let triggers = sqlx::query(
        "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME"
    )
    .bind(database)
    .fetch_all(pool).await.unwrap_or_default();
    for r in &triggers {
        nodes.push(SchemaNode::Trigger {
            name: lossy_str(r, 0),
            schema: Some(database.to_string()),
            table: Some(lossy_str(r, 1)),
        });
    }

    let events = sqlx::query(
        "SELECT EVENT_NAME FROM information_schema.EVENTS \
         WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME"
    )
    .bind(database)
    .fetch_all(pool).await.unwrap_or_default();
    for r in &events {
        nodes.push(SchemaNode::Event {
            name: lossy_str(r, 0),
            schema: Some(database.to_string()),
        });
    }

    Ok(nodes)
}

/// Columns + indexes for a table.
pub async fn list_columns(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<SchemaNode>> {
    let cols = sqlx::query(
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION"
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool).await?;

    let mut nodes: Vec<SchemaNode> = cols.iter().map(|r| {
        SchemaNode::Column {
            name: lossy_str(r, 0),
            type_name: lossy_str(r, 1),
            nullable: lossy_str(r, 2) == "YES",
            primary_key: lossy_str(r, 3) == "PRI",
        }
    }).collect();

    // Indexes — ONE query for all of them, grouped client-side. The old
    // shape issued one extra STATISTICS query per index: dozens of sequential
    // round trips per tree expansion over VPN/tunnel latency. COLUMN_NAME is
    // NULL for functional key parts (MySQL 8.0.13+) — rendered as their
    // expression when the server has the column, plain column names otherwise.
    let key_rows = sqlx::query(
        "SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY INDEX_NAME, SEQ_IN_INDEX"
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool).await?;

    let mut current: Option<(String, bool, Vec<String>)> = None;
    for row in &key_rows {
        let idx_name = lossy_str(row, 0);
        let non_unique: i64 = row.try_get::<i64, _>(1)
            .unwrap_or_else(|_| lossy_str(row, 1).parse().unwrap_or(1));
        let col = lossy_str(row, 3);
        let sub_part: Option<i64> = row.try_get::<Option<i64>, _>(4).unwrap_or(None);
        let part = match sub_part {
            Some(n) if !col.is_empty() => format!("{col}({n})"),
            _ => col,
        };
        match current.as_mut() {
            Some((name, _, cols)) if *name == idx_name => cols.push(part),
            _ => {
                if let Some((name, unique, columns)) = current.take() {
                    nodes.push(SchemaNode::Index { name, unique, columns });
                }
                current = Some((idx_name, non_unique == 0, vec![part]));
            }
        }
    }
    if let Some((name, unique, columns)) = current.take() {
        nodes.push(SchemaNode::Index { name, unique, columns });
    }

    Ok(nodes)
}

/// Return SHOW CREATE … DDL.
/// Run a SHOW CREATE … statement and pull whichever column holds the DDL:
/// named "Create *" for most objects (position and column count differ per
/// kind); SHOW CREATE TRIGGER names it "SQL Original Statement".
async fn show_create(pool: &MySqlPool, stmt: &str) -> Option<String> {
    let row = sqlx::query(AssertSqlSafe(stmt)).fetch_one(pool).await.ok()?;
    for (i, col) in row.columns().iter().enumerate() {
        let name = col.name().to_ascii_lowercase();
        if name.starts_with("create") || name == "sql original statement" {
            if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
                return Some(s);
            }
            if let Ok(Some(b)) = row.try_get::<Option<Vec<u8>>, _>(i) {
                return Some(String::from_utf8_lossy(&b).into_owned());
            }
        }
    }
    None
}

pub async fn get_ddl(pool: &MySqlPool, database: &str, object: &str) -> Result<String> {
    // Tables and views first (most common), then routines / triggers / events
    let kinds = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"];
    for kind in kinds {
        let stmt = format!("SHOW CREATE {} `{}`.`{}`", kind,
            database.replace('`', "``"), object.replace('`', "``"));
        if let Some(ddl) = show_create(pool, &stmt).await {
            return Ok(ddl);
        }
    }
    anyhow::bail!("object `{}`.`{}` not found", database, object)
}

#[cfg(test)]
mod statement_timeout_tests {
    use super::*;

    fn cfg(secs: Option<u32>) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(crate::db::types::Engine::Mysql, "t");
        c.statement_timeout_secs = secs;
        c
    }

    /// `None` must leave the server's own setting untouched. A default ceiling
    /// would look prudent and quietly kill long imports and ALTERs.
// Live check: does the configured ceiling actually reach the server session?
#[tokio::test]
#[ignore = "needs local MySQL on 3306"]
async fn statement_timeout_reaches_the_server_session() {
    use crate::db::types::{ConnectionConfig, Engine};
    let mut cfg = ConnectionConfig::new(Engine::Mysql, "t");
    cfg.host = Some("127.0.0.1".into());
    cfg.port = Some(3306);
    cfg.user = Some("root".into());
    cfg.statement_timeout_secs = Some(7);

    let pool = open_pool(&cfg, Some("root".into()), None, 1).await.expect("connect");
    let r = execute(&pool, "SELECT @@SESSION.max_execution_time").await.expect("query");
    assert_eq!(r.rows[0][0].to_string().trim_matches('"'), "7000",
               "the ceiling did not reach the session");

    // And that it actually bites on a read.
    let t = std::time::Instant::now();
    let mut cfg2 = cfg.clone();
    cfg2.statement_timeout_secs = Some(1);
    let pool2 = open_pool(&cfg2, Some("root".into()), None, 1).await.expect("connect");
    let _ = execute(&pool2, "SELECT SLEEP(3)").await;
    assert!(t.elapsed().as_millis() < 2500,
            "SELECT SLEEP(3) was not bounded: took {:?}", t.elapsed());
}

    #[test]
    fn no_timeout_configured_means_no_statement_is_issued() {
        assert!(cfg(None).statement_timeout_secs.is_none());
        assert_eq!(crate::db::types::DEFAULT_STATEMENT_TIMEOUT_SECS, None);
    }

    /// Zero is the explicit "unbounded" spelling, not a zero-length ceiling —
    /// `max_execution_time = 0` would be correct MySQL for unbounded, but
    /// sending it would still stamp on a server-side default the user may
    /// have set deliberately.
    #[test]
    fn zero_is_treated_as_unbounded_and_sends_nothing() {
        assert_eq!(cfg(Some(0)).statement_timeout_secs.filter(|s| *s > 0), None);
    }

    #[test]
    fn seconds_become_milliseconds_for_mysql() {
        let secs = cfg(Some(30)).statement_timeout_secs.unwrap();
        assert_eq!(u64::from(secs).saturating_mul(1000), 30_000);
    }

    /// u32::MAX seconds in milliseconds overflows u32 and would wrap; the
    /// widening to u64 plus saturating_mul is what stops a huge ceiling from
    /// becoming a tiny one.
    #[test]
    fn an_enormous_ceiling_does_not_wrap_into_a_small_one() {
        let ms = u64::from(u32::MAX).saturating_mul(1000);
        assert!(ms > u64::from(u32::MAX), "widening lost the value");
    }
}

#[cfg(test)]
mod tests {
    use super::valid_session_param;

    #[test]
    fn accepts_plain_identifiers() {
        assert!(valid_session_param("sql_mode", "STRICT_ALL_TABLES"));
        assert!(valid_session_param("wait_timeout", "600"));
        assert!(valid_session_param("optimizer_switch", "'index_merge=off'") == false); // quotes rejected
        assert!(valid_session_param("_private", "1"));
        assert!(valid_session_param("session.transaction_isolation", "'READ-COMMITTED'") == false);
    }

    #[test]
    fn rejects_bad_keys() {
        assert!(!valid_session_param("", "1"));
        assert!(!valid_session_param("1abc", "1"));
        assert!(!valid_session_param(".abc", "1"));
        assert!(!valid_session_param("a b", "1"));
        assert!(!valid_session_param("a`b", "1"));
        assert!(!valid_session_param("a=b", "1"));
        assert!(!valid_session_param("a;b", "1"));
        assert!(!valid_session_param("é", "1"));
    }

    #[test]
    fn rejects_injection_in_values() {
        assert!(!valid_session_param("sql_mode", "x; DROP TABLE t"));
        assert!(!valid_session_param("sql_mode", "x -- comment"));
        assert!(!valid_session_param("sql_mode", "x /* y */"));
        assert!(!valid_session_param("sql_mode", "x */ y"));
        assert!(!valid_session_param("sql_mode", "it's"));
        assert!(!valid_session_param("sql_mode", "say \"hi\""));
        assert!(!valid_session_param("sql_mode", "a\nb"));
        assert!(!valid_session_param("sql_mode", "a\0b"));
        assert!(valid_session_param("sql_mode", "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES"));
    }

    // "localhost" is pinned to 127.0.0.1 for plain TCP so pooled re-dials
    // never re-resolve it (see the note in build_options) — but a unix-socket
    // config and an SSH host_override must keep their original target.
    #[test]
    fn localhost_pinned_to_ipv4_loopback() {
        use super::build_options;
        use crate::db::types::{ConnectionConfig, Engine};

        let mut cfg = ConnectionConfig::new(Engine::Mysql, "t");
        cfg.host = Some("localhost".into());
        let opts = build_options(&cfg, None, None).unwrap();
        assert_eq!(opts.get_host(), "127.0.0.1");

        // Case-insensitive
        cfg.host = Some("LOCALHOST".into());
        assert_eq!(build_options(&cfg, None, None).unwrap().get_host(), "127.0.0.1");

        // Remote hosts untouched
        cfg.host = Some("db.internal".into());
        assert_eq!(build_options(&cfg, None, None).unwrap().get_host(), "db.internal");

        // Unix socket configured → host is irrelevant; leave it alone
        cfg.host = Some("localhost".into());
        cfg.socket_path = Some("/tmp/mysql.sock".into());
        assert_eq!(build_options(&cfg, None, None).unwrap().get_host(), "localhost");
        cfg.socket_path = None;

        // SSH tunnel override wins (already 127.0.0.1:local_port)
        let opts = build_options(&cfg, None, Some(("127.0.0.1", 13306))).unwrap();
        assert_eq!(opts.get_host(), "127.0.0.1");
        assert_eq!(opts.get_port(), 13306);
    }

    /// Live: a schema's object list surfaces tables, views, routines,
    /// triggers AND events, and get_ddl resolves SHOW CREATE for each kind.
    /// Self-contained: creates + drops its own fixture schema.
    ///   TXUI_TEST_CONN=Lo80 cargo test --lib list_schema_objects_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn list_schema_objects_live() {
        let Ok(name) = std::env::var("TXUI_TEST_CONN") else { return };
        let dir = crate::storage::default_data_dir();
        let configs = crate::storage::load(&dir).expect("read connections.json");
        let config = configs.values().find(|c| c.name == name).expect("connection not found").clone();
        let password = crate::secretstore::get(&dir, &config.keychain_key());
        let pool = super::open_pool(&config, password, None, 2).await.unwrap();
        use crate::db::types::SchemaNode;

        let db = "txui_schema_objects_test";
        for stmt in [
            format!("DROP DATABASE IF EXISTS `{db}`"),
            format!("CREATE DATABASE `{db}`"),
            format!("CREATE TABLE `{db}`.t1 (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50))"),
            format!("CREATE VIEW `{db}`.v1 AS SELECT * FROM `{db}`.t1"),
            format!("CREATE PROCEDURE `{db}`.p1() SELECT 1"),
            format!("CREATE FUNCTION `{db}`.f1() RETURNS INT DETERMINISTIC RETURN 1"),
            format!("CREATE TRIGGER `{db}`.trg1 BEFORE INSERT ON `{db}`.t1 FOR EACH ROW SET NEW.name = NEW.name"),
            format!("CREATE EVENT `{db}`.ev1 ON SCHEDULE EVERY 1 DAY DO SELECT 1"),
        ] {
            super::execute(&pool, &stmt).await.unwrap();
        }

        let nodes = super::list_tables(&pool, db).await.unwrap();
        let has = |pred: fn(&SchemaNode) -> bool| nodes.iter().any(pred);
        assert!(has(|n| matches!(n, SchemaNode::Table { name, .. } if name == "t1")));
        assert!(has(|n| matches!(n, SchemaNode::View { name, .. } if name == "v1")));
        assert!(has(|n| matches!(n, SchemaNode::Routine { name, routine_type, .. } if name == "p1" && routine_type == "PROCEDURE")));
        assert!(has(|n| matches!(n, SchemaNode::Routine { name, routine_type, .. } if name == "f1" && routine_type == "FUNCTION")));
        assert!(has(|n| matches!(n, SchemaNode::Trigger { name, .. } if name == "trg1")));
        assert!(has(|n| matches!(n, SchemaNode::Event { name, .. } if name == "ev1")));

        for (obj, needle) in [
            ("v1", "VIEW"), ("p1", "PROCEDURE"), ("f1", "FUNCTION"),
            ("trg1", "TRIGGER"), ("ev1", "EVENT"),
        ] {
            let ddl = super::get_ddl(&pool, db, obj).await
                .unwrap_or_else(|e| panic!("get_ddl {obj}: {e}"));
            assert!(ddl.to_uppercase().contains(needle), "get_ddl {obj} missing {needle}: {ddl}");
        }

        super::execute(&pool, &format!("DROP DATABASE `{db}`")).await.unwrap();
    }
}

#[cfg(test)]
mod zero_date_tests {
    use super::*;
    use crate::db::types::{ConnectionConfig, Engine};

    /// Byte-level tests for the binary decoder. Pure — the payloads are the
    /// ones a live MySQL 8.0.46 actually sent, copied from the wire.
    mod binary_payloads {
        use super::super::binary_date_literal as decode;

        #[test]
        fn an_ordinary_date() {
            // len 4, year 0x07E4 = 2020 little-endian, month 5, day 1
            assert_eq!(decode(&[4, 228, 7, 5, 1], false).as_deref(), Some("2020-05-01"));
        }

        #[test]
        fn an_ordinary_datetime() {
            assert_eq!(decode(&[7, 228, 7, 5, 1, 10, 0, 0], true).as_deref(),
                       Some("2020-05-01 10:00:00"));
        }

        /// The value the previous round called unreachable.
        #[test]
        fn a_partially_zero_date() {
            assert_eq!(decode(&[4, 228, 7, 0, 15], false).as_deref(), Some("2020-00-15"));
        }

        /// MySQL omits trailing zero components, so a midnight DATETIME
        /// arrives with a DATE-shaped length and must still render its time.
        #[test]
        fn a_midnight_datetime_arrives_truncated() {
            assert_eq!(decode(&[4, 228, 7, 0, 15], true).as_deref(),
                       Some("2020-00-15 00:00:00"));
        }

        #[test]
        fn an_empty_payload_is_the_zero_date() {
            assert_eq!(decode(&[0], false).as_deref(), Some("0000-00-00"));
            assert_eq!(decode(&[0], true).as_deref(), Some("0000-00-00 00:00:00"));
        }

        /// `%.f` in the chrono path prints nothing at zero, so the two must
        /// agree: a fraction appears only when there is one.
        #[test]
        fn microseconds_survive_and_are_omitted_when_zero() {
            // 123456 = 0x0001E240, little-endian
            let with = [11u8, 228, 7, 5, 1, 10, 0, 0, 0x40, 0xE2, 0x01, 0x00];
            assert_eq!(decode(&with, true).as_deref(), Some("2020-05-01 10:00:00.123456"));
            assert_eq!(decode(&[7, 228, 7, 5, 1, 10, 0, 0], true).as_deref(),
                       Some("2020-05-01 10:00:00"));
        }

        /// A text-protocol payload must never be mistaken for a binary one.
        /// ASCII digits are 0x30-0x39, so "2020-00-15" declares a length of 50
        /// and is rejected rather than silently mis-decoded.
        #[test]
        fn ascii_is_not_mistaken_for_packed_bytes() {
            assert_eq!(decode(b"2020-00-15", false), None);
            assert_eq!(decode(b"0000-00-00 00:00:00", true), None);
        }

        #[test]
        fn a_truncated_or_odd_length_payload_is_refused() {
            assert_eq!(decode(&[4, 228, 7], false), None,  "declared 4, carries 2");
            assert_eq!(decode(&[5, 1, 2, 3, 4, 5], false), None, "5 is not a legal length");
            assert_eq!(decode(&[], false), None);
        }
    }

    /// Connect to the fixture, building it if it is not there.
    ///
    /// It used to require `dev/mysql_zerodate_fixture.sql` to have been applied
    /// by hand, which meant these tests failed for anyone who had not read that
    /// instruction — and failed again the moment someone tidied the database
    /// up. A test that needs a fixture should make one. The SQL is kept in step
    /// with `dev/mysql_zerodate_fixture.sql`, which stays for reading.
    async fn fixture_pool() -> sqlx::MySqlPool {
        let mut cfg = ConnectionConfig::new(Engine::Mysql, "t");
        cfg.host = Some("127.0.0.1".into());
        cfg.port = Some(3306);
        cfg.user = Some("root".into());

        // No database yet — the fixture may not exist.
        let admin = open_pool(&cfg, Some("root".into()), None, 1).await.expect("connect");
        let mut conn = admin.acquire().await.expect("acquire");
        for stmt in [
            "CREATE DATABASE IF NOT EXISTS txui_zerodate",
            "USE txui_zerodate",
            // Writing a zero date needs a permissive sql_mode. Reading one back
            // needs nothing special, which is the whole problem.
            "SET SESSION sql_mode = ''",
            "DROP TABLE IF EXISTS legacy",
            "CREATE TABLE legacy (id INT PRIMARY KEY, d DATE, dt DATETIME, ts TIMESTAMP NULL)",
            "INSERT INTO legacy VALUES \
               (1, '0000-00-00', '0000-00-00 00:00:00', NULL), \
               (2, '2020-05-01', '2020-05-01 10:00:00', '2020-05-01 10:00:00'), \
               (3, '2020-00-15', '2020-00-15 00:00:00', NULL), \
               (4, NULL, NULL, NULL)",
            "DROP TABLE IF EXISTS emptyish",
            "CREATE TABLE emptyish (id INT PRIMARY KEY, s VARCHAR(20), b BLOB, \
               t TIME, n VARCHAR(20))",
            "INSERT INTO emptyish VALUES (1, '', '', '00:00:00', NULL), (2, 'x', 'x', '01:02:03', 'y')",
        ] {
            // One connection held throughout: `USE` and `SET SESSION` are
            // per-session state, so letting the pool hand out a second
            // connection would silently lose both and write the rows into the
            // wrong database under a strict sql_mode that rejects them.
            sqlx::raw_sql(stmt).execute(&mut *conn).await
                .unwrap_or_else(|e| panic!("building the fixture failed at `{stmt}`: {e}"));
        }
        drop(conn);
        admin.close().await;

        cfg.database = Some("txui_zerodate".into());
        open_pool(&cfg, Some("root".into()), None, 1).await.expect("connect")
    }

    /// Legacy MySQL under a permissive `sql_mode` stores `'0000-00-00'`, which
    /// no Rust date type can represent. Connector/J has a whole property for
    /// it (`zeroDateTimeBehavior`); sqlx hardcodes one of that property's
    /// modes and calls such a value NULL.
    ///
    /// The table must stay readable (it does — this was never a hard failure)
    /// **and** a zero date must not masquerade as a NULL.
    ///
    /// Fixture: `dev/mysql_zerodate_fixture.sql`.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306 with the txui_zerodate fixture"]
    async fn a_zero_date_is_not_reported_as_null() {
        let pool = fixture_pool().await;
        let r = execute(&pool, "SELECT id, d, dt FROM legacy ORDER BY id").await
            .expect("a legacy table with zero dates must still be readable");
        assert_eq!(r.rows.len(), 4, "all four rows must come back");

        // id=1: all-zero date and datetime — rendered as MySQL renders them.
        assert_eq!(r.rows[0][1], serde_json::json!("0000-00-00"));
        assert_eq!(r.rows[0][2], serde_json::json!("0000-00-00 00:00:00"));

        // id=2: an ordinary date is untouched by the rescue path.
        assert_eq!(r.rows[1][1], serde_json::json!("2020-05-01"));

        // id=4: a genuine NULL still reads as NULL. This is the assertion that
        // makes the first one worth anything — the two must not collapse.
        assert_eq!(r.rows[3][1], serde_json::Value::Null);
        assert_eq!(r.rows[3][2], serde_json::Value::Null);
    }

    /// A partially zero date is legal in old MySQL and equally unrepresentable
    /// in chrono. The text-protocol rescue recovers it verbatim, so it is not
    /// rounded, not nulled, and not guessed at.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306 with the txui_zerodate fixture"]
    async fn a_partially_zero_date_keeps_its_real_value() {
        let pool = fixture_pool().await;
        let r = execute(&pool, "SELECT id, d, dt FROM legacy WHERE id = 3").await.expect("query");
        assert_eq!(r.rows[0][1], serde_json::json!("2020-00-15"));
        assert_eq!(r.rows[0][2], serde_json::json!("2020-00-15 00:00:00"));
    }

    /// The data browser binds its filter values, so it runs on the **binary**
    /// protocol while the editor runs on text. Both must show the same cell.
    ///
    /// This is the regression that mattered: `2020-00-15` rendered correctly
    /// in the editor and as NULL in the browser, for the same row.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306 with the txui_zerodate fixture"]
    async fn the_binary_protocol_agrees_with_the_editor() {
        use sqlx::{Row as _, Column as _, TypeInfo as _};
        let pool = fixture_pool().await;

        // Exactly what commands::browser::run_mysql does: sqlx::query + bind.
        let rows = sqlx::query(AssertSqlSafe(
            "SELECT id, d, dt FROM legacy WHERE id >= ? ORDER BY id".to_string()))
            .bind(1).fetch_all(&pool).await.expect("browse");
        let cell = |r: &sqlx::mysql::MySqlRow, i: usize| {
            let tn = r.columns()[i].type_info().name().to_string();
            json_value_from_row_pub(r, i, &tn)
        };

        assert_eq!(cell(&rows[0], 1), serde_json::json!("0000-00-00"));
        assert_eq!(cell(&rows[0], 2), serde_json::json!("0000-00-00 00:00:00"));
        assert_eq!(cell(&rows[1], 1), serde_json::json!("2020-05-01"));
        assert_eq!(cell(&rows[1], 2), serde_json::json!("2020-05-01 10:00:00"));
        assert_eq!(cell(&rows[2], 1), serde_json::json!("2020-00-15"),
                   "the partially-zero date is the one that used to vanish here");
        assert_eq!(cell(&rows[2], 2), serde_json::json!("2020-00-15 00:00:00"));
        assert_eq!(cell(&rows[3], 1), serde_json::Value::Null, "a real NULL stays NULL");
        assert_eq!(cell(&rows[3], 2), serde_json::Value::Null);
    }

    /// The rescue keys off a present-but-empty payload, which is also what an
    /// empty string and an empty blob look like from a distance. They must not
    /// be caught by it — and they are not, because sqlx only conflates zero
    /// values with NULL for the date family.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306 with the txui_zerodate fixture"]
    async fn empty_strings_and_blobs_are_not_collateral_damage() {
        let pool = fixture_pool().await;
        let r = execute(&pool, "SELECT id, s, b, t, n FROM emptyish ORDER BY id").await
            .expect("query");
        assert_eq!(r.rows[0][1], serde_json::json!(""),   "empty string stayed empty");
        assert_eq!(r.rows[0][2], serde_json::json!(""),   "empty blob stayed empty");
        assert_eq!(r.rows[0][3], serde_json::json!("00:00:00"), "zero TIME is a real time");
        assert_eq!(r.rows[0][4], serde_json::Value::Null, "a real NULL is still NULL");
    }
}

#[cfg(test)]
mod stmt_cache_tests {
    use super::*;
    use crate::db::types::{ConnectionConfig, Engine};

    /// Why TxUI does not expose a prepared-statement cache size.
    ///
    /// The worry that prompted the question was the classic GUI one: sqlx
    /// caches prepared statements per connection (capacity 100, not
    /// configurable through us), every statement a user types is a *distinct*
    /// statement, so a long session should pin 100 server-side prepared
    /// statements per pooled connection and eventually collide with
    /// `max_prepared_stmt_count`.
    ///
    /// It does not happen, because the premise is wrong. `execute` runs user
    /// SQL through `raw_sql`, which is the **text** protocol and prepares
    /// nothing at all. Measured against MySQL 8.0.46 (`Prepared_stmt_count`,
    /// session scope):
    ///
    /// | after | prepared |
    /// |---|---|
    /// | baseline | 0 |
    /// | 40 distinct ad-hoc queries via `execute` | **0** |
    /// | 40 *identical* `sqlx::query` calls | 1 |
    /// | 40 *distinct* `sqlx::query` calls | 41 |
    ///
    /// So only internal query shapes are ever prepared, and those are a fixed
    /// small set — bounded by 100 per connection times `pool_max` (4 by
    /// default) against a server default of 16382. A knob would be answering a
    /// question nobody can ask.
    ///
    /// This test guards the premise rather than the conclusion: if the editor
    /// path ever moves to prepared statements, the cache question is live
    /// again and this fails to say so.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn the_editor_path_prepares_nothing() {
        let mut cfg = ConnectionConfig::new(Engine::Mysql, "t");
        cfg.host = Some("127.0.0.1".into());
        cfg.port = Some(3306);
        cfg.user = Some("root".into());
        let pool = open_pool(&cfg, Some("root".into()), None, 1).await.expect("connect");

        async fn prepared(p: &sqlx::MySqlPool) -> String {
            let r = execute(p, "SHOW SESSION STATUS LIKE 'Prepared_stmt_count'").await.unwrap();
            r.rows[0][1].as_str().unwrap_or_default().to_string()
        }

        assert_eq!(prepared(&pool).await, "0", "a fresh session starts clean");
        for n in 0..40 {
            let _ = execute(&pool, &format!("SELECT {n} AS a, '{n}' AS b")).await.unwrap();
        }
        assert_eq!(prepared(&pool).await, "0",
                   "ad-hoc editor SQL started using prepared statements — the statement-cache \
                    ceiling is now reachable from user input, so revisit exposing it");
    }
}

#[cfg(test)]
mod session_timezone_tests {
    use super::*;
    use crate::db::types::{ConnectionConfig, Engine};

    /// Pins the premise behind the `tz.session_differs_from_server` tuner
    /// finding: sqlx sets `time_zone = '+00:00'` on every MySQL session, so
    /// TxUI reads a non-UTC server two hours (or whatever) off from what the
    /// `mysql` CLI shows for the same instant.
    ///
    /// If a sqlx upgrade or a call to `MySqlConnectOptions::timezone` changes
    /// this, the finding becomes wrong and starts misinforming people — so it
    /// fails here rather than there.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn our_sessions_are_pinned_to_utc() {
        let mut cfg = ConnectionConfig::new(Engine::Mysql, "t");
        cfg.host = Some("127.0.0.1".into());
        cfg.port = Some(3306);
        cfg.user = Some("root".into());
        let pool = open_pool(&cfg, Some("root".into()), None, 1).await.expect("connect");
        let r = execute(&pool,
            "SELECT @@session.time_zone AS s, @@global.time_zone AS g, NOW() AS now").await.unwrap();
        println!("session={:?} global={:?} now={:?}", r.rows[0][0], r.rows[0][1], r.rows[0][2]);
        assert_eq!(r.rows[0][0], serde_json::json!("+00:00"),
                   "sqlx no longer pins the session to UTC — recheck the \
                    tz.session_differs_from_server finding, which assumes it does");
    }

    async fn tz_pool(tz: Option<&str>) -> sqlx::MySqlPool {
        let mut cfg = ConnectionConfig::new(Engine::Mysql, "t");
        cfg.host = Some("127.0.0.1".into());
        cfg.port = Some(3306);
        cfg.user = Some("root".into());
        cfg.time_zone = tz.map(str::to_string);
        open_pool(&cfg, Some("root".into()), None, 1).await.expect("connect")
    }

    async fn session_tz(pool: &sqlx::MySqlPool) -> String {
        let r = execute(pool, "SELECT @@session.time_zone").await.unwrap();
        r.rows[0][0].as_str().unwrap_or_default().to_string()
    }

    /// The setting has to reach the server session, not just the options
    /// struct — that is the whole point of it.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn an_explicit_offset_reaches_the_session() {
        assert_eq!(session_tz(&tz_pool(Some("+05:30")).await).await, "+05:30");
    }

    /// `SYSTEM` is the spelling that makes TxUI agree with the mysql CLI, and
    /// is what the tuner finding tells people to reach for.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn system_adopts_the_servers_own_zone() {
        assert_eq!(session_tz(&tz_pool(Some("SYSTEM")).await).await, "SYSTEM");
    }

    /// Unset must not change anything — every saved connection keeps
    /// rendering exactly as it did before the setting existed.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn unset_still_means_utc() {
        assert_eq!(session_tz(&tz_pool(None).await).await, "+00:00");
        assert_eq!(session_tz(&tz_pool(Some("")).await).await, "+00:00",
                   "an empty string is 'not configured', not a zone");
    }

    /// The behaviour a user actually notices: the same instant rendered in two
    /// zones differs by the offset, and NOW() stops disagreeing with the CLI.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn the_rendered_timestamp_follows_the_zone() {
        let utc = execute(&tz_pool(None).await,
            "SELECT FROM_UNIXTIME(1700000000)").await.unwrap();
        let plus2 = execute(&tz_pool(Some("+02:00")).await,
            "SELECT FROM_UNIXTIME(1700000000)").await.unwrap();
        let (a, b) = (utc.rows[0][0].as_str().unwrap(), plus2.rows[0][0].as_str().unwrap());
        assert_eq!(a, "2023-11-14 22:13:20", "UTC rendering changed");
        assert_eq!(b, "2023-11-15 00:13:20", "the +02:00 session did not shift");
        assert_ne!(a, b, "the zone made no difference — the setting is not reaching the server");
    }
}

#[cfg(test)]
mod clock_probe_tests {
    use super::*;
    use crate::db::types::{ConnectionConfig, Engine};

    const PROBE: &str = "SET @txui_tz_save = @@session.time_zone;\n\
         SET SESSION time_zone = 'SYSTEM';\n\
         SELECT UNIX_TIMESTAMP() AS epoch_s,\n\
                TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offset_s,\n\
                @@system_time_zone AS zone;\n\
         SET SESSION time_zone = @txui_tz_save;";

    async fn pool() -> sqlx::MySqlPool {
        let mut cfg = ConnectionConfig::new(Engine::Mysql, "t");
        cfg.host = Some("127.0.0.1".into());
        cfg.port = Some(3306);
        cfg.user = Some("root".into());
        open_pool(&cfg, Some("root".into()), None, 1).await.expect("connect")
    }

    /// `SELECT NOW()` is the obvious probe and it is wrong: our sessions are
    /// pinned to UTC, so it reports UTC for every server in the fleet. The
    /// probe has to switch the zone to read the real offset.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn the_probe_reports_the_servers_offset_not_the_sessions() {
        let p = pool().await;
        let naive = execute(&p, "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW())").await.unwrap();
        assert_eq!(naive.rows[0][0].as_str().unwrap_or("0").trim_matches('"'), "0",
                   "the session is not pinned to UTC — this test no longer proves anything");

        let r = execute(&p, PROBE).await.expect("probe");
        let row = &r.rows[0];
        let offset: i64 = row[1].as_str().and_then(|s| s.parse().ok())
            .or_else(|| row[1].as_i64()).expect("offset");
        // Any real zone; the local server is CEST (+7200) but the assertion
        // that matters is that it is a whole number of minutes and plausible.
        assert!(offset.abs() <= 14 * 3600, "implausible offset {offset}");
        assert_eq!(offset % 60, 0, "offset is not a whole number of minutes: {offset}");
        println!("offset={offset}s zone={:?} epoch={:?}", row[2], row[0]);
    }

    /// The probe mutates session state to read the offset. It must put it
    /// back, or every pooled connection it touches starts rendering
    /// timestamps in a different zone than the others.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn the_probe_leaves_the_connection_exactly_as_it_found_it() {
        let p = pool().await;
        let before = execute(&p, "SELECT @@session.time_zone").await.unwrap();
        let _ = execute(&p, PROBE).await.expect("probe");
        let after = execute(&p, "SELECT @@session.time_zone").await.unwrap();
        assert_eq!(before.rows[0][0], after.rows[0][0],
                   "the probe left the session in a different time zone");
        assert_eq!(after.rows[0][0], serde_json::json!("+00:00"));
    }

    /// The epoch is zone-independent, so it must agree with ours regardless of
    /// where the server thinks it is — that is what makes skew measurable.
    #[tokio::test]
    #[ignore = "needs local MySQL on 3306"]
    async fn the_epoch_agrees_with_ours_so_skew_is_measurable() {
        let p = pool().await;
        let r = execute(&p, PROBE).await.expect("probe");
        let server: i64 = r.rows[0][0].as_str().and_then(|s| s.parse::<f64>().ok())
            .map(|f| f as i64)
            .or_else(|| r.rows[0][0].as_i64()).expect("epoch");
        let ours = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        assert!((server - ours).abs() < 5,
                "server epoch {server} vs ours {ours} — a local server should not be skewed");
    }
}

#[cfg(test)]
mod mariadb_live_tests {
    //! Against the local MariaDB fleet:
    //!
    //! ```sh
    //! dbctl start maria           # 10.6 · 10.11 · 11.4 · 11.8 on 3309–3312
    //! cargo test --lib mariadb_live -- --ignored --test-threads=1
    //! ```
    //!
    //! MariaDB is not a slightly different MySQL for the catalog: it has
    //! objects MySQL does not, and the schema tree used to sort them by
    //! "is it a view, else it is a table", which quietly made every sequence a
    //! table.
    use super::*;
    use crate::db::types::Engine;

    /// 10.6 is the oldest supported and 11.8 the current LTS; a difference
    /// present on both is a fork difference rather than a version one.
    const PORTS: &[u16] = &[3309, 3312];

    async fn pool(port: u16) -> MySqlPool {
        let mut cfg = ConnectionConfig::new(Engine::Mysql, "t");
        cfg.host = Some("127.0.0.1".into());
        cfg.port = Some(port);
        cfg.user = Some("root".into());
        open_pool(&cfg, Some("root".into()), None, 2).await
            .unwrap_or_else(|e| panic!("connect :{port} — is `dbctl start maria` running? {e}"))
    }

    async fn is_mariadb(p: &MySqlPool) -> bool {
        sqlx::query_scalar::<_, String>("SELECT VERSION()").fetch_one(p).await
            .map(|v| v.to_lowercase().contains("mariadb")).unwrap_or(false)
    }

    /// A sequence is not a table. It has no rows to count, no columns to
    /// design, and offering it as one is how a schema tree lies about what is
    /// in the database.
    #[tokio::test]
    #[ignore = "needs the local MariaDB fleet"]
    async fn a_sequence_is_listed_as_a_sequence_not_a_table() {
        for &port in PORTS {
            let p = pool(port).await;
            assert!(is_mariadb(&p).await, ":{port} is not MariaDB");
            sqlx::raw_sql("CREATE DATABASE IF NOT EXISTS txui_seq").execute(&p).await.unwrap();
            sqlx::raw_sql("CREATE OR REPLACE SEQUENCE txui_seq.s1 START WITH 100 INCREMENT BY 5")
                .execute(&p).await.unwrap();
            sqlx::raw_sql("CREATE TABLE IF NOT EXISTS txui_seq.t1 (id INT PRIMARY KEY)")
                .execute(&p).await.unwrap();

            let nodes = list_tables(&p, "txui_seq").await.expect("list");
            let seq = nodes.iter().any(|n| matches!(n,
                SchemaNode::Sequence { name, .. } if name == "s1"));
            let as_table = nodes.iter().any(|n| matches!(n,
                SchemaNode::Table { name, .. } if name == "s1"));
            assert!(seq, ":{port} did not list s1 as a sequence");
            assert!(!as_table, ":{port} listed the sequence as a table");

            // …and an ordinary table is still an ordinary table.
            assert!(nodes.iter().any(|n| matches!(n,
                SchemaNode::Table { name, .. } if name == "t1")), ":{port} lost the real table");

            sqlx::raw_sql("DROP DATABASE txui_seq").execute(&p).await.unwrap();
        }
    }

    /// A system-versioned table keeps every historical row, and says so
    /// nowhere else: MariaDB hides `row_start` / `row_end` from
    /// `information_schema.COLUMNS`, so it is indistinguishable from an
    /// ordinary table in the tree. It reports its own TABLE_TYPE, which is the
    /// only signal available.
    #[tokio::test]
    #[ignore = "needs the local MariaDB fleet"]
    async fn a_system_versioned_table_is_marked_as_such() {
        for &port in PORTS {
            let p = pool(port).await;
            sqlx::raw_sql("CREATE DATABASE IF NOT EXISTS txui_sv").execute(&p).await.unwrap();
            sqlx::raw_sql("CREATE OR REPLACE TABLE txui_sv.acct (id INT PRIMARY KEY) WITH SYSTEM VERSIONING")
                .execute(&p).await.unwrap();
            sqlx::raw_sql("CREATE OR REPLACE TABLE txui_sv.plain (id INT PRIMARY KEY)")
                .execute(&p).await.unwrap();

            let nodes = list_tables(&p, "txui_sv").await.expect("list");
            let versioned = nodes.iter().find(|n| matches!(n,
                SchemaNode::Table { name, .. } if name == "acct"));
            let plain = nodes.iter().find(|n| matches!(n,
                SchemaNode::Table { name, .. } if name == "plain"));

            // It is still a table — browsable and alterable — so it must not
            // have been sorted into some other node kind.
            assert!(versioned.is_some(), ":{port} lost the versioned table entirely");
            assert!(matches!(versioned.unwrap(), SchemaNode::Table { temporal: true, .. }),
                    ":{port} did not mark the versioned table");
            assert!(matches!(plain.unwrap(), SchemaNode::Table { temporal: false, .. }),
                    ":{port} marked an ordinary table as versioned");

            sqlx::raw_sql("DROP DATABASE txui_sv").execute(&p).await.unwrap();
        }
    }

    /// The version string a driver sees, not the one `SELECT VERSION()` gives.
    /// MariaDB 10.x prefixes `5.5.5-` in the handshake, and sqlx surfaces what
    /// the handshake said — so anything version-gating off this must cope.
    #[tokio::test]
    #[ignore = "needs the local MariaDB fleet"]
    async fn the_server_reports_itself_as_mariadb() {
        for &port in PORTS {
            let p = pool(port).await;
            let v: String = sqlx::query_scalar("SELECT VERSION()").fetch_one(&p).await.unwrap();
            assert!(v.to_lowercase().contains("mariadb"), ":{port} said {v}");
        }
    }

    /// The measured plan MySQL cannot produce and MariaDB can, in the form the
    /// JSON parser expects. `EXPLAIN ANALYZE` is a syntax error here.
    #[tokio::test]
    #[ignore = "needs the local MariaDB fleet"]
    async fn analyze_format_json_is_the_measured_plan() {
        for &port in PORTS {
            let p = pool(port).await;
            let mut conn = p.acquire().await.unwrap();
            // A real table: with no table in the query MariaDB reports "No
            // tables used" and emits no measurements at all, which would make
            // this pass or fail for the wrong reason.
            sqlx::raw_sql("CREATE DATABASE IF NOT EXISTS txui_plan").execute(&mut *conn).await.unwrap();
            sqlx::raw_sql("CREATE TABLE IF NOT EXISTS txui_plan.t (id INT PRIMARY KEY, v INT)")
                .execute(&mut *conn).await.unwrap();
            sqlx::raw_sql("INSERT IGNORE INTO txui_plan.t VALUES (1,1),(2,2),(3,3)")
                .execute(&mut *conn).await.unwrap();
            let q = "SELECT * FROM txui_plan.t WHERE v > 1";

            assert!(execute(&mut *conn, &format!("EXPLAIN ANALYZE {q}")).await.is_err(),
                    ":{port} accepted EXPLAIN ANALYZE — the flavour split is unnecessary");

            let r = execute(&mut *conn, &format!("ANALYZE FORMAT=JSON {q}")).await
                .expect("ANALYZE FORMAT=JSON must work on MariaDB");
            let text = r.rows.first().and_then(|row| row.first())
                .map(|v| v.to_string()).unwrap_or_default();
            assert!(text.contains("r_total_time_ms") || text.contains("r_rows"),
                    ":{port} returned no measurements: {text}");
            sqlx::raw_sql("DROP DATABASE txui_plan").execute(&mut *conn).await.unwrap();
        }
    }
}
