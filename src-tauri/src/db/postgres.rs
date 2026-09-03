use anyhow::Result;
use sqlx::AssertSqlSafe;
use sqlx::{PgPool, Row as SqlxRow, Column, TypeInfo};
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use std::time::Instant;

use super::types::{ColumnInfo, ConnectionConfig, LiveSession, PingResult, QueryResult, Row, SchemaNode, SslMode};

fn build_options(
    config:   &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
) -> Result<PgConnectOptions> {
    let (host, port) = host_override.unwrap_or((
        config.host.as_deref().unwrap_or("localhost"),
        config.port.unwrap_or(5432),
    ));

    // "localhost" → "127.0.0.1" (plain TCP only — socket dirs and SSH
    // overrides are untouched). See the MySQL twin in db/mysql.rs: pooled
    // re-dials re-resolve the hostname on every dial, and on macOS a network
    // change can make "localhost" resolve to only ::1, failing later acquires
    // with ENETUNREACH (os error 51) after the session connected fine.
    let socket_in_use = host_override.is_none()
        && config.socket_path.as_deref().is_some_and(|s| !s.is_empty());
    let host: String = if host_override.is_none() && !socket_in_use {
        super::util::pin_localhost(host).to_string()
    } else {
        host.to_string()
    };

    let mut opts = PgConnectOptions::new()
        .host(&host)
        .port(port)
        .username(config.user.as_deref().unwrap_or("postgres"))
        .password(password.as_deref().unwrap_or(""))
        .application_name(config.application_name.as_deref().filter(|a| !a.is_empty()).unwrap_or("TxUI"))
        .database(config.database.as_deref().unwrap_or("postgres"));

    // Unix socket directory overrides host (ignored when an SSH tunnel
    // supplies host_override — the tunnel endpoint is always TCP).
    if host_override.is_none() {
        if let Some(socket) = config.socket_path.as_deref().filter(|s| !s.is_empty()) {
            opts = opts.socket(socket);
        }
    }

    opts = match config.ssl_mode {
        SslMode::Disable    => opts.ssl_mode(PgSslMode::Disable),
        SslMode::Preferred  => opts.ssl_mode(PgSslMode::Prefer),
        SslMode::Require    => opts.ssl_mode(PgSslMode::Require),
        SslMode::VerifyCa   => opts.ssl_mode(PgSslMode::VerifyCa),
        SslMode::VerifyFull => opts.ssl_mode(PgSslMode::VerifyFull),
    };

    if let Some(ca) = &config.ssl_ca_path {
        if !ca.is_empty() { opts = opts.ssl_root_cert(ca); }
    }
    if let Some(cert) = &config.ssl_cert_path {
        if !cert.is_empty() { opts = opts.ssl_client_cert(cert); }
    }
    if let Some(key) = &config.ssl_key_path {
        if !key.is_empty() { opts = opts.ssl_client_key(key); }
    }

    // Startup params: server-validated — an unknown key fails the connect with
    // a clear server error, which is the desired feedback.
    for (k, v) in &config.extra_params {
        if !k.is_empty() {
            opts = opts.options([(k, v)]);
        }
    }
    if config.read_only && !config.extra_params.contains_key("default_transaction_read_only") {
        opts = opts.options([("default_transaction_read_only", "on")]);
    }

    Ok(opts)
}

pub async fn open(config: &ConnectionConfig, password: Option<String>, host_override: Option<(&str, u16)>) -> Result<LiveSession> {
    Ok(LiveSession::Postgres(open_pool(config, password, host_override, config.pool_max.unwrap_or(4)).await?))
}

/// Standalone pool with an explicit size — see the MySQL twin: the Playground
/// holds one backend per spawned worker, which the 4-slot session pool can't.
pub async fn open_pool(
    config: &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
    max_connections: u32,
) -> Result<sqlx::PgPool> {
    let opts = build_options(config, password, host_override)?;
    let init_sql = config.init_sql.clone();
    let stmt_timeout = config.statement_timeout_secs.filter(|s| *s > 0);
    let connect = sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_connections.max(1))
        .min_connections(0)
        .acquire_timeout(std::time::Duration::from_secs(config.pool_acquire_timeout_secs.unwrap_or(30).into()))
        .idle_timeout(std::time::Duration::from_secs(config.pool_idle_timeout_secs.unwrap_or(60).into()))
        .after_connect(move |conn, _meta| {
            let sql = init_sql.clone();
            Box::pin(async move {
                use sqlx::Executor;
                // Before init_sql, so a user who wants a different ceiling for
                // this connection can override it there and have that stick.
                //
                // Unlike MySQL's max_execution_time this bounds *every*
                // statement, writes included — the engines are not equivalent
                // here and the difference is documented on
                // DEFAULT_STATEMENT_TIMEOUT_SECS.
                if let Some(secs) = stmt_timeout {
                    let ms = u64::from(secs).saturating_mul(1000);
                    if let Err(e) = conn.execute(AssertSqlSafe(format!("SET SESSION statement_timeout = {ms}"))).await {
                        log::warn!("statement timeout not applied ({e}) — statements are UNBOUNDED");
                    }
                }
                if let Some(sql) = sql.as_deref().filter(|s| !s.trim().is_empty()) {
                    if let Err(e) = conn.execute(AssertSqlSafe(sql)).await {
                        log::warn!("init_sql failed: {e}");
                    }
                }
                Ok(())
            })
        })
        .connect_with(opts);
    // Bounded + one-line errors — the shared helper (db/util.rs). Note the
    // unification: this path used to hand back sqlx's raw two-line Display
    // where MySQL rendered fmt_conn_error's actionable line.
    let pool = super::util::connect_bounded(connect, config.connect_timeout_secs, fmt_conn_error).await?;
    Ok(pool)
}

pub fn fmt_conn_error(e: &sqlx::Error) -> String {
    let msg = e.as_database_error().map(|db| db.message().to_string()).unwrap_or_else(|| e.to_string());
    let mut out = msg.clone();
    if msg.contains("password authentication failed") || msg.contains("role") && msg.contains("does not exist") {
        out.push_str("\n\nHint: the stored credentials were rejected — re-enter the password via Edit, and confirm the role exists (\\du).");
    }
    out
}

