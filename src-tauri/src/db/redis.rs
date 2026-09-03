use anyhow::Result;
use redis::aio::ConnectionManager;
use redis::Client;
use std::time::Instant;

use super::types::{ConnectionConfig, LiveSession, PingResult, QueryResult, SchemaNode, SslMode};

/// Build the connection URL.
///
/// Covers what the previous two-line version did not: the Redis 6 ACL
/// username, TLS via `rediss://`, the database index (Redis has 16 numbered
/// databases and the browser needs to target one), and an SSH tunnel
/// endpoint. Credentials are percent-encoded.
fn build_url(
    config: &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
) -> String {
    let (host, port) = host_override.unwrap_or((
        config.host.as_deref().unwrap_or("127.0.0.1"),
        config.port.unwrap_or(6379),
    ));
    // Same reasoning as the MySQL/PG drivers: on macOS "localhost" can resolve
    // to ::1 only after a network change, breaking later reconnects.
    let host = if host_override.is_none() { super::util::pin_localhost(host) } else { host };

    // TLS is a scheme, not a flag. `disable` means plain redis://; anything
    // stricter means rediss://. Certificate verification itself is governed by
    // the `tls-rustls` feature's defaults.
    let scheme = match config.ssl_mode {
        SslMode::Disable => "redis",
        _ => "rediss",
    };

    // Redis 6+ ACL: user AND password. Before ACLs only a password existed,
    // which is the `default` user — sending an empty username preserves that.
    let user = config.user.as_deref().unwrap_or("").trim();
    let creds = match (user.is_empty(), password.as_deref().filter(|p| !p.is_empty())) {
        (true, None)        => String::new(),
        (true, Some(p))     => format!(":{}@", super::util::userinfo_encode(p)),
        (false, None)       => format!("{}@", super::util::userinfo_encode(user)),
        (false, Some(p))    => format!("{}:{}@", super::util::userinfo_encode(user), super::util::userinfo_encode(p)),
    };

    // `database` holds the numeric index for Redis. A non-numeric value is
    // ignored rather than producing an invalid URL.
    let db = config.database.as_deref().unwrap_or("").trim();
    let db_path = match db.parse::<u32>() {
        Ok(n) if n > 0 => format!("/{n}"),
        _ => String::new(),
    };

    format!("{scheme}://{creds}{host}:{port}{db_path}")
}

/// `host_override` = Some(("127.0.0.1", local_port)) when an SSH tunnel is up.
pub async fn open(
    config: &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
) -> Result<LiveSession> {
    let url = build_url(config, password, host_override);
    let client = Client::open(url)?;
    // The Client is kept on the session (cheap: it is just the parsed URL) so
    // db sweeps can open a DEDICATED connection instead of SELECT-switching
    // the shared manager.
    let connect = ConnectionManager::new(client.clone());
    // ConnectionManager retries internally and would otherwise hang past any
    // sensible UI wait when the host is unreachable.
    let mgr = match config.connect_timeout_secs {
        Some(secs) if secs > 0 => tokio::time::timeout(
            std::time::Duration::from_secs(secs.into()), connect)
            .await
            .map_err(|_| anyhow::anyhow!("connection timed out after {secs}s"))??,
        // Never unbounded: see DEFAULT_CONNECT_TIMEOUT_SECS.
        _ => {
            let secs = crate::db::types::DEFAULT_CONNECT_TIMEOUT_SECS;
            tokio::time::timeout(std::time::Duration::from_secs(secs), connect)
                .await
                .map_err(|_| anyhow::anyhow!("connection timed out after {secs}s"))??
        }
    };
    Ok(LiveSession::Redis(mgr, client))
}

pub async fn ping(config: &ConnectionConfig, password: Option<String>) -> PingResult {
    let url = build_url(config, password, None);
    let start = Instant::now();
    match Client::open(url) {
        Ok(client) => match ConnectionManager::new(client).await {
            Ok(mut mgr) => {
                let pong: Result<String, _> = redis::cmd("PING").query_async(&mut mgr).await;
                let info: Result<String, _> = redis::cmd("INFO").arg("server").query_async(&mut mgr).await;
                let version = info.ok().and_then(|s| {
                    s.lines()
                        .find(|l| l.starts_with("redis_version:"))
                        .map(|l| l.trim_start_matches("redis_version:").trim().to_string())
                });
                // A failed PING must carry its reason — `ok: false` with
                // `error: None` told the user nothing (WP-09 9.8; the MongoDB
                // ping already did this).
                let error = pong.as_ref().err().map(|e| e.to_string());
                PingResult {
                    ok: pong.is_ok(),
                    latency_ms: start.elapsed().as_millis() as u64,
                    server_version: version,
                    error,
                }
            }
            Err(e) => PingResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: None,
                error: Some(e.to_string()),
            },
        },
        Err(e) => PingResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: None,
            error: Some(e.to_string()),
        },
    }
}

