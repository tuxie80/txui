//! MongoDB driver (plan-dba-focus.md WS4) — **read-only by design**.
//!
//! Scope of the v1 engine: connect, the database/collection tree, the find
//! editor (`mongo_find`), the data browser over collections, a processlist
//! (`currentOp`/`killOp`) and buildInfo/serverStatus. There is deliberately
//! **no write path at all**: this module exposes no insert/update/delete/
//! aggregate-$out function, so the house read-only enforcement (PG's
//! `default_transaction_read_only`, MySQL's `SET SESSION transaction_read_only`,
//! ClickHouse's `readonly=1`) needs no Mongo equivalent — a write cannot be
//! expressed. Every decoded document is data going OUT, never in.
//!
//! BSON decode doctrine (mirrors the row-decoding rules of db/mysql.rs):
//! - `null` / `undefined` are checked FIRST and become JSON null;
//! - ObjectId → hex string, Decimal128 → its exact string form (never f64),
//!   DateTime → RFC3339 string, UUID-typed binData → hyphenated string,
//!   other binData → "BinData(subtype, base64)" string;
//! - nested documents and arrays decode recursively; at the GRID level they
//!   are rendered as JSON text (a cell is one value, never a tree);
//! - NaN / ±Infinity doubles become string sentinels via `json_f64` — a
//!   non-finite number never masquerades as NULL.
use anyhow::Result;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, spec::BinarySubtype, Bson, Document};
use std::time::{Duration, Instant};

use super::types::{
    ColumnInfo, ConnectionConfig, LiveSession, PingResult, QueryResult, SchemaNode, TableColumn,
    TableMeta,
};

/// Client name reported to the server — visible in `currentOp().appName` and
/// the server log, and the basis of self-protection in the kill path.
pub const APP_NAME: &str = "TxUI";

/// Hard ceiling on a single find page, mirroring the SQL engines' default-
/// LIMIT guard: an accidental unbounded find over a huge collection must not
/// stream it all into the webview.
pub const MAX_FIND_LIMIT: i64 = 10_000;

/// Documents sampled to infer a collection's key list (tree expansion, data
/// browser metadata). A sample, not a full scan: a collection is schemaless,
/// so exhaustive key discovery costs a full collection read.
const KEY_SAMPLE_SIZE: i64 = 100;

/// Build the `mongodb://` URI from the structured config.
///
/// `host_override` = Some(("127.0.0.1", local_port)) when an SSH tunnel is up.
/// TLS is a URI parameter (`tls=true`), driven by ssl_mode: only `Disable`
/// dials plaintext. `database` becomes the URI path — which is ALSO the
/// default authSource, per MongoDB URI semantics; `authSource` in
/// extra_params overrides that (the common `admin` case needs it when the
/// default db is something else).
fn build_uri(
    config: &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
) -> String {
    let (host, port) = host_override.unwrap_or((
        config.host.as_deref().unwrap_or("127.0.0.1"),
        config.port.unwrap_or(27017),
    ));
    // Same macOS trap as the other drivers: "localhost" can resolve to ::1
    // only after a network change. Pinned to IPv4 unless a tunnel overrode it.
    let host = if host_override.is_none() { super::util::pin_localhost(host) } else { host };

    let user = config.user.as_deref().unwrap_or("").trim();
    let creds = match (user.is_empty(), password.as_deref().filter(|p| !p.is_empty())) {
        (true, None)     => String::new(),
        (true, Some(p))  => format!(":{}@", super::util::userinfo_encode(p)),
        (false, None)    => format!("{}@", super::util::userinfo_encode(user)),
        (false, Some(p)) => format!("{}:{}@", super::util::userinfo_encode(user), super::util::userinfo_encode(p)),
    };

    let db_path = match config.database.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(db) => format!("/{}", super::util::userinfo_encode(db)),
        None => String::new(),
    };

    // A short allowlist of URI options taken from extra_params — the keys a
    // connection genuinely needs (authSource above all). Unknown keys are
    // ignored rather than sprayed into the URI.
    let mut params: Vec<String> = Vec::new();
    for key in ["authSource", "replicaSet", "directConnection"] {
        if let Some(v) = config.extra_params.get(key).map(|s| s.trim()).filter(|s| !s.is_empty()) {
            params.push(format!("{}={}", key, super::util::userinfo_encode(v)));
        }
    }
    if !matches!(config.ssl_mode, super::types::SslMode::Disable) {
        params.push("tls=true".to_string());
        // The driver's rustls-tls feature verifies against a BAKED webpki
        // (Mozilla) root list, not the OS store — see the note on the mongodb
        // dependency in Cargo.toml. A deployment behind a corporate/internal
        // CA therefore needs the CA handed over explicitly; the connection's
        // CA-path field maps to the driver's tlsCAFile option.
        if let Some(ca) = config.ssl_ca_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            params.push(format!("tlsCAFile={}", super::util::userinfo_encode(ca)));
        }
    }
    let query = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };

    format!("mongodb://{creds}{host}:{port}{db_path}{query}")
}

/// `host_override` = Some(("127.0.0.1", local_port)) when an SSH tunnel is up.
///
/// The driver connects lazily, so open runs `ping` itself — a refused endpoint
/// must surface at connect, not on the first tree expansion.
pub async fn open(
    config: &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
) -> Result<LiveSession> {
    let client = connect(config, password, host_override).await?;
    client.database("admin").run_command(doc! { "ping": 1 }).await?;
    Ok(LiveSession::MongoDb(client))
}

/// Shared by open() and ping(): build the client with the house timeouts and
/// app name. No I/O happens here — the caller's first command does the dial.
async fn connect(
    config: &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
) -> Result<mongodb::Client> {
    let uri = build_uri(config, password, host_override);
    let mut opts = mongodb::options::ClientOptions::parse(&uri).await?;
    opts.app_name = Some(APP_NAME.into());
    // Never unbounded: see DEFAULT_CONNECT_TIMEOUT_SECS in db/types.rs.
    let secs = config.connect_timeout_secs
        .map(u64::from)
        .filter(|s| *s > 0)
        .unwrap_or(super::types::DEFAULT_CONNECT_TIMEOUT_SECS);
    opts.connect_timeout = Some(Duration::from_secs(secs));
    opts.server_selection_timeout = Some(Duration::from_secs(secs));
    Ok(mongodb::Client::with_options(opts)?)
}

