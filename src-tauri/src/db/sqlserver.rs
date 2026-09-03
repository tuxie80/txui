//! SQL Server driver — tiberius (TDS 7.3+) over a Tokio TCP stream, rustls TLS.
//!
//! Plan-dba-focus.md WS 1: registered as `Engine::SqlServer` / the
//! `LiveSession::SqlServer` arm — connect, query, schema tree, DDL, browser,
//! processlist/kill via DMVs. What is deliberately NOT wired is named below.
//!
//! Facts established by the spike (src/bin/mssql_spike.rs), which this module
//! is the productised form of:
//!
//! 1. **One client, behind a mutex.** `Client` methods take `&mut self` — a
//!    TDS connection is a single request/response stream — so the session holds
//!    it in a `tokio::sync::Mutex`. That mutex *is* the concurrency model,
//!    the same statement DuckDB makes about its connection.
//! 2. **No cancel API.** tiberius exposes nothing that sends a TDS Attention
//!    packet. The spike measured the fallback: dropping the client closes the
//!    TCP socket and the server aborts the in-flight request; a fresh
//!    connection then works. Registration must wire Stop to drop+reconnect,
//!    not to a per-query kill.
//! 3. **TLS is rustls with OS-native roots** (`TrustConfig::Default`), the
//!    same stance as the sqlx engines and reqwest. `Config::new()` defaults
//!    to `EncryptionLevel::Required`.
//!
//! Certificate trust: `ssl_ca_path` *narrows* trust to a private CA and keeps
//! verification on; `ConnectionConfig::trust_server_cert` turns verification
//! **off** and accepts any certificate. The second exists because a stock SQL
//! Server container presents a self-signed cert and `Config::new()` defaults to
//! `EncryptionLevel::Required` — without it there is no way to connect to a dev
//! container from the product path at all, which is why this engine went so
//! long without live verification.
//!
//! Known gaps, deliberately left for the registration step (each is a config
//! or capability decision, not a driver bug):
//!   * **No Windows/integrated auth.** The `winauth` feature (SSPI) is off in
//!     Cargo.toml; only SQL logins (`AuthMethod::sql_server`) are supported.
//!   * **No named-instance resolution.** `sql-browser-tokio` (UDP 1434) is off;
//!     connections are host:port only.
//!   * **No driver-level read-only switch.** MySQL sets
//!     `transaction_read_only`, ClickHouse sends `readonly=1`; TDS has no
//!     equivalent session flag (ApplicationIntent=ReadOnly only steers AG
//!     routing). Read-only enforcement for SQL Server rests on sqlguard alone.

use anyhow::{anyhow, bail, Result};
use futures_util::StreamExt;
use std::sync::Arc;
use std::time::Instant;
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, FromSql, QueryItem};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::types::{
    json_f64, ColumnInfo, ConnectionConfig, FilterClause, PingResult, QueryResult, Row,
    SchemaNode, SortClause, SortDir, SslMode, TableColumn, TableMeta, DEFAULT_CONNECT_TIMEOUT_SECS,
};

/// tiberius speaks futures-io traits; a tokio TCP stream crosses the bridge
/// via `Compat` (the spike's pattern).
type MsClient = Client<Compat<TcpStream>>;

/// A live SQL Server session: one connection behind a mutex, plus what it was
/// opened against. Cloning shares the connection (Arc) — there is only ever
/// one socket.
#[derive(Clone)]
pub struct SqlServerSession {
    client: Arc<Mutex<MsClient>>,
    database: String,
    read_only: bool,
    /// Connect parameters, retained for auxiliary connections and reconnects.
    /// Holds the password — as the sqlx pools do for the other engines, which
    /// keep their credentials in the pool's connect options for exactly the
    /// same reason.
    cfg: MsConfig,
    /// Set between `begin()` and `commit`/`rollback`.
    ///
    /// Exists for one reason: `execute_capped` reconnects when the connection
    /// dies, and a reconnect **destroys an open transaction**. Retrying the
    /// statement on the new connection would run it outside the transaction the
    /// user believes is open — an uncommitted write silently becoming a
    /// committed one. The flag lets that case be refused rather than retried.
    in_tx: Arc<std::sync::atomic::AtomicBool>,
}

impl std::fmt::Debug for SqlServerSession {
    // Never let connection details (least of all anything credential-adjacent)
    // reach a log line — the same discipline as ChSession's custom Debug.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqlServerSession")
            .field("database", &self.database)
            .field("read_only", &self.read_only)
            .finish_non_exhaustive()
    }
}

impl SqlServerSession {
    /// The database this session resolves unqualified names against.
    pub fn database(&self) -> &str {
        &self.database
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }
}

/// Everything a connect needs, in one place. `open()` derives this from a
/// `ConnectionConfig`; the live tests build one the same way, from either a
/// saved connection or `TXUI_MSSQL_*`.
///
/// The session keeps a copy so it can open **auxiliary** connections: TDS has
/// no out-of-band channel, and the session's own client is behind a mutex held
/// for the duration of a query, so anything that must talk to the server *while
/// a query runs* — cancelling it, asking whether it is still alive — needs a
/// second connection. The sqlx engines get this free from their pools.
#[derive(Clone)]
struct MsConfig {
    host: String,
    port: u16,
    user: String,
    password: String,
    database: Option<String>,
    encrypt: EncryptionLevel,
    trust_cert: bool,
    /// Custom CA to pin verification to (`ssl_ca_path`).
    ca_path: Option<String>,
    connect_timeout_secs: u64,
}

/// Map the house `SslMode` onto tiberius's `EncryptionLevel`.
///
/// | SslMode    | EncryptionLevel | notes |
/// |------------|-----------------|-------|
/// | Disable    | NotSupported    | ADO's DANGER_PLAINTEXT — nothing encrypted, not even the login |
/// | Preferred  | On              | encrypt if the server can, plain if it cannot |
/// | Require    | Required        | encrypted or fail |
/// | VerifyCa   | Required        | with `trust_cert_ca(path)` when `ssl_ca_path` is set |
/// | VerifyFull | Required        | rustls verifies the hostname by default |
///
/// tiberius exposes no verify-CA-but-not-hostname mode (rustls always checks
/// the hostname once verification is on), so **VerifyCa without a CA path
/// degrades to Required** — certificate AND hostname are both verified. That
/// is stricter than the MySQL/PG reading of VerifyCa, never weaker.
fn encryption_level(mode: &SslMode) -> EncryptionLevel {
    match mode {
        SslMode::Disable => EncryptionLevel::NotSupported,
        SslMode::Preferred => EncryptionLevel::On,
        SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => EncryptionLevel::Required,
    }
}

fn ms_config_from(config: &ConnectionConfig, password: Option<String>) -> Result<MsConfig> {
    // Same macOS ::1-only resolution trap the other drivers guard against.
    let host = config.host.as_deref().unwrap_or("127.0.0.1");
    let host = super::util::pin_localhost(host);
    Ok(MsConfig {
        host: host.to_string(),
        port: config.port.unwrap_or(1433),
        user: config.user.clone().unwrap_or_default(),
        password: password.unwrap_or_default(),
        database: config.database.clone().filter(|s| !s.is_empty()),
        encrypt: encryption_level(&config.ssl_mode),
        trust_cert: config.trust_server_cert,
        ca_path: config.ssl_ca_path.clone().filter(|p| !p.is_empty()),
        connect_timeout_secs: config
            .connect_timeout_secs
            .map(u64::from)
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT_SECS)
            .max(1),
    })
}

async fn connect(cfg: &MsConfig) -> Result<MsClient> {
    let mut config = Config::new();
    config.host(&cfg.host);
    config.port(cfg.port);
    config.authentication(AuthMethod::sql_server(&cfg.user, &cfg.password));
    config.encryption(cfg.encrypt);
    // Shows up in sys.dm_exec_sessions.program_name — the MySQL engines have
    // no way to send this, TDS does.
    config.application_name("TxUI");
    if let Some(db) = &cfg.database {
        config.database(db);
    }
    if let Some(ca) = &cfg.ca_path {
        // Pin verification to the deployment's private CA instead of the OS
        // roots. Verification itself stays ON — this is trust narrowing, not
        // trust bypass.
        config.trust_cert_ca(ca);
    }
    if cfg.trust_cert {
        // Accept ANY server certificate — verification off, not narrowed.
        // The connection form states that plainly and defaults it off. It
        // exists because a stock SQL Server container has no other way in:
        // self-signed cert, `EncryptionLevel::Required` by default.
        config.trust_cert();
    }
    let timeout = std::time::Duration::from_secs(cfg.connect_timeout_secs);
    let tcp = tokio::time::timeout(timeout, TcpStream::connect(config.get_addr()))
        .await
        .map_err(|_| anyhow!("connection to {}:{} timed out after {}s", cfg.host, cfg.port, cfg.connect_timeout_secs))??;
    tcp.set_nodelay(true)?;
    let client = tokio::time::timeout(timeout, Client::connect(config, tcp.compat_write()))
        .await
        .map_err(|_| anyhow!("TDS login to {}:{} timed out after {}s", cfg.host, cfg.port, cfg.connect_timeout_secs))??;
    Ok(client)
}

pub async fn open(config: &ConnectionConfig, password: Option<String>) -> Result<SqlServerSession> {
    let ms = ms_config_from(config, password)?;
    let client = connect(&ms).await?;
    Ok(SqlServerSession {
        client: Arc::new(Mutex::new(client)),
        database: ms.database.clone().unwrap_or_else(|| "master".into()),
        read_only: config.read_only,
        cfg: ms,
        in_tx: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    })
}

// ── Errors ───────────────────────────────────────────────────────────────────

/// A server error is the one the user can act on: surface SQL Server's own
/// Msg/Level/State/Line rather than tiberius's enum Debug noise.
fn ms_error(e: tiberius::error::Error) -> anyhow::Error {
    match &e {
        tiberius::error::Error::Server(token) => anyhow!(
            "Msg {}, Level {}, State {}, Line {}: {}",
            token.code(),
            token.class(),
            token.state(),
            token.line(),
            token.message()
        ),
        _ => anyhow!("{e}"),
    }
}

// ── Ping ─────────────────────────────────────────────────────────────────────

