use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    Mysql,
    Postgres,
    Redis,
    Clickhouse,
    /// File-backed. `file_path` replaces host/port; there is nothing to dial.
    Sqlite,
    /// A single Parquet file. Not a server and not even a query engine —
    /// see db/parquet.rs.
    Parquet,
    /// In-process OLAP engine over a file or `:memory:` — file-backed like
    /// SQLite (`file_path` is the address), but a full SQL engine like the
    /// networked ones. See db/duckdb.rs.
    Duckdb,
    /// Document store. Read-only v1: connect + tree + find editor + JSON
    /// grid — see db/mongodb.rs for scope and decode doctrine.
    /// Explicit rename: the enum is snake_case, which would produce
    /// "mongo_db"; the wire name (TS union, frontend checks) is "mongodb".
    /// The alias keeps a connections.json written before the rename loadable.
    #[serde(rename = "mongodb", alias = "mongo_db")]
    MongoDb,
    /// SQL Server via tiberius (TDS) — see db/sqlserver.rs. Explicit rename:
    /// the enum is snake_case, which would produce "sql_server"; the wire
    /// name (connUrl scheme, utils, TS union) is the single token "sqlserver".
    #[serde(rename = "sqlserver")]
    SqlServer,
}

impl Engine {
    pub fn default_port(&self) -> u16 {
        match self {
            Engine::Mysql    => 3306,
            Engine::Postgres => 5432,
            Engine::Redis    => 6379,
            // The HTTP interface, not the native 9000 port: HTTP is what
            // ingresses expose and what most deployments actually allow.
            Engine::Clickhouse => 8123,
            // File-backed engines have no port. 0 is never dialled: every code
            // path that would connect checks `is_file_backed` first.
            Engine::Sqlite | Engine::Parquet | Engine::Duckdb => 0,
            Engine::MongoDb => 27017,
            Engine::SqlServer => 1433,
        }
    }

    /// Opens a path on this machine rather than a network endpoint. Such a
    /// connection has no host, port, user, password, SSL or SSH — the whole
    /// networking half of ConnectionConfig is meaningless for it.
    pub fn is_file_backed(&self) -> bool {
        matches!(self, Engine::Sqlite | Engine::Parquet | Engine::Duckdb)
    }

    /// The wire/frontend name — the same string serde produces and the TS
    /// `Engine` union uses ("mongodb", "sqlserver", not the snake_case the
    /// variant name would default to). For audit rows and other places that
    /// need the string without going through serialization.
    pub fn wire_name(&self) -> &'static str {
        match self {
            Engine::Mysql      => "mysql",
            Engine::Postgres   => "postgres",
            Engine::Redis      => "redis",
            Engine::Clickhouse => "clickhouse",
            Engine::Sqlite     => "sqlite",
            Engine::Parquet    => "parquet",
            Engine::Duckdb     => "duckdb",
            Engine::MongoDb    => "mongodb",
            Engine::SqlServer  => "sqlserver",
        }
    }
}

/// Bound on the initial connect when neither the connection nor the app
/// setting supplies one.
///
/// Unbounded was the old behaviour, and it meant that connecting to a host
/// that is simply off sat on the OS's SYN retries — well over a minute on
/// macOS — with the UI showing "connecting" the whole time.
///
/// Five seconds because a server that is up answers in well under one on a
/// LAN and a couple over a VPN; a longer wait only ever means "not going to
/// answer". Overridable app-wide in Settings, and per connection in Advanced.
pub const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 5;

/// Default client-side deadline on a single query, in seconds. `0` means
/// unbounded.
///
/// Unbounded, deliberately, for the same reason `DEFAULT_STATEMENT_TIMEOUT_SECS`
/// is `None`: TxUI does not know which statements the user expects to take
/// minutes, and an import or a long `ALTER` cut off halfway is worse than a
/// slow one. Connector/J's `socketTimeout` defaults to 0 for the same reason,
/// so this is also exact parity rather than a local opinion.
///
/// What it adds over `statement_timeout_secs` is coverage. The server-side
/// ceiling is `max_execution_time`, which on MySQL bounds **read-only SELECT
/// only** (measured — see below); a runaway `UPDATE` ignores it entirely. This
/// deadline is enforced by the client and so applies to every statement on
/// every engine. It also issues the same server-side KILL the Cancel button
/// does, rather than merely walking away from the query.
pub const DEFAULT_QUERY_TIMEOUT_SECS: u32 = 0;