pub async fn ping(config: &ConnectionConfig, password: Option<String>) -> PingResult {
    let start = Instant::now();
    match connect(config, password, None).await {
        Ok(client) => {
            let pong = client.database("admin").run_command(doc! { "ping": 1 }).await;
            let version = server_version(&client).await.ok();
            PingResult {
                ok: pong.is_ok(),
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: version,
                error: pong.err().map(|e| e.to_string()),
            }
        }
        Err(e) => PingResult {
            ok: false, latency_ms: start.elapsed().as_millis() as u64,
            server_version: None, error: Some(e.to_string()),
        },
    }
}

/// `buildInfo.version` — the probe behind session_ping and the connect summary.
pub async fn server_version(client: &mongodb::Client) -> Result<String> {
    let doc = client.database("admin").run_command(doc! { "buildInfo": 1 }).await?;
    let v = doc.get_str("version").unwrap_or("unknown");
    Ok(format!("MongoDB {v}"))
}

// ── Schema tree ───────────────────────────────────────────────────────────────

/// `context` = None → the databases; Some(db) → its collections and views.
pub async fn list_schema(
    client: &mongodb::Client,
    context: Option<&str>,
) -> Result<Vec<SchemaNode>> {
    match context {
        None => {
            let mut names = client.list_database_names().await?;
            names.sort();
            Ok(names.into_iter().map(|name| SchemaNode::Database { name }).collect())
        }
        Some(db) => {
            let mut cursor = client.database(db).list_collections().await?;
            let mut out: Vec<SchemaNode> = Vec::new();
            while let Some(spec) = cursor.try_next().await? {
                let schema = Some(db.to_string());
                match spec.collection_type {
                    mongodb::results::CollectionType::View =>
                        out.push(SchemaNode::View { name: spec.name, schema }),
                    // Collections and time-series collections both browse like
                    // tables. Row counts are NOT estimated here — one
                    // estimated_document_count per collection per expansion is
                    // a flood on a wide database.
                    _ => out.push(SchemaNode::Table {
                        name: spec.name, schema, row_count: None,
                        partition_of: None, temporal: false,
                    }),
                }
            }
            out.sort_by(|a, b| {
                let name = |n: &SchemaNode| match n {
                    SchemaNode::Table { name, .. } | SchemaNode::View { name, .. } => name.clone(),
                    _ => String::new(),
                };
                name(a).cmp(&name(b))
            });
            Ok(out)
        }
    }
}

/// Short, UI-facing name of a BSON type ("objectId", "int", …).
pub fn bson_type_name(v: &Bson) -> &'static str {
    match v {
        Bson::Double(_)                  => "double",
        Bson::String(_)                  => "string",
        Bson::Array(_)                   => "array",
        Bson::Document(_)                => "object",
        Bson::Boolean(_)                 => "bool",
        Bson::Null                       => "null",
        Bson::RegularExpression(_)       => "regex",
        Bson::JavaScriptCode(_)          => "javascript",
        Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Int32(_)                   => "int",
        Bson::Int64(_)                   => "long",
        Bson::Timestamp(_)               => "timestamp",
        Bson::Binary(b) => match b.subtype {
            BinarySubtype::Uuid | BinarySubtype::UuidOld => "uuid",
            _ => "binData",
        },
        Bson::ObjectId(_)                => "objectId",
        Bson::DateTime(_)                => "date",
        Bson::Symbol(_)                  => "symbol",
        Bson::Decimal128(_)              => "decimal",
        Bson::Undefined                  => "undefined",
        Bson::MaxKey                     => "maxKey",
        Bson::MinKey                     => "minKey",
        Bson::DbPointer(_)               => "dbPointer",
    }
}

/// The driver error's Display dumps the whole kind + a hex RawDocumentBuf —
/// unreadable in a UI error bar. The kind's `message` is the server's real
/// sentence ("unknown operator: $nosuchop"); surface exactly that.
fn readable(e: mongodb::error::Error) -> anyhow::Error {
    use mongodb::error::ErrorKind;
    let msg = match &*e.kind {
        ErrorKind::Command(c) => c.message.clone(),
        ErrorKind::ServerSelection { message, .. } => message.clone(),
        _ => e.to_string(),
    };
    anyhow::anyhow!(msg)
}

/// Union of top-level keys across a sample of documents, `_id` first, the rest
/// in first-seen order. A collection is schemaless, so this is descriptive
/// ("keys we saw"), never authoritative — the doc on the find editor says so.
async fn sample_keys(
    client: &mongodb::Client,
    db: &str,
    coll: &str,
) -> Result<Vec<(String, String)>> {
    let mut cursor = client.database(db).collection::<Document>(coll)
        .aggregate([doc! { "$sample": { "size": KEY_SAMPLE_SIZE } }])
        .await?;
    let mut keys: Vec<(String, String)> = Vec::new();
    let mut docs = 0usize;
    while let Some(d) = cursor.try_next().await? {
        docs += 1;
        for (k, v) in d.iter() {
            if keys.iter().any(|(name, _)| name == k) { continue; }
            keys.push((k.clone(), bson_type_name(v).to_string()));
        }
    }
    // `_id` first — it is the one key every document is guaranteed to have.
    keys.sort_by(|a, b| {
        let rank = |k: &str| if k == "_id" { 0 } else { 1 };
        (rank(&a.0), "").cmp(&(rank(&b.0), ""))
    });
    let _ = docs;
    Ok(keys)
}

/// `parent` = "db.collection". Sampled keys as column nodes; `_id` marked as
/// the primary key (it is, always, in MongoDB).
pub async fn list_columns(
    client: &mongodb::Client,
    db: &str,
    coll: &str,
) -> Result<Vec<SchemaNode>> {
    let mut keys = sample_keys(client, db, coll).await?;
    if keys.is_empty() {
        // An empty collection still has an _id.
        keys.push(("_id".into(), "objectId".into()));
    }
    Ok(keys.into_iter().map(|(name, type_name)| SchemaNode::Column {
        primary_key: name == "_id",
        name, type_name, nullable: true,
    }).collect())
}

/// The closest thing MongoDB has to DDL: the collection's creation options and
/// validator, rendered as the `db.createCollection()` call that would remake
/// it. Not an invented CREATE TABLE — the server's own options document.
pub async fn get_ddl(client: &mongodb::Client, db: &str, coll: &str) -> Result<String> {
    let mut cursor = client.database(db).list_collections()
        .filter(doc! { "name": coll })
        .await?;
    let spec = cursor.try_next().await?
        .ok_or_else(|| anyhow::anyhow!("collection not found: {db}.{coll}"))?;
    let options = mongodb::bson::to_document(&spec.options)?;
    let opts_json = serde_json::to_string_pretty(&bson_to_json(&Bson::Document(options)))
        .unwrap_or_else(|_| "{}".into());
    Ok(match spec.collection_type {
        mongodb::results::CollectionType::View =>
            format!("// view {db}.{coll}\n{opts_json}"),
        _ => format!("db.createCollection(\"{coll}\", {opts_json})"),
    })
}

