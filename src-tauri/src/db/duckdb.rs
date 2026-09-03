//! DuckDB — an in-process OLAP engine over a file, or `:memory:`.
//!
//! Like SQLite the file is the connection (`config.file_path` is the whole
//! address; `:memory:` is a first-class value, since an analytical scratch
//! database with no file is the normal way to query Parquet/CSV/JSON). Unlike
//! SQLite this is a different library: `duckdb-rs`, with `bundled` compiling
//! the engine's C++ into the binary. Everything about this module follows from
//! three properties of that crate:
//!
//! 1. **`Connection` is `Send` but not `Sync`, and every call is blocking.**
//!    One connection per session lives behind a `Mutex`, and all work runs in
//!    `spawn_blocking` so a heavy scan never stalls the async runtime. The
//!    mutex is also *correctness*, not just interop: DuckDB serialises access
//!    to a connection, so the lock is its concurrency model stated in Rust.
//! 2. **Cancel is real.** `Connection::interrupt_handle()` is DuckDB's
//!    equivalent of `KILL QUERY` / `pg_cancel_backend` — a request the engine
//!    honours at its next interrupt point. The session exposes it so the
//!    app's Stop button reaches in (`commands::query::stop_in_flight`).
//! 3. **Read-only is the library's guarantee, not ours.** A read-only
//!    connection opens with `access_mode = READ_ONLY`, so DuckDB itself
//!    refuses the write — the same posture as SQLite's `mode=ro` and
//!    ClickHouse's `readonly=1`.
//!
//! File locking is DuckDB's own and is reported as-is: one read-write process
//! per file, so a second read-write session to the same path fails at open
//! with DuckDB's lock error; read-only sessions share a file freely. That is
//! the engine's concurrency contract, surfaced rather than papered over.
//!
//! Statement splitting for multi-statement input goes through sqlparser's
//! `DuckDbDialect` (already a dependency) so each statement's row count is
//! reported; if a statement is DuckDB-only syntax sqlparser cannot parse, the
//! whole text falls back to duckdb-rs's own multi-statement prepare, which
//! runs intermediate statements and returns the last result.

use anyhow::{anyhow, Result};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::types::{json_f64, ColumnInfo, ConnectionConfig, PingResult, QueryResult, Row, SchemaNode};

/// A live DuckDB session: one connection, a cancel handle, and what it was
/// opened against.
pub struct DuckDbSession {
    /// `Arc` so `spawn_blocking` closures can own a reference.
    conn: Arc<Mutex<duckdb::Connection>>,
    /// DuckDB's query interrupt — the in-process KILL QUERY. `Send + Sync`,
    /// so the cancel path can fire it while a query holds the mutex.
    interrupt: Arc<duckdb::InterruptHandle>,
    read_only: bool,
    memory: bool,
}

impl std::fmt::Debug for DuckDbSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DuckDbSession")
            .field("read_only", &self.read_only)
            .field("memory", &self.memory)
            .finish()
    }
}

impl DuckDbSession {
    /// Interrupt whatever is running on this session's connection.
    /// Best-effort, like every engine's cancel: DuckDB notices at its next
    /// interrupt point.
    pub fn interrupt(&self) {
        self.interrupt.interrupt();
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }
}

pub async fn open(config: &ConnectionConfig) -> Result<DuckDbSession> {
    let path = config
        .file_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| anyhow!("no database file chosen for this connection — \
                                use a path, or :memory: for a scratch database"))?;

    // The Config holds a raw pointer (not Send), so it is built inside the
    // blocking closure. Opening does file I/O (reads the database header), so
    // it runs off the async runtime.
    let (path_owned, read_only) = (path.to_string(), config.read_only);
    let conn = tokio::task::spawn_blocking(move || -> Result<duckdb::Connection> {
        let duckdb_config = duckdb::Config::default()
            .access_mode(if read_only {
                duckdb::AccessMode::ReadOnly
            } else {
                duckdb::AccessMode::Automatic
            })
            .map_err(|e| anyhow!("invalid DuckDB configuration: {e}"))?;
        if path_owned == ":memory:" {
            return Ok(duckdb::Connection::open_in_memory_with_flags(duckdb_config)?);
        }
        // A missing file must be an error, never an empty new database:
        // DuckDB's default is to create it, and silently opening an empty
        // database because of a typo in the path is the worst possible
        // outcome. Same rule as the SQLite driver.
        if !Path::new(&path_owned).exists() {
            return Err(anyhow!("no such file: {path_owned}"));
        }
        let conn = duckdb::Connection::open_with_flags(&path_owned, duckdb_config)
            .map_err(|e| anyhow!("{e}"))?;
        Ok(conn)
    })
    .await??;

    let interrupt = conn.interrupt_handle();
    Ok(DuckDbSession {
        conn: Arc::new(Mutex::new(conn)),
        interrupt,
        read_only,
        memory: path == ":memory:",
    })
}

/// Run `f` with the connection held, off the async runtime.
async fn with_conn<T, F>(session: &DuckDbSession, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&duckdb::Connection) -> Result<T> + Send + 'static,
{
    let conn = session.conn.clone();
    tokio::task::spawn_blocking(move || {
        // A poisoned mutex means a previous query panicked mid-hold; the
        // connection itself is still valid (DuckDB state is not corrupted by
        // a Rust-side panic in decode), so recover it rather than wedge the
        // session forever.
        let guard = conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&guard)
    })
    .await
    .map_err(|e| anyhow!("DuckDB worker task failed: {e}"))?
}

pub async fn ping(session: &DuckDbSession) -> PingResult {
    let start = Instant::now();
    let r = execute(session, "SELECT version() AS v").await;
    match r {
        Ok(res) => {
            let v = res.rows.first()
                .and_then(|row| row.first())
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            PingResult {
                ok: true,
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: Some(format!("DuckDB {v}")),
                error: None,
            }
        }
        Err(e) => PingResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: None,
            error: Some(e.to_string()),
        },
    }
}

/// Execute SQL text (possibly several statements) and return rows + metadata.
///
/// Same single-pass shape as the other engines: result sets are collected,
/// write statements contribute their `rows_changed`, and a statement never
/// runs twice. With several result-producing statements the rows are
/// concatenated — parity with the SQLite driver's `fetch_many` behaviour.
pub async fn execute(session: &DuckDbSession, sql: &str) -> Result<QueryResult> {
    execute_capped(session, sql, None).await
}