/// Open an explicit transaction on the session's connection.
///
/// SQL Server needs no connection pinning for this — unlike MySQL and
/// PostgreSQL, whose pools would otherwise scatter the statements of one
/// transaction across different backends, a TDS session **is** a single
/// connection. Everything the editor runs already lands on it, so `BEGIN
/// TRANSACTION` here simply holds until it is ended.
pub async fn begin(session: &SqlServerSession) -> Result<()> {
    execute(session, "BEGIN TRANSACTION").await?;
    session.in_tx.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// End it. `COMMIT` or `ROLLBACK`, and the flag clears either way — including
/// on failure, because a failed COMMIT on a doomed transaction still leaves no
/// transaction open.
pub async fn end_tx(session: &SqlServerSession, commit: bool) -> Result<()> {
    let verb = if commit { "COMMIT TRANSACTION" } else { "ROLLBACK TRANSACTION" };
    let r = execute(session, verb).await.map(|_| ());
    session.in_tx.store(false, std::sync::atomic::Ordering::SeqCst);
    r
}

/// `@@TRANCOUNT` — the server's own count of nested open transactions.
///
/// The source of truth for "is a transaction open", in preference to the local
/// flag: it survives anything the client thinks it knows, and after a reconnect
/// it correctly reports 0 rather than the flag's stale `true`.
pub async fn trancount(session: &SqlServerSession) -> Result<i64> {
    let r = execute(session, "SELECT @@TRANCOUNT").await?;
    Ok(r.rows.first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_i64())
        .unwrap_or(0))
}

/// Is autocommit on? SQL Server expresses the inverse: bit 2 of `@@OPTIONS` is
/// IMPLICIT_TRANSACTIONS, so autocommit is that bit being clear.
pub async fn autocommit(session: &SqlServerSession) -> Result<bool> {
    let r = execute(session, "SELECT @@OPTIONS & 2").await?;
    Ok(r.rows.first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_i64())
        .map(|bit| bit == 0)
        .unwrap_or(true))
}

/// The session's own server-side id (`@@SPID`), for the kill path.
///
/// Uses the session's client, so call it *before* a long query starts, not
/// during — the mutex is held for the query's duration. `execute_query`
/// registers it exactly like MySQL's `CONNECTION_ID()`.
pub async fn spid(session: &SqlServerSession) -> Result<u64> {
    let r = execute(session, "SELECT @@SPID").await?;
    r.rows.first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .map(|n| n as u64)
        .ok_or_else(|| anyhow!("@@SPID returned no value"))
}

/// A **second** connection to the same server, for work that cannot wait for
/// the session's client.
///
/// Killing a runaway query is the reason this exists: the query holds the
/// session mutex until it returns, so the KILL has to come from somewhere else.
/// The other engines get this from their connection pool; TDS gives us one
/// connection per session, so we open another.
/// Does this error mean the TCP connection is gone, rather than the statement
/// being rejected?
///
/// Only these get a reconnect-and-retry. A syntax error or a permission denial
/// must surface as itself — retrying it would just run it twice, and on a
/// write that is a correctness bug, not a slow path.
fn is_connection_dead(e: &tiberius::error::Error) -> bool {
    match e {
        tiberius::error::Error::Io { .. } => true,
        // The server ends a KILLed session with a message rather than a socket
        // error often enough that the text has to be checked too.
        tiberius::error::Error::Protocol(m) | tiberius::error::Error::Encoding(m) =>
            m.contains("closed") || m.contains("reset") || m.contains("EOF"),
        _ => false,
    }
}

pub(crate) async fn aux_connect(session: &SqlServerSession) -> Result<MsClient> {
    connect(&session.cfg).await
}

/// Kill a session by id, from an auxiliary connection.
///
/// **T-SQL has one `KILL` and it ends the whole session.** There is no
/// `KILL QUERY` equivalent — no way to stop the statement and keep the
/// connection, which is what MySQL's `KILL QUERY` and PostgreSQL's
/// `pg_cancel_backend` do. tiberius also does not implement the TDS *attention*
/// signal, the protocol-level graceful cancel. So on SQL Server, cancelling is
/// killing, and the UI has to say so rather than implying a polite request.
///
/// The caller's connection dies with the kill; `execute_capped` reconnects on
/// the next statement.
pub async fn kill_spid(session: &SqlServerSession, spid: u64) -> Result<()> {
    let mut aux = aux_connect(session).await?;
    // `spid` is a u64 from the server's own DMVs or @@SPID, never user text.
    aux.simple_query(format!("KILL {spid}")).await.map_err(ms_error)?;
    Ok(())
}

/// Is that session id still on the server?
///
/// From an auxiliary connection, so it answers while the session's own client
/// is busy — which is precisely when the question is asked: after a kill, to
/// find out whether the thing actually died.
pub(crate) async fn session_alive(session: &SqlServerSession, spid: u64) -> Result<bool> {
    let mut aux = aux_connect(session).await?;
    let stream = aux
        .simple_query(format!(
            "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE session_id = {spid}"))
        .await
        .map_err(ms_error)?;
    let row = stream.into_row().await.map_err(ms_error)?;
    Ok(row.and_then(|r| r.get::<i32, _>(0)).unwrap_or(0) > 0)
}