/// Browser metadata: sampled keys as columns, `_id` as the PK, and the
/// estimated document count (cheap metadata, not a scan).
pub async fn get_table_meta(client: &mongodb::Client, db: &str, coll: &str) -> Result<TableMeta> {
    let mut keys = sample_keys(client, db, coll).await?;
    if keys.is_empty() {
        keys.push(("_id".into(), "objectId".into()));
    }
    let total = client.database(db).collection::<Document>(coll)
        .estimated_document_count()
        .await
        .ok()
        .map(|n| n as i64);
    Ok(TableMeta {
        columns: keys.into_iter().map(|(name, type_name)| TableColumn {
            primary_key: name == "_id",
            fk_table: None, fk_column: None,
            name, type_name, nullable: true,
        }).collect(),
        pk_columns: vec!["_id".into()],
        total_rows: total,
    })
}

// ── find ──────────────────────────────────────────────────────────────────────

/// Parse a JSON object (extended JSON accepted: `{"$oid": …}`, `{"$date": …}`,
/// and plain MQL operators like `{"$gt": 5}`) into a BSON document.
/// `None`/blank means "absent". Errors name the field and quote the parser's
/// complaint — a bad filter must read as a bad filter, not a server error.
pub fn parse_doc(raw: Option<&str>, what: &str) -> Result<Option<Document>> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(None) };
    let v: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| anyhow::anyhow!("invalid {what} JSON: {e}"))?;
    let bson = mongodb::bson::to_bson(&v)
        .map_err(|e| anyhow::anyhow!("invalid {what}: {e}"))?;
    match bson {
        Bson::Document(d) => Ok(Some(d)),
        _ => Err(anyhow::anyhow!("{what} must be a JSON object ({{ … }})")),
    }
}

/// Arguments for one find page. All JSON fields are optional text from the
/// find editor; `limit`/`skip` page the result.
#[derive(Debug, Default, Clone)]
pub struct FindArgs {
    pub filter:     Option<String>,
    pub projection: Option<String>,
    pub sort:       Option<String>,
    pub limit:      i64,
    pub skip:       u64,
}

/// Run the find and shape the page into a grid: columns are the union of the
/// page's top-level keys (`_id` first), nested values render as JSON text.
pub async fn find(
    client: &mongodb::Client,
    db: &str,
    coll: &str,
    args: &FindArgs,
) -> Result<QueryResult> {
    let filter     = parse_doc(args.filter.as_deref(), "filter")?.unwrap_or_default();
    let projection = parse_doc(args.projection.as_deref(), "projection")?;
    let sort       = parse_doc(args.sort.as_deref(), "sort")?;
    // clamp, never trust: 0/negative means "the page size the caller asked
    // for was missing" — fall to a page, never to unbounded.
    let limit = if args.limit <= 0 { 500 } else { args.limit.min(MAX_FIND_LIMIT) };

    let start = Instant::now();
    let collection = client.database(db).collection::<Document>(coll);
    let mut q = collection
        .find(filter)
        .limit(limit)
        .skip(args.skip);
    if let Some(p) = projection { q = q.projection(p); }
    if let Some(s) = sort { q = q.sort(s); }
    let mut cursor = q.await.map_err(readable)?;

    let mut docs: Vec<Document> = Vec::new();
    let mut first_ms: Option<u64> = None;
    while let Some(d) = cursor.try_next().await.map_err(readable)? {
        if first_ms.is_none() { first_ms = Some(start.elapsed().as_millis() as u64); }
        docs.push(d);
    }
    let execution_ms = first_ms.unwrap_or_else(|| start.elapsed().as_millis() as u64);
    let fetch_ms = start.elapsed().as_millis() as u64 - execution_ms;

    let (columns, rows) = shape_docs(&docs);
    Ok(QueryResult {
        columns, rows, rows_affected: None, execution_ms, fetch_ms, warnings: vec![],
        truncated: false,
    })
}

/// Shape a page of documents into grid columns + rows. Exposed for tests.
pub fn shape_docs(docs: &[Document]) -> (Vec<ColumnInfo>, Vec<Vec<serde_json::Value>>) {
    // Column set: union of top-level keys in first-seen order, `_id` pinned
    // first. A cap exists because a hostile collection could carry thousands
    // of distinct keys across documents.
    const MAX_COLUMNS: usize = 200;
    let mut names: Vec<String> = Vec::new();
    for d in docs {
        for k in d.keys() {
            if !names.iter().any(|n| n == k) { names.push(k.clone()); }
            if names.len() >= MAX_COLUMNS { break; }
        }
        if names.len() >= MAX_COLUMNS { break; }
    }
    names.sort_by_key(|k| if k == "_id" { 0 } else { 1 });

    // Column type = the first non-null value's BSON type name.
    let mut types: Vec<String> = vec![String::new(); names.len()];
    for d in docs {
        for (i, n) in names.iter().enumerate() {
            if !types[i].is_empty() { continue; }
            if let Some(v) = d.get(n) {
                if !matches!(v, Bson::Null | Bson::Undefined) {
                    types[i] = bson_type_name(v).to_string();
                }
            }
        }
    }

    let columns: Vec<ColumnInfo> = names.iter().enumerate().map(|(i, n)| ColumnInfo {
        name: n.clone(),
        type_name: if types[i].is_empty() { "null".into() } else { types[i].clone() },
        nullable: true,
    }).collect();

    let rows = docs.iter().map(|d| {
        names.iter().map(|n| match d.get(n) {
            None => serde_json::Value::Null,
            // A nested value is JSON TEXT in the cell — a grid cell is one
            // value, and CellViewer shows the pretty form on double-click.
            Some(v @ (Bson::Document(_) | Bson::Array(_))) =>
                serde_json::Value::String(
                    serde_json::to_string(&bson_to_json(v)).unwrap_or_default()),
            Some(v) => bson_to_json(v),
        }).collect()
    }).collect();

    (columns, rows)
}

/// `explain()` for a find — the real planner output, not an emulation.
/// `analyze` = executionStats verbosity (executes the query); queryPlanner
/// otherwise. Rendered as pretty JSON text for the find editor's plan view.
pub async fn explain_find(
    client: &mongodb::Client,
    db: &str,
    coll: &str,
    filter: Option<&str>,
    analyze: bool,
) -> Result<String> {
    let filter = parse_doc(filter, "filter")?.unwrap_or_default();
    let verbosity = if analyze { "executionStats" } else { "queryPlanner" };
    let out = client.database(db).run_command(doc! {
        "explain": { "find": coll, "filter": filter },
        "verbosity": verbosity,
    }).await.map_err(readable)?;
    Ok(serde_json::to_string_pretty(&bson_to_json(&Bson::Document(out)))
        .unwrap_or_default())
}