/// Default server-side ceiling on a single statement.
///
/// Left `None` — meaning *do not touch the server's setting* — rather than
/// given a value, because a wrong ceiling is worse than none: an import or a
/// long `ALTER` killed halfway is a support call, and TxUI does not know
/// which statements the user expects to take minutes.
///
/// **What it bounds is not the same on every engine, and the gap matters.**
/// Measured on the local servers rather than taken from documentation:
///
/// | engine | variable | covers |
/// |---|---|---|
/// | PostgreSQL 16 | `statement_timeout` | every statement, reads and writes |
/// | MySQL 8.0.46 | `max_execution_time` | **read-only `SELECT` only** |
/// | ClickHouse | `max_execution_time` | every statement |
/// | SQLite | — | nothing server-side exists |
///
/// The MySQL row is the trap. With `max_execution_time = 1000`,
/// `SELECT SLEEP(3)` returned in 1.09 s (against 3.09 s unbounded), while
/// `UPDATE t SET v=2 WHERE id=1 AND SLEEP(3)=0` ran the full three seconds
/// **and committed**. So on MySQL this is a guard against a runaway read, not
/// a guard against a runaway write — and presenting it as the latter would be
/// a lie the user only discovers during an incident.
pub const DEFAULT_STATEMENT_TIMEOUT_SECS: Option<u32> = None;