pub async fn ping(config: &ConnectionConfig, password: Option<String>) -> PingResult {
    let start = Instant::now();
    let session = match open(config, password).await {
        Ok(s) => s,
        Err(e) => {
            return PingResult {
                ok: false,
                latency_ms: 0,
                server_version: None,
                error: Some(e.to_string()),
            }
        }
    };
    match execute(&session, "SELECT @@VERSION").await {
        Ok(r) => {
            let v = r.rows.first()
                .and_then(|row| row.first())
                .and_then(|v| v.as_str())
                .map(|s| s.lines().next().unwrap_or(s).to_string());
            PingResult {
                ok: true,
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: v,
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

// ── Row decoding ─────────────────────────────────────────────────────────────
//
// The doctrine (AGENTS.md): NULL checked first; integers stay exact; DECIMAL
// rendered as a string, never through f64; NaN/±Infinity become string
// sentinels; a failed typed decode falls through to a string, never NULL.
//
// On the wire every TDS value is `Option<…>` inside its `ColumnData` variant —
// `None` IS the NULL, so "NULL first" is the structure of the match, not a
// pre-check.

/// Trim trailing zeros from a rendered fractional-seconds part.
///
/// chrono's `%.f` prints 0, 3, 6 or 9 digits, so a `datetime2(7)` value comes
/// out as `03:04:05.123456700` where SQL Server — and SSMS, and sqlcmd — render
/// `03:04:05.1234567`. Same instant, but three digits of precision the column
/// does not have, which in a DBA tool reads as the tool being wrong.
///
/// Matching SQL Server exactly is not possible from the value alone: the server
/// pads to the column's DECLARED scale (`datetime2(7)` renders `.1200000` for
/// twelve hundredths), and tiberius hands us a `NaiveDateTime` with no scale
/// attached. So the rule here is **never show precision the value does not
/// have**: trim trailing zeros, and drop the dot entirely when the fraction is
/// zero. `.123456700` → `.1234567`, `.120000000` → `.12`, `.000000000` → ``.
///
/// The round trip is exact either way — this is a rendering decision, recorded
/// in plan-sqlserver.md §1.1 rather than left to whoever reads the grid.
fn trim_frac(rendered: String) -> String {
    let Some(dot) = rendered.find('.') else { return rendered };
    // The fraction runs to the first non-digit (the " +02:30" of an offset).
    let after = &rendered[dot + 1..];
    let frac_len = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
    let (frac, tail) = after.split_at(frac_len);
    let trimmed = frac.trim_end_matches('0');
    if trimmed.is_empty() {
        format!("{}{}", &rendered[..dot], tail)
    } else {
        format!("{}.{}{}", &rendered[..dot], trimmed, tail)
    }
}

/// Decode one cell to its JSON value. `ColumnData<'static>` because a `Row`
/// owns its data (and `FromSql` requires the 'static form).
fn cell_to_json(data: &ColumnData<'static>) -> serde_json::Value {
    use serde_json::Value as J;
    match data {
        ColumnData::U8(v) => v.map_or(J::Null, J::from),
        ColumnData::I16(v) => v.map_or(J::Null, J::from),
        ColumnData::I32(v) => v.map_or(J::Null, J::from),
        ColumnData::I64(v) => v.map_or(J::Null, J::from),
        ColumnData::F32(v) => v.map_or(J::Null, |x| json_f64(f64::from(x))),
        ColumnData::F64(v) => v.map_or(J::Null, json_f64),
        ColumnData::Bit(v) => v.map_or(J::Null, J::Bool),
        ColumnData::String(v) => v.as_deref().map_or(J::Null, |s| J::String(s.to_owned())),
        ColumnData::Guid(v) => v.map_or(J::Null, |g| J::String(g.to_string())),
        // SSMS renders binary as 0x…; match that rather than inventing base64.
        ColumnData::Binary(v) => v.as_ref()
            .map_or(J::Null, |b| J::String(format!("0x{}", hex::encode_upper(b)))),
        // Exact decimal: value: i128 + scale: u8, and Numeric's Display is the
        // exact string. Never through f64. (The spike additionally proved the
        // rust_decimal FromSql impl round-trips the same string.)
        ColumnData::Numeric(v) => v.map_or(J::Null, |n| J::String(n.to_string())),
        ColumnData::Xml(v) => v.as_ref().map_or(J::Null, |x| J::String(x.to_string())),
        // Datetimes decode through chrono. On a decode failure the RAW value's
        // Debug is the display string — a typed decode that fails must fall
        // through to a string, never masquerade as NULL.
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            match chrono::NaiveDateTime::from_sql(data) {
                Ok(Some(dt)) => J::String(trim_frac(dt.format("%Y-%m-%d %H:%M:%S%.f").to_string())),
                Ok(None) => J::Null,
                Err(_) => J::String(format!("{data:?}")),
            }
        }
        ColumnData::Date(_) => match chrono::NaiveDate::from_sql(data) {
            Ok(Some(d)) => J::String(d.to_string()),
            Ok(None) => J::Null,
            Err(_) => J::String(format!("{data:?}")),
        },
        ColumnData::Time(_) => match chrono::NaiveTime::from_sql(data) {
            Ok(Some(t)) => J::String(trim_frac(t.format("%H:%M:%S%.f").to_string())),
            Ok(None) => J::Null,
            Err(_) => J::String(format!("{data:?}")),
        },
        // datetimeoffset → chrono::DateTime<FixedOffset>, which PRESERVES the
        // raw offset. (The Utc decode tiberius also offers would silently
        // convert, dropping the offset the column was defined to keep.)
        ColumnData::DateTimeOffset(_) => {
            match chrono::DateTime::<chrono::FixedOffset>::from_sql(data) {
                Ok(Some(dt)) => J::String(trim_frac(dt.format("%Y-%m-%d %H:%M:%S%.f %:z").to_string())),
                Ok(None) => J::Null,
                Err(_) => J::String(format!("{data:?}")),
            }
        }
    }
}

/// A display name for the wire `ColumnType`. TDS result metadata carries the
/// type tag but not precision/scale/length, so these are the bare type names —
/// exact enough for the grid header, with `list_columns` carrying the precise
/// `nvarchar(50)` form from `sys.columns`.
fn column_type_name(t: ColumnType) -> &'static str {
    match t {
        ColumnType::Null => "null",
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 | ColumnType::Intn => "int",
        ColumnType::Int8 => "bigint",
        ColumnType::Datetime4 => "smalldatetime",
        ColumnType::Datetime | ColumnType::Datetimen => "datetime",
        ColumnType::Float4 => "real",
        ColumnType::Float8 | ColumnType::Floatn => "float",
        ColumnType::Money => "money",
        ColumnType::Money4 => "smallmoney",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::Decimaln | ColumnType::Numericn => "decimal",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::BigVarBin => "varbinary",
        ColumnType::BigVarChar => "varchar",
        ColumnType::BigBinary => "binary",
        ColumnType::BigChar => "char",
        ColumnType::NVarchar => "nvarchar",
        ColumnType::NChar => "nchar",
        ColumnType::Xml => "xml",
        ColumnType::Udt => "udt",
        ColumnType::Text => "text",
        ColumnType::Image => "image",
        ColumnType::NText => "ntext",
        ColumnType::SSVariant => "sql_variant",
    }
}

fn column_info(c: &tiberius::Column) -> ColumnInfo {
    ColumnInfo {
        name: c.name().to_string(),
        type_name: column_type_name(c.column_type()).to_string(),
        // TDS column metadata carries no nullability flag (Row::columns() is
        // name + type tag), so nullable is unknown → true, the display that
        // never claims a guarantee the server did not state.
        nullable: true,
    }
}

/// Drain a `QueryStream` into result sets, decoding every cell. `max_rows`
/// caps the TOTAL rows collected across sets — past it the stream is
/// abandoned and the third return value is true (truncated). The cap counts
/// totals rather than per-set because only the first columned set is ever
/// returned to the caller, and breaking early biases toward exactly that set.
async fn collect_stream(
    stream: tiberius::QueryStream<'_>,
    start: &Instant,
    max_rows: Option<usize>,
) -> Result<(Vec<(Vec<ColumnInfo>, Vec<Row>)>, Option<u64>, bool)> {
    let mut stream = stream;
    let mut sets: Vec<(Vec<ColumnInfo>, Vec<Row>)> = Vec::new();
    let mut first_row_ms: Option<u64> = None;
    let mut total_rows = 0usize;
    let mut truncated = false;
    while let Some(item) = stream.next().await {
        match item.map_err(ms_error)? {
            QueryItem::Metadata(meta) => {
                sets.push((meta.columns().iter().map(column_info).collect(), Vec::new()));
            }
            QueryItem::Row(row) => {
                if first_row_ms.is_none() {
                    first_row_ms = Some(start.elapsed().as_millis() as u64);
                }
                if max_rows.is_some_and(|cap| total_rows >= cap) {
                    truncated = true;
                    break;
                }
                // Defensive: a row without a preceding metadata item. tiberius
                // emits Metadata on every column-set change, so this should be
                // unreachable, but the row carries its own columns and dropping
                // it would lose data.
                if sets.is_empty() {
                    sets.push((row.columns().iter().map(column_info).collect(), Vec::new()));
                }
                let cells: Row = row.cells().map(|(_, d)| cell_to_json(d)).collect();
                if let Some(last) = sets.last_mut() {
                    last.1.push(cells);
                }
                total_rows += 1;
            }
        }
    }
    Ok((sets, first_row_ms, truncated))
}

/// Build the QueryResult from collected sets.
///
/// The FIRST set with columns wins: a T-SQL batch's `SET`/`DECLARE`/DML
/// statements produce no column metadata, so the first columned set is the
/// SELECT the user wrote the batch for (including `INSERT …; SELECT
/// SCOPE_IDENTITY()`).
///
/// `rows_affected` is honest about a limitation: the row-stream API discards
/// the DoneToken counts (only `Client::execute`, which discards rows, exposes
/// them). A no-result batch therefore reports Some(0) rather than a fabricated
/// count; wiring both rows AND counts for one statement is a registration-step
/// decision (two API calls or a `SET NOCOUNT` policy), not something to fake.
fn result_from_sets(
    mut sets: Vec<(Vec<ColumnInfo>, Vec<Row>)>,
    start: &Instant,
    first_row_ms: Option<u64>,
    truncated: bool,
) -> QueryResult {
    let total_ms = start.elapsed().as_millis() as u64;
    let execution_ms = first_row_ms.unwrap_or(total_ms);
    match sets.iter().position(|(cols, _)| !cols.is_empty()) {
        Some(i) => {
            let (columns, rows) = sets.swap_remove(i);
            QueryResult {
                columns,
                rows,
                rows_affected: None,
                execution_ms,
                fetch_ms: total_ms - execution_ms,
                warnings: vec![],
                truncated,
            }
        }
        None => QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: Some(0),
            execution_ms,
            fetch_ms: total_ms - execution_ms,
            warnings: vec![],
            truncated: false,
        },
    }
}

pub async fn execute(session: &SqlServerSession, sql: &str) -> Result<QueryResult> {
    execute_capped(session, sql, None).await
}

/// As `execute`, fetching at most `max_rows` rows; past the cap the stream is
/// abandoned and `truncated` is set on the result.
pub async fn execute_capped(
    session: &SqlServerSession,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult> {
    let start = Instant::now();
    let mut client = session.client.lock().await;
    // First attempt. The success arm consumes the stream and returns, so its
    // borrow of `client` has ended before the reconnect below reassigns it.
    match client.simple_query(sql).await {
        Ok(stream) => {
            let (sets, first_row_ms, truncated) = collect_stream(stream, &start, max_rows).await?;
            return Ok(result_from_sets(sets, &start, first_row_ms, truncated));
        }
        Err(e) if is_connection_dead(&e) => {}   // fall through and reconnect
        Err(e) => return Err(ms_error(e)),
    }

    // The connection is gone — almost always because this session's own query
    // was KILLed, since T-SQL has no kill-the-query-only form and a cancel
    // takes the connection with it. Reconnect once and run the statement, so a
    // cancel does not leave the session unusable and make the user close and
    // reopen the tab.
    //
    // EXCEPT inside a transaction. A reconnect is a new session, so the
    // transaction is gone and everything in it is rolled back by the server.
    // Retrying the statement there would run it OUTSIDE the transaction the
    // user still believes is open — an uncommitted write quietly becoming a
    // committed one. Reconnect so the session stays usable, but refuse the
    // statement and say what happened.
    let was_in_tx = session.in_tx.swap(false, std::sync::atomic::Ordering::SeqCst);
    *client = connect(&session.cfg).await
        .map_err(|re| anyhow!("connection lost and could not be reopened: {re}"))?;
    if was_in_tx {
        bail!("the connection dropped while a transaction was open, so the server \
               rolled it back — this statement was NOT run, because running it on \
               the new connection would have committed it outside the transaction");
    }
    let stream = client.simple_query(sql).await.map_err(ms_error)?;
    let (sets, first_row_ms, truncated) = collect_stream(stream, &start, max_rows).await?;
    Ok(result_from_sets(sets, &start, first_row_ms, truncated))
}

/// A query plan, as SHOWPLAN_XML.
///
/// SQL Server has no `EXPLAIN` keyword. `SET SHOWPLAN_XML ON` puts the session
/// into a mode where statements are compiled and returned as XML instead of
/// run; `SET STATISTICS XML ON` is the measured counterpart — the query really
/// executes and the plan comes back with actual row counts.
///
/// This lives in the SQL Server module rather than in `commands::ops` because
/// all three of its awkward parts are SQL Server's, not the caller's:
///
///  * **The SET must be alone in its batch.** Prefixing it onto the user's SQL
///    the way `EXPLAIN` is prefixed elsewhere is Msg 1067.
///  * **It is session state and must be turned back off.** A connection left in
///    SHOWPLAN mode silently stops executing anything — every later query
///    returns a plan and changes nothing, which reads as the server ignoring
///    the user. The reset therefore runs whether the statement succeeded or not.
///  * **`STATISTICS XML` puts the plan in a SECOND result set**, after the
///    query's own rows. `execute` keeps only the first non-empty set, so the
///    plan never reached the caller — measured, not deduced: the live test
///    below failed on exactly this before the stream was read whole.
pub async fn explain_xml(
    session: &SqlServerSession,
    sql: &str,
    measured: bool,
) -> Result<String> {
    let (on, off) = if measured {
        ("SET STATISTICS XML ON", "SET STATISTICS XML OFF")
    } else {
        ("SET SHOWPLAN_XML ON", "SET SHOWPLAN_XML OFF")
    };

    execute(session, on).await?;
    let planned = plan_sets(session, sql).await;
    // Reset first, report second — an error must not leave the session
    // planning instead of running.
    let reset = execute(session, off).await;
    let sets = planned?;
    reset?;

    sets.iter()
        .flatten()
        .flatten()
        .filter_map(|v| v.as_str())
        .find(|c| c.trim_start().starts_with("<ShowPlanXML"))
        .map(|c| c.to_string())
        .ok_or_else(|| anyhow!(
            "{on} returned no plan — the statement compiled to nothing, or it is not \
             a statement SQL Server plans"))
}

/// Every result set's rows, unlike `execute` which keeps only the first.
async fn plan_sets(session: &SqlServerSession, sql: &str) -> Result<Vec<Vec<Row>>> {
    let start = Instant::now();
    let mut client = session.client.lock().await;
    let stream = client.simple_query(sql).await.map_err(ms_error)?;
    let (sets, _, _) = collect_stream(stream, &start, None).await?;
    Ok(sets.into_iter().map(|(_, rows)| rows).collect())
}

// ── Metadata ─────────────────────────────────────────────────────────────────
//
// SQL Server is three-level (database → schema → object) where the app's
// schema tree is two. Like DuckDB, the schema is folded into the node's name
// as `schema.table` with the bare schema in the node's `schema` field — a
// three-level tree (Schema nodes between Database and Table) needs frontend
// wiring that is part of registration, not this slice.
//
// Cross-database queries use three-part names (`[db].sys.tables`), never
// `USE`: the session is one shared connection, and flipping its database
// context underneath a concurrent query is a race the bracketed name does not
// have.

/// Bracket-quote an identifier; `]` escapes as `]]`. Mirrors the TS rule in
/// src/utils/sqlIdent.ts.
fn qident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// Run a parameterized metadata query through the same decode path as user
/// queries. `@P1`, `@P2`, … bind the params (nvarchar) — never concatenated.
async fn catalog_query(
    session: &SqlServerSession,
    sql: &str,
    params: &[String],
) -> Result<QueryResult> {
    let start = Instant::now();
    let param_refs: Vec<&dyn tiberius::ToSql> =
        params.iter().map(|p| p as &dyn tiberius::ToSql).collect();
    let mut client = session.client.lock().await;
    let stream = client.query(sql, &param_refs).await.map_err(ms_error)?;
    let (sets, first_row_ms, truncated) = collect_stream(stream, &start, None).await?;
    Ok(result_from_sets(sets, &start, first_row_ms, truncated))
}

use super::util::{col_bool, col_str};

fn col_i64(row: &Row, i: usize) -> Option<i64> {
    row.get(i).and_then(|v| v.as_i64())
}

/// Split the tree's `schema.table` form into its parts; a bare `table` means
/// `dbo`, the schema SQL Server puts unqualified objects in.
fn split_schema_object(object: &str) -> (String, String) {
    match object.split_once('.') {
        Some((s, t)) => (s.to_string(), t.to_string()),
        None => ("dbo".to_string(), object.to_string()),
    }
}

/// Top level: every database on the instance, system ones included (the DBA
/// this tool is aimed at looks at master exactly as often as at user DBs).
pub async fn list_databases(session: &SqlServerSession) -> Result<Vec<SchemaNode>> {
    let r = catalog_query(session,
        "SELECT name FROM sys.databases ORDER BY name", &[]).await?;
    Ok(r.rows.iter()
        .map(|row| SchemaNode::Database { name: col_str(row, 0) })
        .collect())
}

/// `context` = database name | None = top level.
pub async fn list_schema(session: &SqlServerSession, context: Option<&str>) -> Result<Vec<SchemaNode>> {
    match context {
        Some(db) => list_objects(session, db).await,
        None => list_databases(session).await,
    }
}

/// Tables and views of one database, across its schemas (folded into the name,
/// see module docs). Row counts come from `sys.dm_db_partition_stats` — an
/// estimate read from metadata, not a COUNT(*) scan.
async fn list_objects(session: &SqlServerSession, database: &str) -> Result<Vec<SchemaNode>> {
    let tables = catalog_query(session, &format!(
        // sys.partitions spells this `rows`; sys.dm_db_partition_stats — which is
        // what is joined here — spells it `row_count`. Getting it wrong made
        // list_schema fail outright ("Invalid column name 'rows'"), so the
        // object tree was empty against every real server.
        "SELECT s.name, t.name, CAST(SUM(p.row_count) AS bigint) \
         FROM {db}.sys.tables t \
         JOIN {db}.sys.schemas s ON s.schema_id = t.schema_id \
         LEFT JOIN {db}.sys.dm_db_partition_stats p \
           ON p.object_id = t.object_id AND p.index_id IN (0, 1) \
         GROUP BY s.name, t.name ORDER BY s.name, t.name",
        db = qident(database)), &[]).await?;
    let views = catalog_query(session, &format!(
        "SELECT s.name, v.name FROM {db}.sys.views v \
         JOIN {db}.sys.schemas s ON s.schema_id = v.schema_id \
         ORDER BY s.name, v.name",
        db = qident(database)), &[]).await?;

    let mut out = Vec::new();
    for row in &tables.rows {
        let (schema, name) = (col_str(row, 0), col_str(row, 1));
        out.push(SchemaNode::Table {
            name: format!("{schema}.{name}"),
            schema: Some(schema),
            row_count: col_i64(row, 2),
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
    Ok(out)
}

/// Render `ty.name` with the length/precision that defines the column:
/// `nvarchar(50)`, `nvarchar(max)`, `decimal(38,10)`, `datetime2(7)`.
fn tsql_type_name(type_name: &str, max_length: i64, precision: i64, scale: i64) -> String {
    match type_name {
        // n-types store bytes: max_length is twice the character count.
        "nvarchar" | "nchar" => match max_length {
            -1 => format!("{type_name}(max)"),
            n => format!("{type_name}({})", n / 2),
        },
        "varchar" | "char" | "varbinary" | "binary" => match max_length {
            -1 => format!("{type_name}(max)"),
            n => format!("{type_name}({n})"),
        },
        "decimal" | "numeric" => format!("{type_name}({precision},{scale})"),
        // These carry their fractional-seconds precision in scale.
        "datetime2" | "datetimeoffset" | "time" => format!("{type_name}({scale})"),
        _ => type_name.to_string(),
    }
}

/// Columns + indexes of one table. `table` is the tree's `schema.table` form.
/// Columns of a table **or a view**.
///
/// Joins `sys.objects` filtered to `'U'`/`'V'`, not `sys.tables`: the tree
/// lists views (see `list_objects`), so joining `sys.tables` meant expanding
/// one returned an empty column list — silently, because an empty result is
/// indistinguishable from "no columns". MySQL and PostgreSQL both show view
/// columns; this brings SQL Server in line.
///
/// The PK flag is naturally false for a view, which is correct rather than a
/// special case: a view has no primary key.
pub async fn list_columns(
    session: &SqlServerSession,
    database: &str,
    table: &str,
) -> Result<Vec<SchemaNode>> {
    let (schema, table) = split_schema_object(table);
    let dbq = qident(database);
    let params = vec![schema.clone(), table.clone()];

    let cols = catalog_query(session, &format!(
        "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, \
                CASE WHEN ic.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END \
         FROM {dbq}.sys.columns c \
         JOIN {dbq}.sys.types ty ON ty.user_type_id = c.user_type_id \
         JOIN {dbq}.sys.objects t \
           ON t.object_id = c.object_id AND t.type IN ('U', 'V') \
         JOIN {dbq}.sys.schemas s ON s.schema_id = t.schema_id \
         LEFT JOIN {dbq}.sys.indexes i \
           ON i.object_id = c.object_id AND i.is_primary_key = 1 \
         LEFT JOIN {dbq}.sys.index_columns ic \
           ON ic.object_id = c.object_id AND ic.index_id = i.index_id \
          AND ic.column_id = c.column_id \
         WHERE s.name = @P1 AND t.name = @P2 \
         ORDER BY c.column_id"), &params).await?;

    let mut out = Vec::new();
    for row in &cols.rows {
        let name = col_str(row, 0);
        out.push(SchemaNode::Column {
            type_name: tsql_type_name(&col_str(row, 1),
                col_i64(row, 2).unwrap_or(0), col_i64(row, 3).unwrap_or(0),
                col_i64(row, 4).unwrap_or(0)),
            nullable: col_bool(row, 5),
            primary_key: col_bool(row, 6),
            name,
        });
    }

    let idx = catalog_query(session, &format!(
        "SELECT i.name, i.is_unique, \
                STRING_AGG(CAST(c.name AS nvarchar(max)), ',') \
                    WITHIN GROUP (ORDER BY ic.key_ordinal) \
         FROM {dbq}.sys.indexes i \
         JOIN {dbq}.sys.tables t ON t.object_id = i.object_id \
         JOIN {dbq}.sys.schemas s ON s.schema_id = t.schema_id \
         JOIN {dbq}.sys.index_columns ic \
           ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN {dbq}.sys.columns c \
           ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE s.name = @P1 AND t.name = @P2 AND i.is_hypothetical = 0 \
           AND i.name IS NOT NULL \
         GROUP BY i.name, i.is_unique ORDER BY i.name"), &params).await?;
    for row in &idx.rows {
        let name = col_str(row, 0);
        let columns = col_str(row, 2).split(',')
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .collect();
        out.push(SchemaNode::Index { name, unique: col_bool(row, 1), columns });
    }
    Ok(out)
}

/// Rich table metadata for the data browser. `table` is the tree's
/// `schema.table` form. Mirrors duckdb.rs's shape: columns + PK + FKs + an
/// estimated row count.
pub async fn get_table_meta(
    session: &SqlServerSession,
    database: &str,
    table: &str,
) -> Result<TableMeta> {
    let (schema, table) = split_schema_object(table);
    let dbq = qident(database);
    let params = vec![schema.clone(), table.clone()];

    let cols = catalog_query(session, &format!(
        "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, \
                CASE WHEN ic.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END \
         FROM {dbq}.sys.columns c \
         JOIN {dbq}.sys.types ty ON ty.user_type_id = c.user_type_id \
         JOIN {dbq}.sys.tables t ON t.object_id = c.object_id \
         JOIN {dbq}.sys.schemas s ON s.schema_id = t.schema_id \
         LEFT JOIN {dbq}.sys.indexes i \
           ON i.object_id = c.object_id AND i.is_primary_key = 1 \
         LEFT JOIN {dbq}.sys.index_columns ic \
           ON ic.object_id = c.object_id AND ic.index_id = i.index_id \
          AND ic.column_id = c.column_id \
         WHERE s.name = @P1 AND t.name = @P2 \
         ORDER BY c.column_id"), &params).await?;

    // Foreign keys: which column points at which schema.table.column.
    let fk_rows = catalog_query(session, &format!(
        "SELECT pc.name, rs.name + '.' + rt.name, rc.name \
         FROM {dbq}.sys.foreign_key_columns fkc \
         JOIN {dbq}.sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id \
         JOIN {dbq}.sys.tables pt ON pt.object_id = fkc.parent_object_id \
         JOIN {dbq}.sys.schemas ps ON ps.schema_id = pt.schema_id \
         JOIN {dbq}.sys.columns pc \
           ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
         JOIN {dbq}.sys.tables rt ON rt.object_id = fkc.referenced_object_id \
         JOIN {dbq}.sys.schemas rs ON rs.schema_id = rt.schema_id \
         JOIN {dbq}.sys.columns rc \
           ON rc.object_id = fkc.referenced_object_id \
          AND rc.column_id = fkc.referenced_column_id \
         WHERE ps.name = @P1 AND pt.name = @P2"), &params).await?;
    let mut fks: std::collections::HashMap<String, (String, String)> = Default::default();
    for row in &fk_rows.rows {
        fks.insert(col_str(row, 0), (col_str(row, 1), col_str(row, 2)));
    }

    let mut pk_columns: Vec<String> = Vec::new();
    let columns: Vec<TableColumn> = cols.rows.iter().map(|row| {
        let name = col_str(row, 0);
        let primary_key = col_bool(row, 6);
        if primary_key {
            pk_columns.push(name.clone());
        }
        let fk = fks.get(&name);
        TableColumn {
            type_name: tsql_type_name(&col_str(row, 1),
                col_i64(row, 2).unwrap_or(0), col_i64(row, 3).unwrap_or(0),
                col_i64(row, 4).unwrap_or(0)),
            nullable: col_bool(row, 5),
            primary_key,
            fk_table: fk.map(|(t, _)| t.clone()),
            fk_column: fk.map(|(_, c)| c.clone()),
            name,
        }
    }).collect();

    let size = catalog_query(session, &format!(
        // `row_count`, not `rows` — see list_objects.
        "SELECT CAST(SUM(p.row_count) AS bigint) \
         FROM {dbq}.sys.dm_db_partition_stats p \
         JOIN {dbq}.sys.tables t ON t.object_id = p.object_id \
         JOIN {dbq}.sys.schemas s ON s.schema_id = t.schema_id \
         WHERE s.name = @P1 AND t.name = @P2 AND p.index_id IN (0, 1)"), &params).await?;
    let total_rows = size.rows.first().and_then(|row| row.first()).and_then(|v| v.as_i64());

    Ok(TableMeta { columns, pk_columns, total_rows })
}

/// The stored definition of an object — SQL Server keeps source text only for
/// *modules* (views, procedures, functions, triggers) in `sys.sql_modules`.
///
/// A table has no stored DDL anywhere on the server, so for one the CREATE is
/// synthesised from `sys.columns`: bare (columns, types, nullability) and
/// labelled as reconstructed — a `SHOW CREATE TABLE` equivalent that does not
/// exist in T-SQL. Anything else errors naming the object.
pub async fn get_ddl(session: &SqlServerSession, database: &str, object: &str) -> Result<String> {
    let (schema, obj) = split_schema_object(object);
    let dbq = qident(database);
    let params = vec![schema.clone(), obj.clone()];

    let module = catalog_query(session, &format!(
        "SELECT m.definition FROM {dbq}.sys.sql_modules m \
         JOIN {dbq}.sys.objects o ON o.object_id = m.object_id \
         JOIN {dbq}.sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = @P1 AND o.name = @P2"), &params).await?;
    if let Some(text) = module.rows.first().map(|row| col_str(row, 0)).filter(|s| !s.trim().is_empty()) {
        return Ok(text);
    }

    // No module row: a table, or nothing at all. Synthesise from sys.columns.
    let cols = catalog_query(session, &format!(
        "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, \
                c.is_identity \
         FROM {dbq}.sys.columns c \
         JOIN {dbq}.sys.types ty ON ty.user_type_id = c.user_type_id \
         JOIN {dbq}.sys.tables t ON t.object_id = c.object_id \
         JOIN {dbq}.sys.schemas s ON s.schema_id = t.schema_id \
         WHERE s.name = @P1 AND t.name = @P2 \
         ORDER BY c.column_id"), &params).await?;
    if cols.rows.is_empty() {
        return Err(anyhow!("no object named {}.{} in {}", schema, obj, database));
    }

    let mut out = format!(
        "-- reconstructed from sys.columns (SQL Server stores no table DDL)\n\
         CREATE TABLE {}.{} (\n",
        qident(&schema), qident(&obj));
    for (i, row) in cols.rows.iter().enumerate() {
        let sep = if i + 1 < cols.rows.len() { "," } else { "" };
        let identity = if col_bool(row, 6) { " IDENTITY" } else { "" };
        let null = if col_bool(row, 5) { " NULL" } else { " NOT NULL" };
        out.push_str(&format!(
            "    {} {}{}{}{}\n",
            qident(&col_str(row, 0)),
            tsql_type_name(&col_str(row, 1),
                col_i64(row, 2).unwrap_or(0), col_i64(row, 3).unwrap_or(0),
                col_i64(row, 4).unwrap_or(0)),
            identity, null, sep));
    }
    out.push_str(");");
    Ok(out)
}

// ── Data browser ─────────────────────────────────────────────────────────────
//
// T-SQL spells the browse query differently from every other engine:
// bracket-quoted identifiers, `@P1`-style parameters (bound through
// `catalog_query`, never concatenated), and `TOP (n)` / `OFFSET … FETCH`
// instead of LIMIT. The builders are pure and unit-tested below; the async
// wrappers just run them.

/// A built T-SQL statement: the parameterised form that runs, its bound
/// values, and a display copy with the values inlined as literals — the log
/// line must be re-runnable, like the other engines' browse statements.
pub struct TsqlBrowse {
    pub sql: String,
    pub values: Vec<String>,
    pub display: String,
}

/// T-SQL string literal for the display copy: the quote doubles, the
/// backslash is data.
pub(crate) fn tsql_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Bracket-quote every dot-separated part of a (possibly qualified) name.
fn qname(name: &str) -> String {
    name.split('.').map(qident).collect::<Vec<_>>().join(".")
}

/// WHERE/ORDER BY shared by both builders. Values bind as `@P1`, `@P2`, …
/// in filter order; the display string inlines them as literals.
fn where_and_order(
    filters: &[FilterClause],
    sort: &[SortClause],
    values: &mut Vec<String>,
) -> (String, String) {
    let mut where_sql = String::new();
    let mut where_display = String::new();
    if !filters.is_empty() {
        let mut sql_parts: Vec<String> = Vec::new();
        let mut display_parts: Vec<String> = Vec::new();
        for f in filters {
            let col = qident(&f.column);
            if f.op.has_value() {
                let v = f.value.clone().unwrap_or_default();
                values.push(v.clone());
                sql_parts.push(format!("{} {} @P{}", col, f.op.to_sql(), values.len()));
                display_parts.push(format!("{} {} {}", col, f.op.to_sql(), tsql_literal(&v)));
            } else {
                sql_parts.push(format!("{} {}", col, f.op.to_sql()));
                display_parts.push(format!("{} {}", col, f.op.to_sql()));
            }
        }
        where_sql = format!(" WHERE {}", sql_parts.join(" AND "));
        where_display = format!(" WHERE {}", display_parts.join(" AND "));
    }
    let order = || {
        if sort.is_empty() { return String::new() }
        let parts: Vec<String> = sort.iter().map(|s| {
            let dir = match s.direction { SortDir::Asc => "ASC", SortDir::Desc => "DESC" };
            format!("{} {}", qident(&s.column), dir)
        }).collect();
        format!(" ORDER BY {}", parts.join(", "))
    };
    (format!("{}{}", where_sql, order()), format!("{}{}", where_display, order()))
}

/// Paginated SELECT for the data browser. `table` is the tree's
/// `db.schema.table` path (any part may be absent → bare name).
///
/// Paging: `TOP (n)` when there is no offset; past the first page T-SQL needs
/// `OFFSET … FETCH`, which requires an ORDER BY. With no user sort the order
/// comes from `tiebreak` (the table's PK columns): `ORDER BY (SELECT NULL)`
/// is documented as a no-op precisely because SQL Server guarantees NO stable
/// order between pages under it — rows repeated or vanished while scrolling
/// an unsorted browse. With no PK either, `ORDER BY 1` (first projected
/// column) is the deterministic-enough fallback. LIMIT/OFFSET are i64 here,
/// never user text, so they are inlined like the other engines.
pub fn build_browse_select(
    table: &str,
    filters: &[FilterClause],
    sort: &[SortClause],
    limit: i64,
    offset: i64,
    tiebreak: &[String],
) -> TsqlBrowse {
    let mut values = Vec::new();
    let (clauses, clauses_display) = where_and_order(filters, sort, &mut values);
    let (limit, offset) = (limit.max(0), offset.max(0));
    let tiebreak_order = || -> String {
        if tiebreak.is_empty() {
            " ORDER BY 1".to_string()
        } else {
            format!(" ORDER BY {}",
                tiebreak.iter().map(|c| qident(c)).collect::<Vec<_>>().join(", "))
        }
    };
    let (paging, order_pad) = if offset > 0 {
        // A stabilizing ORDER BY only when the user gave no sort — FETCH is a
        // syntax error without an ORDER BY.
        let pad = if sort.is_empty() { tiebreak_order() } else { String::new() };
        (format!(" OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"), pad)
    } else {
        (String::new(), String::new())
    };
    let top = if offset == 0 { format!("TOP ({limit}) ") } else { String::new() };
    let from = qname(table);
    TsqlBrowse {
        sql: format!("SELECT {top}* FROM {from}{clauses}{order_pad}{paging}"),
        display: format!("SELECT {top}* FROM {from}{clauses_display}{order_pad}{paging}"),
        values,
    }
}

/// Top-N most frequent values of one column, for the header filter popover.
/// Same shape as the other engines' value counts, with TOP standing in for
/// LIMIT.
pub fn build_value_counts(
    table: &str,
    column: &str,
    filters: &[FilterClause],
    limit: i64,
) -> TsqlBrowse {
    let mut values = Vec::new();
    let (clauses, clauses_display) = where_and_order(filters, &[], &mut values);
    let col = qident(column);
    let tail = format!("{clauses} GROUP BY {col} ORDER BY cnt DESC");
    let tail_display = format!("{clauses_display} GROUP BY {col} ORDER BY cnt DESC");
    let (limit, from) = (limit.max(0), qname(table));
    TsqlBrowse {
        sql: format!("SELECT TOP ({limit}) {col} AS value, COUNT(*) AS cnt FROM {from}{tail}"),
        display: format!("SELECT TOP ({limit}) {col} AS value, COUNT(*) AS cnt FROM {from}{tail_display}"),
        values,
    }
}

/// Run a built browse statement through the parameterised catalog path.
async fn run_browse(session: &SqlServerSession, q: &TsqlBrowse) -> Result<QueryResult> {
    catalog_query(session, &q.sql, &q.values).await
}

/// One page of the data browser. `parent` is the tree path
/// `db.schema.table`; the database segment is required (the session-wide
/// default db is not assumed — the tree always qualifies).
pub async fn browse_table(
    session: &SqlServerSession,
    parent: &str,
    filters: &[FilterClause],
    sort: &[SortClause],
    limit: i64,
    offset: i64,
) -> Result<(QueryResult, String)> {
    // Deterministic tiebreaker for unsorted deep pages (WP-09 9.4): fetched
    // only when it matters — no user sort, past the first page. Best-effort:
    // a table without a PK (or a failed catalog probe) falls back to
    // ORDER BY 1 inside the builder.
    let tiebreak = if sort.is_empty() && offset > 0 {
        pk_columns_of(session, parent).await
    } else {
        Vec::new()
    };
    let q = build_browse_select(parent, filters, sort, limit, offset, &tiebreak);
    Ok((run_browse(session, &q).await?, q.display))
}

/// PK column names of `db.schema.table`, in key order — one catalog query;
/// empty on any failure or when the table has no PK.
async fn pk_columns_of(session: &SqlServerSession, parent: &str) -> Vec<String> {
    let Some((db, rest)) = parent.split_once('.') else { return Vec::new() };
    let (schema, table) = split_schema_object(rest);
    let dbq = qident(db);
    let params = vec![schema, table];
    let sql = format!(
        "SELECT c.name \
         FROM {dbq}.sys.indexes i \
         JOIN {dbq}.sys.index_columns ic \
           ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN {dbq}.sys.columns c \
           ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         JOIN {dbq}.sys.tables t ON t.object_id = i.object_id \
         JOIN {dbq}.sys.schemas s ON s.schema_id = t.schema_id \
         WHERE i.is_primary_key = 1 AND s.name = @P1 AND t.name = @P2 \
         ORDER BY ic.key_ordinal");
    match catalog_query(session, &sql, &params).await {
        Ok(r) => r.rows.iter().map(|row| col_str(row, 0)).collect(),
        Err(_) => Vec::new(),
    }
}

/// The header-filter popover query. Same parent convention as `browse_table`.
pub async fn value_counts(
    session: &SqlServerSession,
    parent: &str,
    column: &str,
    filters: &[FilterClause],
    limit: i64,
) -> Result<QueryResult> {
    let q = build_value_counts(parent, column, filters, limit);
    run_browse(session, &q).await
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssl_mode_maps_to_encryption_level() {
        assert!(matches!(encryption_level(&SslMode::Disable), EncryptionLevel::NotSupported));
        assert!(matches!(encryption_level(&SslMode::Preferred), EncryptionLevel::On));
        for m in [SslMode::Require, SslMode::VerifyCa, SslMode::VerifyFull] {
            assert!(matches!(encryption_level(&m), EncryptionLevel::Required), "{m:?}");
        }
    }

    #[test]
    fn fractional_seconds_never_show_precision_the_value_lacks() {
        // The case that failed live: datetime2(7) rendered nine digits.
        assert_eq!(trim_frac("2026-01-02 03:04:05.123456700".into()),
                   "2026-01-02 03:04:05.1234567");
        // Fewer significant digits trim all the way down.
        assert_eq!(trim_frac("2026-01-02 03:04:05.120000000".into()),
                   "2026-01-02 03:04:05.12");
        // A zero fraction loses the dot rather than showing ".000000000".
        assert_eq!(trim_frac("2026-01-02 03:04:05.000000000".into()),
                   "2026-01-02 03:04:05");
        // No fraction at all is left alone.
        assert_eq!(trim_frac("2026-01-02 03:04:05".into()), "2026-01-02 03:04:05");
        // datetimeoffset: the offset tail survives, and is not mistaken for
        // part of the fraction.
        assert_eq!(trim_frac("2026-01-02 03:04:05.123456700 +02:30".into()),
                   "2026-01-02 03:04:05.1234567 +02:30");
        assert_eq!(trim_frac("2026-01-02 03:04:05.000000000 -05:00".into()),
                   "2026-01-02 03:04:05 -05:00");
        // time-only values go through the same path.
        assert_eq!(trim_frac("03:04:05.100000000".into()), "03:04:05.1");
    }

    #[test]
    fn bracket_quoting_escapes_the_close_bracket() {
        assert_eq!(qident("orders"), "[orders]");
        assert_eq!(qident("a]b"), "[a]]b]");
        assert_eq!(qident("x].[y"), "[x]].[y]");
    }

    #[test]
    fn split_schema_object_defaults_to_dbo() {
        assert_eq!(split_schema_object("dbo.orders"), ("dbo".to_string(), "orders".to_string()));
        assert_eq!(split_schema_object("orders"), ("dbo".to_string(), "orders".to_string()));
    }

    #[test]
    fn type_names_carry_length_and_precision() {
        assert_eq!(tsql_type_name("nvarchar", 100, 0, 0), "nvarchar(50)");
        assert_eq!(tsql_type_name("nvarchar", -1, 0, 0), "nvarchar(max)");
        assert_eq!(tsql_type_name("varchar", 50, 0, 0), "varchar(50)");
        assert_eq!(tsql_type_name("decimal", 0, 38, 10), "decimal(38,10)");
        assert_eq!(tsql_type_name("datetime2", 0, 0, 7), "datetime2(7)");
        assert_eq!(tsql_type_name("int", 4, 10, 0), "int");
    }

    #[test]
    fn display_labels_cover_the_wire_types() {
        assert_eq!(column_type_name(ColumnType::Int4), "int");
        assert_eq!(column_type_name(ColumnType::Numericn), "decimal");
        assert_eq!(column_type_name(ColumnType::DatetimeOffsetn), "datetimeoffset");
        assert_eq!(column_type_name(ColumnType::NVarchar), "nvarchar");
    }

    use crate::db::types::FilterOp;

    fn filter(column: &str, op: FilterOp, value: Option<&str>) -> FilterClause {
        FilterClause { column: column.into(), op, value: value.map(String::from) }
    }

    #[test]
    fn browse_first_page_uses_top() {
        let q = build_browse_select("sales.dbo.orders", &[], &[], 100, 0, &[]);
        assert_eq!(q.sql, "SELECT TOP (100) * FROM [sales].[dbo].[orders]");
        assert!(q.values.is_empty());
        assert_eq!(q.display, q.sql);
    }

    #[test]
    fn browse_later_page_needs_order_by_for_fetch() {
        // OFFSET…FETCH is a syntax error without ORDER BY. An unsorted page
        // orders by the PK tiebreaker: SQL Server guarantees NO stable order
        // between pages under ORDER BY (SELECT NULL), so rows repeated or
        // vanished while scrolling (WP-09 9.4).
        let pk = vec!["id".to_string(), "seq".to_string()];
        let q = build_browse_select("dbo.orders", &[], &[], 100, 200, &pk);
        assert_eq!(q.sql,
            "SELECT * FROM [dbo].[orders] ORDER BY [id], [seq] \
             OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY");
        // No PK to anchor on: first projected column, still deterministic-ish.
        let q = build_browse_select("dbo.orders", &[], &[], 100, 200, &[]);
        assert_eq!(q.sql,
            "SELECT * FROM [dbo].[orders] ORDER BY 1 \
             OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY");
        // With a user sort, that is the ordering and no pad is added.
        let sort = vec![SortClause { column: "id".into(), direction: SortDir::Desc }];
        let q = build_browse_select("dbo.orders", &[], &sort, 100, 200, &[]);
        assert_eq!(q.sql,
            "SELECT * FROM [dbo].[orders] ORDER BY [id] DESC \
             OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY");
    }

    #[test]
    fn browse_filters_bind_and_the_display_inlines() {
        let filters = vec![
            filter("name", FilterOp::Like, Some("%a%")),
            filter("deleted", FilterOp::IsNull, None),
            filter("note", FilterOp::Eq, Some("it's")),
        ];
        let q = build_browse_select("t", &filters, &[], 10, 0, &[]);
        assert_eq!(q.sql,
            "SELECT TOP (10) * FROM [t] \
             WHERE [name] LIKE @P1 AND [deleted] IS NULL AND [note] = @P2");
        assert_eq!(q.values, vec!["%a%", "it's"]);
        // The IS NULL filter between two valued ones must not shift the
        // display's literals, and a quote doubles.
        assert_eq!(q.display,
            "SELECT TOP (10) * FROM [t] \
             WHERE [name] LIKE '%a%' AND [deleted] IS NULL AND [note] = 'it''s'");
    }

    #[test]
    fn value_counts_group_and_rank() {
        let q = build_value_counts("dbo.orders", "status",
            &[filter("customer_id", FilterOp::Eq, Some("42"))], 20);
        assert_eq!(q.sql,
            "SELECT TOP (20) [status] AS value, COUNT(*) AS cnt FROM [dbo].[orders] \
             WHERE [customer_id] = @P1 GROUP BY [status] ORDER BY cnt DESC");
        assert_eq!(q.values, vec!["42"]);
    }
}

/// Live tests against a real SQL Server. Every test is `#[ignore]`d AND skips
/// quietly when no endpoint is configured, so `cargo test --lib` stays green on
/// a machine with no server.
///
/// Run them against the dev container (docs/MSSQL_DEV.md):
///
///     TXUI_MSSQL_HOST=127.0.0.1 TXUI_MSSQL_USER=sa \
///     TXUI_MSSQL_PASSWORD='TxUI_dev_Passw0rd!' TXUI_MSSQL_TRUST_CERT=1 \
///     TXUI_MSSQL_DB=txui_demo \
///     cargo test --lib sqlserver -- --ignored --nocapture
///
/// …or against a connection saved in the app, like every other engine:
///
///     TXUI_TEST_CONN=mssql-local cargo test --lib sqlserver -- --ignored
///
/// **These go through `ConnectionConfig` and the public `open()`, not a
/// hand-built `MsConfig`.** The earlier version assembled `MsConfig` directly,
/// which skipped `ms_config_from` — the exact function where the product path
/// hardcoded `trust_cert: false`. A test that bypasses the seam it is meant to
/// cover cannot fail when that seam is broken, and this one didn't: the app
/// could not connect to any self-signed server at all, and no test said so.
///
/// Environment:
///   TXUI_MSSQL_PORT        default 1433
///   TXUI_MSSQL_DB          default database (unset = server default)
///   TXUI_MSSQL_ENCRYPT     require | preferred | disable  (default require)
///   TXUI_MSSQL_TRUST_CERT  1/true → ConnectionConfig::trust_server_cert
#[cfg(test)]
pub(crate) mod live_tests {
    use super::*;

    /// The endpoint under test, as a real `ConnectionConfig`.
    ///
    /// Two sources, in order: a connection saved in the app (`TXUI_TEST_CONN`,
    /// the harness every other engine uses), else the `TXUI_MSSQL_*` env for a
    /// throwaway container that has not been saved anywhere.
    pub(crate) fn live_config() -> Option<(ConnectionConfig, Option<String>)> {
        if let Ok(name) = std::env::var("TXUI_TEST_CONN") {
            let dir = crate::storage::default_data_dir();
            let configs = crate::storage::load(&dir).ok()?;
            let config = configs.values().find(|c| c.name == name)?.clone();
            let password = crate::secretstore::get(&dir, &config.keychain_key());
            return Some((config, password));
        }
        let host = std::env::var("TXUI_MSSQL_HOST").ok()?;
        let mut config = ConnectionConfig::new(crate::db::types::Engine::SqlServer, "live-test");
        config.host = Some(host);
        if let Some(p) = std::env::var("TXUI_MSSQL_PORT").ok().and_then(|p| p.parse().ok()) {
            config.port = Some(p);
        }
        config.user = std::env::var("TXUI_MSSQL_USER").ok();
        config.database = std::env::var("TXUI_MSSQL_DB").ok().filter(|s| !s.is_empty());
        config.ssl_mode = match std::env::var("TXUI_MSSQL_ENCRYPT")
            .unwrap_or_else(|_| "require".into()).as_str() {
            "preferred" => SslMode::Preferred,
            "disable" => SslMode::Disable,
            _ => SslMode::Require,
        };
        // The whole point of the rewrite: this rides on ConnectionConfig, so
        // the test exercises the field the product actually reads.
        config.trust_server_cert = matches!(
            std::env::var("TXUI_MSSQL_TRUST_CERT").as_deref(), Ok("1") | Ok("true"));
        let password = std::env::var("TXUI_MSSQL_PASSWORD").ok();
        Some((config, password))
    }

    pub(crate) async fn live_session() -> Option<SqlServerSession> {
        let (config, password) = live_config()?;
        Some(open(&config, password).await.expect("open() against the live endpoint"))
    }

    macro_rules! skip_unless {
        ($s:ident) => {
            let Some($s) = live_session().await else {
                println!("no endpoint configured — set TXUI_TEST_CONN, or \
                          TXUI_MSSQL_HOST/_USER/_PASSWORD (see docs/MSSQL_DEV.md)");
                return;
            };
        };
    }

    /// The SHOWPLAN_XML dance `commands::ops::explain_query` performs.
    ///
    /// Pinned here because all three failure modes are silent: the SET rejected
    /// for not being alone in its batch, a plan that never arrives, and — the
    /// expensive one — a session left in plan mode, where every later query
    /// returns XML and changes nothing.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn showplan_xml_round_trip_leaves_the_session_executing() {
        skip_unless!(s);
        let q = "SELECT COUNT(*) FROM sys.objects";

        let xml = explain_xml(&s, q, false).await.expect("estimated plan");
        assert!(xml.contains("<QueryPlan"), "no operator tree: {xml}");
        assert!(xml.contains("RelOp"), "no operators: {xml}");
        // Estimates only — SHOWPLAN does not execute.
        assert!(!xml.contains("<RunTimeInformation"), "SHOWPLAN should not measure");

        // The session must be RUNNING queries again, not planning them.
        let after = execute(&s, q).await.expect("query after the reset");
        assert_eq!(after.rows.len(), 1);
        assert!(after.rows[0][0].as_i64().unwrap_or(0) > 0,
                "the session is still in plan mode: {:?}", after.rows[0]);
    }

    /// `SET STATISTICS XML ON` is the measured counterpart — it really runs.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn statistics_xml_returns_both_the_rows_and_the_measured_plan() {
        skip_unless!(s);
        // The plan arrives in a SECOND result set, after the query's own rows —
        // which is why this cannot go through `execute`.
        let xml = explain_xml(&s, "SELECT TOP (3) name FROM sys.objects ORDER BY name", true)
            .await.expect("measured plan");
        assert!(xml.contains("<RunTimeInformation"), "no measurements: {xml}");
        assert!(xml.contains("ActualRows"), "no actual row counts: {xml}");

        // And the rows really were produced — STATISTICS XML executes.
        let after = execute(&s, "SELECT 1 AS n").await.expect("still executing");
        assert_eq!(after.rows[0][0].as_i64(), Some(1));
    }

    /// The SET really is refused when it shares a batch — the reason the
    /// explain path is three statements instead of one prefix.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn showplan_set_cannot_share_a_batch() {
        skip_unless!(s);
        let err = execute(&s, "SET SHOWPLAN_XML ON; SELECT 1").await
            .expect_err("SET SHOWPLAN must be alone in its batch");
        let msg = format!("{err:#}");
        assert!(msg.contains("only statements in the batch") || msg.contains("1067"),
                "unexpected error: {msg}");
        // And the failed attempt must not have left plan mode on.
        let after = execute(&s, "SELECT 1 AS n").await.expect("still executing");
        assert_eq!(after.rows[0][0].as_i64(), Some(1));
    }

    /// Query Store end to end: manufacture a plan regression, detect it, force
    /// the good plan, confirm the server applied it, and put things back.
    ///
    /// The whole feature rests on facts only a live server has — that dropping
    /// an index really does give the same query a second, worse plan, and that
    /// `sp_query_store_force_plan` really does pin the first one — so a unit
    /// test of the SQL shapes proves almost nothing on its own.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn query_store_finds_a_regression_and_forcing_pins_the_good_plan() {
        skip_unless!(s);

        // AUTO capture deliberately skips cheap queries, and this one is cheap.
        let prior = execute(&s,
            "SELECT query_capture_mode_desc FROM sys.database_query_store_options")
            .await.expect("qs options");
        let prior_mode = prior.rows[0][0].as_str().unwrap_or("AUTO").to_string();
        execute(&s, "ALTER DATABASE txui_demo SET QUERY_STORE (QUERY_CAPTURE_MODE = ALL)")
            .await.expect("capture ALL");

        // Its OWN table. Creating and dropping an index on `sales.orders`
        // deadlocked against `metadata_smoke`'s catalog read (Msg 1205) when
        // the suite ran in parallel — a shared fixture table is fine to READ
        // from concurrently and not to do DDL on.
        execute(&s, "IF OBJECT_ID('dbo.zz_qs_orders') IS NOT NULL DROP TABLE dbo.zz_qs_orders")
            .await.ok();
        execute(&s, "SELECT id, status, total INTO dbo.zz_qs_orders FROM sales.orders")
            .await.expect("own table");

        let q = "SELECT /*qs_live_test*/ status, SUM(total) AS s \
                 FROM dbo.zz_qs_orders WHERE status = 'paid' GROUP BY status";

        // Plan A: with an index that covers the predicate.
        execute(&s, "CREATE INDEX ix_qs_live ON dbo.zz_qs_orders(status) INCLUDE (total)")
            .await.expect("create index");
        for _ in 0..6 { execute(&s, q).await.expect("run with index"); }

        // Plan B: without it — the same query, a worse plan.
        execute(&s, "DROP INDEX ix_qs_live ON dbo.zz_qs_orders").await.expect("drop index");
        for _ in 0..10 { execute(&s, q).await.expect("run without index"); }
        execute(&s, "EXEC sys.sp_query_store_flush_db").await.ok();

        // The query id FIRST, and the plans for THAT id — not two independent
        // lookups. The same text can map to several query_ids (different SET
        // options compile separately), so fetching plans by text and the id by
        // text could return a plan that does not belong to the id, which is
        // Msg 12406 at force time.
        let query_id = execute(&s,
            "SELECT TOP (1) q.query_id FROM sys.query_store_query q \
             JOIN sys.query_store_query_text t ON t.query_text_id = q.query_text_id \
             WHERE t.query_sql_text LIKE '%qs_live_test%' \
             ORDER BY q.query_id DESC").await.expect("query id")
            .rows.first().and_then(|r| r[0].as_i64()).expect("a query id");

        let plans = execute(&s, &format!(
            "SELECT p.plan_id, \
                    SUM(rs.count_executions) AS execs, \
                    SUM(rs.avg_logical_io_reads * rs.count_executions) \
                      / NULLIF(SUM(rs.count_executions), 0) AS reads \
             FROM sys.query_store_plan p \
             JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id \
             WHERE p.query_id = {query_id} \
             GROUP BY p.plan_id ORDER BY reads")).await.expect("plans");
        // At least two, not exactly two: the query text is stable, so Query
        // Store keeps ACCUMULATING plans for the same query_id every time this
        // test runs. Pinning the count made it pass once and fail on the
        // second run — the shape of a test that tests its own history.
        assert!(plans.rows.len() >= 2,
                "expected several plans for one query, got {:?}", plans.rows);
        // Ordered by reads, so the extremes are the first and last rows.
        let good_plan = plans.rows[0][0].as_i64().expect("plan id");
        let cheap_reads = plans.rows[0][2].as_f64().unwrap_or(0.0);
        let dear_reads = plans.rows[plans.rows.len() - 1][2].as_f64().unwrap_or(0.0);
        // Logical reads are the honest signal: duration moves with load, reads
        // move with the plan.
        assert!(dear_reads > cheap_reads * 2.0,
                "the second plan should read far more: {cheap_reads} vs {dear_reads}");

        // Force the good plan, and confirm the SERVER says it is applied —
        // a forcing that is recorded but not applied is the failure mode the
        // panel exists to surface.
        execute(&s, &format!(
            "EXEC sys.sp_query_store_force_plan @query_id = {query_id}, @plan_id = {good_plan}"))
            .await.expect("force");
        let forced = execute(&s, &format!(
            "SELECT CONVERT(int, is_forced_plan), last_force_failure_reason_desc \
             FROM sys.query_store_plan WHERE plan_id = {good_plan}")).await.expect("read forced");
        assert_eq!(forced.rows[0][0].as_i64(), Some(1), "plan was not forced");
        assert_eq!(forced.rows[0][1].as_str(), Some("NONE"), "forcing already failing");

        // Put everything back — the fixture is shared with every other test.
        execute(&s, &format!(
            "EXEC sys.sp_query_store_unforce_plan @query_id = {query_id}, @plan_id = {good_plan}"))
            .await.expect("unforce");
        // …including this test's own Query Store history, so a re-run starts
        // from nothing rather than from the plans the last run left behind.
        execute(&s, &format!("EXEC sys.sp_query_store_remove_query @query_id = {query_id}"))
            .await.ok();
        execute(&s, "DROP TABLE dbo.zz_qs_orders").await.ok();
        execute(&s, &format!(
            "ALTER DATABASE txui_demo SET QUERY_STORE (QUERY_CAPTURE_MODE = {prior_mode})"))
            .await.ok();
    }

    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn connect_and_version() {
        skip_unless!(s);
        let r = execute(&s, "SELECT @@VERSION").await.expect("SELECT @@VERSION");
        assert_eq!(r.rows.len(), 1);
        let v = r.rows[0][0].as_str().expect("version is a string");
        assert!(v.contains("Microsoft SQL Server"), "{v}");
    }

    /// The house decoding rules, against the same type matrix the spike probed.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn type_matrix_decoding() {
        skip_unless!(s);
        let r = execute(&s,
            "SELECT \
                CAST(2147483647 AS int) AS c_int, \
                CAST(9223372036854775807 AS bigint) AS c_bigint, \
                CAST('1234567890123456789012345678.0123456789' AS decimal(38,10)) AS c_decimal, \
                CAST(1.5 AS float) AS c_float, \
                CAST(N'héllo' AS nvarchar(10)) AS c_nvarchar, \
                CAST('2026-01-02 03:04:05.1234567' AS datetime2) AS c_datetime2, \
                CAST('2026-01-02 03:04:05.1234567 +02:30' AS datetimeoffset) AS c_dto, \
                CAST('9E0B4BCE-1234-5678-9ABC-DEF012345678' AS uniqueidentifier) AS c_guid, \
                CAST(0xDEADBEEF AS varbinary(4)) AS c_bin, \
                CAST(NULL AS int) AS c_null, \
                CAST(1 AS bit) AS c_bit").await.expect("type matrix");
        let row = &r.rows[0];
        assert_eq!(row[0].as_i64(), Some(2147483647));
        assert_eq!(row[1].as_i64(), Some(9223372036854775807));
        // DECIMAL: exact string, never f64.
        assert_eq!(row[2].as_str(), Some("1234567890123456789012345678.0123456789"));
        assert_eq!(row[3].as_f64(), Some(1.5));
        assert_eq!(row[4].as_str(), Some("héllo"));
        assert_eq!(row[5].as_str(), Some("2026-01-02 03:04:05.1234567"));
        // datetimeoffset keeps its raw offset (+02:30), not a UTC conversion.
        assert_eq!(row[6].as_str(), Some("2026-01-02 03:04:05.1234567 +02:30"));
        assert_eq!(row[7].as_str(), Some("9e0b4bce-1234-5678-9abc-def012345678"));
        assert_eq!(row[8].as_str(), Some("0xDEADBEEF"));
        // NULL decodes as null, never as a failed-decode string.
        assert!(row[9].is_null());
        assert_eq!(row[10].as_bool(), Some(true));
    }

    /// Metadata against the `txui_demo` fixture (dev/mssql_fixture.sql), not
    /// against `master`. The old version asked `master` for the columns of
    /// `dbo.spt_values` — which is a VIEW, so it exercised nothing and asserted
    /// on an empty list. The fixture has a heap, a computed column, a filtered
    /// index and two schemas, which is what the tree actually has to render.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn metadata_smoke() {
        skip_unless!(s);
        let db = "txui_demo";

        // Top level lists databases.
        let dbs = list_schema(&s, None).await.expect("list databases");
        assert!(dbs.iter().any(|n| matches!(n, SchemaNode::Database { name } if name == db)),
            "{db} not in {dbs:?} — load dev/mssql_fixture.sql first");

        // Objects carry their schema, and row counts come back populated —
        // this is the query that failed outright with "Invalid column name
        // 'rows'" the first time it met a real server.
        let objs = list_schema(&s, Some(db)).await.expect("list objects");
        let orders = objs.iter().find(|n| matches!(n,
            SchemaNode::Table { name, .. } if name == "sales.orders"));
        assert!(orders.is_some(), "sales.orders not in {objs:?}");
        if let Some(SchemaNode::Table { row_count, .. }) = orders {
            assert!(row_count.unwrap_or(0) > 1000, "row_count not populated: {row_count:?}");
        }
        assert!(objs.iter().any(|n| matches!(n,
            SchemaNode::View { name, .. } if name == "sales.v_order_totals")),
            "the view is missing from {objs:?}");

        // Table columns: PK flagged, computed column present, types carry
        // their length/precision.
        let cols = list_columns(&s, db, "sales.orders").await.expect("list_columns table");
        assert!(cols.iter().any(|n| matches!(n,
            SchemaNode::Column { name, primary_key: true, .. } if name == "id")),
            "id not flagged as PK in {cols:?}");
        assert!(cols.iter().any(|n| matches!(n,
            SchemaNode::Column { name, .. } if name == "total_with_vat")),
            "computed column missing from {cols:?}");

        // VIEW columns — empty before list_columns stopped joining sys.tables.
        let vcols = list_columns(&s, db, "sales.v_order_totals").await.expect("list_columns view");
        assert!(!vcols.is_empty(), "a view must report its columns");
        assert!(vcols.iter().any(|n| matches!(n,
            SchemaNode::Column { name, .. } if name == "lifetime_total")),
            "view column missing from {vcols:?}");

        // Table meta agrees with the tree about the row count.
        let meta = get_table_meta(&s, db, "sales.orders").await.expect("get_table_meta");
        assert!(meta.total_rows.unwrap_or(0) > 1000, "meta row count: {:?}", meta.total_rows);

        // A view has a stored definition.
        let ddl = get_ddl(&s, db, "sales.v_order_totals").await;
        assert!(ddl.is_ok(), "view definition: {ddl:?}");
    }

    /// Cancel actually stops a running query, and the session survives it.
    ///
    /// Before this, `kill_backend` had no `SqlServer` arm at all — the match
    /// ended in `_ => {}`, so pressing Cancel on SQL Server did **nothing**,
    /// silently. This is the test that would have caught that.
    ///
    /// It also pins the consequence T-SQL forces on us: `KILL` ends the whole
    /// session, so the connection dies with the query and `execute_capped` has
    /// to reconnect. A cancel that leaves the tab unusable is not a cancel.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn cancel_stops_the_query_and_the_session_recovers() {
        skip_unless!(s);
        let spid = spid(&s).await.expect("@@SPID");
        assert!(spid > 0, "no spid");
        assert!(session_alive(&s, spid).await.expect("alive check"), "own spid not alive");

        // A query that will not finish on its own inside the test.
        let running = {
            let s2 = SqlServerSession {
                client: s.client.clone(),
                database: s.database.clone(),
                read_only: s.read_only,
                cfg: s.cfg.clone(),
                in_tx: s.in_tx.clone(),
            };
            tokio::spawn(async move { execute(&s2, "WAITFOR DELAY '00:00:30'").await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;

        // Kill it from an auxiliary connection — the session's own client is
        // locked by the WAITFOR, which is the entire reason aux_connect exists.
        kill_spid(&s, spid).await.expect("KILL");

        // The query comes back quickly, and as an error rather than a success.
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), running)
            .await
            .expect("cancelled query did not return within 10s")
            .expect("query task panicked");
        assert!(outcome.is_err(), "a killed query must not report success");

        // And the session still works: execute_capped reconnects.
        let after = execute(&s, "SELECT 1 AS ok").await
            .expect("session unusable after cancel — the reconnect did not happen");
        assert_eq!(after.rows[0][0].as_i64(), Some(1));
    }

    /// A transaction really isolates, and really rolls back.
    ///
    /// No pinning involved: a TDS session is one connection, so the BEGIN, the
    /// write and the ROLLBACK all land on the same backend by construction.
    /// @@TRANCOUNT is asserted directly because it is what `tx_status` reports.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn transaction_commits_and_rolls_back() {
        skip_unless!(s);
        let _ = execute(&s, "DROP TABLE IF EXISTS dbo.txui_tx_test").await;
        execute(&s, "CREATE TABLE dbo.txui_tx_test (n int)").await.expect("create");

        async fn count(s: &SqlServerSession) -> i64 {
            execute(s, "SELECT COUNT(*) FROM dbo.txui_tx_test").await
                .expect("count").rows[0][0].as_i64().unwrap_or(-1)
        }

        // Rollback discards.
        assert_eq!(trancount(&s).await.unwrap(), 0, "started inside a transaction");
        begin(&s).await.expect("begin");
        assert_eq!(trancount(&s).await.unwrap(), 1, "@@TRANCOUNT after BEGIN");
        execute(&s, "INSERT INTO dbo.txui_tx_test VALUES (1)").await.expect("insert");
        assert_eq!(count(&s).await, 1, "not visible inside its own transaction");
        end_tx(&s, false).await.expect("rollback");
        assert_eq!(trancount(&s).await.unwrap(), 0, "@@TRANCOUNT after ROLLBACK");
        assert_eq!(count(&s).await, 0, "ROLLBACK did not discard the insert");

        // Commit keeps.
        begin(&s).await.expect("begin 2");
        execute(&s, "INSERT INTO dbo.txui_tx_test VALUES (2)").await.expect("insert 2");
        end_tx(&s, true).await.expect("commit");
        assert_eq!(count(&s).await, 1, "COMMIT did not keep the insert");

        execute(&s, "DROP TABLE dbo.txui_tx_test").await.expect("cleanup");
    }

    /// Does the driver's session have QUOTED_IDENTIFIER ON?
    ///
    /// It must. With it OFF, SQL Server refuses any DML against a table that
    /// has a filtered index, an indexed view, a computed-column index or an XML
    /// method — Msg 1934 — which would make writes fail on perfectly ordinary
    /// schemas for a reason with nothing to do with the statement. sqlcmd
    /// defaults it OFF and hit exactly that on this fixture; TDS clients
    /// default it ON, and this asserts we are in the second group.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn quoted_identifier_is_on_so_filtered_indexes_accept_writes() {
        skip_unless!(s);
        // Bit 256 of @@OPTIONS is QUOTED_IDENTIFIER.
        let r = execute(&s, "SELECT @@OPTIONS & 256").await.expect("options");
        assert_eq!(r.rows[0][0].as_i64(), Some(256),
            "QUOTED_IDENTIFIER is OFF — writes to any table with a filtered index \
             will fail with Msg 1934");

        // And prove it end to end against the fixture's filtered index.
        execute(&s, "BEGIN TRANSACTION").await.expect("begin");
        let w = execute(&s, "UPDATE sales.customers SET country = 'ZZ' WHERE id = 1").await;
        let _ = execute(&s, "ROLLBACK TRANSACTION").await;
        assert!(w.is_ok(), "write to a filtered-index table failed: {w:?}");
    }

    /// A dropped connection inside a transaction must **refuse** the next
    /// statement, not silently run it.
    ///
    /// This is the hazard the reconnect in `execute_capped` introduces: the
    /// reconnect is a new session, so the server has already rolled the
    /// transaction back. Retrying the statement there would run it outside the
    /// transaction the user still believes is open — turning an uncommitted
    /// write into a committed one, silently. The session stays usable
    /// afterwards; only the statement that straddled the break is refused.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn a_transaction_lost_to_a_reconnect_is_reported_not_hidden() {
        skip_unless!(s);
        let _ = execute(&s, "DROP TABLE IF EXISTS dbo.txui_tx_break").await;
        execute(&s, "CREATE TABLE dbo.txui_tx_break (n int)").await.expect("create");

        let spid = spid(&s).await.expect("spid");
        begin(&s).await.expect("begin");
        execute(&s, "INSERT INTO dbo.txui_tx_break VALUES (1)").await.expect("insert");

        // Kill our own session out from under the open transaction.
        kill_spid(&s, spid).await.expect("kill");
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        // The next statement is refused, and says why.
        let err = execute(&s, "INSERT INTO dbo.txui_tx_break VALUES (2)").await
            .expect_err("a statement straddling a lost transaction must not succeed");
        let msg = err.to_string();
        assert!(msg.contains("transaction"), "unhelpful error: {msg}");

        // The session recovered, and the rolled-back row is genuinely gone.
        let n = execute(&s, "SELECT COUNT(*) FROM dbo.txui_tx_break").await
            .expect("session unusable after the break").rows[0][0].as_i64();
        assert_eq!(n, Some(0), "the server should have rolled the transaction back");
        assert_eq!(trancount(&s).await.unwrap(), 0, "no transaction should remain");

        execute(&s, "DROP TABLE dbo.txui_tx_break").await.expect("cleanup");
    }

    /// `decimal(38, s)` is wider than `rust_decimal::Decimal` can hold.
    ///
    /// SQL Server allows 38 significant digits; `rust_decimal` is a 96-bit
    /// mantissa, so roughly 28-29. The spike **panicked** on this
    /// ("Number exceeds maximum value that can be represented"), and a panic in
    /// a decode path takes the app down rather than returning an error — the
    /// one outcome the row-decoding doctrine rules out. Decoding must degrade
    /// to a string, exactly as a failed typed decode does elsewhere.
    #[tokio::test]
    #[ignore = "needs TXUI_MSSQL_HOST and a live SQL Server"]
    async fn wide_decimal_does_not_panic() {
        skip_unless!(s);
        // 38 nines: the widest value the type allows, and far outside Decimal.
        let r = execute(&s, "SELECT CAST('99999999999999999999999999999999999999' \
                             AS decimal(38,0)) AS c_wide").await;
        let r = r.expect("a value too wide for rust_decimal must not fail the query");
        let v = r.rows[0][0].as_str().expect("wide decimal must decode as a string");
        assert!(!v.is_empty(), "wide decimal decoded to an empty string");
        // Whatever the representation, it must not be silently NULL and must
        // not have lost the magnitude.
        assert!(v.len() >= 20, "wide decimal lost its magnitude: {v}");
    }
}