/// As `execute`, collecting at most `max_rows` rows; past the cap iteration
/// stops and `truncated` is set on the result.
pub async fn execute_capped(
    session: &DuckDbSession,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult> {
    let sql = sql.to_string();
    with_conn(session, move |conn| run(conn, &sql, &[], max_rows)).await
}

/// Execute one parameterised statement (the data browser binds every value —
/// that is what keeps it injection-proof). No statement splitting: the
/// browser emits exactly one statement.
pub async fn execute_params(
    session: &DuckDbSession,
    sql: &str,
    params: &[String],
) -> Result<QueryResult> {
    let sql = sql.to_string();
    let params = params.to_vec();
    with_conn(session, move |conn| run(conn, &sql, &params, None)).await
}

/// Synchronous core of execute: split, then run each statement once.
///
/// A statement is run through `raw_execute` + `raw_query` rather than
/// `Statement::execute`/`Statement::query` so BOTH the changed-row count and
/// the result rows of the same single execution are available — the public
/// helpers each give up one of the two.
///
/// DuckDB answers EVERY statement with a result object: DML gets a one-row
/// `Count` column, DDL an empty one. DML (INSERT/UPDATE/DELETE without a
/// RETURNING clause, per the split's classification) therefore skips row
/// collection entirely and reports `duckdb_rows_changed` as rows_affected —
/// otherwise the grid would show a spurious one-row "Count" result and the
/// affected count would be lost.
fn run(conn: &duckdb::Connection, sql: &str, params: &[String], max_rows: Option<usize>) -> Result<QueryResult> {
    let start = Instant::now();
    let statements = split_statements(sql);

    let mut columns: Vec<ColumnInfo> = Vec::new();
    let mut rows: Vec<Row> = Vec::new();
    let mut saw_result_set = false;
    let mut affected: u64 = 0;
    let mut saw_write = false;
    let mut first_row_ms: Option<u64> = None;
    let mut truncated = false;
    // Remaining row budget for the next result set (None = unlimited).
    let budget = |rows_so_far: usize| max_rows.map(|cap| cap.saturating_sub(rows_so_far));

    for (sql, is_write) in &statements {
        let mut stmt = conn.prepare(sql)?;
        if !params.is_empty() {
            // Parameterised form: `query` = execute + row iterator in one.
            let mut rows_it = stmt.query(duckdb::params_from_iter(params.iter()))?;
            let (cols, data, t_first, cut) = collect_rows(&mut rows_it, &start, budget(rows.len()))?;
            truncated |= cut;
            if !cols.is_empty() {
                saw_result_set = true;
                if columns.is_empty() {
                    columns = cols;
                }
                if first_row_ms.is_none() {
                    first_row_ms = t_first;
                }
                rows.extend(data);
            }
            continue;
        }
        let changed = stmt.raw_execute()?;
        if *is_write {
            saw_write = true;
            affected += changed as u64;
            continue;
        }

        let mut rows_it = stmt.raw_query();
        let (cols, data, t_first, cut) = collect_rows(&mut rows_it, &start, budget(rows.len()))?;
        truncated |= cut;
        if !cols.is_empty() {
            saw_result_set = true;
            if columns.is_empty() {
                columns = cols;
            }
            if first_row_ms.is_none() {
                first_row_ms = t_first;
            }
            rows.extend(data);
        } else {
            // Genuinely columnless (PRAGMA statements that set, …): the
            // changed-row count is all there is to report.
            saw_write = true;
            affected += changed as u64;
        }
    }

    let total_ms = start.elapsed().as_millis() as u64;
    let execution_ms = first_row_ms.unwrap_or(total_ms);
    Ok(QueryResult {
        columns,
        rows,
        // A statement that produced rows is a result set, not a write — the
        // frontend shows "N rows affected" only when nothing returned rows.
        rows_affected: if saw_result_set { None } else if saw_write { Some(affected) } else { None },
        execution_ms,
        fetch_ms: total_ms - execution_ms,
        warnings: vec![],
        truncated,
    })
}

/// Drain one executed statement's rows, decoding each cell. `max_rows` caps
/// the collection: past it iteration stops and the last tuple element is true.
/// Returns (columns, rows, time-to-first-row relative to `start`, truncated).
fn collect_rows(
    rows_it: &mut duckdb::Rows<'_>,
    start: &Instant,
    max_rows: Option<usize>,
) -> Result<(Vec<ColumnInfo>, Vec<Row>, Option<u64>, bool)> {
    let stmt = rows_it.as_ref().ok_or_else(|| anyhow!("statement gone"))?;
    let ncols = stmt.column_count();
    if ncols == 0 {
        return Ok((vec![], vec![], None, false));
    }
    let schema = stmt.schema();
    let columns: Vec<ColumnInfo> = (0..ncols)
        .map(|i| {
            let field = schema.field(i);
            ColumnInfo {
                name: field.name().clone(),
                type_name: duckdb_type_name(field.data_type()),
                nullable: field.is_nullable(),
            }
        })
        .collect();

    let mut out: Vec<Row> = Vec::new();
    let mut first_row_ms = None;
    let mut truncated = false;
    while let Some(row) = rows_it.next()? {
        if first_row_ms.is_none() {
            first_row_ms = Some(start.elapsed().as_millis() as u64);
        }
        if max_rows.is_some_and(|cap| out.len() >= cap) {
            truncated = true;
            break;
        }
        out.push((0..ncols).map(|i| json_cell(row, i)).collect());
    }
    Ok((columns, out, first_row_ms, truncated))
}

/// Split multi-statement text into individual statements, classifying each as
/// a plain write (INSERT/UPDATE/DELETE without RETURNING — the answer is its
/// changed-row count, not its `Count` result row) or anything else.
///
/// sqlparser's DuckDB dialect handles the standard surface; anything it
/// refuses (DuckDB-only syntax such as `PIVOT`, `INSTALL`, `FROM`-first
/// queries in some forms) falls back to the whole text as ONE input to
/// `Connection::prepare`, which itself extracts and runs multi-statement
/// input — executing intermediates and returning the final statement's
/// result. Degraded (intermediate result sets are discarded, and DML there
/// shows its `Count` row) but functional.
fn split_statements(sql: &str) -> Vec<(String, bool)> {
    use sqlparser::ast::Statement;
    let dialect = sqlparser::dialect::DuckDbDialect {};
    split_on_semicolons(sql)
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            // The AST is used for CLASSIFICATION only — what runs is the
            // user's original text. Executing `s.to_string()` (the
            // re-serialized AST) silently changed what ran wherever the
            // round-trip disagreed with DuckDB's dialect, and stripped
            // comments/hints. A statement sqlparser refuses (PIVOT, INSTALL,
            // FROM-first…) still executes — as its own original slice.
            let write = match sqlparser::parser::Parser::parse_sql(&dialect, p) {
                Ok(stmts) if stmts.len() == 1 => match &stmts[0] {
                    Statement::Insert(i) => i.returning.is_none(),
                    Statement::Update(u) => u.returning.is_none(),
                    Statement::Delete(d) => d.returning.is_none(),
                    _ => false,
                },
                _ => false,
            };
            (p.trim().to_string(), write)
        })
        .collect()
}