/// JSON-encode an f64. Finite values become JSON numbers; NaN / ±Infinity
/// become string sentinels so a non-finite value is never silently rendered
/// as NULL (which would be indistinguishable from an actual NULL).
pub fn json_f64(v: f64) -> serde_json::Value {
    if v.is_finite() {
        serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
    } else if v.is_nan() {
        serde_json::Value::String("NaN".into())
    } else if v > 0.0 {
        serde_json::Value::String("Infinity".into())
    } else {
        serde_json::Value::String("-Infinity".into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id:       Uuid,
    pub name:     String,
    pub engine:   Engine,
    pub host:     Option<String>,
    pub port:     Option<u16>,
    pub user:     Option<String>,
    pub database: Option<String>,
    pub ssl_mode: SslMode,
    /// For grouping in the sidebar
    pub group:    Option<String>,
    /// Colour label for the connection tab and sidebar row.
    pub color:    Option<String>,
    /// Environment tag: "dev" | "test" | "prod" — prod triggers write confirmation
    #[serde(default)]
    pub environment: Option<String>,
    /// Client-side write guard: DML/DDL blocked in the UI
    #[serde(default)]
    pub read_only: bool,
    /// Autocommit for this connection.
    ///
    /// `false` means the session **pins one connection** for its whole life and
    /// holds an open transaction on it, so Commit/Rollback are live from the
    /// moment you connect. Pinning is not decoration: a session runs on a pool
    /// of several connections, so `SET autocommit = 0` alone would leave each
    /// one with its own transaction and COMMIT would settle whichever it
    /// happened to land on. Defaults to `true` — every existing connection
    /// keeps behaving exactly as it did.
    #[serde(default = "default_true")]
    pub autocommit: bool,
    /// Free-form note shown as a sidebar tooltip and searchable in the filter
    #[serde(default)]
    pub notes: Option<String>,
    /// Connect automatically at app launch
    #[serde(default)]
    pub auto_connect: bool,
    /// Superseded by `labels`. Kept so an old config file still loads and so an
    /// export written by an older build can be imported; migrated on read.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The functional grouping. Folders are for orientation; **labels are what
    /// fleet checks run against** — variable drift, index divergence and
    /// statistics freshness all operate on the set of servers sharing one.
    ///
    /// A connection carries many, because a server is `cz-test` *and* `prod-eu`
    /// at the same time and a check scoped to either must find it. A label
    /// marked hidden groups and filters exactly like any other but spends no
    /// chip in the sidebar.
    #[serde(default)]
    pub labels: Vec<Label>,

    // ── SSH tunnel ──────────────────────────────────────────────
    /// Enable SSH port-forwarding tunnel before connecting
    #[serde(default)]
    pub use_ssh:      bool,
    #[serde(default)]
    pub ssh_host:     Option<String>,
    #[serde(default)]
    pub ssh_port:     Option<u16>,   // default 22
    #[serde(default)]
    pub ssh_user:     Option<String>,
    /// Path to private key file; if None, ssh-agent / default keys used
    #[serde(default)]
    pub ssh_key_path: Option<String>,

    // ── SSL certificates ────────────────────────────────────────
    /// Path to PEM CA certificate for SSL verification
    #[serde(default)]
    pub ssl_ca_path:   Option<String>,
    /// Path to PEM client certificate (mutual TLS)
    #[serde(default)]
    pub ssl_cert_path: Option<String>,
    /// Path to PEM client private key (mutual TLS)
    #[serde(default)]
    pub ssl_key_path:  Option<String>,
    /// **Accept any server certificate** — disables verification entirely.
    ///
    /// The dev-server escape hatch, and the only way to reach a stock SQL
    /// Server container: those present a self-signed cert, tiberius defaults to
    /// `EncryptionLevel::Required`, and there is no other route in. Distinct
    /// from `ssl_ca_path`, which *narrows* trust to a private CA and keeps
    /// verification on; this one turns verification off.
    ///
    /// Defaults to false and stays false unless the user ticks it. Currently
    /// honoured by the SQL Server driver; the sqlx engines express the same
    /// intent through `SslMode`.
    #[serde(default)]
    pub trust_server_cert: bool,

    // ── Cloud SQL IAM authentication (MySQL / PostgreSQL) ─────────────────────
    // When on, the password is a short-lived OAuth2 token minted from the
    // service-account key at connect time; the DB user is the IAM principal.
    #[serde(default)]
    pub use_iam_auth: bool,
    #[serde(default)]
    pub iam_key_path: Option<String>,

    // ── Connection tuning ───────────────────────────────────────
    /// TCP connect timeout in seconds (bounds the initial pool connect)
    #[serde(default)]
    pub connect_timeout_secs: Option<u32>,
    /// Client-side deadline on a single query, in seconds. `None` falls back to
    /// the app-wide Settings value; `Some(0)` is explicitly unbounded.
    /// See `DEFAULT_QUERY_TIMEOUT_SECS` for why unbounded is the default.
    #[serde(default)]
    pub query_timeout_secs: Option<u32>,
    /// Client name reported to the server.
    ///
    /// **PostgreSQL only.** It becomes the startup `application_name` and shows
    /// up in `pg_stat_activity.application_name`; unset, TxUI sends "TxUI".
    ///
    /// On MySQL it is accepted and then ignored. The equivalent there is the
    /// `program_name` *connection attribute*, sent once inside the handshake
    /// and surfaced in `performance_schema.session_connect_attrs` — and sqlx
    /// exposes no API for connection attributes, so there is nowhere to put
    /// it. It cannot be faked with `SET SESSION`: the attributes are frozen at
    /// handshake time. Closing this needs a patch to sqlx-mysql, not a line
    /// here. See also the UI, which should not advertise the field for MySQL.
    #[serde(default)]
    pub application_name: Option<String>,
    /// Free-form per-engine session params (MySQL: applied as `SET SESSION k = v`
    /// after validation; PG: startup `options`)
    #[serde(default)]
    pub extra_params: std::collections::BTreeMap<String, String>,
    /// The file a file-backed engine opens (SQLite database, Parquet file).
    /// Required for those engines and unused by every other one.
    #[serde(default)]
    pub file_path: Option<String>,
    /// Unix socket path; when set, overrides host/port at connect
    #[serde(default)]
    pub socket_path: Option<String>,
    /// Statements executed once per new pooled connection (both engines)
    #[serde(default)]
    pub init_sql: Option<String>,

    // ── MySQL-specific ──────────────────────────────────────────
    /// Session time zone for MySQL. Blank/`None` keeps TxUI's default of UTC;
    /// `SYSTEM` adopts the server's own zone; an offset (`+02:00`) or a named
    /// zone (`Europe/Prague`) sets that.
    ///
    /// Exists because sqlx pins every session to `+00:00` and DBeaver does
    /// not, so the same `TIMESTAMP` could read two hours apart in the two
    /// tools with nothing on screen to explain it.
    ///
    /// Safe to change here, which is not true of every sqlx user: the sqlx
    /// docs warn that moving off UTC skews `chrono::DateTime<Utc>` values in
    /// both directions, because MySQL's protocol carries no offset with
    /// `TIMESTAMP`. Audited — TxUI never *encodes* a chrono value (every bound
    /// parameter is a `String`; see `BrowseQuery`), and decoding goes through
    /// `NaiveDateTime`, which is zone-naive and renders the server's wall
    /// clock verbatim. So the warning does not reach us.
    #[serde(default)]
    pub time_zone: Option<String>,
    /// Connection charset (default utf8mb4); collation left to the server
    /// unless `collation` is also set
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
    /// Allow mysql_clear_password auth plugin (needed for PAM auth)
    #[serde(default)]
    pub enable_cleartext_plugin: bool,

    // ── Pool tuning ─────────────────────────────────────────────
    #[serde(default)]
    pub pool_max: Option<u32>,
    #[serde(default)]
    pub pool_acquire_timeout_secs: Option<u32>,
    #[serde(default)]
    pub pool_idle_timeout_secs: Option<u32>,
    /// Server-side ceiling on a single statement, in seconds. `None` leaves
    /// the server's own setting alone; `Some(0)` means explicitly unbounded.
    ///
    /// What it actually bounds differs by engine, and the difference is not
    /// cosmetic — see `DEFAULT_STATEMENT_TIMEOUT_SECS`.
    #[serde(default)]
    pub statement_timeout_secs: Option<u32>,

    // ── SSH (jump host + password auth) ─────────────────────────
    /// Jump host, format user@host[:port]
    #[serde(default)]
    pub ssh_jump: Option<String>,
    /// Use password auth for the SSH tunnel (stored in the secret store)
    #[serde(default)]
    pub use_ssh_password: bool,

    // ── Server activity log + prod hard limits ──────────────────
    /// Per-connection directory for server activity logs (append_server_log)
    #[serde(default)]
    pub log_dir: Option<String>,
    /// Opt out of the prod block on destructive DDL (DROP/TRUNCATE/ALTER/RENAME/GRANT/REVOKE)
    #[serde(default)]
    pub prod_allow_ddl: bool,
    /// Opt out of the prod block on WHERE-less UPDATE/DELETE
    #[serde(default)]
    pub prod_allow_unfiltered_write: bool,
}

impl ConnectionConfig {
    #[allow(dead_code)] // constructor for upcoming programmatic connection creation
    pub fn new(engine: Engine, name: impl Into<String>) -> Self {
        let port = engine.default_port();
        ConnectionConfig {
            id:       Uuid::new_v4(),
            name:     name.into(),
            engine,
            host:     Some("localhost".into()),
            port:     Some(port),
            user:     None,
            database: None,
            ssl_mode: SslMode::Preferred,
            group:    None,
            color:    None,
            environment: None,
            read_only:   false,
            autocommit:  true,
            notes:        None,
            auto_connect: false,
            tags:         Vec::new(),
            labels:       Vec::new(),
            use_ssh:      false,
            ssh_host:     None,
            ssh_port:     None,
            ssh_user:     None,
            ssh_key_path: None,
            ssl_ca_path:   None,
            ssl_cert_path: None,
            ssl_key_path:  None,
            trust_server_cert: false,
            use_iam_auth:  false,
            iam_key_path:  None,
            connect_timeout_secs: None,
            query_timeout_secs: None,
            application_name: None,
            extra_params: std::collections::BTreeMap::new(),
            file_path: None,
            socket_path: None,
            init_sql: None,
            time_zone: None,
            charset:   None,
            collation: None,
            enable_cleartext_plugin: false,
            pool_max: None,
            pool_acquire_timeout_secs: None,
            pool_idle_timeout_secs: None,
            statement_timeout_secs: None,
            ssh_jump: None,
            use_ssh_password: false,
            log_dir: None,
            prod_allow_ddl: false,
            prod_allow_unfiltered_write: false,
        }
    }

    /// Secret-store key for the SSH password (key-based auth is preferred; this is a fallback)
    pub fn ssh_keychain_key(&self) -> String {
        format!("dbgui-ssh:{}", self.id)
    }

    /// Keychain service key for this connection's password
    pub fn keychain_key(&self) -> String {
        format!("dbgui:{}", self.id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SslMode {
    Disable,
    #[default]
    Preferred,
    Require,
    VerifyCa,
    VerifyFull,
}

/// Lightweight ping result returned to the frontend
#[derive(Debug, Serialize, Deserialize)]
pub struct PingResult {
    pub ok:      bool,
    pub latency_ms: u64,
    pub server_version: Option<String>,
    pub error:   Option<String>,
}

/// A row in the result set — each value is JSON-safe
pub type Row = Vec<serde_json::Value>;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueryResult {
    pub columns:      Vec<ColumnInfo>,
    pub rows:         Vec<Row>,
    pub rows_affected: Option<u64>,
    /// Execute-only time: until the FIRST row arrives (or until stream
    /// completion for non-SELECT / writes). Total time = execution_ms + fetch_ms.
    pub execution_ms: u64,
    /// Remaining time to consume + decode the rest of the stream (0 for Redis).
    #[serde(default)]
    pub fetch_ms:     u64,
    /// Server warnings collected after execution (MySQL `SHOW WARNINGS`),
    /// one formatted line per warning — empty unless explicitly requested.
    #[serde(default)]
    pub warnings:     Vec<String>,
    /// True when the row cap cut the result: the server had more rows than
    /// `rows` carries. The frontend shows a truncation notice — a silently
    /// partial result would be worse than no cap at all.
    #[serde(default)]
    pub truncated:    bool,
}

fn default_true() -> bool {
    true
}

/// One label on a connection.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct Label {
    /// Display name, without the hidden marker. Case is preserved; comparison
    /// is case-insensitive, so `CZ-test` and `cz-test` cannot name two
    /// different server sets.
    pub name: String,
    /// Groups and filters, but is not shown as a chip.
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnInfo {
    pub name:      String,
    pub type_name: String,
    pub nullable:  bool,
}

/// Live session — one per open connection tab.
/// Defined here to avoid circular imports between connection.rs and engine modules.
pub enum LiveSession {
    Mysql(sqlx::MySqlPool),
    Postgres(sqlx::PgPool),
    /// The shared multiplexed manager, plus the Client it was built from so
    /// callers that must change connection state (SELECT for a db sweep) can
    /// open a DEDICATED connection instead of mutating the shared one.
    Redis(::redis::aio::ConnectionManager, ::redis::Client),
    /// HTTP is stateless, so this holds a configured client rather than a pool.
    Clickhouse(super::clickhouse::ChSession),
    Sqlite(sqlx::SqlitePool),
    /// The file's metadata, read once at open. Parquet is immutable, so there
    /// is no connection to keep and nothing can change underneath us.
    Parquet(std::sync::Arc<super::parquet::ParquetFile>),
    /// One blocking connection behind a mutex, plus its interrupt handle.
    Duckdb(std::sync::Arc<super::duckdb::DuckDbSession>),
    /// The client manages its own connection pool internally (Arc-cheap to
    /// clone), so the session IS the client — like Redis's ConnectionManager.
    MongoDb(mongodb::Client),
    /// One TDS connection behind a mutex — tiberius's `&mut self` client makes
    /// the mutex the concurrency model (db/sqlserver.rs module docs).
    SqlServer(super::sqlserver::SqlServerSession),
}

impl LiveSession {
    #[allow(dead_code)] // debug/logging helper
    pub fn engine_name(&self) -> &'static str {
        match self {
            LiveSession::Mysql(_)    => "mysql",
            LiveSession::Postgres(_) => "postgres",
            LiveSession::Redis(..)   => "redis",
            LiveSession::Clickhouse(_) => "clickhouse",
            LiveSession::Sqlite(_)   => "sqlite",
            LiveSession::Parquet(_)  => "parquet",
            LiveSession::Duckdb(_)   => "duckdb",
            LiveSession::MongoDb(_)  => "mongodb",
            LiveSession::SqlServer(_) => "sqlserver",
        }
    }
}

/// Rich column metadata for the data browser (extends ColumnInfo).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableColumn {
    pub name:        String,
    pub type_name:   String,
    pub nullable:    bool,
    pub primary_key: bool,
    pub fk_table:    Option<String>,   // "schema.table" or "table"
    pub fk_column:   Option<String>,
}

/// Full table metadata returned to the data browser.
#[derive(Debug, Serialize, Deserialize)]
pub struct TableMeta {
    pub columns:     Vec<TableColumn>,
    pub pk_columns:  Vec<String>,
    pub total_rows:  Option<i64>,
}

/// Filter operator for data browser queries.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq, Neq, Lt, Lte, Gt, Gte,
    Like, NotLike, IsNull, IsNotNull,
}

impl FilterOp {
    pub fn to_sql(&self) -> &'static str {
        match self {
            FilterOp::Eq         => "=",
            FilterOp::Neq        => "!=",
            FilterOp::Lt         => "<",
            FilterOp::Lte        => "<=",
            FilterOp::Gt         => ">",
            FilterOp::Gte        => ">=",
            FilterOp::Like       => "LIKE",
            FilterOp::NotLike    => "NOT LIKE",
            FilterOp::IsNull     => "IS NULL",
            FilterOp::IsNotNull  => "IS NOT NULL",
        }
    }
    pub fn has_value(&self) -> bool {
        !matches!(self, FilterOp::IsNull | FilterOp::IsNotNull)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FilterClause {
    pub column: String,
    pub op:     FilterOp,
    pub value:  Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum SortDir { Asc, Desc }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SortClause {
    pub column:    String,
    pub direction: SortDir,
}

/// Parameters for a data browser page fetch.
#[derive(Debug, Serialize, Deserialize)]
pub struct BrowseParams {
    pub session_id:  uuid::Uuid,
    pub table:       String,      // "schema.table" or "table"
    pub filters:     Vec<FilterClause>,
    pub sort:        Vec<SortClause>,
    pub limit:       i64,
    pub offset:      i64,
}


/// Schema tree node
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SchemaNode {
    Database { name: String },
    Schema   { name: String },
    /// `partition_of` names the parent when this table is a PostgreSQL
    /// partition — those are grouped separately so they do not bury the real
    /// tables (a monthly-partitioned table can have hundreds).
    Table    { name: String, schema: Option<String>, row_count: Option<i64>,
               #[serde(default)] partition_of: Option<String>,
               /// MariaDB system-versioned (temporal) table.
               ///
               /// Worth marking because nothing else shows it: the versioning
               /// columns `row_start` / `row_end` are hidden from
               /// `information_schema.COLUMNS`, so a table that silently keeps
               /// every historical row looks exactly like one that does not —
               /// and its history is unreachable without `FOR SYSTEM_TIME`.
               #[serde(default)] temporal: bool },
    View     { name: String, schema: Option<String> },
    /// PostgreSQL materialized view — kept distinct from a plain view because
    /// it stores rows, can be indexed, and needs REFRESH.
    MatView  { name: String, schema: Option<String> },
    /// ClickHouse `Distributed`-engine table — a proxy that fans queries across
    /// a `cluster` to a local (target) table `target_db.target_table` on each
    /// shard. It holds no data itself, so the tree badges it and links straight
    /// to the local table, and names the cluster it spans.
    Distributed { name: String, schema: Option<String>, cluster: String,
                  target_db: String, target_table: String },
    /// ClickHouse materialized-view storage target — the backing table an MV
    /// writes into (an explicit `TO db.tbl`, or the implicit `.inner_id.<uuid>`
    /// / `.inner.<name>` table). Emitted as a child of the MV so its real size
    /// is visible and the storage table is one click away. `name`/`schema` name
    /// the target; `bytes`/`parts` come from system.parts for a MergeTree
    /// target and are `None` when it stores no parts (e.g. a Null engine).
    MatViewTarget { name: String, schema: Option<String>,
                    bytes: Option<i64>, parts: Option<i64> },
    /// Stored procedure or function (`routine_type` = "PROCEDURE" | "FUNCTION")
    Routine  { name: String, schema: Option<String>, routine_type: String },
    /// `table` is the relation the trigger is attached to (the tree lists
    /// triggers schema-flat, so it is carried on the node rather than derivable
    /// from the tree path). `None` when the source could not supply it.
    Trigger  { name: String, schema: Option<String>,
               #[serde(default)] table: Option<String> },
    Event    { name: String, schema: Option<String> },
    /// PostgreSQL sequence (standalone — identity/serial-owned ones are hidden)
    Sequence { name: String, schema: Option<String> },
    /// User-defined type (`type_kind` = "ENUM" | "DOMAIN" | "RANGE" | "COMPOSITE")
    Type     { name: String, schema: Option<String>, type_kind: String },
    /// PostgreSQL row-level security policy.
    ///
    /// Invisible in every schema browser, and the one object whose absence is
    /// itself a defect: a table with RLS enabled and no policy silently
    /// returns nothing to every non-owner — it reads as an empty table, not as
    /// a permission error. `table` is the relation it guards.
    Policy   { name: String, schema: Option<String>, table: String, command: String },
    /// Installed extension, listed in the schema it installed into.
    ///
    /// `version` is what is installed; `default_version` is what the server
    /// has available, so a drift between them is an ALTER EXTENSION … UPDATE
    /// nobody has run.
    Extension { name: String, schema: Option<String>, version: String,
                default_version: Option<String> },
    /// PostgreSQL logical-replication publication (cluster-global, listed at
    /// the connection root). `all_tables` is `FOR ALL TABLES`; `table_count`
    /// is the number of explicitly added member relations.
    Publication  { name: String, schema: Option<String>, all_tables: bool,
                   table_count: i64 },
    /// PostgreSQL event trigger (cluster-global). `event` is the firing point
    /// (`ddl_command_start`, `sql_drop`, …); `enabled` is false when disabled.
    EventTrigger { name: String, schema: Option<String>, event: String,
                   enabled: bool },
    /// PostgreSQL tablespace (cluster-global). `location` is empty for the
    /// built-in `pg_default` / `pg_global`.
    Tablespace   { name: String, schema: Option<String>, owner: String,
                   location: String },
    /// PostgreSQL foreign server (cluster-global). `fdw` names the foreign
    /// data wrapper it uses.
    ForeignServer { name: String, schema: Option<String>, fdw: String },
    /// PostgreSQL foreign table — a relation backed by a foreign server, kept
    /// distinct from ordinary tables so the tree groups them apart. `server`
    /// is the foreign server it reads through.
    ForeignTable { name: String, schema: Option<String>, server: String },
    /// Redis key namespace — the `user:` in `user:1`. Redis has no schema
    /// layer, so the tree groups by the separator convention everyone uses
    /// instead of inventing SQL-shaped nodes.
    KeyPrefix { name: String, schema: Option<String>, count: i64, sampled: bool },
    Column   { name: String, type_name: String, nullable: bool, primary_key: bool },
    /// A nested (struct / list-of-struct) column that expands to child fields.
    /// `path` is the full dotted path from the table root (e.g. "addr.geo"),
    /// used to fetch its children — Parquet only, so it never goes through the
    /// two-level `parentPath` the other engines' columns use.
    StructColumn { name: String, type_name: String, nullable: bool, path: String },
    Index    { name: String, unique: bool, columns: Vec<String> },
}

#[cfg(test)]
mod tests {
    use super::Engine;

    /// The frontend, the connUrl scheme and saved connections.json all use
    /// single-token engine names. The enum is snake_case, which turns a
    /// two-word variant into "sql_server" / "mongo_db" — the renames exist so
    /// that never reaches the wire.
    #[test]
    fn engine_wire_names_are_single_tokens() {
        assert_eq!(serde_json::to_string(&Engine::MongoDb).unwrap(), "\"mongodb\"");
        assert_eq!(serde_json::to_string(&Engine::SqlServer).unwrap(), "\"sqlserver\"");
        assert_eq!(serde_json::from_str::<Engine>("\"sqlserver\"").unwrap(), Engine::SqlServer);
        // A connections.json written before the rename still loads.
        assert_eq!(serde_json::from_str::<Engine>("\"mongo_db\"").unwrap(), Engine::MongoDb);
    }

    /// wire_name is the hand-written twin of the serde renames — it must agree
    /// with serialization for every variant, or an audit row would carry an
    /// engine name the frontend does not recognize.
    #[test]
    fn wire_name_matches_serde_for_every_variant() {
        for e in [
            Engine::Mysql, Engine::Postgres, Engine::Redis, Engine::Clickhouse,
            Engine::Sqlite, Engine::Parquet, Engine::Duckdb, Engine::MongoDb,
            Engine::SqlServer,
        ] {
            assert_eq!(serde_json::to_string(&e).unwrap(), format!("\"{}\"", e.wire_name()));
        }
    }
}