/// Execute raw Redis commands typed as "CMD arg1 arg2 …".
///
/// Arguments are tokenised by `redisguard::split_args`, not `split_whitespace`:
/// the latter turned `SET greeting "hello world"` into four arguments and
/// stored the literal `"hello`, silently writing the wrong value.
pub async fn execute(mut mgr: ConnectionManager, sql: &str) -> Result<QueryResult> {
    let start = Instant::now();
    let parts = crate::redisguard::split_args(sql).map_err(|e| anyhow::anyhow!(e))?;
    if parts.is_empty() {
        anyhow::bail!("empty command");
    }

    let mut cmd = redis::cmd(parts[0].to_ascii_uppercase().as_str());
    for arg in &parts[1..] {
        cmd.arg(arg.as_str());
    }

    let raw: redis::Value = cmd.query_async(&mut mgr).await?;
    let json = redis_value_to_json(raw);

    // Shape the reply into a grid. Returning one row with one JSON cell was
    // fine for `GET key` and useless for everything a DBA runs — SLOWLOG GET
    // and CLIENT LIST arrived as a single unreadable cell.
    Ok(super::redis_shape::shape(&parts, json, start.elapsed().as_millis() as u64))
}

fn redis_value_to_json(val: redis::Value) -> serde_json::Value {
    use redis::Value;
    use serde_json::Value as J;
    match val {
        Value::Nil                => J::Null,
        Value::Int(i)             => J::from(i),
        Value::BulkString(b)      => J::String(String::from_utf8_lossy(&b).into_owned()),
        Value::SimpleString(s)    => J::String(s),
        Value::Array(arr)         => J::Array(arr.into_iter().map(redis_value_to_json).collect()),
        Value::Boolean(b)         => J::Bool(b),
        Value::Double(d)          => super::types::json_f64(d),
        Value::BigNumber(n)       => J::String(n.to_string()),
        Value::VerbatimString { text, .. } => J::String(text),
        Value::Map(pairs)         => {
            let mut map = serde_json::Map::new();
            for (k, v) in pairs {
                let key = match k {
                    Value::BulkString(b) => String::from_utf8_lossy(&b).into_owned(),
                    Value::SimpleString(s) => s,
                    other => format!("{:?}", other),
                };
                map.insert(key, redis_value_to_json(v));
            }
            J::Object(map)
        }
        Value::Set(items) => J::Array(items.into_iter().map(redis_value_to_json).collect()),
        Value::Okay        => J::String("OK".into()),
        Value::Push { data, .. } => J::Array(data.into_iter().map(redis_value_to_json).collect()),
        Value::Attribute { data, .. } => redis_value_to_json(*data),
        Value::ServerError(_) => J::String("server_error".into()),
    }
}

/// How many keys a namespace sweep will look at before giving up and
/// reporting a sample. Bounded on purpose: Redis is single-threaded, and an
/// unbounded sweep of a production keyspace would stall the server.
const PREFIX_SCAN_CAP: usize = 20_000;
/// Keys per SCAN round-trip.
const SCAN_COUNT: usize = 512;

/// Top level: the Redis databases that actually hold keys.
///
/// The previous version returned two invented nodes ("keys", "streams") as
/// SQL *schemas*, which rendered with the schema icon and led nowhere. Redis
/// has 16 numbered databases; `INFO keyspace` lists the non-empty ones in a
/// single cheap call.
pub async fn list_schema(mut mgr: ConnectionManager) -> Result<Vec<SchemaNode>> {
    let info: String = redis::cmd("INFO").arg("keyspace")
        .query_async(&mut mgr).await.unwrap_or_default();

    let mut out: Vec<SchemaNode> = Vec::new();
    for line in info.lines() {
        let line = line.trim();
        if !line.starts_with("db") { continue; }
        let Some((name, rest)) = line.split_once(':') else { continue };
        let keys = rest.split(',')
            .find_map(|kv| kv.strip_prefix("keys="))
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        out.push(SchemaNode::Database { name: format!("{name} ({keys} keys)") });
    }

    // A completely empty server still needs a place to stand.
    if out.is_empty() {
        out.push(SchemaNode::Database { name: "db0 (empty)".to_string() });
    }
    Ok(out)
}