// ── currentOp / killOp (the processlist) ─────────────────────────────────────

/// In-progress operations, shaped as a grid for the Processes panel.
/// `$all: true` so idle connections and system ops are visible too — a DBA
/// hunting a stall needs the whole picture, and Mongo's own shell defaults
/// the other way.
pub async fn current_ops(client: &mongodb::Client) -> Result<QueryResult> {
    let start = Instant::now();
    let out = client.database("admin").run_command(doc! {
        "currentOp": 1, "$all": true,
    }).await.map_err(readable)?;
    let inprog = out.get_array("inprog").cloned().unwrap_or_default();

    let columns = ["opid", "active", "op", "ns", "secs_running", "client", "app", "desc"]
        .iter().map(|n| ColumnInfo {
            name: n.to_string(), type_name: "mixed".into(), nullable: true,
        }).collect::<Vec<_>>();

    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    for op in &inprog {
        let Bson::Document(d) = op else { continue };
        let get = |k: &str| d.get(k).map(bson_to_json).unwrap_or(serde_json::Value::Null);
        // opid is numeric on a standalone/replica-set member, "shard:opid"
        // via mongos — the string form is kept verbatim either way.
        let secs = d.get("secs_running").map(bson_to_json).unwrap_or(serde_json::Value::Null);
        rows.push(vec![
            get("opid"), get("active"), get("op"), get("ns"), secs,
            get("client"), get("appName"), get("desc"),
        ]);
    }
    // Longest-running first, the panel's contract on every engine.
    rows.sort_by_key(|r| std::cmp::Reverse(r[4].as_i64().unwrap_or(0)));
    let ms = start.elapsed().as_millis() as u64;
    Ok(QueryResult {
        columns, rows, rows_affected: None,
        execution_ms: ms, fetch_ms: 0, warnings: vec![],
        truncated: false,
    })
}

/// killOp. Always answers ok on a standalone — even for a dead opid — so the
/// caller reports "request sent", not "op killed" (see kill.rs for the wording).
pub async fn kill_op(client: &mongodb::Client, opid: u64) -> Result<()> {
    client.database("admin").run_command(doc! {
        "killOp": 1, "op": opid as i64,
    }).await?;
    Ok(())
}

/// The opids of OUR OWN connections (appName == APP_NAME). The kill path
/// refuses these, the same self-protection the MySQL/PG/Redis paths have.
pub async fn own_opids(client: &mongodb::Client) -> Vec<u64> {
    let out = client.database("admin").run_command(doc! {
        "currentOp": 1, "$all": true, "$ownOps": true,
    }).await;
    let Ok(out) = out else { return Vec::new() };
    out.get_array("inprog").cloned().unwrap_or_default().iter()
        .filter_map(|op| match op {
            Bson::Document(d) => d.get("opid").and_then(|v| match v {
                Bson::Int32(n) => Some(*n as u64),
                Bson::Int64(n) => Some((*n).max(0) as u64),
                _ => None,
            }),
            _ => None,
        })
        .collect()
}

// ── server info ───────────────────────────────────────────────────────────────

/// `kind` = "variables" | "status" — buildInfo is the settings-shaped answer
/// (what the server IS: version, modules, allocator), serverStatus the status
/// one (what it is DOING). Flattened to (section, name, value) rows like the
/// Redis INFO view; nested paths are dotted, arrays/objects scalar-stopped.
pub async fn server_info(client: &mongodb::Client, kind: &str) -> Result<QueryResult> {
    let cmd = match kind {
        "variables" => doc! { "buildInfo": 1 },
        "status"    => doc! { "serverStatus": 1 },
        _ => anyhow::bail!("server info '{kind}' not available for MongoDB"),
    };
    let out = client.database("admin").run_command(cmd).await?;

    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    for (section, v) in out.iter() {
        flatten_doc(v, section, "", &mut rows);
    }
    // serverStatus is deep; cap the flattened form so a huge status document
    // cannot ship ten thousand rows to the webview.
    rows.truncate(2000);

    Ok(QueryResult {
        columns: vec![
            ColumnInfo { name: "section".into(), type_name: "string".into(), nullable: false },
            ColumnInfo { name: "name".into(),    type_name: "string".into(), nullable: false },
            ColumnInfo { name: "value".into(),   type_name: "string".into(), nullable: true },
        ],
        rows, rows_affected: None, execution_ms: 0, fetch_ms: 0, warnings: vec![],
        truncated: false,
    })
}

fn flatten_doc(
    v: &Bson,
    section: &str,
    prefix: &str,
    rows: &mut Vec<Vec<serde_json::Value>>,
) {
    match v {
        Bson::Document(d) => {
            for (k, inner) in d.iter() {
                let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                flatten_doc(inner, section, &path, rows);
            }
        }
        _ => {
            let text = match bson_to_json(v) {
                serde_json::Value::String(s) => s,
                serde_json::Value::Null => "null".into(),
                other => other.to_string(),
            };
            rows.push(vec![
                serde_json::Value::String(section.into()),
                serde_json::Value::String(prefix.into()),
                serde_json::Value::String(text),
            ]);
        }
    }
}

// ── BSON → JSON decode ────────────────────────────────────────────────────────