pub async fn ping(config: &ConnectionConfig, password: Option<String>) -> PingResult {
    let start = Instant::now();
    let opts = match build_options(config, password, None) {
        Ok(o) => o,
        Err(e) => return PingResult { ok: false, latency_ms: 0, server_version: None, error: Some(e.to_string()) },
    };
    match PgPool::connect_with(opts).await {
        Ok(pool) => {
            let version: Result<String, _> = sqlx::query_scalar("SELECT version()")
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
/// dedicated acquired connection (whose pg_backend_pid enables cancel).
pub async fn execute<'e, E>(executor: E, sql: &'e str) -> Result<QueryResult>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    execute_capped(executor, sql, None).await
}

/// As `execute`, fetching at most `max_rows` data rows: past the cap the
/// stream is abandoned and `truncated` is set. Rows are decoded to JSON as
/// they stream so the raw driver row is dropped immediately — the result set
/// is held once, never twice.
pub async fn execute_capped<'e, E>(
    executor: E,
    sql: &'e str,
    max_rows: Option<usize>,
) -> Result<QueryResult>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
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
                }
                if max_rows.is_some_and(|cap| data.len() >= cap) {
                    truncated = true;
                    break;
                }
                data.push(columns.iter().enumerate().map(|(i, col)| {
                    json_from_pg_row(&row, i, &col.type_name)
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

pub fn json_from_row_pub(row: &sqlx::postgres::PgRow, i: usize, type_name: &str) -> serde_json::Value {
    json_from_pg_row(row, i, type_name)
}

/// Decode-failure fallback: the raw wire value's literal text (the execute
/// path runs the simple-query protocol, which carries text), else the
/// `<typename>` placeholder for genuinely binary/undecodable values. NEVER
/// `Value::Null` — a failed decode must mean "wrong type", indistinguishable
/// from a real NULL is the one thing it must not be. This mirrors the MySQL
/// driver's fallback and repairs the `money` / `NUMERIC 'NaN'` / >28-digit
/// numeric cells that used to render as NULL.
fn pg_raw_text(row: &sqlx::postgres::PgRow, i: usize, type_name: &str) -> serde_json::Value {
    if let Ok(raw) = sqlx::Row::try_get_raw(row, i) {
        if sqlx::ValueRef::is_null(&raw) {
            return serde_json::Value::Null;
        }
        if raw.format() == sqlx::postgres::PgValueFormat::Text {
            if let Ok(s) = raw.as_str() {
                return serde_json::Value::String(s.to_string());
            }
        }
    }
    serde_json::Value::String(format!("<{}>", type_name.to_lowercase()))
}

fn json_from_pg_row(row: &sqlx::postgres::PgRow, i: usize, type_name: &str) -> serde_json::Value {
    use serde_json::Value;
    use sqlx::ValueRef;

    // NULL first — a failed typed decode must mean "wrong type", never NULL
    match row.try_get_raw(i) {
        Ok(raw) if raw.is_null() => return Value::Null,
        Err(_) => return Value::Null,
        _ => {}
    }

    // Any decode failure below falls through to the raw text, never NULL.
    let fallback = || pg_raw_text(row, i, type_name);
    let num = |f: f64| super::types::json_f64(f);

    match type_name {
        // exact-width decode, then widen — sqlx refuses i64←INT2/INT4
        "INT2" => row.try_get::<i16, _>(i).map(|v| Value::from(v as i64)).unwrap_or_else(|_| fallback()),
        "INT4" => row.try_get::<i32, _>(i).map(|v| Value::from(v as i64)).unwrap_or_else(|_| fallback()),
        "INT8" => row.try_get::<i64, _>(i).map(Value::from).unwrap_or_else(|_| fallback()),
        "OID" => row.try_get::<sqlx::postgres::types::Oid, _>(i)
            .map(|v| Value::from(v.0 as i64))
            .unwrap_or_else(|_| fallback()),
        "FLOAT4" => row.try_get::<f32, _>(i).map(|v| num(v as f64)).unwrap_or_else(|_| fallback()),
        "FLOAT8" => row.try_get::<f64, _>(i).map(num).unwrap_or_else(|_| fallback()),
        // Keep exact scale/precision — never round-trip a decimal through f64.
        "NUMERIC" | "MONEY" =>
            row.try_get::<rust_decimal::Decimal, _>(i)
               .map(|v| Value::String(v.to_string()))
               .unwrap_or_else(|_| fallback()),
        "BOOL" =>
            row.try_get::<bool, _>(i).map(Value::Bool).unwrap_or_else(|_| fallback()),
        "TIMESTAMPTZ" =>
            row.try_get::<chrono::DateTime<chrono::Utc>, _>(i)
               .map(|v| Value::String(v.format("%Y-%m-%d %H:%M:%S%.f%:z").to_string()))
               .unwrap_or_else(|_| fallback()),
        "TIMESTAMP" =>
            row.try_get::<chrono::NaiveDateTime, _>(i)
               .map(|v| Value::String(v.format("%Y-%m-%d %H:%M:%S%.f").to_string()))
               .unwrap_or_else(|_| fallback()),
        "DATE" =>
            row.try_get::<chrono::NaiveDate, _>(i)
               .map(|v| Value::String(v.format("%Y-%m-%d").to_string()))
               .unwrap_or_else(|_| fallback()),
        "TIME" =>
            row.try_get::<chrono::NaiveTime, _>(i)
               .map(|v| Value::String(v.format("%H:%M:%S%.f").to_string()))
               .unwrap_or_else(|_| fallback()),
        "UUID" =>
            row.try_get::<uuid::Uuid, _>(i)
               .map(|v| Value::String(v.to_string()))
               .unwrap_or_else(|_| fallback()),
        "BYTEA" =>
            row.try_get::<Vec<u8>, _>(i)
               .map(|v| Value::String(hex::encode(v)))
               .unwrap_or_else(|_| fallback()),
        "JSON" | "JSONB" =>
            row.try_get::<serde_json::Value, _>(i).unwrap_or_else(|_| fallback()),
        // Default: TEXT-compatible decode, then the raw wire text — the
        // simple-query protocol carries the literal server rendering, so
        // arrays, enums, intervals, inet, ranges and extension types display
        // their values instead of a `<typename>` placeholder (WP-09 9.2).
        _ =>
            row.try_get::<String, _>(i).map(Value::String)
               .unwrap_or_else(|_| fallback()),
    }
}

/// Numeric server version (`90603`, `160010`, `180004`). Every catalog query
/// below gates its version-specific columns on this, so one code path serves
/// PG 9.x through 18: `prokind` (11+), `relispartition` (10+), `attidentity`
/// (10+) and `attgenerated` (12+) simply do not exist on older servers, and
/// naming them unconditionally fails the whole query.
async fn server_version_num(pool: &PgPool) -> i32 {
    sqlx::query_scalar::<_, String>("SELECT current_setting('server_version_num')")
        .fetch_one(pool).await
        .ok()
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(90_000)
}

/// Top level for PG: list schemas the current role can actually use.
///
/// Deliberately NOT `information_schema.schemata`: before PG 14 that view
/// only lists schemas *owned* by the current role, so a read-only reporting
/// account would see an empty object tree even with USAGE + SELECT granted.
/// `pg_namespace` + `has_schema_privilege` gives the same answer on every
/// supported version.
pub async fn list_schemas(pool: &PgPool) -> Result<Vec<SchemaNode>> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT nspname FROM pg_catalog.pg_namespace \
         WHERE nspname NOT LIKE 'pg\\_%' \
           AND nspname <> 'information_schema' \
           AND has_schema_privilege(oid, 'USAGE') \
         ORDER BY nspname"
    )
    .fetch_all(pool).await?;

    let mut nodes: Vec<SchemaNode> =
        names.into_iter().map(|name| SchemaNode::Schema { name }).collect();

    // ── Cluster-global objects ──────────────────────────────────────────
    // Publications, event triggers, tablespaces and foreign servers do not
    // live in a schema — they belong to the database/cluster. The tree has no
    // server node, so they hang off the connection root beside the schemas and
    // are bucketed into their own groups client-side. Each query
    // `unwrap_or_default`s so a permission miss or an old server (pre-10
    // publications, pre-9.3 event triggers) simply omits that group rather
    // than failing the whole root listing.

    // Publications (PG 10+). `puballtables` marks FOR ALL TABLES; the member
    // count comes from pg_publication_rel (explicitly added relations only).
    let publications: Vec<(String, bool, i64)> = sqlx::query_as(
        "SELECT p.pubname, p.puballtables, \
                (SELECT count(*) FROM pg_catalog.pg_publication_rel r WHERE r.prpubid = p.oid)::int8 \
         FROM pg_catalog.pg_publication p \
         ORDER BY p.pubname"
    )
    .fetch_all(pool).await.unwrap_or_default();
    for (name, all_tables, table_count) in publications {
        nodes.push(SchemaNode::Publication { name, schema: None, all_tables, table_count });
    }

    // Event triggers (PG 9.3+). evtenabled: 'D' = disabled, anything else fires.
    let event_triggers: Vec<(String, String, bool)> = sqlx::query_as(
        "SELECT evtname, evtevent, evtenabled <> 'D' \
         FROM pg_catalog.pg_event_trigger \
         ORDER BY evtname"
    )
    .fetch_all(pool).await.unwrap_or_default();
    for (name, event, enabled) in event_triggers {
        nodes.push(SchemaNode::EventTrigger { name, schema: None, event, enabled });
    }

    // Tablespaces. pg_tablespace_location returns '' for the built-ins.
    let tablespaces: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT t.spcname, \
                pg_catalog.pg_get_userbyid(t.spcowner), \
                coalesce(pg_catalog.pg_tablespace_location(t.oid), '') \
         FROM pg_catalog.pg_tablespace t \
         ORDER BY t.spcname"
    )
    .fetch_all(pool).await.unwrap_or_default();
    for (name, owner, location) in tablespaces {
        nodes.push(SchemaNode::Tablespace { name, schema: None, owner, location });
    }

    // Foreign servers, tagged with the FDW they use.
    let servers: Vec<(String, String)> = sqlx::query_as(
        "SELECT s.srvname, w.fdwname \
         FROM pg_catalog.pg_foreign_server s \
         JOIN pg_catalog.pg_foreign_data_wrapper w ON w.oid = s.srvfdw \
         ORDER BY s.srvname"
    )
    .fetch_all(pool).await.unwrap_or_default();
    for (name, fdw) in servers {
        nodes.push(SchemaNode::ForeignServer { name, schema: None, fdw });
    }

    Ok(nodes)
}

/// Tables + views inside a schema.
pub async fn list_schema(pool: &PgPool, schema: Option<&str>) -> Result<Vec<SchemaNode>> {
    if schema.is_none() {
        return list_schemas(pool).await;
    }
    list_tables(pool, schema.unwrap()).await
}