/// Extract the numeric index from a "db3 (12 keys)" label.
fn db_index(label: &str) -> Option<u32> {
    label.trim_start_matches("db").split_whitespace().next()?.parse().ok()
}

/// Key namespaces inside one database, from a BOUNDED `SCAN` sweep.
///
/// Never `KEYS *`: that is O(N) and blocks the single-threaded server for the
/// whole scan — the reason it is one of the prod hard limits. `SCAN` is
/// incremental and cursor-based, so the sweep can stop early and say so.
///
/// Runs on a DEDICATED connection (built from the session's Client), never
/// the shared ConnectionManager: `SELECT <idx>` there raced every concurrent
/// command onto the wrong database, and an early `?` between the switch and
/// the restoring `SELECT 0` left the app's one shared connection pointed at
/// the wrong db permanently. The dedicated connection needs no restore at
/// all — it is dropped when the sweep ends, on every exit path.
pub async fn list_prefixes(client: &Client, db_label: &str) -> Result<Vec<SchemaNode>> {
    use std::collections::BTreeMap;

    let mut mgr = client.get_multiplexed_async_connection().await?;
    if let Some(idx) = db_index(db_label) {
        if idx != 0 {
            redis::cmd("SELECT").arg(idx).query_async::<()>(&mut mgr).await?;
        }
    }

    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    let mut bare = 0i64;
    let mut seen = 0usize;
    let mut cursor = "0".to_string();
    let mut sampled = false;

    loop {
        let (next, keys): (String, Vec<String>) = redis::cmd("SCAN")
            .arg(&cursor).arg("COUNT").arg(SCAN_COUNT)
            .query_async(&mut mgr).await?;

        for k in &keys {
            seen += 1;
            // Namespace = everything up to the FIRST separator, the convention
            // every Redis codebase uses ("user:1", "cache:page:home").
            match k.find([':', '|', '/']) {
                Some(p) if p > 0 => *counts.entry(k[..=p].to_string()).or_insert(0) += 1,
                _ => bare += 1,
            }
        }

        cursor = next;
        if cursor == "0" { break; }
        if seen >= PREFIX_SCAN_CAP { sampled = true; break; }
    }

    let ns = Some(db_label.to_string());
    let mut out: Vec<SchemaNode> = counts.into_iter()
        .map(|(name, count)| SchemaNode::KeyPrefix { name, schema: ns.clone(), count, sampled })
        .collect();
    // Largest namespaces first — that is what a DBA is looking for.
    out.sort_by(|a, b| match (a, b) {
        (SchemaNode::KeyPrefix { count: x, .. }, SchemaNode::KeyPrefix { count: y, .. }) => y.cmp(x),
        _ => std::cmp::Ordering::Equal,
    });
    if bare > 0 {
        out.push(SchemaNode::KeyPrefix {
            name: "(no namespace)".into(), schema: ns, count: bare, sampled,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::{Engine, SslMode};

    fn cfg() -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Redis, "r");
        c.host = Some("cache.internal".into());
        c.port = Some(6379);
        c.ssl_mode = SslMode::Disable;
        c.user = None;
        c.database = None;
        c
    }

    #[test]
    fn plain_connection_has_no_credentials() {
        assert_eq!(build_url(&cfg(), None, None), "redis://cache.internal:6379");
    }

    #[test]
    fn password_only_is_the_default_acl_user() {
        // Pre-ACL Redis has no username; an empty user must stay empty rather
        // than becoming a literal "default".
        assert_eq!(build_url(&cfg(), Some("s3cret".into()), None),
                   "redis://:s3cret@cache.internal:6379");
    }

    #[test]
    fn acl_username_is_sent() {
        // Redis 6 ACLs: without this, every ACL-secured server rejected the
        // connection because only the password was offered.
        let mut c = cfg();
        c.user = Some("reporting".into());
        assert_eq!(build_url(&c, Some("pw".into()), None),
                   "redis://reporting:pw@cache.internal:6379");
        assert_eq!(build_url(&c, None, None), "redis://reporting@cache.internal:6379");
    }

    #[test]
    fn credentials_are_percent_encoded() {
        // A password containing '@' or '/' would otherwise split the URL and
        // either fail to parse or authenticate with a truncated secret.
        let mut c = cfg();
        c.user = Some("user@corp".into());
        assert_eq!(build_url(&c, Some("p@ss/w:rd#1".into()), None),
                   "redis://user%40corp:p%40ss%2Fw%3Ard%231@cache.internal:6379");
    }

    #[test]
    fn tls_switches_the_scheme() {
        // TLS is a scheme in Redis, not a connection flag.
        let mut c = cfg();
        for mode in [SslMode::Preferred, SslMode::Require, SslMode::VerifyCa, SslMode::VerifyFull] {
            c.ssl_mode = mode;
            assert!(build_url(&c, None, None).starts_with("rediss://"),
                    "{:?} must use rediss://", c.ssl_mode);
        }
        c.ssl_mode = SslMode::Disable;
        assert!(build_url(&c, None, None).starts_with("redis://"));
    }

    #[test]
    fn database_index_is_appended() {
        // Redis has 16 numbered databases; without this the browser could only
        // ever see db0.
        let mut c = cfg();
        c.database = Some("3".into());
        assert_eq!(build_url(&c, None, None), "redis://cache.internal:6379/3");
        // db0 is the default — no path needed.
        c.database = Some("0".into());
        assert_eq!(build_url(&c, None, None), "redis://cache.internal:6379");
        // A non-numeric value must not produce an invalid URL.
        c.database = Some("mydb".into());
        assert_eq!(build_url(&c, None, None), "redis://cache.internal:6379");
    }

    #[test]
    fn ssh_tunnel_endpoint_wins() {
        let c = cfg();
        assert_eq!(build_url(&c, None, Some(("127.0.0.1", 51234))),
                   "redis://127.0.0.1:51234");
    }

    #[test]
    fn localhost_is_pinned_to_ipv4() {
        // Same macOS ::1-only resolution trap the MySQL and PG drivers guard
        // against — but not when an SSH tunnel supplied the endpoint.
        let mut c = cfg();
        c.host = Some("localhost".into());
        assert_eq!(build_url(&c, None, None), "redis://127.0.0.1:6379");
        assert_eq!(build_url(&c, None, Some(("localhost", 7000))), "redis://localhost:7000");
    }

    #[test]
    fn everything_at_once() {
        let mut c = cfg();
        c.user = Some("admin".into());
        c.database = Some("5".into());
        c.ssl_mode = SslMode::VerifyFull;
        assert_eq!(build_url(&c, Some("pw".into()), None),
                   "rediss://admin:pw@cache.internal:6379/5");
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the local Redis (127.0.0.1:6379) loaded with
    //! `sh dev/redis_fixture.sh`. Skipped when nothing is listening.
    //!
    //!   cargo test --lib redis_live -- --ignored --nocapture
    use crate::db::types::{ConnectionConfig, Engine, SchemaNode, SslMode};

    fn config(db: Option<&str>) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Redis, "redis");
        c.host = Some("127.0.0.1".into());
        c.port = Some(6379);
        c.ssl_mode = SslMode::Disable;
        c.database = db.map(String::from);
        c
    }

    async fn mgr(db: Option<&str>) -> Option<(redis::aio::ConnectionManager, redis::Client)> {
        match super::open(&config(db), None, None).await.ok()? {
            crate::db::types::LiveSession::Redis(m, c) => Some((m, c)),
            _ => None,
        }
    }

    #[tokio::test]
    #[ignore]
    async fn redis_live_ping_reports_version() {
        let r = super::ping(&config(None), None).await;
        if !r.ok { println!("no redis on 6379 — skipping"); return; }
        let v = r.server_version.expect("server_version");
        println!("  redis {v}");
        assert!(v.starts_with(char::is_numeric), "unexpected version {v}");
    }

    #[tokio::test]
    #[ignore]
    async fn redis_live_keyspace_tree_is_real() {
        let Some((m, client)) = mgr(None).await else { println!("no redis — skipping"); return };

        // Top level = actual databases, not the invented "keys"/"streams"
        // schema nodes the old implementation returned.
        let dbs = super::list_schema(m.clone()).await.expect("list_schema");
        let names: Vec<String> = dbs.iter().filter_map(|n| match n {
            SchemaNode::Database { name } => Some(name.clone()),
            _ => None,
        }).collect();
        println!("  databases: {names:?}");
        assert!(!names.is_empty(), "no databases listed");
        assert!(names.iter().any(|n| n.starts_with("db0")), "db0 missing: {names:?}");
        assert!(dbs.iter().all(|n| !matches!(n, SchemaNode::Schema { .. })),
                "Redis must not emit SQL schema nodes");

        // Expanding db0 = key namespaces from a bounded SCAN.
        let prefixes = super::list_prefixes(&client, "db0 (1014 keys)").await.expect("prefixes");
        let mut found: Vec<(String, i64)> = prefixes.iter().filter_map(|n| match n {
            SchemaNode::KeyPrefix { name, count, .. } => Some((name.clone(), *count)),
            _ => None,
        }).collect();
        println!("  namespaces: {found:?}");
        assert!(!found.is_empty(), "no namespaces found");
        // The fixture writes 500 session:* and 500 product:* keys.
        assert!(found.iter().any(|(n, c)| n == "session:" && *c >= 400), "session: {found:?}");
        assert!(found.iter().any(|(n, c)| n == "product:" && *c >= 400), "product: {found:?}");
        // Keys with no separator land in their own bucket rather than vanishing.
        assert!(found.iter().any(|(n, _)| n == "(no namespace)"), "bare keys lost: {found:?}");
        // Sorted largest-first — what a DBA is looking for.
        found.retain(|(n, _)| n != "(no namespace)");
        assert!(found.windows(2).all(|w| w[0].1 >= w[1].1), "not sorted by size: {found:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn redis_live_quoted_values_round_trip() {
        // The old split_whitespace tokeniser stored the literal `"hello` here.
        let Some((m, _)) = mgr(None).await else { return };
        super::execute(m.clone(), r#"SET dbgui:quoted "hello world""#).await.expect("set");
        let r = super::execute(m.clone(), "GET dbgui:quoted").await.expect("get");
        assert_eq!(r.rows[0][0], serde_json::json!("hello world"));

        super::execute(m.clone(), r#"SET dbgui:esc "a\tb\nc""#).await.expect("set esc");
        let r = super::execute(m.clone(), "GET dbgui:esc").await.expect("get esc");
        assert_eq!(r.rows[0][0], serde_json::json!("a\tb\nc"));

        super::execute(m.clone(), "DEL dbgui:quoted dbgui:esc").await.ok();
        println!("  quoted + escaped values round-trip intact");
    }

    #[tokio::test]
    #[ignore]
    async fn redis_live_all_value_types_decode() {
        let Some((m, _)) = mgr(None).await else { return };
        for (cmd, label) in [
            ("GET greeting", "string"),
            ("HGETALL user:1", "hash"),
            ("LRANGE queue:jobs 0 -1", "list"),
            ("SMEMBERS tags:post1", "set"),
            ("ZRANGE leaderboard 0 -1 WITHSCORES", "zset"),
            ("XRANGE events:log - +", "stream"),
            ("PFCOUNT visitors", "hyperloglog"),
            ("GEOPOS cities prague", "geo"),
            ("TTL ttl:soon", "ttl"),
            ("OBJECT ENCODING counter", "encoding"),
        ] {
            let r = super::execute(m.clone(), cmd).await
                .unwrap_or_else(|e| panic!("{label} ({cmd}): {e}"));
            // Shapes differ by reply kind now (redis_shape): a scalar is one
            // cell, a collection is one row per element. Both must decode.
            assert!(!r.rows.is_empty(), "{label}: no rows");
            assert!(!r.columns.is_empty(), "{label}: no columns");
            println!("  {label:<12} {:<38} {} col x {} row", cmd, r.columns.len(), r.rows.len());
        }
    }

    #[tokio::test]
    #[ignore]
    async fn redis_live_database_index_is_honoured() {
        // The fixture seeds exactly one key in db3.
        let Some((m0, _)) = mgr(Some("0")).await else { return };
        let Some((m3, _)) = mgr(Some("3")).await else { return };
        let r0 = super::execute(m0, "DBSIZE").await.expect("dbsize db0");
        let r3 = super::execute(m3, "DBSIZE").await.expect("dbsize db3");
        println!("  db0={} db3={}", r0.rows[0][0], r3.rows[0][0]);
        assert_eq!(r3.rows[0][0], serde_json::json!(1), "db3 should hold exactly the marker key");
        assert_ne!(r0.rows[0][0], r3.rows[0][0], "database index was ignored");
    }

    #[tokio::test]
    #[ignore]
    async fn redis_live_dba_replies_render_as_grids() {
        // The whole point of redis_shape: these used to be one JSON cell.
        let Some((m, _client)) = mgr(None).await else { println!("no redis — skipping"); return };
        // Make sure there is at least one slowlog entry to shape.
        super::execute(m.clone(), "CONFIG SET slowlog-log-slower-than 0").await.ok();
        super::execute(m.clone(), "GET greeting").await.ok();
        super::execute(m.clone(), "CONFIG SET slowlog-log-slower-than 10000").await.ok();

        for (cmd, min_cols, min_rows) in [
            ("SLOWLOG GET 5", 6, 1),
            ("CLIENT LIST", 5, 1),
            ("CONFIG GET maxmemory*", 2, 1),
            ("INFO", 3, 10),
            ("MEMORY STATS", 2, 5),
            ("SMEMBERS tags:post1", 1, 3),
            ("LRANGE queue:jobs 0 -1", 1, 4),
            ("XINFO STREAM events:log", 2, 5),
        ] {
            let r = super::execute(m.clone(), cmd).await
                .unwrap_or_else(|e| panic!("{cmd}: {e}"));
            assert!(r.columns.len() >= min_cols,
                    "{cmd}: {} columns, expected >= {min_cols}", r.columns.len());
            assert!(r.rows.len() >= min_rows,
                    "{cmd}: {} rows, expected >= {min_rows}", r.rows.len());
            println!("  {:<26} {} cols x {} rows  [{}]", cmd, r.columns.len(), r.rows.len(),
                     r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(","));
        }
    }

    #[tokio::test]
    #[ignore]
    async fn redis_live_client_list_columns_are_addressable_by_name() {
        // kill_candidates looks CLIENT LIST fields up BY NAME, because Redis
        // adds fields between versions and positional indexing would silently
        // shift. Prove the names it depends on are actually present.
        let Some((m, _client)) = mgr(None).await else { println!("no redis — skipping"); return };
        let r = super::execute(m.clone(), "CLIENT LIST").await.expect("client list");
        let names: Vec<&str> = r.columns.iter().map(|c| c.name.as_str()).collect();
        for want in ["id", "addr", "name", "age", "idle", "flags", "db", "cmd", "user", "multi", "resp"] {
            assert!(names.contains(&want), "CLIENT LIST has no `{want}` column — {names:?}");
        }
        assert!(!r.rows.is_empty(), "at least this connection should be listed");

        // CLIENT ID must resolve, or self-protection in the kill path cannot
        // work and TxUI could disconnect itself.
        let id = super::execute(m, "CLIENT ID").await.expect("client id");
        assert!(id.rows[0][0].as_i64().unwrap_or(0) > 0, "CLIENT ID did not return an id");
        println!("  CLIENT LIST → {} columns, self id resolves", names.len());
    }

    #[tokio::test]
    #[ignore]
    async fn redis_live_server_catalog_matches_the_baseline() {
        // The baseline was generated from this server; confirm it still agrees,
        // and that the server path classifies the same way.
        let Some((m, _)) = mgr(None).await else { return };
        let r = super::execute(m, "ACL CAT write").await.expect("acl cat");
        // A flat array reply is now one row per element, not one cell holding
        // the whole array.
        let names: Vec<String> = r.rows.iter()
            .filter_map(|row| row.first().and_then(|v| v.as_str()).map(String::from))
            .collect();
        assert!(names.len() > 100, "expected many write commands, got {}", names.len());

        let cat = crate::redisguard::CommandCatalog::baseline()
            .with_server_writes(names.clone());
        assert!(cat.from_server);
        for c in ["set", "del", "flushall", "hset", "lpush"] {
            assert!(cat.classify(&[c.to_string()]).mutates(), "{c} must be a write");
        }
        println!("  server reports {} write commands; all classified as writes", names.len());
    }
}