/// Split on top-level `;`, string/comment/dollar-quote aware, returning
/// slices of the ORIGINAL text. Byte-wise scanning is UTF-8-safe: every
/// sentinel is ASCII and multibyte sequences never contain ASCII bytes.
fn split_on_semicolons(sql: &str) -> Vec<&str> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < n {
        match b[i] {
            q @ (b'\'' | b'"') => {
                i += 1;
                while i < n {
                    if b[i] == q {
                        if i + 1 < n && b[i + 1] == q { i += 2; continue; }  // doubled quote
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'-' if i + 1 < n && b[i + 1] == b'-' => {
                while i < n && b[i] != b'\n' { i += 1; }
            }
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') { i += 1; }
                i = (i + 2).min(n);
            }
            b'$' => {
                // dollar-quoted string: $tag$ … $tag$ (tag may be empty)
                let mut j = i + 1;
                while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_') { j += 1; }
                if j < n && b[j] == b'$' {
                    let tag = &sql[i..=j];
                    match sql[j + 1..].find(tag) {
                        Some(p) => i = j + 1 + p + tag.len(),
                        None => i = n,
                    }
                } else {
                    i += 1;
                }
            }
            b';' => {
                out.push(&sql[start..i]);
                start = i + 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    if start < n { out.push(&sql[start..]); }
    out
}

// ── Row decoding ──────────────────────────────────────────────────────────────
//
// The doctrine (AGENTS.md): NULL checked first; integers as i64/u64; DECIMAL
// rendered as string, never through f64; NaN/±Infinity become string
// sentinels; a failed typed decode falls through to string, never NULL.

/// Decode one cell. NULL is checked first, as the `ValueRef::Null` variant.
fn json_cell(row: &duckdb::Row<'_>, i: usize) -> serde_json::Value {
    use serde_json::Value as J;
    match row.get_ref(i) {
        Ok(vr) => json_from_valueref(vr),
        // An out-of-range index is the only failure mode here; the column
        // count came from the same statement, so this is unreachable in
        // practice. NULL is still the honest answer for "no value".
        Err(_) => J::Null,
    }
}

fn json_from_valueref(vr: duckdb::types::ValueRef<'_>) -> serde_json::Value {
    use duckdb::types::ValueRef;
    use serde_json::Value as J;
    match vr {
        ValueRef::Null => J::Null,
        ValueRef::Boolean(b) => J::Bool(b),
        ValueRef::TinyInt(v) => J::Number((v as i64).into()),
        ValueRef::SmallInt(v) => J::Number((v as i64).into()),
        ValueRef::Int(v) => J::Number((v as i64).into()),
        ValueRef::BigInt(v) => J::Number(v.into()),
        // HUGEINT is i128: a JSON number when it fits i64 (the common case),
        // its exact digits as a string when it does not — never through f64,
        // which would silently round it.
        ValueRef::HugeInt(v) => huge_to_json(v),
        ValueRef::UHugeInt(v) => {
            if v <= u64::MAX as u128 {
                J::Number((v as u64).into())
            } else {
                J::String(v.to_string())
            }
        }
        ValueRef::UTinyInt(v) => J::Number((v as u64).into()),
        ValueRef::USmallInt(v) => J::Number((v as u64).into()),
        ValueRef::UInt(v) => J::Number((v as u64).into()),
        ValueRef::UBigInt(v) => J::Number(v.into()),
        ValueRef::Float(v) => json_f64(v as f64),
        ValueRef::Double(v) => json_f64(v),
        // DECIMAL(width, scale) — hand-formatted from the scaled integer, so
        // DECIMAL(38) (whose payload overflows rust_decimal's 96 bits) renders
        // exactly and trailing zeros survive. Never through f64.
        ValueRef::Decimal(d) => J::String(format_decimal(d.value(), d.scale())),
        ValueRef::Timestamp(unit, v) => J::String(format_timestamp(unit, v)),
        // DuckDB guarantees VARCHAR is valid UTF-8 on write, but a BLOB cast
        // or a mis-encoded CSV can put anything in one. Valid UTF-8 shows as
        // text; otherwise hex — the same treatment MySQL's binary path gets,
        // and never a masquerading NULL.
        ValueRef::Text(bytes) => match std::str::from_utf8(bytes) {
            Ok(s) => J::String(s.to_string()),
            Err(_) => J::String(hex::encode(bytes)),
        },
        // BLOB: hex, matching PostgreSQL's bytea rendering. Never lossy text.
        ValueRef::Blob(bytes) => J::String(hex::encode(bytes)),
        // GEOMETRY is WKB bytes; hex like a blob, and the type_name column
        // metadata says GEOMETRY so the grid can explain it.
        ValueRef::Geometry(wkb) => J::String(hex::encode(wkb)),
        ValueRef::Date32(days) => J::String(format_date32(days)),
        ValueRef::Time64(unit, v) => J::String(format_time64(unit, v)),
        ValueRef::Interval { months, days, nanos } =>
            J::String(format_interval(months, days, nanos)),
        // Nested types become JSON text: STRUCT → object, LIST/ARRAY → array,
        // MAP → object, UNION → the tagged value. The owned conversion is
        // duckdb-rs's own arrow-backed decoder.
        ValueRef::List(..) | ValueRef::Array(..) | ValueRef::Struct(..)
        | ValueRef::Map(..) | ValueRef::Union(..) =>
            json_from_value(&vr.to_owned()),
        ValueRef::Enum(..) => match vr.to_owned() {
            duckdb::types::Value::Enum(s) => J::String(s),
            _ => J::Null,
        },
        // `ValueRef` is non_exhaustive; a type duckdb-rs adds later renders as
        // its debug form rather than pretending to be NULL.
        other => J::String(format!("{other:?}")),
    }
}

/// Owned-value decode, for nested containers. Recursion depth follows the
/// data's nesting, which DuckDB itself bounds far below stack limits.
fn json_from_value(v: &duckdb::types::Value) -> serde_json::Value {
    use duckdb::types::Value as D;
    use serde_json::Value as J;
    match v {
        D::Null => J::Null,
        D::Boolean(b) => J::Bool(*b),
        D::TinyInt(x) => J::Number((*x as i64).into()),
        D::SmallInt(x) => J::Number((*x as i64).into()),
        D::Int(x) => J::Number((*x as i64).into()),
        D::BigInt(x) => J::Number((*x).into()),
        D::HugeInt(x) => huge_to_json(*x),
        D::UHugeInt(x) => if *x <= u64::MAX as u128 {
            J::Number((*x as u64).into())
        } else {
            J::String(x.to_string())
        },
        D::UTinyInt(x) => J::Number((*x as u64).into()),
        D::USmallInt(x) => J::Number((*x as u64).into()),
        D::UInt(x) => J::Number((*x as u64).into()),
        D::UBigInt(x) => J::Number((*x).into()),
        D::Float(x) => json_f64(*x as f64),
        D::Double(x) => json_f64(*x),
        D::Decimal(d) => J::String(format_decimal(d.value(), d.scale())),
        D::Timestamp(unit, t) => J::String(format_timestamp(*unit, *t)),
        D::Text(s) => J::String(s.clone()),
        D::Blob(b) | D::Geometry(b) => J::String(hex::encode(b)),
        D::Date32(d) => J::String(format_date32(*d)),
        D::Time64(unit, t) => J::String(format_time64(*unit, *t)),
        D::Interval { months, days, nanos } => J::String(format_interval(*months, *days, *nanos)),
        D::Enum(s) => J::String(s.clone()),
        D::List(items) | D::Array(items) =>
            J::Array(items.iter().map(json_from_value).collect()),
        D::Struct(map) => J::Object(map.iter().map(|(k, val)| {
            (k.clone(), json_from_value(val))
        }).collect()),
        // JSON objects need string keys; a MAP's key may be any scalar, so it
        // is rendered the way DuckDB would print it.
        D::Map(map) => J::Object(map.iter().map(|(k, val)| {
            (display_value(k), json_from_value(val))
        }).collect()),
        D::Union(inner) => json_from_value(inner),
        other => J::String(format!("{other:?}")),
    }
}

fn huge_to_json(v: i128) -> serde_json::Value {
    if let Ok(small) = i64::try_from(v) {
        serde_json::Value::Number(small.into())
    } else {
        serde_json::Value::String(v.to_string())
    }
}

/// Render a MAP key / any nested scalar the way it would print in SQL.
fn display_value(v: &duckdb::types::Value) -> String {
    match json_from_value(v) {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    }
}

/// `DECIMAL(width, scale)` from its scaled integer payload. Exact for every
/// width DuckDB allows (up to 38 digits — beyond rust_decimal's range, which
/// is why this is hand-rolled rather than delegated).
fn format_decimal(value: i128, scale: u8) -> String {
    if scale == 0 {
        return value.to_string();
    }
    let neg = value < 0;
    let digits = value.unsigned_abs().to_string();
    let scale = scale as usize;
    let body = if digits.len() <= scale {
        // 0.00…digits — pad so the point sits `scale` places in.
        format!("0.{}{}", "0".repeat(scale - digits.len()), digits)
    } else {
        let split = digits.len() - scale;
        format!("{}.{}", &digits[..split], &digits[split..])
    };
    if neg { format!("-{body}") } else { body }
}

/// µs since the Unix epoch, whatever the source unit. DuckDB's own types are
/// µs (TIMESTAMP), seconds (TIMESTAMP_S), ms (TIMESTAMP_MS) and ns
/// (TIMESTAMP_NS); the i128 detour keeps seconds→µs from overflowing i64.
fn to_micros(unit: duckdb::types::TimeUnit, v: i64) -> i64 {
    use duckdb::types::TimeUnit;
    let factor: i128 = match unit {
        TimeUnit::Second => 1_000_000,
        TimeUnit::Millisecond => 1_000,
        TimeUnit::Microsecond => 1,
        TimeUnit::Nanosecond => 0, // handled below: ns→µs is a division
    };
    if matches!(unit, TimeUnit::Nanosecond) {
        return (v as i128 / 1_000).clamp(i64::MIN as i128, i64::MAX as i128) as i64;
    }
    ((v as i128) * factor).clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

/// House style for timestamps: `"2024-03-01 10:20:30.123456"` — the same
/// format MySQL/PostgreSQL naive timestamps render in (`%Y-%m-%d %H:%M:%S%.f`).
/// TIMESTAMPTZ arrives as µs UTC and is rendered as that wall clock, matching
/// how the app treats every engine's timestamp: the value as stored, no local
/// zone applied client-side.
fn format_timestamp(unit: duckdb::types::TimeUnit, v: i64) -> String {
    let micros = to_micros(unit, v);
    match chrono::DateTime::from_timestamp_micros(micros) {
        Some(dt) => dt.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
        // Beyond chrono's range the raw value is still the truth — show it
        // rather than NULL it.
        None => format!("{micros} µs since epoch"),
    }
}

/// Days since 1970-01-01 → `"2024-03-01"`. 719163 is the day number of the
/// Unix epoch in chrono's `num_days_from_ce` counting.
fn format_date32(days: i32) -> String {
    match chrono::NaiveDate::from_num_days_from_ce_opt(days + 719_163) {
        Some(d) => d.format("%Y-%m-%d").to_string(),
        None => format!("{days} days since epoch"),
    }
}

/// Time of day → `"10:20:30.123456"` (house `%H:%M:%S%.f`).
fn format_time64(unit: duckdb::types::TimeUnit, v: i64) -> String {
    let micros = to_micros(unit, v);
    let day = 86_400_000_000i64;
    // Normalise into [0, 24h): DuckDB TIME is a time of day.
    let within = micros.rem_euclid(day);
    let secs = (within / 1_000_000) as u32;
    let micros_part = (within % 1_000_000) as u32;
    match chrono::NaiveTime::from_num_seconds_from_midnight_opt(secs, micros_part * 1_000) {
        Some(t) => t.format("%H:%M:%S%.f").to_string(),
        None => format!("{micros} µs"),
    }
}

/// INTERVAL as DuckDB prints it: months and days as units, sub-day time as a
/// clock value — `"3 months 2 days 04:05:06.5"`. Zero renders as `00:00:00`.
fn format_interval(months: i32, days: i32, nanos: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    if months != 0 {
        parts.push(format!("{months} month{}", if months == 1 { "" } else { "s" }));
    }
    if days != 0 {
        parts.push(format!("{days} day{}", if days == 1 { "" } else { "s" }));
    }
    let micros = nanos / 1_000;
    if micros != 0 || parts.is_empty() {
        let sign = if micros < 0 { "-" } else { "" };
        let abs = micros.unsigned_abs();
        let (h, rem) = (abs / 3_600_000_000, abs % 3_600_000_000);
        let (m, rem) = (rem / 60_000_000, rem % 60_000_000);
        let (s, us) = (rem / 1_000_000, rem % 1_000_000);
        if us == 0 {
            parts.push(format!("{sign}{h:02}:{m:02}:{s:02}"));
        } else {
            parts.push(format!("{sign}{h:02}:{m:02}:{s:02}.{us:06}"));
        }
    }
    parts.join(" ")
}

/// SQL display name for a result column's type, from its arrow representation
/// (duckdb-rs re-exports its arrow, so no extra dependency is named).
fn duckdb_type_name(dt: &duckdb::arrow::datatypes::DataType) -> String {
    use duckdb::arrow::datatypes::{DataType as D, TimeUnit};
    match dt {
        D::Null => "NULL".into(),
        D::Boolean => "BOOLEAN".into(),
        D::Int8 => "TINYINT".into(),
        D::Int16 => "SMALLINT".into(),
        D::Int32 => "INTEGER".into(),
        D::Int64 => "BIGINT".into(),
        D::UInt8 => "UTINYINT".into(),
        D::UInt16 => "USMALLINT".into(),
        D::UInt32 => "UINTEGER".into(),
        D::UInt64 => "UBIGINT".into(),
        D::Float16 | D::Float32 => "FLOAT".into(),
        D::Float64 => "DOUBLE".into(),
        D::Decimal128(p, s) | D::Decimal256(p, s) => format!("DECIMAL({p},{s})"),
        D::Utf8 | D::LargeUtf8 | D::Utf8View => "VARCHAR".into(),
        D::Binary | D::LargeBinary | D::BinaryView => "BLOB".into(),
        D::Date32 | D::Date64 => "DATE".into(),
        D::Time32(_) | D::Time64(_) => "TIME".into(),
        D::Timestamp(TimeUnit::Second, tz) =>
            if tz.is_some() { "TIMESTAMP_S_TZ".into() } else { "TIMESTAMP_S".into() },
        D::Timestamp(TimeUnit::Millisecond, tz) =>
            if tz.is_some() { "TIMESTAMP_MS_TZ".into() } else { "TIMESTAMP_MS".into() },
        D::Timestamp(TimeUnit::Microsecond, tz) =>
            if tz.is_some() { "TIMESTAMPTZ".into() } else { "TIMESTAMP".into() },
        D::Timestamp(TimeUnit::Nanosecond, tz) =>
            if tz.is_some() { "TIMESTAMP_NS_TZ".into() } else { "TIMESTAMP_NS".into() },
        D::Interval(_) => "INTERVAL".into(),
        D::Duration(_) => "DURATION".into(),
        D::List(_) | D::LargeList(_) | D::ListView(_) => "LIST".into(),
        D::FixedSizeList(..) => "ARRAY".into(),
        D::Struct(_) => "STRUCT".into(),
        D::Map(..) => "MAP".into(),
        D::Union(..) => "UNION".into(),
        // Anything not mapped shows arrow's own spelling — accurate, if less
        // idiomatic than DuckDB's name for it.
        other => other.to_string(),
    }
}

// ── Schema tree ──────────────────────────────────────────────────────────────
//
// DuckDB's catalog is a set of built-in table functions — duckdb_tables(),
// duckdb_columns(), duckdb_views(), duckdb_functions(), duckdb_indexes(),
// duckdb_constraints() — each listing every attached database, filterable by
// database_name. All parameterised; names never interpolate into SQL.

/// A row of text columns out of a catalog query.
async fn catalog_query(
    session: &DuckDbSession,
    sql: &str,
    params: &[String],
) -> Result<QueryResult> {
    execute_params(session, sql, params).await
}

use super::util::{col_bool, col_str};

/// Top level: the attached databases (`memory`, plus any ATTACHed file).
/// `internal` filters DuckDB's own `system`/`temp` bookkeeping catalogs.
pub async fn list_databases(session: &DuckDbSession) -> Result<Vec<SchemaNode>> {
    let r = catalog_query(session,
        "SELECT database_name FROM duckdb_databases() \
         WHERE NOT internal ORDER BY database_name", &[]).await?;
    let mut out: Vec<SchemaNode> = r.rows.iter()
        .map(|row| SchemaNode::Database { name: col_str(row, 0) })
        .collect();
    if out.is_empty() {
        out.push(SchemaNode::Database { name: "memory".into() });
    }
    Ok(out)
}

/// `context` = database name | None = top level.
pub async fn list_schema(session: &DuckDbSession, context: Option<&str>) -> Result<Vec<SchemaNode>> {
    match context {
        Some(db) => list_objects(session, db).await,
        None => list_databases(session).await,
    }
}

/// Tables, views and functions/macros of one database, across its schemas.
///
/// DuckDB is three-level (catalog → schema → object) where the app's tree is
/// two, so the schema is folded into the node's `name` as `schema.table`
/// (matching how SchemaNode carries it) — `main` stays visible rather than
/// being silently assumed, because ATTACHed databases routinely carry their
/// own `main` and nothing would tell two `main.orders` apart otherwise.
pub async fn list_objects(session: &DuckDbSession, database: &str) -> Result<Vec<SchemaNode>> {
    let db = vec![database.to_string()];
    let tables = catalog_query(session,
        "SELECT schema_name, table_name, estimated_size FROM duckdb_tables() \
         WHERE database_name = ? AND NOT internal ORDER BY schema_name, table_name",
        &db).await?;
    let views = catalog_query(session,
        "SELECT schema_name, view_name FROM duckdb_views() \
         WHERE database_name = ? AND NOT internal ORDER BY schema_name, view_name",
        &db).await?;
    // Functions incl. macros — cheap, and a DuckDB file is where macro-heavy
    // workflows live. `function_type` is scalar/aggregate/table/macro/…
    let functions = catalog_query(session,
        "SELECT schema_name, function_name, function_type FROM duckdb_functions() \
         WHERE database_name = ? AND NOT internal AND function_type IN ('macro','table_macro') \
         ORDER BY schema_name, function_name",
        &db).await?;

    let mut out = Vec::new();
    for row in &tables.rows {
        let (schema, name) = (col_str(row, 0), col_str(row, 1));
        let row_count = row.get(2).and_then(|v| v.as_i64());
        out.push(SchemaNode::Table {
            name: format!("{schema}.{name}"),
            schema: Some(schema),
            row_count,
            partition_of: None,
            temporal: false,
        });
    }
    for row in &views.rows {
        let (schema, name) = (col_str(row, 0), col_str(row, 1));
        out.push(SchemaNode::View {
            name: format!("{schema}.{name}"),
            schema: Some(schema),
        });
    }
    for row in &functions.rows {
        let (schema, name, kind) = (col_str(row, 0), col_str(row, 1), col_str(row, 2));
        out.push(SchemaNode::Routine {
            name: format!("{schema}.{name}"),
            schema: Some(schema),
            routine_type: kind.to_uppercase(),
        });
    }
    Ok(out)
}

/// Split `schema.table` (as the tree names objects) into its parts; a bare
/// `table` means the `main` schema, which is where DuckDB puts objects
/// created without one.
fn split_schema_object(object: &str) -> (String, String) {
    match object.split_once('.') {
        Some((s, t)) => (s.to_string(), t.to_string()),
        None => ("main".to_string(), object.to_string()),
    }
}

/// Columns + indexes of one table. `table` is the tree's `schema.table` form.
pub async fn list_columns(
    session: &DuckDbSession,
    database: &str,
    table: &str,
) -> Result<Vec<SchemaNode>> {
    let (schema, table) = split_schema_object(table);
    let params = vec![database.to_string(), schema.clone(), table.clone()];
    let cols = catalog_query(session,
        "SELECT column_name, data_type, is_nullable FROM duckdb_columns() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ? \
         ORDER BY column_index",
        &params).await?;

    // Primary-key columns, from the constraint rather than a flag: DuckDB
    // records PRIMARY KEY as a constraint with its column list.
    let pks = catalog_query(session,
        "SELECT constraint_column_names FROM duckdb_constraints() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ? \
           AND constraint_type = 'PRIMARY KEY'",
        &params).await?;
    let mut pk_cols: Vec<String> = Vec::new();
    for row in &pks.rows {
        if let Some(names) = row.first().and_then(|v| v.as_array()) {
            pk_cols.extend(names.iter().filter_map(|n| n.as_str().map(str::to_string)));
        }
    }

    let mut out = Vec::new();
    for row in &cols.rows {
        let name = col_str(row, 0);
        out.push(SchemaNode::Column {
            name: name.clone(),
            type_name: col_str(row, 1),
            nullable: col_bool(row, 2),
            primary_key: pk_cols.iter().any(|c| c == &name),
        });
    }

    let idx = catalog_query(session,
        "SELECT index_name, is_unique, sql FROM duckdb_indexes() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ? \
         ORDER BY index_name",
        &params).await?;
    for row in &idx.rows {
        let name = col_str(row, 0);
        let unique = col_bool(row, 1);
        // duckdb_indexes() has no column list; the CREATE INDEX statement is
        // the record, so the columns are parsed from it.
        let sql = col_str(row, 2);
        out.push(SchemaNode::Index { name, unique, columns: index_columns(&sql) });
    }
    Ok(out)
}

/// The column list out of a stored `CREATE INDEX … ON t (a, b)` statement.
/// Best-effort display data: anything unparseable yields an empty list, and
/// the DDL view still shows the full statement.
fn index_columns(sql: &str) -> Vec<String> {
    let Some(open) = sql.rfind('(') else { return vec![] };
    let Some(close) = sql.rfind(')') else { return vec![] };
    if close <= open { return vec![]; }
    sql[open + 1..close]
        .split(',')
        .map(|c| c.trim().trim_matches('"').to_string())
        .filter(|c| !c.is_empty())
        .collect()
}

/// Rich table metadata for the data browser. `table` is the tree's
/// `schema.table` form.
pub async fn get_table_meta(
    session: &DuckDbSession,
    database: &str,
    table: &str,
) -> Result<super::types::TableMeta> {
    use super::types::{TableColumn, TableMeta};
    let (schema, table) = split_schema_object(table);
    let params = vec![database.to_string(), schema.clone(), table.clone()];

    let cols = catalog_query(session,
        "SELECT column_name, data_type, is_nullable FROM duckdb_columns() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ? \
         ORDER BY column_index",
        &params).await?;

    // Constraints carry both the PK and the FKs. The column-name lists decode
    // as JSON arrays (LIST values — see json_from_valueref).
    let cons = catalog_query(session,
        "SELECT constraint_type, constraint_column_names, referenced_table, \
                referenced_column_names \
         FROM duckdb_constraints() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ? \
           AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')",
        &params).await?;
    let mut pk_columns: Vec<String> = Vec::new();
    // column → (referenced_table, referenced_column)
    let mut fks: std::collections::HashMap<String, (String, String)> = Default::default();
    for row in &cons.rows {
        let names: Vec<String> = row.get(1)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        match col_str(row, 0).as_str() {
            "PRIMARY KEY" => pk_columns.extend(names),
            "FOREIGN KEY" => {
                let ref_table = col_str(row, 2);
                let ref_cols: Vec<String> = row.get(3)
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                for (i, name) in names.into_iter().enumerate() {
                    if let Some(rc) = ref_cols.get(i) {
                        fks.insert(name, (ref_table.clone(), rc.clone()));
                    }
                }
            }
            _ => {}
        }
    }

    let columns: Vec<TableColumn> = cols.rows.iter().map(|row| {
        let name = col_str(row, 0);
        let fk = fks.get(&name);
        TableColumn {
            primary_key: pk_columns.iter().any(|c| c == &name),
            nullable: col_bool(row, 2),
            type_name: col_str(row, 1),
            fk_table: fk.map(|(t, _)| t.clone()),
            fk_column: fk.map(|(_, c)| c.clone()),
            name,
        }
    }).collect();

    // duckdb_tables().estimated_size is exactly the row count for a base
    // table — no COUNT(*) scan needed.
    let size = catalog_query(session,
        "SELECT estimated_size FROM duckdb_tables() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ?",
        &params).await?;
    let total_rows = size.rows.first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_i64());

    Ok(TableMeta { columns, pk_columns, total_rows })
}

/// The stored CREATE statement — DuckDB keeps the original text in
/// duckdb_tables()/duckdb_views(), with the table's indexes appended (every
/// other engine's "the DDL" includes them).
pub async fn get_ddl(session: &DuckDbSession, database: &str, object: &str) -> Result<String> {    let (schema, obj) = split_schema_object(object);
    let params = vec![database.to_string(), schema.clone(), obj.clone()];
    let r = catalog_query(session,
        "SELECT sql FROM duckdb_tables() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ? AND NOT internal \
         UNION ALL \
         SELECT sql FROM duckdb_views() \
         WHERE database_name = ? AND schema_name = ? AND view_name = ? AND NOT internal",
        &[
            database.to_string(), schema.clone(), obj.clone(),
            database.to_string(), schema.clone(), obj.clone(),
        ]).await?;

    let Some(text) = r.rows.first().map(|row| col_str(row, 0)).filter(|s| !s.trim().is_empty())
    else {
        return Err(anyhow!("no object named {obj} in {database}.{schema}"));
    };

    let idx = catalog_query(session,
        "SELECT sql FROM duckdb_indexes() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ? ORDER BY index_name",
        &params).await?;
    let mut out = format!("{};", text.trim_end_matches(';'));
    for row in &idx.rows {
        let sql = col_str(row, 0);
        if !sql.trim().is_empty() {
            out.push_str(&format!("\n{};", sql.trim_end_matches(';')));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::Engine;

    fn mem_config(read_only: bool) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Duckdb, "t");
        c.file_path = Some(":memory:".into());
        c.read_only = read_only;
        c
    }

    async fn mem() -> DuckDbSession {
        open(&mem_config(false)).await.unwrap()
    }

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("txui-duckdb-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("t.duckdb")
    }

    #[tokio::test]
    async fn a_missing_file_is_an_error_not_a_new_empty_database() {
        let mut c = ConnectionConfig::new(Engine::Duckdb, "t");
        c.file_path = Some("/nonexistent/definitely/not/here.duckdb".into());
        let err = open(&c).await.unwrap_err().to_string();
        assert!(err.contains("no such file"), "{err}");
    }

    #[tokio::test]
    async fn no_file_path_says_what_to_do() {
        let mut c = ConnectionConfig::new(Engine::Duckdb, "t");
        c.file_path = None;
        let err = open(&c).await.unwrap_err().to_string();
        assert!(err.contains(":memory:"), "{err}");
    }

    #[tokio::test]
    async fn memory_database_runs_queries_and_reports_versions() {
        let s = mem().await;
        let p = ping(&s).await;
        assert!(p.ok, "{:?}", p.error);
        assert!(p.server_version.unwrap().starts_with("DuckDB v1."));

        execute(&s, "CREATE TABLE t (a INTEGER, b VARCHAR)").await.unwrap();
        let ins = execute(&s, "INSERT INTO t VALUES (1, 'x'), (2, 'y')").await.unwrap();
        assert_eq!(ins.rows_affected, Some(2));
        let r = execute(&s, "SELECT a, b FROM t ORDER BY a").await.unwrap();
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][0], serde_json::json!(1));
        assert_eq!(r.rows[0][1], serde_json::json!("x"));
        assert_eq!(r.rows_affected, None);
    }

    #[tokio::test]
    async fn multi_statement_runs_each_once_and_concatenates() {
        let s = mem().await;
        let r = execute(&s,
            "CREATE TABLE m (a INTEGER); INSERT INTO m VALUES (1); INSERT INTO m VALUES (2); \
             SELECT a FROM m ORDER BY a; SELECT a * 10 FROM m ORDER BY a").await.unwrap();
        assert_eq!(r.rows.len(), 4, "{:?}", r.rows);
        let upd = execute(&s, "UPDATE m SET a = a + 1; DELETE FROM m WHERE a = 3").await.unwrap();
        assert_eq!(upd.rows_affected, Some(3), "{:?}", upd.rows_affected);
    }

    /// Every type class, decoded by the doctrine: NULL first, integers exact,
    /// hugeint beyond i64 as digits, decimal as string, non-finite floats as
    /// sentinels, timestamps/dates canonical, nested as JSON, blob as hex.
    #[tokio::test]
    async fn every_type_class_decodes_per_the_doctrine() {
        let s = mem().await;
        let r = execute(&s, "SELECT \
            NULL::INTEGER AS n, \
            42::BIGINT AS i64, \
            170141183460469231731687303715884105727::HUGEINT AS huge_max, \
            99999::HUGEINT AS huge_small, \
            18446744073709551615::UBIGINT AS u64max, \
            340282366920938463463374607431768211455::UHUGEINT AS uhuge_max, \
            123.45::DECIMAL(9,2) AS dec, \
            0.001::DECIMAL(38,6) AS dec_wide, \
            -7::DECIMAL(10,0) AS dec_neg_int, \
            1.5::DOUBLE AS dbl, \
            'NaN'::DOUBLE AS nan, \
            'Infinity'::DOUBLE AS inf, \
            '-Infinity'::DOUBLE AS ninf, \
            TIMESTAMP '2024-03-01 10:20:30.123456' AS ts, \
            DATE '2024-02-29' AS dt, \
            TIME '04:05:06.000789' AS tm, \
            INTERVAL '3 months 2 days 01:02:03.5' AS iv, \
            'héllo'::VARCHAR AS txt, \
            unhex('DEADBEEF') AS bin, \
            {'a': 1, 'b': 'x'} AS st, \
            [1, 2, NULL]::INTEGER[] AS lst, \
            MAP {'k1': 10, 'k2': 20} AS mp, \
            true::BOOLEAN AS b, \
            9223372036854775807::BIGINT AS i64max, \
            (-9223372036854775807::BIGINT - 1) AS i64min").await.unwrap();

        let get = |name: &str| {
            let i = r.columns.iter().position(|c| c.name == name).unwrap_or_else(|| panic!("no column {name}"));
            r.rows[0][i].clone()
        };
        use serde_json::json;
        assert_eq!(get("n"), serde_json::Value::Null);
        assert_eq!(get("i64"), json!(42));
        // HUGEINT at i128 range edges: exact digits as string, never rounded.
        assert_eq!(get("huge_max"), json!("170141183460469231731687303715884105727"));
        assert_eq!(get("huge_small"), json!(99999));
        assert_eq!(get("u64max"), json!(18446744073709551615u64));
        assert_eq!(get("uhuge_max"), json!("340282366920938463463374607431768211455"));
        // DECIMAL as string, trailing zero and wide width intact.
        assert_eq!(get("dec"), json!("123.45"));
        assert_eq!(get("dec_wide"), json!("0.001000"));
        assert_eq!(get("dec_neg_int"), json!("-7"));
        assert_eq!(get("dbl"), json!(1.5));
        // Non-finite sentinels — never NULL.
        assert_eq!(get("nan"), json!("NaN"));
        assert_eq!(get("inf"), json!("Infinity"));
        assert_eq!(get("ninf"), json!("-Infinity"));
        assert_eq!(get("ts"), json!("2024-03-01 10:20:30.123456"));
        assert_eq!(get("dt"), json!("2024-02-29"));
        assert_eq!(get("tm"), json!("04:05:06.000789"));
        assert_eq!(get("iv"), json!("3 months 2 days 01:02:03.500000"));
        assert_eq!(get("txt"), json!("héllo"));
        assert_eq!(get("bin"), json!("deadbeef"));
        assert_eq!(get("st"), json!({"a": 1, "b": "x"}));
        assert_eq!(get("lst"), json!([1, 2, null]));
        assert_eq!(get("mp"), json!({"k1": 10, "k2": 20}));
        assert_eq!(get("b"), json!(true));
        assert_eq!(get("i64max"), json!(9223372036854775807i64));
        assert_eq!(get("i64min"), json!(-9223372036854775808i64));

        // Column metadata carries real type names.
        let tname = |name: &str| r.columns.iter().find(|c| c.name == name).unwrap().type_name.clone();
        assert_eq!(tname("dec"), "DECIMAL(9,2)");
        assert_eq!(tname("ts"), "TIMESTAMP");
        assert_eq!(tname("txt"), "VARCHAR");
        assert_eq!(tname("bin"), "BLOB");
        assert_eq!(tname("st"), "STRUCT");
    }

    /// A failed typed decode must fall through to a string, never NULL. For
    /// VARCHAR that fallback is defense-in-depth only: DuckDB validates UTF-8
    /// on every path that produces a VARCHAR — a BLOB cast even *renders*
    /// non-printable bytes as `\xNN` escape text rather than emitting invalid
    /// UTF-8 — so the hex branch is not reachable through SQL. This pins the
    /// engine behaviour that makes that safe.
    #[tokio::test]
    async fn duckdb_guarantees_varchar_is_valid_utf8() {
        let s = mem().await;
        let r = execute(&s, "SELECT CAST(unhex('FFFE') AS VARCHAR) AS bad").await.unwrap();
        assert_eq!(r.rows[0][0], serde_json::json!("\\xFF\\xFE"));
        // …and the BLOB itself is hex, the PostgreSQL bytea convention.
        let r = execute(&s, "SELECT unhex('FFFE') AS bin").await.unwrap();
        assert_eq!(r.rows[0][0], serde_json::json!("fffe"));
    }

    #[tokio::test]
    async fn decimal_formatting_is_exact_at_every_width() {
        assert_eq!(format_decimal(12345, 2), "123.45");
        assert_eq!(format_decimal(-12345, 2), "-123.45");
        assert_eq!(format_decimal(1, 6), "0.000001");
        assert_eq!(format_decimal(0, 4), "0.0000");
        assert_eq!(format_decimal(-42, 0), "-42");
        // The case rust_decimal cannot represent: 38-digit payload.
        assert_eq!(format_decimal(99999999999999999999999999999999999999i128, 38),
                   "0.99999999999999999999999999999999999999");
    }

    #[tokio::test]
    async fn read_only_is_refused_by_duckdb_itself() {
        let path = tmp_path("ro");
        let _ = std::fs::remove_file(&path);
        {
            let s = mem().await;
            execute(&s, &format!(
                "ATTACH '{}' AS rw; CREATE TABLE rw.t (a INTEGER); INSERT INTO rw.t VALUES (1); DETACH rw",
                path.display())).await.unwrap();
        }

        let mut c = ConnectionConfig::new(Engine::Duckdb, "ro");
        c.file_path = Some(path.to_string_lossy().into_owned());
        c.read_only = true;
        let s = open(&c).await.unwrap();
        assert!(s.is_read_only());

        // Reads work…
        assert_eq!(execute(&s, "SELECT a FROM t").await.unwrap().rows.len(), 1);
        // …and the WRITE is refused by DuckDB, not by our guard.
        for stmt in ["INSERT INTO t VALUES (2)", "CREATE TABLE nope (a INTEGER)"] {
            let err = execute(&s, stmt).await.unwrap_err().to_string().to_lowercase();
            assert!(err.contains("read-only") || err.contains("readonly"),
                    "`{stmt}` was not refused: {err}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn interrupt_stops_a_running_query() {
        let s = Arc::new(mem().await);
        let s2 = s.clone();
        let q = tokio::spawn(async move {
            // A cross join that runs far longer than the test's patience.
            execute(&s2, "SELECT count(*) FROM range(100000000) a, range(100000000) b \
                          WHERE a.range = b.range").await
        });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        s.interrupt();
        let r = q.await.unwrap();
        let err = r.unwrap_err().to_string().to_lowercase();
        assert!(err.contains("interrupt"), "expected an interrupt error, got: {err}");
        // The session survives: interrupt is a request, not a kill.
        assert_eq!(execute(&s, "SELECT 1").await.unwrap().rows.len(), 1);
    }

    #[tokio::test]
    async fn schema_tree_lists_tables_views_and_macros() {
        let s = mem().await;
        execute(&s, "CREATE TABLE orders (id INTEGER PRIMARY KEY, total DECIMAL(9,2) NOT NULL);
                     CREATE INDEX idx_total ON orders (total);
                     CREATE VIEW big AS SELECT * FROM orders WHERE total > 100;
                     CREATE MACRO twice(x) AS x * 2").await.unwrap();

        let dbs = list_databases(&s).await.unwrap();
        assert!(dbs.iter().any(|n| matches!(n, SchemaNode::Database { name } if name == "memory")),
                "{dbs:?}");

        let objs = list_schema(&s, Some("memory")).await.unwrap();
        assert!(objs.iter().any(|n| matches!(n,
            SchemaNode::Table { name, schema: Some(s), .. } if name == "main.orders" && s == "main")),
            "{objs:?}");
        assert!(objs.iter().any(|n| matches!(n, SchemaNode::View { name, .. } if name == "main.big")));
        assert!(objs.iter().any(|n| matches!(n,
            SchemaNode::Routine { name, routine_type, .. } if name == "main.twice" && routine_type == "MACRO")));

        let cols = list_columns(&s, "memory", "main.orders").await.unwrap();
        assert!(cols.iter().any(|n| matches!(n,
            SchemaNode::Column { name, primary_key: true, .. } if name == "id")), "{cols:?}");
        assert!(cols.iter().any(|n| matches!(n,
            SchemaNode::Column { name, nullable: false, .. } if name == "total")));
        assert!(cols.iter().any(|n| matches!(n,
            SchemaNode::Index { name, unique: false, columns }
                if name == "idx_total" && columns == &["total"])), "{cols:?}");

        let ddl = get_ddl(&s, "memory", "main.orders").await.unwrap();
        assert!(ddl.contains("CREATE TABLE orders"), "{ddl}");
        assert!(ddl.contains("idx_total"), "{ddl}");
        let vddl = get_ddl(&s, "memory", "main.big").await.unwrap();
        assert!(vddl.to_uppercase().contains("CREATE VIEW"), "{vddl}");
    }

    /// Parameterised execution — the data browser's path. DuckDB compares a
    /// bound VARCHAR against an INTEGER column by casting, so the builder's
    /// all-strings parameter set works.
    #[tokio::test]
    async fn bound_parameters_filter_rows() {
        let s = mem().await;
        execute(&s, "CREATE TABLE items (id INTEGER, name VARCHAR);
                     INSERT INTO items VALUES (1,'a'),(2,'b'),(3,'c')").await.unwrap();
        let r = execute_params(&s, "SELECT name FROM items WHERE id = ?",
                               &["2".to_string()]).await.unwrap();
        assert_eq!(r.rows.len(), 1);
        assert_eq!(r.rows[0][0], serde_json::json!("b"));
    }

    /// Querying external files is just DuckDB SQL — nothing extra to build.
    /// (A tiny Parquet written by DuckDB itself, read back through SQL.)
    #[tokio::test]
    async fn parquet_and_csv_files_are_queryable_as_sql() {
        let dir = std::env::temp_dir().join(format!("txui-duckdb-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pq = dir.join("t.parquet");
        let _ = std::fs::remove_file(&pq);

        let s = mem().await;
        execute(&s, &format!("COPY (SELECT 1 AS a, 'x' AS b) TO '{}' (FORMAT PARQUET)",
                             pq.display())).await.unwrap();
        let r = execute(&s, &format!("SELECT a, b FROM '{}'", pq.display())).await.unwrap();
        assert_eq!(r.rows[0][0], serde_json::json!(1));
        assert_eq!(r.rows[0][1], serde_json::json!("x"));
        let _ = std::fs::remove_file(&pq);
    }

    #[tokio::test]
    async fn dollar_params_bind() {
        let s = mem().await;
        let r = execute_params(&s, "SELECT $1::INTEGER + 1", &["41".to_string()]).await.unwrap();
        assert_eq!(r.rows[0][0], serde_json::json!(42));
    }

    /// The data browser's PG-form builder (double-quoted identifiers + `$N`
    /// positional parameters) must run verbatim on DuckDB — this pins the two
    /// DuckDB behaviours commands/browser.rs's Duckdb arm rests on, the same
    /// way the SQLite test pins its MySQL form there. (Backticks are NOT
    /// accepted by DuckDB — measured — so the MySQL form is out.)
    #[tokio::test]
    async fn the_browse_builder_runs_verbatim_on_duckdb() {
        use crate::db::browser::{build_select, build_value_counts};
        use crate::db::types::{FilterClause, FilterOp, SortClause, SortDir};

        let s = mem().await;
        execute(&s, "CREATE TABLE items (id INTEGER, \"order\" VARCHAR, qty INTEGER);
                     INSERT INTO items VALUES (1,'a',5),(2,'b',10),(3,'a',15)").await.unwrap();

        // Plain page — double-quoted schema.table.
        let q = build_select("main.items", &[], &[], 10, 0, true, &Default::default());
        let r = execute_params(&s, &q.sql, &q.values).await.unwrap();
        assert_eq!(r.rows.len(), 3, "{}: {:?}", q.sql, r.rows);

        // Filter (binds a parameter) + sort (quotes a reserved identifier).
        let filters = vec![FilterClause {
            column: "order".into(), op: FilterOp::Eq, value: Some("a".into()),
        }];
        let sort = vec![SortClause { column: "qty".into(), direction: SortDir::Desc }];
        let q = build_select("main.items", &filters, &sort, 10, 0, true, &Default::default());
        let r = execute_params(&s, &q.sql, &q.values).await.unwrap();
        assert_eq!(r.rows.len(), 2, "filter must be applied: {}", q.sql);
        let qty = r.columns.iter().position(|c| c.name == "qty").unwrap();
        assert_eq!(r.rows[0][qty], serde_json::json!(15));

        // Offset paging + the header value-count popover.
        let q = build_select("main.items", &[], &[], 1, 2, true, &Default::default());
        let r = execute_params(&s, &q.sql, &q.values).await.unwrap();
        assert_eq!(r.rows.len(), 1);
        let q = build_value_counts("main.items", "order", &[], 10, true, &Default::default());
        let r = execute_params(&s, &q.sql, &q.values).await.unwrap();
        assert_eq!(r.rows.len(), 2);
    }

    /// Table metadata for the browser: columns, PK flags, FK targets, and an
    /// exact row count from the catalog rather than a COUNT(*) scan.
    #[tokio::test]
    async fn table_meta_carries_pk_fk_and_row_count() {
        let s = mem().await;
        execute(&s, "CREATE TABLE orders (a INTEGER, b INTEGER, PRIMARY KEY (a, b));
                     CREATE TABLE lines (x INTEGER, y INTEGER, note VARCHAR,
                        FOREIGN KEY (x, y) REFERENCES orders(a, b));
                     INSERT INTO orders VALUES (1, 1);
                     INSERT INTO lines VALUES (1, 1, 'n')").await.unwrap();

        let meta = get_table_meta(&s, "memory", "main.lines").await.unwrap();
        assert_eq!(meta.total_rows, Some(1));
        let note = meta.columns.iter().find(|c| c.name == "note").unwrap();
        assert!(note.nullable);
        let x = meta.columns.iter().find(|c| c.name == "x").unwrap();
        assert_eq!(x.fk_table.as_deref(), Some("orders"), "{x:?}");
        assert_eq!(x.fk_column.as_deref(), Some("a"), "{x:?}");

        let pk = get_table_meta(&s, "memory", "main.orders").await.unwrap();
        assert_eq!(pk.pk_columns, vec!["a".to_string(), "b".to_string()]);
    }

    /// EXPLAIN passes through as ordinary result rows (there is nothing
    /// driver-side to do — the ops layer wraps the statement).
    #[tokio::test]
    async fn explain_is_just_a_result_set() {
        let s = mem().await;
        let r = execute(&s, "EXPLAIN SELECT 42").await.unwrap();
        assert!(!r.rows.is_empty());
        let text = r.rows.iter()
            .flat_map(|row| row.iter())
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect::<Vec<_>>().join("\n");
        assert!(text.contains("42"), "{text}");
    }
    /// WP-09 9.5: what executes is the user's ORIGINAL text, sliced per
    /// statement — never the re-serialized AST (which stripped comments and
    /// could silently change semantics on any round-trip discrepancy).
    #[test]
    fn split_statements_preserves_original_text() {
        let src = "SELECT 1 /* keep me */;\nINSERT INTO t VALUES (';');";
        let parts = split_statements(src);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].0, "SELECT 1 /* keep me */");
        assert!(parts[0].0.contains("/* keep me */"), "comment stripped");
        assert!(!parts[0].1);
        assert_eq!(parts[1].0, "INSERT INTO t VALUES (';')");
        assert!(parts[1].1, "plain INSERT classifies as a write");
    }

    #[test]
    fn split_on_semicolons_respects_strings_comments_and_dollar_quotes() {
        assert_eq!(split_on_semicolons("a;b"), vec!["a", "b"]);
        assert_eq!(split_on_semicolons("SELECT ';'; SELECT 2"), vec!["SELECT ';'", " SELECT 2"]);
        assert_eq!(split_on_semicolons("-- x;y\nSELECT 1"), vec!["-- x;y\nSELECT 1"]);
        assert_eq!(split_on_semicolons("/* a;b */ SELECT 1; SELECT 2"),
                   vec!["/* a;b */ SELECT 1", " SELECT 2"]);
        assert_eq!(split_on_semicolons("SELECT $tag$ ; $tag$; SELECT 2"),
                   vec!["SELECT $tag$ ; $tag$", " SELECT 2"]);
        assert_eq!(split_on_semicolons("SELECT 'it''s;fine'; SELECT 2"),
                   vec!["SELECT 'it''s;fine'", " SELECT 2"]);
    }

}