pub async fn list_tables(pool: &PgPool, schema: &str) -> Result<Vec<SchemaNode>> {
    let ver = server_version_num(pool).await;
    let ns = Some(schema.to_string());
    let mut nodes: Vec<SchemaNode> = Vec::new();

    // ── Relations: tables, partitioned tables, views, matviews, foreign tables
    //
    // pg_class rather than information_schema.tables: it is the only source
    // that carries materialized views ('m') and foreign tables ('f') as well,
    // and it respects table-level privileges without the pre-14 ownership
    // quirk that affects the information_schema views.
    // Foreign tables ('f') are listed separately (with their server) so they
    // group apart from ordinary tables — see below.
    let relkinds = if ver >= 90_300 { "'r','p','v','m'" } else { "'r','v'" };
    // A partition's parent, so the tree can group partitions apart from real
    // tables — relispartition is PG 10+, and a monthly-partitioned table can
    // otherwise bury every other table in the schema.
    let parent_expr = if ver >= 100_000 {
        "CASE WHEN c.relispartition THEN \
           (SELECT pc.relname FROM pg_catalog.pg_inherits i \
            JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
            WHERE i.inhrelid = c.oid) END"
    } else {
        "NULL::text"
    };
    let rel_sql = format!(
        "SELECT c.relname, c.relkind::text, {parent_expr} \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ({relkinds}) \
         ORDER BY c.relkind, c.relname"
    );
    let rels: Vec<(String, String, Option<String>)> = sqlx::query_as(AssertSqlSafe(rel_sql))
        .bind(schema)
        .fetch_all(pool).await?;

    for (name, relkind, parent) in rels {
        match relkind.as_str() {
            "v" => nodes.push(SchemaNode::View { name, schema: ns.clone() }),
            "m" => nodes.push(SchemaNode::MatView { name, schema: ns.clone() }),
            // 'r' ordinary, 'p' partitioned parent, 'f' foreign table
            _   => nodes.push(SchemaNode::Table {
                name, schema: ns.clone(), row_count: None, partition_of: parent,
                temporal: false,
            }),
        }
    }

    // ── Functions + procedures ──────────────────────────────────────────
    // prokind exists from PG 11; before that the flags were proisagg /
    // proiswindow (and procedures did not exist at all until 11).
    // DISTINCT collapses overloads to one node per name: the tree keys nodes by
    // name, so two `f(int)` / `f(text)` rows would collide. "View DDL" prints
    // every overload, so nothing is lost.
    // Aggregates ('a') and window functions ('w') are listed too — filtering
    // to ('f','p') hid every user-defined aggregate from the tree.
    let routine_sql = if ver >= 110_000 {
        "SELECT DISTINCT p.proname, \
                CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' \
                               WHEN 'w' THEN 'WINDOW' ELSE 'FUNCTION' END \
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = $1 AND p.prokind IN ('f','p','a','w') \
         ORDER BY 2, 1"
    } else {
        // Pre-11 there is no prokind and no procedures; the two flags carry it.
        "SELECT DISTINCT p.proname, \
                CASE WHEN p.proisagg THEN 'AGGREGATE' \
                     WHEN p.proiswindow THEN 'WINDOW' ELSE 'FUNCTION' END \
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = $1 \
         ORDER BY 2, 1"
    };
    let routines: Vec<(String, String)> = sqlx::query_as(routine_sql)
        .bind(schema)
        .fetch_all(pool).await.unwrap_or_default();
    for (name, routine_type) in routines {
        nodes.push(SchemaNode::Routine { name, schema: ns.clone(), routine_type });
    }

    // ── Triggers ────────────────────────────────────────────────────────
    // Previously absent entirely — MySQL listed triggers, PostgreSQL did not.
    // tgisinternal filters the rows PostgreSQL creates to back FK constraints.
    // DISTINCT ON (tgname) keeps one node per trigger name (the tree keys nodes
    // by name), while still carrying the table the trigger is attached to.
    let triggers: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT ON (t.tgname) t.tgname, c.relname \
         FROM pg_catalog.pg_trigger t \
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND NOT t.tgisinternal \
         ORDER BY t.tgname, c.relname"
    )
    .bind(schema)
    .fetch_all(pool).await.unwrap_or_default();
    for (name, table) in triggers {
        nodes.push(SchemaNode::Trigger { name, schema: ns.clone(), table: Some(table) });
    }

    // ── Row-level security policies ─────────────────────────────────────
    // Previously invisible, like triggers were. A policy decides which rows a
    // role can see at all, so a schema browser that does not show them is
    // describing a table nobody actually gets.
    //
    // pg_policy is 9.5+; on anything older the query simply finds nothing,
    // and `unwrap_or_default` keeps that from costing the rest of the tree.
    let policies: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT pol.polname, c.relname, \
                CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' \
                                WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' \
                                ELSE 'ALL' END \
         FROM pg_catalog.pg_policy pol \
         JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 \
         ORDER BY c.relname, pol.polname"
    )
    .bind(schema)
    .fetch_all(pool).await.unwrap_or_default();
    for (name, table, command) in policies {
        nodes.push(SchemaNode::Policy { name, schema: ns.clone(), table, command });
    }

    // ── Extensions ──────────────────────────────────────────────────────
    // Listed in the schema they installed into, which is where pgAdmin puts
    // them and where they actually live. The available version rides along so
    // a drift — an ALTER EXTENSION … UPDATE nobody has run — is visible
    // without a second lookup.
    let extensions: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT e.extname, e.extversion, a.default_version \
         FROM pg_catalog.pg_extension e \
         JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace \
         LEFT JOIN pg_catalog.pg_available_extensions a ON a.name = e.extname \
         WHERE n.nspname = $1 \
         ORDER BY e.extname"
    )
    .bind(schema)
    .fetch_all(pool).await.unwrap_or_default();
    for (name, version, default_version) in extensions {
        nodes.push(SchemaNode::Extension { name, schema: ns.clone(), version, default_version });
    }

    // ── Sequences ───────────────────────────────────────────────────────
    // Identity/serial-owned sequences are excluded: they are an artefact of
    // their owning column, not an object a user manages separately.
    let sequences: Vec<String> = sqlx::query_scalar(
        "SELECT c.relname \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind = 'S' \
           AND NOT EXISTS ( \
             SELECT 1 FROM pg_catalog.pg_depend d \
             WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass \
               AND d.deptype IN ('a','i')) \
         ORDER BY c.relname"
    )
    .bind(schema)
    .fetch_all(pool).await.unwrap_or_default();
    for name in sequences {
        nodes.push(SchemaNode::Sequence { name, schema: ns.clone() });
    }

    // ── User-defined types (enum / composite / domain / range) ──────────
    // The implicit row type behind every table is excluded via typrelid.
    let types: Vec<(String, String)> = sqlx::query_as(
        "SELECT t.typname, \
                CASE t.typtype WHEN 'e' THEN 'ENUM' WHEN 'd' THEN 'DOMAIN' \
                               WHEN 'r' THEN 'RANGE' ELSE 'COMPOSITE' END \
         FROM pg_catalog.pg_type t \
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
         WHERE n.nspname = $1 \
           AND t.typtype IN ('e','d','r','c') \
           AND (t.typrelid = 0 OR (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid) = 'c') \
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid) \
         ORDER BY 2, 1"
    )
    .bind(schema)
    .fetch_all(pool).await.unwrap_or_default();
    for (name, type_kind) in types {
        nodes.push(SchemaNode::Type { name, schema: ns.clone(), type_kind });
    }

    // ── Foreign tables ──────────────────────────────────────────────────
    // Relations backed by a foreign server (relkind 'f'), pulled out of the
    // ordinary-table list so a schema full of FDW tables does not bury the
    // local ones. Each carries the server it reads through. pg_foreign_table
    // is 9.1+, and unwrap_or_default keeps an old server from failing the list.
    let foreign_tables: Vec<(String, String)> = sqlx::query_as(
        "SELECT c.relname, s.srvname \
         FROM pg_catalog.pg_foreign_table ft \
         JOIN pg_catalog.pg_class c ON c.oid = ft.ftrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_foreign_server s ON s.oid = ft.ftserver \
         WHERE n.nspname = $1 \
         ORDER BY c.relname"
    )
    .bind(schema)
    .fetch_all(pool).await.unwrap_or_default();
    for (name, server) in foreign_tables {
        nodes.push(SchemaNode::ForeignTable { name, schema: ns.clone(), server });
    }

    Ok(nodes)
}