/// Decode a BSON value to a JSON-safe one, per the doctrine in the module
/// header. Recursive; every special BSON type becomes a string form rather
/// than a lossy number or an absent value.
pub fn bson_to_json(v: &Bson) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        // NULL first — the house rule. `undefined` (deprecated BSON type) reads
        // as null because that is what every driver maps it to.
        Bson::Null | Bson::Undefined => J::Null,
        Bson::Boolean(b)  => J::Bool(*b),
        Bson::Int32(n)    => J::from(*n),
        Bson::Int64(n)    => J::from(*n),
        // NaN / ±Infinity become string sentinels, never silent nulls.
        Bson::Double(d)   => super::types::json_f64(*d),
        Bson::String(s)   => J::String(s.clone()),
        Bson::ObjectId(o) => J::String(o.to_hex()),
        // Exact decimal as its string form — never through f64, same rule as
        // DECIMAL/NUMERIC on the SQL engines.
        Bson::Decimal128(d) => J::String(d.to_string()),
        Bson::DateTime(dt) => {
            let ms = dt.timestamp_millis();
            match chrono::DateTime::from_timestamp_millis(ms) {
                Some(t) => J::String(t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                None    => J::String(format!("Date({ms}ms)")),
            }
        }
        Bson::Timestamp(t) => J::String(format!("Timestamp({}, {})", t.time, t.increment)),
        Bson::Binary(b) => match b.subtype {
            // UUID subtypes render hyphenated (RFC 4122). UuidOld is the legacy
            // byte-swapped layout; the bytes are shown as stored rather than
            // pretending to know the producing driver's language convention.
            BinarySubtype::Uuid | BinarySubtype::UuidOld if b.bytes.len() == 16 =>
                J::String(hex_uuid(&b.bytes)),
            _ => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&b.bytes);
                J::String(format!("BinData({}, {b64})", u8::from(b.subtype)))
            }
        },
        Bson::RegularExpression(r) => J::String(format!("/{}/{}", r.pattern, r.options)),
        Bson::JavaScriptCode(c) => J::String(c.clone()),
        Bson::JavaScriptCodeWithScope(c) => {
            let mut m = serde_json::Map::new();
            m.insert("code".into(), J::String(c.code.clone()));
            m.insert("scope".into(), bson_to_json(&Bson::Document(c.scope.clone())));
            J::Object(m)
        }
        Bson::Symbol(s)    => J::String(s.clone()),
        Bson::DbPointer(p) => J::String(format!("DBPointer({p:?})")),
        Bson::MaxKey       => J::String("MaxKey".into()),
        Bson::MinKey       => J::String("MinKey".into()),
        Bson::Array(arr) => J::Array(arr.iter().map(bson_to_json).collect()),
        Bson::Document(d) => {
            let mut m = serde_json::Map::with_capacity(d.len());
            for (k, inner) in d.iter() {
                m.insert(k.clone(), bson_to_json(inner));
            }
            J::Object(m)
        }
    }
}