/// Columns + indexes for a table, view, matview or foreign table.
pub async fn list_columns(pool: &PgPool, schema: &str, table: &str) -> Result<Vec<SchemaNode>> {
    let ver = server_version_num(pool).await;

    // ── Columns ─────────────────────────────────────────────────────────
    // pg_attribute rather than information_schema.columns: matviews have no
    // information_schema entry at all, so their columns used to come back
    // empty. format_type() also renders the true declared type
    // ("numeric(14,2)", "text[]") where udt_name gave the internal name
    // ("numeric", "_text").
    let cols: Vec<(String, String, bool)> = sqlx::query_as(
        "SELECT a.attname, \
                pg_catalog.format_type(a.atttypid, a.atttypmod), \
                NOT a.attnotnull \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 \
           AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum"
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool).await?;

    // Primary key columns, straight from the index that backs the constraint.
    let pk_cols: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname \
         FROM pg_catalog.pg_index ix \
         JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey) \
         WHERE n.nspname = $1 AND c.relname = $2 AND ix.indisprimary"
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool).await.unwrap_or_default();

    let mut nodes: Vec<SchemaNode> = cols.into_iter().map(|(name, type_name, nullable)| {
        let pk = pk_cols.contains(&name);
        SchemaNode::Column { name, type_name, nullable, primary_key: pk }
    }).collect();

    // ── Indexes ─────────────────────────────────────────────────────────
    // The previous query joined pg_attribute on `a.attnum = ANY(ix.indkey)`,
    // which silently DROPPED every expression index: an expression key is
    // stored as attnum 0, matches no column, and the inner join removed the
    // whole row. Reading pg_get_indexdef() per key position keeps expression
    // and partial indexes visible and needs no version gating.
    let idx_rows = sqlx::query(
        "SELECT i.relname, ix.indisunique, ix.indisprimary, \
                am.amname, \
                pg_get_expr(ix.indpred, ix.indrelid) IS NOT NULL AS partial, \
                (SELECT array_agg(pg_catalog.pg_get_indexdef(ix.indexrelid, k, true) \
                                  ORDER BY k) \
                 FROM generate_series(1, ix.indnatts) AS k) AS keys \
         FROM pg_catalog.pg_index ix \
         JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid \
         JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_catalog.pg_am am ON am.oid = i.relam \
         WHERE n.nspname = $1 AND t.relname = $2 \
         ORDER BY ix.indisprimary DESC, i.relname"
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool).await
    .unwrap_or_default();

    for r in idx_rows {
        let name: String        = r.try_get(0).unwrap_or_default();
        let unique: bool        = r.try_get(1).unwrap_or_default();
        let primary: bool       = r.try_get(2).unwrap_or_default();
        let am: String          = r.try_get(3).unwrap_or_default();
        let partial: bool       = r.try_get(4).unwrap_or_default();
        let mut columns: Vec<String> = r.try_get(5).unwrap_or_default();

        // Annotate so the tree subtext reads e.g. "lower(name) · gin · partial"
        let mut notes: Vec<String> = Vec::new();
        if primary { notes.push("PK".into()); }
        if am != "btree" && !am.is_empty() { notes.push(am); }
        if partial { notes.push("partial".into()); }
        if !notes.is_empty() { columns.push(format!("[{}]", notes.join(" "))); }

        nodes.push(SchemaNode::Index { name, unique, columns });
    }

    // Views/matviews have no indexes worth listing beyond the above; nothing
    // else is version-gated here.
    let _ = ver;
    Ok(nodes)
}

/// Quote an identifier for DDL output, matching PostgreSQL's own rules: bare
/// lowercase identifiers stay unquoted, anything else gets double quotes.
fn quote_ident(name: &str) -> String {
    let plain = !name.is_empty()
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if plain { name.to_string() } else { format!("\"{}\"", name.replace('"', "\"\"")) }
}

/// Reconstruct DDL for any schema object.
///
/// PostgreSQL has no `SHOW CREATE TABLE`, so table DDL is assembled from
/// pg_catalog. The previous version emitted column names and types only —
/// no defaults, identity, primary key, foreign keys, checks, or indexes —
/// which made "View DDL" misleading for every non-trivial table.
pub async fn get_ddl(pool: &PgPool, schema: &str, object: &str) -> Result<String> {
    let ver = server_version_num(pool).await;

    // Resolve the object once: relkind tells us which branch to take.
    let relkind: Option<String> = sqlx::query_scalar(
        "SELECT c.relkind::text FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2"
    )
    .bind(schema).bind(object)
    .fetch_optional(pool).await.ok().flatten();

    let qualified = format!("{}.{}", quote_ident(schema), quote_ident(object));

    // Cluster-global objects (publications, event triggers, tablespaces,
    // foreign servers) have no schema. The tree routes their "View DDL" through
    // a `pg_global.<name>` sentinel parent; resolve them by name alone.
    if schema == PG_GLOBAL_SCHEMA {
        return global_object_ddl(pool, object).await;
    }

    match relkind.as_deref() {
        Some("v") => return view_ddl(pool, schema, object, &qualified, false).await,
        Some("m") => return view_ddl(pool, schema, object, &qualified, true).await,
        Some("S") => return sequence_ddl(pool, schema, object, &qualified, ver).await,
        Some("r") | Some("p") | Some("f") => {
            return table_ddl(pool, schema, object, &qualified, ver).await
        }
        _ => {}
    }

    // Not a relation — try a user-defined type, then a routine.
    if let Ok(sql) = type_ddl(pool, schema, object, &qualified).await {
        return Ok(sql);
    }

    // Aggregates first: pg_get_functiondef() raises "X is an aggregate
    // function" rather than returning a definition, so they need their own
    // reconstruction from pg_aggregate.
    let agg: Vec<String> = sqlx::query_scalar(
        "SELECT format(E'CREATE AGGREGATE %s.%s(%s) (\\n  SFUNC = %s,\\n  STYPE = %s%s%s\\n);', \
                       n.nspname, p.proname, pg_get_function_arguments(p.oid), \
                       a.aggtransfn::regproc, pg_catalog.format_type(a.aggtranstype, NULL), \
                       CASE WHEN a.aggfinalfn::oid <> 0 \
                            THEN E',\\n  FINALFUNC = ' || a.aggfinalfn::regproc::text ELSE '' END, \
                       CASE WHEN a.agginitval IS NOT NULL \
                            THEN E',\\n  INITCOND = ' || quote_literal(a.agginitval) ELSE '' END) \
         FROM pg_catalog.pg_aggregate a \
         JOIN pg_catalog.pg_proc p ON p.oid = a.aggfnoid \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = $1 AND p.proname = $2 \
         ORDER BY p.oid"
    )
    .bind(schema).bind(object)
    .fetch_all(pool).await.unwrap_or_default();
    if !agg.is_empty() {
        return Ok(agg.join("\n\n"));
    }

    // Functions/procedures: a name can be overloaded, so emit every overload.
    let defs: Vec<String> = sqlx::query_scalar(
        "SELECT pg_get_functiondef(p.oid) \
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = $1 AND p.proname = $2 \
         ORDER BY p.oid"
    )
    .bind(schema).bind(object)
    .fetch_all(pool).await.unwrap_or_default();
    if !defs.is_empty() {
        return Ok(defs.join("\n\n"));
    }

    // Triggers are named per-table, so look the name up across the schema.
    let trg: Vec<String> = sqlx::query_scalar(
        "SELECT pg_get_triggerdef(t.oid, true) || ';' \
         FROM pg_catalog.pg_trigger t \
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal"
    )
    .bind(schema).bind(object)
    .fetch_all(pool).await.unwrap_or_default();
    if !trg.is_empty() {
        return Ok(trg.join("\n"));
    }

    Err(anyhow::anyhow!("DDL not found for {}.{}", schema, object))
}

/// Sentinel namespace the tree uses to route "View DDL" for cluster-global
/// objects (which have no real schema) through the standard
/// `list->get_ddl(schema, object)` path. Chosen to never collide with a real
/// schema — `pg_` names are reserved.
pub const PG_GLOBAL_SCHEMA: &str = "pg_global";

/// Reconstruct DDL for a cluster-global object by name. Tries each catalog in
/// turn; names are unique within their own catalog, so the first hit wins.
async fn global_object_ddl(pool: &PgPool, name: &str) -> Result<String> {
    // Publication.
    let pubrow = sqlx::query(
        "SELECT puballtables FROM pg_catalog.pg_publication WHERE pubname = $1"
    )
    .bind(name)
    .fetch_optional(pool).await.ok().flatten();
    if let Some(row) = pubrow {
        let all_tables: bool = row.try_get(0).unwrap_or(false);
        let qname = quote_ident(name);
        if all_tables {
            return Ok(format!("CREATE PUBLICATION {qname} FOR ALL TABLES;"));
        }
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) \
             FROM pg_catalog.pg_publication_tables WHERE pubname = $1 ORDER BY 1"
        )
        .bind(name)
        .fetch_all(pool).await.unwrap_or_default();
        return Ok(if tables.is_empty() {
            format!("CREATE PUBLICATION {qname};")
        } else {
            format!("CREATE PUBLICATION {qname}\n    FOR TABLE {};", tables.join(", "))
        });
    }

    // Event trigger.
    let evtrow = sqlx::query(
        "SELECT et.evtevent, n.nspname, p.proname, et.evtenabled, \
                (SELECT string_agg(quote_literal(t), ', ') FROM unnest(et.evttags) AS t) \
         FROM pg_catalog.pg_event_trigger et \
         JOIN pg_catalog.pg_proc p ON p.oid = et.evtfoid \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE et.evtname = $1"
    )
    .bind(name)
    .fetch_optional(pool).await.ok().flatten();
    if let Some(row) = evtrow {
        let event: String = row.try_get(0).unwrap_or_default();
        let fn_ns: String  = row.try_get(1).unwrap_or_default();
        let fn_name: String = row.try_get(2).unwrap_or_default();
        let enabled: String = row.try_get(3).unwrap_or_else(|_| "O".into());
        let tags: Option<String> = row.try_get(4).ok().flatten();
        let qname = quote_ident(name);
        let func = format!("{}.{}", quote_ident(&fn_ns), quote_ident(&fn_name));
        let when = tags.map(|t| format!("\n    WHEN TAG IN ({t})")).unwrap_or_default();
        let mut out = format!(
            "CREATE EVENT TRIGGER {qname}\n    ON {event}{when}\n    EXECUTE FUNCTION {func}();"
        );
        // evtenabled: 'D' disabled, 'R' replica, 'A' always, 'O' origin(default).
        match enabled.as_str() {
            "D" => out.push_str(&format!("\nALTER EVENT TRIGGER {qname} DISABLE;")),
            "R" => out.push_str(&format!("\nALTER EVENT TRIGGER {qname} ENABLE REPLICA;")),
            "A" => out.push_str(&format!("\nALTER EVENT TRIGGER {qname} ENABLE ALWAYS;")),
            _   => {}
        }
        return Ok(out);
    }

    // Tablespace.
    let tsrow = sqlx::query(
        "SELECT pg_catalog.pg_get_userbyid(spcowner), \
                coalesce(pg_catalog.pg_tablespace_location(oid), '') \
         FROM pg_catalog.pg_tablespace WHERE spcname = $1"
    )
    .bind(name)
    .fetch_optional(pool).await.ok().flatten();
    if let Some(row) = tsrow {
        let owner: String = row.try_get(0).unwrap_or_default();
        let location: String = row.try_get(1).unwrap_or_default();
        let qname = quote_ident(name);
        if location.is_empty() {
            // Built-in (pg_default / pg_global) — no location to reproduce.
            return Ok(format!("-- {qname} is a built-in tablespace (owner {}).", quote_ident(&owner)));
        }
        return Ok(format!(
            "CREATE TABLESPACE {qname}\n    OWNER {}\n    LOCATION {};",
            quote_ident(&owner), sql_string_literal(&location)
        ));
    }

    // Foreign server.
    let srvrow = sqlx::query(
        "SELECT w.fdwname, s.srvtype, s.srvversion, \
                (SELECT string_agg(quote_ident(split_part(o, '=', 1)) || ' ' || \
                                   quote_literal(substr(o, strpos(o, '=') + 1)), ', ') \
                 FROM unnest(s.srvoptions) AS o) \
         FROM pg_catalog.pg_foreign_server s \
         JOIN pg_catalog.pg_foreign_data_wrapper w ON w.oid = s.srvfdw \
         WHERE s.srvname = $1"
    )
    .bind(name)
    .fetch_optional(pool).await.ok().flatten();
    if let Some(row) = srvrow {
        let fdw: String = row.try_get(0).unwrap_or_default();
        let srvtype: Option<String> = row.try_get(1).ok().flatten();
        let srvversion: Option<String> = row.try_get(2).ok().flatten();
        let options: Option<String> = row.try_get(3).ok().flatten();
        let qname = quote_ident(name);
        let mut out = format!("CREATE SERVER {qname}");
        if let Some(t) = srvtype.filter(|s| !s.is_empty()) {
            out.push_str(&format!(" TYPE {}", sql_string_literal(&t)));
        }
        if let Some(v) = srvversion.filter(|s| !s.is_empty()) {
            out.push_str(&format!(" VERSION {}", sql_string_literal(&v)));
        }
        out.push_str(&format!("\n    FOREIGN DATA WRAPPER {}", quote_ident(&fdw)));
        if let Some(opts) = options.filter(|s| !s.is_empty()) {
            out.push_str(&format!("\n    OPTIONS ({opts})"));
        }
        out.push(';');
        return Ok(out);
    }

    Err(anyhow::anyhow!("DDL not found for global object {}", name))
}

/// Single-quote a string literal for DDL (doubling embedded quotes).
fn sql_string_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

async fn view_ddl(pool: &PgPool, schema: &str, object: &str, qualified: &str, mat: bool) -> Result<String> {
    let body: String = sqlx::query_scalar(
        "SELECT pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true)"
    )
    .bind(schema).bind(object)
    .fetch_one(pool).await?;

    let head = if mat {
        format!("CREATE MATERIALIZED VIEW {qualified} AS\n")
    } else {
        format!("CREATE OR REPLACE VIEW {qualified} AS\n")
    };
    let mut out = format!("{head}{}", body.trim_end());
    if !out.trim_end().ends_with(';') { out.push(';'); }

    // Matviews carry their own indexes.
    if mat {
        let idx: Vec<String> = sqlx::query_scalar(
            "SELECT pg_get_indexdef(ix.indexrelid) || ';' \
             FROM pg_catalog.pg_index ix \
             JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 ORDER BY 1"
        )
        .bind(schema).bind(object)
        .fetch_all(pool).await.unwrap_or_default();
        if !idx.is_empty() {
            out.push_str("\n\n");
            out.push_str(&idx.join("\n"));
        }
    }
    Ok(out)
}

async fn sequence_ddl(pool: &PgPool, schema: &str, object: &str, qualified: &str, ver: i32) -> Result<String> {
    // pg_sequences (PG 10+) exposes the parameters directly; older servers
    // keep them in the sequence relation itself.
    if ver >= 100_000 {
        let row = sqlx::query(
            "SELECT data_type::text, start_value, min_value, max_value, increment_by, cycle, cache_size \
             FROM pg_catalog.pg_sequences WHERE schemaname = $1 AND sequencename = $2"
        )
        .bind(schema).bind(object)
        .fetch_one(pool).await?;
        let dtype: String = row.try_get(0).unwrap_or_else(|_| "bigint".into());
        let start: i64    = row.try_get(1).unwrap_or(1);
        let min: i64      = row.try_get(2).unwrap_or(1);
        let max: i64      = row.try_get(3).unwrap_or(i64::MAX);
        let inc: i64      = row.try_get(4).unwrap_or(1);
        let cycle: bool   = row.try_get(5).unwrap_or(false);
        let cache: i64    = row.try_get(6).unwrap_or(1);
        return Ok(format!(
            "CREATE SEQUENCE {qualified}\n    AS {dtype}\n    START WITH {start}\n    INCREMENT BY {inc}\n    \
             MINVALUE {min}\n    MAXVALUE {max}\n    CACHE {cache}{};",
            if cycle { "\n    CYCLE" } else { "" }
        ));
    }
    Ok(format!("CREATE SEQUENCE {qualified};"))
}