/// 16 raw bytes → the RFC 4122 hyphenated form (8-4-4-4-12).
fn hex_uuid(bytes: &[u8]) -> String {
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::{Engine, SslMode};
    use mongodb::bson::{oid::ObjectId, Binary, DateTime, Decimal128, Regex, Timestamp};

    fn cfg() -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::MongoDb, "m");
        c.host = Some("db.internal".into());
        c.port = Some(27017);
        c.ssl_mode = SslMode::Disable;
        c
    }

    // ── build_uri ────────────────────────────────────────────────────────────

    #[test]
    fn plain_uri_has_no_credentials_or_db() {
        assert_eq!(build_uri(&cfg(), None, None), "mongodb://db.internal:27017");
    }

    #[test]
    fn credentials_are_percent_encoded() {
        let mut c = cfg();
        c.user = Some("user@corp".into());
        assert_eq!(build_uri(&c, Some("p@ss/w:rd#1".into()), None),
                   "mongodb://user%40corp:p%40ss%2Fw%3Ard%231@db.internal:27017");
    }

    #[test]
    fn database_becomes_the_uri_path() {
        let mut c = cfg();
        c.database = Some("appdb".into());
        assert_eq!(build_uri(&c, None, None), "mongodb://db.internal:27017/appdb");
    }

    #[test]
    fn auth_source_extra_param_is_applied() {
        // The fixture's root user authenticates against admin while the
        // connection's default db may be anything — this is why authSource is
        // the one extra param that cannot wait.
        let mut c = cfg();
        c.extra_params.insert("authSource".into(), "admin".into());
        assert_eq!(build_uri(&c, None, None),
                   "mongodb://db.internal:27017?authSource=admin");
    }

    #[test]
    fn unknown_extra_params_are_not_sprayed_into_the_uri() {
        let mut c = cfg();
        c.extra_params.insert("maxPoolSize".into(), "999".into());
        assert_eq!(build_uri(&c, None, None), "mongodb://db.internal:27017");
    }

    #[test]
    fn tls_is_a_uri_parameter() {
        let mut c = cfg();
        for mode in [SslMode::Preferred, SslMode::Require, SslMode::VerifyCa, SslMode::VerifyFull] {
            c.ssl_mode = mode;
            assert!(build_uri(&c, None, None).contains("tls=true"),
                    "{:?} must request TLS", c.ssl_mode);
        }
        c.ssl_mode = SslMode::Disable;
        assert!(!build_uri(&c, None, None).contains("tls=true"));
    }

    #[test]
    fn ssh_tunnel_endpoint_wins() {
        assert_eq!(build_uri(&cfg(), None, Some(("127.0.0.1", 51234))),
                   "mongodb://127.0.0.1:51234");
    }

    #[test]
    fn localhost_is_pinned_to_ipv4() {
        let mut c = cfg();
        c.host = Some("localhost".into());
        assert_eq!(build_uri(&c, None, None), "mongodb://127.0.0.1:27017");
        assert_eq!(build_uri(&c, None, Some(("localhost", 7000))), "mongodb://localhost:7000");
    }

    // ── parse_doc ────────────────────────────────────────────────────────────

    #[test]
    fn blank_filter_is_absent() {
        assert!(parse_doc(None, "filter").unwrap().is_none());
        assert!(parse_doc(Some("   "), "filter").unwrap().is_none());
    }

    #[test]
    fn mql_operators_parse() {
        let d = parse_doc(Some(r#"{"age": {"$gt": 5}}"#), "filter").unwrap().unwrap();
        // serde_json numbers become BSON Int64 — assert the value, not the width.
        assert_eq!(d.get_document("age").unwrap().get_i64("$gt").unwrap(), 5);
    }

    #[test]
    fn bad_json_names_the_field() {
        let e = parse_doc(Some("{not json"), "filter").unwrap_err().to_string();
        assert!(e.contains("filter"), "{e}");
        assert!(e.contains("JSON"), "{e}");
    }

    #[test]
    fn a_non_object_is_refused() {
        let e = parse_doc(Some("[1,2]"), "sort").unwrap_err().to_string();
        assert!(e.contains("sort"), "{e}");
        assert!(e.contains("object"), "{e}");
    }

    // ── bson_to_json ─────────────────────────────────────────────────────────

    #[test]
    fn null_and_undefined_decode_first() {
        assert_eq!(bson_to_json(&Bson::Null), serde_json::Value::Null);
        assert_eq!(bson_to_json(&Bson::Undefined), serde_json::Value::Null);
    }

    #[test]
    fn object_id_is_hex_and_decimal_is_exact_string() {
        let oid = ObjectId::parse_str("64b7f2a7c7d7a81a4c3f9e01").unwrap();
        assert_eq!(bson_to_json(&Bson::ObjectId(oid)),
                   serde_json::json!("64b7f2a7c7d7a81a4c3f9e01"));
        let d = "3.141592653589793238".parse::<Decimal128>().unwrap();
        assert_eq!(bson_to_json(&Bson::Decimal128(d)),
                   serde_json::json!("3.141592653589793238"));
    }

    #[test]
    fn dates_are_rfc3339_strings() {
        let dt = DateTime::from_millis(1_700_000_000_123);
        assert_eq!(bson_to_json(&Bson::DateTime(dt)),
                   serde_json::json!("2023-11-14T22:13:20.123Z"));
    }

    #[test]
    fn uuid_bindata_is_hyphenated() {
        let b = Binary { subtype: BinarySubtype::Uuid,
                         bytes: hex::decode("00112233445566778899aabbccddeeff").unwrap() };
        assert_eq!(bson_to_json(&Bson::Binary(b)),
                   serde_json::json!("00112233-4455-6677-8899-aabbccddeeff"));
    }

    #[test]
    fn non_uuid_bindata_is_base64_text() {
        let b = Binary { subtype: BinarySubtype::Generic, bytes: vec![1, 2, 3] };
        let v = bson_to_json(&Bson::Binary(b));
        let s = v.as_str().unwrap();
        assert!(s.starts_with("BinData(0, "), "{s}");
    }

    #[test]
    fn non_finite_doubles_are_string_sentinels() {
        assert_eq!(bson_to_json(&Bson::Double(f64::NAN)), serde_json::json!("NaN"));
        assert_eq!(bson_to_json(&Bson::Double(f64::INFINITY)), serde_json::json!("Infinity"));
    }

    #[test]
    fn nested_structures_recurse() {
        let inner = doc! { "a": 1, "ts": Bson::Timestamp(Timestamp { time: 5, increment: 2 }) };
        let v = bson_to_json(&Bson::Document(inner));
        assert_eq!(v["a"], serde_json::json!(1));
        assert_eq!(v["ts"], serde_json::json!("Timestamp(5, 2)"));
        let arr = bson_to_json(&Bson::Array(vec![Bson::Null, Bson::Boolean(true)]));
        assert_eq!(arr, serde_json::json!([null, true]));
    }

    #[test]
    fn regex_and_specials_have_string_forms() {
        let r = Regex { pattern: "^a+".into(), options: "i".into() };
        assert_eq!(bson_to_json(&Bson::RegularExpression(r)), serde_json::json!("/^a+/i"));
        assert_eq!(bson_to_json(&Bson::MaxKey), serde_json::json!("MaxKey"));
        assert_eq!(bson_to_json(&Bson::MinKey), serde_json::json!("MinKey"));
    }

    // ── shape_docs ───────────────────────────────────────────────────────────

    #[test]
    fn id_column_is_pinned_first() {
        let docs = vec![doc! { "z": 1, "_id": ObjectId::parse_str("64b7f2a7c7d7a81a4c3f9e01").unwrap(), "a": 2 }];
        let (cols, _) = shape_docs(&docs);
        assert_eq!(cols[0].name, "_id");
        assert_eq!(cols[0].type_name, "objectId");
    }

    #[test]
    fn nested_values_become_json_text_in_the_cell() {
        let docs = vec![doc! { "_id": 1, "addr": { "city": "Praha" }, "tags": ["a", "b"] }];
        let (cols, rows) = shape_docs(&docs);
        let ci = |n: &str| cols.iter().position(|c| c.name == n).unwrap();
        assert_eq!(rows[0][ci("addr")], serde_json::json!(r#"{"city":"Praha"}"#));
        assert_eq!(rows[0][ci("tags")], serde_json::json!(r#"["a","b"]"#));
        assert_eq!(cols[ci("addr")].type_name, "object");
    }

    #[test]
    fn a_key_missing_from_a_document_is_null_not_absent() {
        let docs = vec![doc! { "_id": 1, "a": 1 }, doc! { "_id": 2 }];
        let (cols, rows) = shape_docs(&docs);
        let ci = cols.iter().position(|c| c.name == "a").unwrap();
        assert_eq!(rows[1][ci], serde_json::Value::Null);
    }

    #[test]
    fn column_type_is_the_first_non_null_values_type() {
        let docs = vec![doc! { "_id": 1, "v": Bson::Null }, doc! { "_id": 2, "v": 7i32 }];
        let (cols, _) = shape_docs(&docs);
        let ci = cols.iter().position(|c| c.name == "v").unwrap();
        assert_eq!(cols[ci].type_name, "int");
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the fixture mongod (127.0.0.1:27017, root/root, authSource
    //! admin). Env-overridable: TXUI_MONGO_HOST / _PORT / _USER / _PASSWORD.
    //! Skipped quietly when nothing is listening.
    //!
    //!   cargo test --lib mongo_live -- --ignored --nocapture
    use crate::db::types::{ConnectionConfig, Engine, LiveSession, SchemaNode, SslMode};
    use mongodb::bson::{doc, oid::ObjectId, spec::BinarySubtype, Bson, Binary, DateTime, Decimal128, Document, Timestamp};

    fn env(k: &str, default: &str) -> String {
        std::env::var(k).unwrap_or_else(|_| default.to_string())
    }

    fn config() -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::MongoDb, "mongo");
        c.host = Some(env("TXUI_MONGO_HOST", "127.0.0.1"));
        c.port = Some(env("TXUI_MONGO_PORT", "27017").parse().unwrap_or(27017));
        c.user = Some(env("TXUI_MONGO_USER", "root"));
        c.ssl_mode = SslMode::Disable;
        c
    }

    fn password() -> Option<String> {
        Some(env("TXUI_MONGO_PASSWORD", "root"))
    }

    /// None when the fixture is not up — every test skips quietly then.
    async fn client() -> Option<mongodb::Client> {
        match super::open(&config(), password(), None).await.ok()? {
            LiveSession::MongoDb(c) => Some(c),
            _ => None,
        }
    }

    /// Drop-if-exists, then load the fixture documents. Each test uses its OWN
    /// database — `cargo test` runs these in parallel threads, and a shared
    /// `txui_mongo_test` raced (one test's drop landed mid-way through
    /// another's find). Writes happen here because they are the TEST's
    /// fixture setup — the driver itself still has no write path.
    async fn fixture(c: &mongodb::Client, db_name: &str, docs: usize) {
        let db = c.database(db_name);
        db.drop().await.expect("drop fixture db");
        let coll = db.collection::<Document>("items");
        let mut batch = Vec::with_capacity(1000);
        for i in 0..docs {
            batch.push(doc! {
                "n": i as i32,
                "parity": if i % 2 == 0 { "even" } else { "odd" },
                "grp": format!("g{}", i % 10),
            });
            if batch.len() == 1000 {
                coll.insert_many(std::mem::take(&mut batch)).await.expect("seed batch");
            }
        }
        if !batch.is_empty() {
            coll.insert_many(batch).await.expect("seed tail");
        }
    }

    async fn cleanup(c: &mongodb::Client, db_name: &str) {
        c.database(db_name).drop().await.expect("cleanup drop");
    }

    #[tokio::test]
    #[ignore]
    async fn mongo_live_ping_reports_version() {
        let r = super::ping(&config(), password()).await;
        if !r.ok {
            println!("no mongodb on 27017 — skipping ({})", r.error.unwrap_or_default());
            return;
        }
        let v = r.server_version.expect("server_version");
        println!("  {v} ({} ms)", r.latency_ms);
        assert!(v.starts_with("MongoDB "), "unexpected version {v}");
        assert!(v.trim_start_matches("MongoDB ").starts_with(char::is_numeric), "{v}");
    }

    #[tokio::test]
    #[ignore]
    async fn mongo_live_tree_lists_databases_and_collections() {
        let Some(c) = client().await else { println!("no mongodb — skipping"); return };
        const DB: &str = "txui_mongo_test_tree";
        fixture(&c, DB, 100).await;

        let dbs = super::list_schema(&c, None).await.expect("list databases");
        let names: Vec<String> = dbs.iter().filter_map(|n| match n {
            SchemaNode::Database { name } => Some(name.clone()),
            _ => None,
        }).collect();
        println!("  databases: {names:?}");
        assert!(names.iter().any(|n| n == DB), "fixture db missing: {names:?}");
        assert!(names.iter().any(|n| n == "admin"), "admin missing: {names:?}");

        let coll = c.database(DB).collection::<Document>("events");
        coll.insert_one(doc! { "kind": "x" }).await.expect("seed events");
        c.database(DB).create_collection("capped_view_src").await.ok();
        c.database(DB).run_command(doc! {
            "create": "v_even", "viewOn": "items",
            "pipeline": [ { "$match": { "parity": "even" } } ],
        }).await.expect("create view");

        let nodes = super::list_schema(&c, Some(DB)).await.expect("list collections");
        let tables: Vec<String> = nodes.iter().filter_map(|n| match n {
            SchemaNode::Table { name, .. } => Some(name.clone()),
            _ => None,
        }).collect();
        let views: Vec<String> = nodes.iter().filter_map(|n| match n {
            SchemaNode::View { name, .. } => Some(name.clone()),
            _ => None,
        }).collect();
        println!("  collections: {tables:?}  views: {views:?}");
        assert!(tables.iter().any(|n| n == "items"), "items missing: {tables:?}");
        assert!(views.iter().any(|n| n == "v_even"), "view not a view node: {nodes:?}");

        // Column expansion = sampled keys, _id first and flagged as the key.
        let cols = super::list_columns(&c, DB, "items").await.expect("columns");
        let names: Vec<(String, bool)> = cols.iter().filter_map(|n| match n {
            SchemaNode::Column { name, primary_key, .. } => Some((name.clone(), *primary_key)),
            _ => None,
        }).collect();
        println!("  items keys: {names:?}");
        assert_eq!(names.first().map(|(n, _)| n.as_str()), Some("_id"));
        assert!(names.iter().any(|(n, pk)| n == "_id" && *pk));
        for k in ["n", "parity", "grp"] {
            assert!(names.iter().any(|(n, _)| n == k), "{k} missing: {names:?}");
        }

        // DDL = the createCollection options document, honestly labelled.
        let ddl = super::get_ddl(&c, DB, "items").await.expect("ddl");
        println!("  ddl: {}", &ddl[..ddl.len().min(120)]);
        assert!(ddl.contains("createCollection"), "{ddl}");

        let meta = super::get_table_meta(&c, DB, "items").await.expect("meta");
        assert_eq!(meta.total_rows, Some(100));
        assert_eq!(meta.pk_columns, vec!["_id".to_string()]);

        cleanup(&c, DB).await;
    }

    #[tokio::test]
    #[ignore]
    async fn mongo_live_find_pages_and_filters_10k_documents() {
        let Some(c) = client().await else { println!("no mongodb — skipping"); return };
        const DB: &str = "txui_mongo_test_find";
        fixture(&c, DB, 10_000).await;

        // Full-ish page: the fixture fits one capped page.
        let r = super::find(&c, DB, "items", &super::FindArgs {
            limit: 20_000, ..Default::default()   // clamped to MAX_FIND_LIMIT
        }).await.expect("find all");
        println!("  unfiltered page: {} rows ({}+{} ms)", r.rows.len(), r.execution_ms, r.fetch_ms);
        assert_eq!(r.rows.len() as i64, super::MAX_FIND_LIMIT);

        // Filter + projection + sort + paging.
        let r = super::find(&c, DB, "items", &super::FindArgs {
            filter:     Some(r#"{"parity": "even", "n": {"$gte": 100}}"#.into()),
            projection: Some(r#"{"n": 1, "parity": 1}"#.into()),
            sort:       Some(r#"{"n": -1}"#.into()),
            limit:      5,
            skip:       0,
        }).await.expect("filtered find");
        assert_eq!(r.rows.len(), 5);
        let ni = r.columns.iter().position(|c| c.name == "n").unwrap();
        let pi = r.columns.iter().position(|c| c.name == "parity").unwrap();
        // Sorted desc: 9998, 9996, … and every row is even.
        assert_eq!(r.rows[0][ni], serde_json::json!(9998));
        assert!(r.rows.iter().all(|row| row[pi] == serde_json::json!("even")));
        // Projection dropped grp.
        assert!(r.columns.iter().all(|c| c.name != "grp"));

        // Skip pages forward.
        let r2 = super::find(&c, DB, "items", &super::FindArgs {
            filter: Some(r#"{"parity": "even"}"#.into()),
            sort: Some(r#"{"n": -1}"#.into()), limit: 5, skip: 5,
            ..Default::default()
        }).await.expect("page 2");
        assert_eq!(r2.rows[0][ni], serde_json::json!(9988));
        println!("  filtered page: {:?} … then {:?}", r.rows[0][ni], r2.rows[0][ni]);

        // A find against a view returns its filtered documents.
        let v = super::find(&c, DB, "items", &super::FindArgs {
            filter: Some(r#"{"grp": "g3"}"#.into()), limit: 10, ..Default::default()
        }).await.expect("view-source find");
        assert_eq!(v.rows.len(), 10);
        assert!(v.rows.iter().all(|row| {
            let gi = v.columns.iter().position(|c| c.name == "grp").unwrap();
            row[gi] == serde_json::json!("g3")
        }));

        cleanup(&c, DB).await;
    }

    #[tokio::test]
    #[ignore]
    async fn mongo_live_bson_type_matrix_decodes() {
        let Some(c) = client().await else { println!("no mongodb — skipping"); return };
        const DB: &str = "txui_mongo_test_types";
        let db = c.database(DB);
        db.drop().await.ok();
        let oid = ObjectId::parse_str("64b7f2a7c7d7a81a4c3f9e01").unwrap();
        let coll = db.collection::<Document>("types");
        coll.insert_one(doc! {
            "_id": oid,
            "s": "hello",
            "i32": 42i32,
            "i64": 9_000_000_000i64,
            "f": 1.5f64,
            "nan": f64::NAN,
            "b": true,
            "nul": Bson::Null,
            "dec": Bson::Decimal128("3.141592653589793238".parse::<Decimal128>().unwrap()),
            "date": Bson::DateTime(DateTime::from_millis(1_700_000_000_123)),
            "ts": Bson::Timestamp(Timestamp { time: 5, increment: 2 }),
            "uuid": Bson::Binary(Binary {
                subtype: BinarySubtype::Uuid,
                bytes: hex::decode("00112233445566778899aabbccddeeff").unwrap(),
            }),
            "bin": Bson::Binary(Binary { subtype: BinarySubtype::Generic, bytes: vec![1,2,3] }),
            "nested": doc! { "x": 1, "y": [1, 2] },
            "arr": vec![1i32, 2i32],
        }).await.expect("seed types");

        let r = super::find(&c, DB, "types", &super::FindArgs {
            filter: Some(format!(r#"{{"_id": {{"$oid": "{oid}"}}}}"#)),
            ..Default::default()
        }).await.expect("find types");
        assert_eq!(r.rows.len(), 1);
        let row = &r.rows[0];
        let cell = |n: &str| {
            let i = r.columns.iter().position(|c| c.name == n).unwrap();
            row[i].clone()
        };
        assert_eq!(cell("_id"), serde_json::json!("64b7f2a7c7d7a81a4c3f9e01"));
        assert_eq!(cell("s"), serde_json::json!("hello"));
        assert_eq!(cell("i32"), serde_json::json!(42));
        assert_eq!(cell("i64"), serde_json::json!(9_000_000_000i64));
        assert_eq!(cell("f"), serde_json::json!(1.5));
        assert_eq!(cell("nan"), serde_json::json!("NaN"), "NaN must not become null");
        assert_eq!(cell("b"), serde_json::json!(true));
        assert_eq!(cell("nul"), serde_json::Value::Null);
        assert_eq!(cell("dec"), serde_json::json!("3.141592653589793238"));
        assert_eq!(cell("date"), serde_json::json!("2023-11-14T22:13:20.123Z"));
        assert_eq!(cell("ts"), serde_json::json!("Timestamp(5, 2)"));
        assert_eq!(cell("uuid"), serde_json::json!("00112233-4455-6677-8899-aabbccddeeff"));
        assert!(cell("bin").as_str().unwrap().starts_with("BinData(0, "));
        assert_eq!(cell("nested"), serde_json::json!(r#"{"x":1,"y":[1,2]}"#));
        assert_eq!(cell("arr"), serde_json::json!("[1,2]"));
        println!("  type matrix: {} columns decoded", r.columns.len());

        cleanup(&c, DB).await;
    }

    #[tokio::test]
    #[ignore]
    async fn mongo_live_bad_filter_json_is_a_readable_error() {
        let Some(c) = client().await else { println!("no mongodb — skipping"); return };
        const DB: &str = "txui_mongo_test_err";
        fixture(&c, DB, 10).await;
        let e = super::find(&c, DB, "items", &super::FindArgs {
            filter: Some("{not json".into()), ..Default::default()
        }).await.unwrap_err().to_string();
        println!("  error: {e}");
        assert!(e.contains("filter"), "{e}");
        assert!(e.contains("JSON"), "{e}");
        // A server-side rejection (unknown operator) is likewise surfaced raw.
        let e2 = super::find(&c, DB, "items", &super::FindArgs {
            filter: Some(r#"{"n": {"$nosuchop": 1}}"#.into()), ..Default::default()
        }).await.unwrap_err().to_string();
        println!("  server error: {e2}");
        assert!(e2.contains("$nosuchop") || e2.contains("unknown"), "{e2}");
        cleanup(&c, DB).await;
    }

    #[tokio::test]
    #[ignore]
    async fn mongo_live_explain_returns_a_real_plan() {
        let Some(c) = client().await else { println!("no mongodb — skipping"); return };
        const DB: &str = "txui_mongo_test_explain";
        fixture(&c, DB, 100).await;
        let plan = super::explain_find(&c, DB, "items", Some(r#"{"parity": "even"}"#), false)
            .await.expect("explain");
        println!("  queryPlanner: {}…", &plan[..plan.len().min(160)]);
        assert!(plan.contains("queryPlanner"), "{plan}");
        let stats = super::explain_find(&c, DB, "items", Some(r#"{"parity": "even"}"#), true)
            .await.expect("explain executionStats");
        assert!(stats.contains("executionStats"), "{stats}");
        cleanup(&c, DB).await;
    }

    #[tokio::test]
    #[ignore]
    async fn mongo_live_current_op_lists_and_kill_op_is_safe_on_a_dead_id() {
        let Some(c) = client().await else { println!("no mongodb — skipping"); return };
        let r = super::current_ops(&c).await.expect("currentOp");
        let names: Vec<&str> = r.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["opid", "active", "op", "ns", "secs_running", "client", "app", "desc"]);
        println!("  currentOp: {} ops", r.rows.len());
        assert!(!r.rows.is_empty(), "our own connection should be visible");

        // Our own ops are identifiable — the kill path's self-protection.
        let own = super::own_opids(&c).await;
        println!("  own opids: {own:?}");
        assert!(!own.is_empty(), "appName TxUI must appear in $ownOps");

        // killOp on an opid that cannot exist: accepted by the server (killOp
        // is a request), no error — so the UI must word it as "sent".
        super::kill_op(&c, u64::MAX - 1).await.expect("killOp dead id");
        println!("  killOp on a dead id returned ok (request semantics)");
    }
}