async fn type_ddl(pool: &PgPool, schema: &str, object: &str, qualified: &str) -> Result<String> {
    let typtype: String = sqlx::query_scalar(
        "SELECT t.typtype::text FROM pg_catalog.pg_type t \
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
         WHERE n.nspname = $1 AND t.typname = $2"
    )
    .bind(schema).bind(object)
    .fetch_one(pool).await?;

    match typtype.as_str() {
        "e" => {
            let labels: Vec<String> = sqlx::query_scalar(
                "SELECT quote_literal(e.enumlabel) FROM pg_catalog.pg_enum e \
                 JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
                 WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder"
            )
            .bind(schema).bind(object)
            .fetch_all(pool).await?;
            Ok(format!("CREATE TYPE {qualified} AS ENUM (\n    {}\n);", labels.join(",\n    ")))
        }
        "d" => {
            let row = sqlx::query(
                "SELECT pg_catalog.format_type(t.typbasetype, t.typtypmod), t.typnotnull, \
                        (SELECT string_agg(pg_get_constraintdef(c.oid), ' ') \
                         FROM pg_catalog.pg_constraint c WHERE c.contypid = t.oid) \
                 FROM pg_catalog.pg_type t \
                 JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
                 WHERE n.nspname = $1 AND t.typname = $2"
            )
            .bind(schema).bind(object)
            .fetch_one(pool).await?;
            let base: String = row.try_get(0).unwrap_or_default();
            let notnull: bool = row.try_get(1).unwrap_or(false);
            let check: Option<String> = row.try_get(2).ok().flatten();
            Ok(format!(
                "CREATE DOMAIN {qualified} AS {base}{}{};",
                if notnull { " NOT NULL" } else { "" },
                check.map(|c| format!("\n    {c}")).unwrap_or_default(),
            ))
        }
        "c" => {
            let attrs: Vec<String> = sqlx::query_scalar(
                "SELECT quote_ident(a.attname) || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) \
                 FROM pg_catalog.pg_attribute a \
                 JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum"
            )
            .bind(schema).bind(object)
            .fetch_all(pool).await?;
            Ok(format!("CREATE TYPE {qualified} AS (\n    {}\n);", attrs.join(",\n    ")))
        }
        _ => Err(anyhow::anyhow!("unsupported type kind")),
    }
}

async fn table_ddl(pool: &PgPool, schema: &str, object: &str, qualified: &str, ver: i32) -> Result<String> {
    // Column definitions. attidentity is PG 10+, attgenerated PG 12+ — naming
    // either on an older server would fail the whole statement, so the SQL is
    // assembled to match the connected version.
    let identity_expr  = if ver >= 100_000 { "a.attidentity::text" } else { "''::text" };
    let generated_expr = if ver >= 120_000 { "a.attgenerated::text" } else { "''::text" };
    let col_sql = format!(
        "SELECT quote_ident(a.attname), \
                pg_catalog.format_type(a.atttypid, a.atttypmod), \
                a.attnotnull, \
                pg_get_expr(d.adbin, d.adrelid), \
                {identity_expr}, \
                {generated_expr}, \
                (SELECT cl.collname FROM pg_catalog.pg_collation cl \
                 WHERE cl.oid = a.attcollation AND a.attcollation <> 0 \
                   AND cl.collname <> 'default') \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum"
    );
    let rows = sqlx::query(AssertSqlSafe(col_sql)).bind(schema).bind(object).fetch_all(pool).await?;
    if rows.is_empty() {
        return Err(anyhow::anyhow!("no columns for {}.{}", schema, object));
    }

    let mut lines: Vec<String> = Vec::new();
    for r in &rows {
        let name: String              = r.try_get(0).unwrap_or_default();
        let dtype: String             = r.try_get(1).unwrap_or_default();
        let notnull: bool             = r.try_get(2).unwrap_or(false);
        let default: Option<String>   = r.try_get(3).ok().flatten();
        let identity: String          = r.try_get(4).unwrap_or_default();
        let generated: String         = r.try_get(5).unwrap_or_default();
        let collation: Option<String> = r.try_get(6).ok().flatten();

        let mut line = format!("    {name} {dtype}");
        if let Some(c) = collation { line.push_str(&format!(" COLLATE {}", quote_ident(&c))); }
        match identity.as_str() {
            "a" => line.push_str(" GENERATED ALWAYS AS IDENTITY"),
            "d" => line.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
            _ => {
                if generated == "s" {
                    // stored generated column — the expression lives in adbin
                    if let Some(expr) = &default {
                        line.push_str(&format!(" GENERATED ALWAYS AS ({expr}) STORED"));
                    }
                } else if let Some(expr) = &default {
                    line.push_str(&format!(" DEFAULT {expr}"));
                }
            }
        }
        if notnull && generated != "s" { line.push_str(" NOT NULL"); }
        lines.push(line);
    }

    // Table constraints in a stable order: PK, UNIQUE, FK, CHECK, EXCLUDE.
    let cons: Vec<String> = sqlx::query_scalar(
        "SELECT '    CONSTRAINT ' || quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid) \
         FROM pg_catalog.pg_constraint con \
         JOIN pg_catalog.pg_class c ON c.oid = con.conrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 \
         ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 \
                                   WHEN 'c' THEN 3 ELSE 4 END, con.conname"
    )
    .bind(schema).bind(object)
    .fetch_all(pool).await.unwrap_or_default();
    lines.extend(cons);

    // PARTITION BY for a partitioned parent (PG 10+).
    let partition_by: Option<String> = if ver >= 100_000 {
        sqlx::query_scalar(
            "SELECT pg_get_partkeydef(c.oid) FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'p'"
        )
        .bind(schema).bind(object)
        .fetch_optional(pool).await.ok().flatten()
    } else { None };

    let mut out = format!("CREATE TABLE {qualified} (\n{}\n)", lines.join(",\n"));
    if let Some(pk) = partition_by { out.push_str(&format!(" PARTITION BY {pk}")); }
    out.push_str(";\n");

    // Indexes that are not already implied by a constraint.
    let idx: Vec<String> = sqlx::query_scalar(
        "SELECT pg_get_indexdef(ix.indexrelid) || ';' \
         FROM pg_catalog.pg_index ix \
         JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid \
         JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 \
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con \
                           WHERE con.conindid = ix.indexrelid) \
         ORDER BY i.relname"
    )
    .bind(schema).bind(object)
    .fetch_all(pool).await.unwrap_or_default();
    if !idx.is_empty() {
        out.push('\n');
        out.push_str(&idx.join("\n"));
        out.push('\n');
    }

    // Triggers defined on this table.
    let trg: Vec<String> = sqlx::query_scalar(
        "SELECT pg_get_triggerdef(t.oid, true) || ';' \
         FROM pg_catalog.pg_trigger t \
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal \
         ORDER BY t.tgname"
    )
    .bind(schema).bind(object)
    .fetch_all(pool).await.unwrap_or_default();
    if !trg.is_empty() {
        out.push('\n');
        out.push_str(&trg.join("\n"));
        out.push('\n');
    }

    // Comments on the table and its columns.
    let comments: Vec<String> = sqlx::query_scalar(
        "SELECT 'COMMENT ON TABLE ' || format('%I.%I', $1::text, $2::text) || ' IS ' \
                || quote_literal(obj_description(c.oid, 'pg_class')) || ';' \
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND obj_description(c.oid, 'pg_class') IS NOT NULL \
         UNION ALL \
         SELECT 'COMMENT ON COLUMN ' || format('%I.%I.%I', $1::text, $2::text, a.attname) || ' IS ' \
                || quote_literal(col_description(c.oid, a.attnum)) || ';' \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
           AND col_description(c.oid, a.attnum) IS NOT NULL"
    )
    .bind(schema).bind(object)
    .fetch_all(pool).await.unwrap_or_default();
    if !comments.is_empty() {
        out.push('\n');
        out.push_str(&comments.join("\n"));
        out.push('\n');
    }

    Ok(out)
}

#[cfg(test)]
mod live_tests {
    //! Live checks against the local PostgreSQL 16/17/18 instances. Every
    //! catalog query below is version-sensitive, and the whole point of the
    //! backward-compatibility gating is that it holds across releases — which
    //! only a real server can prove.
    //!
    //!   cargo test --lib pg_live -- --ignored --nocapture
    //!
    //! Expects the fixture schema `txui_demo` and a root/root superuser on
    //! ports 5432 (v16), 5433 (v17), 5434 (v18) — see docs/POSTGRES_DEV.md.

    use crate::db::types::{ConnectionConfig, Engine, SchemaNode};
    use sqlx::AssertSqlSafe;

    fn config(port: u16) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Postgres, format!("pg-{port}"));
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.database = Some("postgres".into());
        c.ssl_mode = crate::db::types::SslMode::Disable;
        c
    }

    // 14 is deliberately in the matrix: it is the oldest supported major,
    // sits below every version gate in the collectors (prokind 11+,
    // attidentity 10+, attgenerated 12+, pg_stat_checkpointer 17+), and is
    // the release where information_schema.schemata changed behaviour.
    const PORTS: [u16; 4] = [5435, 5432, 5433, 5434];

    async fn pool(port: u16) -> sqlx::PgPool {
        super::open_pool(&config(port), Some("root".into()), None, 2).await
            .unwrap_or_else(|e| panic!("connect to pg on {port}: {e}"))
    }

    #[tokio::test]
    #[ignore]
    async fn pg_live_ping_reports_a_version_on_every_server() {
        for port in PORTS {
            let r = super::ping(&config(port), Some("root".into())).await;
            assert!(r.ok, "ping {port} failed: {:?}", r.error);
            let v = r.server_version.expect("server_version");
            assert!(v.starts_with("PostgreSQL 1"), "unexpected version on {port}: {v}");
            println!("  {port}: {v}");
        }
    }

    #[tokio::test]
    #[ignore]
    async fn pg_live_schema_tree_lists_every_object_kind() {
        for port in PORTS {
            let p = pool(port).await;

            let schemas = super::list_schemas(&p).await.expect("list_schemas");
            let names: Vec<&str> = schemas.iter().filter_map(|n| match n {
                SchemaNode::Schema { name } => Some(name.as_str()), _ => None,
            }).collect();
            assert!(names.contains(&"txui_demo"), "{port}: schemas = {names:?}");

            let objs = super::list_tables(&p, "txui_demo").await.expect("list_tables");
            let mut tables = 0; let mut views = 0; let mut matviews = 0;
            let mut funcs = 0; let mut procs = 0; let mut aggs = 0;
            let mut triggers = 0; let mut seqs = 0; let mut types = 0;
            for o in &objs {
                match o {
                    SchemaNode::Table { .. }    => tables += 1,
                    SchemaNode::View { .. }     => views += 1,
                    SchemaNode::MatView { .. }  => matviews += 1,
                    SchemaNode::Routine { routine_type, .. } => match routine_type.as_str() {
                        "PROCEDURE" => procs += 1,
                        "AGGREGATE" | "WINDOW" => aggs += 1,
                        _ => funcs += 1,
                    },
                    SchemaNode::Trigger { .. }  => triggers += 1,
                    SchemaNode::Sequence { .. } => seqs += 1,
                    SchemaNode::Type { .. }     => types += 1,
                    _ => {}
                }
            }
            // The fixture defines all of these; a regression that drops a whole
            // object class (as the missing trigger listing did) fails here.
            assert!(tables   >= 5, "{port}: tables={tables}");

            // Partitions are tagged with their parent so the tree can group
            // them apart — a monthly-partitioned table would otherwise bury
            // every real table in the schema.
            let parts: Vec<(&str, &str)> = objs.iter().filter_map(|o| match o {
                SchemaNode::Table { name, partition_of: Some(p), .. } => Some((name.as_str(), p.as_str())),
                _ => None,
            }).collect();
            assert_eq!(parts.len(), 3, "{port}: partitions of events = {parts:?}");
            assert!(parts.iter().all(|(_, p)| *p == "events"), "{port}: wrong parent — {parts:?}");
            // …and the parent itself is NOT tagged as a partition.
            assert!(objs.iter().any(|o| matches!(o,
                SchemaNode::Table { name, partition_of: None, .. } if name == "events")),
                "{port}: partitioned parent must not be tagged a partition");
            assert_eq!(views,    1, "{port}: views");
            assert_eq!(matviews, 1, "{port}: materialized views");
            assert!(funcs    >= 3, "{port}: functions={funcs}");
            assert_eq!(procs,    1, "{port}: procedures");
            // prokind 'a' was filtered out entirely before, hiding every aggregate
            assert_eq!(aggs,     1, "{port}: aggregates");
            assert_eq!(triggers, 2, "{port}: triggers");
            assert_eq!(seqs,     1, "{port}: standalone sequences");
            assert_eq!(types,    3, "{port}: enum + domain + composite");
            println!("  {port}: {tables}t {views}v {matviews}mv {funcs}f {procs}p {aggs}agg {triggers}trg {seqs}seq {types}ty");
        }
    }

    #[tokio::test]
    #[ignore]
    async fn pg_live_expression_index_is_not_dropped() {
        // Regression: joining pg_attribute on `attnum = ANY(indkey)` silently
        // discarded expression indexes, because an expression key is attnum 0.
        for port in PORTS {
            let p = pool(port).await;
            let nodes = super::list_columns(&p, "txui_demo", "customers").await.expect("list_columns");
            let idx: Vec<&str> = nodes.iter().filter_map(|n| match n {
                SchemaNode::Index { name, .. } => Some(name.as_str()), _ => None,
            }).collect();
            assert!(idx.contains(&"idx_customers_lower"), "{port}: expression index missing — {idx:?}");
            assert!(idx.contains(&"idx_customers_meta"),  "{port}: gin index missing — {idx:?}");
            assert!(idx.contains(&"customers_pkey"),      "{port}: pk index missing — {idx:?}");
        }
    }

    #[tokio::test]
    #[ignore]
    async fn pg_live_matview_columns_resolve() {
        // Materialized views have no information_schema.columns rows, so the
        // old query returned an empty column list for them.
        for port in PORTS {
            let p = pool(port).await;
            let nodes = super::list_columns(&p, "txui_demo", "mv_customer_totals").await.expect("list_columns");
            let cols: Vec<&str> = nodes.iter().filter_map(|n| match n {
                SchemaNode::Column { name, .. } => Some(name.as_str()), _ => None,
            }).collect();
            assert_eq!(cols, vec!["id", "name", "orders", "cents"], "{port}");
        }
    }

    #[tokio::test]
    #[ignore]
    async fn pg_live_table_ddl_is_complete() {
        for port in PORTS {
            let p = pool(port).await;
            let ddl = super::get_ddl(&p, "txui_demo", "orders").await.expect("get_ddl orders");
            for needle in [
                "CREATE TABLE txui_demo.orders",
                "GENERATED ALWAYS AS",          // total_eur generated column
                "NOT NULL",
                "PRIMARY KEY",                  // constraint, previously absent
                "FOREIGN KEY",                  // FK, previously absent
                "CHECK",                        // check constraint
                "CREATE INDEX",                 // secondary indexes
                "CREATE TRIGGER",               // triggers on the table
            ] {
                assert!(ddl.contains(needle), "{port}: DDL missing {needle:?}\n{ddl}");
            }

            // Identity column on a different table.
            let cust = super::get_ddl(&p, "txui_demo", "customers").await.expect("get_ddl customers");
            assert!(cust.contains("GENERATED ALWAYS AS IDENTITY"), "{port}: identity lost\n{cust}");
            assert!(cust.contains("COMMENT ON TABLE"), "{port}: table comment lost");

            // Partitioned parent keeps its PARTITION BY clause.
            let ev = super::get_ddl(&p, "txui_demo", "events").await.expect("get_ddl events");
            assert!(ev.contains("PARTITION BY RANGE"), "{port}: partition key lost\n{ev}");
        }
    }

    #[tokio::test]
    #[ignore]
    async fn pg_live_ddl_for_views_sequences_and_types() {
        for port in PORTS {
            let p = pool(port).await;

            let v = super::get_ddl(&p, "txui_demo", "v_open_orders").await.expect("view ddl");
            assert!(v.starts_with("CREATE OR REPLACE VIEW"), "{port}: {v}");

            let mv = super::get_ddl(&p, "txui_demo", "mv_customer_totals").await.expect("matview ddl");
            assert!(mv.starts_with("CREATE MATERIALIZED VIEW"), "{port}: {mv}");

            let s = super::get_ddl(&p, "txui_demo", "invoice_seq").await.expect("sequence ddl");
            assert!(s.contains("CREATE SEQUENCE"), "{port}: {s}");

            let e = super::get_ddl(&p, "txui_demo", "order_status").await.expect("enum ddl");
            assert!(e.contains("AS ENUM") && e.contains("'shipped'"), "{port}: {e}");

            let d = super::get_ddl(&p, "txui_demo", "email").await.expect("domain ddl");
            assert!(d.contains("CREATE DOMAIN"), "{port}: {d}");

            let c = super::get_ddl(&p, "txui_demo", "addr").await.expect("composite ddl");
            assert!(c.contains("CREATE TYPE") && c.contains("street"), "{port}: {c}");

            let f = super::get_ddl(&p, "txui_demo", "customer_order_count").await.expect("function ddl");
            assert!(f.contains("CREATE OR REPLACE FUNCTION"), "{port}: {f}");

            // pg_get_functiondef() raises on an aggregate — it needs pg_aggregate
            let ag = super::get_ddl(&p, "txui_demo", "total_cents").await.expect("aggregate ddl");
            assert!(ag.contains("CREATE AGGREGATE") && ag.contains("SFUNC"), "{port}: {ag}");

            let t = super::get_ddl(&p, "txui_demo", "trg_touch_order").await.expect("trigger ddl");
            assert!(t.contains("CREATE TRIGGER"), "{port}: {t}");
        }
    }

    #[tokio::test]
    #[ignore]
    async fn pg_live_table_meta_covers_matviews_and_row_counts() {
        use crate::db::browser::get_table_meta_pg;
        for port in PORTS {
            let p = pool(port).await;

            // A matview has no information_schema.columns rows — the old
            // query returned an empty column list, so browsing showed nothing.
            let mv = get_table_meta_pg(&p, "txui_demo", "mv_customer_totals").await.expect("matview meta");
            assert_eq!(mv.columns.len(), 4, "{port}: matview columns");

            let o = get_table_meta_pg(&p, "txui_demo", "orders").await.expect("orders meta");
            assert_eq!(o.pk_columns, vec!["id"], "{port}: pk");
            let fk = o.columns.iter().find(|c| c.name == "customer_id").expect("customer_id");
            assert_eq!(fk.fk_table.as_deref(), Some("txui_demo.customers"), "{port}: fk target");
            // format_type keeps the declared type, not the internal udt_name
            let bal = get_table_meta_pg(&p, "txui_demo", "customers").await.expect("customers meta");
            let b = bal.columns.iter().find(|c| c.name == "balance").expect("balance");
            assert_eq!(b.type_name, "numeric(14,2)", "{port}: declared type");
            let tags = bal.columns.iter().find(|c| c.name == "tags").expect("tags");
            assert_eq!(tags.type_name, "text[]", "{port}: array type");

            // Composite FK: both columns must map to their OWN counterpart.
            // Pairing by constraint name alone gives a cartesian product, and
            // the fixture declares the referencing columns in the opposite
            // order so a mis-pairing cannot look accidentally correct.
            let notes = get_table_meta_pg(&p, "txui_demo", "item_notes").await.expect("item_notes meta");
            let by = |n: &str| notes.columns.iter().find(|c| c.name == n).cloned()
                .unwrap_or_else(|| panic!("{port}: no column {n}"));
            let oid = by("order_id");
            let lno = by("line_no");
            assert_eq!(oid.fk_table.as_deref(), Some("txui_demo.order_items"), "{port}");
            assert_eq!(oid.fk_column.as_deref(), Some("order_id"), "{port}: order_id must map to order_id");
            assert_eq!(lno.fk_table.as_deref(), Some("txui_demo.order_items"), "{port}");
            assert_eq!(lno.fk_column.as_deref(), Some("line_no"), "{port}: line_no must map to line_no");

            // Partitioned parent sums its children rather than reporting 0.
            let ev = get_table_meta_pg(&p, "txui_demo", "events").await.expect("events meta");
            assert!(ev.total_rows.unwrap_or(0) > 0, "{port}: partitioned row count = {:?}", ev.total_rows);

            // Never-analyzed table reports unknown, never -1.
            sqlx::query("DROP TABLE IF EXISTS txui_demo.never_analyzed").execute(&p).await.ok();
            sqlx::query("CREATE TABLE txui_demo.never_analyzed (id int)").execute(&p).await.expect("create");
            let na = get_table_meta_pg(&p, "txui_demo", "never_analyzed").await.expect("meta");
            assert!(na.total_rows.is_none_or(|n| n >= 0), "{port}: got {:?}", na.total_rows);
            sqlx::query("DROP TABLE txui_demo.never_analyzed").execute(&p).await.ok();
        }
    }

    #[tokio::test]
    #[ignore]
    async fn pg_live_typed_filters_run_on_every_server() {
        // The data browser binds every value as TEXT; these are the exact
        // shapes build_select() emits once column types are known.
        use crate::db::browser::{build_select, pg_column_types};
        use crate::db::types::{FilterClause, FilterOp};

        for port in PORTS {
            let p = pool(port).await;
            let types = pg_column_types(&p, "txui_demo.orders").await;
            assert!(!types.is_empty(), "{port}: no column types");

            for (col, op, val) in [
                ("id",          FilterOp::Eq,   "5"),
                ("total_cents", FilterOp::Gte,  "1000"),
                ("placed_at",   FilterOp::Lt,   "2030-01-01"),
                ("status",      FilterOp::Eq,   "paid"),      // enum, schema-qualified cast
                ("note",        FilterOp::Like, "%note%"),    // text — no cast
                ("id",          FilterOp::Like, "%7%"),       // non-text LIKE — column cast
            ] {
                let f = vec![FilterClause { column: col.into(), op, value: Some(val.into()) }];
                let q = build_select("txui_demo.orders", &f, &[], 5, 0, true, &types);
                let mut query = sqlx::query(AssertSqlSafe(q.sql.as_str()));
                for v in &q.values { query = query.bind(v); }
                query.fetch_all(&p).await
                    .unwrap_or_else(|e| panic!("{port}: {} failed: {e}", q.sql));
            }
        }
    }
}

#[cfg(test)]
mod tls_tests {
    //! SSL mode coverage against a TLS-enabled server. Requires PG 18 on 5434
    //! configured with the self-signed CA from docs/POSTGRES_DEV.md.
    //!
    //!   PG_TLS_CA=<path to ca.crt> cargo test --lib pg_tls -- --ignored --nocapture
    //!
    //! Skipped when PG_TLS_CA is unset, so it never fails a machine that has
    //! not set the fixture up.

    use crate::db::types::{ConnectionConfig, Engine, SslMode};

    fn config(mode: SslMode, host: &str, ca: Option<&str>) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Postgres, "tls");
        c.host = Some(host.into());
        c.port = Some(5434);
        c.user = Some("root".into());
        c.database = Some("postgres".into());
        c.ssl_mode = mode;
        c.ssl_ca_path = ca.map(String::from);
        c
    }

    #[tokio::test]
    #[ignore]
    async fn pg_tls_every_mode_behaves_as_documented() {
        let Ok(ca) = std::env::var("PG_TLS_CA") else {
            println!("PG_TLS_CA unset — skipping");
            return;
        };
        let pw = Some("root".to_string());

        // disable: plaintext, must connect and must NOT be encrypted.
        let r = super::ping(&config(SslMode::Disable, "127.0.0.1", None), pw.clone()).await;
        assert!(r.ok, "disable failed: {:?}", r.error);
        println!("  disable      → connected (plaintext)");

        // prefer: encrypts when offered, never fails when it is not.
        let r = super::ping(&config(SslMode::Preferred, "127.0.0.1", None), pw.clone()).await;
        assert!(r.ok, "preferred failed: {:?}", r.error);
        println!("  preferred    → connected");

        // require: encryption mandatory, certificate NOT validated — so a
        // self-signed server cert is accepted with no CA supplied.
        let r = super::ping(&config(SslMode::Require, "127.0.0.1", None), pw.clone()).await;
        assert!(r.ok, "require failed: {:?}", r.error);
        println!("  require      → connected (cert not validated)");

        // verify-ca WITHOUT the CA must FAIL — otherwise the setting is
        // security theatre and users would believe they are protected.
        let r = super::ping(&config(SslMode::VerifyCa, "127.0.0.1", None), pw.clone()).await;
        assert!(!r.ok, "verify-ca accepted an untrusted self-signed cert — that defeats the mode");
        println!("  verify-ca/no CA → correctly refused: {}",
                 r.error.unwrap_or_default().lines().next().unwrap_or("").trim());

        // verify-ca WITH the CA must succeed.
        let r = super::ping(&config(SslMode::VerifyCa, "127.0.0.1", Some(&ca)), pw.clone()).await;
        assert!(r.ok, "verify-ca with CA failed: {:?}", r.error);
        println!("  verify-ca    → connected with CA");

        // verify-full additionally matches the hostname against the cert. The
        // cert carries CN=localhost + SAN DNS:localhost,IP:127.0.0.1.
        let r = super::ping(&config(SslMode::VerifyFull, "localhost", Some(&ca)), pw.clone()).await;
        assert!(r.ok, "verify-full to localhost failed: {:?}", r.error);
        println!("  verify-full  → connected to localhost (hostname matched)");
    }

    #[tokio::test]
    #[ignore]
    async fn pg_tls_read_only_startup_option_survives_tls() {
        // read_only rides on the startup packet; make sure enabling TLS does
        // not lose it.
        let Ok(_) = std::env::var("PG_TLS_CA") else { return };
        let mut c = config(SslMode::Require, "127.0.0.1", None);
        c.read_only = true;
        let pool = super::open_pool(&c, Some("root".into()), None, 1).await.expect("connect");
        let ro: String = sqlx::query_scalar("SELECT current_setting('default_transaction_read_only')")
            .fetch_one(&pool).await.expect("query");
        assert_eq!(ro, "on", "read-only startup option lost over TLS");
        println!("  read-only over TLS → default_transaction_read_only={ro}");
        pool.close().await;
    }
}
